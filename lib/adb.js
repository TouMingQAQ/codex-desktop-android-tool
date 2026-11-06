/**
 * adb 执行器：设备发现、无线调试、截图、shell 与按键。
 *
 * 约束：
 *   - 永不抛；所有失败都变成 `{ ok:false, error }`。
 *   - 每个命令都带 `-s <serial>`，避免多设备串线。
 *   - 超时用 taskkill /T /F（Windows）或 SIGKILL，避免 adb 卡死拖着界面。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolveExecutablePaths } from './config.js'
import { join } from 'node:path'

/** 文本输出上限。 */
const TEXT_MAX_BYTES = 4 * 1024 * 1024

/** 截图上限。 */
const IMAGE_MAX_BYTES = 32 * 1024 * 1024

/** 常用按键名 → Android keycode。 */
export const KEY_CODES = {
  back: 4,
  home: 3,
  recents: 187,
  app_switch: 187,
  menu: 82,
  enter: 66,
  escape: 111,
  del: 67,
  delete: 67,
  tab: 61,
  space: 62,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  volume_up: 24,
  volume_down: 25,
  mute: 164,
  power: 26,
  wakeup: 224,
  sleep: 223,
  camera: 27,
  search: 84,
  page_up: 92,
  page_down: 93,
}

/** 把按键名或数字转成 keycode。 */
export function resolveKeyCode(key) {
  const text = String(key ?? '').trim().toLowerCase()
  if (/^\d+$/u.test(text)) return Number(text)
  return KEY_CODES[text]
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

/**
 * 跑一个子进程并收集输出。
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{ timeoutMs?: number, maxBytes?: number, binary?: boolean }} [options]
 * @returns {Promise<{ok:boolean, code:number|null, stdout:string, stderr:string, buffer?:Buffer, truncated?:boolean, elapsedMs:number, error?:string}>}
 */
export function runProcess(file, args, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : TEXT_MAX_BYTES
  const binary = options.binary === true
  const started = Date.now()

  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolvePromise({ ok: false, code: null, stdout: '', stderr: '', elapsedMs: 0, error: error instanceof Error ? error.message : String(error) })
      return
    }

    const stdoutChunks = []
    const stderrChunks = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let settled = false
    let timedOut = false

    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        ok: payload.code === 0 && timedOut === false,
        code: payload.code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        ...(binary ? { buffer: Buffer.concat(stdoutChunks) } : {}),
        truncated,
        elapsedMs: Date.now() - started,
        ...(timedOut ? { error: `命令超时（${timeoutMs}ms）` } : {}),
        ...(payload.error ? { error: payload.error } : {}),
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > maxBytes) {
        truncated = true
        const room = maxBytes - (stdoutBytes - chunk.length)
        if (room > 0) stdoutChunks.push(chunk.subarray(0, room))
        return
      }
      stdoutChunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes > maxBytes) {
        truncated = true
        const room = maxBytes - (stderrBytes - chunk.length)
        if (room > 0) stderrChunks.push(chunk.subarray(0, room))
        return
      }
      stderrChunks.push(chunk)
    })
    child.on('error', (error) => {
      finish({ code: null, error: error instanceof Error ? error.message : String(error) })
    })
    child.on('close', (code) => {
      finish({ code })
    })
  })
}

/**
 * 解析 `adb devices -l`。
 * @param {string} output
 * @returns {Array<{serial:string,state:string,model:string,product:string,device:string,transportId:string}>}
 */
export function parseAdbDevices(output) {
  const rows = []
  for (const raw of String(output ?? '').split(/\r?\n/u)) {
    const line = raw.trim()
    if (line.length === 0) continue
    if (line.startsWith('List of devices') || line.startsWith('*')) continue
    const parts = line.split(/\s+/u)
    if (parts.length < 2) continue
    const serial = parts[0]
    const state = parts[1]
    if (!/^(device|offline|unauthorized|bootloader|recovery|sideload|authorizing|connecting)$/u.test(state)) continue
    const extras = {}
    for (const token of parts.slice(2)) {
      const index = token.indexOf(':')
      if (index > 0) extras[token.slice(0, index)] = token.slice(index + 1)
    }
    rows.push({
      serial,
      state,
      model: extras.model ?? '',
      product: extras.product ?? '',
      device: extras.device ?? '',
      transportId: extras.transport_id ?? '',
    })
  }
  return rows
}

