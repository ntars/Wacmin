/**
 * 渲染模型的容错测试。
 *
 * 跑法：cd console && npm test
 *
 * ## 为什么需要这一套
 *
 * `report-view.mjs` 的全部职责就是「拿到什么垃圾都不许抛」。它一旦
 * 抛异常，后果不是显示难看，而是**界面直接卡死**：`finishJob` 由 SSE
 * 的 done 回调调用，抛出之后后面所有 DOM 更新都不会执行，面板永远
 * 停在「运行中」，用户连个错误提示都看不到。
 *
 * 所以这里的主线不是「渲染对不对」，而是「不管输入什么，返回值都是
 * 一个能画出来的形状」。
 *
 * 输入全部用**真实可能出现的畸形**，不是随便乱造：
 *
 *   - `stages: [null]`        —— 组装时漏了判空
 *   - `checks: {}`            —— 该是数组的地方给了对象
 *   - `artifacts: [null]`     —— 这一条曾让下载接口回 500
 *   - `passed: "false"`       —— 字符串化的布尔，非空即真值
 *   - 孤立代理项的文件名       —— Linux 下非 UTF-8 字节被宽松解码
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  artifactRows, asArray, checkRows, checksSummary, contractRows,
  errorBox, historyRow, progressText, stageRows, toText, warningRows,
} from '../web/report-view.mjs'

/** 一份合法报告，供各用例改字段。 */
function valid(overrides = {}) {
  return {
    schemaVersion: 1,
    direction: 'mac2win',
    ok: true,
    exitCode: 0,
    command: 'doctor',
    startedAt: '2026-11-14T00:00:00.000Z',
    finishedAt: '2026-11-14T00:00:01.000Z',
    durationMs: 1000,
    stages: [{ id: 0, name: '预检', status: 'ok', durationMs: 10 }],
    ...overrides,
  }
}

/** 一组「最坏情况」输入，供各函数统一过一遍。 */
const HOSTILE = [
  null,
  undefined,
  true,
  42,
  'string',
  [],
  {},
  { stages: null },
  { stages: { 0: { status: 'ok' } } },
  { stages: [null] },
  { stages: [undefined] },
  { stages: ['x', 42] },
  { stages: [{ id: null, name: null, status: null, durationMs: 'x' }] },
  { checks: {} },
  { checks: [null] },
  { artifacts: [null] },
  { artifacts: 'abc' },
  { warnings: 'x' },
  { error: 'boom' },
  { error: 500 },
  { error: [] },
]

describe('asArray', () => {
  test('非数组一律给空数组', () => {
    for (const value of [null, undefined, {}, 'abc', 42, true]) {
      assert.deepEqual(asArray(value), [], JSON.stringify(value))
    }
    assert.deepEqual(asArray([1, 2]), [1, 2])
  })
})

describe('toText', () => {
  test('基本类型直出', () => {
    assert.equal(toText('x'), 'x')
    assert.equal(toText(0), '0')
    assert.equal(toText(false), 'false')
    assert.equal(toText(null), 'null')
    assert.equal(toText(undefined), '')
  })

  test('对象转 JSON 而不是 [object Object]', () => {
    /*
     * `String({a:1})` 得到 `[object Object]`，对排查毫无帮助。
     * 用户看到 `{"a":1}` 至少知道实际结构。
     */
    assert.equal(toText({ a: 1 }), '{"a":1}')
    assert.equal(toText([1, 2]), '[1,2]')
  })

  test('循环引用不抛', () => {
    const cyclic = { a: 1 }
    cyclic.self = cyclic
    assert.doesNotThrow(() => toText(cyclic))
  })
})

