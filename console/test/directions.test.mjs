/**
 * 调度层的纯函数测试。
 *
 * ## 这套测试守的是一个已经发生过的事故
 *
 * `bin/wacmin-console.mjs` 原本顶层直接 `main()`，于是任何 import 它的
 * 地方都会连带执行一次 CLI。`src/server.mjs` 的 `/api/status` 正是这么写的，
 * 后果是：每有人打开看板，服务进程就把一份中文用法说明写进自己的 stdout，
 * 并把 `process.exitCode` 设成 2。
 *
 * 看板不读自己的 stdout，所以这个污染藏了很久。真正让它变致命的是 MCP ——
 * MCP 规范要求 stdout 只出现协议消息，多一个字客户端就解析失败。也就是说
 * 这个缺陷会在新的调用方式下立刻暴露，而且表现为「服务一启动就坏」。
 *
 * 所以这里测两件容易被忽略的事：
 *
 *   1. import 一个能力模块必须零副作用（不写 stdout、不改 exitCode）
 *   2. 直接执行时 CLI 照常工作
 *
 * 第 2 条看起来多余，但它是第 1 条的对偶：只把副作用删干净、
 * 把 CLI 也删坏了，同样不可接受。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const CONSOLE = join(REPO, 'console')
const ENTRY = join(CONSOLE, 'bin', 'wacmin-console.mjs')

describe('导入副作用', () => {
  test('import 入口文件不写 stdout、不改 exitCode', async () => {
    /*
     * 用子进程测，不用本进程 import。
     *
     * 本进程 import 之后再断言「stdout 没被写」是测不出来的 —— 测试
     * 框架自己也在写 stdout，而且 import 已经发生，无法回溯。必须让
     * 一个干净的子进程只做 import，再把它的两个流原样拿回来。
     */
    const script = `
      const before = process.exitCode;
      await import(${JSON.stringify(ENTRY)});
      const after = process.exitCode;
      process.stderr.write(JSON.stringify({ before, after }));
    `
    const { stdout, stderr } = await run(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: CONSOLE },
    )

    assert.equal(
      stdout, '',
      `import 入口文件时不应该有任何 stdout 输出，实际收到 ${String(stdout.length)} 字节：${stdout.slice(0, 200)}`,
    )

    const state = JSON.parse(stderr)
    assert.equal(state.before, undefined, '测试开始时 exitCode 应该是未设置状态')
    assert.equal(
      state.after, undefined,
      `import 不该改动 process.exitCode，实际被改成 ${String(state.after)}`,
    )
  })

  test('import 共享调度模块不写 stdout', async () => {
    const script = `
      await import(${JSON.stringify(join(CONSOLE, 'src', 'directions.mjs'))});
    `
    const { stdout } = await run(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: CONSOLE },
    )
    assert.equal(stdout, '', '共享模块被 import 时必须完全静默')
  })

  test('导入后仍能拿到三个公开 API', async () => {
    // 搬家不该改公开面：老调用点继续能用。
    const module = await import(ENTRY)
    assert.equal(typeof module.runDirection, 'function')
    assert.equal(typeof module.status, 'function')
    assert.equal(typeof module.DIRECTIONS, 'object')
    assert.ok(Object.keys(module.DIRECTIONS).length > 0)
  })
})

describe('方向表', () => {
  test('四个方向齐全且字段完整', async () => {
    const { DIRECTIONS } = await import(ENTRY)
    for (const id of ['mac2win', 'exeonmac', 'win2mac', 'apponwin']) {
      const spec = DIRECTIONS[id]
      assert.ok(spec !== undefined, `缺少方向 ${id}`)
      assert.equal(typeof spec.label, 'string')
      assert.equal(typeof spec.summary, 'string')
      assert.equal(typeof spec.host, 'string', `${id} 缺 host 字段`)
      assert.equal(typeof spec.produces, 'string', `${id} 缺 produces 字段`)
      assert.ok(Array.isArray(spec.subcommands), `${id} 的 subcommands 必须是数组`)
      assert.ok(spec.subcommands.length > 0, `${id} 的 subcommands 不该为空`)
      assert.equal(typeof spec.runner, 'function')
    }
  })

  test('每个方向都声明了实际存在的主力子命令', async () => {
    /*
     * 这条防的是「工具表写残」。
     *
     * agent 拿到一张残缺的子命令表，会以为本项目只会自检 —— 于是它永远
     * 不会去调用 build，用户问「帮我打个包」时 agent 答「本项目不支持」。
     * 这不是 agent 的错，是表本身漏了。
     */
    const { DIRECTIONS } = await import(ENTRY)
    for (const [id, spec] of Object.entries(DIRECTIONS)) {
      assert.ok(
        spec.subcommands.includes('doctor'),
        `${id} 应该声明 doctor`,
      )
    }
    assert.ok(DIRECTIONS.mac2win.subcommands.includes('build'), 'mac2win 必须声明 build')
    assert.ok(DIRECTIONS.win2mac.subcommands.includes('build'), 'win2mac 必须声明 build')
    assert.ok(DIRECTIONS.exeonmac.subcommands.includes('build'), 'exeonmac 必须声明 build')
    assert.ok(DIRECTIONS.apponwin.subcommands.includes('assess'), 'apponwin 必须声明 assess')
  })

  test('status 反映目录存在性与声明顺序', async () => {
    const { status, DIRECTIONS } = await import(ENTRY)
    const rows = status()
    assert.equal(rows.length, Object.keys(DIRECTIONS).length)
    assert.deepEqual(
      rows.map((row) => row.id),
      Object.keys(DIRECTIONS),
      'status 的顺序必须与 DIRECTIONS 的声明顺序一致',
    )
    for (const row of rows) {
      assert.equal(typeof row.installed, 'boolean')
      assert.ok(Array.isArray(row.subcommands))
    }
  })

  test('status 返回的是副本，外部改动不会污染方向表', async () => {
    /*
     * 暴露内部数组是典型的隐性耦合：调用方 `subcommands.push(...)` 之后
     * 方向表就被改了，而且改的人不知道自己改了全局状态。
     */
    const { status, DIRECTIONS } = await import(ENTRY)
    const rows = status()
    rows[0].subcommands.push('__污染__')
    assert.ok(
      !DIRECTIONS[rows[0].id].subcommands.includes('__污染__'),
      'status 必须返回副本，不能把内部数组直接交出去',
    )
  })
})

