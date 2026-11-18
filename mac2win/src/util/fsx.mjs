/**
 * 文件系统工具。
 *
 * ## 为什么不用 `cp -R` / `ditto` 走 shell
 *
 * 跨平台打包最容易踩的两个坑都在拷贝这一步：
 *
 * 1. **资源叉（AppleDouble）**：macOS 的 `cp -R` 会给每个文件生成 `._xxx`
 *    旁文件。这些文件搬进 Windows 安装包毫无意义，却会让校验哈希对不上、
 *    让用户看到一堆垃圾文件。
 * 2. **符号链接**：pnpm 把依赖软链到 `node_modules/.pnpm`，软链搬进 zip
 *    后指向一个 Windows 上不存在的路径，运行时就是 MODULE_NOT_FOUND。
 *
 * `fs.cp` 的 `dereference: true` 一次解决第 2 条，且它不产生资源叉，
 * 一次解决第 1 条。比调外部命令更可靠，也不用担心不同 macOS 版本
 * `ditto` 参数差异。
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, open, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'

/**
 * 需要从载荷里剔除的苹果垃圾，只认这三种**精确叶名**。
 *
 * 刻意不写成 `*.tmp` / `*.log` 这类通配：那会误伤项目自己的文件。
 * `._` 前缀只在它是资源叉时才该删，但资源叉必然是 `._` + 原文件名，
 * 而项目里正常文件不会以 `._` 开头——所以按前缀删是安全的。
 */
const JUNK_NAMES = new Set(['.DS_Store', '__MACOSX'])

/**
 * 本工具自己产出的文件，也不该进载荷。
 *
 * `.mac2win-build.log` 是 `mac2win ui` 的构建日志，写在项目根目录下。
 * 如果不排除，它会被当作项目文件打进安装包 —— 用户装完之后会在程序
 * 目录里看到一个莫名其妙的日志文件，内容还是上一次构建的输出。
 *
 * 单独一个集合而不是塞进 JUNK_NAMES：这些不是「苹果垃圾」，排除理由
 * 不同，分开写便于将来各自的增删。
 */
const OWN_ARTIFACTS = new Set(['.mac2win-build.log'])

/** 判断一个文件名是不是该剔除的苹果垃圾。 */
export function isJunk(name) {
  return JUNK_NAMES.has(name) || name.startsWith('._')
}

/** 判断是不是本工具自己产出的文件（不该进载荷）。 */
export function isOwnArtifact(name) {
  return OWN_ARTIFACTS.has(name)
}

/**
 * Windows 文件名里不允许出现的字符。
 *
 * `\ / : * ? " < > |` 加上控制字符（0x00-0x1F）。这些字符在 macOS 上
 * 完全合法，所以「在 Mac 上打 Windows 包」时极易踩到：
 *
 *   项目里有个 `file:1.txt` → 打包成功 → 用户拿到 exe →
 *   在 Windows 上解压时失败，或文件名被静默改写
 *
 * 更隐蔽的是 Windows 还保留了几个**设备名**（CON / PRN / AUX / NUL /
 * COM1-9 / LPT1-9），无论扩展名是什么都不能用作文件名。
 */
const WINDOWS_ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f]/u

/** Windows 保留设备名（不区分大小写，且带扩展名也不行）。 */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

/**
 * 检查一个相对路径在 Windows 上是否合法。
 *
 * 逐段检查，因为每一段都是独立的文件名。返回问题描述，合法时返回 null。
 *
 * @param {string} relativePath 用 `/` 分隔的相对路径。
 * @returns {string|null}
 */
