/**
 * 把（可能畸形的）报告转成安全的渲染模型。
 *
 * ## 为什么要单独一层
 *
 * 前端直接读 `report.stages` / `report.artifacts` 有两个问题：
 *
 *   1. **会抛异常。** `for (const s of report.stages)` 在 stages 是对象
 *      时抛 "not iterable"；`artifact.path` 在 artifacts 含 null 时抛
 *      TypeError。异常发生在 `finishJob` 里，而它已经被 SSE 的 done
 *      回调调用 —— 抛出后**后续的界面更新全部丢失**，面板永远停在
 *      「运行中」，用户看到的是一个卡死的界面，连错误提示都没有。
 *
 *   2. **没法测。** 渲染逻辑写在 `app.js` 里，依赖 DOM，Node 里跑不了。
 *      而「畸形报告会不会把界面弄崩」恰恰是最需要回归保护的一类。
 *
 * 抽出来之后这里是纯函数：输入任意 JS 值，输出确定的渲染模型，
 * 不抛异常。`app.js` 只负责把模型变成 DOM。
 *
 * ## 与契约检查的分工
 *
 * 契约检查（`src/contract-check.mjs`）负责**判定**报告是否合规，会
 * 逐条列出违规。这里负责**兜底渲染**：不合规也照样显示得出来，因为
 * 用户恰恰要看的就是「它到底吐了什么」。
 *
 * 两者不可互相替代：只有检查没有兜底，用户看不到坏报告的内容；只有
 * 兜底没有检查，坏报告永远没人修。
 */

/** 阶段状态 → 显示符号。未知状态给一个中性符号，不显示 undefined。 */
export const STAGE_MARK = {
  ok: '✓',
  failed: '✗',
  running: '▸',
  skipped: '·',
  pending: '·',
}

/** 已被终态覆盖的阶段状态，用于算进度。 */
const SETTLED = new Set(['ok', 'failed', 'skipped'])

/**
 * 把任意值收敛成数组。
 *
 * 不用 `Array.isArray(x) ? x : []` 就够了吗？不够 —— 数组里的元素
 * 也可能是 null/undefined/原始值，仍然要在遍历时过滤。这里只保证
 * 「拿到的是可遍历的数组」，元素有效性由各渲染函数自己判断。
 *
 * @param {unknown} value
 * @returns {unknown[]}
 */
export function asArray(value) {
  return Array.isArray(value) ? value : []
}

/** 判断是否为可当对象读的普通对象（排除 null 与数组）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把任意值转成可安全放进 textContent 的字符串。
 *
 * 对象直接 `String()` 会得到 `[object Object]`，对排查毫无帮助。
 * 这里给 JSON 表示 —— 用户看到 `{"path":"/x"}` 至少知道实际结构是什么。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function toText(value) {
  if (value === null) return 'null'
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    // 循环引用、BigInt 等会让 JSON.stringify 抛错
    return Object.prototype.toString.call(value)
  }
}

/**
 * 把长串按「路径分隔符」切成可断行的片段。
 *
 * ## 解决什么
 *
 * 报告里的产物路径、错误消息里的路径，是**不含空格**的长串。它们必须在
 * 容器内换行（否则被 `.panel` 的 `overflow: hidden` 静默裁掉），而
 * `overflow-wrap: anywhere` 满足了「能断」，代价是**断在任意字符之间**：
 * 实测 375px 下 `Electron/runtime.tar.zst` 被劈成 `Elec|tron`、`dir|ectory`，
 * 读的人得在两行之间自己拼。三档视口合计 17 处（见 README 15.17）。
 *
 * ## 怎么解决
 *
 * 在 `/` `\` `-` 这些**天然边界之后**插入 `<wbr>`（零宽断行机会）。浏览器
 * 会优先在这些位置断行，只有整段长到一行放不下时才退回字符间硬断。
 *
 * 三个关键事实，都是实测的（`node console/scripts/viewport-check.mjs`）：
 *
 *   1. `<wbr>` **不占宽度、不进剪贴板**：`getSelection().toString()` 得到
 *      原文（实测 `/a/b<cwbr>c/d` → `"/a/bc/d"`），所以复制路径照样可用。
 *   2. 只有 `overflow-wrap: anywhere` 会**优先**用 `<wbr>`；
 *      `word-break: break-all` 会**无视**它（实测同一串加不加 `<wbr>`
 *      结果完全一致，4 处硬断照旧）。所以 `.result-val` 的
 *      `break-all` 必须换成 `anywhere`。
 *   3. `<wbr>` 只在有真正长 token 时才有意义。给每个 `/` 都插一个，
 *      对短路径没影响 —— 浏览器不会为 `<wbr>` 主动换行，除非需要。
 *
 * ## 为什么返回片段数组而不是拼 HTML
 *
 * 渲染层只用 `textContent` 与 `append(Text)` 写 DOM，不用 `innerHTML`
 * （见 `app.js` 头部「安全」一节）。返回 `{ text, breakAfter }` 的切片，
 * 让渲染层自己决定插不插 `<wbr>`，这里保持纯函数、可在 Node 里测。
 *
 * @param {string} text
 * @param {{ separators?: RegExp }} [options] 断点字符集，默认 `/ \ -`
 * @returns {Array<{text: string, breakAfter: boolean}>}
 */
