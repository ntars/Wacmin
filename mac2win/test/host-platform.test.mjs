/**
 * 宿主环境分支的测试（W-05 跨平台可运行性巡检产物）。
 *
 * ## 这一组守的是什么
 *
 * `checkHost` 有两条分支在本机永远走不到：本机是 darwin + arm64，
 * 所以「非 macOS / 非 arm64」这两条判断从来没有被真正执行过。
 * 而它们恰恰是**用户最可能撞上的那条**：在 Linux CI 或 Intel mac 上
 * 跑 `mac2win build`。
 *
 * 走错的后果不是崩溃，是**报错指向错误的方向**：
 *
 * | 实际情形 | 错误的话 | 用户去做什么 |
 * |---|---|---|
 * | 在 Linux 上跑 | 「项目目录不存在」 | 查路径拼写、权限、软链 |
 * | 正确 | 「当前是 linux，本工具只支持 macOS」 | 换机器 |
 *
 * 这正是 `preflight-error-codes.test.mjs` 里记录的 `host-os` / `host-platform`
 * 键名不一致缺陷的同一片土壤 —— 那一轮修了「归码」，但分支本身仍然
 * 没被跑过。这一组把它补上：直接调 `checkHost` 并注入平台，断言结论。
 *
 * ## 为什么注入而不是 mock 模块
 *
 * `node:os` 的 `platform()` 无法在 ESM 里可靠地替换（模块命名空间是
 * 只读的）。把平台作为参数传进来，比任何 mock 手段都直白，也让
 * 生产代码的意图更清楚：这个函数的结论**只取决于入参**。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { Check, PreflightReport, checkHost } from '../src/core/preflight.mjs'
import { ErrorCode } from '../src/core/errors.mjs'
import { preflightToError } from '../src/core/preflight.mjs'

/** 跑一次 checkHost，把结果按 id 索引。 */
function runHost(host) {
  const report = new PreflightReport()
  checkHost(report, host)
  return report
}

/** 按 id 取一条检查项。 */
function pick(report, id) {
  return report.checks.find((check) => check.id === id)
}

describe('宿主平台分支', () => {
  test('darwin + arm64：平台与架构都通过，且不报 arch 警告', () => {
    const report = runHost({ platform: 'darwin', arch: 'arm64' })

    const platformCheck = pick(report, 'host-platform')
    assert.equal(platformCheck.status, 'pass', `实际 ${platformCheck.status}`)
    assert.match(platformCheck.detail, /macOS/u)

    const archCheck = pick(report, 'host-arch')
    assert.equal(archCheck.status, 'pass', `实际 ${archCheck.status}`)
    assert.match(archCheck.detail, /arm64/u)
  })

  test('linux：platform 判 fail 且说清是宿主问题，不是路径问题', () => {
    /*
     * 这是本组的核心断言。在 Linux 上跑时，第一条失败的检查项必须
     * 是 host-platform，且文案里要出现「只支持 macOS」——
     * 不能是「项目目录不存在」。
     */
    const report = runHost({ platform: 'linux', arch: 'x64' })

    const platformCheck = pick(report, 'host-platform')
    assert.equal(platformCheck.status, 'fail', `实际 ${platformCheck.status}`)
    assert.match(platformCheck.detail, /linux/u, '文案里应点出当前平台')
    assert.match(platformCheck.detail, /只支持 macOS/u, '应说明工具的平台前提')
    assert.ok(platformCheck.hint && platformCheck.hint.length > 0, '必须给出下一步')

    /*
     * 非 darwin 时 checkHost 提前 return，不再查架构 ——
     * 平台都不对，架构结论没有意义。这条防止有人后续加检查时
     * 把 arch 也塞进来，出现「平台不支持下还报架构警告」的噪声。
     */
    assert.equal(pick(report, 'host-arch'), undefined,
      '平台已判 fail 时不应再报架构检查项')
  })

  test('win32：同样判 fail，文案里是当前平台名', () => {
    const report = runHost({ platform: 'win32', arch: 'x64' })
    const platformCheck = pick(report, 'host-platform')
    assert.equal(platformCheck.status, 'fail')
    assert.match(platformCheck.detail, /win32/u)
  })

  test('darwin + x64（Intel mac）：warn 而不是 fail', () => {
    /*
     * Intel mac 上功能本身成立，只是核心卖点（arm 上产出 x86）
     * 没有意义。给警告而不是错误 —— 误判成 fail 会把能用的机器拦在门外。
     */
    const report = runHost({ platform: 'darwin', arch: 'x64' })

    assert.equal(pick(report, 'host-platform').status, 'pass',
      'Intel mac 的平台仍应通过')

    const archCheck = pick(report, 'host-arch')
    assert.equal(archCheck.status, 'warn', `实际 ${archCheck.status}`)
    assert.match(archCheck.detail, /x64/u)
    assert.ok(archCheck.hint && archCheck.hint.length > 0, '警告也要给下一步')
  })
})

describe('宿主分支与错误码的对应', () => {
  test('linux 上首个失败项归 UNSUPPORTED（1005），走退出码 4', () => {
    /*
     * 「宿主不支持」是明确不支持，不是参数错误。
     * 契约：exit 4 → 1005；exit 2 → 1002/1003/1004。
     *
     * 早先映射表写的是 `host-os`（不存在的 id），于是静默落进
     * 「项目目录不存在」兜底报 1002 —— 用户会去查路径。
     * 这条端到端守住「checkHost 真的产出了 host-platform 这个 id」。
     */
    const report = runHost({ platform: 'linux', arch: 'x64' })
    const error = preflightToError(report)

    assert.equal(error.code, ErrorCode.UNSUPPORTED,
      `宿主不支持应报 ${ErrorCode.UNSUPPORTED}，实际 ${error.code}`)
    assert.match(error.code, /_1005$/u)
  })

  test('Intel mac 的 warn 不会让预检失败', () => {
    /*
     * 有 warn 无 fail 时 preflightToError 不该被调用；这里直接断言
     * 报告里有 fail 项的判断依据，避免「有警告就中止」的矫枉过正。
     */
    const report = runHost({ platform: 'darwin', arch: 'x64' })
    const failures = report.checks.filter((check) => check.status === 'fail')
    assert.deepEqual(failures.map((check) => check.id), [],
      `Intel mac 不该有 fail 项，实际：${failures.map((c) => c.id).join(', ')}`)
  })
})

describe('checkHost 是公开能力而不是私有实现', () => {
  test('导出的是函数，可直接调用', () => {
    /*
     * 注入能力只有配上「真的能被外部调用」才有意义。
     * 若将来有人把它改回不导出，这条立刻红 —— 而不是等到
     * 别的测试 import 失败才发现。
     */
    assert.equal(typeof checkHost, 'function')
    const report = new PreflightReport()
    checkHost(report, { platform: 'darwin', arch: 'arm64' })
    assert.ok(report.checks.length >= 2, '应至少产出平台与架构两条检查项')
    for (const check of report.checks) {
      assert.ok(check instanceof Check)
    }
  })
})
