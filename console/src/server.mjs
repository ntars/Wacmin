/**
 * console 的本地 Web 服务。
 *
 * ## 为什么是本地服务而不是静态文件
 *
 * 静态 HTML 只能读历史报告，无法触发构建。而 console 的核心价值恰恰是
 * 「点一下就跑起来，边跑边看进度」。要做到这点必须有进程能起子进程，
 * 所以需要一个本地 HTTP 服务。
 *
 * ## 安全边界（重要）
 *
 * 这个服务能**启动子进程**，等同于本机任意代码执行的入口。因此：
 *
 *   1. **只绑 127.0.0.1**，绝不绑 0.0.0.0 —— 否则同一局域网内任何人都能
 *      通过它执行命令。
 *   2. **校验 Origin / Host**，防 DNS rebinding —— 恶意网页可以把域名
 *      解析到 127.0.0.1，然后从浏览器里打这个接口。
 *   3. **静态文件路径穿越防护**：请求路径先规范化，再确认落在静态目录内。
 *   4. **只允许白名单内的子命令**，不接受任意命令拼接。
 *
 * 这几条不是「理论上应该做」，而是本地开发服务器被利用的常见路径。
 *
 * ## 为什么用 SSE 而不是 WebSocket
 *
 * 进度是单向的（服务端 → 浏览器），SSE 够用，且：
 *   - 原生 `EventSource` 支持，前端零依赖
 *   - 走普通 HTTP，不用处理握手与心跳
 *   - 断线自动重连，浏览器自带
 *
 * WebSocket 在这里只会增加复杂度。
 */

import { createServer } from 'node:http'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = resolve(HERE, '..', 'web')

/** 允许通过 API 触发的子命令白名单。 */
const ALLOWED_COMMANDS = new Set([
  'doctor', 'version', 'list', 'contract',
  'detect', 'extract', 'install', 'package', 'build', 'verify',
  'layers', 'recipe', 'runtime',
  'assess', 'parse', 'spike',
])

/** 历史条数上限。多了会拖慢首屏，而且更早的没人会翻。 */
const HISTORY_LIMIT = 20

/**
 * 历史文件的落盘路径。
 *
 * 放用户目录而不是仓库目录：这是运行时数据，不该进版本库，也不该
 * 因为仓库被删而不见。`WACMIN_HOME` 可覆盖，供测试与多实例隔离 ——
 * 测试直接写用户真实目录是灾难，会污染开发者的看板历史。
 *
 * @returns {string}
 */
function historyFile() {
  const home = process.env.WACMIN_HOME ?? join(homedir(), '.wacmin')
  return join(home, 'history.json')
}

/**
 * 把一个任务收敛成历史摘要。
 *
 * ## 为什么抽成函数
 *
 * 实时列表和历史回看要显示的是**同一批字段**。早先这段推导写在
 * `/api/history` 里，加持久化时又要在写盘处再算一遍 —— 两处各写
 * 一份必然分叉。本项目已经因此出过事：`artifacts?.length` 让
 * 字符串算出「3 个产物」，而实际一个产物都没有。抽出来只有一个来源。
 *
 * @param {object} job
 * @returns {object}
 */
function summarizeJob(job) {
  /*
   * 报告是子进程吐回来再 JSON.parse 的，结构不受本进程控制。
   * 当 artifacts 是字符串时 `'abc'.length` 得到 3，历史里会显示
   * 「3 个产物」，而实际一个产物都没有。用 Array.isArray 才算得准。
   */
  const report = job.result?.report
  const artifacts = report !== null && typeof report === 'object'
    && Array.isArray(report.artifacts) ? report.artifacts : []
  const error = report !== null && typeof report === 'object'
    && typeof report.error === 'object' && report.error !== null
    ? report.error : null
  return {
    jobId: job.id,
    direction: job.direction,
    command: job.command,
    startedAt: job.startedAt,
    ok: job.result?.ok ?? false,
    exitCode: job.result?.exitCode ?? -1,
    durationMs: job.result?.durationMs ?? 0,
    timedOut: job.result?.timedOut ?? false,
    errorCode: typeof error?.code === 'string' ? error.code : null,
    artifactCount: artifacts.length,
  }
}

/**
 * 读上次留下的历史。
 *
 * ## 为什么容错要这么宽
 *
 * 这个文件是**上一个进程**写的，可能来自旧版本，也可能因为断电被
 * 截断成半个 JSON。任何一条读不出来都不该让看板起不来 —— 历史是
 * 便利功能，不是核心功能。所以：读不到返回空数组，解析失败返回
 * 空数组，单条畸形就跳过那一条。
 *
 * @returns {Promise<object[]>}
 */
async function loadPersistedHistory() {
  try {
    const text = await readFile(historyFile(), 'utf8')
    const data = JSON.parse(text)
    const items = Array.isArray(data) ? data : data?.items
    if (!Array.isArray(items)) return []
    return items.filter((item) => typeof item === 'object' && item !== null
      && typeof item.jobId === 'string' && typeof item.startedAt === 'number')
  } catch {
    return []
  }
}

