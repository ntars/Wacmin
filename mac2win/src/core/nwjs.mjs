/**
 * NW.js 运行时的下载与重打包。
 *
 * ## 与 Electron 的差别
 *
 * | 项 | Electron | NW.js |
 * | --- | --- | --- |
 * | 主程序 | `electron.exe` | `nw.exe` |
 * | 项目位置 | `resources/app/` | 与 `nw.exe` 同级（或 `package.nw` 归档） |
 * | 入口声明 | `package.json` 的 `main` | `package.json` 的 `main`（通常是 html） |
 * | ia32 支持 | 到 v43 | 目前仍在发布 |
 *
 * NW.js 把项目文件放在**主程序同级**，靠 `package.json` 找入口。所以
 * 重打包时不能把项目塞进子目录，否则它找不到——这是两者最容易搞混的
 * 地方。
 *
 * ## 为什么用目录形态而不是 `package.nw`
 *
 * `package.nw` 是一个 zip 归档。用目录形态的好处是文件可见、可改、
 * 出错时能直接看到是哪个文件不对；坏处是启动稍慢（NW.js 要扫描目录）。
 * 对一个安装到本机的桌面应用，启动慢几十毫秒换可排查性，值得。
 */

import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BuildError, ErrorCode } from './errors.mjs'
import { cacheRoot } from './runtime.mjs'
import { copyFile, copyTree, isFile, walkFiles } from '../util/fsx.mjs'
import { checkWindowsExe } from '../verify/pe.mjs'
import { unzipFile } from './zip.mjs'

/** NW.js 官方下载源。 */
const NW_MIRRORS = [
  'https://dl.nwjs.io',
  'https://npmmirror.com/mirrors/nwjs',
]

/** 平台标识。NW.js 用 `win-ia32` 而不是 `win32-ia32`。 */
function platformTag(target) {
  if (target === 'x86') return 'win-ia32'
  if (target === 'x64') return 'win-x64'
  return `win-${target}`
}

/** 缓存目录。 */
export function nwjsCacheDir(version, target) {
  return join(cacheRoot(), `nwjs-${version}-${platformTag(target)}`)
}

/**
 * 确保 NW.js 运行时可用。
 *
 * @param {object} input
 * @param {string} input.version NW.js 版本，形如 `0.90.0`。
 * @param {string} input.target 目标架构。
 * @param {string} [input.flavor] `normal`（默认）或 `sdk`。sdk 版带开发者工具。
 * @param {string} [input.archive] 本地 zip。
 * @param {(message: string) => void} [input.onProgress]
 * @returns {Promise<{dir: string, exeName: string, version: string, fromCache: boolean}>}
 */
