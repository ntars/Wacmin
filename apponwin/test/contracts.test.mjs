/**
 * 契约测试：错误码与报告结构。
 *
 * AppOnWin 的阶段定义与其他方向不同（多一道兼容性评估），
 * 这里额外守住「阶段数与本方向语义匹配」，避免照抄时把别的方向的
 * 阶段表直接搬过来。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BuildError, ErrorCode } from '../src/core/errors.mjs'
import {
  DIRECTION, SCHEMA_VERSION, STAGES, StageTracker,
  exitCodeFor, failureReport, successReport,
} from '../src/core/report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONTRACTS = join(HERE, '..', '..', 'contracts')
const prefixes = JSON.parse(readFileSync(join(CONTRACTS, 'error-prefixes.json'), 'utf8'))

test('方向标识与契约一致', () => {
  assert.equal(DIRECTION, 'apponwin')
  assert.equal(prefixes.prefixes[DIRECTION], 'AOW')
})

test('报告格式版本与契约一致', () => {
  assert.equal(SCHEMA_VERSION, 1)
})

test('全部错误码使用本方向前缀', () => {
  const prefix = prefixes.prefixes[DIRECTION]
  for (const [name, code] of Object.entries(ErrorCode)) {
    assert.match(code, new RegExp(`^${prefix}_\\d{4}$`), `${name} 的码值 ${code} 前缀不对`)
  }
})

test('全部错误码的段位在契约中已定义', () => {
  const segments = new Set(Object.keys(prefixes.segments))
  for (const [name, code] of Object.entries(ErrorCode)) {
    const bucket = `${code.slice(-4, -3)}000`
    assert.ok(segments.has(bucket), `${name} 的段位 ${bucket} 未在契约中定义`)
  }
})

test('阶段表含本方向独有的兼容性评估', () => {
  const ids = STAGES.map((stage) => stage.id)
  assert.ok(ids.includes('assess'), 'AppOnWin 必须有兼容性评估阶段')
  assert.equal(ids[0], 'preflight')
  assert.equal(ids.at(-1), 'verify')
  assert.equal(STAGES.length, 8)
})

test('退出码映射按段位决定，9999 不被误判为中断', () => {
  assert.equal(exitCodeFor('AOW_1003'), 2)
  assert.equal(exitCodeFor('AOW_2001'), 5)
  assert.equal(exitCodeFor('AOW_4002'), 6)
  assert.equal(exitCodeFor('AOW_6002'), 7)
  assert.equal(exitCodeFor('AOW_9001'), 130)
  assert.equal(exitCodeFor('AOW_9999'), 1)
})

test('1005 是 1xxx 段里唯一映射到退出码 4 的例外', () => {
  /*
   * 1005 = 输入物明确不支持，对应退出码 4；同段其它码（1002 路径不存在、
   * 1003 配置非法、1004 缺参数）都是退出码 2。
   *
   * 这个区分对自动化有意义：2 可以改路径重试，4 重试多少次都一样。
   */
  assert.equal(exitCodeFor('AOW_1005'), 4)
  assert.equal(exitCodeFor('AOW_1002'), 2)
  assert.equal(exitCodeFor('AOW_1003'), 2)
  assert.equal(exitCodeFor('AOW_1004'), 2)
})

test('StageTracker：进入离开后标 ok', () => {
  const tracker = new StageTracker()
  tracker.enter('assess')
  tracker.leave('assess')
  const stage = tracker.toStages().find((item) => item.name === '兼容性评估')
  assert.equal(stage.status, 'ok')
})

test('失败报告：未进入阶段时首个标 failed', () => {
  const tracker = new StageTracker()
  const report = failureReport({
    error: new BuildError(ErrorCode.HOST_UNSUPPORTED, '不在 Windows 上'),
    tracker,
    exitCode: 2,
  })
  assert.equal(report.ok, false)
  assert.equal(report.stages[0].status, 'failed')
  assert.equal(report.error.code, ErrorCode.HOST_UNSUPPORTED)
})

test('成功报告：error 为 null', () => {
  const tracker = new StageTracker()
  const report = successReport({
    config: { target: 'arm64' },
    result: { artifact: '/out/x', artifactSize: 1, durationMs: 1, preflight: { checks: [] } },
    tracker,
  })
  assert.equal(report.ok, true)
  assert.equal(report.error, null)
  assert.equal(report.artifacts[0].kind, 'dir')
})
// ---------------------------------------------------------------------------
// CLI 层：--report 下 stdout 必须永远有一份 JSON
// ---------------------------------------------------------------------------

/**
 * 参数缺失也必须吐报告。
 *
 * 这条曾漏过：参数校验发生在 `--report` 判定之前，漏参数时直接
 * `stderr.write` + return，stdout 完全是空的。console 拿到空输入只能
 * 显示「未知错误」，用户看不出是自己少敲了个路径。
 */
function runCli(args) {
  const bin = join(HERE, '..', 'bin', 'apponwin.mjs')
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  })
}

for (const command of ['parse', 'assess']) {
  test(`${command} 缺参数时 --report 仍输出合规报告`, () => {
    const result = runCli([command, '--report'])
    assert.equal(result.status, 2, `退出码应为 2，实际 ${result.status}`)

    const report = JSON.parse(result.stdout)
    assert.equal(report.direction, 'apponwin')
    assert.equal(report.ok, false)
    assert.equal(report.exitCode, 2)
    assert.equal(report.command, command)
    assert.equal(report.ok, report.exitCode === 0)
    assert.match(report.error.code, /^AOW_1\d{3}$/)
    assert.match(result.stderr, /缺少/)
  })
}