export function pathSegments(text, options = {}) {
  const separators = options.separators ?? /[/\\-]/u
  if (typeof text !== 'string' || text === '') return []

  const segments = []
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    if (!separators.test(text[i])) continue
    segments.push({ text: text.slice(start, i + 1), breakAfter: true })
    start = i + 1
  }
  if (start < text.length) segments.push({ text: text.slice(start), breakAfter: false })
  return segments
}

/**
 * 阶段行。
 *
 * @param {object|null} report
 * @returns {Array<{status: string, mark: string, name: string, time: string, message: string|null}>}
 */
export function stageRows(report) {
  const rows = []
  for (const stage of asArray(isPlainObject(report) ? report.stages : undefined)) {
    /*
     * 非对象项也渲染出来，标成 unknown。
     *
     * 直接跳过会让「报告里混进了 null」这件事在界面上完全不可见 ——
     * 用户看到的阶段数与报告里实际的项数对不上，反而更困惑。
     */
    if (!isPlainObject(stage)) {
      rows.push({
        status: 'unknown',
        mark: '?',
        name: `（非法阶段项：${toText(stage)}）`,
        time: '',
        message: null,
      })
      continue
    }
    const duration = typeof stage.durationMs === 'number' && stage.durationMs > 0
      ? `${String(stage.durationMs)}ms`
      : ''
    rows.push({
      status: typeof stage.status === 'string' ? stage.status : 'unknown',
      mark: STAGE_MARK[stage.status] ?? '·',
      name: typeof stage.name === 'string' && stage.name !== ''
        ? stage.name
        : `（阶段 ${toText(stage.id)}）`,
      time: duration,
      message: stage.message === undefined || stage.message === null
        ? null
        : toText(stage.message),
    })
  }
  return rows
}

/**
 * 进度文本。
 *
 * ## 为什么要把「跳过」单独算出来
 *
 * `failed` 和 `skipped` 都算「已结束」，所以早先的实现把它们一视同仁，
 * 只报「已完成数 / 总数」。但失败时的情形长这样：
 *
 *   预检:failed  项目构建:skipped  准备运行时:skipped ... 校验产物:skipped
 *
 * 8 个阶段里 7 个是跳过的，真正跑过的只有 1 个。这时显示
 * **「8 / 8 阶段 · 2ms」** 会让用户以为整个流程跑完了 —— 实际是
 * 第 1 步就挂了，剩下 7 步一步没走。这不是小数点的偏差，是把
 * 「几乎没跑」说成「全跑完」。
 *
 * 所以：有跳过时把「真正跑过的」放前面。`8 / 8 阶段 · 7 项跳过` 这种
 * 说法自相矛盾 —— 8 个都「结束」了却有 7 个没走。改成
 * `1 / 8 阶段 · 7 项跳过`：分母是全部阶段，分子是**真正跑过**的。
 * 全部正常完成时不出现这个分支，仍显示简洁的「8 / 8」。
 *
 * @param {object|null} report
 * @param {number} [fallbackMs]
 * @returns {string}
 */
export function progressText(report, fallbackMs = 0) {
  const stages = asArray(isPlainObject(report) ? report.stages : undefined)
  const skipped = stages.filter(
    (stage) => isPlainObject(stage) && stage.status === 'skipped').length
  const ran = stages.filter(
    (stage) => isPlainObject(stage) && SETTLED.has(stage.status)
      && stage.status !== 'skipped').length
  const duration = isPlainObject(report) && typeof report.durationMs === 'number'
    ? report.durationMs
    : fallbackMs
  if (stages.length === 0) return `无阶段记录 · ${String(duration)}ms`

  const total = String(stages.length)
  if (skipped === 0) {
    // 没有跳过：分子分母都是「已结束」，正常情况
    const settled = stages.filter(
      (stage) => isPlainObject(stage) && SETTLED.has(stage.status)).length
    return `${String(settled)} / ${total} 阶段 · ${String(duration)}ms`
  }
  return `${String(ran)} / ${total} 阶段 · ${String(skipped)} 项跳过 · ${String(duration)}ms`
}

