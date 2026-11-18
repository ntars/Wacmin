/**
 * 最小的 zip 解包实现。
 *
 * ## 为什么自己写
 *
 * 需要解三种官方包：Node 的 win-x86 zip、Electron 的 win32-ia32 zip、
 * NW.js 的 win-ia32 zip。它们都只用「存储（0）」与「deflate（8）」两种
 * 压缩方法，且文件名全是 ASCII。为这个场景引一个 zip 库不值得。
 *
 * 更关键的是：调外部 `unzip` 会引入平台假设。macOS 自带的 `unzip` 是
 * Info-ZIP 6.0（2009 年），对某些 zip64 字段处理不一致；而
 * `ditto` 只在 mac 上有。自己解析是唯一「在任何 mac 上都一样」的做法。
 *
 * ## 支持范围与明确的不支持
 *
 * 支持：存储 / deflate、zip64 扩展、UTF-8 文件名标志。
 * 不支持：加密（官方包不会加密）、bzip2/lzma 压缩方法。
 * 遇到不支持的方法时明确报错，而不是写出半个损坏的文件。
 */

import { inflateRawSync } from 'node:zlib'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 中央目录结束记录签名。 */
const EOCD_SIGNATURE = 0x06054b50
/** zip64 中央目录结束记录签名。 */
const EOCD64_SIGNATURE = 0x06064b50
/** zip64 定位器签名。 */
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50

/** 解包失败时抛出。 */
export class ZipError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ZipError'
  }
}

/**
 * 解一个 zip 到目录。
 *
 * @param {string} zipPath zip 文件路径。
 * @param {string} targetDir 目标目录。
 * @returns {Promise<{files: number}>}
 */
export async function unzipFile(zipPath, targetDir) {
  const buffer = await readFile(zipPath)

  if (buffer.length < 22) throw new ZipError('文件太小，不可能是 zip')

  // 从尾部往前找 EOCD。注释最长 65535 字节。
  let eocd = -1
  const scanStart = Math.max(0, buffer.length - 22 - 65535)
  for (let i = buffer.length - 22; i >= scanStart; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipError('找不到中央目录结束记录，不是合法的 zip')

  let entryCount = buffer.readUInt16LE(eocd + 10)
  let centralOffset = buffer.readUInt32LE(eocd + 16)

  /*
   * zip64：当文件数或偏移超过 65535 / 4GB 时，真正的值在 zip64 记录里。
   * Electron 的包只有几十 MB，理论上用不到，但 `nwjs` 的某些包接近
   * 200MB、文件数上万，所以必须支持。
   */
  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    // 定位器紧挨在 EOCD 之前。
    const locator = eocd - 20
    if (locator >= 0 && buffer.readUInt32LE(locator) === EOCD64_LOCATOR_SIGNATURE) {
      const eocd64Offset = Number(buffer.readBigUInt64LE(locator + 8))
      if (eocd64Offset >= 0 && eocd64Offset + 56 <= buffer.length && buffer.readUInt32LE(eocd64Offset) === EOCD64_SIGNATURE) {
        entryCount = Number(buffer.readBigUInt64LE(eocd64Offset + 32))
        centralOffset = Number(buffer.readBigUInt64LE(eocd64Offset + 48))
      }
    }
  }

  await mkdir(targetDir, { recursive: true })

  let offset = centralOffset
  let files = 0

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length) throw new ZipError(`中央目录越界（第 ${String(index)} 项）`)
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new ZipError(`中央目录签名错误（第 ${String(index)} 项）`)
    }

    const method = buffer.readUInt16LE(offset + 10)
    const flags = buffer.readUInt16LE(offset + 8)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1')

    offset += 46 + nameLength + extraLength + commentLength

    // 目录项本身不落地，但父目录会在写文件时按需创建。
    if (name.endsWith('/')) continue

    // 防路径穿越：zip 里可能有 `../../etc/passwd` 这种条目。
    const normalized = name.split('\\').join('/')
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new ZipError(`压缩包里有不安全的路径：${name}`)
    }

    // 本地头里的长度可能与中央目录不同，必须重读。
    if (localOffset + 30 > buffer.length) throw new ZipError(`本地头越界：${name}`)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength

    // 压缩大小优先从中央目录取；zip64 时该字段是 0xffffffff，
    // 需要从额外字段里找。这里用「下一项的开始位置」兜底更稳。
    let compressedSize = buffer.readUInt32LE(offset - commentLength - extraLength - nameLength - 46 + 20)
    if (compressedSize === 0xffffffff) {
      // 从额外字段解析 zip64 扩展（0x0001）。
      const extraStart = offset - commentLength - extraLength
      compressedSize = readZip64Size(buffer, extraStart, extraLength)
    }

    const raw = buffer.subarray(dataStart, dataStart + compressedSize)

    let content
    if (method === 0) {
      content = raw
    } else if (method === 8) {
      try {
        content = inflateRawSync(raw)
      } catch (error) {
        throw new ZipError(`解压失败（${name}）：${error.message}`)
      }
    } else {
      throw new ZipError(`不支持的压缩方法 ${String(method)}（${name}），只支持存储与 deflate`)
    }

    const outPath = join(targetDir, normalized)
    await mkdir(dirname(outPath), { recursive: true })
    await writeFile(outPath, content)
    files += 1
  }

  return { files }
}

/**
 * 从额外字段里读 zip64 的压缩大小。
 *
 * zip64 扩展的字段顺序：原始大小(8)、压缩大小(8)、本地头偏移(8)、
 * 磁盘号(4)，按需截断——只有被写成 0xffffffff 的字段才存在。
 * 这里简化处理：读前两个 8 字节，取第二个（压缩大小）。
 */
function readZip64Size(buffer, extraStart, extraLength) {
  let cursor = extraStart
  const end = extraStart + extraLength
  while (cursor + 4 <= end) {
    const tag = buffer.readUInt16LE(cursor)
    const size = buffer.readUInt16LE(cursor + 2)
    if (tag === 0x0001 && size >= 16) {
      // 原始大小在前，压缩大小在后。
      return Number(buffer.readBigUInt64LE(cursor + 12))
    }
    cursor += 4 + size
  }
  throw new ZipError('zip64 额外字段缺失，无法确定压缩大小')
}