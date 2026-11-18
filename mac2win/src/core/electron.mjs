/**
 * Electron 运行时的下载与重打包。
 *
 * ## 为什么这条路在 arm64 mac 上成立
 *
 * Electron 的 Windows 发行包是**预编译好的完整运行时**（含 Chromium、
 * V8、Node、以及 electron.exe 本身）。它在官方 CI 上就已经按
 * `win32-ia32` 编好了，下载下来就能用——不需要任何交叉编译工具链。
 *
 * 所谓「打包」就是三步：
 * 1. 解开官方的 `electron-vX.Y.Z-win32-ia32.zip`；
 * 2. 把用户的项目文件放进 `resources/app/`；
 * 3. 把 `electron.exe` 改名成产品名（可选，但用户看到进程名才像自己的应用）。
 *
 * 这三步在 mac 上都能做，产出的就是真正的 32 位 Windows 程序。
 *
 * ## ia32 的版本边界
 *
 * Electron **从 v44 起不再发布 win32-ia32**。这不是推测：官方 release
 * 资产列表里 `electron-v44.0.0-win32-ia32.zip` 返回 404，而 v43.0.0
 * 返回 206。所以打 x86 必须用 ≤43.x。
 */

import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { BuildError, ErrorCode } from './errors.mjs'
import { cacheRoot } from './runtime.mjs'
import { copyFile, copyTree, isDirectory, isFile, sha256File, walkFiles } from '../util/fsx.mjs'
import { checkWindowsExe } from '../verify/pe.mjs'
import { unzipFile } from './zip.mjs'

/** Electron 官方下载源。镜像可用环境变量覆盖。 */
const ELECTRON_MIRRORS = [
  'https://github.com/electron/electron/releases/download',
  'https://npmmirror.com/mirrors/electron',
]

/** 平台标识映射。Electron 的资产名用 `win32` 而不是 `win`。 */
function platformTag(target) {
  return target === 'x86' ? 'win32-ia32' : `win32-${target}`
}

/** 缓存目录。 */
export function electronCacheDir(version, target) {
  return join(cacheRoot(), `electron-${version}-${platformTag(target)}`)
}

/**
 * 确保 Electron 运行时可用。
 *
 * @param {object} input
 * @param {string} input.version Electron 版本，形如 `43.0.0`。
 * @param {string} input.target 目标架构（`x86` / `x64` / `arm64`）。
 * @param {string} [input.archive] 本地 zip，供离线环境。
 * @param {(message: string) => void} [input.onProgress]
 * @returns {Promise<{dir: string, exeName: string, version: string, fromCache: boolean}>}
 */
