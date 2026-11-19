/**
 * 附录 C 自检清单的机器守卫。
 *
 * ## 为什么需要它
 *
 * 附录 C 是「README 照提示词十章逐条自检」的结论表，里面写着 8 个数字：
 * 37 个配置项、13 个环境变量、18 项外部工具、6 个子命令族、25 条亮点、
 * 第 5 章 11 节、`NOTICE` 13 章、产物校验 11 项。
 *
 * 这些数字**全是人手工数出来写进去的** —— 而 2026-11-19 的 W-03 巡检
 * 里，9 处文档缺陷有 4 处正是这一类（配置项 32/14/10 三个数一起过期、
 * 亮点漏数成二十条）。它们读起来毫无破绽，所以不会有人去复核。
 *
 * 实测过：把「37 个配置项」改成 32、把「二十五条亮点」改成二十，
 * `doc-counts.mjs --check` 仍然输出「✓ 计数一致」。守卫形同不存在。
 *
 * 所以这里把每个数字都改成**从文档与代码里读出来再对账**：
 *
 * | 数字 | 真源 |
 * |---|---|
 * | 配置项 37 | `config.mjs` 的 `DEFAULTS` 键数，并与 9.2 首表行数交叉验证 |
 * | 环境变量 13 | 9.3 表行数 |
 * | 外部工具 18 | 6.2 表行数，并与 `NOTICE` 第三章表行数交叉验证 |
 * | 子命令族 6 | 10.1 首表行数 |
 * | 亮点 25 | `#### 亮点` 标题数 |
 * | 第 5 章 11 节 | `### 5.` 标题数 |
 * | `NOTICE` 13 章 | `NOTICE` 顶层「一、二、…」编号章数 |
 * | 产物校验 11 项 | 15.6 表行数 |
 *
 * ## 为什么单独成文件而不塞进 doc-counts.mjs
 *
 * `doc-counts.mjs` 守的是 12.1 的测试计数（7 个模块 + 合计），
 * 本文件守的是附录 C 的 8 个文档事实。两者的真源完全不同（前者是
 * 测试跑出来的数字，后者是代码常量与文档结构），失败时的修复动作也不同。
 * 混在一个函数里，报错会分不清「该改测试还是该改表」。
 *
 * 两者共用同一个入口：`doc-counts.mjs --check` 跑 12.1，
 * `doc-counts.mjs --appendix` 跑本文件。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 8 个事实的键名。顺序即报错顺序，与附录 C 的条目顺序一致。 */
export const FACT_KEYS = [
  'configKeys',
  'envVars',
  'extTools',
  'subcommandFamilies',
  'highlights',
  'chapter5Sections',
  'noticeChapters',
  'artifactChecks',
]

/** 每个事实在附录 C 里对应哪一条，用于报错时指路。 */
const FACT_LABEL = {
  configKeys: '配置项数',
  envVars: '环境变量数',
  extTools: '外部工具数',
  subcommandFamilies: '子命令族数',
  highlights: '亮点条数',
  chapter5Sections: '第 5 章节数',
  noticeChapters: 'NOTICE 章数',
  artifactChecks: '产物校验项数',
}

const ZH_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

const EN_ONES = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
}
const EN_TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }

/**
 * 解析英文数字词（`one` .. `ninety-nine`）。
 *
 * 英文版把「二十五条亮点」「十节」「十三节」写成 `twenty-five` /
 * `eleven` / `thirteen`，与中文版的汉字数字是同一类写法。数字与词都接受，
 * 这样有人把 `twenty-five` 改成 `25` 也不会被当成「取不到」。
 *
 * @param {string} text
 * @returns {number|null}
 */
export function parseEnNumber(text) {
  const normalized = String(text).trim().toLowerCase()
  if (/^\d+$/u.test(normalized)) return Number(normalized)
  if (EN_ONES[normalized] !== undefined) return EN_ONES[normalized]
  // 单独的十位词：`twenty` / `thirty`（「二十条亮点」写成 `twenty highlights` 时）
  if (EN_TENS[normalized] !== undefined) return EN_TENS[normalized]
  const hyphen = /^([a-z]+)-([a-z]+)$/u.exec(normalized)
  if (hyphen === null) return null
  const tens = EN_TENS[hyphen[1]]
  const ones = EN_ONES[hyphen[2]]
  if (tens === undefined || ones === undefined || ones > 9) return null
  return tens + ones
}

