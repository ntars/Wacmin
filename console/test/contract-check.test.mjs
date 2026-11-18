/**
 * 契约一致性检查器的测试。
 *
 * 跑法：cd console && npm test
 *
 * ## 这套测试在守护什么
 *
 * 检查器本身也可能有 bug，而且它的 bug 危害更大 —— 一个误报会让用户
 * 开始忽略所有报告。开发过程中就踩到两次：
 *
 *   1. 前缀正则写成 `[A-Z]{2,4}`，不认 `M2W` / `W2M` 里的数字，
 *      导致 mac2win 与 win2mac 的错误码全部被误判为「格式不符」
 *   2. 白名单漏了 schema 里的 `checks`，导致四个方向的 doctor 报告
 *      全部被误判为「有多余字段」
 *
 * 所以这里既测检查逻辑本身，也测「检查器的配置与契约文件同步」。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  REQUIRED_REPORT_FIELDS, allowedReportFields, checkReport,
  classifyCode, loadContract,
} from '../src/contract-check.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')

/** 造一份合法报告。 */
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
    ...overrides,
  }
}

describe('契约文件读取', () => {
  test('读到四个方向的前缀', () => {
    const contract = loadContract()
    assert.deepEqual(Object.keys(contract.prefixes).sort(),
      ['apponwin', 'exeonmac', 'mac2win', 'win2mac'])
    assert.equal(contract.prefixes.mac2win, 'M2W')
    assert.equal(contract.prefixes.win2mac, 'W2M')
    assert.equal(contract.prefixes.exeonmac, 'EOM')
    assert.equal(contract.prefixes.apponwin, 'AOW')
  })

  test('读到段位定义', () => {
    const contract = loadContract()
    assert.ok('1000' in contract.segments)
    assert.equal(contract.segments['1000'].range, '1001-1999')
  })
})

describe('错误码分类', () => {
  const { segments } = loadContract()

  test('含数字的前缀能正确识别', () => {
    /*
     * 这条是本套最重要的回归测试。
     *
     * M2W 与 W2M 都含数字 2。早期正则只允许 [A-Z]，这两个方向的
     * 全部错误码被判为「格式不符」—— 而这是检查器自己的 bug，
     * 不是方向的违规。
     */
    for (const code of ['M2W_1001', 'W2M_6001', 'EOM_5001', 'AOW_1002']) {
      const result = classifyCode(code, segments)
      assert.equal(result.ok, true, `${code} 应被识别：${result.reason}`)
    }
  })

  test('各段位归类正确', () => {
    const cases = [
      ['M2W_1001', '1000'],
      ['M2W_2001', '2000'],
      ['M2W_3001', '3000'],
      ['M2W_4001', '4000'],
      ['M2W_5001', '5000'],
      ['M2W_6001', '6000'],
      ['M2W_7001', '7000'],
      ['M2W_9001', '9000'],
      ['M2W_9999', '9999'],
    ]
    for (const [code, expected] of cases) {
      assert.equal(classifyCode(code, segments).segment, expected, code)
    }
  })

  test('越界段位被判不合法', () => {
    const result = classifyCode('M2W_8888', segments)
    assert.equal(result.ok, false)
    assert.match(result.reason, /不在任何已定义范围内/u)
  })

  test('格式错误被判不合法', () => {
    for (const code of ['M2W1001', 'M2W_100', 'm2w_1001', 'M2W_10011', '']) {
      assert.equal(classifyCode(code, segments).ok, false, code)
    }
  })

  test('单值段位 9999 能匹配', () => {
    assert.equal(classifyCode('M2W_9999', segments).segment, '9999')
  })
})

