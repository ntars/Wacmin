#!/usr/bin/env node
/**
 * apponwin 命令行入口。
 *
 * ## 为什么这个方向只到「评估」为止
 *
 * 另外三个方向都有成熟底座：mac2win 靠 NSIS 与预编译运行时，
 * ExeOnMac 靠 Wine + Rosetta 2，Win2Mac 靠 zip 与 plist。
 * AppOnWin 要的是「在 Windows 上跑 macOS 程序」，唯一开源路径是
 * Darling——它官方只支持 Linux，Windows 需经 WSL2，GUI 支持被
 * 上游自己标注为「basic and experimental」。
 *
 * 所以本阶段只做两件确定能做的事：
 *   1. 解析 .app 包（Mach-O 头、Info.plist、依赖框架）
 *   2. 给出兼容性评估结论
 * 打包与运行留到 spike 结论出来之后再定。
 */

import { parseArgs } from 'node:util'
import { BuildError, ErrorCode, asBuildError, isCancellation } from '../src/core/errors.mjs'
import {
  DIRECTION, StageTracker, exitCodeFor, failureReport, successReport,
} from '../src/core/report.mjs'
import { assessCompatibility, parseAppBundle } from '../src/core/assess.mjs'
import { runSpike } from '../src/core/spike.mjs'

/** 版本号。与 package.json 保持一致。 */
const VERSION = '0.2.0'

/** 帮助文本。 */
const HELP = `
apponwin ${VERSION} — 在 Windows 上运行 macOS 应用（兼容性评估阶段）

用法
  apponwin assess <应用包.app>          评估兼容性（解析 + 框架判定）
  apponwin parse <应用包.app>           只解析结构，不做判定
  apponwin spike [--sample X] [--app Y] 三条门槛可行性验证
  apponwin doctor                       环境自检

选项
      --sample <path>       门槛 1 用的 Mach-O 样本
      --app <path>          门槛 3 用的 .app 样本
      --json                以 JSON 输出结果（供脚本调用）
      --report              输出统一运行报告
      --verbose             输出调试级日志
  -h, --help                显示帮助
  -v, --version             显示版本

退出码
  0   成功 / spike 通过
  1   spike 实测不通过（方向不成立）
  2   用法错误
  5   spike 未验证（环境不具备，不能算通过）

说明
  assess 与 parse 是纯读操作，任何平台都能跑。
  「能否真的运行」必须用 spike 在 Windows + WSL2 + Darling 上验证。
  底座 Darling 官方仅支持 Linux，GUI 支持被上游标注为实验性。
`.trim()

