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
 * 无头 Chrome 渲染真实页面，在三档视口下量三件事：
 *
 *   1. **基线**：页面按真实数据渲染时，有没有元素跑出容器。
 *   2. **压测**：往报告类元素里注入 139 字符的深目录路径（macOS 常见），
 *      看长串会不会撑破布局。
 *   3. **触控**：模拟粗指针（手指）设备后，可点元素的命中区够不够大，
 *      以及放大后的按钮有没有反过来撑破布局。
 *
 * ## 为什么第 3 项不能用视口宽度判断
 *
 * 「375px 屏 = 手机 = 手指」是错的。1440px 的触屏笔记本、桌面浏览器
 * 里打开的 375px 响应式预览，都会让宽度判据给出与实际输入方式相反的
 * 答案。CSS 侧用的是 `@media (pointer: coarse)` —— 它描述**输入设备
 * 本身**，与宽度无关。所以这里也用 `Emulation.setTouchEmulationEnabled`
 * 让 `pointer: coarse` 真的成立，而不是把宽视口跳过。
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

/**
 * 触控目标的最小边长。
 *
 * 44pt 取自 Apple HIG 的最小点击目标（44×44pt）；Android Material 给的是
 * 48dp，取 44 与 HIG 对齐。手指落点误差约 7–10mm，24px（约 6.3mm）确实
 * 会点错 —— 四个方向卡片的按钮并排时，想点「自检」点到「构建」，后果是
 * 真的开始一次构建。
 *
 * 只在 `pointer: coarse` 下要求，细指针（鼠标）不受此约束：鼠标精度远
 * 高于手指，桌面端强行撑到 44px 只会把紧凑的终端风格看板变松散。
 */
export const MIN_TOUCH_TARGET = 44

/**
 * 压测覆盖的容器 —— 真实渲染路径里会放用户路径或安装器输出的位置。
 *
 * 这份清单必须与 `app.js` 的渲染点一致：多列一个不存在的选择器会让
 * 检查报「元素缺失」，少列一个则那处永远不被量。测试
 * `viewport-check.test.mjs` 逐一核对它与 `app.js` 里的类名对得上。
 */
