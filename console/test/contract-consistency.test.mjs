/**
 * 两个契约校验器的一致性守卫。
 *
 * ## 为什么需要这个文件
 *
 * 仓库里有两个校验器，服务于不同场景，但**判断的是同一件事**：
 *
 * | 校验器 | 场景 | 强弱 |
 * |---|---|---|
 * | `contracts/validate.mjs` | CI 第一步，离线，只看 JSON | 曾弱得多 |
 * | `console/src/contract-check.mjs` | 真跑四方向，读运行时报告 | 28 项检查 |
 *
 * 审计时发现两者对**同一份报告**给出过相反结论：`console` 报「有契约
 * 未定义的字段」，`validate.mjs` 报「✓ 契约自洽」。这不是理论风险 ——
 * 意味着 CI 全绿而看板在报错，或者反过来。
 *
 * 根因与 `contract-check.mjs` 注释里记的两次事故同源：**同一语义存了
 * 两份实现**。两份独立演化的检查逻辑必然分叉，只是时间问题。
 *
 * ## 这一套守的是什么
 *
 * 不要求两者报同样的文案（那会把两份实现耦死），只要求**结论一致**：
 * 「应当违规」的样本两边都判违规，「应当合规」的样本两边都放行。
 *
 * 跑法：cd console && npm test
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkReport, loadContract } from '../src/contract-check.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const VALIDATOR = join(REPO, 'contracts', 'validate.mjs')

/** 一份必然合法的报告 —— 两个校验器都应放行。 */
function validReport(overrides = {}) {
  return {
    schemaVersion: 1,
    direction: 'mac2win',
    ok: true,
    exitCode: 0,
    command: 'doctor',
    startedAt: '2026-11-14T00:00:00.000Z',
    finishedAt: '2026-11-14T00:00:01.000Z',
    durationMs: 1000,
    host: { platform: 'darwin', arch: 'arm64' },
    stages: [{ id: 0, name: '预检', status: 'ok', durationMs: 10 }],
    artifacts: [],
    checks: [{ name: 'platform', passed: true }],
    warnings: [],
    error: null,
    ...overrides,
  }
}

/**
 * 用 `contracts/validate.mjs` 判一份报告是否合规。
 *
 * @returns {{ok: boolean, detail: string}}
 */