/** 评估子命令。 */
async function commandAssess(positional, values) {
  const appArg = positional[0]
  if (appArg === undefined) {
    process.stderr.write('缺少应用包路径。用法：apponwin assess <应用包.app>\n')
    process.exitCode = 2
    emitMissingArgument('assess', '缺少应用包路径', '用法：apponwin assess <应用包.app>', values)
    return
  }

  /*
   * 输出模式变量，语义见 win2mac 的同名注释。
   *
   * 关键点：`--report` 时 stdout 只能有 JSON 报告。早先只用
   * `quiet = values.json`，于是 `--report` 下人类可读文本照旧写 stdout，
   * 报告被冲成 `null`。assess 是这里最常用的命令，坏得最明显。
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
     * 预检：解析 .app 与评估框架依赖都是纯读操作，任何平台都能做。
     *
     * 原骨架在非 Windows 上直接报 HOST_UNSUPPORTED，这会挡住真正有用的
     * 场景 —— 应用包通常在 macOS 上，用户想在 macOS 上先看「这应用
     * 在 Darling 上有没有戏」，然后再决定要不要装 WSL2。
     *
     * 需要 Windows 的是「真的跑起来」，那是 spike 与运行时阶段的事，
     * 由 `spike` 子命令单独负责。
     */
    tracker.enter('preflight')
    const hostWarnings = []
    if (process.platform !== 'win32') {
      const message = `当前宿主是 ${process.platform}。解析与评估不受影响，` +
        '但「能否真的运行」必须在 Windows + WSL2 + Darling 上验证（用 apponwin spike）。'
      hostWarnings.push(message)
      if (!quiet) process.stderr.write(`[WARN] ${message}\n`)
    }
    tracker.leave('preflight')

    // ── parse ────────────────────────────────────────────────────────────
    tracker.enter('parse')
    const parsed = await parseAppBundle(appArg)
    tracker.leave('parse')

    // ── assess ───────────────────────────────────────────────────────────
    tracker.enter('assess')
    const assessment = assessCompatibility(parsed)
    tracker.leave('assess')

    const payload = {
      ok: true,
      app: parsed.path,
      name: parsed.name,
      bundleId: parsed.bundleId,
      version: parsed.version,
      executable: parsed.executableName,
      mainExecutableExists: parsed.mainExecutableExists,
      minimumSystemVersion: parsed.minimumSystemVersion,
      binaries: parsed.binaries.map((binary) => ({
        path: binary.path,
        architectures: binary.architectures,
        frameworks: binary.frameworks,
      })),
      frameworks: assessment.frameworks,
      architectures: assessment.architectures,
      verdict: assessment.verdict,
      counts: assessment.counts,
      reasons: assessment.reasons,
      archWarnings: assessment.archWarnings,
      disclaimer: assessment.disclaimer,
      warnings: [...hostWarnings, ...assessment.archWarnings],
    }

    if (values.report === true) {
      process.stdout.write(`${JSON.stringify(successReport({
        config: { target: 'x86_64', appName: parsed.name },
        result: {
          artifact: null,
          artifactSize: 0,
          durationMs: Date.now() - tracker.startedAt,
        },
        tracker,
        command: 'assess',
      }), undefined, 2)}\n`)
    } else if (quiet) {
      process.stdout.write(`${JSON.stringify(payload, undefined, 2)}\n`)
    } else {
      log('')
      log(`应用      ${parsed.name}`)
      log(`Bundle ID ${parsed.bundleId ?? '-'}`)
      log(`版本      ${parsed.version ?? '-'}`)
      log(`主程序    ${parsed.executableName ?? '-'}` +
        (parsed.mainExecutableExists ? '' : '（文件不存在！）'))
      /*
       * Info.plist 解析失败必须在主输出里说清楚。
       *
       * 早先只写 stderr，人类可读输出里看不到 —— 用户会看到「结论：无法判定」
       * 却不知道为什么，而这恰恰是最需要解释的情况。plist 坏了意味着
       * 后续所有判断（主程序、版本、最低系统）都无从谈起。
       */
      if (parsed.plistError !== null) {
        log(`          ⚠ Info.plist 解析失败：${parsed.plistError}`)
        log('            这会让主程序、版本、最低系统版本都无法读取。')
      }
      log(`最低系统  ${parsed.minimumSystemVersion ?? '-'}`)
      log(`架构      ${assessment.architectures.join(', ') || '未知'}`)
      log(`二进制    ${String(parsed.binaries.length)} 个，依赖 ${String(parsed.frameworks.length)} 个框架`)
      log('')
      log(`结论      ${verdictLabel(assessment.verdict)}`)
      for (const reason of assessment.reasons) log(`          ${reason}`)
      log('')
      log('框架明细')
      for (const detail of assessment.frameworks) {
        const mark = statusMark(detail.status)
        log(`  ${mark} ${detail.name.padEnd(22)} ${detail.status.padEnd(8)} ${detail.note}`)
      }
      log('')
      log(`统计      可用 ${String(assessment.counts.works)} / ` +
        `部分 ${String(assessment.counts.partial)} / ` +
        `不可用 ${String(assessment.counts.broken)} / ` +
        `未知 ${String(assessment.counts.unknown)}`)
      for (const warning of hostWarnings) log(`  注意：${warning}`)
      for (const warning of assessment.archWarnings) log(`  注意：${warning}`)
      log('')
      log(`声明      ${assessment.disclaimer}`)
    }
  } catch (error) {
    if (isCancellation(error)) {
      tracker.markFailed(ErrorCode.CANCELLED)
      process.exitCode = 130
      return
    }
    const buildError = asBuildError(error)
    tracker.markFailed(buildError.code)
    for (const line of buildError.toLines()) process.stderr.write(`${line}\n`)
    process.exitCode = exitCodeFor(buildError.code)
    /*
     * 失败路径也要吐结构化结果。
     *
     * 契约要求所有命令在 `--report` 下都输出报告，成功失败一样。
     * 早先这里只看 `quiet`，`--report` 的失败分支什么都不输出，
     * 看板上只剩一个没有原因的空白失败。
     */
    if (silent) {
      process.stdout.write(`${JSON.stringify(failureReport({
        error: buildError,
        tracker,
        exitCode: process.exitCode,
        command: 'assess',
      }), undefined, 2)}\n`)
    }
  }
}