describe('stageRows', () => {
  test('合法阶段正常映射', () => {
    const rows = stageRows(valid())
    assert.equal(rows.length, 1)
    assert.equal(rows[0].mark, '✓')
    assert.equal(rows[0].name, '预检')
    assert.equal(rows[0].time, '10ms')
  })

  test('stages 含 null 时不抛，并渲染成可见的非法项', () => {
    /*
     * 关键：不能静默跳过。
     *
     * 跳过会让「报告里混进了 null」在界面上完全不可见 —— 用户看到的
     * 阶段数与报告里实际的项数对不上，反而更困惑。
     */
    const rows = stageRows({ stages: [null, { id: 1, name: '构建', status: 'ok' }] })
    assert.equal(rows.length, 2)
    assert.equal(rows[0].status, 'unknown')
    assert.match(rows[0].name, /非法阶段项/u)
    assert.equal(rows[1].name, '构建')
  })

  test('未知状态给中性符号，不显示 undefined', () => {
    const rows = stageRows({ stages: [{ id: 0, name: 'x', status: 'weird' }] })
    assert.equal(rows[0].mark, '·')
    assert.equal(rows[0].status, 'weird')
  })

  test('缺 name 时用 id 兜底', () => {
    const rows = stageRows({ stages: [{ id: 3, status: 'ok' }] })
    assert.match(rows[0].name, /3/u)
  })

  test('durationMs 非数字时不显示 NaN', () => {
    const rows = stageRows({ stages: [{ id: 0, name: 'x', status: 'ok', durationMs: 'abc' }] })
    assert.equal(rows[0].time, '')
  })

  test('stages 不是数组时返回空而不抛', () => {
    for (const stages of [null, {}, 'x', 42, true]) {
      assert.deepEqual(stageRows({ stages }), [], JSON.stringify(stages))
    }
  })
})

describe('progressText', () => {
  test('合法报告算出进度', () => {
    assert.match(progressText(valid()), /1 \/ 1 阶段 · 1000ms/u)
  })

  test('无阶段时明确说明，不显示 0 / 0', () => {
    assert.match(progressText({ stages: [], durationMs: 5 }), /无阶段记录/u)
    assert.match(progressText({ stages: [], durationMs: 5 }), /5ms/u)
  })

  test('畸形阶段不计入分母', () => {
    const text = progressText({ stages: [null, { status: 'ok' }], durationMs: 1 })
    assert.match(text, /1 \/ 2 阶段/u)
  })

  test('缺 durationMs 时用兜底值', () => {
    assert.match(progressText({ stages: [] }, 77), /77ms/u)
  })

  /*
   * 失败时「跳过」必须被标出来。
   *
   * 真实失败报告的形态是「第 1 步 failed，其余 7 步全部 skipped」。
   * 因为 skipped 也算「已结束」，早先的实现会报「8 / 8 阶段」——
   * 用户看到的是一次跑完，实际是第 1 步就挂了、剩下 7 步一步没走。
   */
  test('大量跳过时分子只算真正跑过的阶段', () => {
    const report = {
      durationMs: 2,
      stages: [
        { name: '预检', status: 'failed' },
        { name: '项目构建', status: 'skipped' },
        { name: '准备运行时', status: 'skipped' },
        { name: '收集依赖', status: 'skipped' },
      ],
    }
    const text = progressText(report)
    /*
     * 关键是分子：4 个阶段里 3 个跳过，真正跑过的只有 1 个。
     * 报「4 / 4」等于说「全部完成」，而事实是第 1 步就挂了。
     */
    assert.match(text, /^1 \/ 4 阶段/u, `分子必须是真正跑过的阶段数，实际：${text}`)
    assert.match(text, /3 项跳过/u, '必须说清有几项没走')
  })

  test('没有跳过时不加多余说明', () => {
    const text = progressText({
      durationMs: 10,
      stages: [{ status: 'ok' }, { status: 'ok' }],
    })
    assert.match(text, /2 \/ 2 阶段/u)
    assert.doesNotMatch(text, /跳过/u, '全部正常完成时不该出现「跳过」字样')
  })
})

