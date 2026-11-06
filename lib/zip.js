/**
 * 极简 ZIP 读取（只读，支持 store / deflate）。
 *
 * AAB2APK 的原文用 Rust 的 `zip` crate 读 `.aab` / `.apks` / `.apk`：
 *   - 判断 bundle 里有没有 `BundleConfig.pb`；
 *   - 从 AAB 里抽 `AndroidManifest.xml`；
 *   - 从 `.apks` 里抽 `universal.apk`；
 *   - 从 APK 里读二进制清单做包名 / 版本号。
 *
 * 这里不引第三方依赖，自己走一遍 EOCD → 中央目录 → 本地文件头。
 * 不支持 ZIP64（单个条目或归档超过 4GB）——真实 AAB 极少到那个量级，
 * 真遇到会明确报错，而不是悄悄读错。
 */

import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const ZIP64_MARK = 0xffffffff

/** 是否像 ZIP（用于快速判错）。 */
export function looksLikeZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 22 && findEocd(buffer) >= 0
}

function findEocd(buffer) {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIG) return offset
  }
  return -1
}

/**
 * 列出中央目录里的所有条目（不解压）。
 * @param {Buffer} buffer
 * @returns {{name:string, method:number, compressedSize:number, size:number, flags:number, localHeaderOffset:number}[]}
 */
export function listZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('不是有效的 ZIP：输入不是 Buffer')
  const eocd = findEocd(buffer)
  if (eocd < 0) throw new Error('不是有效的 ZIP：找不到目录结束标记')
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  if (offset === ZIP64_MARK) throw new Error('不支持 ZIP64 归档')

  const entries = []
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error('ZIP 中央目录损坏')
    }
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)
    if (compressedSize === ZIP64_MARK || size === ZIP64_MARK || localHeaderOffset === ZIP64_MARK) {
      throw new Error('不支持 ZIP64 条目')
    }
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    entries.push({ name, method, compressedSize, size, flags, localHeaderOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** 找到第一个名字满足条件的条目。 */
export function findZipEntry(buffer, predicate) {
  if (typeof predicate === 'function') return listZipEntries(buffer).find(predicate)
  return listZipEntries(buffer).find((entry) => entry.name === predicate)
}

/**
 * 解压单条条目。
 * @param {Buffer} buffer
 * @param {string|((entry:{name:string})=>boolean)} target 条目名或谓词
 * @returns {Buffer}
 */
export function readZipEntry(buffer, target) {
  const entries = listZipEntries(buffer)
  const entry = typeof target === 'function' ? entries.find(target) : entries.find((item) => item.name === target)
  if (entry === undefined) throw new Error(`ZIP 中没有条目 ${typeof target === 'function' ? '(匹配失败)' : target}`)

  const local = entry.localHeaderOffset
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_SIG) {
    throw new Error(`ZIP 本地文件头损坏：${entry.name}`)
  }
  const nameLength = buffer.readUInt16LE(local + 26)
  const extraLength = buffer.readUInt16LE(local + 28)
  const dataStart = local + 30 + nameLength + extraLength
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize)

  if (entry.method === 0) return Buffer.from(compressed)
  if (entry.method === 8) return inflateRawSync(compressed)
  throw new Error(`不支持的 ZIP 压缩方式 ${entry.method}（${entry.name}）`)
}

/** 归档里是否含某个后缀的条目（大小写不敏感）。 */
export function hasZipEntryEndingWith(buffer, suffix) {
  const lower = String(suffix).toLowerCase()
  return listZipEntries(buffer).some((entry) => entry.name.toLowerCase().endsWith(lower))
}

/**
 * 造一个简单的 ZIP（store，无压缩）。只给测试用，避免为了测试引入依赖。
 * @param {{name:string, data:Buffer}[]} files
 */
export function buildStoredZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const data = Buffer.from(file.data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIG, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + data.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([Buffer.concat(locals), centralBuffer, eocd])
}

let crcTable
function crc32(buffer) {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
