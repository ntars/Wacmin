/**
 * 框架识别与适配。
 *
 * ## 这个文件解决什么问题
 *
 * 用户在 arm64 mac 上想产出 x86 Windows 安装包，但他们的项目可能是
 * Electron、NW.js、Tauri、纯 Node 服务，或者只是个静态站点。这些形态
 * 的「可打包部分」完全不同：
 *
 * | 框架 | 壳 | 能跨架构打包的部分 | 必须承认的限制 |
 * | --- | --- | --- | --- |
 * | Electron | 官方预编译二进制 | 全都能（含 ia32） | ia32 只到 Electron 43 |
 * | NW.js | 官方预编译二进制 | 全都能（含 win-ia32） | 无 |
 * | Tauri | Rust 编译产物 | Node/前端层能，Rust 壳不能 | 需 Windows 工具链 |
 * | Flutter | 用户预构建的原生 exe | 只重打包已构建产物 | Flutter 强制要求 Windows 宿主 |
 * | 纯 Node | 无 | 全都能 | 无 |
 * | 静态站 | 无 | 全都能 | 无 |
 *
 * 所以「适配」的正确含义是：**识别出项目属于哪一类，走它唯一可行的
 * 那条路，并把走不通的部分如实说清楚**，而不是假装全都能做。
 *
 * ## 为什么不做「假装成功」
 *
 * 如果 Tauri 项目打出来的包里没有 Rust 壳，用户装完双击会得到一个
 * 浏览器页面而不是原生窗口。那不算「打包成功」，只是把失败推迟到了
 * 用户机器上。所以这里对 Tauri 明确标注 `nativeShell: false`，
 * 并在产物里写清降级说明。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDirectory, isFile, readJson } from '../util/fsx.mjs'

/**
 * 支持的框架清单。
 *
 * `architectures` 表示「在 arm64 mac 上能产出哪些目标架构」。
 * `nativeShell` 表示产出的包是否包含该框架的原生窗口壳。
 */
export const FRAMEWORKS = {
  electron: {
    id: 'electron',
    label: 'Electron',
    /** 官方预编译包覆盖的架构。ia32 从 44 起被移除。 */
    architectures: ['x86', 'x64', 'arm64'],
    nativeShell: true,
    /** 需要从官方下载的运行时标识。 */
    runtime: 'electron',
    description: 'Electron 官方发布 win32-ia32 预编译二进制，mac 上可直接重打包',
    /** 走这条路时默认的入口。 */
    defaultEntry: 'main.js',
  },
  nwjs: {
    id: 'nwjs',
    label: 'NW.js',
    architectures: ['x86', 'x64'],
    nativeShell: true,
    runtime: 'nwjs',
    description: 'NW.js 官方发布 win-ia32 预编译二进制，mac 上可直接重打包',
    defaultEntry: 'index.html',
  },
  tauri: {
    id: 'tauri',
    label: 'Tauri',
    architectures: ['x86'],
    /*
     * 默认不编 Rust 壳，但**原因不是「编不了」**。
     *
     * 2026-11-19 实测：arm64 macOS 上 `cargo xwin build --target
     * i686-pc-windows-msvc` 能编出真实的 `PE32 / i386 / windows-gui`。
     * 完整 Tauri 项目卡在 `llvm-rc`（`tauri-winres` 编资源节要用）——
     * 一个可选组件，不是架构限制。详见 `rust-shell.mjs`。
     *
     * 默认关着是为了省 1.5 GB 依赖与 10–30 分钟首次构建，
     * 这是产品取舍，不是能力边界。注释写清楚，免得下一个人
     * 又把「默认不做」读成「做不到」。
     */
    nativeShell: false,
    runtime: 'node',
    description: 'Tauri 默认只打包其 Node/前端层；要原生窗口需显式开启 Rust 壳编译',
    defaultEntry: 'dist',
  },
  flutter: {
    id: 'flutter',
    label: 'Flutter',
    /*
     * Flutter 的 Windows 产物是原生 exe + 一组数据目录，不是 Node 项目。
     * macOS 上不能跑 `flutter build windows`（2026-11-23 实测 3.50.0
     * 的 `build_windows.dart` 明确拒绝非 Windows host），所以 mac2win
     * 只负责把用户在 Windows 上编好的发布目录重打成 NSIS 安装包。
     */
    architectures: ['x86', 'x64'],
    nativeShell: true,
    runtime: null,
    description: 'Flutter Windows 发布产物：由用户在 Windows 上构建，mac2win 负责重打包为安装包',
    defaultEntry: null,
  },
  node: {
    id: 'node',
    label: 'Node 服务',
    architectures: ['x86', 'x64'],
    nativeShell: false,
    runtime: 'node',
    description: '纯 Node 项目：打包 Windows x86 的 node.exe 与依赖',
    defaultEntry: null,
  },
  static: {
    id: 'static',
    label: '静态站点',
    architectures: ['x86', 'x64'],
    nativeShell: false,
    runtime: 'node',
    description: '只有前端产物：用内置静态服务托管',
    defaultEntry: null,
  },
}