/**
 * 解析 `adb mdns services` 输出。
 *
 * 输出形如（制表符或空格分隔）：
 *   List of discovered mdns services
 *   adb-XXXX-YYYY	_adb-tls-pairing._tcp	192.168.1.5:37777
 *   adb-XXXX-YYYY	_adb-tls-connect._tcp	192.168.1.5:5555
 *
 * @param {string} output
 * @returns {Array<{instance:string, kind:string, endpoint:string}>}
 */
export function parseMdnsServices(output) {
  const rows = []
  for (const raw of String(output ?? '').split(/\r?\n/u)) {
    const line = raw.trim()
    if (line.length === 0) continue
    const tokens = line.split(/\s+/u)
    const kindIndex = tokens.findIndex((token) => /^_adb-tls-(?:pairing|connect)\._tcp\.?$/u.test(token))
    if (kindIndex < 0) continue
    const instance = tokens[0]
    const endpoint = tokens[kindIndex + 1]
    if (instance === undefined || endpoint === undefined) continue
    rows.push({
      instance,
      kind: tokens[kindIndex].replace(/\.$/u, ''),
      endpoint,
    })
  }
  return rows
}

/**
 * 把 `host:port`（兼容 `[IPv6]:port`）解析成 { host, port }。
 * @param {string} endpoint
 * @returns {{host:string, port:number}|undefined}
 */
export function parseMdnsEndpoint(endpoint) {
  const text = String(endpoint ?? '').trim()
  if (text.length === 0) return undefined
  const index = text.lastIndexOf(':')
  if (index <= 0) return undefined
  const host = text.slice(0, index).replace(/^\[|\]$/gu, '')
  const port = Number(text.slice(index + 1))
  if (host.length === 0 || !Number.isFinite(port) || port <= 0 || port > 65535) return undefined
  return { host, port }
}

/** 从 PNG 头里读宽高。 */
export function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return undefined
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return undefined
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** 从设备列表里选一台可用设备。 */
export function pickDevice(devices, preferred) {
  const list = Array.isArray(devices) ? devices : []
  const online = list.filter((item) => item.state === 'device')
  const wanted = String(preferred ?? '').trim()
  if (wanted.length > 0) {
    const hit = online.find((item) => item.serial === wanted)
    if (hit !== undefined) return { ok: true, device: hit }
  }
  if (online.length === 1) return { ok: true, device: online[0] }
  if (online.length === 0) {
    const unauthorized = list.filter((item) => item.state === 'unauthorized')
    const offline = list.filter((item) => item.state === 'offline')
    if (unauthorized.length > 0) {
      return { ok: false, error: `设备未授权：${unauthorized.map((item) => item.serial).join(', ')}。请在手机上点「允许 USB 调试」。` }
    }
    if (offline.length > 0) {
      return { ok: false, error: `设备离线：${offline.map((item) => item.serial).join(', ')}。请检查连接或重新 adb connect。` }
    }
    return { ok: false, error: '没有检测到 Android 设备。请插 USB 或先在设置里连接无线调试。' }
  }
  return {
    ok: false,
    error: `发现 ${online.length} 台设备，但还没有选择当前调试设备。请在「设置 → 安卓调试」或面板顶部选一台。`,
    multiple: online.map((item) => item.serial),
  }
}

/** adb 操作集合。 */
export class Adb {
  /**
   * @param {object} options
   * @param {() => object} options.getConfig
   * @param {string} options.pluginRoot
   * @param {object} [options.logger]
   */
  constructor(options) {
    this.getConfig = options.getConfig
    this.pluginRoot = options.pluginRoot
    this.logger = options.logger
  }

  /** 解析 adb 路径并校验存在。 */
  resolve() {
    const settings = this.getConfig()
    const paths = resolveExecutablePaths({
      pluginRoot: this.pluginRoot,
      adbPath: settings.adbPath,
      scrcpyPath: settings.scrcpyPath,
      join,
    })
    if (!existsSync(paths.adbPath)) {
      return {
        ok: false,
        error: `找不到 adb：${paths.adbPath}。请在「设置 → 安卓调试」里填正确的 adb.exe 路径。`,
        paths,
      }
    }
    return { ok: true, path: paths.adbPath, paths }
  }

