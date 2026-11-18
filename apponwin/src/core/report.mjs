/**
 * 统一运行报告。
 *
 * 结构与 `contracts/run-report.schema.json` 一致。与其他三个方向
 * 唯一的差别是阶段定义：AppOnWin 多一道「兼容性评估」，因为它的
 * 输入物是一个 macOS 应用包，「能不能跑」本身就要先判定。
 */

/** 报告格式版本。 */
export const SCHEMA_VERSION = 1

/** 方向标识。 */
export const DIRECTION = 'apponwin'

/**
 * 阶段定义。
 *
 * 前七步与其他方向同构，第八步 `assess` 是本方向独有：
 * 读 Mach-O 头、读 Info.plist、比对已实现的框架清单。
 * 这一步不通过就没有后续——不评估就打包，等于承诺跑不起来的软件能跑。
 */
export const STAGES = [
  { id: 'preflight', title: '预检', weight: 1 },
  { id: 'parse', title: '解析应用包', weight: 2 },
  { id: 'assess', title: '兼容性评估', weight: 4 },
  { id: 'runtime', title: '准备兼容层', weight: 4 },
  { id: 'collect', title: '收集依赖', weight: 2 },
  { id: 'stage', title: '暂存文件', weight: 3 },
  { id: 'package', title: '装配启动器', weight: 4 },
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

  leave(id) {
    const record = this.records.get(id)
    if (record === undefined) return
    record.status = 'ok'
    record.durationMs = Date.now() - record.startedAt
    this.current = null
  }

  markFailed(errorCode) {
    if (this.current === null) return
    const record = this.records.get(this.current)
    if (record === undefined) return
    record.status = 'failed'
    record.durationMs = Date.now() - record.startedAt
    record.errorCode = errorCode
    this.current = null
  }

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

/** 组装成功报告。 */
export function successReport(input) {
  const { config, result, tracker, command = 'build' } = input
  const finishedAt = Date.now()

  const artifacts = []
  if (result.artifact !== null) {
    artifacts.push({
      path: result.artifact,
      kind: 'dir',
      bytes: result.artifactSize,
      target: config.target,
    })
  }

  const warnings = []
  for (const check of result.preflight?.checks ?? []) {
    if (check.status === 'warn') warnings.push(`${check.title}：${check.detail}`)
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
    checks: [],
    warnings,
    error: null,
  }
}

/** 组装失败报告。 */
export function failureReport(input) {
  const { error, tracker, exitCode, command = 'build' } = input
  const finishedAt = Date.now()
  const stages = tracker.toStages()

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
    checks: [],
    warnings: [],
    error: {
      code: error.code,
      message: error.message,
      hint: error.hint ?? null,
      details: error.details ?? [],
    },
  }
}

/** 错误码 → 进程退出码。按段位映射，9999 单独判掉。 */
export function exitCodeFor(code) {
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