/**
 * 保留 Unix 权限位的 zip 写入器。
 *
 * ## 为什么不能复用 mac2win 的 zipwriter
 *
 * mac2win 的产物是 Windows 安装包，权限位在 Windows 上毫无意义，
 * 所以那边把 `external_attr` 写 0、`create_system` 写 0（FAT）是对的。
 *
 * 但 Win2Mac 的产物是 `.app`，它是一个**可执行的目录**。macOS 上：
 *
 *   - `Contents/MacOS/<executable>` 必须有 `0755`，否则双击报
 *     「应用程序无法打开」
 *   - 目录需要 `0755`，否则 Finder 进不去
 *   - 符号链接要按 `S_IFLNK` 存，不能当普通文件复制内容
 *
 * 实测用 mac2win 的写入器打一个 `0755` 的脚本，解压后变成 `0644`：
 *
 *     -rw-r--r--  1 user  staff  18  T.app/Contents/MacOS/launcher
 *
 * 这种包在 macOS 上**必然打不开**，而且报错信息（「无法打开」）
 * 完全不提示是权限问题，用户根本查不到原因。
 *
 * ## 做法
 *
 * zip 规范里 `external_attr` 的高 16 位是 Unix mode，低 16 位是
 * DOS 属性；`create_system` 必须是 3（Unix）才会被解压方读取。
 *
 *     external_attr = (mode << 16) | dosAttrs
 *     create_system = 3
 *
 * 目录额外置 `S_IFDIR`（0o040000），符号链接置 `S_IFLNK`（0o120000）
 * 并把链接目标当内容写入（这是 zip 存符号链接的标准做法，解压时
 * `unzip` / macOS 归档工具都认）。
 *
 * ## 为什么仍不引第三方库
 *
 * 与 mac2win 同一个理由：`yazl` / `archiver` 都能做，但为一个
 * 「打 zip」的需求引依赖不值得。这里的实现约 200 行，覆盖了
 * deflate / store / 符号链接 / 权限位，够用且可读。
 */

import { createWriteStream } from 'node:fs'
import { lstat, readFile, readlink, readdir, stat } from 'node:fs/promises'
import { deflateRawSync } from 'node:zlib'
import { join } from 'node:path'
import { crc32 } from '../../../mac2win/src/core/zipwriter.mjs'

/** 压缩方法码。 */
const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** `create_system` 取值：3 表示 Unix，解压方据此读 external_attr 的高 16 位。 */
const CREATE_SYSTEM_UNIX = 3

/** 文件类型位（POSIX）。 */
const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

/** 默认权限：可执行文件与目录都是 0755，普通文件 0644。 */
const DEFAULT_DIR_MODE = 0o755
const DEFAULT_FILE_MODE = 0o644

/**
 * 这些扩展名已经压过一遍，再 deflate 只会浪费 CPU。
 * 判断只看扩展名，不做内容嗅探 —— 那需要读全文件，得不偿失。
 */
const INCOMPRESSIBLE = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns',
  '.zip', '.gz', '.bz2', '.xz', '.7z', '.rar', '.dmg',
  '.mp3', '.mp4', '.m4a', '.ogg', '.webm', '.woff', '.woff2',
  '.exe', '.dll', '.node', '.so', '.dylib',
])

/**
 * 判断某路径是否值得压缩。
 * @param {string} name 包内路径。
 */
function shouldCompress(name) {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return true
  return !INCOMPRESSIBLE.has(name.slice(dot).toLowerCase())
}

/**
 * 遍历目录，返回所有条目（含目录与符号链接）。
 *
 * 与 `walkFiles` 的区别：那个只返回文件，这里必须包含目录与链接，
 * 否则解压后目录权限丢失、符号链接被当成空文件。
 *
 * @param {string} root 源目录。
 * @returns {Promise<Array<{relative: string, absolute: string, kind: 'dir'|'file'|'symlink'}>>}
 */
