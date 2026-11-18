/**
 * 协议编解码测试。
 *
 * ## 为什么这部分要测这么细
 *
 * 分帧与错误码是「自测时看起来正常、接真实客户端就全坏」的典型区域：
 * 自己发自己收永远对得上，因为两边用同一套（错误的）假设。所以这里
 * 刻意用**规范原文**当断言依据，而不是「我的实现对不对」。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  ERROR_CODES,
  LineDecoder,
  encodeMessage,
  isValidId,
  parseLine,
  rpcError,
  rpcResult,
} from '../src/protocol.mjs'

describe('分帧：换行分隔', () => {
  test('一条消息一次到达', () => {
    const decoder = new LineDecoder()
    const lines = decoder.push('{"a":1}\n')
    assert.deepEqual(lines, ['{"a":1}'])
  })

  test('多条消息一次到达时全部切出', () => {
    const decoder = new LineDecoder()
    const lines = decoder.push('{"a":1}\n{"b":2}\n{"c":3}\n')
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}'])
  })

  test('消息跨两次到达时暂不吐出半条', () => {
    /*
     * 这是最常见的真实情况：TCP 之类会把一条消息切两半。对半条做
     * JSON.parse 必然失败，所以必须缓冲到完整行才解析。
     */
    const decoder = new LineDecoder()
    assert.deepEqual(decoder.push('{"a":'), [])
    assert.deepEqual(decoder.push('1}\n'), ['{"a":1}'])
  })

  test('一行被切成三块也能拼回', () => {
    const decoder = new LineDecoder()
    const pieces = ['{"met', 'hod":"pi', 'ng"}\n']
    const lines = pieces.flatMap((piece) => decoder.push(piece))
    assert.deepEqual(lines, ['{"method":"ping"}'])
  })

  test('CRLF 行尾被剥离', () => {
    // Windows 客户端可能发 \r\n。\r 留在 JSON 尾部会让解析失败。
    const decoder = new LineDecoder()
    assert.deepEqual(decoder.push('{"a":1}\r\n'), ['{"a":1}'])
  })

  test('空行被保留为空字符串而不是丢弃', () => {
    /*
     * 空行的处置交给 parseLine（回 PARSE_ERROR）。这里若悄悄过滤掉，
     * 协议层就少了一次可观测的事件 —— 客户端发空行时我们会毫无反应，
     * 而它期待一个错误。
     */
    const decoder = new LineDecoder()
    assert.deepEqual(decoder.push('\n'), [''])
  })

  test('flush 吐出没有结尾换行的最后一行', () => {
    const decoder = new LineDecoder()
    decoder.push('{"a":1}')
    assert.deepEqual(decoder.flush(), ['{"a":1}'])
  })

  test('flush 之后不再重复吐出', () => {
    const decoder = new LineDecoder()
    decoder.push('{"a":1}')
    decoder.flush()
    assert.deepEqual(decoder.flush(), [])
  })

  test('空缓冲 flush 返回空数组', () => {
    const decoder = new LineDecoder()
    assert.deepEqual(decoder.flush(), [])
  })
})

describe('分帧：UTF-8 跨块', () => {
  test('中文字符被切在块边界时不会变成替换字符', () => {
    /*
     * 「中」的 UTF-8 是 E4 B8 AD 三个字节。若在第二个字节处切断并用
     * `chunk.toString()`，前半个会变成 U+FFFD，且**无法挽回** ——
     * 表现为偶发的「报告里中文变成问号」，只在特定分包下复现。
     */
    const decoder = new LineDecoder()
    const full = Buffer.from('{"msg":"中文测试"}\n', 'utf8')
    const cut = 9 // 切在「中」的字节中间
    const lines = [
      ...decoder.push(full.subarray(0, cut)),
      ...decoder.push(full.subarray(cut)),
    ]
    assert.equal(lines.length, 1)
    assert.match(lines[0], /中文测试/u)
    assert.ok(!lines[0].includes('\uFFFD'), '不应该出现替换字符')
  })

  test('逐字节喂整条消息也能还原', () => {
    const decoder = new LineDecoder()
    const full = Buffer.from('{"名字":"空谷 Ondra"}\n', 'utf8')
    const lines = []
    for (const byte of full) {
      lines.push(...decoder.push(new Uint8Array([byte])))
    }
    assert.deepEqual(lines, ['{"名字":"空谷 Ondra"}'])
  })
})

