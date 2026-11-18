/**
 * console 调用层的测试：超时、错误处理、并行。
 *
 * 跑法：cd console && npm test
 *
 * ## 为什么这些测试值得写
 *
 * 开发时实测确认过两个真实缺陷：
 *
 *   1. **无超时保护**：用一个永不退出的子进程 100% 复现 console
 *      永久挂起。真实场景里 wine 安装器挂死、下载卡在半开连接都会触发。
 *   2. **doctor 串行**：555ms 里有 415ms 花在等 exeonmac 上，而四个
 *      方向本来完全独立。
 *
 * 这两条都不是理论风险，是量出来的。测试守住它们不再退化。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { DIRECTIONS, runDirection, status } from '../bin/wacmin-console.mjs'

/** 一个必然存在的方向，用来测通用行为。 */
const DIRECTION = 'win2mac'

describe('方向注册表', () => {
  test('四个方向齐全', () => {
    assert.deepEqual(Object.keys(DIRECTIONS).sort(),
      ['apponwin', 'exeonmac', 'mac2win', 'win2mac'])
  })

  test('每个方向都有 label / summary / cwd / runner', () => {
    for (const [id, spec] of Object.entries(DIRECTIONS)) {
      assert.ok(typeof spec.label === 'string' && spec.label !== '', id)
      assert.ok(typeof spec.summary === 'string' && spec.summary !== '', id)
      assert.ok(typeof spec.cwd === 'string' && spec.cwd !== '', id)
      assert.equal(typeof spec.runner, 'function', id)
    }
  })

  test('runner 返回可执行的命令与参数', () => {
    for (const [id, spec] of Object.entries(DIRECTIONS)) {
      const { command, args } = spec.runner('doctor', [])
      assert.ok(typeof command === 'string' && command !== '', id)
      assert.ok(Array.isArray(args), id)
      assert.ok(args.length > 0, id)
    }
  })

  test('runDirection 负责补 --report', async () => {
    /*
     * `--report` 由 runDirection 统一追加，不在各方向的 runner 里 ——
     * 这样新增方向时不会漏。用一个假 runner 确认它真的被传下去。
     */
    const original = DIRECTIONS.win2mac.runner
    let captured = null
    DIRECTIONS.win2mac.runner = (command, options) => {
      captured = [...options]
      return { command: process.execPath, args: ['-e', 'console.log("{}")'] }
    }
    try {
      await runDirection('win2mac', 'doctor', [], { timeoutMs: 5000 })
      assert.ok(captured !== null)
      assert.ok(captured.includes('--report'), '--report 应被追加到参数末尾')
    } finally {
      DIRECTIONS.win2mac.runner = original
    }
  })

  test('status 报告四个方向都已安装', () => {
    const rows = status()
    assert.equal(rows.length, 4)
    for (const row of rows) {
      assert.equal(row.installed, true, `${row.id} 目录不存在`)
    }
  })
})

describe('超时保护', () => {
  test('极短超时会判定超时', async () => {
    /*
     * 给 1ms 超时，任何子进程都来不及完成 —— 必然命中超时分支。
     * 这验证的是「超时机制真的接上了」，不是某个方向的性能。
     */
    const started = Date.now()
    const result = await runDirection(DIRECTION, 'doctor', [], { timeoutMs: 1 })
    const elapsed = Date.now() - started

    assert.equal(result.timedOut, true, '应标记为超时')
    assert.notEqual(result.exitCode, 0, '超时不应返回 0')
    /*
     * 被信号杀死时退出码是 128+信号。SIGTERM(15) → 143，SIGKILL(9) → 137。
     * 只要不是 0 就说明进程确实被终止了。
     */
    assert.ok([137, 143].includes(result.exitCode),
      `超时退出码应为 137 或 143，实际 ${String(result.exitCode)}`)
    assert.ok(elapsed < 10000, `超时后应快速返回，实际耗时 ${String(elapsed)}ms`)
  })

  test('timeoutMs 为 0 表示不限', async () => {
    /* 用一个能正常快速完成的命令，确认 0 不会立刻杀掉它 */
    const result = await runDirection(DIRECTION, 'doctor', [], { timeoutMs: 0 })
    assert.equal(result.timedOut, false)
  })

  test('超时后 stderr 仍可读', async () => {
    const result = await runDirection(DIRECTION, 'doctor', [], { timeoutMs: 1 })
    assert.equal(typeof result.stderr, 'string')
  })
})

