/**
 * console 看板的三档视口实测。
 *
 * ## 为什么需要这个脚本
 *
 * `style.css` 里那段「长串换行」的注释写着「375 / 768 / 1440 三档此前
 * 分别有 14 / 14 / 3 处溢出，加完这两条归零」。但当时留下这个数字的
 * 脚本没有进仓库 —— 结论没有复现路径，等于没有证据。
 *
 * 这个脚本把那次测量固化下来：起一个真实的 console 服务，用真实的
 * 无头 Chrome 渲染真实页面，在三档视口下量两件事：
 *
 *   1. **基线**：页面按真实数据渲染时，有没有元素跑出容器。
 *   2. **压测**：往报告类元素里注入 139 字符的深目录路径（macOS 常见），
 *      看长串会不会撑破布局。
 *
 * ## 为什么必须查「被裁掉」而不只是查横向滚动条
 *
 * `.panel` 上有 `overflow: hidden`。长串把网格撑爆时，内容是被**静默
 * 裁掉**的：页面不出现横向滚动条，看起来一切正常，但用户读不到完整
 * 路径和完整错误提示。只量 `document.scrollWidth` 会漏掉整整一类缺陷。
 *
 * 所以量的是「元素的外框有没有跑出它最近的裁剪祖先」—— 跑出去就说明
 * 那段文字被切了。
 *
 * ## 零依赖
 *
 * 直接走 Chrome DevTools Protocol，用 Node 22 内置的 `WebSocket`。
 * 不引 puppeteer / playwright：为了量几个矩形引入上百兆依赖，对一个
 * 零依赖项目不划算。
 *
 * ## 用法
 *
 *   node console/scripts/viewport-check.mjs            # 人读的表格
 *   node console/scripts/viewport-check.mjs --json      # stdout 只有 JSON
 *   node console/scripts/viewport-check.mjs --chrome /path/to/chrome
 *
 * 退出码：0 三档全部无溢出；1 有溢出（细节见输出）；2 环境缺 Chrome。
 * 退出码 2 与 1 分开，是为了让 CI 能区分「代码有缺陷」和「这台机器没装
 * 浏览器」—— 混成一个码会让人把环境问题当成代码问题去查。
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONSOLE_ROOT = resolve(HERE, '..')

/** 三档视口：iPhone 竖屏 / 平板竖屏 / 桌面。高度取常见值，不影响横向测量。 */
export const VIEWPORTS = [
  { name: '375', width: 375, height: 812 },
  { name: '768', width: 768, height: 1024 },
  { name: '1440', width: 1440, height: 900 },
]

/**
 * 压测用的长串。
 *
 * 139 个字符、不含空格 —— 这正是 macOS 深目录路径的形态，也是
 * `overflow-wrap: anywhere` 针对的场景。含空格的串会自己换行，测不出问题。
 *
 * 长度 139 与 `style.css` 里那段注释记录的数字保持一致，这样「注入同一
 * 个串、得到同一组溢出计数」是可复现的。测试 `viewport-check.test.mjs`
 * 断言这个长度，改动会立刻被发现。
 */
export const LONG_PATH = `/${'very-long-directory-name/'.repeat(3)}payload/MyApp2.app/Contents/Frameworks/Electron/runtime.tar.zst`

// ---------------------------------------------------------------------------
// 找 Chrome
// ---------------------------------------------------------------------------

/**
 * 找到可用的 Chrome / Chromium 可执行文件。
 *
 * 顺序：`--chrome` 参数 → 环境变量 → 各平台常见路径 → PATH。
 * 找不到返回 null，由调用方决定怎么处理 —— 不抛异常，因为「没装浏览器」
 * 是可预期的环境状态，不是程序错误。
 *
 * @param {string | undefined} explicit
 * @returns {string | null}
 */
