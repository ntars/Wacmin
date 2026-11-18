/**
 * 本地 Web 控制台的服务端。
 *
 * ## 为什么用本地 Web 而不是桌面窗口
 *
 * 这个工具本身就是「在 mac 上为 Windows 打包」，如果它自己还需要一套
 * Rust/Tauri 的桌面壳，那就自相矛盾了——用户还得先装 Rust 工具链。
 * 用 Node 起一个本地 HTTP 服务 + 系统浏览器打开，零额外依赖，
 * 而且界面代码可以直接复用（同一套 CSS 在浏览器里就是最终形态）。
 *
 * ## 接口设计
 *
 * 全部 JSON，全部 `POST` 或 `GET`，无鉴权——服务只监听 `127.0.0.1`，
 * 且这是个本地开发工具，不存在多用户。加令牌会让「刷新页面就失联」
 * 这种体验出现，收益为零。
 *
 * ## 日志推送用 SSE
 *
 * 构建日志是单向流（服务端 → 界面），SSE 正好。不用 WebSocket：
 * 双向能力在这里完全用不上，而 SSE 自带重连、无需握手库。
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig, describeConfig, DEFAULTS } from '../core/config.mjs'
import { Builder, STAGES } from '../core/builder.mjs'
import { Logger } from '../core/logger.mjs'
import { asBuildError, isCancellation } from '../core/errors.mjs'
import { runPreflight } from '../core/preflight.mjs'
import { verifyArtifact } from '../verify/artifact.mjs'
import { humanBytes, isDirectory } from '../util/fsx.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(here, '..', '..', 'web')

/** MIME 表。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/** 全局构建状态。同一时刻只允许一次构建——打包是重活，并行没有意义。 */
const state = {
  /** @type {import('../core/logger.mjs').Logger | null} */
  logger: null,
  /** @type {AbortController | null} */
  controller: null,
  building: false,
  /** @type {object | null} 最近一次构建的结果摘要。 */
  lastResult: null,
  /** @type {object | null} 最近一次的预检报告。 */
  lastPreflight: null,
  /** @type {Set<import('node:http').ServerResponse>} SSE 连接。 */
  streams: new Set(),
}

/** 把一条消息推给所有 SSE 连接。 */
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const stream of state.streams) {
    try {
      stream.write(payload)
    } catch {
      state.streams.delete(stream)
    }
  }
}

