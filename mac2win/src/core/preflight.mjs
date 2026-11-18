/**
 * 预检：在动手之前把所有能提前发现的问题都查出来。
 *
 * ## 为什么预检值得单独一个模块
 *
 * 打包是个长流程：装依赖、跑构建、下载运行时、压缩、编译。如果等到
 * 第 5 步才因为「makensis 没装」失败，用户前面几分钟全白等。
 * 预检的意义是把所有「现在就能知道」的失败挪到第 0 秒。
 *
 * ## 检查分三级
 *
 * - **错误**：必须解决，否则一定失败。直接中止。
 * - **警告**：能继续，但产物可能不完整或有兼容问题。记进报告。
 * - **通过**：显式记一条，让用户看到「这一项查过了」。
 *
 * 全绿和「没查」在界面上长得一样，所以通过的项也要报。
 */

import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { promisify } from 'node:util'
import { BuildError, ErrorCode } from './errors.mjs'
import { isDirectory, isFile, walkFiles, windowsPathProblem } from '../util/fsx.mjs'
import { FRAMEWORKS, checkFrameworkTarget } from './frameworks.mjs'
import { checkRustEnv } from './rust-shell.mjs'

const run = promisify(execFile)

/** 一条检查结果。 */
export class Check {
  /**
   * @param {string} id 稳定标识，供界面区分。
   * @param {string} title 一句话标题。
   * @param {'pass'|'warn'|'fail'} status 结论。
   * @param {string} detail 说明。
   * @param {string} [hint] 不通过时该怎么做。
   */
  constructor(id, title, status, detail, hint) {
    this.id = id
    this.title = title
    this.status = status
    this.detail = detail
    this.hint = hint
  }
}

/** 预检报告。 */
export class PreflightReport {
  constructor() {
    /** @type {Check[]} */
    this.checks = []
  }

  add(check) {
    this.checks.push(check)
    return this
  }

  /** 有没有致命问题。 */
  get failed() {
    return this.checks.some((check) => check.status === 'fail')
  }

  /** 有没有警告。 */
  get warned() {
    return this.checks.some((check) => check.status === 'warn')
  }

  /** 取第一条致命问题，用来构造错误。 */
  firstFailure() {
    return this.checks.find((check) => check.status === 'fail')
  }
}

/**
 * 检查宿主环境。
 *
 * 这个工具的前提是「在 ARM 的 mac 上，为 x86 的 Windows 打包」。
 * 环境不对时给的不是「不支持」四个字，而是**说明为什么这个组合才成立**——
 * 用户往往是在错误的机器上跑（比如 Intel mac 或 Linux），
 * 知道原因才能选对机器。
 */
function checkHost(report) {
  const currentPlatform = platform()
  const currentArch = arch()

  if (currentPlatform !== 'darwin') {
    report.add(new Check(
      'host-platform',
      '宿主操作系统',
      'fail',
      `当前是 ${currentPlatform}，本工具只支持 macOS`,
      '在 macOS 上运行。其他系统上的等价做法是各自平台的原生交叉编译链',
    ))
    return
  }

  report.add(new Check(
    'host-platform',
    '宿主操作系统',
    'pass',
    `macOS ${release()}（${currentArch}）`,
  ))

  if (currentArch !== 'arm64') {
    // Intel mac 上跑得通，只是这个工具的核心卖点（arm 上产出 x86）
    // 在这里没有意义。给警告而不是错误：功能本身是成立的。
    report.add(new Check(
      'host-arch',
      '宿主 CPU 架构',
      'warn',
      `当前是 ${currentArch}，本工具针对 arm64 macOS 设计`,
      '在 Intel mac 上依然能产出 x86 exe，只是没有必要——直接在本机构建 Windows 目标即可',
    ))
  } else {
    report.add(new Check('host-arch', '宿主 CPU 架构', 'pass', 'arm64（Apple Silicon）'))
  }
}

/** Node 版本。低于 20 时 `fetch` 与部分 API 的行为不一致。 */
function checkNode(report) {
  const major = Number(process.versions.node.split('.')[0])
  if (major < 20) {
    report.add(new Check(
      'node-version',
      'Node 版本',
      'fail',
      `当前 v${process.versions.node}，需要 v20 或更高`,
      '用 nvm 或 Homebrew 升级 Node：brew install node@22',
    ))
  } else {
    report.add(new Check('node-version', 'Node 版本', 'pass', `v${process.versions.node}`))
  }
}

