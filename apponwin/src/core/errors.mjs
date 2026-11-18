/**
 * 统一错误码。
 *
 * `AOW_<段位><序号>`。段位见 `contracts/error-prefixes.json`。
 *
 * 注意 `1xxx` 里多了几个别的方向没有的码：AppOnWin 的输入物是
 * macOS 应用包，判定「这个包能不能在 Windows 上跑」本身就是一次
 * 兼容性评估，失败原因比「文件不存在」复杂得多。
 */

export const ErrorCode = {
  /** 当前机器不是 Windows。 */
  HOST_UNSUPPORTED: 'AOW_1001',
  /** 输入路径不存在或不是 .app。 */
  INPUT_NOT_FOUND: 'AOW_1002',
  /** 配置读不了或格式不对。 */
  CONFIG_INVALID: 'AOW_1003',
  /** 必填参数缺失。 */
  CONFIG_MISSING: 'AOW_1004',
  /**
   * 输入物落在硬边界内，明确不支持（对应退出码 4）。
   *
   * 与 `INPUT_NOT_FOUND`（1002）分开：那个是路径或类型写错，这个是
   * 「这个包本身跑不了」，用户下一步动作完全不同。
   */
  UNSUPPORTED: 'AOW_1005',

  /** 缺少外部工具（WSL2 / Darling / 7z）。 */
  TOOL_MISSING: 'AOW_2001',
  /** 工具版本过低。 */
  TOOL_OUTDATED: 'AOW_2002',

  /** 兼容层运行时不可用。 */
  RUNTIME_UNAVAILABLE: 'AOW_3001',
  /** 运行时校验失败。 */
  RUNTIME_CHECKSUM_MISMATCH: 'AOW_3002',
  /** 运行时架构不对。 */
  RUNTIME_WRONG_ARCH: 'AOW_3003',

  /** 应用包解析失败（Mach-O / Info.plist / 签名）。 */
  APP_PARSE_FAILED: 'AOW_4001',
  /** 应用依赖的系统框架未实现。 */
  APP_UNSUPPORTED_FRAMEWORK: 'AOW_4002',
  /** 应用含不可跨架构的原生代码。 */
  APP_NATIVE_CODE: 'AOW_4003',

  /** 启动器装配失败。 */
  LAUNCHER_ASSEMBLY_FAILED: 'AOW_5001',
  /** 打包失败。 */
  PACKAGE_FAILED: 'AOW_5002',

  /** 产物校验不通过。 */
  VERIFY_FAILED: 'AOW_6001',
  /** 产物架构不对。 */
  VERIFY_WRONG_ARCH: 'AOW_6002',
  /** 产物不完整。 */
  VERIFY_INCOMPLETE: 'AOW_6003',

  /** 用户中断。 */
  CANCELLED: 'AOW_9001',
  /** 内部错误。 */
  INTERNAL: 'AOW_9999',
}

/** 带错误码、人话与建议的构建错误。 */
export class BuildError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'BuildError'
    this.code = code
    this.hint = options.hint
    this.details = options.details ?? []
  }

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