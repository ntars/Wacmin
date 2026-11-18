/**
 * MCP server 测试。
 *
 * ## 注入假 run，不真跑四个方向
 *
 * 真跑构建要几分钟，而且依赖 makensis / wine。测试的目的是验证**协议
 * 接线**对不对，不是验证打包能不能成 —— 后者由各方向自己的测试负责。
 *
 * 但假 run 必须**忠实模拟真实返回值**，包括 `report: null`、超时、被中止
 * 这些边界。用「永远返回成功」的假函数，等于只测了顺利路径。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import { PROTOCOL_VERSION, startMcpServer } from '../src/server.mjs'

/**
 * 造一个可控的测试台。
 *
 * 用 PassThrough 而不是真管道：读写都在内存里，能精确控制「一次送几条
 * 消息」「什么时候关」，也不必担心子进程退出时机带来的不确定性。
 *
 * @param {object} [options]
 * @param {Function} [options.run] 假的 runDirection
 */
function harness(options = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  const errorOutput = new PassThrough()

  let out = ''
  output.on('data', (chunk) => { out += chunk.toString() })
  const errChunks = []
  errorOutput.on('data', (chunk) => { errChunks.push(chunk.toString()) })

  const server = startMcpServer({
    input,
    output,
    errorOutput,
    run: options.run,
  })

  /**
   * 发一条消息并等响应。
   *
   * 轮询而不是「等一个固定时长」：固定时长在慢机器上会偶发失败，
   * 快机器上又白等。轮询到条件成立就返回，两边都稳。
   */
  const send = async (message, predicate = (m) => m.id === message.id) => {
    input.write(`${JSON.stringify(message)}\n`)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      for (const line of out.split('\n').filter((item) => item !== '')) {
        let parsed
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        if (predicate(parsed)) return parsed
      }
      await new Promise((resolveDelay) => { setTimeout(resolveDelay, 5) })
    }
    throw new Error(`等响应超时。已收到的输出：\n${out}`)
  }

  return {
    input,
    output,
    server,
    send,
    /** 当前累积的原始输出。 */
    raw: () => out,
    /** 累积的日志。 */
    logs: () => errChunks.join(''),
    /** 关闭输入，模拟客户端断开。 */
    closeInput: () => { input.end() },
  }
}

/** 一份合法的最小报告。 */
function makeReport(overrides = {}) {
  return {
    schemaVersion: 1,
    direction: 'mac2win',
    ok: true,
    exitCode: 0,
    command: 'build',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    stages: [{ id: 0, name: '预检', status: 'ok' }],
    artifacts: [{ path: '/tmp/out.exe', kind: 'nsis-exe', bytes: 1024 }],
    ...overrides,
  }
}

/** 假的成功 run。 */
function okRun(report = makeReport()) {
  return () => Promise.resolve({
    exitCode: 0,
    report,
    stderr: '',
    stdout: JSON.stringify(report),
    timedOut: false,
    aborted: false,
  })
}

describe('握手', () => {
  test('initialize 返回协议版本、能力与服务信息', async () => {
    const h = harness({ run: okRun() })
    const response = await h.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    })
    await h.server.stop()

    assert.equal(response.jsonrpc, '2.0')
    assert.equal(response.id, 1)
    assert.equal(response.result.protocolVersion, PROTOCOL_VERSION)
    assert.ok(response.result.capabilities.tools !== undefined, '应声明 tools 能力')
    assert.equal(response.result.serverInfo.name, 'wacmin')
    assert.equal(typeof response.result.instructions, 'string')
    assert.ok(response.result.instructions.length > 0, 'instructions 不该为空')
  })

  test('客户端给旧协议版本时回落到我支持的版本', async () => {
    /*
     * 规范：「If the server supports the requested protocol version, it MUST
     * respond with the same version. Otherwise, the server MUST respond with
     * another protocol version it supports.」
     *
     * 不能直接拒绝 —— 那样新客户端会因为一个老 server 而完全不可用。
     */
    const h = harness({ run: okRun() })
    const response = await h.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    })
    await h.server.stop()
    assert.equal(response.result.protocolVersion, '2024-11-05', '支持的版本应原样返回')
  })

  test('完全不认识的版本回落到我方最新版', async () => {
    const h = harness({ run: okRun() })
    const response = await h.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '9999-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    })
    await h.server.stop()
    assert.equal(response.result.protocolVersion, PROTOCOL_VERSION)
  })

  test('缺 protocolVersion 也不崩，回我方版本', async () => {
    const h = harness({ run: okRun() })
    const response = await h.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    })
    await h.server.stop()
    assert.equal(response.result.protocolVersion, PROTOCOL_VERSION)
  })

  test('ping 在任何状态下都回空结果', async () => {
    const h = harness({ run: okRun() })
    const response = await h.send({ jsonrpc: '2.0', id: 7, method: 'ping' })
    await h.server.stop()
    assert.deepEqual(response.result, {})
  })

  test('initialized 通知不产生响应', async () => {
    const h = harness({ run: okRun() })
    await h.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } },
    })
    h.input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    await new Promise((resolveDelay) => { setTimeout(resolveDelay, 100) })
    const lines = h.raw().split('\n').filter((line) => line !== '')
    await h.server.stop()
    assert.equal(lines.length, 1, '通知不该产生响应，只应有 initialize 那一条')
  })
})

