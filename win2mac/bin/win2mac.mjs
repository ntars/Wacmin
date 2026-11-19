#!/usr/bin/env node
/**
 * win2mac 命令行入口。
 *
 * ## 与 mac2win 的关系
 *
 * 两个方向同构：把「一个项目」打成「对端能直接用的东西」。
 * mac2win 出 NSIS exe，win2mac 出 .app 目录 + zip。因此命令集、
 * 退出码、报告结构全部照搬，只把产物形态换掉。
 *
 * ## 硬边界（写在最前面，避免后期返工）
 *
 * 在 Windows 上**不能**产出 dmg、不能签名、不能公证：
 * `hdiutil` / `codesign` / `notarytool` 都是 macOS 独占工具。
 * 产物只能是 .app 目录，外加一个 zip 便于传输。
 */

import { parseArgs } from 'node:util'
import { existsSync } from 'node:fs'
import { BuildError, ErrorCode, asBuildError, isCancellation } from '../src/core/errors.mjs'
import {
  DIRECTION, StageTracker, exitCodeFor, failureReport, successReport,
} from '../src/core/report.mjs'
import { runBuild } from '../src/core/builder.mjs'
import { humanBytes } from '../src/util/fsx.mjs'

/** 版本号。与 package.json 保持一致。 */
const VERSION = '0.2.0'

/** 帮助文本。 */
const HELP = `
win2mac ${VERSION} — 在 Windows 上打包 macOS 应用包（.app 目录 + zip）

用法
  win2mac build <项目目录> [选项]     打包
  win2mac verify <产物路径>           校验已有产物（.app 目录或 .zip）
  win2mac doctor                      环境自检

打包选项
  -p, --project <dir>       项目目录（也可作为位置参数）
  -o, --out <dir>           输出目录（默认 <项目>/dist-win2mac）
      --name <name>         应用名（默认取项目目录名）
      --version <ver>       版本号
      --executable <path>   主可执行文件（Mach-O），必填
      --payload <path>      应用本体（目录或文件），默认整个项目
      --icon <path>         .icns 图标（Windows 上无法从 .ico 转换）
      --bundle-id <id>      显式指定 CFBundleIdentifier
      --vendor <domain>     厂商片段，用于生成 bundle id
      --associate <ext>     文件关联后缀，可重复（如 --associate .txt）
      --min-macos <ver>     LSMinimumSystemVersion，默认 11.0
      --category <type>     LSApplicationCategoryType
      --keep-work           保留中间 .app 目录
      --no-verify           跳过产物校验（不推荐）
      --strict-host         宿主不是 Windows 时直接拒绝（默认只警告）

通用选项
      --json                以 JSON 输出结果（供脚本调用）
      --report              输出统一运行报告
      --verbose             输出调试级日志
  -h, --help                显示帮助
  -v, --version             显示版本

示例
  win2mac build ./dist --name "我的应用" --executable ./dist/MyApp
  win2mac build ./dist --executable ./dist/MyApp --icon ./AppIcon.icns
  win2mac verify "./我的应用 (Mac).zip"
`.trim()

/**
 * 错误码 → 进程退出码。统一放在 report.mjs，这里只是转出。
 * @param {string} code
 */
function exitCodeOf(code) {
  return exitCodeFor(code)
}

