/**
 * 跨方向契约一致性检查。
 *
 * ## 与 contracts/validate.mjs 的分工
 *
 * | 工具 | 检查对象 | 回答的问题 |
 * |---|---|---|
 * | `contracts/validate.mjs` | 契约文件自身 | 「契约定义自相矛盾吗？」 |
 * | 本模块 | 四个方向的**运行时输出** | 「四个方向真的遵守契约吗？」 |
 *
 * 前者是静态的、只看 JSON；后者必须真的把四个方向跑起来，读它们
 * 吐出的报告。这是唯一能发现「某方向偷偷改了字段名」的办法 ——
 * 静态扫描源码做不到，因为报告是运行时拼出来的。
 *
 * ## 检查项
 *
 * 1. **报告结构**：必需字段齐全、类型正确、无多余字段
 * 2. **方向标识**：`direction` 必须与调用方一致（防止复制粘贴串台）
 * 3. **ok 与 exitCode 一致**：`ok === (exitCode === 0)`，这是契约明文
 * 4. **错误码前缀**：失败报告的 `error.code` 必须用本方向的前缀
 * 5. **错误码段位**：段位必须落在契约定义的范围内
 * 6. **阶段结构**：`stages` 是数组，每项有 id/name/status
 * 7. **阶段连续性**：失败后不应有后续阶段（契约要求「失败即停」）
 *
 * ## 为什么每条检查都要给出「证据」
 *
 * 只说「不符合契约」对修 bug 没有帮助。每条失败都带上实际值与期望值，
 * 用户能直接定位到是哪个字段、哪个方向出的问题。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')

/** 报告必需字段，与 run-report.schema.json 的 required 一致。 */
export const REQUIRED_REPORT_FIELDS = [
  'schemaVersion', 'direction', 'ok', 'exitCode',
  'startedAt', 'finishedAt', 'stages',
]

/**
 * 允许出现在报告顶层的字段。
 *
 * ## 为什么改成从 schema 现读，而不是维护一份常量表
 *
 * 早先这里是一份手写的常量表，两次出事：
 *
 *   1. 漏了 schema 里的 `checks`，四个方向的 doctor 报告全被误判为
 *      「有多余字段」—— 检查器自己制造噪音，比不检查更糟，因为用户
 *      看到一堆无意义失败后就开始忽略真正的违规。
 *   2. 反过来多了 schema 里根本没有的 `config` 与 `nextSteps`，于是
 *      检查器比契约更宽松：真有人写出 `config` 字段也放行，而 schema
 *      的 `additionalProperties: false` 明令禁止。
 *
 * 两次都是同一个根因：**同一份信息存了两份**。改成从 schema 现读之后
 * 这个类别的 bug 在结构上就不可能发生。
 *
 * @param {object} schema run-report.schema.json 的内容。
 * @returns {string[]}
 */
export function allowedReportFields(schema) {
  return Object.keys(schema.properties).sort()
}

/**
 * JSON Schema 的 `type` 关键字 → JS 判定函数。
 *
 * 只覆盖本契约实际用到的类型。`integer` 与 `number` 分开是因为
 * `exitCode: 1.5` 这种值 schema 明确不允许，用 `typeof === 'number'`
 * 会放过去。
 */
const TYPE_CHECKS = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  object: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  array: (value) => Array.isArray(value),
  null: (value) => value === null,
}

/**
 * 判断值是否符合 schema 的 type 声明。
 *
 * type 可以是单值（`"object"`），也可以是数组（`["object", "null"]`）——
 * 后者表示可空。两种都要支持。
 *
 * @param {unknown} value
 * @param {string|string[]} declared
 * @returns {boolean}
 */
function typeMatches(value, declared) {
  const names = Array.isArray(declared) ? declared : [declared]
  return names.some((name) => TYPE_CHECKS[name]?.(value) === true)
}

/** 把 type 声明渲染成人读文本，用于问题描述。 */
function describeType(declared) {
  return Array.isArray(declared) ? declared.join('|') : String(declared)
}

