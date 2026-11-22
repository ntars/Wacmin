/**
 * README 两版小节编号对称守卫：中文版有的编号，英文版必须也有，反之亦然。
 *
 * ## 这个脚本为什么存在（2026-11-22，第 20 轮）
 *
 * 本轮往 `README.md` 加了整节「15.32」，`README_EN.md` 没同步 —— 少了整整
 * 一节（`###` 少 1 个、`####` 少 7 个），而 `node contracts/doc-counts.mjs
 * --check` 依然报「两版逐项相同」并退 0。
 *
 * 为什么没拦住：那个检查比的是**计数表里的数字与常量**（12.1 各模块测试数、
 * 附录 C 那 8 个数），以及**表格结构每行列数**。它压根不问「两版的章节集合
 * 是否一致」。于是「整节缺失」这种最严重的不同步，在它眼里完全合格。
 *
 * 此前每轮 JOURNAL 里写的「两版 `##` 23/23 `###` 134/134 `####` 182/182
 * 对称」，靠的是**人手工数一遍**。人手数出来的数字有两个毛病：改文档时
 * 没人提醒你要重数，且数错了读起来毫无破绽。这轮就是先信了那句话，直到
 * 自己数才发现差 1 个 `###`。
 *
 * ## 判据
 *
 * 1. 抽两版所有 `##` / `###` / `####` 标题里的**编号**（`15.32`、`12.1`、
 *    `5.11`、`A`、`C` 这类），编号是语言无关的，可以直接对账。
 * 2. 中英各一份集合；两边的差集都必须为空。
 * 3. 只比对**同时带编号**的标题。纯文字标题（`## 附录 A、错误码总表` 与
 *    `## Appendix A. Error Codes` 之外的散文标题）不参与，避免拿语言去猜对应关系。
 *
 * 不做的事：不校标题的译文质量、不校标题顺序之外的内容 —— 顺序单独查，
 * 因为「编号都在但顺序乱了」是另一种错，得单独报。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 标题行：`## 15. 已知问题` / `### 15.32 标题` / `#### ① 问题`。 */
const HEADING = /^(#{2,4})\s+(.*)$/u

/**
 * 从一个标题文本里抽编号，抽不到返回 null。
 *
 * 认的形状：
 *   - `15.32 只下了一半…`   → `15.32`
 *   - `12.1 测试规模`        → `12.1`
 *   - `15. 已知问题`          → `15`
 *   - `十六、更新日志`         → `16`（中文数字转阿拉伯，见 `chineseNumber`）
 *   - `附录 A、错误码总表`    → `A`
 *   - `Appendix B. Push guide` → `B`
 *
 * 两个坑都是负向验证时撞出来的：
 *
 * 1. **编号改坏本身就是要抓的错，判据却看不见。** 第一版 `(?![\d.])` 把
 *    `15.32x` 认成 `15.32` —— 负向验证把编号改成 `15.32x`，守卫照样报 0 个
 *    问题。正则的回溯会悄悄退回一个更短的前缀（`15.32` → `15.3` → `15`），
 *    所以不能靠 lookahead 收尾，必须**先取完整数字串再看后面跟的是什么**。
 * 2. **两版顶章的编号体系不同。** 中文版是 `## 十五、已知问题`，英文版是
 *    `## 15. Known Issues`。第一版只认阿拉伯数字，于是中文顶章一个都没抽到，
 *    「0 个问题」是通过**两边都没比**凑出来的 —— 一个把范围缩到空集的判据，
 *    永远为真。
 *
 * @param {string} text
 * @returns {string|null}
 */
export function sectionNumber(text) {
  const body = text.trim()

  const num = /^(\d+(?:\.\d+)*)/u.exec(body)
  if (num) {
    const rest = body.slice(num[1].length)
    // 允许紧跟一个句点（英文版 `## 16. Changelog`），但其后不许接字母数字
    const after = rest.startsWith('.') ? rest.slice(1) : rest
    return after === '' || !/^[A-Za-z0-9]/u.test(after) ? num[1] : null
  }

  const cn = /^([一二三四五六七八九十]+)、/u.exec(body)
  if (cn) {
    const value = chineseNumber(cn[1])
    if (value !== null) return String(value)
  }

  // 附录：`附录 A、…` / `Appendix B. …`
  const appendix = /^(?:附录|Appendix)\s*([A-Z])(?![A-Za-z])/u.exec(body)
  if (appendix) return appendix[1]
  return null
}

/**
 * 中文数字转整数，只支持 README 用到的一到九十九。
 *
 * @param {string} text
 * @returns {number|null}
 */
export function chineseNumber(text) {
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (text === '十') return 10
  const tenAt = text.indexOf('十')
  if (tenAt === -1) return text.length === 1 ? (digits[text] ?? null) : null
  const high = tenAt === 0 ? 1 : digits[text.slice(0, tenAt)]
  const lowText = text.slice(tenAt + 1)
  const low = lowText === '' ? 0 : digits[lowText]
  if (high === undefined || low === undefined) return null
  return high * 10 + low
}

/**
 * 抽出一份 README 里所有带编号的小节，按出现顺序。
 *
 * @param {string} text
 * @returns {{level: number, number: string, line: number}[]}
 */
export function numberedSections(text) {
  const out = []
  let inFence = false
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*```/u.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = HEADING.exec(line)
    if (!match) continue
    const number = sectionNumber(match[2])
    if (number === null) continue
    out.push({ level: match[1].length, number, line: i + 1 })
  }
  return out
}

/**
 * 比对两版的小节编号集合。
 *
 * @param {string} zh 中文版全文
 * @param {string} en 英文版全文
 * @returns {string[]} 问题清单，空数组表示通过
 */
export function compareSections(zh, en) {
  const zhList = numberedSections(zh)
  const enList = numberedSections(en)
  const zhSet = new Set(zhList.map((s) => s.number))
  const enSet = new Set(enList.map((s) => s.number))

  const problems = []
  for (const s of zhList) {
    if (!enSet.has(s.number)) {
      problems.push(`小节 ${s.number}（README.md:${s.line}）在 README_EN.md 里不存在`)
    }
  }
  for (const s of enList) {
    if (!zhSet.has(s.number)) {
      problems.push(`小节 ${s.number}（README_EN.md:${s.line}）在 README.md 里不存在`)
    }
  }
  return problems
}

/**
 * 对真实仓库跑一遍。
 *
 * @param {string} root
 * @returns {string[]}
 */
export function checkRepo(root) {
  const zhPath = join(root, 'README.md')
  const enPath = join(root, 'README_EN.md')
  for (const p of [zhPath, enPath]) {
    if (!existsSync(p)) return [`找不到 ${p}，无法校验两版小节对称`]
  }
  return compareSections(readFileSync(zhPath, 'utf8'), readFileSync(enPath, 'utf8'))
}