/**
 * 解析中文数字（一 .. 九十九）。
 *
 * 只支持到两位，够用：附录 C 最大是「二十五」，`NOTICE` 最大是「十三」。
 * 解析不了返回 null 而不是 0 —— 回退到 0 会让「写成阿拉伯数字」这类
 * 改动被当成「对得上」，正是本仓库反复踩的坑。
 *
 * @param {string} text
 * @returns {number|null}
 */
export function parseZhNumber(text) {
  if (typeof text !== 'string' || !/^[一二三四五六七八九十]+$/u.test(text)) return null
  const parts = text.split('十')
  if (parts.length === 1) return ZH_DIGITS[parts[0]] ?? null
  if (parts.length > 2) return null
  const tens = parts[0] === '' ? 1 : ZH_DIGITS[parts[0]]
  const ones = parts[1] === '' ? 0 : ZH_DIGITS[parts[1]]
  if (tens === undefined || ones === undefined) return null
  return tens * 10 + ones
}

/**
 * 取某一节（`## 标题` 开头）的正文，到下一个 `## ` 或文件结束。
 *
 * @param {string} text
 * @param {RegExp} heading
 * @returns {string|null} 找不到返回 null，由调用方判为「缺附录 C」而不是通过
 */
export function sectionOf(text, heading) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => heading.test(line))
  if (start === -1) return null
  const body = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) break
    body.push(lines[i])
  }
  return body.join('\n')
}

/**
 * 数一份文档里各表格的数据行（跳过表头与 `|---|` 分隔行）。
 *
 * 按「连续管道行成一块」分组，返回每块的行数 —— 因为同一节里常有两张表
 * （9.2 后面紧跟一张「校验项」表、10.1 后面紧跟一张「spike 退出码」表），
 * 合并计数会把 37 数成 45。
 *
 * @param {string} text
 * @returns {number[]}
 */
export function tableRowCounts(text) {
  const blocks = []
  let current = []
  for (const line of text.split('\n')) {
    if (line.startsWith('|')) {
      current.push(line)
    } else if (current.length > 0) {
      blocks.push(current)
      current = []
    }
  }
  if (current.length > 0) blocks.push(current)
  return blocks.map((block) => block.filter((line) => !/^\|[\s:|-]+\|$/u.test(line)).length - 1)
}

/** 数 `NOTICE` 的顶层编号章数（`## 一、`…`## 十三、`，「一之一」不计）。 */
export function noticeChapterCount(text) {
  const numbers = []
  for (const line of text.split('\n')) {
    const match = /^## ([一二三四五六七八九十]+)、/u.exec(line)
    if (match === null) continue
    const value = parseZhNumber(match[1])
    if (value !== null) numbers.push(value)
  }
  // 要求从 1 起连续 —— 跳号的编号会让「十三节」这种说法失去意义
  const sorted = [...new Set(numbers)].sort((a, b) => a - b)
  let contiguous = 0
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i] !== i + 1) break
    contiguous = sorted[i]
  }
  return { count: numbers.length, contiguous }
}

/**
 * 从代码里读 `DEFAULTS` 的键数。
 *
 * 导入而不是数源码文本：`DEFAULTS` 里有嵌套对象与数组，正则数不准。
 * 导入失败必须报错 —— 静默跳过等于把「配置项数」这一条守卫关掉。
 *
 * @param {string} root
 * @returns {Promise<{keys: number}|{error: string}>}
 */
async function readDefaultsKeys(root) {
  const path = join(root, 'mac2win', 'src', 'core', 'config.mjs')
  if (!existsSync(path)) {
    return { error: `找不到 ${path}，无法核对配置项数` }
  }
  try {
    const module = await import(pathToFileURL(path).href)
    const defaults = module.DEFAULTS
    if (defaults === null || typeof defaults !== 'object') {
      return { error: `${path} 没有导出 DEFAULTS 对象` }
    }
    return { keys: Object.keys(defaults).length }
  } catch (error) {
    return { error: `导入 ${path} 失败：${error.message}` }
  }
}

/**
 * 从文档里算出一组事实（每个都带真源说明，便于报错时指路）。
 *
 * @param {{zh: string, en: string, notice: string}} docs
 * @param {number|null} defaultsKeys
 * @returns {Record<string, {actual: number, source: string}>}
 */
