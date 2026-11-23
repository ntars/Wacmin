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
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { BuildError, ErrorCode } from './errors.mjs'
import { isDirectory, isFile } from '../util/fsx.mjs'

const run = promisify(execFile)

/**
 * 本方向编译 Rust 壳时使用的目标三元组。
 *
 * 抽成常量而不是在两处各写一遍字符串：它同时决定
 * `cargo xwin build --target` 的参数、`TAURI_ENV_TARGET_TRIPLE` 的值、
 * 以及产物目录 `target/<三元组>/<profile>`。三处任一不同步，
 * 表现都是「编完了但找不到 exe」，而错误信息不会指向真正的原因。
 */
const TARGET_TRIPLE = 'i686-pc-windows-msvc'

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

/**
 * cargo-xwin 自建 shim 的落地目录。
 *
 * ## 为什么必须单独列出来
 *
 * `clang-cl` 与 `lld-link` **不是**用户自己装的 LLVM 组件，
 * 而是 `cargo-xwin` 首次运行时**自己创建的两个符号链接**：
 *
 * ```
 * ~/Library/Caches/cargo-xwin/clang-cl -> …/XcodeDefault.xctoolchain/usr/bin/clang
 * ~/Library/Caches/cargo-xwin/lld-link -> ~/.rustup/toolchains/<host>/lib/rustlib/<host>/bin/rust-lld
 * ```
 *
 * `cargo xwin build` 执行时会把该目录**临时插进 PATH**，所以编译能成功；
 * 但那个目录**从不进系统 PATH**，也不在 `~/.cargo/bin` 里。
 *
 * 于是只看 PATH 的检查会得出「clang-cl 找不到」，而真实情况是
 * 「已经能编译」。2026-11-19 实测就是这个结果：系统 PATH 无 clang-cl，
 * 同一时刻 `cargo xwin build --target i686-pc-windows-msvc` 编译成功、
 * 产出 92 KB 的 `PE32 / i386 / windows-gui`。
 *
 * 这与 W-02 记录的 wine 是**同一类错误**：拿 `which` 判断「有没有」，
 * 而工具刻意不进 PATH。判据只该问「编译时能不能拿到」，不该问「PATH 里有没有」。
 *
 * @returns {string[]} 候选目录（macOS 与 Linux 各一）。
 */
function cargoXwinShimDirs() {
  const home = process.env.HOME ?? ''
  return [
    join(home, 'Library', 'Caches', 'cargo-xwin'),
    join(home, '.cache', 'cargo-xwin'),
  ]
}

/**
 * Homebrew 已安装但未链接到 PATH 的工具目录。
 *
 * ## 为什么要查 Cellar
 *
 * `brew install llvm` 默认是 keg-only：可执行文件在
 * `/opt/homebrew/Cellar/llvm/<version>/bin/`，**不会**出现在
 * `/opt/homebrew/bin`。`brew install llvm@19` 同理。
 *
 * 只查 PATH 与固定前缀会得出「llvm-rc 未安装」，但同一台机器上它其实
 * 就在 Cellar 里 —— 用户照着提示再装一遍毫无作用。这种情况比「真的没装」
 * 更糟，因为它把「探测路径不全」伪装成了「环境缺失」。
 *
 * 扫描只到 Cellar 下名称以 `llvm` 开头的公式目录的 `bin`：
 * - 不递归整个 Homebrew：那会有几万项；
 * - 不把任意同名二进制当 llvm-rc：调用方仍会检查文件是否存在。
 *
 * @returns {Promise<string[]>}
 */
async function homebrewLlmBinDirs() {
  const { readdir } = await import('node:fs/promises')
  const roots = ['/opt/homebrew/Cellar', '/usr/local/Cellar']
  const dirs = []
  for (const root of roots) {
    let formulae
    try {
      formulae = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const formula of formulae) {
      if (!formula.isDirectory()) continue
      if (!formula.name.startsWith('llvm')) continue
      const formulaRoot = join(root, formula.name)
      let versions
      try {
        versions = await readdir(formulaRoot, { withFileTypes: true })
      } catch {
        continue
      }
      for (const version of versions) {
        if (!version.isDirectory()) continue
        dirs.push(join(formulaRoot, version.name, 'bin'))
      }
    }
  }
  return dirs
}

/**
 * cargo-xwin 的 MSVC 库缓存根目录（含 `crt` / `sdk` 的那个 `xwin` 子目录）。
 *
 * `XWIN_CACHE_DIR` 可覆盖，与 cargo-xwin 自己的行为一致。
 *
 * @returns {string} 缓存根。
 */
