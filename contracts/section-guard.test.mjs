import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  cellCount, isSeparator, tableBlocks, checkTables, checkRepo,
} from './table-guard.mjs'
import {
  sectionNumber, chineseNumber, numberedSections, compareSections,
  checkRepo as checkSectionRepo,
} from './section-guard.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('cellCount 按未转义的竖线切分，`\\|` 不算列边界', () => {
  assert.equal(cellCount('| a | b | c |'), 3)
  assert.equal(cellCount('| a \\| b | c |'), 2)
  assert.equal(cellCount('| a || c |'), 3)
})

test('isSeparator 认分隔行，且必须含连字符', () => {
  assert.equal(isSeparator('|---|---|'), true)
  assert.equal(isSeparator('|:--:|--:|'), true)
  assert.equal(isSeparator('| a | b |'), false)
})

test('tableBlocks 跳过围栏代码块里的管道符', () => {
  const text = [
    '| h1 | h2 |',
    '|---|---|',
    '| a | b |',
    '',
    '```sh',
    '| not | a | table |',
    '```',
  ].join('\n')
  const blocks = tableBlocks(text)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].rows.length, 1)
})

test('checkTables 抓少一列，报出行号与两端列数', () => {
  const text = ['| h1 | h2 |', '|---|---|', '| only-one |'].join('\n')
  const problems = checkTables(text, 'X.md')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /列数 1 ≠ 表头 2/u)
})

test('checkTables 抓多一列，不是只抓少', () => {
  const text = ['| h1 | h2 |', '|---|---|', '| a | b | c |'].join('\n')
  assert.equal(checkTables(text, 'X.md').length, 1)
})

test('列数正确的表格必须通过（不让守卫变成永远为真）', () => {
  const text = ['| h1 | h2 |', '|---|---|', '| a | b |'].join('\n')
  assert.equal(checkTables(text, 'X.md').length, 0)
})

test('两版 README 表格结构真实通过', () => {
  assert.deepEqual(checkRepo(ROOT), [])
})

test('sectionNumber 认得四种编号体系', () => {
  assert.equal(sectionNumber('15.32 只下了一半'), '15.32')
  assert.equal(sectionNumber('12.1 测试规模'), '12.1')
  assert.equal(sectionNumber('15. 已知问题'), '15')
  assert.equal(sectionNumber('16. Changelog'), '16')
  assert.equal(sectionNumber('附录 A、错误码总表'), 'A')
  assert.equal(sectionNumber('Appendix B. Push guide'), 'B')
})

test('sectionNumber 把中文数字顶章也认出来（否则等于两边都没比）', () => {
  assert.equal(sectionNumber('十五、已知问题'), '15')
  assert.equal(sectionNumber('十六、更新日志'), '16')
  assert.equal(sectionNumber('五、目录'), '5')
  assert.equal(sectionNumber('二十、NOTICE 开源合规声明'), '20')
})

test('sectionNumber 对「编号后面接了字母」返回 null', () => {
  // 负向验证时把 15.32 改成 15.32x，第一版判据仍认作 15.32 —— 守卫看不见
  // 「编号本身改坏了」这件正是要抓的事。
  assert.equal(sectionNumber('15.32x 坏'), null)
  assert.equal(sectionNumber('15.3a 坏'), null)
})

test('sectionNumber 不许把 15.3 匹配成 15.32 的前缀', () => {
  assert.equal(sectionNumber('15.3 三处'), '15.3')
  assert.notEqual(sectionNumber('15.3 三处'), '15.32')
})

test('sectionNumber 对没有编号的标题返回 null', () => {
  assert.equal(sectionNumber('① 问题'), null)
  assert.equal(sectionNumber('为什么需要它'), null)
})

test('chineseNumber 覆盖一到九十九', () => {
  assert.equal(chineseNumber('一'), 1)
  assert.equal(chineseNumber('九'), 9)
  assert.equal(chineseNumber('十'), 10)
  assert.equal(chineseNumber('十五'), 15)
  assert.equal(chineseNumber('二十'), 20)
  assert.equal(chineseNumber('二十一'), 21)
  assert.equal(chineseNumber('九十九'), 99)
})

test('numberedSections 跳过围栏代码块里的 `## ` 行', () => {
  const text = ['## 15. 已知问题', '```md', '## 99. 假标题', '```'].join('\n')
  const sections = numberedSections(text)
  assert.deepEqual(sections.map((s) => s.number), ['15'])
})

test('compareSections 抓「英文版缺整节」—— 本轮的真实缺陷', () => {
  // 两版都有的 15.31 必须不报，只报英文版缺的 15.32
  const zh = '### 15.31 半个 exe\n\n### 15.32 只下了一半\n\n#### ① 问题\n'
  const en = '### 15.31 Half an exe\n'
  const problems = compareSections(zh, en)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /15\.32/u)
  assert.match(problems[0], /README_EN\.md 里不存在/u)
})

test('compareSections 反方向也抓（中文版缺节）', () => {
  const zh = '### 15.31 半个 exe\n'
  const en = '### 15.31 Half an exe\n### 15.32 Half a runtime\n'
  const problems = compareSections(zh, en)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /README\.md 里不存在/u)
})

test('compareSections 两版一致时返回空（本体不许永远为真）', () => {
  const zh = '## 十五、已知问题\n### 15.32 甲\n'
  const en = '## 15. Known Issues\n### 15.32 A\n'
  assert.deepEqual(compareSections(zh, en), [])
})

test('compareSections 认得出中文顶章与英文顶章是同一节', () => {
  const zh = '## 十六、更新日志\n'
  const en = '## 16. Changelog\n'
  assert.deepEqual(compareSections(zh, en), [])
})

test('两版 README 小节编号真实对称', () => {
  const problems = checkSectionRepo(ROOT)
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('守卫扫描范围非空 —— 防止 glob 返回空集让断言全绿', () => {
  const zh = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const en = readFileSync(join(ROOT, 'README_EN.md'), 'utf8')
  assert.ok(numberedSections(zh).length > 100, '中文版带编号小节应过百')
  assert.ok(numberedSections(en).length > 100, '英文版带编号小节应过百')
})
