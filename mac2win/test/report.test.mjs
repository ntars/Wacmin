/**
 * 统一报告的契约测试。
 *
 * 报告是前端汇总的唯一输入，字段写歪了要到 console 阶段才暴露。
 * 这里守住三件事：结构合规、状态机正确、失败时阶段不留空白。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BuildError, ErrorCode } from '../src/core/errors.mjs'
import {
  DIRECTION, SCHEMA_VERSION, StageTracker, failureReport, successReport,
} from '../src/core/report.mjs'

test('报告方向与格式版本与契约一致', () => {
  assert.equal(DIRECTION, 'mac2win')
  assert.equal(SCHEMA_VERSION, 1)
})

test('StageTracker：进入再离开标 ok 并计时', () => {
  const tracker = new StageTracker()
  tracker.enter('preflight')
  tracker.leave('preflight')
  const stages = tracker.toStages()
  assert.equal(stages[0].status, 'ok')
  assert.ok(stages[0].durationMs >= 0)
})

test('StageTracker：未进入的阶段标 skipped 而不是 pending', () => {
  const tracker = new StageTracker()
  tracker.enter('preflight')
  tracker.leave('preflight')
  const stages = tracker.toStages()
  assert.equal(stages[1].status, 'skipped')
  assert.equal(stages.length, 8)
})

test('StageTracker：markFailed 记录错误码', () => {
  const tracker = new StageTracker()
  tracker.enter('package')
  tracker.markFailed(ErrorCode.NSIS_COMPILE_FAILED)
  const stage = tracker.toStages().find((item) => item.name === '打包安装包')
  assert.equal(stage.status, 'failed')
  assert.equal(stage.errorCode, ErrorCode.NSIS_COMPILE_FAILED)
})

test('成功报告：字段齐备且 error 为 null', () => {
  const tracker = new StageTracker()
  tracker.enter('preflight')
  tracker.leave('preflight')
  const report = successReport({
    config: { projectRoot: '/tmp/x', framework: 'static', target: 'x86', format: 'nsis' },
    result: {
      artifact: '/tmp/x/out.exe',
      artifactSize: 1024,
      zipArtifact: null,
      zipSize: 0,
      durationMs: 500,
      preflight: { checks: [] },
      verify: { items: [{ title: 'PE 格式', status: 'pass', detail: 'ok' }] },
    },
    tracker,
  })

  assert.equal(report.ok, true)
  assert.equal(report.exitCode, 0)
  assert.equal(report.error, null)
  assert.equal(report.artifacts.length, 1)
  assert.equal(report.artifacts[0].kind, 'nsis-exe')
  assert.equal(report.checks[0].passed, true)
  assert.equal(report.checks[0].severity, 'required')
})

test('成功报告：warn 项归为 advisory 并进 warnings', () => {
  const tracker = new StageTracker()
  const report = successReport({
    config: { projectRoot: '/tmp/x', framework: 'static', target: 'x86', format: 'nsis' },
    result: {
      artifact: '/tmp/x/out.exe',
      artifactSize: 1,
      zipArtifact: null,
      zipSize: 0,
      durationMs: 1,
      preflight: { checks: [{ title: '宿主入口', status: 'warn', detail: '未配置' }] },
      verify: { items: [{ title: '7-Zip', status: 'warn', detail: '转发壳' }] },
    },
    tracker,
  })
  assert.equal(report.warnings.length, 2)
  assert.equal(report.checks[0].severity, 'advisory')
})

test('失败报告：全部阶段未进入时把首个阶段标 failed', () => {
  const tracker = new StageTracker()
  const report = failureReport({
    error: new BuildError(ErrorCode.CONFIG_INVALID, '配置有误', { hint: '改配置' }),
    tracker,
    exitCode: 2,
  })

  assert.equal(report.ok, false)
  assert.equal(report.exitCode, 2)
  assert.equal(report.error.code, ErrorCode.CONFIG_INVALID)
  assert.equal(report.stages[0].status, 'failed')
  assert.equal(report.stages[0].errorCode, ErrorCode.CONFIG_INVALID)
  assert.equal(report.stages[1].status, 'skipped')
})

test('失败报告：error 字段结构固定，hint 缺失时为 null', () => {
  const tracker = new StageTracker()
  const report = failureReport({
    error: new BuildError(ErrorCode.INTERNAL, '炸了'),
    tracker,
    exitCode: 1,
  })
  assert.equal(report.error.hint, null)
  assert.deepEqual(report.error.details, [])
})

test('报告时间戳可被 Date 解析', () => {
  const tracker = new StageTracker()
  const report = failureReport({
    error: new BuildError(ErrorCode.INTERNAL, 'x'),
    tracker,
    exitCode: 1,
  })
  assert.ok(Number.isFinite(Date.parse(report.startedAt)))
  assert.ok(Number.isFinite(Date.parse(report.finishedAt)))
})
// ---------------------------------------------------------------------------
// CLI 层：--report 下 stdout 必须永远有一份 JSON
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 参数缺失也必须吐报告。
 *
 * 这条曾漏过：`commandBuild` 的参数校验发生在 `--report` 判定之前，
 * 漏参数时直接 `stderr.write` + return，stdout 完全是空的。console
 * 拿到空输入只能显示「未知错误」，用户看不出是自己少敲了个目录。
 *
 * 注意 `verify` 早先已单独处理过，这里一并覆盖以防将来被改回去。
 */
