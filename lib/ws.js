/**
 * 最小 WebSocket 服务端工具（RFC 6455）。
 *
 * 只做本项目需要的事：握手、发送文本/二进制、回复 ping/close、解析客户端
 * 的 close/ping/pong。不处理分片消息和扩展协商——浏览器发来的控制帧都很小。
 */

import { createHash } from 'node:crypto'

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 计算 Sec-WebSocket-Accept。 */
export function acceptKey(key) {
  return createHash('sha1').update(`${String(key ?? '')}${WS_GUID}`).digest('base64')
}

/**
 * 生成 101 响应文本；缺少 key 时返回 undefined。
 * @param {{ headers: Record<string, string|string[]|undefined> }} req
 */
export function handshakeResponse(req) {
  const raw = req?.headers?.['sec-websocket-key']
  const key = Array.isArray(raw) ? raw[0] : raw
  if (typeof key !== 'string' || key.length === 0) return undefined
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '',
    '',
  ].join('\r\n')
}

/** 编码一个服务端帧（不掩码）。 */
export function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8')
  const length = body.length
  let header
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, body])
}

export const encodeText = (text) => encodeFrame(0x1, text)
export const encodeBinary = (buffer) => encodeFrame(0x2, buffer)
export const encodePing = () => encodeFrame(0x9, Buffer.alloc(0))
export const encodePong = (payload) => encodeFrame(0xa, payload ?? Buffer.alloc(0))
export const encodeClose = () => encodeFrame(0x8, Buffer.alloc(0))

/**
 * 解析客户端发来的帧（客户端帧一定带掩码）。
 * @param {Buffer} buffer
 * @returns {{frames:Array<{opcode:number,payload:Buffer,fin:boolean}>, rest:Buffer}}
 */
export function parseFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (cursor + 2 > buffer.length) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break
      const big = buffer.readBigUInt64BE(cursor)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) break
      length = Number(big)
      cursor += 8
    }
    let mask
    if (masked) {
      if (cursor + 4 > buffer.length) break
      mask = buffer.subarray(cursor, cursor + 4)
      cursor += 4
    }
    if (cursor + length > buffer.length) break
    let payload = buffer.subarray(cursor, cursor + length)
    if (mask !== undefined) {
      const copy = Buffer.allocUnsafe(payload.length)
      for (let index = 0; index < payload.length; index += 1) copy[index] = payload[index] ^ mask[index % 4]
      payload = copy
    }
    frames.push({ opcode, payload: Buffer.from(payload), fin })
    offset = cursor + length
  }
  return { frames, rest: buffer.subarray(offset) }
}

/** 一个已升级的连接。 */
export class WsConnection {
  /**
   * @param {import('node:stream').Duplex} socket
   * @param {object} req
   */
  constructor(socket, req) {
    this.socket = socket
    this.req = req
    this.closed = false
    this.buffer = Buffer.alloc(0)
    this.onClose = undefined
    this.onMessage = undefined

    socket.on('data', (chunk) => this.handleData(chunk))
    socket.on('error', () => this.destroy())
    socket.on('close', () => {
      this.closed = true
      this.onClose?.()
    })
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    const { frames, rest } = parseFrames(this.buffer)
    this.buffer = rest
    for (const frame of frames) {
      if (frame.opcode === 0x8) {
        this.send(encodeClose())
        this.destroy()
        return
      }
      if (frame.opcode === 0x9) {
        this.send(encodePong(frame.payload))
        continue
      }
      if (frame.opcode === 0xa) continue
      this.onMessage?.(frame)
    }
  }

  send(buffer) {
    if (this.closed) return false
    try {
      this.socket.write(buffer)
      return true
    } catch {
      this.destroy()
      return false
    }
  }

  /** 待发送字节数（用于视频帧背压判断；拿不到就当 0）。 */
  get bufferedAmount() {
    try {
      const value = this.socket?.writableLength ?? this.socket?.bufferSize ?? 0
      return Number.isFinite(value) ? value : 0
    } catch {
      return 0
    }
  }

  sendText(text) {
    return this.send(encodeText(text))
  }

  sendBinary(buffer) {
    return this.send(encodeBinary(buffer))
  }

  ping() {
    return this.send(encodePing())
  }

  close() {
    this.send(encodeClose())
    this.destroy()
  }

  destroy() {
    if (this.closed) return
    this.closed = true
    try {
      this.socket.destroy()
    } catch {
      // 忽略
    }
    this.onClose?.()
  }
}
