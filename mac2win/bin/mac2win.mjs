#!/usr/bin/env node
/**
 * mac2win 命令行入口。
 *
 * ## 为什么命令要少
 *
 * 三个子命令覆盖全部场景：`build`（打包）、`verify`（只校验已有产物）、
 * `ui`（起界面）。多一个命令就多一份帮助文档与测试，而这个工具的
 * 核心动作本来只有一个——把项目打成 exe。
 *
 * ## 输出给谁看
 *
 * 终端里跑就是给人看的：阶段用符号分隔、错误用红色、进度不刷屏。
 * 同时全部写进 `build.log`，因为用户贴 issue 时贴的是文件而不是终端截图。
 */

import { parseArgs } from 'node:util'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BuildError, ErrorCode, asBuildError, isCancellation } from '../src/core/errors.mjs'
import { Logger, formatForTerminal, Level } from '../src/core/logger.mjs'
import { describeConfig, resolveConfig } from '../src/core/config.mjs'
import { Builder } from '../src/core/builder.mjs'
import { runPreflight } from '../src/core/preflight.mjs'
import { StageTracker, failureReport, successReport } from '../src/core/report.mjs'
import { verifyArtifact, verifyZip, find7zip } from '../src/verify/artifact.mjs'
import { humanBytes, isDirectory } from '../src/util/fsx.mjs'

/** 版本号。与 package.json 保持一致。 */
const VERSION = '1.0.0'

/** 帮助文本。 */
const HELP = `
mac2win ${VERSION} — 在 ARM 架构的 macOS 上打包 x86 Windows 安装包

用法
  mac2win build <项目目录> [选项]     打包
  mac2win verify <exe 文件>           只校验已有产物
  mac2win ui [项目目录]               打开图形界面
  mac2win doctor                      环境自检（平台、架构、Node、外部工具）

打包选项
  -p, --project <dir>       项目目录（也可作为位置参数）
  -o, --out <dir>           输出目录（默认 <项目>/dist-mac2win）
  -t, --target <arch>       目标架构，默认 x86
  -f, --format <format>     产物形态：nsis（默认）| zip
      --name <name>         产品名
      --version <ver>       版本号
      --entry <path>        宿主入口脚本（相对项目根）
      --frontend <path>     前端产物目录（相对项目根）
      --build <command>     打包前执行的项目构建命令
      --dry-run             只跑预检并打印计划，不下载不构建不落盘
      --also-zip            出安装包的同时额外生成免安装 zip
      --no-verify           跳过产物校验（不推荐）
      --keep-staging        保留中间产物，便于排查
      --compression <type>  lzma（默认）| zlib | bzip2 | none
      --icon <file.ico>     安装包图标
      --framework <name>    强制指定框架：electron / nwjs / tauri / flutter / node / static
      --flutter-release <dir> Flutter Windows 发布目录（默认自动探测）
      --flutter-launcher <path> Flutter 主程序在发布目录内的相对路径
      --electron <ver>      Electron 版本（x86 目标须 ≤43）
      --nwjs <ver>          NW.js 版本
      --runtime <file>      离线运行时（node.exe 或 win-x86 zip）
      --runtime-sha256 <h>  与 --runtime 配套的校验和

图形界面选项
      --port <n>            ui 子命令的监听端口（默认自动挑选空闲端口）
      --no-open             ui 子命令启动后不自动打开浏览器

通用选项
      --json                以 JSON 输出结果（供脚本调用）
      --report              输出统一运行报告（与另外三个方向的契约一致）
      --verbose             输出调试级日志
  -h, --help                显示帮助
  -v, --version             显示版本

示例
  mac2win build ../Ondra
  mac2win build ../Ondra --name "空谷 Ondra" --keep-staging
  mac2win verify ./dist-mac2win/空谷-1.0.0-x86-setup.exe
  mac2win ui
`.trim()

/**
 * 描述「这次构建会做什么」。
 *
 * 给 `--dry-run` 用。每条都写清**具体动作**而不是抽象步骤，
 * 因为用户想确认的正是「它会不会去下 100MB 的 Electron」这类事。
 *
 * @param {object} config 归一化配置。
 * @returns {string[]}
 */
