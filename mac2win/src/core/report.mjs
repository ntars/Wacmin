/**
 * 统一运行报告。
 *
 * ## 为什么要单独一层
 *
 * 各方向原本各写各的 `--json` 结构：mac2win 输出 `{ok, artifact, size}`，
 * exeonmac 输出另一套。前端汇总时得为每个方向写一份适配代码，
 * 加一个方向就多一份，越写越歪。
 *
 * 这里把「各方向的内部结果」翻译成 `contracts/run-report.schema.json`
 * 定义的统一结构。**翻译只在这一处做**，CLI 不再自己拼 JSON。
 */

import { STAGES } from './builder.mjs'
import { release } from 'node:os'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 报告格式版本。与 contracts/run-report.schema.json 的 schemaVersion 同步。 */
export const SCHEMA_VERSION = 1

/** 方向标识。与 contracts/error-prefixes.json 的键一致。 */
export const DIRECTION = 'mac2win'

/**
 * 阶段状态跟踪器。
 *
 * Builder 的进度回调只告诉「进入了哪个阶段」，不告诉「哪个阶段失败了」。
 * 失败时用 {@link markFailed} 补记，其余已完成阶段按顺序标 ok。
 */
export class StageTracker {
  constructor() {
    this.startedAt = Date.now()
    /** @type {Map<string, {status: string, startedAt: number, durationMs: number, message: string|null, errorCode: string|null}>} */
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
   * 导出为契约要求的 stages 数组。
   *
   * 未进入过的阶段标 skipped 而不是 pending：报告是「已发生的事」的
   * 记录，不是「计划表」。前端看 skipped 就知道这次没走到那里。
   */
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

/** 把 mac2win 的校验项翻译成契约的 checks 结构。 */
function toChecks(verify) {
  const items = verify?.items ?? []
  return items.map((item) => ({
    name: item.title,
    passed: item.status === 'pass',
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    // warn 是「不影响成功但要告诉用户」，对应契约里的 advisory
    severity: item.status === 'warn' ? 'advisory' : 'required',
  }))
}

/**
 * 组装成功报告。
 *
 * @param {object} input
 * @param {object} input.config 归一化配置。
 * @param {object} input.result 构建结果。
 * @param {StageTracker} input.tracker 阶段跟踪器。
 * @param {object} [input.detection] 框架识别结果。
 * @returns {object} 符合契约的报告。
 */
export function successReport(input) {
  const { config, result, tracker, detection, command = 'build' } = input
  const finishedAt = Date.now()

  /*
   * ## 判「有没有产物」不能用 `!== null`
   *
   * 调用方没传这个字段时它是 `undefined`，而 `undefined !== null` 为真，
   * 于是 `artifacts` 里被推进一条 `{path: undefined, bytes: undefined}`
   * 的空记录。契约要求 `path` 是非空字符串，这份报告就是不合规的；
   * 更糟的是下游按 `artifacts.length > 0` 判断「有产物可下载」时，
   * 会渲染出一个点不动的下载链接。
   *
   * 实测就是 `doctor` 踩到的：它压根不产出产物，报告里却有
   * `[{kind: 'zip', target: 'x86'}]`，`path` 与 `bytes` 全缺。
   */
  const hasText = (value) => typeof value === 'string' && value !== ''

  const artifacts = []
  if (hasText(result.artifact)) {
    artifacts.push({
      path: result.artifact,
      kind: config.format === 'zip' ? 'zip' : 'nsis-exe',
      bytes: result.artifactSize,
      target: config.target,
    })
  }
  if (hasText(result.zipArtifact)) {
    artifacts.push({
      path: result.zipArtifact,
      kind: 'zip',
      bytes: result.zipSize,
      target: config.target,
    })
  }

  const warnings = []
  for (const check of result.preflight?.checks ?? []) {
    if (check.status === 'warn') warnings.push(`${check.title}：${check.detail}`)
  }
  for (const item of result.verify?.items ?? []) {
    if (item.status === 'warn') warnings.push(`${item.title}：${item.detail}`)
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
    input: {
      path: config.projectRoot,
      kind: config.framework,
      ...(detection?.confidence === undefined ? {} : { confidence: detection.confidence }),
      evidence: detection?.reasons ?? [],
      supported: true,
      unsupportedReason: null,
    },
    stages: tracker.toStages(),
    artifacts,
    checks: toChecks(result.verify),
    warnings,
    error: null,
  }
}

/**
 * 组装失败报告。
 *
 * @param {object} input
 * @param {import('./errors.mjs').BuildError} input.error 收敛后的错误。
 * @param {StageTracker} input.tracker 阶段跟踪器。
 * @param {number} input.exitCode 进程退出码。
 * @param {string} [input.command] 子命令名。
 * @returns {object} 符合契约的报告。
 */
export function failureReport(input) {
  const { error, tracker, exitCode, command = 'build' } = input
  const finishedAt = Date.now()
  const stages = tracker.toStages()

  /*
   * 失败可能发生在进入任何阶段之前（例如配置解析就挂了）。
   * 这时全部阶段都是 skipped，前端会显示成一片灰，看不出哪里出问题。
   * 把第一个阶段标成 failed 并注明「流程开始前」，比一片灰更有用。
   */
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

/** 宿主环境快照。 */
function hostSnapshot() {
  return {
    platform: process.platform,
    arch: process.arch,
    osVersion: release(),
    toolVersion: toolVersion(),
  }
}

/** 工具自身版本。从 package.json 读，避免与 VERSION 常量两处维护。 */
let cachedVersion = null
function toolVersion() {
  if (cachedVersion !== null) return cachedVersion
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'))
    cachedVersion = String(pkg.version)
  } catch {
    cachedVersion = 'unknown'
  }
  return cachedVersion
}