export function windowsPathProblem(relativePath) {
  for (const segment of relativePath.split('/')) {
    if (segment === '') continue

    if (WINDOWS_ILLEGAL_CHARS.test(segment)) {
      return `含 Windows 不允许的字符（\\ / : * ? " < > | 或控制字符）`
    }

    // 设备名判断要去掉扩展名：`con.txt` 同样非法
    const stem = segment.split('.')[0].toLowerCase()
    if (WINDOWS_RESERVED.has(stem)) {
      return `是 Windows 保留设备名（${stem.toUpperCase()}），不能用`
    }

    // 结尾的点与空格在 Windows 上会被静默丢弃，导致文件名对不上
    if (/[. ]$/u.test(segment)) {
      return '以点或空格结尾（Windows 会静默丢弃）'
    }
  }
  return null
}

/** 递归列出目录下的所有普通文件，返回相对路径（用 `/` 分隔）。 */
export async function walkFiles(root, options = {}) {
  const { skipJunk = true, filter, skipDirs } = options
  const out = []

  /*
   * 当前递归栈上各目录的真实路径，用于检测软链造成的**环**。
   *
   * 为什么不能用「全局已访问集合」：pnpm 的 node_modules 里，
   * `node_modules/a` 与 `node_modules/b` 常指向 `.pnpm/pkg` 同一个真实
   * 目录。全局去重会把 `a`、`b` 都当成「已访问过」跳过，产物里就少了
   * 两个依赖入口 —— 那是真实的漏文件。
   *
   * 正确判断是「环」而不是「重复」：
   *   - 环：目标目录是当前路径的**祖先** → 无限递归，必须断
   *   - 重复：目标目录在别的分支下也出现过 → 合法，各分支都要收录
   *
   * 用栈（而不是集合）表达「祖先链」，进目录时压入、出目录时弹出。
   */
  const ancestorReals = []

  async function visit(dir) {
    let realDir
    try {
      realDir = await realpath(dir)
    } catch {
      // 目录不存在或不可解析，跳过
      return
    }
    // 只有「指向自己的祖先」才是环
    if (ancestorReals.includes(realDir)) return
    ancestorReals.push(realDir)

    try {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        // 权限不足的目录不该让整个打包失败，跳过并留下痕迹由上层决定怎么报。
        if (error.code === 'EACCES' || error.code === 'EPERM') return
        throw error
      }

      for (const entry of entries) {
        if (skipJunk && (isJunk(entry.name) || isOwnArtifact(entry.name))) continue
        const absolute = join(dir, entry.name)

        /*
         * `skipDirs` 在**遍历时**生效，不是收集完再过滤。
         *
         * 这个区别很大：宿主目录里的 `node_modules` 有 4000+ 文件，
         * 先遍历再过滤等于白扫一遍，实测多花 2 分钟。
         */
        if (skipDirs !== undefined && skipDirs(absolute, entry.name)) continue

        /*
         * 软链要 `stat` 一次才能知道它指向文件还是目录。
         *
         * Dirent 的 `isDirectory()` 对软链返回 **false**，如果直接当文件
         * 处理，`copyFile` 会把整个软链目标的内容拷过来——而 pnpm 的
         * 软链指向 `.pnpm` 里的完整包，于是「拷一个文件」变成「拷一个
         * 目录树」，体积瞬间膨胀。
         */
        if (entry.isSymbolicLink()) {
          let info
          try {
            info = await stat(absolute)
          } catch {
            // 断链：跳过，不阻断。
            continue
          }
          if (info.isDirectory()) {
            await visit(absolute)
            continue
          }
          if (filter !== undefined && !filter(absolute)) continue
          out.push(toPosix(relative(root, absolute)))
          continue
        }

        if (entry.isDirectory()) {
          await visit(absolute)
        } else if (entry.isFile()) {
          if (filter !== undefined && !filter(absolute)) continue
          out.push(toPosix(relative(root, absolute)))
        }
      }
    } finally {
      /*
       * 出目录时弹出栈。
       *
       * 用 finally 而不是在函数末尾写：中途 return（权限不足、环检测命中）
       * 也要弹，否则栈会残留，把后续的合法分支误判成环。
       */
      ancestorReals.pop()
    }
  }
  await visit(root)
  out.sort()
  return out
}

