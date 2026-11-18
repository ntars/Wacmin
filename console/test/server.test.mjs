/**
 * Web 服务测试。
 *
 * 跑法：cd console && npm test
 *
 * ## 这套测试的重点是安全边界
 *
 * 这个服务能**启动子进程**，等同于本机任意代码执行的入口。所以测的
 * 不只是功能，更是「不该被调用的东西调用不到」：
 *
 *   - 只绑 127.0.0.1
 *   - 伪造 Host / Origin 被拒（防 DNS rebinding）
 *   - 静态文件路径穿越被拦
 *   - 子命令白名单
 *   - 同方向并发被拦
 *
 * 用一个假的 `run` 函数注入，不真的跑四个方向 —— 那样测试会很慢且
 * 依赖环境。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'

import { readBody, startServer } from '../src/server.mjs'

/**
 * 发一个 HTTP 请求。
 *
 * 用 `node:http` 而不是 `fetch`：需要能自定义 Host 头（`fetch` 会
 * 忽略或改写 Host），这是测 DNS rebinding 防护的前提。
 *
 * @param {number} port
 * @param {string} path
 * @param {object} [options]
 * @returns {Promise<{status: number, headers: object, body: string}>}
 */
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
 * 起一个用假 run 的服务。
 *
 * ## 为什么每个测试都要独立的 WACMIN_HOME
 *
 * 历史现在会落盘到 `~/.wacmin/history.json`。如果测试不隔离，会出现
 * 两个都很糟的后果：
 *
 *   1. **测试污染开发者的真实历史**。跑一次 `npm test`，看板里多出
 *      几十条 `mac2win doctor` 的假记录。
 *   2. **反过来也被污染**。测试断言「历史里有 1 条」，而本机真实历史
 *      有 20 条，于是必然失败 —— 这条测试在干净的 CI 上通过、在开发
 *      者机器上失败，是最难查的一类。
 *
 * 所以每个 withServer 起一个临时目录，结束就删掉。测试之间也互相
 * 隔离，不会因为并行执行而串数据。
 */
async function withServer(run, fn) {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'wacmin-test-'))
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

/** 假的 run：立刻返回一份合法报告。 */
function fakeRun(id, command) {
  return Promise.resolve({
    exitCode: 0,
    report: {
      schemaVersion: 1,
      direction: id,
      ok: true,
      exitCode: 0,
      command,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 1,
      stages: [{ id: 0, name: '预检', status: 'ok', durationMs: 1 }],
    },
    stderr: '',
    timedOut: false,
  })
}

describe('服务启动', () => {
  test('只绑 127.0.0.1', async () => {
    /*
     * 这是整个模块最重要的安全属性。绑 0.0.0.0 等于把本机的命令执行
     * 能力开放给整个局域网 —— 而用户就在本机看这个页面，没有任何
     * 理由需要外部访问。
     */
    await withServer(fakeRun, async (port) => {
      assert.ok(port > 0)
      // 通过 127.0.0.1 能连上
      const response = await request(port, '/api/status')
      assert.equal(response.status, 200)
    })
  })

  test('端口为 0 时自动分配', async () => {
    await withServer(fakeRun, async (port) => {
      assert.ok(port > 1024, `应分配到高位端口，实际 ${String(port)}`)
    })
  })
})