  /** 解析 scrcpy 路径。 */
  resolveScrcpy() {
    const settings = this.getConfig()
    return resolveExecutablePaths({
      pluginRoot: this.pluginRoot,
      adbPath: settings.adbPath,
      scrcpyPath: settings.scrcpyPath,
      join,
    })
  }

  /**
   * 执行 adb 子命令（自动加 -s）。
   * @param {string[]} args
   * @param {{serial?:string, timeoutMs?:number, maxBytes?:number, binary?:boolean}} [options]
   */
  async run(args, options = {}) {
    const resolved = this.resolve()
    if (!resolved.ok) return { ok: false, code: null, stdout: '', stderr: '', elapsedMs: 0, error: resolved.error }
    const list = Array.isArray(args) ? [...args] : []
    const serial = String(options.serial ?? '').trim()
    const argv = serial.length > 0 ? ['-s', serial, ...list] : list
    const result = await runProcess(resolved.path, argv, {
      timeoutMs: options.timeoutMs ?? this.getConfig().adbTimeoutMs,
      maxBytes: options.maxBytes,
      binary: options.binary === true,
    })
    if (result.ok !== true && result.error === undefined) {
      result.error = (result.stderr || '').trim() || `adb 退出码 ${result.code ?? '?'}`
    }
    return result
  }

  /** `adb version`。 */
  async version() {
    const result = await this.run(['version'], { timeoutMs: 8000 })
    if (result.ok !== true) return result
    return { ok: true, version: result.stdout.trim(), path: this.resolve().path }
  }

  /** `adb devices -l`。 */
  async devices() {
    const result = await this.run(['devices', '-l'], { timeoutMs: 12000 })
    if (result.ok !== true) return { ok: false, error: result.error, devices: [] }
    return { ok: true, devices: parseAdbDevices(result.stdout), raw: result.stdout.trim() }
  }

  /** 选中设备（返回 ok/device/error）。 */
  async selectDevice(preferred) {
    const listed = await this.devices()
    if (listed.ok !== true) return { ok: false, error: listed.error, devices: [] }
    const picked = pickDevice(listed.devices, preferred)
    return { ...picked, devices: listed.devices }
  }

  /** 连接无线设备。 */
  async connect(host, port) {
    const target = `${String(host ?? '').trim()}:${Number(port) || 5555}`
    if (String(host ?? '').trim().length === 0) return { ok: false, error: '请先填写设备 IP。' }
    const result = await this.run(['connect', target], { timeoutMs: 15000 })
    return { ok: result.ok === true, target, output: (result.stdout || result.stderr || '').trim(), error: result.ok === true ? undefined : result.error }
  }

  /** 断开无线设备。 */
  async disconnect(host, port) {
    const target = `${String(host ?? '').trim()}:${Number(port) || 5555}`
    const result = await this.run(['disconnect', target], { timeoutMs: 10000 })
    return { ok: result.ok === true, target, output: (result.stdout || result.stderr || '').trim(), error: result.ok === true ? undefined : result.error }
  }

  /** Android 11+ 无线调试配对。 */
  async pair(host, port, code) {
    const target = `${String(host ?? '').trim()}:${Number(port)}`
    if (String(host ?? '').trim().length === 0) return { ok: false, error: '请先填写设备 IP。' }
    if (!Number(port)) return { ok: false, error: '请填写无线调试的配对端口。' }
    if (String(code ?? '').trim().length === 0) return { ok: false, error: '请填写手机屏幕上显示的配对码。' }
    const result = await this.run(['pair', target, String(code).trim()], { timeoutMs: 30000 })
    return { ok: result.ok === true, target, output: (result.stdout || result.stderr || '').trim(), error: result.ok === true ? undefined : result.error }
  }

  /** 确保 adb 的 mDNS 发现已启用（旧 adb 可能不支持 mdns 子命令，失败可忽略）。 */
  async mdnsCheck() {
    return this.run(['mdns', 'check'], { timeoutMs: 8000 })
  }