/** 解析子命令：只输出结构，不做评估。 */
async function commandParse(positional, values) {
  const appArg = positional[0]
  if (appArg === undefined) {
    process.stderr.write('缺少应用包路径。用法：apponwin parse <应用包.app>\n')
    process.exitCode = 2
    emitMissingArgument('parse', '缺少应用包路径', '用法：apponwin parse <应用包.app>', values)
    return
  }

  const tracker = new StageTracker()

  try {
    tracker.enter('parse')
    const parsed = await parseAppBundle(appArg)
    tracker.leave('parse')
    const payload = {
      ok: true,
      path: parsed.path,
      bundleId: parsed.bundleId,
      name: parsed.name,
      version: parsed.version,
      executable: parsed.executableName,
      mainExecutableExists: parsed.mainExecutableExists,
      minimumSystemVersion: parsed.minimumSystemVersion,
      plistError: parsed.plistError,
      binaries: parsed.binaries,
      frameworks: parsed.frameworks,
      dylibs: parsed.dylibs,
    }

    /*
     * `--report` 与 `--json` 是两种不同的输出，不能共用一个分支。
     *
     * 早先 `--report` 走的是 `--json` 那条路，吐出的 payload 里
     * 没有 `direction` / `stages` / `exitCode`，契约检查会判「缺字段」。
     * parse 虽小，但它是契约检查里 apponwin 的失败探测命令，结构必须合规。
     */
    if (values.report === true) {
      process.stdout.write(`${JSON.stringify(successReport({
        config: { target: 'x86_64', appName: parsed.name },
        result: { artifact: null, artifactSize: 0, durationMs: 0 },
        tracker,
        command: 'parse',
      }), undefined, 2)}\n`)
      return
    }
    if (values.json === true) {
      process.stdout.write(`${JSON.stringify(payload, undefined, 2)}\n`)
      return
    }
    process.stdout.write(`应用      ${parsed.name}\n`)
    process.stdout.write(`Bundle ID ${parsed.bundleId ?? '-'}\n`)
    process.stdout.write(`主程序    ${parsed.executableName ?? '-'}\n`)
    process.stdout.write(`二进制    ${String(parsed.binaries.length)} 个\n`)
    for (const binary of parsed.binaries) {
      process.stdout.write(
        `  ${binary.path}  [${binary.architectures.join(',')}]` +
        `  ${binary.frameworks.length > 0 ? binary.frameworks.join(' ') : '(无框架依赖)'}\n`)
    }
    if (parsed.plistError !== null) {
      process.stderr.write(`[WARN] Info.plist 解析失败：${parsed.plistError}\n`)
    }
  } catch (error) {
    const buildError = asBuildError(error)
    for (const line of buildError.toLines()) process.stderr.write(`${line}\n`)
    process.exitCode = exitCodeFor(buildError.code)
    /*
     * 失败路径也要输出契约报告。
     *
     * 契约要求所有命令在 --report 下都输出报告，成功失败都一样。
     * 早先这里只写 stderr，导致 console 的契约检查判为「没有输出报告」。
     */
    if (values.json === true || values.report === true) {
      // markFailed 只在有 current 阶段时生效，先进入 parse 阶段
      tracker.enter('parse')
      tracker.markFailed(buildError.code)
      process.stdout.write(`${JSON.stringify(failureReport({
        error: buildError,
        tracker,
        exitCode: process.exitCode,
        command: 'parse',
      }), undefined, 2)}\n`)
    }
  }
}