describe('白名单与 schema 同步', () => {
  const schema = JSON.parse(
    readFileSync(join(REPO, 'contracts', 'run-report.schema.json'), 'utf8'))

  test('白名单与 schema 的 properties 完全一致', () => {
    /*
     * 检查器的白名单必须与 run-report.schema.json 的 properties 一致。
     *
     * 这个位置出过两次事，方向相反：
     *
     *   1. 漏了 `checks`，四个方向的 doctor 报告全被误判为「有多余字段」
     *   2. 多了 schema 里根本没有的 `config` / `nextSteps`，于是检查器
     *      比契约更宽松 —— 真有人写出 `config` 也放行，而 schema 的
     *      `additionalProperties: false` 明令禁止
     *
     * 现在白名单直接从 schema 读，两边不可能再分叉。这条测试于是从
     * 「抓不同步」变成「证明白名单确实来自 schema」。
     */
    assert.deepEqual(allowedReportFields(schema), Object.keys(schema.properties).sort())
  })

  test('白名单不含 schema 未定义的字段', () => {
    /*
     * 反向检查：多出来的字段会让检查器放行 schema 禁止的东西。
     * 早先 `config` 与 `nextSteps` 就是这么混进来的。
     */
    const schemaFields = new Set(Object.keys(schema.properties))
    const extra = allowedReportFields(schema).filter((field) => !schemaFields.has(field))
    assert.deepEqual(extra, [],
      `白名单含 schema 未定义的字段：${extra.join(', ')}`)
  })

  test('contract 里带上了 schema', () => {
    /* checkReport 需要 schema 才能判断类型，loadContract 必须提供。 */
    assert.ok(loadContract().schema !== undefined)
    assert.ok(loadContract().schema.properties !== undefined)
  })

  test('必需字段都在白名单里', () => {
    const whitelist = allowedReportFields(schema)
    for (const field of REQUIRED_REPORT_FIELDS) {
      assert.ok(whitelist.includes(field), `${field} 不在白名单`)
    }
  })

  test('必需字段与 schema 的 required 一致', () => {
    assert.deepEqual([...REQUIRED_REPORT_FIELDS].sort(), [...schema.required].sort())
  })

  test('checkReport 真的用的是 schema 白名单', () => {
    /*
     * 这条补一个测试盲区。
     *
     * 上面几条验的是「导出的 allowedReportFields() 与 schema 同步」，
     * 但**没验 checkReport 内部实际用的是它**。回滚验证时踩到了：
     * 把 checkReport 里的白名单改回硬编码（含 schema 没有的 config /
     * nextSteps），上面的测试全部照样通过 —— 因为它们调的是导出函数，
     * 而 checkReport 已经不用它了。
     *
     * 所以这里从行为侧验：喂一份带 `config` 的报告，必须被判为多余字段。
     * `config` 是真实出现过的字段（mac2win / win2mac / apponwin 都写它），
     * 而 schema 的 additionalProperties 是 false。
     */
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({ config: { target: 'x86' } }),
      exitCode: 0,
      contract: loadContract(),
    })
    assert.ok(result.problems.some((p) => p.check === 'report.no_extra_fields'),
      '带 config 的报告必须被发现「有多余字段」')
  })

  test('schema 定义过的字段不误报为多余', () => {
    /* 反向保险：不能因为改行为侧检查就把合法字段也判成多余。 */
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({ host: { platform: 'darwin', arch: 'arm64' } }),
      exitCode: 0,
      contract: loadContract(),
    })
    assert.equal(result.problems.some(
      (p) => p.check === 'report.no_extra_fields'), false)
  })
})