  /** `adb mdns services`：列出网络上的配对 / 连接服务。 */
  async mdnsServices() {
    const result = await this.run(['mdns', 'services'], { timeoutMs: 10000 })
    if (result.ok !== true) return { ok: false, error: result.error, services: [] }
    return { ok: true, services: parseMdnsServices(result.stdout), raw: result.stdout.trim() }
  }

  /** USB 已连接时开启 TCP 模式。 */
  async enableTcpip(serial, port = 5555) {
    const result = await this.run(['tcpip', String(port)], { serial, timeoutMs: 15000 })
    return { ok: result.ok === true, port, output: (result.stdout || result.stderr || '').trim(), error: result.ok === true ? undefined : result.error }
  }

  /** 执行 shell 命令。 */
  async shell(serial, command, options = {}) {
    const text = String(command ?? '').trim()
    if (text.length === 0) return { ok: false, error: '命令为空。' }
    return this.run(['shell', text], { serial, timeoutMs: options.timeoutMs })
  }

  /** 发送按键。 */
  async keyevent(serial, key) {
    const code = resolveKeyCode(key)
    if (code === undefined) return { ok: false, error: `不认识的按键：${key}` }
    return this.run(['shell', `input keyevent ${code}`], { serial, timeoutMs: 8000 })
  }

  /** tap。 */
  async tap(serial, x, y) {
    return this.run(['shell', `input tap ${Math.round(Number(x))} ${Math.round(Number(y))}`], { serial, timeoutMs: 8000 })
  }

  /** 长按 / 滑动。 */
  async swipe(serial, x1, y1, x2, y2, durationMs = 300) {
    const ms = Math.max(50, Math.round(Number(durationMs) || 300))
    return this.run(
      ['shell', `input swipe ${Math.round(Number(x1))} ${Math.round(Number(y1))} ${Math.round(Number(x2))} ${Math.round(Number(y2))} ${ms}`],
      { serial, timeoutMs: 12000 },
    )
  }

  /** 输入 ASCII 文本（Android input 不支持中文，中文会返回提示）。 */
  async inputText(serial, text) {
    const source = String(text ?? '')
    if (source.length === 0) return { ok: false, error: '文本为空。' }
    if (/[^\x20-\x7e]/u.test(source)) {
      return {
        ok: false,
        error: 'adb input text 只支持 ASCII。中文/emoji 请用「打开 scrcpy 窗口」在电脑键盘输入，或先装输入法辅助应用。',
        unsupported: true,
      }
    }
    const escaped = source.replace(/ /gu, '%s').replace(/'/gu, `'\\''`)
    return this.run(['shell', `input text '${escaped}'`], { serial, timeoutMs: 8000 })
  }

  /**
   * 截图，返回 PNG Buffer。
   * 优先 exec-out（二进制安全）；失败时退回 shell screencap 到设备临时文件再 exec-out cat。
   */
  async screencap(serial) {
    const direct = await this.run(['exec-out', 'screencap', '-p'], {
      serial,
      timeoutMs: 15000,
      maxBytes: IMAGE_MAX_BYTES,
      binary: true,
    })
    if (direct.ok === true && pngSize(direct.buffer) !== undefined) {
      const size = pngSize(direct.buffer)
      return { ok: true, buffer: direct.buffer, width: size.width, height: size.height }
    }

    const remote = `/data/local/tmp/dsh-android-${Date.now()}.png`
    const shot = await this.run(['shell', `screencap -p ${remote}`], { serial, timeoutMs: 15000 })
    if (shot.ok !== true) {
      return { ok: false, error: shot.error ?? '截图失败', stderr: direct.stderr }
    }
    const pulled = await this.run(['exec-out', 'cat', remote], {
      serial,
      timeoutMs: 15000,
      maxBytes: IMAGE_MAX_BYTES,
      binary: true,
    })
    void this.run(['shell', `rm -f ${remote}`], { serial, timeoutMs: 3000 })
    const size = pngSize(pulled.buffer)
    if (pulled.ok === true && size !== undefined) {
      return { ok: true, buffer: pulled.buffer, width: size.width, height: size.height }
    }
    return {
      ok: false,
      error: `截图失败：${pulled.error ?? direct.error ?? '返回数据不是 PNG'}`,
      stderr: `${direct.stderr || ''}\n${pulled.stderr || ''}`.trim(),
    }
  }
}
