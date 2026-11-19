#!/usr/bin/env node
/**
 * 契约自检 + 报告校验。
 *
 * 为什么需要这个脚本：契约是四个方向共用的对外承诺，一旦某个方向的
 * 退出码或错误码前缀写歪了，console 汇总时才会暴露，那时已经很难定位。
 * 在 CI 里跑一次，问题在提交前就拦住。
 *
 * ## 与 console/src/contract-check.mjs 的分工
 *
 * | 工具 | 检查对象 | 回答的问题 |
 * |---|---|---|
 * | 本脚本 | 契约文件 + 单份报告 | 「契约定义自相矛盾吗？这份报告合法吗？」 |
 * | console 的检查器 | 四个方向的**运行时输出** | 「四个方向真的遵守契约吗？」 |
 *
 * 前者离线可跑，不需要把任何方向跑起来，所以 CI 第一步就能跑；后者要
 * 真起子进程。两者必须对同一份报告给出**相同结论** —— 这一点由
 * `contracts/validate.test.mjs` 的一致性用例守着。
 *
 * 用法：
 *   node contracts/validate.mjs                        校验契约文件自身
 *   node contracts/validate.mjs --report r.json        校验一份 --json 报告
 *   node contracts/validate.mjs --report r.json --exit-code 2
 *                                                      同时比对真实进程退出码
 *   node contracts/validate.mjs --contracts <目录>     改用别的契约目录
 *
 * 退出码：0 通过，1 有问题，2 用法错误。
 */

import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const problems = []
const notes = []

/** 契约所在目录。`--contracts` 可改，测试用它造契约变体。 */
let contractDir = HERE

function fail(message) {
  problems.push(message)
}

function readJson(name) {
  const path = join(contractDir, name)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`${name} 读不了或不是合法 JSON：${error.message}`)
    return null
  }
}

/* ─────────────────────────── 段位与类型 ─────────────────────────── */

/**
 * JSON Schema 的 `type` 关键字 → 判定函数。
 *
 * 只覆盖本契约实际用到的类型。`integer` 与 `number` 必须分开：
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

/** `type` 可以是单值（`"object"`）或数组（`["object","null"]` 表示可空）。 */
function typeMatches(value, declared) {
  const names = Array.isArray(declared) ? declared : [declared]
  return names.some((name) => TYPE_CHECKS[name]?.(value) === true)
}

function describeType(declared) {
  return Array.isArray(declared) ? declared.join('|') : String(declared)
}

/**
 * 判断一个 4 位码值落在哪个段位。
 *
 * ## 为什么不能按首字符推
 *
 * 早先这里两处都写 `${part.slice(0, 1)}000`：拿码值首位拼桶名。段位定义
 * 规整时它看起来等价，实际不成立 —— `9999`（内部错误，独立段位）与
 * `9998`（属 9000 段，range 是 `9001-9998`）首位都是 9，全被推成 `9000`。
 *
 * 后果是 `9999` 段的定义**形同虚设**：把它从 error-prefixes.json 里整个
 * 删掉，校验仍全绿，因为没有任何码值会被推算到那个桶上。一个永远命中
 * 不了的段位定义，等于没有定义。
 *
 * 唯一可靠的依据是 `segments[x].range`，它有两种形态：
 * 范围 `1001-1999`、单值 `9999`。
 *
 * @param {number} codeNumber 4 位码值，如 9999。
 * @param {object} segments error-prefixes.json 的 segments。
 * @returns {string|null} 段位键；不在任何已定义范围内时返回 null。
 */
export function segmentOf(codeNumber, segments) {
  for (const [key, definition] of Object.entries(segments ?? {})) {
    const range = definition?.range
    if (typeof range !== 'string') continue
    if (!range.includes('-')) {
      // 单值段位，如 9999
      if (codeNumber === Number(range)) return key
      continue
    }
    const [low, high] = range.split('-').map(Number)
    if (codeNumber >= low && codeNumber <= high) return key
  }
  return null
}

/* ─────────────────────────── 契约文件自检 ─────────────────────────── */