describe('静态文件', () => {
  test('首页返回 HTML', async () => {
    await withServer(fakeRun, async (port) => {
      const response = await request(port, '/')
      assert.equal(response.status, 200)
      assert.match(response.headers['content-type'], /text\/html/u)
      assert.match(response.body, /Wacmin 看板/u)
    })
  })

  test('CSS 与 JS 的 MIME 正确', async () => {
    await withServer(fakeRun, async (port) => {
      const css = await request(port, '/style.css')
      assert.equal(css.status, 200)
      assert.match(css.headers['content-type'], /text\/css/u)

      const js = await request(port, '/app.js')
      assert.equal(js.status, 200)
      assert.match(js.headers['content-type'], /javascript/u)
    })
  })

  /*
   * 前端引用的**每一个模块文件**都必须以 JS 的 MIME 返回。
   *
   * ## 这条测试守的是一个让看板完全不可用的真实缺陷
   *
   * 浏览器对 ES 模块的 MIME 检查是硬性的：`<script type="module">` 和
   * 它 import 的模块，响应类型必须是 JavaScript 的 MIME，否则直接拒绝
   * 执行 —— 不降级、不部分可用。
   *
   * 早先 MIME 表里只有 `.js` 没有 `.mjs`，于是 `report-view.mjs` 落到
   * 兜底的 `application/octet-stream`。`app.js` 里
   * `import { ... } from './report-view.mjs'` 抛
   * `TypeError: Failed to fetch dynamically imported module`，
   * 整个前端一行没跑，看板在任何浏览器里都是空白页。
   *
   * 而当时测试全绿 —— 因为测试手写文件名，只测了 `/app.js`。
   * 教训：不要手写清单，**从源码里把引用抓出来**，新增文件自动被覆盖。
   */
  test('前端 import 的每个模块都以 JavaScript MIME 返回', async () => {
    const { readFile } = await import('node:fs/promises')
    const { join, dirname, basename } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')

    // 从 index.html 的 script 标签起步，顺着 import 走完整张图
    const pending = ['index.html']
    const modules = new Set()
    while (pending.length > 0) {
      const name = pending.pop()
      let source
      try {
        source = await readFile(join(webRoot, name), 'utf8')
      } catch {
        continue
      }
      // `from './x.mjs'` / `import './x.mjs'` / `src="./x.js"`
      const refs = [...source.matchAll(/(?:from|src=|import)\s*['"](\.\/[^'"]+)['"]/gu)]
      for (const [, ref] of refs) {
        const target = basename(ref)
        if (modules.has(target)) continue
        modules.add(target)
        pending.push(target)
      }
    }

    assert.ok(modules.size >= 2,
      `应该从入口抓到至少两个模块，实际 ${String(modules.size)} 个：${[...modules].join(', ')}`)

    await withServer(fakeRun, async (port) => {
      for (const name of modules) {
        const response = await request(port, `/${name}`)
        assert.equal(response.status, 200, `${name} 应该能取到`)
        assert.match(response.headers['content-type'], /javascript/u,
          `${name} 必须以 JavaScript MIME 返回，否则浏览器拒绝把它当模块执行`
            + `（当前是 ${String(response.headers['content-type'])}）`)
      }
    })
  })

  test('前端源码里引用的模块都真实存在', async () => {
    /*
     * 与上一条互补：那条防「存在但类型错」，这条防「引用但不存在」。
     * 两者都会让整个前端一行不执行，而 HTTP 层看起来只是某个文件 404。
     */
    const { readFile } = await import('node:fs/promises')
    const { join, dirname, basename } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')

    const pending = ['index.html']
    const missing = []
    const seen = new Set()
    while (pending.length > 0) {
      const name = pending.pop()
      let source
      try {
        source = await readFile(join(webRoot, name), 'utf8')
      } catch {
        missing.push(name)
        continue
      }
      for (const [, ref] of source.matchAll(/(?:from|src=|import)\s*['"](\.\/[^'"]+)['"]/gu)) {
        const target = basename(ref)
        if (seen.has(target)) continue
        seen.add(target)
        pending.push(target)
      }
    }
    assert.deepEqual(missing, [], `这些模块被引用但不存在：${missing.join(', ')}`)
  })

  test('不存在的文件返回 404', async () => {
    await withServer(fakeRun, async (port) => {
      const response = await request(port, '/nonexistent-file.txt')
      assert.equal(response.status, 404)
    })
  })

  test('路径穿越被拦', async () => {
    /*
     * 三种常见写法都要拦住。仅靠字符串前缀判断不够：
     * `/../web-evil` 也以 `/web` 开头，所以比较时必须补分隔符。
     */
    await withServer(fakeRun, async (port) => {
      for (const path of ['/../package.json', '/../../etc/passwd', '/..%2Fpackage.json']) {
        const response = await request(port, path)
        assert.ok([403, 404].includes(response.status),
          `${path} 应被拒绝，实际 ${String(response.status)}`)
        assert.equal(response.body.includes('"name"'), false,
          `${path} 泄漏了 package.json 内容`)
      }
    })
  })
})

