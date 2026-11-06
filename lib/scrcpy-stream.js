/**
 * scrcpy 视频推流（host 侧最小客户端）。
 *
 * 做法：
 *   1. adb push 随包的 scrcpy-server；
 *   2. adb forward 一个本地端口到设备 localabstract:scrcpy_<scid>；
 *   3. 启动 com.genymobile.scrcpy.Server 5.0.1（audio=false / control=false）；
 *   4. 连本地端口，解析 codec id、session packet、12 字节帧头；
 *   5. 通过 WebSocket 把每一帧推给浏览器，WebCodecs 解码到 canvas。
 *
 * 任何一步失败都返回结构化错误，由上层回退到截图轮询 / 独立 scrcpy 窗口。
 */

import { spawn } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { existsSync } from 'node:fs'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import {
  AndroidKeyEventAction,
  AndroidMotionEventAction,
  ScrcpyControlMessageSerializer,
  ScrcpyOptions5_0_1,
} from '@yume-chan/scrcpy'
import {
  buildHidReport,
  emptyGamepadState,
  GAMEPAD_HID_ID,
  GAMEPAD_HID_REPORT_DESC,
  gamepadStateEquals,
  gamepadTypeInfo,
  normalizeGamepadState,
  resolveGamepadType,
} from './gamepad.js'
import {
  joinAnnexB,
  parseFrameHeader,
  parseSessionPacket,
  readCodecId,
  scrcpySocketName,
  spsToCodecString,
  splitAnnexB,
  extractSpsPps,
} from './scrcpy-protocol.js'
import { handshakeResponse, WsConnection } from './ws.js'

/** 远端 server 路径。 */
const REMOTE_SERVER = '/data/local/tmp/scrcpy-server.jar'

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

/** 找一个空闲的本地 TCP 端口。 */
function getFreePort() {
  return new Promise((resolvePromise) => {
    const server = net.createServer()
    server.unref()
    server.on('error', () => resolvePromise(0))
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePromise(port))
    })
  })
}

/** 连一次本地端口（只看 TCP connect，不等业务数据）。 */
function connectOnce(port, timeoutMs = 1500) {
  return new Promise((resolvePromise) => {
    const client = net.connect({ port, host: '127.0.0.1' })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      client.destroy()
      resolvePromise({ ok: false, error: 'TCP 连接超时' })
    }, timeoutMs)
    client.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.destroy()
      resolvePromise({ ok: false, error: error instanceof Error ? error.message : String(error) })
    })
    client.once('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ok: true, socket: client })
    })
  })
}

/**
 * 连 scrcpy 的两个 socket（video + control），并等 video 真的收到首包。
 *
 * 为什么不能只看 TCP connect：adb forward 在 device 端还没有 LocalServerSocket
 * 监听时也会先 accept 再 close。另外开启 control 后，server 会先 accept video，
 * 再 accept control，两个都连上之后才开始发视频数据——所以必须成对连接。
 */
async function connectVideoControl(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    const video = await connectOnce(port)
    if (video.ok !== true) {
      lastError = video.error
      await delay(220)
      continue
    }
    const control = await connectOnce(port)
    if (control.ok !== true) {
      video.socket.destroy()
      lastError = control.error
      await delay(220)
      continue
    }
    const firstChunk = await new Promise((resolvePromise) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolvePromise(undefined)
      }, 1800)
      const finish = (chunk) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise(chunk)
      }
      video.socket.once('data', (chunk) => {
        video.socket.pause()
        finish(chunk)
      })
      video.socket.once('close', () => finish(undefined))
      video.socket.once('error', () => finish(undefined))
    })
    if (Buffer.isBuffer(firstChunk) && firstChunk.length > 0) {
      return { ok: true, video: video.socket, control: control.socket, firstChunk }
    }
    video.socket.destroy()
    control.socket.destroy()
    lastError = '连接在首包前被关闭'
    await delay(220)
  }
  return { ok: false, error: lastError || '连接 scrcpy server 超时' }
}