describe('报告检查', () => {
  const contract = loadContract()

  test('合法报告通过', () => {
    const result = checkReport({
      direction: 'mac2win', report: validReport(), exitCode: 0, contract,
    })
    assert.equal(result.ok, true,
      result.problems.map((p) => `${p.check}: ${p.detail}`).join('; '))
  })

  test('报告为 null 时报错', () => {
    const result = checkReport({
      direction: 'mac2win', report: null, exitCode: 1, contract,
    })
    assert.equal(result.ok, false)
    assert.equal(result.problems[0].check, 'report.present')
  })

  test('缺必需字段被抓出', () => {
    const report = validReport()
    delete report.stages
    const result = checkReport({
      direction: 'mac2win', report, exitCode: 0, contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'report.required_fields'))
  })

  test('多余字段被抓出', () => {
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({ totallyMadeUpField: true }),
      exitCode: 0,
      contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'report.no_extra_fields'))
  })

  test('direction 串台被抓出', () => {
    /*
     * 这是复制粘贴最容易犯的错：把 mac2win 的报告模板拷到 win2mac
     * 却没改 direction。报告结构完全合法，只有这个字段能暴露问题。
     */
    const result = checkReport({
      direction: 'win2mac',
      report: validReport({ direction: 'mac2win' }),
      exitCode: 0,
      contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'report.direction_match'))
  })

  test('ok 与 exitCode 不一致被抓出', () => {
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({ ok: true, exitCode: 5 }),
      exitCode: 5,
      contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'report.ok_matches_exit_code'))
  })

  test('报告 exitCode 与进程退出码不一致被抓出', () => {
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({ ok: false, exitCode: 1 }),
      exitCode: 5,
      contract,
    })
    assert.ok(result.problems.some(
      (p) => p.check === 'report.exit_code_matches_process'))
  })

  test('schemaVersion 不符被抓出', () => {
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({ schemaVersion: 2 }),
      exitCode: 0,
      contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'report.schema_version'))
  })

  test('阶段状态非法被抓出', () => {
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({
        stages: [{ id: 0, name: '预检', status: 'weird', durationMs: 1 }],
      }),
      exitCode: 0,
      contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'report.stage_status'))
  })

  test('失败后仍继续执行被抓出', () => {
    /*
     * 契约明文要求「失败即停」。违反通常意味着实现里没在失败处 return，
     * 继续跑了后续步骤 —— 那会产出半成品。
     */
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({
        ok: false,
        exitCode: 1,
        stages: [
          { id: 0, name: '预检', status: 'ok', durationMs: 1 },
          { id: 1, name: '构建', status: 'failed', durationMs: 1 },
          { id: 2, name: '打包', status: 'ok', durationMs: 1 },
        ],
      }),
      exitCode: 1,
      contract,
    })
    assert.ok(result.problems.some(
      (p) => p.check === 'report.stage_stop_on_failure'))
  })

  test('失败后阶段全部 skipped 是合法的', () => {
    /*
     * 注意 exitCode 与 error.code 的配对：5001 属 5xxx 段，按契约
     * 对应退出码 6（产物生成失败）。早先这里写的是 exitCode: 1，
     * 而退出码 1 按契约只能配 9999 —— 那是不合法的组合，
     * 检查器补上配对检查后这条用例就红了。
     *
     * 这条测的是「failed 之后跟 skipped 不算违反失败即停」，
     * 不该被一个无关的错误码配对问题绊住，所以把数据改对。
     */
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({
        ok: false,
        exitCode: 6,
        error: { code: 'M2W_5001', message: '失败' },
        stages: [
          { id: 0, name: '预检', status: 'ok', durationMs: 1 },
          { id: 1, name: '构建', status: 'failed', durationMs: 1 },
          { id: 2, name: '打包', status: 'skipped', durationMs: 0 },
        ],
      }),
      exitCode: 6,
      contract,
    })
    assert.equal(result.ok, true,
      result.problems.map((p) => `${p.check}: ${p.detail}`).join('; '))
  })

  test('错误码前缀不对被抓出', () => {
    const result = checkReport({
      direction: 'win2mac',
      report: validReport({
        direction: 'win2mac', ok: false, exitCode: 1,
        error: { code: 'M2W_1001', message: '用了别家的前缀' },
      }),
      exitCode: 1,
      contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'error.prefix'))
  })

  test('使用保留前缀被抓出', () => {
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({
        ok: false, exitCode: 1,
        error: { code: 'WAC_1001', message: 'x' },
      }),
      exitCode: 1,
      contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'error.prefix_reserved'))
  })

  test('错误码段位越界被抓出', () => {
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({
        ok: false, exitCode: 1,
        error: { code: 'M2W_8888', message: 'x' },
      }),
      exitCode: 1,
      contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'error.segment'))
  })

  /*
   * ── 退出码与错误码必须配对 ──────────────────────────────────────────
   *
   * 这一组来自实测发现的真实违规：`apponwin spike` 退出码 5，报告里
   * 却填 `AOW_1001`（1xxx 段，按契约对应退出码 2）。
   *
   * 关键点：这条违规**通过了当时所有的单项检查** —— 前缀是本人的、
   * 段位存在、结构合法、ok 与 exitCode 一致。只有把两者放在一起
   * 比对才看得出来。
   */
  test('退出码 5 配 1xxx 段的码被抓出（真实违规的形态）', () => {
    const result = checkReport({
      direction: 'apponwin',
      report: validReport({
        direction: 'apponwin', ok: false, exitCode: 5,
        error: { code: 'AOW_1001', message: '当前机器不是 Windows' },
      }),
      exitCode: 5,
      contract,
    })
    assert.ok(
      result.problems.some((p) => p.check === 'error.exit_code_pair'),
      `退出码 5 配 AOW_1001 必须被拦下，实际问题：`
        + result.problems.map((p) => `${p.check}: ${p.detail}`).join('; '))
  })

  test('配对正确时不报错（退出码 5 配 2001）', () => {
    const result = checkReport({
      direction: 'apponwin',
      report: validReport({
        direction: 'apponwin', ok: false, exitCode: 5,
        error: { code: 'AOW_2001', message: '缺 WSL2' },
      }),
      exitCode: 5,
      contract,
    })
    assert.equal(result.ok, true,
      result.problems.map((p) => `${p.check}: ${p.detail}`).join('; '))
  })

  test('退出码 4 配 1005 通过，配 1002 被抓出', () => {
    /*
     * 1002 与 1005 同在 1xxx 段，唯一区别是退出码 2 与 4。
     * 这正是「段位检查」看不出、必须做配对检查的地方。
     */
    const good = checkReport({
      direction: 'mac2win',
      report: validReport({
        ok: false, exitCode: 4,
        error: { code: 'M2W_1005', message: '不支持' },
      }),
      exitCode: 4,
      contract,
    })
    assert.equal(good.ok, true,
      good.problems.map((p) => `${p.check}: ${p.detail}`).join('; '))

    const bad = checkReport({
      direction: 'mac2win',
      report: validReport({
        ok: false, exitCode: 4,
        error: { code: 'M2W_1002', message: '路径不存在' },
      }),
      exitCode: 4,
      contract,
    })
    assert.ok(bad.problems.some((p) => p.check === 'error.exit_code_pair'))
  })

  test('范围型段位（6xxx / 7xxx）也能配对', () => {
    /*
     * errorSegment 写成 "4001-5002" 这种范围时，早先只按 "/" 切分
     * 会把它当成单个字符串比较，永远对不上 —— 于是退出码 6/7 的
     * 配对检查静默失效。这条守住范围型的处理。
     */
    const build = checkReport({
      direction: 'mac2win',
      report: validReport({
        ok: false, exitCode: 6,
        error: { code: 'M2W_4001', message: '构建失败' },
      }),
      exitCode: 6,
      contract,
    })
    assert.equal(build.ok, true,
      `4001 落在 4001-5002 范围内，应通过。实际：`
        + build.problems.map((p) => `${p.check}: ${p.detail}`).join('; '))

    const verify = checkReport({
      direction: 'mac2win',
      report: validReport({
        ok: false, exitCode: 7,
        error: { code: 'M2W_6001', message: '校验失败' },
      }),
      exitCode: 7,
      contract,
    })
    assert.equal(verify.ok, true,
      `6001 落在 6001-6003 范围内，应通过。实际：`
        + verify.problems.map((p) => `${p.check}: ${p.detail}`).join('; '))
  })

  test('ok=false 却没有 error 被抓出', () => {
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({ ok: false, exitCode: 1 }),
      exitCode: 1,
      contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'error.required_on_failure'))
  })

  test('含数字前缀的失败报告能通过', () => {
    /*
     * M2W / W2M 含数字，是最容易误判的一类。
     *
     * 1002 属 1xxx 段，按契约对应退出码 2。早先这里写 exitCode: 1，
     * 与 1002 不配对（退出码 1 只能配 9999）—— 补上配对检查后才暴露。
     */
    const result = checkReport({
      direction: 'win2mac',
      report: validReport({
        direction: 'win2mac', ok: false, exitCode: 2,
        error: { code: 'W2M_1002', message: '输入不存在' },
      }),
      exitCode: 2,
      contract,
    })
    assert.equal(result.ok, true,
      result.problems.map((p) => `${p.check}: ${p.detail}`).join('; '))
  })
})