function describePlan(config) {
  const lines = []

  if (config.buildCommand !== null && config.buildCommand !== '') {
    lines.push(`1. 在 ${config.projectRoot} 执行 \`${config.buildCommand}\``)
  } else {
    lines.push('1. 跳过项目构建（未配置 buildCommand，假定产物已就绪）')
  }

  const runtimeNote = config.framework === 'flutter'
    ? '不需要 Node 运行时（Flutter 原生产物自带 exe）'
    : config.runtimeArchive === null
      ? '从 nodejs.org 下载 Node win-x86（约 32 MB，已缓存则复用）'
      : `使用本地运行时 ${config.runtimeArchive}`
  lines.push(`2. 准备 Node 运行时：${runtimeNote}`)

  if (config.framework === 'electron') {
    const electronNote = config.electronArchive === null
      ? `下载 Electron ${config.electronVersion} win32-ia32（约 100 MB，已缓存则复用）`
      : `使用本地 Electron 包 ${config.electronArchive}`
    lines.push(`3. 准备 Electron 运行时：${electronNote}`)
  } else if (config.framework === 'nwjs') {
    const nwjsNote = config.nwjsArchive === null
      ? `下载 NW.js ${config.nwjsVersion} win-ia32（约 90 MB，已缓存则复用）`
      : `使用本地 NW.js 包 ${config.nwjsArchive}`
    lines.push(`3. 准备 NW.js 运行时：${nwjsNote}`)
  } else if (config.framework === 'tauri' && config.buildRustShell === true) {
    lines.push('3. 用 cargo-xwin 编译 Rust 壳（首次 10–30 分钟）')
  } else if (config.framework === 'flutter') {
    lines.push(`3. 使用 Windows 上已构建的 Flutter 发布目录 ${config.flutterReleaseDir ?? '(未配置)'}`)
  } else {
    lines.push('3. 无需额外运行时（走 Node + 启动器）')
  }

  if (config.entry !== null) {
    lines.push(`4. 从 ${config.entry} 出发收集依赖（会拦下原生模块）`)
  } else {
    lines.push('4. 跳过依赖收集（未配置 entry）')
  }

  if (config.frontendDist !== null) {
    lines.push(`5. 暂存前端产物 ${config.frontendDist}，注入桌面壳垫片`)
  } else {
    lines.push('5. 跳过前端（未配置 frontendDist）')
  }

  lines.push(`6. 生成文件清单并计算 SHA-256`)

  const compressionText = {
    lzma: 'LZMA（体积最小，较慢）',
    zlib: 'zlib（最快）',
    bzip2: 'bzip2',
    none: '不压缩（最快，体积最大）',
  }[config.compression] ?? config.compression
  const artifactName = config.artifactName ?? `${config.productName}-${String(config.version).split('-')[0]}-${config.target}-setup.exe`
  lines.push(`7. 用 makensis 打包成 ${config.outDir}/${artifactName}（压缩：${compressionText}）`)

  if (config.verify) {
    lines.push('8. 校验产物：PE 头 + 解包逐文件哈希比对')
  } else {
    lines.push('8. 跳过产物校验（verify: false，不推荐）')
  }

  return lines
}

/**
 * 从产物反推目标架构。
 *
 * ## 为什么从载荷而不是从文件名
 *
 * 文件名（`xxx-x64-setup.exe`）是打包时按配置生成的，可以被改名、
 * 也可能用户手改过。而载荷里的 `node.exe` 是编译进包的真实二进制，
 * 它的 PE 机器类型是**不可伪造的事实**。
 *
 * 校验的价值正在于此：不轻信声明，只认证据。
 *
 * ## 支持两种产物
 *
 * - `.exe`：用 7-Zip 解出载荷再读 node.exe；
 * - `.zip`：直接用内置解包器。
 *
 * 两者都失败时返回 null，让调用方退回默认值并给出警告——
 * 而不是猜一个然后假装验过。
 *
 * @param {string} artifact 产物路径。
 * @param {(message: string) => void} [onProgress]
 * @returns {Promise<'x86' | 'x64' | null>}
 */
async function detectArtifactTarget(artifact, onProgress) {
  const { find7zip } = await import('../src/verify/artifact.mjs')
  const { unzipFile } = await import('../src/core/zip.mjs')
  const { checkWindowsExe } = await import('../src/verify/pe.mjs')
  const { readdir, rm, stat } = await import('node:fs/promises')
  const { join, dirname } = await import('node:path')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)

  const tempDir = join(dirname(artifact), `.detect-${String(process.pid)}`)

  try {
    const info = await stat(artifact)
    if (!info.isFile()) return null

    if (artifact.toLowerCase().endsWith('.zip')) {
      onProgress?.('解 zip 探测架构')
      await unzipFile(artifact, tempDir)
    } else {
      const sevenZip = await find7zip()
      if (sevenZip === null) return null
      onProgress?.('解 NSIS 载荷探测架构')
      await run(sevenZip, ['x', '-y', `-o${tempDir}`, artifact], { maxBuffer: 64 * 1024 * 1024 })
    }

    /*
     * 找 node.exe。
     *
     * exe 产物解出来是 `app/node.exe`；zip 产物是 `<产品名>/node.exe`。
     * 顶层目录名不固定，所以递归找，只认第一个名为 node.exe 的文件。
     */
    const found = await findFileNamed(tempDir, 'node.exe')
    if (found === null) return null

    const result = await checkWindowsExe(found, { gui: false })
    if (result.header === null) return null

    if (result.header.machineName === 'x86-64') return 'x64'
    if (result.header.machineName === 'i386') return 'x86'
    return null
  } catch (error) {
    /*
     * 配置错误必须往上抛，不能吞成「推断不出架构」。
     *
     * 这个 catch 本来是给「解包失败」准备的——载荷坏了、7-Zip 不认这个
     * 包，都该安静地退回默认架构并继续验 PE 头。但 `MAC2WIN_7ZIP` 配错
     * 性质完全不同：用户明确指定了一个用不了的路径，静默回退会让他
     * 以为设置生效了，实际用的却是别处的二进制。
     *
     * 两者的区别是「能不能继续」：解包失败还能验 PE 头，配置错误则
     * 说明用户的前提就是错的，继续下去所有结论都不可信。
     */
    const message = error instanceof Error ? error.message : String(error)
    if (/MAC2WIN_7ZIP/u.test(message)) throw error
    return null
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

/** 在目录里递归找第一个指定名字的文件。 */
async function findFileNamed(root, name) {
  const { readdir } = await import('node:fs/promises')
  const { join } = await import('node:path')

  async function visit(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        const found = await visit(full)
        if (found !== null) return found
      } else if (entry.name === name) {
        return full
      }
    }
    return null
  }

  return visit(root)
}