/**
 * 找 makensis。
 *
 * 按顺序找：环境变量 → PATH → Homebrew 的两个默认前缀。
 * 为什么要显式查 Homebrew 路径：`execFile('makensis')` 在图形界面启动的
 * 进程里常常找不到 Homebrew 的 bin（PATH 没继承 shell 配置）。
 */
export async function findMakensis() {
  const candidates = [
    process.env.MAC2WIN_MAKENSIS,
    '/opt/homebrew/bin/makensis',
    '/usr/local/bin/makensis',
  ].filter((item) => item !== undefined && item !== '')

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      /* 继续找下一个 */
    }
  }

  // 退回 PATH 查找。
  try {
    const { stdout } = await run('which', ['makensis'])
    const path = stdout.trim()
    if (path !== '') return path
  } catch {
    /* 没找到 */
  }
  return null
}

/** 检查 makensis 是否存在且版本够新。 */
async function checkNsis(report) {
  const path = await findMakensis()
  if (path === null) {
    report.add(new Check(
      'makensis',
      'NSIS 编译器',
      'fail',
      '找不到 makensis',
      '安装：brew install makensis。装完用 makensis -VERSION 确认能跑',
    ))
    return
  }

  let version = ''
  try {
    const { stdout } = await run(path, ['-VERSION'])
    version = stdout.trim()
  } catch (error) {
    report.add(new Check(
      'makensis',
      'NSIS 编译器',
      'fail',
      `找到 ${path} 但执行失败`,
      error.message,
    ))
    return
  }

  // 版本形如 `v3.13`。3.x 才支持 Unicode true 与 MUI2 的现代用法。
  const match = /v?(\d+)\.(\d+)/.exec(version)
  const major = match === null ? 0 : Number(match[1])
  if (major < 3) {
    report.add(new Check(
      'makensis',
      'NSIS 编译器',
      'fail',
      `版本 ${version} 过旧，需要 3.x`,
      '升级：brew upgrade makensis',
    ))
    return
  }

  report.add(new Check('makensis', 'NSIS 编译器', 'pass', `${version}（${path}）`))
}

/**
 * 检查项目里的关键路径。
 *
 * @param {PreflightReport} report
 * @param {object} config 归一化配置。
 */