/**
 * 从项目里识别框架。
 *
 * 判据优先级：显式配置 > 目录特征 > package.json 依赖。
 * 目录特征排第二是因为它比依赖更可信——一个项目可能 `devDependencies`
 * 里同时装着 electron 和 @tauri-apps/cli，但 `src-tauri/` 目录只在
 * Tauri 项目里出现。
 *
 * @param {string} projectRoot 项目根目录。
 * @param {object} [hints] 配置里给的显式提示。
 * @returns {Promise<{id: string, confidence: 'explicit'|'high'|'medium'|'guess', evidence: string[]}>}
 */
export async function detectFramework(projectRoot, hints = {}) {
  // --- 显式指定：用户说了算 ---
  if (typeof hints.framework === 'string' && FRAMEWORKS[hints.framework] !== undefined) {
    return {
      id: hints.framework,
      confidence: 'explicit',
      evidence: [`配置里指定 framework: ${hints.framework}`],
    }
  }

  const evidence = []
  let pkg = null
  if (await isFile(join(projectRoot, 'package.json'))) {
    try {
      pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
    } catch {
      pkg = null
    }
  }

  const deps = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  }

  // --- Flutter：pubspec.yaml 是最硬的目录特征，优先于 package.json ---
  if (await isFile(join(projectRoot, 'pubspec.yaml'))) {
    evidence.push('存在 pubspec.yaml')
    return { id: 'flutter', confidence: 'high', evidence }
  }

  // --- Tauri：目录特征最硬 ---
  if (await isDirectory(join(projectRoot, 'src-tauri'))) {
    evidence.push('存在 src-tauri/ 目录')
    return { id: 'tauri', confidence: 'high', evidence }
  }
  if (deps['@tauri-apps/cli'] !== undefined || deps['@tauri-apps/api'] !== undefined) {
    evidence.push('依赖里有 @tauri-apps/*')
    return { id: 'tauri', confidence: 'medium', evidence }
  }

  // --- Electron ---
  if (deps.electron !== undefined) {
    evidence.push(`依赖里有 electron@${String(deps.electron)}`)
    // electron-builder 与 electron-forge 都只是打包器，不影响识别。
    if (deps['electron-builder'] !== undefined) evidence.push('依赖里有 electron-builder')
    return { id: 'electron', confidence: 'high', evidence }
  }

  // --- NW.js ---
  if (deps['nw'] !== undefined || deps['nw-builder'] !== undefined) {
    evidence.push(`依赖里有 ${deps.nw !== undefined ? 'nw' : 'nw-builder'}`)
    return { id: 'nwjs', confidence: 'high', evidence }
  }

  // --- 纯 Node 服务 ---
  const hasEntry = await isFile(join(projectRoot, 'index.js'))
    || await isFile(join(projectRoot, 'server.js'))
    || await isFile(join(projectRoot, 'src', 'index.js'))
  if (hasEntry && pkg?.main !== undefined) {
    evidence.push(`存在入口文件与 package.json main 字段`)
    return { id: 'node', confidence: 'medium', evidence }
  }

  // --- 静态站点 ---
  for (const candidate of ['dist', 'build', 'out']) {
    if (await isFile(join(projectRoot, candidate, 'index.html'))) {
      evidence.push(`${candidate}/index.html 存在`)
      return { id: 'static', confidence: 'medium', evidence }
    }
  }

  return { id: 'static', confidence: 'guess', evidence: ['没找到明确特征，按静态站点处理'] }
}

