/**
 * 控制台前端逻辑。
 *
 * ## 与后端的约定
 *
 * - `GET /api/state` 拿初始状态与已有日志
 * - `GET /api/events` SSE 收实时日志与进度
 * - `POST /api/build` 开始构建（立刻回 202，结果走 SSE）
 * - `POST /api/preflight` 只跑预检
 *
 * ## 为什么不用框架
 *
 * 整个界面只有「一列表单 + 一个日志流 + 一个结果卡片」。引入 React
 * 意味着要配构建、要处理依赖，而这个工具本身是「零依赖、装了就能跑」。
 * 手写 DOM 在这个体量下更短、更快、更容易读。
 */

const $ = (id) => document.getElementById(id)

/** 表单字段与配置键的映射。 */
const FIELDS = {
  project: null, // 特殊：不是配置项
  framework: 'framework',
  productName: 'productName',
  version: 'version',
  target: 'target',
  format: 'format',
  entry: 'entry',
  frontendDist: 'frontendDist',
  buildCommand: 'buildCommand',
  compression: 'compression',
  dataEnv: 'dataEnv',
}

/** 开关字段。 */
const SWITCHES = {
  verify: 'verify',
  alsoZip: 'alsoZip',
  desktopShortcut: 'desktopShortcut',
  keepStaging: 'keepStaging',
}

/** 本地记住的表单值，刷新页面不丢。 */
const STORAGE_KEY = 'mac2win.form'

/** 当前是否在构建。 */
let building = false
/** SSE 连接。 */
let stream = null

/* ---------------- 主题 ---------------- */

function initTheme() {
  $('theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme
    const next = current === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    document.documentElement.style.colorScheme = next
    localStorage.setItem('mac2win.theme', next)
  })
}

/* ---------------- 表单读写 ---------------- */

/** 收集当前表单值。空字符串转成 null，让后端走推断与默认值。 */
function collect() {
  const overrides = {}
  for (const [id, key] of Object.entries(FIELDS)) {
    if (key === null) continue
    const element = $(id)
    const value = element.value.trim()
    // 空值不传：传空字符串会覆盖后端的自动推断。
    if (value !== '') overrides[key] = value
  }
  for (const [id, key] of Object.entries(SWITCHES)) {
    overrides[key] = $(id).checked
  }
  return { projectRoot: $('project').value.trim(), overrides }
}

/** 把值填回表单。 */
function apply(values) {
  for (const [id, key] of Object.entries(FIELDS)) {
    if (key === null) continue
    if (values[key] !== undefined && values[key] !== null) $(id).value = String(values[key])
  }
  for (const [id, key] of Object.entries(SWITCHES)) {
    if (typeof values[key] === 'boolean') $(id).checked = values[key]
  }
}

/** 存到 localStorage，只存用户填的，不存推断结果。 */
function persist() {
  const data = {}
  for (const id of Object.keys(FIELDS)) data[id] = $(id).value
  for (const id of Object.keys(SWITCHES)) data[id] = $(id).checked
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    /* 隐私模式下写不了，不影响使用 */
  }
}

/** 从 localStorage 恢复。 */
function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return
    const data = JSON.parse(raw)
    for (const [id, value] of Object.entries(data)) {
      const element = $(id)
      if (element === null || value === null || value === undefined) continue
      if (element.type === 'checkbox') element.checked = Boolean(value)
      else element.value = String(value)
    }
  } catch {
    /* 数据坏了就当没存过 */
  }
}

/* ---------------- 日志渲染 ---------------- */

/**
 * 追加一条日志。
 *
 * 用 `textContent` 而不是 `innerHTML`：日志内容里可能有用户项目的
 * 文件路径与错误信息，直接拼 HTML 会引入注入面（哪怕只是本地工具，
 * 也不该留这种坑）。
 */