/**
 * 独立 verify 时从产物文件名推断框架。
 *
 * 文件名是打包阶段的产品名，不能保证含 `flutter`；这只是一个启发式，
 * 用于不把 Flutter 原生产物误判成「缺 node.exe」。最可靠的做法仍是
 * 构建阶段传入 config.framework（builder 已传）。
 */
async function inferVerifyFramework(artifact) {
  const name = artifact.split('/').pop()?.toLowerCase() ?? ''
  return name.includes('flutter') ? 'flutter' : null
}

/** 把命令行参数转成配置覆盖项。只映射用户显式给了的那些。 */
function toOverrides(values) {
  const overrides = {}
  const map = {
    out: 'outDir',
    target: 'target',
    format: 'format',
    name: 'productName',
    version: 'version',
    entry: 'entry',
    frontend: 'frontendDist',
    build: 'buildCommand',
    compression: 'compression',
    icon: 'iconFile',
    runtime: 'runtimeArchive',
    'runtime-sha256': 'runtimeChecksum',
    framework: 'framework',
    'flutter-release': 'flutterReleaseDir',
    'flutter-launcher': 'flutterLauncherRelative',
    electron: 'electronVersion',
    nwjs: 'nwjsVersion',
  }
  for (const [flag, key] of Object.entries(map)) {
    if (values[flag] !== undefined) overrides[key] = values[flag]
  }
  if (values['no-verify'] === true) overrides.verify = false
  if (values['keep-staging'] === true) overrides.keepStaging = true
  if (values['also-zip'] === true) overrides.alsoZip = true
  return overrides
}

