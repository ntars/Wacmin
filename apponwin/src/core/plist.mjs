/**
 * Info.plist 解析（读取侧）。
 *
 * ## 要处理两种格式
 *
 * macOS 的 plist 有两种物理格式：
 *
 * | 格式 | 开头 | 说明 |
 * |---|---|---|
 * | XML | `<?xml` 或 `<plist` | 纯文本，可正则/自解析 |
 * | 二进制 | `bplist00` | 紧凑二进制，必须真解析 |
 *
 * 系统应用几乎全是二进制 plist（Xcode 默认输出）。所以只支持 XML 是
 * 不够的 —— 一个 `.app` 都读不了，评估功能就是废的。
 *
 * ## 二进制 plist 格式要点
 *
 * ```
 * 'bplist00'
 * [对象区]      每个对象按类型标记 + 内容
 * [偏移表]      每个对象的起始偏移，定长（1/2/4/8 字节）
 * [trailer 32B] offsetSize(1) objectRefSize(1) numObjects(8)
 *               topObject(8) offsetTableOffset(8)
 * ```
 *
 * 对象类型看标记的高 4 位：
 *
 * | 高 4 位 | 类型 |
 * |---|---|
 * | 0x0 | 简单值（null/false/true/fill） |
 * | 0x1 | 整数（低 4 位是字节数 2^n） |
 * | 0x2 | 实数 |
 * | 0x3 | 日期 |
 * | 0x4 | 数据 |
 * | 0x5 | ASCII 字符串（低 4 位是长度） |
 * | 0x6 | UTF-16BE 字符串 |
 * | 0x8 | UID |
 * | 0xA | 数组 |
 * | 0xC | 集合 |
 * | 0xD | 字典（key 引用数组 + value 引用数组） |
 *
 * 长度 ≥ 15 时低 4 位为 0xF，后面跟一个整数对象表示真实长度。
 */

import { readFile } from 'node:fs/promises'

/** plist 解析失败。 */
export class PlistError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PlistError'
  }
}

/**
 * 读 plist 文件，自动识别 XML / 二进制。
 *
 * @param {string} path
 * @returns {Promise<unknown>}
 */
export async function readPlist(path) {
  const buffer = await readFile(path)
  return parsePlistBuffer(buffer)
}

/**
 * 从 Buffer 解析 plist。
 *
 * @param {Buffer} buffer
 * @returns {unknown}
 */
export function parsePlistBuffer(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).toString('latin1') === 'bplist00') {
    return parseBinaryPlist(buffer)
  }
  const text = buffer.toString('utf8')
  return parseXmlPlist(text)
}

// ---------------------------------------------------------------------------
// 二进制 plist
// ---------------------------------------------------------------------------

/**
 * 解析二进制 plist。
 *
 * @param {Buffer} buffer
 * @returns {unknown}
 */
function parseBinaryPlist(buffer) {
  if (buffer.length < 40) throw new PlistError('二进制 plist 过短')

  const trailer = buffer.subarray(buffer.length - 32)
  const offsetSize = trailer.readUInt8(6)
  const refSize = trailer.readUInt8(7)
  const numObjects = readUInt(trailer, 8, 8)
  const topObject = readUInt(trailer, 16, 8)
  const offsetTableOffset = readUInt(trailer, 24, 8)

  if (![1, 2, 4, 8].includes(offsetSize)) {
    throw new PlistError(`offsetSize 非法：${String(offsetSize)}`)
  }
  if (![1, 2, 4, 8].includes(refSize)) {
    throw new PlistError(`refSize 非法：${String(refSize)}`)
  }
  if (numObjects === 0 || numObjects > 1e6) {
    throw new PlistError(`对象数异常：${String(numObjects)}`)
  }
  if (offsetTableOffset + numObjects * offsetSize > buffer.length) {
    throw new PlistError('偏移表越界')
  }

  /** 缓存已解析对象，避免重复解析（plist 允许对象共享）。 */
  const cache = new Map()

  const objectAt = (index) => {
    if (cache.has(index)) return cache.get(index)
    if (index >= numObjects) throw new PlistError(`对象引用越界：${String(index)}`)
    const offset = readUInt(buffer, offsetTableOffset + index * offsetSize, offsetSize)
    if (offset >= buffer.length) throw new PlistError(`对象偏移越界：${String(offset)}`)
    const value = parseObject(buffer, offset, refSize, objectAt, offsetTableOffset)
    cache.set(index, value)
    return value
  }

  return objectAt(topObject)
}