function cargoXwinCacheRoot() {
  const override = process.env.XWIN_CACHE_DIR
  if (typeof override === 'string' && override !== '') return join(override, 'xwin')
  const home = process.env.HOME ?? ''
  return [
    join(home, 'Library', 'Caches', 'cargo-xwin', 'xwin'),
    join(home, '.cache', 'cargo-xwin', 'xwin'),
  ][0]
}

/**
 * 检查 x86 的 CRT/SDK 库是否**真的落地**在缓存里。
 *
 * ## 为什么这一项必须单独查（2026-11-19 实测确认）
 *
 * `XWIN_ARCH=x86` 只影响 cargo-xwin **该下载什么**，不保证**已经下到了**。
 * 而它有这样一个提前返回的分支（`cargo-xwin-0.23.1/src/compiler/clang_cl.rs`）：
 *
 * ```rust
 * let done_mark_file_content = fs::read_to_string(&done_mark_file);
 * if let Ok(content) = &done_mark_file_content {
 *     let mut lines = content.lines();
 *     if let Some(archs) = lines.next() {
 *         for arch in archs.split_whitespace() {
 *             downloaded_arches.insert(arch.to_string());
 *         }
 *     }
 *     ...
 * }
 * if !update && xwin_arches.difference(&downloaded_arches).next().is_none() {
 *     return Ok(());   // ← 直接返回，不校验文件是否真在
 * }
 * ```
 *
 * 判据是 **`DONE` 文件首行的文本**，不是磁盘上的文件。本机实测到的具体后果：
 *
 * | 事实 | 值 |
 * |---|---|
 * | `xwin/DONE` 首行 | `x86` |
 * | `xwin/crt/lib/` 实有 | 只有 `x86_64` |
 * | `xwin/sdk/lib/um/` 实有 | `aarch64`、`x86_64` |
 *
 * 于是 `cargo xwin build --target i686-pc-windows-msvc` 一路编完 130+ crate，
 * 在**链接**阶段才报 10 条 `could not open 'user32.lib'`，
 * 而重跑同一命令仍然是同一个错 —— 因为 `DONE` 说「有了」。
 *
 * 同一份代码在干净缓存下（`XWIN_CACHE_DIR` 指到新目录）一次通过。
 * 所以这不是环境坏，是**缓存自述与磁盘不一致**。
 *
 * 把这个判据放进预检，用户能在编译前就被告知，而不是等十几分钟。
 *
 * @returns {Promise<{ok: boolean, missingPaths: string[]}>}
 */
async function checkX86Libs() {
  const root = cargoXwinCacheRoot()
  const required = [
    join(root, 'crt', 'lib', 'x86'),
    join(root, 'sdk', 'lib', 'um', 'x86'),
  ]
  const missingPaths = []
  for (const path of required) {
    if (!(await isDirectory(path))) missingPaths.push(path)
  }
  return { ok: missingPaths.length === 0, missingPaths }
}

/**
 * 找一个命令，返回绝对路径或 null。
 *
 * @param {string} command 命令名。
 * @param {string[]} [extraDirs] 额外候选目录（如 cargo-xwin 的 shim 目录）。
 */
