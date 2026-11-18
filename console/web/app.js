/**
 * Wacmin 看板前端。
 *
 * ## 零依赖
 *
 * 不用框架。整个前端只有三种状态需要管理：方向列表、当前任务、
 * 契约检查结果。用框架反而要引入构建步骤，对这个规模的页面不值得。
 *
 * ## 数据来源
 *
 * 全部来自契约（`contracts/run-report.schema.json`）定义的字段：
 *
 *   report.stages    → 阶段进度
 *   report.checks    → 校验项
 *   report.error     → 错误码与建议
 *   report.artifacts → 产物路径
 *
 * 前端**不需要为每个方向写适配** —— 这是 console 存在的意义。
 *
 * ## 容错分层（重要）
 *
 * 「读报告」与「画界面」是两件事，分别放在两个文件：
 *
 *   report-view.mjs  纯函数，把任意值收敛成安全的渲染模型，绝不抛异常
 *   app.js（本文件） 只负责把模型变成 DOM
 *
 * 这个划分不是为了好看，是因为踩过一个很隐晦的坑：早先直接在
 * `finishJob` 里 `for (const s of report.stages)`，一份
 * `stages: {...}` 或 `artifacts: [null]` 的报告会让它抛 TypeError。
 * 而 `finishJob` 是由 SSE 的 done 回调调用的 —— 抛出之后**后面所有的
 * 界面更新都不会执行**，面板永远停在「运行中」，用户看到的是一个
 * 卡死的界面，连个错误都看不到。
 *
 * 所以现在的原则是：渲染层拿到什么都不许抛，画不出来就画「画不出来」。
 *
 * ## 安全
 *
 * 所有来自后端的字符串都经 `textContent` 或显式转义写入，不用
 * `innerHTML` 拼接。日志与错误消息里可能含用户路径、安装器输出，
 * 直接插进 HTML 会有注入风险。
 */

import {
  artifactRows, checkRows, checksSummary, contractRows,
  errorBox, historyRow, progressText, stageRows, toText, warningRows,
} from './report-view.mjs'

const $ = (id) => document.getElementById(id)

/** 各方向可触发的动作。 */
const ACTIONS = {
  mac2win: [
    { command: 'doctor', label: '自检' },
    { command: 'build', label: '构建', needsArgs: true, hint: '项目目录' },
  ],
  exeonmac: [
    { command: 'doctor', label: '自检' },
    { command: 'version', label: '版本' },
    { command: 'layers', label: '层', args: ['list'] },
    { command: 'recipe', label: '配方', args: ['list'] },
  ],
  win2mac: [
    { command: 'doctor', label: '自检' },
    { command: 'verify', label: '校验', needsArgs: true, hint: '.app 或 .zip' },
  ],
  apponwin: [
    { command: 'doctor', label: '自检' },
    { command: 'assess', label: '评估', needsArgs: true, hint: '.app 路径' },
    { command: 'spike', label: 'Spike' },
  ],
}

/** 当前任务的事件源，切换任务时先关掉旧的。 */
let activeSource = null
/** 当前任务的计时器。 */
let activeTimer = null
/** 当前任务的 ID，用于拼产物下载地址。 */
let currentJobId = null

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

init()

async function init() {
  $('host-info').textContent = `${navigator.platform || '本机'} · ${new Date().toLocaleString('zh-CN')}`
  $('btn-contract').addEventListener('click', runContractCheck)
  $('btn-contract-close').addEventListener('click', () => {
    $('contract-panel').hidden = true
  })
  await loadDirections()
  await loadHistory()
}

// ---------------------------------------------------------------------------
// 方向列表
// ---------------------------------------------------------------------------

async function loadDirections() {
  try {
    const response = await fetch('./api/status')
    const data = await response.json()
    renderDirections(data.directions)
  } catch (error) {
    $('directions').replaceChildren(el('div', 'loading', `读取失败：${String(error)}`))
  }
}

function renderDirections(directions) {
  const container = $('directions')
  container.replaceChildren()
  $('dir-count').textContent = `${directions.length} 个`

  for (const direction of directions) {
    const card = el('div', 'dir-card')
    card.dataset.direction = direction.id

    const head = el('div', 'dir-head')
    head.append(
      el('span', 'dir-id', direction.label),
      el('span', 'badge', direction.id),
    )

    const summary = el('div', 'dir-summary', direction.summary)
    const actions = el('div', 'dir-actions')

    for (const action of ACTIONS[direction.id] ?? []) {
      const button = el('button', 'btn', action.label)
      button.type = 'button'
      button.addEventListener('click', () => {
        trigger(direction.id, action)
      })
      actions.append(button)
    }

    card.append(head, summary, actions)
    container.append(card)
  }
}

