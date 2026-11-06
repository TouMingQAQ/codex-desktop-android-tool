/**
 * AAB → 已签名 APK 转换引擎（从 AAB2APK 的 Rust core 复刻到纯 JS）。
 *
 * 流程与 AAB2APK 保持一致：
 *   检查配置 → bundletool build-apks --mode=universal → 解包 universal.apk
 *   → zipalign（可选）→ apksigner sign → apksigner verify（可选）→ 清理
 *
 * 与 DSH 的集成点：
 *   - `Aab2ApkService` 负责配置持久化（目标工作区下的 .android_tool/aab2apk.config.json）、
 *     工具自动检测、转换任务（可取消）与实时日志缓冲；
 *   - HTTP 路由（webapi.js）读写它；
 *   - AI 工具 android_aab2apk 调 `convert()` 一次跑完。
 *
 * 设计原则：所有对外方法都不抛，返回 `{ ok, ... }`；密码只出现在真正执行的参数里，
 * 日志/回报统一 `pass:***`。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, statfs, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { hasZipEntryEndingWith, listZipEntries, readZipEntry } from './zip.js'
import { readApkManifest } from './apk-manifest.js'

export const AAB2APK_VERSION = '0.1.0'

/** AAB2APK 默认配置（与原文 aab2apk.config.json 的字段一致）。 */
export const AAB2APK_DEFAULTS = {
  aabPath: '',
  outputDir: 'output',
  outputName: '',
  tempDir: '',
  keystore: {
    keystorePath: '',
    keystorePassword: '',
    keyAlias: '',
    keyPassword: '',
    storeType: null,
    v4Signing: false,
  },
  tools: {
    bundletoolJar: '',
    javaPath: '',
    zipalignPath: '',
    apksignerPath: '',
    androidSdkRoot: '',
  },
  align: true,
  verify: true,
  alignment: 4,
  overwrite: true,
  keepIntermediate: false,
  cleanupTemp: true,
  manifestPath: '',
  deviceSpecPath: '',
  bundletoolSigningConfig: '',
  extraBundletoolArgs: [],
  extraApksignerArgs: [],
  javaOptions: [],
}

const BUILD_TOOL_NAMES = {
  zipalign: process.platform === 'win32' ? ['zipalign.exe', 'zipalign.bat', 'zipalign'] : ['zipalign'],
  apksigner: process.platform === 'win32' ? ['apksigner.bat', 'apksigner.exe', 'apksigner'] : ['apksigner'],
}

const STEPS = {
  validate: '检查配置',
  'build-apks': '生成通用 APK（bundletool）',
  extract: '解包通用 APK',
  align: '对齐 APK（zipalign）',
  sign: '签名 APK（apksigner）',
  verify: '校验签名',
  done: '转换完成',
}

// ───────────────────────────────────────────────────────────────────────────
// 纯工具函数（可单独单测）
// ───────────────────────────────────────────────────────────────────────────

/** 清理一个路径/目录输入：去引号、展开 %VAR%/$VAR/~、Windows 反斜杠归一。 */
export function cleanPath(raw) {
  let text = String(raw ?? '').trim()
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) text = text.slice(1, -1)
  }
  if (text.length === 0) return ''
  let expanded = expandVars(text)
  expanded = expandHome(expanded)
  if (process.platform === 'win32') expanded = expanded.replace(/\//gu, '\\')
  return expanded
}

function expandVars(input) {
  let out = ''
  let i = 0
  while (i < input.length) {
    const char = input[i]
    if (char === '%') {
      const end = input.indexOf('%', i + 1)
      if (end > i + 1) {
        const name = input.slice(i + 1, end)
        if (!name.includes(' ') && process.env[name] !== undefined) {
          out += process.env[name]
          i = end + 1
          continue
        }
      }
      out += '%'
      i += 1
      continue
    }
    if (char === '$') {
      let j = i + 1
      let braced = false
      if (input[j] === '{') {
        braced = true
        j += 1
      }
      const start = j
      while (j < input.length && /[\w]/u.test(input[j])) j += 1
      const name = input.slice(start, j)
      const closed = !braced || input[j] === '}'
      if (name.length > 0 && closed && process.env[name] !== undefined) {
        out += process.env[name]
        i = braced ? j + 1 : j
        continue
      }
      out += '$'
      i += 1
      continue
    }
    out += char
    i += 1
  }
  return out
}

function expandHome(input) {
  if (input.startsWith('~')) {
    const rest = input.slice(1)
    if (rest.length === 0 || rest.startsWith('/') || rest.startsWith('\\')) return homedir() + rest
  }
  return input
}

/** 相对路径锚定到 baseDir；绝对路径原样；fold `.` / `..`。 */
export function resolvePath(baseDir, value) {
  const text = String(value ?? '').trim()
  if (text.length === 0) return ''
  if (isAbsolute(text)) return lexicalClean(text)
  return lexicalClean(join(baseDir, text))
}

function lexicalClean(input) {
  const absolute = isAbsolute(input)
  const parts = input.split(/[\\/]+/u)
  const out = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(part)
  }
  const prefix = absolute ? (process.platform === 'win32' ? '' : '/') : ''
  const joined = out.join(sep)
  return `${prefix}${joined}` || (absolute ? sep : '.')
}

/** 拆额外参数：支持一行文本或数组；引号包裹的参数保留空格。 */
export function splitArgList(text) {
  if (Array.isArray(text)) return text.map((item) => String(item).trim()).filter((item) => item.length > 0)
  const source = String(text ?? '')
  const out = []
  let current = ''
  let quote = ''
  let started = false
  for (const char of source) {
    if (quote !== '') {
      if (char === quote) quote = ''
      else current += char
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/u.test(char)) {
      if (started) {
        out.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started) out.push(current)
  return out
}

export function humanSize(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = Number(bytes) || 0
  let unit = 0
  while (value >= 1024 && unit + 1 < units.length) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(2)} ${units[unit]}`
}

/** 日志里把密码抹成 pass:***。 */
export function redactCommand(rendered) {
  const tokens = String(rendered ?? '').split(' ')
  const out = []
  let maskNext = false
  for (const token of tokens) {
    if (maskNext && token.startsWith('pass:')) out.push('pass:***')
    else out.push(token)
    maskNext = token === '--ks-pass' || token === '--key-pass' || token === '--ks-key-pass'
  }
  return out.join(' ')
}

export function sanitizeFileName(input) {
  const cleaned = String(input ?? '')
    .replace(/[<>:"/\\|?*]/gu, '_')
    .replace(/[\u0000-\u001f]/gu, '_')
    .trim()
    .replace(/^\.+|\.+$/gu, '')
  return cleaned.length === 0 ? 'output' : cleaned
}

/** 依次追加 -1、-2…；给临时产物用。 */
export function uniquePath(path) {
  if (!existsSync(path)) return path
  const ext = extname(path)
  const stem = ext.length > 0 ? path.slice(0, -ext.length) : path
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${stem}-${index}${ext}`
    if (!existsSync(candidate)) return candidate
  }
  return path
}

/** 单段通配符匹配（`*` / `?`，Windows 忽略大小写）。 */
export function wildcardMatch(pattern, text) {
  let p = String(pattern)
  let t = String(text)
  if (process.platform === 'win32') {
    p = p.toLowerCase()
    t = t.toLowerCase()
  }
  let pi = 0
  let ti = 0
  let star = -1
  let mark = 0
  while (ti < t.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === t[ti])) {
      pi += 1
      ti += 1
    } else if (pi < p.length && p[pi] === '*') {
      star = pi
      mark = ti
      pi += 1
    } else if (star !== -1) {
      pi = star + 1
      mark += 1
      ti = mark
    } else {
      return false
    }
  }
  while (pi < p.length && p[pi] === '*') pi += 1
  return pi === p.length
}