function collectFacts(docs, defaultsKeys) {
  const zh = docs.zh
  const rowsIn = (heading, next, block = 0) => {
    const body = sectionOf(zh, heading)
    if (body === null) return null
    const section = next === null ? body : body.split(next)[0]
    const counts = tableRowCounts(section)
    return counts[block] ?? null
  }

  const facts = {}

  // 配置项：优先用代码常量，表格行数只作交叉验证
  const configRows = rowsIn(/^### 9\.2/u, '### 9.3')
  facts.configKeys = defaultsKeys === null
    ? { actual: configRows, source: '9.2 表行数（代码常量不可读）' }
    : { actual: defaultsKeys, source: '`config.mjs` 的 `DEFAULTS` 键数' }

  facts.envVars = { actual: rowsIn(/^### 9\.3/u, '### 9.4'), source: '9.3 表行数' }
  facts.extTools = { actual: rowsIn(/^### 6\.2/u, '### 6.3'), source: '6.2 表行数' }
  facts.subcommandFamilies = { actual: rowsIn(/^### 10\.1/u, '### 10.2'), source: '10.1 首表行数' }
  facts.highlights = {
    actual: (zh.match(/^#### 亮点/gmu) ?? []).length,
    source: '`#### 亮点` 标题数',
  }
  facts.chapter5Sections = {
    actual: (zh.match(/^### 5\./gmu) ?? []).length,
    source: '`### 5.` 标题数',
  }
  facts.noticeChapters = {
    actual: noticeChapterCount(docs.notice).count,
    source: '`NOTICE` 顶层编号章数',
  }
  facts.artifactChecks = { actual: rowsIn(/^### 15\.6/u, '### 15.7'), source: '15.6 表行数' }

  // 交叉验证用：6.2 与 NOTICE 第三章必须是同一个数（两处各写一份清单）
  facts.extToolsNotice = {
    actual: (() => {
      const body = sectionOf(docs.notice, /^## 三、/u)
      if (body === null) return null
      const section = body.split('## 四、')[0]
      return tableRowCounts(section)[0] ?? null
    })(),
    source: '`NOTICE` 第三章表行数',
  }
  facts.configRows = { actual: configRows, source: '9.2 首表行数' }

  return facts
}

/**
 * 从附录 C 里读出各条声明的数字。
 *
 * 正则锚在「数字 + 单位 + 节号」上，所以文档里别处出现的同形数字不会被误取。
 * 任何一条取不到都记为「无法解析」并让检查失败 —— 这比默默跳过安全，
 * 因为附录 C 的措辞一变，守卫就该提醒人去同步正则，而不是假装无事。
 *
 * @param {string} body 附录 C 的正文
 * @param {'zh'|'en'} lang
 * @returns {{claims: Record<string, number>, missing: string[]}}
 */
export function parseClaims(body, lang) {
  const claims = {}
  const missing = []

  /**
   * @param {string} key
   * @param {RegExp} pattern
   * @param {(match: RegExpExecArray) => number|null} [pick]
   */
  const take = (key, pattern, pick) => {
    const match = pattern.exec(body)
    if (match === null) {
      missing.push(key)
      return
    }
    const value = pick === undefined ? Number(match[1]) : pick(match)
    if (!Number.isFinite(value)) {
      missing.push(key)
      return
    }
    claims[key] = value
  }

  if (lang === 'zh') {
    take('configKeys', /(\d+) 个配置项全表（9\.2）/u)
    take('envVars', /(\d+) 个环境变量全表（9\.3）/u)
    take('extTools', /(\d+) 项外部工具七要素表（6\.2）/u)
    take('subcommandFamilies', /(\d+) 个子命令族（10\.1）/u)
    take('highlights', /([一二三四五六七八九十]+)条亮点/u, (m) => parseZhNumber(m[1]))
    take('chapter5Sections', /第 5 章 (\d+) 节/u)
    take('noticeChapters', /`NOTICE` ([一二三四五六七八九十]+)节/u, (m) => parseZhNumber(m[1]))
    take('artifactChecks', /校验项数（15\.6）按实测 (\d+) 项/u)
  } else {
    take('configKeys', /(\d+) configuration keys \(9\.2\)/u)
    take('envVars', /(\d+) environment variables \(9\.3\)/u)
    take('extTools', /(\d+) external tools[^(]*\(6\.2\)/u)
    take('subcommandFamilies', /(\d+) subcommand families \(10\.1\)/u)
    take('highlights', /All ([\w-]+) highlights/u, (m) => parseEnNumber(m[1]))
    take('chapter5Sections', /Chapter 5, ([\w-]+) sections/u, (m) => parseEnNumber(m[1]))
    take('noticeChapters', /the ([\w-]+) sections of `?NOTICE`?/u, (m) => parseEnNumber(m[1]))
    take('artifactChecks', /check counts \(15\.6\) distinguish the measured (\d+)/u)
  }

  return { claims, missing }
}

/**
 * 跑完整检查。
 *
 * @param {string} root 仓库根目录
 * @returns {Promise<string[]>} 问题清单；空数组表示全部对得上
 */
export async function checkAppendix(root) {
  const problems = []

  const read = (name) => {
    const path = join(root, name)
    if (!existsSync(path)) {
      problems.push(`找不到 ${name}`)
      return ''
    }
    return readFileSync(path, 'utf8')
  }

  const docs = {
    zh: read('README.md'),
    en: read('README_EN.md'),
    notice: read('NOTICE'),
  }

  const zhBody = sectionOf(docs.zh, /^## 附录 C/u)
  const enBody = sectionOf(docs.en, /^## Appendix C/u)
  if (zhBody === null) problems.push('README.md 找不到「附录 C」一节')
  if (enBody === null) problems.push('README_EN.md 找不到「Appendix C」一节')
  if (zhBody === null || enBody === null) return problems

  const zhParse = parseClaims(zhBody, 'zh')
  const enParse = parseClaims(enBody, 'en')
  for (const key of zhParse.missing) {
    problems.push(`README.md 附录 C 取不到${FACT_LABEL[key]}，措辞变了就要同步 appendix-guard.mjs 的正则`)
  }
  for (const key of enParse.missing) {
    problems.push(`README_EN.md Appendix C 取不到${FACT_LABEL[key]}（同上）`)
  }

  const defaults = await readDefaultsKeys(root)
  if (defaults.error !== undefined) problems.push(defaults.error)
  const facts = collectFacts(docs, defaults.error === undefined ? defaults.keys : null)

  // 1) 每个声明数字 vs 真源
  for (const key of FACT_KEYS) {
    const claimed = zhParse.claims[key]
    const fact = facts[key]
    if (claimed === undefined || fact.actual === null) {
      if (claim === undefined) {}
      if (fact.actual === null) problems.push(`算不出${FACT_LABEL[key]}的真源（${fact.source} 不存在）`)
      continue
    }
    if (claimed !== fact.actual) {
      problems.push(`附录 C 写 ${claimed} ${FACT_LABEL[key]}，实际 ${fact.actual}（${fact.source}）`)
    }
  }

  // 2) 代码常量与文档表格必须一致 —— 两处各存一份，谁也别说自己对
  if (facts.configKeys.actual !== null && facts.configRows.actual !== null
    && facts.configKeys.actual !== facts.configRows.actual) {
    problems.push(
      `9.2 表有 ${facts.configRows.actual} 行，而 DEFAULTS 有 ${facts.configKeys.actual} 键 —— 两张清单需要同步`,
    )
  }
  if (facts.extTools.actual !== null && facts.extToolsNotice.actual !== null
    && facts.extTools.actual !== facts.extToolsNotice.actual) {
    problems.push(
      `6.2 表有 ${facts.extTools.actual} 行，而 NOTICE 第三章有 ${facts.extToolsNotice.actual} 行 —— 两张清单需要同步`,
    )
  }

  // 3) NOTICE 章号必须从 1 起连续，「十三节」这种说法才有意义
  const notice = noticeChapterCount(docs.notice)
  if (notice.contiguous !== notice.count) {
    problems.push(`NOTICE 章号不连续：从 1 起只连续到 ${notice.contiguous}，共 ${notice.count} 章`)
  }

  // 4) 两版逐项相同
  for (const key of FACT_KEYS) {
    const inZh = zhParse.claims[key]
    const inEn = enParse.claims[key]
    if (inZh === undefined || inEn === undefined) continue
    if (inZh !== inEn) {
      problems.push(`附录 C 两版不一致：${FACT_LABEL[key]} 中文版 ${inZh}，英文版 ${inEn}`)
    }
  }

  return problems
}