/**
 * 参数缺失时的统一收尾：`--report` / `--json` 下补一份结构化报告。
 *
 * 参数校验发生在任何 tracker / try-catch 之前，所以不能复用各子命令
 * 异常分支里的报告逻辑。这里单独给一份最小但合规的报告。
 *
 * 只在 `--report` 时输出：`--json` 的老结构各方向不同，不强行统一
 * （那会破坏既有脚本），而 `--report` 是四方向共用的契约。
 *
 * @param {string} command 子命令名
 * @param {string} message 给机器看的失败描述
 * @param {string} usage   给用户的用法提示
 * @param {object} values  parseArgs 的结果，用来看是否带了 --report
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

/** 打包子命令。 */
async function commandBuild(positional, values) {
  const projectArg = values.project ?? positional[0]
  if (projectArg === undefined) {
    process.stderr.write('缺少项目目录。用法：win2mac build <项目目录>\n')
    process.exitCode = 2
    /*
     * 参数缺失也必须吐报告。
     *
     * 契约要求 `--report` 下 stdout **永远**有一份 JSON —— 不论成功失败。
     * 早先这条分支只写 stderr 就 return，于是 `win2mac build --report`
     * 漏参数时 stdout 完全为空，console 拿到空输入只能显示「未知错误」，
     * 用户看不出是自己少敲了个目录。
     */
    emitMissingArgument('build', '缺少项目目录', '用法：win2mac build <项目目录>', values)
    return
  }

  /*
   * 三个「输出模式」变量，别混用。
   *
   * ## 为什么必须拆开
   *
   * 早期只有一个 `quiet = values.json === true`，于是 `--report` 模式下
   * 所有人类可读日志照旧写 stdout，直接跟在 JSON 报告后面 —— 报告再也
   * 解析不出来，console 只能拿到一个 `null`。
   *
   * 这个 bug 能藏很久，因为契约检查只跑 doctor（人读文本本来就走了
   * stderr）和「必然失败」的探测（走 catch 分支），**从没跑过成功的
   * build**。真实用户第一次点看板就撞上了。
   *
   * - `quiet`    ：`--json`，输出精简 JSON 而不是人读文本
   * - `wantReport`：`--report`，输出契约报告
   * - `silent`   ：两者任一，人读日志一律静默（或改走 stderr）
   */
  const quiet = values.json === true
  const wantReport = values.report === true
  const silent = quiet || wantReport
  const tracker = new StageTracker()
  const log = (message) => {
    if (!silent) process.stdout.write(`${message}\n`)
  }

  try {
    /*
     * 宿主校验：非 Windows 时**警告而不拒绝**。
     *
     * 原骨架是直接报 HOST_UNSUPPORTED 退出。改掉的理由：
     *
     *   1. 打包本身是纯文件操作（复制、写 XML、压 zip），任何平台都能做。
     *      真正只能在 Windows 上做的是「构建 Windows 侧的原生产物」，
     *      而 win2mac 本来就不做那件事（它接收已构建好的可执行文件）。
     *   2. 拒绝会让 macOS 上的开发者无法自测，也让 CI 必须跑 Windows。
     *   3. 在 macOS 上跑反而**更安全**：verify 能调 plutil 做权威校验，
     *      这是 Windows 上做不到的。
     *
     * 所以改成警告，把判断权交给用户。`--strict-host` 可恢复旧的严格行为。
     *
     * ## 严格模式用 1005 而不是 1001
     *
     * 「宿主不是 Windows」落在**硬边界**里：路径没错、参数没错，是这台
     * 机器做不了这件事。契约里 `exit 4 → 1005`（明确不支持），mac2win
     * 的 `host-platform` 检查项也是归到 `UNSUPPORTED`（1005）。
     *
     * 早先这里抛 `HOST_UNSUPPORTED`（1001），而契约的 13 条退出码里
     * **没有任何一条声明 1001**，于是 `exitCodeFor('W2M_1001')` 按段位
     * 兜底给出 2 —— 报告里是 `exitCode 2` 配 `W2M_1001`，
     * `node contracts/validate.mjs --report r.json --exit-code 2` 直接报红。
     * 用户拿到的信号是「参数错误」，会去查路径拼写，而真正该做的
     * 是换机器或去掉 `--strict-host`。
     */
    tracker.enter('preflight')
    const hostWarnings = []
    if (process.platform !== 'win32') {
      const message = `当前宿主是 ${process.platform}，不是 Windows。` +
        '打包本身不受影响，但产物是给 macOS 用的 —— ' +
        '请在 macOS 上打开一次确认能运行。'
      hostWarnings.push(message)
      if (values['strict-host'] === true) {
        throw new BuildError(ErrorCode.UNSUPPORTED, message, {
          hint: '去掉 --strict-host，或换到 Windows 上运行',
        })
      }
      if (!quiet) process.stderr.write(`[WARN] ${message}\n`)
    }
    tracker.leave('preflight')

    const result = await runBuild({
      projectRoot: projectArg,
      outDir: values.out ?? `${projectArg}/dist-win2mac`,
      appName: values.name ?? undefined,
      version: values.version,
      executable: values.executable,
      payload: values.payload,
      icon: values.icon,
      bundleId: values['bundle-id'],
      vendor: values.vendor,
      fileAssociations: values.associate,
      minMacOS: values['min-macos'],
      category: values.category,
      noVerify: values['no-verify'] === true,
      keepWork: values['keep-work'] === true,
      tracker,
      onProgress: silent ? undefined : (message) => { log(`  ${message}`) },
    })

    const allWarnings = [...hostWarnings, ...result.warnings]

    if (values.report === true) {
      process.stdout.write(`${JSON.stringify(successReport({
        config: {
          target: 'arm64',
          appName: result.appName,
          bundleId: result.bundleId,
        },
        result: {
          artifact: result.artifact,
          artifactSize: result.bytes,
          durationMs: Date.now() - tracker.startedAt,
        },
        tracker,
        command: 'build',
      }), undefined, 2)}\n`)
    } else if (quiet) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        artifact: result.artifact,
        appDir: result.appDir,
        appName: result.appName,
        bundleId: result.bundleId,
        bytes: result.bytes,
        files: result.files,
        dirs: result.dirs,
        symlinks: result.symlinks,
        warnings: allWarnings,
      }, undefined, 2)}\n`)
    } else {
      log('')
      log(`产物      ${result.artifact}`)
      log(`应用名    ${result.appName}`)
      log(`Bundle ID ${result.bundleId}`)
      log(`内容      ${String(result.files)} 文件 / ${String(result.dirs)} 目录` +
        (result.symlinks > 0 ? ` / ${String(result.symlinks)} 符号链接` : ''))
      log(`大小      ${humanBytes(result.bytes)}`)
      if (result.appDir !== null) log(`中间目录  ${result.appDir}（--keep-work 保留）`)
      for (const warning of allWarnings) log(`  注意：${warning}`)
      log('')
      log('解压后拖进 /Applications 即可使用。首次打开会触发 Gatekeeper 提示（未签名）。')
    }
  } catch (error) {
    if (isCancellation(error)) {
      tracker.markFailed(ErrorCode.CANCELLED)
      process.exitCode = 130
      if (silent) {
        process.stdout.write(`${JSON.stringify(failureReport({
          error: new BuildError(ErrorCode.CANCELLED, '构建已取消'),
          tracker,
          exitCode: 130,
          command: 'build',
        }), undefined, 2)}\n`)
      }
      return
    }
    const buildError = asBuildError(error)
    tracker.markFailed(buildError.code)
    for (const line of buildError.toLines()) process.stderr.write(`${line}\n`)
    process.exitCode = exitCodeOf(buildError.code)
    /*
     * `--report` 与 `--json` 在失败路径上都要吐结构化结果。
     *
     * 早先这里只看 `quiet`，于是 `--report` 的失败分支什么都不输出，
     * console 侧表现为「没有报告」而不是「报告里写着失败原因」——
     * 看板上只剩一个空白的失败，用户无从判断是参数错了还是环境缺工具。
     */
    if (silent) {
      process.stdout.write(`${JSON.stringify(failureReport({
        error: buildError,
        tracker,
        exitCode: process.exitCode,
        command: 'build',
      }), undefined, 2)}\n`)
    }
  }
}

/**
 * 校验子命令。
 *
 * 支持两种输入：
 *   - `.app` 目录 → 走 verifyBundle
 *   - `.zip` 文件 → 走 verifyZip（重点查权限位）
 */
async function commandVerify(positional, values = {}) {
  const target = positional[0]
  if (target === undefined) {
    process.stderr.write('缺少产物路径。用法：win2mac verify <产物路径>\n')
    process.exitCode = 2
    // 同 build：--report 下必须有报告，否则 console 拿到空输入
    emitMissingArgument('verify', '缺少产物路径', '用法：win2mac verify <产物路径>', values)
    return
  }

  const { verifyBundle, verifyZip } = await import('../src/core/verify.mjs')
  const { isDirectory, isFile } = await import('../src/util/fsx.mjs')
  const { basename } = await import('node:path')

  /*
   * tracker 在这里而不是在 catch 里建。
   *
   * 成功路径的契约报告也要有 `stages`，而 StageTracker 是它唯一的来源。
   * 早先只在失败分支临时 new 了一个，成功路径想输出报告时无处可取。
   */
  const tracker = new StageTracker()

  let result
  try {
    if (await isDirectory(target)) {
      result = await verifyBundle(target)
    } else if (await isFile(target) && target.toLowerCase().endsWith('.zip')) {
      // 从 zip 名反推顶层目录名：`X (Mac).zip` → `X (Mac).app`
      const appDirName = basename(target).replace(/\.zip$/iu, '.app')
      result = await verifyZip(target, appDirName)
    } else {
      throw new BuildError(ErrorCode.INPUT_NOT_FOUND,
        `不支持的产物类型：${target}`,
        { hint: '传 .app 目录或 .zip 文件' })
    }
  } catch (error) {
    const buildError = asBuildError(error)
    for (const line of buildError.toLines()) process.stderr.write(`${line}\n`)
    process.exitCode = exitCodeOf(buildError.code)
    /*
     * 失败路径也要输出契约报告。
     *
     * 早先这里直接 return，导致 --report 模式下 stdout 空无一物，
     * console 的契约检查会判为「没有输出报告」。契约要求所有命令
     * 在 --report 下都输出报告，成功失败都一样。
     */
    if (values.json === true || values.report === true) {
      // markFailed 只在有 current 阶段时生效，先进入 verify 阶段
      tracker.enter('verify')
      tracker.markFailed(buildError.code)
      process.stdout.write(`${JSON.stringify(failureReport({
        error: buildError,
        tracker,
        exitCode: process.exitCode,
        command: 'verify',
      }), undefined, 2)}\n`)
    }
    return
  }

  tracker.enter('verify')
  if (result.ok) tracker.leave('verify')
  else tracker.markFailed(ErrorCode.VERIFY_FAILED)

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify({
      ok: result.ok,
      checks: result.checks,
      warnings: result.warnings,
    }, undefined, 2)}\n`)
  } else if (values.report !== true) {
    for (const check of result.checks) {
      const mark = check.ok ? '[OK  ]' : '[FAIL]'
      const detail = check.detail === '' ? '' : `  ${check.detail}`
      process.stdout.write(`${mark} ${check.name.padEnd(22)}${detail}\n`)
    }
    for (const warning of result.warnings) {
      process.stdout.write(`[WARN] ${warning}\n`)
    }
  }
  process.exitCode = result.ok ? 0 : exitCodeOf(ErrorCode.VERIFY_FAILED)

  /*
   * `--report` 的 verify 也必须是契约报告。
   *
   * 早先这里跟 `--json` 共用一个分支，输出的 `{ok, checks, warnings}`
   * 三字段结构 —— 它有 `checks` 但没有 `direction` / `stages` /
   * `exitCode`，契约检查会判「缺字段」。verify 是独立子命令，人经常
   * 单独调它，所以它的成功路径同样要合规。
   *
   * 校验项映射到 `checks`：契约要求每项有布尔 `passed`，而 verify
   * 内部用的是 `ok`，这里做一次显式转换而不是让前端兼容两套字段名。
   */
  if (values.report === true) {
    const verifyChecks = result.checks.map((check) => ({
      name: check.name,
      passed: check.ok === true,
      detail: check.detail ?? '',
    }))
    process.stdout.write(`${JSON.stringify(result.ok
      ? successReport({
        config: { target: 'arm64' },
        result: { artifact: target, artifactSize: 0, durationMs: 0 },
        tracker,
        command: 'verify',
        checks: verifyChecks,
        warnings: result.warnings,
      })
      : failureReport({
        error: new BuildError(ErrorCode.VERIFY_FAILED,
          `产物校验未通过（${String(result.checks.filter((c) => !c.ok).length)} 项）`, {
            details: result.checks.filter((c) => !c.ok)
              .map((c) => `${c.name}：${c.detail}`),
          }),
        tracker,
        exitCode: process.exitCode,
        command: 'verify',
        checks: verifyChecks,
        warnings: result.warnings,
      }), undefined, 2)}\n`)
  }
}