/**
 * 解析单个对象。
 *
 * @param {Buffer} buffer
 * @param {number} offset
 * @param {number} refSize 引用宽度（字节）。
 * @param {(index: number) => unknown} objectAt 按索引取对象。
 * @param {number} offsetTableOffset 偏移表起点，用于判断越界。
 */
function parseObject(buffer, offset, refSize, objectAt, offsetTableOffset) {
  const marker = buffer.readUInt8(offset)
  const type = marker >> 4
  const info = marker & 0x0f

  switch (type) {
    case 0x0:
      if (info === 0x0) return null
      if (info === 0x8) return false
      if (info === 0x9) return true
      return null

    case 0x1: {
      // 整数：低 4 位是字节数 2^n
      const bytes = 1 << info
      if (bytes > 8) throw new PlistError(`整数宽度过大：${String(bytes)}`)
      let value = 0
      for (let i = 0; i < bytes; i += 1) {
        value = value * 256 + buffer.readUInt8(offset + 1 + i)
      }
      return value
    }

    case 0x2: {
      const bytes = 1 << info
      if (bytes === 4) return buffer.readFloatBE(offset + 1)
      if (bytes === 8) return buffer.readDoubleBE(offset + 1)
      throw new PlistError(`实数宽度非法：${String(bytes)}`)
    }

    case 0x3: {
      // 日期：8 字节 double，起点是 2001-01-01 UTC
      const seconds = buffer.readDoubleBE(offset + 1)
      return new Date(Date.UTC(2001, 0, 1) + seconds * 1000)
    }

    case 0x4: {
      // 数据
      const { length, headerSize } = readLength(buffer, offset, info)
      return buffer.subarray(offset + headerSize, offset + headerSize + length)
    }

    case 0x5: {
      // ASCII 字符串
      const { length, headerSize } = readLength(buffer, offset, info)
      return buffer.subarray(offset + headerSize, offset + headerSize + length).toString('latin1')
    }

    case 0x6: {
      // UTF-16BE 字符串
      const { length, headerSize } = readLength(buffer, offset, info)
      const start = offset + headerSize
      return buffer.subarray(start, start + length * 2).toString('utf16le').length > 0
        ? swapEndianUtf16(buffer.subarray(start, start + length * 2))
        : ''
    }

    case 0x8: {
      // UID
      const bytes = info + 1
      let value = 0
      for (let i = 0; i < bytes; i += 1) {
        value = value * 256 + buffer.readUInt8(offset + 1 + i)
      }
      return { uid: value }
    }

    case 0xa: {
      // 数组
      const { length, headerSize } = readLength(buffer, offset, info)
      const out = []
      for (let i = 0; i < length; i += 1) {
        const ref = readUInt(buffer, offset + headerSize + i * refSize, refSize)
        out.push(objectAt(ref))
      }
      return out
    }

    case 0xc: {
      // 集合（同数组，少见）
      const { length, headerSize } = readLength(buffer, offset, info)
      const out = []
      for (let i = 0; i < length; i += 1) {
        out.push(objectAt(readUInt(buffer, offset + headerSize + i * refSize, refSize)))
      }
      return out
    }

    case 0xd: {
      // 字典：先 length 个 key 引用，再 length 个 value 引用
      const { length, headerSize } = readLength(buffer, offset, info)
      const out = {}
      for (let i = 0; i < length; i += 1) {
        const keyRef = readUInt(buffer, offset + headerSize + i * refSize, refSize)
        const valueRef = readUInt(
          buffer, offset + headerSize + (length + i) * refSize, refSize)
        const key = objectAt(keyRef)
        out[String(key)] = objectAt(valueRef)
      }
      return out
    }

    default:
      throw new PlistError(`未知对象类型：0x${type.toString(16)}`)
  }
}

/**
 * 读长度。低 4 位为 0xF 时，后面紧跟一个整数对象给出真实长度。
 *
 * @returns {{length: number, headerSize: number}}
 */
function readLength(buffer, offset, info) {
  if (info !== 0x0f) return { length: info, headerSize: 1 }

  const marker = buffer.readUInt8(offset + 1)
  if (marker >> 4 !== 0x1) {
    throw new PlistError('长长度的标记不是整数')
  }
  const bytes = 1 << (marker & 0x0f)
  let length = 0
  for (let i = 0; i < bytes; i += 1) {
    length = length * 256 + buffer.readUInt8(offset + 2 + i)
  }
  return { length, headerSize: 2 + bytes }
}