async function walkEntries(root) {
  /** @type {Array<{relative: string, absolute: string, kind: 'dir'|'file'|'symlink'}>} */
  const out = []
  /** @type {string[]} */
  const queue = ['']

  while (queue.length > 0) {
    const relative = queue.shift()
    const absolute = relative === '' ? root : join(root, relative)
    const info = await lstat(absolute)

    if (relative !== '') {
      if (info.isSymbolicLink()) {
        out.push({ relative, absolute, kind: 'symlink' })
        // 符号链接不递归：它指向的可能是包外路径，跟进去会打出无限深度
        continue
      }
      if (info.isDirectory()) out.push({ relative, absolute, kind: 'dir' })
      else if (info.isFile()) out.push({ relative, absolute, kind: 'file' })
      else continue // 设备文件、FIFO 之类一律跳过
    }

    if (info.isDirectory() && !info.isSymbolicLink()) {
      const children = await readdir(absolute)
      for (const child of children) {
        queue.push(relative === '' ? child : `${relative}/${child}`)
      }
    }
  }
  return out
}

/**
 * Windows 上 `stat().mode` 的权限位是「有值但没用」的。
 *
 * 实测数据：Windows 的目录返回 `0o40666`，普通文件返回 `0o100666`。
 * 两个值都非零，看起来像有效权限，但都不含执行位 —— 目录拿这个值写进
 * zip，解压后 `cd` 进不去；文件拿这个值，解压后权限是 `0666` 而不是
 * `0644`，比预期更宽。
 *
 * 关键在于**不能用「非零即有效」判断**。判断依据只能是平台：
 * 当前进程跑在 Windows 上，就没有可信的 POSIX 位来源。
 *
 * 这里的判断抽成函数而非常量，是为了让测试能显式验证 Windows 分支 ——
 * 否则只有在 Windows runner 上跑 CI 才会发现问题，本机永远测不出来。
 */
function isWindowsPlatform(platform = process.platform) {
  return platform === 'win32'
}

/** 权限位里这三类都算「有执行权限」。 */
const EXEC_BITS = 0o111

/**
 * 取条目的 Unix 权限位。
 *
 * 两条信息源，优先级明确：
 *
 * 1. **bundle 内的角色**（路径决定）。这是唯一可靠的依据，因为
 *    `Contents/MacOS/` 下的东西在 macOS 上必须可执行，无论源文件
 *    在 Windows 上是什么权限。
 * 2. **源文件的真实 mode**（仅当宿主不是 Windows）。
 *
 * 为什么宿主判断优先于 mode 取值：Windows 的 mode 恒非零，任何
 * 「取到 0 才兜底」的写法都不会触发。这一点在 CI 的 Windows runner
 * 上暴露过 —— 目录写成 `0o40666`，产物在任何 Mac 上都无法解压进入。
 *
 * @param {import('node:fs').Stats} info
 * @param {string} relative 包内相对路径。
 * @param {'dir'|'file'|'symlink'} kind
 * @param {string} executableName CFBundleExecutable 的值。
 * @param {string} [platform] 平台标识，仅供测试注入；默认取当前平台。
 */
export function resolveMode(info, relative, kind, executableName, platform = process.platform) {
  const onWindows = isWindowsPlatform(platform)

  if (kind === 'symlink') return S_IFLNK | 0o777

  if (kind === 'dir') {
    /*
     * 目录必须可进入（至少 0755）。宿主是 Windows 时无从判断，
     * 直接给 0755；否则沿用源目录权限，但补上执行位 —— 一个目录
     * 没有执行位在任何 Unix 上都是打不开的，不存在「合理的只读目录」。
     *
     * 补位时只补到 0755 的形态，不盲目 `| 0o111`。后者会把 0666 变成
     * 0777，同一份源在 Windows 与 macOS 上产出的目录权限就不一致了，
     * 产物无法复现。这里统一收敛到「与 0755 取并」的语义：源权限更宽
     * 的部分保留，但组/其他的写权限不在目录上额外授予。
     */
    if (onWindows) return S_IFDIR | DEFAULT_DIR_MODE
    const perm = info.mode & 0o777
    if (perm === 0) return S_IFDIR | DEFAULT_DIR_MODE
    return S_IFDIR | ((perm & 0o755) | EXEC_BITS)
  }

  /*
   * 文件：先按路径认角色，这条路在 Windows 上同样有效。
   *
   * `Contents/MacOS/<CFBundleExecutable>` 必须 0755 —— 这是 `.app`
   * 能否双击打开的唯一决定因素，也是整个模块存在的理由。
   */
  if (relative.startsWith('Contents/MacOS/')) {
    return S_IFREG | 0o755
  }

  if (onWindows) return S_IFREG | DEFAULT_FILE_MODE

  /*
   * 非 Windows：源文件的真实权限有意义，保留读写位。
   * 但把「组/其他」的写权限收掉 —— 一个随 .app 分发的资源文件不该是
   * 0666，0644 才是预期。执行位不在这里给：需要执行的文件都在
   * MacOS/ 下，上面已经处理。
   */
  const perm = info.mode & 0o777
  if (perm === 0) return S_IFREG | DEFAULT_FILE_MODE
  return S_IFREG | (perm & 0o644) | 0o600
}