/**
 * 把历史写回磁盘。
 *
 * 「不能影响主流程」：写失败只记一行日志。磁盘满、权限不足、用户把
 * 目录删了 —— 这些都不该让一次成功的构建变成失败。
 *
 * 写临时文件再 rename，避免写到一半进程被杀留下半个 JSON。rename
 * 在同一文件系统内是原子的。
 *
 * @param {object[]} items
 * @param {(message: string) => void} log
 * @returns {Promise<void>}
 */
async function savePersistedHistory(items, log) {
  const target = historyFile()
  const temp = `${target}.${String(process.pid)}.tmp`
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(temp, `${JSON.stringify({ items }, undefined, 2)}\n`, 'utf8')
    await rename(temp, target)
  } catch (error) {
    log(`历史写盘失败（不影响使用）：${String(error)}`)
    try { await rm(temp, { force: true }) } catch { /* 临时文件可能没建起来 */ }
  }
}

/** 静态文件的 MIME 映射。只覆盖看板用到的类型。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  /*
   * `.mjs` 必须显式列出，且类型必须是 JS 的。
   *
   * 浏览器对 ES 模块的 MIME 检查是**硬性**的：`<script type="module">`
   * 及其 import 的模块，响应类型必须是 JavaScript 的 MIME，否则直接
   * 拒绝执行 —— 不会降级，不会有部分可用。
   *
   * 这里踩过一个致命坑：早先表里只有 `.js`，`report-view.mjs` 落到
   * 兜底的 `application/octet-stream`。结果 `app.js` 里那行
   * `import { ... } from './report-view.mjs'` 直接抛
   * `TypeError: Failed to fetch dynamically imported module`，
   * 整个前端一行都没跑 —— 看板在任何浏览器里都是空白页，只显示
   * 「正在读取方向状态…」的初始占位文案。
   *
   * 而当时所有测试都通过：测试只断言「GET /report-view.mjs 返回 200
   * 且内容正确」，没有一个测试真的去看浏览器能不能执行它。
   */
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/**
 * 启动服务。
 *
 * @param {object} options
 * @param {number} [options.port] 端口，0 表示随机。
 * @param {(id: string, command: string, options?: string[], hooks?: object) => Promise<object>} options.run
 *   调用方向的函数（注入以便测试）。
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{server: import('node:http').Server, port: number, close: () => Promise<void>}>}
 */
export async function startServer(options) {
  const { run } = options
  const log = options.log ?? (() => {})

  /** 正在跑的任务：id → job */
  const jobs = new Map()
  /** 已结束但保留供补订阅的任务：id → job */
  const finished = new Map()
  /** 正在跑的方向集合，用于「同方向只能一个任务」判断 */
  const activeDirections = new Set()
  /**
   * 上次进程留下的历史摘要。
   *
   * ## 为什么要持久化
   *
   * 早先历史只活在内存里，服务一重启就全空。用户的真实动作是
   * 「关掉终端，第二天回来看看昨天那个包打成什么样了」—— 而那时
   * 历史是空的，产物文件还在但看板什么都不知道。
   *
   * 只存摘要不存完整报告：报告可能几百 KB，而历史要的只是「谁、
   * 什么时候、成没成、错误码、几个产物」。完整报告随进程消失，
   * 反正任务本身也跑不了第二次补订阅。
   */
  const persisted = await loadPersistedHistory()
  /**
   * 在途的历史写盘 Promise 集合。
   *
   * 写盘本身是「发出去就不管」的（失败只记日志，不能影响任务流程），
   * 但关闭服务时必须能等它们落地 —— 否则 `close()` 返回后目录里还有
   * 文件正在被创建，调用方紧接着删目录就会拿到
   * `ENOTEMPTY: directory not empty`。
   *
   * 这不是理论问题：测试里 `withServer` 的 finally 就是先 close 再 rm，
   * 在 macOS runner 上稳定复现，本机偶尔能碰到。
   */
  const inFlightWrites = new Set()
  /** 上下文对象，供 handleRequest 与 runJob 共用 */
  const context = { run, jobs, finished, activeDirections, persisted, log, inFlightWrites }

  const server = createServer((request, response) => {
    handleRequest(request, response, context).catch((error) => {
      /*
       * `HttpError` 是「客户端发错了」，用自带的状态码（413 / 400）如实
       * 回；其余一律 500 并在日志里留痕。把客户端错误一律当 500 会让
       * 用户去翻服务端日志找一个不存在的 bug。
       */
      const status = error instanceof HttpError ? error.status : 500
      if (status === 500) log(`请求处理异常：${String(error)}`)
      if (!response.headersSent) {
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      }
      response.end(JSON.stringify({ ok: false, error: String(error) }))
    })
  })

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    /*
     * 只绑 127.0.0.1。
     *
     * 这是本模块最重要的安全决定：服务能起子进程，绑 0.0.0.0 等于把
     * 本机的命令执行能力开放给整个局域网。没有任何理由需要外部访问 ——
     * 用户就在本机看这个页面。
     */
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', rejectPromise)
      resolvePromise()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    server,
    port,
    close: async () => {
      // 先掐断所有 SSE 连接，否则 close 会一直等
      for (const job of [...jobs.values(), ...finished.values()]) {
        for (const subscriber of job.subscribers) {
          try { subscriber.end() } catch { /* 已断开 */ }
        }
        job.subscribers.clear()
      }

      await new Promise((resolvePromise) => { server.close(() => { resolvePromise() }) })

      /*
       * 等历史写盘落地。
       *
       * 顺序不能反：必须在 server.close 之后等，因为收尾的任务会在
       * 关闭过程中才触发写盘。等待有上限 —— 写盘卡住不该让 close
       * 永久挂住，调用方是关服务，不是等 IO。
       */
      if (inFlightWrites.size > 0) {
        await Promise.race([
          Promise.allSettled([...inFlightWrites]),
          new Promise((r) => { setTimeout(r, 3000).unref() }),
        ])
      }
    },
  }
}

