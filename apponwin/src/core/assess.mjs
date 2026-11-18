/**
 * `.app` 应用包解析与兼容性评估。
 *
 * ## 这个模块回答什么问题
 *
 * 「这个 macOS 应用，能不能在 Windows + Darling 上跑？」
 *
 * 答案分三级，**不给出虚假的乐观结论**：
 *
 * | 结论 | 含义 |
 * |---|---|
 * | `likely` | 只依赖 Darling 已实现的核心框架，命令行/简单图形程序 |
 * | `unlikely` | 依赖 Darling 明确不支持的框架（Metal / SwiftUI / 私有框架） |
 * | `unknown` | 有依赖无法判定，或应用包结构异常 |
 *
 * ## 为什么评估要基于框架清单
 *
 * Darling 的兼容性是**按框架**给出的，不是按应用。上游自述：命令行工具
 * 基本可用，GUI 程序「basic and experimental」。所以正确的做法是：
 *
 * 1. 扫出应用实际链接了哪些框架（从 Mach-O 的 LC_LOAD_DYLIB 读）
 * 2. 与 Darling 的已知能力清单比对
 * 3. 按「最弱的那个依赖」给出整体结论 —— 木桶效应
 *
 * ## 框架能力清单的来源与时效
 *
 * 下面的清单基于 Darling 上游文档与 issue 跟踪的公开信息整理，
 * **不是一个可以长期保证准确的表**。Darling 在演进，某些框架的支持
 * 状态会变。因此：
 *
 *   - 清单里每一项都标注了置信度
 *   - 输出里明确写出「基于 XXXX 的公开信息，可能已过时」
 *   - `unknown` 类别的框架不会被当成「能跑」
 *
 * 宁可给出「不确定」，也不给错的乐观结论 —— 后者会让用户浪费
 * 一整天去装 Darling 然后失败。
 */

