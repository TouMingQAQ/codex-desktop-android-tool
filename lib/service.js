/**
 * AndroidService：把 adb、logcat、性能、scrcpy 推流与独立窗口拼成一个门面。
 *
 * 对上层只暴露方法；所有方法都返回 `{ ok, ... }`，绝不抛。
 */

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import QRCode from 'qrcode'
import { resolveDataRoot, resolveExecutablePaths } from './config.js'
import { layoutAt } from './paths.js'
import { Adb, parseMdnsEndpoint, pickDevice, resolveKeyCode } from './adb.js'
import {
  diffButtons,
  emptyGamepadState,
  GAMEPAD_KEYCODE_FALLBACK,
  gamepadSummary,
  normalizeGamepadState,
  resolveGamepadType,
} from './gamepad.js'
import { LogcatService } from './logcat.js'
import { PerfService } from './perf.js'
import { parseBattery } from './perf.js'
import { ScrcpyStream } from './scrcpy-stream.js'
import { ScrcpyWindow } from './scrcpy-window.js'
import { Aab2ApkService } from './aab2apk.js'

/** 把 `wm size` 输出解析成 { width, height }。 */
export function parseWmSize(text) {
  const matches = [...String(text ?? '').matchAll(/(\d+)\s*x\s*(\d+)/giu)]
  if (matches.length === 0) return undefined
  const last = matches[matches.length - 1]
  return { width: Number(last[1]), height: Number(last[2]) }
}

/** 解析 df -k /data。 */
export function parseDf(text) {
  const lines = String(text ?? '').trim().split(/\r?\n/u)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parts = lines[index].trim().split(/\s+/u)
    if (parts.length < 6) continue
    const totalKb = Number(parts[1])
    const usedKb = Number(parts[2])
    const freeKb = Number(parts[3])
    if ([totalKb, usedKb, freeKb].every((value) => Number.isFinite(value))) {
      return { totalKb, usedKb, freeKb }
    }
  }
  return undefined
}

/** 解析 wifi 组合命令结果。 */
export function parseWifi(text) {
  const source = String(text ?? '')
  const enabledMatch = /Wi-?Fi is (enabled|disabled)/iu.exec(source)
  const ssidMatch = /SSID:\s*("?)([^"\r\n]*)\1/iu.exec(source)
  const ipMatch = /inet\s+(\d+\.\d+\.\d+\.\d+)/u.exec(source)
  const airplaneMatch = /==AIR\r?\n(\d+)/u.exec(source)
  return {
    enabled: enabledMatch !== null ? /enabled/iu.test(enabledMatch[1]) : undefined,
    ssid: ssidMatch !== null ? ssidMatch[2].trim() : undefined,
    ip: ipMatch !== null ? ipMatch[1] : undefined,
    airplaneMode: airplaneMatch !== null ? airplaneMatch[1] === '1' : undefined,
  }
}

/** 生成随机十六进制串。 */
function randomHex(byteLength) {
  return randomBytes(byteLength).toString('hex')
}

/**
 * 生成 Android 无线调试「二维码配对」载荷。
 * 手机在「无线调试 → 使用二维码配对设备」里扫描后，
 * 会以 `S` 作为 mDNS 实例名起一个 `_adb-tls-pairing._tcp` 服务，
 * 之后电脑用 `adb pair <endpoint> <password>` 完成配对。
 *
 * @param {string} service 配对服务名（对应二维码里的 S）
 * @param {string} password 配对码（对应二维码里的 P）
 * @returns {string}
 */
export function buildPairingPayload(service, password) {
  const name = String(service ?? '').trim()
  const code = String(password ?? '').trim()
  if (name.length === 0 || /[;\r\n]/u.test(name)) throw new Error('非法配对服务名')
  if (code.length === 0 || /[;\r\n]/u.test(code)) throw new Error('非法配对码')
  return `WIFI:T:ADB;S:${name};P:${code};;`
}

export class AndroidService {
  /**
   * @param {object} options
   * @param {object} options.ctx
   * @param {() => object} options.getConfig
   * @param {string} options.pluginRoot
   * @param {() => string} [options.getProfileDir]
   * @param {() => string} [options.getHomeDir]
   * @param {object} [options.logger]
   */
  constructor(options) {
    this.ctx = options.ctx
    this.getConfig = options.getConfig
    this.pluginRoot = options.pluginRoot
    this.getProfileDir = options.getProfileDir ?? (() => process.env.DSH_PROFILE_DIR ?? '')
    this.getHomeDir = options.getHomeDir ?? (() => homedir())
    this.logger = options.logger

    this.adb = new Adb({ getConfig: options.getConfig, pluginRoot: options.pluginRoot, logger: options.logger })
    this.logcat = new LogcatService({ adb: this.adb, getConfig: options.getConfig, logger: options.logger })
    this.perf = new PerfService({ adb: this.adb, logger: options.logger })
    this.stream = new ScrcpyStream({ adb: this.adb, getConfig: options.getConfig, pluginRoot: options.pluginRoot, logger: options.logger })
    this.window = new ScrcpyWindow({ adb: this.adb, getConfig: options.getConfig, logger: options.logger })
    this.aab2apk = new Aab2ApkService({
      getDataRoot: () => this.resolveDataRoot().root,
      getWorkspaceRoot: () => this.getWorkspaceDir(),
      getLegacyConfigPaths: () => {
        const profile = String(this.getProfileDir() ?? '').trim()
        return profile.length > 0 ? [join(profile, '.dsh-android-tool', 'aab2apk.config.json')] : []
      },
      pluginRoot: options.pluginRoot,
      logger: options.logger,
    })

    // 最近一次跑工具时看到的会话（Agent），用来把数据落到它的工作区。
    this.activeSessionId = ''
    this.state = { deviceSerial: '', lastAddress: '' }
    this.stateLoaded = undefined
    this.agentActionAt = 0
    this.statePollCount = 0
    this.devicesCache = undefined
    this.deviceSize = undefined
    // 手柄回退（无 scrcpy control 时）用的上一帧状态。
    this.gamepadState = emptyGamepadState()
    this.gamepadType = 'xbox'
    // 当前进行中的「扫码配对」会话（见 startQrPairing）。
    this.qrPairing = undefined
    this.disposed = false
  }

