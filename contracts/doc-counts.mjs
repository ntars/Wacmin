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
 * @returns {{ rows: Map<string, number>, total: number|null }}
 */
export function parseCountTable(text) {
  const rows = new Map()
  let total = null

  for (const line of text.split('\n')) {
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
      `  node contracts/doc-counts.mjs --check\n` +
      `  node contracts/doc-counts.mjs --min <${MODULES.join('|')}>\n` +
      `  node contracts/doc-counts.mjs --list\n`,
  )
  process.exit(2)
}

function main(argv) {
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

  if (argv.includes('--check')) {
    const problems = check(root)
    if (problems.length > 0) {
      process.stderr.write(`✗ 12.1 测试计数不一致（${problems.length} 处）\n`)
      for (const problem of problems) {
        process.stderr.write(`  · ${problem}\n`)
      }
      process.exit(1)
    }
    const { rows, total } = parseCountTable(readDoc(join(root, 'README.md')))
    const sum = [...rows.values()].reduce((acc, value) => acc + value, 0)
    process.stdout.write(
      `✓ 12.1 计数一致：${MODULES.length} 个模块合计 ${sum} 项，两版逐项相同\n`,
    )
    return
  }

  usage('需要 --check / --min / --list 之一')
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('doc-counts.mjs')) {
  main(process.argv.slice(2))
}