function appendLog(entry) {
  const log = $('log')
  const empty = log.querySelector('.log__empty')
  if (empty !== null) empty.remove()

  const line = document.createElement('div')
  line.className = 'log__line'
  line.dataset.level = entry.level

  const time = document.createElement('span')
  time.className = 'log__time'
  time.textContent = new Date(entry.at).toTimeString().slice(0, 8)

  const body = document.createElement('span')
  body.className = 'log__body'
  body.textContent = entry.message

  if (entry.code !== undefined) {
    const code = document.createElement('span')
    code.className = 'log__code'
    code.textContent = ` [${entry.code}]`
    body.appendChild(code)
  }

  if (entry.hint !== undefined) {
    const hint = document.createElement('span')
    hint.className = 'log__hint'
    hint.textContent = `→ ${entry.hint}`
    body.appendChild(hint)
  }

  line.append(time, body)
  log.appendChild(line)

  // 只在用户没有往上滚的时候自动跟随。强行滚动会让人没法回看。
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80
  if (nearBottom) log.scrollTop = log.scrollHeight
}

/** 清空日志。 */
function clearLog() {
  $('log').replaceChildren()
  const empty = document.createElement('div')
  empty.className = 'log__empty'
  empty.textContent = '等待构建开始'
  $('log').appendChild(empty)
}

/* ---------------- 状态显示 ---------------- */

/** 设置右上角状态徽标。 */
function setStatus(text, tone) {
  const pill = $('status')
  pill.textContent = text
  if (tone === undefined) delete pill.dataset.tone
  else pill.dataset.tone = tone
}

/** 更新进度条。 */
function setProgress(progress) {
  $('progress-wrap').hidden = false
  $('progress-fill').style.width = `${String(progress.percent)}%`
  $('progress-stage').textContent = progress.stageTitle ?? ''
  $('progress-percent').textContent = `${String(progress.percent)}%`
}

/** 渲染结果卡片。 */
function renderResult(result) {
  const box = $('result')
  box.replaceChildren()
  box.hidden = false

  const row = (key, value, tone, mono) => {
    const wrap = document.createElement('div')
    wrap.className = 'result__row'
    const keyEl = document.createElement('span')
    keyEl.className = 'result__key'
    keyEl.textContent = key
    const valueEl = document.createElement('span')
    valueEl.className = `result__value${mono === true ? ' result__value--mono' : ''}${tone === undefined ? '' : ` result__value--${tone}`}`
    valueEl.textContent = value
    wrap.append(keyEl, valueEl)
    box.appendChild(wrap)
  }

  if (result.ok === true) {
    row('产物', result.artifact ?? '—', undefined, true)
    row('体积', result.sizeText ?? '—')
    row('耗时', `${(result.durationMs / 1000).toFixed(1)} 秒`)
    if (Array.isArray(result.verify)) {
      /*
       * ## 这里原来写的是「N 项通过」
       *
       * N 取的是 `result.verify.length`——**全部项**，包括 warn 和
       * 根本没验的项。于是 10 项里 5 项没验，界面照样写「10 项通过」。
       *
       * 与 CLI 上那个「✓ 校验通过」是同一个毛病：把「没验」算进「通过」。
       * 两处必须一起改，否则用户在命令行看到警告、在界面上看到全绿，
       * 反而更困惑。
       *
       * 现在的口径：
       * - 有 fail      → 「N 项失败」
       * - 有未验证     → 「N 项通过，M 项未验证」（不用绿色）
       * - 有 warn 但全验过 → 「N 项通过，M 项有警告」
       * - 全绿         → 「N 项通过」
       */
      const failed = result.verify.filter((item) => item.status === 'fail').length
      const skipped = result.verify.filter((item) => item.skipped === true).length
      const warned = result.verify.filter(
        (item) => item.status === 'warn' && item.skipped !== true,
      ).length
      const passed = result.verify.length - failed - skipped - warned

      let text
      if (failed > 0) text = `${String(failed)} 项失败`
      else if (skipped > 0) text = `${String(passed)} 项通过，${String(skipped)} 项未验证`
      else if (warned > 0) text = `${String(passed)} 项通过，${String(warned)} 项有警告`
      else text = `${String(passed)} 项通过`

      row('校验', text, failed === 0 && skipped === 0 ? 'ok' : failed > 0 ? 'bad' : 'warn')
    }
    if (result.artifact !== undefined) {
      const actions = document.createElement('div')
      actions.className = 'result__actions'
      const reveal = document.createElement('button')
      reveal.type = 'button'
      reveal.className = 'button button--quiet'
      reveal.textContent = '在访达中显示'
      reveal.addEventListener('click', () => { void revealPath(result.artifact) })
      actions.appendChild(reveal)
      box.appendChild(actions)
    }
  } else {
    row('失败', result.message ?? '未知错误', 'bad')
    if (result.code !== undefined) row('错误码', result.code, undefined, true)
    if (result.hint !== undefined) row('建议', result.hint)
  }
}

