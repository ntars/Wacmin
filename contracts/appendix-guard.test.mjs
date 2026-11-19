/**
 * contracts/appendix-guard.mjs 的测试。
 *
 * 跑法：node --test contracts/appendix-guard.test.mjs
 *
 * ## 为什么必须逐个数字测
 *
 * 这个守卫守的是附录 C 里 8 个人手数出来的数字。最容易发生的退化不是
 * 「整个脚本崩掉」，而是**其中某一条正则悄悄失配**：失配后那道检查就返回
 * 「取不到」，若实现里把「取不到」当成「跳过」，另外 7 条照样绿，报告照样
 * 全绿 —— 守卫被关掉一格而没人知道。
 *
 * 所以这里的做法是：每个数字单独篡改一次，断言它**必须**被点名，且报错
 * 文本里要出现那个数字与真源名。8 条各一个用例，任何一条正则坏掉就红。
 *
 * ## 为什么还要测「真源变化」
 *
 * 只测「文档写错」是不够的：真正的日常场景是**表格加了一行而附录 C 没跟**
 * （W-03 那 4 处缺陷就是这么来的）。所以另有一组用例改的是表格、代码常量
 * 与 `NOTICE`，附录 C 一个字不动，看守卫能否发现。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  checkAppendix,
  noticeChapterCount,
  parseClaims,
  parseEnNumber,
  parseZhNumber,
  sectionOf,
  tableRowCounts,
} from './appendix-guard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCRIPT = join(HERE, 'doc-counts.mjs')

/**
 * 造一份可跑的临时仓库根。
 *
 * 只拷守卫真正需要的东西：两份 README、`NOTICE`、以及 `DEFAULTS` 所在的
 * 那四个源文件。整仓拷贝会让这个测试从 1 秒变成几十秒，而守卫并不读别的。
 */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'appendix-guard-'))
  for (const name of ['README.md', 'README_EN.md', 'NOTICE']) {
    cpSync(join(REPO, name), join(root, name))
  }
  for (const rel of [
    'mac2win/src/core/config.mjs',
    'mac2win/src/core/errors.mjs',
    'mac2win/src/core/frameworks.mjs',
    'mac2win/src/util/fsx.mjs',
  ]) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    cpSync(join(REPO, rel), join(root, rel))
  }
  return root
}

/** 跑一次检查，返回 { status, stdout, stderr, problems }。 */
function run(root) {
  const result = spawnSync(process.execPath, [SCRIPT, '--check', '--root', root], { encoding: 'utf8' })
  const problems = result.stderr.split('\n').filter((line) => line.trimStart().startsWith('·'))
    .map((line) => line.replace(/^\s*·\s*/u, ''))
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, problems }
}

/** 在临时根上改一个文件，跑检查，返回问题清单。 */
function withEdit(root, file, edit) {
  const path = join(root, file)
  const original = readFileSync(path, 'utf8')
  const next = edit(original)
  assert.notEqual(next, original, `这条用例的改动没有生效（文件 ${file}），测试本身失效`)
  writeFileSync(path, next, 'utf8')
  try {
    return run(root)
  } finally {
    writeFileSync(path, original, 'utf8')
  }
}

/**
 * 只改附录 C 那一节里的文字，别的章节一个字不动。
 *
 * ## 为什么必须限定范围
 *
 * 正文 15.3.2 讲述这次修复时，**原文引用了「37 个配置项全表（9.2）」
 * 「二十五条亮点」这些字面串**作为证据。若直接在整份 README 上做
 * `replace`，字符串替换命中的是正文那份（它在文件里更靠前），附录 C
 * 本身没被改动 —— 于是检查通过，而用例本该失败。
 *
 * 这个坑真实发生过：初版测试就是这么写的，加完 15.3.2 之后 6 项立刻变红，
 * 而红的原因不是守卫失灵，是**测试改错了地方**。
 *
 * 教训与守卫本身一致：**改动必须落在被检查的那一节里**，否则测的是别的
 * 东西。守卫用 `sectionOf` 裁剪到附录 C，测试也得同样裁剪。
 *
 * @param {string} root
 * @param {string} file
 * @param {(appendixBody: string) => string} edit
 * @returns {ReturnType<typeof run>}
 */