  /** 取宿主服务。 */
  get(name) {
    try {
      return this.ctx?.get?.(name)
    } catch {
      return undefined
    }
  }

  /**
   * 目标工作区：优先按当前会话匹配 workspaceRegistry 里的记录，
   * 其次用环境里的 DSH_SESSION_ID，再退回「唯一工作区 / 与进程 cwd 相同」。
   * 取不到返回空串，由 resolveDataRoot 退到 DSH profile。
   *
   * @returns {string} 工作区绝对路径，或 ''
   */
  getWorkspaceDir() {
    try {
      const registry = this.get('workspaceRegistry')
      const list = typeof registry?.list === 'function' ? registry.list() : []
      if (Array.isArray(list) && list.length > 0) {
        const want = this.pickWorkspace(list)
        if (want !== undefined) return want
      }
    } catch {
      // 没有 workspaceRegistry：交给后面的兜底
    }
    // 有些 DSH 版本没有 workspaceRegistry，但会给出当前工作目录
    const fallback = String(this.get('workingDirectory')?.defaultDirectory ?? '').trim()
    return fallback
  }

  /** 在 workspace 列表里挑当前会话所属的那个。 */
  pickWorkspace(list) {
    const norm = (p) => String(p ?? '').replace(/[\\/]+$/u, '').toLowerCase()
    const sessionId = String(this.activeSessionId || process.env.DSH_SESSION_ID || '').trim()
    if (sessionId.length > 0) {
      const hit = list.find((ws) => Array.isArray(ws?.sessionIds) && ws.sessionIds.includes(sessionId))
      if (hit !== undefined && typeof hit.path === 'string' && hit.path.length > 0) return hit.path
    }
    const cwd = norm(process.cwd())
    const byCwd = list.find((ws) => norm(ws?.path) === cwd)
    if (byCwd !== undefined && typeof byCwd.path === 'string') return byCwd.path
    if (list.length === 1 && typeof list[0]?.path === 'string') return list[0].path
    return undefined
  }

  /** 工具执行时记下会话 id（Agent.id），供工作区解析使用。 */
  noteAgent(agent) {
    const id = typeof agent?.id === 'string' ? agent.id.trim() : ''
    if (id.length > 0) this.activeSessionId = id
  }

  /** 面板请求带上 session 时，同样记下来。 */
  noteSessionId(id) {
    const text = typeof id === 'string' ? id.trim() : ''
    if (text.length > 0) this.activeSessionId = text
  }

  /** 数据根目录。 */
  resolveDataRoot() {
    return resolveDataRoot({
      workspaceDir: this.getWorkspaceDir(),
      profileDir: String(this.getProfileDir() ?? '').trim(),
      homeDir: this.getHomeDir(),
      join,
    })
  }