function runCli(args) {
  const bin = join(HERE, '..', 'bin', 'mac2win.mjs')
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  })
}

for (const command of ['build', 'verify']) {
  test(`${command} 缺参数时 --report 仍输出合规报告`, () => {
    const result = runCli([command, '--report'])
    assert.equal(result.status, 2, `退出码应为 2，实际 ${result.status}`)

    const report = JSON.parse(result.stdout)
    assert.equal(report.direction, 'mac2win')
    assert.equal(report.ok, false)
    assert.equal(report.exitCode, 2)
    assert.equal(report.command, command)
    assert.equal(report.ok, report.exitCode === 0)
    assert.match(report.error.code, /^M2W_1\d{3}$/)
    assert.match(result.stderr, /缺少/)
  })
}

/**
 * `undefined` 与 `null` 在这里必须一样处理。
 *
 * 真实故障：`doctor` 调 `successReport` 时只传了
 * `{ artifact: null, artifactSize: 0, durationMs: 0 }`，没传 `zipArtifact`。
 * 旧代码判的是 `result.zipArtifact !== null`——`undefined !== null` 为真，
 * 于是 `artifacts` 里多出一条 `{kind: 'zip', target: 'x86'}`，`path` 与
 * `bytes` 全缺。
 *
 * 两个后果：
 * 1. 契约要求 `artifacts[].path` 是非空字符串，整份报告不合规；
 * 2. 下游按 `artifacts.length > 0` 判断「有产物可下载」时，会渲染出
 *    一个点不动的下载链接。
 */
test('成功报告：产物字段缺失时不留空记录', () => {
  const tracker = new StageTracker()
  const report = successReport({
    config: { projectRoot: '/tmp/x', framework: 'static', target: 'x86', format: 'nsis' },
    result: {
      artifact: null,
      artifactSize: 0,
      // 故意不传 zipArtifact / zipSize
      durationMs: 0,
    },
    tracker,
    command: 'doctor',
  })

  assert.deepEqual(report.artifacts, [], '没有产物时 artifacts 必须是空数组')
})

test('成功报告：空字符串路径不算产物', () => {
  const tracker = new StageTracker()
  const report = successReport({
    config: { projectRoot: '/tmp/x', framework: 'static', target: 'x86', format: 'nsis' },
    result: {
      artifact: '',
      artifactSize: 0,
      zipArtifact: '',
      zipSize: 0,
      durationMs: 0,
    },
    tracker,
  })

  /*
   * 空字符串比 undefined 更隐蔽：`typeof '' === 'string'` 成立，
   * 只判类型会放过去。而 `path: ''` 同样不合契约，同样渲染成死链。
   */
  assert.deepEqual(report.artifacts, [])
})