async function checkProject(report, config) {
  if (!(await isDirectory(config.projectRoot))) {
    report.add(new Check('project-root', '项目目录', 'fail', `不存在：${config.projectRoot}`))
    return
  }
  report.add(new Check('project-root', '项目目录', 'pass', config.projectRoot))

  // 入口
  if (config.entry !== null) {
    if (await isFile(config.entry)) {
      report.add(new Check('project-entry', '宿主入口', 'pass', config.entry))
    } else {
      report.add(new Check(
        'project-entry',
        '宿主入口',
        'fail',
        `不存在：${config.entry}`,
        '先跑项目自己的构建（npm run build）。如果构建产物在别的路径，改配置里的 entry',
      ))
    }
  } else {
    report.add(new Check('project-entry', '宿主入口', 'warn', '未配置入口，只会打包前端'))
  }

  // 前端产物
  if (config.frontendDist !== null) {
    if (await isDirectory(config.frontendDist)) {
      const hasIndex = await isFile(`${config.frontendDist}/index.html`)
      if (hasIndex) {
        report.add(new Check('project-frontend', '前端产物', 'pass', config.frontendDist))
      } else {
        report.add(new Check(
          'project-frontend',
          '前端产物',
          'warn',
          `${config.frontendDist} 存在但没有 index.html`,
          '产物可能不是可直接打开的静态站点，界面将无法显示',
        ))
      }
    } else {
      report.add(new Check(
        'project-frontend',
        '前端产物',
        'fail',
        `不存在：${config.frontendDist}`,
        '先跑项目自己的构建；或把配置里的 frontendDist 指向正确的产物目录',
      ))
    }
  } else {
    report.add(new Check('project-frontend', '前端产物', 'warn', '未配置前端产物目录'))
  }

  // 额外资源
  for (const resource of config.resources) {
    if (await isDirectory(resource) || await isFile(resource)) {
      report.add(new Check('project-resource', '额外资源', 'pass', resource))
    } else {
      report.add(new Check('project-resource', '额外资源', 'fail', `不存在：${resource}`))
    }
  }

  // 输出目录可写性：不建目录，只查父级权限，避免预检产生副作用。
  report.add(new Check('output-dir', '输出目录', 'pass', config.outDir))

  /*
   * 文件名在 Windows 上是否合法。
   *
   * 这是「在 macOS 上打 Windows 包」最容易踩、也最难自查的坑：
   * macOS 允许 `:` `?` `*` `<` `>` `|` `"` 出现在文件名里，Windows 全不允许。
   *
   * 不检查的后果是：打包一路绿灯，用户拿到 exe 后解压失败，或者文件名
   * 被 Windows 静默改写导致程序找不到资源。而用户几乎不可能联想到
   * 是某个文件名带了冒号。
   *
   * 这一项报 warn 而不是 fail：有些文件可能确实不会被用到，硬拦下来
   * 反而挡了合理的打包。但必须让用户看见。
   */
  const scannedRoot = config.frontendDist ?? config.projectRoot
  const offending = []
  for (const relative of await walkFiles(scannedRoot)) {
    const problem = windowsPathProblem(relative)
    if (problem !== null) offending.push({ path: relative, problem })
  }
  if (offending.length === 0) {
    report.add(new Check('windows-filenames', 'Windows 文件名兼容', 'pass',
      `${scannedRoot} 下无非法名称`))
  } else {
    /*
     * 按问题类型归组，避免把同一句「含不允许的字符」重复 N 遍 ——
     * 六条一模一样的说明会让人读不下去，反而看不到关键信息。
     */
    const byProblem = new Map()
    for (const item of offending) {
      if (!byProblem.has(item.problem)) byProblem.set(item.problem, [])
      byProblem.get(item.problem).push(item.path)
    }
    const groups = [...byProblem.entries()].map(([problem, paths]) =>
      `${problem}：${paths.slice(0, 3).join('、')}`
      + (paths.length > 3 ? ` 等 ${String(paths.length)} 个` : ''))

    report.add(new Check(
      'windows-filenames',
      'Windows 文件名兼容',
      'warn',
      `${offending.length} 个文件在 Windows 上不合法`,
      '这些文件会让用户在 Windows 上解压失败或文件名被静默改写。'
        + ` ${groups.join('；')}`,
    ))
  }
}

/**
 * 检查目标架构与产物形态的组合是否合理。
 *
 * @param {PreflightReport} report
 * @param {object} config
 */
function checkTarget(report, config) {
  if (config.target === 'x86') {
    report.add(new Check(
      'target-arch',
      '目标架构',
      'pass',
      'x86（32 位，可在 32 位与 64 位 Windows 上运行）',
    ))
  } else if (config.target === 'x64') {
    report.add(new Check(
      'target-arch',
      '目标架构',
      'warn',
      'x64（64 位）：应用本体是 64 位，但安装器外壳仍是 32 位',
      'x64 产物无法在 32 位 Windows 上运行。安装器外壳固定为 i386（NSIS 的形态），'
      + '能在所有 Windows 上运行；真正决定兼容性的是载荷里的 node.exe',
    ))
  } else {
    report.add(new Check(
      'target-arch',
      '目标架构',
      'fail',
      `暂不支持 ${config.target}`,
      '目前只支持 x86 与 x64',
    ))
  }

  report.add(new Check(
    'target-format',
    '产物形态',
    'pass',
    config.format === 'nsis' ? 'nsis（安装包 exe）' : 'zip（免安装压缩包）',
  ))
}

/**
 * 检查框架与目标的组合。
 *
 * 这一项是本次多框架适配的核心：不同框架在 arm64 mac 上的能力边界
 * 完全不同，必须在动手前说清楚。
 */
