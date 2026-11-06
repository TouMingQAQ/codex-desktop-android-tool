/**
 * 读取已编译 APK 的二进制 `AndroidManifest.xml`（AXML），拿包名 / versionCode / versionName。
 *
 * 逐字移植 AAB2APK core/src/manifest.rs 的扫描逻辑：
 *   - 先走 RES_XML_RESOURCE_MAP 把 `android:versionCode` 这类 resource id 换成属性名索引；
 *   - 再扫所有 START_ELEMENT 的属性数组；
 *   - 字符串池同时兼容 UTF-8 / UTF-16、大小端与 ±1 字节的锚点差异。
 *
 * 全部是「尽力而为」：任何越界或结构不符都返回 null，绝不让转换因为读不出包名而失败。
 */

import { readZipEntry, findZipEntry } from './zip.js'

const ATTR_VERSION_CODE = 0x0101021b
const ATTR_VERSION_NAME = 0x0101021c
const RES_XML_START_ELEMENT = 0x0102
const RES_STRING_POOL = 0x0001
const RES_XML_RESOURCE_MAP = 0x0180

const RES_XML_NODE_SIZE = 16
const RES_XML_ATTR_EXT_SIZE = 20
const RES_XML_ATTR_START_OFFSET = 8
const RES_XML_ATTR_COUNT_OFFSET = 12
const RES_XML_ATTR_SIZE_OFFSET = 10
const ATTR_NAME_OFFSET = 4
const ATTR_DATA_TYPE_OFFSET = 15
const ATTR_DATA_OFFSET = 16
const TYPE_STRING = 0x03

function readU16(data, offset) {
  if (offset < 0 || offset + 2 > data.length) return undefined
  return data[offset] | (data[offset + 1] << 8)
}

function readU32(data, offset) {
  if (offset < 0 || offset + 4 > data.length) return undefined
  return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0
}

/** 从 APK 文件 buffer 里取清单信息。 */
export function readApkManifest(apkBuffer) {
  try {
    const entry = findZipEntry(apkBuffer, (item) => item.name === 'AndroidManifest.xml')
    if (entry === undefined) return { packageName: null, versionCode: null, versionName: null }
    const data = readZipEntry(apkBuffer, entry.name)
    return parseManifestBytes(data)
  } catch {
    return { packageName: null, versionCode: null, versionName: null }
  }
}

/** 解析二进制清单字节。 */
export function parseManifestBytes(data) {
  return {
    packageName: findPackage(data),
    versionCode: scanVersionAttribute(data, ATTR_VERSION_CODE),
    versionName: scanVersionString(data, ATTR_VERSION_NAME),
  }
}

function resourceMapIndex(data, target) {
  let offset = 8
  while (offset + 8 <= data.length) {
    const chunkType = readU16(data, offset)
    const headerSize = readU16(data, offset + 2)
    const chunkSize = readU32(data, offset + 4)
    if (chunkType === undefined || headerSize === undefined || chunkSize === undefined) return undefined
    if (chunkSize < 8 || offset + chunkSize > data.length) break
    if (chunkType === RES_XML_RESOURCE_MAP) {
      const start = offset + Math.max(headerSize, 8)
      const ids = Math.floor((offset + chunkSize - start) / 4)
      for (let i = 0; i < ids; i += 1) {
        if (readU32(data, start + i * 4) === target) return i
      }
      return undefined
    }
    offset += chunkSize
  }
  return undefined
}

function startElementAttributes(data) {
  const elements = []
  let offset = 8
  while (offset + 8 <= data.length) {
    const chunkType = readU16(data, offset)
    const headerSize = readU16(data, offset + 2)
    const chunkSize = readU32(data, offset + 4)
    if (chunkType === undefined || headerSize === undefined || chunkSize === undefined) break
    if (chunkSize < 8 || offset + chunkSize > data.length) break
    if (chunkType === RES_XML_START_ELEMENT) {
      const body = offset + Math.max(headerSize, 8)
      const nameIndex = readU32(data, body + 4)
      const count = readU16(data, body + RES_XML_ATTR_COUNT_OFFSET)
      const size = readU16(data, body + RES_XML_ATTR_SIZE_OFFSET)
      const declaredStart = readU16(data, body + RES_XML_ATTR_START_OFFSET)
      if (nameIndex !== undefined && count !== undefined && size !== undefined && declaredStart !== undefined) {
        const base = attributeArrayBase(body, declaredStart)
        const attrSize = size === 0 ? 20 : size
        const attributes = []
        for (let i = 0; i < count; i += 1) {
          const attr = base + i * attrSize
          if (attr + ATTR_DATA_OFFSET + 4 <= data.length) attributes.push(attr)
        }
        elements.push({ nameIndex, attributes })
      }
    }
    offset += chunkSize
  }
  return elements
}