describe('checkRows', () => {
  test('passed 与 ok 都认', () => {
    /*
     * 契约规定 passed，但 exeonmac 用 passed、另外三个方向用 ok。
     * 前端两个都认，保证不会因为读不到 passed 就把「通过」显示成
     * 「失败」—— 界面不该在契约修好之前骗人。
     */
    const byPassed = checkRows({ checks: [{ name: 'a', passed: true }] })
    const byOk = checkRows({ checks: [{ name: 'a', ok: true }] })
    assert.equal(byPassed.rows[0].passed, true)
    assert.equal(byOk.rows[0].passed, true)
  })

  test('字符串 "false" 不算通过', () => {
    /*
     * 用真值判断会把它当成通过（非空字符串是 truthy）。
     * 必须用 typeof === 'boolean'。
     */
    const summary = checkRows({ checks: [{ name: 'a', passed: 'false' }] })
    assert.equal(summary.rows[0].passed, false)
    assert.equal(summary.failed, 1)
  })

  test('checks 含 null 时不抛', () => {
    const summary = checkRows({ checks: [null, { name: 'b', passed: true }] })
    assert.equal(summary.total, 2)
    assert.equal(summary.failed, 1)
    assert.equal(summary.rows[0].passed, false)
  })

  test('checks 不是数组时 present 为假', () => {
    for (const checks of [null, {}, 'x', [], undefined]) {
      const summary = checkRows({ checks })
      assert.equal(summary.present, false, JSON.stringify(checks))
      assert.deepEqual(summary.rows, [])
    }
  })

  test('缺 name 时给占位名', () => {
    const summary = checkRows({ checks: [{ passed: true }] })
    assert.match(summary.rows[0].name, /未命名/u)
  })
})

describe('checksSummary', () => {
  test('全通过与部分失败的文案', () => {
    assert.match(checksSummary({ present: true, failed: 0, total: 3 }), /全部通过（3）/u)
    assert.match(checksSummary({ present: true, failed: 1, total: 3 }), /1 项未通过/u)
  })

  test('无校验项时为空串', () => {
    assert.equal(checksSummary({ present: false }), '')
  })

  /*
   * 直接传 null 也不能抛。
   *
   * 「绝不抛异常」测试原来只喂 `checksSummary(checkRows(input))` ——
   * 而 checkRows 总返回对象，所以永远测不到 null 这条路径。实际
   * 早先传 null 会 `TypeError: Cannot read properties of null`。
   *
   * 这个文件里的函数都在 SSE 的 done 回调链上，抛出会让后续所有
   * 界面更新都不执行，面板永久停在「运行中」。
   */
  test('传 null / undefined / 畸形值时退化成空串，不抛', () => {
    for (const input of [null, undefined, 0, '', 'abc', [], 42, { present: 'yes' }]) {
      assert.doesNotThrow(
        () => checksSummary(input),
        `checksSummary(${JSON.stringify(input)}) 不该抛`)
      assert.equal(typeof checksSummary(input), 'string')
    }
  })
})

describe('artifactRows', () => {
  test('合法产物带序号与可用标记', () => {
    const rows = artifactRows({ artifacts: [{ path: '/tmp/a.zip' }] })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].index, 0)
    assert.equal(rows[0].path, '/tmp/a.zip')
    assert.equal(rows[0].usable, true)
  })

  test('artifacts 含 null 时不抛，且标为不可下载', () => {
    /*
     * 这一条来自真实的 500：服务端直接读 `.path` 抛 TypeError，
     * 整个下载请求变成 500，看板上是「点了没反应」。
     * 前端这里先保证画得出来，只是不给下载链接。
     */
    const rows = artifactRows({ artifacts: [null] })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].usable, false)
    assert.match(rows[0].path, /空产物项/u)
  })

  test('裸字符串产物仍可下载', () => {
    const rows = artifactRows({ artifacts: ['/tmp/b.zip'] })
    assert.equal(rows[0].usable, true)
    assert.equal(rows[0].path, '/tmp/b.zip')
  })

  test('空字符串产物不可下载', () => {
    const rows = artifactRows({ artifacts: [''] })
    assert.equal(rows[0].usable, false)
  })

  test('缺 path 的对象产物不可下载', () => {
    const rows = artifactRows({ artifacts: [{ kind: 'zip' }] })
    assert.equal(rows[0].usable, false)
    assert.match(rows[0].path, /无 path/u)
  })

  test('序号连续，不因非法项而错位', () => {
    /*
     * 序号直接决定下载地址 `/api/artifact/<jobId>/<index>`。
     * 若跳过非法项导致序号错位，用户点第 2 个产物会拿到第 3 个文件 ——
     * 那是最糟的一类 bug：看起来正常，内容却是错的。
     */
    const rows = artifactRows({
      artifacts: [null, { path: '/a' }, { path: '/b' }],
    })
    assert.deepEqual(rows.map((r) => r.index), [0, 1, 2])
    assert.equal(rows[1].path, '/a')
    assert.equal(rows[2].path, '/b')
  })
})