function validateWithCli(report) {
  const dir = mkdtempSync(join(tmpdir(), 'wacmin-consistency-'))
  try {
    const path = join(dir, 'report.json')
    writeFileSync(path, JSON.stringify(report), 'utf8')
    const result = spawnSync(process.execPath, [VALIDATOR, '--report', path],
      { encoding: 'utf8' })
    return { ok: result.status === 0, detail: (result.stderr || result.stdout).trim() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 用 console 的检查器判一份报告是否合规。 */
function validateWithConsole(report) {
  const result = checkReport({
    direction: report.direction,
    report,
    exitCode: report.exitCode,
    contract: loadContract(),
    expectedCommand: report.command,
  })
  return {
    ok: result.ok,
    detail: result.problems.map((problem) => `${problem.check}: ${problem.detail}`).join('; '),
  }
}

/**
 * 断言两个校验器给出同一个结论。
 *
 * @param {string} label 样本说明
 * @param {object} report 报告
 * @param {boolean} expectReject 期望是否违规
 */
function assertAgree(label, report, expectReject) {
  const cli = validateWithCli(report)
  const console_ = validateWithConsole(report)

  assert.equal(cli.ok, !expectReject,
    `[${label}] contracts/validate.mjs ${expectReject ? '应判违规' : '应放行'}，`
    + `实际 ${cli.ok ? '放行' : '违规'}：${cli.detail}`)
  assert.equal(console_.ok, !expectReject,
    `[${label}] console 检查器 ${expectReject ? '应判违规' : '应放行'}，`
    + `实际 ${console_.ok ? '放行' : '违规'}：${console_.detail}`)
}

describe('两个校验器的结论必须一致', () => {
  /*
   * 合规样本。两侧都放行，说明没有「检查器自己制造噪音」的问题 ——
   * 一旦某个校验器开始误报，用户就会开始忽略所有报告，比不检查更糟。
   */
  test('合规报告两边都放行', () => {
    assertAgree('合规', validReport(), false)
  })

  test('失败路径的合规报告两边都放行', () => {
    assertAgree('失败但合规', validReport({
      ok: false,
      exitCode: 2,
      error: { code: 'M2W_1003', message: '输入物不存在', hint: null, details: [] },
    }), false)
  })

  /*
   * P0-2 那类：schema 的 additionalProperties: false 没人执行。
   * 这是审计里最先暴露的分叉点 —— console 报违规，validate.mjs 放行。
   */
  test('顶层多余字段：两边都判违规', () => {
    assertAgree('多余字段', validReport({ 这个字段不该存在: 1 }), true)
  })

  test('嵌套层多余字段：两边都判违规', () => {
    assertAgree('嵌套多余字段',
      validReport({ stages: [{ id: 0, name: 'A', status: 'ok', bogus: 1 }] }), true)
  })

  /*
   * 类型错。`exitCode: "0"` 是典型样本：结构看起来齐全，但前端按
   * `=== 0` 判断时会得到 false。
   */
  test('exitCode 类型错：两边都判违规', () => {
    assertAgree('类型错', validReport({ exitCode: '0' }), true)
  })

  test('checks 类型错：两边都判违规', () => {
    assertAgree('checks 类型错', validReport({ checks: {} }), true)
  })

  /*
   * 退出码与错误码分叉。这类样本的每一项单项检查都通过 ——
   * 前缀是本人的、段位存在、结构合法，只有把两者放一起比才看得出。
   */
  test('退出码与错误码不配对：两边都判违规', () => {
    assertAgree('退出码配错', validReport({
      ok: false, exitCode: 2,
      error: { code: 'M2W_1005', message: 'x' },
    }), true)
  })

  /*
   * P0-3 那类：段位越界。用 8888 这个谁都不占的码值。
   */
  test('错误码段位越界：两边都判违规', () => {
    assertAgree('段位越界', validReport({
      ok: false, exitCode: 1,
      error: { code: 'M2W_8888', message: 'x' },
    }), true)
  })

  /*
   * 9999 段位是 P0-3 的核心样本。
   *
   * 契约里 9999 是独立段位（INFRA），range 是单值。旧 validate.mjs 按
   * 首字符把 9999 推成 9000 桶 —— 于是这个段位的定义永远命中不了，
   * 删掉它校验仍全绿。console 的 classifyCode 一直是对的。
   *
   * 这一条同时验证：修好之后，9999 配 exitCode 1 在两边都是合法配对。
   */
  test('9999 段位：两边都放行（不是越界）', () => {
    assertAgree('9999 合法', validReport({
      ok: false, exitCode: 1,
      error: { code: 'M2W_9999', message: '兜底内部错误' },
    }), false)
  })

  /*
   * 「失败即停」是契约明文。违反意味着实现没在失败处 return。
   */
  test('失败后仍有 ok 阶段：两边都判违规', () => {
    assertAgree('失败即停', validReport({
      ok: false, exitCode: 6,
      stages: [
        { id: 0, name: '打包', status: 'failed' },
        { id: 1, name: '校验', status: 'ok' },
      ],
      error: { code: 'M2W_4001', message: 'x' },
    }), true)
  })

  /*
   * 产物结构。`artifacts: [null]` 会让 console 的下载接口抛 TypeError，
   * 整个请求变 500，而看板上只表现为「点了没反应」。
   */
  test('artifacts 项为 null：两边都判违规', () => {
    assertAgree('产物为 null', validReport({ artifacts: [null] }), true)
  })

  test('checks 项缺 passed：两边都判违规', () => {
    assertAgree('checks 缺 passed',
      validReport({ checks: [{ name: 'x', ok: true }] }), true)
  })

  /*
   * ok 与 error 的互斥（schema 的 allOf if/then）。
   *
   * 两边都必须管这一条：一侧漏掉就会出现「同一份报告，一个说成功一个
   * 说失败」。前端读到 error 显示失败提示、读到 ok 显示成功横幅。
   */
  test('ok=true 却带 error：两边都判违规', () => {
    assertAgree('ok 与 error 矛盾', validReport({
      ok: true, exitCode: 0,
      error: { code: 'M2W_9999', message: 'x' },
    }), true)
  })

  test('ok=false 却缺 error：两边都判违规', () => {
    assertAgree('缺 error', validReport({ ok: false, exitCode: 1, error: null }), true)
  })

  /*
   * 阶段状态枚举。
   *
   * 这一条以前只在 console 侧检查，validate.mjs 放行 —— 正是分叉的
   * 典型形态：同一个契约字段，一个校验器当回事，另一个不当。
   */
  test('非法阶段状态：两边都判违规', () => {
    assertAgree('非法状态',
      validReport({ stages: [{ id: 0, name: 'A', status: 'great' }] }), true)
  })

  test('非法 direction：两边都判违规', () => {
    /*
     * 注意契约里两个方向拼错、且调用方也照着拼错的情况 —— 这才能测出
     * 「direction 必须在 enum 内」这条独立判断。console 另有一条
     * 「与调用方一致」，那条对 `linux` 会放行（调用方也是 linux）。
     */
    assertAgree('非法方向', validReport({ direction: 'linux' }), true)
  })

  test('direction 与调用方一致但不在 enum 内：两边都判违规', () => {
    const report = validReport({ direction: 'mac2windows' })
    const cli = validateWithCli(report)
    /*
     * console 侧的期望方向参数这里故意传同一个错值，模拟「实现与调用方
     * 一起写错」。只测 enum 那一条，不测 ④。
     */
    const result = checkReport({
      direction: 'mac2windows',
      report,
      exitCode: report.exitCode,
      contract: loadContract(),
      expectedCommand: report.command,
    })
    assert.equal(cli.ok, false, `contracts/validate.mjs 应判违规：${cli.detail}`)
    assert.equal(result.ok, false, 'console 应判违规（enum 那条）')
    assert.ok(result.problems.some((p) => p.check === 'report.direction_enum'),
      `应由 report.direction_enum 报出，实际：${result.problems.map((p) => p.check).join(',')}`)
  })
})