export function findChrome(explicit) {
  if (typeof explicit === 'string' && explicit !== '') {
    return existsSync(explicit) ? explicit : null
  }
  if (typeof process.env.WACMIN_CHROME === 'string' && existsSync(process.env.WACMIN_CHROME)) {
    return process.env.WACMIN_CHROME
  }

  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  for (const name of ['google-chrome', 'chromium', 'chrome']) {
    try {
      const found = execFileSync('which', [name], { encoding: 'utf8' }).trim()
      if (found !== '') return found
    } catch {
      // 没这个命令，继续试下一个
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 最小 CDP 客户端
// ---------------------------------------------------------------------------

/**
 * Chrome DevTools Protocol 的最小客户端。
 *
 * 只做三件事：按 id 配对请求与响应、按 method 分发事件、带上 sessionId
 * 走扁平会话。够用就好 —— 完整实现 CDP 规范是另一个项目的工作量。
 */
class CdpClient {
  /** @param {WebSocket} socket */
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    /** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void}>} */
    this.pending = new Map()
    /** @type {Map<string, Array<(params: any) => void>>} */
    this.listeners = new Map()

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (typeof message.id === 'number') {
        const slot = this.pending.get(message.id)
        if (slot === undefined) return
        this.pending.delete(message.id)
        if (message.error !== undefined) {
          slot.reject(new Error(`${message.error.message ?? 'CDP 错误'}（${String(message.method ?? '')}）`))
        } else {
          slot.resolve(message.result)
        }
        return
      }
      for (const handler of this.listeners.get(message.method) ?? []) {
        handler(message.params)
      }
    })
  }

  /**
   * 连接一个 WebSocket 调试地址。
   *
   * @param {string} url
   * @returns {Promise<CdpClient>}
   */
  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve_, reject) => {
      socket.addEventListener('open', () => { resolve_() }, { once: true })
      socket.addEventListener('error', () => { reject(new Error(`无法连接调试端口：${url}`)) }, { once: true })
    })
    return new CdpClient(socket)
  }

  /**
   * 发一条 CDP 命令。
   *
   * **必须有超时。** 早期版本这里的 Promise 永不 settle：只要 Chrome 那边
   * 不回应，`await` 就永远挂着，进程既不输出也不退出。本仓库实测过一次：
   * 受限沙箱里 Chrome 自建 sandbox 失败、renderer 起不来，`Page.enable`
   * 永不回包 → 脚本静默挂死 6 分钟以上，看门狗和 CI 都以为它还在跑。
   * 「挂死」比「报错」难查得多，因为没有任何输出可看。
   *
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  send(method, params = {}, sessionId, timeoutMs = 20000) {
    const id = this.nextId
    this.nextId += 1
    const frame = { id, method, params }
    if (sessionId !== undefined) frame.sessionId = sessionId
    return new Promise((resolve_, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const err = new Error(`CDP 命令 ${method} 超时（${String(timeoutMs)}ms 无回应）`)
        err.cdpTimeout = true
        err.method = method
        reject(err)
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve_(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.socket.send(JSON.stringify(frame))
    })
  }

  /**
   * 等一个事件。
   *
   * @param {string} method
   * @param {number} timeoutMs
   * @returns {Promise<any>}
   */
  once(method, timeoutMs = 15000) {
    return new Promise((resolve_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`等待事件 ${method} 超时`))
      }, timeoutMs)
      const handler = (params) => {
        clearTimeout(timer)
        const list = this.listeners.get(method) ?? []
        this.listeners.set(method, list.filter((fn) => fn !== handler))
        resolve_(params)
      }
      const list = this.listeners.get(method) ?? []
      list.push(handler)
      this.listeners.set(method, list)
    })
  }

  close() {
    try {
      this.socket.close()
    } catch {
      // 已经断了，无所谓
    }
  }
}

// ---------------------------------------------------------------------------
// 页面内测量
// ---------------------------------------------------------------------------

/**
 * 在页面里跑的测量函数（会被序列化后送进浏览器执行）。
 *
 * ## 判定口径
 *
 * 对一个元素找它最近的「裁剪祖先」（`overflow` 不是 `visible` 的祖先），
 * 然后比外框：元素的左/右边缘超出祖先的左/右边缘超过 1px，就算溢出。
 *
 * 1px 的容差是必要的：亚像素布局会算出 0.5px 的偏差，卡死 0 会天天
 * 报假警。真正的溢出都是几十像素起步。
 *
 * ## 为什么光量元素外框不够（重要）
 *
 * 只量 `getBoundingClientRect()` 会漏掉整整一类溢出：**文字跑出盒子，
 * 盒子自己不长大**。典型例子是 `.check` 的 `grid-template-columns: 16px
 * 200px 1fr` —— 中间那列宽度被钉死在 200px，里面塞一个 139 字符的路径，
 * 列的宽度一分不变，文字直接盖到相邻列上。元素外框完全正常，量出来
 * 「0 处溢出」。
 *
 * 这个漏检真实发生过：把 `overflow-wrap` 摘掉做负向验证时，375px 报
 * 18 处、768px 与 1440px 报 0 处 —— 而宽屏下固定列更多，本该更糟。
 *
 * 所以每条文本节点都用 `Range.getClientRects()` 量**实际渲染出来的
 * 字形框**，再拿去比裁剪祖先。这才是用户眼睛看到的那条边界。
 *
 * 零宽元素跳过 —— 隐藏面板、空 span 的 `getBoundingClientRect()` 全是 0，
 * 会把它们的祖先左边缘当成溢出点，制造一堆噪音。
 *
 * @returns {{viewport: number, pageOverflow: number, offenders: object[]}}
 */
