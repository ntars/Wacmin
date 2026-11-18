/**
 * 打包后的应用启动器（bootstrap）。
 *
 * ## 这个文件跑在哪
 *
 * 跑在**目标 Windows 机器上**，由安装包里的 `node.exe` 执行。它不能用
 * 任何第三方依赖——那台机器上只有安装目录里这一份运行时，没有任何
 * `node_modules` 供它解析。所以全文只用 Node 标准库。
 *
 * ## 它解决的四件事
 *
 * 1. **托管宿主进程**。宿主（用户项目的服务端）需要一个「父进程还活着」
 *    的信号：它监听 stdin 的 EOF，管道一关就自己退出。所以不能让启动器
 *    用完就退——这里用 pipe 起子进程，并一直握着那条 stdin。
 * 2. **给前端提供静态文件**。浏览器模式没有 Tauri 那层 `tauri://localhost`，
 *    必须自己把 `ui/` 目录用 HTTP 服务出去。
 * 3. **把连接信息交给页面**。宿主启动后才生成令牌，页面必须能拿到它。
 *    这里写一份 `runtime.json` 到静态根下，页面同源取。
 * 4. **打开窗口**。用系统默认浏览器打开页面——这是「没有 Rust 壳」时
 *    最接近桌面应用体验的做法，也是本项目兼容性边界的来源。
 *
 * ## 关闭链路
 *
 * 页面上的关闭按钮 → 调 shim 的 `resolve_close` → POST `/__mac2win/quit`
 * → 这里杀掉宿主子进程 → 启动器（NSIS 的 nsExec）随之返回 → 进程全退。
 * 不留孤儿进程。
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/** 安装目录布局。与打包阶段生成的目录结构一一对应，改一处必须改两处。 */
const LAYOUT = {
  ui: join(root, 'ui'),
  host: join(root, 'host'),
  data: join(root, 'data'),
}

/** 读打包时写下的清单。它记录了入口脚本相对 `host/` 的路径。 */
function readManifest() {
  const path = join(here, 'launch.json')
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fatal(`读不到启动清单 ${path}：${error.message}`)
  }
}

const manifest = readManifest()

/** 一条日志。同时写 stderr 与 data 目录下的日志文件。 */
function log(message) {
  const line = `[bootstrap] ${message}`
  process.stderr.write(`${line}\n`)
  try {
    mkdirSync(LAYOUT.data, { recursive: true })
    writeFileSync(join(LAYOUT.data, 'launcher.log'), `${new Date().toISOString()} ${line}\n`, { flag: 'a' })
  } catch {
    /* 日志写不进去不该拦住启动 */
  }
}

/** 致命错误：写日志、弹一个系统消息框、退出。 */
function fatal(message) {
  log(`致命错误：${message}`)
  /*
   * 用 mshta 弹框而不是退出码：用户是双击 exe 启动的，控制台被隐藏，
   * 只看退出码等于什么都没看到。这是 Windows 上不依赖任何运行时
   * 弹一个原生对话框的最省事办法。
   *
   * 弹不出来也不能卡住——所以 spawn 的 error 事件必须挂上，
   * 否则它会冒到 uncaughtException，在一个「正在报错」的路径上
   * 再抛一次错，日志就彻底乱了。
   */
  try {
    const script = `mshta "javascript:alert('启动失败\\n\\n${message.replace(/['"\\]/g, '')}');close()"`
    const child = spawn('cmd', ['/c', script], { stdio: 'ignore', windowsHide: true, detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    /* 弹不出来也不能卡住 */
  }
  process.exit(1)
}

/** MIME 类型表。只覆盖前端产物会用到的那些。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
}

/**
 * 静态文件服务。
 *
 * 只服务 `ui/` 下的文件，并且拒绝任何跳出该目录的路径——否则
 * `GET /../../node.exe` 就能把运行时下走。这类路径穿越是静态服务的
 * 经典漏洞，判断方式是把路径 normalize 后确认仍在根目录内。
 */
function createStaticServer() {
  const uiRoot = LAYOUT.ui

  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')

    // 控制接口：让页面能把应用关掉。
    if (url.pathname === '/__mac2win/quit' && request.method === 'POST') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
      log('收到退出请求，正在关闭')
      shutdown(0)
      return
    }

    // 心跳：页面每隔一会儿探一次，用来判断「还有没有窗口开着」。
    if (url.pathname === '/__mac2win/ping') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, at: Date.now() }))
      return
    }

    let pathname
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      response.writeHead(400).end('路径编码不合法')
      return
    }
    if (pathname === '/') pathname = '/index.html'

    const target = normalize(join(uiRoot, pathname))
    // 必须校验：normalize 之后仍在 uiRoot 之内。
    if (target !== uiRoot && !target.startsWith(uiRoot + sep)) {
      response.writeHead(403).end('禁止访问')
      return
    }

    let finalPath = target
    if (existsSync(finalPath) && statSync(finalPath).isDirectory()) {
      finalPath = join(finalPath, 'index.html')
    }
    if (!existsSync(finalPath)) {
      // 单页应用：找不到的路径回 index.html，让前端路由自己处理。
      const fallback = join(uiRoot, 'index.html')
      if (existsSync(fallback)) {
        serveFile(fallback, response)
        return
      }
      response.writeHead(404).end('文件不存在')
      return
    }

    serveFile(finalPath, response)
  })
}

