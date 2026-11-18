/**
 * 统一命令行 `wacmin` 的测试。
 *
 * ## 重点在退出码透传
 *
 * 这个入口的价值在于「`wacmin run ... ; echo $?` 能直接判断那个方向干成没干成」。
 * 所以每条断言都盯退出码：用法错误是 2、自检未全过是 5、方向失败原码透传。
 * 若这里把各方向的码重新映射成统一的 0/1，脚本作者就得去解析输出才能判断，
 * 那这个入口就白做了。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const AI = join(HERE, '..')
const CLI = join(AI, 'bin', 'wacmin.mjs')

/**
 * 跑一次 CLI，**不抛异常**。
 *
 * 直接 `promisify(execFile)` 在非 0 退出码时会 reject，而这里大多数断言
 * 恰恰要看非 0 的情形。所以自己包一层，把退出码当数据取回来。
 *
 * @param {string[]} args
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function cli(args) {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [CLI, ...args], { cwd: AI }, (error, stdout, stderr) => {
      const code = error === null ? 0 : (typeof error.code === 'number' ? error.code : 1)
      resolvePromise({ code, stdout, stderr })
    })
  })
}

describe('基础命令', () => {
  test('无参数打印帮助并退 0', async () => {
    const result = await cli([])
    assert.equal(result.code, 0)
    assert.match(result.stdout, /wacmin — /u)
    assert.match(result.stdout, /wacmin run/u)
  })

  test('help 子命令与 --help 等价', async () => {
    const a = await cli(['help'])
    const b = await cli(['--help'])
    assert.equal(a.code, 0)
    assert.equal(b.code, 0)
    assert.equal(a.stdout, b.stdout)
  })

  test('list 默认输出 JSON', async () => {
    /*
     * 默认 JSON 是刻意的：这个入口的第一个使用者是 agent 与脚本，
     * 人类可读的表格对他们反而是负担（还要解析）。与 console 的默认
     * 行为相反。
     */
    const result = await cli(['list'])
    assert.equal(result.code, 0)
    const parsed = JSON.parse(result.stdout)
    assert.equal(Array.isArray(parsed), true)
    assert.equal(parsed.length, 4)
  })

  test('list --human 输出人类可读格式', async () => {
    const result = await cli(['list', '--human'])
    assert.equal(result.code, 0)
    assert.throws(() => { JSON.parse(result.stdout) }, 'human 模式不该输出 JSON')
    assert.match(result.stdout, /mac2win/u)
    assert.match(result.stdout, /在 macOS 上产出 Windows 安装包/u)
  })

  test('list 的 JSON 含宿主与产出字段', async () => {
    const parsed = JSON.parse((await cli(['list'])).stdout)
    for (const row of parsed) {
      assert.equal(typeof row.host, 'string', `${row.id} 缺 host`)
      assert.equal(typeof row.produces, 'string', `${row.id} 缺 produces`)
      assert.ok(Array.isArray(row.subcommands))
    }
  })

  test('status 比 list 多带产出细节', async () => {
    const result = await cli(['status', '--human'])
    assert.equal(result.code, 0)
    assert.match(result.stdout, /宿主：/u)
    assert.match(result.stdout, /产出：/u)
    assert.match(result.stdout, /子命令：/u)
  })

  test('未知命令退 2', async () => {
    const result = await cli(['__不存在__'])
    assert.equal(result.code, 2)
    assert.match(result.stderr, /未知命令/u)
  })
})