/**
 * 校验项。
 *
 * ## 为什么 `passed` 与 `ok` 都认
 *
 * 契约规定 `passed`，但实际运行时 exeonmac 用 `passed`、另外三个
 * 方向用 `ok`。字段名不一致是契约执行不彻底的典型表现 —— 前端两个
 * 都认，保证不会因为读不到 `passed` 就把「通过」显示成「失败」。
 * 契约检查会把这种不一致单独标出来，那是**应该修的地方**，但界面
 * 不该在修好之前骗人。
 *
 * @param {object|null} report
 * @returns {{rows: Array<object>, total: number, failed: number, present: boolean}}
 */
export function checkRows(report) {
  const source = isPlainObject(report) ? report.checks : undefined
  if (!Array.isArray(source) || source.length === 0) {
    return { rows: [], total: 0, failed: 0, present: false }
  }

  const rows = []
  for (const check of source) {
    if (!isPlainObject(check)) {
      rows.push({
        passed: false,
        mark: '✗',
        name: `（非法校验项：${toText(check)}）`,
        detail: '',
      })
      continue
    }
    /*
     * 判定优先级：布尔型 passed → 布尔型 ok → 视为未通过。
     *
     * 用 `typeof === 'boolean'` 而不是真值判断，是为了让 `passed: "false"`
     * 这种字符串不会因为非空而被当成通过。
     */
    const passed = typeof check.passed === 'boolean'
      ? check.passed
      : (typeof check.ok === 'boolean' ? check.ok : false)
    rows.push({
      passed,
      mark: passed ? '✓' : '✗',
      name: typeof check.name === 'string' && check.name !== ''
        ? check.name
        : '（未命名校验项）',
      detail: check.detail === undefined || check.detail === null
        ? ''
        : toText(check.detail),
    })
  }

  const failed = rows.filter((row) => !row.passed).length
  return { rows, total: rows.length, failed, present: true }
}

/**
 * 校验项摘要文案。
 *
 * ## 为什么这里也要防 null
 *
 * 本文件的约定是「拿到什么都不许抛」—— 因为这些函数在 SSE 的 done
 * 回调里调用，抛出会让**后面所有界面更新都不执行**，面板永远停在
 * 「运行中」，用户看到的是卡死的界面。
 *
 * 早先这个函数直接 `summary.present`，传 null 就
 * `TypeError: Cannot read properties of null`。它是整个文件里唯一
 * 一处没做防护的，因为「摘要显然来自 checkRows」看起来不需要防。
 * 但 `finishJob` 里 `renderChecks` 的调用链上有 `report` 可能为 null
 * 的分支 —— 约定不能靠「调用方保证」来维持。
 *
 * @param {{present?: boolean, total?: number, failed?: number} | null} summary
 * @returns {string}
 */
export function checksSummary(summary) {
  if (!isPlainObject(summary) || summary.present !== true) return ''
  const failed = typeof summary.failed === 'number' ? summary.failed : 0
  const total = typeof summary.total === 'number' ? summary.total : 0
  return failed === 0
    ? `全部通过（${String(total)}）`
    : `${String(failed)} 项未通过 / 共 ${String(total)}`
}

/**
 * 产物行。
 *
 * 每项带 `index`，供下载链接拼 `/api/artifact/<jobId>/<index>` —— 用
 * 序号而不是路径，是为了不让服务端开出一个任意文件读取接口。
 *
 * @param {object|null} report
 * @returns {Array<{index: number, path: string, usable: boolean}>}
 */