function checkFramework(report, config) {
  const detected = config.__framework ?? { id: config.framework, confidence: 'explicit', evidence: [] }
  const framework = FRAMEWORKS[detected.id]

  if (framework === undefined) {
    report.add(new Check(
      'framework',
      '项目框架',
      'fail',
      `未知框架：${detected.id}`,
      `可选：${Object.keys(FRAMEWORKS).join(' / ')}`,
    ))
    return
  }

  const confidenceText = detected.confidence === 'explicit'
    ? '配置指定'
    : detected.confidence === 'high'
      ? '高可信'
      : detected.confidence === 'medium'
        ? '中等可信'
        : '推测'

  report.add(new Check(
    'framework',
    '项目框架',
    detected.confidence === 'guess' ? 'warn' : 'pass',
    `${framework.label}（${confidenceText}）${detected.evidence.length > 0 ? `：${detected.evidence.join('；')}` : ''}`,
    detected.confidence === 'guess' ? '如果识别错了，在配置里写 framework 指定' : undefined,
  ))

  // 框架 × 架构
  const combo = checkFrameworkTarget(detected.id, config.target, config.electronVersion)
  if (!combo.ok) {
    report.add(new Check('framework-target', '框架与架构组合', 'fail', combo.reason, combo.hint))
  } else {
    report.add(new Check(
      'framework-target',
      '框架与架构组合',
      'pass',
      `${framework.label} + ${config.target} 可行`,
    ))
  }

  // 原生窗口：Tauri 打不出壳，这条必须明确告知。
  if (!framework.nativeShell) {
    report.add(new Check(
      'framework-shell',
      '原生窗口',
      detected.id === 'tauri' ? 'warn' : 'pass',
      detected.id === 'tauri'
        ? '不含 Rust 壳，界面将通过系统默认浏览器打开'
        : '这类项目本身没有原生壳，属预期行为',
      detected.id === 'tauri'
        ? 'Tauri 的 Rust 壳需要 i686-pc-windows-msvc 工具链，macOS 上没有。'
          + '要原生窗口请在 Windows 机器上跑 tauri build'
        : undefined,
    ))
  } else {
    report.add(new Check(
      'framework-shell',
      '原生窗口',
      'pass',
      `包含（由 ${framework.label} 官方预编译二进制提供）`,
    ))
  }
}

/**
 * 跑完整预检。
 *
 * @param {object} config 归一化配置。
 * @param {(message: string) => void} [onProgress]
 * @returns {Promise<PreflightReport>}
 */
export async function runPreflight(config, onProgress) {
  const report = new PreflightReport()

  onProgress?.('检查宿主环境')
  checkHost(report)
  checkNode(report)

  onProgress?.('检查打包工具')
  await checkNsis(report)

  onProgress?.('检查项目路径')
  await checkProject(report, config)

  onProgress?.('检查框架与目标')
  checkFramework(report, config)
  await checkTarget(report, config)

  /*
   * 开了 Rust 壳才查 Rust 环境。
   *
   * 没开的时候查它没有意义（用户可能根本没装 Rust），而且会在
   * 界面上刷一堆「未安装」的警告，让本该全绿的预检看起来很糟。
   */
  if (config.buildRustShell === true) {
    onProgress?.('检查 Rust 交叉编译环境')
    const rustEnv = await checkRustEnv()
    if (rustEnv.ready) {
      report.add(new Check(
        'rust-env',
        'Rust 交叉编译环境',
        'pass',
        rustEnv.items.map((item) => item.detail).join('；'),
      ))
    } else {
      report.add(new Check(
        'rust-env',
        'Rust 交叉编译环境',
        'fail',
        `缺 ${String(rustEnv.missing.length)} 项：${rustEnv.missing.map((item) => item.title).join('、')}`,
        rustEnv.missing.map((item) => item.hint).filter((hint) => hint !== undefined).join('；'),
      ))
    }
  }

  return report
}