/*
 * ── 畸形报告的容错 ────────────────────────────────────────────────────
 *
 * 这一组全部来自实际探测。核心要求有两条：
 *
 *   ① 检查器**绝不能抛异常**。它一抛，runContractCheck 的 catch 就会
 *      记成「调用 <方向> 抛错」，把检查器自己的 bug 栽给无辜的方向。
 *   ② 类型错误**不能被静默放过**。早先只在用得着的地方做 Array.isArray
 *      判断，类型不对就跳过那一段，于是 `checks: {}`、`ok: "true"` 全部
 *      被判为合法 —— 检查器对类型错误整体失明。
 */
describe('畸形报告：不抛异常', () => {
  const contract = loadContract()

  /** 一批会出现在真实报告里的畸形形状。 */
  const MALFORMED = {
    'stages 含 null': validReport({ stages: [null] }),
    'stages 含 undefined': validReport({ stages: [undefined] }),
    'stages 含字符串': validReport({ stages: ['x'] }),
    'stages 是对象': validReport({ stages: { 0: { status: 'ok' } } }),
    'checks 含 null': validReport({ checks: [null] }),
    'checks 是对象': validReport({ checks: { a: 1 } }),
    'artifacts 含 null': validReport({ artifacts: [null] }),
    'artifacts 是对象': validReport({ artifacts: { path: '/x' } }),
    'warnings 是字符串': validReport({ warnings: 'x' }),
    'warnings 含对象': validReport({ warnings: [{ a: 1 }] }),
    'error 是字符串': validReport({ ok: false, exitCode: 1, error: 'boom' }),
    'error 是数字': validReport({ ok: false, exitCode: 1, error: 500 }),
    'error 是数组': validReport({ ok: false, exitCode: 1, error: [] }),
    'null 报告': null,
    '数组报告': [],
    '字符串报告': 'x',
  }

  test('全部畸形形状都不抛，且被判为不合规', () => {
    for (const [name, report] of Object.entries(MALFORMED)) {
      let result
      assert.doesNotThrow(() => {
        result = checkReport({
          direction: 'mac2win', report,
          exitCode: typeof report === 'object' && report !== null
            ? (report.exitCode ?? 0) : 0,
          contract,
        })
      }, `${name} 让检查器抛异常`)
      assert.equal(result.ok, false, `${name} 应被判为不合规`)
      assert.ok(result.problems.length > 0, `${name} 没有给出任何问题项`)
    }
  })

  test('stages 含 null 被指出，不是崩掉', () => {
    /*
     * 这一条是本组的核心。早先 forEach 里有 null 保护，但紧接着算
     * 「失败即停」时对原始数组取 `.status`，一个 null 就抛 TypeError。
     */
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({ stages: [{ id: 0, name: 'a', status: 'ok' }, null] }),
      exitCode: 0,
      contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'report.stage_shape'))
  })

  test('stages 全为空值时不误报「失败即停」', () => {
    /*
     * 过滤掉非法项后数组为空，findIndex 返回 -1，不应报出任何
     * stage_stop_on_failure。若忘了过滤，这里会抛。
     */
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({ stages: [null, null] }),
      exitCode: 0,
      contract,
    })
    assert.equal(result.problems.some(
      (p) => p.check === 'report.stage_stop_on_failure'), false)
  })

  test('输入 undefined 报告不抛', () => {
    const result = checkReport({
      direction: 'mac2win', report: undefined, exitCode: 1, contract,
    })
    assert.equal(result.problems[0].check, 'report.present')
  })
})