export function artifactRows(report) {
  const rows = []
  const source = asArray(isPlainObject(report) ? report.artifacts : undefined)
  source.forEach((artifact, index) => {
    /*
     * 契约规定 artifacts 的每项是对象且有 path。但真实数据里可能是
     * 裸字符串（早期版本）或 null（组装时漏了判空）。
     *
     * 三种都渲染，只是 usable 不同：null / 空路径不给下载链接，因为
     * 服务端拿它去 stat 只会 404，点了没反应比没有按钮更让人困惑。
     */
    if (artifact === null || artifact === undefined) {
      rows.push({ index, path: '（空产物项）', usable: false })
      return
    }
    if (typeof artifact === 'string') {
      rows.push({ index, path: artifact, usable: artifact !== '' })
      return
    }
    if (!isPlainObject(artifact)) {
      rows.push({ index, path: toText(artifact), usable: false })
      return
    }
    const path = typeof artifact.path === 'string' ? artifact.path : ''
    rows.push({
      index,
      path: path !== '' ? path : `（产物项无 path：${toText(artifact)}）`,
      usable: path !== '',
    })
  })
  return rows
}

/**
 * 警告行。
 *
 * 契约里 warnings 是字符串数组，但对象也时有出现（某些方向直接塞了
 * 整个 check 对象）。一律 `toText` 渲染，不因类型不对而整段不显示。
 *
 * @param {object|null} report
 * @returns {string[]}
 */
export function warningRows(report) {
  return asArray(isPlainObject(report) ? report.warnings : undefined)
    .filter((item) => item !== null && item !== undefined && item !== '')
    .map((item) => toText(item))
}

/**
 * 错误框。
 *
 * @param {object|null} report
 * @returns {{code: string, message: string, hint: string|null}|null}
 */
export function errorBox(report) {
  if (!isPlainObject(report)) return null
  const error = report.error
  if (error === null || error === undefined) return null

  // error 本身不是对象时，直接把它的值展示出来，别假装有 code
  if (!isPlainObject(error)) {
    return { code: 'ERROR', message: toText(error), hint: null }
  }
  return {
    code: typeof error.code === 'string' && error.code !== ''
      ? error.code
      : 'ERROR',
    message: error.message === undefined || error.message === null
      ? ''
      : toText(error.message),
    hint: error.hint === undefined || error.hint === null
      ? null
      : toText(error.hint),
  }
}

/**
 * 历史条目 → 显示文案。
 *
 * 服务端算好的摘要也可能缺字段（旧版本任务、序列化异常）。这里全部
 * 走 `toText` 并有默认值，保证一行历史总能显示出来。
 *
 * @param {object} item
 * @returns {{ok: boolean, label: string, clock: string, meta: string}}
 */
export function historyRow(item) {
  const record = isPlainObject(item) ? item : {}

  const started = typeof record.startedAt === 'number'
    ? new Date(record.startedAt)
    : null
  /*
   * 时间无效时显示 `--:--:--` 而不是 `NaN:NaN:NaN`。
   * `new Date(undefined)` 得到 Invalid Date，getHours() 返回 NaN。
   */
  const clock = started !== null && !Number.isNaN(started.getTime())
    ? `${String(started.getHours()).padStart(2, '0')}:`
      + `${String(started.getMinutes()).padStart(2, '0')}:`
      + `${String(started.getSeconds()).padStart(2, '0')}`
    : '--:--:--'

  const duration = typeof record.durationMs === 'number'
    ? `${String(record.durationMs)}ms`
    : '—'
  const count = typeof record.artifactCount === 'number' ? record.artifactCount : 0

  return {
    ok: record.ok === true,
    label: `${toText(record.direction) || '未知方向'} ${toText(record.command) || '未知命令'}`,
    clock,
    meta: record.errorCode !== null && record.errorCode !== undefined
      ? `${toText(record.errorCode)} · ${duration}`
      : duration + (count > 0 ? ` · ${String(count)} 个产物` : ''),
  }
}

/** 契约检查结果 → 渲染模型。 */
export function contractRows(result) {
  const blocks = []
  for (const entry of asArray(isPlainObject(result) ? result.results : undefined)) {
    if (!isPlainObject(entry)) continue
    const scenarios = []
    for (const scenario of asArray(entry.scenarios)) {
      if (!isPlainObject(scenario)) continue
      const problems = []
      for (const problem of asArray(scenario.problems)) {
        if (!isPlainObject(problem)) continue
        problems.push({
          check: toText(problem.check) || '未分类',
          detail: toText(problem.detail),
        })
      }
      scenarios.push({
        ok: scenario.ok === true,
        name: toText(scenario.scenario) || '未命名场景',
        problems,
      })
    }
    blocks.push({
      ok: entry.ok === true,
      direction: toText(entry.direction) || '未知方向',
      scenarios,
    })
  }
  return blocks
}
