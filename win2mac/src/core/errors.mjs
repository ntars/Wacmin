/**
 * 统一错误码。
 *
 * ## 码值结构
 *
 * `W2M_<段位><序号>`。段位含义见 `contracts/error-prefixes.json`，
 * 四个方向共用同一套段位，因此看到 `W2M_6002` 就知道是产物校验里
 * 的「架构不对」，不必读日志。
 *
 * 段位不越界：`4xxx` 只表示输入物处理失败，不许拿去表示缺工具。
 */

export const ErrorCode = {
  /** 当前机器不是 Windows。 */
  HOST_UNSUPPORTED: 'W2M_1001',
  /** 输入路径不存在或类型不对。 */
  INPUT_NOT_FOUND: 'W2M_1002',
  /** 配置读不了或格式不对。 */
  CONFIG_INVALID: 'W2M_1003',
  /** 必填参数缺失。 */
  CONFIG_MISSING: 'W2M_1004',
  /**
   * 输入物落在硬边界内，明确不支持（对应退出码 4）。
   *
   * 与 `INPUT_NOT_FOUND`（1002）分开：那个是路径写错，这个是东西做不了。
   */
  UNSUPPORTED: 'W2M_1005',

  /** 缺少外部工具。 */
  TOOL_MISSING: 'W2M_2001',
  /** 工具版本过低。 */
  TOOL_OUTDATED: 'W2M_2002',

  /** 运行时下载失败。 */
  RUNTIME_DOWNLOAD_FAILED: 'W2M_3001',
  /** 运行时校验和不匹配。 */
  RUNTIME_CHECKSUM_MISMATCH: 'W2M_3002',
  /** 运行时架构不对。 */
  RUNTIME_WRONG_ARCH: 'W2M_3003',

  /** 项目构建失败。 */
  PROJECT_BUILD_FAILED: 'W2M_4001',
  /** 项目里找不到要打包的产物。 */
  PROJECT_ARTIFACT_MISSING: 'W2M_4002',
  /** 项目含不可跨架构的原生模块。 */
  PROJECT_NATIVE_MODULE: 'W2M_4003',

  /** bundle 装配失败（Info.plist / 图标 / 结构）。 */
  BUNDLE_ASSEMBLY_FAILED: 'W2M_5001',
  /** 压缩包编译失败。 */
  ARCHIVE_COMPILE_FAILED: 'W2M_5002',

  /** 产物校验不通过。 */
  VERIFY_FAILED: 'W2M_6001',
  /** 产物架构不对。 */
  VERIFY_WRONG_ARCH: 'W2M_6002',
  /** 产物不完整。 */
  VERIFY_INCOMPLETE: 'W2M_6003',

  /** 用户中断。 */
  CANCELLED: 'W2M_9001',
  /** 内部错误。 */
  INTERNAL: 'W2M_9999',
}

/** 带错误码、人话与建议的构建错误。 */
export class BuildError extends Error {
  /**
   * @param {string} code 错误码，取 {@link ErrorCode} 的值。
   * @param {string} message 给人看的一句话。
   * @param {object} [options]
   * @param {string} [options.hint] 下一步该做什么。
   * @param {string[]} [options.details] 补充细节，逐行显示。
   * @param {Error} [options.cause] 原始错误。
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'BuildError'
    this.code = code
    this.hint = options.hint
    this.details = options.details ?? []
  }

  /** 格式化成多行文本，供 CLI 与日志使用。 */
  toLines() {
    const lines = [`[${this.code}] ${this.message}`]
    for (const detail of this.details) lines.push(`  · ${detail}`)
    if (this.hint !== undefined) lines.push(`  → ${this.hint}`)
    return lines
  }
}

/** 把任意错误收敛成 {@link BuildError}。 */
export function asBuildError(error) {
  if (error instanceof BuildError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new BuildError(ErrorCode.INTERNAL, message, {
    cause: error instanceof Error ? error : undefined,
  })
}

/** 判断是不是用户主动中断。 */
export function isCancellation(error) {
  if (error instanceof BuildError) return error.code === ErrorCode.CANCELLED
  return error instanceof Error && (error.name === 'AbortError' || error.message === '已取消')
}