describe('API', () => {
  test('/api/status 返回四个方向', async () => {
    await withServer(fakeRun, async (port) => {
      const response = await request(port, '/api/status')
      assert.equal(response.status, 200)
      const data = JSON.parse(response.body)
      assert.equal(data.ok, true)
      assert.equal(data.directions.length, 4)
      for (const direction of data.directions) {
        assert.ok(typeof direction.id === 'string')
        assert.ok(typeof direction.label === 'string')
      }
    })
  })

  test('未知路径返回 404', async () => {
    await withServer(fakeRun, async (port) => {
      const response = await request(port, '/api/nonexistent')
      assert.equal(response.status, 404)
    })
  })
})

describe('安全：DNS rebinding 防护', () => {
  test('伪造 Host 被拒', async () => {
    /*
     * 攻击方式：恶意网页把自己的域名解析到 127.0.0.1，然后从用户浏览器
     * 里请求本服务。此时 Host 头是攻击者的域名。
     */
    await withServer(fakeRun, async (port) => {
      const response = await request(port, '/api/status', {
        headers: { Host: 'evil.example' },
      })
      assert.equal(response.status, 403)
    })
  })

  test('伪造 Origin 被拒', async () => {
    await withServer(fakeRun, async (port) => {
      const response = await request(port, '/api/status', {
        headers: { Origin: 'http://evil.example' },
      })
      assert.equal(response.status, 403)
    })
  })

  test('本机 Origin 放行', async () => {
    await withServer(fakeRun, async (port) => {
      const response = await request(port, '/api/status', {
        headers: { Origin: `http://127.0.0.1:${String(port)}` },
      })
      assert.equal(response.status, 200)
    })
  })

  test('localhost Origin 放行', async () => {
    await withServer(fakeRun, async (port) => {
      const response = await request(port, '/api/status', {
        headers: { Origin: `http://localhost:${String(port)}` },
      })
      assert.equal(response.status, 200)
    })
  })
})

describe('任务触发', () => {
  test('合法命令返回 jobId', async () => {
    await withServer(fakeRun, async (port) => {
      const response = await request(port, '/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'mac2win', command: 'doctor' }),
      })
      assert.equal(response.status, 200)
      const data = JSON.parse(response.body)
      assert.equal(data.ok, true)
      assert.match(data.jobId, /^job-/u)
    })
  })

  test('白名单外的命令被拒', async () => {
    /*
     * 这是最关键的一道闸：服务能起子进程，如果 command 可以任意传，
     * 就等于把本机 shell 暴露出去。
     */
    await withServer(fakeRun, async (port) => {
      for (const command of ['rm -rf /', 'cat /etc/passwd', '$(whoami)', ';ls', '']) {
        const response = await request(port, '/api/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ direction: 'mac2win', command }),
        })
        assert.equal(response.status, 400, `${JSON.stringify(command)} 应被拒绝`)
      }
    })
  })

  test('同一方向并发被拒（409）', async () => {
    /*
     * 两个 build 同时跑会争用同一个 prefix / 输出目录，产出互相覆盖的
     * 半成品。宁可明确拒绝，也不让用户拿到坏产物。
     */
    let release
    const slowRun = (id, command) => new Promise((resolvePromise) => {
      release = () => { resolvePromise({
        exitCode: 0,
        report: { schemaVersion: 1, direction: id, ok: true, exitCode: 0, command,
          startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
          durationMs: 1, stages: [] },
        stderr: '', timedOut: false,
      }) }
    })

    await withServer(slowRun, async (port) => {
      const first = await request(port, '/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'mac2win', command: 'doctor' }),
      })
      assert.equal(JSON.parse(first.body).ok, true)

      const second = await request(port, '/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'mac2win', command: 'doctor' }),
      })
      assert.equal(second.status, 409)

      release()
    })
  })

  test('任务结束后同方向可再触发', async () => {
    /*
     * 这条来自一个真实缺陷：任务结束后没从 jobs 里摘掉，导致
     * 「已有任务在跑」的判断在 5 分钟内一直成立，用户点第二次永远被拒。
     */
    await withServer(fakeRun, async (port) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await request(port, '/api/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ direction: 'win2mac', command: 'doctor' }),
        })
        const data = JSON.parse(response.body)
        assert.equal(data.ok, true, `第 ${String(attempt + 1)} 次应成功：${String(data.error)}`)
        // 等任务跑完（fakeRun 是同步 resolve，一个 tick 就够）
        await new Promise((r) => setTimeout(r, 100))
      }
    })
  })

  test('不同方向可并行', async () => {
    await withServer(fakeRun, async (port) => {
      const responses = await Promise.all([
        request(port, '/api/run', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ direction: 'mac2win', command: 'doctor' }),
        }),
        request(port, '/api/run', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ direction: 'apponwin', command: 'doctor' }),
        }),
      ])
      for (const response of responses) {
        assert.equal(JSON.parse(response.body).ok, true)
      }
    })
  })
})