/** 打包子命令。 */
async function commandBuild(positional, values) {
  const projectArg = values.project ?? positional[0]
  if (projectArg === undefined) {
    process.stderr.write('缺少项目目录。用法：mac2win build <项目目录>\n')
    process.exitCode = 2
    emitMissingArgument('build', '缺少项目目录', '用法：mac2win build <项目目录>', values)
    return
  }

  const projectRoot = resolve(projectArg)
  const quiet = values.json === true
  const wantReport = values.report === true
  // --json / --report 时 stdout 只能有结构化结果，人类可读日志改走 stderr。
  const logStream = (quiet || wantReport) ? process.stderr : process.stdout

  /*
   * 日志落盘要等确认项目目录真实存在。
   *
   * Logger 构造时会 `mkdirSync(dirname(file))`，如果这里直接把
   * `<projectRoot>/.mac2win-build.log` 传进去，用一个**不存在的路径**
   * 调 build 就会先把那个目录建出来 —— 接着 `resolveConfig` 里
   * 「目录不存在」的检查必然通过（因为它刚被创建），用户拿到的
   * 错误变成「既没有 entry 也没有 frontendDist」，与真实原因
   * （路径写错了）毫无关系。
   *
   * 实测：`mac2win build /tmp/nonexist-xyz` 会在 /tmp 下凭空造出
   * 一个空目录并回报 M2W_1003，而 win2mac 同样的输入正确回报 W2M_1002。
   *
   * 判据用 `isDirectory` 而不是「resolveConfig 是否成功」：目录存在但
   * 配置有错（缺 entry 之类）时，日志**恰恰是最该留下的** —— 那正是
   * 用户要来查的现场。只有目录本身不存在才跳过落盘，那时无处可写。
   */
  const projectDirExists = await isDirectory(projectRoot)
  const logger = new Logger({
    sink: (entry) => {
      logStream.write(`${formatForTerminal(entry)}\n`)
    },
  })
  if (projectDirExists) {
    logger.attachFile(join(projectRoot, '.mac2win-build.log'))
  }

  const controller = new AbortController()
  // Ctrl+C 走取消流程而不是直接退出：让子进程有机会被清理掉。
  const onSigint = () => {
    logger.warn('收到中断信号，正在停止…')
    controller.abort()
  }
  process.on('SIGINT', onSigint)

  // 阶段跟踪器与 Builder 的进度回调联动：报告要能说清「走到哪一步停的」。
  const tracker = new StageTracker()

  try {
    logger.info(`mac2win ${VERSION}，Node ${process.version}，${process.platform}/${process.arch}`)

    const config = await resolveConfig({
      projectRoot,
      overrides: toOverrides(values),
    })

    /*
     * 目录存在但 resolveConfig 失败时，用 config 里的 projectRoot 补齐落盘
     * 路径（正常情况下上面已挂过，这里是 idempotent 的兜底）。
     */
    if (logger.file === undefined && await isDirectory(config.projectRoot)) {
      logger.attachFile(join(config.projectRoot, '.mac2win-build.log'))
    }

    if (values.verbose === true) {
      for (const line of describeConfig(config)) logger.debug(line)
    }

    /*
     * 试运行：只跑预检 + 打印计划，不下载、不构建、不落盘。
     *
     * 用途是「先看看会做什么」——尤其适合第一次跑某个项目时确认
     * 框架识别对不对、目标架构组合是否可行、缺不缺工具。
     * 它**不改动任何东西**：不建输出目录、不碰缓存、不跑项目构建命令。
     */
    if (values['dry-run'] === true) {
      const report = await runPreflight(config, (message) => { logger.debug(message) })
      for (const check of report.checks) {
        if (check.status === 'pass') logger.info(`✓ ${check.title}：${check.detail}`)
        else if (check.status === 'warn') logger.warn(`${check.title}：${check.detail}${check.hint === undefined ? '' : `（${check.hint}）`}`)
        else logger.error(`${check.title}：${check.detail}${check.hint === undefined ? '' : ` → ${check.hint}`}`)
      }

      logger.step('将要执行的动作')
      const plan = describePlan(config)
      for (const line of plan) logger.info(line)

      if (report.failed) {
        logger.error('预检未通过，实际构建会在这里中止')
        process.exitCode = 1
      } else {
        logger.success('预检通过。去掉 --dry-run 即可实际构建')
      }

      if (values.json === true) {
        process.stdout.write(`${JSON.stringify({
          ok: !report.failed,
          dryRun: true,
          config: describeConfig(config),
          plan,
          checks: report.checks,
        }, undefined, 2)}\n`)
      }
      return
    }

    const builder = new Builder({ config, logger, signal: controller.signal })
    /*
     * 进度回调是「进入阶段」的唯一信号，借它驱动 tracker。
     * 进入新阶段即意味着上一个阶段已经跑完，所以顺手把上一个标 ok。
     */
    builder.onProgress = (progress) => {
      if (progress.stage === undefined) return
      if (tracker.current !== null && tracker.current !== progress.stage) {
        tracker.leave(tracker.current)
      }
      if (!tracker.records.has(progress.stage)) tracker.enter(progress.stage)
    }
    const result = await builder.build()
    if (tracker.current !== null) tracker.leave(tracker.current)

    logger.success(`构建完成，耗时 ${(result.durationMs / 1000).toFixed(1)} 秒`)
    logger.success(`产物 ${result.artifact}（${humanBytes(result.artifactSize)}）`)

    if (quiet || wantReport) {
      process.stdout.write(`${JSON.stringify(successReport({
        config,
        result,
        tracker,
      }), undefined, 2)}\n`)
    }
  } catch (error) {
    if (isCancellation(error)) {
      logger.warn('构建已取消')
      tracker.markFailed(ErrorCode.CANCELLED)
      process.exitCode = 130
      if (quiet || wantReport) {
        const cancelled = new BuildError(ErrorCode.CANCELLED, '构建已取消')
        process.stdout.write(`${JSON.stringify(failureReport({
          error: cancelled,
          tracker,
          exitCode: 130,
        }), undefined, 2)}\n`)
      }
      return
    }
    const buildError = asBuildError(error)
    for (const line of buildError.toLines()) logger.error(line)
    tracker.markFailed(buildError.code)
    process.exitCode = exitCodeFor(buildError.code)
    if (quiet || wantReport) {
      process.stdout.write(`${JSON.stringify(failureReport({
        error: buildError,
        tracker,
        exitCode: process.exitCode,
      }), undefined, 2)}\n`)
    }
  } finally {
    process.off('SIGINT', onSigint)
  }
}