function measureInPage() {
  const doc = document.documentElement
  const viewport = doc.clientWidth
  const pageOverflow = Math.max(doc.scrollWidth, document.body.scrollWidth) - viewport

  const clipAncestor = (element) => {
    let parent = element.parentElement
    while (parent !== null) {
      const style = getComputedStyle(parent)
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') return parent
      parent = parent.parentElement
    }
    return doc
  }

  const describe = (element) => {
    const cls = typeof element.className === 'string' && element.className !== ''
      ? `.${element.className.trim().split(/\s+/u).join('.')}`
      : ''
    return `${element.tagName.toLowerCase()}${cls}`
  }

  /** 元素外框 + 文本字形框，两路都查；同一元素只记一条，取较重的那次。 */
  const found = new Map()
  const record = (element, ancestor, overflow) => {
    if (overflow <= 1) return
    const key = `${describe(element)}|${describe(ancestor)}`
    const previous = found.get(key)
    if (previous === undefined || previous.overflow < overflow) {
      found.set(key, {
        element: describe(element),
        container: describe(ancestor),
        overflow: Math.round(overflow * 10) / 10,
        text: (element.textContent ?? '').trim().slice(0, 60),
      })
    }
  }

  for (const element of document.body.querySelectorAll('*')) {
    const ancestor = clipAncestor(element)
    const box = ancestor.getBoundingClientRect()

    const rect = element.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      record(element, ancestor, Math.max(rect.right - box.right, box.left - rect.left))
    }

    /*
     * 文本字形框。只取直接子文本节点 —— 递归查每个元素会重复计算
     * 祖先已经包含的字形，把一条溢出记成十几条。
     */
    for (const node of element.childNodes) {
      if (node.nodeType !== 3) continue
      const content = node.textContent ?? ''
      if (content.trim() === '') continue

      const range = document.createRange()
      range.selectNodeContents(node)
      for (const glyph of range.getClientRects()) {
        if (glyph.width === 0 || glyph.height === 0) continue
        record(element, ancestor, Math.max(glyph.right - box.right, box.left - glyph.left))
      }
    }
  }

  return { viewport, pageOverflow, offenders: [...found.values()] }
}

/**
 * 压测注入：把报告类容器填成最坏情况。
 *
 * ## 为什么必须造节点，而不是改现有元素的文字
 *
 * 最初这版是 `querySelectorAll('.stage-msg')` 再改 `textContent`。它看起来
 * 能跑、结果永远「0 处溢出」—— 因为页面刚加载完时这些容器**全是空的**：
 * 阶段行、校验行、结果行要等用户点一次构建才会由 `app.js` 拼出来。对空
 * 集合赋值等于什么都没做，于是这个脚本曾经连续通过却什么都没测。
 *
 * 教训是负向验证救的命：把 `overflow-wrap` 摘掉再跑，仍然报「无溢出」，
 * 才能发现压测本身是空转。
 *
 * 所以这里按 `app.js` 的真实 DOM 结构造行（同样的类名、同样的网格层级），
 * 塞进真实容器，再用长串填满会发生溢出的那几个位置。
 *
 * 注入的每个位置都对应真实渲染路径里会放用户路径或安装器输出的地方。
 */
