/**
 * MCP 的 JSON-RPC 编解码。
 *
 * 这里只放**纯函数**：不碰 stdin/stdout、不碰进程状态。理由很直接 ——
 * 分帧与错误码是协议里最容易写错、又最容易测的部分。把它们和 IO 混在
 * 一起，测一次就得起一个子进程；分开之后，一个字符串进一个数组出，
 * 边界条件可以逐条摁住。
 *
 * ## 分帧规则（来自 MCP 2025-06-18 规范，stdio 传输）
 *
 * > Messages are delimited by newlines, and **MUST NOT** contain embedded newlines.
 *
 * 这一条与 LSP 的 `Content-Length:` 分帧**完全不同**。凭印象写成本头
 * 分帧的话，服务在自测时看起来正常（自己发自己收），一接真实客户端就
 * 一个字都读不出来。所以这里严格按换行切，并且发送时保证消息本身不含
 * 裸换行。
 *
 * `JSON.stringify` 会把字符串里的换行转义成 `\n` 两个字符，因此正常
 * 序列化出来的 JSON 天然不含裸换行 —— 前提是不用 `undefined, 2` 那种
 * 美化输出。美化输出会把每个字段换到独立一行，是这里唯一需要防的坑。
 */

/** JSON-RPC 与 MCP 用到的标准错误码。 */
export const ERROR_CODES = {
  /** 收到的不是合法 JSON。 */
  PARSE_ERROR: -32700,
  /** 是合法 JSON，但不是合法的 JSON-RPC 请求对象。 */
  INVALID_REQUEST: -32600,
  /** 方法不存在。 */
  METHOD_NOT_FOUND: -32601,
  /** 方法存在，参数不合法。 */
  INVALID_PARAMS: -32602,
  /** 服务内部错误。 */
  INTERNAL_ERROR: -32603,
}

/**
 * 增量分帧器。
 *
 * ## 为什么要缓冲而不是逐块解析
 *
 * `stdin` 的 `data` 事件给的是**任意切分**的字节块：一条消息可能横跨
 * 两个块，一个块里也可能挤着三条消息。直接对每块 `JSON.parse` 会在
 * 三种情况下出错：消息被切断（解析失败）、多消息粘连（整块解析失败）、
 * 结尾半个 UTF-8 字符（乱码）。
 *
 * 所以先攒进缓冲，按换行切出**完整行**再解析，剩下的尾巴留到下一块。
 *
 * ## UTF-8 跨块切割
 *
 * 中文占 3 字节，很容易被切在块边界上。用 `StringDecoder` 而不是
 * `chunk.toString()`：前者会把不完整的多字节序列留到下一次，后者会
 * 立刻替换成 U+FFFD，且**无法挽回** —— 表现为偶发的「报告里中文变成
 * 问号」，而且只在特定分包下复现。
 */
export class LineDecoder {
  /** @param {string} [encoding] */
  constructor(encoding = 'utf8') {
    this.#decoder = new TextDecoder(encoding)
    this.#buffer = ''
  }

  #decoder
  #buffer

  /**
   * 喂一块数据，取出其中所有完整的行。
   *
   * @param {Uint8Array|string} chunk
   * @returns {string[]} 完整行（已去掉行尾换行符），可能为空数组。
   */
  push(chunk) {
    this.#buffer += typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true })

    const lines = []
    let index = this.#buffer.indexOf('\n')
    while (index !== -1) {
      let line = this.#buffer.slice(0, index)
      this.#buffer = this.#buffer.slice(index + 1)
      // Windows 客户端可能发 \r\n。\r 留在 JSON 尾部会让解析失败。
      if (line.endsWith('\r')) line = line.slice(0, -1)
      lines.push(line)
      index = this.#buffer.indexOf('\n')
    }
    return lines
  }

  /**
   * 冲刷残留。
   *
   * 流结束时缓冲里可能还剩最后一行（客户端没发结尾换行）。丢掉它就等于
   * 丢掉最后一条请求，而那条很可能是 `tools/call`。
   *
   * @returns {string[]}
   */
  flush() {
    const rest = this.#buffer + this.#decoder.decode()
    this.#buffer = ''
    const line = rest.endsWith('\r') ? rest.slice(0, -1) : rest
    return line.trim() === '' ? [] : [line]
  }
}

/**
 * 把一条消息编码成可以写进 stdout 的一行。
 *
 * 强制 `JSON.stringify` 不带缩进 —— 缩进会引入裸换行，直接违反分帧规则。
 *
 * @param {object} message
 * @returns {string} 以换行结尾的单行字符串。
 */
export function encodeMessage(message) {
  const text = JSON.stringify(message)
  /*
   * 双保险。
   *
   * `JSON.stringify` 正常不会产出裸换行，但对象里若混进已序列化的字符串
   * （比如把某个字段先 stringify 再塞回去），就可能带 `\n` 进结果。这类
   * 错误在自测时看不出来，客户端会静静地解析失败。宁可在这里断死。
   */
  if (text.includes('\n') || text.includes('\r')) {
    throw new Error('JSON-RPC 消息不得包含裸换行（会破坏 stdio 分帧）')
  }
  return `${text}\n`
}

/**
 * 构造成功响应。
 *
 * @param {string|number|null} id
 * @param {unknown} result
 * @returns {object}
 */
export function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

/**
 * 构造错误响应。
 *
 * @param {string|number|null} id
 * @param {number} code
 * @param {string} message
 * @param {unknown} [data]
 * @returns {object}
 */
export function rpcError(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: '2.0', id, error }
}

/**
 * 判断一个值是否是可接受的 JSON-RPC id。
 *
 * 规范允许 string / number / null。**不接受** undefined、对象、布尔 ——
 * 用 undefined 当 id 会被 `JSON.stringify` 整个丢掉，响应就变成了一条
 * 「没有 id 的响应」，客户端只能当作通知丢弃，表现为调用无声无息地消失。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidId(value) {
  return value === null
    || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value))
}

/**
 * 解析一行文本。
 *
 * @param {string} line
 * @returns {{ok: true, message: object} | {ok: false, code: number, message: string}}
 */
export function parseLine(line) {
  if (line.trim() === '') {
    return { ok: false, code: ERROR_CODES.PARSE_ERROR, message: '空消息' }
  }
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    return {
      ok: false,
      code: ERROR_CODES.PARSE_ERROR,
      message: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      code: ERROR_CODES.INVALID_REQUEST,
      message: '消息必须是 JSON 对象',
    }
  }
  if (parsed.jsonrpc !== '2.0') {
    return {
      ok: false,
      code: ERROR_CODES.INVALID_REQUEST,
      message: '缺少 "jsonrpc": "2.0"',
    }
  }
  if (typeof parsed.method !== 'string') {
    /*
     * 客户端发来的响应（对我方请求的回复）也会走这里。本服务不发请求，
     * 所以收到无 method 的消息只可能是脏数据或误用。用 INVALID_REQUEST
     * 回它，比静默丢弃更利于排查。
     */
    return {
      ok: false,
      code: ERROR_CODES.INVALID_REQUEST,
      message: '缺少 method 字段',
    }
  }
  return { ok: true, message: parsed }
}