async function which(command, extraDirs = []) {
  const candidates = [
    ...extraDirs.map((dir) => join(dir, command)),
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
 * 构造子进程 PATH。
 *
 * 交叉编译链里有两类工具必须由我们自己暴露：
 * - `llvm-rc` 往往来自 keg-only 的 Homebrew 安装，不在 PATH；
 * - `cargo-xwin` 会在内部按名字启动 `cargo`，但它不会替我们补 PATH。
 *
 * 去重是必要的：`llvmRcDir` 与 cargo 目录有时会重合，重复项本身无害，
 * 但会让出错时的环境排查变长。
 *
 * @param {string[]} dirs 要前置的目录。
 * @param {string} [basePath] 原 PATH。
 * @returns {string}
 */
function prependPathDirs(dirs, basePath = process.env.PATH ?? '') {
  const seen = new Set()
  const parts = []
  for (const dir of dirs) {
    if (typeof dir !== 'string' || dir === '' || seen.has(dir)) continue
    seen.add(dir)
    parts.push(dir)
  }
  if (basePath !== '') parts.push(basePath)
  return parts.join(delimiter)
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
      const installed = stdout.includes(TARGET_TRIPLE)
      status.add({
        id: 'target',
        title: 'i686-pc-windows-msvc 目标',
        ok: installed,
        detail: installed ? '已安装' : '未安装',
        hint: installed ? undefined : `rustup target add ${TARGET_TRIPLE}`,
      })
    } catch {
      status.add({ id: 'target', title: 'i686-pc-windows-msvc 目标', ok: false, detail: '无法查询' })
    }
  }

  /*
   * --- clang-cl 与 lld-link ---
   *
   * 这两个要连 cargo-xwin 的 shim 目录一起找。只查 PATH 会误判成缺失，
   * 见 `cargoXwinShimDirs()` 的说明。
   */
  const shimDirs = [...cargoXwinShimDirs(), ...(await homebrewLlmBinDirs())]
  for (const [command, title] of [
    ['clang-cl', 'clang-cl 编译器'],
    ['lld-link', 'lld-link 链接器'],
  ]) {
    const path = await which(command, shimDirs)
    status.add({
      id: command,
      title,
      ok: path !== null,
      detail: path ?? '找不到（系统 PATH 与 cargo-xwin shim 目录都没有）',
      hint: path === null ? 'brew install llvm' : undefined,
    })
  }

  /*
   * --- llvm-rc ---
   *
   * **这是 Tauri v2 交叉编译的真正卡点，而且与 Rust 环境完全无关。**
   *
   * Tauri 的 `build.rs` 会调 `tauri-build` → `tauri-winres` → `embed-resource`，
   * 把 `icons/icon.ico` 编成 Windows 资源节。对 `*-pc-windows-msvc` 目标，
   * `embed-resource` 默认找的就是 `llvm-rc`（源码 `lib.rs:85` 的注释明写）。
   *
   * 2026-11-19 实测：上面五项全绿之后编译仍在
   * `tauri-winres-0.3.7/src/lib.rs:543` 处 panic：
   *
   * ```
   * called `Result::unwrap()` on an `Err` value: NotAttempted("llvm-rc")
   * ```
   *
   * 而 `llvm-rc` **不在任何现成安装里**：Xcode 的 LLVM 没有它
   * （`Toolchains/XcodeDefault.xctoolchain/usr/bin/` 只有 llvm-cov / llvm-nm /
   * llvm-objdump 等，全盘 `find -name "llvm-rc*"` 零命中），
   * cargo-xwin 也只造 `clang-cl` / `lld-link` 两个 shim。
   *
   * 所以这一项要**单独查、单独报**。放在这里而不是让它编译时才炸，
   * 是因为那个 panic 发生在「已编译 300+ 个 crate、耗时十几分钟」之后，
   * 报错文本只有一句 `NotAttempted("llvm-rc")`，用户无从知道该装什么。
   */
  const llvmRc = await which('llvm-rc', shimDirs)
  status.add({
    id: 'llvm-rc',
    title: 'llvm-rc 资源编译器',
    ok: llvmRc !== null,
    detail: llvmRc ?? '找不到（Tauri 编译资源节必需）',
    hint: llvmRc === null
      ? 'brew install llvm 会一并提供 llvm-rc；或用 RC 环境变量指向可用的 rc 编译器'
      : undefined,
  })

  // --- cargo ---
  const cargo = await which('cargo')
  status.add({
    id: 'cargo',
    title: 'Cargo',
    ok: cargo !== null,
    detail: cargo ?? '找不到',
    hint: cargo === null ? '重新安装 Rust 工具链，或把 ~/.cargo/bin 加进 PATH' : undefined,
  })

  // --- cargo-xwin ---
  const cargoXwin = await which('cargo-xwin')
  status.add({
    id: 'cargo-xwin',
    title: 'cargo-xwin',
    ok: cargoXwin !== null,
    detail: cargoXwin ?? '找不到',
    hint: cargoXwin === null ? 'cargo install cargo-xwin' : undefined,
  })

  // --- x86 的 CRT / SDK 库是否真的落地 ---
  const x86Libs = await checkX86Libs()
  status.add({
    id: 'x86-libs',
    title: 'x86（32 位）CRT / SDK 库',
    ok: x86Libs.ok,
    detail: x86Libs.ok
      ? '已落地'
      : `缓存缺目录：${x86Libs.missingPaths.join('、')}`,
    hint: x86Libs.ok
      ? undefined
      : '缓存自述（xwin/DONE 首行）与实际文件不一致，删掉该缓存目录后重跑，'
        + 'cargo-xwin 会按 XWIN_ARCH=x86 重新下载；或用 XWIN_CACHE_DIR 指一个干净目录',
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
  const cargo = await which('cargo')
  const llvmRc = await which('llvm-rc', [
    ...cargoXwinShimDirs(),
    ...(await homebrewLlmBinDirs()),
  ])
  if (llvmRc === null) {
    throw new BuildError(ErrorCode.TOOL_MISSING, '找不到 llvm-rc', {
      hint: 'brew install llvm，或把 RC 指向可用的资源编译器',
    })
  }
  if (cargo === null) {
    throw new BuildError(ErrorCode.TOOL_MISSING, '找不到 cargo', {
      hint: 'cargo-xwin 会启动 cargo；重新安装 Rust 工具链，或把 ~/.cargo/bin 加进 PATH',
    })
  }
  const llvmRcDir = dirname(llvmRc)
  const cargoXwinDir = dirname(cargoXwin)
  const startedAt = Date.now()

  onProgress?.('开始编译 Rust 壳（首次构建需 10–30 分钟，要编译整个 tauri crate 树）')

  await new Promise((resolve, reject) => {
    const child = execFile(
      cargoXwin,
      ['xwin', 'build', '--target', TARGET_TRIPLE, ...(profile === 'release' ? ['--release'] : [])],
      {
        cwd: tauriDir,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          /*
           * 两条路都要显式补：
           * - keg-only 的 llvm-rc 不在 PATH，embed-resource 会找不到；
           * - cargo-xwin 内部按名字启动 cargo，而 ~/.cargo/bin 在图形界面
           *   或非登录 shell 里经常不在 PATH。只传 cargo-xwin 的绝对路径不够，
           *   父进程能找到它，不代表它找得到 cargo。
           */
          PATH: prependPathDirs([llvmRcDir, cargoXwinDir, dirname(cargo)]),
          // cargo-xwin 会读这两个变量决定用哪个 LLVM。
          CC_i686_pc_windows_msvc: 'clang-cl',
          AR_i686_pc_windows_msvc: 'llvm-lib',
          /*
           * 冗余但必要：不同 embed-resource 版本对 PATH 与 RC 的优先级不同，
           * 显式给 RC 能避免「PATH 改了、探测仍失败」的版本差异。
           */
          RC: llvmRc,
          // 有些工具按 CARGO 找 cargo；与 PATH 一起给，覆盖两种实现。
          CARGO: cargo,
          /*
           * 让 cargo-xwin 下载 32 位（x86）的 CRT 与 SDK。
           *
           * 不设这个变量时它只下 x86_64 与 aarch64，链接阶段会报
           * `could not open 'user32.lib'`。
           *
           * **注意**：这个变量只决定「该下载什么」，不保证「已经下到了」。
           * cargo-xwin 的缓存判据只看 `xwin/DONE` 的首行文本，从不校验文件
           * 是否真在磁盘上，所以存在「DONE 写着 x86、目录里只有 x86_64」
           * 的情况，此时重跑也不会补下。因此 `checkRustEnv()` 里单列了
           * `x86-libs` 一项直接查磁盘，预检阶段就能拦住。
           */
          XWIN_ARCH: 'x86',
          /*
           * 告诉 `tauri` 的 `generate_context!()` 本次是交叉编译到 Windows。
           *
           * 这个变量不能省。`generate_context!()` 是**过程宏，在宿主上展开**，
           * 它读的是 `TAURI_ENV_TARGET_TRIPLE` 而**不是** `TARGET`
           * （`tauri-codegen-2.7.6/src/context.rs:148`）。
           *
           * 不设的后果实测：宏按宿主判定为 macOS，生成的代码里带上
           * `tauri::embed_plist::embed_info_plist!`，而 `embed_plist` 在
           * `tauri-2.12.7/src/lib.rs:75` 被 `#[cfg(target_os = "macos")]` 门控，
           * 交叉编译到 Windows 时该门未开，于是：
           *
           *     error[E0433]: cannot find `embed_plist` in `tauri`
           *
           * 这个错误与 Rust 环境、与 llvm-rc 都无关，纯粹是目标三元组没传对。
           * 报错文本指向 `tauri` 内部，从字面完全看不出「少设一个环境变量」。
           */
          TAURI_ENV_TARGET_TRIPLE: TARGET_TRIPLE,
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
  const targetDir = join(tauriDir, 'target', TARGET_TRIPLE, profile)
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