// ---------------------------------------------------------------------------
// 触发任务
// ---------------------------------------------------------------------------

async function trigger(directionId, action) {
  let args = [...(action.args ?? [])]

  if (action.needsArgs === true) {
    const input = window.prompt(`${action.label} ${directionId}：${action.hint ?? '参数'}`)
    if (input === null) return
    if (input.trim() !== '') args = [input.trim()]
  }

  resetJobPanel(`${directionId} ${action.command}${args.length > 0 ? ` ${args.join(' ')}` : ''}`)

  let payload
  try {
    const response = await fetch('./api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ direction: directionId, command: action.command, args }),
    })
    payload = await response.json()
  } catch (error) {
    appendLog(`[console] 请求失败：${String(error)}\n`)
    setJobStatus('fail', '请求失败')
    return
  }

  if (payload.ok !== true) {
    appendLog(`[console] ${payload.error ?? '未知错误'}\n`)
    setJobStatus('fail', '无法启动')
    return
  }

  markRunning(directionId, true)
  setJobStatus('running', '运行中')
  subscribe(payload.jobId)
}

// ---------------------------------------------------------------------------
// 任务面板
// ---------------------------------------------------------------------------

function resetJobPanel(title) {
  currentJobId = null
  $('job-panel').hidden = false
  $('job-title').textContent = title
  setJobStatus('running', '准备中')
  $('progress-fill').style.width = '0%'
  $('progress-fill').className = 'progress-fill'
  $('progress-text').textContent = '未开始'
  $('progress-time').textContent = ''
  // 清掉上一个任务记下的阶段标题，否则新任务会显示旧任务的名字
  liveStageTitles.clear()
  $('stages').replaceChildren()
  $('checks').replaceChildren()
  $('checks-wrap').hidden = true
  $('log').textContent = ''
  $('result').hidden = true
  $('result').replaceChildren()

  /*
   * 自动展开日志。
   *
   * 日志默认折叠（`<details>` 不带 open）是为了看历史报告时不被大段
   * 输出淹没。但**任务正在跑**的时候正好相反：用户最想看的就是它 ——
   * 阶段列表只能说明「走到第几步」，卡在哪、为什么慢、报了什么错，
   * 全在日志里。折叠着等于把唯一能判断「是死是活」的信息藏起来。
   *
   * 只在新任务开始时展开，任务结束后不动：失败时用户正需要看它，
   * 成功后想收起就自己收，不要替用户决定。
   */
  $('log-wrap').open = true

  if (activeSource !== null) {
    activeSource.close()
    activeSource = null
  }
  if (activeTimer !== null) {
    clearInterval(activeTimer)
    activeTimer = null
  }

  const startedAt = Date.now()
  activeTimer = setInterval(() => {
    $('progress-time').textContent = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  }, 100)

  $('job-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

function subscribe(jobId) {
  currentJobId = jobId
  const source = new EventSource(`./api/job/${jobId}/events`)
  activeSource = source

  source.addEventListener('start', (event) => {
    const data = JSON.parse(event.data)
    appendLog(`[console] ${data.direction} ${data.command} 已启动\n`)
  })

  source.addEventListener('log', (event) => {
    const data = JSON.parse(event.data)
    appendLog(data.text)
  })

  /*
   * 阶段进度。
   *
   * 构建动辄几十秒（mac2win 打一个大载荷 20 秒以上，exeonmac 静默安装
   * 更久），只显示「转圈 + 计时」会让人怀疑是不是卡死了。服务端从各
   * 方向的日志里认出 `▸ [3/8] 准备运行时` 这类标记后推过来，这里把
   * 进度条推到对应比例，并把已经走过的阶段画出来。
   *
   * 进度按「已开始」算而不是「已完成」：进入第 3 阶段时进度是 2/8 到
   * 3/8 之间，取 (index-1)/total 更诚实 —— 第 3 步还没干完。
   */
  source.addEventListener('stage', (event) => {
    const data = JSON.parse(event.data)
    const { index, total, title } = data
    if (!Number.isInteger(index) || !Number.isInteger(total) || total <= 0) return

    const ratio = Math.max(0, Math.min(1, (index - 1) / total))
    $('progress-fill').style.width = `${(ratio * 100).toFixed(1)}%`
    $('progress-text').textContent = `第 ${index}/${total} 步 · ${title}`

    renderLiveStages(index, total, title)
  })

  source.addEventListener('done', (event) => {
    const data = JSON.parse(event.data)
    finishJob(data)
    source.close()
    activeSource = null
  })

  source.onerror = () => {
    /*
     * SSE 断线时浏览器会自动重连。但任务结束后服务端会主动关闭连接，
     * 这时重连没有意义 —— 若已经拿到结果就忽略。
     */
    if (activeSource === null) return
    appendLog('[console] 连接中断，正在重试…\n')
  }
}

function finishJob(result) {
  if (activeTimer !== null) {
    clearInterval(activeTimer)
    activeTimer = null
  }
  markRunning(null, false)

  /*
   * result 本身也当不可信处理：SSE 的 data 是 JSON.parse 出来的，
   * 服务端将来改结构这里就会拿到 undefined。
   */
  const payload = (typeof result === 'object' && result !== null) ? result : {}
  const report = payload.report ?? null
  const ok = payload.ok === true

  /*
   * 历史列表在任何结局下都要刷新。
   *
   * 早先这行在下面的 `report === null` 早返回之后，于是「任务失败且
   * 没拿到报告」这类最需要回看的情况反而不出现在历史里 —— 而它恰恰
   * 是用户最想点开看看发生了什么的一条。
   */
  void loadHistory()

  setJobStatus(ok ? 'ok' : 'fail', ok ? '完成' : '失败')
  $('progress-fill').style.width = '100%'
  $('progress-fill').className = `progress-fill ${ok ? 'ok' : 'fail'}`

  if (report === null) {
    $('progress-text').textContent = '没有拿到报告'
    renderResult({ ...payload, ok, report: null })
    return
  }

  renderStages(report)
  renderChecks(report)
  renderResult({ ...payload, ok, report })

  $('progress-text').textContent = progressText(report, payload.durationMs)
}

function setJobStatus(kind, text) {
  const badge = $('job-status')
  badge.className = `badge ${kind}`
  badge.textContent = text
}

function markRunning(directionId, running) {
  for (const card of document.querySelectorAll('.dir-card')) {
    if (running && card.dataset.direction === directionId) {
      card.classList.add('running')
    } else {
      card.classList.remove('running')
    }
  }
}

// ---------------------------------------------------------------------------
// 渲染：阶段
// ---------------------------------------------------------------------------
//
// 这里开始只做「模型 → DOM」。所有对不可信数据的判断都在
// report-view.mjs 里，已由单测覆盖。

function renderStages(report) {
  const container = $('stages')
  container.replaceChildren()

  for (const stage of stageRows(report)) {
    const row = el('div', `stage ${stage.status}`)
    row.append(
      el('span', 'stage-mark', stage.mark),
      el('span', 'stage-name', stage.name),
      el('span', 'stage-time', stage.time),
    )
    if (stage.message !== null) {
      row.append(el('span', 'stage-msg', stage.message))
    }
    container.append(row)
  }
}

/**
 * 实时画阶段列表（任务还没结束时）。
 *
 * 与 renderStages 的区别：那边渲染的是**报告里的**阶段（带耗时、状态、
 * 错误码），这边只能根据「日志里出现过第几步」推断。所以：
 *
 *   - 之前的阶段标 ✓（已经走过）
 *   - 当前这一步标 ⟳（正在做）
 *   - 之后的阶段不画 —— 那时还不知道总共有没有这些阶段，
 *     画出来一堆灰条反而更乱
 *
 * 任务结束后 finishJob 会用真实报告整个重绘一遍，这里的临时状态
 * 自然被替换掉。
 */
function renderLiveStages(current, total, currentTitle) {
  const container = $('stages')
  container.replaceChildren()

  // 先记下当前标题，再画：否则画到当前行时 map 里还没有它
  liveStageTitles.set(current, currentTitle)

  /*
   * 只知道「现在是第 current 步、共 total 步」，前面每一步的标题
   * 从日志里出现过的那行取。没出现过的（比如跳步）就不画标题，
   * 只留空 —— 比编一个名字诚实。
   */
  for (let index = 1; index <= current; index += 1) {
    const isCurrent = index === current
    const row = el('div', `stage ${isCurrent ? 'running' : 'ok'}`)
    row.append(
      el('span', 'stage-mark', isCurrent ? '⟳' : '✓'),
      el('span', 'stage-name', liveStageTitles.get(index) ?? ''),
      el('span', 'stage-time', ''),
    )
    container.append(row)
  }
  void total
}

/** 已见过的阶段标题：序号 → 标题。用于把走过的阶段补上名字。 */
const liveStageTitles = new Map()

// ---------------------------------------------------------------------------
// 渲染：校验项
// ---------------------------------------------------------------------------

function renderChecks(report) {
  const summary = checkRows(report)
  if (!summary.present) {
    $('checks-wrap').hidden = true
    return
  }

  $('checks-wrap').hidden = false
  $('checks-summary').textContent = checksSummary(summary)

  const container = $('checks')
  container.replaceChildren()
  for (const check of summary.rows) {
    const row = el('div', `check ${check.passed ? 'ok' : 'fail'}`)
    row.append(
      el('span', 'check-mark', check.mark),
      el('span', 'check-name', check.name),
      el('span', 'check-detail', check.detail),
    )
    container.append(row)
  }
}

// ---------------------------------------------------------------------------
// 渲染：结果
// ---------------------------------------------------------------------------

function renderResult(result) {
  const container = $('result')
  container.hidden = false
  container.replaceChildren()

  const report = (typeof result.report === 'object' && result.report !== null)
    ? result.report
    : null

  const box = errorBox(report)
  if (box !== null) {
    const node = el('div', 'error-box')
    node.append(
      el('span', 'error-code', box.code),
      el('span', 'error-msg', box.message),
    )
    if (box.hint !== null) {
      node.append(el('span', 'error-hint', `→ ${box.hint}`))
    }
    container.append(node)
  }

  container.append(resultLine('退出码', toText(result.exitCode), result.ok === true ? 'ok' : 'fail'))
  container.append(resultLine('耗时', `${toText(result.durationMs)}ms`))

  if (result.timedOut === true) {
    container.append(resultLine('超时', '是（已强制终止）', 'fail'))
  }

  for (const artifact of artifactRows(report)) {
    const row = resultLine('产物', artifact.path)
    /*
     * 下载链接用「任务 ID + 序号」，不传路径。
     *
     * 传路径会开出一个任意文件读取接口 —— 任何能访问这个端口的东西
     * 都能读 ~/.ssh/id_rsa。用序号让服务端从自己记录的报告里取路径，
     * 攻击面收敛成「只能下载本次真实产出过的文件」。
     *
     * usable 为假时不给链接：路径为空或不是字符串时，服务端只会回
     * 404，点了没反应比没有按钮更让人困惑。
     */
    if (artifact.usable && currentJobId !== null) {
      const link = el('a', 'btn btn-ghost download', '下载')
      link.href = `./api/artifact/${currentJobId}/${String(artifact.index)}`
      link.setAttribute('download', '')
      row.append(link)
    }
    container.append(row)
  }

  for (const warning of warningRows(report)) {
    container.append(resultLine('注意', warning))
  }
}

function resultLine(key, value, kind = '') {
  const row = el('div', 'result-line')
  row.append(
    el('span', 'result-key', key),
    el('span', `result-val ${kind}`.trim(), value),
  )
  return row
}

// ---------------------------------------------------------------------------
// 契约检查
// ---------------------------------------------------------------------------

async function runContractCheck() {
  const panel = $('contract-panel')
  const body = $('contract-body')
  panel.hidden = false
  body.replaceChildren(el('div', 'loading', '正在检查四个方向…'))

  const button = $('btn-contract')
  button.disabled = true

  try {
    const response = await fetch('./api/contract')
    const result = await response.json()
    renderContract(result)
  } catch (error) {
    body.replaceChildren(el('div', 'loading', `检查失败：${String(error)}`))
  } finally {
    button.disabled = false
  }
}

function renderContract(result) {
  const body = $('contract-body')
  body.replaceChildren()

  const blocks = contractRows(result)
  if (blocks.length === 0) {
    body.replaceChildren(el('div', 'loading', '没有拿到检查结果'))
    return
  }

  for (const entry of blocks) {
    const block = el('div', 'contract-dir')

    const head = el('div', 'contract-dir-head')
    head.append(
      el('span', 'check-mark', entry.ok ? '✓' : '✗'),
      el('span', '', entry.direction),
    )
    block.append(head)

    for (const scenario of entry.scenarios) {
      const row = el('div', 'contract-scenario')
      row.append(
        el('span', 'check-mark', scenario.ok ? '✓' : '✗'),
        el('span', '', scenario.name),
      )
      block.append(row)

      for (const problem of scenario.problems) {
        block.append(el('div', 'contract-problem',
          `[${problem.check}] ${problem.detail}`))
      }
    }
    body.append(block)
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 创建元素。
 *
 * 第三个参数是文本内容，用 `textContent` 写入 —— 不用 innerHTML。
 * 后端来的字符串可能含用户路径、安装器输出，拼接进 HTML 会有注入风险。
 */
function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className !== '') node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** 追加日志，自动滚到底。 */
function appendLog(text) {
  const log = $('log')
  log.textContent += text
  // 只在用户没有往上翻时才自动滚到底
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60
  if (nearBottom) log.scrollTop = log.scrollHeight
}
// ---------------------------------------------------------------------------
// 历史
// ---------------------------------------------------------------------------

/**
 * 拉取并渲染历史记录。
 *
 * 刷新页面不该丢掉刚才的结果 —— 这是看板相对终端的核心优势。
 * 服务端只保留最近 20 条、5 分钟内的任务。
 */
async function loadHistory() {
  let items
  try {
    const response = await fetch('./api/history')
    const data = await response.json()
    items = Array.isArray(data.items) ? data.items : []
  } catch {
    return
  }

  const panel = $('history-panel')
  if (items.length === 0) {
    panel.hidden = true
    return
  }
  panel.hidden = false
  $('history-count').textContent = `${items.length} 条`

  const body = $('history-body')
  body.replaceChildren()

  for (const item of items) {
    /*
     * 全部经 historyRow 收敛：服务端算好的摘要也可能缺字段（旧版本
     * 任务、序列化异常）。早先这里直接 `new Date(item.startedAt)`，
     * startedAt 缺失时显示成 `NaN:NaN:NaN` —— 行还在，但读不出时间。
     */
    const view = historyRow(item)
    const row = el('div', `history-row ${view.ok ? 'ok' : 'fail'}`)
    row.append(
      el('span', 'check-mark', view.ok ? '✓' : '✗'),
      el('span', 'history-label', view.label),
      el('span', 'history-time', view.clock),
      el('span', 'history-meta', view.meta),
    )

    /*
     * 点一下重新订阅那条任务的报告（服务端保留 5 分钟）。
     *
     * ## 为什么还要 keydown 与 tabindex
     *
     * 这一行是 `<div>` + `click` —— 鼠标能用，**键盘用户完全够不到**：
     * div 不进 Tab 序列，回车也不触发 click。用 Tab 浏览的用户看到
     * 历史里有一行却打不开，也不知道为什么。
     *
     * 做成真正的 `<button>` 会带上按钮语义，但历史行是一整条带四段
     * 文本的列表项，套按钮标签后读屏会念成「按钮 mac2win build
     * 13:43:42 37719ms 1 个产物」，反而更难懂。所以保留 div，补上：
     *
     *   - `tabindex="0"`：进 Tab 序列
     *   - `role="button"`：告诉读屏这是个可操作元素
     *   - 回车与空格：两种键都该触发（原生按钮就是如此）
     *
     * 空格必须 `preventDefault`，否则页面会同时向下滚动。
     */
    const jobId = typeof item === 'object' && item !== null ? item.jobId : undefined
    if (typeof jobId === 'string' && jobId !== '') {
      const replay = () => { replayJob({ ...item, jobId }) }
      row.tabIndex = 0
      row.setAttribute('role', 'button')
      row.addEventListener('click', replay)
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          replay()
        }
      })
    }
    body.append(row)
  }
}

/**
 * 回看一条历史任务的完整报告。
 *
 * 用 SSE 补订阅：服务端对已完成的任务会立刻回放 done 事件。
 * 这样不用额外做一个「取报告」的接口。
 *
 * @param {object} item 历史条目
 */
function replayJob(item) {
  const view = historyRow(item)
  /*
   * resetJobPanel 会清空 currentJobId，但紧接着 subscribe 又把它设回来。
   * 顺序不能反 —— 先 reset 再 subscribe，才能保证拿到的是这条任务的 ID
   * 而不是上一条的（否则「回看 A 却下载到 B 的产物」）。
   */
  resetJobPanel(view.label)
  $('job-title').textContent = `${view.label}（回看）`
  setJobStatus('running', '加载中')
  subscribe(item.jobId)
}