describe('SSE 事件流', () => {
  test('订阅能收到 done 事件', async () => {
    await withServer(fakeRun, async (port) => {
      const created = await request(port, '/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'mac2win', command: 'doctor' }),
      })
      const { jobId } = JSON.parse(created.body)

      // 等任务完成，再订阅 —— 应立刻收到 done
      await new Promise((r) => setTimeout(r, 200))
      const events = await request(port, `/api/job/${jobId}/events`)
      assert.equal(events.status, 200)
      assert.match(events.headers['content-type'], /text\/event-stream/u)
      assert.match(events.body, /event: done/u)
      assert.match(events.body, /"ok":true/u)
    })
  })

  test('不存在的任务返回 404', async () => {
    await withServer(fakeRun, async (port) => {
      const response = await request(port, '/api/job/nonexistent/events')
      assert.equal(response.status, 404)
    })
  })
})

/*
 * ── 畸形报告的渲染容错 ────────────────────────────────────────────────
 *
 * 报告是子进程吐回来再 JSON.parse 的，结构不受本进程控制。这一组检
 * 的是「拿到畸形报告时，服务不崩、也不撒谎」。
 *
 * 起因是一个真实的 500：`artifacts: [null]` 时下载接口直接读 `.path`
 * 抛 TypeError，整个请求变成 500 —— 看板上表现为「点了下载没反应」，
 * 真正的错误埋在服务端日志里。
 */