/**
 * 处理一个请求。
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {object} context
 */
async function handleRequest(request, response, context) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
  const pathname = url.pathname

  /*
   * 防 DNS rebinding。
   *
   * 攻击方式：恶意网页把自己的域名解析到 127.0.0.1，然后从用户浏览器
   * 里请求 http://evil.example/api/run。浏览器会带上 Origin: http://evil.example，
   * 而 Host 也是 evil.example。因此两个头都要查。
   */
  if (!isTrustedHost(request.headers.host)) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('拒绝：Host 不是本机')
    return
  }
  const origin = request.headers.origin
  if (origin !== undefined && !isTrustedOrigin(origin)) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('拒绝：Origin 不是本机')
    return
  }

  // ── API ────────────────────────────────────────────────────────────────
  if (pathname === '/api/history') {
    /*
     * 最近跑过的任务列表，新的在前。
     *
     * 刷新页面不该丢掉刚才的结果 —— 这是看板相对终端的核心优势。
     * 只返回摘要，不含完整报告（报告可能很大，而且前端点开某条时
     * 可以用 /api/job/<id>/events 补订阅拿全量）。
     *
     * 两个来源合并：本进程跑过的（`finished`）+ 上次进程留下的
     * （`persisted`）。同一 jobId 以内存里的为准 —— 那份更新。
     */
    const merged = new Map()
    for (const record of context.persisted) {
      if (typeof record?.jobId === 'string') merged.set(record.jobId, record)
    }
    for (const job of context.finished.values()) {
      merged.set(job.id, summarizeJob(job))
    }

    const items = [...merged.values()]
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .slice(0, HISTORY_LIMIT)
    sendJson(response, { ok: true, items })
    return
  }

  if (pathname === '/api/status') {
    /*
     * 直接引共享调度模块，不再绕道 `bin/wacmin-console.mjs`。
     *
     * 绕道时会连带执行入口文件顶层的 `main()`：每个请求都往服务进程
     * stdout 写一份中文用法说明，并把 `process.exitCode` 设成 2。
     * 看板不读自己的 stdout，所以这个问题藏了很久；而 MCP server 复用
     * 同一套调度、stdout 又被协议独占，同样的写法在那里是致命缺陷。
     */
    const { status } = await import('./directions.mjs')
    sendJson(response, { ok: true, directions: status() })
    return
  }

  if (pathname === '/api/contract') {
    const { runContractCheck } = await import('./contract-check.mjs')
    const result = await runContractCheck({
      run: (id, sub, opts = []) => context.run(id, sub, opts, { timeoutMs: 60000 }),
    })
    sendJson(response, result)
    return
  }

  if (pathname === '/api/run' && request.method === 'POST') {
    const body = await readBody(request)
    const id = String(body.direction ?? '')
    const command = String(body.command ?? '')
    const args = Array.isArray(body.args) ? body.args.map(String) : []

    if (!ALLOWED_COMMANDS.has(command)) {
      sendJson(response, { ok: false, error: `不允许的子命令：${command}` }, 400)
      return
    }

    /*
     * 同一个方向同时只允许一个任务。
     *
     * 理由：两个 build 同时跑会争用同一个 prefix / 输出目录，产出
     * 互相覆盖的半成品。宁可明确拒绝，也不让用户拿到坏产物。
     */
    if (context.activeDirections.has(id)) {
      sendJson(response, {
        ok: false,
        error: `方向 ${id} 已有任务在跑，等它结束再试`,
      }, 409)
      return
    }

    const jobId = `job-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`
    const job = {
      id: jobId,
      direction: id,
      command,
      startedAt: Date.now(),
      subscribers: new Set(),
      result: null,
      controller: new AbortController(),
      /** 已广播的事件，供晚到的订阅者补发。见 broadcast 的说明。 */
      events: [],
      /** 缓冲里日志文本的总字符数，用于裁剪。 */
      eventChars: 0,
      /** 最近一次广播的阶段序号，用于去重。 */
      lastStage: null,
    }
    context.jobs.set(jobId, job)
    context.activeDirections.add(id)

    /*
     * 任务在后台跑，立刻返回 jobId。
     * 前端用 /api/job/<id>/events 订阅进度。
     */
    runJob(job, args, context).catch((error) => {
      job.result = { ok: false, error: String(error), exitCode: 1 }
      broadcast(job, 'done', job.result)
      context.activeDirections.delete(id)
      context.jobs.delete(jobId)
      context.finished.set(jobId, job)
    })

    sendJson(response, { ok: true, jobId })
    return
  }

  // ── 产物下载 ───────────────────────────────────────────────────────────
  /*
   * GET /api/artifact/<jobId>/<index>
   *
   * ## 为什么用「任务 ID + 序号」而不是直接传路径
   *
   * 传路径的方案看起来简单：`/api/artifact?path=/tmp/x.exe`。但那等于
   * 开了一个任意文件读取接口 —— 任何能访问这个端口的东西都能读
   * `~/.ssh/id_rsa`。路径穿越防护在这种设计下永远补不干净（软链、
   * 编码变形、大小写、Windows 短名……）。
   *
   * 改成从**已完成任务的报告里**取产物路径，攻击面就收敛成：
   * 只能下载本次会话里真实产出过的文件。路径不来自请求，来自服务端
   * 自己记录的报告。
   */
  const artifactMatch = /^\/api\/artifact\/([^/]+)\/(\d+)$/u.exec(pathname)
  if (artifactMatch !== null) {
    const jobId = artifactMatch[1]
    const index = Number(artifactMatch[2])
    const job = context.finished.get(jobId) ?? context.jobs.get(jobId)

    if (job === undefined || job.result === null) {
      sendJson(response, { ok: false, error: '任务不存在或尚未完成' }, 404)
      return
    }

    const artifacts = job.result.report?.artifacts
    if (!Array.isArray(artifacts) || index >= artifacts.length) {
      sendJson(response, { ok: false, error: `产物序号越界：${String(index)}` }, 404)
      return
    }

    /*
     * artifacts 的项不一定是对象。
     *
     * 这里踩过一个 500：`artifacts: [null]` 时直接读 `.path` 抛
     * TypeError，整个请求变成 500 —— 看板上表现为「点了下载没反应」，
     * 真正的错误埋在服务端日志里。畸形报告本来就该由契约检查去修，
     * 但下载接口不该因此崩，它只需要给出一个说得清原因的 400。
     */
    const artifact = artifacts[index]
    if (typeof artifact !== 'object' || artifact === null) {
      sendJson(response, { ok: false, error: '产物项不是对象' }, 400)
      return
    }

    const artifactPath = artifact.path
    if (typeof artifactPath !== 'string' || artifactPath === '') {
      sendJson(response, { ok: false, error: '产物路径为空' }, 404)
      return
    }

    let info
    try {
      info = await stat(artifactPath)
    } catch {
      sendJson(response, { ok: false, error: '产物文件已不存在' }, 404)
      return
    }
    if (!info.isFile()) {
      sendJson(response, { ok: false, error: '产物不是文件' }, 400)
      return
    }

    /*
     * 下载名用 basename，防止响应头里出现路径分隔符 ——
     * 换行注入 Content-Disposition 是历史上有过的攻击手法。
     *
     * ## 为什么还要兜 encodeURIComponent 的异常
     *
     * 文件名可能含**孤立代理项**（\ud800 单独出现）。这种情况在
     * 真实世界会出现：Linux 的文件名是任意字节序列，不是合法 UTF-8
     * 的名字被宽松解码后就得到孤立代理。`encodeURIComponent` 对这种
     * 输入抛 `URIError: URI malformed`。
     *
     * 不兜住的话，请求在 `writeHead` 之前就抛了，被外层 catch 变成
     * 500 —— 而文件其实好好躺在磁盘上。这里退化成 ASCII 安全名，
     * 让用户至少能把文件拿走。
     */
    let encodedName
    try {
      encodedName = encodeURIComponent(basename(artifactPath).replace(/[\r\n"]/gu, '_'))
    } catch {
      encodedName = 'artifact'
    }
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': info.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`,
    })
    createReadStream(artifactPath).pipe(response)
    return
  }

  // ── 任务事件（SSE） ────────────────────────────────────────────────────
  const eventsMatch = /^\/api\/job\/([^/]+)\/events$/u.exec(pathname)
  if (eventsMatch !== null) {
    const jobId = eventsMatch[1]
    const job = context.jobs.get(jobId) ?? context.finished.get(jobId)
    if (job === undefined) {
      sendJson(response, { ok: false, error: `任务不存在：${jobId}` }, 404)
      return
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 关闭反向代理缓冲，否则进度会被攒着一起发
      'X-Accel-Buffering': 'no',
    })
    response.write(': connected\n\n')

    /*
     * 先补发历史，再接实时流。
     *
     * 顺序不能反：反了的话，补发期间新产生的事件会插到历史前面，
     * 前端看到「第 5 步 → 第 1 步 → 第 6 步」，进度条来回跳。
     *
     * `job.result !== null` 时不走补发，直接由下面的分支补 done ——
     * 那说明任务已结束，事件历史里已经有 done，重复发会让前端把
     * 结果渲染两遍。
     */
    if (job.result === null) replayEvents(job, response)

    job.subscribers.add(response)
    request.on('close', () => { job.subscribers.delete(response) })

    // 已经结束的任务：立刻补发结果并关闭
    if (job.result !== null) {
      writeEvent(response, 'done', job.result)
      response.end()
      job.subscribers.delete(response)
    }
    return
  }

  // ── 静态文件 ───────────────────────────────────────────────────────────
  await serveStatic(pathname, response)
}