/** 校验子命令。 */
async function commandVerify(positional, values) {
  const wantReport = values.report === true
  const tracker = new StageTracker()
  tracker.enter('verify')

  const artifact = positional[0]
  if (artifact === undefined) {
    process.stderr.write('缺少产物路径。用法：mac2win verify <exe 文件>\n')
    process.exitCode = 2
    tracker.markFailed(ErrorCode.CONFIG_MISSING)
    if (wantReport) {
      const missing = new BuildError(ErrorCode.CONFIG_MISSING, '缺少产物路径', {
        hint: '用法：mac2win verify <exe 文件>',
      })
      process.stdout.write(`${JSON.stringify(failureReport({
        error: missing, tracker, exitCode: 2, command: 'verify',
      }), undefined, 2)}\n`)
    }
    return
  }

  const target = resolve(artifact)
  const logger = new Logger({
    // --report / --json 时 stdout 只能有 JSON，日志改走 stderr。
    sink: (entry) => {
      const stream = (wantReport || values.json === true) ? process.stderr : process.stdout
      stream.write(`${formatForTerminal(entry)}\n`)
    },
  })

  logger.step(`校验 ${target}`)

  /*
   * 目标架构：命令行给了就用，否则从产物自己推断。
   *
   * ## 为什么必须能推断
   *
   * `verify` 是独立子命令，用户手里只有一个 exe，没有配置文件可读。
   * 早期实现默认 `expectTarget = 'x86'`，于是校验 x64 产物会报
   * 「载荷内 node.exe 架构：PE32+ / x86-64（需要 i386）」——一个
   * 完全正确的产物被判为不合格。
   *
   * 推断方式：解开载荷看 node.exe 的 PE 机器类型。这是唯一可信的
   * 事实来源，也符合「校验就是验证事实」的定位——不该让用户
   * 先声明答案再让工具去附和。
   */
  let expectTarget = values.target
  if (expectTarget === undefined) {
    try {
      expectTarget = await detectArtifactTarget(target, (message) => { logger.debug(message) })
    } catch (error) {
      /*
       * 只可能是 `MAC2WIN_7ZIP` 配错（其它异常在 detect 内部已退回 null）。
       * 与下面 verify 那段用同一个处理，保证同一个问题在流程的前后
       * 两处给出一致的错误码和提示。
       */
      const message = error instanceof Error ? error.message : String(error)
      logger.error(message)
      logger.info('修正 MAC2WIN_7ZIP，或 unset 掉让它自动查找')
      process.exitCode = exitCodeFor(ErrorCode.CONFIG_INVALID)
      tracker.markFailed(ErrorCode.CONFIG_INVALID)
      if (wantReport) {
        process.stdout.write(`${JSON.stringify(failureReport({
          error: new BuildError(ErrorCode.CONFIG_INVALID, message, {
            hint: '修正 MAC2WIN_7ZIP，或 unset 掉让它自动查找',
          }),
          tracker,
          exitCode: process.exitCode,
          command: 'verify',
        }), undefined, 2)}\n`)
      }
      return
    }
    if (expectTarget !== null) {
      logger.info(`推断目标架构：${expectTarget}（从载荷内 node.exe 的 PE 头）`)
    } else {
      expectTarget = 'x86'
      logger.warn('无法推断目标架构，按 x86 校验')
    }
  }

  /*
   * 按扩展名选校验方式。
   *
   * `.exe` 是 NSIS 容器，验 PE 头 + 解载荷；`.zip` 是标准压缩包，
   * 没有 PE 头可验——早期统一走 exe 路径，于是 zip 会报
   * 「不是 MZ 开头（实际 504b）」，「504b」正是 `PK` 的十六进制，
   * 一个完全正确的 zip 被判为「不是 Windows 可执行文件」。
   */
  const isZip = target.toLowerCase().endsWith('.zip')
  /*
   * `MAC2WIN_7ZIP` 配错时 `find7zip()` 会抛。那是配置问题（1003 / 退出码 2），
   * 不是内部错误——这里必须翻译，否则用户拿到 `M2W_9999` 会以为是程序 bug，
   * 而我们自己的兜底捕获也会把真正的原因埋掉。
   */
  let report
  try {
    report = isZip
      ? await verifyZip({
        artifact: target,
        expectTarget,
        onProgress: (message) => { logger.debug(message) },
      })
      : await verifyArtifact({
        artifact: target,
        expectTarget,
        // 独立 verify 命令可以根据载荷内容自动判断框架，避免 Flutter
        // 原生产物被当作「缺 node.exe」误报。
        framework: await inferVerifyFramework(target),
        onProgress: (message) => { logger.debug(message) },
      })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/MAC2WIN_7ZIP/u.test(message)) {
      logger.error(message)
      logger.info('修正 MAC2WIN_7ZIP，或 unset 掉让它自动查找')
      process.exitCode = exitCodeFor(ErrorCode.CONFIG_INVALID)
      tracker.markFailed(ErrorCode.CONFIG_INVALID)
      if (wantReport) {
        process.stdout.write(`${JSON.stringify(failureReport({
          error: new BuildError(ErrorCode.CONFIG_INVALID, message, {
            hint: '修正 MAC2WIN_7ZIP，或 unset 掉让它自动查找',
          }),
          tracker,
          exitCode: process.exitCode,
          command: 'verify',
        }), undefined, 2)}\n`)
      }
      return
    }
    throw error
  }

  for (const item of report.items) {
    if (item.status === 'pass') logger.info(`✓ ${item.title}：${item.detail}`)
    else if (item.status === 'warn') logger.warn(`${item.title}：${item.detail}`)
    else logger.error(`${item.title}：${item.detail}`)
  }

  /*
   * ## 三态，不是两态
   *
   * 校验有三种结局，早期实现只区分前两种：
   *
   * | ok | complete | 该说什么 | 退出码 |
   * |----|----------|----------|--------|
   * | ✓  | ✓        | 校验通过 | 0 |
   * | ✗  | 任意     | 校验未通过 | 7 |
   * | ✓  | ✗        | 校验未完成 | 5 |
   *
   * 第三行是补上的。原先「没验」也被归进「通过」——用户看到
   * 「✓ 校验通过」就以为 4000 多个文件都比对过了，实际连包都没解开。
   * 按契约，缺 7-Zip 属于「缺少外部依赖」（exit 5 / M2W_2001），
   * 与「产物有问题」（exit 7 / M2W_6001）必须是两条路。
   */
  if (!report.ok) {
    const failures = report.failures
    logger.error(`校验未通过（${String(failures.length)} 项）`)
    process.exitCode = 7
    tracker.markFailed(ErrorCode.VERIFY_FAILED)
  } else if (!report.complete) {
    /*
     * 未完成的校验不能给「通过」二字。
     *
     * 用 `M2W_2001` 而不是自定义错误码：用户搜这个码能直接搜到
     * 「装 7-Zip」，而不是一堆关于产物损坏的排查建议。
     *
     * 阻断原因取自 `report.blockers` 而非写死「缺 7-Zip」——写死的话，
     * 将来若多出别的阻断源（比如 7-Zip 版本过旧不支持 NSIS），提示
     * 就会指错方向。但逐项循环已经把完整说明打过了，这里只报标题，
     * 避免同一段话出现两遍。
     */
    logger.warn(`校验未完成：${String(report.unverified.length)} 项没有验证`)
    for (const blocker of report.blockers) {
      logger.info(`原因：${blocker.title}`)
    }
    process.exitCode = 5
    tracker.markFailed(ErrorCode.TOOL_MISSING)
  } else {
    logger.success('校验通过')
    tracker.leave('verify')
  }

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify({
      ok: report.ok,
      complete: report.complete,
      items: report.items,
      unverified: report.unverified.map((item) => item.id),
    }, undefined, 2)}\n`)
  }
  if (wantReport) {
    process.stdout.write(`${JSON.stringify(report.ok && report.complete
      ? successReport({
        config: { projectRoot: target, target: expectTarget, format: 'nsis' },
        result: {
          artifact: target,
          artifactSize: 0,
          zipArtifact: null,
          zipSize: 0,
          durationMs: 0,
          preflight: { checks: [] },
          verify: report,
        },
        tracker,
        command: 'verify',
      })
      : failureReport({
        error: report.ok
          ? new BuildError(ErrorCode.TOOL_MISSING, `校验未完成：${String(report.unverified.length)} 项没有验证`, {
            details: report.unverified.map((item) => `${item.title}：${item.detail}`),
            hint: '装 7-Zip 后重跑：brew install sevenzip',
          })
          : new BuildError(ErrorCode.VERIFY_FAILED, `校验未通过（${String(report.failures.length)} 项）`, {
            details: report.failures.map((item) => `${item.title}：${item.detail}`),
          }),
        tracker,
        exitCode: process.exitCode ?? 7,
        command: 'verify',
      }), undefined, 2)}\n`)
  }
}

/** 界面子命令。 */
async function commandUi(positional, values) {
  const { startServer } = await import('../src/server/app.mjs')
  const projectRoot = values.project ?? positional[0]
  await startServer({
    projectRoot: projectRoot === undefined ? undefined : resolve(projectRoot),
    port: values.port === undefined ? undefined : Number(values.port),
    open: values['no-open'] !== true,
  })
}

/** 主入口。 */
async function main() {
  // `--version` 有两重语义：单独出现时打印工具版本，带值时指定产物版本号。
  // parseArgs 无法表达「可选值」，因此先在这里判一次：没有跟值时走打印分支。
  const rawArgs = process.argv.slice(2)
  const versionIdx = rawArgs.findIndex((a) => a === '--version')
  const printVersion = rawArgs.includes('-v')
    || (versionIdx !== -1
      && (versionIdx === rawArgs.length - 1 || rawArgs[versionIdx + 1].startsWith('-')))
  if (printVersion) {
    process.stdout.write(`${VERSION}\n`)
    return
  }

  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        project: { type: 'string', short: 'p' },
        out: { type: 'string', short: 'o' },
        target: { type: 'string', short: 't' },
        format: { type: 'string', short: 'f' },
        name: { type: 'string' },
        version: { type: 'string' },
        entry: { type: 'string' },
        frontend: { type: 'string' },
        build: { type: 'string' },
        compression: { type: 'string' },
        icon: { type: 'string' },
        runtime: { type: 'string' },
        'runtime-sha256': { type: 'string' },
        framework: { type: 'string' },
        'flutter-release': { type: 'string' },
        'flutter-launcher': { type: 'string' },
        electron: { type: 'string' },
        nwjs: { type: 'string' },
        'no-verify': { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        'also-zip': { type: 'boolean' },
        'keep-staging': { type: 'boolean' },
        json: { type: 'boolean' },
        report: { type: 'boolean' },
        verbose: { type: 'boolean' },
        port: { type: 'string' },
        'no-open': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}\n`)
    process.exitCode = 2
    return
  }

  const { values, positionals } = parsed

  if (values.help === true) {
    process.stdout.write(`${HELP}\n`)
    return
  }

  const command = positionals[0]

  if (command === 'build') {
    await commandBuild(positionals.slice(1), values)
    return
  }
  if (command === 'verify') {
    await commandVerify(positionals.slice(1), values)
    return
  }
  if (command === 'ui') {
    await commandUi(positionals.slice(1), values)
    return
  }
  if (command === 'doctor') {
    await commandDoctor(values)
    return
  }

  /*
   * 没给子命令时，如果给了目录就当 build 处理 —— 这是便捷用法
   * （`mac2win ./myapp`）。
   *
   * 但**必须区分「像路径的参数」与「拼错的子命令」**：早先的实现
   * 把任何第一个位置参数都当项目路径，于是 `mac2win doctor` 会去
   * 构建一个叫 `doctor` 的目录，报出莫名其妙的配置错误。
   *
   * 判断依据：参数里含路径分隔符、或磁盘上确实存在该路径 → 当路径；
   * 否则视为未知子命令，明确报错并提示。
   */
  if (command !== undefined) {
    const looksLikePath = command.includes('/') || command.includes('\\')
      || command.startsWith('.') || existsSync(command)
    if (looksLikePath) {
      await commandBuild(positionals, values)
      return
    }
    process.stderr.write(`未知子命令：${command}\n`)
    process.stderr.write(`可用：build / verify / ui / doctor\n`)
    process.exitCode = 2
    return
  }

  process.stdout.write(`${HELP}\n`)
}

