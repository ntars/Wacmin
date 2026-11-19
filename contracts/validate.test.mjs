/**
 * contracts/validate.mjs 的测试。
 *
 * 跑法：node --test contracts/validate.test.mjs
 *
 * ## 为什么这个文件必须存在
 *
 * 这个脚本是 CI 里「契约是否被遵守」的唯一权威，而它此前**没有任何
 * 测试**。后果是两处真实缺陷长期存在：
 *
 *   1. `additionalProperties: false` 在 schema 里写着，脚本从不执行 ——
 *      报告里塞任意多余字段都报「✓ 契约自洽」
 *   2. 段位归属按码值首字符推桶 —— 独立的 `9999` 段位永远命中不了，
 *      把它从 error-prefixes.json 里整个删掉，校验仍然全绿
 *
 * 两条的共同点：**校验器失明了，而它自己不会说话**。一个失明的检查器
 * 比没有检查器更糟 —— 用户以为有东西在站岗。
 *
 * ## 测试策略
 *
 * 用真实的 CLI 子进程（`spawnSync`），不 import 内部函数来测。理由是
 * 用户与 CI 用的是命令行，`--report` 的解析、退出码的语义都在那一层。
 * 唯一例外是 `segmentOf` —— 它是纯函数，直接测边界更方便。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { segmentOf } from './validate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'validate.mjs')

/** 读仓库里的契约，测试自己造变体时以它为基准。 */
const loadJson = (name) => JSON.parse(readFileSync(join(HERE, name), 'utf8'))