/**
 * 剥掉 ANSI 转义序列。
 *
 * ## 为什么必须在服务端剥
 *
 * 各方向的人类日志是给**终端**写的，带颜色：
 *
 *   `\x1b[2m13:22:57\x1b[0m ▸ \x1b[36m[1/8] 预检\x1b[0m`
 *
 * 这段字节进到两处都会坏：
 *
 *   1. **阶段解析**。`▸` 和 `[1/8]` 之间夹着 `\x1b[36m`，正则匹配不上，
 *      于是真实构建里进度条永远不动 —— 只有对着干净字符串写的测试会过。
 *   2. **日志面板**。前端用 `textContent` 追加，ANSI 码不会被解释，会原样
 *      显示成 `[2m13:22:57[0m`，整屏日志变成乱码。
 *
 * 剥在服务端而不是前端，是因为「入口只有一个」：stderr 进 console 的地方
 * 只有 `onStderr`，在这里剥一次，解析和展示都拿到干净文本，不需要两处
 * 各写一遍、也不需要前端为格式差异做兼容。
 *
 * 覆盖的序列：
 *   - CSI：`\x1b[` 后跟参数与终止字节，覆盖颜色、光标、清屏
 *   - OSC：`\x1b]` 到 `BEL` 或 `\x1b\\`，覆盖改标题
 *   - 字符集选择：`\x1b(B` 这类两字节序列
 *
 * @param {string} text
 * @returns {string}
 */