/**
 * 顺着 schema 递归找出嵌套层的问题。
 *
 * 只做两件事：`required` 缺字段、`additionalProperties: false` 有多余
 * 字段。**不做类型判定** —— 顶层已经用 `report.field_type` 报过，这里
 * 再报一次只是换个措辞说同一件事，噪音对定位没帮助。
 *
 * ## 为什么用递归而不是逐层手写
 *
 * schema 的嵌套深度是它自己的事（今天 `stages.items` 只有一层，明天加了
 * `checks[].details[]` 就得改代码）。递归之后 schema 改了这里自动跟随，
 * 不会再出现「schema 加了新约束、检查器不知道」这类分叉。
 *
 * @param {unknown} value 顶层某字段的实际值
 * @param {object} definition 该字段的 schema 片段
 * @param {string} path 报告的字段路径，如 `stages`
 * @returns {Array<{check: string, detail: string}>}
 */
function nestedSchemaIssues(value, definition, path) {
  const issues = []

  if (Array.isArray(value) && definition.items !== undefined) {
    value.forEach((item, index) => {
      issues.push(...nestedSchemaIssues(item, definition.items, `${path}[${String(index)}]`))
    })
    return issues
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) return issues

  const properties = definition.properties ?? {}
  for (const key of definition.required ?? []) {
    if (!Object.hasOwn(value, key)) {
      issues.push({
        check: 'report.nested_required',
        detail: `${path} 缺少必填字段 ${key}`,
      })
    }
  }
  if (definition.additionalProperties === false) {
    const extra = Object.keys(value).filter((key) => !Object.hasOwn(properties, key))
    if (extra.length > 0) {
      issues.push({
        check: 'report.nested_extra_fields',
        detail: `${path} 有契约未定义的字段：${extra.join(', ')}`,
      })
    }
  }
  for (const [key, child] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key)) continue
    issues.push(...nestedSchemaIssues(value[key], child, `${path}.${key}`))
  }
  return issues
}

/** 合法的阶段状态。 */
const STAGE_STATUSES = new Set(['ok', 'failed', 'skipped', 'running', 'pending'])

/**
 * 读契约文件。
 *
 * @returns {{prefixes: object, segments: object, exitCodes: object, schema: object}}
 */
export function loadContract() {
  const read = (name) => JSON.parse(readFileSync(join(REPO, 'contracts', name), 'utf8'))
  const prefixesFile = read('error-prefixes.json')
  return {
    prefixes: prefixesFile.prefixes,
    reservedPrefixes: prefixesFile.reservedPrefixes ?? [],
    segments: prefixesFile.segments,
    exitCodes: read('exit-codes.json'),
    schema: read('run-report.schema.json'),
  }
}

/**
 * 判断一个错误码落在哪个段位。
 *
 * 段位定义里有两种形态：范围（`1001-1999`）与单值（`9999`）。
 *
 * **前缀可以含数字**：契约里 `M2W`（Mac2Win）与 `W2M`（Win2Mac）都
 * 带数字 2。早期实现只允许 `[A-Z]`，导致这两个方向的错误码全部
 * 被判为「格式不符」—— 这类 bug 只在真实数据上才暴露。
 *
 * @param {string} code 形如 `M2W_1001`。
 * @param {object} segments 契约的 segments。
 * @returns {{ok: boolean, segment: string|null, reason: string}}
 */
export function classifyCode(code, segments) {
  const match = /^([A-Z][A-Z0-9]{1,3})_(\d{4})$/u.exec(code)
  if (match === null) {
    return { ok: false, segment: null, reason: `错误码格式不符：${code}（应为 PREFIX_NNNN）` }
  }

  const numeric = Number(match[2])
  for (const [key, definition] of Object.entries(segments)) {
    const range = definition.range
    if (!range.includes('-')) {
      // 单值段位，如 9999
      if (numeric === Number(range)) return { ok: true, segment: key, reason: '' }
      continue
    }
    const [low, high] = range.split('-').map(Number)
    if (numeric >= low && numeric <= high) {
      return { ok: true, segment: key, reason: '' }
    }
  }
  return {
    ok: false,
    segment: null,
    reason: `错误码 ${code} 的段位 ${String(numeric)} 不在任何已定义范围内`,
  }
}