/**
 * 探测宿主上的可选工具。
 *
 * 这些工具**都不是必需**的 —— 它们只影响校验的深度：
 *
 *   - `plutil`：macOS 上有，能对 Info.plist 做权威校验
 *   - `codesign`：macOS 上有，但 win2mac 不做签名（无证书）
 *   - `unzip`：用来在开发机上抽查产物，不影响打包
 *
 * 缺失时只提示「校验深度降低」，不阻塞任何流程。
 */
async function hostToolChecks() {
  const { execFile } = await import('node:child_process')
  /*
   * 用 `-help` 而不是 `--version` 探测。
   *
   * `plutil --version` 在 macOS 上会以非 0 退出（它不认识这个参数），
   * 用它判断会误报「不可用」。`-help` 虽也非 0，但错误信息里含用法，
   * 更稳的判断是「能否执行成功」——这里直接看 stderr 是否为空。
   */
  const probe = (command, args) => new Promise((resolve) => {
    execFile(command, args, { timeout: 5000 }, (error, stdout, stderr) => {
      // 命令不存在时 error.code 是 'ENOENT'
      if (error !== null && error.code === 'ENOENT') {
        resolve(false)
        return
      }
      resolve(`${String(stdout)}${String(stderr)}`.trim().length > 0)
    })
  })

  const checks = []
  const plutil = process.platform === 'darwin' ? await probe('plutil', ['-help']) : false
  checks.push({
    name: 'plutil',
    ok: true,
    detail: plutil
      ? '可用（Info.plist 可做权威校验）'
      : '不可用（仅在 macOS 上有；plist 校验退化为文本级检查）',
  })
  return checks
}