export const LONG_TEXT_SELECTORS = [
  '.dir-summary',
  '.stage-name',
  '.stage-msg',
  '.check-name',
  '.check-detail',
  '.error-msg',
  '.error-hint',
  '.result-val',
  '.contract-problem',
]

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
 * 在页面里量长串的**断行质量**（会被序列化后送进浏览器执行）。
 *
 * ## 为什么「不溢出」还不够
 *
 * `overflow-wrap: anywhere` 能把任何一个长串压进容器，代价是**断在任意
 * 字符之间**。实测 375px 下 `Electron/runtime.tar.zst` 被劈成 `Elec|tron`、
 * `dir|ectory`，读的人得在两行之间自己拼回一个单词。页面不溢出、不失真、
 * 测试全绿 —— 只有真正读它的人受影响。
 *
 * ## 口径
 *
 * 一次断行算「断在词中间」，当且仅当断点**前一个字符**与**后一个字符**
 * 都属于 `[A-Za-z0-9._]`：
 *
 *   - 中文在字间断行是正常排版，不算；
 *   - 断在 `/` `\` `-` `空格` `:` 之后是路径与标识符的天然边界，不算；
 *   - `dir|ectory` 这种把一个不可分词劈成两半，才是真缺陷。
 *
 * ## 为什么要逐字符量
 *
 * 行尾字符不可能从 `Range.getClientRects()` 直接读到 —— 那些矩形只给
 * 位置不给内容。所以逐字符建 range、按 `top` 归行，再把每行还原成字符串。
 * 一个 139 字符的串只有几百次 range 操作，代价可忽略；换来的是「断在哪
 * 个字上」这个能直接读懂的结论。
 *
 * @param {string[]} selectors 要检查的容器选择器
 * @returns {{selector: string, missing?: boolean, lines: number, dirty: number, samples: string[]}[]}
 */
function measureLineBreaksInPage(selectors) {
  /** 不可分词字符集。两侧都命中才算词被劈开。 */
  const ATOMIC = /[A-Za-z0-9._]/u

  const describe = (element) => {
    const cls = typeof element.className === 'string' && element.className !== ''
      ? `.${element.className.trim().split(/\s+/u).join('.')}`
      : ''
    return `${element.tagName.toLowerCase()}${cls}`
  }

  /** 逐字符取位置，再按 top 归行，返回每行的文本。 */
  const linesOf = (host) => {
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
    const chars = []
    let textNode = walker.nextNode()
    while (textNode !== null) {
      for (let i = 0; i < textNode.data.length; i += 1) {
        const range = document.createRange()
        range.setStart(textNode, i)
        range.setEnd(textNode, i + 1)
        const rect = range.getBoundingClientRect()
        // <wbr> 自身不产生字形，两侧字符的 top 相同，不影响归行
        if (rect.width === 0 && rect.height === 0) continue
        chars.push({ ch: textNode.data[i], top: Math.round(rect.top) })
      }
      textNode = walker.nextNode()
    }

    const lines = []
    let current = null
    for (const c of chars) {
      if (current === null || Math.abs(current.top - c.top) > 2) {
        current = { top: c.top, text: c.ch }
        lines.push(current)
      } else {
        current.text += c.ch
      }
    }
    return lines
  }

  const out = []
  for (const selector of selectors) {
    const host = document.querySelector(selector)
    if (host === null) {
      out.push({ selector, missing: true, lines: 0, dirty: 0, samples: [] })
      continue
    }
    const lines = linesOf(host)
    const dirty = []
    for (let i = 0; i < lines.length - 1; i += 1) {
      const before = lines[i].text.slice(-1)
      const after = lines[i + 1].text.slice(0, 1)
      if (ATOMIC.test(before) && ATOMIC.test(after)) {
        dirty.push(`${lines[i].text.slice(-6)}|${lines[i + 1].text.slice(0, 6)}`)
      }
    }
    out.push({ selector, element: describe(host), lines: lines.length, dirty: dirty.length, samples: dirty.slice(0, 4) })
  }
  return out
}

/**
 * 在页面里量可点元素的命中区尺寸（会被序列化后送进浏览器执行）。
 *
 * ## 口径
 *
 * 「可点元素」取 `button` / `a[href]` / `summary` / `[role="button"]` ——
 * 与 `a11y.test.mjs` 盯的那几类一致，也与真实交互路径一致。
 *
 * 只量**可见**的（宽高都非 0）：折叠的 `<details>` 内容、`hidden` 的面板
 * 都是 0×0，算进来会制造一堆假阳性。但 `summary` 本身要算 —— 折叠状态下
 * 它照样可点，恰恰是最需要够得着的那个。
 *
 * ## 为什么返回尺寸而不是只返回布尔
 *
 * 失败时要能说清「哪个元素、差多少像素」。只回一个 false，读报告的人还得
 * 自己去浏览器里一个个量。
 *
 * @param {number} min 最小边长
 * @returns {{pointerCoarse: boolean, min: number, total: number, undersized: object[]}}
 */
function measureTouchTargetsInPage(min) {
  const describe = (element) => {
    const cls = typeof element.className === 'string' && element.className !== ''
      ? `.${element.className.trim().split(/\s+/u).join('.')}`
      : ''
    return `${element.tagName.toLowerCase()}${cls}`
  }

  const undersized = []
  let total = 0
  for (const element of document.querySelectorAll('button, a[href], summary, [role="button"]')) {
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    total += 1
    const width = Math.round(rect.width * 10) / 10
    const height = Math.round(rect.height * 10) / 10
    if (width < min || height < min) {
      undersized.push({
        element: describe(element),
        width,
        height,
        text: (element.textContent ?? '').trim().slice(0, 18),
      })
    }
  }

  return {
    pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
    min,
    total,
    undersized,
  }
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
(async () => {
  const path = ${JSON.stringify(LONG_PATH)}
  /*
   * 断行由**产品自己的** \`writeText\` 来写，这里不另写一份等价逻辑。
   *
   * 为什么这条不能省：压测注入的节点本来就绕过了 app.js 的渲染路径，
   * 如果连「把文本写进节点」这一步也自己实现，那么产品代码改坏了
   * （比如退回 \`textContent\`）压测照样全绿 —— 实测过，确实如此。
   * 用 \`import('./app.js')\` 取的是页面已加载的那个模块实例，
   * 不会重复执行 init，拿到的是真正在跑的那份实现。
   *
   * 「app.js 的渲染点确实调了 writeText」这一步压测管不到，由
   * \`viewport-check.test.mjs\` 的静态守卫盯着，两头合起来才闭环。
   */
  const { writeText } = await import('./app.js')
  const make = (tag, cls, text) => {
    const node = document.createElement(tag)
    if (cls !== '') node.className = cls
    if (text !== undefined) node.textContent = text
    return node
  }
  /** 造一个 span/div，把长串交给产品的 writeText 写进去。 */
  const write = (node, prefix = '') => {
    node.replaceChildren()
    if (prefix !== '') node.append(document.createTextNode(prefix))
    writeText(node, path)
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
      write(node, '把 macOS 应用打包成 Windows 可执行文件：')
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
        write(make('span', 'stage-name')),
        make('span', 'stage-time', '12345ms'),
        write(make('span', 'stage-msg')),
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
        write(make('span', 'check-name')),
        write(make('span', 'check-detail')),
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
        write(make('span', 'history-label'), 'mac2win build '),
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
      write(make('span', 'error-msg'), '找不到运行时可执行文件：'),
      write(make('span', 'error-hint'), '请检查 '),
    )
    result.append(box)
    for (let i = 0; i < 2; i += 1) {
      const line = make('div', 'result-line')
      line.append(make('span', 'result-key', '产物'), write(make('span', 'result-val fail')))
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
      block.append(write(make('div', 'contract-problem'), '[exit-code] 报告里的 exitCode 与进程实际退出码不一致：'))
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

      /*
       * 第三段：模拟粗指针设备。
       *
       * `Emulation.setTouchEmulationEnabled` 是唯一能让 `(pointer: coarse)`
       * 真的成立的 CDP 手段 —— 实测过 `Emulation.setEmulatedMedia` 带
       * `{name:'pointer', value:'coarse'}` 无效（`matchMedia` 仍回 false，
       * Chrome 不支持用这个接口改指针能力）。
       *
       * 顺序有讲究：先激活触控再量溢出。放大后的按钮若撑破容器，必须
       * 在这里被发现 —— 否则「修好了触控目标、弄坏了布局」会成为新的
       * 回归。压测节点仍留在页面上，所以这一段同时覆盖「触控 + 长串」
       * 这个最坏组合。
       */
      await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId)
      await new Promise((r) => { setTimeout(r, 200) })
      const touchOverflow = await evaluate(client, sessionId, measureInPage)
      const touch = await evaluate(client, sessionId, `(${String(measureTouchTargetsInPage)})(${String(MIN_TOUCH_TARGET)})`)
      await client.send('Emulation.setTouchEmulationEnabled', { enabled: false }, sessionId)
      await new Promise((r) => { setTimeout(r, 120) })

      /*
       * 第四段：长串的断行质量。
       *
       * 放在触控段之后、退回到细指针再量 —— 粗指针会把按钮撑宽，
       * 挤压文本列宽，量出来的断行形态与真实鼠标环境不同。这一节
       * 针对的是「读不读得懂」，细指针下的列宽才是基线。
       *
       * 三段都通过、唯独断行在词中间，是「页面没坏但读不了」的形态：
       * 它不会被前三段抓到，所以必须单列一段。
       */
      const lineBreaks = await evaluate(client, sessionId,
        `(${String(measureLineBreaksInPage)})(${JSON.stringify(LONG_TEXT_SELECTORS)})`)

      results.push({ viewport: viewport.name, width: viewport.width, baseline, stress, touch, touchOverflow, lineBreaks })
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
    /*
     * 判定里单列 `touch.pointerCoarse === true`。
     *
     * 粗指针没生效时，CSS 的 `@media (pointer: coarse)` 整块不解析，
     * 按钮仍是 24px —— 理论上 `undersized` 会非空从而失败。但那是**间接**
     * 失败：只要哪天有人把 `MIN_TOUCH_TARGET` 调小，或者页面碰巧有个别
     * 大按钮，这一节就静默通过了。直接断言「模拟确实生效」才是把空转
     * 堵在入口 —— 与 CSS 侧那条 `pointerCoarse` 断言各守一头。
     */
    const ok = results.every((row) =>
      row.baseline.pageOverflow <= 0 && row.baseline.offenders.length === 0
      && row.stress.pageOverflow <= 0 && row.stress.offenders.length === 0
      && row.touchOverflow.pageOverflow <= 0 && row.touchOverflow.offenders.length === 0
      && row.touch.pointerCoarse === true
      && row.touch.undersized.length === 0
      // 断行质量：任何一处「断在词中间」都算失败。missing 也算 —— 选择器
      // 失效会让整节静默空转，与「压测注入到空集合」是同一类坑。
      && row.lineBreaks.every((item) => item.missing !== true && item.dirty === 0))

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
    for (const [label, data] of [['基线', row.baseline], ['压测', row.stress], ['触控', row.touchOverflow]]) {
      const overflow = data.pageOverflow > 0 ? `页面横向溢出 ${String(data.pageOverflow)}px` : '页面横向溢出 0px'
      lines.push(`  ${label}：${overflow}，越界元素 ${String(data.offenders.length)} 处`)
      for (const offender of data.offenders.slice(0, 5)) {
        lines.push(`    · ${offender.element} 超出 ${offender.container} ${String(offender.overflow)}px`)
      }
      if (data.offenders.length > 5) {
        lines.push(`    …另有 ${String(data.offenders.length - 5)} 处`)
      }
    }

    const touch = row.touch
    const state = touch.pointerCoarse ? '粗指针已生效' : '⚠ 粗指针未生效，本节无效'
    lines.push(`  触控目标：共 ${String(touch.total)} 个，小于 ${String(touch.min)}px 的 ${String(touch.undersized.length)} 个（${state}）`)
    for (const bad of touch.undersized.slice(0, 5)) {
      lines.push(`    · ${bad.element}${bad.text === '' ? '' : `「${bad.text}」`} 实测 ${String(bad.width)}×${String(bad.height)}px`)
    }
    if (touch.undersized.length > 5) {
      lines.push(`    …另有 ${String(touch.undersized.length - 5)} 个`)
    }

    const breaks = row.lineBreaks
    const missing = breaks.filter((item) => item.missing === true)
    const dirty = breaks.filter((item) => item.dirty > 0)
    const totalLines = breaks.reduce((sum, item) => sum + item.lines, 0)
    lines.push(`  断行质量：共 ${String(breaks.length)} 个容器 / ${String(totalLines)} 行，断在词中间 ${String(dirty.reduce((sum, item) => sum + item.dirty, 0))} 处`)
    for (const bad of dirty) {
      lines.push(`    · ${bad.selector} 断开 ${String(bad.dirty)} 处：${bad.samples.join(' , ')}`)
    }
    for (const gone of missing) {
      lines.push(`    · ${gone.selector} 元素不存在，本节对它是空转`)
    }
  }
  lines.push(payload.ok
    ? '✓ 三档视口均无溢出，触控目标与断行位置均达标'
    : '✗ 存在溢出、触控目标过小或断在词中间，见上')
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
