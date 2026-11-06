/**
 * Logcat：设备日志采集、过滤、包名扫描与导出。
 *
 * 设计：
 *   - 一个设备一个 logcat 子进程，环形缓冲有上限，内存不会无限涨。
 *   - 过滤（包名 / 关键词 / 级别）在服务端做；包名过滤靠 ps 的 PID 映射。
 *   - Unity 富文本只解析 <color=...> 标签，输出 segments，前端不用 innerHTML。
 */

import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/** 日志级别排序（越大越严重）。 */
const LEVEL_ORDER = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, S: 6 }

/** threadtime 行：`12-21 16:30:45.123  1234  5678 I Tag: message` */
const LINE_RE = /^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+(.*?)\s*:\s?(.*)$/u

/** 把 Unity 颜色名/十六进制规范化；非法值返回 undefined。 */
export function normalizeColor(raw) {
  const text = String(raw ?? '').trim()
  if (/^#[0-9a-f]{3}$/iu.test(text)) {
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`
  }
  if (/^#[0-9a-f]{4}$/iu.test(text)) {
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`
  }
  if (/^#[0-9a-f]{6}$/iu.test(text)) return text
  if (/^#[0-9a-f]{8}$/iu.test(text)) return text.slice(0, 7)
  if (/^[a-z]{3,20}$/iu.test(text)) return text.toLowerCase()
  return undefined
}

/**
 * 解析 Unity 富文本颜色，返回 [{ text, color? }]。
 * 只认 <color=...> / </color>，其它标签原样保留在文本里。
 *
 * @param {string} input
 * @returns {Array<{text:string,color?:string}>}
 */
export function parseUnityColor(input) {
  const text = String(input ?? '')
  const segments = []
  const stack = []
  let current
  let last = 0
  let matched = false
  const re = /<color=(?:"([^"]*)"|([^>]+))>|<\/color>/giu
  let match
  while ((match = re.exec(text)) !== null) {
    matched = true
    if (match.index > last) {
      segments.push({ text: text.slice(last, match.index), ...(current === undefined ? {} : { color: current }) })
    }
    const whole = match[0]
    if (/^<\/color>/iu.test(whole)) {
      stack.pop()
      current = stack.length > 0 ? stack[stack.length - 1] : undefined
    } else {
      const color = normalizeColor(match[1] ?? match[2])
      stack.push(color)
      current = color
    }
    last = re.lastIndex
  }
  if (!matched) return [{ text }]
  if (last < text.length) {
    segments.push({ text: text.slice(last), ...(current === undefined ? {} : { color: current }) })
  }
  if (segments.length === 0) return [{ text: '' }]
  return segments
}

/**
 * 解析一行 threadtime 日志。
 * @param {string} line
 * @returns {{date:string,time:string,pid:number,tid:number,level:string,tag:string,msg:string}|undefined}
 */
export function parseThreadTimeLine(line) {
  const match = LINE_RE.exec(String(line ?? '').trimEnd())
  if (match === null) return undefined
  return {
    date: match[1],
    time: match[2],
    pid: Number(match[3]),
    tid: Number(match[4]),
    level: match[5],
    tag: match[6].trim(),
    msg: match[7],
  }
}

/** 级别是否满足最低要求。 */
export function levelPasses(entryLevel, minLevel) {
  const min = String(minLevel ?? 'V').toUpperCase()
  if (!(min in LEVEL_ORDER)) return true
  return (LEVEL_ORDER[String(entryLevel ?? 'V').toUpperCase()] ?? 0) >= LEVEL_ORDER[min]
}

/** 杀进程树。 */
function killTree(child) {
  if (child === undefined || child === null || child.killed) return
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => {})
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    // 忽略
  }
}

/** Logcat 服务。 */
export class LogcatService {
  /**
   * @param {object} options
   * @param {import('./adb.js').Adb} options.adb
   * @param {() => object} options.getConfig
   * @param {object} [options.logger]
   */
  constructor(options) {
    this.adb = options.adb
    this.getConfig = options.getConfig
    this.logger = options.logger

    this.entries = []
    this.seq = 0
    this.serial = ''
    this.child = undefined
    this.running = false
    this.lastError = ''
    this.lastExitAt = 0
    this.startedAt = 0

    this.pidMap = new Map()
    this.pidMapAt = 0
    this.packagesCache = undefined
    this.packagesAt = 0
  }

  get maxLines() {
    return this.getConfig().logcatMaxLines
  }