function withAppendixEdit(root, file, edit) {
  return withEdit(root, file, (text) => replaceInAppendix(text, file, edit))
}

/** 把附录 C 的正文替换成 `edit` 的结果，前后原样拼回。 */
function replaceInAppendix(text, file, edit) {
  const heading = file === 'README_EN.md' ? '## Appendix C' : '## 附录 C'
  const start = text.indexOf(heading)
  assert.notEqual(start, -1, `找不到 ${file} 的附录 C 标题`)
  // 附录 C 是最后一章，直接取到文件末尾即可；若将来后面还有章节，这里要改成找下一个 `## `
  const body = text.slice(start)
  const next = edit(body)
  assert.notEqual(next, body, `附录 C 内的改动没有生效（${file}），测试本身失效`)
  return text.slice(0, start) + next
}

// ---------------------------------------------------------------------------
// 基础解析
// ---------------------------------------------------------------------------

describe('parseZhNumber', () => {
  test('单位数与十位数', () => {
    assert.equal(parseZhNumber('一'), 1)
    assert.equal(parseZhNumber('九'), 9)
    assert.equal(parseZhNumber('十'), 10)
    assert.equal(parseZhNumber('十一'), 11)
    assert.equal(parseZhNumber('十三'), 13)
    assert.equal(parseZhNumber('二十'), 20)
    assert.equal(parseZhNumber('二十五'), 25)
  })

  test('非中文数字返回 null，不回退到 0', () => {
    // 回退到 0 会让「把二十五改成 25」被当成「对得上」，正是要防的坑
    assert.equal(parseZhNumber('25'), null)
    assert.equal(parseZhNumber(''), null)
    assert.equal(parseZhNumber('百'), null)
    assert.equal(parseZhNumber('二十五条'), null)
  })
})

describe('parseEnNumber', () => {
  test('单词、复合词与阿拉伯数字都认', () => {
    assert.equal(parseEnNumber('eleven'), 11)
    assert.equal(parseEnNumber('thirteen'), 13)
    assert.equal(parseEnNumber('twenty'), 20)
    assert.equal(parseEnNumber('twenty-five'), 25)
    assert.equal(parseEnNumber('25'), 25)
  })

  test('认不出来返回 null', () => {
    assert.equal(parseEnNumber('many'), null)
    assert.equal(parseEnNumber('twenty-xx'), null)
    assert.equal(parseEnNumber(''), null)
  })
})

describe('tableRowCounts', () => {
  test('跳过表头与分隔行', () => {
    const text = ['| a | b |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |'].join('\n')
    assert.deepEqual(tableRowCounts(text), [2])
  })

  test('连续管道行会按块分开 —— 同一节里常有两张表', () => {
    // 9.2 后面紧跟一张「校验项」表；合并计数会把 37 数成 45
    const text = [
      '| a | b |', '|---|---|', '| 1 | 2 |',
      '',
      '| c | d |', '|---|---|', '| 3 | 4 |', '| 5 | 6 |',
    ].join('\n')
    assert.deepEqual(tableRowCounts(text), [1, 2])
  })
})