  /** 确保数据目录存在。 */
  async ensureDirs() {
    const { root } = this.resolveDataRoot()
    const layout = layoutAt(root)
    try {
      await mkdir(layout.logsDir, { recursive: true })
      return { ok: true, layout }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 读运行期状态（只读一次）。 */
  async loadState() {
    if (this.stateLoaded !== undefined) return this.stateLoaded
    const { root } = this.resolveDataRoot()
    const layout = layoutAt(root)
    this.stateLoaded = (async () => {
      try {
        const text = await readFile(layout.stateFile, 'utf8')
        const parsed = JSON.parse(text)
        if (parsed !== null && typeof parsed === 'object') {
          this.state = {
            deviceSerial: typeof parsed.deviceSerial === 'string' ? parsed.deviceSerial : '',
            lastAddress: typeof parsed.lastAddress === 'string' ? parsed.lastAddress : '',
          }
        }
      } catch {
        // 文件不存在或损坏：用默认值
      }
      return this.state
    })()
    return this.stateLoaded
  }

  /** 原子写运行期状态。 */
  async saveState() {
    const { root } = this.resolveDataRoot()
    const layout = layoutAt(root)
    try {
      await mkdir(root, { recursive: true })
      const temp = `${layout.stateFile}.tmp`
      await writeFile(temp, JSON.stringify(this.state, null, 2), 'utf8')
      await rename(temp, layout.stateFile)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 初始化：读状态 + 按需自动连接。 */
  async init() {
    await this.loadState()
    const settings = this.getConfig()
    if (settings.autoConnect === true && settings.wirelessHost.length > 0) {
      void this.adb.connect(settings.wirelessHost, settings.wirelessPort).then((result) => {
        if (result.ok === true) {
          this.state.lastAddress = result.target ?? ''
          void this.saveState()
        }
      })
    }
  }

  /** AI 用了工具 → 面板自动弹出。 */
  markAgentAction() {
    this.agentActionAt = Date.now()
  }

  /** 当前 adb 路径信息。 */
  adbInfo() {
    const paths = resolveExecutablePaths({
      pluginRoot: this.pluginRoot,
      adbPath: this.getConfig().adbPath,
      scrcpyPath: this.getConfig().scrcpyPath,
      join,
    })
    return {
      path: paths.adbPath,
      exists: existsSync(paths.adbPath),
      scrcpyPath: paths.scrcpyPath,
      scrcpyExists: existsSync(paths.scrcpyPath),
      serverExists: existsSync(paths.serverPath),
    }
  }

  /** 选一台设备（不抛）。 */
  async resolveDevice(preferred) {
    await this.loadState()
    const wanted = String(preferred ?? this.state.deviceSerial ?? '').trim()
    // 已经有一条活着的 scrcpy 连接时，直接认它，避免每次点击都 spawn 一次
    // `adb devices`——那会平白给每次触控加 50–100ms。
    if (this.stream.running === true && this.stream.serial.length > 0) {
      if (wanted.length === 0 || wanted === this.stream.serial) {
        return { ok: true, device: { serial: this.stream.serial, state: 'device' } }
      }
    }
    const picked = await this.adb.selectDevice(wanted)
    if (picked.ok === true && this.state.deviceSerial !== picked.device.serial) {
      this.state.deviceSerial = picked.device.serial
      void this.saveState()
    }
    return picked
  }

  /** 面板/设置页状态。 */
  async uiState() {
    this.statePollCount += 1
    await this.loadState()
    // 面板/自动打开/设置页都会打这个接口；缓存 1.5 秒，避免每秒 spawn 多次 adb。
    if (this.devicesCache === undefined || Date.now() - this.devicesCache.at > 1500) {
      this.devicesCache = { at: Date.now(), result: await this.adb.devices() }
    }
    const listed = this.devicesCache.result
    const picked = listed.ok === true ? pickDevice(listed.devices, this.state.deviceSerial) : { ok: false, error: listed.error }
    const chosen = picked.ok === true ? picked.device : undefined
    if (chosen !== undefined && this.state.deviceSerial !== chosen.serial) {
      this.state.deviceSerial = chosen.serial
      void this.saveState()
    }
    return {
      ok: true,
      adb: this.adbInfo(),
      devices: listed.devices ?? [],
      selectedSerial: chosen?.serial ?? this.state.deviceSerial ?? '',
      device: chosen ?? null,
      deviceError: chosen === undefined ? picked.error : undefined,
      stream: this.stream.status(),
      gamepad: this.stream.gamepadStatus(),
      window: this.window.status(),
      logcat: {
        running: this.logcat.running,
        serial: this.logcat.serial,
        lines: this.logcat.entries.length,
        error: this.logcat.lastError || undefined,
      },
      previewFps: this.getConfig().previewFps,
      statePollCount: this.statePollCount,
      agentActionAt: this.agentActionAt,
    }
  }

  /** 当前前台应用。 */
  async currentApp(serial) {
    const result = await this.adb.shell(
      serial,
      "dumpsys activity activities 2>/dev/null | grep -E 'mResumedActivity|topResumedActivity' | head -n 1",
      { timeoutMs: 8000 },
    )
    if (result.ok !== true) return undefined
    const match = /([a-zA-Z][\w.]*\/[\w.$]+)/u.exec(result.stdout)
    if (match === null) return undefined
    return match[1]
  }

  /** 截图（返回 buffer + 可选图片附件）。 */
  async screencapture(input = {}) {
    const picked = await this.resolveDevice(input.serial)
    if (picked.ok !== true) return { ok: false, error: picked.error }
    const serial = picked.device.serial
    const shot = await this.adb.screencap(serial)
    if (shot.ok !== true) return { ok: false, error: shot.error, serial }

    let savedPath
    const explicit = String(input.savePath ?? '').trim()
    if (explicit.length > 0) {
      try {
        await mkdir(dirname(explicit), { recursive: true })
        await writeFile(explicit, shot.buffer)
        savedPath = explicit
      } catch {
        savedPath = undefined
      }
    }

    let image
    const attachments = this.get('attachments')
    if (attachments !== undefined && typeof attachments.saveImage === 'function') {
      try {
        const ref = await attachments.saveImage({
          data: shot.buffer,
          mediaType: 'image/png',
          name: `android-${serial.replace(/[^\w.-]/gu, '_')}.png`,
        })
        image = {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
          ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }),
        }
      } catch {
        image = undefined
      }
    }

    if (input.mark !== false) this.markAgentAction()

    let current
    if (input.includeState !== false) {
      const app = await this.currentApp(serial)
      const model = await this.adb.shell(serial, 'getprop ro.product.model', { timeoutMs: 5000 })
      current = {
        model: model.ok === true ? model.stdout.trim() : '',
        activity: app ?? '',
        package: app !== undefined ? app.split('/')[0] : '',
      }
    }

    return {
      ok: true,
      serial,
      width: shot.width,
      height: shot.height,
      bytes: shot.buffer.length,
      path: savedPath,
      image,
      // Codex MCP server 用：把 PNG 字节一并带出，便于直接转成 MCP image content。
      buffer: shot.buffer,
      ...(current === undefined ? {} : current),
      capturedAt: Date.now(),
    }
  }

  /** 只取截图字节，给面板 <img> / 轮询用。 */
  async screenshotBuffer(serial) {
    const picked = await this.resolveDevice(serial)
    if (picked.ok !== true) return { ok: false, error: picked.error }
    const shot = await this.adb.screencap(picked.device.serial)
    return shot
  }

  /** 设备状态（电量 / WiFi / 存储 / 内存 / 屏幕 / 当前应用）。 */
  async deviceState(input = {}) {
    const picked = await this.resolveDevice(input.serial)
    if (picked.ok !== true) return { ok: false, error: picked.error }
    const serial = picked.device.serial

    const propsResult = await this.adb.shell(serial, 'getprop ro.product.model; getprop ro.product.brand; getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.cpu.abi', { timeoutMs: 8000 })
    const props = propsResult.ok === true ? propsResult.stdout.split(/\r?\n/u) : []
    const [model = '', brand = '', android = '', sdk = '', abi = ''] = props.map((line) => line.trim())

    const batteryResult = await this.adb.shell(serial, 'dumpsys battery', { timeoutMs: 8000 })
    const battery = parseBattery(batteryResult.stdout)

    const wifiCommand = [
      "echo '==WIFI'",
      'cmd wifi status 2>/dev/null',
      "echo '==IP'",
      'ip -f inet addr show wlan0 2>/dev/null',
      "echo '==AIR'",
      'settings get global airplane_mode_on 2>/dev/null',
    ].join('; ')
    const wifiResult = await this.adb.shell(serial, wifiCommand, { timeoutMs: 8000 })
    const wifi = parseWifi(wifiResult.stdout)

    const memResult = await this.adb.shell(serial, 'cat /proc/meminfo', { timeoutMs: 8000 })
    const mem = parseMeminfoSafe(memResult.stdout)

    const dfResult = await this.adb.shell(serial, 'df -k /data', { timeoutMs: 8000 })
    const storage = parseDf(dfResult.stdout)

    const sizeResult = await this.adb.shell(serial, 'wm size; wm density', { timeoutMs: 8000 })
    const display = parseWmSize(sizeResult.stdout)
    const densityMatch = /Physical density:\s*(\d+)/iu.exec(sizeResult.stdout)

    const powerResult = await this.adb.shell(serial, "dumpsys power 2>/dev/null | grep -E 'mWakefulness=' | head -n 1", { timeoutMs: 8000 })
    const wakeMatch = /mWakefulness=(\w+)/u.exec(powerResult.stdout)

    const app = await this.currentApp(serial)

    return {
      ok: true,
      serial,
      model,
      brand,
      android,
      sdk,
      abi,
      battery,
      wifi,
      memory: mem,
      storage,
      display: display === undefined ? undefined : { ...display, density: densityMatch !== null ? Number(densityMatch[1]) : undefined },
      screen: { wakefulness: wakeMatch !== null ? wakeMatch[1] : undefined },
      current: app === undefined ? undefined : { activity: app, package: app.split('/')[0] },
      sampledAt: Date.now(),
    }
  }

  /**
   * 把设备物理坐标换算成 scrcpy 视频坐标。
   * 面板点击本来就来自视频坐标（input.videoCoords=true），AI 工具截图看到的是
   * 设备物理尺寸，所以只有工具调用需要换算。
   */
  async toVideoPoint(serial, x, y) {
    const width = this.stream.width || 0
    const height = this.stream.height || 0
    if (!(width > 0) || !(height > 0)) return undefined
    if (this.deviceSize === undefined || Date.now() - this.deviceSize.at > 5000) {
      const result = await this.adb.shell(serial, 'wm size', { timeoutMs: 5000 })
      const parsed = parseWmSize(result.stdout) ?? { width: 1080, height: 1920 }
      this.deviceSize = { at: Date.now(), ...parsed }
    }
    return {
      x: (Number(x) * width) / (this.deviceSize.width || width),
      y: (Number(y) * height) / (this.deviceSize.height || height),
    }
  }

  /** 模拟触屏 / 按键。优先走 scrcpy control 通道，延迟比 adb shell input 低很多。 */
  async control(input = {}) {
    const picked = await this.resolveDevice(input.serial)
    if (picked.ok !== true) return { ok: false, error: picked.error }
    const serial = picked.device.serial
    const action = String(input.action ?? '').trim()
    if (action === 'gamepad') return this.setGamepad({ ...input, serial })
    if (action === 'gamepad_disconnect' || action === 'gamepadDisconnect') return this.disconnectGamepad({ serial })
    const stream = this.stream
    const fast = stream.controlReady()
    let result
    let used = 'adb'

    const point = async (x, y) => {
      if (input.videoCoords === true) return { x: Number(x), y: Number(y) }
      return (await this.toVideoPoint(serial, x, y)) ?? { x: Number(x), y: Number(y) }
    }

    if (action === 'tap') {
      if (fast) {
        const p = await point(input.x, input.y)
        result = (await stream.controlTap(p.x, p.y)) ? { ok: true } : { ok: false, error: 'scrcpy control 写入失败' }
        used = 'scrcpy'
      } else {
        result = await this.adb.tap(serial, input.x, input.y)
      }
    } else if (action === 'long_press') {
      const ms = Number(input.durationMs) || 700
      if (fast) {
        const p = await point(input.x, input.y)
        result = (await stream.controlSwipe(p.x, p.y, p.x, p.y, ms)) ? { ok: true } : { ok: false, error: 'scrcpy control 写入失败' }
        used = 'scrcpy'
      } else {
        result = await this.adb.swipe(serial, input.x, input.y, input.x, input.y, ms)
      }
    } else if (action === 'swipe') {
      const duration = input.durationMs ?? 300
      if (fast) {
        const a = await point(input.x, input.y)
        const b = await point(input.x2, input.y2)
        result = (await stream.controlSwipe(a.x, a.y, b.x, b.y, duration)) ? { ok: true } : { ok: false, error: 'scrcpy control 写入失败' }
        used = 'scrcpy'
      } else {
        result = await this.adb.swipe(serial, input.x, input.y, input.x2, input.y2, duration)
      }
    } else if (action === 'key') {
      const code = resolveKeyCode(input.key)
      if (fast && code !== undefined) {
        result = (await stream.controlKey(code)) ? { ok: true } : { ok: false, error: 'scrcpy control 写入失败' }
        used = 'scrcpy'
      } else {
        result = await this.adb.keyevent(serial, input.key)
      }
    } else if (action === 'text') {
      if (fast) {
        result = stream.controlText(input.text) ? { ok: true } : { ok: false, error: 'scrcpy control 写入失败' }
        used = 'scrcpy'
      } else {
        result = await this.adb.inputText(serial, input.text)
      }
    } else if (action === 'scroll') {
      const direction = String(input.direction ?? 'down')
      const amount = Math.max(1, (Number(input.amount) || 400) / 200)
      if (fast) {
        result = stream.controlScroll(direction, amount) ? { ok: true } : { ok: false, error: 'scrcpy control 写入失败' }
        used = 'scrcpy'
      } else {
        const size = parseWmSize((await this.adb.shell(serial, 'wm size', { timeoutMs: 5000 })).stdout) ?? { width: 1080, height: 1920 }
        const pixels = Math.max(50, Number(input.amount) || 400)
        const cx = Math.round(size.width / 2)
        const cy = Math.round(size.height / 2)
        if (direction === 'up') result = await this.adb.swipe(serial, cx, cy - pixels, cx, cy + pixels, 250)
        else if (direction === 'down') result = await this.adb.swipe(serial, cx, cy + pixels, cx, cy - pixels, 250)
        else if (direction === 'left') result = await this.adb.swipe(serial, cx - pixels, cy, cx + pixels, cy, 250)
        else result = await this.adb.swipe(serial, cx + pixels, cy, cx - pixels, cy, 250)
      }
    } else if (action === 'wake') {
      if (fast && stream.controlPower(true)) {
        result = { ok: true }
        used = 'scrcpy'
      } else {
        result = await this.adb.keyevent(serial, 'wakeup')
      }
    } else if (action === 'open_app') {
      const pkg = String(input.package ?? '').trim()
      if (pkg.length === 0) return { ok: false, error: 'open_app 需要 package 参数。' }
      result = await this.adb.shell(serial, `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, { timeoutMs: 15000 })
    } else {
      return { ok: false, error: `不支持的 action：${action || '(空)'}` }
    }

    if (result.ok !== true) return { ok: false, error: result.error, serial, action }
    this.markAgentAction()

    if (input.capture === false) {
      return { ok: true, serial, action, via: used }
    }
    const shot = await this.screencapture({ serial, mark: true, includeState: true })
    return {
      ok: true,
      serial,
      action,
      via: used,
      ...(shot.ok === true
        ? {
            width: shot.width,
            height: shot.height,
            image: shot.image,
            model: shot.model,
            package: shot.package,
            activity: shot.activity,
          }
        : { screenshotError: shot.error }),
    }
  }

  /**
   * 设置手柄输入。
   *
   * 优先走 scrcpy UHID（真·手柄，摇杆/扳机都有）；control 通道不可用时回退到
   * adb keyevent（只能点按按键，摇杆/扳机不支持）。
   *
   * 参数（input）：
   *   - gamepad / 直接字段：buttons（数组或对象）、lstick、rstick、lt、rt
   *   - merge:true 在上一帧上叠加，否则绝对覆盖（没给的按键视为松开）
   *   - holdMs：按下后保持多久再全部松开（做「点一下」）
   *   - capture：是否在操作后回一张截图（默认 false）
   */
  async setGamepad(input = {}) {
    const picked = await this.resolveDevice(input.serial)
    if (picked.ok !== true) return { ok: false, error: picked.error }
    const serial = picked.device.serial

    const source = String(input.source ?? 'ai')
    const gamepadType = String(input.gamepadType ?? input.controller ?? this.gamepadType ?? 'xbox')
    this.gamepadType = gamepadType
    const next = normalizeGamepadState(input.gamepad ?? input, {
      merge: input.merge === true,
      base: this.gamepadState,
    })

    // control 通道没起来时尝试拉起推流（AI 直接用手柄也能工作）；失败就回退。
    if (this.stream.controlReady() !== true && this.stream.running !== true) {
      try {
        await this.stream.start(serial)
      } catch {
        // 忽略，后面回退 adb
      }
    }

    let via = 'keyevent'
    let accepted = false
    if (this.stream.controlReady() === true) {
      // 第一次用时先建设备，稍等一下让内核/HAL 枚举，避免第一条输入被丢掉。
      const wasCreated = this.stream.gamepad?.created === true
      this.stream.ensureGamepadDevice?.()
      if (wasCreated !== true && this.stream.gamepad?.created === true) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      accepted = this.stream.setGamepad(next, { source, type: gamepadType })
      if (accepted === true) via = 'uhid'
    }

    if (accepted !== true) {
      // 回退：把新按下的按键用 keyevent 点一下；摇杆/扳机无法表达。
      const diff = diffButtons(this.gamepadState, next)
      for (const name of diff.pressed) {
        const code = GAMEPAD_KEYCODE_FALLBACK[name]
        if (code !== undefined) await this.adb.keyevent(serial, code)
      }
      via = 'keyevent'
    }

    this.gamepadState = next
    this.markAgentAction()

    // 按住一段时间后全部松开
    const holdMs = Number(input.holdMs)
    if (Number.isFinite(holdMs) && holdMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(60000, Math.max(1, Math.round(holdMs)))))
      const released = emptyGamepadState()
      if (this.stream.controlReady() === true) this.stream.setGamepad(released, { source, type: gamepadType })
      this.gamepadState = released
      const shot = input.capture === true ? await this.screencapture({ serial, mark: false, includeState: true }) : undefined
      return {
        ok: true,
        serial,
        action: 'gamepad',
        gamepadType,
        via,
        held: gamepadSummary(next),
        released: true,
        gamepad: released,
        ...(via === 'keyevent' ? { unsupported: ['lstick', 'rstick', 'lt', 'rt'], note: 'adb keyevent 回退只能点按按键，摇杆/扳机需要实时画面（scrcpy 推流）。' } : {}),
        ...(shot?.ok === true ? { image: shot.image, width: shot.width, height: shot.height } : {}),
      }
    }

    if (input.capture === true) {
      const shot = await this.screencapture({ serial, mark: false, includeState: true })
      return {
        ok: true,
        serial,
        action: 'gamepad',
        gamepadType,
        via,
        held: gamepadSummary(next),
        gamepad: next,
        ...(via === 'keyevent' ? { unsupported: ['lstick', 'rstick', 'lt', 'rt'], note: 'adb keyevent 回退只能点按按键，摇杆/扳机需要实时画面（scrcpy 推流）。' } : {}),
        ...(shot.ok === true ? { image: shot.image, width: shot.width, height: shot.height } : { screenshotError: shot.error }),
      }
    }

    return {
      ok: true,
      serial,
      action: 'gamepad',
      gamepadType,
      via,
      held: gamepadSummary(next),
      gamepad: next,
      ...(via === 'keyevent' ? { unsupported: ['lstick', 'rstick', 'lt', 'rt'], note: 'adb keyevent 回退只能点按按键，摇杆/扳机需要实时画面（scrcpy 推流）。' } : {}),
    }
  }

  /**
   * 切换虚拟手柄类型：xbox / ps / switch。
   * 有实时画面时销毁旧 UHID 设备并按新身份重建；否则只记下来，等有流再用。
   */
  async setGamepadType(type) {
    const picked = await this.resolveDevice()
    const serial = picked.ok === true ? picked.device.serial : ''
    const next = resolveGamepadType(type)
    this.gamepadType = next
    if (picked.ok !== true) return { ok: true, gamepadType: next, serial }
    if (this.stream.controlReady() !== true && this.stream.running !== true) {
      try {
        await this.stream.start(serial)
      } catch {
        // 忽略
      }
    }
    if (this.stream.controlReady() === true) {
      const result = this.stream.setGamepadType(next)
      return { ok: true, serial, ...result }
    }
    return { ok: true, serial, gamepadType: next }
  }

  /**
   * 主动断连虚拟手柄：销毁 UHID 设备，手机侧不再看到手柄；推流 / 画面不受影响。
   * 之后再按手柄任意键会自动重连。
   */
  async disconnectGamepad(input = {}) {
    this.gamepadState = emptyGamepadState()
    const result = typeof this.stream.disconnectGamepad === 'function'
      ? this.stream.disconnectGamepad()
      : { ok: true, disconnected: false }
    this.markAgentAction?.()
    return {
      ok: true,
      serial: String(input.serial ?? this.stream.serial ?? ''),
      action: 'gamepadDisconnect',
      disconnected: result.disconnected === true,
      gamepad: result.gamepad ?? this.stream.gamepadStatus?.(),
    }
  }

  /** 任意 adb 命令（最后兜底）。 */
  async adbCommand(input = {}) {
    const mode = String(input.mode ?? 'shell') === 'adb' ? 'adb' : 'shell'
    const command = String(input.command ?? '').trim()
    if (command.length === 0) return { ok: false, error: '命令为空。' }
    const timeoutMs = Math.max(1000, Math.min(120000, Number(input.timeoutMs) || 20000))

    let result
    if (mode === 'shell') {
      const picked = await this.resolveDevice(input.serial)
      if (picked.ok !== true) return { ok: false, error: picked.error }
      result = await this.adb.run(['shell', command], { serial: picked.device.serial, timeoutMs })
    } else {
      const args = splitArgsLoose(command)
      const serial = String(input.serial ?? '').trim()
      result = await this.adb.run(args, { serial, timeoutMs })
    }
    this.markAgentAction()
    return {
      ok: result.ok === true,
      mode,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated === true,
      elapsedMs: result.elapsedMs,
      error: result.ok === true ? undefined : result.error,
    }
  }

  // ── 扫码配对（手机扫电脑上的二维码）──────────────────────────────────────
  /**
   * 生成一个扫码配对会话：随机服务名 + 配对码 → 二维码 PNG。
   * 随后后台轮询 `adb mdns services`，等手机扫到二维码后完成配对并连接。
   * @returns {Promise<{ok:boolean, token?:string, status?:string, message?:string, expiresAt?:number, error?:string}>}
   */
  async startQrPairing() {
    this.cancelQrPairing()
    const service = `studio-${randomHex(8)}`
    const password = randomHex(6)
    let payload
    try {
      payload = buildPairingPayload(service, password)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    let png
    try {
      png = await QRCode.toBuffer(payload, {
        type: 'png',
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 420,
        color: { dark: '#000000ff', light: '#ffffffff' },
      })
    } catch (error) {
      return { ok: false, error: `生成二维码失败：${error instanceof Error ? error.message : String(error)}` }
    }
    const token = randomHex(12)
    const session = {
      token,
      service,
      password,
      payload,
      png,
      status: 'waiting',
      message: '等待手机扫描二维码…',
      createdAt: Date.now(),
      expiresAt: Date.now() + 120000,
      cancelled: false,
      endpoint: undefined,
      target: undefined,
      loop: undefined,
    }
    this.qrPairing = session
    session.loop = this.runQrPairing(session).catch((error) => {
      session.status = 'failed'
      session.message = `配对出错：${error instanceof Error ? error.message : String(error)}`
    })
    return { ok: true, token, status: session.status, message: session.message, expiresAt: session.expiresAt }
  }

  /** 后台配对流程：等配对服务 → adb pair → 等连接服务 → adb connect。 */
  async runQrPairing(session) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const alive = () => !session.cancelled && Date.now() < session.expiresAt && this.qrPairing === session
    // 启用 adb mDNS 发现；旧 adb 可能不支持，失败不影响后续轮询。
    void this.adb.mdnsCheck()

    let endpoint
    while (alive()) {
      endpoint = await this.findMdnsService(session.service, '_adb-tls-pairing._tcp')
      if (endpoint !== undefined) break
      await sleep(1000)
    }
    if (!alive()) {
      this.finishQrPairing(session, 'timeout', '超时：没等到手机配对服务。检查无线调试是否开启、手机与电脑是否在同一 Wi-Fi、防火墙是否放行 adb。')
      return
    }

    session.endpoint = `${endpoint.host}:${endpoint.port}`
    session.status = 'pairing'
    session.message = `发现手机 ${session.endpoint}，正在配对…`
    const pair = await this.adb.pair(endpoint.host, endpoint.port, session.password)
    if (pair.ok !== true) {
      this.finishQrPairing(session, 'failed', `配对失败：${pair.error ?? '未知错误'}`)
      return
    }

    session.status = 'connecting'
    session.message = '配对成功，正在查找连接服务…'
    const connectDeadline = Date.now() + 30000
    let target
    while (!session.cancelled && Date.now() < connectDeadline && this.qrPairing === session) {
      target = await this.findMdnsService(undefined, '_adb-tls-connect._tcp', endpoint.host)
      if (target !== undefined) break
      await sleep(1000)
    }
    if (session.cancelled) return
    if (target === undefined) {
      this.finishQrPairing(session, 'paired', '已配对，但没找到连接服务。可改用「IP 直连」手动连接。')
      return
    }
    const connect = await this.adb.connect(target.host, target.port)
    if (connect.ok === true) {
      session.target = `${target.host}:${target.port}`
      this.finishQrPairing(session, 'connected', `已连接 ${session.target}`)
      this.state.lastAddress = session.target
      void this.saveState()
      await this.loadState()
    } else {
      this.finishQrPairing(session, 'failed', `配对成功，但连接失败：${connect.error ?? ''}`)
    }
  }

  /** 在 mDNS 服务里找一条（可限定实例名 / 主机）。 */
  async findMdnsService(name, kind, host) {
    const result = await this.adb.mdnsServices()
    if (result.ok !== true) return undefined
    for (const row of result.services) {
      if (row.kind !== kind) continue
      if (name !== undefined && row.instance !== name) continue
      const parsed = parseMdnsEndpoint(row.endpoint)
      if (parsed === undefined) continue
      if (host !== undefined && parsed.host !== host) continue
      return parsed
    }
    return undefined
  }

  /** 结束一个扫码配对会话。 */
  finishQrPairing(session, status, message) {
    if (session === undefined) return
    session.status = status
    session.message = message
  }

  /** 查询扫码配对进度（给前端轮询）。 */
  qrPairingStatus(token) {
    const session = this.qrPairing
    if (session === undefined) return { ok: false, error: '没有进行中的扫码配对。' }
    const wanted = String(token ?? '').trim()
    if (wanted.length > 0 && session.token !== wanted) return { ok: false, error: '扫码配对会话已失效。' }
    return {
      ok: true,
      token: session.token,
      service: session.service,
      status: session.status,
      message: session.message,
      endpoint: session.endpoint,
      target: session.target,
      expiresAt: session.expiresAt,
      remainingMs: Math.max(0, session.expiresAt - Date.now()),
    }
  }

  /** 取扫码配对二维码 PNG。 */
  qrPairingImage(token) {
    const session = this.qrPairing
    if (session === undefined) return undefined
    const wanted = String(token ?? '').trim()
    if (wanted.length > 0 && session.token !== wanted) return undefined
    return session.png
  }

  /** 取消扫码配对。 */
  cancelQrPairing(token) {
    const session = this.qrPairing
    if (session === undefined) return { ok: true }
    const wanted = String(token ?? '').trim()
    if (wanted.length > 0 && session.token !== wanted) return { ok: false, error: '扫码配对会话已失效。' }
    session.cancelled = true
    this.qrPairing = undefined
    return { ok: true }
  }

  /** 设置页 / 面板按钮。 */
  async humanCommand(body = {}) {
    await this.loadState()
    const action = String(body.action ?? '').trim()
    if (action === 'testAdb') return this.adb.version()
    if (action === 'refreshDevices') return this.adb.devices()
    if (action === 'select') {
      this.state.deviceSerial = String(body.serial ?? '').trim()
      const saved = await this.saveState()
      return { ok: saved.ok === true, selectedSerial: this.state.deviceSerial, error: saved.error }
    }
    if (action === 'connect') {
      const result = await this.adb.connect(body.host, body.port)
      if (result.ok === true) {
        this.state.lastAddress = result.target ?? ''
        void this.saveState()
      }
      return result
    }
    if (action === 'pair') return this.adb.pair(body.host, body.port, body.code)
    if (action === 'qrPairStart') return this.startQrPairing()
    if (action === 'qrPairStatus') return this.qrPairingStatus(body.token)
    if (action === 'qrPairCancel') return this.cancelQrPairing(body.token)
    if (action === 'disconnect') return this.adb.disconnect(body.host, body.port)
    if (action === 'enableTcpip') {
      const picked = await this.resolveDevice(body.serial)
      if (picked.ok !== true) return { ok: false, error: picked.error }
      return this.adb.enableTcpip(picked.device.serial, body.port)
    }
    if (action === 'volume') {
      return this.control({
        action: 'key',
        key: Number(body.delta) >= 0 ? 'volume_up' : 'volume_down',
        serial: body.serial,
        capture: false,
        videoCoords: true,
      })
    }
    if (action === 'key') {
      return this.control({ action: 'key', key: body.key, serial: body.serial, capture: false, videoCoords: true })
    }
    if (action === 'tap' || action === 'swipe') {
      return this.control({ ...body, action, capture: false, videoCoords: true })
    }
    if (action === 'gamepad') {
      return this.setGamepad({ ...body, source: body.source ?? 'manual', capture: body.capture === true })
    }
    if (action === 'gamepadType') {
      return this.setGamepadType(body.gamepadType)
    }
    if (action === 'gamepadReset') {
      return this.setGamepad({ gamepad: emptyGamepadState(), source: 'manual', capture: false })
    }
    if (action === 'gamepadDisconnect') {
      return this.disconnectGamepad(body)
    }
    if (action === 'startScrcpy') {
      const picked = await this.resolveDevice(body.serial)
      if (picked.ok !== true) return { ok: false, error: picked.error }
      return this.window.launch(picked.device.serial)
    }
    if (action === 'stopScrcpy') return this.window.stop()
    if (action === 'startVideo') {
      const picked = await this.resolveDevice(body.serial)
      if (picked.ok !== true) return { ok: false, error: picked.error }
      return this.stream.start(picked.device.serial)
    }
    if (action === 'stopVideo') return this.stream.stop()
    if (action === 'logcatStart') {
      const picked = await this.resolveDevice(body.serial)
      if (picked.ok !== true) return { ok: false, error: picked.error }
      return this.logcat.ensure(picked.device.serial)
    }
    if (action === 'logcatStop') {
      this.logcat.stop()
      return { ok: true }
    }
    return { ok: false, error: `未知 action：${action || '(空)'}` }
  }

  /** 读 logcat。 */
  async logcatRead(options = {}) {
    const picked = await this.resolveDevice(options.serial)
    if (picked.ok !== true) return { ok: false, error: picked.error, entries: [], cursor: 0 }
    return this.logcat.read({ ...options, serial: picked.device.serial })
  }

  /** 运行中 / 已安装包名。 */
  async packages(options = {}) {
    const picked = await this.resolveDevice(options.serial)
    if (picked.ok !== true) return { ok: false, error: picked.error, running: [], installed: [], foreground: '' }
    return this.logcat.scanPackages(picked.device.serial)
  }

  /** 性能。 */
  async perfSample(options = {}) {
    const picked = await this.resolveDevice(options.serial)
    if (picked.ok !== true) return { ok: false, error: picked.error }
    const pkg = String(options.pkg ?? '').trim() || (await this.currentApp(picked.device.serial))?.split('/')[0] || ''
    return this.perf.sample(picked.device.serial, pkg)
  }

  /** 导出 logcat 到文件。 */
  async exportLogcat(filters = {}) {
    const picked = await this.resolveDevice(filters.serial)
    if (picked.ok !== true) return { ok: false, error: picked.error }
    await this.logcat.ensure(picked.device.serial)
    await this.logcat.ensurePidMap(picked.device.serial)
    const text = this.logcat.exportText(filters)
    const dirs = await this.ensureDirs()
    if (dirs.ok !== true) return { ok: false, error: dirs.error }
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
    const filename = `logcat-${stamp}.txt`
    const path = join(dirs.layout.logsDir, filename)
    try {
      await writeFile(path, text, 'utf8')
      return { ok: true, path, filename, bytes: Buffer.byteLength(text), lines: text.length === 0 ? 0 : text.trimEnd().split('\n').length, serial: picked.device.serial }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 当前 logcat 文本（下载用，不落盘）。 */
  async exportLogcatText(filters = {}) {
    const picked = await this.resolveDevice(filters.serial)
    if (picked.ok !== true) return { ok: false, error: picked.error, text: '' }
    await this.logcat.ensure(picked.device.serial)
    await this.logcat.ensurePidMap(picked.device.serial)
    return { ok: true, text: this.logcat.exportText(filters), serial: picked.device.serial }
  }

  /** scrcpy 推流。 */
  startVideo(serial) {
    return this.stream.start(serial)
  }

  stopVideo() {
    return this.stream.stop()
  }

  videoStatus() {
    return this.stream.status()
  }

  handleVideoUpgrade(req, socket, head) {
    return this.stream.handleUpgrade(req, socket, head)
  }

  /** 插件卸载。 */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.cancelQrPairing()
    this.window.dispose()
    this.logcat.dispose()
    this.stream.dispose()
    this.aab2apk.dispose()
  }
}

/** 避免循环 import：本文件已 import parseMeminfo 的兄弟函数，这里直接用。 */
function parseMeminfoSafe(text) {
  const values = {}
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const match = /^(MemTotal|MemFree|MemAvailable):\s+(\d+)/u.exec(line.trim())
    if (match !== null) values[match[1]] = Number(match[2])
  }
  const totalKb = values.MemTotal ?? 0
  const availableKb = values.MemAvailable ?? values.MemFree ?? 0
  return {
    totalMb: Math.round(totalKb / 1024),
    usedMb: Math.round(Math.max(0, totalKb - availableKb) / 1024),
    availableMb: Math.round(availableKb / 1024),
  }
}

/** 宽松拆 adb 参数。 */
function splitArgsLoose(text) {
  const out = []
  let current = ''
  let quote = ''
  for (const char of String(text ?? '')) {
    if (quote !== '') {
      if (char === quote) quote = ''
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/u.test(char)) {
      if (current.length > 0) {
        out.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current.length > 0) out.push(current)
  return out
}