export class ScrcpyStream {
  /**
   * @param {object} options
   * @param {import('./adb.js').Adb} options.adb
   * @param {() => object} options.getConfig
   * @param {string} options.pluginRoot
   * @param {object} [options.logger]
   */
  constructor(options) {
    this.adb = options.adb
    this.getConfig = options.getConfig
    this.pluginRoot = options.pluginRoot
    this.logger = options.logger

    this.clients = new Set()
    this.serverChild = undefined
    this.socket = undefined
    this.controlSocket = undefined
    this.controlSerializer = new ScrcpyControlMessageSerializer(new ScrcpyOptions5_0_1({ control: true }))
    this.controlError = ''
    this.port = 0
    this.scid = 0
    this.serial = ''
    this.running = false
    this.error = ''
    this.serverLog = ''
    this.width = 0
    this.height = 0
    this.codec = ''
    this.sps = undefined
    this.pps = undefined
    this.buffer = Buffer.alloc(0)
    this.phase = 'codec'
    this.frameCounter = 0
    this.framesSent = 0
    this.bytesSent = 0
    this.starting = undefined
    this.stopping = false
    this.lastStage = 'idle'
    // 手柄：UHID 设备是否已建、当前归一化状态、来源（ai / manual）、最近更新时间。
    this.gamepad = {
      created: false,
      id: GAMEPAD_HID_ID,
      type: 'xbox',
      state: emptyGamepadState(),
      source: '',
      updatedAt: 0,
      error: '',
    }
  }

  /** 手柄当前状态（给 uiState / status 用）。 */
  gamepadStatus() {
    return {
      active: this.gamepad.created === true && this.controlReady() === true,
      uhid: this.gamepad.created === true,
      controlReady: this.controlReady() === true,
      id: this.gamepad.id,
      type: this.gamepad.type,
      typeLabel: gamepadTypeInfo(this.gamepad.type).label,
      state: this.gamepad.state,
      source: this.gamepad.source,
      updatedAt: this.gamepad.updatedAt,
      error: this.gamepad.error || undefined,
    }
  }

  status() {
    return {
      running: this.running,
      serial: this.serial,
      width: this.width,
      height: this.height,
      codec: this.codec,
      clients: this.clients.size,
      error: this.error || undefined,
      control: this.controlReady(),
      controlError: this.controlError || undefined,
      port: this.port,
      scid: this.scid,
      socketName: this.scid ? scrcpySocketName(this.scid) : '',
      stage: this.lastStage,
      framesSent: this.framesSent,
      bytesSent: this.bytesSent,
      serverLog: this.serverLog ? this.serverLog.slice(-1200) : undefined,
      build: 'android-tool-scrcpy-2',
      gamepad: this.gamepadStatus(),
    }
  }

  /** 当前元信息。 */
  meta() {
    return {
      type: 'meta',
      serial: this.serial,
      codec: this.codec || 'avc1.42e01e',
      width: this.width,
      height: this.height,
      running: this.running,
    }
  }

  /** 处理面板通过 WebSocket 发来的实时触控消息。 */
  handleControlMessage(message) {
    if (message === null || typeof message !== 'object') return
    if (message.type === 'touch') {
      const action = { down: 0, up: 1, move: 2, cancel: 3 }[String(message.action)]
      if (action === undefined) return
      this.touch(action, Number(message.x), Number(message.y), action === 1 ? 0 : 1)
    } else if (message.type === 'key' && Number.isFinite(Number(message.keyCode))) {
      void this.controlKey(Number(message.keyCode))
    } else if (message.type === 'scroll') {
      this.controlScroll(String(message.direction ?? 'down'), Number(message.amount) || 1)
    } else if (message.type === 'gamepad') {
      // 面板里手动按手柄 → 归一化后照常注入并广播回所有客户端。
      const next = normalizeGamepadState(message.gamepad ?? message.state ?? {})
      this.setGamepad(next, { source: String(message.source ?? 'manual'), type: message.gamepadType })
    } else if (message.type === 'gamepadType') {
      this.setGamepadType(message.gamepadType)
    } else if (message.type === 'gamepadReset') {
      this.setGamepad(emptyGamepadState(), { source: 'manual' })
    } else if (message.type === 'gamepadDisconnect') {
      // 面板主动断连手柄：销毁 UHID 设备（推流继续），手机侧会看到手柄被拔出。
      this.disconnectGamepad()
    }
  }

