#!/usr/bin/env node
/**
 * console 的可执行入口。
 *
 * ## 这个文件只剩两件事
 *
 * 解析 argv、打印结果。所有调度能力都搬到了 `src/directions.mjs`，
 * 这里只是薄壳。
 *
 * ## 为什么要加「被 import 时不执行」的守卫
 *
 * 早先这个文件顶层直接 `main()`。于是 `src/server.mjs` 的 `/api/status`
 * 分支里那句 `await import('../bin/wacmin-console.mjs')`（只为拿 `status()`）
 * 会连带执行一次 CLI：往服务进程 stdout 写一份中文用法说明，还把
 * `process.exitCode` 设成 2。
 *
 * 看板不读自己的 stdout，所以这个污染一直没暴露。但 MCP server 复用同一套
 * 调度 —— 而 MCP 规范要求 stdout 只出现协议消息，多一个字就让客户端解析失败。
 * 也就是说：不修这里，MCP server 一启动就会被自己人污染。
 *
 * 守卫用 realpath 比对而不是字符串比对：`node bin/x.mjs`、`node ./bin/x.mjs`、
 * 经软链调用，三种写法下 `import.meta.url` 与 `process.argv[1]` 的形态并不
 * 一致，字符串相等会漏判，而漏判的后果正是上面那个缺陷。
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  DIRECTIONS,
  DOCTOR_TIMEOUT_MS,
  killTree,
  runDirection,
  status,
} from '../src/directions.mjs'

/*
 * 保持对外的导出面不变。
 *
 * 测试与 `src/server.mjs` 都是 `import { DIRECTIONS, runDirection, status }
 * from '../bin/wacmin-console.mjs'`。搬家不该逼所有调用点改 import 路径 ——
 * 那会让这次重构变成一个波及面很大的改动，而它本来只是「把入口和实现分开」。
 */
export { DIRECTIONS, runDirection, status }

/** 命令行用法。 */
const HELP = `
wacmin-console — 四个方向的统一入口

用法
  console list                       列出四个方向
  console run <方向> <子命令> [参数]   调用某个方向
  console doctor                     汇总各方向自检（并行）
  console contract                   检查四个方向是否遵守契约
  console web [端口]                 启动本地看板（只绑 127.0.0.1）

示例
  console list
  console run mac2win build ../myapp --dry-run
  console run exeonmac version
  console contract
  console web 7777

环境变量
  WACMIN_TIMEOUT_MS   单次调用的超时毫秒数，默认 1800000（30 分钟），0 表示不限
  WACMIN_PORT         web 命令的默认端口，默认 0（随机）
`.trim()