describe('编码', () => {
  test('编码结果以单个换行结尾，不含其他换行', () => {
    const text = encodeMessage({ jsonrpc: '2.0', id: 1, result: { a: 'b\nc' } })
    assert.equal(text.endsWith('\n'), true)
    // 字符串里的 \n 必须被转义成两个字符，而不是裸换行
    assert.equal(text.split('\n').length, 2, '整个输出只应有结尾那一个换行')
  })

  test('字符串里的换行被转义而不是裸露', () => {
    /*
     * 这里原本写的是「含裸换行的输入会被拒绝」，断言抛出异常 —— 但那条
     * 断言**永远不可能通过**（除非实现有 bug）：`JSON.stringify` 会把
     * 字符串值里的换行一律转义成两个字符 `\n`，所以只要不加缩进参数，
     * 输出天然不含裸换行。
     *
     * 这正好说明一件事：`encodeMessage` 里那道 `includes('\n')` 的检查
     * 是**兜底**，不是主防线。主防线是「不传 space 参数」。真正会引入
     * 裸换行的唯一途径就是有人后来给 `JSON.stringify` 加了 `undefined, 2`。
     *
     * 所以这里改为断言真正可测的不变量：不管输入里有什么，编码结果
     * 都只有结尾那一个换行。
     */
    const cases = [
      { text: 'a\nb' },
      { text: 'a\r\nb' },
      { text: '多行\n中文\n内容' },
      { nested: { deep: { text: 'x\ny' } } },
    ]
    for (const result of cases) {
      const text = encodeMessage({ jsonrpc: '2.0', id: 1, result })
      assert.equal(
        text.split('\n').length, 2,
        `编码结果只应有结尾一个换行，实际：${JSON.stringify(text)}`,
      )
      assert.equal(text.includes('\r'), false, '不该出现回车符')
    }
  })

  test('逐条写出时行数与消息数严格一致', () => {
    /*
     * 这是分帧正确性的总体不变量：N 条消息 → N 行。
     *
     * 若哪天有人在 encodeMessage 里加了缩进，这条会立刻报红 ——
     * 而缩进恰恰是最容易被「顺手加上去」的一行代码（为了日志好看）。
     */
    const messages = [
      { jsonrpc: '2.0', id: 1, result: { text: 'a\nb' } },
      { jsonrpc: '2.0', id: 2, result: { text: '多行\n内容' } },
      { jsonrpc: '2.0', id: 3, error: { code: -32601, message: '无' } },
    ]
    const stream = messages.map((message) => encodeMessage(message)).join('')
    const lines = stream.split('\n').filter((line) => line !== '')
    assert.equal(lines.length, messages.length)
    for (const line of lines) {
      assert.doesNotThrow(() => { JSON.parse(line) }, '每一行都应能独立解析')
    }
  })

  test('中文不被转义成 \\u 序列', () => {
    /*
     * 转义后仍然合法，但可读性极差 —— 排查协议问题时看到一屏 \u7a7a\u8c37
     * 会让人放弃读日志。
     */
    const text = encodeMessage({ jsonrpc: '2.0', id: 1, result: { name: '空谷' } })
    assert.match(text, /空谷/u)
    assert.ok(!text.includes('\\u7a7a'), '不应该把中文转义')
  })
})