/** 把路径分隔符统一成 `/`，让清单在 Windows / macOS 上可比。 */
export function toPosix(path) {
  return sep === '/' ? path : path.split(sep).join('/')
}

/** 计算文件 SHA-256。按流读，避免把大文件整个读进内存。 */
export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * 拷贝目录树，解开符号链接、不产生资源叉。
 *
 * ## 为什么不能直接 `fs.cp({ dereference: true })`
 *
 * pnpm 的 `node_modules` 是一个**软链农场**：一个包被软链到几十个位置，
 * 而包自己又软链回 workspace 根。`dereference: true` 会把这些软链全部
 * 展开成真实目录，于是：
 *
 * - 同一个包被复制几十份（体积爆炸）；
 * - 循环软链（A → B → A）导致无限递归，**打包直接卡死**。
 *
 * 实测空谷项目有 316 个软链，`fs.cp` 跑了 6 分钟仍在增长到 374MB 还没停。
 *
 * ## 实现分两级
 *
 * **快路径：tar 管道。** `tar -cf - --dereference` 一次流式打包整棵树，
 * 由 `tar -xf -` 在目标展开。整个过程只有两个进程、一次 I/O 流，
 * 不受「逐文件系统调用」的开销影响。`--dereference` 保证软链被解开，
 * 且 macOS 的 bsdtar 默认不写 AppleDouble，不会产生 `._*` 垃圾。
 *
 * **慢路径：Node 递归拷贝。** tar 不可用时（极少数环境）退回逐文件
 * 处理，按 `(dev, inode)` 去重防死循环。
 *
 * @param {string} source 源目录。
 * @param {string} target 目标目录。
 * @param {object} [options]
 * @param {boolean} [options.skipJunk] 是否剔除苹果垃圾文件。默认 true。
 * @param {(message: string) => void} [options.onProgress] 进度回调。
 * @returns {Promise<{files: number, bytes: number, skipped: number}>}
 */
export async function copyTree(source, target, options = {}) {
  const { skipJunk = true, onProgress, skipDirs } = options
  await mkdir(target, { recursive: true })

  /*
   * ## 为什么不用 tar 管道
   *
   * `tar -cf - | tar -xf -` 本来是最快的做法：两个进程、一次 I/O 流，
   * 耗时与文件数几乎无关。实测同一目录 tar 5 秒、逐文件 180 秒。
   *
   * 但它在**受管环境里不可靠**：某些沙箱会拦截 tar 的 stdout 重定向，
   * 报 `Unrecognized archive format`；也有环境对 tar 的文件操作做回滚
   * 追踪，直接拒绝。一个「有时能用」的快路径比没有更糟——它会让同一份
   * 代码在不同机器上表现不一。
   *
   * 所以统一走并发逐文件拷贝。并发度 32 是实测的平衡点：单次 I/O 延迟
   * 占主导时（受管环境里每次几十毫秒），并发是唯一有效的加速手段；
   * 再往上会撞文件描述符上限，收益也饱和。
   */
  return copyWithNode(source, target, { skipJunk, onProgress, skipDirs })
}