describe('畸形报告：类型错误必须被指出', () => {
  const contract = loadContract()

  test('ok 是字符串被抓出', () => {
    /*
     * `ok: "true"` 是 truthy，但 `ok === true` 是 false。前端与后端
     * 若一处用真值、一处用严格比较，界面就会自相矛盾。
     */
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({ ok: 'true' }),
      exitCode: 0,
      contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'report.field_type'))
  })

  test('exitCode 是字符串被抓出', () => {
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({ exitCode: '0' }),
      exitCode: 0,
      contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'report.field_type'))
  })

  test('exitCode 是小数被抓出', () => {
    /* schema 写的是 integer，1.5 不合法，typeof === 'number' 会放过 */
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({ exitCode: 1.5, ok: false }),
      exitCode: 1.5,
      contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'report.field_type'))
  })

  test('checks 是对象被抓出（不静默跳过）', () => {
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({ checks: { a: 1 } }),
      exitCode: 0,
      contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'report.field_type'))
    assert.ok(result.problems.some((p) => p.check === 'report.checks_array'))
  })

  test('artifacts 是对象被抓出', () => {
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({ artifacts: { path: '/x' } }),
      exitCode: 0,
      contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'report.artifacts_array'))
  })

  test('warnings 是字符串被抓出', () => {
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({ warnings: 'x' }),
      exitCode: 0,
      contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'report.warnings_array'))
  })

  test('artifacts 含 null 被抓出', () => {
    /*
     * 这一条来自真实的 500：服务端下载接口读 `.path` 抛 TypeError。
     * 检查在源头标出来，比等用户点下载才发现好得多。
     */
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({ artifacts: [null] }),
      exitCode: 0,
      contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'report.artifact_shape'))
  })

  test('artifacts 项缺 path 被抓出', () => {
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({ artifacts: [{ kind: 'zip' }] }),
      exitCode: 0,
      contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'report.artifact_shape'))
  })

  test('warnings 含非字符串被抓出', () => {
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({ warnings: [{ a: 1 }] }),
      exitCode: 0,
      contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'report.warning_shape'))
  })

  test('error 是字符串时指出类型，而不是「缺 code」', () => {
    /*
     * 早先会报「有 error 对象但缺 code」—— 那是在描述一个不存在的
     * 现象（根本没有 code 这个字段可缺）。真正的问题是 error 本身
     * 不是对象。
     */
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({ ok: false, exitCode: 1, error: 'boom' }),
      exitCode: 1,
      contract,
    })
    assert.ok(result.problems.some((p) => p.check === 'error.object'))
    assert.equal(result.problems.some((p) => p.check === 'error.code_present'), false)
  })

  test('合法报告不因新增的类型检查而误报', () => {
    /* 新增检查最怕自己制造噪音 —— 一份完全合规的报告必须零问题。 */
    const result = checkReport({
      direction: 'mac2win',
      report: validReport({
        artifacts: [{ path: '/tmp/a.zip', kind: 'zip', bytes: 10 }],
        checks: [{ name: '产物存在', passed: true, detail: 'ok' }],
        warnings: ['只是提醒'],
        error: null,
      }),
      exitCode: 0,
      contract,
    })
    assert.equal(result.ok, true,
      result.problems.map((p) => `${p.check}: ${p.detail}`).join('; '))
  })
})