describe('sectionOf', () => {
  test('取到下一个二级标题前为止', () => {
    const text = '## A\n内容一\n### 子\n## B\n内容二\n'
    assert.equal(sectionOf(text, /^## A$/u), '内容一\n### 子')
  })

  test('找不到返回 null 而不是空串 —— 空串会被当成「有这一节但没数字」', () => {
    assert.equal(sectionOf('## B\nx\n', /^## A$/u), null)
  })
})

describe('noticeChapterCount', () => {
  test('数顶层编号章，忽略「一之一」这类子编号', () => {
    const text = '## 一、x\n## 一之一、y\n## 二、z\n## 三、w\n'
    assert.deepEqual(noticeChapterCount(text), { count: 3, contiguous: 3 })
  })

  test('章号跳号时 contiguous 停在断点', () => {
    const text = '## 一、x\n## 二、y\n## 四、z\n'
    assert.deepEqual(noticeChapterCount(text), { count: 3, contiguous: 2 })
  })
})

describe('parseClaims', () => {
  test('中文版取全 8 个数字', () => {
    const body = [
      '| 2 | x | 已补全。37 个配置项全表（9.2）、13 个环境变量全表（9.3）、18 项外部工具七要素表（6.2）、6 个子命令族（10.1） |',
      '| 3 | x | 二十五条亮点均含五段 |',
      '| 4 | x | 第 5 章 11 节 |',
      '| 5 | x | 第 6 章 + `NOTICE` 十三节 |',
      '| 6 | x | 校验项数（15.6）按实测 11 项 / 10 项区分 |',
    ].join('\n')
    const { claims, missing } = parseClaims(body, 'zh')
    assert.deepEqual(missing, [])
    assert.deepEqual(claims, {
      configKeys: 37,
      envVars: 13,
      extTools: 18,
      subcommandFamilies: 6,
      highlights: 25,
      chapter5Sections: 11,
      noticeChapters: 13,
      artifactChecks: 11,
    })
  })

  test('英文版取全 8 个数字', () => {
    const body = [
      '| 2 | x | Full table of 37 configuration keys (9.2), 13 environment variables (9.3), 18 external tools with all seven attributes (6.2), 6 subcommand families (10.1) |',
      '| 3 | x | All twenty-five highlights |',
      '| 4 | x | Chapter 5, eleven sections |',
      '| 5 | x | Chapter 6 plus the thirteen sections of `NOTICE` |',
      '| 6 | x | check counts (15.6) distinguish the measured 11 from 10 |',
    ].join('\n')
    const { claims, missing } = parseClaims(body, 'en')
    assert.deepEqual(missing, [])
    assert.equal(claims.highlights, 25)
    assert.equal(claims.chapter5Sections, 11)
    assert.equal(claims.noticeChapters, 13)
    assert.equal(claims.artifactChecks, 11)
  })

  test('句子里少一项时报 missing，绝不静默跳过', () => {
    const body = '| 2 | x | 已补全。37 个配置项全表（9.2） |'
    const { missing } = parseClaims(body, 'zh')
    assert.ok(missing.includes('envVars'))
    assert.ok(missing.includes('highlights'))
  })
})

// ---------------------------------------------------------------------------
// 真实仓库：8 个数字逐个篡改
// ---------------------------------------------------------------------------

describe('附录 C 的 8 个数字，逐个篡改都必须被抓到', () => {
  /** 每条用例：中文版里改一处，断言退出码 1 且报错点名该数字。 */
  const CASES = [
    { key: '配置项', from: '37 个配置项全表（9.2）', to: '32 个配置项全表（9.2）', expect: /写 32 配置项数，实际 37/u },
    { key: '环境变量', from: '13 个环境变量全表（9.3）', to: '14 个环境变量全表（9.3）', expect: /写 14 环境变量数，实际 13/u },
    { key: '外部工具', from: '18 项外部工具七要素表（6.2）', to: '14 项外部工具七要素表（6.2）', expect: /写 14 外部工具数，实际 18/u },
    { key: '子命令族', from: '6 个子命令族（10.1）', to: '10 个子命令族（10.1）', expect: /写 10 子命令族数，实际 6/u },
    { key: '亮点', from: '二十五条亮点', to: '二十条亮点', expect: /写 20 亮点条数，实际 25/u },
    { key: '第 5 章节', from: '第 5 章 11 节', to: '第 5 章 9 节', expect: /写 9 第 5 章节数，实际 11/u },
    { key: 'NOTICE 章', from: '`NOTICE` 十三节', to: '`NOTICE` 十二节', expect: /写 12 NOTICE 章数，实际 13/u },
    { key: '校验项', from: '按实测 11 项', to: '按实测 9 项', expect: /写 9 产物校验项数，实际 11/u },
  ]

  for (const item of CASES) {
    test(`附录 C 的${item.key}写错时红`, () => {
      const root = makeRoot()
      try {
        assert.equal(run(root).status, 0, '基线应通过，否则下面的断言无从归因')
        const { status, problems } = withAppendixEdit(root, 'README.md', (text) => text.replace(item.from, item.to))
        assert.equal(status, 1)
        assert.ok(
          problems.some((problem) => item.expect.test(problem)),
          `应点名「${item.key}」的数字不符，实际问题：${JSON.stringify(problems)}`,
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }

  test('8 条一起改，一次全部列出（不是遇错即停）', () => {
    const root = makeRoot()
    try {
      const { status, problems } = withAppendixEdit(root, 'README.md', (text) => {
        let next = text
        for (const item of CASES) next = next.replace(item.from, item.to)
        return next
      })
      assert.equal(status, 1)
      const numberProblems = problems.filter((problem) => /^附录 C 写 \d+ .+，实际 \d+/u.test(problem))
      assert.equal(numberProblems.length, 8, `应报出 8 条数字不符，实际 ${String(numberProblems.length)}：${JSON.stringify(problems)}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 真源变化：附录 C 不动，也能发现
// ---------------------------------------------------------------------------

describe('真源变化时必须发现（附录 C 一个字不动）', () => {
  test('9.3 表加一行 → 环境变量数不符', () => {
    const root = makeRoot()
    try {
      const { status, problems } = withEdit(root, 'README.md', (text) => {
        const lines = text.split('\n')
        const start = lines.findIndex((line) => line.startsWith('### 9.3'))
        const end = lines.findIndex((line, index) => index > start && line.startsWith('### 9.4'))
        let last = -1
        for (let i = start; i < end; i += 1) if (lines[i].startsWith('|')) last = i
        assert.notEqual(last, -1, '9.3 表格没找到，测试本身失效')
        lines.splice(last + 1, 0, '| `WACMIN_PROBE` | 探测 | 无 |')
        return lines.join('\n')
      })
      assert.equal(status, 1)
      assert.ok(problems.some((problem) => /环境变量数，实际 14/u.test(problem)),
        `应报环境变量数不符，实际：${JSON.stringify(problems)}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('DEFAULTS 加一个键 → 配置项数与 9.2 表同时报', () => {
    const root = makeRoot()
    try {
      const { status, problems } = withEdit(root, 'mac2win/src/core/config.mjs', (text) =>
        text.replace('export const DEFAULTS = {', 'export const DEFAULTS = {\n  probeExtraKey: null,'))
      assert.equal(status, 1)
      assert.ok(problems.some((problem) => /实际 38/u.test(problem) && /配置项数/u.test(problem)),
        `应有「实际 38」的配置项数不符，实际：${JSON.stringify(problems)}`)
      // 代码与文档两张清单各存一份，必须交叉验证
      assert.ok(problems.some((problem) => /两(?:张|份)清单需要同步/u.test(problem)),
        `应有「两张清单需要同步」的交叉验证报错，实际：${JSON.stringify(problems)}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('NOTICE 第三章加一行 → 与 6.2 分叉', () => {
    const root = makeRoot()
    try {
      const { status, problems } = withEdit(root, 'NOTICE', (text) => {
        const lines = text.split('\n')
        const start = lines.findIndex((line) => line.startsWith('## 三、'))
        const end = lines.findIndex((line) => line.startsWith('## 四、'))
        let last = -1
        for (let i = start; i < end; i += 1) if (lines[i].startsWith('|')) last = i
        assert.notEqual(last, -1, 'NOTICE 第三章表格没找到，测试本身失效')
        lines.splice(last + 1, 0, '| ProbeTool | 1.0 | Probe | MIT | — | 探测 | 否 |')
        return lines.join('\n')
      })
      assert.equal(status, 1)
      assert.ok(problems.some((problem) => /NOTICE 第三章有 19 行/u.test(problem)),
        `应报 NOTICE 与 6.2 分叉，实际：${JSON.stringify(problems)}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('删掉一个亮点标题 → 亮点数不符', () => {
    const root = makeRoot()
    try {
      const { status, problems } = withEdit(root, 'README.md', (text) => {
        const index = text.indexOf('#### 亮点二十三')
        assert.notEqual(index, -1)
        const end = text.indexOf('\n', text.indexOf('\n', index) + 1)
        return text.slice(0, index) + text.slice(end + 1)
      })
      assert.equal(status, 1)
      assert.ok(problems.some((problem) => /亮点条数，实际 24/u.test(problem)),
        `应报亮点数变成 24，实际：${JSON.stringify(problems)}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 两版一致
// ---------------------------------------------------------------------------

describe('两版必须逐项相同', () => {
  test('只改英文版亮点数 → 报两版不一致', () => {
    const root = makeRoot()
    try {
      const { status, problems } = withAppendixEdit(root, 'README_EN.md', (text) =>
        text.replace('All twenty-five highlights', 'All twenty highlights'))
      assert.equal(status, 1)
      assert.ok(problems.some((problem) => /两版不一致：亮点条数 中文版 25，英文版 20/u.test(problem)),
        `应报两版不一致，实际：${JSON.stringify(problems)}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('英文版把数字写成阿拉伯数字也认', () => {
    const root = makeRoot()
    try {
      // 25 与 twenty-five 是同一个数，不应报错
      const { status } = withAppendixEdit(root, 'README_EN.md', (text) =>
        text.replace('All twenty-five highlights', 'All 25 highlights'))
      assert.equal(status, 0, '写成阿拉伯数字是同一事实，不该判红')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 缺失与结构
// ---------------------------------------------------------------------------

describe('缺东西时必须报错，不能静默通过', () => {
  test('删掉附录 C 整节 → 报找不到', async () => {
    const root = makeRoot()
    try {
      const path = join(root, 'README.md')
      const original = readFileSync(path, 'utf8')
      const index = original.indexOf('## 附录 C、自检清单')
      assert.notEqual(index, -1)
      writeFileSync(path, original.slice(0, index), 'utf8')
      const problems = await checkAppendix(root)
      assert.ok(problems.some((problem) => /找不到「附录 C」/u.test(problem)),
        `应报找不到附录 C，实际：${JSON.stringify(problems)}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('config.mjs 不可读 → 报错而不是把配置项那条跳过', async () => {
    const root = makeRoot()
    try {
      rmSync(join(root, 'mac2win/src/core/config.mjs'))
      const problems = await checkAppendix(root)
      assert.ok(problems.some((problem) => /无法核对配置项数/u.test(problem)),
        `应报配置项数核对不了，实际：${JSON.stringify(problems)}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 对真实仓库的断言
// ---------------------------------------------------------------------------

describe('对真实仓库的断言', () => {
  test('当前附录 C 与代码常量、文档结构逐项相符', async () => {
    /*
     * 这里不认任何具体数字，只认「检查通过」。
     *
     * 具体数字的真源是 README 的表格、`config.mjs` 的 `DEFAULTS` 与
     * `NOTICE` 的章节；测试若把它们背下来，就等于在第三处又存一份 ——
     * 而「同一个数字存多处必然漂移」正是本文件所守的那条规矩。
     */
    const problems = await checkAppendix(REPO)
    assert.deepEqual(problems, [], `附录 C 应与真源一致，实际：${JSON.stringify(problems)}`)
  })

  test('--check 的输出里附录 C 那一行必须出现 —— 守卫生效的可见证据', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: REPO, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /附录 C 自检清单/u)
  })
})