/**
 * 检查「退出码 ↔ 错误码」是否配对。
 *
 * ## 这一条守的是什么
 *
 * 报告里 `exitCode` 和 `error.code` 是**两个独立算出来的值**，分别写在
 * 两个地方。契约对每一对都有明文规定：
 *
 *   退出码 2 → 1002/1003/1004（参数与输入）
 *   退出码 4 → 1005（明确不支持）
 *   退出码 5 → 2001/2002（缺外部依赖）
 *   退出码 1 → 9999（未归类）
 *
 * 两边分叉时，报告看起来「结构完全合法」—— 字段齐全、类型正确、
 * 前缀是本人的、段位也存在。**每一种单项检查都会放行**，只有把
 * 两者放在一起比对才看得出来。
 *
 * ## 真实发生过的例子
 *
 * `apponwin spike` 在缺 WSL2/Darling 时退出码是 5，但报告里填的是
 * `AOW_1001`（1xxx 段，按契约属退出码 2）。同一份报告里两个值互斥，
 * 而那个文件自己的 `exitCodeFor(AOW_1001)` 返回的是 2 —— 同一个错误码
 * 在同一份代码里有两个退出码。
 *
 * 后果落在脚本层：CI 看到 5 认为「装个 WSL2 就能过」，但报告说是 1001
 * （环境与输入），不知道该信哪个，自动化只能二选一猜。
 *
 * @param {object} input
 * @param {string} input.direction
 * @param {number} input.exitCode
 * @param {string} input.code
 * @param {object} input.contract
 * @returns {string|null} 不配对时返回说明，配对或无法判断时返回 null
 */
function exitCodeMismatch(direction, exitCode, code, contract) {
  const declared = contract.exitCodes?.codes?.[String(exitCode)]
  // 契约没给这个退出码声明段位（例如 0 成功、130 中断）就不用比
  if (declared?.errorSegment === null || declared?.errorSegment === undefined) return null

  const tail = code.slice(code.indexOf('_') + 1)
  if (!/^\d{4}$/u.test(tail)) return null

  /*
   * errorSegment 可能是「1003/1004」（列举）或「4001-5002」（范围）。
   * 两种都要支持 —— 只处理列举会让 6xxx/7xxx 段的配对检查静默失效。
   */
  const parts = String(declared.errorSegment).split('/').map((part) => part.trim())
  for (const part of parts) {
    if (part.includes('-')) {
      const [low, high] = part.split('-').map(Number)
      const numeric = Number(tail)
      if (numeric >= low && numeric <= high) return null
    } else if (part === tail) {
      return null
    }
  }

  return `${direction} 的退出码 ${String(exitCode)} 在契约里对应错误码 `
    + `${String(declared.errorSegment)}，但报告给的是 ${code}。`
    + '两个值各算一处、对不上时脚本无法判断该按哪个分流'
}

/**
 * 检查一份报告。
 *
 * @param {object} input
 * @param {string} input.direction 期望的方向标识。
 * @param {object|null} input.report 实际报告（可能为 null）。
 * @param {number} input.exitCode 进程退出码。
 * @param {object} input.contract {@link loadContract} 的返回值。
 * @param {string} [input.expectedCommand] 期望的 command 字段值。
 * @returns {{ok: boolean, problems: Array<{check: string, detail: string}>}}
 */
