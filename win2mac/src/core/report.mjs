/**
 * 统一运行报告。
 *
 * 结构与 `contracts/run-report.schema.json` 严格一致。前端汇总只认这一份，
 * 不认各方向自己的内部字段名。
 */

/** 报告格式版本。与契约的 schemaVersion 同步。 */
export const SCHEMA_VERSION = 1

/** 方向标识。与 contracts/error-prefixes.json 的键一致。 */
export const DIRECTION = 'win2mac'

/**
 * 构建阶段定义。
 *
 * 与 mac2win 的八阶段刻意保持一一对应，只把「安装包」换成「应用包」：
 * 两个方向都是「把项目打成一个对端能装的东西」，流程本来就同构。
 * 将来 console 画进度条可以共用同一套阶段图。
 */
export const STAGES = [
  { id: 'preflight', title: '预检', weight: 1 },
  { id: 'project-build', title: '项目构建', weight: 3 },
  { id: 'runtime', title: '准备运行时', weight: 4 },
  { id: 'collect', title: '收集依赖', weight: 2 },
  { id: 'stage', title: '暂存文件', weight: 4 },
  { id: 'manifest', title: '生成清单', weight: 2 },
  { id: 'package', title: '装配应用包', weight: 5 },
  { id: 'verify', title: '校验产物', weight: 3 },
]

/** 阶段状态跟踪器。 */
export class StageTracker {
  constructor() {
    this.startedAt = Date.now()
    /** @type {Map<string, object>} */
    this.records = new Map()
    this.current = null
  }

  /** 进入某阶段。 */
  enter(id) {
    this.current = id
    this.records.set(id, {
      status: 'running',
      startedAt: Date.now(),
      durationMs: 0,
      message: null,
      errorCode: null,
    })
  }

  /** 离开某阶段，标为成功。 */
  leave(id) {
    const record = this.records.get(id)
    if (record === undefined) return
    record.status = 'ok'
    record.durationMs = Date.now() - record.startedAt
    this.current = null
  }

  /** 把当前阶段标为失败。 */
  markFailed(errorCode) {
    if (this.current === null) return
    const record = this.records.get(this.current)
    if (record === undefined) return
    record.status = 'failed'
    record.durationMs = Date.now() - record.startedAt
    record.errorCode = errorCode
    this.current = null
  }

  /**
   * 显式跳过某阶段，并记录原因。
   *
   * 与「根本没进入」的区别在于 `message`：前端能据此显示
   * 「跳过：Windows 上无法构建 macOS 产物」而不是一片灰。
   * 这对 win2mac 尤其重要 —— 它的 project-build 与 runtime
   * 两个阶段在 Windows 上本来就是空转的。
   */
  skip(id, reason) {
    this.records.set(id, {
      status: 'skipped',
      startedAt: Date.now(),
      durationMs: 0,
      message: reason ?? null,
      errorCode: null,
    })
    if (this.current === id) this.current = null
  }

  /** 导出为契约要求的 stages 数组。未进入的阶段标 skipped。 */
  toStages() {
    return STAGES.map((stage, index) => {
      const record = this.records.get(stage.id)
      return {
        id: index,
        name: stage.title,
        status: record?.status ?? 'skipped',
        durationMs: record?.durationMs ?? 0,
        ...(record?.message === null || record?.message === undefined
          ? {}
          : { message: record.message }),
        errorCode: record?.errorCode ?? null,
      }
    })
  }
}

/** 宿主环境快照。 */
function hostSnapshot() {
  return {
    platform: process.platform,
    arch: process.arch,
    osVersion: undefined,
    toolVersion: undefined,
  }
}

/**
 * 组装成功报告。
 *
 * @param {object} input
 * @param {object} input.config 归一化配置。
 * @param {object} input.result 构建结果。
 * @param {StageTracker} input.tracker 阶段跟踪器。
 * @param {string} [input.command] 实际执行的子命令。
 * @param {Array<{name: string, passed: boolean, detail?: string}>} [input.checks]
 *   doctor / verify 这类「逐项结论」命令的检查项。调用方传入时以它为准，
 *   因为这类命令的成功与否本身就没有产物，`artifacts` 为空是正常的。
 * @param {string[]} [input.warnings] 覆盖默认警告来源。
 * @returns {object} 符合契约的报告。
 */
export function successReport(input) {
  const { config, result, tracker, command = 'build' } = input
  const finishedAt = Date.now()

  const artifacts = []
  if (result.artifact !== null) {
    artifacts.push({
      path: result.artifact,
      kind: 'mac-app',
      bytes: result.artifactSize,
      target: config.target,
    })
  }

  const warnings = input.warnings ?? []
  if (input.warnings === undefined) {
    for (const check of result.preflight?.checks ?? []) {
      if (check.status === 'warn') warnings.push(`${check.title}：${check.detail}`)
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    direction: DIRECTION,
    ok: true,
    exitCode: 0,
    command,
    startedAt: new Date(tracker.startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: result.durationMs,
    host: hostSnapshot(),
    stages: tracker.toStages(),
    artifacts,
    checks: input.checks ?? [],
    warnings,
    error: null,
  }
}

/**
 * 组装失败报告。
 *
 * @param {object} input
 * @param {import('./errors.mjs').BuildError} input.error
 * @param {StageTracker} input.tracker
 * @param {number} input.exitCode
 * @param {string} [input.command]
 * @param {Array<{name: string, passed: boolean, detail?: string}>} [input.checks]
 * @param {string[]} [input.warnings]
 * @returns {object}
 */
export function failureReport(input) {
  const { error, tracker, exitCode, command = 'build' } = input
  const finishedAt = Date.now()
  const stages = tracker.toStages()

  // 失败可能发生在进入任何阶段之前，此时全 skipped 会让前端显示一片灰。
  if (!stages.some((stage) => stage.status !== 'skipped')) {
    stages[0].status = 'failed'
    stages[0].errorCode = error.code
    stages[0].message = '流程开始前即失败'
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    direction: DIRECTION,
    ok: false,
    exitCode,
    command,
    startedAt: new Date(tracker.startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - tracker.startedAt,
    host: hostSnapshot(),
    stages,
    artifacts: [],
    checks: input.checks ?? [],
    warnings: input.warnings ?? [],
    error: {
      code: error.code,
      message: error.message,
      hint: error.hint ?? null,
      details: error.details ?? [],
    },
  }
}

/**
 * 错误码 → 进程退出码。
 *
 * 依据 `contracts/exit-codes.json` 的段位映射，不逐码写死。
 */
export function exitCodeFor(code) {
  // 9999 是兜底段，首位也是 9，必须先判掉，否则会被误映射成 130（中断）。
  if (code.endsWith('_9999')) return 1
  // 1005 同属 1xxx 段，但语义是「明确不支持」，退出码是 4 不是 2。
  // 契约：exit 4 → 1005；exit 2 → 1002/1003/1004。
  if (code.endsWith('_1005')) return 4
  const segment = code.slice(-4, -3)
  if (segment === '1') return 2
  if (segment === '2') return 5
  if (segment === '3') return 5
  if (segment === '4') return 6
  if (segment === '5') return 6
  if (segment === '6') return 7
  if (segment === '9') return 130
  return 1
}