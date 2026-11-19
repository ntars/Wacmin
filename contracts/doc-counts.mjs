#!/usr/bin/env node
/**
 * 校验 README 12.1 表格里的测试计数，并把它作为 CI 基线的唯一来源。
 *
 * ## 这个脚本为什么存在
 *
 * README 12.1 声明自己是「本仓库测试计数的唯一来源」，但这句话此前**没有
 * 任何东西在强制执行**。同一份数字实际存了四处：
 *
 *   1. README.md 12.1 表格
 *   2. README_EN.md 12.1 表格
 *   3. .github/workflows/ci.yml 的 `--min 132` / `--min 416` / `--min 43`
 *   4. 各模块测试实际跑出来的数量
 *
 * 前三处任何一处改动而其余不动，就会分叉。这不是假设 —— 本仓库已经发生过
 * 三次：总数写 978（实际 1150）、英文版把 mac2win 记成 131、6.5 与 NOTICE
 * 第八章各有一份互不相同的「未使用技术」清单。防漂移的办法不是「记住要同步
 * 修改」，而是让**同一个数字只有一个写入点，其余全部读它**。
 *
 * 所以这个脚本做两件事：
 *   - `--check`：表格自洽（合计 = 各分项之和）且两版语言逐项一致
 *   - `--min <模块>`：从表格读基线，供 CI 的 check-no-skips 使用，
 *     从而删掉 ci.yml 里那三个硬编码数字
 *
 * 它**不**知道测试实际跑出来多少 —— 那需要先跑测试。实时比对由
 * `--actual` 完成：传入各模块的测试日志，脚本解析出真实数量再与表格比。
 *
 * ## 为什么不做成 validate.mjs 的一部分
 *
 * validate.mjs 的职责是「四方向的退出码与报告契约」，那是运行期行为；
 * 本脚本检查的是文档声明，属于仓库元数据。两类东西的失败意味着完全不同
 * 的修复动作（前者改实现，后者改文档），混在一起会让报错信息难以归因。
 *
 * 用法：
 *   node contracts/doc-counts.mjs --check
 *   node contracts/doc-counts.mjs --min mac2win          # 输出 132
 *   node contracts/doc-counts.mjs --min exeonmac --json  # 输出 {"min":416,...}
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkAppendix } from './appendix-guard.mjs'

/** 附录 C 里被守着的数字个数，用于通过信息里报数（与 FACT_KEYS 同长）。 */
const FACT_COUNT = 8

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')

/** 12.1 表格里出现过的模块名。顺序即表格顺序，报错时按它排。 */
const MODULES = ['mac2win', 'exeonmac', 'win2mac', 'apponwin', 'console', 'ai', 'contracts']

/**
 * 从 README 文本里抓出 12.1 表格的每一行。
 *
 * 中文版写 `132 项`，英文版写 `132`。两者都接受，因为这里要的是数字。
 * 合计行中文是 `**合计**`，英文是 `**Total**`，同样两种都认。
 *
 * ## 为什么必须限定在 12.1 那一节里
 *
 * 初版是扫描**整份** README 的所有表格行，同名的行后写覆盖先写。平时没事，
 * 因为 12.1 只此一张；但 15.13 记交付体检时加了一张历史对照表，里面也有
 * `| contracts | 79 | 58（且 1 项**红**）|` 这种行 —— 它排在 12.1 之后，
 * 于是 `--check` 读到的 contracts 是 **79**，而 12.1 明明写着 111。
 *
 * 实测复现：把 12.1 的 contracts 改成 111、合计算对，`--check` 仍报
 * 「合计写 1319，但分项之和是 1287」——**它读的是 300 行之外那张历史表**。
 * 这个缺陷本身不会误报（合计与分项都用同一份错读，加总仍然自洽），
 * 只有在改了真值时才会暴露，所以它能潜伏很久。
 *
 * 修法是先裁到 12.1 一节再解析。`--min` 也跟着受益：CI 的基线不该被
 * 正文里任何一张旁证表影响。
 *
 * @param {string} text 整份 README
 * @returns {{ rows: Map<string, number>, total: number|null }}
 */