/**
 * 环境自检。
 *
 * 与另外三个方向的 doctor 对齐：检查平台、架构、Node 版本、外部工具。
 * 这是 console 的并行自检能覆盖 mac2win 的前提 —— 没有这个命令，
 * console 的 doctor 汇总会缺一角。
 */
async function commandDoctor(values) {
  const { existsSync: exists } = await import('node:fs')
  const { execFile } = await import('node:child_process')
  const { platform, arch } = await import('node:os')

  const probe = (cmd, args, validate) => new Promise((resolvePromise) => {
    execFile(cmd, args, { timeout: 5000 }, (error, stdout, stderr) => {
      if (error !== null && error.code === 'ENOENT') {
        resolvePromise({ ok: false, detail: '未安装' })
        return
      }
      const text = `${String(stdout)}${String(stderr)}`.trim()
      /*
       * 不能只看退出码。
       *
       * 沙箱环境里 `7z` 可能是一个转发壳（shim），它以 0 退出但输出
       * 一堆自己的警告，实际并没有跑真正的 7z。只看退出码会误判为
       * 「可用」，然后在真正需要解包时失败。
       *
       * 因此让调用方给一个 validate 函数，验证输出里确实有该工具的
       * 特征内容。
       */
      const firstLine = text.split('\n')[0] ?? ''
      if (validate !== undefined && !validate(text)) {
        resolvePromise({ ok: false, detail: `不可用（输出不符：${firstLine.slice(0, 60)}）` })
        return
      }
      resolvePromise({ ok: true, detail: firstLine })
    })
  })

  const makensis = await probe('makensis', ['-VERSION'], (text) => /v?\d+\.\d+/u.test(text))
  /*
   * 7-Zip 必须走 `find7zip()`，不能只 `probe('7z')`。
   *
   * ## 这里踩过一个自相矛盾的坑
   *
   * 原来这行是 `probe('7z', ...)`——只看 PATH 里有没有 `7z`。而
   * `verify` 用的是 `find7zip()`，它会依次查环境变量、项目自带目录、
   * Homebrew、MacPorts、PATH，最后还会扫 `/Applications/*.app`。
   *
   * 两个不同的判据必然打架。实测那台机器上：
   *
   * - `doctor` 说「[FAIL] 7z 未安装（brew install sevenzip）」
   * - 而同一时刻 `verify` 正用 BlueStacks 里那份 7-Zip 成功解包校验
   *
   * 用户看到 doctor 报 FAIL，会去装 Homebrew 版；装完再跑 doctor 才
   * 变绿。这中间他本来不用做任何事。更糟的是 doctor 的 FAIL 让整个
   * 自检 `allOk = false`、退出码 5——一个完全能用的环境被判定为不可用。
   *
   * 现在两边共用一个判据：doctor 报的就是 verify 实际会用的那个。
   *
   * `find7zip()` 在 `MAC2WIN_7ZIP` 设了但用不了时会抛——那是配置错误，
   * 不是「未安装」。必须区分开：前者要用户改环境变量，后者要用户装东西。
   */
  let sevenZip
  try {
    const sevenZipPath = await find7zip()
    sevenZip = sevenZipPath === null
      ? { ok: false, detail: '未安装（brew install sevenzip）' }
      : { ok: true, detail: sevenZipPath }
  } catch (error) {
    /*
     * 环境变量配错属于「输入配置有问题」，对应退出码 2 / 1003，
     * 而不是「缺依赖」（5）或「内部错误」（1）。用户改一个变量就能解决。
     */
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`✗ [${ErrorCode.CONFIG_INVALID}] ${message}\n`)
    process.stderr.write('  → 修正 MAC2WIN_7ZIP，或 unset 掉让它自动查找\n')
    process.exitCode = exitCodeFor(ErrorCode.CONFIG_INVALID)
    return
  }
  const checks = [
    {
      name: 'platform',
      ok: true,
      detail: platform() === 'darwin'
        ? 'darwin（原生宿主）'
        : `${platform()}（mac2win 面向 macOS，非 darwin 上行为未验证）`,
    },
    { name: 'arch', ok: true, detail: arch() },
    {
      name: 'node',
      ok: Number(process.versions.node.split('.')[0]) >= 20,
      detail: process.versions.node,
    },
    {
      name: 'makensis',
      ok: makensis.ok,
      detail: makensis.ok ? makensis.detail : '未安装（brew install makensis）',
    },
    {
      name: '7z',
      ok: sevenZip.ok,
      detail: sevenZip.ok ? sevenZip.detail : '未安装（brew install sevenzip）',
    },
  ]

  const allOk = checks.every((check) => check.ok)

  /*
   * 契约里的字段名是 `passed`，不是内部的 `ok`；且 `additionalProperties`
   * 为 false——多带一个 `ok` 会被判为不合规。
   *
   * 内部用 `ok` 是因为逐项打印那段写的是 `check.ok ? '[OK  ]' : '[FAIL]'`，
   * 改它要动两条分支；这里做一次显式映射更安全，也让「契约字段」与
   * 「内部字段」的差异显式可见。
   */
  const contractChecks = checks.map((check) => ({
    name: check.name,
    passed: check.ok,
    detail: check.detail,
    /*
     * 自检的每一项都是「必须过」：缺 makensis 就编不出包，缺 7-Zip
     * 就验不了载荷。没有一项是「建议但可忽略」的。
     */
    severity: 'required',
  }))

  if (values.json === true || values.report === true) {
    const tracker = new StageTracker()
    tracker.enter('preflight')
    if (allOk) tracker.leave('preflight')
    else tracker.markFailed(ErrorCode.TOOL_MISSING)

    /*
     * ## 逐项结果必须一起进 JSON
     *
     * 原来这条分支只吐一个统一的 ok / fail，**逐项检查结果全部丢失**。
     * 用 `--json` 的都是脚本与 CI——它们恰恰最需要知道「哪一项不合格」
     * 才能决定装什么。只给一个 false，调用方唯一的办法是再跑一次
     * 不带 `--json` 的人工命令去 grep 文本。
     */
    const payload = allOk
      ? successReport({
        config: { target: 'x86' },
        result: { artifact: null, artifactSize: 0, durationMs: 0 },
        tracker,
        command: 'doctor',
      })
      : failureReport({
        error: new BuildError(ErrorCode.TOOL_MISSING, '环境自检未通过', {
          hint: '见 checks 里 passed 为 false 的项',
          details: checks
            .filter((check) => !check.ok)
            .map((check) => `${check.name}：${check.detail}`),
        }),
        tracker,
        exitCode: 5,
        command: 'doctor',
      })

    process.stdout.write(`${JSON.stringify({ ...payload, checks: contractChecks }, undefined, 2)}\n`)
  } else {
    for (const check of checks) {
      process.stdout.write(
        `${check.ok ? '[OK  ]' : '[FAIL]'} ${check.name.padEnd(12)} ${check.detail}\n`)
    }
  }

  process.exitCode = allOk ? 0 : 5
}