/** 请求后端在访达里显示文件。 */
async function revealPath(path) {
  try {
    await fetch('/api/reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    })
  } catch (error) {
    console.warn('无法打开访达', error)
  }
}

/* ---------------- 构建控制 ---------------- */

/** 锁定/解锁表单，构建中不许改配置。 */
function setBuilding(value) {
  building = value
  $('build').disabled = value
  $('build-label').textContent = value ? '构建中…' : '开始打包'
  $('cancel').hidden = !value
  for (const id of [...Object.keys(FIELDS), ...Object.keys(SWITCHES)]) {
    const element = $(id)
    if (element !== null && element.tagName !== 'BUTTON') element.disabled = value
  }
}

/** 开始构建。 */
async function startBuild() {
  const payload = collect()
  if (payload.projectRoot === '') {
    $('probe-hint').textContent = '先填项目目录'
    $('probe-hint').className = 'field__hint field__hint--bad'
    return
  }

  clearLog()
  $('result').hidden = true
  $('progress-fill').style.width = '0%'
  $('progress-percent').textContent = '0%'
  $('progress-stage').textContent = '预检中'
  $('progress-wrap').hidden = false
  setBuilding(true)
  setStatus('构建中', 'running')

  try {
    const response = await fetch('/api/build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      const data = await response.json()
      throw new Error(data.message ?? `HTTP ${String(response.status)}`)
    }
  } catch (error) {
    setBuilding(false)
    setStatus('失败', 'bad')
    appendLog({ at: Date.now(), level: 'error', message: error.message })
  }
}

/** 取消构建。 */
async function cancelBuild() {
  try {
    await fetch('/api/cancel', { method: 'POST' })
  } catch {
    /* 已经结束了 */
  }
}

/** 探测目录。 */
async function probe() {
  const path = $('project').value.trim()
  const hint = $('probe-hint')
  if (path === '') {
    hint.textContent = '先填项目目录'
    hint.className = 'field__hint field__hint--bad'
    return
  }

  hint.textContent = '探测中…'
  hint.className = 'field__hint'

  try {
    const response = await fetch('/api/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    const data = await response.json()
    if (data.ok !== true) {
      hint.textContent = data.message ?? '不是一个有效目录'
      hint.className = 'field__hint field__hint--bad'
      return
    }

    const found = Object.entries(data.findings).filter(([, value]) => value === true).map(([name]) => name)
    if (found.length === 0) {
      hint.textContent = '目录存在，但没找到 package.json 等常见文件'
      hint.className = 'field__hint field__hint--bad'
      return
    }
    hint.textContent = `识别到：${found.join('、')}`
    hint.className = 'field__hint field__hint--ok'

    // 顺手把能推断的填进去，省得用户再抄一遍。
    if (data.findings.dist === true && $('frontendDist').value.trim() === '') $('frontendDist').value = 'dist'
    if (data.findings.build === true && $('frontendDist').value.trim() === '') $('frontendDist').value = 'build'
    if (data.findings['mac2win.config.json'] === true) {
      hint.textContent += '（目录里有配置文件，会自动读取）'
    }
    persist()
  } catch (error) {
    hint.textContent = error.message
    hint.className = 'field__hint field__hint--bad'
  }
}

/* ---------------- 事件流 ---------------- */

/** 建立 SSE 连接。 */
function connect() {
  if (stream !== null) stream.close()
  stream = new EventSource('/api/events')

  stream.addEventListener('log', (event) => {
    appendLog(JSON.parse(event.data))
  })

  stream.addEventListener('progress', (event) => {
    setProgress(JSON.parse(event.data))
  })

  stream.addEventListener('build-start', () => {
    setBuilding(true)
    setStatus('构建中', 'running')
  })

  stream.addEventListener('build-done', (event) => {
    const result = JSON.parse(event.data)
    setBuilding(false)
    setStatus('完成', 'ok')
    setProgress({ percent: 100, stageTitle: '完成' })
    renderResult(result)
  })

  stream.addEventListener('build-failed', (event) => {
    const result = JSON.parse(event.data)
    setBuilding(false)
    setStatus('失败', 'bad')
    renderResult(result)
  })

  stream.addEventListener('build-cancelled', () => {
    setBuilding(false)
    setStatus('已取消')
    $('progress-wrap').hidden = true
  })

  // 连接断了就重连。EventSource 自带重连，但服务重启时
  // readyState 会变成 CLOSED，那就不重连了，这里补一次。
  stream.addEventListener('error', () => {
    if (stream.readyState === EventSource.CLOSED) {
      setTimeout(connect, 2000)
    }
  })
}

/* ---------------- 初始化 ---------------- */

/** 拉初始状态。 */
async function loadState() {
  try {
    const response = await fetch('/api/state')
    const data = await response.json()

    $('env').textContent = `${data.platform.platform}/${data.platform.arch} · node ${data.platform.node}`

    // 回放已有日志（比如页面刷新前已经在构建）。
    if (Array.isArray(data.logs) && data.logs.length > 0) {
      clearLog()
      for (const entry of data.logs) appendLog(entry)
    }

    if (data.building === true) {
      setBuilding(true)
      setStatus('构建中', 'running')
    } else if (data.lastResult !== null) {
      renderResult(data.lastResult)
      setStatus(data.lastResult.ok === true ? '完成' : '失败', data.lastResult.ok === true ? 'ok' : 'bad')
    }
  } catch (error) {
    console.warn('读取初始状态失败', error)
  }
}

/** 从 URL 读预填的项目路径（`?project=`）。 */
function projectFromUrl() {
  const params = new URLSearchParams(location.search)
  const value = params.get('project')
  if (value === null || value === '') return
  $('project').value = value
}

async function main() {
  initTheme()
  restore()
  projectFromUrl()

  clearLog()
  await loadState()
  connect()

  $('build').addEventListener('click', () => { void startBuild() })
  $('cancel').addEventListener('click', () => { void cancelBuild() })
  $('probe').addEventListener('click', () => { void probe() })
  $('clear').addEventListener('click', clearLog)
  $('reset').addEventListener('click', () => {
    for (const id of Object.keys(FIELDS)) {
      if (id !== 'project') $(id).value = ''
    }
    $('framework').value = 'auto'
    $('target').value = 'x86'
    $('format').value = 'nsis'
    $('compression').value = 'lzma'
    $('verify').checked = true
    $('desktopShortcut').checked = true
    $('alsoZip').checked = false
    $('keepStaging').checked = false
    persist()
  })

  for (const id of [...Object.keys(FIELDS), ...Object.keys(SWITCHES)]) {
    const element = $(id)
    if (element === null) continue
    element.addEventListener('change', persist)
    element.addEventListener('input', persist)
  }

  /*
   * 框架选择联动提示。
   *
   * 不同框架的能力边界差别很大，用户选完必须立刻看到「这条路会得到
   * 什么」——尤其 Tauri 默认没有原生窗口，不说清楚会让人以为打包坏了。
   */
  const FRAMEWORK_HINTS = {
    auto: '按 src-tauri 目录与 package.json 依赖判断',
    electron: '含原生窗口。注意：x86 目标只能用 Electron ≤43',
    nwjs: '含原生窗口。官方提供 win-ia32 预编译包',
    tauri: 'Rust 壳需 cargo-xwin（1.5GB 依赖）。默认走浏览器形态',
    node: '用 node.exe 承载服务，界面走系统浏览器',
    static: '内置静态服务托管前端，界面走系统浏览器',
  }
  $('framework').addEventListener('change', () => {
    $('framework-hint').textContent = FRAMEWORK_HINTS[$('framework').value] ?? ''
  })
  $('framework-hint').textContent = FRAMEWORK_HINTS[$('framework').value] ?? ''

  // 回车直接开打，省一次点击。
  $('project').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void startBuild()
  })
}

void main()