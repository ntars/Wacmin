/**
 * 四方向调度层（共享模块）。
 *
 * ## 为什么从 bin 里搬出来
 *
 * 这段逻辑原本住在 `bin/wacmin-console.mjs` 里。那个文件是**可执行入口**：
 * 顶层直接调用 `main()`，一被执行就打帮助、跑命令。于是「复用调度能力」
 * 和「运行 CLI」被绑死在同一份模块上 —— 任何想 import 它的地方都会连带
 * 触发一次 CLI 执行。
 *
 * 这不是理论问题，是实测出来的：`src/server.mjs` 的 `/api/status` 处理
 * 分支里有 `await import('../bin/wacmin-console.mjs')`，只为拿一个 `status()`。
 * 后果是每次有人打开看板、前端请求 `/api/status`，服务进程就会把一份
 * 中文用法说明写进自己的 stdout，并把 `process.exitCode` 设成 2。
 *
 * 看板自己不看 stdout，所以这个污染一直没被发现。但 MCP server 也复用
 * 这套调度 —— 而 MCP 规范明确要求 **stdout 只能出现协议消息**，多一个字
 * 都会让客户端解析失败。同一个缺陷换到 MCP 上就是致命的。
 *
 * 所以把「能力」与「入口」分开：
 *
 *   - 本模块：纯能力，被 import 时零副作用
 *   - `bin/wacmin-console.mjs`：可执行入口，只负责解析 argv 与打印
 *
 * ## 职责边界
 *
 * 它**只做两件事**：找到某个方向的 CLI，调用它，读回 `--report` 的 JSON。
 * 不实现任何构建逻辑 —— 一旦在这里重写一遍打包流程，就等于有了第二份
 * 真源，两个方向的行为必然逐渐分叉。
 *
 * ## 为什么用子进程而不是 import
 *
 * 四个方向的实现语言不同（Node / Python），进程边界是唯一干净的边界。
 * 子进程也带来一个好处：某个方向崩了不会带崩整个 console。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// HERE 是 console/src，仓库根要再上两级。
const REPO = resolve(HERE, '..', '..')

/**
 * 默认超时：30 分钟。
 *
 * 为什么是 30 分钟：exeonmac 的静默安装在大安装包上可能跑十几分钟
 * （实测空谷 Ondra 装完要等很久），给足余量。但绝不无限等 ——
 * 无限等意味着一个挂死的 wine 进程能让整个入口卡到用户放弃。
 *
 * 环境变量 WACMIN_TIMEOUT_MS 可覆盖，0 表示不限（仅供调试）。
 */
const DEFAULT_TIMEOUT_MS = Number(process.env.WACMIN_TIMEOUT_MS ?? 30 * 60 * 1000)

/** stderr 保留上限：256 KB，约几千行，够定位问题。 */
const STDERR_LIMIT = 256 * 1024

/**
 * stdout 保留上限：8 MB。
 *
 * 报告走这条通道，而报告本身通常不到 1 MB，8 MB 留足 40 倍余量；
 * 上限存在的意义是「异常输出不会吃光内存」，不是「省内存」。取尾部
 * 而不是头部：报告是**末尾**那个 JSON，截掉前面的日志噪音反而更有用。
 *
 * `WACMIN_STDOUT_LIMIT_BYTES` 可覆盖，与 `WACMIN_TIMEOUT_MS` 同一套
 * 约定。测试把它设小来验证截断行为 —— 否则要真造 8 MB 输才能测到。
 */
const STDOUT_LIMIT = Number(process.env.WACMIN_STDOUT_LIMIT_BYTES ?? 8 * 1024 * 1024)

/** 供测试断言默认值与截断生效，不参与业务逻辑。 */
export const STDOUT_CAP = STDOUT_LIMIT

/** spawn 失败时的退出码。取 shell 惯例的 127（command not found）。 */
export const SPAWN_FAILED_EXIT = 127

/**
 * doctor 的超时：60 秒。
 *
 * 自检只探测工具是否存在，正常在 1 秒内完成。给 60 秒是留足余量，
 * 同时保证「某个方向的自检卡死」不会拖住整个汇总 —— 60 秒后判定
 * 该项失败，其余三项照常出结果。
 */
export const DOCTOR_TIMEOUT_MS = 60 * 1000

/**
 * 四个方向的调用约定。
 *
 * `runner` 返回 `{ command, args }`，由 {@link runDirection} 负责起进程。
 * 新增方向只需在这里加一条，其他部分不用改。
 *
 * `subcommands` 是这个方向支持的子命令清单，供 MCP 与统一 CLI 生成工具表。
 * **它必须与各方向 `--help` 的输出一致** —— 早先只写极简版会漏掉 build
 * 之类的主力命令，agent 拿到一张残缺的工具表，就会以为本项目只会自检。
 */
