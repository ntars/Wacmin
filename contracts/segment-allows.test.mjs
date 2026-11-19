/**
 * `segmentAllows` 的测试：退出码对错误码的区间判定。
 *
 * ## 这一组修的是一个「一直看起来是对的」缺陷
 *
 * `validate.mjs` 原来用 `String(errorSegment).split(/[/-]/)` 解析契约：
 * 列举写法（`"1003/1004"`）与单值写法（`"9999"`）碰巧都能过，但**范围
 * 写法会被切成两个端点**：
 *
 *      "4001-5002".split(/[/-]/)  →  ["4001", "5002"]
 *
 * 于是 `M2W_4002` 既不等于 `4001` 也不等于 `5002`，被判成「退出码与
 * 错误码不一致」。实测确认：造一份 `exitCode: 6` 配 `M2W_4002` 的报告，
 * 校验器报红，而 4002 完全合法。
 *
 * ## 为什么此前没人发现
 *
 * 真实报告里命中的多是**端点值**：`4001`（构建失败）和 `5002`（装配失败）
 * 用得最多，`4002` / `4003` 少见。端点恰好是切分后的两个字符串，
 * 所以校验器看起来一直是好的 —— 直到有一份报告真的给出中值。
 *
 * 这正是本仓库反复踩的那类坑：**缺陷在常见输入上不留痕迹**。
 * 所以下面不只测「4002 能过」，而是把三种写法、边界值与越界值都列出来。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { segmentAllows } from './validate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

describe('列举写法', () => {
  test('列出的值通过', () => {
    for (const tail of ['1002', '1003', '1004']) {
      assert.equal(segmentAllows('1002/1003/1004', tail), true, `${tail} 应通过`)
    }
  })

  test('未列出的值不通过', () => {
    for (const tail of ['1001', '1005', '2001']) {
      assert.equal(segmentAllows('1002/1003/1004', tail), false, `${tail} 不该通过`)
    }
  })
})

describe('范围写法', () => {
  test('端点通过', () => {
    assert.equal(segmentAllows('4001-5002', '4001'), true)
    assert.equal(segmentAllows('4001-5002', '5002'), true)
  })

  test('范围内的中值通过 —— 这是修复前会误判的那一类', () => {
    /*
     * 修复前 `split(/[/-]/)` 把 "4001-5002" 切成 ['4001','5002']，
     * 所以下面每一个断言都会是 false。真实受影响的码：
     * M2W_4002（产物缺失）、M2W_4003（原生模块）、M2W_5001（脚本生成失败）。
     */
    for (const tail of ['4002', '4003', '4500', '5001']) {
      assert.equal(segmentAllows('4001-5002', tail), true, `${tail} 在范围内应通过`)
    }
  })

  test('范围外不通过', () => {
    for (const tail of ['4000', '5003', '3001', '6001']) {
      assert.equal(segmentAllows('4001-5002', tail), false, `${tail} 在范围外不该通过`)
    }
  })

  test('单值范围（起止相同）也能判', () => {
    assert.equal(segmentAllows('6001-6001', '6001'), true)
    assert.equal(segmentAllows('6001-6001', '6002'), false)
  })
})

describe('单值写法', () => {
  test('相等即通过', () => {
    assert.equal(segmentAllows('9999', '9999'), true)
  })

  test('不等不通过', () => {
    assert.equal(segmentAllows('9999', '9001'), false)
    assert.equal(segmentAllows('9999', '9998'), false)
  })
})

describe('容错', () => {
  test('空串与纯空白不通过，且不抛错', () => {
    assert.equal(segmentAllows('', '1002'), false)
    assert.equal(segmentAllows('   ', '1002'), false)
    assert.equal(segmentAllows('1002/1003', ''), false)
  })

  test('列举与范围混写时两者都生效', () => {
    /*
     * 契约里目前没有这种写法，但 `split('/')` 天然支持。
     * 这条守住「不许因为只考虑单一形态而把混写判死」。
     */
    assert.equal(segmentAllows('7001/9001-9002', '9002'), true)
    assert.equal(segmentAllows('7001/9001-9002', '7001'), true)
    assert.equal(segmentAllows('7001/9001-9002', '9003'), false)
  })
})

describe('与真实契约对账', () => {
  const contract = JSON.parse(readFileSync(join(HERE, 'exit-codes.json'), 'utf8'))

  test('契约里声明的每条 errorSegment 都能被解析', () => {
    /*
     * 拿真实契约跑一遍，确保新增写法不会静默失效。
     * 若将来出现「a-b/c」这类嵌套写法，这条会红。
     */
    for (const [exit, entry] of Object.entries(contract.codes)) {
      if (entry.errorSegment === null) continue
      const first = String(entry.errorSegment).split('/')[0].split('-')[0]
      assert.equal(segmentAllows(entry.errorSegment, first), true,
        `退出码 ${exit} 的 errorSegment "${entry.errorSegment}" 解析不出首值 ${first}`)
    }
  })

  test('契约的 6 与 7 各自接受本段的全部码', () => {
    /*
     * 这两条是范围写法的真实使用者，也是修复前唯一会误判的地方
     * （如果真有报告给出中值的话）。
     */
    const six = contract.codes['6'].errorSegment
    for (const tail of ['4001', '4002', '4003', '5001', '5002']) {
      assert.equal(segmentAllows(six, tail), true, `exit 6 应接受 ${tail}`)
    }
    const seven = contract.codes['7'].errorSegment
    for (const tail of ['6001', '6002', '6003']) {
      assert.equal(segmentAllows(seven, tail), true, `exit 7 应接受 ${tail}`)
    }
  })
})
