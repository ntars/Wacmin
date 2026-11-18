/**
 * MCP server（stdio 传输）。
 *
 * ## 为什么不用官方 SDK
 *
 * 本项目全仓零第三方依赖：Node 侧只用 `node:*`，Python 侧只用标准库。
 * 引入 `@modelcontextprotocol/sdk` 会让「clone 下来就能跑」变成「先 npm i」，
 * 而且把协议细节藏进一层抽象，出问题时反而更难定位。
 *
 * MCP 的 stdio 部分本身很小：换行分隔的 JSON-RPC，几个方法名。这个文件
 * 加上 `protocol.mjs` 一共不到 600 行，可读、可测、无依赖。
 *
 * ## stdout 是独占的（最重要的一条）
 *
 * MCP 规范明文要求：**server MUST NOT write anything to its stdout that is
 * not a valid MCP message**。这一条比它看上去更容易违反 ——
 *
 * 本仓库自己就踩过：`console/src/server.mjs` 曾经 `import` 一个顶层直接
 * `main()` 的入口文件，于是每次请求都往 stdout 打印一份中文用法说明。
 * 看板不读自己的 stdout，所以那个缺陷藏了很久。同样的写法搬到这里，
 * 客户端会在收到第一份「用法」时判定协议错误并断开。
 *
 * 因此本文件的所有日志走 `log()`，它只写 stderr。任何 console.log 都是
 * 缺陷，测试里有一条专门扫描源码中是否出现 `console.log`。
 *
 * ## 取消要真的停掉后台进程
 *
 * 构建可能跑几分钟。客户端发 `notifications/cancelled` 时，如果只是标记
 * 一下、让后台继续跑完，用户会看到「已取消」但磁盘上多了一个产物 ——
 * 这比不取消更糟。所以每个在途请求都挂一个 `AbortController`，
 * 取消时按进程组杀掉子进程树（`directions.mjs` 里的 `killTree`）。
 */

import { createInterface } from 'node:readline'

import {
  DIRECTIONS,
  DOCTOR_TIMEOUT_MS,
  runDirection,
  status,
} from '../../console/src/directions.mjs'
import {
  ERROR_CODES,
  encodeMessage,
  isValidId,
  parseLine,
  rpcError,
  rpcResult,
} from './protocol.mjs'
import { TOOLS, buildArgv, verifyArgv } from './tools.mjs'

/** 本 server 声明的协议版本。客户端给别的版本时回这个。 */
export const PROTOCOL_VERSION = '2025-06-18'

/** 本 server 支持的协议版本清单（从新到旧）。 */
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

/**
 * 支持构建的方向集合。
 *
 * apponwin 不在其中：它的设计目标就是评估，没有 build 子命令。
 */
const BUILD_DIRECTIONS = new Set(['mac2win', 'exeonmac', 'win2mac'])

/** 服务标识。 */
const SERVER_INFO = {
  name: 'wacmin',
  title: 'Wacmin（四方向打包与兼容层）',
  version: '1.0.0',
}

/**
 * 给客户端的用法说明。
 *
 * 这段文字会进模型的上下文，所以要写成「该怎么做」而不是「本服务是什么」。
 * 客户端通常把它作为 system prompt 的一部分注入。
 */
const INSTRUCTIONS = [
  '本服务把 Wacmin 的四个方向能力暴露成工具。四个方向分别是：',
  'mac2win（macOS 上产出 Windows 安装包）、exeonmac（macOS 上运行 Windows 程序，',
  '也可把 Windows 安装包封装成 .app）、win2mac（Windows 上产出 macOS 应用包）、',
  'apponwin（Windows 上运行 macOS 程序，仅评估阶段）。',
  '',
  '建议顺序：不确定用哪个方向时先调 wacmin_list_directions；',
  '要构建之前先调 wacmin_doctor 确认外部工具就位 —— 多数构建失败其实是',
  '缺 makensis / wine / 7z，而不是代码问题；',
  'wacmin_build 会写盘且可能跑几分钟，调用前请确认用户确实想要产物。',
  '',
  '读报告时注意 ok 与 complete 是两个维度：ok 表示有没有查出问题，',
  'complete 表示是不是全验了。complete 为 false 时不能对外声称「校验通过」。',
  '',
  '退出码含义固定：0 成功 / 1 未归类失败 / 2 参数错误 / 3 能力未实现 /',
  '4 明确不支持 / 5 缺外部依赖 / 6 构建失败 / 7 产物校验失败 / 130 用户中断。',
].join('\n')