describe('检查器自身崩溃的归因', () => {
  test('检查器抛异常时标成 checker.crash，不栽给方向', async () => {
    /*
     * 这是本组最重要的一条。
     *
     * 早先 runContractCheck 用一个 try 同时罩着 input.run 和 checkReport，
     * 于是 checkReport 抛出的 TypeError 被记成「调用 mac2win doctor 抛错」。
     * 用户会跑去翻 mac2win 的源码，而它完全正常 —— 错误归因错了比不报错
     * 更浪费时间。
     *
     * 现在分成两个 try：调用失败说「调用抛错」，检查失败说「检查器自身
     * 异常」，并明示「这是 console 的缺陷」。
     */
    const { runContractCheck } = await import('../src/contract-check.mjs')

    /*
     * 用一个必然让 checkReport 抛的输入。正常路径已经不会抛了，所以
     * 这里直接注入一个 getter —— 读 `stages` 时抛错，模拟将来某个
     * 新加的检查漏了防御。
     */
    const hostile = {
      schemaVersion: 1, direction: 'mac2win', ok: true, exitCode: 0,
      startedAt: 'a', finishedAt: 'b',
    }
    Object.defineProperty(hostile, 'stages', {
      enumerable: true,
      get() { throw new Error('模拟读取字段时崩溃') },
    })

    const result = await runContractCheck({
      run: async () => ({ exitCode: 0, report: hostile }),
      directions: ['mac2win'],
    })

    const scenario = result.results[0].scenarios[0]
    assert.equal(scenario.ok, false)
    assert.equal(scenario.problems[0].check, 'checker.crash')
    assert.match(scenario.problems[0].detail, /console 的缺陷/u)
    assert.doesNotMatch(scenario.problems[0].detail, /调用 mac2win/u,
      '检查器崩溃不该被描述成方向的问题')
  })

  test('方向自身抛异常时仍标 scenario.crash', async () => {
    /* 两类失败必须能区分开，这条保证另一半没被改坏。 */
    const { runContractCheck } = await import('../src/contract-check.mjs')
    const result = await runContractCheck({
      run: async () => { throw new Error('子进程启动失败') },
      directions: ['mac2win'],
    })
    const scenario = result.results[0].scenarios[0]
    assert.equal(scenario.problems[0].check, 'scenario.crash')
    assert.match(scenario.problems[0].detail, /调用 mac2win/u)
  })

  test('run 返回 undefined 时不抛', async () => {
    /* 注入的 run 写错时（忘了 return），检查器不该跟着崩。 */
    const { runContractCheck } = await import('../src/contract-check.mjs')
    const result = await runContractCheck({
      run: async () => undefined,
      directions: ['mac2win'],
    })
    assert.equal(result.results[0].ok, false)
    assert.doesNotThrow(() => JSON.stringify(result))
  })
})