export function checkReport(input) {
  const { direction, report, exitCode, contract, expectedCommand } = input
  const problems = []
  const add = (check, detail) => { problems.push({ check, detail }) }

  if (report === null || report === undefined) {
    add('report.present',
      `${direction} 没有输出可解析的 JSON 报告（退出码 ${String(exitCode)}）`)
    return { ok: false, problems }
  }
  if (typeof report !== 'object' || Array.isArray(report)) {
    add('report.object', `${direction} 的报告不是对象`)
    return { ok: false, problems }
  }

  /*
   * ① 必需字段。
   *
   * 用 hasOwnProperty 而不是 `field in report`：后者会命中原型链，
   * 一份 `{"__proto__": ...}` 或从 Object.prototype 被污染的进程里
   * 拿到的报告会让检查误判为「字段齐全」。
   */
  const missing = REQUIRED_REPORT_FIELDS.filter(
    (field) => !Object.hasOwn(report, field))
  if (missing.length > 0) {
    add('report.required_fields', `${direction} 缺少字段：${missing.join(', ')}`)
  }

  // ② 多余字段（schema 是 additionalProperties: false）
  const allowed = new Set(allowedReportFields(contract.schema))
  const extra = Object.keys(report).filter((key) => !allowed.has(key))
  if (extra.length > 0) {
    add('report.no_extra_fields',
      `${direction} 有契约未定义的字段：${extra.join(', ')}`)
  }

  /*
   * ②b 各字段的类型。
   *
   * 这一条来自实际探测：早先的实现只在自己「用得着」的地方做
   * `Array.isArray` 判断，类型不对就静静跳过那一段 —— 于是
   * `checks: {}`、`warnings: "x"`、`ok: "true"`、`exitCode: "0"`
   * 全部被判为合法。检查器对类型错误整体失明。
   *
   * 前端会因此显示错东西：`ok: "true"` 是 truthy，但 `ok === true`
   * 是 false，两处判断不一致时界面就会自相矛盾。
   */
  for (const [field, definition] of Object.entries(contract.schema.properties)) {
    if (!Object.hasOwn(report, field)) continue
    if (definition.type === undefined) continue
    if (!typeMatches(report[field], definition.type)) {
      const actual = report[field] === null ? 'null' : typeof report[field]
      add('report.field_type',
        `${direction} 的 ${field} 类型是 ${actual}，契约要求 ${describeType(definition.type)}`)
    }
  }

  /*
   * ②c 嵌套层（stages[] / artifacts[] / checks[] / error / host / input）。
   *
   * ## 为什么顶层查过还要查一层
   *
   * schema 里**每一层**都写着 `additionalProperties: false`，但早先的
   * 实现只比对顶层键集。于是：
   *
   *   - `stages: [{id, name, status, bogus: 1}]` → 放行
   *   - `artifacts: [{path, kind, bytes, 乱写: 1}]` → 放行
   *
   * 这层恰恰最容易乱改：报告结构里真正会被手抖改名的就是阶段与产物的
   * 字段，而它们又直接喂给前端渲染。顶层严防、内层敞开，等于没防。
   *
   * 实现上直接顺着 schema 递归，不另写一份字段表 —— 理由同
   * {@link allowedReportFields} 的注释：同一信息存两份必然分叉。
   */
  for (const [field, definition] of Object.entries(contract.schema.properties)) {
    if (!Object.hasOwn(report, field) || definition.type === undefined) continue
    if (!typeMatches(report[field], definition.type)) continue   // 类型错已在上一步报过
    for (const issue of nestedSchemaIssues(report[field], definition, field)) {
      add(issue.check, `${direction} 的 ${issue.detail}`)
    }
  }

  // ③ schemaVersion
  if (report.schemaVersion !== undefined && report.schemaVersion !== 1) {
    add('report.schema_version',
      `${direction} 的 schemaVersion 是 ${String(report.schemaVersion)}，期望 1`)
  }

  /*
   * ③b direction 必须落在 schema 的 enum 内。
   *
   * 下面的 ④ 比对「与实际调用的方向一致」，比这条更严 —— 但它有个漏
   * 洞：调用方传什么它比什么。若 `report.direction` 与调用方**都**写成
   * 一个契约里没有的值（复制粘贴出来的新方向、拼错的 `mac2windows`），
   * ④ 会一路放行。契约的 enum 是独立的第二道判断，不能省。
   */
  const directionEnum = contract.schema.properties?.direction?.enum
  if (Array.isArray(directionEnum) && report.direction !== undefined
    && !directionEnum.includes(report.direction)) {
    add('report.direction_enum',
      `${direction} 的 direction 字段是 "${String(report.direction)}"，`
      + `契约只允许 ${directionEnum.join('/')}`)
  }

  // ④ direction 与调用方一致（防止复制粘贴串台）
  if (report.direction !== direction) {
    add('report.direction_match',
      `${direction} 的报告 direction 字段是 "${String(report.direction)}"`)
  }

  /*
   * ④b command 与实际执行的子命令一致。
   *
   * 这条来自一个真实缺陷：三个 Node 方向的 report.mjs 都是从 mac2win
   * 拷来的，`command` 硬编码成 `'build'`，于是 `doctor` 的报告里也写
   * 着 `build`。前端按这个字段显示「正在执行什么」，写错会让用户
   * 看到完全不符的操作名。
   *
   * 这个字段结构完全合法，只有和调用方比对才能发现。
   */
  if (expectedCommand !== undefined
    && report.command !== undefined
    && report.command !== expectedCommand) {
    add('report.command_match',
      `${direction} 执行 ${expectedCommand} 但报告 command 是 "${String(report.command)}"`)
  }

  // ⑤ ok 与 exitCode 一致 —— 契约明文要求
  if (typeof report.ok === 'boolean' && typeof report.exitCode === 'number') {
    const expected = report.exitCode === 0
    if (report.ok !== expected) {
      add('report.ok_matches_exit_code',
        `${direction} 的 ok=${String(report.ok)} 但 exitCode=${String(report.exitCode)}`)
    }
  }

  // ⑥ 报告里的 exitCode 与真实进程退出码一致
  if (typeof report.exitCode === 'number' && report.exitCode !== exitCode) {
    add('report.exit_code_matches_process',
      `${direction} 报告里 exitCode=${String(report.exitCode)}，` +
      `实际进程退出码=${String(exitCode)}`)
  }

  // ⑦ 阶段结构
  if (Array.isArray(report.stages)) {
    report.stages.forEach((stage, index) => {
      if (typeof stage !== 'object' || stage === null) {
        add('report.stage_shape', `${direction} 的 stages[${String(index)}] 不是对象`)
        return
      }
      if (!Number.isInteger(stage.id)) {
        add('report.stage_shape', `${direction} 的 stages[${String(index)}].id 不是整数`)
      }
      if (typeof stage.name !== 'string' || stage.name === '') {
        add('report.stage_shape', `${direction} 的 stages[${String(index)}].name 为空`)
      }
      if (!STAGE_STATUSES.has(stage.status)) {
        add('report.stage_status',
          `${direction} 的 stages[${String(index)}].status 是 "${String(stage.status)}"，` +
          `允许值：${[...STAGE_STATUSES].join('/')}`)
      }
    })

    /*
     * 失败即停：一旦某阶段 failed，其后不应有 ok 的阶段。
     *
     * 这是契约的明文要求。违反通常意味着实现里没有在失败处 return，
     * 继续跑了后续步骤 —— 那会产出半成品。
     *
     * **必须先过滤掉非对象项再判断。** 上面那条 forEach 有 null 保护，
     * 但这里若直接对原始数组取 `.status`，一个 `stages: [null]` 就会
     * 抛 TypeError。而 runContractCheck 的 try 同时罩着 input.run 和
     * checkReport，抛出来的异常会被记成「调用 <方向> 抛错」—— 用户会
     * 跑去查子进程，实际是检查器自己崩了。这类错误归因会浪费大量时间。
     */
    const usable = report.stages.filter(
      (stage) => typeof stage === 'object' && stage !== null)
    const failedAt = usable.findIndex((stage) => stage.status === 'failed')
    if (failedAt >= 0) {
      const after = usable
        .slice(failedAt + 1)
        .filter((stage) => stage.status === 'ok')
      if (after.length > 0) {
        add('report.stage_stop_on_failure',
          `${direction} 在阶段 ${String(failedAt)} 失败后仍执行了 ` +
          `${String(after.length)} 个阶段：${after.map((s) => s.name).join(', ')}`)
      }
    }
  } else if (report.stages !== undefined) {
    add('report.stages_array', `${direction} 的 stages 不是数组`)
  }

  /*
   * ⑦b checks 项的结构。
   *
   * 契约规定每项必须有 `passed`（run-report.schema.json 的
   * checks.items.required）。但实际运行时发现方向之间不一致：
   * exeonmac 用 `passed`，另外几个方向用 `ok`。
   *
   * 字段名不一致的后果是前端把「通过」显示成「失败」—— 因为它读不到
   * `passed` 就当成 falsy。这类问题在结构层面完全合法，只有跨方向
   * 比对才能发现。
   */
  if (Array.isArray(report.checks)) {
    report.checks.forEach((check, index) => {
      if (typeof check !== 'object' || check === null) {
        add('report.check_shape', `${direction} 的 checks[${String(index)}] 不是对象`)
        return
      }
      if (typeof check.name !== 'string' || check.name === '') {
        add('report.check_shape', `${direction} 的 checks[${String(index)}].name 为空`)
      }
      if (typeof check.passed !== 'boolean') {
        add('report.check_passed_field',
          `${direction} 的 checks[${String(index)}] 缺少布尔型 passed 字段` +
          `（实际键：${Object.keys(check).join(', ')}）`)
      }
    })
  } else if (report.checks !== undefined) {
    add('report.checks_array', `${direction} 的 checks 不是数组`)
  }

  /*
   * ⑦c artifacts 项的结构。
   *
   * 这一条来自一个真实的 500：`artifacts: [null]` 时服务端的下载接口
   * 直接 `artifacts[index].path` 抛 TypeError，整个请求变成 500。看板
   * 上表现为「产物下载点了没反应」，而真正的错误被埋在服务端日志里。
   *
   * 契约检查在源头就把它标出来，比等用户点下载才发现好得多。
   */
  if (Array.isArray(report.artifacts)) {
    report.artifacts.forEach((artifact, index) => {
      if (typeof artifact !== 'object' || artifact === null) {
        add('report.artifact_shape',
          `${direction} 的 artifacts[${String(index)}] 不是对象`)
        return
      }
      if (typeof artifact.path !== 'string' || artifact.path === '') {
        add('report.artifact_shape',
          `${direction} 的 artifacts[${String(index)}].path 为空或不是字符串`)
      }
    })
  } else if (report.artifacts !== undefined) {
    add('report.artifacts_array', `${direction} 的 artifacts 不是数组`)
  }

  // ⑦d warnings 是字符串数组（schema: items.type = string）
  if (Array.isArray(report.warnings)) {
    report.warnings.forEach((warning, index) => {
      if (typeof warning !== 'string') {
        add('report.warning_shape',
          `${direction} 的 warnings[${String(index)}] 不是字符串`)
      }
    })
  } else if (report.warnings !== undefined) {
    add('report.warnings_array', `${direction} 的 warnings 不是数组`)
  }

  // ⑧ 错误码
  if (report.error !== undefined && report.error !== null) {
    /*
     * error 必须是对象。`error: "boom"`、`error: 500` 这类值本身类型
     * 就不对 —— 下一步读 `report.error.code` 会得到 undefined，
     * 被报成「有 error 对象但缺 code」，那是在描述一个不存在的现象
     * （根本没有 code 这个字段可缺）。先定位类型问题。
     */
    if (typeof report.error !== 'object' || Array.isArray(report.error)) {
      add('error.object',
        `${direction} 的 error 是 ${Array.isArray(report.error) ? '数组' : typeof report.error}，` +
        '契约要求 object 或 null')
      return { ok: problems.length === 0, problems }
    }
    const code = report.error.code
    if (typeof code !== 'string') {
      add('error.code_present', `${direction} 有 error 对象但缺 code`)
    } else {
      const expectedPrefix = contract.prefixes[direction]
      const actualPrefix = code.split('_')[0]
      if (expectedPrefix !== undefined && actualPrefix !== expectedPrefix) {
        add('error.prefix',
          `${direction} 的错误码 ${code} 前缀是 ${actualPrefix}，` +
          `契约要求 ${expectedPrefix}`)
      }
      if (contract.reservedPrefixes.includes(actualPrefix)) {
        add('error.prefix_reserved',
          `${direction} 使用了保留前缀 ${actualPrefix}`)
      }
      const classified = classifyCode(code, contract.segments)
      if (!classified.ok) {
        add('error.segment', classified.reason)
      }

      /*
       * 退出码与错误码必须配对。
       *
       * 这一条和上面几条的区别：前缀对、段位存在、结构合法，**每一项
       * 单项检查都通过**，只有把退出码和错误码放在一起比对才看得出
       * 矛盾。详见 exitCodeMismatch 的说明。
       */
      const mismatch = exitCodeMismatch(
        direction, exitCode, code, contract)
      if (mismatch !== null) add('error.exit_code_pair', mismatch)
    }
  }

  // ⑨ ok=false 时应该有 error
  if (report.ok === false && (report.error === undefined || report.error === null)) {
    add('error.required_on_failure',
      `${direction} 的 ok=false 但报告里没有 error 对象`)
  }

  /*
   * ⑩ ok=true 时 error 必须为 null。
   *
   * 这是 schema 末尾 `allOf` 的第二条 if/then，与 ⑨ 是一对。早先只实现了
   * 一半 —— 失败必须有 error，却不管成功带着 error 的情况。
   *
   * 后果很具体：前端按 `report.error` 判断要不要显示红色失败提示，按
   * `report.ok` 判断要不要显示成功横幅。两个都读时，同一份报告会渲染出
   * 「成功」和「失败」两块自相矛盾的界面。用户唯一的感受是「这工具坏了」。
   */
  if (report.ok === true && report.error !== undefined && report.error !== null) {
    add('error.forbidden_on_success',
      `${direction} 的 ok=true 但报告里带着 error 对象（契约要求 ok=true 时 error 为 null）`)
  }

  return { ok: problems.length === 0, problems }
}