describe('工具列表', () => {
  test('tools/list 返回六个工具', async () => {
    const h = harness({ run: okRun() })
    const response = await h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await h.server.stop()

    const tools = response.result.tools
    assert.equal(tools.length, 6)
    const names = tools.map((tool) => tool.name)
    for (const expected of [
      'wacmin_list_directions', 'wacmin_doctor', 'wacmin_build',
      'wacmin_verify', 'wacmin_assess', 'wacmin_run',
    ]) {
      assert.ok(names.includes(expected), `缺少工具 ${expected}`)
    }
  })

  test('每个工具都有 name / title / description / inputSchema', async () => {
    const h = harness({ run: okRun() })
    const response = await h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await h.server.stop()

    for (const tool of response.result.tools) {
      assert.equal(typeof tool.name, 'string')
      assert.ok(tool.name.length > 0)
      assert.equal(typeof tool.title, 'string', `${tool.name} 缺 title`)
      assert.equal(typeof tool.description, 'string', `${tool.name} 缺 description`)
      assert.equal(tool.description.length > 0, true, `${tool.name} 的 description 不该为空`)
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} 的 inputSchema 必须是 object`)
      assert.equal(typeof tool.inputSchema.properties, 'object')
    }
  })

  test('工具名统一带 wacmin_ 前缀', async () => {
    /*
     * MCP 客户端会把多个 server 的工具汇到一个命名空间。没有前缀时
     * 「doctor」「build」这种通用词极易撞名，撞了之后调用会打到别人那儿。
     */
    const h = harness({ run: okRun() })
    const response = await h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await h.server.stop()
    for (const tool of response.result.tools) {
      assert.match(tool.name, /^wacmin_/u, `${tool.name} 缺前缀`)
    }
  })

  test('声明了只读注解的工具确实不写盘', async () => {
    /*
     * readOnlyHint 直接决定客户端要不要弹确认框。标错方向的代价是：
     * 把 build 标成只读 → agent 在用户不知情下跑几分钟构建并写盘；
     * 把 doctor 标成非只读 → 每次自检都打断用户。
     */
    const h = harness({ run: okRun() })
    const response = await h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await h.server.stop()

    const byName = new Map(response.result.tools.map((tool) => [tool.name, tool]))
    for (const name of ['wacmin_list_directions', 'wacmin_doctor', 'wacmin_verify', 'wacmin_assess']) {
      assert.equal(
        byName.get(name).annotations?.readOnlyHint, true,
        `${name} 应标为只读`,
      )
    }
    for (const name of ['wacmin_build', 'wacmin_run']) {
      assert.notEqual(
        byName.get(name).annotations?.readOnlyHint, true,
        `${name} 不该标为只读`,
      )
    }
  })

  test('tools/list 重复调用结果稳定', async () => {
    const h = harness({ run: okRun() })
    const first = await h.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const second = await h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await h.server.stop()
    assert.deepEqual(first.result.tools, second.result.tools)
  })
})

describe('工具调用：成功路径', () => {
  test('list_directions 返回四个方向', async () => {
    const h = harness({ run: okRun() })
    const response = await h.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'wacmin_list_directions', arguments: {} },
    })
    await h.server.stop()

    const directions = response.result.structuredContent.directions
    assert.equal(directions.length, 4)
    const ids = directions.map((item) => item.id)
    assert.deepEqual(ids, ['mac2win', 'exeonmac', 'win2mac', 'apponwin'])
  })

  test('构建成功时 isError 不出现，产物被列出', async () => {
    const h = harness({ run: okRun() })
    const response = await h.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'wacmin_build',
        arguments: { direction: 'mac2win', project: '/tmp/proj' },
      },
    })
    await h.server.stop()

    const result = response.result
    assert.equal(result.isError, undefined, '成功时不该有 isError')
    assert.equal(result.structuredContent.ok, true)
    assert.equal(result.structuredContent.exitCode, 0)
    assert.equal(result.structuredContent.artifacts.length, 1)
    assert.equal(result.structuredContent.artifacts[0].path, '/tmp/out.exe')
  })

  test('成功结果同时给出文本与结构化内容', async () => {
    /*
     * 规范建议：返回 structuredContent 时也应把序列化 JSON 放进 TextContent，
     * 以兼容只读文本的老客户端。所以 content 里应有两条文本：一条人读，
     * 一条是 JSON。
     */
    const h = harness({ run: okRun() })
    const response = await h.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'wacmin_verify', arguments: { direction: 'mac2win', artifact: '/tmp/a.exe' } },
    })
    await h.server.stop()

    const content = response.result.content
    assert.equal(content.length, 2)
    assert.equal(content[0].type, 'text')
    assert.match(content[0].text, /退出码 0/u)
    assert.equal(content[1].type, 'text')
    // 第二条应是可解析的 JSON
    assert.doesNotThrow(() => { JSON.parse(content[1].text) })
  })

  test('complete 为假时文本里明确提示未验全', async () => {
    /*
     * 这是本项目最容易误读的字段。ok 与 complete 正交，只报 ok 会让模型
     * 把「没验」说成「验过了」—— 而这正是曾经修过的真实缺陷。
     */
    const report = makeReport({
      ok: true,
      complete: false,
      unverified: ['载荷完整性', '文件哈希比对'],
    })
    const h = harness({ run: okRun(report) })
    const response = await h.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'wacmin_verify', arguments: { direction: 'mac2win', artifact: '/tmp/a.exe' } },
    })
    await h.server.stop()

    const text = response.result.content[0].text
    assert.match(text, /未覆盖全部项目/u)
    assert.match(text, /未验证项 2 个/u)
    assert.equal(response.result.structuredContent.complete, false)
  })
})

describe('工具调用：失败路径', () => {
  test('退出码非 0 时用 isError 而不是协议错误', async () => {
    /*
     * MCP 把错误分两层。构建失败属于「工具执行错误」：它是**有效信息**，
     * 模型需要看到退出码和错误码才能决定下一步。用协议错误回它，多数
     * 客户端只会显示「工具调用失败」，把细节吞掉。
     */
    const report = makeReport({
      ok: false,
      exitCode: 2,
      artifacts: [],
      error: { code: 'M2W_1002', message: '项目目录不存在', hint: '确认路径拼写' },
    })
    const h = harness({
      run: () => Promise.resolve({
        exitCode: 2, report, stderr: '错误日志', stdout: '', timedOut: false, aborted: false,
      }),
    })
    const response = await h.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'wacmin_build', arguments: { direction: 'mac2win', project: '/tmp/x' } },
    })
    await h.server.stop()

    const result = response.result
    assert.equal(result.isError, true, '业务失败应体现为 isError')
    assert.equal(response.error, undefined, '不该用协议错误')
    assert.equal(result.structuredContent.exitCode, 2)
    assert.equal(result.structuredContent.error.code, 'M2W_1002')
    assert.match(result.content[0].text, /M2W_1002/u)
    assert.match(result.content[0].text, /确认路径拼写/u, '提示要带给模型')
  })

  test('没有合规报告时也如实反映', async () => {
    const h = harness({
      run: () => Promise.resolve({
        exitCode: 3, report: null, stderr: '未实现', stdout: '', timedOut: false, aborted: false,
      }),
    })
    const response = await h.send({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'wacmin_run', arguments: { direction: 'mac2win', command: 'build', args: [] } },
    })
    await h.server.stop()

    assert.equal(response.result.isError, true)
    assert.equal(response.result.structuredContent.exitCode, 3)
    assert.match(response.result.content[0].text, /未拿到合规报告/u)
  })

  test('超时被标记且判为失败', async () => {
    const h = harness({
      run: () => Promise.resolve({
        exitCode: 143, report: makeReport({ ok: false }), stderr: '', stdout: '',
        timedOut: true, aborted: false,
      }),
    })
    const response = await h.send({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'wacmin_build', arguments: { direction: 'mac2win', project: '/tmp/x' } },
    })
    await h.server.stop()

    assert.equal(response.result.isError, true)
    assert.equal(response.result.structuredContent.timedOut, true)
    assert.match(response.result.content[0].text, /已超时并被终止/u)
  })

  test('被取消时标记 aborted 并且不是成功', async () => {
    const h = harness({
      run: () => Promise.resolve({
        exitCode: 143, report: makeReport({ ok: false }), stderr: '', stdout: '',
        timedOut: false, aborted: true,
      }),
    })
    const response = await h.send({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'wacmin_build', arguments: { direction: 'mac2win', project: '/tmp/x' } },
    })
    await h.server.stop()

    assert.equal(response.result.isError, true)
    assert.match(response.result.content[0].text, /已被调用方取消/u)
  })

  test('stderr 只带尾部，避免撑爆上下文', async () => {
    /*
     * 一次 30 分钟的安装能产生几十 MB 日志。全塞进模型上下文会直接
     * 撑爆窗口，而真正有用的永远是最末几十行。
     */
    const long = `${'x'.repeat(20000)}END_MARKER`
    const h = harness({
      run: () => Promise.resolve({
        exitCode: 6, report: makeReport({ ok: false, exitCode: 6 }), stderr: long,
        stdout: '', timedOut: false, aborted: false,
      }),
    })
    const response = await h.send({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'wacmin_build', arguments: { direction: 'mac2win', project: '/tmp/x' } },
    })
    await h.server.stop()

    const tail = response.result.structuredContent.stderrTail
    assert.ok(tail.length <= 4000, `stderrTail 应被截断，实际 ${String(tail.length)} 字符`)
    assert.match(tail, /END_MARKER/u, '尾部内容要保留')
  })
})

describe('工具调用：参数校验', () => {
  test('未知工具回协议错误并列出可用工具', async () => {
    const h = harness({ run: okRun() })
    const response = await h.send({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: '__不存在__', arguments: {} },
    })
    await h.server.stop()

    assert.equal(response.error.code, -32602)
    assert.ok(Array.isArray(response.error.data.available))
    assert.ok(response.error.data.available.length === 6)
  })

  test('apponwin 构建被明确拒绝并给出替代方案', async () => {
    /*
     * 让它走到子进程再报「未知子命令」，用户看到的是实现细节。
     * 在这里拒绝并说明替代方案，才是有效信息。
     */
    const h = harness({ run: okRun() })
    const response = await h.send({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'wacmin_build', arguments: { direction: 'apponwin', project: '/tmp/x' } },
    })
    await h.server.stop()

    assert.equal(response.error.code, -32602)
    assert.match(response.error.message, /wacmin_assess/u, '要指出该用什么替代')
  })

  test('未知方向回协议错误并列出支持的方向', async () => {
    const h = harness({ run: okRun() })
    const response = await h.send({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'wacmin_verify', arguments: { direction: '__x__', artifact: '/tmp/a' } },
    })
    await h.server.stop()
    assert.equal(response.error.code, -32602)
    assert.match(response.error.message, /未知方向/u)
  })

  test('逃生门拒绝未声明的子命令并给出可用清单', async () => {
    /*
     * 「原样透传」不等于「什么都能传」。不做这层校验时，一个拼错的
     * 子命令会让各方向自己的 argparse 报错，错误信息五花八门。
     */
    const h = harness({ run: okRun() })
    const response = await h.send({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'wacmin_run', arguments: { direction: 'mac2win', command: '__nope__' } },
    })
    await h.server.stop()

    assert.equal(response.error.code, -32602)
    assert.ok(Array.isArray(response.error.data.available))
    assert.ok(response.error.data.available.includes('build'))
  })

  test('assess 缺 path 时报参数错误', async () => {
    const h = harness({ run: okRun() })
    const response = await h.send({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'wacmin_assess', arguments: { direction: 'apponwin' } },
    })
    await h.server.stop()
    assert.equal(response.error.code, -32602)
    assert.match(response.error.message, /path/u)
  })
})

describe('协议错误处理', () => {
  test('未知方法回 METHOD_NOT_FOUND', async () => {
    const h = harness({ run: okRun() })
    const response = await h.send({ jsonrpc: '2.0', id: 20, method: 'prompts/list' })
    await h.server.stop()

    assert.equal(response.error.code, -32601)
    assert.ok(Array.isArray(response.error.data.supported))
    assert.ok(response.error.data.supported.includes('tools/call'))
  })

  test('非法 JSON 回 PARSE_ERROR 且 id 为 null', async () => {
    const h = harness({ run: okRun() })
    h.input.write('{不是 json\n')
    await new Promise((resolveDelay) => { setTimeout(resolveDelay, 100) })
    const lines = h.raw().split('\n').filter((line) => line !== '')
    await h.server.stop()

    const response = JSON.parse(lines[0])
    assert.equal(response.error.code, -32700)
    assert.equal(response.id, null)
  })

  test('缺 jsonrpc 字段回 INVALID_REQUEST', async () => {
    const h = harness({ run: okRun() })
    h.input.write('{"id":1,"method":"ping"}\n')
    await new Promise((resolveDelay) => { setTimeout(resolveDelay, 100) })
    const lines = h.raw().split('\n').filter((line) => line !== '')
    await h.server.stop()

    const response = JSON.parse(lines[0])
    assert.equal(response.error.code, -32600)
  })
})

describe('stdout 纯净性', () => {
  test('所有输出都是可解析的 JSON-RPC 消息', async () => {
    /*
     * 这是本模块最重要的一条不变量。
     *
     * MCP 规范：server MUST NOT write anything to its stdout that is not a
     * valid MCP message。本仓库自己踩过这个坑 —— console 曾经 import 一个
     * 顶层直接 main() 的入口，导致每次请求都往 stdout 打一份用法说明。
     */
    const h = harness({ run: okRun() })
    await h.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } },
    })
    await h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await h.send({ jsonrpc: '2.0', id: 3, method: 'ping' })
    await h.server.stop()

    for (const line of h.raw().split('\n').filter((item) => item !== '')) {
      const parsed = JSON.parse(line) // 解析失败即说明有杂质
      assert.equal(parsed.jsonrpc, '2.0')
    }
  })

  test('日志全部走 stderr 而不是 stdout', async () => {
    const h = harness({ run: okRun() })
    await h.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } },
    })
    h.input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    await new Promise((resolveDelay) => { setTimeout(resolveDelay, 100) })
    await h.server.stop()

    assert.match(h.logs(), /\[wacmin-mcp\]/u, '日志应带前缀走 stderr')
    assert.ok(!h.raw().includes('[wacmin-mcp]'), 'stdout 不该出现日志')
  })

  test('源码里没有 console.log', async () => {
    /*
     * 静态扫描。将来有人为了调试顺手加一句 console.log，就会直接
     * 破坏协议 —— 而且是在生产里才暴露（测试用注入流，看不到 stdout）。
     */
    const { readFile } = await import('node:fs/promises')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    const files = ['../src/server.mjs', '../src/protocol.mjs', '../src/tools.mjs', '../bin/wacmin-mcp.mjs']
    for (const file of files) {
      const text = await readFile(join(here, file), 'utf8')
      // 排除注释里出现的情况
      const code = text.split('\n')
        .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
        .join('\n')
      assert.ok(
        !/\bconsole\.log\b/u.test(code),
        `${file} 里出现了 console.log —— 会污染 MCP 的 stdout`,
      )
    }
  })
})

describe('取消', () => {
  test('notifications/cancelled 会中止在途请求', async () => {
    /*
     * 只标记不中止是假取消：用户看到「已取消」，磁盘上却多了个产物。
     */
    let captured = null
    const h = harness({
      run: (id, command, args, hooks) => new Promise((resolvePromise) => {
        captured = hooks.signal
        hooks.signal?.addEventListener('abort', () => {
          resolvePromise({
            exitCode: 143, report: null, stderr: '', stdout: '',
            timedOut: false, aborted: true,
          })
        })
      }),
    })

    // 发一个会挂住的调用（不 await，但要接住可能的 rejection）
    const pending = h.send({
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: { name: 'wacmin_build', arguments: { direction: 'mac2win', project: '/tmp/x' } },
    })

    // 等 run 被调用、signal 被捕获
    const deadline = Date.now() + 2000
    while (captured === null && Date.now() < deadline) {
      await new Promise((resolveDelay) => { setTimeout(resolveDelay, 5) })
    }
    assert.ok(captured !== null, 'run 应已被调用并注入 signal')
    assert.equal(captured.aborted, false)

    h.input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 30, reason: '用户取消' },
    })}\n`)

    const response = await pending
    await h.server.stop()

    assert.equal(captured.aborted, true, 'signal 应已被 abort')
    assert.equal(response.result.structuredContent.aborted, true)
  })

  test('取消未知请求被静默忽略', async () => {
    /*
     * 规范：未知 ID、已完成、格式错误的取消通知 SHOULD 被忽略。
     * 回错误反而会让客户端的取消逻辑卡住。
     */
    const h = harness({ run: okRun() })
    h.input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 999 },
    })}\n`)
    await new Promise((resolveDelay) => { setTimeout(resolveDelay, 100) })
    const lines = h.raw().split('\n').filter((line) => line !== '')
    await h.server.stop()
    assert.equal(lines.length, 0, '取消未知请求不该产生任何输出')
  })

  test('客户端断开时在途请求被取消', async () => {
    let captured = null
    const h = harness({
      run: (id, command, args, hooks) => new Promise((resolvePromise) => {
        captured = hooks.signal
        hooks.signal?.addEventListener('abort', () => {
          resolvePromise({
            exitCode: 143, report: null, stderr: '', stdout: '',
            timedOut: false, aborted: true,
          })
        })
      }),
    })

    /*
     * 这里用 `.catch(() => {})` 而不是 `void`。
     *
     * 断开之后响应写不出去，`send` 里的轮询最终会超时并 reject。用 `void`
     * 丢掉这个 Promise，等测试结束后 rejection 才冒出来，于是 Node 报
     * 「generated asynchronous activity after the test ended」—— 失败被
     * 归到整个文件头上，而真正的原因只是一条没人接的 Promise。
     *
     * 这不是被测代码的问题，是测试自己的写法问题。显式接住它。
     */
    const pending = h.send({
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: { name: 'wacmin_build', arguments: { direction: 'mac2win', project: '/tmp/x' } },
    }).catch(() => null)

    const deadline = Date.now() + 2000
    while (captured === null && Date.now() < deadline) {
      await new Promise((resolveDelay) => { setTimeout(resolveDelay, 5) })
    }
    assert.ok(captured !== null, 'run 应已被调用')

    h.closeInput()
    await h.server.closed.catch(() => {})
    await pending
    assert.equal(captured.aborted, true, '断开后应取消在途请求')
  })
})

describe('参数翻译', () => {
  test('build 把 project 放在位置参数首位', async () => {
    /*
     * 三个方向的 build 都接受位置参数形式的项目目录。放后面时若某个
     * `--flag` 恰好接受可选值，解析器会把项目路径吃成 flag 的值 ——
     * 这类错位在参数表复杂时非常难查。
     */
    let capturedArgs = null
    const h = harness({
      run: (id, command, args) => {
        capturedArgs = args
        return Promise.resolve({
          exitCode: 0, report: makeReport(), stderr: '', stdout: '', timedOut: false, aborted: false,
        })
      },
    })
    await h.send({
      jsonrpc: '2.0',
      id: 40,
      method: 'tools/call',
      params: {
        name: 'wacmin_build',
        arguments: { direction: 'mac2win', project: '/tmp/proj', target: 'x64', dryRun: true },
      },
    })
    await h.server.stop()

    assert.equal(capturedArgs[0], '/tmp/proj', '项目路径必须是第一个位置参数')
    assert.ok(capturedArgs.includes('--target'))
    assert.ok(capturedArgs.includes('x64'))
    assert.ok(capturedArgs.includes('--dry-run'))
  })

  test('布尔 false 不产生 flag', async () => {
    /*
     * `--also-zip=false` 不是合法的命令行形式，多数解析器会把它当成
     * 一个字面量参数。false 就该什么都不加。
     */
    let capturedArgs = null
    const h = harness({
      run: (id, command, args) => {
        capturedArgs = args
        return Promise.resolve({
          exitCode: 0, report: makeReport(), stderr: '', stdout: '', timedOut: false, aborted: false,
        })
      },
    })
    await h.send({
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: {
        name: 'wacmin_build',
        arguments: { direction: 'mac2win', project: '/tmp/p', dryRun: false, alsoZip: false },
      },
    })
    await h.server.stop()

    assert.ok(!capturedArgs.includes('--dry-run'), 'false 不该产生 --dry-run')
    assert.ok(!capturedArgs.includes('--also-zip'), 'false 不该产生 --also-zip')
  })

  test('extraArgs 原样追加在最后', async () => {
    let capturedArgs = null
    const h = harness({
      run: (id, command, args) => {
        capturedArgs = args
        return Promise.resolve({
          exitCode: 0, report: makeReport(), stderr: '', stdout: '', timedOut: false, aborted: false,
        })
      },
    })
    await h.send({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: {
        name: 'wacmin_build',
        arguments: {
          direction: 'mac2win', project: '/tmp/p', extraArgs: ['--keep-staging', '--verbose'],
        },
      },
    })
    await h.server.stop()

    assert.deepEqual(capturedArgs.slice(-2), ['--keep-staging', '--verbose'])
  })

  test('verify 把产物路径放在首位', async () => {
    let capturedArgs = null
    const h = harness({
      run: (id, command, args) => {
        capturedArgs = args
        return Promise.resolve({
          exitCode: 0, report: makeReport(), stderr: '', stdout: '', timedOut: false, aborted: false,
        })
      },
    })
    await h.send({
      jsonrpc: '2.0',
      id: 43,
      method: 'tools/call',
      params: { name: 'wacmin_verify', arguments: { direction: 'mac2win', artifact: '/tmp/a.exe' } },
    })
    await h.server.stop()
    assert.equal(capturedArgs[0], '/tmp/a.exe')
  })

  test('assess 在 exeonmac 上走 detect', async () => {
    let captured = null
    const h = harness({
      run: (id, command, args) => {
        captured = { id, command, args }
        return Promise.resolve({
          exitCode: 0, report: makeReport(), stderr: '', stdout: '', timedOut: false, aborted: false,
        })
      },
    })
    await h.send({
      jsonrpc: '2.0',
      id: 44,
      method: 'tools/call',
      params: { name: 'wacmin_assess', arguments: { direction: 'exeonmac', path: '/tmp/setup.exe' } },
    })
    await h.server.stop()

    assert.equal(captured.id, 'exeonmac')
    assert.equal(captured.command, 'detect', 'exeonmac 的评估是 detect')
    assert.equal(captured.args[0], '/tmp/setup.exe')
  })

  test('assess 在 apponwin 上走 assess', async () => {
    let captured = null
    const h = harness({
      run: (id, command) => {
        captured = { id, command }
        return Promise.resolve({
          exitCode: 0, report: makeReport(), stderr: '', stdout: '', timedOut: false, aborted: false,
        })
      },
    })
    await h.send({
      jsonrpc: '2.0',
      id: 45,
      method: 'tools/call',
      params: { name: 'wacmin_assess', arguments: { direction: 'apponwin', path: '/tmp/A.app' } },
    })
    await h.server.stop()
    assert.equal(captured.command, 'assess')
  })
})

describe('并发与顺序', () => {
  test('连续多条消息都被处理，响应 id 可配对', async () => {
    const h = harness({ run: okRun() })
    h.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'ping' })}\n`)
    h.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'ping' })}\n`)
    h.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 103, method: 'ping' })}\n`)

    const deadline = Date.now() + 3000
    let ids = []
    while (Date.now() < deadline) {
      const lines = h.raw().split('\n').filter((line) => line !== '')
      ids = lines.map((line) => JSON.parse(line).id)
      if (ids.length >= 3) break
      await new Promise((resolveDelay) => { setTimeout(resolveDelay, 5) })
    }
    await h.server.stop()

    assert.deepEqual(ids.sort(), [101, 102, 103])
  })

  test('字符串 id 与数字 id 都能正确回显', async () => {
    const h = harness({ run: okRun() })
    const stringId = await h.send({ jsonrpc: '2.0', id: 'abc', method: 'ping' })
    const numberId = await h.send({ jsonrpc: '2.0', id: 42, method: 'ping' })
    await h.server.stop()

    assert.equal(stringId.id, 'abc')
    assert.equal(numberId.id, 42)
  })
})