export async function ensureNwjs(input) {
  const { version, target, flavor = 'normal', archive, onProgress } = input

  const tag = platformTag(target)
  const dir = nwjsCacheDir(version, target)
  const exeName = 'nw.exe'
  const exePath = join(dir, exeName)

  if (await isFile(exePath)) {
    try {
      await checkWindowsExe(exePath, { gui: false })
      onProgress?.(`复用缓存 NW.js ${version}（${tag}）`)
      return { dir, exeName, version, fromCache: true }
    } catch {
      onProgress?.('缓存的 NW.js 不可用，重新下载')
      await rm(dir, { recursive: true, force: true })
    }
  }

  // sdk 版的文件名里带 `-sdk` 后缀。
  const suffix = flavor === 'sdk' ? '-sdk' : ''
  const zipName = `nwjs${suffix}-v${version}-${tag}.zip`
  const zipPath = join(cacheRoot(), zipName)
  await mkdir(cacheRoot(), { recursive: true })

  if (archive !== undefined && archive !== null) {
    if (!(await isFile(archive))) {
      throw new BuildError(ErrorCode.RUNTIME_DOWNLOAD_FAILED, `指定的 NW.js 包不存在：${archive}`)
    }
    onProgress?.(`解包本地 NW.js ${archive}`)
    await unzipFile(archive, dir)
    await flattenSingleRoot(dir)
    await assertNwjs(exePath, target)
    return { dir, exeName, version, fromCache: false }
  }

  let lastError
  let ok = false
  for (const mirror of NW_MIRRORS) {
    const url = `${mirror}/v${version}/${zipName}`
    try {
      onProgress?.(`下载 NW.js ${url}`)
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
    throw new BuildError(ErrorCode.RUNTIME_DOWNLOAD_FAILED, 'NW.js 运行时下载失败', {
      details: [lastError instanceof Error ? lastError.message : String(lastError)],
      hint: `可手动下载 ${zipName} 后用 nwjsArchive 指定本地路径`,
    })
  }

  onProgress?.('解包 NW.js')
  await rm(dir, { recursive: true, force: true })
  await unzipFile(zipPath, dir)
  await flattenSingleRoot(dir)
  await rm(zipPath, { force: true })

  await assertNwjs(exePath, target)
  return { dir, exeName, version, fromCache: false }
}

/** 去掉多余的一层顶层目录（NW.js 的 zip 里是 `nwjs-v0.90.0-win-ia32/`）。 */
async function flattenSingleRoot(dir) {
  const { readdir, rename } = await import('node:fs/promises')
  const entries = await readdir(dir, { withFileTypes: true })
  const files = entries.filter((entry) => !entry.isDirectory())
  const dirs = entries.filter((entry) => entry.isDirectory())
  if (files.length > 0 || dirs.length !== 1) return

  const inner = join(dir, dirs[0].name)
  for (const name of await readdir(inner)) {
    await rename(join(inner, name), join(dir, name))
  }
  await rm(inner, { recursive: true, force: true })
}

/** 断言 NW.js 主程序架构。 */
async function assertNwjs(exePath, target) {
  if (!(await isFile(exePath))) {
    throw new BuildError(ErrorCode.RUNTIME_WRONG_ARCH, `NW.js 包不完整：找不到 ${exePath}`)
  }
  const result = await checkWindowsExe(exePath, { gui: false })
  const header = result.header
  if (header === null) {
    throw new BuildError(ErrorCode.RUNTIME_WRONG_ARCH, 'NW.js 主程序不是合法的 Windows 可执行文件', {
      details: result.problems,
    })
  }
  const expected = target === 'x86' ? 'i386' : 'x86-64'
  if (header.machineName !== expected) {
    throw new BuildError(
      ErrorCode.RUNTIME_WRONG_ARCH,
      `NW.js 主程序架构是 ${header.machineName}，期望 ${expected}`,
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
 * 把用户项目重打包成 NW.js 应用。
 *
 * ## 目录结构
 *
 * ```
 * app/
 *   node.exe               ← 启动器用的 Node（用于 bootstrap）
 *   bootstrap/             ← 启动器（可选，NW.js 有自己的壳）
 *   nwjs/
 *     <产品名>.exe         ← nw.exe 改名
 *     package.json         ← 项目清单（NW.js 靠它找入口）
 *     <项目文件…>          ← 与主程序同级
 *   ui/                    ← 前端产物
 * ```
 *
 * ## 为什么项目文件放在主程序同级
 *
 * NW.js 启动时在当前目录找 `package.json`。放进子目录它会找不到，
 * 表现是「打开一个空白窗口」。这是 NW.js 与 Electron 最大的结构差异。
 *
 * @param {object} input
 * @param {string} input.nwjsDir NW.js 运行时目录。
 * @param {string} input.projectRoot 项目根目录。
 * @param {string} input.target 暂存区的 `app/` 目录。
 * @param {string} input.productName 产品名。
 * @param {string} [input.mainEntry] 入口（相对项目根，通常是 html）。
 * @param {string[]} [input.exclude]
 * @param {(message: string) => void} [input.onProgress]
 * @returns {Promise<{exeName: string, appFiles: number}>}
 */
export async function repackNwjs(input) {
  const { nwjsDir, projectRoot, target, productName, mainEntry, exclude = [], onProgress } = input

  const nwTarget = join(target, 'nwjs')
  onProgress?.('拷贝 NW.js 运行时')
  await copyTree(nwjsDir, nwTarget)

  const { rename } = await import('node:fs/promises')
  const safeName = String(productName).replace(/[\\/:*?"<>|]/g, '').trim() || 'app'
  const originalExe = join(nwTarget, 'nw.exe')
  const renamedExe = join(nwTarget, `${safeName}.exe`)
  if (safeName !== 'nw' && await isFile(originalExe)) {
    await rename(originalExe, renamedExe)
  }

  const skipped = new Set(['node_modules/.cache', '.git', '.github', 'dist-mac2win', ...exclude])
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
    await copyFile(join(projectRoot, relative), join(nwTarget, relative))
    copied += 1
    if (copied % 200 === 0) onProgress?.(`拷贝项目文件 ${String(copied)} / ${String(files.length)}`)
  }

  /*
   * 修正 package.json 的 main 指向。
   *
   * NW.js 要求 main 是一个能被它加载的文件（html 或 js）。原项目的
   * main 可能指向 `dist/index.html`，也可能根本没写。这里只补不覆盖：
   * 有值就留着，没值才按推断填。
   */
  const pkgPath = join(nwTarget, 'package.json')
  let pkg = null
  try {
    pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  } catch {
    pkg = null
  }

  if (pkg === null || typeof pkg !== 'object') {
    pkg = {
      name: safeName.toLowerCase(),
      version: '0.0.0',
      main: mainEntry ?? 'index.html',
    }
  } else if (typeof pkg.main !== 'string' || pkg.main === '') {
    pkg.main = mainEntry ?? 'index.html'
  }

  // NW.js 的窗口配置：给一个像桌面应用的默认尺寸。
  if (pkg.window === undefined) {
    pkg.window = { width: 1100, height: 720, title: productName }
  }

  await writeFile(pkgPath, `${JSON.stringify(pkg, undefined, 2)}\n`)

  return { exeName: `${safeName}.exe`, appFiles: copied }
}