function stripAnsi(text) {
  return text
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/gu, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001B[@-Z\\-_]/gu, '')
}

/**
 * 找出文本末尾**尚未写完**的转义序列。
 *
 * ## 为什么需要这个
 *
 * stderr 的 chunk 边界由子进程的 flush 时机决定，**完全可能切在转义
 * 序列中间**：
 *
 *   第一块：`\x1b[2m13:22:57\x1b[0m ▸ \x1b[3`   ← 青色序列只到了一半
 *   第二块：`6m[1/8] 预检\x1b[0m\n`
 *
 * 把两块各自 `stripAnsi` 一遍，第一块的 `\x1b[3` 不构成完整序列被留下，
 * 第二块的 `6m` 也不是序列开头被留下 —— 拼起来还是 `\x1b[36m`，
 * 于是 `▸` 和 `[1/8]` 之间仍然隔着颜色码，阶段还是认不出来。
 *
 * 正确做法是：把末尾这半截**扣住不发**，等下一个 chunk 到了拼上再剥。
 * 这和真实终端的行为一致 —— 终端也是收到完整序列才解析。
 *
 * @param {string} text
 * @returns {string} 末尾未完成的转义序列；没有则空串
 */
function incompleteEscapeTail(text) {
  const esc = text.lastIndexOf('\u001B')
  if (esc === -1) return ''

  const rest = text.slice(esc)

  // ESC 孤零零在末尾，下一块才知道它要干什么
  if (rest.length === 1) return rest

  const kind = rest[1]

  if (kind === '[') {
    // CSI 序列：参数与中间字节之后，以 0x40–0x7E 的终止字节结束
    for (let i = 2; i < rest.length; i += 1) {
      const code = rest.charCodeAt(i)
      if (code >= 0x40 && code <= 0x7e) return ''   // 已终止
    }
    return rest
  }

  if (kind === ']') {
    // OSC 序列：以 BEL 或 ST（ESC \）结束
    if (rest.includes('\u0007')) return ''
    if (rest.indexOf('\u001B\\', 1) !== -1) return ''
    return rest
  }

  // 其余是两字符序列（ESC + 单字节），已经完整
  return ''
}

/**
 * 从日志行里认出阶段标记。
 *
 * ## 为什么解析 stderr 而不是让各方向上报进度
 *
 * 各方向的报告（`--report`）是**结束时**才写的，任务跑着的时候拿不到。
 * 要实时进度，只有两条路：
 *
 *   1. 四个方向各加一套进度回调 / 事件流协议
 *   2. 从它们已经在打的日志里认
 *
 * 选 2 的理由：四个方向的人类日志本来就有稳定的阶段标记
 * （mac2win `▸ [3/8] 准备运行时`、win2mac/apponwin 同构，exeonmac 用
 * `▸ [n/8]`），这些标记是给人看的主要骨架，不会轻易改；而新增协议要
 * 动四份代码、四套测试，还会引入「协议版本不一致」这类新问题。
 *
 * 代价是耦合了日志格式。所以这个函数**只做识别、不做推断**：认不出就
 * 返回 null，前端退回到「转圈 + 计时」，不会因为认错而显示假进度。
 *
 * 支持的形态（四个方向实测）：
 *   `13:15:23 ▸ [3/8] 准备运行时`   ← mac2win / win2mac / apponwin
 *   `13:15:46 ▸ [8/8] 校验产物`
 *   `▸ [2/8] 项目构建`              ← 可能没有时间戳前缀
 *
 * 调用前应先用 `stripAnsi` 去掉颜色码，否则真实日志里的 `▸ \x1b[36m[3/8]`
 * 匹配不上。这里没有自己做剥离，是为了让调用方对「剥一次还是剥两次」
 * 有明确控制权。
 *
 * @param {string} line 一行日志（不含换行）
 * @returns {{index: number, total: number, title: string} | null}
 */