/** 解析一份配置对象，回填默认值并规范化文本。返回「存盘形态」（相对路径保持相对）。 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const keystore = source.keystore !== null && typeof source.keystore === 'object' ? source.keystore : {}
  const tools = source.tools !== null && typeof source.tools === 'object' ? source.tools : {}
  const storeType = keystore.storeType === null || keystore.storeType === undefined ? null : String(keystore.storeType).trim().toUpperCase() || null
  return {
    aabPath: cleanPath(source.aabPath),
    outputDir: cleanPath(source.outputDir) || AAB2APK_DEFAULTS.outputDir,
    outputName: String(source.outputName ?? '').trim(),
    tempDir: cleanPath(source.tempDir),
    keystore: {
      keystorePath: cleanPath(keystore.keystorePath),
      keystorePassword: String(keystore.keystorePassword ?? '').trim(),
      keyAlias: String(keystore.keyAlias ?? '').trim(),
      keyPassword: String(keystore.keyPassword ?? '').trim(),
      storeType,
      v4Signing: keystore.v4Signing === true,
    },
    tools: {
      bundletoolJar: cleanPath(tools.bundletoolJar),
      javaPath: cleanPath(tools.javaPath),
      zipalignPath: cleanPath(tools.zipalignPath),
      apksignerPath: cleanPath(tools.apksignerPath),
      androidSdkRoot: cleanPath(tools.androidSdkRoot),
    },
    align: source.align === undefined ? true : Boolean(source.align),
    verify: source.verify === undefined ? true : Boolean(source.verify),
    alignment: clampNumber(source.alignment, 1, 64, 4),
    overwrite: source.overwrite === undefined ? true : Boolean(source.overwrite),
    keepIntermediate: source.keepIntermediate === true,
    cleanupTemp: source.cleanupTemp === undefined ? true : Boolean(source.cleanupTemp),
    manifestPath: cleanPath(source.manifestPath),
    deviceSpecPath: cleanPath(source.deviceSpecPath),
    bundletoolSigningConfig: cleanPath(source.bundletoolSigningConfig),
    extraBundletoolArgs: splitArgList(source.extraBundletoolArgs),
    extraApksignerArgs: splitArgList(source.extraApksignerArgs),
    javaOptions: splitArgList(source.javaOptions),
  }
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

/** 把存盘配置里的相对路径锚定到 baseDir（运行时形态）。 */
export function resolveConfig(cfg, baseDir) {
  const resolved = {
    ...cfg,
    aabPath: resolvePath(baseDir, cfg.aabPath),
    outputDir: resolvePath(baseDir, cfg.outputDir) || resolvePath(baseDir, AAB2APK_DEFAULTS.outputDir),
    tempDir: cfg.tempDir.length > 0 ? resolvePath(baseDir, cfg.tempDir) : '',
    keystore: { ...cfg.keystore, keystorePath: resolvePath(baseDir, cfg.keystore.keystorePath) },
    tools: {
      bundletoolJar: resolvePath(baseDir, cfg.tools.bundletoolJar),
      javaPath: resolvePath(baseDir, cfg.tools.javaPath),
      zipalignPath: resolvePath(baseDir, cfg.tools.zipalignPath),
      apksignerPath: resolvePath(baseDir, cfg.tools.apksignerPath),
      androidSdkRoot: resolvePath(baseDir, cfg.tools.androidSdkRoot),
    },
    manifestPath: resolvePath(baseDir, cfg.manifestPath),
    deviceSpecPath: resolvePath(baseDir, cfg.deviceSpecPath),
    bundletoolSigningConfig: resolvePath(baseDir, cfg.bundletoolSigningConfig),
  }
  return resolved
}

/** 把相对 baseDir 的绝对路径重新变回相对（用于回写配置时保持可迁移）。 */
export function relativizeConfig(cfg, baseDir) {
  const unanchor = (value) => {
    const text = String(value ?? '')
    if (text.length === 0) return ''
    const prefix = baseDir.endsWith(sep) ? baseDir : `${baseDir}${sep}`
    return text.toLowerCase().startsWith(prefix.toLowerCase()) ? text.slice(prefix.length) : text
  }
  return {
    ...cfg,
    aabPath: unanchor(cfg.aabPath),
    outputDir: unanchor(cfg.outputDir),
    tempDir: unanchor(cfg.tempDir),
    keystore: { ...cfg.keystore, keystorePath: unanchor(cfg.keystore.keystorePath) },
    tools: {
      bundletoolJar: unanchor(cfg.tools.bundletoolJar),
      javaPath: unanchor(cfg.tools.javaPath),
      zipalignPath: unanchor(cfg.tools.zipalignPath),
      apksignerPath: unanchor(cfg.tools.apksignerPath),
      androidSdkRoot: unanchor(cfg.tools.androidSdkRoot),
    },
    manifestPath: unanchor(cfg.manifestPath),
    deviceSpecPath: unanchor(cfg.deviceSpecPath),
    bundletoolSigningConfig: unanchor(cfg.bundletoolSigningConfig),
  }
}