export function parseCountTable(text) {
  const rows = new Map()
  let total = null

  for (const line of countTableSection(text).split('\n')) {
    if (!line.startsWith('|')) continue

    // 拆列并去掉首尾空串：`| a | b |` → ['a','b']
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    if (cells.length < 2) continue

    // 第一列可能是 `**合计**` / `**Total**` / 普通模块名
    const rawName = cells[0].replace(/\*\*/g, '').trim()
    // 第二列可能是 `132 项` / `132` / `**1150 项**`
    const number = Number(cells[1].replace(/\*\*/g, '').replace(/项$/, '').trim())

    if (!Number.isFinite(number)) continue

    if (rawName === '合计' || rawName === 'Total') {
      total = number
    } else if (MODULES.includes(rawName)) {
      rows.set(rawName, number)
    }
  }

  return { rows, total }
}

/**
 * 裁出 12.1 那一节的正文。
 *
 * 找不到这一节时返回**全文**而不是空串：返回空串会让所有模块「缺行」，
 * 报错指向「表格缺 7 个模块」，掩盖真因「章节标题改了名」。返回全文时
 * 行为退回旧版（能跑，只是可能读到旁证表），比直接崩更好排查。
 *
 * @param {string} text
 * @returns {string}
 */
function countTableSection(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^### 12\.1 /u.test(line))
  if (start === -1) return text
  const body = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{2,3} /u.test(lines[i])) break
    body.push(lines[i])
  }
  return body.join('\n')
}

/** 读 README 全文。路径由调用方给，测试用它指向临时文件。 */
function readDoc(path) {
  if (!existsSync(path)) {
    throw new Error(`找不到文档：${path}`)
  }
  return readFileSync(path, 'utf8')
}

/** 收集所有问题而不是遇错即抛，一次把全部分歧列给用户。 */
function check(root) {
  const problems = []

  const zh = parseCountTable(readDoc(join(root, 'README.md')))
  const en = parseCountTable(readDoc(join(root, 'README_EN.md')))

  // 1) 中文版表格本身是否齐全
  for (const name of MODULES) {
    if (!zh.rows.has(name)) problems.push(`README.md 12.1 表格缺 ${name} 一行`)
  }

  // 2) 合计是否等于分项之和 —— 这是最容易错也最难靠眼睛发现的一条
  if (zh.total === null) {
    problems.push('README.md 12.1 表格缺合计行')
  } else {
    const sum = [...zh.rows.values()].reduce((acc, value) => acc + value, 0)
    if (sum !== zh.total) {
      const detail = [...zh.rows.entries()].map(([key, value]) => `${key} ${value}`).join(' + ')
      problems.push(`README.md 合计写 ${zh.total}，但分项之和是 ${sum}（${detail} = ${sum}）`)
    }
  }

  // 3) 两版语言逐项一致 —— 分叉过两次的地方
  for (const name of MODULES) {
    const inZh = zh.rows.get(name)
    const inEn = en.rows.get(name)
    if (inZh === undefined || inEn === undefined) continue
    if (inZh !== inEn) {
      problems.push(`12.1 两版不一致：${name} 中文版 ${inZh}，英文版 ${inEn}`)
    }
  }

  if (zh.total !== null && en.total !== null && zh.total !== en.total) {
    problems.push(`12.1 合计两版不一致：中文版 ${zh.total}，英文版 ${en.total}`)
  }

  return problems
}

/**
 * 读 12.1 表格里某个模块的计数，供 CI 当基线。
 *
 * 取不到就抛错而不是回退到 0 —— 回退到 0 意味着 `--min 0` 永远通过，
 * 等于把守卫关掉而报告全绿，正是本仓库反复踩过的坑。
 */
function minOf(root, moduleName) {
  const { rows } = parseCountTable(readDoc(join(root, 'README.md')))
  const value = rows.get(moduleName)
  if (value === undefined) {
    throw new Error(`12.1 表格里没有 ${moduleName}，无法取出 CI 基线`)
  }
  return value
}