/**
 * 各方向的「读取类」命令 —— 传一个不存在的路径必然失败，且失败路径
 * 必须带 error 对象。这是验证错误码前缀与段位最可靠的方式。
 *
 * 为什么不能统一用 `verify`：四个方向的命令集并不完全相同。exeonmac
 * 的等价命令是 `detect`（识别安装器类型），apponwin 是 `parse`
 * （解析 .app）。硬套 `verify` 会让三个方向报「没有输出报告」——
 * 那是检查器用错了场景，不是方向违反了契约。
 *
 * 这类「检查器自己制造噪音」的问题比漏检更糟：一旦用户看到一堆
 * 无意义的失败，就会开始忽略真正的违规。
 */
const FAILURE_PROBES = {
  mac2win: { command: 'verify', args: [] },
  exeonmac: { command: 'detect', args: [] },
  win2mac: { command: 'verify', args: [] },
  apponwin: { command: 'parse', args: [] },
}

/** 检查时传给各方向的「不存在的输入路径」。 */
const MISSING_INPUT = '/tmp/wacmin-contract-check-nonexistent-input'

/**
 * 额外场景：可能会以「非 0 且非 2」退出码结束的命令。
 *
 * ## 为什么需要额外场景
 *
 * 前两个场景只覆盖「成功」与「输入缺失」（退出码 2）。但退出码与
 * 错误码的配对问题**恰恰只会出现在其他退出码上**：
 *
 *   - `apponwin spike` 环境不具备时退出码 5，报告却填 1xxx 段的码
 *   - `mac2win build` 缺少 makensis 时退出码 5
 *
 * 实测抓到的就是 spike 那一条：退出码 5 配 `AOW_1001`，而契约规定
 * 退出码 5 必须配 2001/2002、1001 属退出码 2。任何单项检查都放行 ——
 * 前缀是本人的、段位存在、结构合法。
 *
 * ## 为什么这些场景只要求「结构合法」，不要求成功
 *
 * 它们的结果取决于宿主环境（有没有 WSL2、有没有 makensis）。在装了
 * 依赖的机器上会成功，在没装的机器上会失败，**两种都必须符合契约**。
 * 断言具体退出码会让检查器在不同机器上时红时绿，那比不检查更糟。
 */