function attributeArrayBase(body, declaredStart) {
  if (declaredStart >= RES_XML_ATTR_EXT_SIZE) return body + declaredStart
  return body + RES_XML_ATTR_EXT_SIZE + declaredStart
}

function scanVersionAttribute(data, targetAttr) {
  const attrIndex = resourceMapIndex(data, targetAttr)
  if (attrIndex === undefined) return null
  for (const element of startElementAttributes(data)) {
    for (const attr of element.attributes) {
      if (readU32(data, attr + ATTR_NAME_OFFSET) === attrIndex) {
        const value = readU32(data, attr + RES_XML_NODE_SIZE)
        return value === undefined ? null : value
      }
    }
  }
  return null
}

function scanVersionString(data, targetAttr) {
  const attrIndex = resourceMapIndex(data, targetAttr)
  if (attrIndex === undefined) return null
  const pool = parseStringPool(data)
  if (pool === undefined) return null
  for (const element of startElementAttributes(data)) {
    for (const attr of element.attributes) {
      if (readU32(data, attr + ATTR_NAME_OFFSET) !== attrIndex) continue
      if (data[attr + ATTR_DATA_TYPE_OFFSET] !== TYPE_STRING) continue
      const value = readU32(data, attr + ATTR_DATA_OFFSET)
      if (value === undefined) continue
      const text = pool.strings[value]
      if (text === undefined) return null
      const cleaned = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffd]/gu, '').trim()
      return cleaned.length > 0 ? cleaned : null
    }
  }
  return null
}

function parseStringPool(data) {
  if (readU16(data, 8) !== RES_STRING_POOL) return undefined
  const headerSize = readU16(data, 10)
  const chunkSize = readU32(data, 12)
  const stringCount = readU32(data, 16)
  const flags = readU32(data, 24)
  const stringsStart = readU32(data, 28)
  if ([headerSize, chunkSize, stringCount, flags, stringsStart].some((value) => value === undefined)) return undefined
  const utf8 = (flags & 0x100) !== 0
  const base = 8
  const offsetsStart = base + Math.max(headerSize, 28)
  const anchor = base + stringsStart

  let best
  for (const candidateAnchor of [anchor, anchor - 1]) {
    const strings = readPoolEntries(data, offsetsStart, candidateAnchor, stringCount, utf8)
    if (strings === undefined) continue
    const score = strings.reduce((sum, text) => sum + strayControlCount(text), 0)
    if (best === undefined || score < best.score) best = { score, strings }
    if (score === 0) break
  }
  return best === undefined ? undefined : { strings: best.strings, headerSize, chunkSize }
}

function readPoolEntries(data, offsetsStart, anchor, stringCount, utf8) {
  const strings = []
  for (let i = 0; i < stringCount; i += 1) {
    const offset = readU32(data, offsetsStart + i * 4)
    if (offset === undefined) return undefined
    const position = anchor + offset
    if (position < 0 || position >= data.length) return undefined
    const value = utf8 ? readUtf8String(data, position) : readUtf16String(data, position)
    if (value === undefined) return undefined
    strings.push(value)
  }
  return strings
}

function readVarLen(data, position) {
  const first = data[position]
  if (first === undefined) return undefined
  if ((first & 0x80) !== 0) {
    const second = data[position + 1]
    if (second === undefined) return undefined
    return { length: ((first & 0x7f) << 8) | second, start: position + 2 }
  }
  return { length: first, start: position + 1 }
}

function readUtf8String(data, position) {
  const first = readVarLen(data, position)
  if (first === undefined) return undefined
  const second = readVarLen(data, first.start)
  if (second === undefined) return undefined
  const start = second.start
  const end = Math.min(start + second.length, data.length)
  if (start > data.length) return undefined
  let slice = data.subarray(start, end)
  if (slice.length > 0 && slice[slice.length - 1] === 0) slice = slice.subarray(0, slice.length - 1)
  return slice.toString('utf8')
}