/** Spike 子命令：三条门槛的可行性验证。 */
async function commandSpike(positional, values) {
  const quiet = values.json === true
  const wantReport = values.report === true
  const tracker = new StageTracker()

  try {
    tracker.enter('preflight')
    const result = await runSpike({
      sample: values.sample ?? null,
      app: values.app ?? positional[0] ?? null,
    })
    tracker.leave('preflight')

    const payload = {
      ok: result.conclusion === 'accepted',
      conclusion: result.conclusion,
      decisiveGate: result.decisiveGate,
      gates: result.gates,
      notes: result.notes,
      platform: process.platform,
    }

    /*
     * spike 的 `checks` 就是三条门槛，直接映射成契约的检查项。
     *
     * 契约要求每项有布尔 `passed`，而门槛用的是 `status`（三态：
     * pass / fail / blocked）。`blocked` 不能算通过 —— 那是「环境不具备，
     * 没验证过」，和 mac2win 那边「unverified 不能用退出码 0 冒充通过」
     * 是同一条原则。所以只有 `pass` 才是 true。
     */
    const gatesAsChecks = result.gates.map((gate) => ({
      name: `gate${String(gate.id)}-${gate.name}`,
      passed: gate.status === 'pass',
      detail: `${gate.status} — ${gate.reason}`,
    }))

    if (quiet) {
      process.stdout.write(`${JSON.stringify(payload, undefined, 2)}\n`)
    } else if (!wantReport) {
      process.stdout.write('Spike：AppOnWin 可行性三条门槛\n\n')
      for (const gate of result.gates) {
        const decisive = gate.id === result.decisiveGate ? '（决定性）' : ''
        process.stdout.write(
          `  ${gateMark(gate.status)} 门槛 ${String(gate.id)} ${gate.name}${decisive}\n`)
        process.stdout.write(`         ${gate.status} — ${gate.reason}\n`)
        if (gate.hint !== undefined && gate.hint !== null) {
          process.stdout.write(`         建议：${gate.hint}\n`)
        }
      }
      process.stdout.write(`\n结论      ${conclusionLabel(result.conclusion)}\n`)
      for (const note of result.notes) process.stdout.write(`          ${note}\n`)
    }

    /*
     * 退出码语义：
     *   0 = accepted（可继续）
     *   5 = unverified（环境不具备，不是失败但也不能算通过）
     *   1 = rejected（实测不通过）
     *
     * 用 5 而不是 0 是关键：CI 里若把 unverified 当通过，就会在
     * 没验证的情况下继续推进，这正是要避免的。
     *
     * 契约要求报告里的 `exitCode` 与进程退出码一致，所以先算出来
     * 再同时写进两处，而不是各算一遍。
     */
    /*
     * `spike` 的结论有三种，各自对应**不同的错误码**，不能共用一个。
     *
     *   结论        退出码  错误码              含义
     *   accepted    0       —                  可继续
     *   unverified  5       AOW_2001           缺外部依赖（WSL2 / Darling）
     *   rejected    1       AOW_9999           实测不通过，未归类失败
     *
     * ## 早先的写法为什么是错的
     *
     * 原来两种失败都填 `HOST_UNSUPPORTED`（AOW_1001），而退出码按结论
     * 分别是 5 和 1。于是同一份报告里出现
     *
     *   exitCode: 5, error.code: AOW_1001
     *
     * 而契约写明 exit 5 → 2001/2002、exit 1 → 9999、1001 属 exit 2。
     * 三处全不一致。更糟的是**本文件自己的 exitCodeFor(AOW_1001)
     * 返回的是 2** —— 同一份代码对同一个错误码给出两个退出码，
     * 到底哪个对只能靠读到这里的人猜。
     *
     * 脚本按退出码分流时会走错分支：CI 看到 5 认为「装个 WSL2 就能过」，
     * 但报告说是 1001（环境与输入），不知道该信哪个。
     *
     * `unverified` 的语义确实是「缺东西」——缺 WSL2、缺 Darling，
     * 与 `AOW_2001 TOOL_MISSING` 完全吻合。`rejected` 是实测跑不通，
     * 不属于任何具体段位，归 `INTERNAL`（9999）的「未归类失败」。
     */
    const conclusion = result.conclusion
    process.exitCode = conclusion === 'accepted' ? 0 : conclusion === 'unverified' ? 5 : 1

    if (wantReport) {
      const failureCode = conclusion === 'unverified'
        ? ErrorCode.TOOL_MISSING
        : ErrorCode.INTERNAL
      process.stdout.write(`${JSON.stringify(process.exitCode === 0
        ? successReport({
          config: { target: 'x86_64' },
          result: { artifact: null, artifactSize: 0, durationMs: 0 },
          tracker,
          command: 'spike',
          checks: gatesAsChecks,
        })
        : failureReport({
          error: new BuildError(failureCode,
            conclusion === 'rejected'
              ? 'spike 实测不通过：至少一条门槛失败'
              : 'spike 未验证：环境不具备（WSL2 / Darling 缺失）', {
              hint: result.notes.join('；'),
            }),
          tracker,
          exitCode: process.exitCode,
          command: 'spike',
          checks: gatesAsChecks,
        }), undefined, 2)}\n`)
    }
  } catch (error) {
    const buildError = asBuildError(error)
    for (const line of buildError.toLines()) process.stderr.write(`${line}\n`)
    process.exitCode = exitCodeFor(buildError.code)
    if (wantReport) {
      tracker.enter('preflight')
      tracker.markFailed(buildError.code)
      process.stdout.write(`${JSON.stringify(failureReport({
        error: buildError,
        tracker,
        exitCode: process.exitCode,
        command: 'spike',
      }), undefined, 2)}\n`)
    }
  }
}

/** 结论 → 中文标签。 */
function conclusionLabel(conclusion) {
  if (conclusion === 'accepted') return '通过（三条门槛全部实测通过）'
  if (conclusion === 'rejected') return '不通过（至少一条门槛实测失败）'
  return '未验证（环境不具备，不能算通过）'
}

