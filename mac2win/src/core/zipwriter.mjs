/**
 * 最小的 zip 打包实现。
 *
 * ## 为什么自己写
 *
 * 与 `zip.mjs`（解包）同一个理由：不想为一个「把目录压成一个文件」
 * 的需求引第三方库，也不想依赖系统 `zip` 命令（不同 macOS 版本的
 * 参数与行为不完全一致，且受管环境里外部命令可能被拦截）。
 *
 * ## 支持范围
 *
 * 只用 **deflate**（method 8）与 **存储**（method 0）两种方法。
 * 前者用于可压缩的文本与二进制，后者用于已经压缩过的文件
 * （图片、字体、`.exe` 之类）——再压一遍只会浪费时间。
 *
 * 不写 zip64：单文件超过 4 GB 或总大小超过 4 GB 时报错，
 * 而不是产出损坏的包。桌面应用的安装目录不会到这个量级。
 */

import { createWriteStream } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { deflateRawSync } from 'node:zlib'
import { join } from 'node:path'
import { walkFiles } from '../util/fsx.mjs'

/** 压缩方法码。 */
const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/**
 * 判断一个扩展名是否**确定**不值得尝试压缩。
 *
 * ## 为什么把 `.exe` / `.dll` 从名单里拿掉
 *
 * 最初把它们列为「已压缩」，理由是 PE 文件里的资源段是压缩过的。
 * 实测打脸：`node.exe` 73.3 MB 用 deflate 能压到约 30 MB——
 * 因为它的绝大部分是未压缩的代码段与调试符号。
 *
 * 现在的策略是**不猜，试一下**：先 deflate，只有在结果确实更小
 * （见下面的 `useDeflate` 判断）时才采用。代价是几秒 CPU，
 * 收益是体积减半。这个交换对安装包显然划算。
 *
 * 真正没必要试的只剩「压缩算法产物」本身：zip / 图片 / 视频 /
 * 字体。它们再压一遍确实只能省 1–2%，而 CPU 要多花几倍。
 */
const NEVER_COMPRESS = new Set([
  '.zip', '.gz', '.xz', '.bz2', '.7z', '.rar',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif',
  '.mp3', '.mp4', '.webm', '.ogg', '.opus', '.m4a',
  '.woff', '.woff2',
])

/** 该不该尝试压缩。 */
function shouldCompress(name) {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return true
  return !NEVER_COMPRESS.has(name.slice(dot).toLowerCase())
}

/**
 * 把目录压成一个 zip。
 *
 * @param {object} input
 * @param {string} input.source 源目录。
 * @param {string} input.outputFile 产物 zip 路径。
 * @param {string} [input.rootName] 包内的顶层目录名。默认用源目录名。
 * @param {(message: string) => void} [input.onProgress]
 * @returns {Promise<{files: number, bytes: number, compressedBytes: number}>}
 */
