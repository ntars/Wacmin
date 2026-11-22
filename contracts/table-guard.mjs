/**
 * README 表格结构守卫：同一块内每行的单元格数必须与表头一致。
 *
 * ## 这个脚本为什么存在（2026-11-22，第 17 轮）
 *
 * README 15.7「其他已修正的缺陷」是一张 4 列表，其中**三行只有 3 个单元格**
 * ——「根因」整列缺失。这在 HEAD 上就存在，而第 14–16 三轮 JOURNAL 都写着
 * 「表格异常行两版均 0」「表格列数异常 0」。
 *
 * 那些结论不是抄的，是真跑了一个检查得出的。问题在那个检查的判据：
 *
 *     「这一行以 `|` 开头、以 `|` 结尾、能切出至少两个格子」→ 算合法表格行
 *
 * 它只数「是不是表格行」，**从不与表头比列数**。于是少一整列的行在它眼里
 * 完全合格。一个只数格子的判据，对「少一个格子」是瞎的 —— 与第 15 轮
 * 「永远为真的判据等于没写」是同一类错误的两个外形。
 *
 * ## 判据
 *
 * 1. 一块表格 = 连续若干行 `|` 开头的行（跳过围栏代码块内的内容）。
 * 2. 块内首行为表头；其后每一行（除 `|---|` 分隔行）的列数必须等于表头。
 * 3. 按**未转义的** `|` 切分（`\|` 是 Markdown 的字面竖线，不算列边界）。
 * 4. 两版 README 都要过。
 *
 * 不做的事：不校验列宽、不校验对齐符、不校验内容 —— 那些是排版偏好，
 * 不是错误。这里只抓「结构上少一列」这种渲染出来会错位、且人眼在 1700 行
 * 文档里看不出来的问题。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 按未转义的 `|` 切分一行表格，返回单元格数（不含首尾空段）。
 *
 * @param {string} line
 * @returns {number}
 */
export function cellCount(line) {
  const trimmed = line.trim()
  // 逐字符走一遍，`\|` 跳过（反斜杠本身不消费下一个字符之外的语义）
  let cells = 0
  let current = ''
  const parts = []
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i]
    if (char === '\\' && trimmed[i + 1] === '|') {
      current += '|'
      i += 1
      continue
    }
    if (char === '|') {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  // 首尾各一个「空段」是 Markdown 表格的边界，不算列
  if (parts.length >= 2 && parts[0].trim() === '') parts.shift()
  if (parts.length >= 1 && parts[parts.length - 1].trim() === '') parts.pop()
  cells = parts.length
  return cells
}

/** 是否是 `|---|:--:|` 这类分隔行。 */
export function isSeparator(line) {
  return /^\|[\s:|-]+\|$/u.test(line.trim()) && line.includes('-')
}

/**
 * 抽出所有表格块，每块返回 `{ startLine, header: 列数, rows: [{line, cells}] }`。
 *
 * 围栏代码块里的 `|` 不算表格 —— README 里有大量 shell 片段写着管道符，
 * 把它们算进来会造出一堆假块，最后只能靠人放宽规则。
 *
 * @param {string} text
 * @returns {{startLine: number, header: number, rows: {line: number, cells: number}[]}[]}
 */
export function tableBlocks(text) {
  const blocks = []
  let current = null
  let inFence = false
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*```/u.test(line)) {
      inFence = !inFence
      current = null
      continue
    }
    const isRow = !inFence && /^\s*\|/u.test(line)
    if (isRow) {
      if (current === null) {
        current = { startLine: i + 1, header: cellCount(line), rows: [] }
      } else if (!isSeparator(line)) {
        current.rows.push({ line: i + 1, cells: cellCount(line) })
      }
      continue
    }
    if (current !== null) {
      blocks.push(current)
      current = null
    }
  }
  if (current !== null) blocks.push(current)
  return blocks
}

/**
 * 检查一份 README，返回问题清单（空数组表示通过）。
 *
 * @param {string} text
 * @param {string} name 用于报错的文件名
 * @returns {string[]}
 */
export function checkTables(text, name) {
  const problems = []
  for (const block of tableBlocks(text)) {
    for (const row of block.rows) {
      if (row.cells !== block.header) {
        problems.push(
          `${name}:${row.line} 列数 ${row.cells} ≠ 表头 ${block.header}（表格起始第 ${block.startLine} 行）`,
        )
      }
    }
  }
  return problems
}

/**
 * 对真实仓库跑一遍（两份 README）。
 *
 * @param {string} root
 * @returns {string[]}
 */
export function checkRepo(root) {
  const problems = []
  for (const name of ['README.md', 'README_EN.md']) {
    const path = join(root, name)
    if (!existsSync(path)) {
      problems.push(`找不到 ${name}，无法校验表格结构`)
      continue
    }
    problems.push(...checkTables(readFileSync(path, 'utf8'), name))
  }
  return problems
}