export async function ensureElectron(input) {
  const { version, target, archive, onProgress } = input

  if (target === 'x86') {
    const major = Number.parseInt(String(version).split('.')[0], 10)
    if (Number.isFinite(major) && major >= 44) {
      throw new BuildError(ErrorCode.RUNTIME_WRONG_ARCH, `Electron ${version} 没有 win32-ia32 构建`, {
        details: ['Electron 从 v44 起移除了 32 位 Windows 支持'],
        hint: '把 electronVersion 改成 43.x，或把 target 改成 x64',
      })
    }
  }

  const tag = platformTag(target)
  const dir = electronCacheDir(version, target)
  const exeName = 'electron.exe'
  const exePath = join(dir, exeName)

  // --- 缓存命中 ---
  if (await isFile(exePath)) {
    try {
      await checkWindowsExe(exePath, { gui: false })
      onProgress?.(`复用缓存 Electron ${version}（${tag}）`)
      return { dir, exeName, version, fromCache: true }
    } catch {
      onProgress?.('缓存的 Electron 不可用，重新下载')
      await rm(dir, { recursive: true, force: true })
    }
  }

  const zipName = `electron-v${version}-${tag}.zip`
  const zipPath = join(cacheRoot(), zipName)
  await mkdir(cacheRoot(), { recursive: true })

  // --- 本地文件 ---
  if (archive !== undefined && archive !== null) {
    if (!(await isFile(archive))) {
      throw new BuildError(ErrorCode.RUNTIME_DOWNLOAD_FAILED, `指定的 Electron 包不存在：${archive}`)
    }
    onProgress?.(`解包本地 Electron ${archive}`)
    await unzipTo(archive, dir)
    await assertElectron(exePath, target)
    return { dir, exeName, version, fromCache: false }
  }

  // --- 下载 ---
  let lastError
  let ok = false
  for (const mirror of ELECTRON_MIRRORS) {
    const url = `${mirror}/v${version}/${zipName}`
    try {
      onProgress?.(`下载 Electron ${url}`)
      await downloadWithProgress(url, zipPath, onProgress)
      ok = true
      break
    } catch (error) {
      lastError = error
      onProgress?.(`该源不可用：${error.message}`)
      await rm(zipPath, { force: true })
    }
  }

  if (!ok) {
    throw new BuildError(ErrorCode.RUNTIME_DOWNLOAD_FAILED, 'Electron 运行时下载失败', {
      details: [lastError instanceof Error ? lastError.message : String(lastError)],
      hint: `可手动下载 ${zipName} 后用 electronArchive 指定本地路径`,
    })
  }

  onProgress?.('解包 Electron')
  await rm(dir, { recursive: true, force: true })
  await unzipTo(zipPath, dir)
  await rm(zipPath, { force: true })

  await assertElectron(exePath, target)
  return { dir, exeName, version, fromCache: false }
}

/** 断言 Electron 主程序架构正确。 */
async function assertElectron(exePath, target) {
  if (!(await isFile(exePath))) {
    throw new BuildError(ErrorCode.RUNTIME_WRONG_ARCH, `Electron 包不完整：找不到 ${exePath}`)
  }
  const result = await checkWindowsExe(exePath, { gui: false })
  const header = result.header
  if (header === null) {
    throw new BuildError(ErrorCode.RUNTIME_WRONG_ARCH, 'Electron 主程序不是合法的 Windows 可执行文件', {
      details: result.problems,
    })
  }
  const expected = target === 'x86' ? 'i386' : target === 'x64' ? 'x86-64' : 'ARM64'
  if (header.machineName !== expected) {
    throw new BuildError(
      ErrorCode.RUNTIME_WRONG_ARCH,
      `Electron 主程序架构是 ${header.machineName}，期望 ${expected}`,
      { hint: '检查 electronVersion 与 target 是否匹配' },
    )
  }
}

/** 下载并报进度。 */
async function downloadWithProgress(url, target, onProgress) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const total = Number(response.headers.get('content-length') ?? 0)
  const body = response.body
  if (body === null) throw new Error('响应没有内容')

  await mkdir(join(target, '..'), { recursive: true })
  const stream = createWriteStream(target)
  let received = 0
  let lastReport = 0

  for await (const chunk of body) {
    received += chunk.length
    if (!stream.write(chunk)) await new Promise((resolve) => stream.once('drain', resolve))
    if (received - lastReport > 4 * 1024 * 1024) {
      lastReport = received
      const percent = total > 0 ? ((received / total) * 100).toFixed(0) : '?'
      onProgress?.(`下载中 ${(received / 1024 / 1024).toFixed(1)}MB / ${(total / 1024 / 1024).toFixed(1)}MB（${percent}%）`)
    }
  }
  await new Promise((resolve, reject) => {
    stream.end(() => { resolve() })
    stream.on('error', reject)
  })
}

/**
 * 解 zip 到目录。
 *
 * 复用 runtime.mjs 里的 zip 解析逻辑。这里单独 import 是为了避免
 * 两个模块互相引用（runtime 也 import 了 fsx）。
 */
async function unzipTo(zipPath, targetDir) {
  await unzipFile(zipPath, targetDir)
}