/** 环境自检。 */
async function commandDoctor(values) {
  const tracker = new StageTracker()
  tracker.enter('preflight')
  const checks = [
    /*
     * platform 不再作为硬性失败项。
     *
     * 打包是纯文件操作，非 Windows 也能做（macOS 上反而能调 plutil
     * 做权威校验）。这里标 ok=true 并在 detail 里说明，让用户知道
     * 「当前不是 Windows」但不至于被拦住。
     */
    {
      name: 'platform',
      ok: true,
      detail: process.platform === 'win32'
        ? 'win32（原生宿主）'
        : `${process.platform}（非 Windows，打包可用但需在 macOS 上验证产物）`,
    },
    { name: 'arch', ok: true, detail: process.arch },
    { name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 20, detail: process.versions.node },
    ...await hostToolChecks(),
  ]
  const allOk = checks.every((check) => check.ok)
  /*
   * 失败项只可能是 Node 版本过低 —— platform / arch / plutil 都是 ok=true
   * 的说明项，永远不会让 allOk 变假。
   *
   * 所以归码用 `TOOL_OUTDATED`（2002，退出码 5），而不是 `HOST_UNSUPPORTED`
   * （1001）。后者是「宿主不是 Windows」，与本分支的唯一实际失败原因
   * 无关；而且退出码 5 在契约里只对应 2001/2002，配 1001 会被
   * `contracts/validate.mjs` 判为不一致。
   */
  const failCode = ErrorCode.TOOL_OUTDATED
  if (allOk) tracker.leave('preflight')
  else tracker.markFailed(failCode)

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify({ direction: DIRECTION, checks }, undefined, 2)}\n`)
  } else if (values.report !== true) {
    // --report 时 stdout 只能有报告，人类可读文本改走 stderr。
    for (const check of checks) {
      process.stderr.write(`${check.ok ? '[OK  ]' : '[FAIL]'} ${check.name.padEnd(12)} ${check.detail}\n`)
    }
  }
  if (values.report === true) {
    process.stdout.write(`${JSON.stringify(allOk
      ? successReport({ config: { target: 'arm64' }, result: { artifact: null, artifactSize: 0, durationMs: 0 }, tracker, command: 'doctor' })
      : failureReport({
        error: new BuildError(failCode, `环境自检未通过：Node ${process.versions.node} 低于要求`, {
          hint: '用 nvm 或 Homebrew 升级到 Node 20 或更高',
        }),
        tracker,
        exitCode: 5,
        command: 'doctor',
      }), undefined, 2)}\n`)
  }
  process.exitCode = allOk ? 0 : 5
}

/** 主入口。 */
async function main() {
  // `--version` 双语义：单独出现打印工具版本，带值时指定产物版本号。
  const rawArgs = process.argv.slice(2)
  const versionIdx = rawArgs.findIndex((arg) => arg === '--version')
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
        name: { type: 'string' },
        version: { type: 'string' },
        executable: { type: 'string' },
        payload: { type: 'string' },
        icon: { type: 'string' },
        'bundle-id': { type: 'string' },
        vendor: { type: 'string' },
        associate: { type: 'string', multiple: true },
        'min-macos': { type: 'string' },
        category: { type: 'string' },
        'keep-work': { type: 'boolean' },
        'no-verify': { type: 'boolean' },
        'strict-host': { type: 'boolean' },
        json: { type: 'boolean' },
        report: { type: 'boolean' },
        verbose: { type: 'boolean' },
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
  if (command === 'doctor') {
    await commandDoctor(values)
    return
  }
  /*
   * 没给子命令时，如果给了目录就当 build 处理 —— 这是便捷用法
   * （`win2mac ./myapp`）。
   *
   * 但必须区分「像路径的参数」与「拼错的子命令」。早先的实现把任何
   * 第一个位置参数都当项目路径，于是：
   *
   *   win2mac biuld ./proj
   *     → [W2M_1002] 项目目录不存在：/…/biuld
   *
   * 用户看到的是「项目目录不存在」，会去查路径、查权限、查项目本身，
   * 而真正的原因是 `build` 拼错了。mac2win 已经踩过这个坑并修掉了
   * （见那边的同名注释），这里补齐同样的判断。
   *
   * 判断依据：参数里含路径分隔符、以 `.` 开头、或磁盘上确实存在该
   * 路径 → 当路径；否则视为未知子命令，明确报错并给出可用清单。
   */
  if (command !== undefined) {
    const looksLikePath = command.includes('/') || command.includes('\\')
      || command.startsWith('.') || existsSync(command)
    if (looksLikePath) {
      await commandBuild(positionals, values)
      return
    }
    process.stderr.write(`未知子命令：${command}\n`)
    process.stderr.write(`可用：build / verify / doctor\n`)
    process.exitCode = 2
    return
  }

  process.stdout.write(`${HELP}\n`)
}

main().catch((error) => {
  const buildError = asBuildError(error)
  process.stderr.write(`\n${buildError.toLines().join('\n')}\n`)
  process.exitCode = exitCodeFor(buildError.code)
})