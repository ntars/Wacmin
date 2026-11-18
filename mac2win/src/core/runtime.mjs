/**
 * Windows x86 Node 运行时管理。
 *
 * ## 为什么必须自带运行时
 *
 * 目标机器上不保证装了 Node，装了的版本也未必对（可能是 x64、可能太旧）。
 * 依赖用户的 Node 等于把「能不能启动」交给运气。所以安装包里必须有一份
 * **确定的、x86 的、版本已知的** node.exe。
 *
 * ## 为什么从官方下载而不是用本机那份
 *
 * 本机是 arm64 macOS，`process.execPath` 是 Mach-O 文件，Windows 根本
 * 不认。必须拿 Node 官方发布的 `win-x86` 构建。
 *
 * ## 校验和不是可选项
 *
 * 下载来的二进制要装进别人的安装包、在别人的机器上以用户权限执行。
 * 一个字节被替换就是一次供应链投毒。所以：
 * 1. 从官方 `SHASUMS256.txt` 取期望值（不硬编码在代码里，硬编码会过期）；
 * 2. 下载后本地算 SHA-256 比对；
 * 3. 解包后再验一次 PE 头，确认是 i386。
 * 三道都过了才算拿到可用的运行时。
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { BuildError, ErrorCode } from './errors.mjs'
import { isFile, remove, sha256File } from '../util/fsx.mjs'
import { checkWindowsExe } from '../verify/pe.mjs'
import { unzipFile } from './zip.mjs'

/** 官方分发地址。镜像通过环境变量覆盖，供网络受限时使用。 */
const DEFAULT_BASE = 'https://nodejs.org/dist'

/**
 * 镜像列表。国内直连 nodejs.org 常常只有几十 KB/s，
 * 33MB 的包要下十几分钟。npmmirror 有同构的目录结构。
 *
 * 顺序即优先级：先官方（校验和也一起取，来源一致），失败再退镜像。
 * 注意镜像的 SHASUMS 可能与官方不同步，所以**校验和一律以官方为准**，
 * 镜像只用来加速下载本体。
 */
const MIRRORS = ['https://registry.npmmirror.com/-/binary/node']

/**
 * 缓存根目录。放用户主目录下，跨项目复用，不必每次重下。
 *
 * 统一收在 `~/.wacmin/` 下，四个方向各占一个子目录，
 * 免得每个方向都在主目录里开一个点目录。
 */
export function cacheRoot() {
  return process.env.MAC2WIN_CACHE ?? join(homedir(), '.wacmin', 'mac2win', 'cache')
}

/**
 * 平台标识。
 *
 * Node 官方把 32 位 Windows 叫 `win-x86`（不是 `win32-ia32`，那是
 * Electron 的叫法），64 位叫 `win-x64`。两套命名不能混用，
 * 混了就是下载 404。
 */
function platformTag(target) {
  if (target === 'x86') return 'win-x86'
  if (target === 'x64') return 'win-x64'
  throw new Error(`Node 运行时没有 ${String(target)} 的 Windows 构建`)
}

/**
 * 某个 Node 版本 + 架构的缓存目录。
 *
 * 必须按架构分开：x86 与 x64 的 node.exe 是两个不同的文件，
 * 放同一个目录会互相覆盖，然后得到「标称 x64 实际 x86」的产物。
 */
export function runtimeCacheDir(version, target = 'x86') {
  return join(cacheRoot(), `node-${version}-${platformTag(target)}`)
}

/**
 * 取官方校验和表。
 *
 * @param {string} version 形如 `22.23.5`。
 * @param {object} [options]
 * @param {(message: string) => void} [options.onProgress]
 * @returns {Promise<Map<string, string>>} 文件名 → SHA-256。
 */
export async function fetchChecksums(version, options = {}) {
  const { onProgress } = options
  const base = process.env.MAC2WIN_NODE_BASE ?? DEFAULT_BASE
  const url = `${base}/v${version}/SHASUMS256.txt`

  onProgress?.(`读取官方校验和 ${url}`)

  let text
  try {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    text = await response.text()
  } catch (error) {
    throw new BuildError(ErrorCode.RUNTIME_DOWNLOAD_FAILED, `读不到官方校验和表：${url}`, {
      details: [error.message],
      hint: '检查网络连通性；离线环境可用 runtime.archive 直接指定本地的 node.exe',
    })
  }

  const map = new Map()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const [hash, name] = trimmed.split(/\s+/)
    if (hash !== undefined && name !== undefined) map.set(name, hash)
  }
  return map
}