/** 校验退出码契约：键必须是数字，含义不能重复，段位引用必须存在。 */
function checkExitCodes(exitCodes, prefixes) {
  if (exitCodes === null) return
  const seen = new Map()

  for (const [key, entry] of Object.entries(exitCodes.codes)) {
    const code = Number(key)
    if (!Number.isInteger(code) || code < 0 || code > 255) {
      fail(`exit-codes.json：退出码 ${key} 不是 0-255 的整数`)
    }
    const meaning = entry.meaning
    if (seen.has(meaning)) {
      fail(`exit-codes.json：退出码 ${key} 与 ${seen.get(meaning)} 含义重复（${meaning}）`)
    }
    seen.set(meaning, key)

    const segment = entry.errorSegment
    if (segment === null || segment === undefined) continue
    // 形如 "4001-5002" 或 "1003/1004"，逐个取出码值查它落在哪个段位
    for (const part of String(segment).split(/[/-]/)) {
      const bucket = segmentOf(Number(part), prefixes?.segments ?? {})
      if (bucket === null) {
        fail(`exit-codes.json：退出码 ${key} 引用的错误码 ${part} 不在任何段位范围内`)
      }
    }
  }

  for (const required of ['0', '1', '2', '130']) {
    if (!(required in exitCodes.codes)) {
      fail(`exit-codes.json：缺少必备退出码 ${required}`)
    }
  }
}

/** 校验错误码前缀：四个方向必须齐，前缀不能互相重复，也不能占用保留前缀。 */
function checkPrefixes(prefixes) {
  if (prefixes === null) return
  const directions = ['mac2win', 'exeonmac', 'apponwin', 'win2mac']
  const used = new Map()

  for (const direction of directions) {
    const prefix = prefixes.prefixes?.[direction]
    if (prefix === undefined) {
      fail(`error-prefixes.json：方向 ${direction} 未分配前缀`)
      continue
    }
    // 前缀允许含数字（M2W / W2M 这类方向缩写），但必须以字母开头，
    // 否则错误码正则 `^M2W_\d{4}$` 会被误读成别的结构。
    if (!/^[A-Z][A-Z0-9]{1,3}$/.test(prefix)) {
      fail(`error-prefixes.json：${direction} 的前缀 "${prefix}" 须以字母开头、2-4 位大写字母或数字`)
    }
    if (used.has(prefix)) {
      fail(`error-prefixes.json：前缀 ${prefix} 被 ${direction} 与 ${used.get(prefix)} 重复占用`)
    }
    used.set(prefix, direction)
  }

  for (const reserved of prefixes.reservedPrefixes ?? []) {
    if (used.has(reserved)) {
      fail(`error-prefixes.json：保留前缀 ${reserved} 被方向占用`)
    }
  }

  for (const [id, segment] of Object.entries(prefixes.segments ?? {})) {
    if (!/^\d{4}$/.test(id)) {
      fail(`error-prefixes.json：段位键 "${id}" 必须是 4 位数字`)
    }
    if (segment.name === undefined || segment.meaning === undefined) {
      fail(`error-prefixes.json：段位 ${id} 缺 name 或 meaning`)
    }
    /*
     * range 必须能被 segmentOf 解析回它自己。
     *
     * 这一条守的是「段位定义写歪也没人说话」那类洞：range 写成
     * `"9xxx"` 或 `"9999-"` 时，segmentOf 会静默跳过该段位，于是
     * 这个段位等同于不存在 —— 与首字符推导造成的后果一模一样。
     */
    if (!segmentRangeCoversSelf(id, segment)) {
      fail(`error-prefixes.json：段位 ${id} 的 range "${segment.range}" 解析不出该段位自身`)
    }
  }
  notes.push(`段位 ${Object.keys(prefixes.segments ?? {}).length} 个，前缀 ${used.size} 个`)
}

/**
 * 段位自己的 range 是否覆盖该段位的下界。
 *
 * 用下界而不是任意值：范围段位（`9001-9998`）的下界就在键名附近，
 * 单值段位（`9999`）的 range 就是键名。两者都能被这条覆盖。
 */
function segmentRangeCoversSelf(id, segment) {
  const range = segment?.range
  if (typeof range !== 'string' || range === '') return false
  const low = Number(range.split('-')[0])
  if (!Number.isInteger(low)) return false
  return segmentOf(low, { [id]: segment }) === id
}