function parseStageLine(line) {
  // 时间戳可有可无：`HH:MM:SS` 后跟任意空白，再接 ▸
  const match = /(?:^|\s)(?:▸|>)\s*\[(\d+)\/(\d+)\]\s*(.*)$/u.exec(line)
  if (match === null) return null
  const index = Number(match[1])
  const total = Number(match[2])
  // 序号必须落在 1..total 的合理范围内。异常值当没认出来，
  // 免得把 1/0 这类脏数据算进进度条（会出现 NaN 或负宽度）。
  if (!Number.isInteger(index) || !Number.isInteger(total) || total <= 0) return null
  if (index < 1 || index > total) return null
  return { index, total, title: match[3].trim() }
}

/**
 * 跑一个任务并把进度广播给订阅者。
 *
 * @param {object} job
 * @param {string[]} args
 * @param {object} context
 */
async function runJob(job, args, context) {
  broadcast(job, 'start', {
    jobId: job.id,
    direction: job.direction,
    command: job.command,
    startedAt: job.startedAt,
  })

  /*
   * stderr 是流式的，两处边界都要处理：
   *
   *   1. **行边界**：`▸ [3/8]` 可能被切成 `▸ [3` 和 `/8]`
   *   2. **转义序列边界**：`\x1b[36m` 可能被切成 `\x1b[3` 和 `6m`
   *
   * 两个都用「扣住尾巴、等下一块」的办法解决：
   *   - 行尾巴留在 `pending` 里
   *   - 转义序列尾巴留在 `escPending` 里
   *
   * 处理顺序必须是「先剥 ANSI、再累积行」：
   * 反过来的话，`\x1b[3` + `6m[1/8]` 中间夹着换行时，按换行切会先切
   * 出两个都不完整的行，再拼就拼不回去了。
   */
  let escPending = ''
  let pending = ''
  const onStderr = (chunk) => {
    const raw = escPending + String(chunk)
    const tail = incompleteEscapeTail(raw)
    escPending = tail
    const clean = stripAnsi(tail === '' ? raw : raw.slice(0, raw.length - tail.length))

    /*
     * 给前端的日志也必须是剥过的，否则面板里全是 `[2m` `[0m`。
     *
     * 但末尾未完成的转义序列已经被扣住，这段不被广播 —— 等它完整了
     * 随下一块一起发。少发的只是几个字节的格式控制，没有正文。
     */
    if (clean !== '') broadcast(job, 'log', { text: clean })

    pending += clean
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      const stage = parseStageLine(line)
      if (stage === null) continue
      // 同一阶段重复出现（例如日志被重打）时不必重发
      if (job.lastStage === stage.index) continue
      job.lastStage = stage.index
      broadcast(job, 'stage', stage)
    }
  }

  let result
  try {
    result = await context.run(job.direction, job.command, args, { onStderr })
  } catch (error) {
    result = { exitCode: 1, report: null, stderr: String(error), timedOut: false }
  }

  /*
   * 收尾：最后一行往往没有换行符。
   *
   * 子进程的正常收尾是「打完最后一行就退出」，而那行十有八九不带
   * `\n`。留在 `pending` 里不处理，用户看到的日志就会缺最后一行 ——
   * 偏偏失败时最后一行正是错误原因。
   *
   * `escPending` 里若还剩半截转义序列，说明子进程在写格式控制的中途
   * 挂了。那是一段没有正文的废字节，直接丢弃。
   */
  if (pending !== '') {
    const stage = parseStageLine(pending)
    if (stage !== null && job.lastStage !== stage.index) {
      job.lastStage = stage.index
      broadcast(job, 'stage', stage)
    }
    broadcast(job, 'log', { text: pending })
    pending = ''
  }
  escPending = ''

  job.result = {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    timedOut: result.timedOut ?? false,
    report: result.report,
    durationMs: Date.now() - job.startedAt,
  }
  broadcast(job, 'done', job.result)

  /*
   * `done` 是终止事件，发完就要关流。
   *
   * 早先只广播不关闭，行为随订阅时机而异：
   *   - 任务**已结束**再订阅 → 走 handleRequest 里「立刻补发 done 并 end」
   *     那条路径，连接关掉了
   *   - 任务**跑着时**订阅 → 收到 done 但流一直开着，只有浏览器自己
   *     调 `source.close()` 才断，非浏览器客户端（脚本、curl）会永久挂住
   *
   * 同一个事件语义不该有两个结局。这里统一成「done 之后必然关流」，
   * 顺便把 subscribers 清空 —— 否则已结束的 job 对象还攥着一堆
   * 已失效的 response 引用，5 分钟内不释放。
   */
  for (const subscriber of job.subscribers) {
    try { subscriber.end() } catch { /* 对端已断开 */ }
  }
  job.subscribers.clear()

  /*
   * 任务结束后立刻从 jobs 里摘掉 —— 但**保留 job 对象本身**供补订阅。
   *
   * 这里踩过一个坑：早先的实现只在异常路径 delete，正常完成时留在
   * jobs 里，于是「同一方向已有任务在跑」的判断在任务结束后 5 分钟内
   * 一直成立，用户点第二次永远被拒。
   *
   * 正确的做法是把「运行中」与「已完成」分开：
   *   - `activeDirections` 只记录真正在跑的
   *   - `finished` 保留最近的结果供前端补订阅
   */
  context.activeDirections.delete(job.direction)
  context.finished.set(job.id, job)
  context.jobs.delete(job.id)

  /*
   * 落盘历史。
   *
   * 顺序很重要：先写内存再写盘，且**不 await 等待写盘结果影响主流程**
   * —— 写盘失败只应记日志。
   *
   * 合并策略：内存里还在 5 分钟保留期内的任务（`finished`）优先，
   * 其次是上次进程留下的（`persisted`）。同一 jobId 只留一条，
   * 否则重启后再跑同名任务会出现两条一模一样的记录。
   */
  const byId = new Map()
  for (const record of context.persisted) {
    if (typeof record?.jobId === 'string') byId.set(record.jobId, record)
  }
  for (const done of context.finished.values()) {
    byId.set(done.id, summarizeJob(done))
  }
  const ordered = [...byId.values()]
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, HISTORY_LIMIT)
  context.persisted = ordered
  /*
   * 不 await：写盘慢不该拖住任务收尾。但要把 Promise 记进集合，
   * 让 close() 能等到它 —— 否则进程退出或测试删目录时它还在写。
   */
  const writePromise = savePersistedHistory(ordered, context.log)
    .finally(() => { context.inFlightWrites.delete(writePromise) })
  context.inFlightWrites.add(writePromise)

  // 保留 5 分钟供补订阅，之后清理
  setTimeout(() => { context.finished.delete(job.id) }, 5 * 60 * 1000).unref()
}