/** 下载一个 URL 到本地文件，带进度回调。 */
async function download(url, target, options = {}) {
  const { onProgress, timeoutMs = 120_000 } = options
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)

  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    const total = Number(response.headers.get('content-length') ?? 0)

    await mkdir(join(target, '..'), { recursive: true })
    const stream = createWriteStream(target)
    let received = 0
    let lastReport = 0

    const body = response.body
    if (body === null) throw new Error('响应没有内容')

    for await (const chunk of body) {
      received += chunk.length
      if (!stream.write(chunk)) await new Promise((resolve) => stream.once('drain', resolve))
      // 每 2MB 报一次进度：太密会把日志刷爆，太疏看不出在动。
      if (received - lastReport > 2 * 1024 * 1024) {
        lastReport = received
        const percent = total > 0 ? ((received / total) * 100).toFixed(0) : '?'
        onProgress?.(`下载中 ${(received / 1024 / 1024).toFixed(1)}MB${total > 0 ? ` / ${(total / 1024 / 1024).toFixed(1)}MB（${percent}%）` : ''}`)
      }
    }
    await new Promise((resolve, reject) => {
      stream.end(() => { resolve() })
      stream.on('error', reject)
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 去掉解包结果里多余的一层顶层目录。
 *
 * Node 官方的 zip 内部统一是 `node-v22.23.5-win-x86/` 这一层前缀。
 * 留着它会让 `node.exe` 落在 `…/node-v22.23.5-win-x86/node.exe`，
 * 而启动器按契约找的是 `app/node.exe`。与其在启动器里加一层猜路径的
 * 逻辑，不如在这里把它摊平——目录契约只能有一个真源。
 *
 * 判定方式：目录下只有一个子目录且没有文件，就把那一层提上来。
 *
 * @param {string} dir 解包目标目录。
 */
async function flattenSingleRoot(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = entries.filter((entry) => !entry.isDirectory())
  const dirs = entries.filter((entry) => entry.isDirectory())
  if (files.length > 0 || dirs.length !== 1) return

  const inner = join(dir, dirs[0].name)
  const innerEntries = await readdir(inner)
  for (const name of innerEntries) {
    await rename(join(inner, name), join(dir, name))
  }
  await rm(inner, { recursive: true, force: true })
}

/**
 * 确保有一个可用的 Windows x86 Node 运行时。
 *
 * 优先用缓存；缓存不存在才下载。返回 node.exe 的绝对路径。
 *
 * @param {object} input
 * @param {string} input.version 需要的 Node 版本，形如 `22.23.5`。
 * @param {string} [input.archive] 本地 node.exe 或 zip 路径，给离线环境用。
 * @param {string} [input.checksum] 与 archive 配套的期望 SHA-256。
 * @param {(message: string) => void} [input.onProgress]
 * @returns {Promise<{nodePath: string, version: string, sha256: string, fromCache: boolean}>}
 */
export async function ensureRuntime(input) {
  const { version, archive, checksum, onProgress, target = 'x86' } = input
  const targetDir = runtimeCacheDir(version, target)
  const nodePath = join(targetDir, 'node.exe')

  // --- 1. 用户指定了本地文件：验架构与校验和，直接收下 ---
  if (archive !== undefined && archive !== null) {
    if (!(await isFile(archive))) {
      throw new BuildError(ErrorCode.RUNTIME_DOWNLOAD_FAILED, `指定的运行时文件不存在：${archive}`, {
        hint: 'runtime.archive 要指向本地的 node.exe 或 node 的 win-x86 zip',
      })
    }
    const actual = await sha256File(archive)
    if (checksum !== undefined && checksum !== null && checksum !== '' && actual !== checksum.toLowerCase()) {
      throw new BuildError(ErrorCode.RUNTIME_CHECKSUM_MISMATCH, '指定的运行时校验和不匹配', {
        details: [`期望 ${checksum}`, `实际 ${actual}`],
        hint: '确认文件没被替换或损坏；去掉 runtime.checksum 可跳过这一步（不推荐）',
      })
    }
    await remove(targetDir)
    if (archive.toLowerCase().endsWith('.zip')) {
      onProgress?.(`解包本地运行时 ${archive}`)
      await unzipFile(archive, targetDir)
    } else {
      await mkdir(targetDir, { recursive: true })
      await pipeline(createReadStream(archive), createWriteStream(nodePath))
    }
    await assertTargetArch(nodePath, target)
    return { nodePath, version, sha256: await sha256File(nodePath), fromCache: false }
  }

  // --- 2. 缓存命中：仍然验一次架构，防止上一次下载被写坏 ---
  if (await isFile(nodePath)) {
    try {
      await assertTargetArch(nodePath, target)
      onProgress?.(`复用缓存运行时 ${targetDir}`)
      return { nodePath, version, sha256: await sha256File(nodePath), fromCache: true }
    } catch {
      // 缓存坏了就丢掉重下，而不是直接失败——用户没做错任何事。
      onProgress?.('缓存里的运行时不可用，重新下载')
      await remove(targetDir)
    }
  }

  // --- 3. 下载 ---
  const zipName = `node-v${version}-${platformTag(target)}.zip`
  const checksums = await fetchChecksums(version, { onProgress })
  const expected = checksums.get(zipName)
  if (expected === undefined) {
    throw new BuildError(ErrorCode.RUNTIME_DOWNLOAD_FAILED, `官方校验和表里没有 ${zipName}`, {
      details: [`该版本可能没有 Windows ${target} 构建：${version}`],
      hint: target === 'x86'
        ? 'Node 从 23 起不再发布 win-x86。请用 22.x 的版本，例如 22.23.5'
        : '检查 runtimeVersion 是否拼写正确',
    })
  }

  const tempZip = join(cacheRoot(), zipName)
  await mkdir(cacheRoot(), { recursive: true })

  const base = process.env.MAC2WIN_NODE_BASE ?? DEFAULT_BASE
  const sources = [`${base}/v${version}/${zipName}`, ...MIRRORS.map((mirror) => `${mirror}/v${version}/${zipName}`)]

  let lastError
  let downloaded = false
  for (const url of sources) {
    try {
      onProgress?.(`下载运行时 ${url}`)
      await download(url, tempZip, { onProgress })
      const actual = await sha256File(tempZip)
      if (actual !== expected) {
        // 镜像可能给了不同步的文件，换下一个源，而不是直接判死。
        throw new Error(`校验和不匹配（期望 ${expected.slice(0, 16)}…，实际 ${actual.slice(0, 16)}…）`)
      }
      downloaded = true
      break
    } catch (error) {
      lastError = error
      onProgress?.(`该源不可用，换下一个：${error.message}`)
      await remove(tempZip)
    }
  }

  if (!downloaded) {
    throw new BuildError(ErrorCode.RUNTIME_DOWNLOAD_FAILED, '所有下载源都失败了', {
      details: [lastError instanceof Error ? lastError.message : String(lastError)],
      hint: '网络受限时可在配置里写 runtime.archive 指向本地 node 的 win-x86 zip，并配上 runtime.checksum',
    })
  }

  onProgress?.('校验通过，解包运行时')
  await remove(targetDir)
  await unzipFile(tempZip, targetDir)
  await flattenSingleRoot(targetDir)
  await remove(tempZip)

  await assertTargetArch(nodePath, target)
  const sha256 = await sha256File(nodePath)
  onProgress?.(`运行时就绪 ${nodePath}`)
  return { nodePath, version, sha256, fromCache: false }
}

/**
 * 断言 node.exe 的架构与目标一致。
 *
 * 这是最后一道闸：即使校验和对了，也不排除下载源本身给错了架构
 * （比如把 x64 的包改名成 x86）。PE 头是唯一可信的判据。
 *
 * ## 为什么必须按目标校验而不是一律要求 i386
 *
 * 早期实现写死「必须是 i386」，于是 `--target x64` 会：
 * 1. 下载 win-x86 的包（因为文件名写死）；
 * 2. 断言通过（确实是 i386）；
 * 3. 产出标称 x64、实际 32 位的包，**而且校验盖章通过**。
 *
 * 那是最坏的一类缺陷：用户以为拿到 64 位，实际是 32 位，
 * 而所有检查都说没问题。
 */
async function assertTargetArch(nodePath, target) {
  if (!(await isFile(nodePath))) {
    throw new BuildError(ErrorCode.RUNTIME_WRONG_ARCH, `运行时文件不存在：${nodePath}`)
  }

  const expected = target === 'x64' ? 'x86-64' : 'i386'
  const result = await checkWindowsExe(nodePath, { gui: false })
  const header = result.header

  if (header === null) {
    throw new BuildError(ErrorCode.RUNTIME_WRONG_ARCH, '运行时不是合法的 Windows 可执行文件', {
      details: result.problems,
      hint: '删掉缓存目录后重试：rm -rf ~/.wacmin/mac2win/cache',
    })
  }

  if (header.machineName !== expected) {
    throw new BuildError(
      ErrorCode.RUNTIME_WRONG_ARCH,
      `运行时架构是 ${header.machineName}，目标 ${target} 需要 ${expected}`,
      {
        details: [`文件：${nodePath}`],
        hint: '检查 runtimeVersion 与 target 是否匹配；删掉缓存目录后重试可强制重新下载',
      },
    )
  }

  return header
}

/** 计算一个文件的 SHA-256 摘要，供清单使用。 */
export async function digestFile(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** 目录体积（字节）。 */
export async function directorySize(path) {
  try {
    const info = await stat(path)
    return info.size
  } catch {
    return 0
  }
}