/** 判定 → 中文标签。 */
function verdictLabel(verdict) {
  if (verdict === 'likely') return '较可能运行'
  if (verdict === 'unlikely') return '较不可能运行'
  return '无法判定'
}

/** 框架状态 → 标记。 */
function statusMark(status) {
  if (status === 'works') return '[OK  ]'
  if (status === 'partial') return '[PART]'
  if (status === 'broken') return '[FAIL]'
  return '[ ?  ]'
}

/** 门槛状态 → 标记。 */
function gateMark(status) {
  if (status === 'pass') return '[PASS]'
  if (status === 'fail') return '[FAIL]'
  return '[ -- ]'
}

/** 环境自检。 */
async function commandDoctor(values) {
  const tracker = new StageTracker()
  tracker.enter('preflight')

  const { probeWsl, probeDarling } = await import('../src/core/spike.mjs')
  const wsl = await probeWsl()
  const darling = wsl.available ? await probeDarling() : { available: false, reason: wsl.reason }

  const checks = [
    /*
     * platform 不再是硬失败项。
     *
     * 解析与评估是纯读操作，任何平台都能做 —— 而这正是本方向当前
     * 真正交付的东西。把非 Windows 当失败会让 macOS 上的用户无法
     * 使用最有价值的功能。
     */
    {
      name: 'platform',
      ok: true,
      detail: process.platform === 'win32'
        ? 'win32（可做运行时验证）'
        : `${process.platform}（解析与评估可用；运行时验证需 Windows + WSL2）`,
    },
    { name: 'arch', ok: true, detail: process.arch },
    { name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 20, detail: process.versions.node },
    /*
     * WSL2 与 Darling 都不是「必需」——它们只决定能不能跑 spike。
     * 因此 ok 恒为 true，状态写在 detail 里，由 spike 子命令给出
     * 明确的三态结论（pass / fail / blocked）。
     */
    {
      name: 'wsl2',
      ok: true,
      detail: wsl.available
        ? `可用（${wsl.distributions.join(', ')}）`
        : wsl.reason,
    },
    {
      name: 'darling',
      ok: true,
      detail: darling.available
        ? `可用（${darling.version}）`
        : darling.reason,
    },
  ]

  const allOk = checks.every((check) => check.ok)
  if (allOk) tracker.leave('preflight')
  else tracker.markFailed(ErrorCode.HOST_UNSUPPORTED)

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
      ? successReport({ config: { target: 'x86_64' }, result: { artifact: null, artifactSize: 0, durationMs: 0 }, tracker, command: 'doctor' })
      : failureReport({
        error: new BuildError(ErrorCode.HOST_UNSUPPORTED, '环境自检未通过', {
          hint: '见 doctor 的逐项输出',
        }),
        tracker,
        exitCode: 5,
      }), undefined, 2)}\n`)
  }
  process.exitCode = allOk ? 0 : 5
}

/**
 * 参数缺失时的统一收尾：`--report` 下补一份结构化报告。
 *
 * 参数校验发生在 tracker / try-catch 之前，没法复用各子命令的异常分支。
 * 契约要求 `--report` 下 stdout 永远有一份 JSON，否则 console 拿到空输入
 * 只能显示「未知错误」，用户看不出是自己少敲了个路径。
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

/** 主入口。 */
async function main() {
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
        sample: { type: 'string' },
        app: { type: 'string' },
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
  if (command === 'assess') {
    await commandAssess(positionals.slice(1), values)
    return
  }
  if (command === 'parse') {
    await commandParse(positionals.slice(1), values)
    return
  }
  if (command === 'spike') {
    await commandSpike(positionals.slice(1), values)
    return
  }
  if (command === 'doctor') {
    await commandDoctor(values)
    return
  }

  /*
   * 未知子命令必须报错，不能静默打一份 help 就退出。
   *
   * 早先这里是直接 `write(HELP)` 然后 return —— 退出码 0，看起来像成功：
   *
   *   $ apponwin asseess ./Foo.app ; echo $?
   *   （打印一大段帮助）
   *   0
   *
   * 脚本里 `apponwin assess "$APP" || exit 1` 这种写法完全失效，因为
   * 拼错命令也算「成功」。改成显式报错 + 退出码 2，并把可用清单列出来
   * —— 用户一眼能看到自己少打了一个字母。
   */
  if (command !== undefined && !command.startsWith('-')) {
    process.stderr.write(`未知子命令：${command}\n`)
    process.stderr.write(`可用：assess / parse / spike / doctor\n`)
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