/** 把一个文件写进响应。 */
function serveFile(path, response) {
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
  response.writeHead(200, {
    'content-type': type,
    // 页面与它的资源每次都要重新校验：开发迭代时改了文件能立刻生效，
    // 而这个应用的资源就在本机，缓存收益本来也不大。
    'cache-control': 'no-cache',
  })
  createReadStream(path).pipe(response)
}

/** 已写入的连接信息，供静态服务读取。 */
let runtimeState = null

/** 把连接信息写到静态根下，供页面同源读取。 */
function publishRuntimeState(state) {
  runtimeState = state
  const target = join(LAYOUT.ui, 'runtime.json')
  try {
    mkdirSync(LAYOUT.ui, { recursive: true })
    writeFileSync(target, JSON.stringify(state, undefined, 2))
  } catch (error) {
    log(`写连接信息失败：${error.message}`)
  }
}

/** 宿主子进程。 */
let hostProcess = null
/** 是否已经在关闭流程里，避免重复清理。 */
let closing = false

/**
 * 启动宿主。
 *
 * 关键点：`stdio` 必须是 `pipe`。宿主把 stdout 当协议通道、把 stdin 的
 * EOF 当「父进程死了」的信号。给 `inherit` 会让它的输出混进启动器的
 * 输出，给 `ignore` 会让它立刻收到 EOF 然后退出。
 */
function startHost() {
  if (manifest.entry === null) {
    log('未配置宿主入口，只提供静态前端')
    return
  }

  const entryPath = join(LAYOUT.host, manifest.entry)
  if (!existsSync(entryPath)) {
    fatal(`宿主入口不存在：${entryPath}`)
  }

  const args = [...manifest.nodeArgs, entryPath]
  log(`启动宿主 ${process.execPath} ${args.join(' ')}`)

  /*
   * 让宿主知道「它的同级目录在哪」。
   *
   * 原项目的宿主按 `<宿主目录>/../../dsh-sidecar` 找内核——这是 Tauri
   * 版的 `Resources/` 布局（`Resources/cordis-host` 与
   * `Resources/dsh-sidecar` 同级）。
   *
   * 我们的布局是 `app/host` 与 `app/dsh-sidecar`，同样同级，所以这个
   * 默认路径其实是对的。但用户的项目未必用这个约定，所以只要清单里
   * 给了 sidecar 的相对路径，就用环境变量显式告诉宿主——这比猜路径
   * 可靠，也是宿主自己支持的机制。
   */
  const env = {
    ...process.env,
    ...manifest.env,
    ...(manifest.dataEnv === null ? {} : { [manifest.dataEnv]: LAYOUT.data }),
  }
  if (typeof manifest.sidecarEntry === 'string' && manifest.sidecarEntry !== '') {
    const sidecarPath = join(LAYOUT.host, manifest.sidecarEntry)
    if (existsSync(sidecarPath)) env.ONDRA_SIDECAR_ENTRY = sidecarPath
  }

  hostProcess = spawn(process.execPath, args, {
    cwd: join(LAYOUT.host),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env,
  })

  /*
   * 逐行读 stdout。宿主在就绪时写一行 `{"type":"ready","url":…,"token":…}`。
   * 这里必须按行切：一行 JSON 可能被拆成多个 chunk，也可能一个 chunk
   * 里有多行。
   */
  let pending = ''
  hostProcess.stdout.setEncoding('utf8')
  hostProcess.stdout.on('data', (chunk) => {
    pending += chunk
    let index
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index).trim()
      pending = pending.slice(index + 1)
      if (line === '') continue
      handleHostLine(line)
    }
  })

  hostProcess.stderr.setEncoding('utf8')
  hostProcess.stderr.on('data', (chunk) => {
    // 宿主日志原样转到启动器日志，出事时只有这一份可查。
    for (const line of String(chunk).split('\n')) {
      if (line.trim() !== '') log(`宿主: ${line}`)
    }
  })

  hostProcess.on('error', (error) => {
    fatal(`宿主进程启动失败：${error.message}`)
  })

  hostProcess.on('exit', (code, signal) => {
    log(`宿主已退出 code=${String(code)} signal=${String(signal)}`)
    if (!closing) {
      // 宿主意外退出，整个应用没有意义了，跟着退。
      shutdown(code ?? 1)
    }
  })
}