/**
 * 把 `.app` 目录打成 zip，保留 Unix 权限与符号链接。
 *
 * @param {object} input
 * @param {string} input.source 源目录（`.app`）。
 * @param {string} input.outputFile 产物 zip 路径。
 * @param {string} [input.rootName] 包内顶层目录名，默认取源目录名。
 * @param {string} [input.executableName] CFBundleExecutable，用于判定哪些文件要 0755。
 * @param {(message: string) => void} [input.onProgress]
 * @returns {Promise<{files: number, dirs: number, symlinks: number, bytes: number, compressedBytes: number}>}
 */
export async function zipBundle(input) {
  const { source, outputFile, onProgress } = input
  const executableName = input.executableName ?? 'launcher'
  const rootName = input.rootName ?? source.split(/[\\/]/).pop() ?? 'app'

  const entries = await walkEntries(source)
  if (entries.length === 0) {
    throw new Error(`源目录为空：${source}`)
  }

  const stream = createWriteStream(outputFile)
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
    stream.once('drain', () => {
      if (writeError !== null) reject(writeError)
      else resolve()
    })
  })

  /** @type {Array<object>} */
  const central = []
  let offset = 0
  let rawBytes = 0
  let fileCount = 0
  let dirCount = 0
  let linkCount = 0
  let processed = 0

  try {
    for (const entry of entries) {
      /*
       * 目录名必须以 `/` 结尾。
       *
       * 这是 zip 规范里判定「这是目录」的第一依据，比 external_attr 里的
       * S_IFDIR 更早被解压方检查。漏了它，`unzip` 会把目录条目当成
       * 一个零字节文件创建，后续所有子项都报
       * "exists but is not directory"。
       */
      const suffix = entry.kind === 'dir' ? '/' : ''
      const name = `${rootName}/${entry.relative}${suffix}`

      let content
      let info
      if (entry.kind === 'symlink') {
        /*
         * 符号链接：内容就是链接目标字符串，不带结尾 NUL。
         * 这是 zip 存链接的标准做法，`unzip` 与 macOS 归档工具都会
         * 据此重建链接而不是写一个普通文件。
         */
        content = Buffer.from(await readlink(entry.absolute), 'utf8')
        info = await lstat(entry.absolute)
        linkCount += 1
      } else if (entry.kind === 'dir') {
        content = Buffer.alloc(0)
        info = await lstat(entry.absolute)
        dirCount += 1
      } else {
        content = await readFile(entry.absolute)
        info = await stat(entry.absolute)
        rawBytes += content.length
        fileCount += 1
      }

      const mode = resolveMode(info, entry.relative, entry.kind, executableName)
      // 高 16 位是 Unix mode，低 16 位是 DOS 属性（目录置 0x10）
      const externalAttr = ((mode << 16) | (entry.kind === 'dir' ? 0x10 : 0)) >>> 0

      const nameBuffer = Buffer.from(name, 'utf8')
      const compress = entry.kind === 'file' && shouldCompress(entry.relative)
      const compressed = compress ? deflateRawSync(content, { level: 6 }) : content
      const useDeflate = compress && compressed.length < content.length
      const payload = useDeflate ? compressed : content
      const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE
      const crc = crc32(content)

      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      // 解压所需版本：20 是 2.0，支持 deflate；符号链接也在这个版本内
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0x800, 6)       // 文件名 UTF-8
      local.writeUInt16LE(method, 8)
      local.writeUInt16LE(0, 10)
      local.writeUInt16LE(0, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(payload.length, 18)
      local.writeUInt32LE(content.length, 22)
      local.writeUInt16LE(nameBuffer.length, 26)
      local.writeUInt16LE(0, 28)

      await write(local)
      await write(nameBuffer)
      if (payload.length > 0) await write(payload)

      central.push({
        nameBuffer, method, crc,
        compressedSize: payload.length,
        uncompressedSize: content.length,
        localOffset: offset,
        externalAttr,
      })

      offset += local.length + nameBuffer.length + payload.length
      processed += 1
      if (processed % 500 === 0) {
        onProgress?.(`已打包 ${String(processed)} / ${String(entries.length)} 个条目`)
      }
    }

    const centralBuffers = []
    let centralSize = 0
    for (const entry of central) {
      const header = Buffer.alloc(46)
      header.writeUInt32LE(0x02014b50, 0)
      /*
       * 创建版本：高字节 = 3（Unix），低字节 = 20（zip 2.0）。
       *
       * 这一处是最容易漏的。只写 external_attr 而不把 create_system
       * 置成 Unix，解压方会忽略高 16 位，权限照样丢失。
       */
      header.writeUInt16LE((CREATE_SYSTEM_UNIX << 8) | 20, 4)
      header.writeUInt16LE(20, 6)
      header.writeUInt16LE(0x800, 8)
      header.writeUInt16LE(entry.method, 10)
      header.writeUInt16LE(0, 12)
      header.writeUInt16LE(0, 14)
      header.writeUInt32LE(entry.crc, 16)
      header.writeUInt32LE(entry.compressedSize, 20)
      header.writeUInt32LE(entry.uncompressedSize, 24)
      header.writeUInt16LE(entry.nameBuffer.length, 28)
      header.writeUInt16LE(0, 30)
      header.writeUInt16LE(0, 32)
      header.writeUInt16LE(0, 34)
      header.writeUInt16LE(0, 36)
      header.writeUInt32LE(entry.externalAttr, 38)
      header.writeUInt32LE(entry.localOffset, 42)

      centralBuffers.push(header, entry.nameBuffer)
      centralSize += header.length + entry.nameBuffer.length
    }
    await write(Buffer.concat(centralBuffers))

    if (central.length > 0xffff) {
      throw new Error(`条目数 ${String(central.length)} 超过 zip 上限 65535，需要 zip64`)
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
  return {
    files: fileCount,
    dirs: dirCount,
    symlinks: linkCount,
    bytes: rawBytes,
    compressedBytes: finalSize,
  }
}

/**
 * 读回 zip 的条目属性，供 verify 用。
 *
 * 不解析中央目录的全部字段，只取验证需要的三样：路径、Unix mode、
 * 是否符号链接。这样即使产物由别的工具生成（不完全是本模块写的），
 * 也能检查权限是否正确。
 *
 * @param {string} zipPath
 * @returns {Promise<Array<{name: string, mode: number, isSymlink: boolean, isDir: boolean}>>}
 */
export async function readZipEntries(zipPath) {
  const buffer = await readFile(zipPath)

  // 从尾部找 EOCD（0x06054b50），注释最长 65535 字节
  let eocdOffset = -1
  const stop = Math.max(0, buffer.length - 65557)
  for (let index = buffer.length - 22; index >= stop; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocdOffset = index
      break
    }
  }
  if (eocdOffset < 0) throw new Error('不是合法的 zip：找不到中央目录结束记录')

  const count = buffer.readUInt16LE(eocdOffset + 10)
  let cursor = buffer.readUInt32LE(eocdOffset + 16)

  const entries = []
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`中央目录第 ${String(index)} 项签名错误`)
    }
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const externalAttr = buffer.readUInt32LE(cursor + 38)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)

    const mode = externalAttr >>> 16
    entries.push({
      name,
      mode,
      isDir: (mode & S_IFDIR) === S_IFDIR,
      isSymlink: (mode & S_IFLNK) === S_IFLNK,
    })

    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** 导出常量供测试与上层引用。 */
export const ZIP_MODES = {
  S_IFDIR, S_IFREG, S_IFLNK,
  DEFAULT_DIR_MODE, DEFAULT_FILE_MODE,
  EXECUTABLE_MODE: 0o755,
  CREATE_SYSTEM_UNIX,
}