const STRESS_SNIPPET = `
(() => {
  const path = ${JSON.stringify(LONG_PATH)}
  const make = (tag, cls, text) => {
    const node = document.createElement(tag)
    if (cls !== '') node.className = cls
    if (text !== undefined) node.textContent = text
    return node
  }

  // 让所有面板可见：隐藏面板宽度为 0，测不出溢出
  for (const id of ['contract-panel', 'history-panel', 'job-panel']) {
    const panel = document.getElementById(id)
    if (panel !== null) panel.hidden = false
  }
  for (const id of ['checks-wrap', 'result']) {
    const node = document.getElementById(id)
    if (node !== null) node.hidden = false
  }

  // 方向卡片：真实页面会渲染四张，这里保证至少四张，摘要填长串
  const dirs = document.getElementById('directions')
  if (dirs !== null) {
    while (dirs.children.length < 4) {
      const card = make('div', 'dir-card')
      const head = make('div', 'dir-head')
      head.append(make('span', 'dir-id', 'Mac2Win'), make('span', 'badge', 'mac2win'))
      const actions = make('div', 'dir-actions')
      actions.append(make('button', 'btn', '自检'), make('button', 'btn', '构建'))
      card.append(head, make('div', 'dir-summary', ''), actions)
      dirs.append(card)
    }
    for (const node of dirs.querySelectorAll('.dir-summary')) {
      node.textContent = '把 macOS 应用打包成 Windows 可执行文件：' + path
    }
  }

  // 阶段行：mark / name / time / msg 四段，与 app.js 的 renderStages 一致
  const stages = document.getElementById('stages')
  if (stages !== null) {
    stages.replaceChildren()
    for (let i = 0; i < 3; i += 1) {
      const row = make('div', 'stage failed')
      row.append(
        make('span', 'stage-mark', '✗'),
        make('span', 'stage-name', path),
        make('span', 'stage-time', '12345ms'),
        make('span', 'stage-msg', path),
      )
      stages.append(row)
    }
  }

  // 校验项：mark / name / detail
  const checks = document.getElementById('checks')
  if (checks !== null) {
    checks.replaceChildren()
    for (let i = 0; i < 3; i += 1) {
      const row = make('div', 'check fail')
      row.append(
        make('span', 'check-mark', '✗'),
        make('span', 'check-name', path),
        make('span', 'check-detail', path),
      )
      checks.append(row)
    }
  }

  // 历史行：四段，与 app.js 的 historyRow 渲染一致
  const history = document.getElementById('history-body')
  if (history !== null) {
    history.replaceChildren()
    for (let i = 0; i < 3; i += 1) {
      const row = make('div', 'history-row fail')
      row.append(
        make('span', 'check-mark', '✗'),
        make('span', 'history-label', 'mac2win build ' + path),
        make('span', 'history-time', '13:43:42'),
        make('span', 'history-meta', '37719ms · 1 个产物'),
      )
      history.append(row)
    }
  }

  // 结果区：错误框 + 结果行（含产物路径）
  const result = document.getElementById('result')
  if (result !== null) {
    result.replaceChildren()
    const box = make('div', 'error-box')
    box.append(
      make('span', 'error-code', 'E-4001'),
      make('span', 'error-msg', '找不到运行时可执行文件：' + path),
      make('span', 'error-hint', '请检查 ' + path + ' 是否存在'),
    )
    result.append(box)
    for (let i = 0; i < 2; i += 1) {
      const line = make('div', 'result-line')
      line.append(make('span', 'result-key', '产物'), make('span', 'result-val fail', path))
      result.append(line)
    }
  }

  // 契约面板：问题行是长串最容易撑破的地方
  const contract = document.getElementById('contract-body')
  if (contract !== null) {
    contract.replaceChildren()
    const block = make('div', 'contract-dir')
    const head = make('div', 'contract-dir-head')
    head.append(make('span', 'check-mark', '✗'), make('span', '', 'mac2win'))
    block.append(head)
    for (let i = 0; i < 3; i += 1) {
      const scenario = make('div', 'contract-scenario')
      scenario.append(make('span', 'check-mark', '✗'), make('span', '', 'build 最小项目'))
      block.append(scenario)
      block.append(make('div', 'contract-problem', '[exit-code] 报告里的 exitCode 与进程实际退出码不一致：' + path))
    }
    contract.append(block)
  }

  return true
})()
`

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 起一个隔离的 chrome 实例。
 *
 * `--user-data-dir` 指到临时目录是必须的：共用一个 profile 会和用户
 * 自己开着的 Chrome 抢锁，直接启动失败。
 *
 * ## `--no-sandbox` 为什么是**第二档**而不是默认
 *
 * 有些受限环境（容器、受限沙箱、部分 CI runner）不允许 Chrome 建自己的
 * sandbox，报 `sandbox initialization failed: Operation not permitted`，
 * renderer 起不来。表现不是启动失败，而是**起来了但不干活** ——
 * `DevToolsActivePort` 照常写出、WebSocket 照常能连，只有 `Page.enable`
 * 之类的命令永远不回包。本仓库实测过这个形态。
 *
 * 但 `--no-sandbox` 会削弱隔离，不该无条件带上。所以先按正常参数起，
 * 只有「命令超时」这一种失败才降级重试一次，并在返回值里标明降级过，
 * 免得有人以为默认就是这么跑的。
 *
 * @param {string} chrome
 * @param {{noSandbox?: boolean}} [options]
 * @returns {Promise<{process: import('node:child_process').ChildProcess, port: number, wsUrl: string, profileDir: string, noSandbox: boolean}>}
 */