export const DIRECTIONS = {
  mac2win: {
    label: 'Mac2Win',
    summary: '在 macOS 上产出 Windows 安装包',
    host: 'macOS',
    produces: 'Windows 安装包（.exe，NSIS 外壳）或免安装 .zip',
    cwd: join(REPO, 'mac2win'),
    subcommands: ['build', 'verify', 'doctor', 'ui'],
    runner: (command, options) => ({
      command: process.execPath,
      args: [join(REPO, 'mac2win', 'bin', 'mac2win.mjs'), command, ...options],
    }),
  },
  exeonmac: {
    label: 'ExeOnMac',
    summary: '在 macOS 上运行 Windows 程序',
    host: 'macOS',
    produces: '可双击运行的 macOS .app（内含 wine prefix）',
    cwd: join(REPO, 'exeonmac'),
    subcommands: [
      'detect', 'extract', 'install', 'package', 'build',
      'layers', 'recipe', 'runtime', 'doctor', 'version',
    ],
    runner: (command, options) => ({
      command: 'python3',
      args: ['-m', 'wepack', command, ...options],
    }),
  },
  win2mac: {
    label: 'Win2Mac',
    summary: '在 Windows 上产出 macOS 应用包',
    host: 'Windows',
    produces: 'macOS .app 目录与保留权限位的 .zip',
    cwd: join(REPO, 'win2mac'),
    subcommands: ['build', 'verify', 'doctor'],
    runner: (command, options) => ({
      command: process.execPath,
      args: [join(REPO, 'win2mac', 'bin', 'win2mac.mjs'), command, ...options],
    }),
  },
  apponwin: {
    label: 'AppOnWin',
    summary: '在 Windows 上运行 macOS 程序',
    host: 'Windows',
    produces: '兼容性评估报告（运行能力待实测定论）',
    cwd: join(REPO, 'apponwin'),
    subcommands: ['assess', 'parse', 'spike', 'doctor'],
    runner: (command, options) => ({
      command: process.execPath,
      args: [join(REPO, 'apponwin', 'bin', 'apponwin.mjs'), command, ...options],
    }),
  },
}

/** 各方向是否已就绪（目录存在即视为已就绪，缺实现时由报告自己说明）。 */
export function status() {
  return Object.entries(DIRECTIONS).map(([id, spec]) => ({
    id,
    label: spec.label,
    summary: spec.summary,
    host: spec.host,
    produces: spec.produces,
    subcommands: [...spec.subcommands],
    installed: existsSync(spec.cwd),
  }))
}

/**
 * 跑一个方向。
 *
 * @param {string} id 方向标识。
 * @param {string} command 子命令。
 * @param {string[]} [options] 追加参数。
 * @param {object} [hooks]
 * @param {(chunk: string) => void} [hooks.onStderr] 实时收日志。
 * @param {(chunk: string) => void} [hooks.onStdout] 实时收标准输出（谨慎使用，报告也在其中）。
 * @param {number} [hooks.timeoutMs] 超时毫秒数，0 表示不限。
 * @param {AbortSignal} [hooks.signal] 外部取消信号。
 * @returns {Promise<{exitCode: number, report: object|null, stderr: string, stdout: string, timedOut: boolean, aborted: boolean}>}
 */