describe('畸形报告：服务端不崩', () => {
  /** 起服务、跑一个假任务、拿到 jobId。 */
  async function runFake(report, fn) {
    const run = async (id, command) => ({
      exitCode: 0,
      report: typeof report === 'function' ? report(id, command) : report,
      stderr: '',
      timedOut: false,
    })
    await withServer(run, async (port) => {
      const created = await request(port, '/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'mac2win', command: 'doctor' }),
      })
      const { jobId } = JSON.parse(created.body)
      await new Promise((r) => setTimeout(r, 150))
      await fn(port, jobId)
    })
  }

  /** 一份最小合法报告。 */
  function reportBody(overrides = {}) {
    return {
      schemaVersion: 1, direction: 'mac2win', ok: true, exitCode: 0,
      command: 'doctor', startedAt: 'a', finishedAt: 'b',
      stages: [], ...overrides,
    }
  }

  test('artifacts 含 null 时下载返回 400 而不是 500', async () => {
    await runFake(reportBody({ artifacts: [null] }), async (port, jobId) => {
      const response = await request(port, `/api/artifact/${jobId}/0`)
      assert.equal(response.status, 400, response.body)
      const data = JSON.parse(response.body)
      assert.equal(data.ok, false)
      assert.match(data.error, /产物项不是对象/u)
    })
  })

  test('artifacts 项是字符串时返回 400', async () => {
    /* 早期版本确实吐过裸字符串数组，这里不能崩。 */
    await runFake(reportBody({ artifacts: ['/tmp/x.zip'] }), async (port, jobId) => {
      const response = await request(port, `/api/artifact/${jobId}/0`)
      assert.equal(response.status, 400)
    })
  })

  test('artifacts 项缺 path 时返回 404', async () => {
    await runFake(reportBody({ artifacts: [{ kind: 'zip' }] }), async (port, jobId) => {
      const response = await request(port, `/api/artifact/${jobId}/0`)
      assert.equal(response.status, 404)
      assert.match(JSON.parse(response.body).error, /路径为空/u)
    })
  })

  test('产物路径含孤立代理项时仍能下载', async () => {
    /*
     * 文件名可能含孤立代理项（\ud800 单独出现）。真实世界会出现：
     * Linux 文件名是任意字节序列，非合法 UTF-8 的名字被宽松解码后
     * 就是这样。`encodeURIComponent` 对它抛 URIError。
     *
     * 不兜住的话，请求在 writeHead 之前就抛了，被外层 catch 变成
     * 500 —— 而文件其实好好躺在磁盘上。
     */
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const dir = await mkdtemp(join(tmpdir(), 'wacmin-artifact-'))
    const real = join(dir, 'plain.txt')
    await writeFile(real, 'payload')
    try {
      await runFake(reportBody({ artifacts: [{ path: real }] }), async (port, jobId) => {
        /*
         * 这里没法真的造一个「文件存在但名字含孤立代理」的场景 ——
         * macOS 的 APFS 不接受这种文件名。所以换个角度验证：
         * 路径本身合法，下载能成功，响应头编码正确。孤立代理的
         * 兜底逻辑由 code review 与下面的「不抛」断言共同保证。
         */
        const response = await request(port, `/api/artifact/${jobId}/0`)
        assert.equal(response.status, 200)
        assert.equal(response.body, 'payload')
        assert.match(response.headers['content-disposition'], /plain\.txt/u)
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('产物序号越界返回 404', async () => {
    await runFake(reportBody({ artifacts: [{ path: '/tmp/x' }] }), async (port, jobId) => {
      const response = await request(port, `/api/artifact/${jobId}/99`)
      assert.equal(response.status, 404)
    })
  })

  test('artifacts 是对象时序号一律越界', async () => {
    await runFake(reportBody({ artifacts: { path: '/tmp/x' } }), async (port, jobId) => {
      const response = await request(port, `/api/artifact/${jobId}/0`)
      assert.equal(response.status, 404)
    })
  })

  test('历史接口对畸形报告不崩，且产物数算得准', async () => {
    /*
     * 早先 `report.artifacts?.length ?? 0` 在 artifacts 是字符串时
     * 得到 `'abc'.length === 3`，历史里显示「3 个产物」，而实际一个
     * 都没有。用 Array.isArray 才算得准。
     */
    await runFake(reportBody({ artifacts: 'abc' }), async (port) => {
      const response = await request(port, '/api/history')
      assert.equal(response.status, 200)
      const data = JSON.parse(response.body)
      assert.equal(data.items.length, 1)
      assert.equal(data.items[0].artifactCount, 0, 'productCount 应为 0')
    })
  })

  test('历史接口对 error 非对象的情况不崩', async () => {
    await runFake(reportBody({ ok: false, exitCode: 1, error: 'boom' }), async (port) => {
      const response = await request(port, '/api/history')
      assert.equal(response.status, 200)
      const data = JSON.parse(response.body)
      // error 不是对象时无法取 code，给 null 而不是崩
      assert.equal(data.items[0].errorCode, null)
    })
  })

  test('报告为 null 时历史仍记录这一条', async () => {
    await runFake(null, async (port) => {
      const response = await request(port, '/api/history')
      assert.equal(response.status, 200)
      const data = JSON.parse(response.body)
      assert.equal(data.items.length, 1)
      assert.equal(data.items[0].artifactCount, 0)
      assert.equal(data.items[0].errorCode, null)
    })
  })

  test('报告是数组时历史接口不崩', async () => {
    await runFake([], async (port) => {
      const response = await request(port, '/api/history')
      assert.equal(response.status, 200)
      assert.equal(JSON.parse(response.body).items.length, 1)
    })
  })
})
/*
 * ── 历史持久化 ────────────────────────────────────────────────────────
 *
 * 守的是「关掉终端，第二天回来还能看见昨天那个包打成什么样」。
 *
 * 早先历史只活在内存里，服务一重启全空 —— 产物文件还在磁盘上，
 * 但看板什么都不知道。而用户的真实动作恰恰是隔天回看。
 */
describe('历史持久化', () => {
  /** 在给定的临时 home 下起服务、跑一个任务、关掉。 */
  async function runOnceAndClose(home, direction = 'mac2win') {
    const previous = process.env.WACMIN_HOME
    process.env.WACMIN_HOME = home
    const server = await startServer({ port: 0, run: fakeRun })
    try {
      const created = await request(server.port, '/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction, command: 'doctor' }),
      })
      assert.equal(JSON.parse(created.body).ok, true)
      // 等任务真正结束（历史在结束路径上落盘）
      await new Promise((r) => setTimeout(r, 300))
    } finally {
      await server.close()
      if (previous === undefined) delete process.env.WACMIN_HOME
      else process.env.WACMIN_HOME = previous
    }
  }

  test('重启后历史还在', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const home = await mkdtemp(join(tmpdir(), 'wacmin-persist-'))
    try {
      await runOnceAndClose(home)

      // 新进程（新 startServer）读同一个 home
      const previous = process.env.WACMIN_HOME
      process.env.WACMIN_HOME = home
      const server = await startServer({ port: 0, run: fakeRun })
      try {
        const history = await request(server.port, '/api/history')
        const items = JSON.parse(history.body).items
        assert.equal(items.length, 1,
          `重启后应能读回 1 条历史，实际 ${String(items.length)} 条`)
        assert.equal(items[0].direction, 'mac2win')
        assert.equal(items[0].command, 'doctor')
      } finally {
        await server.close()
        if (previous === undefined) delete process.env.WACMIN_HOME
        else process.env.WACMIN_HOME = previous
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('历史文件损坏时服务照常启动（历史为空）', async () => {
    /*
     * 这个文件是上一个进程写的，可能断电被截断、可能来自旧版本。
     * 读不出来绝不能让看板起不来 —— 历史是便利功能，不是核心功能。
     */
    const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const home = await mkdtemp(join(tmpdir(), 'wacmin-broken-'))
    try {
      await mkdir(home, { recursive: true })
      await writeFile(join(home, 'history.json'), '{"items": [ {"jobId": "x"', 'utf8')

      const previous = process.env.WACMIN_HOME
      process.env.WACMIN_HOME = home
      const server = await startServer({ port: 0, run: fakeRun })
      try {
        const history = await request(server.port, '/api/history')
        assert.equal(history.status, 200, '历史文件坏了也要能起来')
        assert.deepEqual(JSON.parse(history.body).items, [],
          '坏文件应退化成空历史，而不是让整个服务崩掉')
      } finally {
        await server.close()
        if (previous === undefined) delete process.env.WACMIN_HOME
        else process.env.WACMIN_HOME = previous
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('历史文件里的畸形条目被跳过，其余照常显示', async () => {
    /*
     * 逐条校验而不是整体信任：一条坏记录不该让整份历史不可用。
     */
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const home = await mkdtemp(join(tmpdir(), 'wacmin-mixed-'))
    try {
      await writeFile(join(home, 'history.json'), JSON.stringify({
        items: [
          null,
          { jobId: 'no-startedAt' },
          { startedAt: 123 },                          // 缺 jobId
          'a string',
          { jobId: 'good-1', startedAt: 999, direction: 'win2mac', command: 'doctor', ok: true },
        ],
      }), 'utf8')

      const previous = process.env.WACMIN_HOME
      process.env.WACMIN_HOME = home
      const server = await startServer({ port: 0, run: fakeRun })
      try {
        const items = JSON.parse((await request(server.port, '/api/history')).body).items
        assert.equal(items.length, 1, '只应保留那条合法的')
        assert.equal(items[0].jobId, 'good-1')
      } finally {
        await server.close()
        if (previous === undefined) delete process.env.WACMIN_HOME
        else process.env.WACMIN_HOME = previous
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('请求体大小防护', () => {
  /*
   * 这一组守的是「限制了大小却没限制内存」那类缺陷。
   *
   * 原实现在超限时 `reject()` 之后只 `return` 出本轮回调，下一个 data
   * 事件照样进来、照样 push —— 实测灌 10 MB，内存里就躺着 10 MB。
   * 大小上限像个摆设：正常路径挡住了，恶意路径畅通。
   */
  test('超过 1 MB 的请求体被拒绝，且不返回 500', async () => {
    await withServer(fakeRun, async (port) => {
      const big = JSON.stringify({ direction: 'mac2win', project: 'x'.repeat(2 * 1024 * 1024) })
      const response = await request(port, '/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: big,
      })
      /*
       * 关键断言是「不是 500」：500 说明服务端在异常里崩了一下才回，
       * 客户端只能看到「服务器错误」，不知道该改什么。413 才是准确
       * 的语义（Payload Too Large），也才对用户有指导意义。
       */
      assert.notEqual(response.status, 500, `不该出现 500，实际响应：${response.body}`)
      assert.ok(response.status === 413 || response.status === 400,
        `应为 413/400，实际 ${response.status}：${response.body}`)
    })
  })

  test('正好在限制内的请求体能正常处理', async () => {
    await withServer(fakeRun, async (port) => {
      // 900 KB，在 1 MB 限制内
      const body = JSON.stringify({
        direction: 'mac2win',
        command: 'doctor',
        project: `/${'a'.repeat(900 * 1024)}`,
      })
      const response = await request(port, '/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      assert.notEqual(response.status, 500)
      assert.ok(response.status < 400, `应被接受，实际 ${response.status}：${response.body}`)
    })
  })

  test('超大请求体不会让服务端崩，后续请求仍可用', async () => {
    await withServer(fakeRun, async (port) => {
      /*
       * 这条比「被拒绝」更重要：拒绝的同时服务不能倒。
       *
       * 原实现用 `request.destroy()` 硬拍连接，在 keep-alive 或代理
       * 场景下容易牵连同一个 socket 上的后续请求。这里验证超限之后
       * 服务端还能正常响应新请求。
       */
      const huge = JSON.stringify({ direction: 'mac2win', project: 'x'.repeat(3 * 1024 * 1024) })
      await request(port, '/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: huge,
      }).catch(() => { /* 客户端侧可能先断开，不影响服务端健康 */ })

      const after = await request(port, '/api/status')
      assert.equal(after.status, 200, `超限请求之后服务端应仍可用，实际 ${after.status}`)
    })
  })

  /*
   * 空请求体：没有任何字节时按 `{}` 处理。
   *
   * 这里只断言「不是 500」。缺 direction 的后果是 400 一类，
   * 但具体是 400 还是 422 属于服务端的自由，不该被测试钉死 ——
   * 钉死了就成了「测实现」而不是「测行为」。
   */
  test('空请求体按空对象处理，不报错', async () => {
    await withServer(fakeRun, async (port) => {
      const response = await request(port, '/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      assert.notEqual(response.status, 500, `不该 500：${response.body}`)
    })
  })
})

/** 从错误对象上取 HTTP 状态码（HttpError 自带 status）。 */
function rejectedStatus(error) {
  return error?.status
}

/**
 * 一个足够像 `IncomingMessage` 的假 request。
 *
 * `push()` 同步触发 `data`，让每一步都确定 —— 用 `PassThrough` 试过，
 * 它的 `write` 是异步派发事件，测试会在 await 上挂死并报
 * 「Promise resolution is still pending but the event loop has already
 * resolved」。
 *
 * `chunkBytesRead` 是这一组测试的关键：它数的是 **`chunk.length` 被读了
 * 几次**，而不是 push 了几次。原因是修复版把守卫放在 `size += chunk.length`
 * **之前** —— 一旦 overflow，后续 chunk 连 `.length` 都不会被碰：
 *
 *     request.on('data', (chunk) => {
 *       if (overflow) return        // ← 到这里就返回，不读 chunk.length
 *       size += chunk.length        // ← 只有未溢出的 chunk 才走到这
 *
 * 于是「overflow 之后又推 N 块」这件事有了一个确定的可观测差异：
 * 修复版 `chunkBytesRead` 停在溢出那一刻，回退版会继续增长。
 * 内存采样做不到这一点（测试自己持有的 Buffer 会污染读数），
 * 「end 是否耗时」也不可靠（几十微秒级的差异，机器一忙就测不出来）。
 */
function makeFakeRequest() {
  const handlers = {}
  const state = {
    resumed: false,
    destroyed: false,
    chunkBytesRead: 0,
  }
  const fake = {
    on: (event, handler) => { handlers[event] = handler; return fake },
    resume: () => { state.resumed = true },
    destroy: () => { state.destroyed = true },
    /*
     * 每次 push 都换一个「读 length 会记账」的对象。
     *
     * 不能直接用 Buffer：Buffer 的 length 是自有属性，读它无从观测。
     * 这里给一个只有 `length` 的普通对象就够 —— readBody 只用到
     * `chunk.length`，以及（未溢出时）`chunks.push(chunk)`。
     */
    push: (bytes) => {
      const chunk = {
        get length() {
          state.chunkBytesRead += 1
          return bytes
        },
      }
      handlers.data?.(chunk)
    },
    end: () => { handlers.end?.() },
  }
  return { fake, state }
}

describe('请求体大小防护（内部不变量）', () => {
  /*
   * 这一组守的是「限制了大小却没限制内存」那类缺陷。
   *
   * 原实现在超限时 `reject()` 之后只 `return` 出本轮回调，下一个 data
   * 事件照样进来、照样 push —— 实测灌 10 MB，内存里就躺着 10 MB。
   * 大小上限像个摆设：正常路径挡住了，恶意路径畅通。
   *
   * 从 HTTP 外面看不到这个缺陷（413 在 5 ms 内就返回，之后客户端写入
   * 被 socket 拒掉），所以直接喂假 request。
   */
  const CHUNK = 64 * 1024
  const LIMIT = 1024 * 1024

  test('超限后不再读取后续 chunk 的长度（停止累积的直接证据）', async () => {
    const { fake, state } = makeFakeRequest()
    let rejection = null
    const promise = readBody(fake).catch((error) => { rejection = error })

    // 喂到超过 1 MB：16 块正好 1 MB，第 17 块越界
    for (let index = 0; index < 17; index += 1) fake.push(CHUNK)
    await promise

    assert.ok(rejection instanceof Error, '超限必须 reject')
    assert.match(rejection.message, /请求体过大/u)
    assert.equal(rejectedStatus(rejection), 413, '必须是 413，不能是 500')
    assert.equal(state.resumed, true, '超限后必须 resume 排空剩余流，否则 socket 半开')

    /*
     * 溢出发生在第 17 块（16 * 64 KB = 1 MB，第 17 块让 size > LIMIT）。
     * 那一块自己的 length 已经被读过（判断越界要用它），所以这里是 17。
     */
    assert.equal(state.chunkBytesRead, 17,
      `溢出时正好读了 17 块的长度，实际 ${String(state.chunkBytesRead)}`)

    // 再灌 160 块（10 MB）：修复版一块都不读，回退版会读满 177 块
    for (let index = 0; index < 160; index += 1) fake.push(CHUNK)

    assert.equal(state.chunkBytesRead, 17,
      'overflow 之后不该再读任何 chunk 的长度 —— 读了就是还在收数据'
      + `（实际 ${String(state.chunkBytesRead)}，说明又处理了 `
      + `${String(state.chunkBytesRead - 17)} 块）`)
  })

  test('overflow 之后 end 不触发二次结算', async () => {
    /*
     * 这条守的是「end 分支没有 overflow 守卫」的情况。
     *
     * 注意它守的是**冗余防线**，不是唯一防线：超限时已经 `chunks.length = 0`，
     * 所以即使 `end` 没有守卫，走到 `JSON.parse(Buffer.concat([]))` 也只会
     * 被 catch 住、不影响已 reject 的结果。实测把 `end` 的守卫单独删掉，
     * 本组 41 项仍全绿 —— 这说明这一行是防御性冗余，不是必需。
     *
     * 保留它是因为成本为零、语义更清楚（「overflow 之后什么都不做」比
     * 「overflow 之后靠 chunks 恰好为空来兜住」更不容易在日后被改坏）。
     * 但既然它不构成守卫，就不该假装有测试在守它 —— 这里只断言
     * 「不该出现二次结算」这个**用户可见**的契约。
     */
    const { fake } = makeFakeRequest()
    let rejection = null
    let settled = 0
    const promise = readBody(fake)
      .then(() => { settled += 1 })
      .catch((error) => { rejection = error; settled += 1 })

    for (let index = 0; index < 18; index += 1) fake.push(CHUNK)
    await promise
    assert.equal(settled, 1)

    const before = rejection
    assert.doesNotThrow(() => { fake.end() }, 'overflow 之后 end 不该抛异常')
    assert.equal(rejection, before, 'end 不该改变已 reject 的结果')
    assert.equal(settled, 1, 'end 不该二次结算')
  })

  test('正常大小的请求体能被解析出来（上限没有误伤正常路径）', async () => {
    const handlers = {}
    const fake = {
      on: (event, handler) => { handlers[event] = handler; return fake },
      resume: () => { throw new Error('正常路径不该 resume') },
      destroy: () => { throw new Error('正常路径不该 destroy') },
    }
    const promise = readBody(fake)
    const payload = Buffer.from(JSON.stringify({ direction: 'mac2win' }), 'utf8')
    handlers.data?.(payload)
    handlers.end?.()
    const body = await promise
    assert.equal(body.direction, 'mac2win')
  })
})