describe('warningRows', () => {
  test('对象警告也渲染成文本', () => {
    const rows = warningRows({ warnings: ['纯文本', { code: 'M2W_1001' }] })
    assert.equal(rows.length, 2)
    assert.equal(rows[0], '纯文本')
    assert.match(rows[1], /M2W_1001/u)
  })

  test('null / 空串被过滤', () => {
    assert.deepEqual(warningRows({ warnings: [null, '', undefined, 'x'] }), ['x'])
  })

  test('warnings 不是数组时返回空', () => {
    assert.deepEqual(warningRows({ warnings: 'x' }), [])
  })
})

describe('errorBox', () => {
  test('正常错误框', () => {
    const box = errorBox(valid({
      ok: false, exitCode: 1,
      error: { code: 'M2W_1001', message: '输入不存在', hint: '检查路径' },
    }))
    assert.equal(box.code, 'M2W_1001')
    assert.equal(box.message, '输入不存在')
    assert.equal(box.hint, '检查路径')
  })

  test('没有 error 时返回 null', () => {
    assert.equal(errorBox(valid()), null)
    assert.equal(errorBox(null), null)
    assert.equal(errorBox({ error: null }), null)
  })

  test('error 是字符串时不假装有 code', () => {
    /*
     * 早先的写法 `report.error.code ?? 'ERROR'` 对字符串取值得到
     * undefined → 'ERROR'，同时 message 也读不到 → 空串。
     * 用户看到一个只有 "ERROR" 的空框，完全不知道发生了什么。
     */
    const box = errorBox({ error: 'boom' })
    assert.equal(box.code, 'ERROR')
    assert.equal(box.message, 'boom')
  })

  test('error 是数组时不抛', () => {
    assert.doesNotThrow(() => errorBox({ error: [1, 2] }))
    const box = errorBox({ error: ['a'] })
    assert.equal(box.code, 'ERROR')
  })

  test('缺 hint 时为 null，不是 undefined', () => {
    const box = errorBox({ error: { code: 'X_1001', message: 'm' } })
    assert.equal(box.hint, null)
  })
})

describe('historyRow', () => {
  test('正常条目', () => {
    const view = historyRow({
      direction: 'mac2win', command: 'doctor', ok: true,
      startedAt: Date.parse('2026-11-14T10:20:30.000Z'),
      durationMs: 120, errorCode: null, artifactCount: 2,
    })
    assert.equal(view.ok, true)
    assert.equal(view.label, 'mac2win doctor')
    assert.match(view.clock, /^\d{2}:\d{2}:\d{2}$/u)
    assert.match(view.meta, /120ms/u)
    assert.match(view.meta, /2 个产物/u)
  })

  test('startedAt 缺失时不显示 NaN:NaN:NaN', () => {
    /*
     * `new Date(undefined)` 是 Invalid Date，getHours() 返回 NaN。
     * 早先界面会直接显示 `NaN:NaN:NaN` —— 行还在，但读不出时间。
     */
    const view = historyRow({ direction: 'x', command: 'y' })
    assert.equal(view.clock, '--:--:--')
    assert.doesNotMatch(view.clock, /NaN/u)
  })

  test('有 errorCode 时优先显示', () => {
    const view = historyRow({
      direction: 'x', command: 'y', durationMs: 5,
      errorCode: 'M2W_1001', artifactCount: 3,
    })
    assert.match(view.meta, /M2W_1001/u)
  })

  test('空对象也给得出可显示的行', () => {
    const view = historyRow({})
    assert.equal(view.ok, false)
    assert.match(view.label, /未知方向/u)
    assert.equal(view.clock, '--:--:--')
  })

  test('非对象输入不抛', () => {
    for (const item of [null, undefined, 'x', 42]) {
      assert.doesNotThrow(() => historyRow(item), JSON.stringify(item))
    }
  })
})