export function runDirection(id, command, options = [], hooks = {}) {
  const spec = DIRECTIONS[id]
  if (spec === undefined) {
    return Promise.reject(new Error(`未知方向：${id}`))
  }
  if (!existsSync(spec.cwd)) {
    return Promise.reject(new Error(`方向 ${id} 的目录不存在：${spec.cwd}`))
  }

  const timeoutMs = hooks.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const { command: bin, args } = spec.runner(command, [...options, '--report'])

  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, {
      cwd: spec.cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      /*
       * Windows 上不设 shell，但需要能杀整个进程树。
       * detached 让子进程自成进程组，超时时可以按组杀 —— 否则
       * `python3 -m wepack` 拉起的 wine 子进程会变成孤儿继续跑。
       */
      detached: process.platform !== 'win32',
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false

    /*
     * stderr 只保留尾部。
     *
     * 一个跑 30 分钟的安装可能产生几十 MB 日志，全存进内存没有意义 ——
     * 出错时人只看最后几十行。这里限制在 STDERR_LIMIT 字符内，
     * 超出时从头部丢弃。
     */
    const appendStderr = (text) => {
      stderr += text
      if (stderr.length > STDERR_LIMIT) {
        stderr = stderr.slice(-STDERR_LIMIT)
      }
    }

    const finish = (exitCode) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (hooks.signal !== undefined) {
        hooks.signal.removeEventListener('abort', onAbort)
      }

      let report = null
      try {
        report = JSON.parse(stdout)
      } catch {
        // 方向没按契约输出时 report 为 null，由调用方按 exitCode 判断。
      }
      resolvePromise({ exitCode, report, stderr, stdout, timedOut, aborted })
    }

    /*
     * 超时保护。
     *
     * 没有这一层时，任何一个方向卡住都会让调用方永久挂起 ——
     * 实测用「永不退出的子进程」可以 100% 复现。真实场景里 wine
     * 安装器挂死、下载卡在网络半开连接，都会触发。
     *
     * 超时后先 SIGTERM 让子进程有机会收尾，再 SIGKILL 兜底。
     */
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        killTree(child, 'SIGTERM')
        // 给 2 秒收尾，之后强杀
        setTimeout(() => { killTree(child, 'SIGKILL') }, 2000)
      }, timeoutMs)
      : null

    /*
     * 外部取消。
     *
     * MCP 客户端可以发 `notifications/cancelled` 撤销一次调用。没有这条
     * 通路时，用户点了取消，后台的构建仍在跑，产物落到磁盘上 —— 用户
     * 会以为取消成功了。
     *
     * 取消与超时走同一套杀进程逻辑，但 `aborted` 与 `timedOut` 分开记录：
     * 「用户不要了」和「跑太久了」是两种不同的失败，报告里要能区分。
     */
    const onAbort = () => {
      aborted = true
      killTree(child, 'SIGTERM')
      setTimeout(() => { killTree(child, 'SIGKILL') }, 2000)
    }
    if (hooks.signal !== undefined) {
      if (hooks.signal.aborted) {
        onAbort()
      } else {
        hooks.signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    child.stdout.on('data', (chunk) => {
      /*
       * stdout 也要有上限，与 stderr 对称。
       *
       * stderr 的注释解释了为什么要封顶（一个跑 30 分钟的安装能产生
       * 几十 MB 日志）。stdout 的道理一样，但它更危险 —— 报告走这条
       * 通道，而 stdout 恰恰**最容易被污染**：本仓库自己就踩过「import
       * 一个顶层调 main() 的入口文件，每次请求往 stdout 打印用法说明」
       * 的坑（`ai/src/server.mjs` 的注释有完整记录）。方向侧任何一处
       * 误用 console.log 刷进度，都能把它灌满。
       *
       * 8 MB 的依据：真实报告最大的一份（exeonmac 带完整 checks 的
       * build）约 200 KB，留 40 倍余量足够；同时保证异常输出不会把
       * 服务端内存吃光。
       */
      stdout += chunk
      if (stdout.length > STDOUT_LIMIT) stdout = stdout.slice(-STDOUT_LIMIT)
      hooks.onStdout?.(chunk.toString())
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      appendStderr(text)
      hooks.onStderr?.(text)
    })

    /*
     * spawn 本身失败（ENOENT / EACCES）。
     *
     * Node 在这种情况下也会触发 close（code 为 -2），但 error 事件
     * 是唯一能拿到 errno 的地方。不监听它会让 Node 在部分版本上
     * 抛出未捕获异常。
     */
    child.on('error', (error) => {
      appendStderr(`[wacmin] 无法启动 ${id}：${error.message}\n`)
      finish(SPAWN_FAILED_EXIT)
    })

    child.on('close', (code, signal) => {
      /*
       * 被信号杀死时 code 为 null。用 128+信号编号表达，
       * 与 shell 惯例一致（SIGTERM=15 → 143，SIGKILL=9 → 137）。
       */
      if (code === null) {
        finish(signal === 'SIGKILL' ? 137 : 143)
        return
      }
      finish(code)
    })
  })
}

/**
 * 杀掉子进程（及其进程组）。
 *
 * POSIX 上子进程以 detached 启动，自成进程组，`-pid` 可整组杀 ——
 * 这是必要的，因为 `python3 -m wepack` 会拉起 wine、7z 等子进程，
 * 只杀直接子进程会留下孤儿。
 *
 * Windows 上没有进程组信号，只能调 `taskkill /t` 按树杀。这条分支
 * 在本机（darwin）永远走不到，而它恰恰是**超时与取消的唯一兜底** ——
 * 走错了就会留下孤儿 wine 进程继续装东西，用户以为取消了实际没取消。
 * 所以把平台与 spawn 都做成可注入，让测试能真的执行这条分支。
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 * @param {{platform?: string, spawnFn?: typeof spawn}} [options] 仅供测试注入。
 * @returns {{method: 'none'|'taskkill'|'group'|'direct', args?: string[]}} 实际走的路径，供测试断言。
 */
export function killTree(child, signal, options = {}) {
  if (child.pid === undefined) return { method: 'none' }
  const hostPlatform = options.platform ?? process.platform
  const spawnFn = options.spawnFn ?? spawn
  try {
    if (hostPlatform === 'win32') {
      // Windows 上没有进程组信号，用 taskkill 按树杀
      const args = ['/pid', String(child.pid), '/t', '/f']
      spawnFn('taskkill', args, { stdio: 'ignore' })
      return { method: 'taskkill', args }
    }
    process.kill(-child.pid, signal)
    return { method: 'group' }
  } catch {
    /*
     * 进程可能已经退出（ESRCH），或权限不足（EPERM）。
     * 两种情况都不该让调用方崩 —— 后面还有 close 事件兜底。
     */
    try { child.kill(signal) } catch { /* 已经没了 */ }
    return { method: 'direct' }
  }
}