  /** 按名字发触摸事件（面板拖拽用）。 */
  controlTouch(action, x, y) {
    const map = { down: AndroidMotionEventAction.Down, up: AndroidMotionEventAction.Up, move: AndroidMotionEventAction.Move, cancel: AndroidMotionEventAction.Cancel }
    const mapped = map[String(action)]
    if (mapped === undefined) return false
    return this.touch(mapped, x, y, mapped === AndroidMotionEventAction.Up ? 0 : 1)
  }

  /** control 通道是否可用（scrcpy 控制消息比 adb shell input 延迟低很多）。 */
  controlReady() {
    return this.controlSocket !== undefined && this.controlSocket.destroyed !== true
  }

  /** 写一条 scrcpy 控制消息。 */
  writeControl(bytes) {
    if (this.controlReady() !== true) return false
    try {
      this.controlSocket.write(Buffer.from(bytes))
      return true
    } catch (error) {
      this.controlError = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  /** 触摸事件（坐标是视频坐标系 0..videoWidth / 0..videoHeight）。 */
  touch(action, x, y, pressure = 1) {
    const width = this.width || 0
    const height = this.height || 0
    if (!(width > 0) || !(height > 0)) return false
    const bytes = this.controlSerializer.injectTouch({
      action,
      pointerId: -2n,
      pointerX: Math.max(0, Math.min(width, Math.round(x))),
      pointerY: Math.max(0, Math.min(height, Math.round(y))),
      videoWidth: width,
      videoHeight: height,
      pressure,
      buttons: 0,
    })
    return this.writeControl(bytes)
  }

  async controlTap(x, y) {
    if (this.touch(AndroidMotionEventAction.Down, x, y, 1) !== true) return false
    await delay(10)
    return this.touch(AndroidMotionEventAction.Up, x, y, 0)
  }

  async controlSwipe(x1, y1, x2, y2, durationMs = 250) {
    const duration = Math.max(60, Math.min(2000, Number(durationMs) || 250))
    const steps = Math.max(3, Math.min(40, Math.round(duration / 20)))
    if (this.touch(AndroidMotionEventAction.Down, x1, y1, 1) !== true) return false
    for (let index = 1; index < steps; index += 1) {
      await delay(Math.max(8, Math.round(duration / steps)))
      this.touch(AndroidMotionEventAction.Move, x1 + ((x2 - x1) * index) / steps, y1 + ((y2 - y1) * index) / steps, 1)
    }
    return this.touch(AndroidMotionEventAction.Up, x2, y2, 0)
  }

  async controlKey(keyCode) {
    if (this.writeControl(this.controlSerializer.injectKeyCode({ action: AndroidKeyEventAction.Down, keyCode, repeat: 0, metaState: 0 })) !== true) return false
    await delay(8)
    return this.writeControl(this.controlSerializer.injectKeyCode({ action: AndroidKeyEventAction.Up, keyCode, repeat: 0, metaState: 0 }))
  }

  controlText(text) {
    return this.writeControl(this.controlSerializer.injectText(String(text ?? '')))
  }

  controlScroll(direction, amount = 1) {
    const width = this.width || 0
    const height = this.height || 0
    if (!(width > 0) || !(height > 0)) return false
    const value = Math.max(0.1, Math.min(20, Number(amount) || 1))
    const scrollX = direction === 'left' ? value : direction === 'right' ? -value : 0
    const scrollY = direction === 'up' ? value : direction === 'down' ? -value : 0
    return this.writeControl(
      this.controlSerializer.injectScroll({
        pointerX: Math.round(width / 2),
        pointerY: Math.round(height / 2),
        videoWidth: width,
        videoHeight: height,
        scrollX,
        scrollY,
      }),
    )
  }

  controlPower(on) {
    return this.writeControl(this.controlSerializer.setDisplayPower(on === true))
  }

  /**
   * 创建手柄 UHID 设备（只建一次）。需要 control 通道可用。
   * vendor/product/name 用 XBox 360 手柄的值，Android 会按标准手柄识别。
   */
  ensureGamepadDevice() {
    if (this.gamepad.created === true) return true
    if (this.controlReady() !== true) return false
    const info = gamepadTypeInfo(this.gamepad.type)
    try {
      const bytes = this.controlSerializer.uHidCreate({
        id: this.gamepad.id,
        vendorId: info.vendorId,
        productId: info.productId,
        name: info.name,
        data: GAMEPAD_HID_REPORT_DESC,
      })
      if (this.writeControl(bytes) !== true) return false
      this.gamepad.created = true
      this.gamepad.error = ''
      return true
    } catch (error) {
      this.gamepad.error = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  /**
   * 设置手柄状态并发送一条 UHID_INPUT 报告。
   * @param {object} state - 归一化手柄状态
   * @param {{source?:string, type?:'xbox'|'ps'|'switch'}} [options]
   */
  setGamepad(state, options = {}) {
    const type = resolveGamepadType(options.type ?? this.gamepad.type)
    if (this.gamepad.created === true && this.gamepad.type !== type) this.destroyGamepad()
    this.gamepad.type = type
    const next = normalizeGamepadState(state)
    if (this.ensureGamepadDevice() !== true) return false
    try {
      const report = buildHidReport(next, type)
      const bytes = this.controlSerializer.uHidInput({ id: this.gamepad.id, data: report })
      if (this.writeControl(bytes) !== true) return false
    } catch (error) {
      this.gamepad.error = error instanceof Error ? error.message : String(error)
      return false
    }
    const changed = gamepadStateEquals(this.gamepad.state, next) === false
    this.gamepad.state = next
    this.gamepad.source = String(options.source ?? '')
    this.gamepad.updatedAt = Date.now()
    if (changed || options.forceBroadcast === true) this.broadcastGamepad()
    return true
  }

  /** 切换手柄类型：销毁旧设备，按新类型重建并广播。 */
  setGamepadType(type) {
    const next = resolveGamepadType(type)
    if (this.gamepad.created === true) this.destroyGamepad()
    this.gamepad.type = next
    this.gamepad.state = emptyGamepadState()
    this.gamepad.source = ''
    this.gamepad.updatedAt = Date.now()
    this.ensureGamepadDevice()
    this.broadcastGamepad()
    return { ok: true, gamepadType: next, label: gamepadTypeInfo(next).label }
  }

  /** 广播当前手柄状态给所有 WebSocket 客户端。 */
  broadcastGamepad() {
    this.broadcastText(
      JSON.stringify({
        type: 'gamepad',
        gamepad: this.gamepad.state,
        gamepadType: this.gamepad.type,
        gamepadTypeLabel: gamepadTypeInfo(this.gamepad.type).label,
        source: this.gamepad.source,
        via: this.gamepad.created === true ? 'uhid' : 'idle',
        uhid: this.gamepad.created,
        updatedAt: this.gamepad.updatedAt,
      }),
    )
  }

  /** 销毁手柄 UHID 设备（停止推流前调用）。 */
  destroyGamepad() {
    if (this.gamepad.created === true && this.controlReady() === true) {
      try {
        this.writeControl(this.controlSerializer.uHidDestroy(this.gamepad.id))
      } catch {
        // 忽略
      }
    }
    const had = this.gamepad.created === true
    this.gamepad.created = false
    this.gamepad.state = emptyGamepadState()
    this.gamepad.source = ''
    this.gamepad.updatedAt = Date.now()
    if (had) {
      this.broadcastText(JSON.stringify({ type: 'gamepad', gamepad: this.gamepad.state, gamepadType: this.gamepad.type, source: '', via: 'idle', uhid: false }))
    }
  }

  /**
   * 主动断连手柄：销毁 UHID 设备，手机侧会看到手柄被拔出；推流与画面继续。
   * 之后再发任意手柄输入会自动重建设备（setGamepad 里的 ensureGamepadDevice）。
   */
  disconnectGamepad() {
    const had = this.gamepad.created === true
    const controlReady = this.controlReady() === true
    this.destroyGamepad()
    return { ok: true, disconnected: had, controlReady, gamepad: this.gamepadStatus() }
  }

  /** 广播文本。 */
  broadcastText(text) {
    for (const client of this.clients) client.sendText(text)
  }

  /** 广播二进制帧。慢客户端积压时整段 GOP 丢掉，等下一个关键帧再恢复，避免延迟无限增长。 */
  broadcastBinary(payload) {
    const isKey = (payload[0] & 1) === 1
    for (const client of this.clients) {
      if (typeof client.sendBinary !== 'function') continue
      const busy = (client.bufferedAmount ?? 0) > 256 * 1024
      if (client.waitingKey === true) {
        if (!isKey) continue
        client.waitingKey = false
      } else if (busy && !isKey) {
        client.waitingKey = true
        continue
      }
      client.sendBinary(payload)
    }
  }

  /** WebSocket upgrade 入口。 */
  handleUpgrade(req, socket, head) {
    const response = handshakeResponse(req)
    if (response === undefined) {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      } catch {
        // 忽略
      }
      return
    }
    try {
      socket.write(response)
    } catch {
      return
    }
    const connection = new WsConnection(socket, req)
    this.clients.add(connection)
    connection.onClose = () => this.clients.delete(connection)
    connection.onMessage = (frame) => {
      if (frame.opcode !== 0x1) return
      try {
        const message = JSON.parse(frame.payload.toString('utf8'))
        this.handleControlMessage(message)
      } catch {
        // 忽略坏消息
      }
    }
    connection.sendText(JSON.stringify(this.meta()))
    // 新连上来的客户端补一条当前手柄状态，界面一打开就能画出按住的手柄。
    connection.sendText(
      JSON.stringify({
        type: 'gamepad',
        gamepad: this.gamepad.state,
        gamepadType: this.gamepad.type,
        gamepadTypeLabel: gamepadTypeInfo(this.gamepad.type).label,
        source: this.gamepad.source,
        via: this.gamepad.created === true ? 'uhid' : 'idle',
        uhid: this.gamepad.created === true,
        updatedAt: this.gamepad.updatedAt,
      }),
    )
    if (Buffer.isBuffer(head) && head.length > 0) connection.handleData(head)
  }

  /**
   * push server。
   *
   * 不能只推一次就缓存：scrcpy.exe（用户点「打开 scrcpy 窗口」）退出时会按
   * 自己的 cleanup 规则删掉 /data/local/tmp/scrcpy-server.jar。缓存会导致下一次
   * 启动 app_process 时 ClassNotFoundException。733KB 的推送只要几毫秒，每次都推。
   */
  async pushServer(serial) {
    const paths = this.adb.resolveScrcpy()
    if (!existsSync(paths.serverPath)) {
      return { ok: false, error: `找不到 scrcpy-server：${paths.serverPath}` }
    }
    const pushed = await this.adb.run(['push', paths.serverPath, REMOTE_SERVER], { serial, timeoutMs: 90000 })
    if (pushed.ok !== true) {
      return { ok: false, error: `推送 scrcpy-server 失败：${pushed.error ?? ''}` }
    }
    return { ok: true }
  }

  /** 启动推流。 */
  async start(serial) {
    const target = String(serial ?? '').trim()
    if (target.length === 0) return { ok: false, error: '没有选中设备。' }
    if (this.running && this.serial === target) return { ok: true, ...this.status() }
    if (this.starting !== undefined) return this.starting
    this.starting = this.#start(target)
    try {
      return await this.starting
    } finally {
      this.starting = undefined
    }
  }

  async #start(serial) {
    await this.stop()
    this.stopping = false
    this.error = ''
    this.controlError = ''
    this.serverLog = ''

    const adb = this.adb.resolve()
    if (!adb.ok) return { ok: false, error: adb.error }
    this.lastStage = 'push'
    const pushed = await this.pushServer(serial)
    if (pushed.ok !== true) return { ok: false, error: pushed.error }

    const settings = this.getConfig()
    this.scid = randomInt(1, 0x7fffffff)
    this.port = await getFreePort()
    if (!this.port) return { ok: false, error: '找不到空闲端口给 scrcpy 使用。' }

    this.lastStage = 'forward'
    const forward = await this.adb.run(['forward', `tcp:${this.port}`, `localabstract:${scrcpySocketName(this.scid)}`], {
      serial,
      timeoutMs: 15000,
    })
    if (forward.ok !== true) {
      return { ok: false, error: `adb forward 失败：${forward.error ?? ''}` }
    }

    const args = [
      '-s',
      serial,
      'shell',
      `CLASSPATH=${REMOTE_SERVER}`,
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      '5.0.1',
      // server 端 Options.parse 用 Integer.parseInt(value, 0x10) 解析 scid，
      // 即这个值本身按十六进制读；socket 名又是 %08x。因此这里必须传十六进制。
      `scid=${this.scid.toString(16)}`,
      'log_level=info',
      'audio=false',
      'control=true',
      'cleanup=false',
      'tunnel_forward=true',
      'send_device_meta=false',
      'send_dummy_byte=false',
      `max_size=${settings.videoMaxSize}`,
      `video_bit_rate=${settings.videoBitRate}`,
      `max_fps=${settings.videoFps}`,
      'video_codec=h264',
    ]
    if (settings.videoEncoder) args.push(`video_encoder=${settings.videoEncoder}`)
    if (settings.videoCodecOptions) args.push(`video_codec_options=${settings.videoCodecOptions}`)

    this.lastStage = 'spawn'
    let child
    try {
      child = spawn(adb.path, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      await this.removeForward()
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    this.serverChild = child
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
      this.serverLog = stderr
    })
    child.on('exit', () => {
      if (this.serverChild === child) {
        this.serverChild = undefined
        if (this.running) {
          this.running = false
          this.error = stderr.trim() || 'scrcpy server 已退出'
          this.broadcastText(JSON.stringify({ type: 'status', running: false, error: this.error }))
        }
      }
    })

    this.lastStage = 'connect'
    const connected = await connectVideoControl(this.port, 12000)
    if (connected.ok !== true) {
      killTree(child)
      this.serverChild = undefined
      await this.removeForward()
      return { ok: false, error: connected.error || stderr.trim() || '连接 scrcpy server 失败' }
    }

    this.socket = connected.video
    this.controlSocket = connected.control
    // 触摸/按键都是很小的包，Nagle 会攒包导致 40–200ms 的控制延迟。
    try {
      this.socket.setNoDelay(true)
      this.controlSocket.setNoDelay(true)
    } catch {
      // 忽略
    }
    this.controlSocket.on('error', (error) => {
      this.controlError = error instanceof Error ? error.message : String(error)
    })
    this.controlSocket.on('close', () => {
      if (this.controlSocket === undefined) return
      this.controlSocket = undefined
    })
    // 设备可能通过 control socket 回传剪贴板等消息，先读掉，避免缓冲堆积。
    this.controlSocket.on('data', () => {})
    this.serial = serial
    this.running = true
    this.lastStage = 'streaming'
    this.buffer = Buffer.alloc(0)
    this.phase = 'codec'
    this.sps = undefined
    this.pps = undefined
    this.codec = ''
    this.width = 0
    this.height = 0

    if (Buffer.isBuffer(connected.firstChunk) && connected.firstChunk.length > 0) this.feed(connected.firstChunk)
    this.socket.on('data', (chunk) => this.feed(chunk))
    this.socket.resume()
    this.socket.on('error', (error) => {
      if (this.stopping) return
      this.error = error instanceof Error ? error.message : String(error)
      void this.stop()
    })
    this.socket.on('close', () => {
      if (this.stopping) return
      if (this.running) {
        this.error = this.error || 'scrcpy 视频连接已关闭'
        void this.stop()
      }
    })

    return { ok: true, ...this.status() }
  }

  /** 解析输入字节流。 */
  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    let progressed = true
    while (progressed) {
      progressed = false
      if (this.phase === 'codec') {
        if (this.buffer.length < 4) return
        const codec = readCodecId(this.buffer.subarray(0, 4))
        this.buffer = this.buffer.subarray(4)
        if (codec?.name !== 'h264') {
          this.error = `不支持的视频编码：${codec?.name ?? codec?.id ?? '未知'}`
          this.running = false
          this.broadcastText(JSON.stringify({ type: 'status', running: false, error: this.error }))
          return
        }
        this.phase = 'session'
        progressed = true
        continue
      }
      if (this.phase === 'session') {
        if (this.buffer.length < 12) return
        const session = parseSessionPacket(this.buffer.subarray(0, 12))
        if (session === undefined) {
          this.error = 'scrcpy session packet 解析失败'
          this.running = false
          return
        }
        this.buffer = this.buffer.subarray(12)
        this.width = session.width
        this.height = session.height
        this.phase = 'frame'
        this.broadcastText(JSON.stringify(this.meta()))
        progressed = true
        continue
      }

      // phase === 'frame'
      if (this.buffer.length < 12) return
      // 旋转时会重新插一个 session packet。
      if ((this.buffer[0] & 0x80) !== 0) {
        const session = parseSessionPacket(this.buffer.subarray(0, 12))
        if (session !== undefined) {
          this.buffer = this.buffer.subarray(12)
          this.width = session.width
          this.height = session.height
          this.broadcastText(JSON.stringify(this.meta()))
          progressed = true
          continue
        }
      }
      const header = parseFrameHeader(this.buffer.subarray(0, 12))
      if (header === undefined || header.size <= 0) {
        this.buffer = this.buffer.subarray(1)
        continue
      }
      if (this.buffer.length < 12 + header.size) return
      const payload = this.buffer.subarray(12, 12 + header.size)
      this.buffer = this.buffer.subarray(12 + header.size)

      if (header.config === true) {
        const nals = splitAnnexB(payload)
        const { sps, pps } = extractSpsPps(nals)
        if (sps !== undefined) this.sps = sps
        if (pps !== undefined) this.pps = pps
        if (this.sps !== undefined && this.codec === '') {
          this.codec = spsToCodecString(this.sps) ?? ''
          this.broadcastText(JSON.stringify(this.meta()))
        }
        progressed = true
        continue
      }

      if (header.media === true) {
        let data = Buffer.from(payload)
        if (header.key === true && this.sps !== undefined) {
          data = Buffer.concat([joinAnnexB([this.sps, this.pps].filter((item) => item !== undefined)), data])
        }
        this.frameCounter += 1
        const stamps = header.pts > 0 ? header.pts : this.frameCounter * 16666
        const frame = Buffer.allocUnsafe(9 + data.length)
        frame[0] = header.key === true ? 1 : 0
        frame.writeDoubleBE(stamps, 1)
        data.copy(frame, 9)
        this.framesSent += 1
        this.bytesSent += frame.length
        this.broadcastBinary(frame)
        progressed = true
      }
    }
  }

  /** 移除 forward。 */
  async removeForward() {
    if (this.port === 0) return
    try {
      await this.adb.run(['forward', '--remove', `tcp:${this.port}`], { timeoutMs: 5000 })
    } catch {
      // 忽略
    }
    this.port = 0
  }

  /** 停止。 */
  async stop() {
    this.stopping = true
    this.running = false
    this.destroyGamepad()
    if (this.socket !== undefined) {
      try {
        this.socket.destroy()
      } catch {
        // 忽略
      }
      this.socket = undefined
    }
    if (this.controlSocket !== undefined) {
      try {
        this.controlSocket.destroy()
      } catch {
        // 忽略
      }
      this.controlSocket = undefined
    }
    if (this.serverChild !== undefined) {
      killTree(this.serverChild)
      this.serverChild = undefined
    }
    await this.removeForward()
    this.width = 0
    this.height = 0
    this.phase = 'codec'
    this.buffer = Buffer.alloc(0)
    this.broadcastText(JSON.stringify({ type: 'status', running: false, ...(this.error ? { error: this.error } : {}) }))
    this.stopping = false
    return { ok: true }
  }

  dispose() {
    void this.stop()
    for (const client of this.clients) client.close()
    this.clients.clear()
  }
}
