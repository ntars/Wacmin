/**
 * contracts/doc-counts.mjs 的测试。
 *
 * 跑法：node --test contracts/doc-counts.test.mjs
 *
 * ## 为什么这个文件必须存在
 *
 * doc-counts.mjs 是「README 12.1 是测试计数唯一来源」这句话的执行者。
 * 如果它自己失明，那句话就只是一句自我表扬 —— 本仓库已经因此吃过三次
 * 苦头（978 vs 1150、英文版 131、两处「未使用技术」清单各一份）。
 *
 * 所以测试的重点不是「能跑通」，而是**它能否真的抓到每一类分叉**：
 *
 *   1. 合计与分项之和不符
 *   2. 中英两版某个模块数字不同
 *   3. 表格缺行
 *   4. 取基线时模块名不存在（此时必须报错，绝不能回退到 0）
 *
 * 第 4 条尤其关键：若 `--min` 在找不到模块时输出 0，CI 的
 * `check-no-skips --min 0` 就永远通过 —— 守卫被关掉而报告全绿，
 * 正是这个仓库反复踩的那类坑。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseCountTable } from './doc-counts.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'doc-counts.mjs')

/** 造一个只含 README 两份文档的临时仓库根。 */
function makeRoot(files) {
  const root = mkdtempSync(join(tmpdir(), 'doc-counts-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content, 'utf8')
  }
  return root
}

/** 按给定数字拼一份 12.1 表格，中文版格式。 */
function zhTable(counts, total) {
  const lines = ['| 子项目 | 测试数 | 耗时 | 备注 |', '|---|---|---|---|']
  for (const [name, value] of Object.entries(counts)) {
    lines.push(`| ${name} | ${value} 项 | 约 1 秒 | |`)
  }
  if (total !== undefined) {
    lines.push(`| **合计** | **${total} 项** | — | |`)
  }
  return `${lines.join('\n')}\n`
}

/** 英文版格式：数字后面没有「项」，合计行写 Total。 */
function enTable(counts, total) {
  const lines = ['| Subproject | Tests | Duration | Notes |', '|---|---|---|---|']
  for (const [name, value] of Object.entries(counts)) {
    lines.push(`| ${name} | ${value} | about 1 second | |`)
  }
  if (total !== undefined) {
    lines.push(`| **Total** | **${total}** | — | |`)
  }
  return `${lines.join('\n')}\n`
}

const BASE = { mac2win: 132, exeonmac: 416, win2mac: 121, apponwin: 91, console: 215, ai: 132, contracts: 43 }
const BASE_TOTAL = 1150

/** 跑脚本，返回 { status, stdout, stderr }。 */
function run(args, root) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args, '--root', root], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('parseCountTable', () => {
  test('认得中文版的「132 项」与「**合计**」', () => {
    const { rows, total } = parseCountTable(zhTable(BASE, BASE_TOTAL))
    assert.equal(rows.get('mac2win'), 132)
    assert.equal(rows.get('contracts'), 43)
    assert.equal(total, 1150)
  })

  test('认得英文版的裸数字与 Total', () => {
    const { rows, total } = parseCountTable(enTable(BASE, BASE_TOTAL))
    assert.equal(rows.get('exeonmac'), 416)
    assert.equal(total, 1150)
  })

  test('忽略表头与分隔行，不会把它们当成数据', () => {
    const { rows } = parseCountTable(zhTable(BASE, BASE_TOTAL))
    assert.equal(rows.has('子项目'), false)
    assert.equal(rows.size, 7)
  })

  test('只读 12.1 那一节，不被正文里同样形状的旁证表覆盖', () => {
    /*
     * ## 这个用例守的是一个真实缺陷
     *
     * 初版扫描整份 README 的所有表格行，同名的行后写覆盖先写。平时没事，
     * 因为 12.1 只此一张；15.13 加了一张「工作区 / 当初的 clone」历史对照
     * 表，里面也有 `| contracts | 79 | 58 |` 这种行 —— 它排在 12.1 之后，
     * 于是 `--check` 读到的 contracts 是 79，而 12.1 明明写着 111。
     *
     * 隐蔽之处在于：合计与分项都出自同一份错读，加总仍自洽，所以只有
     * 改动真值时才会暴露。
     */
    const doc = [
      '### 12.1 关键指标',
      '',
      zhTable({ ...BASE, contracts: 111 }, BASE_TOTAL + 32).trimEnd(),
      '',
      '**测试规模与耗时**。',
      '',
      '### 12.2 一次真实的两小时 → 一分钟',
      '',
      '| | 工作区 | 当初的 clone |',
      '|---|---|---|',
      '| contracts | 43 | 40 |',
      '',
    ].join('\n')

    const { rows, total } = parseCountTable(doc)
    assert.equal(rows.get('contracts'), 111, '应读 12.1 的 111，而不是 12.2 之后的 43')
    assert.equal(rows.get('mac2win'), 132)
    assert.equal(total, BASE_TOTAL + 32)
  })

  test('章节标题找不到时退回全文，而不是返回空表', () => {
    /*
     * 返回空表会让报错变成「表格缺 7 个模块」，掩盖真因（标题被改了名）。
     * 退回全文虽不完美，但报错指向正确。
     */
    const doc = zhTable(BASE, BASE_TOTAL)
    const { rows } = parseCountTable(doc)
    assert.equal(rows.size, 7)
  })

  test('缺合计行时 total 为 null，而不是 0', () => {
    const { total } = parseCountTable(zhTable(BASE))
    assert.equal(total, null)
  })
})