  /** 开始采集（同设备已在跑就复用）。 */
  async ensure(serial) {
    const target = String(serial ?? '').trim()
    if (target.length === 0) return { ok: false, error: '没有选中设备。' }
    if (this.running && this.serial === target) return { ok: true }
    if (this.running && this.serial !== target) this.stop()
    if (this.running !== true && this.lastExitAt > 0 && Date.now() - this.lastExitAt < 2000) {
      return { ok: false, error: this.lastError || 'logcat 刚退出，稍后重试。' }
    }
    return this.start(target)
  }

  /** 真正启动 logcat 子进程。 */
  async start(serial) {
    const resolved = this.adb.resolve()
    if (!resolved.ok) {
      this.lastError = resolved.error
      return { ok: false, error: resolved.error }
    }
    this.stop()
    let child
    try {
      child = spawn(resolved.path, ['-s', serial, 'logcat', '-v', 'threadtime'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      return { ok: false, error: this.lastError }
    }

    this.child = child
    this.serial = serial
    this.running = true
    this.lastError = ''
    this.startedAt = Date.now()
    this.entries = []
    this.seq = 0

    const decoder = new StringDecoder('utf8')
    let buffer = ''
    const consume = (text) => {
      buffer += text
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/u, '')
        buffer = buffer.slice(index + 1)
        this.appendLine(line)
        index = buffer.indexOf('\n')
      }
    }

    child.stdout.on('data', (chunk) => consume(decoder.write(chunk)))
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text.length > 0) {
        this.lastError = text.slice(0, 500)
        this.logger?.warn?.(`dsh-android-tool: logcat ${text.slice(0, 200)}`)
      }
    })
    child.on('error', (error) => {
      this.running = false
      this.lastError = error instanceof Error ? error.message : String(error)
    })
    child.on('close', (code) => {
      if (this.child !== child) return
      this.running = false
      this.lastExitAt = Date.now()
      if (code !== 0 && code !== null) this.lastError = this.lastError || `logcat 退出码 ${code}`
    })
    return { ok: true, serial }
  }

  /** 追加一行 / 合并续行。 */
  appendLine(line) {
    if (line.length === 0) return
    if (/^-{5,}\s*beginning of/iu.test(line.trim())) {
      this.entries.push({ id: ++this.seq, raw: line, marker: true, level: 'V', tag: '', msg: line, segments: [{ text: line }] })
      this.trim()
      return
    }
    const parsed = parseThreadTimeLine(line)
    if (parsed === undefined) {
      const last = this.entries[this.entries.length - 1]
      if (last !== undefined && last.marker !== true) {
        last.raw += `\n${line}`
        last.msg += `\n${line}`
        last.segments = parseUnityColor(last.msg)
      }
      return
    }
    const entry = {
      id: ++this.seq,
      raw: line,
      date: parsed.date,
      time: parsed.time,
      pid: parsed.pid,
      tid: parsed.tid,
      level: parsed.level,
      tag: parsed.tag,
      msg: parsed.msg,
      segments: parseUnityColor(parsed.msg),
    }
    this.entries.push(entry)
    this.trim()
  }

  /** 环形缓冲裁剪。 */
  trim() {
    const max = this.maxLines
    if (this.entries.length > max) this.entries.splice(0, this.entries.length - max)
  }

  /** 更新包名 → PID 映射。 */
  async ensurePidMap(serial) {
    if (Date.now() - this.pidMapAt < 2500) return
    this.pidMapAt = Date.now()
    const result = await this.adb.run(['shell', 'ps -A -o PID,NAME'], { serial, timeoutMs: 8000 })
    if (result.ok !== true) return
    const map = new Map()
    for (const line of result.stdout.split(/\r?\n/u)) {
      const parts = line.trim().split(/\s+/u)
      if (parts.length < 2) continue
      const pid = Number(parts[0])
      if (!Number.isFinite(pid)) continue
      const name = parts.slice(1).join(' ')
      const pkg = name.split(':')[0]
      if (!pkg.includes('.')) continue
      if (!map.has(pkg)) map.set(pkg, new Set())
      map.get(pkg).add(pid)
    }
    this.pidMap = map
  }

  /** 扫描运行中 / 已安装 / 前台包名。 */
  async scanPackages(serial) {
    if (this.packagesCache !== undefined && Date.now() - this.packagesAt < 3000) return this.packagesCache
    const command = [
      "echo '==PS'",
      'ps -A -o PID,NAME 2>/dev/null',
      "echo '==PKG'",
      'pm list packages -3 2>/dev/null',
      "echo '==FG'",
      "dumpsys activity activities 2>/dev/null | grep -E 'mResumedActivity|topResumedActivity' | head -n 5",
    ].join('; ')
    const result = await this.adb.run(['shell', command], { serial, timeoutMs: 12000 })
    if (result.ok !== true) return { ok: false, error: result.error, running: [], installed: [], foreground: '' }

    const sections = { PS: [], PKG: [], FG: [] }
    let current = ''
    for (const line of result.stdout.split(/\r?\n/u)) {
      const trimmed = line.trim()
      const marker = /^==(PS|PKG|FG)$/u.exec(trimmed)
      if (marker !== null) {
        current = marker[1]
        continue
      }
      if (current !== '' && trimmed.length > 0) sections[current].push(trimmed)
    }

    const installed = sections.PKG.map((line) => line.replace(/^package:/u, '').trim()).filter((name) => name.length > 0)
    const installedSet = new Set(installed)
    const running = []
    const seen = new Set()
    for (const line of sections.PS) {
      const parts = line.split(/\s+/u)
      if (parts.length < 2) continue
      const pid = Number(parts[0])
      if (!Number.isFinite(pid)) continue
      const name = parts.slice(1).join(' ')
      const pkg = name.split(':')[0]
      if (!pkg.includes('.')) continue
      if (seen.has(pkg)) continue
      seen.add(pkg)
      running.push({ pid, name, package: pkg, isSystem: !installedSet.has(pkg) })
    }

    let foreground = ''
    for (const line of sections.FG) {
      const match = /([a-zA-Z][\w.]*\/[\w.$]+)/u.exec(line)
      if (match !== null) {
        foreground = match[1].split('/')[0]
        break
      }
    }

    const cache = { ok: true, running, installed, foreground }
    this.packagesCache = cache
    this.packagesAt = Date.now()
    return cache
  }

  /** 读取增量日志。 */
  async read(options = {}) {
    const serial = String(options.serial ?? '').trim()
    if (serial.length === 0) return { ok: false, error: '没有选中设备。', entries: [], cursor: 0 }
    const ensured = await this.ensure(serial)
    if (ensured.ok !== true && this.running !== true) {
      return { ok: false, error: ensured.error, entries: [], cursor: 0, running: false }
    }

    const cursor = Number(options.cursor) || 0
    const level = String(options.level ?? 'V')
    const keyword = String(options.q ?? '').trim().toLowerCase()
    const pkg = String(options.pkg ?? '').trim()
    if (pkg.length > 0) await this.ensurePidMap(serial)
    const pidSet = pkg.length > 0 ? this.pidMap.get(pkg) : undefined
    if (pkg.length > 0 && pidSet === undefined) {
      // 包名存在但当前没有进程：返回空，不把全量日志倒给前端。
      return { ok: true, entries: [], cursor: this.seq, running: this.running, serial }
    }

    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(5000, options.limit)) : 500
    const entries = []
    for (const entry of this.entries) {
      if (entry.id <= cursor) continue
      if (entry.marker === true) continue
      if (levelPasses(entry.level, level) !== true) continue
      if (keyword.length > 0 && entry.raw.toLowerCase().includes(keyword) !== true) continue
      if (pidSet !== undefined && pidSet.has(entry.pid) !== true) continue
      entries.push(entry)
    }
    const slice = entries.length > limit ? entries.slice(entries.length - limit) : entries
    return { ok: true, entries: slice, cursor: this.seq, running: this.running, serial, error: this.lastError || undefined }
  }

  /** 当前缓冲里满足过滤条件的纯文本（导出用）。 */
  exportText(options = {}) {
    const level = String(options.level ?? 'V')
    const keyword = String(options.q ?? '').trim().toLowerCase()
    const pkg = String(options.pkg ?? '').trim()
    const pidSet = pkg.length > 0 ? this.pidMap.get(pkg) : undefined
    if (pkg.length > 0 && pidSet === undefined) return ''
    const lines = []
    for (const entry of this.entries) {
      if (entry.marker === true) continue
      if (levelPasses(entry.level, level) !== true) continue
      if (keyword.length > 0 && entry.raw.toLowerCase().includes(keyword) !== true) continue
      if (pidSet !== undefined && pidSet.has(entry.pid) !== true) continue
      lines.push(entry.raw)
    }
    return lines.join('\n') + (lines.length > 0 ? '\n' : '')
  }

  /** 停止采集。 */
  stop() {
    if (this.child !== undefined) {
      killTree(this.child)
      this.child = undefined
    }
    this.running = false
    this.serial = ''
  }

  /** 插件卸载。 */
  dispose() {
    this.stop()
  }
}