/** 读请求体并解析 JSON。 */
function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      // 限制 2MB：这个接口只收配置对象，不需要更大的体。
      if (size > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolveBody({})
        return
      }
      try {
        resolveBody(JSON.parse(text))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error.message}`))
      }
    })
    request.on('error', reject)
  })
}

/** 回 JSON。 */
function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  response.end(text)
}

/** 服务静态文件（界面本身）。 */
function serveStatic(pathname, response) {
  const target = normalize(join(webRoot, pathname === '/' ? '/index.html' : pathname))
  if (target !== webRoot && !target.startsWith(webRoot + sep)) {
    response.writeHead(403).end('禁止访问')
    return
  }
  if (!existsSync(target)) {
    response.writeHead(404).end('文件不存在')
    return
  }
  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
  response.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
  // 同步读是刻意的：界面资源很小（几十 KB），异步流式引入的复杂度
  // 换不来任何收益，而同步读让「读不到就 404」这条路径更简单。
  response.end(readFileSync(target))
}

/**
 * 处理一次 API 请求。
 *
 * @returns {Promise<boolean>} 是否已处理（false 表示交给静态服务）。
 */
async function handleApi(request, response, url) {
  const path = url.pathname

  // --- 事件流 ---
  if (path === '/api/events' && request.method === 'GET') {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // 首帧立刻发一次，让界面知道连上了（否则某些浏览器要等 3 秒才触发 open）。
    response.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`)
    state.streams.add(response)
    // 心跳：中间的代理或系统可能掐掉长时间静默的连接。
    const heartbeat = setInterval(() => {
      try {
        response.write(`event: ping\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`)
      } catch {
        clearInterval(heartbeat)
      }
    }, 15_000)
    request.on('close', () => {
      clearInterval(heartbeat)
      state.streams.delete(response)
    })
    return true
  }

  // --- 初始状态 ---
  if (path === '/api/state' && request.method === 'GET') {
    sendJson(response, 200, {
      version: '1.0.0',
      stages: STAGES,
      defaults: DEFAULTS,
      building: state.building,
      lastResult: state.lastResult,
      lastPreflight: state.lastPreflight,
      logs: state.logger?.snapshot() ?? [],
      platform: { platform: process.platform, arch: process.arch, node: process.versions.node },
    })
    return true
  }

  // --- 预检 ---
  if (path === '/api/preflight' && request.method === 'POST') {
    const body = await readBody(request)
    try {
      const config = await resolveConfig({
        projectRoot: body.projectRoot,
        overrides: body.overrides ?? {},
      })
      const report = await runPreflight(config)
      state.lastPreflight = {
        checks: report.checks,
        failed: report.failed,
        warned: report.warned,
        at: Date.now(),
      }
      sendJson(response, 200, { ok: true, config: describeConfig(config), ...state.lastPreflight })
    } catch (error) {
      const buildError = asBuildError(error)
      sendJson(response, 200, {
        ok: false,
        code: buildError.code,
        message: buildError.message,
        hint: buildError.hint,
        details: buildError.details,
      })
    }
    return true
  }

  // --- 开始构建 ---
  if (path === '/api/build' && request.method === 'POST') {
    if (state.building) {
      sendJson(response, 409, { ok: false, message: '已有构建在进行中' })
      return true
    }

    const body = await readBody(request)

    // 立刻回 202，构建在后台跑，进度通过 SSE 推。
    // 同步等构建结束会让 HTTP 请求挂几分钟，中间任何代理都会超时。
    sendJson(response, 202, { ok: true, started: true })

    state.building = true
    state.controller = new AbortController()
    state.logger = new Logger({
      file: join(resolve(body.projectRoot ?? '.'), '.mac2win-build.log'),
    })
    state.logger.subscribe((entry) => { broadcast('log', entry) })

    void (async () => {
      try {
        const config = await resolveConfig({
          projectRoot: body.projectRoot,
          overrides: body.overrides ?? {},
        })

        const builder = new Builder({
          config,
          logger: state.logger,
          signal: state.controller.signal,
        })
        builder.onProgress = (progress) => { broadcast('progress', progress) }

        broadcast('build-start', { at: Date.now(), config: describeConfig(config) })
        const result = await builder.build()

        state.lastResult = {
          ok: true,
          artifact: result.artifact,
          size: result.artifactSize,
          sizeText: humanBytes(result.artifactSize),
          durationMs: result.durationMs,
          verify: result.verify?.items ?? [],
          manifestCount: result.manifest.length,
          preflight: result.preflight?.checks ?? [],
        }
        broadcast('build-done', state.lastResult)
      } catch (error) {
        if (isCancellation(error)) {
          broadcast('build-cancelled', { at: Date.now() })
        } else {
          const buildError = asBuildError(error)
          state.lastResult = {
            ok: false,
            code: buildError.code,
            message: buildError.message,
            hint: buildError.hint,
            details: buildError.details,
          }
          broadcast('build-failed', state.lastResult)
        }
      } finally {
        state.building = false
        state.controller = null
      }
    })()

    return true
  }

  // --- 取消构建 ---
  if (path === '/api/cancel' && request.method === 'POST') {
    state.controller?.abort()
    sendJson(response, 200, { ok: true })
    return true
  }

  // --- 校验已有产物 ---
  if (path === '/api/verify' && request.method === 'POST') {
    const body = await readBody(request)
    try {
      const report = await verifyArtifact({
        artifact: body.artifact,
        expectTarget: typeof body.target === 'string' ? body.target : undefined,
      })
      /*
       * `complete` 必须一起返回。
       *
       * 界面上「已验证」和「验了一半」是两种颜色。只给 ok 的话，
       * 缺 7-Zip 时前端会把一个只验了 PE 头的包渲染成全绿。
       */
      sendJson(response, 200, {
        ok: report.ok,
        complete: report.complete,
        items: report.items,
        unverified: report.unverified.map((item) => item.id),
      })
    } catch (error) {
      const buildError = asBuildError(error)
      sendJson(response, 200, {
        ok: false,
        complete: false,
        code: buildError.code,
        message: buildError.message,
        items: [],
      })
    }
    return true
  }

  // --- 在访达里显示产物 ---
  if (path === '/api/reveal' && request.method === 'POST') {
    const body = await readBody(request)
    try {
      if (typeof body.path === 'string' && body.path !== '') {
        spawn('open', ['-R', body.path], { stdio: 'ignore', detached: true }).unref()
      }
      sendJson(response, 200, { ok: true })
    } catch (error) {
      sendJson(response, 200, { ok: false, message: error.message })
    }
    return true
  }

  // --- 探测目录里像不像一个可打包的项目 ---
  if (path === '/api/probe' && request.method === 'POST') {
    const body = await readBody(request)
    const target = resolve(String(body.path ?? ''))
    const isDir = await isDirectory(target)
    if (!isDir) {
      sendJson(response, 200, { ok: false, message: '不是一个目录' })
      return true
    }
    const findings = {}
    for (const candidate of ['package.json', 'mac2win.config.json', 'dist', 'build', 'out', 'src-tauri']) {
      findings[candidate] = existsSync(join(target, candidate))
    }
    sendJson(response, 200, { ok: true, path: target, findings })
    return true
  }

  return false
}

/**
 * 启动服务。
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot] 预填的项目目录。
 * @param {number} [options.port] 端口。默认 4321，被占用则顺延。
 * @param {boolean} [options.open] 是否自动打开浏览器。
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
export async function startServer(options = {}) {
  const { projectRoot, open = true } = options

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')

    void (async () => {
      try {
        if (url.pathname.startsWith('/api/')) {
          const handled = await handleApi(request, response, url)
          if (!handled) sendJson(response, 404, { message: '接口不存在' })
          return
        }
        serveStatic(url.pathname, response)
      } catch (error) {
        if (!response.headersSent) {
          sendJson(response, 500, { message: error.message })
        } else {
          response.end()
        }
      }
    })()
  })

  // 端口顺延：4321 常被别的开发服务占着。
  const startPort = options.port ?? 4321
  let port = startPort
  const maxAttempts = 20

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const bound = await new Promise((resolveBind) => {
      const onError = (error) => {
        server.off('listening', onListening)
        resolveBind(error.code === 'EADDRINUSE' ? null : error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolveBind(true)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })

    if (bound === true) break
    if (bound instanceof Error) throw bound
    port += 1
  }

  const url = `http://127.0.0.1:${String(port)}/${projectRoot === undefined ? '' : `?project=${encodeURIComponent(projectRoot)}`}`

  process.stdout.write(`\nmac2win 控制台已启动\n  ${url}\n\n按 Ctrl+C 退出\n`)

  if (open) {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
  }

  return {
    url,
    close: () => new Promise((resolveClose) => {
      for (const stream of state.streams) {
        try { stream.end() } catch { /* 已断 */ }
      }
      state.streams.clear()
      server.close(() => { resolveClose() })
    }),
  }
}