/** 跑一次校验器，返回 {code, stdout, stderr}。 */
function runValidator(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** 造一份必然合法的报告，各用例在此基础上做局部破坏。 */
function validReport(overrides = {}) {
  return {
    schemaVersion: 1,
    direction: 'mac2win',
    ok: true,
    exitCode: 0,
    command: 'doctor',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:01Z',
    durationMs: 12,
    host: { platform: 'darwin', arch: 'arm64' },
    stages: [{ id: 0, name: '预检', status: 'ok' }],
    artifacts: [],
    checks: [{ name: 'platform', passed: true }],
    warnings: [],
    error: null,
    ...overrides,
  }
}

/** 把报告写进临时文件并校验，返回结果。 */
function checkReportWith(report, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'wacmin-contract-'))
  try {
    const path = join(dir, 'report.json')
    writeFileSync(path, JSON.stringify(report), 'utf8')
    return runValidator(['--report', path, ...extraArgs])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 断言被拦下，且错误信息里出现指定片段。 */
function assertRejected(report, fragment, extraArgs = []) {
  const result = checkReportWith(report, extraArgs)
  assert.equal(result.code, 1, `应判为不通过，实际退出码 ${result.code}\n${result.stdout}${result.stderr}`)
  assert.ok(result.stderr.includes(fragment),
    `错误信息里应含「${fragment}」，实际：\n${result.stderr}`)
}

/* ══════════════════════════ 段位归属 ══════════════════════════ */

describe('segmentOf：段位按 range 判定', () => {
  const segments = loadJson('error-prefixes.json').segments

  /*
   * 这一组是 P0-3 的核心回归。
   *
   * 旧实现用 `${String(n).slice(0, 1)}000` 拼桶，于是 9999 与 9998 都
   * 落到 9000 桶。9999 段（内部错误）因此永远命中不了，那段定义可以被
   * 静默删除 —— 段位定义形同虚设。
   */
  test('9999 落在独立的 9999 段，而不是 9000 段', () => {
    assert.equal(segmentOf(9999, segments), '9999')
  })

  test('9998 落在 9000 段（range 是 9001-9998）', () => {
    assert.equal(segmentOf(9998, segments), '9000')
  })

  test('每个段位的 range 上下界都归属该段位', () => {
    for (const [key, definition] of Object.entries(segments)) {
      const range = definition.range
      const [low, high] = range.includes('-')
        ? range.split('-').map(Number)
        : [Number(range), Number(range)]
      assert.equal(segmentOf(low, segments), key, `${key} 的下界 ${low}`)
      assert.equal(segmentOf(high, segments), key, `${key} 的上界 ${high}`)
    }
  })

  test('不在任何范围内的码值返回 null', () => {
    for (const code of [0, 1, 8888, 10000, 12345]) {
      assert.equal(segmentOf(code, segments), null, `码值 ${code} 不应落在任何段位`)
    }
  })

  test('range 写歪时不会静默命中相邻段位', () => {
    // 畸形 range 应解析不到，而不是退化成「随便给一个」
    assert.equal(segmentOf(1500, { 1000: { range: '1xxx' } }), null)
    assert.equal(segmentOf(1500, { 1000: { range: '1001-' } }), null)
    assert.equal(segmentOf(1500, { 1000: {} }), null)
  })
})

/* ══════════════════════════ 契约文件自检 ══════════════════════════ */

describe('契约文件自检', () => {
  test('当前契约自洽', () => {
    const result = runValidator([])
    assert.equal(result.code, 0, result.stderr)
    assert.ok(result.stdout.includes('✓ 契约自洽'))
  })

  /*
   * 用 --contracts 指向造出来的坏契约，验证「自检真的在检」。
   *
   * 只跑真实契约的话，删掉某项检查也不会红 —— 这正是 P0-3 的成因。
   */
  test('段位 range 解析不出自身时被拦下', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wacmin-contract-bad-'))
    try {
      mkdirSync(dir, { recursive: true })
      const prefixes = loadJson('error-prefixes.json')
      prefixes.segments['1000'].range = '1xxx'
      writeFileSync(join(dir, 'error-prefixes.json'), JSON.stringify(prefixes), 'utf8')
      writeFileSync(join(dir, 'exit-codes.json'),
        readFileSync(join(HERE, 'exit-codes.json'), 'utf8'), 'utf8')
      writeFileSync(join(dir, 'run-report.schema.json'),
        readFileSync(join(HERE, 'run-report.schema.json'), 'utf8'), 'utf8')

      const result = runValidator(['--contracts', dir])
      assert.equal(result.code, 1)
      assert.ok(result.stderr.includes('解析不出该段位自身'), result.stderr)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('退出码引用了不存在的段位时被拦下', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wacmin-contract-bad-'))
    try {
      const exitCodes = loadJson('exit-codes.json')
      exitCodes.codes['2'].errorSegment = '1003/8888'
      writeFileSync(join(dir, 'exit-codes.json'), JSON.stringify(exitCodes), 'utf8')
      writeFileSync(join(dir, 'error-prefixes.json'),
        readFileSync(join(HERE, 'error-prefixes.json'), 'utf8'), 'utf8')
      writeFileSync(join(dir, 'run-report.schema.json'),
        readFileSync(join(HERE, 'run-report.schema.json'), 'utf8'), 'utf8')

      const result = runValidator(['--contracts', dir])
      assert.equal(result.code, 1)
      assert.ok(result.stderr.includes('8888'), result.stderr)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/* ══════════════════════════ 报告结构与类型 ══════════════════════════ */

describe('报告：schema 驱动的结构校验', () => {
  test('合规报告放行', () => {
    const result = checkReportWith(validReport())
    assert.equal(result.code, 0, result.stderr)
  })

  /*
   * P0-2 的回归：schema 顶层写着 additionalProperties: false，
   * 旧脚本从不执行，塞任意字段都放行。
   */
  test('顶层多余字段被拦下', () => {
    assertRejected(validReport({ 这个字段不该存在: 123, anotherBogus: true }),
      '有 schema 未定义的字段')
  })

  /*
   * 嵌套层同样写着 additionalProperties: false。只查顶层是不够的 ——
   * 报告结构里最容易乱改的恰恰是 stages / artifacts / checks 的项。
   */
  test('stages 项的多余字段被拦下', () => {
    assertRejected(validReport({ stages: [{ id: 0, name: 'A', status: 'ok', bogus: 1 }] }),
      'stages[0]')
  })

  test('artifacts 项的多余字段被拦下', () => {
    assertRejected(validReport({
      artifacts: [{ path: '/a.zip', kind: 'zip', bytes: 1, bogus: 1 }],
    }), 'artifacts[0]')
  })

  test('error 对象的多余字段被拦下', () => {
    assertRejected(validReport({
      ok: false, exitCode: 1,
      error: { code: 'M2W_9999', message: 'x', bogus: 1 },
    }), 'error')
  })

  /*
   * 类型校验。
   *
   * 旧脚本只在「自己用得着」的地方判断类型，于是 `exitCode: "0"`、
   * `ok: "true"`、`checks: {}` 全部放行。前端按 `ok === true` 与
   * truthy 两种方式判断时会自相矛盾。
   */
  test('exitCode 写成字符串被拦下', () => {
    assertRejected(validReport({ exitCode: '0' }), 'exitCode')
  })

  test('ok 写成字符串被拦下', () => {
    assertRejected(validReport({ ok: 'true' }), 'ok')
  })

  test('checks 写成对象被拦下', () => {
    assertRejected(validReport({ checks: {} }), 'checks')
  })

  test('整数类型不接受小数', () => {
    assertRejected(validReport({ exitCode: 1.5 }), 'exitCode')
  })

  test('durationMs 为负数被拦下', () => {
    assertRejected(validReport({ durationMs: -1 }), 'durationMs')
  })

  test('缺少必填字段被拦下', () => {
    const report = validReport()
    delete report.stages
    assertRejected(report, '缺少必填字段')
  })

  test('schemaVersion 不是 1 被拦下', () => {
    assertRejected(validReport({ schemaVersion: 2 }), 'schemaVersion')
  })

  test('direction 不在枚举内被拦下', () => {
    assertRejected(validReport({ direction: 'linux' }), 'direction')
  })
})

describe('报告：枚举、格式与范围', () => {
  test('非法的阶段状态被拦下', () => {
    assertRejected(validReport({ stages: [{ id: 0, name: 'A', status: 'great' }] }),
      '允许值')
  })

  test('非法的产物 kind 被拦下', () => {
    assertRejected(validReport({
      artifacts: [{ path: '/a.exe', kind: 'exe', bytes: 1 }],
    }), 'kind')
  })

  test('sha256 不符合十六进制 64 位时被拦下', () => {
    assertRejected(validReport({
      artifacts: [{ path: '/a.zip', kind: 'zip', bytes: 1, sha256: 'ZZZ' }],
    }), 'sha256')
  })

  test('错误码不符合 PREFIX_NNNN 格式时被拦下', () => {
    assertRejected(validReport({
      ok: false, exitCode: 1,
      error: { code: 'm2w_9999', message: 'x' },
    }), 'error.code')
  })

  test('artifacts 项不是对象时被拦下', () => {
    assertRejected(validReport({ artifacts: [null] }), 'artifacts[0]')
  })

  test('checks 项缺少布尔型 passed 时被拦下', () => {
    assertRejected(validReport({ checks: [{ name: 'x', ok: true }] }), 'passed')
  })

  test('stages 项不是对象时被拦下且不抛异常', () => {
    // 旧实现会在这里抛 TypeError，被上层记成「调用某方向抛错」
    const result = checkReportWith(validReport({ stages: [null] }))
    assert.equal(result.code, 1)
    assert.ok(!result.stderr.includes('TypeError'), `不该抛异常：\n${result.stderr}`)
  })
})

/* ══════════════════════════ 跨字段语义 ══════════════════════════ */

describe('报告：跨字段不变量', () => {
  test('ok 与 exitCode 不一致时被拦下', () => {
    assertRejected(validReport({ ok: true, exitCode: 6 }), '不一致')
  })

  /*
   * 「失败即停」是契约明文。违反意味着实现里没在失败处 return，
   * 继续跑了后续步骤 —— 那会产出半成品。
   */
  test('失败后仍有 ok 阶段时被拦下', () => {
    assertRejected(validReport({
      ok: false, exitCode: 6,
      stages: [
        { id: 0, name: '打包', status: 'failed' },
        { id: 1, name: '校验', status: 'ok' },
      ],
      error: { code: 'M2W_4001', message: 'x' },
    }), '失败后仍执行')
  })

  test('ok=false 缺 error 时被拦下', () => {
    assertRejected(validReport({ ok: false, exitCode: 1, error: null }), '必须带 error')
  })

  /*
   * schema 的 allOf 里第二条：ok=true 时 error 必须为 null。
   * 漏掉这一半的代价是同一份报告能渲染出自相矛盾的两个结论 ——
   * 读 error 显示失败提示，读 ok 显示成功横幅。
   */
  test('ok=true 却带 error 时被拦下', () => {
    assertRejected(validReport({
      ok: true, exitCode: 0,
      error: { code: 'M2W_9999', message: 'x' },
    }), 'error 必须为 null')
  })

  test('错误码段位不存在时被拦下', () => {
    assertRejected(validReport({
      ok: false, exitCode: 1,
      error: { code: 'M2W_8888', message: 'x' },
    }), '不在任何已定义范围内')
  })

  /*
   * 退出码与错误码配对。这类分叉时报告的每一项结构检查都通过 ——
   * 前缀是本人的、段位存在、字段齐全，只有把两者放一起比才看得出。
   */
  test('退出码与错误码段位不配对时被拦下', () => {
    // 契约：130 → 9001；M2W_9999 属 9999 段（内部错误，对应退出码 1）
    assertRejected(validReport({
      ok: false, exitCode: 130,
      error: { code: 'M2W_9999', message: 'x' },
    }), '两边必须一致')
  })

  test('9999 配退出码 1 是合法配对', () => {
    const result = checkReportWith(validReport({
      ok: false, exitCode: 1,
      error: { code: 'M2W_9999', message: 'x' },
    }))
    assert.equal(result.code, 0, result.stderr)
  })

  /*
   * 区间写法的中值。这一组是 2026-11-19 修掉的真实缺陷的回归锁。
   *
   * 契约里 `exit 6 → "4001-5002"` 是**范围**写法。旧实现用
   * `String(seg).split(/[/-]/)` 解析，范围被切成两个端点，
   * 于是 4002 既不等于 4001 也不等于 5002，被判「不一致」。
   *
   * 它长期没被发现，因为真实报告命中的多是端点（4001 构建失败、
   * 5002 装配失败），端点恰好就是切分后的那两个字符串。
   * 所以这组不只测 4002，而是把范围内的每一个真实码都跑一遍 ——
   * 只测端点等于没测。
   */
  for (const tail of ['4001', '4002', '4003', '5001', '5002']) {
    test(`exit 6 配 ${tail} 是合法配对（范围内所有码都该过）`, () => {
      const result = checkReportWith(validReport({
        ok: false, exitCode: 6,
        error: { code: `M2W_${tail}`, message: 'x' },
      }))
      assert.equal(result.code, 0,
        `M2W_${tail} 落在契约 exit 6 的 4001-5002 范围内，不该报错：\n${result.stderr}`)
    })
  }

  for (const tail of ['6001', '6002', '6003']) {
    test(`exit 7 配 ${tail} 是合法配对`, () => {
      const result = checkReportWith(validReport({
        ok: false, exitCode: 7,
        error: { code: `M2W_${tail}`, message: 'x' },
      }))
      assert.equal(result.code, 0, `M2W_${tail} 应在 6001-6003 内：\n${result.stderr}`)
    })
  }

  test('范围外的码配 exit 6 仍被拦下（修区间不能把门开太大）', () => {
    /*
     * 修「范围判定」最容易犯的错是改成「只要是 4xxx/5xxx 就放行」，
     * 那样 3001 也会被放过。这条守住上界。
     */
    assertRejected(validReport({
      ok: false, exitCode: 6,
      error: { code: 'M2W_3001', message: 'x' },
    }), '两边必须一致')
  })
})

/* ══════════════════════════ 真实退出码比对 ══════════════════════════ */

describe('--exit-code：报告与真实进程退出码比对', () => {
  test('两者一致时放行', () => {
    const result = checkReportWith(validReport({ exitCode: 0 }), ['--exit-code', '0'])
    assert.equal(result.code, 0, result.stderr)
  })

  test('两者不一致时被拦下', () => {
    assertRejected(validReport({ exitCode: 0 }), '实际进程退出码', ['--exit-code', '2'])
  })

  test('不传 --exit-code 时不比对（离线场景）', () => {
    const result = checkReportWith(validReport({ exitCode: 0 }))
    assert.equal(result.code, 0, result.stderr)
  })
})

/* ══════════════════════════ 命令行契约 ══════════════════════════ */

describe('命令行用法', () => {
  test('--report 缺参数时退出码为 2', () => {
    assert.equal(runValidator(['--report']).code, 2)
  })

  test('--exit-code 不是整数时退出码为 2', () => {
    assert.equal(runValidator(['--exit-code', 'abc']).code, 2)
  })

  test('报告文件不存在时退出码为 1 且给出路径', () => {
    const result = runValidator(['--report', '/tmp/wacmin-does-not-exist.json'])
    assert.equal(result.code, 1)
    assert.ok(result.stderr.includes('wacmin-does-not-exist.json'), result.stderr)
  })

  test('报告不是合法 JSON 时退出码为 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wacmin-contract-'))
    try {
      const path = join(dir, 'broken.json')
      writeFileSync(path, '{ not json', 'utf8')
      const result = runValidator(['--report', path])
      assert.equal(result.code, 1)
      assert.ok(result.stderr.includes('读不了'), result.stderr)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /*
   * 被 import 时不许有任何副作用。
   *
   * 少了入口守卫，`import { segmentOf }` 会把整个校验跑一遍、往 stderr
   * 打问题清单、并设置 process.exitCode。`ai/src/server.mjs` 踩过同类的
   * 坑（入口文件顶层调 main()，每次请求往 stdout 打印用法说明，污染了
   * MCP 的独占通道）。这个测试就是那道守卫的看门人。
   */
  test('被 import 时不执行校验、不写 stdout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wacmin-contract-'))
    try {
      const path = join(dir, 'probe.mjs')
      writeFileSync(path,
        `import { segmentOf } from ${JSON.stringify(SCRIPT)}\n`
        + 'process.stdout.write(`RESULT:${typeof segmentOf}`)\n', 'utf8')
      const result = spawnSync(process.execPath, [path], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, 'RESULT:function',
        `import 不该产生额外输出，实际：${result.stdout}`)
      assert.equal(result.stderr, '', `import 不该写 stderr，实际：${result.stderr}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