describe('--check 能抓到每一类分叉', () => {
  test('两版完全一致时通过', () => {
    const root = makeRoot({
      'README.md': zhTable(BASE, BASE_TOTAL),
      'README_EN.md': enTable(BASE, BASE_TOTAL),
    })
    try {
      const { status, stdout } = run(['--check-counts'], root)
      assert.equal(status, 0)
      assert.match(stdout, /合计 1150 项/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('合计与分项之和不等时失败，并报出算式', () => {
    // 合计写 1150，但把 contracts 从 43 改成 40 —— 真实数量仍是 1150
    const wrong = { ...BASE, contracts: 40 }
    const root = makeRoot({
      'README.md': zhTable(wrong, BASE_TOTAL),
      'README_EN.md': enTable(wrong, BASE_TOTAL),
    })
    try {
      const { status, stderr } = run(['--check-counts'], root)
      assert.equal(status, 1)
      assert.match(stderr, /合计写 1150/)
      assert.match(stderr, /分项之和是 1147/)
      assert.match(stderr, /contracts 40/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('中英两版某模块数字不同时失败 —— 这就是「英文版记成 131」那次', () => {
    const root = makeRoot({
      'README.md': zhTable(BASE, BASE_TOTAL),
      'README_EN.md': enTable({ ...BASE, mac2win: 131 }, BASE_TOTAL),
    })
    try {
      const { status, stderr } = run(['--check-counts'], root)
      assert.equal(status, 1)
      assert.match(stderr, /两版不一致：mac2win 中文版 132，英文版 131/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('合计两版不同时也会失败', () => {
    const root = makeRoot({
      'README.md': zhTable(BASE, BASE_TOTAL),
      'README_EN.md': enTable(BASE, 1149),
    })
    try {
      const { status, stderr } = run(['--check-counts'], root)
      assert.equal(status, 1)
      assert.match(stderr, /合计两版不一致/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('表格缺某个模块时失败，并点名是哪一个', () => {
    const missing = { ...BASE }
    delete missing.apponwin
    const root = makeRoot({
      'README.md': zhTable(missing, BASE_TOTAL),
      'README_EN.md': enTable(missing, BASE_TOTAL),
    })
    try {
      const { status, stderr } = run(['--check-counts'], root)
      assert.equal(status, 1)
      assert.match(stderr, /缺 apponwin 一行/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('缺合计行时失败', () => {
    const root = makeRoot({
      'README.md': zhTable(BASE),
      'README_EN.md': enTable(BASE),
    })
    try {
      const { status, stderr } = run(['--check-counts'], root)
      assert.equal(status, 1)
      assert.match(stderr, /缺合计行/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('一次列出全部问题，不是遇错即停', () => {
    const root = makeRoot({
      'README.md': zhTable({ ...BASE, contracts: 40 }, BASE_TOTAL),
      'README_EN.md': enTable({ ...BASE, mac2win: 131 }, BASE_TOTAL),
    })
    try {
      const { status, stderr } = run(['--check-counts'], root)
      assert.equal(status, 1)
      // 合计不符与两版不一致应同时出现在输出里
      assert.match(stderr, /分项之和是 1147/)
      assert.match(stderr, /mac2win 中文版 132，英文版 131/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('--min 供 CI 取基线', () => {
  test('取出表格里的数字', () => {
    const root = makeRoot({
      'README.md': zhTable(BASE, BASE_TOTAL),
      'README_EN.md': enTable(BASE, BASE_TOTAL),
    })
    try {
      assert.equal(run(['--min', 'exeonmac'], root).stdout.trim(), '416')
      assert.equal(run(['--min', 'contracts'], root).stdout.trim(), '43')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('模块不存在时必须失败，绝不能输出 0', () => {
    const root = makeRoot({
      'README.md': zhTable(BASE, BASE_TOTAL),
      'README_EN.md': enTable(BASE, BASE_TOTAL),
    })
    try {
      const { status, stdout, stderr } = run(['--min', 'nosuchmodule'], root)
      assert.equal(status, 1, '找不到模块时应以非零退出')
      assert.equal(stdout.trim(), '', '不能往 stdout 写任何数字，否则 CI 会当成基线')
      assert.match(stderr, /没有 nosuchmodule/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('文档不存在时报错而不是静默通过', () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-counts-empty-'))
    try {
      const { status, stderr } = run(['--check-counts'], root)
      assert.equal(status, 1)
      assert.match(stderr, /找不到文档/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('对真实仓库的断言', () => {
  test('本仓库当前 12.1 表格自洽', () => {
    /*
     * ## 这里曾经硬编码 `合计 1150 项`
     *
     * 那行断言在两份 README 都把总数写成 1165 之后就一直红着 —— 而它守着
     * 的恰恰是「同一个数字只能有一个写入点」这条规矩，自己却成了第二个
     * 写入点。改一次测试计数，就得记得同时改 README 和这里，否则红；而
     * 一旦有人图省事把这里改成新数字，它又变成下一次漂移的伏笔。
     *
     * 所以这里不认任何具体数字，只认两件事：
     *
     *   1. `--check` 退出码为 0（表格自洽、两版逐项相同）
     *   2. 输出里的合计**等于各分项之和**（从同一份 README 里现读）
     *
     * 真正的数字真源是 README 12.1 表格，`--check` 负责守它；测试只守
     * 「`--check` 在真实仓库上确实通过」。数字对不对，由表格自己的
     * 加总关系决定，不由测试背下来。
     */
    const { status, stdout } = spawnSync(process.execPath, [SCRIPT, '--check'], {
      cwd: HERE,
      encoding: 'utf8',
    })
    assert.equal(status, 0, stdout)

    const match = /合计 (\d+) 项/u.exec(stdout)
    assert.notEqual(match, null, `输出里应有合计数，实际：${stdout}`)

    const readme = readFileSync(join(HERE, '..', 'README.md'), 'utf8')
    const { rows, total } = parseCountTable(readme)
    const sum = [...rows.values()].reduce((acc, n) => acc + n, 0)

    assert.equal(rows.size, 7, `12.1 应有 7 个模块行，实际 ${String(rows.size)}`)
    assert.equal(total, sum, `合计 ${String(total)} 应等于各分项之和 ${String(sum)}`)
    assert.equal(Number(match[1]), sum,
      `--check 报出的合计 ${match[1]} 应与表格分项之和 ${String(sum)} 一致`)
  })
})