/** 处理宿主 stdout 的一行。 */
function handleHostLine(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    log(`宿主输出（非协议）：${line}`)
    return
  }

  if (message !== null && typeof message === 'object' && message.type === 'ready') {
    log(`宿主就绪 ${message.url}`)
    publishRuntimeState({
      url: message.url,
      token: message.token,
      port: message.port,
      uiUrl: uiUrl(),
      at: Date.now(),
    })
    openBrowser()
    return
  }

  if (message !== null && typeof message === 'object' && message.type === 'fatal') {
    fatal(`宿主报告错误：${message.message}`)
    return
  }

  log(`宿主输出：${line}`)
}

/** 静态服务的访问地址。 */
let staticPort = 0
function uiUrl() {
  return `http://127.0.0.1:${String(staticPort)}/index.html`
}

/**
 * 用系统默认浏览器打开页面。
 *
 * ## 失败不能是致命的
 *
 * 打开浏览器依赖外部命令（`cmd /c start`）。这条命令失败的原因很多：
 * 系统策略禁用了 cmd、默认浏览器关联坏了、杀毒软件拦了。
 * 任何一种都不该让整个应用退出——静态服务已经起来了，用户手动
 * 把地址粘进浏览器就能用。所以这里只记日志，不抛错。
 */
function openBrowser() {
  const url = uiUrl()
  log(`打开界面 ${url}`)
  try {
    /*
     * `cmd /c start "" <url>` 是 Windows 上打开默认浏览器最稳的方式。
     * 第一个空参数是窗口标题占位——不写它，URL 会被当成标题，
     * 结果是浏览器根本没被打开。
     */
    const child = spawn('cmd', ['/c', 'start', '', url], {
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
    })
    // `spawn` 的失败是异步的（命令不存在时抛 error 事件而不是异常）。
    // 必须挂监听，否则会冒到 uncaughtException 把进程带走。
    child.on('error', (error) => {
      log(`打开浏览器失败：${error.message}。请手动访问 ${url}`)
    })
    child.unref()
  } catch (error) {
    log(`打开浏览器失败：${error.message}。请手动访问 ${url}`)
  }
}

/** 收尾：关宿主、关服务、退出。 */
function shutdown(code) {
  if (closing) return
  closing = true
  log('正在退出')

  try {
    // 先关 stdin：宿主靠这个信号做优雅清理（它要落盘日志、销毁插件）。
    hostProcess?.stdin?.end()
  } catch {
    /* 管道可能已经断了 */
  }

  // 给宿主一点时间自己退；超时就强杀，绝不留孤儿进程。
  const timer = setTimeout(() => {
    try {
      hostProcess?.kill()
    } catch {
      /* 已经没了 */
    }
    process.exit(code)
  }, 4000)
  timer.unref()

  if (hostProcess !== null) {
    hostProcess.once('exit', () => {
      clearTimeout(timer)
      process.exit(code)
    })
  } else {
    clearTimeout(timer)
    process.exit(code)
  }
}