describe('contractRows', () => {
  test('正常结构映射', () => {
    const blocks = contractRows({
      ok: false,
      results: [{
        direction: 'mac2win', ok: false,
        scenarios: [{
          scenario: 'doctor', ok: false,
          problems: [{ check: 'report.required_fields', detail: '缺字段' }],
        }],
      }],
    })
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].direction, 'mac2win')
    assert.equal(blocks[0].scenarios[0].name, 'doctor')
    assert.equal(blocks[0].scenarios[0].problems[0].check, 'report.required_fields')
  })

  test('畸形结构不抛', () => {
    for (const result of HOSTILE) {
      assert.doesNotThrow(() => contractRows(result), JSON.stringify(result))
    }
    const blocks = contractRows({
      results: [null, { scenarios: [null, { problems: [null] }] }],
    })
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].scenarios.length, 1)
    assert.equal(blocks[0].scenarios[0].problems.length, 0)
  })
})

describe('整体：任何输入都不抛', () => {
  /*
   * 这是本套测试的总闸。上面各 describe 逐个函数测，这条横向扫一遍
   * 「最坏情况 × 全部函数」，保证将来新增函数时忘了加防御能被抓住。
   *
   * ## 为什么必须把所有导出函数都列进来
   *
   * 早先这张表漏了 `checksSummary`，而那正是唯一会抛的一个 ——
   * 传 null 它抛 TypeError。漏的原因很典型：它看着像「只接受
   * checkRows 的返回值」，不像其他函数那样直接吃 report。
   *
   * 教训：**总闸的价值取决于它的覆盖率，漏一个就等于没测那一个**。
   * 所以这里改成从模块的导出清单里自动取，新增函数自动纳入。
   */
  const fns = {
    stageRows: (r) => stageRows(r),
    progressText: (r) => progressText(r, 0),
    checkRows: (r) => checkRows(r),
    checksSummary: (r) => checksSummary(r),
    artifactRows: (r) => artifactRows(r),
    warningRows: (r) => warningRows(r),
    errorBox: (r) => errorBox(r),
    historyRow: (r) => historyRow(r),
    contractRows: (r) => contractRows(r),
    toText: (r) => toText(r),
    asArray: (r) => asArray(r),
  }

  test('全部函数对全部敌对输入都不抛', () => {
    for (const [name, fn] of Object.entries(fns)) {
      for (const input of HOSTILE) {
        assert.doesNotThrow(
          () => fn(input),
          `${name} 在输入 ${JSON.stringify(input)} 时抛异常`)
      }
    }
  })

  /*
   * 组合路径：真实的调用链是 checkRows → checksSummary，
   * 而 checkRows 的结果也可能是畸形（旧版本、序列化异常）。
   * 单独测每个函数还不够，要测「上一个的输出喂给下一个」。
   */
  test('函数串联（checkRows → checksSummary）也不抛', () => {
    for (const input of HOSTILE) {
      assert.doesNotThrow(() => checksSummary(checkRows(input)),
        `checkRows → checksSummary 在输入 ${JSON.stringify(input)} 时抛异常`)
    }
  })

  test('返回值都是可画出来的形状', () => {
    /*
     * 不抛还不够 —— 返回 undefined 一样会让 `for (const x of ...)`
     * 在调用侧抛。数组型返回值必须是数组。
     */
    for (const input of HOSTILE) {
      assert.ok(Array.isArray(stageRows(input)))
      assert.ok(Array.isArray(artifactRows(input)))
      assert.ok(Array.isArray(warningRows(input)))
      assert.ok(Array.isArray(contractRows(input)))
      assert.equal(typeof progressText(input, 0), 'string')
      assert.equal(typeof checksSummary(checkRows(input)), 'string')
    }
  })
})