async function launchChrome(chrome, options = {}) {
  const noSandbox = options.noSandbox === true
  const profileDir = await mkdtemp(join(tmpdir(), 'wacmin-viewport-'))
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ]
  if (noSandbox) args.unshift('--no-sandbox')
  const child = spawn(chrome, args, { stdio: 'ignore' })

  /*
   * Chrome 把实际端口写进 profile 里的 `DevToolsActivePort`：
   * 第一行端口，第二行 ws 路径。轮询等它出现 —— 没有比这更可靠的
   * 拿端口方式，因为 `--remote-debugging-port=0` 就是随机端口。
   */
  const portFile = join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const content = await readFile(portFile, 'utf8')
      const [portLine, wsPath] = content.split('\n')
      const port = Number.parseInt(portLine, 10)
      if (Number.isInteger(port) && port > 0 && typeof wsPath === 'string') {
        return { process: child, port, wsUrl: `ws://127.0.0.1:${port}${wsPath.trim()}`, profileDir, noSandbox }
      }
    }
    await new Promise((r) => { setTimeout(r, 100) })
  }

  child.kill('SIGKILL')
  throw new Error('Chrome 启动后 20 秒内没有写出调试端口')
}

/**
 * 在已启动的 Chrome 上跑完整的三档量测。
 *
 * 抽成独立函数是为了能「同一套流程跑两次」：第一次正常参数，遇到
 * 沙箱导致的命令超时再用 `--no-sandbox` 重跑一次。把流程复制两遍
 * 会让两档悄悄漂移，所以只留一份。
 *
 * @param {{chrome: string, server: {port: number}, noSandbox?: boolean}} ctx
 * @returns {Promise<{results: object[], noSandbox: boolean}>}
 */
async function measureAllViewports(ctx) {
  const browser = await launchChrome(ctx.chrome, { noSandbox: ctx.noSandbox === true })
  let client
  try {
    client = await CdpClient.connect(browser.wsUrl)

    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })

    await client.send('Page.enable', undefined, sessionId)
    await client.send('Runtime.enable', undefined, sessionId)

    const results = []
    for (const viewport of VIEWPORTS) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.width < 600,
      }, sessionId)

      const loaded = client.once('Page.loadEventFired')
      await client.send('Page.navigate', { url: `http://127.0.0.1:${String(ctx.server.port)}/` }, sessionId)
      await loaded

      /*
       * 等一拍再量。页面 init() 是 async 的：方向列表与历史是两个
       * fetch，量太早会拿到「正在读取方向状态…」那个占位块，宽度
       * 和真实卡片完全不同。
       */
      await new Promise((r) => { setTimeout(r, 700) })

      const baseline = await evaluate(client, sessionId, measureInPage)
      await evaluate(client, sessionId, STRESS_SNIPPET)
      await new Promise((r) => { setTimeout(r, 120) })
      const stress = await evaluate(client, sessionId, measureInPage)

      results.push({ viewport: viewport.name, width: viewport.width, baseline, stress })
    }

    return { results, noSandbox: browser.noSandbox }
  } finally {
    if (client !== undefined) client.close()
    browser.process.kill('SIGKILL')
    await rm(browser.profileDir, { recursive: true, force: true })
  }
}

/**
 * 跑一轮检查。
 *
 * @param {{chrome?: string, noSandbox?: boolean}} [options]
 * @returns {Promise<{ok: boolean, reason?: string, results?: object[], chrome?: string, noSandbox?: boolean, fallbackReason?: string}>}
 */