describe('run 子命令', () => {
  test('缺参数退 2', async () => {
    const result = await cli(['run'])
    assert.equal(result.code, 2)
    assert.match(result.stderr, /用法/u)
  })

  test('只给方向不够，仍退 2', async () => {
    const result = await cli(['run', 'mac2win'])
    assert.equal(result.code, 2)
    assert.match(result.stderr, /用法/u)
  })

  test('未知方向退 2 并列出可用方向', async () => {
    const result = await cli(['run', '__x__', 'doctor'])
    assert.equal(result.code, 2)
    assert.match(result.stderr, /未知方向/u)
    assert.match(result.stderr, /mac2win/u, '应列出可用方向')
  })

  test('真实调用 mac2win doctor 能跑完', async () => {
    /*
     * 这条测的是「透传链路通不通」，不断言成功。
     *
     * 最初这里写的是 `version`，但 `mac2win` 没有 version 子命令 ——
     * 版本查询是全局的 `--version`。用它当「一定成功」的样本是错的。
     * 改用 doctor：四个方向都有，退出码 0 或 5 都属于正常结果，
     * 两种都能证明链路是通的。
     */
    const result = await cli(['run', 'mac2win', 'doctor'])
    assert.ok([0, 5].includes(result.code), `退出码应是 0 或 5，实际 ${String(result.code)}：${result.stderr}`)
    const parsed = JSON.parse(result.stdout)
    assert.equal(typeof parsed.exitCode, 'number')
    assert.equal(typeof parsed.report, 'object')
  })

  test('方向失败时退出码原样透传，不重映射', async () => {
    /*
     * 这是本入口的核心契约。
     *
     * `mac2win build` 传一个不存在的项目目录，方向会以一个非 0 码退出。
     * 若这里把它改成 1，脚本作者就无法区分「我参数写错了」和「程序崩了」。
     *
     * ## 为什么不断言具体的码值
     *
     * 最初这里写死 `assert.equal(result.code, 2)` 且 `error.code === 'M2W_1002'`，
     * 在 macOS 上确实成立 —— 但这台机器上宿主预检是过的，首个失败项是
     * `project-root`。换到 ubuntu（CI 就跑在那）首个失败项变成 `host-platform`，
     * 两条断言仍然通过纯属**巧合**：`preflightToError` 的映射表里没有
     * `host-platform` 这个键（写成了 `host-os`），于是走了 `M2W_1002` 兜底。
     *
     * 也就是说这条测试当时守的不是契约，而是一个 bug 的副作用。一旦把
     * 映射表补对，CI 立刻变红，而变红的理由是「行为改对了」。
     *
     * 因此改为断言真正的不变量：**退出码不重映射**（`wacmin` 的码等于方向的码）、
     * 失败标记正确、错误码符合契约格式。这与平台无关。
     */
    const result = await cli(['run', 'mac2win', 'build', '/tmp/__绝对不存在__'])
    assert.notEqual(result.code, 0, '构建不存在的项目不该成功')

    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.exitCode, result.code, '退出码必须原样透传，不能重映射')
    assert.match(parsed.report.error.code, /^M2W_\d{4}$/u, '错误码须符合契约格式')
  })

  test('报告写进 report 字段而不是丢在 stderr', async () => {
    const result = await cli(['run', 'mac2win', 'doctor'])
    const parsed = JSON.parse(result.stdout)
    assert.ok(Array.isArray(parsed.report.stages), '报告应含 stages')
    assert.equal(typeof parsed.report.direction, 'string')
    assert.equal(parsed.report.direction, 'mac2win')
  })

  test('--human 时把报告原样打出而不是包装层', async () => {
    /*
     * 人看的时候更关心报告本身，而不是 `{ok, exitCode, report}` 这层壳。
     * 壳是给脚本用的。
     */
    const result = await cli(['run', 'mac2win', 'doctor', '--human'])
    assert.ok([0, 5].includes(result.code))
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.direction, 'mac2win', 'human 模式应直接给报告')
    assert.equal('report' in parsed, false, '不该有包装层')
  })
})

