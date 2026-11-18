/**
 * 实时阶段进度测试。
 *
 * ## 这一组守的是什么
 *
 * 看板相对终端的核心价值是「边跑边看」。但构建动辄几十秒（mac2win 打
 * 一个大载荷 20 秒以上），如果只有「转圈 + 计时」，用户无法判断是正常
 * 在跑还是卡死了。
 *
 * 进度信息的来源是各方向**已经在打的人类日志**：
 *
 *   `13:15:23 ▸ [3/8] 准备运行时`
 *
 * 服务端把这种行认出来，转成一个 `stage` 事件推给前端。选解析日志而不是
 * 让四个方向新增进度协议，是因为日志的阶段标记是给人看的主要骨架，
 * 不会轻易改；新增协议要动四份代码四套测试，还会引入协议版本不一致。
 *
 * ## 三个容易错的地方
 *
 * 1. **ANSI 颜色码**：真实 stderr 是
 *    `\x1b[2m13:22:57\x1b[0m ▸ \x1b[36m[1/8] 预检\x1b[0m` ——
 *    `▸` 和 `[1/8]` 之间夹着颜色码。对着干净字符串写的正则能过，
 *    真实构建里永远匹配不上。这组测试的第一批用例就踩了这个坑，
 *    所以现在固定用带码的真实样本。
 * 2. **chunk 边界**：stderr 是流式的，`▸ [3/8]` 完全可能被切成
 *    `▸ [3` 和 `/8]` 两个 chunk。不把尾巴留到下次，进度就永远认不出来。
 *    真实场景里这取决于子进程的 flush 时机，本地跑一百次都不一定碰上，
 *    但线上一定会碰上。
 * 3. **脏数据**：`[0/0]`、`[9/8]`、`[a/b]` 都不该算出进度，否则进度条
 *    会出现 NaN 宽度或倒退。
 * 4. **重复**：同一阶段行被重打时不该重复推进度。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { startServer } from '../src/server.mjs'

/**
 * 造一行和真实日志等价的带色文本。
 *
 * 格式取自 `mac2win/src/core/logger.mjs` 的 `formatForTerminal`：
 *   暗色时间戳 + 空白 + 符号 + 着色的正文
 *
 * 不用直接调 `formatForTerminal` 是为了让断言可以写死期望的字节，
 * 不会因为 logger 改了渲染就悄悄跟着变。
 */
function colorLine(clock, symbol, body, color = '36') {
  return `\u001B[2m${clock}\u001B[0m ${symbol} \u001B[${color}m${body}\u001B[0m`
}

/** 一行真实的阶段日志。默认青色（STEP 级别）。 */
function stageLine(index, total, title, clock = '13:15:23') {
  return `${colorLine(clock, '▸', `[${String(index)}/${String(total)}] ${title}`)}\n`
}

/** 发一个 HTTP 请求，收集完整响应体。 */
function request(port, path, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      timeout: 10000,
    }, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        resolvePromise({ status: response.statusCode ?? 0, headers: response.headers, body })
      })
    })
    req.on('error', rejectPromise)
    req.on('timeout', () => { req.destroy(new Error('请求超时')) })
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

/**
 * 起服务并保证历史写盘落在临时目录。
 *
 * 历史会落盘到 `~/.wacmin/history.json`，不隔离的话：测试会污染
 * 开发者的真实看板历史，反过来真实历史也会让断言失效（「应该 1 条」
 * 而本机有 20 条）—— 这类测试在干净 CI 上绿、在开发机上红，最难查。
 */
async function withServer(run, fn) {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'wacmin-stage-'))
  const previous = process.env.WACMIN_HOME
  process.env.WACMIN_HOME = home

  let server
  try {
    server = await startServer({ port: 0, run })
    return await fn(server.port)
  } finally {
    if (previous === undefined) delete process.env.WACMIN_HOME
    else process.env.WACMIN_HOME = previous
    if (server !== undefined) await server.close()
    await rm(home, { recursive: true, force: true })
  }
}

/** 一份最小合法报告。 */
function minimalReport() {
  return {
    schemaVersion: 1, direction: 'mac2win', ok: true, exitCode: 0,
    command: 'build', startedAt: 'a', finishedAt: 'b',
    stages: [{ id: 0, name: '预检', status: 'ok', durationMs: 1 }],
  }
}

/**
 * 造一个会按给定分块推 stderr 的假 run。
 *
 * 每个 chunk 之间 yield 一次事件循环，模拟真实子进程的流式输出 ——
 * 这样服务端的 chunk 累积逻辑才会被真正走到。
 */
function streamingRun(chunks, delayMs = 5) {
  return async (id, command, args, hooks) => {
    for (const chunk of chunks) {
      hooks?.onStderr?.(chunk)
      await new Promise((r) => setTimeout(r, delayMs))
    }
    return { exitCode: 0, report: minimalReport(), stderr: '', timedOut: false }
  }
}

/** 起任务并订阅事件流，返回收到的事件块。 */
async function collectEvents(port, direction = 'mac2win') {
  const created = await request(port, '/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction, command: 'build' }),
  })
  const { jobId } = JSON.parse(created.body)
  const events = await request(port, `/api/job/${jobId}/events`)
  return events.body
}

/** 从 SSE 文本里取出某类事件的全部 data。 */
function eventsOfType(body, type) {
  const out = []
  const blocks = body.split('\n\n')
  for (const block of blocks) {
    const nameMatch = /^event: (\S+)/mu.exec(block)
    if (nameMatch === null || nameMatch[1] !== type) continue
    const dataMatch = /^data: (.+)$/mu.exec(block)
    if (dataMatch === null) continue
    out.push(JSON.parse(dataMatch[1]))
  }
  return out
}