export async function runViewportCheck(options = {}) {
  const chrome = findChrome(options.chrome)
  if (chrome === null) {
    return { ok: false, reason: 'no-chrome' }
  }

  // 历史文件写到临时目录，别污染开发者真实看板的历史
  const homeDir = await mkdtemp(join(tmpdir(), 'wacmin-console-home-'))
  process.env.WACMIN_HOME = homeDir

  const { startServer } = await import('../src/server.mjs')
  const server = await startServer({ port: 0 })

  try {
    let attempted
    try {
      attempted = await measureAllViewports({ chrome, server, noSandbox: options.noSandbox === true })
    } catch (error) {
      /*
       * 只在「命令超时」这一种失败上降级。别的错误（找不到 Chrome、
       * 服务端没起、页面内脚本抛异常）跟沙箱无关，重试只是把同一个
       * 错误再犯一遍，还会掩盖真实原因。
       */
      const sandboxSuspected = error?.cdpTimeout === true
      if (!sandboxSuspected || options.noSandbox === true) throw error
      attempted = await measureAllViewports({ chrome, server, noSandbox: true })
      attempted.fallbackReason = `首次以默认参数启动时 ${String(error.method ?? 'CDP')} 超时，已用 --no-sandbox 重跑一次`
    }

    const { results } = attempted
    const ok = results.every((row) =>
      row.baseline.pageOverflow <= 0 && row.baseline.offenders.length === 0
      && row.stress.pageOverflow <= 0 && row.stress.offenders.length === 0)

    return {
      ok,
      results,
      chrome,
      noSandbox: attempted.noSandbox,
      ...(attempted.fallbackReason === undefined ? {} : { fallbackReason: attempted.fallbackReason }),
    }
  } finally {
    await server.close()
    await rm(homeDir, { recursive: true, force: true })
  }
}

/**
 * 在页面里执行一个函数并取返回值。
 *
 * `Runtime.evaluate` 只接受字符串表达式，所以要 `(${fn})()` 包一层。
 * `returnByValue` 让结果直接是 JSON 值而不是 RemoteObject 引用。
 *
 * @param {CdpClient} client
 * @param {string} sessionId
 * @param {Function | string} fn
 * @returns {Promise<any>}
 */
async function evaluate(client, sessionId, fn) {
  const expression = typeof fn === 'string' ? fn : `(${String(fn)})()`
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId)
  if (exceptionDetails !== undefined) {
    throw new Error(`页面内执行失败：${exceptionDetails.text ?? '未知异常'}`)
  }
  return result.value
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** 把一轮结果画成人读的表格。 */
function formatReport(payload) {
  const lines = []
  for (const row of payload.results) {
    lines.push(`视口 ${row.viewport}×（宽 ${String(row.width)}px）`)
    for (const [label, data] of [['基线', row.baseline], ['压测', row.stress]]) {
      const overflow = data.pageOverflow > 0 ? `页面横向溢出 ${String(data.pageOverflow)}px` : '页面横向溢出 0px'
      lines.push(`  ${label}：${overflow}，越界元素 ${String(data.offenders.length)} 处`)
      for (const offender of data.offenders.slice(0, 5)) {
        lines.push(`    · ${offender.element} 超出 ${offender.container} ${String(offender.overflow)}px`)
      }
      if (data.offenders.length > 5) {
        lines.push(`    …另有 ${String(data.offenders.length - 5)} 处`)
      }
    }
  }
  lines.push(payload.ok ? '✓ 三档视口均无溢出' : '✗ 存在溢出，见上')
  return lines.join('\n')
}

async function main() {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const chromeIndex = argv.indexOf('--chrome')
  const chrome = chromeIndex === -1 ? undefined : argv[chromeIndex + 1]
  const noSandbox = argv.includes('--no-sandbox')

  const payload = await runViewportCheck({ chrome, noSandbox })

  if (payload.reason === 'no-chrome') {
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: false, reason: 'no-chrome' })}\n`)
    } else {
      process.stderr.write('✗ 没有找到 Chrome / Chromium，无法实测视口\n')
      process.stderr.write('  可指定路径：node console/scripts/viewport-check.mjs --chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"\n')
    }
    process.exitCode = 2
    return
  }

  if (payload.fallbackReason !== undefined) {
    process.stderr.write(`· ${payload.fallbackReason}\n`)
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok: payload.ok,
      chrome: payload.chrome,
      noSandbox: payload.noSandbox === true,
      ...(payload.fallbackReason === undefined ? {} : { fallbackReason: payload.fallbackReason }),
      results: payload.results,
    })}\n`)
  } else {
    process.stdout.write(`${formatReport(payload)}\n`)
    if (payload.noSandbox === true) {
      process.stdout.write('  注：本次以 --no-sandbox 运行（受限环境下 Chrome 自建沙箱失败）\n')
    }
  }
  process.exitCode = payload.ok ? 0 : 1
}

// 只在被直接执行时跑 CLI；被 import（测试）时只提供导出
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