describe('doctor 子命令', () => {
  test('可指定单个方向', async () => {
    const result = await cli(['doctor', 'mac2win'])
    // 成功 0，缺工具 5，两种都算正常结果
    assert.ok([0, 5].includes(result.code), `退出码应是 0 或 5，实际 ${String(result.code)}`)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.results.length, 1)
    assert.equal(parsed.results[0].direction, 'mac2win')
  })

  test('未知方向退 2', async () => {
    const result = await cli(['doctor', '__x__'])
    assert.equal(result.code, 2)
    assert.match(result.stderr, /未知方向/u)
  })

  test('不指定方向时检查四个', async () => {
    const result = await cli(['doctor'])
    assert.ok([0, 5].includes(result.code))
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.results.length, 4)
  })

  test('结果里每个方向都带 ok 字段', async () => {
    const result = await cli(['doctor'])
    const parsed = JSON.parse(result.stdout)
    for (const item of parsed.results) {
      assert.equal(typeof item.ok, 'boolean', `${item.direction} 缺 ok`)
      assert.equal(typeof item.direction, 'string')
    }
  })

  test('整体 ok 等于各项都 ok', async () => {
    const result = await cli(['doctor'])
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.ok, parsed.results.every((item) => item.ok))
  })

  test('失败项退出码是 5 而不是 1', async () => {
    /*
     * 5 在契约里是「缺外部依赖」。自检不过就是这个类别 —— 用户该去装
     * 工具，不是去查代码。用 1（未归类失败）会让人以为是程序 bug。
     */
    const result = await cli(['doctor'])
    if (result.code === 5) {
      const parsed = JSON.parse(result.stdout)
      assert.equal(parsed.ok, false)
    } else {
      assert.equal(result.code, 0)
    }
  })
})

describe('mcp 与 skill 子命令', () => {
  test('mcp 输出可直接使用的配置片段', async () => {
    const result = await cli(['mcp'])
    assert.equal(result.code, 0)
    const parsed = JSON.parse(result.stdout)
    assert.ok(parsed.mcpServers.wacmin !== undefined)
    assert.equal(parsed.mcpServers.wacmin.command, 'node')
    assert.equal(Array.isArray(parsed.mcpServers.wacmin.args), true)
    assert.match(parsed.mcpServers.wacmin.args[0], /wacmin-mcp\.mjs$/u)
  })

  test('mcp 片段不固化本机绝对路径', async () => {
    /*
     * 用 `process.execPath` 会把当前机器的 node 绝对路径写进配置，
     * 换机器或换 Node 版本就失效，而配置里看不出那是个本机路径。
     */
    const parsed = JSON.parse((await cli(['mcp'])).stdout)
    assert.equal(parsed.mcpServers.wacmin.command, 'node', '应该是可移植的 node，而不是绝对路径')
  })

  test('mcp --human 带说明文字', async () => {
    const result = await cli(['mcp', '--human'])
    assert.equal(result.code, 0)
    assert.match(result.stdout, /合并进你的 MCP 客户端配置/u)
    assert.match(result.stdout, /不联网/u)
  })

  test('skill 报告 SKILL.md 存在', async () => {
    const result = await cli(['skill'])
    assert.equal(result.code, 0, 'SKILL.md 应已生成')
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.present, true)
    assert.match(parsed.path, /ai\/skills\/wacmin\/SKILL\.md$/u)
  })

  test('skill 给出安装方式', async () => {
    const result = await cli(['skill', '--human'])
    assert.match(result.stdout, /复制到你的 skill 目录/u)
  })
})

describe('contract 子命令', () => {
  test('契约检查能跑完并给出结果', async () => {
    /*
     * 这条会真的把四个方向都跑起来，属于慢测试（约 1-2 秒）。
     * 但它值这个时间：契约一致性是四个方向能拼成一个产品的前提，
     * 而这条是唯一从外部验证它的入口。
     */
    const result = await cli(['contract'])
    assert.ok([0, 5].includes(result.code), `退出码应是 0 或 5，实际 ${String(result.code)}`)
    const parsed = JSON.parse(result.stdout)
    assert.equal(Array.isArray(parsed.results), true)
    assert.equal(parsed.results.length, 4)
  })

  test('每个方向都有场景明细', async () => {
    const parsed = JSON.parse((await cli(['contract'])).stdout)
    for (const entry of parsed.results) {
      assert.ok(Array.isArray(entry.scenarios), `${entry.direction} 缺 scenarios`)
      assert.ok(entry.scenarios.length > 0, `${entry.direction} 的场景不该为空`)
    }
  })

  test('--human 输出场景汇总', async () => {
    const result = await cli(['contract', '--human'])
    assert.match(result.stdout, /场景符合契约/u)
  })
})