const EXTRA_PROBES = {
  apponwin: [
    { command: 'spike', args: [], label: 'spike' },
  ],
  mac2win: [
    /*
     * `verify` 校验一个**不存在的产物**。
     *
     * 这条会以退出码 7（产物不合格）结束，报告里是 `M2W_6001`。
     * 契约规定退出码 7 对应 6001-6003，必须配上——这里能抓到
     * 「不合格却报 1xxx」这类错配。
     *
     * 不带 `--report` 时它只打日志不吐 JSON，所以这里要显式加。
     */
    {
      command: 'verify',
      args: [MISSING_INPUT, '--report'],
      label: 'verify-缺产物',
    },
  ],
}

/**
 * 跑一个场景：调用方向，然后检查它吐出的报告。
 *
 * ## 为什么把「调用」与「检查」分成两个 try
 *
 * 早先这两件事共用一个 try，于是**检查器自己抛异常时也会走进 catch**，
 * 被记成「调用 <方向> 抛错」。实测 `stages: [null]` 就能触发：
 *
 *     [scenario.crash] 调用 mac2win doctor 抛错：
 *     TypeError: Cannot read properties of null (reading 'status')
 *
 * 这条消息把使用者引向 mac2win 的子进程，而 mac2win 其实完全正常 ——
 * 是契约检查器在读报告时崩了。**错误归因错了比不报错更浪费时间**，
 * 用户会去翻一个无辜方向的源码。
 *
 * 分开之后，两类问题各有各的措辞：调用失败说「调用抛错」，检查失败
 * 说「检查器自身异常」。后者是我们自己的 bug，必须一眼能认出来。
 *
 * @param {object} input
 * @returns {Promise<object>} 一个 scenario 结果。
 */