/**
 * 读定长无符号整数（大端）。
 *
 * 不用 `readUIntBE` 是因为它最大只支持 6 字节，而 plist 里可能是 8 字节。
 *
 * @param {Buffer} buffer
 * @param {number} offset
 * @param {number} size
 */
function readUInt(buffer, offset, size) {
  let value = 0
  for (let i = 0; i < size; i += 1) {
    value = value * 256 + buffer.readUInt8(offset + i)
  }
  return value
}

/**
 * 二进制 plist 的 UTF-16 是大端，Node 的 `utf16le` 是小端，
 * 所以要逐字交换字节。
 *
 * @param {Buffer} buffer
 */
function swapEndianUtf16(buffer) {
  const swapped = Buffer.alloc(buffer.length)
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    swapped[i] = buffer[i + 1]
    swapped[i + 1] = buffer[i]
  }
  return swapped.toString('utf16le')
}

// ---------------------------------------------------------------------------
// XML plist
// ---------------------------------------------------------------------------

/**
 * 解析 XML plist。
 *
 * 这不是通用 XML 解析器，只认 plist 的固定结构：
 * `<plist>` → `<dict>` → 成对的 `<key>` 与值节点。
 *
 * 为什么不用正则硬切：值节点可能嵌套（数组套字典），正则会切错层级。
 * 这里用一个极简的递归下降，按标签流式推进，约 100 行但能正确处理嵌套。
 *
 * @param {string} text
 * @returns {unknown}
 */
export function parseXmlPlist(text) {
  const tokens = tokenize(text)
  let cursor = 0

  const peek = () => tokens[cursor]
  const next = () => tokens[cursor++]

  /** 跳过声明、DOCTYPE、注释。 */
  const skipProlog = () => {
    while (cursor < tokens.length) {
      const token = peek()
      if (token.type === 'pi' || token.type === 'doctype' || token.type === 'comment') {
        cursor += 1
        continue
      }
      break
    }
  }

  skipProlog()

  /** 读一个值节点。 */
  const readValue = () => {
    const token = next()
    if (token === undefined) throw new PlistError('XML 意外结束')

    if (token.type === 'open') {
      const name = token.name
      if (name === 'dict') return readDict()
      if (name === 'array') return readArray()
      if (name === 'string') return readText('string')
      if (name === 'integer') return Number.parseInt(readText('integer').trim(), 10)
      if (name === 'real') return Number.parseFloat(readText('real').trim())
      if (name === 'true') { skipClose('true'); return true }
      if (name === 'false') { skipClose('false'); return false }
      if (name === 'date') return new Date(readText('date').trim())
      if (name === 'data') return readText('data').trim()
      if (name === 'plist') {
        const value = readValue()
        skipClose('plist')
        return value
      }
      throw new PlistError(`未知的 plist 标签：<${name}>`)
    }
    if (token.type === 'selfclose') {
      /*
       * 自闭合标签在真实 plist 里很常见：`<dict/>` `<array/>` `<string/>`
       * 都表示空容器。早期的实现只处理了 true/false，遇到 `<dict/>`
       * 直接抛错 —— 而系统应用的 plist 里确实有空的 dict（例如
       * `CFBundleDocumentTypes` 为空时）。
       */
      if (token.name === 'true') return true
      if (token.name === 'false') return false
      if (token.name === 'string') return ''
      if (token.name === 'dict') return {}
      if (token.name === 'array') return []
      if (token.name === 'data') return ''
      if (token.name === 'integer') return 0
      if (token.name === 'real') return 0
      throw new PlistError(`自闭合标签不支持：<${token.name}/>`)
    }
    throw new PlistError(`意外的 token：${token.type}`)
  }

  /** 读标签内的文本直到闭合标签。 */
  const readText = (name) => {
    const token = next()
    if (token === undefined) throw new PlistError(`<${name}> 未闭合`)
    if (token.type === 'text') {
      const close = next()
      if (close === undefined || close.type !== 'close' || close.name !== name) {
        throw new PlistError(`<${name}> 的闭合标签不匹配`)
      }
      return token.text
    }
    if (token.type === 'close' && token.name === name) return ''
    throw new PlistError(`<${name}> 内容异常`)
  }

  /**
   * 消费一个闭合标签。
   *
   * 早期实现在 token 为 undefined 时直接 return —— 这让「缺闭合标签」
   * 被静默接受。现在缺 token 就是结构错误，必须抛。
   *
   * @param {string} name
   */
  const skipClose = (name) => {
    const token = next()
    if (token === undefined) {
      throw new PlistError(`<${name}> 缺少闭合标签`)
    }
    if (token.type === 'close' && token.name === name) return
    /*
     * 走到这里说明标签不匹配。回退一格交给上层判断 ——
     * 上层可能是「自闭合已在别处处理」的情况，不能一概抛错。
     */
    cursor -= 1
  }

  const readDict = () => {
    const out = {}
    for (;;) {
      const token = peek()
      if (token === undefined) throw new PlistError('<dict> 未闭合')
      if (token.type === 'close' && token.name === 'dict') { next(); break }

      const keyToken = next()
      if (keyToken === undefined || keyToken.type !== 'open' || keyToken.name !== 'key') {
        throw new PlistError('<dict> 内应为 <key>')
      }
      const key = readText('key')
      out[key] = readValue()
    }
    return out
  }

  const readArray = () => {
    const out = []
    for (;;) {
      const token = peek()
      if (token === undefined) throw new PlistError('<array> 未闭合')
      if (token.type === 'close' && token.name === 'array') { next(); break }
      out.push(readValue())
    }
    return out
  }

  const value = readValue()

  /*
   * 顶层必须**完全消费完**，且不得有残留。
   *
   * 这一条来自一个真实缺陷：缺 `</plist>` 闭合标签的 XML 被静默接受了 ——
   * 因为 readValue 读完 `<dict>` 就返回，没人检查后面还有没有东西、
   * 或者 plist 标签是否闭合。
   *
   * 对真实 plist 宽容（比如允许自闭合空容器）是好事，但对**损坏的**
   * plist 宽容会掩盖问题：一个截断的 Info.plist 会被当成合法的，
   * 后续所有判断都建立在错误前提上。
   *
   * 检查两件事：
   *   1. 不能有剩余的实质内容（非注释/声明）
   *   2. 若出现过 <plist> 开标签，必须有对应的闭合
   */
  while (cursor < tokens.length) {
    const rest = tokens[cursor]
    if (rest.type === 'comment' || rest.type === 'pi' || rest.type === 'doctype') {
      cursor += 1
      continue
    }
    throw new PlistError(
      `XML 结构不完整：<${String(rest.name ?? rest.type)}> 之后仍有内容`)
  }

  /*
   * 顶层若用了 <plist> 包裹，必须闭合。
   *
   * readValue 遇到 <plist> 时已经 skipClose('plist')，所以正常路径
   * 不会有残留；能走到这里有残留就说明标签没配对。
   */
  return value
}

