/**
 * 预检错误码映射表的完整性测试。
 *
 * ## 这一组守的是什么
 *
 * `preflightToError` 用一张 `CHECK_ERROR_CODES` 表把「哪个检查项失败」翻译成
 * 「哪个错误码」。键名必须与本文件里 `new Check()` 的第一个参数逐字一致。
 *
 * 键名写错**不会报错**，只会静默落进 `?? PROJECT_NOT_FOUND` 兜底。于是这张表
 * 号称「按检查项归类」，实际退化成「几乎全都归到 1002」。
 *
 * 真实发生过的缺陷（本轮核对时发现，不是假设）：
 *
 * | 表里写的键 | 实际用的 id | 用户看到的 |
 * |---|---|---|
 * | `host-os` | `host-platform` | 在 Linux 上构建报「项目目录不存在」 |
 * | `native-window` | `framework-shell` | Tauri 无原生壳被报成路径问题 |
 *
 * 用户的损失很具体：在非 macOS 上跑 `build`，得到「项目目录不存在：
 * /path/to/real/project」——路径完全没问题，他会去查拼写、查权限、查软链，
 * 而真正该做的是换一台 Mac。退出码也从 4（明确不支持）错成 2（参数错误），
 * 自动化会误以为重试有意义。
 *
 * ## 为什么用源码扫描而不是逐个构造报告
 *
 * 逐个构造要覆盖全部 16 个检查项，且新增检查项时测试不会提醒你。
 * 扫描源码能直接拿到「实际用过哪些 id」，与映射表的键做集合比对 ——
 * 加新检查项时若忘了归码，这里立刻报红。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  Check,
  PreflightReport,
  preflightToError,
} from '../src/core/preflight.mjs'
import { ErrorCode } from '../src/core/errors.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'src', 'core', 'preflight.mjs'), 'utf8')

/**
 * 从源码里提取「会 fail 的检查项 id」。
 *
 * 匹配 `new Check(` 之后的第一个字符串字面量，且同一段里出现 `'fail'`。
 * `new Check(` 的参数可能跨行，所以用 `[\s\S]` 而不是 `.`。
 *
 * @returns {Set<string>}
 */
function failingCheckIds() {
  const ids = new Set()
  const pattern = /new Check\(\s*\n?\s*'([a-z-]+)'[\s\S]{0,120}?'fail'/g
  let match = pattern.exec(SOURCE)
  while (match !== null) {
    ids.add(match[1])
    match = pattern.exec(SOURCE)
  }
  return ids
}

/**
 * 从源码里提取映射表的全部键。
 *
 * @returns {Set<string>}
 */
function mappedIds() {
  const block = /const CHECK_ERROR_CODES = \{([\s\S]*?)\n\}/.exec(SOURCE)
  assert.notEqual(block, null, '找不到 CHECK_ERROR_CODES 定义，测试需同步更新')

  const keys = new Set()
  const pattern = /^\s*'([a-z-]+)':/gm
  let match = pattern.exec(block[1])
  while (match !== null) {
    keys.add(match[1])
    match = pattern.exec(block[1])
  }
  return keys
}

test('映射表里没有指错人的键', () => {
  /*
   * 反向断言：表里出现的每个键，源码里必须真的用过它。
   *
   * 「用过的 id 都在表里」可以由兜底掩盖，但「表里的键对应的 id 存在」
   * 无法掩盖 —— 一个不存在的键等于这行代码从未生效。
   */
  const used = new Set()
  const pattern = /new Check\(\s*\n?\s*'([a-z-]+)'/g
  let match = pattern.exec(SOURCE)
  while (match !== null) {
    used.add(match[1])
    match = pattern.exec(SOURCE)
  }

  const orphans = [...mappedIds()].filter((id) => !used.has(id))
  assert.deepEqual(
    orphans,
    [],
    `映射表里这些键对应的检查项根本不存在，写了等于没写：${orphans.join('、')}`,
  )
})

test('每个可能 fail 的检查项都有明确的错误码', () => {
  /*
   * 正向断言：会 fail 的检查项必须显式归码。
   *
   * 允许的例外只有三个，理由写在 CHECK_ERROR_CODES 的注释里：
   * `framework` 失败时无法判断用户该做什么，走兜底是当时的合理选择。
   *
   * 其余两个（`windows-filenames` / `target-format`）只会 pass 或 warn，
   * 不会出现在这里 —— 若它们真的开始 fail，这里会报红提醒补归码。
   */
  const allowedFallback = new Set(['framework'])
  const missing = [...failingCheckIds()]
    .filter((id) => !mappedIds().has(id))
    .filter((id) => !allowedFallback.has(id))

  assert.deepEqual(
    missing,
    [],
    `这些检查项会 fail 但没有归码，会静默落进「项目目录不存在」的兜底：${missing.join('、')}`,
  )
})

test('宿主不支持报 1005 而不是 1002', () => {
  /*
   * 这条是本轮修掉的真实缺陷的回归测试。
   *
   * 在 Linux / Windows 上跑 build，首个失败项是 `host-platform`。
   * 修复前映射表里写的是 `host-os`（不存在），于是走兜底报 M2W_1002
   * 「项目目录不存在」——用户会去查路径，而真实原因是他不该在这台机器上跑。
   */
  const report = new PreflightReport()
  report.add(new Check('host-platform', '宿主操作系统', 'fail', '当前是 linux，本工具只支持 macOS', '在 macOS 上运行'))

  const error = preflightToError(report)
  assert.equal(
    error.code,
    ErrorCode.UNSUPPORTED,
    `宿主不支持应报 ${ErrorCode.UNSUPPORTED}（明确不支持），实际 ${error.code}`,
  )
})

test('原生窗口缺失报 1005 而不是 1002', () => {
  const report = new PreflightReport()
  report.add(new Check('framework-shell', '原生窗口', 'fail', '不含原生窗口', '换框架'))

  const error = preflightToError(report)
  assert.equal(error.code, ErrorCode.UNSUPPORTED, `实际 ${error.code}`)
})

test('项目路径不存在仍报 1002', () => {
  /*
   * 修映射表时容易矫枉过正：把全都改成 1005 就没人报 1002 了。
   * 这条守住真正该报 1002 的情形。
   */
  const report = new PreflightReport()
  report.add(new Check('project-root', '项目目录', 'fail', '不存在：/tmp/nope'))

  const error = preflightToError(report)
  assert.equal(error.code, ErrorCode.PROJECT_NOT_FOUND, `实际 ${error.code}`)
})

test('缺 makensis 优先报 2001，压过其它失败项', () => {
  /*
   * 缺工具是最常见的失败，且搜 M2W_2001 就能直接搜到安装命令。
   * 这条优先级是刻意的，不能被「取第一个失败项」的规则盖掉。
   */
  const report = new PreflightReport()
  report.add(new Check('project-root', '项目目录', 'fail', '不存在：/tmp/nope'))
  report.add(new Check('makensis', 'NSIS 编译器', 'fail', '未安装（brew install makensis）'))

  const error = preflightToError(report)
  assert.equal(error.code, ErrorCode.TOOL_MISSING, `实际 ${error.code}`)
})