/**
 * 校验「退出码 ↔ 错误码」的对应关系是否无歧义。
 *
 * ## 这一项守的是什么
 *
 * `exit-codes.json` 里每个退出码标注了对应的错误码段（`errorSegment`）。
 * 这里反过来建一张「错误码 → 退出码」的反查表，要求**同一个错误码
 * 不能出现在两个不同退出码下**。
 *
 * 反例是真实发生过的：`exit 4` 写着 `errorSegment: "1002"`，而四个
 * 方向的实现都把 `1002` 映射到退出码 2（输入物不存在属于参数与输入
 * 错误）。契约与实现就此分叉，而且**没有任何自动检查会发现** ——
 * 因为原来只校验「段位是否存在」，不校验「退出码与码值是否自洽」。
 * 结果同一份报告里 `exitCode: 2` 配 `code: "M2W_1002"`，而契约说
 * 1002 应该配 4。
 *
 * 分叉的后果落在脚本层：拿到 2 的自动化会重试，拿到 4 才该停。
 */
function checkExitCodeMapping(exitCodes) {
  if (exitCodes === null) return
  /** 错误码 → 声明它的退出码（用于发现冲突） */
  const claimed = new Map()

  for (const [key, entry] of Object.entries(exitCodes.codes)) {
    const segment = entry.errorSegment
    if (segment === null || segment === undefined) continue
    // 形如 "4001-5002"（范围）或 "1003/1004"（列举）或 "9999"（单个）
    for (const part of String(segment).split(/[/-]/)) {
      const code = part.trim()
      if (code === '') continue
      if (claimed.has(code)) {
        fail(`exit-codes.json：错误码 ${code} 同时被退出码 ${claimed.get(code)} 与 ${key} 声明，`
          + '同一码值不能有两种退出码')
      } else {
        claimed.set(code, key)
      }
    }
  }

  notes.push(`退出码 ↔ 错误码声明 ${claimed.size} 条`)
}

/* ─────────────────────────── 报告校验 ─────────────────────────── */

/**
 * 按 run-report.schema.json 递归校验一份报告的结构。
 *
 * ## 为什么读 schema 而不手写每层字段
 *
 * 手写会犯三种错，第一种本文件原来就犯着：只校验顶层 `required`，从不
 * 执行 `additionalProperties: false` —— schema 里明明写着，检查器却不管，
 * 报告里塞 `{"这个字段不该存在": 123}` 照样「✓ 契约自洽」。而 `stages` /
 * `artifacts` / `checks` / `error` 的每个 item 也写着这句，一层都没被执行。
 *
 * 另外两种是「同一语义存两份」的老毛病（白名单漏字段导致误报、多字段
 * 导致比契约更宽松），`console/src/contract-check.mjs` 的注释里有完整
 * 事故记录，不在这里复述。
 *
 * 所以这里实现一个只覆盖本契约用到关键字的最小校验器：`type` / `const` /
 * `enum` / `pattern` / `minimum` / `maximum` / `required` / `properties` /
 * `additionalProperties` / `items`。零依赖，schema 改了就自动跟随。
 *
 * 不实现 `allOf` 里的 if/then（ok 与 error 的互斥）—— 两条规则手写比
 * 条件 schema 更好读也更好报错，见 {@link checkReport}。
 *
 * @param {unknown} value 待校验节点
 * @param {object} schema 该节点的 schema 片段
 * @param {string} path 报告里的路径，如 `stages[2].status`
 * @returns {string[]} 问题清单
 */
function validateAgainstSchema(value, schema, path) {
  if (typeof schema !== 'object' || schema === null) return []

  // 类型不对时不再深入，否则会报一串由它派生的连带问题
  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    const actual = value === null ? 'null' : typeof value
    return [`${path} 的类型是 ${actual}，契约要求 ${describeType(schema.type)}`]
  }

  const issues = []
  if (schema.const !== undefined && value !== schema.const) {
    issues.push(`${path} 必须是 ${JSON.stringify(schema.const)}，实际 ${JSON.stringify(value)}`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    issues.push(`${path} 是 ${JSON.stringify(value)}，允许值：${schema.enum.join('/')}`)
  }
  if (typeof value === 'string' && typeof schema.pattern === 'string'
    && !new RegExp(schema.pattern, 'u').test(value)) {
    issues.push(`${path} 不符合格式 ${schema.pattern}：${value}`)
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      issues.push(`${path} 是 ${value}，不能小于 ${schema.minimum}`)
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      issues.push(`${path} 是 ${value}，不能大于 ${schema.maximum}`)
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => {
      issues.push(...validateAgainstSchema(item, schema.items, `${path}[${index}]`))
    })
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const properties = schema.properties ?? {}
    // 用 hasOwn 而不是 `key in value`：后者会命中原型链
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) issues.push(`${path} 缺少必填字段 ${key}`)
    }
    // additionalProperties: false —— 契约里每一层都写着，逐层执行
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          issues.push(`${path} 有 schema 未定义的字段 ${key}（additionalProperties: false）`)
        }
      }
    }
    for (const [key, definition] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) {
        issues.push(...validateAgainstSchema(value[key], definition, `${path}.${key}`))
      }
    }
  }
  return issues
}