import { readdir, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { BuildError, ErrorCode } from './errors.mjs'
import { parseMachO, isMachO } from './macho.mjs'
import { readPlist } from './plist.mjs'

/**
 * Darling 对各框架的支持状况。
 *
 * `status` 取值：
 *   - `works`      已知可用
 *   - `partial`    部分可用，具体 API 覆盖不明
 *   - `broken`     明确不可用或不稳定
 *   - `unknown`    无公开信息，不能假设可用
 *
 * `confidence` 表示这条判断的可信程度：
 *   - `high`     上游文档或大量实测支持
 *   - `medium`   社区报告一致，但无官方确认
 *   - `low`      单一来源或推断
 */
export const FRAMEWORK_SUPPORT = {
  // ── 基础运行时：Darling 的核心目标，支持度高 ──
  Foundation: { status: 'works', confidence: 'high', note: 'Darling 的核心实现，字符串/集合/文件系统基础' },
  CoreFoundation: { status: 'works', confidence: 'high', note: 'CF 层与 Foundation 一起实现' },
  libSystem: { status: 'works', confidence: 'high', note: 'libc / libdispatch / libxpc 等系统库' },
  Security: { status: 'partial', confidence: 'medium', note: '基础 API 可用，钥匙串与证书链不完整' },
  CoreServices: { status: 'partial', confidence: 'medium', note: '部分子框架缺失' },

  // ── 图形与界面：Darling 的主要短板 ──
  AppKit: { status: 'partial', confidence: 'medium', note: '上游自述「basic and experimental」，简单窗口可显示，控件行为不完整' },
  SwiftUI: { status: 'broken', confidence: 'medium', note: '依赖大量私有 API 与 Metal，实测无法渲染' },
  CoreGraphics: { status: 'partial', confidence: 'medium', note: '2D 绘图基本可用，部分滤镜与色彩空间缺失' },
  CoreAnimation: { status: 'partial', confidence: 'low', note: '图层合成依赖后端，行为不稳定' },
  QuartzCore: { status: 'partial', confidence: 'low', note: '同 CoreAnimation' },
  Metal: { status: 'broken', confidence: 'high', note: '无 GPU 后端，Darling 明确不支持' },
  MetalKit: { status: 'broken', confidence: 'high', note: '依赖 Metal' },
  OpenGL: { status: 'partial', confidence: 'low', note: '软件渲染，性能与兼容性都不可预期' },
  SceneKit: { status: 'broken', confidence: 'high', note: '依赖 Metal' },
  SpriteKit: { status: 'broken', confidence: 'high', note: '依赖 Metal' },
  RealityKit: { status: 'broken', confidence: 'high', note: '依赖 Metal 与 ARKit' },

  // ── 多媒体 ──
  AVFoundation: { status: 'broken', confidence: 'medium', note: '依赖 CoreMedia / VideoToolbox，未实现' },
  CoreMedia: { status: 'broken', confidence: 'medium', note: '未实现' },
  CoreAudio: { status: 'partial', confidence: 'low', note: '部分音频设备接口' },
  AudioToolbox: { status: 'partial', confidence: 'low', note: '基础编解码可用性不明' },

  // ── 网络与数据 ──
  CFNetwork: { status: 'works', confidence: 'medium', note: '基于系统 socket 实现' },
  Network: { status: 'partial', confidence: 'low', note: '新式 Network.framework，覆盖度不明' },
  WebKit: { status: 'broken', confidence: 'high', note: '依赖大量图形与 JIT，未实现' },

  // ── 系统集成：几乎必然失败 ──
  AppIntents: { status: 'broken', confidence: 'medium', note: '依赖系统服务发现' },
  Accessibility: { status: 'broken', confidence: 'medium', note: '辅助功能框架，无对应实现' },
  ApplicationServices: { status: 'partial', confidence: 'low', note: '聚合框架，取决于子框架' },
  ScriptingBridge: { status: 'broken', confidence: 'low', note: 'AppleScript 桥，未实现' },
  Carbon: { status: 'broken', confidence: 'medium', note: '旧版 API，未实现' },
}

/**
 * 框架支持状态 → 严重度。用于「木桶效应」取最差项。
 */
const SEVERITY = {
  works: 0,
  partial: 1,
  unknown: 2,
  broken: 3,
}

/**
 * 取框架支持信息。清单里没有的框架返回 unknown，**不假设可用**。
 *
 * @param {string} name
 */
export function frameworkStatus(name) {
  const known = FRAMEWORK_SUPPORT[name]
  if (known !== undefined) return { name, ...known }
  return {
    name,
    status: 'unknown',
    confidence: 'low',
    note: '无公开支持信息，不能假设可用',
  }
}

/**
 * 解析一个 `.app` 应用包。
 *
 * 输入物不合法时抛 {@link BuildError} 并带契约错误码 —— 不能用裸
 * `Error`，否则 `asBuildError` 会把它兜底成 `AOW_9999`（内部错误），
 * 用户看到「内部错误」会以为是工具的 bug，而实际是路径传错了。
 *
 * @param {string} appPath
 * @returns {Promise<object>}
 */
export async function parseAppBundle(appPath) {
  const appStat = await stat(appPath).catch(() => null)
  if (appStat === null) {
    throw new BuildError(ErrorCode.INPUT_NOT_FOUND,
      `路径不存在：${appPath}`,
      { hint: '确认 .app 的完整路径；可以从 Finder 拖到终端里取' })
  }
  if (!appStat.isDirectory()) {
    throw new BuildError(ErrorCode.INPUT_NOT_FOUND,
      `不是目录：${appPath}`,
      { hint: '.app 在磁盘上是一个目录，不是一个文件' })
  }
  if (!appPath.endsWith('.app')) {
    throw new BuildError(ErrorCode.INPUT_NOT_FOUND,
      `不是 .app 应用包：${appPath}`,
      { hint: '路径必须以 .app 结尾' })
  }

  const contents = join(appPath, 'Contents')
  const plistPath = join(contents, 'Info.plist')

  let info = null
  let plistError = null
  try {
    info = await readPlist(plistPath)
  } catch (error) {
    plistError = String(error)
  }

  const executableName = info?.CFBundleExecutable ?? null
  const mainExecutable = executableName === null
    ? null
    : join(contents, 'MacOS', executableName)

  /*
   * 扫 bundle 内所有 Mach-O。
   *
   * 为什么不止读主可执行文件：一个 .app 里常有 helper、plugin、内嵌
   * framework。主程序可能只依赖 Foundation，但某个 plugin 依赖 Metal ——
   * 那个 plugin 一被加载就崩。所以要全扫，不能只看入口。
   *
   * 限制：只扫 Contents/ 下最多 2000 个文件，避免遇到超大 bundle
   * （如 Xcode 几十万文件）时耗时失控。
   */
  const binaries = await scanBinaries(appPath, 2000)

  const frameworks = new Set()
  const dylibs = new Set()
  for (const binary of binaries) {
    for (const framework of binary.frameworks) frameworks.add(framework)
    for (const dylib of binary.dylibs) dylibs.add(dylib)
  }

  return {
    path: appPath,
    bundleId: info?.CFBundleIdentifier ?? null,
    name: info?.CFBundleDisplayName ?? info?.CFBundleName ?? basename(appPath, '.app'),
    version: info?.CFBundleShortVersionString ?? info?.CFBundleVersion ?? null,
    executableName,
    mainExecutableExists: mainExecutable === null
      ? false
      : await stat(mainExecutable).then((s) => s.isFile()).catch(() => false),
    minimumSystemVersion: info?.LSMinimumSystemVersion ?? null,
    plistError,
    binaries,
    frameworks: [...frameworks].sort(),
    dylibs: [...dylibs].sort(),
    info,
  }
}

/**
 * 扫描目录下的 Mach-O 文件。
 *
 * @param {string} root
 * @param {number} limit 最多检查多少个文件。
 * @returns {Promise<Array<object>>}
 */
async function scanBinaries(root, limit) {
  const out = []
  const queue = ['']
  let visited = 0

  while (queue.length > 0 && visited < limit) {
    const relativePath = queue.shift()
    const absolute = relativePath === '' ? root : join(root, relativePath)

    let children
    try {
      children = await readdir(absolute, { withFileTypes: true })
    } catch {
      continue
    }

    for (const child of children) {
      if (visited >= limit) break
      const childRelative = relativePath === '' ? child.name : `${relativePath}/${child.name}`
      const childAbsolute = join(root, childRelative)

      if (child.isDirectory() && !child.isSymbolicLink()) {
        queue.push(childRelative)
        continue
      }
      if (!child.isFile()) continue

      visited += 1
      try {
        const head = await readHead(childAbsolute, 4)
        if (!isMachO(head)) continue
        const parsed = await parseMachO(childAbsolute)
        out.push({
          path: childRelative,
          kind: parsed.kind,
          architectures: parsed.architectures.map((arch) => arch.cpuName),
          fileType: parsed.architectures[0]?.fileType ?? null,
          dylibs: parsed.dylibs,
          frameworks: parsed.frameworks,
          rpaths: parsed.rpaths,
        })
      } catch {
        // 不是有效 Mach-O 或解析失败：跳过，不影响整体评估
        continue
      }
    }
  }
  return out
}

/**
 * 读文件前 N 字节。
 *
 * @param {string} path
 * @param {number} length
 */
async function readHead(path, length) {
  const { open } = await import('node:fs/promises')
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, 0)
    return buffer
  } finally {
    await handle.close()
  }
}