describe('消息串行化', () => {
  /**
   * 造一个「记录进入/退出顺序」的假 run。
   *
   * 每条调用进入时推 `enter:<项目>`，退出时推 `exit:<项目>`。串行执行
   * 时顺序必然是 `enter A → exit A → enter B → exit B`；一旦并发，
   * 就会出现 `enter A → enter B → ...` 的交叠。
   *
   * 用 `setTimeout` 而不是立即 resolve：不制造真实的异步间隙，
   * 两条调用可能在同一 tick 里先后完成，测不出交叠。
   */
  function recordingRun(delayMs = 40) {
    const events = []
    const run = (direction, command, args) => new Promise((resolve) => {
      const tag = args?.project ?? args?.installer ?? args?.artifact ?? String(args)
      events.push(`enter:${tag}`)
      setTimeout(() => {
        events.push(`exit:${tag}`)
        resolve({
          exitCode: 0,
          report: makeReport({ command }),
          stderr: '',
          stdout: '',
          timedOut: false,
          aborted: false,
        })
      }, delayMs)
    })
    return { run, events }
  }

  test('两条 tools/call 不交叠：A 退出后才进 B', async () => {
    /*
     * 这条测试守的是一个「注释与实现不符」的缺陷。
     *
     * 原实现是 `void (async () => {...})()` —— 每收到一行就起一个新
     * 异步任务，彼此并行。而同处的注释写着「串行处理：不并发」。
     * 注释说的事从来没发生过。
     *
     * 危害不是理论上的：build / package 会写产物目录。两条并行时争用
     * 同一目录，互相覆盖中间文件，得到半成品 —— 而两次调用都「成功」。
     */
    const { run, events } = recordingRun()
    const h = harness({ run })

    h.input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'wacmin_build', arguments: { direction: 'mac2win', project: '/tmp/A' } },
    })}\n`)
    h.input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'wacmin_build', arguments: { direction: 'mac2win', project: '/tmp/B' } },
    })}\n`)

    const deadline = Date.now() + 5000
    while (events.length < 4 && Date.now() < deadline) {
      await new Promise((resolveDelay) => { setTimeout(resolveDelay, 5) })
    }
    await h.server.stop()

    assert.deepEqual(events, ['enter:/tmp/A', 'exit:/tmp/A', 'enter:/tmp/B', 'exit:/tmp/B'],
      `两条调用交叠了，实际顺序：${events.join(' → ')}`)
  })

  test('三条调用也严格串行', async () => {
    const { run, events } = recordingRun(20)
    const h = harness({ run })

    for (const [id, project] of [[1, '/tmp/1'], [2, '/tmp/2'], [3, '/tmp/3']]) {
      h.input.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'wacmin_build', arguments: { direction: 'mac2win', project } },
      })}\n`)
    }

    const deadline = Date.now() + 5000
    while (events.length < 6 && Date.now() < deadline) {
      await new Promise((resolveDelay) => { setTimeout(resolveDelay, 5) })
    }
    await h.server.stop()

    assert.deepEqual(events, [
      'enter:/tmp/1', 'exit:/tmp/1',
      'enter:/tmp/2', 'exit:/tmp/2',
      'enter:/tmp/3', 'exit:/tmp/3',
    ], `顺序错乱：${events.join(' → ')}`)
  })

  test('前一条抛错不会卡死队列', async () => {
    /*
     * 队列链上只要有一环 reject，整条链就断了 —— 之后所有消息都不再被
     * 处理，而进程还活着，客户端只是「卡住」，没有任何报错。这是最难查
     * 的形态，所以必须显式测。
     */
    let call = 0
    const run = () => {
      call += 1
      if (call === 1) return Promise.reject(new Error('第一次故意失败'))
      return Promise.resolve({
        exitCode: 0, report: makeReport(), stderr: '', stdout: '',
        timedOut: false, aborted: false,
      })
    }
    const h = harness({ run })

    h.input.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'wacmin_build', arguments: { direction: 'mac2win', project: '/tmp/X' } },
    })}\n`)
    h.input.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'wacmin_build', arguments: { direction: 'mac2win', project: '/tmp/Y' } },
    })}\n`)

    const second = await h.send({ id: 2 }, (message) => message.id === 2)
    await h.server.stop()

    assert.equal(call, 2, '第二条必须被执行，说明队列没被前一条的异常打断')
    assert.ok(second.result !== undefined || second.error !== undefined)
  })

  test('取消通知不排队，能立即打断在途任务', async () => {
    /*
     * 取消通知的全部意义就是打断在途任务。若它也排进队列，就得等前面
     * 那个跑了十分钟的 build 结束才轮到自己 —— 那时早已无事可取消。
     */
    let aborted = false
    const run = (direction, command, args, options) => new Promise((resolve) => {
      options?.signal?.addEventListener('abort', () => {
        aborted = true
        resolve({
          exitCode: 130, report: null, stderr: '', stdout: '',
          timedOut: false, aborted: true,
        })
      })
    })
    const h = harness({ run })

    h.input.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'wacmin_build', arguments: { direction: 'mac2win', project: '/tmp/S' } },
    })}\n`)

    // 等它进入在途状态
    const deadline = Date.now() + 2000
    while (h.server.inFlight() === 0 && Date.now() < deadline) {
      await new Promise((resolveDelay) => { setTimeout(resolveDelay, 5) })
    }
    assert.equal(h.server.inFlight(), 1, '任务应已在途')

    h.input.write(`${JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 },
    })}\n`)

    const abortDeadline = Date.now() + 2000
    while (!aborted && Date.now() < abortDeadline) {
      await new Promise((resolveDelay) => { setTimeout(resolveDelay, 5) })
    }
    await h.server.stop()

    assert.equal(aborted, true, '取消通知必须能在任务运行中立即生效')
  })
})