describe('错误处理', () => {
  test('未知方向直接拒绝', async () => {
    await assert.rejects(
      () => runDirection('nonexistent-direction', 'doctor'),
      /未知方向/u)
  })

  test('spawn 失败不会挂死', async () => {
    /*
     * 命令不存在时 Node 会触发 error 事件与 close。必须两者都处理，
     * 否则某些版本上会抛未捕获异常。
     */
    const original = DIRECTIONS.win2mac.runner
    DIRECTIONS.win2mac.runner = () => ({
      command: 'definitely-not-a-real-command-wacmin-xyz',
      args: [],
    })
    try {
      const result = await runDirection('win2mac', 'doctor', [], { timeoutMs: 5000 })
      assert.equal(result.report, null)
      assert.notEqual(result.exitCode, 0)
      assert.match(result.stderr, /无法启动|ENOENT/u)
    } finally {
      DIRECTIONS.win2mac.runner = original
    }
  })

  test('不合规输出时 report 为 null', async () => {
    /*
     * 方向没按契约输出 JSON 时不能崩，要返回 report=null 让调用方
     * 按 exitCode 判断。
     */
    const original = DIRECTIONS.win2mac.runner
    DIRECTIONS.win2mac.runner = () => ({
      command: process.execPath,
      args: ['-e', 'console.log("这不是 JSON")'],
    })
    try {
      const result = await runDirection('win2mac', 'doctor', [], { timeoutMs: 5000 })
      assert.equal(result.report, null)
    } finally {
      DIRECTIONS.win2mac.runner = original
    }
  })

  test('stderr 过大时只保留尾部', async () => {
    /*
     * 一个跑 30 分钟的安装可能产生几十 MB 日志。全存进内存没有意义，
     * 出错时人只看最后几十行。
     */
    const original = DIRECTIONS.win2mac.runner
    DIRECTIONS.win2mac.runner = () => ({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("X".repeat(500000)); process.exit(1)'],
    })
    try {
      const result = await runDirection('win2mac', 'doctor', [], { timeoutMs: 30000 })
      assert.ok(result.stderr.length <= 256 * 1024 + 1024,
        `stderr 应被截断到 256KB 内，实际 ${String(result.stderr.length)}`)
    } finally {
      DIRECTIONS.win2mac.runner = original
    }
  })
})

describe('并行 doctor', () => {
  test('并行 doctor 能同时跑四个方向', async () => {
    /*
     * 这里**不比较并行与串行的绝对耗时** —— 那样测不准。
     *
     * 早期版本写成「并行应不快于串行的 1.1 倍」，结果在 CI 上偶发失败：
     * 并行先跑、串行后跑，后跑的受益于文件系统缓存与进程预热，反而更快。
     * 计时比较在单机上是不可靠的指标。
     *
     * 改为验证「并行确实同时发起了四个子进程」：用一个会记录并发峰值的
     * 假 run，看峰值是否达到 4。
     */
    let active = 0
    let peak = 0
    const slowRun = (id, command) => new Promise((resolvePromise) => {
      active += 1
      peak = Math.max(peak, active)
      setTimeout(() => {
        active -= 1
        resolvePromise({
          exitCode: 0,
          report: {
            schemaVersion: 1, direction: id, ok: true, exitCode: 0, command,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: 1, stages: [],
          },
          stderr: '', timedOut: false,
        })
      }, 50)
    })

    const { startServer } = await import('../src/server.mjs')
    /*
     * 历史会落盘到 `~/.wacmin/history.json`，测试必须隔离到临时目录 ——
     * 否则会污染开发者的真实看板历史，真实历史也会让其他断言失效。
     */
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const home = await mkdtemp(join(tmpdir(), 'wacmin-runner-'))
    const previousHome = process.env.WACMIN_HOME
    process.env.WACMIN_HOME = home

    const { port, close } = await startServer({ port: 0, run: slowRun })
    try {
      /*
       * 通过 HTTP 触发四个不同方向 —— 它们应该同时在跑。
       * 用 Promise.all 是因为前端也是这么发的。
       */
      const results = await Promise.all(
        ['mac2win', 'exeonmac', 'win2mac', 'apponwin'].map((direction) =>
          fetch(`http://127.0.0.1:${String(port)}/api/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ direction, command: 'doctor' }),
          }).then((r) => r.json())))
      for (const result of results) {
        assert.equal(result.ok, true, String(result.error))
      }
      assert.equal(peak, 4, `并发峰值应为 4，实际 ${String(peak)}`)
    } finally {
      await close()
      if (previousHome === undefined) delete process.env.WACMIN_HOME
      else process.env.WACMIN_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('真实调用', () => {
  test('每个方向的 doctor 都能产出报告', async () => {
    for (const id of Object.keys(DIRECTIONS)) {
      const result = await runDirection(id, 'doctor', [], { timeoutMs: 60000 })
      assert.notEqual(result.report, null, `${id} 的 doctor 没有输出报告`)
      assert.equal(result.report.direction, id, `${id} 的 direction 字段不对`)
      assert.ok(Array.isArray(result.report.stages), `${id} 的 stages 不是数组`)
    }
  })

  test('报告 ok 与 exitCode 一致', async () => {
    for (const id of Object.keys(DIRECTIONS)) {
      const { exitCode, report } = await runDirection(id, 'doctor', [], { timeoutMs: 60000 })
      if (report === null) continue
      assert.equal(report.ok, exitCode === 0,
        `${id}: ok=${String(report.ok)} 但 exitCode=${String(exitCode)}`)
    }
  })
})