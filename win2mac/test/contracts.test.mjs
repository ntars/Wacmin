/**
 * 契约测试：错误码与报告结构。
 *
 * 阶段 0 只有骨架，但骨架最容易出的问题是「码值写错段位」和
 * 「报告字段漏了」。这两类问题在实现阶段会连锁放大，所以现在就守住。
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
  assert.equal(DIRECTION, 'win2mac')
  assert.equal(prefixes.prefixes[DIRECTION], 'W2M')
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

test('八个阶段与 mac2win 同构', () => {
  assert.equal(STAGES.length, 8)
  assert.equal(STAGES[0].id, 'preflight')
  assert.equal(STAGES.at(-1).id, 'verify')
})

test('退出码映射按段位决定', () => {
  assert.equal(exitCodeFor('W2M_1003'), 2)
  assert.equal(exitCodeFor('W2M_2001'), 5)
  assert.equal(exitCodeFor('W2M_4001'), 6)
  assert.equal(exitCodeFor('W2M_6002'), 7)
  assert.equal(exitCodeFor('W2M_9001'), 130)
  assert.equal(exitCodeFor('W2M_9999'), 1)
})

test('1005 是 1xxx 段里唯一映射到退出码 4 的例外', () => {
  /*
   * 1005 表示「输入物明确不支持」，对应退出码 4；同段其它码（1002 路径
   * 不存在、1003 配置非法、1004 缺参数）都是退出码 2。
   *
   * 这个区分对调用方有意义：拿到 2 说明改一下路径或参数再试就行，
   * 拿到 4 说明这个输入物永远做不了，重试多少次都一样。若都映射成 2，
   * 自动化会对着一个不可能成功的输入反复重跑。
   */
  const exitCodes = JSON.parse(readFileSync(join(CONTRACTS, 'exit-codes.json'), 'utf8'))
  const unsupported = exitCodes.codes['4']
  assert.ok(unsupported.errorSegment.includes('1005'),
    '契约里退出码 4 必须指向 1005')

  assert.equal(exitCodeFor('W2M_1005'), 4)
  // 同段其它码不能被顺手带成 4
  assert.equal(exitCodeFor('W2M_1002'), 2)
  assert.equal(exitCodeFor('W2M_1003'), 2)
  assert.equal(exitCodeFor('W2M_1004'), 2)
})

test('StageTracker：进入离开后标 ok', () => {
  const tracker = new StageTracker()
  tracker.enter('preflight')
  tracker.leave('preflight')
  const stages = tracker.toStages()
  assert.equal(stages[0].status, 'ok')
  assert.equal(stages[1].status, 'skipped')
})

test('失败报告：未进入阶段时首个标 failed', () => {
  const tracker = new StageTracker()
  const report = failureReport({
    error: new BuildError(ErrorCode.HOST_UNSUPPORTED, '不在 Windows 上'),
    tracker,
    exitCode: 2,
  })
  assert.equal(report.ok, false)
  assert.equal(report.error.code, ErrorCode.HOST_UNSUPPORTED)
  assert.equal(report.stages[0].status, 'failed')
})

test('成功报告：error 为 null 且 exitCode 为 0', () => {
  const tracker = new StageTracker()
  const report = successReport({
    config: { target: 'arm64' },
    result: {
      artifact: '/out/MyApp.app',
      artifactSize: 2048,
      durationMs: 100,
      preflight: { checks: [] },
    },
    tracker,
  })
  assert.equal(report.ok, true)
  assert.equal(report.exitCode, 0)
  assert.equal(report.error, null)
  assert.equal(report.artifacts[0].kind, 'mac-app')
})
// ---------------------------------------------------------------------------
// CLI 层：--report 下 stdout 必须永远有一份 JSON
// ---------------------------------------------------------------------------

/**
 * 参数缺失也必须吐报告。
 *
 * 这条曾漏过：参数校验发生在 `--report` 判定之前，漏参数时直接
 * `stderr.write` + return，stdout 完全是空的。console 拿到空输入只能
 * 显示「未知错误」，用户看不出是自己少敲了个目录。
 */
function runCli(args) {
  const bin = join(HERE, '..', 'bin', 'win2mac.mjs')
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  })
}

for (const command of ['build', 'verify']) {
  test(`${command} 缺参数时 --report 仍输出合规报告`, () => {
    const result = runCli([command, '--report'])
    assert.equal(result.status, 2, `退出码应为 2，实际 ${result.status}`)

    // stdout 必须能解析成 JSON —— 空字符串也过不了这一关
    const report = JSON.parse(result.stdout)
    assert.equal(report.direction, 'win2mac')
    assert.equal(report.ok, false)
    assert.equal(report.exitCode, 2)
    assert.equal(report.command, command)
    // 契约：ok === (exitCode === 0)
    assert.equal(report.ok, report.exitCode === 0)
    // 缺参数属于「环境与输入」段位
    assert.match(report.error.code, /^W2M_1\d{3}$/)
    // 人读提示仍走 stderr
    assert.match(result.stderr, /缺少/)
  })
}