/**
 * 报告的 stages：「失败即停」。
 *
 * 结构（items 的必填字段、status 枚举、id 下界）已由 schema 覆盖，这里
 * 只补 schema 表达不了的跨项不变量。
 *
 * @returns {string[]}
 */
function checkReportStages(report) {
  if (!Array.isArray(report.stages)) return []   // 类型问题由 schema 报

  /*
   * 失败即停：某阶段 failed 之后不应再有 ok 阶段。违反通常意味着实现里
   * 没在失败处 return，继续跑了后续步骤 —— 那会产出半成品。
   *
   * **必须先过滤非对象项**：直接对原始数组取 `.status` 时，一个
   * `stages: [null]` 就抛 TypeError，而抛错会被上层记成「调用某方向
   * 抛错」，把排查引向一个无辜的子进程。错误归因错了比不报错更浪费
   * 时间。
   */
  const usable = report.stages.filter(
    (stage) => typeof stage === 'object' && stage !== null)
  const failedAt = usable.findIndex((stage) => stage.status === 'failed')
  if (failedAt < 0) return []
  const after = usable.slice(failedAt + 1).filter((stage) => stage.status === 'ok')
  if (after.length === 0) return []
  return [`阶段 ${failedAt} 失败后仍执行了 ${after.length} 个 ok 阶段：`
    + `${after.map((stage) => stage.name).join(', ')}`]
}

/**
 * 校验一份报告。
 *
 * 分成两类，边界很清楚：
 *
 *   - **结构**（字段名、类型、必填、枚举、格式）→ 交给 schema 递归，
 *     见 {@link validateAgainstSchema}。契约是唯一事实来源。
 *   - **语义**（跨字段不变量，schema 的 `allOf` 表达不了或表达得很难读）
 *     → 在这里手写：ok↔exitCode、退出码↔错误码、失败即停、
 *     真实进程退出码比对。
 *
 * 不引入 JSON Schema 校验库 —— 契约结构固定，手写校验约百行，换来
 * 零依赖，与各子项目「不装第三方依赖」的口径一致。
 *
 * @param {object|null} report
 * @param {object|null} prefixes error-prefixes.json
 * @param {object|null} exitCodes exit-codes.json
 * @param {object} [options]
 * @param {object|null} [options.schema] run-report.schema.json
 * @param {number} [options.expectedExitCode] 真实进程退出码，给了才比对
 */