/** 主流程。 */
function main() {
  mkdirSync(LAYOUT.data, { recursive: true })
  log(`启动器就绪，安装目录 ${root}`)
  log(`Node 版本 ${process.version}，平台 ${process.platform}`)
  log(`框架 ${manifest.framework ?? '未知'}，原生壳 ${manifest.shellExe ?? '无'}`)

  /*
   * 原生壳模式（Electron / NW.js）。
   *
   * 这两种框架自带窗口，不需要静态服务也不需要拉宿主——直接把壳拉起来
   * 就完事。启动器在这条路上只做三件事：检查文件在不在、拉起壳、
   * 等壳退出。
   *
   * 为什么还要经过启动器：NSIS 的快捷方式只能指向一个 exe，而
   * 「应用目录在哪」只有启动器知道（用户可能装在任意路径）。
   * 让启动器当这层转接，快捷方式就能固定指向它。
   */
  if (manifest.shellExe !== null && manifest.shellExe !== undefined) {
    launchNativeShell()
    return
  }

  if (manifest.entry === null && !existsSync(join(LAYOUT.ui, 'index.html'))) {
    fatal('安装包里既没有宿主入口也没有前端页面，无法启动')
  }

  // 先起静态服务：端口拿到之后才能算出页面地址，而宿主就绪时要立刻用它。
  const server = createStaticServer()
  server.on('error', (error) => {
    fatal(`静态服务启动失败：${error.message}`)
  })
  server.listen(0, '127.0.0.1', () => {
    staticPort = server.address().port
    log(`静态服务 127.0.0.1:${String(staticPort)}`)

    // 页面在宿主就绪前加载时也要能拿到东西，先写一份 pending。
    publishRuntimeState({ pending: true, uiUrl: uiUrl(), at: Date.now() })

    startHost()

    // 没有宿主时（纯静态前端），立刻开浏览器。
    if (manifest.entry === null) openBrowser()
  })
}

/**
 * 拉起原生壳（Electron / NW.js）。
 *
 * ## 为什么用 detached: false 并等它退出
 *
 * 启动器是「父进程」。如果它先退出，Windows 上壳会变成孤儿进程，
 * 用户从任务管理器里看不到父子关系，也没法通过关窗口把启动器一起收掉。
 * 保持父子关系、等壳退出再退，进程树才是干净的。
 */
function launchNativeShell() {
  let shellPath = join(root, manifest.shellExe)

  /*
   * 兜底：清单里的名字对不上时，在同一个目录里找一个 exe。
   *
   * 为什么需要这一层：Electron / NW.js 的主程序名在打包时被改成产品名。
   * 如果产品名里有空格、中文、或用户后来手改了文件名，清单里的路径
   * 就会失效。此时与其报「原生壳不存在」让用户猜，不如把那个目录里
   * 唯一的主程序找出来——那种目录里除了壳本身不会有第二个 exe
   * （Chromium 的辅助程序都在子目录里）。
   *
   * 找不到才报错。
   */
  if (!existsSync(shellPath)) {
    const dir = dirname(shellPath)
    if (existsSync(dir)) {
      const candidates = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.exe'))
      if (candidates.length === 1) {
        const fallback = join(dir, candidates[0])
        log(`清单里的 ${manifest.shellExe} 不存在，改用 ${candidates[0]}`)
        shellPath = fallback
      } else {
        fatal(`原生壳不存在：${shellPath}（该目录下找到 ${String(candidates.length)} 个 exe）`)
      }
    } else {
      fatal(`原生壳目录不存在：${dir}`)
    }
  }

  log(`启动原生壳 ${shellPath}`)
  const child = spawn(shellPath, [], {
    cwd: dirname(shellPath),
    stdio: 'ignore',
    windowsHide: false,
    env: {
      ...process.env,
      ...manifest.env,
      ...(manifest.dataEnv === null ? {} : { [manifest.dataEnv]: LAYOUT.data }),
    },
  })

  child.on('error', (error) => {
    fatal(`原生壳启动失败：${error.message}`)
  })

  child.on('exit', (code, signal) => {
    log(`原生壳已退出 code=${String(code)} signal=${String(signal)}`)
    process.exit(code ?? 0)
  })
}

/*
 * 兜底：任何未捕获异常都要留下痕迹再退。
 * 用户看到的是「闪一下就没了」，而日志里有完整原因。
 */
process.on('uncaughtException', (error) => {
  fatal(`未捕获异常：${error.stack ?? error.message}`)
})
process.on('unhandledRejection', (reason) => {
  fatal(`未处理的 Promise 拒绝：${String(reason)}`)
})

main()