/**
 * 错误码 → 进程退出码。
 *
 * 映射依据 `contracts/exit-codes.json`：段位决定退出码，不是逐个码写死。
 * 这样新增错误码时只需归到对的段位，退出码自动正确。
 *
 * `1005` 是段位内的一个例外，必须单独判：它表示「输入物明确不支持」，
 * 对应退出码 4，而同段的其它码（1002 路径不存在、1003 配置非法、
 * 1004 缺参数）都是退出码 2。契约里 `exit 4 → errorSegment 1005`
 * 与 `exit 2 → 1002/1003/1004` 就是这样分的。
 *
 * 这个区分对脚本有意义：拿错路径重试一次就好（2），而输入物不支持
 * 是重试多少次都无用（4），自动化该停止而不是重跑。
 */
function exitCodeFor(code) {
  // 9999 是兜底段，首位也是 9，必须先判掉，否则会被误映射成 130（中断）。
  if (code.endsWith('_9999')) return 1
  // 1005 同属 1xxx 段，但语义是「明确不支持」，退出码是 4 不是 2。
  if (code.endsWith('_1005')) return 4

  const segment = code.slice(-4, -3)
  if (segment === '1') return 2      // 环境与输入：多半是参数或配置问题
  if (segment === '2') return 5      // 外部工具缺失
  if (segment === '3') return 5      // 运行时也是「缺东西」
  if (segment === '4') return 6      // 输入物处理失败
  if (segment === '5') return 6      // 产物生成失败
  if (segment === '6') return 7      // 产物校验失败
  if (segment === '9') return 130    // 流程控制：取消
  return 1
}