/**
 * 按框架推断配置。
 *
 * 每种框架的「入口在哪、产物在哪、怎么构建」都不一样，这里把
 * 各自的常识编码进来，让用户只填项目目录就能跑通。
 *
 * @param {string} frameworkId 框架 id。
 * @param {string} projectRoot 项目根目录。
 * @param {object} pkg package.json 内容（可能为 null）。
 * @returns {Promise<object>} 推断出的配置片段。
 */
export async function inferForFramework(frameworkId, projectRoot, pkg) {
  const inferred = {}

  if (frameworkId === 'flutter') {
    // 默认发布目录，可被 mac2win.config.json 覆盖。
    const { readdir } = await import('node:fs/promises')
    for (const candidate of [
      'build/windows/x64/runner/Release',
      'build/windows/runner/Release',
    ]) {
      const dir = join(projectRoot, candidate)
      if (await isDirectory(dir)) {
        const names = await readdir(dir)
        if (names.some((name) => name.toLowerCase().endsWith('.exe'))) {
          inferred.flutterReleaseDir = candidate
          break
        }
      }
    }
  }

  if (frameworkId === 'electron') {
    // Electron 的入口由 package.json 的 main 决定，默认 main.js。
    if (typeof pkg?.main === 'string') inferred.entry = pkg.main
    else if (await isFile(join(projectRoot, 'main.js'))) inferred.entry = 'main.js'
    else if (await isFile(join(projectRoot, 'src', 'main.js'))) inferred.entry = 'src/main.js'
    // 前端产物目录
    for (const candidate of ['dist', 'build', 'out']) {
      if (await isFile(join(projectRoot, candidate, 'index.html'))) {
        inferred.frontendDist = candidate
        break
      }
    }
  }

  if (frameworkId === 'nwjs') {
    // NW.js 的入口是 package.json 的 main，通常指向 html。
    if (typeof pkg?.main === 'string') inferred.entry = pkg.main
    else if (await isFile(join(projectRoot, 'index.html'))) inferred.entry = 'index.html'
  }

  if (frameworkId === 'tauri') {
    // Tauri 的 Node 宿主层（如果有）与前端产物。
    for (const candidate of ['dist', 'build', 'out']) {
      if (await isFile(join(projectRoot, candidate, 'index.html'))) {
        inferred.frontendDist = candidate
        break
      }
    }
    // 宿主入口：常见于 cordis-host / server 这类目录。
    for (const candidate of ['cordis-host/lib/index.js', 'server/lib/index.js', 'host/lib/index.js']) {
      if (await isFile(join(projectRoot, candidate))) {
        inferred.entry = candidate
        break
      }
    }
  }

  if (frameworkId === 'node') {
    if (typeof pkg?.main === 'string') inferred.entry = pkg.main
    else if (await isFile(join(projectRoot, 'index.js'))) inferred.entry = 'index.js'
    else if (await isFile(join(projectRoot, 'src', 'index.js'))) inferred.entry = 'src/index.js'
  }

  return inferred
}