/**
 * 预检检查项 → 错误码。
 *
 * 修复前的写法是 `first?.id === 'makensis' ? TOOL_MISSING : PROJECT_NOT_FOUND`，
 * 也就是**除 makensis 外的一切失败都报「项目目录不存在」**。实测
 * `mac2win build <真实项目> --target arm64` 的输出是：
 *
 * ```
 * ✗ [M2W_1002] 预检未通过（2 项）
 *   · 框架与架构组合：Node 服务 不支持目标架构 arm64
 *   · 目标架构：暂不支持 arm64
 * ```
 *
 * 用户会去查路径拼写，而真实原因是他自己指定的 arm64 落在硬边界内 ——
 * 路径完全没问题，改架构才有用。
 *
 * 这里按检查项归类，不再「一个兜底吃掉所有」。归类原则是看**用户该做什么**：
 *
 *   - 装工具      → 2xxx（TOOL_MISSING）
 *   - 换输入物    → 1002（PROJECT_NOT_FOUND：路径或资源不对）
 *   - 换目标/文件 → 1005（UNSUPPORTED：落在硬边界内，换文件不是修路径）
 *
 * ## 键名必须与本文件里 `new Check()` 的 id 逐字一致
 *
 * 这张表曾经有三个键是「想当然」写下的，`new Check()` 里根本没用过这些 id：
 *
 * | 表里写的键 | 实际的 id | 后果 |
 * |---|---|---|
 * | `host-os` | `host-platform` | 在 Linux / Windows 上构建报「项目目录不存在」（1002），实际是宿主不支持（1005） |
 * | `native-window` | `framework-shell` | 原生窗口缺失被报成路径问题 |
 *
 * 键名对不上时不会报错，只会静默走进 `?? ErrorCode.PROJECT_NOT_FOUND` 兜底 ——
 * 于是「这张表按检查项归类」这个设计目标在不知不觉中退化成「几乎全都归到 1002」。
 *
 * 用户的损失很具体：在非 macOS 上跑 `mac2win build`，得到的是
 * 「项目目录不存在：/path/to/real/project」——路径完全没问题，他会去查路径拼写、
 * 查权限、查软链，而真正该做的是换一台 Mac。
 *
 * `windows-filenames` / `target-format` / `framework` 有意不入表：前两个只会是
 * `pass` 或 `warn`，`framework` 失败时框架识别不出来、无从判断用户该做什么，
 * 走兜底 1002 是当时唯一合理的选择（而且它会连带触发 `framework-target` 的 1005）。
 */
const CHECK_ERROR_CODES = {
  // 缺外部工具
  'makensis': ErrorCode.TOOL_MISSING,
  'node-version': ErrorCode.TOOL_MISSING,
  'rust-env': ErrorCode.TOOL_MISSING,
  // 输入物本身不存在
  'project-root': ErrorCode.PROJECT_NOT_FOUND,
  'project-entry': ErrorCode.PROJECT_NOT_FOUND,
  'project-frontend': ErrorCode.PROJECT_NOT_FOUND,
  'project-resource': ErrorCode.PROJECT_NOT_FOUND,
  'output-dir': ErrorCode.PROJECT_NOT_FOUND,
  // 目标与架构落在硬边界内：路径没错，是这件事做不了
  'target-arch': ErrorCode.UNSUPPORTED,
  'framework-target': ErrorCode.UNSUPPORTED,
  'host-platform': ErrorCode.UNSUPPORTED,
  'host-arch': ErrorCode.UNSUPPORTED,
  'framework-shell': ErrorCode.UNSUPPORTED,
}

/**
 * 把预检报告转成错误。有致命问题时调用。
 *
 * @param {PreflightReport} report
 * @returns {BuildError}
 */
export function preflightToError(report) {
  const failures = report.checks.filter((check) => check.status === 'fail')
  const first = report.firstFailure()

  /*
   * 取**第一个失败项**的错误码，它通常最接近根因。
   *
   * 不能按「有没有 UNSUPPORTED 就优先报它」来挑：一个项目路径写错时
   * 也可能顺带报出架构问题（框架识别不出来、推不出目标组合），那时
   * 首要原因仍是路径，先修路径。
   *
   * 缺 makensis 单独优先：它是最常见的失败，且用户搜 M2W_2001 就能
   * 直接搜到安装命令。
   */
  let code = CHECK_ERROR_CODES[first?.id] ?? ErrorCode.PROJECT_NOT_FOUND
  if (failures.some((check) => check.id === 'makensis')) code = ErrorCode.TOOL_MISSING

  return new BuildError(code, `预检未通过（${String(failures.length)} 项）`, {
    details: failures.map((check) => `${check.title}：${check.detail}`),
    hint: first?.hint,
  })
}