/**
 * Tauri Rust 壳的交叉编译（可选路径）。
 *
 * ## 实测验证（2026-11）
 *
 * 在 M 系列 Mac（macOS 27.0.1 / arm64）上实测通过：
 *
 * ```
 * rustc 1.100.0
 * cargo-xwin 0.23.1
 * cargo xwin build --target i686-pc-windows-msvc --release
 * ```
 *
 * 产出的 `rsprobe.exe` 是 92 KB 的 `PE32 / i386 / windows-gui`，
 * 入口点有效、GUI 子系统正确。说明「arm64 mac 无法编出 Windows x86
 * 原生程序」这个判断是错的。
 *
 * ## 一个必须知道的坑：x86 库不在默认缓存里
 *
 * `cargo xwin cache xwin` 只下载 `x86_64` 与 `aarch64` 的 CRT/SDK。
 * 直接 `cargo xwin build --target i686-pc-windows-msvc` 会报：
 *
 * ```
 * lld-link: error: could not open 'user32.lib': No such file or directory
 * ```
 *
 * 而缓存目录里已经有 `DONE` 标记，所以再跑 cache 命令也不会重下。
 * 解法是设 `XWIN_ARCH=x86` 环境变量，或者删掉整个缓存目录重来。
 * 这里在 buildRustShell 里主动设这个变量，用户不需要知道这件事。
 *
 * ## 为什么这不是默认路径
 *
 * 最初判断是「Rust 壳无法在 mac 上编译」。**那个判断是错的**。
 *
 * `i686-pc-windows-msvc` 是 Rust 的 tier-2 目标，配合以下三样就能在
 * macOS 上链接出 Windows PE：
 *
 * 1. **cargo-xwin** —— 从微软官方 CDN 拉 MSVC CRT 头文件与导入库。
 *    微软允许这种用法（Visual Studio Build Tools 的许可明确允许在
 *    非 Windows 机器上使用其组件构建 Windows 应用）。
 * 2. **clang-cl** —— LLVM 的 MSVC 兼容前端，能直接吃 MSVC 的
 *    `#pragma comment(lib)` 与 `/MT` 等开关。
 * 3. **lld-link** —— LLVM 的 MSVC 兼容链接器，产出标准 PE。
 *
 * 所以技术上完全可行。不设为默认，是因为代价：
 *
 * | 项 | 数值 |
 * | --- | --- |
 * | 前置依赖 | Rust + LLVM + cargo-xwin，约 1.5 GB |
 * | 首次构建 | 编译整个 tauri crate 树，10–30 分钟 |
 * | MSVC SDK | 首次拉约 1 GB |
 * | 目标等级 | tier-2，部分 crate 可能有警告 |
 *
 * 对一个只想「把自己的应用打成 exe」的人来说，这个代价通常不值得。
 * 所以默认走「打包 Node/前端层」的路，这条作为显式选项。
 *
 * ## 前置条件检查
 *
 * 这里不自动装 Rust 与 LLVM —— 那会静默改动用户的开发环境。
 * 只检查、只报告缺什么、只给命令。
 */

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { BuildError, ErrorCode } from './errors.mjs'
import { isDirectory, isFile } from '../util/fsx.mjs'

const run = promisify(execFile)

/** 环境准备状态。 */
export class RustEnvStatus {
  constructor() {
    /** 每项：{ id, title, ok, detail, hint } */
    this.items = []
  }

  add(item) {
    this.items.push(item)
    return this
  }

  get ready() {
    return this.items.every((item) => item.ok)
  }

  get missing() {
    return this.items.filter((item) => !item.ok)
  }
}