/**
 * 检查框架与目标架构的组合是否可行。
 *
 * @param {string} frameworkId 框架 id。
 * @param {string} target 目标架构。
 * @param {string} [electronVersion] Electron 版本（仅 electron 用）。
 * @returns {{ok: boolean, reason?: string, hint?: string}}
 */
export function checkFrameworkTarget(frameworkId, target, electronVersion) {
  const framework = FRAMEWORKS[frameworkId]
  if (framework === undefined) {
    return { ok: false, reason: `未知框架：${frameworkId}` }
  }

  if (!framework.architectures.includes(target)) {
    return {
      ok: false,
      reason: `${framework.label} 不支持目标架构 ${target}`,
      hint: `可选：${framework.architectures.join(' / ')}`,
    }
  }

  /*
   * Electron 的 ia32 支持在 v44 被移除。
   *
   * 这不是「可能不支持」，是确定的：官方 release 页面从 v44.0.0 起
   * 不再有 `electron-v44.x.x-win32-ia32.zip`。用高版本去要 x86 会得到
   * 一个 404，而那个错误在打包后期才出现，排查成本很高。
   * 所以在预检阶段就拦住，并给出可用的版本。
   */
  if (frameworkId === 'electron' && target === 'x86' && electronVersion !== undefined) {
    const major = Number.parseInt(String(electronVersion).replace(/^[^\d]*/, ''), 10)
    if (Number.isFinite(major) && major >= 44) {
      return {
        ok: false,
        reason: `Electron ${String(major)} 不再发布 win32-ia32 预编译包（v44 起移除）`,
        hint: '用 Electron 43.x 或更低版本打 x86；或用 x64 目标',
      }
    }
  }

  return { ok: true }
}

/**
 * 生成一份「这次打包做了什么、没做什么」的说明。
 *
 * 写进安装目录的 README，也回给界面。用户需要知道产物的能力边界，
 * 否则会在「为什么没有原生窗口」这类问题上浪费半天。
 *
 * @param {string} frameworkId 框架 id。
 * @returns {string[]} 说明行。
 */
export function describeCapabilities(frameworkId) {
  const framework = FRAMEWORKS[frameworkId] ?? FRAMEWORKS.static
  const lines = [`项目类型：${framework.label}`, `说明：${framework.description}`]

  if (framework.nativeShell) {
    lines.push('原生窗口：包含（由框架自带的预编译壳提供）')
    if (frameworkId === 'flutter') {
      lines.push('构建边界：Flutter Windows 产物须由用户在 Windows 上执行 flutter build windows 生成')
    }
  } else if (frameworkId === 'tauri') {
    /*
     * 这句此前写的是「Rust 壳需要 Windows 工具链，无法在 arm64 mac 上编译」。
     *
     * **那个说法是错的。** 2026-11-19 实测：arm64 macOS 上用
     * `cargo xwin build --target i686-pc-windows-msvc` 能编出真实的
     * `PE32 / i386 / windows-gui`（探针 92160 字节）。跨架构编译这条路是通的。
     *
     * 真正拦住完整 Tauri 项目的是另一件事：`tauri-build` 生成 Windows
     * 资源节时要用 `llvm-rc`，而它不是任何现成安装的组成部分（详见
     * `rust-shell.mjs` 里 `llvm-rc` 那一段的注释）。这跟 CPU 架构无关，
     * 在 Intel mac 上一样缺。
     *
     * 产物说明是写给**最终用户**看的，不能把内部实现细节说成「做不到」。
     * 所以这里只陈述产物事实（本次没带原生窗口），不再给架构层面的断言。
     */
    lines.push('原生窗口：本次未包含（Rust 壳需显式开启，且依赖 llvm-rc 等交叉编译工具）')
    lines.push('降级行为：界面通过系统默认浏览器打开，后端服务在后台运行')
  } else {
    lines.push('原生窗口：不包含（这类项目本身没有原生壳）')
    lines.push('降级行为：界面通过系统默认浏览器打开')
  }

  return lines
}