async function main() {
  const [command, ...rest] = process.argv.slice(2)

  if (command === undefined || command === 'help' || command === '--help') {
    process.stdout.write(`${HELP}\n`)
    return
  }

  if (command === 'list') {
    const rows = status()
    for (const row of rows) {
      const mark = row.installed ? '✓' : '·'
      process.stdout.write(`${mark} ${row.id.padEnd(10)} ${row.label.padEnd(10)} ${row.summary}\n`)
    }
    return
  }

  if (command === 'run') {
    const [id, sub, ...options] = rest
    if (id === undefined || sub === undefined) {
      process.stderr.write('用法：console run <方向> <子命令> [参数]\n')
      process.exitCode = 2
      return
    }
    const { exitCode, report, stderr } = await runDirection(id, sub, options, {
      onStderr: (chunk) => process.stderr.write(chunk),
    })
    if (report === null) {
      process.stderr.write(`方向 ${id} 未输出合规报告\n`)
      if (stderr !== '') process.stderr.write(stderr)
      process.exitCode = exitCode
      return
    }
    process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`)
    process.exitCode = exitCode
    return
  }

  if (command === 'doctor') {
    /*
     * 并行跑四个方向。
     *
     * 四个方向互相独立（各自一个子进程），串行没有任何收益 ——
     * 实测串行 555ms，其中 exeonmac 一项就占 415ms（Python 启动 +
     * 探测 wine/sips/7z）。并行后总耗时约等于最慢的那一项。
     *
     * 并行也有代价：四个进程同时起，瞬时内存占用更高。但这些自检
     * 都很轻（只探测工具存在性），可以接受。
     */
    const rows = status()
    const results = await Promise.all(rows.map(async (row) => {
      if (!row.installed) {
        return { id: row.id, ok: false, reason: '目录不存在' }
      }
      const startedAt = Date.now()
      try {
        const { exitCode, report, timedOut } = await runDirection(row.id, 'doctor', [], {
          timeoutMs: DOCTOR_TIMEOUT_MS,
        })
        return {
          id: row.id,
          ok: exitCode === 0 && !timedOut,
          exitCode,
          durationMs: Date.now() - startedAt,
          ...(timedOut ? { reason: `超时（>${String(DOCTOR_TIMEOUT_MS)}ms）` } : {}),
          stages: report?.stages?.filter((stage) => stage.status !== 'skipped').length ?? 0,
        }
      } catch (error) {
        return {
          id: row.id,
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    }))
    process.stdout.write(`${JSON.stringify(results, undefined, 2)}\n`)
    process.exitCode = results.every((item) => item.ok) ? 0 : 5
    return
  }

  if (command === 'contract') {
    /*
     * 契约一致性检查。
     *
     * 这是 console 作为「统一入口」最有价值的能力：四个方向由不同语言
     * 实现（Node / Python），靠人工保证一致性不现实。这个命令真的把
     * 四个方向跑起来，逐条校验它们的报告是否符合契约。
     *
     * 与 contracts/validate.mjs 的分工：那边只检查契约文件自身是否自洽，
     * 这边检查各方向是否真的遵守。
     */
    const { runContractCheck } = await import('../src/contract-check.mjs')
    const result = await runContractCheck({
      run: (id, sub, options = []) =>
        runDirection(id, sub, options, { timeoutMs: DOCTOR_TIMEOUT_MS }),
    })

    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`)
    } else {
      for (const entry of result.results) {
        const mark = entry.ok ? '✓' : '✗'
        process.stdout.write(`${mark} ${entry.direction.padEnd(10)}\n`)
        for (const scenario of entry.scenarios) {
          const scenarioMark = scenario.ok ? '  ✓' : '  ✗'
          process.stdout.write(`${scenarioMark} ${scenario.scenario}\n`)
          for (const problem of scenario.problems) {
            process.stdout.write(`      [${problem.check}] ${problem.detail}\n`)
          }
        }
      }
      const total = result.results.reduce(
        (sum, entry) => sum + entry.scenarios.length, 0)
      const passed = result.results.reduce(
        (sum, entry) => sum + entry.scenarios.filter((s) => s.ok).length, 0)
      process.stdout.write(`\n${String(passed)} / ${String(total)} 场景符合契约\n`)
    }
    process.exitCode = result.ok ? 0 : 5
    return
  }

  if (command === 'web') {
    /*
     * 本地看板服务。
     *
     * 只绑 127.0.0.1 —— 这个服务能起子进程，绑 0.0.0.0 等于把本机的
     * 命令执行能力开放给整个局域网。
     */
    const { startServer } = await import('../src/server.mjs')
    const port = Number(rest[0] ?? process.env.WACMIN_PORT ?? 0)

    const { port: actualPort, close } = await startServer({
      port,
      run: (id, sub, opts = [], hooks = {}) => runDirection(id, sub, opts, hooks),
      log: (message) => process.stderr.write(`${message}\n`),
    })

    const url = `http://127.0.0.1:${String(actualPort)}/`
    process.stdout.write(`Wacmin 看板已启动：${url}\n`)
    process.stdout.write('按 Ctrl+C 停止。\n')

    /*
     * 优雅退出：先关服务（掐断 SSE），再退出。
     * 不这么做时，开着页面的浏览器会让进程一直不退出。
     */
    const shutdown = () => {
      process.stdout.write('\n正在停止…\n')
      close().then(() => { process.exit(0) })
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    // 保持进程活着
    await new Promise(() => {})
    return
  }

  process.stderr.write(`未知命令：${command}\n\n${HELP}\n`)
  process.exitCode = 2
}

/**
 * 判断本模块是否被直接执行。
 *
 * 两级比对，任一成立即视为直接执行：
 *   1. `process.argv[1]` 的 realpath 与 `import.meta.url` 的 realpath 相同
 *   2. 字符串层面直接相等（realpath 失败时兜底）
 *
 * realpath 失败（文件被删、权限不足）不能抛出 —— 那会让「被 import」
 * 的路径也崩，比不判断更糟。
 */
function isDirectRun() {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry === '') return false
  const self = fileURLToPath(import.meta.url)
  if (entry === self) return true
  try {
    return realpathSync(entry) === realpathSync(self)
  } catch {
    return false
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