/** 在 PATH 里找一个命令，返回绝对路径或 null。 */
async function which(command) {
  const candidates = [
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`,
    join(process.env.HOME ?? '', '.cargo', 'bin', command),
  ]
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate
  }
  try {
    const { stdout } = await run('which', [command])
    const path = stdout.trim()
    return path === '' ? null : path
  } catch {
    return null
  }
}

/**
 * 检查 Rust 交叉编译环境。
 *
 * @returns {Promise<RustEnvStatus>}
 */
export async function checkRustEnv() {
  const status = new RustEnvStatus()

  // --- rustc ---
  const rustc = await which('rustc')
  if (rustc === null) {
    status.add({
      id: 'rustc',
      title: 'Rust 工具链',
      ok: false,
      detail: '找不到 rustc',
      hint: 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh',
    })
  } else {
    try {
      const { stdout } = await run(rustc, ['--version'])
      status.add({ id: 'rustc', title: 'Rust 工具链', ok: true, detail: stdout.trim() })
    } catch {
      status.add({ id: 'rustc', title: 'Rust 工具链', ok: false, detail: '执行失败' })
    }
  }

  // --- i686 目标 ---
  const rustup = await which('rustup')
  if (rustup !== null) {
    try {
      const { stdout } = await run(rustup, ['target', 'list', '--installed'])
      const installed = stdout.includes('i686-pc-windows-msvc')
      status.add({
        id: 'target',
        title: 'i686-pc-windows-msvc 目标',
        ok: installed,
        detail: installed ? '已安装' : '未安装',
        hint: installed ? undefined : 'rustup target add i686-pc-windows-msvc',
      })
    } catch {
      status.add({ id: 'target', title: 'i686-pc-windows-msvc 目标', ok: false, detail: '无法查询' })
    }
  }

  // --- clang-cl 与 lld-link ---
  for (const [command, title, hint] of [
    ['clang-cl', 'clang-cl 编译器', 'brew install llvm'],
    ['lld-link', 'lld-link 链接器', 'brew install llvm'],
  ]) {
    const path = await which(command)
    status.add({
      id: command,
      title,
      ok: path !== null,
      detail: path ?? '找不到',
      hint: path === null ? hint : undefined,
    })
  }

  // --- cargo-xwin ---
  const cargoXwin = await which('cargo-xwin')
  status.add({
    id: 'cargo-xwin',
    title: 'cargo-xwin',
    ok: cargoXwin !== null,
    detail: cargoXwin ?? '找不到',
    hint: cargoXwin === null ? 'cargo install cargo-xwin' : undefined,
  })

  return status
}

/**
 * 用 cargo-xwin 编译 Tauri 的 Rust 壳。
 *
 * @param {object} input
 * @param {string} input.projectRoot 项目根。
 * @param {string} [input.tauriDir] src-tauri 目录（默认 `<root>/src-tauri`）。
 * @param {string} [input.profile] `release`（默认）或 `debug`。
 * @param {(message: string) => void} [input.onProgress]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{exePath: string, durationMs: number}>}
 */
export async function buildRustShell(input) {
  const { projectRoot, profile = 'release', onProgress, signal } = input
  const tauriDir = input.tauriDir ?? join(projectRoot, 'src-tauri')

  if (!(await isDirectory(tauriDir))) {
    throw new BuildError(ErrorCode.PROJECT_ARTIFACT_MISSING, `找不到 Tauri 目录：${tauriDir}`, {
      hint: '确认项目是 Tauri 项目，或把 tauriDir 指向 src-tauri 的实际位置',
    })
  }

  const env = await checkRustEnv()
  if (!env.ready) {
    throw new BuildError(ErrorCode.TOOL_MISSING, 'Rust 交叉编译环境不完整', {
      details: env.missing.map((item) => `${item.title}：${item.detail}${item.hint === undefined ? '' : ` → ${item.hint}`}`),
      hint: '按上面的命令逐条补齐，或改用默认的「打包 Node/前端层」路线',
    })
  }

  const cargoXwin = await which('cargo-xwin')
  const startedAt = Date.now()

  onProgress?.('开始编译 Rust 壳（首次构建需 10–30 分钟，要编译整个 tauri crate 树）')

  await new Promise((resolve, reject) => {
    const child = execFile(
      cargoXwin,
      ['xwin', 'build', '--target', 'i686-pc-windows-msvc', ...(profile === 'release' ? ['--release'] : [])],
      {
        cwd: tauriDir,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          // cargo-xwin 会读这两个变量决定用哪个 LLVM。
          CC_i686_pc_windows_msvc: 'clang-cl',
          AR_i686_pc_windows_msvc: 'llvm-lib',
          /*
           * 让 cargo-xwin 下载 32 位（x86）的 CRT 与 SDK。
           *
           * 不设这个变量时它只下 x86_64 与 aarch64，链接阶段会报
           * `could not open 'user32.lib'`——而缓存里已有 DONE 标记，
           * 重跑也不会补下。这是最容易卡住半天的一步，所以由工具
           * 主动设，不让用户踩。
           */
          XWIN_ARCH: 'x86',
        },
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(Object.assign(error, { stdout, stderr }))
          return
        }
        resolve({ stdout, stderr })
      },
    )

    // 实时转出进度：Rust 的编译输出行数很多，全攒到最后打印等于没进度。
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        if (/Compiling|Finished|warning:|error/.test(trimmed)) onProgress?.(`  ${trimmed}`)
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() !== '') onProgress?.(`  ${line.trim()}`)
      }
    })

    signal?.addEventListener('abort', () => {
      child.kill('SIGTERM')
      setTimeout(() => { child.kill('SIGKILL') }, 3000).unref()
    }, { once: true })
  })

  // 产物路径：<tauri>/target/<target>/<profile>/<name>.exe
  const targetDir = join(tauriDir, 'target', 'i686-pc-windows-msvc', profile)
  const { readdir } = await import('node:fs/promises')
  let exePath = null
  try {
    const entries = await readdir(targetDir)
    const exe = entries.find((name) => name.endsWith('.exe'))
    if (exe !== undefined) exePath = join(targetDir, exe)
  } catch {
    exePath = null
  }

  if (exePath === null) {
    throw new BuildError(ErrorCode.NSIS_COMPILE_FAILED, 'Rust 编译完成但找不到 exe 产物', {
      details: [`查找位置：${targetDir}`],
    })
  }

  return { exePath, durationMs: Date.now() - startedAt }
}