/**
 * 评估兼容性。
 *
 * @param {object} parsed {@link parseAppBundle} 的返回值。
 * @returns {object}
 */
export function assessCompatibility(parsed) {
  const frameworkDetails = parsed.frameworks.map((name) => frameworkStatus(name))

  /*
   * 整体结论取「最差的框架」。
   *
   * 这是木桶效应：只要有一个 broken 的框架，应用就必然在加载或使用
   * 那个功能时崩溃。不能因为「其它 18 个框架都能跑」就说能跑。
   */
  let worst = 'works'
  for (const detail of frameworkDetails) {
    if (SEVERITY[detail.status] > SEVERITY[worst]) worst = detail.status
  }

  /*
   * 没有任何 Mach-O 时结论是 unknown 而不是 likely。
   *
   * 一个 .app 里找不到任何可执行文件，要么是结构异常，要么是纯资源包。
   * 这种情况说「能跑」毫无依据。
   */
  const hasBinaries = parsed.binaries.length > 0

  let verdict
  const reasons = []

  if (!hasBinaries) {
    verdict = 'unknown'
    reasons.push('bundle 内未找到任何 Mach-O 可执行文件，无法评估')
  } else if (worst === 'broken') {
    verdict = 'unlikely'
    const broken = frameworkDetails.filter((d) => d.status === 'broken')
    reasons.push(`依赖 ${String(broken.length)} 个 Darling 明确不支持的框架`)
    for (const item of broken.slice(0, 5)) {
      reasons.push(`  · ${item.name}：${item.note}`)
    }
  } else if (worst === 'unknown') {
    verdict = 'unknown'
    const unknown = frameworkDetails.filter((d) => d.status === 'unknown')
    reasons.push(`依赖 ${String(unknown.length)} 个无公开支持信息的框架`)
    for (const item of unknown.slice(0, 5)) {
      reasons.push(`  · ${item.name}`)
    }
  } else if (worst === 'partial') {
    verdict = 'unlikely'
    const partial = frameworkDetails.filter((d) => d.status === 'partial')
    reasons.push(`依赖 ${String(partial.length)} 个仅部分支持的框架`)
    for (const item of partial.slice(0, 5)) {
      reasons.push(`  · ${item.name}：${item.note}`)
    }
  } else {
    verdict = 'likely'
    reasons.push('只依赖 Darling 已知可用的核心框架')
  }

  // 架构提示：Darling 在 WSL2 里通常只有 x86_64
  const archs = new Set()
  for (const binary of parsed.binaries) {
    for (const arch of binary.architectures) archs.add(arch)
  }
  const archWarning = []
  if (archs.size > 0 && !archs.has('x86_64')) {
    archWarning.push(
      `应用只含 ${[...archs].join('/')}，不含 x86_64。` +
      'WSL2 里的 Darling 通常只跑 x86_64，可能需要 Rosetta 类转译（Linux 上无对应物）。')
  }

  return {
    verdict,
    worstStatus: worst,
    frameworks: frameworkDetails,
    counts: {
      works: frameworkDetails.filter((d) => d.status === 'works').length,
      partial: frameworkDetails.filter((d) => d.status === 'partial').length,
      broken: frameworkDetails.filter((d) => d.status === 'broken').length,
      unknown: frameworkDetails.filter((d) => d.status === 'unknown').length,
    },
    architectures: [...archs].sort(),
    reasons,
    archWarnings: archWarning,
    /*
     * 时效声明必须每次都带上。
     *
     * 框架支持清单会过时，用户需要知道这个结论是基于什么时点的信息。
     * 不给日期的兼容性判断是不可信的。
     */
    disclaimer:
      '框架支持判断基于 Darling 上游文档与社区公开信息整理，' +
      '并非实测结果，可能随 Darling 版本变化。要确认请跑 apponwin spike。',
  }
}