describe('实时阶段进度', () => {
  test('认出 mac2win 的阶段行并推成 stage 事件', async () => {
    const run = streamingRun([
      stageLine(1, 8, '预检'),
      stageLine(2, 8, '项目构建'),
      stageLine(3, 8, '准备运行时', '13:15:24'),
    ])
    await withServer(run, async (port) => {
      const body = await collectEvents(port)
      const stages = eventsOfType(body, 'stage')
      assert.equal(stages.length, 3, `应收到 3 个 stage 事件，实际 ${String(stages.length)}`)
      assert.deepEqual(stages.map((s) => s.index), [1, 2, 3])
      assert.equal(stages[0].total, 8)
      assert.equal(stages[2].title, '准备运行时')
    })
  })

  test('带 ANSI 颜色码的真实日志也能认出（不做这步进度条永远不动）', async () => {
    /*
     * 这条测试是回归防线。第一批实现只对着 `13:15:23 ▸ [1/8] 预检`
     * 这种干净字符串测，全绿；但真实 stderr 是
     * `\x1b[2m13:22:57\x1b[0m ▸ \x1b[36m[1/8] 预检\x1b[0m`，
     * `▸` 与 `[` 之间隔着 `\x1b[36m`，正则匹配不上 ——
     * 看板上表现为「构建跑完了进度条还在 0%」。
     */
    const raw = '\u001B[2m13:22:57\u001B[0m ▸ \u001B[36m[1/8] 预检\u001B[0m\n'
    const run = streamingRun([raw])
    await withServer(run, async (port) => {
      const stages = eventsOfType(await collectEvents(port), 'stage')
      assert.equal(stages.length, 1, 'ANSI 码必须被剥掉，否则真实构建里认不出阶段')
      assert.equal(stages[0].index, 1)
      assert.equal(stages[0].title, '预检')
    })
  })

  test('推给前端的日志已经剥掉 ANSI 码', async () => {
    /*
     * 前端用 `textContent +=` 追加日志，ANSI 码不会被解释，
     * 会原样显示成 `[2m13:22:57[0m` —— 整屏日志变乱码。
     */
    const run = streamingRun([stageLine(1, 8, '预检'), colorLine('13:15:24', '✓', '完成', '32') + '\n'])
    await withServer(run, async (port) => {
      const logs = eventsOfType(await collectEvents(port), 'log')
      const joined = logs.map((l) => l.text).join('')
      assert.doesNotMatch(joined, /\u001B/u, '日志里不该再有转义序列')
      assert.match(joined, /13:15:23 ▸ \[1\/8\] 预检/u, '剥完要保留可读的时间戳与正文')
      assert.match(joined, /13:15:24 ✓ 完成/u)
    })
  })

  test('被切开的阶段行仍能认出（chunk 边界）', async () => {
    /*
     * 这是最容易漏的一条：`▸ [3/8] 准备运行时` 被拆成两个 chunk 时，
     * 逐 chunk 做正则匹配永远匹配不上。必须把不完整的尾巴留到下次。
     *
     * 切点故意落在带色行中间（`\x1b[36m[3` 之后），同时压测
     * 「先剥 ANSI 再累积」是否会让半截转义序列漏进来。
     */
    const full = stageLine(3, 8, '准备运行时')
    const cut = full.indexOf('[3') + 2
    const run = streamingRun([full.slice(0, cut), full.slice(cut)])
    await withServer(run, async (port) => {
      const body = await collectEvents(port)
      const stages = eventsOfType(body, 'stage')
      assert.equal(stages.length, 1, '被切开的行也要认出来，否则流式输出下进度永远不动')
      assert.equal(stages[0].index, 3)
      assert.equal(stages[0].title, '准备运行时')
      assert.doesNotMatch(eventsOfType(body, 'log').map((l) => l.text).join(''), /\u001B/u)
    })
  })

  test('没有时间戳前缀的也能认', async () => {
    const run = streamingRun(['▸ [2/8] 项目构建\n'])
    await withServer(run, async (port) => {
      const stages = eventsOfType(await collectEvents(port), 'stage')
      assert.equal(stages.length, 1)
      assert.equal(stages[0].index, 2)
    })
  })

  test('脏数据不产生 stage 事件', async () => {
    const run = streamingRun([
      '▸ [0/0] 零\n',
      '▸ [9/8] 越界\n',
      '▸ [a/b] 非数字\n',
      '▸ [-1/8] 负数\n',
      '普通日志行\n',
    ])
    await withServer(run, async (port) => {
      const stages = eventsOfType(await collectEvents(port), 'stage')
      assert.equal(stages.length, 0,
        '脏数据必须被丢掉。算进去会让进度条出现 NaN 宽度或倒退')
    })
  })

  test('同一阶段重复出现只推一次', async () => {
    const run = streamingRun([
      stageLine(3, 8, '准备运行时'),
      stageLine(3, 8, '准备运行时'),
      stageLine(3, 8, '准备运行时'),
    ])
    await withServer(run, async (port) => {
      const stages = eventsOfType(await collectEvents(port), 'stage')
      assert.equal(stages.length, 1, '重复的阶段行不该重复推进度')
    })
  })

  test('日志事件仍然完整，不因为解析阶段而丢', async () => {
    const text = `${stageLine(1, 8, '预检')}${colorLine('13:15:24', '·', '完成', '2')}\n`
    const run = streamingRun([text])
    await withServer(run, async (port) => {
      const body = await collectEvents(port)
      const joined = eventsOfType(body, 'log').map((l) => l.text).join('')
      // 逐行比对剥码后的结果：日志是用户排查的唯一依据，不能少内容
      const expected = text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
      assert.equal(joined, expected, '日志必须原样保留（剥码除外），用户排查靠它')
    })
  })
})