/** 给 UI 用的脱敏副本（密码显示为空，保存时留空表示不变）。 */
export function redactConfig(cfg) {
  return {
    ...cfg,
    keystore: {
      ...cfg.keystore,
      keystorePassword: cfg.keystore.keystorePassword.length > 0 ? '***' : '',
      keyPassword: cfg.keystore.keyPassword.length > 0 ? '***' : '',
    },
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 外部工具探测
// ───────────────────────────────────────────────────────────────────────────

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function validateBundletoolJar(path) {
  if (!isFile(path)) return false
  try {
    const data = statSync(path).size
    if (data < 1024) return false
    const entries = listZipEntries(readFileSync(path))
    if (entries.some((entry) => entry.name === 'com/android/tools/build/bundletool/BundleToolMain.class')) return true
    return entries.some((entry) => entry.name.toLowerCase().includes('bundletool'))
  } catch {
    return false
  }
}

function resolveBundletool(config, baseDir) {
  const checked = []
  const explicit = config.tools.bundletoolJar
  if (explicit.length > 0) {
    checked.push(explicit)
    if (validateBundletoolJar(explicit)) return { ok: true, path: explicit, checked }
    return { ok: false, checked, error: `找不到 bundletool 的 jar 文件：${explicit}` }
  }
  for (const candidate of bundletoolCandidates(baseDir)) {
    checked.push(candidate)
    if (validateBundletoolJar(candidate)) return { ok: true, path: candidate, checked }
  }
  return { ok: false, checked, error: '找不到 bundletool-all.jar。请把 bundletool-all.jar 放到插件目录的 tools\\ 下，或在「AAB→APK」里指定路径。' }
}

function bundletoolCandidates(baseDir) {
  const out = []
  if (process.env.BUNDLETOOL_JAR && process.env.BUNDLETOOL_JAR.trim() !== '') out.push(cleanPath(process.env.BUNDLETOOL_JAR))
  const home = process.env.AAB2APK_HOME
  if (home && home.trim() !== '') {
    const dir = cleanPath(home)
    out.push(join(dir, 'tools', 'bundletool-all.jar'), join(dir, 'bundletool-all.jar'))
  }
  for (const key of ['AAB2APK_EXE_DIR', 'AAB2APK_BUNDLE_DIR']) {
    const value = process.env[key]
    if (value && value.trim() !== '') {
      const dir = cleanPath(value)
      out.push(join(dir, 'tools', 'bundletool-all.jar'), join(dir, 'bundletool-all.jar'))
    }
  }
  out.push(join(process.cwd(), 'tools', 'bundletool-all.jar'), join(process.cwd(), 'bundletool-all.jar'))
  out.push(join(baseDir, 'tools', 'bundletool-all.jar'), join(baseDir, 'bundletool-all.jar'))
  out.push(join(baseDir, '..', 'tools', 'bundletool-all.jar'), join(baseDir, '..', 'bundletool-all.jar'))
  out.push(join(homedir(), '.aab2apk', 'tools', 'bundletool-all.jar'))
  return [...new Set(out)]
}

function javaExeName() {
  return process.platform === 'win32' ? 'java.exe' : 'java'
}

function javaInstallRoots() {
  const out = []
  if (process.platform === 'win32') {
    const programFiles = [process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)']
    for (const pf of programFiles) {
      out.push(join(pf, 'Android', 'Android Studio', 'jbr'))
      out.push(join(pf, 'Android', 'Android Studio Preview', 'jbr'))
      out.push(join(pf, 'Java'))
      out.push(join(pf, 'Eclipse Adoptium'))
      out.push(join(pf, 'Microsoft', 'jdk'))
    }
    const local = process.env.LOCALAPPDATA
    if (local) {
      out.push(join(local, 'Programs', 'Android Studio', 'jbr'))
      out.push(join(local, 'Programs', 'Eclipse Adoptium'))
      out.push(join(local, 'Google', 'AndroidStudio', 'jbr'))
    }
    out.push(join(homedir(), '.jdks'))
    out.push(join(homedir(), 'scoop', 'apps', 'temurin17-jdk', 'current'))
    out.push(join(homedir(), 'scoop', 'apps', 'openjdk', 'current'))
  } else if (process.platform === 'darwin') {
    out.push('/Applications/Android Studio.app/Contents/jbr/Contents/Home')
    out.push('/Library/Java/JavaVirtualMachines')
    out.push('/opt/homebrew/opt/openjdk')
    out.push('/usr/local/opt/openjdk')
  } else {
    out.push('/usr/lib/jvm')
    out.push('/usr/lib/android-studio/jbr')
    out.push('/opt/android-studio/jbr')
  }
  return out.filter((path) => existsSync(path))
}

function resolveJava(config, notes) {
  const explicit = config.tools.javaPath
  const explicitLooksLikeDir = explicit.length > 0 && !/\.(jar|exe)$/iu.test(explicit)
  if (explicit.length > 0 && isFile(explicit)) return { ok: true, path: explicit }
  if (explicit.length > 0 && explicitLooksLikeDir && !isDir(explicit)) {
    return { ok: false, error: `Java 目录不存在：${explicit}` }
  }

  const roots = []
  if (explicitLooksLikeDir) roots.push(explicit)
  for (const key of ['JAVA_HOME', 'JDK_HOME', 'AAB2APK_JAVA_HOME']) {
    const value = process.env[key]
    if (value && value.trim() !== '') roots.push(cleanPath(value))
  }
  roots.push(...javaInstallRoots())

  const exe = javaExeName()
  for (const root of [...new Set(roots)]) {
    const candidate = isFile(root) ? root : join(root, 'bin', exe)
    if (isFile(candidate)) {
      notes.push(`java       : ${candidate}`)
      return { ok: true, path: candidate }
    }
  }
  const onPath = findOnPath(exe)
  if (onPath !== undefined) {
    notes.push(`java       : ${onPath}（来自 PATH）`)
    return { ok: true, path: onPath }
  }
  return { ok: false, error: '找不到 Java。请安装 JDK，或在「AAB→APK」里把 Java 指向 java.exe / JAVA_HOME 目录。' }
}

function androidSdkRoots(config, baseDir) {
  const out = []
  if (config.tools.androidSdkRoot.length > 0) out.push(config.tools.androidSdkRoot)
  for (const key of ['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_SDK_HOME', 'ANDROID_BUILD_TOOLS']) {
    const value = process.env[key]
    if (value && value.trim() !== '') out.push(cleanPath(value))
  }
  // 常见布局：JDK 与 SDK 并排放在同一个 Android 目录下（如 ...\Android\JDK 与 ...\Android\SDK）。
  // 从 java / JAVA_HOME 往上找，看到带 build-tools 的兄弟目录就当作 SDK 根。
  out.push(...sdkRootsFromJava(config))
  if (process.platform === 'win32') {
    out.push(join(homedir(), 'AppData', 'Local', 'Android', 'Sdk'))
    if (process.env.LOCALAPPDATA) out.push(join(process.env.LOCALAPPDATA, 'Android', 'Sdk'))
  } else if (process.platform === 'darwin') {
    out.push(join(homedir(), 'Library', 'Android', 'sdk'))
  } else {
    out.push(join(homedir(), 'Android', 'Sdk'))
  }
  out.push(join(baseDir, 'sdk'))
  return [...new Set(out)]
}

/** 从 Java 的安装位置反推可能的 Android SDK 根目录（只在真存在 build-tools 时采用）。 */
function sdkRootsFromJava(config) {
  const starts = []
  const explicit = String(config.tools.javaPath ?? '').trim()
  if (explicit.length > 0) starts.push(isFile(explicit) ? dirname(explicit) : explicit)
  for (const key of ['JAVA_HOME', 'JDK_HOME']) {
    const value = process.env[key]
    if (value && value.trim() !== '') starts.push(cleanPath(value))
  }
  const found = []
  for (const start of starts) {
    let dir = start
    for (let depth = 0; depth < 6; depth += 1) {
      const parent = dirname(dir)
      if (parent === dir || parent.length === 0) break
      dir = parent
      if (isDir(join(dir, 'build-tools'))) found.push(dir)
      for (const name of ['SDK', 'sdk', 'Sdk']) {
        const candidate = join(dir, name)
        if (isDir(join(candidate, 'build-tools'))) found.push(candidate)
      }
    }
  }
  return found
}

function versionKey(path) {
  const parent = dirname(path)
  const name = parent.slice(parent.lastIndexOf(sep) + 1) || parent
  return name
    .split(/[.\-_]/u)
    .map((part) => {
      const value = Number.parseInt(part, 10)
      return Number.isFinite(value) ? value : 0
    })
}

function compareVersionKey(a, b) {
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left - right
  }
  return 0
}

function newestBuildTool(sdkRoot, tool) {
  if (!isDir(sdkRoot)) return undefined
  const buildTools = join(sdkRoot, 'build-tools')
  const base = isDir(buildTools) ? buildTools : sdkRoot
  const candidates = []
  try {
    for (const entry of readdirSyncSafe(base)) {
      const full = join(base, entry)
      if (!isDir(full)) continue
      for (const name of BUILD_TOOL_NAMES[tool]) {
        const candidate = join(full, name)
        if (isFile(candidate)) candidates.push(candidate)
      }
    }
  } catch {
    // 忽略
  }
  for (const name of BUILD_TOOL_NAMES[tool]) {
    const candidate = join(sdkRoot, name)
    if (isFile(candidate)) candidates.push(candidate)
  }
  if (candidates.length === 0) return undefined
  candidates.sort((a, b) => compareVersionKey(versionKey(a), versionKey(b)))
  return candidates[candidates.length - 1]
}

function readdirSyncSafe(path) {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function expandGlob(pattern) {
  const components = pattern.split(/[\\/]+/u)
  let frontier = ['']
  for (const piece of components) {
    const next = []
    for (const base of frontier) {
      if (piece.includes('*') || piece.includes('?')) {
        const dir = base === '' ? '.' : base
        for (const name of readdirSyncSafe(dir)) {
          if (wildcardMatch(piece, name)) next.push(base === '' ? name : join(base, name))
        }
      } else {
        const current = base === '' ? piece : join(base, piece)
        if (existsSync(current)) next.push(current)
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }
  const files = frontier.filter((candidate) => isFile(candidate))
  files.sort()
  return files.length > 0 ? files[files.length - 1] : undefined
}

function resolveBuildTool(config, tool, notes, baseDir) {
  const explicit = tool === 'zipalign' ? config.tools.zipalignPath : config.tools.apksignerPath
  if (explicit.length > 0) {
    if (isFile(explicit)) {
      notes.push(`${tool.padEnd(10)}: ${explicit}`)
      return { ok: true, path: explicit }
    }
    if (isDir(explicit)) {
      for (const name of BUILD_TOOL_NAMES[tool]) {
        const candidate = join(explicit, name)
        if (isFile(candidate)) {
          notes.push(`${tool.padEnd(10)}: ${candidate}`)
          return { ok: true, path: candidate }
        }
      }
    }
    if (explicit.includes('*') || explicit.includes('?')) {
      const found = expandGlob(explicit)
      if (found !== undefined) {
        notes.push(`${tool.padEnd(10)}: ${found}`)
        return { ok: true, path: found }
      }
    }
  }
  for (const sdkRoot of androidSdkRoots(config, baseDir)) {
    const found = newestBuildTool(sdkRoot, tool)
    if (found !== undefined) {
      notes.push(`${tool.padEnd(10)}: ${found}`)
      return { ok: true, path: found }
    }
  }
  for (const name of BUILD_TOOL_NAMES[tool]) {
    const found = findOnPath(name)
    if (found !== undefined) {
      notes.push(`${tool.padEnd(10)}: ${found}（来自 PATH）`)
      return { ok: true, path: found }
    }
  }
  return { ok: false }
}

function findOnPath(name) {
  const pathVar = process.env.PATH ?? process.env.Path ?? ''
  for (const dir of pathVar.split(sep === '\\' ? ';' : ':')) {
    if (dir.trim() === '') continue
    const candidate = join(dir, name)
    if (isFile(candidate)) return candidate
  }
  return undefined
}

/** 解析全部工具。返回 { ok, bundletool, java, zipalign, apksigner, notes, error }。 */
export function resolveTools(config, baseDir) {
  const notes = []
  const bundletool = resolveBundletool(config, baseDir)
  if (bundletool.ok === true) notes.push(`bundletool : ${bundletool.path}`)
  else notes.push(`bundletool : 未找到（${bundletool.error}）`)
  const java = resolveJava(config, notes)
  if (java.ok !== true) notes.push('java       : 未找到')
  // 用刚找到的 java 反推 SDK（PATH 上的 java 也能用上这套）：
  const derived = java.ok === true ? { ...config, tools: { ...config.tools, javaPath: config.tools.javaPath || java.path } } : config
  const zipalign = resolveBuildTool(derived, 'zipalign', notes, baseDir)
  if (zipalign.ok !== true) notes.push('未找到 zipalign，将跳过对齐步骤')
  const apksigner = resolveBuildTool(derived, 'apksigner', notes, baseDir)
  if (apksigner.ok !== true) notes.push('未找到 apksigner（签名必需）')

  let error
  if (bundletool.ok !== true) error = bundletool.error
  else if (java.ok !== true) error = java.error
  else if (apksigner.ok !== true) {
    error = '未找到 apksigner。请手动指定其路径，或安装 Android SDK Build-Tools（并设置 ANDROID_HOME）。'
  }
  return { ok: error === undefined, error, notes, bundletool, java, zipalign, apksigner }
}

// ───────────────────────────────────────────────────────────────────────────
// 子进程
// ───────────────────────────────────────────────────────────────────────────

function quoteDisplay(text) {
  const value = String(text)
  return value.length === 0 || /[\s"]/u.test(value) ? `"${value.replace(/"/gu, '\\"')}"` : value
}

export function displayCommand(spec) {
  return [quoteDisplay(spec.program), ...spec.args.map(quoteDisplay)].join(' ')
}

function quoteWin(text) {
  const value = String(text)
  return /[\s"&|<>^]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value
}

function spawnSpec(spec, env) {
  const isWin = process.platform === 'win32'
  const lower = spec.program.toLowerCase()
  const options = { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env }
  if (isWin && (lower.endsWith('.bat') || lower.endsWith('.cmd'))) {
    const comspec = process.env.ComSpec || 'cmd.exe'
    const line = [quoteWin(spec.program), ...spec.args.map(quoteWin)].join(' ')
    return spawn(comspec, ['/d', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true })
  }
  return spawn(spec.program, spec.args, options)
}

function stripAnsi(text) {
  return String(text)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/\r/gu, '')
}

function killChild(child) {
  if (child === null || child === undefined || child.killed === true) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    try {
      child.kill()
    } catch {
      // 忽略
    }
  }
}

/**
 * 跑一个外部命令，逐行回调输出，支持超时与取消。
 * @returns {Promise<{code:number|null, success:boolean, stdout:string, stderr:string, durationMs:number, cancelled:boolean, timedOut:boolean}>}
 */
export function runProcess(spec, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 0
  const onLine = typeof options.onLine === 'function' ? options.onLine : () => {}
  const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : () => false
  const env = { ...process.env, ...(spec.env ?? {}) }
  const started = Date.now()

  return new Promise((resolve) => {
    let child
    try {
      child = spawnSpec(spec, env)
    } catch (error) {
      resolve({ code: null, success: false, stdout: '', stderr: String(error?.message ?? error), durationMs: Date.now() - started, cancelled: false, timedOut: false })
      return
    }
    if (typeof options.onSpawn === 'function') options.onSpawn(child)

    let stdout = ''
    let stderr = ''
    let finished = false
    let cancelled = false
    let timedOut = false
    const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') }
    const buffers = { out: '', err: '' }

    const flushLines = (stream, chunk, final) => {
      const decoder = stream === 'out' ? decoders.out : decoders.err
      const key = stream
      buffers[key] += final ? decoder.end() : decoder.write(chunk)
      const parts = buffers[key].split('\n')
      buffers[key] = parts.pop() ?? ''
      for (const raw of parts) {
        const line = stripAnsi(raw)
        if (stream === 'out') stdout += `${line}\n`
        else stderr += `${line}\n`
        if (line.trim().length > 0) onLine(stream === 'out' ? 'stdout' : 'stderr', line)
      }
    }

    child.stdout?.on('data', (chunk) => flushLines('out', chunk, false))
    child.stderr?.on('data', (chunk) => flushLines('err', chunk, false))

    const finish = (code) => {
      if (finished) return
      finished = true
      if (timer !== undefined) clearInterval(timer)
      flushLines('out', '', true)
      flushLines('err', '', true)
      resolve({ code, success: code === 0 && !cancelled && !timedOut, stdout, stderr, durationMs: Date.now() - started, cancelled, timedOut })
    }

    child.on('error', (error) => {
      stderr += `${String(error?.message ?? error)}\n`
      finish(null)
    })
    child.on('close', (code) => finish(code))

    const timer = setInterval(() => {
      if (finished) return
      if (!cancelled && isCancelled()) {
        cancelled = true
        killChild(child)
      }
      if (timeoutMs > 0 && Date.now() - started > timeoutMs && !timedOut) {
        timedOut = true
        killChild(child)
      }
    }, 80)
    if (timer.unref !== undefined) timer.unref()
  })
}

// ───────────────────────────────────────────────────────────────────────────
// 转换服务
// ───────────────────────────────────────────────────────────────────────────

function stepEvent(job, event) {
  const record = { seq: job.events.length, at: Date.now(), ...event }
  job.events.push(record)
  if (job.events.length > 6000) job.events.splice(0, job.events.length - 6000)
  return record
}

class ConversionAbort extends Error {}

export class Aab2ApkService {
  /**
   * @param {object} options
   * @param {() => string} options.getDataRoot 返回数据根目录
   * @param {() => string} [options.getWorkspaceRoot] 返回目标工作区（相对路径锚点）
   * @param {() => string[]} [options.getLegacyConfigPaths] 旧位置（迁移用）
   * @param {string} options.pluginRoot 插件目录（工具/随包资源锚点）
   * @param {object} [options.logger]
   */
  constructor(options) {
    this.getDataRoot = options.getDataRoot
    this.getWorkspaceRoot = options.getWorkspaceRoot ?? (() => '')
    this.getLegacyConfigPaths = options.getLegacyConfigPaths ?? (() => [])
    this.pluginRoot = options.pluginRoot
    this.logger = options.logger
    this.jobs = new Map()
    this.activeJobId = ''
    this.configLoaded = undefined
  }

  /** 用户路径（输出目录、密钥库等）的锚点：优先目标工作区，其次插件目录。 */
  baseDir() {
    const workspace = String(this.getWorkspaceRoot?.() ?? '').trim()
    return workspace.length > 0 ? workspace : this.pluginRoot
  }

  configPath() {
    return join(this.getDataRoot(), 'aab2apk.config.json')
  }

  /** 读配置；损坏时回落默认值。新位置没有时读旧位置的副本（迁移）。 */
  async loadConfig() {
    if (this.configLoaded !== undefined) return this.configLoaded
    this.configLoaded = (async () => {
      try {
        const text = await readFile(this.configPath(), 'utf8')
        return normalizeConfig(JSON.parse(text))
      } catch {
        // 新位置还没有：看看旧位置（例如 profile 下的 .dsh-android-tool）
        for (const legacy of this.getLegacyConfigPaths()) {
          if (typeof legacy !== 'string' || legacy.length === 0) continue
          if (legacy === this.configPath()) continue
          try {
            const text = await readFile(legacy, 'utf8')
            return normalizeConfig(JSON.parse(text))
          } catch {
            // 继续找下一个
          }
        }
        return normalizeConfig({})
      }
    })()
    return this.configLoaded
  }

  /** 保存配置（传存盘形态或部分字段）。 */
  async saveConfig(partial) {
    const current = await this.loadConfig()
    const merged = mergeConfig(current, partial)
    const normalized = normalizeConfig(merged)
    const root = this.getDataRoot()
    await mkdir(root, { recursive: true })
    const file = this.configPath()
    const temp = `${file}.tmp`
    await writeFile(temp, JSON.stringify(normalized, null, 2), 'utf8')
    await rename(temp, file)
    this.configLoaded = Promise.resolve(normalized)
    return normalized
  }

  /** 当前配置 + 解析后的工具状态（给 UI）。 */
  async describe() {
    const config = await this.loadConfig()
    const baseDir = this.baseDir()
    return {
      ok: true,
      config: redactConfig(config),
      baseDir,
      dataRoot: this.getDataRoot(),
      workspaceDir: String(this.getWorkspaceRoot?.() ?? '').trim(),
      detected: this.detect(config),
    }
  }

  /** 工具探测（纯函数式，不抛）。 */
  detect(storedConfig) {
    const baseDir = this.baseDir()
    const config = resolveConfig(storedConfig, baseDir)
    const tools = resolveTools(config, this.pluginRoot)
    const tempDir = config.tempDir.length > 0 ? config.tempDir : tmpdir()
    return {
      ok: tools.ok === true,
      error: tools.error,
      notes: tools.notes,
      tools: {
        bundletool: tools.bundletool?.ok === true ? tools.bundletool.path : undefined,
        java: tools.java?.ok === true ? tools.java.path : undefined,
        zipalign: tools.zipalign?.ok === true ? tools.zipalign.path : undefined,
        apksigner: tools.apksigner?.ok === true ? tools.apksigner.path : undefined,
      },
      tempDir,
      outputDir: config.outputDir,
    }
  }

  /**
   * 启动一次转换（给 UI）。返回任务摘要，实际转换异步进行。
   * @param {object} overrides 覆盖配置（camelCase，与存盘字段一致）
   */
  async startJob(overrides = {}) {
    if (this.activeJobId !== '' && this.jobs.get(this.activeJobId)?.status === 'running') {
      return { ok: false, error: '已有转换在进行中，请等它结束或先取消。' }
    }
    const stored = await this.loadConfig()
    const merged = normalizeConfig(mergeConfig(stored, overrides))
    const config = resolveConfig(merged, this.baseDir())
    const job = {
      id: `aab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'running',
      events: [],
      startedAt: Date.now(),
      finishedAt: 0,
      result: null,
      error: '',
      child: null,
      cancelled: false,
      config: merged,
    }
    this.jobs.set(job.id, job)
    this.activeJobId = job.id
    this.pruneJobs()
    void this.execute(job, config)
    return { ok: true, jobId: job.id, status: job.status }
  }

  /** 取任务状态与增量日志。 */
  getJob(id, cursor = 0) {
    const job = this.jobs.get(String(id ?? ''))
    if (job === undefined) return { ok: false, error: '任务不存在' }
    const from = Math.max(0, Math.min(Number(cursor) || 0, job.events.length))
    return {
      ok: true,
      id: job.id,
      status: job.status,
      events: job.events.slice(from),
      cursor: job.events.length,
      result: job.result,
      error: job.error,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    }
  }

  /** 取消当前任务。 */
  cancel(id) {
    const job = id ? this.jobs.get(String(id)) : this.jobs.get(this.activeJobId)
    if (job === undefined || job.status !== 'running') return { ok: false, error: '没有正在进行的转换' }
    job.cancelled = true
    killChild(job.child)
    return { ok: true }
  }

  /** AI 工具：跑完再返回（带日志尾巴）。 */
  async convert(overrides = {}) {
    const started = await this.startJob(overrides)
    if (started.ok !== true) return { ok: false, error: started.error }
    const job = this.jobs.get(started.jobId)
    while (job.status === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const log = job.events
      .filter((event) => event.kind === 'output' || event.kind === 'info' || event.kind === 'warn' || event.kind === 'error')
      .map((event) => event.line ?? event.message ?? '')
      .slice(-120)
      .join('\n')
    if (job.status === 'done') return { ok: true, ...job.result, log }
    return { ok: false, error: job.error || '转换失败', log, cancelled: job.cancelled === true }
  }

  pruneJobs() {
    if (this.jobs.size <= 20) return
    const finished = [...this.jobs.values()].filter((job) => job.status !== 'running').sort((a, b) => a.startedAt - b.startedAt)
    for (const job of finished.slice(0, this.jobs.size - 20)) this.jobs.delete(job.id)
  }

  dispose() {
    for (const job of this.jobs.values()) {
      if (job.status === 'running') killChild(job.child)
    }
  }

  // ── 实际流水线 ────────────────────────────────────────────────────────────

  async execute(job, config) {
    const emit = (event) => stepEvent(job, event)
    const startAll = Date.now()
    const scratch = join(config.tempDir.length > 0 ? config.tempDir : tmpdir(), `aab2apk-${process.pid}-${Date.now()}`)
    const ctx = {
      config,
      baseDir: this.pluginRoot,
      job,
      scratch,
      emit,
      cancelled: () => job.cancelled === true,
      onChild: (child) => {
        job.child = child
      },
      startedAll: startAll,
      steps: [],
      javaPath: '',
    }

    try {
      const result = await runPipeline(ctx)
      job.result = result
      job.status = 'done'
      job.finishedAt = Date.now()
    } catch (error) {
      if (error instanceof ConversionAbort || job.cancelled === true) {
        job.status = 'cancelled'
        job.error = '已取消'
        emit({ kind: 'error', message: '转换已取消', step: 'done' })
      } else {
        job.status = 'error'
        job.error = error instanceof Error ? error.message : String(error)
        emit({ kind: 'error', message: job.error, step: 'done' })
      }
      job.finishedAt = Date.now()
    } finally {
      if (config.cleanupTemp) {
        try {
          await rm(scratch, { recursive: true, force: true })
        } catch {
          // 忽略
        }
      }
      job.child = null
    }
  }
}

function mergeConfig(base, patch) {
  const source = patch !== null && typeof patch === 'object' ? patch : {}
  const mergedKeystore = { ...base.keystore, ...(source.keystore ?? {}) }
  // UI 回读时密码被脱敏成 ***；原样提交回来表示「不改」。
  if (mergedKeystore.keystorePassword === '***') mergedKeystore.keystorePassword = base.keystore.keystorePassword
  if (mergedKeystore.keyPassword === '***') mergedKeystore.keyPassword = base.keystore.keyPassword
  return {
    ...base,
    ...source,
    keystore: mergedKeystore,
    tools: { ...base.tools, ...(source.tools ?? {}) },
  }
}

async function runPipeline(ctx) {
  const { config, emit } = ctx
  const info = (message, step) => emit({ kind: 'info', message, step })
  const warn = (message, step) => emit({ kind: 'warn', message, step })
  const begin = (step) => emit({ kind: 'step-started', step, label: STEPS[step] })
  const finish = (step, ok, detail) => emit({ kind: 'step-finished', step, ok, detail })
  const skip = (step, reason) => emit({ kind: 'step-skipped', step, reason })

  const checkCancel = () => {
    if (ctx.cancelled()) throw new ConversionAbort('cancelled')
  }

  // 1. validate
  begin('validate')
  if (config.aabPath.length === 0) throw new Error('有必填路径为空（AAB 文件）。')
  if (!isFile(config.aabPath)) throw new Error(`文件不存在：${config.aabPath}`)
  if (!/\.aab$/iu.test(config.aabPath)) throw new Error(`不是 .aab 文件：${config.aabPath}`)
  if (config.outputDir.length === 0) throw new Error('输出目录不可用。')
  try {
    await mkdir(config.outputDir, { recursive: true })
  } catch {
    throw new Error(`输出目录不可用：${config.outputDir}`)
  }
  await ensureScratch(ctx, info, warn)
  const keystore = config.keystore
  if (!keystoreComplete(keystore)) throw new Error(`密钥库配置不完整：${missingKeystoreFields(keystore)} 未填写`)
  if (!isFile(keystore.keystorePath)) throw new Error(`密钥库文件不存在：${keystore.keystorePath}`)
  for (const [label, value] of [
    ['AndroidManifest.xml', config.manifestPath],
    ['device-spec.json', config.deviceSpecPath],
    ['signing-config.json', config.bundletoolSigningConfig],
  ]) {
    if (value.length > 0 && !isFile(value)) throw new Error(`${label} 不存在：${value}`)
  }
  if (config.alignment <= 0) throw new Error('zipalign 对齐字节数必须大于 0（安卓默认值为 4）。')

  const tools = resolveTools(config, ctx.baseDir)
  if (tools.ok !== true) throw new Error(tools.error)
  ctx.javaPath = tools.java.path
  info(`bundletool : ${tools.bundletool.path}`)
  info(`java       : ${tools.java.path}`)
  if (tools.zipalign?.ok === true) info(`zipalign   : ${tools.zipalign.path}`)
  else warn('未找到 zipalign，将跳过对齐步骤', 'validate')
  info(`apksigner  : ${tools.apksigner.path}`)
  for (const note of tools.notes) info(note)
  info(`输出文件   : ${resolvedOutputApk(config)}`)
  info(`缓存目录   : ${ctx.scratch}`)
  finish('validate', true)
  ctx.steps.push('validate')
  checkCancel()

  // 2. bundletool build-apks
  begin('build-apks')
  const archive = await buildApks(ctx, tools)
  finish('build-apks', true, archive)
  ctx.steps.push('build-apks')
  checkCancel()

  // 3. extract universal.apk
  begin('extract')
  let draft = await extractUniversal(ctx, archive)
  const outputApk = resolvedOutputApk(config)
  draft = await normalizeUniversalName(ctx, draft, outputApk)
  finish('extract', true, draft)
  ctx.steps.push('extract')
  checkCancel()

  // 4. zipalign
  let signingInput = draft
  if (config.align) {
    begin('align')
    if (tools.zipalign?.ok === true) {
      signingInput = await zipalign(ctx, tools.zipalign.path, draft)
      finish('align', true, signingInput)
      ctx.steps.push('align')
    } else {
      warn('zipalign 不可用，将直接对未对齐的 APK 签名', 'align')
      skip('align', 'zipalign not found')
    }
  } else {
    skip('align', 'disabled in settings')
  }
  checkCancel()

  // 5. sign
  begin('sign')
  await sign(ctx, tools.apksigner.path, signingInput, outputApk)
  finish('sign', true, outputApk)
  ctx.steps.push('sign')
  checkCancel()

  // 6. verify
  let verified = false
  if (config.verify) {
    begin('verify')
    await verify(ctx, tools.apksigner.path, outputApk, info)
    verified = true
    finish('verify', true)
    ctx.steps.push('verify')
  } else {
    skip('verify', 'disabled in settings')
  }

  await cleanup(ctx, draft, signingInput, outputApk, archive, info, warn)

  const sizeBytes = (await stat(outputApk)).size
  let manifest = { packageName: null, versionCode: null, versionName: null }
  try {
    manifest = readApkManifest(await readFile(outputApk))
  } catch {
    // 忽略
  }
  begin('done')
  const message =
    manifest.packageName !== null && manifest.versionCode !== null
      ? `已生成 ${manifest.packageName}（版本号 ${manifest.versionCode}）`
      : manifest.packageName !== null
        ? `已生成 ${manifest.packageName}`
        : 'APK 生成成功'
  finish('done', true, outputApk)
  ctx.steps.push('done')

  return {
    outputApk,
    sizeBytes,
    sizeHuman: humanSize(sizeBytes),
    durationMs: Date.now() - ctx.startedAll,
    steps: ctx.steps,
    packageName: manifest.packageName,
    versionCode: manifest.versionCode,
    versionName: manifest.versionName,
    verified,
    message,
  }
}

async function ensureScratch(ctx, info, warn) {
  try {
    await mkdir(ctx.scratch, { recursive: true })
  } catch {
    throw new Error(`缓存目录不可用：${ctx.scratch}`)
  }
  try {
    const probe = join(ctx.scratch, '.aab2apk-write-test')
    await writeFile(probe, 'ok')
    await unlink(probe)
  } catch {
    throw new Error(`缓存目录不可写：${ctx.scratch}`)
  }
  try {
    const aabSize = (await stat(ctx.config.aabPath)).size
    if (aabSize === 0) return
    const free = await freeSpace(ctx.scratch)
    if (free === undefined) return
    if (free < aabSize) {
      throw new Error(`缓存目录磁盘空间不足：需要至少 ${humanSize(aabSize)}，当前只剩 ${humanSize(free)}`)
    }
    if (free < aabSize * 3) {
      warn(`缓存目录所在磁盘只剩 ${humanSize(free)}，而 AAB 本身就有 ${humanSize(aabSize)}；大 bundle 建议把缓存目录放到更大磁盘。`, 'validate')
    }
  } catch (error) {
    if (String(error?.message ?? '').includes('磁盘空间不足')) throw error
  }
}

function keystoreComplete(keystore) {
  return keystore.keystorePath.length > 0 && keystore.keystorePassword.length > 0 && keystore.keyAlias.length > 0
}

function missingKeystoreFields(keystore) {
  const missing = []
  if (keystore.keystorePath.length === 0) missing.push('密钥库文件')
  if (keystore.keystorePassword.length === 0) missing.push('密钥库密码')
  if (keystore.keyAlias.length === 0) missing.push('密钥别名')
  return missing.join('、')
}

function effectiveKeyPassword(keystore) {
  return keystore.keyPassword.length > 0 ? keystore.keyPassword : keystore.keystorePassword
}

function resolvedOutputName(config) {
  const base = config.outputName.trim().length > 0 ? config.outputName.trim() : (config.aabPath.split(/[\\/]/u).pop() ?? '').replace(/\.aab$/iu, '') || 'output'
  const clean = sanitizeFileName(base)
  const withoutApk = clean.toLowerCase().endsWith('.apk') ? clean.slice(0, -4).trim() : clean
  return withoutApk.length === 0 ? 'output' : withoutApk
}

function resolvedOutputApk(config) {
  return join(config.outputDir, `${resolvedOutputName(config)}.apk`)
}

function resolvedApksArchive(config) {
  return join(config.outputDir, `${resolvedOutputName(config)}.apks`)
}

function javaSpec(ctx, tools) {
  const spec = {
    program: tools.java.path,
    args: [`-Djava.io.tmpdir=${ctx.scratch}`, ...ctx.config.javaOptions, '-jar', tools.bundletool.path],
    env: javaEnv(tools.java.path),
  }
  return spec
}

function javaEnv(javaPath) {
  const env = {}
  if (javaPath !== undefined && javaPath !== null && javaPath.length > 0) {
    const home = dirname(dirname(javaPath))
    if (home.length > 0 && home !== '.') {
      env.JAVA_HOME = home
      env.AAB2APK_JAVA_HOME = home
    }
  }
  env.AAB2APK = AAB2APK_VERSION
  return env
}

async function runTool(ctx, step, spec, timeoutMs) {
  const emit = ctx.emit
  const shown = redactCommand(displayCommand(spec))
  emit({ kind: 'info', message: `> ${shown}`, step })
  const result = await runProcess(spec, {
    timeoutMs,
    isCancelled: ctx.cancelled,
    onSpawn: ctx.onChild,
    onLine: (stream, line) => emit({ kind: 'output', step, stream, line }),
  })
  return result
}

async function buildApks(ctx, tools) {
  const { config, emit } = ctx
  const archive = resolvedApksArchive(config)
  if (existsSync(archive)) {
    if (!config.overwrite) throw new Error(`${archive} 已存在。请勾选「覆盖已存在的 APK」，或先删除该文件。`)
    await rm(archive, { force: true })
  }
  const spec = javaSpec(ctx, tools)
  spec.args.push('build-apks', `--bundle=${config.aabPath}`, `--output=${archive}`, '--mode=universal')
  if (config.overwrite) spec.args.push('--overwrite')

  let manifestPath = config.manifestPath
  if (manifestPath.length === 0 && !bundleHasConfig(config.aabPath)) {
    const extracted = join(ctx.scratch, 'AndroidManifest.xml')
    emit({ kind: 'info', message: '该 bundle 不含 BundleConfig.pb，正在从 AAB 中提取 AndroidManifest.xml', step: 'build-apks' })
    manifestPath = await extractAabManifest(config.aabPath, extracted)
  }
  if (manifestPath.length > 0) spec.args.push(`--aab-manifest=${manifestPath}`)
  if (config.deviceSpecPath.length > 0) spec.args.push(`--device-spec=${config.deviceSpecPath}`)

  const keystore = config.keystore
  if (config.bundletoolSigningConfig.length > 0) {
    emit({ kind: 'info', message: '使用配置中指定的 bundletool signing-config.json', step: 'build-apks' })
    spec.args.push(`--ks=${config.bundletoolSigningConfig}`)
  } else if (keystoreComplete(keystore)) {
    spec.args.push(`--ks=${keystore.keystorePath}`)
    spec.args.push(`--ks-key-alias=${keystore.keyAlias}`)
    spec.args.push(`--ks-pass=pass:${keystore.keystorePassword}`)
    spec.args.push(`--key-pass=pass:${effectiveKeyPassword(keystore)}`)
  } else {
    emit({ kind: 'warn', message: '没有可用的密钥库，bundletool 生成的通用 APK 将只由 apksigner 签名', step: 'build-apks' })
  }
  spec.args.push(...config.extraBundletoolArgs)

  const output = await runTool(ctx, 'build-apks', spec, 30 * 60 * 1000)
  if (output.timedOut) throw new Error(`bundletool 超过 30 分钟时限，已被终止。`)
  if (output.cancelled) throw new ConversionAbort('cancelled')
  if (!output.success || !isFile(archive)) {
    const stderr = output.stderr.trim().length > 0 ? output.stderr : tail(output.stdout + output.stderr, 30)
    if (looksLikeScratchWriteFailure(stderr)) {
      throw new Error(`bundletool 无法写入缓存目录 ${ctx.scratch}，通常是磁盘空间不足。\n${tail(stderr, 12)}`)
    }
    throw new Error(`bundletool 执行失败（退出码 ${output.code ?? '?'}）：\n${tail(stderr || output.stdout, 12)}`)
  }
  return archive
}

function looksLikeScratchWriteFailure(stderr) {
  return (
    stderr.includes('Unable to sign APK') &&
    (stderr.includes('FileDispatcherImpl.write0') || stderr.includes('FileChannelImpl.write') || stderr.includes('RandomAccessFileDataSink'))
  )
}

function tail(text, lines) {
  const list = String(text ?? '').split(/\r?\n/u).filter((line) => line.trim().length > 0)
  return list.slice(Math.max(0, list.length - lines)).join('\n')
}

function bundleHasConfig(aabPath) {
  try {
    return hasZipEntryEndingWith(readFileSync(aabPath), 'BundleConfig.pb')
  } catch {
    return false
  }
}

async function extractAabManifest(aabPath, destination) {
  const buffer = await readFile(aabPath)
  const entries = listZipEntries(buffer)
  const entry =
    entries.find((item) => item.name.toLowerCase().endsWith('manifest/androidmanifest.xml')) ??
    entries.find((item) => item.name.toLowerCase().endsWith('androidmanifest.xml'))
  if (entry === undefined) throw new Error(`无法从 AAB 中读取 AndroidManifest.xml：${aabPath}`)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, readZipEntry(buffer, entry.name))
  return destination
}

async function extractUniversal(ctx, archive) {
  const buffer = await readFile(archive)
  const entries = listZipEntries(buffer)
  const entry =
    entries.find((item) => item.name.toLowerCase() === 'universal.apk') ??
    entries.find((item) => item.name.toLowerCase().endsWith('/universal.apk')) ??
    entries.find((item) => item.name.toLowerCase().endsWith('.apk') && !item.name.includes('splits/'))
  if (entry === undefined) {
    throw new Error(`.apks 归档里没有 universal.apk。包含：${entries.map((item) => item.name).join(', ') || '（空）'}`)
  }
  const destination = uniquePath(join(ctx.config.outputDir, `${resolvedOutputName(ctx.config)}.universal.apk`))
  await writeFile(destination, readZipEntry(buffer, entry.name))
  ctx.emit({ kind: 'info', message: `已提取 ${entry.name}`, step: 'extract' })
  return destination
}

async function normalizeUniversalName(ctx, draft, target) {
  if (draft === target) return draft
  if (existsSync(target)) {
    if (!ctx.config.overwrite) throw new Error(`${target} 已存在。请勾选「覆盖已存在的 APK」，或改用其他文件夹。`)
    await rm(target, { force: true })
  }
  ctx.emit({ kind: 'info', message: `正在重命名通用 APK 为 ${target}`, step: 'extract' })
  try {
    await rename(draft, target)
  } catch {
    await copyFile(draft, target)
    await rm(draft, { force: true })
  }
  return target
}

async function zipalign(ctx, zipalignPath, input) {
  const output = uniquePath(join(ctx.config.outputDir, `${resolvedOutputName(ctx.config)}.aligned.apk`))
  const spec = {
    program: zipalignPath,
    args: ['-f', '-p', String(ctx.config.alignment), input, output],
    env: javaEnv(ctx.javaPath),
  }
  const result = await runTool(ctx, 'align', spec, 10 * 60 * 1000)
  if (result.timedOut) throw new Error('zipalign 超时，已被终止。')
  if (result.cancelled) throw new ConversionAbort('cancelled')
  if (!result.success) throw new Error(`zipalign 执行失败（退出码 ${result.code ?? '?'}）：\n${tail(result.stderr || result.stdout, 10)}`)
  return output
}

async function sign(ctx, apksignerPath, input, output) {
  const keystore = ctx.config.keystore
  if (existsSync(output)) {
    if (!ctx.config.overwrite) throw new Error(`${output} 已存在。请勾选「覆盖已存在的 APK」，或改用其他文件夹。`)
    await rm(output, { force: true })
  }
  const spec = {
    program: apksignerPath,
    args: [
      'sign',
      '--ks',
      keystore.keystorePath,
      '--ks-pass',
      `pass:${keystore.keystorePassword}`,
      '--ks-key-alias',
      keystore.keyAlias,
      '--key-pass',
      `pass:${effectiveKeyPassword(keystore)}`,
    ],
    env: javaEnv(ctx.javaPath),
  }
  if (keystore.storeType !== null) spec.args.push('--ks-type', keystore.storeType)
  if (keystore.v4Signing) spec.args.push('--v4-signing-enabled', 'true')
  spec.args.push('--out', output, ...ctx.config.extraApksignerArgs, input)

  const result = await runTool(ctx, 'sign', spec, 10 * 60 * 1000)
  if (result.timedOut) throw new Error('apksigner 超时，已被终止。')
  if (result.cancelled) throw new ConversionAbort('cancelled')
  if (!result.success || !isFile(output)) {
    throw new Error(`apksigner 执行失败（退出码 ${result.code ?? '?'}）：\n${tail(result.stderr || result.stdout, 8)}`)
  }
}

async function verify(ctx, apksignerPath, apk, info) {
  const spec = {
    program: apksignerPath,
    args: ['verify', '--verbose', '--print-certs', apk],
    env: javaEnv(ctx.javaPath),
  }
  const result = await runTool(ctx, 'verify', spec, 5 * 60 * 1000)
  if (result.timedOut) throw new Error('apksigner verify 超时。')
  if (result.cancelled) throw new ConversionAbort('cancelled')
  if (!result.success) throw new Error(`apksigner verify 报告了问题：\n${tail(result.stderr || result.stdout, 12)}`)
  const combined = `${result.stdout}\n${result.stderr}`
  const verifiedLine = combined.split(/\r?\n/u).find((line) => line.trimStart().startsWith('Verified using'))
  if (verifiedLine !== undefined) info(verifiedLine.trim(), 'verify')
  const certLine = combined.split(/\r?\n/u).find((line) => line.includes('Signer #1 certificate DN'))
  if (certLine !== undefined) info(certLine.trim(), 'verify')
}

async function cleanup(ctx, draft, aligned, output, archive, info, warn) {
  if (!ctx.config.cleanupTemp) {
    info(`已保留缓存目录（bundletool 的临时文件都在这里）：${ctx.scratch}`, 'done')
    return
  }
  for (const path of [draft, aligned]) {
    if (path === output) continue
    if (existsSync(path)) {
      try {
        await rm(path, { force: true })
        info(`已删除临时文件 ${path}`, 'done')
      } catch (error) {
        warn(`无法删除 ${path}：${error instanceof Error ? error.message : String(error)}`, 'done')
      }
    }
  }
  if (!ctx.config.keepIntermediate && existsSync(archive)) {
    try {
      await rm(archive, { force: true })
      info(`已删除中间产物 ${archive}`, 'done')
    } catch (error) {
      warn(`无法删除 ${archive}：${error instanceof Error ? error.message : String(error)}`, 'done')
    }
  } else if (existsSync(archive)) {
    info(`已保留 .apks 归档：${archive}`, 'done')
  }
}

// ── 杂项 ───────────────────────────────────────────────────────────────────

async function freeSpace(path) {
  let candidate = path
  while (!existsSync(candidate)) {
    const parent = dirname(candidate)
    if (parent === candidate) return undefined
    candidate = parent
  }
  try {
    const info = await statfs(candidate)
    return info.bsize * info.bavail
  } catch {
    return undefined
  }
}

/** 供 UI 目录浏览：列出一个目录。 */
export async function browseDirectory(path, baseDir) {
  const target = resolvePath(baseDir, path || '') || baseDir
  try {
    const stats = await stat(target)
    if (!stats.isDirectory()) return { ok: false, error: '不是文件夹' }
  } catch {
    return { ok: false, error: `目录不存在：${target}` }
  }
  try {
    const entries = await readdir(target, { withFileTypes: true })
    const list = []
    for (const entry of entries) {
      const full = join(target, entry.name)
      let size = 0
      try {
        size = (await stat(full)).size
      } catch {
        // 忽略
      }
      list.push({ name: entry.name, path: full, dir: entry.isDirectory(), size })
    }
    list.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    const parent = dirname(target)
    return { ok: true, dir: target, parent: parent === target ? '' : parent, entries: list }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