/**
 * 参数缺失时的统一收尾：`--report` 下补一份结构化报告。
 *
 * 参数校验发生在 tracker / try-catch 之前，没法复用各子命令的异常分支。
 * 契约要求 `--report` 下 stdout 永远有一份 JSON，否则 console 拿到空输入
 * 只能显示「未知错误」，用户看不出是自己少敲了个路径。
 *
 * 只在 `--report` 时输出：`--json` 的老结构各方向不同，强行统一会破坏
 * 既有脚本；`--report` 才是四方向共用的契约面。
 *
 * @param {string} command 子命令名
 * @param {string} message 机器可读的失败描述
 * @param {string} usage   给用户的用法提示
 * @param {object} values  parseArgs 结果，用来看是否带 --report
 */
function emitMissingArgument(command, message, usage, values = {}) {
  if (values.report !== true) return
  const error = new BuildError(ErrorCode.CONFIG_MISSING, message, { hint: usage })
  process.stdout.write(`${JSON.stringify(failureReport({
    error,
    tracker: new StageTracker(),
    exitCode: 2,
    command,
  }), undefined, 2)}\n`)
}

main().catch((error) => {
  const buildError = asBuildError(error)
  process.stderr.write(`\n${buildError.toLines().join('\n')}\n`)
  process.exitCode = exitCodeFor(buildError.code)
})
