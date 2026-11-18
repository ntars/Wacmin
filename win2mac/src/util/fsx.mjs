/**
 * 文件系统工具。
 *
 * ## 为什么 win2mac 自带一份而不复用 mac2win 的
 *
 * mac2win 的 `util/fsx.mjs` 有 389 行，包含 Windows 打包场景专用的逻辑
 * （PE 资源处理、NSIS 暂存路径等）。win2mac 只需要其中很小一部分，
 * 跨目录 import 会让两个方向在重构时互相牵制。
 *
 * 唯一的例外是 `crc32`：那是纯算法，没有场景耦合，直接从 mac2win 借用。
 *
 * ## 跨平台注意
 *
 * Win2Mac 设计上跑在 Windows，但开发者可能在 macOS 上测试。所以：
 *
 *   - 路径拼接一律用 `node:path`，不手写分隔符
 *   - 写进 zip 的路径统一转正斜杠（`toPosix`）
 *   - 不用 `chmod`（Windows 上没有意义），权限靠打包阶段处理
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile as fsCopyFile, mkdir, readdir, stat, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

/** 打包时该跳过的垃圾文件名。 */
const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])
const JUNK_PREFIXES = ['._', '~$']
const JUNK_DIRS = new Set(['__MACOSX', '.git', 'node_modules/.cache'])

/**
 * 判断一个文件名是否是垃圾。
 * @param {string} name 单段文件名（不含路径）。
 */
export function isJunk(name) {
  if (JUNK_NAMES.has(name)) return true
  return JUNK_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * 递归列出目录下的所有文件（相对路径，正斜杠）。
 *
 * @param {string} root
 * @param {object} [options]
 * @param {boolean} [options.skipJunk] 是否跳过垃圾文件，默认 true。
 * @param {string[]} [options.exclude] 额外排除的目录名。
 * @param {string[]} [options.excludePaths] 额外排除的**绝对路径**（整棵子树）。
 *   用于「输出目录恰好位于输入目录内」的场景，见下面的说明。
 * @returns {Promise<string[]>}
 */
export async function walkFiles(root, options = {}) {
  const skipJunk = options.skipJunk ?? true
  const exclude = new Set(options.exclude ?? [])
  const excludePaths = new Set((options.excludePaths ?? []).map((path) => resolve(path)))
  const out = []
  const queue = ['']

  while (queue.length > 0) {
    const relative = queue.shift()
    const absolute = relative === '' ? root : join(root, relative)

    /*
     * 整棵子树跳过。
     *
     * ## 为什么必须有这一层
     *
     * win2mac 的默认输出目录是 `<项目>/dist-win2mac`，而默认载荷是
     * **整个项目**。于是第二次构建会把第一次的产物当作载荷再打一遍：
     *
     *   proj (Mac).app/Contents/Resources/app/dist-win2mac/proj (Mac).app/...
     *
     * 产物每构建一次就翻一倍，而且内层那个 .app 的可执行权限在复制中
     * 丢失，最终 verify 报 `zip.executable_modes` 失败 —— 用户看到的
     * 是「权限不足」，实际根因是自我嵌套。这个错误信息毫无指向性。
     *
     * 名字级 exclude 不够用：这里的判断必须按**绝对路径**比较，因为
     * 用户完全可能用 `--out` 指到项目里任意一层。
     */
    if (excludePaths.has(resolve(absolute))) continue

    let children
    try {
      children = await readdir(absolute, { withFileTypes: true })
    } catch {
      continue
    }

    for (const child of children) {
      if (skipJunk && isJunk(child.name)) continue
      if (exclude.has(child.name)) continue
      if (JUNK_DIRS.has(child.name)) continue

      const childRelative = relative === '' ? child.name : `${relative}/${child.name}`
      if (child.isDirectory() && !child.isSymbolicLink()) {
        queue.push(childRelative)
      } else if (child.isFile()) {
        out.push(childRelative)
      }
      // 符号链接在 zip 阶段单独处理，这里不列
    }
  }
  return out.sort()
}

/**
 * 把路径分隔符统一成正斜杠。
 * @param {string} path
 */
export function toPosix(path) {
  return path.split(sep).join('/')
}

/**
 * 算文件 SHA-256。
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => { hash.update(chunk) })
    stream.on('end', () => { resolve(hash.digest('hex')) })
  })
}

/**
 * 递归复制目录。
 *
 * 与 `fs.cp` 的区别：这里会跳过垃圾文件，并统计文件数与字节数，
 * 供报告的 artifacts 使用。
 *
 * @param {string} source
 * @param {string} target
 * @param {object} [options]
 * @returns {Promise<{files: number, bytes: number}>}
 */
export async function copyTree(source, target, options = {}) {
  const files = await walkFiles(source, options)
  let bytes = 0

  for (const relative of files) {
    const from = join(source, relative)
    const to = join(target, relative)
    await mkdir(dirname(to), { recursive: true })
    await fsCopyFile(from, to)
    try {
      bytes += (await stat(to)).size
    } catch {
      // 统计失败不影响复制本身
    }
  }
  return { files: files.length, bytes }
}

/** 判断路径是否是目录。 */
export async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** 判断路径是否是文件。 */
export async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** 读 JSON，失败返回 null。 */
export async function readJson(path) {
  try {
    const { readFile } = await import('node:fs/promises')
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/** 原子写文件：先写临时文件再改名，避免中断留下半个文件。 */
export async function writeFileAtomic(path, content) {
  const temp = `${path}.tmp-${String(process.pid)}`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temp, content)
  const { rename } = await import('node:fs/promises')
  await rename(temp, path)
}

/** 删除路径（文件或目录），不存在不报错。 */
export async function remove(path) {
  await rm(path, { recursive: true, force: true })
}

/**
 * 人类可读的字节数。
 * @param {number} bytes
 */
export function humanBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return index === 0
    ? `${String(Math.round(value))} B`
    : `${value.toFixed(1)} ${units[index]}`
}

/**
 * 统计目录的文件数与总字节数。
 * @param {string} root
 * @param {object} [options] 透传给 {@link walkFiles}（如 excludePaths）。
 * @returns {Promise<{files: number, bytes: number}>}
 */
export async function measureTree(root, options = {}) {
  const files = await walkFiles(root, options)
  let bytes = 0
  for (const relative of files) {
    try {
      bytes += (await stat(join(root, relative))).size
    } catch {
      // 忽略统计失败
    }
  }
  return { files: files.length, bytes }
}