export async function zipDirectory(input) {
  const { source, outputFile, onProgress } = input

  const files = await walkFiles(source)
  if (files.length === 0) {
    throw new Error(`源目录为空：${source}`)
  }

  /*
   * 包内顶层目录名。
   *
   * 用户解开 zip 时应该得到一个文件夹而不是一堆散文件——否则解压到
   * 桌面就污染了。用产品名做顶层目录是最自然的做法。
   */
  const rootName = input.rootName ?? source.split('/').pop() ?? 'app'

  const stream = createWriteStream(outputFile)

  /*
   * ## 为什么 error 监听器只能挂一次
   *
   * 最初写成「每次 write 都挂一个 once('error')」，于是写 500 个文件
   * 就挂 500 个监听器，Node 报 MaxListenersExceededWarning，而且
   * 真有错误时会被触发多次（每次都是一次 unhandled 风险）。
   *
   * 现在挂一次，把错误存进 `writeError`，每次 write 先检查它。
   */
  let writeError = null
  stream.on('error', (error) => { writeError = error })

  const write = (buffer) => new Promise((resolve, reject) => {
    if (writeError !== null) {
      reject(writeError)
      return
    }
    if (stream.write(buffer)) {
      resolve()
      return
    }
    // drain 也只挂一次，用一次性回调。
    stream.once('drain', () => {
      if (writeError !== null) reject(writeError)
      else resolve()
    })
  })

  /** 中央目录条目，最后统一写入。 */
  const central = []
  let offset = 0
  let rawBytes = 0
  let processed = 0

  try {
    for (const relative of files) {
      const absolute = join(source, relative)
      const info = await stat(absolute)
      if (info.isDirectory()) continue

      const content = await readFile(absolute)
      rawBytes += content.length

      const name = `${rootName}/${relative}`
      const nameBuffer = Buffer.from(name, 'utf8')

      const compress = shouldCompress(relative)
      const compressed = compress ? deflateRawSync(content, { level: 6 }) : content
      // 压完反而更大时用原始内容——小文件常见这种情况。
      const useDeflate = compress && compressed.length < content.length
      const payload = useDeflate ? compressed : content
      const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE

      const crc = crc32(content)

      // 本地文件头（30 字节 + 文件名）。
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)          // 解压所需版本
      local.writeUInt16LE(0x800, 6)       // UTF-8 文件名标志
      local.writeUInt16LE(method, 8)
      local.writeUInt16LE(0, 10)          // 修改时间
      local.writeUInt16LE(0, 12)          // 修改日期
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(payload.length, 18)
      local.writeUInt32LE(content.length, 22)
      local.writeUInt16LE(nameBuffer.length, 26)
      local.writeUInt16LE(0, 28)          // 额外字段长度

      await write(local)
      await write(nameBuffer)
      await write(payload)

      central.push({
        nameBuffer,
        method,
        crc,
        compressedSize: payload.length,
        uncompressedSize: content.length,
        localOffset: offset,
      })

      offset += local.length + nameBuffer.length + payload.length
      processed += 1
      if (processed % 500 === 0) {
        onProgress?.(`已打包 ${String(processed)} / ${String(files.length)} 个文件`)
      }
    }

    // 中央目录。
    const centralBuffers = []
    let centralSize = 0
    for (const entry of central) {
      const header = Buffer.alloc(46)
      header.writeUInt32LE(0x02014b50, 0)
      header.writeUInt16LE(20, 4)         // 创建版本
      header.writeUInt16LE(20, 6)         // 解压所需版本
      header.writeUInt16LE(0x800, 8)      // UTF-8 标志
      header.writeUInt16LE(entry.method, 10)
      header.writeUInt16LE(0, 12)
      header.writeUInt16LE(0, 14)
      header.writeUInt32LE(entry.crc, 16)
      header.writeUInt32LE(entry.compressedSize, 20)
      header.writeUInt32LE(entry.uncompressedSize, 24)
      header.writeUInt16LE(entry.nameBuffer.length, 28)
      header.writeUInt16LE(0, 30)         // 额外字段
      header.writeUInt16LE(0, 32)         // 注释
      header.writeUInt16LE(0, 34)         // 磁盘号
      header.writeUInt16LE(0, 36)         // 内部属性
      header.writeUInt32LE(0, 38)         // 外部属性
      header.writeUInt32LE(entry.localOffset, 42)

      centralBuffers.push(header, entry.nameBuffer)
      centralSize += header.length + entry.nameBuffer.length
    }
    const centralBuffer = Buffer.concat(centralBuffers)
    await write(centralBuffer)

    // 中央目录结束记录。
    if (central.length > 0xffff) {
      throw new Error(`文件数 ${String(central.length)} 超过 zip 上限 65535，需要 zip64`)
    }
    if (offset + centralSize > 0xffffffff) {
      throw new Error('包体超过 4 GB，需要 zip64')
    }

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(central.length, 8)
    eocd.writeUInt16LE(central.length, 10)
    eocd.writeUInt32LE(centralSize, 12)
    eocd.writeUInt32LE(offset, 16)
    eocd.writeUInt16LE(0, 20)
    await write(eocd)
  } finally {
    await new Promise((resolve) => { stream.end(resolve) })
  }

  const finalSize = (await stat(outputFile)).size
  return { files: central.length, bytes: rawBytes, compressedBytes: finalSize }
}

/** CRC-32 查表，只算一次。 */
let CRC_TABLE = null

function crcTable() {
  if (CRC_TABLE !== null) return CRC_TABLE
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
    }
    table[index] = value >>> 0
  }
  CRC_TABLE = table
  return table
}

/**
 * 算 CRC-32。
 *
 * zip 的每个条目都要带它，解压方用它验证内容完整性——这是 zip
 * 自带的校验机制，比只比文件大小可靠得多。
 */
export function crc32(buffer) {
  const table = crcTable()
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc = table[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}