/**
 * 把 XML 切成 token 流。
 *
 * 只需要四种 token：open / close / selfclose / text，加三种可跳过的。
 *
 * @param {string} text
 */
function tokenize(text) {
  const tokens = []
  let cursor = 0

  while (cursor < text.length) {
    const lt = text.indexOf('<', cursor)
    if (lt < 0) {
      const rest = text.slice(cursor)
      if (rest.trim() !== '') tokens.push({ type: 'text', text: decodeEntities(rest) })
      break
    }
    if (lt > cursor) {
      const chunk = text.slice(cursor, lt)
      if (chunk.trim() !== '') tokens.push({ type: 'text', text: decodeEntities(chunk) })
    }

    const gt = text.indexOf('>', lt)
    if (gt < 0) break
    const raw = text.slice(lt + 1, gt)
    cursor = gt + 1

    if (raw.startsWith('?')) { tokens.push({ type: 'pi' }); continue }
    if (raw.startsWith('!')) { tokens.push({ type: 'doctype' }); continue }
    if (raw.startsWith('!--')) {
      // 注释可能跨行，找到 -->
      const end = text.indexOf('-->', lt)
      cursor = end < 0 ? text.length : end + 3
      tokens.push({ type: 'comment' })
      continue
    }
    if (raw.startsWith('/')) {
      tokens.push({ type: 'close', name: raw.slice(1).trim() })
      continue
    }
    if (raw.endsWith('/')) {
      tokens.push({ type: 'selfclose', name: raw.slice(0, -1).trim() })
      continue
    }
    tokens.push({ type: 'open', name: raw.split(/\s+/u)[0] })
  }
  return tokens
}

/**
 * 还原 XML 实体。
 *
 * @param {string} text
 */
function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
}