function checkReport(report, prefixes, exitCodes, options = {}) {
  if (report === null) return
  if (typeof report !== 'object' || Array.isArray(report)) {
    fail(`报告不是对象，而是 ${Array.isArray(report) ? '数组' : typeof report}`)
    return
  }

  if (options.schema != null) {
    for (const message of validateAgainstSchema(report, options.schema, '报告')) fail(message)
  }
  for (const message of checkReportStages(report)) fail(message)

  /*
   * schemaVersion 与 direction 的取值已由 schema 的 const/enum 覆盖；
   * 上面逐项校验只在报告缺这些字段时才会走到这里，所以这里只补
   * 「跨字段」的判断。
   */
  if (typeof report.ok === 'boolean' && typeof report.exitCode === 'number'
    && report.ok !== (report.exitCode === 0)) {
    fail(`报告 ok=${report.ok} 与 exitCode=${report.exitCode} 不一致`)
  }

  /*
   * 报告里的 exitCode 与真实进程退出码必须一致。
   *
   * 两个值是分别算出来的，分叉时报告看起来完全合法，只有和进程实际
   * 退出码比对才看得出来。脚本按退出码分流，看错就会走错分支（该停的
   * 去重试、该重试的停下）。离线只有报告时拿不到真实退出码，所以这项
   * 做成可选参数：CI 用 `--exit-code` 传入。
   */
  const expectedExit = options.expectedExitCode
  if (expectedExit !== undefined && typeof report.exitCode === 'number'
    && report.exitCode !== expectedExit) {
    fail(`报告 exitCode=${report.exitCode}，实际进程退出码=${expectedExit}`)
  }

  /*
   * ok 与 error 的互斥关系，对应 schema 末尾的两条 allOf if/then。
   *
   * 那两条无法用上面的递归校验表达（它不实现 if/then），手写反而更
   * 清楚。漏掉「ok=true 却带着 error」这一半是有代价的：前端读到
   * `error` 就显示红色失败提示，读到 `ok: true` 又显示成功横幅，同一
   * 份报告渲染出自相矛盾的两个结论。
   */
  const hasError = report.error !== undefined && report.error !== null
  if (report.ok === false && !hasError) {
    fail('报告 ok=false 时必须带 error')
  }
  if (report.ok === true && hasError) {
    fail('报告 ok=true 时 error 必须为 null（schema 的 allOf 明文要求）')
  }
  if (hasError) checkError(report, prefixes, exitCodes)

  notes.push(`报告方向 ${report.direction}，${report.stages?.length ?? 0} 个阶段`)
}

/**
 * 报告的 error 对象：存在性之外的三件事 —— 码值格式、段位、退出码配对。
 *
 * 拆成独立函数用提前返回，是因为串起来写会到五层嵌套（error 是不是
 * 对象 → code 是不是字符串 → 前缀对不对 → 段位存不存在 → 退出码配不配），
 * 每一层都只关心一件事，平铺比缩进好读。
 *
 * @param {object} report 已确认是对象且带 error 的报告
 * @param {object|null} prefixes
 * @param {object|null} exitCodes
 */
function checkError(report, prefixes, exitCodes) {
  if (typeof report.error !== 'object' || Array.isArray(report.error)) {
    fail(`报告 error 是 ${Array.isArray(report.error) ? '数组' : typeof report.error}，`
      + '契约要求 object 或 null')
    return
  }
  const code = report.error.code
  if (typeof code !== 'string') {
    fail('报告 error 缺 code 或 code 不是字符串')
    return
  }
  const prefix = prefixes?.prefixes?.[report.direction]
  if (prefix !== undefined && !new RegExp(`^${prefix}_\\d{4}$`).test(code)) {
    fail(`错误码 ${code} 不符合方向 ${report.direction} 的前缀 ${prefix}_NNNN`)
  }
  if (segmentOf(Number(code.slice(-4)), prefixes?.segments ?? {}) === null) {
    fail(`错误码 ${code} 的段位 ${code.slice(-4)} 不在任何已定义范围内`)
  }

  /*
   * 退出码与错误码必须落在同一格。
   *
   * 这是这类缺陷的最后一道闸：报告里 `exitCode` 与 `error.code` 各写
   * 一处，两边都由各自代码算出来，很容易分叉。契约里声明了「哪个码配
   * 哪个退出码」，这里拿它反查一遍。
   */
  const declared = exitCodes?.codes?.[String(report.exitCode)]
  if (declared?.errorSegment == null) return

  const codeTail = code.slice(code.indexOf('_') + 1)   // "M2W_1005" → "1005"
  if (!segmentAllows(declared.errorSegment, codeTail)) {
    fail(`退出码 ${report.exitCode} 在契约里对应错误码 ${declared.errorSegment}，`
      + `但报告给的是 ${code}。两边必须一致，否则脚本按退出码分流会走错分支`)
  }
}

