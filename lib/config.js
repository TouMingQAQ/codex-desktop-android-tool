/**
 * dsh-android-tool 的配置纯逻辑层（不 import 宿主包，可在纯 Node 下单测）。
 *
 * config-schema.js 才 import schemastery；这里只做「取值 + 规范化 + 兜底」。
 * 配置写坏不该让插件挂掉，因此每个字段都有默认值。
 */

/** scrcpy 随包目录名。 */
export const SCRCPY_DIR = 'scrcpy'

/** 合理默认值。字段缺失、类型不对时都回落到这里。 */
export const DEFAULTS = {
  adbPath: '',
  scrcpyPath: '',
  wirelessHost: '',
  wirelessPort: 5555,
  pairingPort: 0,
  autoConnect: false,
  videoMaxSize: 720,
  videoBitRate: 2500000,
  videoFps: 30,
  videoEncoder: '',
  videoCodecOptions: '',
  previewFps: 3,
  logcatMaxLines: 5000,
  adbTimeoutMs: 15000,
  scrcpyExtraArgs: '',
}

/** 读取可能是 Volatile 引用的配置值。 */
export function readLive(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'object' && typeof value.get === 'function') {
    try {
      const current = value.get()
      return current === undefined || current === null ? fallback : current
    } catch {
      return fallback
    }
  }
  return value
}

/** 整数钳制。 */
export function clampInt(value, min, max, fallback) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

/** 布尔读取：只有明确写成 false / 'false' / '0' / 'off' 才算关。 */
export function readBool(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const text = String(value).trim().toLowerCase()
  if (text === '') return fallback
  if (['false', '0', 'off', 'no', 'n'].includes(text)) return false
  if (['true', '1', 'on', 'yes', 'y'].includes(text)) return true
  return fallback
}

/** 把运行期配置收成普通对象。 */
export function snapshotConfig(config) {
  const source = config ?? {}
  return {
    adbPath: String(readLive(source.adbPath, DEFAULTS.adbPath) ?? '').trim(),
    scrcpyPath: String(readLive(source.scrcpyPath, DEFAULTS.scrcpyPath) ?? '').trim(),
    wirelessHost: String(readLive(source.wirelessHost, DEFAULTS.wirelessHost) ?? '').trim(),
    wirelessPort: clampInt(readLive(source.wirelessPort, DEFAULTS.wirelessPort), 1, 65535, DEFAULTS.wirelessPort),
    pairingPort: clampInt(readLive(source.pairingPort, DEFAULTS.pairingPort), 0, 65535, DEFAULTS.pairingPort),
    autoConnect: readBool(readLive(source.autoConnect, DEFAULTS.autoConnect), DEFAULTS.autoConnect),
    videoMaxSize: clampInt(readLive(source.videoMaxSize, DEFAULTS.videoMaxSize), 320, 4096, DEFAULTS.videoMaxSize),
    videoBitRate: clampInt(readLive(source.videoBitRate, DEFAULTS.videoBitRate), 100000, 50000000, DEFAULTS.videoBitRate),
    videoFps: clampInt(readLive(source.videoFps, DEFAULTS.videoFps), 1, 120, DEFAULTS.videoFps),
    videoEncoder: String(readLive(source.videoEncoder, DEFAULTS.videoEncoder) ?? '').trim(),
    videoCodecOptions: String(readLive(source.videoCodecOptions, DEFAULTS.videoCodecOptions) ?? '').trim(),
    previewFps: clampInt(readLive(source.previewFps, DEFAULTS.previewFps), 1, 10, DEFAULTS.previewFps),
    logcatMaxLines: clampInt(readLive(source.logcatMaxLines, DEFAULTS.logcatMaxLines), 100, 100000, DEFAULTS.logcatMaxLines),
    adbTimeoutMs: clampInt(readLive(source.adbTimeoutMs, DEFAULTS.adbTimeoutMs), 1000, 120000, DEFAULTS.adbTimeoutMs),
    scrcpyExtraArgs: String(readLive(source.scrcpyExtraArgs, DEFAULTS.scrcpyExtraArgs) ?? '').trim(),
  }
}

/**
 * 解析 adb / scrcpy / scrcpy-server 三个随包路径。
 * 显式路径优先；否则用 <pluginRoot>/scrcpy 下的可执行文件。
 *
 * @param {object} options
 * @param {string} options.pluginRoot
 * @param {string} [options.adbPath]
 * @param {string} [options.scrcpyPath]
 * @param {string} [options.platform]
 * @param {typeof import('node:path').join} options.join
 * @returns {{adbPath:string, scrcpyPath:string, serverPath:string, bundledDir:string}}
 */
export function resolveExecutablePaths(options) {
  const join = options.join
  const platform = options.platform ?? process.platform
  const exe = platform === 'win32' ? '.exe' : ''
  const bundledDir = join(options.pluginRoot, SCRCPY_DIR)
  const adbPath = String(options.adbPath ?? '').trim() || join(bundledDir, `adb${exe}`)
  const scrcpyPath = String(options.scrcpyPath ?? '').trim() || join(bundledDir, `scrcpy${exe}`)
  const serverPath = join(bundledDir, 'scrcpy-server')
  return { adbPath, scrcpyPath, serverPath, bundledDir }
}

/** 数据目录名（放在目标工作区里，与插件名区分开）。 */
export const DATA_DIR = '.android_tool'

/**
 * 数据根目录：显式 dataDir → 目标工作区 → DSH profile → 用户主目录。
 * 存放 state.json、aab2apk.config.json 与导出的 logcat 文件。
 *
 * 「目标工作区」优先：AAB 与产物通常都在当前会话的工作区里，配置跟着走，
 * 换项目就是另一份配置；取不到工作区时退回 DSH 自己的分配（profile），
 * 最后才落到用户主目录。全都用同一个 `.android_tool` 目录名。
 *
 * @param {object} options
 * @param {string} [options.dataDir]
 * @param {string} [options.workspaceDir]
 * @param {string} [options.profileDir]
 * @param {string} [options.homeDir]
 * @param {typeof import('node:path').join} options.join
 * @returns {{root:string, source:'dataDir'|'workspace'|'profile'|'home'}}
 */
export function resolveDataRoot(options) {
  const join = options.join
  const explicit = String(options.dataDir ?? '').trim()
  if (explicit.length > 0) return { root: explicit, source: 'dataDir' }
  const workspace = String(options.workspaceDir ?? '').trim()
  if (workspace.length > 0) return { root: join(workspace, DATA_DIR), source: 'workspace' }
  const profile = String(options.profileDir ?? '').trim()
  if (profile.length > 0) return { root: join(profile, DATA_DIR), source: 'profile' }
  const home = String(options.homeDir ?? '').trim()
  return { root: join(home || '.', DATA_DIR), source: 'home' }
}

/**
 * 按空格拆参数，支持单双引号与反斜杠转义。
 * 用于 scrcpyExtraArgs 与「指令」页的 adb 模式。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitArgs(text) {
  const source = String(text ?? '')
  const out = []
  let current = ''
  let quote = ''
  let escaped = false
  let started = false
  for (const char of source) {
    if (escaped) {
      current += char
      escaped = false
      started = true
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
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
  if (escaped) current += '\\'
  if (started) out.push(current)
  return out
}
