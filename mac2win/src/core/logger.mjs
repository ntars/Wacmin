/**
 * 构建日志。
 *
 * ## 三条设计约束
 *
 * 1. **日志要能落盘**。用户在界面上看到红字之后，下一步往往是把它贴进
 *    issue。没有文件就没法贴，所以每次构建都写一份 `build.log`。
 * 2. **日志要能实时推给界面**。构建动辄几十秒到几分钟，全等结束再显示
 *    等于让用户盯着一个不动的进度条。这里用事件订阅，界面订阅多少
 *    推多少。
 * 3. **落盘不能阻塞构建**。写文件是同步的（`appendFileSync`），因为
 *    构建主流程在等外部进程，日志量很小；异步写会引入「进程已退出、
 *    日志还没刷完」的竞态，反而丢最后几行——而那几行正是出错原因。
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 日志级别。`step` 用于标记一个阶段的开始，让长日志有骨架。 */
export const Level = {
  DEBUG: 'debug',
  INFO: 'info',
  STEP: 'step',
  WARN: 'warn',
  ERROR: 'error',
  SUCCESS: 'success',
}

/** 各级别的控制台前缀符号。终端里一眼能扫出重点。 */
const SYMBOLS = {
  debug: '·',
  info: ' ',
  step: '▸',
  warn: '!',
  error: '✗',
  success: '✓',
}

/**
 * 一条日志。
 *
 * @typedef {object} LogEntry
 * @property {number} at 时间戳（毫秒）。
 * @property {string} level 级别。
 * @property {string} message 正文。
 * @property {string} [code] 错误码，仅错误条目有。
 * @property {string} [hint] 建议，仅错误条目有。
 */

/**
 * 日志器。
 *
 * 同一份日志同时流向三处：内存环形缓冲（供界面首屏补齐）、
 * 订阅者（供界面实时追加）、磁盘文件（供事后排查）。
 */
export class Logger {
  /**
   * @param {object} [options]
   * @param {string} [options.file] 落盘路径。不给则不写文件。
   * @param {(entry: LogEntry) => void} [options.sink] 额外的同步接收器，供 CLI 直接打印。
   * @param {number} [options.capacity] 内存里最多保留多少条。默认 4000。
   */
  constructor(options = {}) {
    this.file = options.file
    this.sink = options.sink
    this.capacity = options.capacity ?? 4000
    /** @type {LogEntry[]} */
    this.entries = []
    /** @type {Set<(entry: LogEntry) => void>} */
    this.listeners = new Set()
    this.startedAt = Date.now()

    if (this.file !== undefined) this.#openFile()
  }

  /**
   * 打开落盘文件，并把已在内存里的条目补写进去。
   *
   * 单独抽出来是因为落盘时机可能晚于构造：见 bin/mac2win.mjs 里
   * 「先校验项目目录、再挂日志文件」的说明。补写内存条目是必须的，
   * 否则构造到挂载之间产生的日志只出现在终端、不在文件里，而那段
   * 日志往往正是报错原因。
   */
  #openFile() {
    mkdirSync(dirname(this.file), { recursive: true })
    // 每次构建覆盖上一份：日志按构建隔离，混在一起就没法定位是哪一次。
    writeFileSync(this.file, `# mac2win 构建日志\n# 开始于 ${new Date(this.startedAt).toISOString()}\n\n`)
    for (const entry of this.entries) this.#appendEntry(entry)
  }

  /**
   * 挂载落盘文件。可重复调用，后一次覆盖前一次。
   *
   * @param {string} file 日志路径。
   */
  attachFile(file) {
    this.file = file
    this.#openFile()
  }

  /** 订阅日志。返回取消订阅的函数。 */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 取已产生的全部日志，供界面首屏渲染。 */
  snapshot() {
    return [...this.entries]
  }

  /**
   * 写一条日志。
   *
   * @param {string} level 级别。
   * @param {string} message 正文。
   * @param {object} [extra] 附加字段（`code` / `hint`）。
   */
  log(level, message, extra = {}) {
    const entry = { at: Date.now(), level, message, ...extra }

    this.entries.push(entry)
    if (this.entries.length > this.capacity) this.entries.shift()

    this.#appendEntry(entry)

    for (const listener of this.listeners) {
      try {
        listener(entry)
      } catch {
        /* 单个订阅者出错不该影响构建 */
      }
    }

    this.sink?.(entry)
  }

  /** 把一条日志追加到磁盘。未挂载文件时什么都不做。 */
  #appendEntry(entry) {
    if (this.file === undefined) return
    // 时间用相对秒数：用户关心「第几秒出的问题」，而不是绝对时刻。
    const elapsed = ((entry.at - this.startedAt) / 1000).toFixed(2).padStart(7)
    const suffix = entry.code === undefined ? '' : ` [${entry.code}]`
    appendFileSync(this.file, `[${elapsed}s] ${entry.level.toUpperCase().padEnd(7)} ${entry.message}${suffix}\n`)
  }

  debug(message, extra) {
    this.log(Level.DEBUG, message, extra)
  }

  info(message, extra) {
    this.log(Level.INFO, message, extra)
  }

  /** 标记一个阶段的开始。界面上会画一条分隔线。 */
  step(message, extra) {
    this.log(Level.STEP, message, extra)
  }

  warn(message, extra) {
    this.log(Level.WARN, message, extra)
  }

  error(message, extra) {
    this.log(Level.ERROR, message, extra)
  }

  success(message, extra) {
    this.log(Level.SUCCESS, message, extra)
  }

  /** 耗时（秒），保留一位小数。 */
  elapsed() {
    return (Date.now() - this.startedAt) / 1000
  }
}

/** 把一条日志渲染成终端里的一行。 */
export function formatForTerminal(entry) {
  const symbol = SYMBOLS[entry.level] ?? ' '
  const time = new Date(entry.at).toTimeString().slice(0, 8)
  const head = `\x1b[2m${time}\x1b[0m ${symbol} `
  const body = entry.level === Level.ERROR
    ? `\x1b[31m${entry.message}\x1b[0m`
    : entry.level === Level.WARN
      ? `\x1b[33m${entry.message}\x1b[0m`
      : entry.level === Level.SUCCESS
        ? `\x1b[32m${entry.message}\x1b[0m`
        : entry.level === Level.STEP
          ? `\x1b[36m${entry.message}\x1b[0m`
          : entry.level === Level.DEBUG
            ? `\x1b[2m${entry.message}\x1b[0m`
            : entry.message
  const code = entry.code === undefined ? '' : ` \x1b[2m[${entry.code}]\x1b[0m`
  const hint = entry.hint === undefined ? '' : `\n     \x1b[33m→ ${entry.hint}\x1b[0m`
  return `${head}${body}${code}${hint}`
}