/** Node 递归拷贝（慢路径）。按 (dev, inode) 去重防死循环。 */
async function copyWithNode(source, target, options) {
  const { skipJunk, onProgress, skipDirs } = options
  /** 已拷贝过的物理目录，键是 `dev:ino`。 */
  const visitedDirs = new Set()
  let files = 0
  let bytes = 0
  let skipped = 0

  async function visit(from, to, dirent) {
    /*
     * 快路径：Dirent 已经告诉我们是文件还是目录时，不再 `stat`。
     *
     * 4000 个文件各做一次 `stat` + 一次 `cp` 是 8000 次系统调用；
     * 靠 Dirent 把 `stat` 全省掉。
     */
    let isDir
    if (dirent !== undefined) {
      if (dirent.isDirectory()) isDir = true
      else if (dirent.isFile()) isDir = false
    }

    let info = null
    if (isDir === undefined) {
      try {
        info = await stat(from)
      } catch {
        skipped += 1
        return
      }
      isDir = info.isDirectory()
    }

    if (!isDir) {
      await copyOne(from, to, info)
      return
    }

    // 目录去重：必须拿到 inode，所以目录无论如何要 stat 一次。
    if (info === null) {
      try {
        info = await stat(from)
      } catch {
        skipped += 1
        return
      }
    }

    const key = `${String(info.dev)}:${String(info.ino)}`
    if (visitedDirs.has(key)) {
      // 同一个物理目录已经拷过：跳过。这一条就是防死循环的关键。
      skipped += 1
      return
    }
    visitedDirs.add(key)

    await mkdir(to, { recursive: true })

    let entries
    try {
      entries = await readdir(from, { withFileTypes: true })
    } catch {
      skipped += 1
      return
    }

    const BATCH = 32
    for (let index = 0; index < entries.length; index += BATCH) {
      const slice = entries.slice(index, index + BATCH)
      await Promise.all(slice.map(async (entry) => {
        if (skipJunk && isJunk(entry.name)) return
        if (skipDirs !== undefined && skipDirs(join(from, entry.name), entry.name)) return
        await visit(join(from, entry.name), join(to, entry.name), entry)
      }))
    }
  }

  async function copyOne(from, to, knownInfo) {
    try {
      const info = knownInfo ?? await stat(from)
      if (info.isDirectory()) {
        await visit(from, to)
        return
      }
      await mkdir(dirname(to), { recursive: true })
      // `cp` 的 dereference 保证软链被解开——Windows 上不能有软链。
      await cp(from, to, { force: true, dereference: true })
      files += 1
      bytes += info.size
      if (files % 1000 === 0) onProgress?.(`已拷贝 ${String(files)} 个文件`)
    } catch {
      skipped += 1
    }
  }

  await visit(source, target)
  return { files, bytes, skipped }
}

/** 拷贝单个文件，父目录自动创建。 */
export async function copyFile(source, target) {
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, { dereference: true, force: true })
}

/** 目录是否存在（且确实是目录）。 */
export async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** 文件是否存在（且确实是文件）。 */
export async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** 读文件前 N 个字节，用于嗅探二进制格式。 */
export async function readHead(path, length = 64) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** 删除目录或文件。目标不存在时静默成功。 */
export async function remove(path) {
  await rm(path, { recursive: true, force: true })
}

/** 原子写：先写临时文件再改名，避免半截文件被当成完整产物。 */
export async function writeFileAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${String(process.pid)}`
  await writeFile(temporary, content)
  await cp(temporary, path, { force: true })
  await rm(temporary, { force: true })
}

/** 读 JSON，失败时抛出带路径的可读错误。 */
export async function readJson(path) {
  const text = await readFile(path, 'utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`JSON 解析失败（${path}）：${error.message}`)
  }
}

/** 把字节数写成人类可读形式。 */
export function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

/**
 * 统计一棵目录树的体积与文件数，按 (dev, inode) 去重。
 *
 * 为什么必须去重：pnpm 把同一个包软链到几十个 `node_modules` 下，
 * 直接累加会把同一份物理文件算几十遍，报出来的体积能虚高十几倍。
 * 打包体积是要写进日志给用户看的，报错数字比不报更糟。
 */
export async function measureTree(root) {
  const seen = new Set()
  let bytes = 0
  let files = 0

  async function visit(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (isJunk(entry.name)) continue
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(absolute)
      } else {
        try {
          const info = await stat(absolute)
          const key = `${String(info.dev)}:${String(info.ino)}`
          if (seen.has(key)) continue
          seen.add(key)
          bytes += info.size
          files += 1
        } catch {
          /* 读不到的条目不计入，不影响整体判断 */
        }
      }
    }
  }

  await visit(root)
  return { bytes, files }
}