describe('解析', () => {
  const good = '{"jsonrpc":"2.0","id":1,"method":"ping"}'

  test('合法请求被解析', () => {
    const result = parseLine(good)
    assert.equal(result.ok, true)
    assert.equal(result.message.method, 'ping')
  })

  test('非法 JSON 回 PARSE_ERROR', () => {
    const result = parseLine('{不是 json')
    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.PARSE_ERROR)
  })

  test('空行回 PARSE_ERROR', () => {
    const result = parseLine('   ')
    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.PARSE_ERROR)
  })

  test('数组回 INVALID_REQUEST', () => {
    // 批量请求是 JSON-RPC 的扩展，MCP 不用。明确拒绝比默默当单条处理安全。
    const result = parseLine('[{"jsonrpc":"2.0"}]')
    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.INVALID_REQUEST)
  })

  test('缺 jsonrpc 字段回 INVALID_REQUEST', () => {
    const result = parseLine('{"id":1,"method":"ping"}')
    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.INVALID_REQUEST)
    assert.match(result.message, /jsonrpc/u)
  })

  test('jsonrpc 版本不是 2.0 时拒绝', () => {
    const result = parseLine('{"jsonrpc":"1.0","id":1,"method":"ping"}')
    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.INVALID_REQUEST)
  })

  test('缺 method 字段回 INVALID_REQUEST', () => {
    const result = parseLine('{"jsonrpc":"2.0","id":1}')
    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.INVALID_REQUEST)
    assert.match(result.message, /method/u)
  })

  test('null 回 INVALID_REQUEST', () => {
    const result = parseLine('null')
    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.INVALID_REQUEST)
  })
})

describe('id 合法性', () => {
  test('字符串、数字、null 都是合法 id', () => {
    assert.equal(isValidId('abc'), true)
    assert.equal(isValidId(1), true)
    assert.equal(isValidId(0), true)
    assert.equal(isValidId(-1), true)
    assert.equal(isValidId(null), true)
  })

  test('undefined、布尔、对象、数组都不是合法 id', () => {
    /*
     * undefined 尤其危险：`JSON.stringify({id: undefined})` 会把 id 整个
     * 丢掉，响应于是变成「没有 id 的响应」，客户端只能当通知丢弃 ——
     * 表现为调用无声无息地消失。
     */
    assert.equal(isValidId(undefined), false)
    assert.equal(isValidId(true), false)
    assert.equal(isValidId({}), false)
    assert.equal(isValidId([]), false)
  })

  test('NaN 与 Infinity 不是合法 id', () => {
    // 它们无法被 JSON 表示，序列化后会变成 null，语义就变了。
    assert.equal(isValidId(Number.NaN), false)
    assert.equal(isValidId(Number.POSITIVE_INFINITY), false)
  })
})

describe('响应构造', () => {
  test('成功响应形如 JSON-RPC 2.0', () => {
    const message = rpcResult(1, { ok: true })
    assert.equal(message.jsonrpc, '2.0')
    assert.equal(message.id, 1)
    assert.deepEqual(message.result, { ok: true })
    assert.equal('error' in message, false)
  })

  test('错误响应带 code 与 message', () => {
    const message = rpcError(2, ERROR_CODES.METHOD_NOT_FOUND, '没有这个方法')
    assert.equal(message.jsonrpc, '2.0')
    assert.equal(message.id, 2)
    assert.equal(message.error.code, -32601)
    assert.equal(message.error.message, '没有这个方法')
    assert.equal('result' in message, false)
  })

  test('未提供 data 时错误里没有 data 字段', () => {
    // 带一个 `data: undefined` 会让序列化结果出现 "data":null 的歧义。
    const message = rpcError(1, -32600, 'x')
    assert.equal('data' in message.error, false)
  })

  test('提供 data 时原样带上', () => {
    const message = rpcError(1, -32602, 'x', { supported: ['a'] })
    assert.deepEqual(message.error.data, { supported: ['a'] })
  })

  test('id 为 null 的错误响应也能编码', () => {
    const text = encodeMessage(rpcError(null, -32700, '解析失败'))
    assert.equal(text.trim(), '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"解析失败"}}')
  })
})

describe('错误码取值', () => {
  test('与 JSON-RPC 2.0 规范一致', () => {
    /*
     * 这些值是协议常量，写错一个客户端就会把「方法不存在」显示成
     * 「内部错误」，排查方向全歪。
     */
    assert.equal(ERROR_CODES.PARSE_ERROR, -32700)
    assert.equal(ERROR_CODES.INVALID_REQUEST, -32600)
    assert.equal(ERROR_CODES.METHOD_NOT_FOUND, -32601)
    assert.equal(ERROR_CODES.INVALID_PARAMS, -32602)
    assert.equal(ERROR_CODES.INTERNAL_ERROR, -32603)
  })
})