function readUtf16String(data, position) {
  let best = null
  let empty = false
  for (const prefix of [position, position + 1, position - 1]) {
    const read = readVarLen(data, prefix)
    if (read === undefined) continue
    if (read.length === 0) {
      empty = true
      continue
    }
    if (read.start >= data.length || read.length > 4096) continue
    for (const bigEndian of [true, false]) {
      const decoded = decodeUtf16(data, read.start, read.length, bigEndian)
      const score = [strayControlCount(decoded.text), Number.MAX_SAFE_INTEGER - decoded.decoded]
      if (score[0] === 0 && terminatorConfirms(data, read.start, read.length, bigEndian)) {
        score[0] = 0
        score[1] = 0
      }
      if (best === null || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) {
        best = { score, text: decoded.text }
      }
      if (score[0] === 0 && score[1] === 0) return decoded.text
    }
  }
  if (best !== null) return best.text
  if (empty) return ''
  return undefined
}

function strayControlCount(text) {
  let count = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    if ((code < 0x20 && code !== 0x0a && code !== 0x09 && code !== 0x0d) || (code >= 0x7f && code <= 0x9f) || code === 0xfffd) {
      count += 1
    }
  }
  return count
}

function terminatorConfirms(data, start, charLen, bigEndian) {
  const last = start + charLen * 2
  if (last > data.length || charLen === 0) return false
  const low = data[last - 1]
  const high = data[last - 2]
  const zeroIsLow = low === 0 && high !== 0
  const zeroIsHigh = high === 0 && low !== 0
  return (bigEndian && zeroIsLow && last % 2 === 1) || (!bigEndian && zeroIsHigh && last % 2 === 0)
}

function decodeUtf16(data, start, charLen, bigEndian) {
  const available = Math.floor((data.length - start) / 2)
  const count = Math.min(charLen, available)
  const units = new Array(count)
  for (let i = 0; i < count; i += 1) {
    const a = data[start + i * 2]
    const b = data[start + i * 2 + 1]
    units[i] = bigEndian ? ((a << 8) | b) : (a | (b << 8))
  }
  let text = ''
  for (let i = 0; i < units.length; i += 4096) {
    text += String.fromCharCode(...units.slice(i, i + 4096))
  }
  return { text, decoded: count }
}

function findPackage(data) {
  const pool = parseStringPool(data)
  if (pool !== undefined) {
    const manifestIndex = pool.strings.indexOf('manifest')
    if (manifestIndex >= 0) {
      for (const element of startElementAttributes(data)) {
        if (element.nameIndex !== manifestIndex) continue
        for (const attr of element.attributes) {
          if (data[attr + ATTR_DATA_TYPE_OFFSET] !== TYPE_STRING) continue
          const rawValue = readU32(data, attr + ATTR_DATA_OFFSET)
          const nameIndex = readU32(data, attr + ATTR_NAME_OFFSET)
          if (rawValue === undefined || nameIndex === undefined) continue
          const value = pool.strings[rawValue]
          if (value === undefined) continue
          const namedPackage = pool.strings[nameIndex] === 'package'
          if (namedPackage || looksLikePackage(value)) return value
        }
      }
    }
    const heuristic = pool.strings
      .filter((value) => looksLikePackage(value) && !isNoisePackage(value))
      .sort((a, b) => a.length - b.length)[0]
    if (heuristic !== undefined) return heuristic
  }
  return null
}

const NOISE_PREFIXES = [
  'android.permission',
  'android.intent',
  'android.app',
  'android.content',
  'android.os',
  'android.widget',
  'android.view',
  'com.android.',
  'androidx.',
  'com.google.android.',
  'org.apache.',
  'kotlin.',
]

function isNoisePackage(value) {
  return NOISE_PREFIXES.some((prefix) => value.startsWith(prefix))
}

function looksLikePackage(value) {
  if (value.length < 3 || value.length > 200) return false
  if (!value.includes('.')) return false
  if (!/^[a-z0-9._]+$/u.test(value)) return false
  if (value.startsWith('.') || value.endsWith('.')) return false
  let segments = 0
  for (const segment of value.split('.')) {
    if (segment.length === 0) return false
    if (!/^[a-z0-9_]+$/u.test(segment)) return false
    segments += 1
  }
  return segments >= 2 && /[a-z]/u.test(value)
}