/**
 * 向订阅者广播一个事件，并记录进任务的事件缓冲。
 *
 * ## 为什么要记录
 *
 * SSE 是**只往前发**的：订阅那一刻之前发生的事件，晚到的订阅者永远
 * 拿不到。这造成两个真实问题：
 *
 *   1. **前端订阅必然晚于启动**。前端是先 POST `/api/run` 拿到 jobId，
 *      再开 `EventSource` —— 这两步之间服务端已经在跑了。没有缓冲时，
 *      `start` 事件和最初的几行日志稳定丢失。
 *   2. **跑着的时候刷新页面等于瞎了**。日志面板清空、进度条归零，
 *      但任务其实还在跑。
 *
 * 所以每个 job 留一份事件历史，新订阅者先补发再接入实时流。
 *
 * ## 为什么缓冲要设上限
 *
 * 一次跑 30 分钟的安装可能产出几十 MB 日志，全留着会吃内存。上限按
 * **日志文本总字符数**算而不是按条数 —— 一条日志可能是一大段报错，
 * 按条数限制不住。超限时从头丢最老的日志，但 `stage` / `start` 这类
 * 小事件不丢：它们是重建进度条的唯一依据，几十条加起来也不到几 KB。
 *
 * @param {object} job
 * @param {string} event
 * @param {unknown} data
 */
function broadcast(job, event, data) {
  recordEvent(job, event, data)
  for (const subscriber of job.subscribers) {
    try {
      writeEvent(subscriber, event, data)
    } catch {
      job.subscribers.delete(subscriber)
    }
  }
}

/** 事件缓冲上限（字符）。约 256 KB，够看几千行日志。 */
const EVENT_BUFFER_CHARS = 256 * 1024

/**
 * 把事件记进任务的缓冲，并在超限时裁剪。
 *
 * @param {object} job
 * @param {string} event
 * @param {unknown} data
 */
function recordEvent(job, event, data) {
  const isLog = event === 'log'
  job.events.push({ event, data, size: isLog ? String(data?.text ?? '').length : 0 })
  job.eventChars += isLog ? String(data?.text ?? '').length : 0

  /*
   * 超限时从最老的日志开始丢。
   *
   * 只丢 `log`：`stage` 决定进度条、`start` 决定面板标题，丢了会让
   * 补订阅拿到的界面状态是错的。日志丢了只是少看几行历史，代价小得多。
   */
  while (job.eventChars > EVENT_BUFFER_CHARS && job.events.length > 1) {
    const index = job.events.findIndex((entry) => entry.event === 'log')
    if (index === -1) break
    job.eventChars -= job.events[index].size
    job.events.splice(index, 1)
  }
}

/**
 * 向新订阅者补发全部已记录事件。
 *
 * 顺序必须与原始发生顺序一致，否则前端会拿到「先 done 后 stage」这种
 * 乱序，进度条会往回跳。
 *
 * @param {object} job
 * @param {import('node:http').ServerResponse} response
 */