async function runScenario(input) {
  const { direction, command, args, run, contract, scenario } = input

  let outcome
  try {
    outcome = await run(direction, command, args)
  } catch (error) {
    return {
      scenario,
      exitCode: -1,
      ok: false,
      problems: [{
        check: 'scenario.crash',
        detail: `调用 ${direction} ${command} 抛错：${String(error)}`,
      }],
    }
  }

  const { exitCode, report } = outcome ?? {}

  try {
    return {
      scenario,
      exitCode: exitCode ?? -1,
      ...checkReport({
        direction, report: report ?? null, exitCode: exitCode ?? -1,
        contract, expectedCommand: command,
      }),
    }
  } catch (error) {
    /*
     * 走到这里说明 checkReport 自身有 bug（或某份报告的畸形程度超出
     * 它的防御）。明确标注为检查器缺陷，不要伪装成方向的问题。
     */
    return {
      scenario,
      exitCode: exitCode ?? -1,
      ok: false,
      problems: [{
        check: 'checker.crash',
        detail: `契约检查器在检查 ${direction} 的报告时自身异常：${String(error)}` +
          '（这是 console 的缺陷，不是该方向的违规）',
      }],
    }
  }
}

/**
 * 跑完整的契约检查。
 *
 * 每个方向跑两个场景：
 *
 *   1. `doctor` —— 成功或失败路径，验证基本结构与方向标识
 *   2. 读取类命令传不存在的输入 —— 验证错误码前缀与段位
 *
 * 用「必然失败」而不是「必然成功」来验错误码，因为只有失败路径
 * 才带 error 对象。
 *
 * @param {object} input
 * @param {(id: string, command: string, options?: string[]) => Promise<object>} input.run
 *   调用方向的函数，返回 `{exitCode, report}`。
 * @param {string[]} [input.directions] 要检查的方向，默认全部。
 * @returns {Promise<object>}
 */
