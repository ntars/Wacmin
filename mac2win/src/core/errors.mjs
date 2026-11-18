/**
 * 统一的错误码与错误类型。
 *
 * ## 为什么要有错误码
 *
 * 「打包失败」这四个字对用户没有用。用户真正需要知道的是：
 * 是缺依赖、架构不对、还是参数写错了？这三件事的处理方式完全不同——
 * 缺依赖要装工具，架构不对要换目标，参数错了要改配置。
 *
 * 所以每种失败都带一个稳定的码（`M2W_xxxx`）与一句人话、一条建议。
 * 码可以贴进 issue，话给用户看，建议告诉用户下一步该做什么。
 */

/** 全部错误码。码值一经发布不再改动，只在末尾追加。 */
export const ErrorCode = {
  /** 当前机器不是 ARM 架构的 macOS。 */
  HOST_UNSUPPORTED: 'M2W_1001',
  /** 项目路径不存在或不是目录。 */
  PROJECT_NOT_FOUND: 'M2W_1002',
  /** 配置文件读不了或格式不对。 */
  CONFIG_INVALID: 'M2W_1003',
  /** 必填参数缺失。 */
  CONFIG_MISSING: 'M2W_1004',
  /**
   * 输入物落在硬边界内，明确不支持（对应退出码 4）。
   *
   * 与 `PROJECT_NOT_FOUND`（1002）分开：那个是「路径写错了，改一下就好」，
   * 这个是「东西本身做不了，换文件」，用户下一步动作完全不同。
   * 也与 7xxx 段分开：7xxx 是「还没做」，这个是「做不了」。
   */
  UNSUPPORTED: 'M2W_1005',

  /** 缺少打包工具（makensis）。 */
  TOOL_MISSING: 'M2W_2001',
  /** 工具版本过低。 */
  TOOL_OUTDATED: 'M2W_2002',

  /** 下载运行时失败。 */
  RUNTIME_DOWNLOAD_FAILED: 'M2W_3001',
  /** 运行时校验和不匹配。 */
  RUNTIME_CHECKSUM_MISMATCH: 'M2W_3002',
  /** 运行时架构不对。 */
  RUNTIME_WRONG_ARCH: 'M2W_3003',

  /** 项目构建失败（用户自己的 build 命令出错）。 */
  PROJECT_BUILD_FAILED: 'M2W_4001',
  /** 项目里找不到要打包的产物。 */
  PROJECT_ARTIFACT_MISSING: 'M2W_4002',
  /** 项目含原生模块，无法跨架构使用。 */
  PROJECT_NATIVE_MODULE: 'M2W_4003',

  /** NSIS 脚本生成失败。 */
  NSIS_SCRIPT_FAILED: 'M2W_5001',
  /** NSIS 编译失败。 */
  NSIS_COMPILE_FAILED: 'M2W_5002',

  /** 产物校验不通过。 */
  VERIFY_FAILED: 'M2W_6001',
  /** 产物架构不是 x86。 */
  VERIFY_WRONG_ARCH: 'M2W_6002',
  /** 产物不完整（缺少必需文件）。 */
  VERIFY_INCOMPLETE: 'M2W_6003',

  /** 用户中断。 */
  CANCELLED: 'M2W_9001',
  /** 未预期的内部错误。 */
  INTERNAL: 'M2W_9999',
}

/**
 * 打包流程中可预期的失败。
 *
 * 继承 `Error` 而不是用普通对象：这样 `try/catch` 与堆栈都还能用，
 * 上层不必为「可预期错误」写一套独立的传递方式。
 */
export class BuildError extends Error {
  /**
   * @param {string} code 错误码，取 {@link ErrorCode} 中的值。
   * @param {string} message 给用户看的一句话。
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

/** 把任意错误收敛成 {@link BuildError}，便于统一上报。 */
export function asBuildError(error) {
  if (error instanceof BuildError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new BuildError(ErrorCode.INTERNAL, message, {
    cause: error instanceof Error ? error : undefined,
  })
}

/** 判断一个错误是不是用户主动中断。 */
export function isCancellation(error) {
  if (error instanceof BuildError) return error.code === ErrorCode.CANCELLED
  return error instanceof Error && (error.name === 'AbortError' || error.message === '已取消')
}