/**
 * 判断一个错误码是否落在 `errorSegment` 声明的范围内。
 *
 * ## 为什么不能让 `/[/-]/` 一把切
 *
 * `errorSegment` 有三种写法：列举（`"1003/1004"`）、范围（`"4001-5002"`）、
 * 单值（`"9999"`）。用 `/[/-]/` 切会把范围切成两个端点，于是 `4002`
 * 既不等于 `4001` 也不等于 `5002`，被判成「不一致」。
 *
 * 这个缺陷实测存在（2026-11-19）：一份 `exitCode: 6` 配 `M2W_4002` 的
 * 报告被判红，而 4002 完全合法。它此前没被发现，是因为**恰好没有任何
 * 测试跑过「范围内非端点」的码**，而真实报告里 `4001` / `5002` 这两个
 * 端点值用得最多 —— 校验器看起来一直是对的。
 *
 * 同一判据在 `console/src/contract-check.mjs` 里已经实现对了（分开
 * 处理 `-` 与 `/`）。这里是第二份实现，属于「同一判据两处各写一套」，
 * 但两个包没有共享模块的通道（contracts 是零依赖的独立脚本），所以
 * 用相同的用例把两边钉住，而不是硬抽公共层。
 *
 * @param {string} segment 契约里的 `errorSegment` 原文。
 * @param {string} tail 错误码的后四位，如 `"4002"`。
 * @returns {boolean}
 */
export function segmentAllows(segment, tail) {
  const numeric = Number(tail)
  for (const part of String(segment).split('/')) {
    const piece = part.trim()
    if (piece === '') continue
    const dash = piece.indexOf('-')
    if (dash === -1) {
      if (piece === tail) return true
      continue
    }
    const low = Number(piece.slice(0, dash))
    const high = Number(piece.slice(dash + 1))
    if (Number.isInteger(low) && Number.isInteger(high)
      && Number.isInteger(numeric) && numeric >= low && numeric <= high) return true
  }
  return false
}

/* ─────────────────────────── 入口 ─────────────────────────── */

function usage(message) {
  process.stderr.write(`${message}\n`)
  process.stderr.write('用法：node contracts/validate.mjs [--report <文件>] '
    + '[--exit-code <码>] [--contracts <目录>]\n')
  return 2
}

function main(argv) {
  const valueOf = (flag) => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }

  if (argv.includes('--report') && valueOf('--report') === undefined) {
    return usage('--report 后面要跟文件路径')
  }
  if (argv.includes('--contracts')) {
    const dir = valueOf('--contracts')
    if (dir === undefined) return usage('--contracts 后面要跟目录')
    contractDir = dir
  }
  let expectedExitCode
  if (argv.includes('--exit-code')) {
    const raw = valueOf('--exit-code')
    if (raw === undefined || !/^\d+$/.test(raw)) {
      return usage('--exit-code 后面要跟非负整数')
    }
    expectedExitCode = Number(raw)
  }

  const exitCodes = readJson('exit-codes.json')
  const prefixes = readJson('error-prefixes.json')
  const schema = readJson('run-report.schema.json')

  checkExitCodes(exitCodes, prefixes)
  checkExitCodeMapping(exitCodes)
  checkPrefixes(prefixes)
  if (schema === null) {
    fail('run-report.schema.json 读不了')
  } else if (schema.$id === undefined) {
    fail('run-report.schema.json 缺 $id')
  }

  if (argv.includes('--report')) {
    const path = valueOf('--report')
    let report = null
    try {
      report = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      fail(`报告 ${path} 读不了：${error.message}`)
    }
    checkReport(report, prefixes, exitCodes, { schema, expectedExitCode })
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`✗ ${problem}\n`)
    process.stderr.write(`\n${problems.length} 处问题\n`)
    return 1
  }
  for (const note of notes) process.stdout.write(`· ${note}\n`)
  process.stdout.write('✓ 契约自洽\n')
  return 0
}

/**
 * 判断本模块是否被直接执行。
 *
 * 少了这道守卫，任何 `import` 都会把整个校验流程跑一遍、往 stderr 打
 * 问题清单、并设置 process.exitCode —— `ai/src/server.mjs` 踩过同类的坑
 * （入口文件顶层调 main()，每次请求往 stdout 打印用法说明，污染了 MCP
 * 的独占通道）。测试要 import `segmentOf`，所以守卫是必需的。
 */
function isDirectRun() {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry === '') return false
  const self = fileURLToPath(import.meta.url)
  if (entry === self) return true
  // realpath 失败（文件被删、权限不足）不能抛出 —— 那会让「被 import」
  // 的路径也崩，比不判断更糟。
  try {
    return realpathSync(entry) === realpathSync(self)
  } catch {
    return false
  }
}

if (isDirectRun()) {
  process.exitCode = main(process.argv.slice(2))
}