export async function runContractCheck(input) {
  const contract = loadContract()
  const directions = input.directions ?? Object.keys(contract.prefixes)

  const results = await Promise.all(directions.map(async (direction) => {
    const scenarios = []

    /*
     * 场景 1：doctor。
     *
     * 这条可能成功也可能失败（取决于宿主环境），两种都合法 ——
     * 只要报告结构对就行。因此不要求 exitCode 为 0。
     */
    scenarios.push(await runScenario({
      direction, command: 'doctor', args: [],
      run: input.run, contract, scenario: 'doctor',
    }))

    /*
     * 场景 2：读取类命令传不存在的输入。
     *
     * 这条能验证：失败时是否真的输出 error 对象、错误码前缀是否为本
     * 方向的、段位是否落在 1xxx。
     */
    const probe = FAILURE_PROBES[direction]
    if (probe === undefined) {
      scenarios.push({
        scenario: 'missing-input',
        exitCode: -1,
        ok: false,
        problems: [{
          check: 'scenario.not_configured',
          detail: `方向 ${direction} 没有配置失败场景探测命令`,
        }],
      })
    } else {
      scenarios.push(await runScenario({
        direction, command: probe.command, args: [...probe.args, MISSING_INPUT],
        run: input.run, contract, scenario: `${probe.command}-missing-input`,
      }))
    }

    /*
     * 场景 3+：可能以「非 0 且非 2」退出码结束的命令。
     *
     * 这些是退出码与错误码配对的唯一暴露点 —— 前两个场景的退出码
     * 只可能是 0 或 2，而配对问题恰恰只在 3/4/5/6/7 上出现。
     */
    for (const extra of EXTRA_PROBES[direction] ?? []) {
      scenarios.push(await runScenario({
        direction, command: extra.command, args: [...extra.args],
        run: input.run, contract, scenario: extra.label,
      }))
    }

    return {
      direction,
      ok: scenarios.every((scenario) => scenario.ok),
      scenarios,
    }
  }))

  return {
    ok: results.every((result) => result.ok),
    contractVersion: contract.exitCodes.version ?? 1,
    results,
  }
}