describe('命令行', () => {
  test('list 列出四个方向', async () => {
    const { stdout } = await run(process.execPath, [ENTRY, 'list'], { cwd: CONSOLE })
    for (const id of ['mac2win', 'exeonmac', 'win2mac', 'apponwin']) {
      assert.match(stdout, new RegExp(id, 'u'))
    }
  })

  test('无参数打印帮助且不报错退出', async () => {
    const { stdout } = await run(process.execPath, [ENTRY], { cwd: CONSOLE })
    assert.match(stdout, /用法/u)
    assert.match(stdout, /console run/u)
  })

  test('未知命令退出码是 2', async () => {
    await assert.rejects(
      () => run(process.execPath, [ENTRY, '__不存在的命令__'], { cwd: CONSOLE }),
      (error) => {
        assert.equal(error.code, 2, `未知命令该退 2，实际 ${String(error.code)}`)
        assert.match(error.stderr, /未知命令/u)
        return true
      },
    )
  })
})

describe('stdout 长度上限', () => {
  /*
   * 这一组守的是「stderr 有上限、stdout 没有」的不对称。
   *
   * stderr 的注释解释了为什么要封顶（跑 30 分钟的安装能产生几十 MB
   * 日志）。stdout 走的是报告，看起来不会很大 —— 但它**最容易被污染**：
   * 本仓库自己就踩过「import 顶层调 main() 的入口文件，每次请求往
   * stdout 打印用法说明」的坑。方向侧任何一处误用 console.log 刷进度，
   * 都能把它灌满，而它原来一点上限都没有。
   *
   * 上限在模块加载时从环境变量读取，所以必须在子进程里设 —— 本进程
   * import 之后改环境变量已经晚了。
   */
  test('默认上限是 8 MB', async () => {
    const { stdout } = await run(
      process.execPath,
      ['--input-type=module', '-e',
        'const m = await import("./src/directions.mjs");'
        + 'process.stdout.write(String(m.STDOUT_CAP))'],
      { cwd: CONSOLE },
    )
    assert.equal(Number(stdout), 8 * 1024 * 1024)
  })

  test('超限时 stdout 被截断到上限以内', async () => {
    /*
     * 用真实方向调用（doctor 的报告约 2 KB），把上限压到 1 KB。
     * 若截断生效，拿回的 stdout 不该超过 1 KB。
     */
    const script = `
      const { runDirection } = await import('./src/directions.mjs');
      const result = await runDirection('mac2win', 'doctor', [], { timeoutMs: 60000 });
      process.stdout.write(JSON.stringify({
        length: result.stdout.length,
        exitCode: result.exitCode,
        reportIsNull: result.report === null,
      }));
    `
    const { stdout } = await run(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: CONSOLE, env: { ...process.env, WACMIN_STDOUT_LIMIT_BYTES: '1024' } },
    )
    const state = JSON.parse(stdout)

    assert.ok(state.length <= 1024,
      `stdout 应被截断到 1024 以内，实际 ${String(state.length)} 字节`)
    /*
     * 截断会让 JSON 解析失败，report 变成 null。这不是缺陷 ——
     * 现有设计对「报告不合规」的处理路径本来就是「report 为 null，
     * 调用方按 exitCode 判断」。行为保持一致比额外造一套错误类型好。
     */
    assert.equal(state.reportIsNull, true,
      '截断后报告必然不完整，report 应为 null 而不是抛异常')
  })

  test('正常报告不受上限影响', async () => {
    const script = `
      const { runDirection } = await import('./src/directions.mjs');
      const result = await runDirection('mac2win', 'doctor', [], { timeoutMs: 60000 });
      process.stdout.write(JSON.stringify({
        length: result.stdout.length,
        hasReport: result.report !== null && typeof result.report === 'object',
        direction: result.report?.direction ?? null,
      }));
    `
    const { stdout } = await run(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: CONSOLE },
    )
    const state = JSON.parse(stdout)

    assert.equal(state.hasReport, true, '正常报告应能解析出来')
    assert.equal(state.direction, 'mac2win')
    assert.ok(state.length > 0)
  })
})