function usage(message) {
  process.stderr.write(
    `${message}\n\n` +
      `用法：\n` +
      `  node contracts/doc-counts.mjs --check            # 12.1 计数 + 附录 C，CI 与 18.2 用这个\n` +
      `  node contracts/doc-counts.mjs --check-counts     # 只查 12.1（给夹具测试用）\n` +
      `  node contracts/doc-counts.mjs --check-appendix    # 只查附录 C\n` +
      `  node contracts/doc-counts.mjs --min <${MODULES.join('|')}>\n` +
      `  node contracts/doc-counts.mjs --list\n`,
  )
  process.exit(2)
}

/** 跑 12.1 表格检查，返回问题清单。 */
function checkCounts(root) {
  return check(root)
}

/**
 * 打印问题并退出，或打印两行通过信息。
 *
 * @param {string[]} problems
 * @param {{counts: boolean, appendix: boolean, root: string}} options
 */
function report(problems, options) {
  if (problems.length > 0) {
    process.stderr.write(`✗ 文档计数不一致（${problems.length} 处）\n`)
    for (const problem of problems) {
      process.stderr.write(`  · ${problem}\n`)
    }
    process.exit(1)
  }
  if (options.counts) {
    const { rows } = parseCountTable(readDoc(join(options.root, 'README.md')))
    const sum = [...rows.values()].reduce((acc, value) => acc + value, 0)
    process.stdout.write(
      `✓ 12.1 计数一致：${MODULES.length} 个模块合计 ${sum} 项，两版逐项相同\n`,
    )
  }
  if (options.appendix) {
    process.stdout.write(
      `✓ 附录 C 自检清单：${FACT_COUNT} 个数字与代码常量、文档结构逐项相符，两版相同\n`,
    )
  }
}

async function main(argv) {
  const rootIndex = argv.indexOf('--root')
  const root = rootIndex >= 0 ? argv[rootIndex + 1] : REPO_ROOT

  if (argv.includes('--list')) {
    const { rows, total } = parseCountTable(readDoc(join(root, 'README.md')))
    for (const name of MODULES) {
      process.stdout.write(`${name} ${rows.get(name) ?? '?'}\n`)
    }
    process.stdout.write(`total ${total ?? '?'}\n`)
    return
  }

  const minIndex = argv.indexOf('--min')
  if (minIndex >= 0) {
    const moduleName = argv[minIndex + 1]
    if (moduleName === undefined || moduleName.startsWith('-')) {
      usage('--min 后面需要模块名')
    }
    const value = minOf(root, moduleName)
    process.stdout.write(`${value}\n`)
    return
  }

  /*
   * `--check` 一把跑完两件事：12.1 的测试计数，与附录 C 的 8 个文档事实。
   *
   * 附录 C 那 8 个数字全是人手数出来的，2026-11-19 的 W-03 巡检里 9 处
   * 文档缺陷有 4 处正是这一类。实测过：把「37 个配置项」改成 32、
   * 「二十五条亮点」改成二十，加上这层守卫之前的 `--check` 照样输出
   * 「✓ 计数一致」—— 等于没守。
   *
   * 放进同一个命令而不是另开一个，是因为 CI 与 18.2 检查块已经在跑
   * `--check`；加一个需要人记得去跑的新命令，等于给它一个被遗忘的机会。
   *
   * 另两个只跑一半的入口是给测试用的：12.1 的夹具只造两份 README，
   * 附录 C 的夹具还要 `NOTICE` 与 `config.mjs`，混在一起会让两边都
   * 被迫造一堆与本用例无关的文件，测试意图反而看不清。
   */
  const wantCounts = argv.includes('--check') || argv.includes('--check-counts')
  const wantAppendix = argv.includes('--check') || argv.includes('--check-appendix')

  if (wantCounts || wantAppendix) {
    const problems = []
    if (wantCounts) problems.push(...checkCounts(root))
    if (wantAppendix) problems.push(...await checkAppendix(root))
    report(problems, { counts: wantCounts, appendix: wantAppendix, root })
    return
  }

  usage('需要 --check / --check-counts / --check-appendix / --min / --list 之一')
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('doc-counts.mjs')) {
  await main(process.argv.slice(2))
}