/**
 * 启动 server。
 *
 * @param {object} [options]
 * @param {NodeJS.ReadableStream} [options.input] 默认 process.stdin
 * @param {NodeJS.WritableStream} [options.output] 默认 process.stdout
 * @param {NodeJS.WritableStream} [options.errorOutput] 默认 process.stderr
 * @param {(id: string, command: string, options?: string[], hooks?: object) => Promise<object>} [options.run]
 *   注入以便测试，默认走真实的 directions.runDirection。
 * @returns {{closed: Promise<void>, stop: () => Promise<void>, inFlight: () => number}}
 */
export function startMcpServer(options = {}) {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const errorOutput = options.errorOutput ?? process.stderr
  const run = options.run ?? runDirection

  /** 是否已完成 initialize 握手。 */
  let initialized = false
  /** 在途请求：id → AbortController。用于取消。 */
  const inFlight = new Map()
  /** 是否已收到 EOF / 停止请求。 */
  let stopping = false

  /**
   * 写一条协议消息。
   *
   * 所有输出都必须经过这里。直接 `output.write` 会在某天被人加进一句
   * 调试输出，而那正是最难查的一类问题 —— 客户端只会说「协议错误」。
   *
   * @param {object} message
   */
  const send = (message) => {
    if (stopping) return
    try {
      output.write(encodeMessage(message))
    } catch (error) {
      log(`写响应失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 日志只走 stderr。 */
  const log = (message) => {
    try {
      errorOutput.write(`[wacmin-mcp] ${message}\n`)
    } catch {
      // stderr 断了也不能让协议流程崩。
    }
  }

  /**
   * 处理 initialize。
   *
   * 版本协商按规范：客户端给的是我支持的 → 原样回；否则回我支持的最新版。
   * 不能直接拒绝 —— 那样新客户端会因为老 server 而完全不可用。
   */
  const handleInitialize = (id, params) => {
    const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : ''
    const version = SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION

    if (requested !== '' && requested !== version) {
      log(`协议版本 ${requested} 不在支持列表，改用 ${version}`)
    }

    initialized = true
    send(rpcResult(id, {
      protocolVersion: version,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    }))
  }

  /** 处理 tools/list。 */
  const handleListTools = (id) => {
    /*
     * 原样返回定义。
     *
     * 不做「按客户端能力过滤」这类自作聪明的事：客户端能力协商的是
     * 它支持哪些协议特性，不是它想看到哪些工具。过滤掉一半只会让
     * agent 以为我们没有那个能力。
     */
    send(rpcResult(id, { tools: TOOLS }))
  }

  /**
   * 把一次方向调用的结果包装成 MCP 工具结果。
   *
   * ## 为什么失败也用 result 而不是 error
   *
   * MCP 把错误分两层：
   *   - **协议错误**（`error` 字段）：方法不存在、参数结构不对、服务崩了
   *   - **工具执行错误**（`result.isError = true`）：工具跑了但业务上失败了
   *
   * 「构建失败，退出码 6」属于后者。它是**有效的信息**，模型需要看到
   * 退出码、错误码、stderr 才能决定下一步（装工具？改参数？放弃？）。
   * 用协议错误回它，多数客户端只会显示「工具调用失败」，把细节吞掉。
   *
   * @param {object} outcome
   * @returns {object}
   */
  const toToolResult = (outcome) => {
    const { exitCode, report, stderr, timedOut, aborted } = outcome

    /*
     * 退出码为 0 且拿到合规报告，才算成功。
     *
     * 只看 exitCode 不够：封装层自己 spawn 失败时也是非 0，但那不是
     * 工具的业务失败，而是调用方用错了方向。两者都要如实反映。
     */
    const ok = exitCode === 0 && report !== null && !timedOut && !aborted

    const payload = {
      ok,
      exitCode,
      timedOut,
      aborted,
      direction: report?.direction ?? null,
      command: report?.command ?? null,
      durationMs: report?.durationMs ?? null,
      artifacts: Array.isArray(report?.artifacts) ? report.artifacts : [],
      /*
       * 把 complete 单独提出来。
       *
       * 这是本项目最容易误读的字段：ok 与 complete 正交，只报 ok 会让
       * 模型把「没验」说成「验过了」。提到顶层能降低误读概率。
       */
      complete: report?.complete ?? null,
      unverified: Array.isArray(report?.unverified) ? report.unverified : [],
      error: report?.error ?? null,
      stages: Array.isArray(report?.stages)
        ? report.stages.map((stage) => ({
          id: stage.id,
          name: stage.name,
          status: stage.status,
          ...(typeof stage.durationMs === 'number' ? { durationMs: stage.durationMs } : {}),
          ...(stage.errorCode ? { errorCode: stage.errorCode } : {}),
        }))
        : [],
      /*
       * stderr 只带尾部。
       *
       * 一次 30 分钟的安装能产生几十 MB 日志，全塞进模型上下文会直接
       * 撑爆窗口，而且真正有用的永远是最末几十行。
       */
      stderrTail: typeof stderr === 'string' && stderr !== ''
        ? stderr.slice(-4000)
        : '',
    }

    const text = [
      ok ? '✓ 执行成功' : '✗ 执行未成功',
      `退出码 ${String(exitCode)}`,
      ...(timedOut ? ['（已超时并被终止）'] : []),
      ...(aborted ? ['（已被调用方取消）'] : []),
      ...(report === null ? ['未拿到合规报告，可能是方向未实现或参数错误'] : []),
      ...(payload.error !== null ? [`错误码 ${String(payload.error.code)}：${String(payload.error.message)}`] : []),
      ...(payload.error?.hint ? [`提示：${payload.error.hint}`] : []),
      ...(payload.artifacts.length > 0
        ? [`产物：${payload.artifacts.map((a) => `${String(a.path)}（${String(a.bytes)} 字节）`).join('、')}`]
        : []),
      ...(payload.complete === false
        ? [`注意：本次校验未覆盖全部项目，未验证项 ${String(payload.unverified.length)} 个`]
        : []),
      ...(payload.stderrTail !== '' ? [`--- stderr 尾部 ---\n${payload.stderrTail}`] : []),
    ].join('\n')

    return {
      content: [
        { type: 'text', text },
        /*
         * 结构化内容同时给出。
         *
         * 规范建议：返回 structuredContent 时也应把序列化 JSON 放进一个
         * TextContent，以兼容只读文本的老客户端。这里两个都给了。
         */
        { type: 'text', text: JSON.stringify(payload) },
      ],
      structuredContent: payload,
      ...(ok ? {} : { isError: true }),
    }
  }

  /**
   * 执行一次方向调用，带取消支持。
   *
   * @param {string} requestId
   * @param {string} direction
   * @param {string} command
   * @param {string[]} args
   * @param {object} [hooks]
   * @returns {Promise<object>}
   */
  const invoke = async (requestId, direction, command, args, hooks = {}) => {
    const controller = new AbortController()
    inFlight.set(requestId, controller)
    try {
      return await run(direction, command, args, {
        ...hooks,
        signal: controller.signal,
      })
    } finally {
      inFlight.delete(requestId)
    }
  }

  /**
   * 处理 tools/call。
   *
   * 分派逻辑按工具名走。`wacmin_run` 是逃生门，其余的工具都只是把
   * 参数翻译成某个方向的固定子命令。
   */
  const handleCallTool = async (id, params) => {
    const name = typeof params?.name === 'string' ? params.name : ''
    const args = params?.arguments !== null && typeof params?.arguments === 'object'
      ? params.arguments
      : {}

    if (name === 'wacmin_list_directions') {
      send(rpcResult(id, {
        content: [{
          type: 'text',
          text: JSON.stringify({ directions: status() }),
        }],
        structuredContent: { directions: status() },
      }))
      return
    }

    if (name === 'wacmin_doctor') {
      const direction = typeof args.direction === 'string' ? args.direction : null
      if (direction === null) {
        /*
         * 不指定方向：并行自检四个。
         *
         * 并行而非串行 —— 四个子进程互相独立，串行只是白等。实测串行
         * 555ms 里有 415ms 是 exeonmac 一项（Python 启动开销）。
         */
        const rows = status()
        const results = await Promise.all(rows.map(async (row) => {
          if (!row.installed) {
            return { direction: row.id, ok: false, reason: '目录不存在' }
          }
          try {
            const outcome = await invoke(
              `${String(id)}:${row.id}`,
              row.id,
              'doctor',
              [],
              { timeoutMs: DOCTOR_TIMEOUT_MS },
            )
            return {
              direction: row.id,
              ok: outcome.exitCode === 0 && !outcome.timedOut,
              exitCode: outcome.exitCode,
              timedOut: outcome.timedOut,
              error: outcome.report?.error ?? null,
            }
          } catch (error) {
            return {
              direction: row.id,
              ok: false,
              reason: error instanceof Error ? error.message : String(error),
            }
          }
        }))
        const allOk = results.every((item) => item.ok)
        send(rpcResult(id, {
          content: [{
            type: 'text',
            text: JSON.stringify({ results }, undefined, 2),
          }],
          structuredContent: { results, ok: allOk },
          ...(allOk ? {} : { isError: true }),
        }))
        return
      }

      if (DIRECTIONS[direction] === undefined) {
        send(rpcError(id, ERROR_CODES.INVALID_PARAMS, `未知方向：${direction}`, {
          supported: Object.keys(DIRECTIONS),
        }))
        return
      }
      const outcome = await invoke(id, direction, 'doctor', [], { timeoutMs: DOCTOR_TIMEOUT_MS })
      send(rpcResult(id, toToolResult(outcome)))
      return
    }

    if (name === 'wacmin_build') {
      const direction = typeof args.direction === 'string' ? args.direction : ''
      if (direction === 'apponwin') {
        /*
         * 明确拒绝而不是「试试看」。
         *
         * apponwin 的设计目标就是评估，没有 build 子命令。让它走到
         * 子进程里再报「未知子命令」，用户看到的是我们的实现细节；
         * 在这里拒绝并说明替代方案，才是有效信息。
         */
        send(rpcError(
          id,
          ERROR_CODES.INVALID_PARAMS,
          'apponwin 不提供构建能力，它只做兼容性评估。请改用 wacmin_assess。',
        ))
        return
      }
      if (BUILD_DIRECTIONS.has(direction) === false) {
        send(rpcError(id, ERROR_CODES.INVALID_PARAMS, `未知或不支持构建的方向：${direction}`, {
          supported: [...BUILD_DIRECTIONS],
        }))
        return
      }
      let argv
      try {
        argv = buildArgv(direction, args)
      } catch (error) {
        send(rpcError(id, ERROR_CODES.INVALID_PARAMS,
          error instanceof Error ? error.message : String(error)))
        return
      }
      const outcome = await invoke(id, direction, 'build', argv)
      send(rpcResult(id, toToolResult(outcome)))
      return
    }

    if (name === 'wacmin_verify') {
      const direction = typeof args.direction === 'string' ? args.direction : ''
      if (DIRECTIONS[direction] === undefined) {
        send(rpcError(id, ERROR_CODES.INVALID_PARAMS, `未知方向：${direction}`))
        return
      }
      let argv
      try {
        argv = verifyArgv(direction, args)
      } catch (error) {
        send(rpcError(id, ERROR_CODES.INVALID_PARAMS,
          error instanceof Error ? error.message : String(error)))
        return
      }
      const outcome = await invoke(id, direction, 'verify', argv)
      send(rpcResult(id, toToolResult(outcome)))
      return
    }

    if (name === 'wacmin_assess') {
      const direction = typeof args.direction === 'string' ? args.direction : ''
      const path = typeof args.path === 'string' ? args.path : ''
      if (path === '') {
        send(rpcError(id, ERROR_CODES.INVALID_PARAMS, '缺少 path 参数'))
        return
      }
      const command = direction === 'apponwin' ? 'assess' : 'detect'
      if (direction !== 'apponwin' && direction !== 'exeonmac') {
        send(rpcError(id, ERROR_CODES.INVALID_PARAMS,
          `方向 ${direction} 不支持评估。apponwin 用 assess，exeonmac 用 detect。`))
        return
      }
      const extra = Array.isArray(args.extraArgs) ? args.extraArgs.map(String) : []
      const outcome = await invoke(id, direction, command, [path, ...extra])
      send(rpcResult(id, toToolResult(outcome)))
      return
    }

    if (name === 'wacmin_run') {
      const direction = typeof args.direction === 'string' ? args.direction : ''
      const command = typeof args.command === 'string' ? args.command : ''
      if (DIRECTIONS[direction] === undefined) {
        send(rpcError(id, ERROR_CODES.INVALID_PARAMS, `未知方向：${direction}`))
        return
      }
      if (command === '') {
        send(rpcError(id, ERROR_CODES.INVALID_PARAMS, '缺少 command 参数'))
        return
      }
      /*
       * 逃生门也要有底线：只允许该方向声明过的子命令。
       *
       * 「原样透传」不等于「什么都能传」。不做这一层校验时，一个
       * 拼错的子命令会让各方向自己的 argparse 报错，错误信息五花八门，
       * agent 很难从中判断是自己拼错了。这里直接给出可用清单。
       */
      const allowed = DIRECTIONS[direction].subcommands
      if (!allowed.includes(command)) {
        send(rpcError(id, ERROR_CODES.INVALID_PARAMS,
          `方向 ${direction} 没有子命令 ${command}`,
          { available: allowed }))
        return
      }
      const extra = Array.isArray(args.args) ? args.args.map(String) : []
      const outcome = await invoke(id, direction, command, extra)
      send(rpcResult(id, toToolResult(outcome)))
      return
    }

    send(rpcError(id, ERROR_CODES.INVALID_PARAMS, `未知工具：${name}`, {
      available: TOOLS.map((tool) => tool.name),
    }))
  }

  /** 处理取消通知。 */
  const handleCancelled = (params) => {
    const requestId = params?.requestId
    /*
     * 通知里的 requestId 类型必须与请求一致。JSON-RPC 允许 string 与
     * number，Map 的键比较是严格相等，`1` 与 `"1"` 不等 —— 统一转成
     * 字符串再查，避免因类型不同查不到而漏掉取消。
     */
    const controller = inFlight.get(String(requestId)) ?? inFlight.get(requestId)
    if (controller === undefined) {
      /*
       * 找不到就静默忽略。
       *
       * 规范明确说：未知 ID、已完成、格式错误的取消通知 SHOULD 被忽略。
       * 回错误反而会让客户端的取消逻辑卡住。
       */
      return
    }
    log(`收到取消请求：${String(requestId)}${typeof params?.reason === 'string' ? `（${params.reason}）` : ''}`)
    controller.abort()
  }

  /**
   * 处理一条消息。
   *
   * @param {object} message
   */
  const handleMessage = async (message) => {
    const { id, method, params } = message
    const isNotification = id === undefined

    /*
     * 通知没有 id，不能回响应。
     *
     * `notifications/initialized` 是握手最后一步：客户端收到 initialize
     * 结果后发它，表示「我准备好了」。收到它才算真正进入工作状态。
     * 但这里不强制 —— 有些客户端会跳过它直接调工具，为此拒绝服务
     * 只会让那些客户端完全不可用。
     */
    if (isNotification) {
      if (method === 'notifications/cancelled') {
        handleCancelled(params)
      } else if (method === 'notifications/initialized') {
        log('客户端握手完成')
      }
      return
    }

    if (!isValidId(id)) {
      send(rpcError(null, ERROR_CODES.INVALID_REQUEST, 'id 必须是字符串、数字或 null'))
      return
    }

    if (method === 'initialize') {
      handleInitialize(id, params)
      return
    }

    if (method === 'ping') {
      // ping 用于存活探测，必须在任何状态下都能回。
      send(rpcResult(id, {}))
      return
    }

    if (method === 'tools/list') {
      handleListTools(id)
      return
    }

    if (method === 'tools/call') {
      await handleCallTool(id, params)
      return
    }

    /*
     * prompts / resources 未实现。
     *
     * 回 METHOD_NOT_FOUND 而不是空列表：空列表意味着「有这能力但现在
     * 没有内容」，客户端会以为以后会有。没实现就该明确说不支持。
     */
    send(rpcError(id, ERROR_CODES.METHOD_NOT_FOUND, `不支持的方法：${method}`, {
      supported: ['initialize', 'ping', 'tools/list', 'tools/call'],
    }))
  }

  const reader = createInterface({ input, crlfDelay: Infinity })

  /**
   * 消息处理队列。
   *
   * ## 为什么必须有这道队列
   *
   * 这里的注释原本就写着「串行处理：不并发」，但实现是
   * `void (async () => {...})()` —— 每收到一行就起一个新异步任务，
   * 彼此并行。注释说的事从来没发生过。
   *
   * 后果不是理论上的：`tools/call` 里有 `build` / `package` 这类会写出
   * 产物的操作。两条 build 并行时争用同一个输出目录，互相覆盖中间文件，
   * 得到的是半成品 —— 而且两次调用看起来都成功。这类损坏只在产物里
   * 显现，不在日志里。
   *
   * 串行也不能简单 `await` 在 `on('line')` 里：`on('line')` 的返回
   * Promise 没人等，第二行照样会立刻触发。只能自己维护一条链。
   */
  let queue = Promise.resolve()

  /**
   * 把一件事排进队列，返回它自己的 Promise。
   *
   * `.catch` 是必需的：队列链上只要有一环 reject，整条链就断了，
   * 之后所有消息都不会再被处理 —— 而进程还活着，客户端只是「卡住」，
   * 没有任何报错。这正是最难排查的形态。
   */
  function enqueue(work) {
    const result = queue.then(work)
    queue = result.catch(() => {})
    return result
  }

  /** 处理一行输入：解析、分发、兜住异常。 */
  async function processLine(line) {
    const parsed = parseLine(line)
    if (parsed.ok === false) {
      send(rpcError(null, parsed.code, parsed.message))
      return
    }
    try {
      await handleMessage(parsed.message)
    } catch (error) {
      const id = isValidId(parsed.message.id) ? parsed.message.id : null
      const message = error instanceof Error ? error.message : String(error)
      log(`处理 ${String(parsed.message.method)} 时异常：${message}`)
      if (parsed.message.id !== undefined) {
        send(rpcError(id, ERROR_CODES.INTERNAL_ERROR, message))
      }
    }
  }

  const closed = new Promise((resolveClosed) => {
    reader.on('line', (line) => {
      if (stopping) return
      /*
       * 取消通知**不排队**。
       *
       * 它的全部意义就是打断在途任务。若也排进队列，就得等前面那个
       * 跑了十分钟的 build 结束才轮到自己 —— 那时早已无事可取消。
       * 客户端点了「取消」却毫无反应，是最糟糕的交互。
       */
      const parsed = parseLine(line)
      if (parsed.ok === true && parsed.message.method === 'notifications/cancelled') {
        void processLine(line)
        return
      }
      void enqueue(() => processLine(line))
    })

    reader.on('close', () => {
      stopping = true
      /*
       * EOF 时把所有在途请求取消掉。
       *
       * 客户端断开后后台还留着一个跑了十分钟的构建进程，是明确的资源
       * 泄漏 —— 而且用户看不到它在跑。
       */
      for (const controller of inFlight.values()) {
        controller.abort()
      }
      inFlight.clear()
      resolveClosed()
    })
  })

  return {
    closed,
    /** 仍在处理的请求数，供测试断言取消是否真的生效。 */
    inFlight: () => inFlight.size,
    /** 主动停止（测试用）。 */
    stop: async () => {
      stopping = true
      for (const controller of inFlight.values()) controller.abort()
      inFlight.clear()
      reader.close()
    },
  }
}