function replayEvents(job, response) {
  for (const entry of job.events) {
    try {
      writeEvent(response, entry.event, entry.data)
    } catch {
      return
    }
  }
}

/**
 * 写一条 SSE 事件。
 *
 * SSE 的格式要求：`event: 名称\n` + `data: 单行JSON\n\n`。
 * data 里不能有裸换行，所以 JSON 必须压成一行 —— 用 JSON.stringify
 * 天然满足（它会把换行转成 \n 转义）。
 *
 * @param {import('node:http').ServerResponse} response
 * @param {string} event
 * @param {unknown} data
 */
function writeEvent(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/**
 * 判断 Host 头是否可信。
 *
 * 只接受 127.0.0.1 / localhost / [::1]，端口任意（本机服务端口是随机的）。
 *
 * @param {string | undefined} host
 */
function isTrustedHost(host) {
  if (host === undefined) return false
  const name = host.replace(/:\d+$/u, '').replace(/^\[|\]$/gu, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

/**
 * 判断 Origin 是否可信。
 *
 * @param {string} origin
 */
function isTrustedOrigin(origin) {
  try {
    const parsed = new URL(origin)
    return isTrustedHost(parsed.host)
  } catch {
    return false
  }
}

/**
 * 发 JSON 响应。
 *
 * @param {import('node:http').ServerResponse} response
 * @param {unknown} payload
 * @param {number} [status]
 */
function sendJson(response, payload, status = 200) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * 带 HTTP 状态码的错误。
 *
 * 顶层那个 catch 是兜底，把一切异常变成 500 是对的 —— 真出了没预料到的
 * 问题，500 是诚实的答复。但「请求体过大」不是服务端故障，它是客户端
 * 发多了，回 500 会让用户以为是工具坏了，去翻服务端日志。给它一个
 * 明确的 413，用户立刻知道该改什么。
 */
class HttpError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** 请求体上限：1 MB。POST /api/run 只收几个路径字符串。 */
const BODY_LIMIT = 1024 * 1024

/**
 * 读请求体（限制 1 MB）。
 *
 * ## 为什么用 overflow 标志而不是只在超限那一轮 return
 *
 * 原实现是：
 *
 *     if (size > LIMIT) { reject(); request.destroy(); return }
 *     chunks.push(chunk)
 *
 * `return` 只结束**本轮回调**，下一个 `data` 事件照样进来，照样 push。
 * 实测往里灌 10 MB，`chunks` 一路涨到 10 MB —— 大小限制了，内存没限制。
 * 「防护」只挡住了正常路径，这恰恰是最不该出错的地方：`POST /api/run`
 * 是唯一会触发构建的端点。
 *
 * 现在超限时置位 overflow、丢弃已收数据并 `resume()` 排空剩余流（不排空
 * 会让 socket 一直半开），后续 `data` 直接忽略。
 *
 * **导出是为了可测**：HTTP 层的 413 在 5 ms 内就返回了，之后客户端
 * 的写入会被 socket 拒掉 —— 从外面看不到「chunks 还在涨」。只有直接
 * 喂一个假 request 才能验证这个内部不变量。不导出就只能靠内存采样，
 * 而内存采样受 GC 时机影响，测不准。
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<object>}
 */
export function readBody(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let size = 0
    let overflow = false

    request.on('data', (chunk) => {
      if (overflow) return   // 已经判过了，后续数据一律丢弃
      size += chunk.length
      if (size > BODY_LIMIT) {
        overflow = true
        chunks.length = 0    // 已收的部分没有用了，尽快释放
        rejectPromise(new HttpError(`请求体过大，上限 ${BODY_LIMIT} 字节`, 413))
        /*
         * 不用 `destroy()`：它会直接把连接拍掉，客户端只看到
         * ECONNRESET，拿不到「请求体过大」这句提示。resume 把剩余数据
         * 读完再丢弃，响应就能正常写回去 —— 用户知道是自己发大了。
         */
        request.resume()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (overflow) return
      if (chunks.length === 0) { resolvePromise({}); return }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        rejectPromise(error)
      }
    })
    request.on('error', rejectPromise)
  })
}

/**
 * 提供静态文件。
 *
 * 路径穿越防护：规范化后必须落在 WEB_ROOT 之内。仅靠字符串前缀判断
 * 不够（`/../web-evil` 也以 `/web` 开头），所以比较时补上分隔符。
 *
 * @param {string} pathname
 * @param {import('node:http').ServerResponse} response
 */
async function serveStatic(pathname, response) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//u, '')
  const target = resolve(WEB_ROOT, normalize(relative))

  if (!target.startsWith(WEB_ROOT + sep) && target !== join(WEB_ROOT, 'index.html')) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('拒绝：路径越界')
    return
  }

  let info
  try {
    info = await stat(target)
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('未找到')
    return
  }
  if (!info.isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('未找到')
    return
  }

  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
  response.writeHead(200, {
    'Content-Type': type,
    'Content-Length': info.size,
    'Cache-Control': 'no-cache',
  })
  createReadStream(target).pipe(response)
}