/**
 * 表格结构守卫的测试。
 *
 * ## 为什么这些用例长这样（2026-11-22，第 17 轮）
 *
 * 15.7 表有 3 行少一整列，而前三轮都报「表格异常 0」。那三轮的判据是
 * 「这行是表格行吗」—— 它从不与表头比列数，于是少一列的行完全合格。
 *
 * 所以这里每条用例都要能回答一个问题：**这条断言在哪种具体篡改下会红？**
 * 凡是构造不出对立面的，都是空转。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  cellCount, isSeparator, tableBlocks, checkTables, checkRepo,
} from './table-guard.mjs'

test('cellCount 只数未转义的竖线', () => {
  assert.equal(cellCount('| a | b | c |'), 3)
  assert.equal(cellCount('| a | b |'), 2)
  // `\|` 是字面竖线，不是列边界 —— 本仓库有多处 `\\|` 转义（表格里讲正则）
  assert.equal(cellCount('| a \\| b | c |'), 2)
  /*
   * 行内代码里的竖线**算**列边界 —— 这是 GFM 的规则，不是本实现的偏好：
   * 表格里的 `|` 一律要写 `\|`，代码段也不例外，否则渲染出来确实会错位。
   * 这里刻意断言 4 而不是 2：若哪天有人「顺手」让代码段豁免，这条会红，
   * 提醒他那是与渲染器不一致的改动。本仓库两份 README 实测 0 处表格行
   * 含未转义的 `||`（2026-11-22 扫过），所以不会被这条规则误伤。
   */
  assert.equal(cellCount('| `a || b` | c |'), 4)
})

test('isSeparator 认分隔行，不认普通数据行', () => {
  assert.equal(isSeparator('|---|---|'), true)
  assert.equal(isSeparator('|:--|--:|'), true)
  assert.equal(isSeparator('| 甲 | 乙 |'), false)
})

test('tableBlocks 跳过围栏代码块里的管道符', () => {
  const text = [
    '```sh',
    'grep -n "a" f | head',
    '```',
    '',
    '| 甲 | 乙 |',
    '|---|---|',
    '| 1 | 2 |',
  ].join('\n')
  const blocks = tableBlocks(text)
  assert.equal(blocks.length, 1, '代码块里的管道符不许造出假表格块')
  assert.equal(blocks[0].header, 2)
  assert.equal(blocks[0].rows.length, 1)
})

test('少一列必须被抓到 —— 这条就是 15.7 的实际形态', () => {
  const text = [
    '| 缺陷 | 症状 | 根因 | 修复 |',
    '|---|---|---|---|',
    '| A | a | r | fixed |',
    '| B | b | fixed |',           // ← 缺「根因」，与 15.7 那三行同形
  ].join('\n')
  const problems = checkTables(text, 'X.md')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /列数 3 ≠ 表头 4/u)
})

test('多一列也必须被抓到 —— 少列与多列是同一类错，不许只守一边', () => {
  const text = [
    '| 甲 | 乙 |',
    '|---|---|',
    '| 1 | 2 | 3 |',
  ].join('\n')
  const problems = checkTables(text, 'X.md')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /列数 3 ≠ 表头 2/u)
})

test('同一块内两张表不许互相冒充：块边界按空行切', () => {
  // 9.2 后面紧跟一张「校验项」表，合并计数会把两张表揉成一块
  const text = [
    '| 甲 | 乙 | 丙 |',
    '|---|---|---|',
    '| 1 | 2 | 3 |',
    '',
    '| 丁 | 戊 |',
    '|---|---|',
    '| 4 | 5 |',
  ].join('\n')
  assert.equal(checkTables(text, 'X.md').length, 0,
    '两张表各自列数自洽，不许因为块外列数不同而红')
})

test('列数正确的表必须通过 —— 防矫枉过正', () => {
  const text = [
    '| 甲 | 乙 |',
    '|---|---|',
    '| 1 | 2 |',
    '| 3 | 4 |',
  ].join('\n')
  assert.equal(checkTables(text, 'X.md').length, 0)
})

test('真实仓库的两版 README 必须通过', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const problems = checkRepo(repoRoot)
  assert.deepEqual(problems, [], problems.join('\n'))
})
