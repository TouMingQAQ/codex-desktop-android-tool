/**
 * scrcpy 协议的最小解析器（纯函数，可单测）。
 *
 * 依据：https://github.com/Genymobile/scrcpy/blob/master/doc/develop.md
 * 视频 socket：codec id(u32) → session packet(12) → 媒体包(12 字节帧头 + payload)。
 * 帧头首字节 bit7=0（媒体包）、bit6=config、bit5=key，低 61 位是 PTS，后 4 字节是包长。
 */

/** codec id 的数字 → 名字。 */
const CODEC_IDS = {
  '0x68323634': 'h264',
  '0x68323635': 'h265',
  '0x00617631': 'av1',
  '0x00767038': 'vp8',
  '0x00767039': 'vp9',
}

/**
 * scrcpy server 使用的 abstract socket 名。
 *
 * 注意：server 把 scid 当十进制 int 解析，再用 `%08x` 格式化成 8 位十六进制，
 * 所以本地 adb forward 必须指向 `scrcpy_0074cbb1` 这种形式，不能直接拼十进制。
 *
 * @param {number} scid
 * @returns {string}
 */
export function scrcpySocketName(scid) {
  const value = Number(scid)
  if (!Number.isFinite(value) || value === -1) return 'scrcpy'
  return `scrcpy_${(value >>> 0).toString(16).padStart(8, '0')}`
}

/** 读 4 字节 codec id。 */
export function readCodecId(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return undefined
  const hex = `0x${buffer.readUInt32BE(0).toString(16).padStart(8, '0')}`
  const name = CODEC_IDS[hex]
  return name === undefined ? { id: hex, name: undefined } : { id: hex, name }
}

/**
 * 解析 12 字节 session packet。
 * byte0 最高位=1；bit0=client resized；byte4-7 宽；byte8-11 高。
 */
export function parseSessionPacket(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return undefined
  if ((buffer[0] & 0x80) === 0) return undefined
  return {
    clientResized: (buffer[0] & 0x01) !== 0,
    width: buffer.readUInt32BE(4),
    height: buffer.readUInt32BE(8),
  }
}

/**
 * 解析 12 字节媒体包帧头。
 * @returns {{media:boolean,config:boolean,key:boolean,pts:number,size:number}|undefined}
 */
export function parseFrameHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return undefined
  const first = buffer[0]
  const media = (first & 0x80) === 0
  const config = (first & 0x40) !== 0
  const key = (first & 0x20) !== 0
  let pts = 0n
  for (let index = 0; index < 8; index += 1) pts = (pts << 8n) | BigInt(buffer[index])
  pts &= 0x1fffffffffffffffn
  return { media, config, key, pts: Number(pts), size: buffer.readUInt32BE(8) }
}

/**
 * 按 Annex-B 起始码拆 NAL。
 * @param {Buffer} buffer
 * @returns {Array<{type:number,data:Buffer}>}
 */
export function splitAnnexB(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return []
  const starts = []
  for (let index = 0; index + 3 < buffer.length; index += 1) {
    if (buffer[index] === 0x00 && buffer[index + 1] === 0x00 && buffer[index + 2] === 0x01) {
      starts.push({ at: index, length: 3 })
      index += 2
      continue
    }
    if (buffer[index] === 0x00 && buffer[index + 1] === 0x00 && buffer[index + 2] === 0x00 && buffer[index + 3] === 0x01) {
      starts.push({ at: index, length: 4 })
      index += 3
    }
  }
  if (starts.length === 0) return []
  const nals = []
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]
    const payloadStart = start.at + start.length
    const payloadEnd = index + 1 < starts.length ? starts[index + 1].at : buffer.length
    if (payloadEnd <= payloadStart) continue
    const data = buffer.subarray(payloadStart, payloadEnd)
    nals.push({ type: data[0] & 0x1f, data })
  }
  return nals
}

/** 从 NAL 列表里找 SPS/PPS。 */
export function extractSpsPps(nals) {
  let sps
  let pps
  for (const nal of Array.isArray(nals) ? nals : []) {
    if (nal.type === 7 && sps === undefined) sps = nal.data
    if (nal.type === 8 && pps === undefined) pps = nal.data
  }
  return { sps, pps }
}

/**
 * 从 SPS 的前三个字节构造 WebCodecs 的 codec 字符串。
 * @param {Buffer} sps - 含 NAL header 的 SPS
 */
export function spsToCodecString(sps) {
  if (!Buffer.isBuffer(sps) || sps.length < 4) return undefined
  const profile = sps[1]
  const constraints = sps[2]
  const level = sps[3]
  return `avc1.${profile.toString(16).padStart(2, '0')}${constraints.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`
}

/** 把若干 NAL 拼回 Annex-B 字节流（前面补 4 字节起始码）。 */
export function joinAnnexB(nals) {
  const parts = []
  for (const nal of Array.isArray(nals) ? nals : []) {
    if (!Buffer.isBuffer(nal) || nal.length === 0) continue
    parts.push(Buffer.from([0x00, 0x00, 0x00, 0x01]))
    parts.push(nal)
  }
  return Buffer.concat(parts)
}