/**
 * 把用户项目重打包成 Electron 应用。
 *
 * ## 目录结构
 *
 * ```
 * app/
 *   node.exe               ← 启动器用的 Node 运行时
 *   bootstrap/             ← 启动器
 *   electron/              ← Electron 运行时（含 electron.exe 改名后的主程序）
 *     <产品名>.exe
 *     resources/app/       ← 用户项目
 *   ui/                    ← 前端产物（如果和 app 分开）
 * ```
 *
 * ## 为什么主程序要改名
 *
 * 任务管理器里显示 `electron.exe` 会让用户以为装了个开发工具。
 * 改名成产品名是 Electron 生态的通行做法（electron-builder 也这么做）。
 * 改名后 Electron 内部靠 `process.execPath` 找资源，改名不影响它。
 *
 * @param {object} input
 * @param {string} input.electronDir Electron 运行时目录。
 * @param {string} input.projectRoot 项目根目录。
 * @param {string} input.target 暂存区的 `app/` 目录。
 * @param {string} input.productName 产品名（用于主程序改名）。
 * @param {string[]} [input.exclude] 不该进包的文件/目录名。
 * @param {(message: string) => void} [input.onProgress]
 * @returns {Promise<{exeName: string, appFiles: number}>}
 */
export async function repackElectron(input) {
  const { electronDir, projectRoot, target, productName, exclude = [], onProgress } = input

  const electronTarget = join(target, 'electron')
  onProgress?.('拷贝 Electron 运行时')
  await copyTree(electronDir, electronTarget)

  // 主程序改名。先删掉旧名再拷，避免同目录下两个 exe。
  const originalExe = join(electronTarget, 'electron.exe')
  const safeName = String(productName).replace(/[\\/:*?"<>|]/g, '').trim() || 'app'
  const renamedExe = join(electronTarget, `${safeName}.exe`)

  if (safeName !== 'electron' && await isFile(originalExe)) {
    await rename(originalExe, renamedExe)
  }

  /*
   * 把项目放进 resources/app/。
   *
   * Electron 会自动加载 `resources/app/package.json` 的 `main`。
   * 用目录形态而不是 asar 打包：asar 需要一个额外的打包器
   * （@electron/asar），而目录形态 Electron 原生支持，少一个依赖
   * 就少一处失败可能。体积上 asar 也没有优势（只是归档不是压缩）。
   */
  const appDir = join(electronTarget, 'resources', 'app')
  await mkdir(appDir, { recursive: true })

  const skipped = new Set([
    'node_modules/.cache',
    '.git',
    '.github',
    'src-tauri',
    'dist-mac2win',
    ...exclude,
  ])

  const files = await walkFiles(projectRoot, {
    filter: (absolute) => {
      const relative = absolute.slice(projectRoot.length + 1)
      for (const pattern of skipped) {
        if (relative === pattern || relative.startsWith(`${pattern}/`)) return false
      }
      return true
    },
  })

  let copied = 0
  for (const relative of files) {
    await copyFile(join(projectRoot, relative), join(appDir, relative))
    copied += 1
    if (copied % 200 === 0) onProgress?.(`拷贝项目文件 ${String(copied)} / ${String(files.length)}`)
  }

  /*
   * Electron 需要 package.json 的 `main` 指向入口。
   * 如果原项目的 main 指向 TypeScript 或不存在，Electron 会直接报错退出。
   * 这里只做一件事：确保 package.json 存在且 main 有值——不改用户的
   * 其他字段，那是用户项目的事。
   */
  const pkgPath = join(appDir, 'package.json')
  if (!(await isFile(pkgPath))) {
    await writeFile(pkgPath, `${JSON.stringify({ name: safeName.toLowerCase(), version: '0.0.0', main: 'main.js' }, undefined, 2)}\n`)
  }

  return { exeName: `${safeName}.exe`, appFiles: copied }
}