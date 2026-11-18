#!/usr/bin/env node
/**
 * 统一命令行入口 `wacmin`。
 *
 * ## 与 console 的分工
 *
 * 两者共用同一套调度（`console/src/directions.mjs`），但面向的读者不同：
 *
 *   - `console`：人在看板前看进度、翻历史、点按钮。输出偏人类可读。
 *   - `wacmin` ：脚本与 agent 调用。输出偏机器可读，默认 JSON。
 *
 * 合并不是好主意 —— 看板需要起 HTTP 服务、维护 SSE 连接，脚本调用要的是
 * 一次进程一次结果、退出码即结论。硬塞进一个入口只会让两边都别扭。
 *
 * ## 为什么默认输出 JSON
 *
 * 这个入口的第一个使用者是 AI agent 与 shell 脚本。人类可读的表格对他们
 * 是负担（还要解析）。所以默认 JSON，加 `--human` 才输出给人看的格式。
 * 这与 `console` 的默认行为相反，是刻意的。
 *
 * ## 退出码
 *
 * 直接透传所调用方向的退出码，不重新定义。`wacmin` 自己产生的失败只有
 * 三种：2 用法错误、5 自检未全过、1 内部异常。这样 `wacmin run ... ; echo $?`
 * 在 shell 里能直接判断「那个方向的活干成了没有」。
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DIRECTIONS,
  DOCTOR_TIMEOUT_MS,
  runDirection,
  status,
} from '../../console/src/directions.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const MCP_ENTRY = join(REPO, 'ai', 'bin', 'wacmin-mcp.mjs')

const HELP = `
wacmin — 四个方向的统一命令行入口（面向脚本与 AI）

用法
  wacmin list                          列出四个方向（JSON）
  wacmin status                        同 list，但带就绪状态摘要
  wacmin run <方向> <子命令> [参数]      调用某个方向，透传退出码
  wacmin doctor [方向]                 环境自检；省略方向则四个并行
  wacmin contract                      检查四个方向是否遵守契约
  wacmin mcp                           打印 MCP 客户端配置片段
  wacmin skill                         打印 SKILL.md 的路径与摘要
  wacmin help                          显示本帮助

选项
  --human       输出人类可读格式而非 JSON
  --json        强制 JSON（默认）

示例
  wacmin list --human
  wacmin run mac2win doctor
  wacmin run mac2win build ../myapp --dry-run
  wacmin run exeonmac detect ~/Downloads/npp.exe
  wacmin doctor
  wacmin mcp

退出码
  0    成功
  1    wacmin 自身内部异常
  2    用法错误
  5    自检未全过（与各方向「缺外部依赖」同码）
  其他  透传所调用方向的退出码（见 README 附录 A）

环境变量
  WACMIN_TIMEOUT_MS   单次调用超时毫秒数，默认 1800000（30 分钟），0 表示不限
`.trim()

/** 是否要人类可读输出。 */
function wantsHuman(argv) {
  return argv.includes('--human')
}

/**
 * 输出一个对象。
 *
 * @param {unknown} data
 * @param {boolean} human
 * @param {(data: unknown) => string} [renderer] 人类可读渲染器
 */
function emit(data, human, renderer) {
  if (human && renderer !== undefined) {
    process.stdout.write(`${renderer(data)}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify(data, undefined, 2)}\n`)
}

/** list 的人类可读渲染。 */
function renderList(rows) {
  return rows
    .map((row) => {
      const mark = row.installed ? '✓' : '·'
      return `${mark} ${row.id.padEnd(10)} ${row.label.padEnd(10)} ${row.summary}`
    })
    .join('\n')
}

/** status 的人类可读渲染。 */
function renderStatus(rows) {
  return rows
    .map((row) => {
      const mark = row.installed ? '✓' : '·'
      return [
        `${mark} ${row.id}（${row.label}）`,
        `    宿主：${row.host}`,
        `    产出：${row.produces}`,
        `    子命令：${row.subcommands.join(' / ')}`,
      ].join('\n')
    })
    .join('\n\n')
}

async function main() {
  const argv = process.argv.slice(2)
  const [command, ...rest] = argv
  const human = wantsHuman(argv)
  const positional = rest.filter((item) => !item.startsWith('--'))

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${HELP}\n`)
    return
  }

  if (command === 'list') {
    emit(status(), human, renderList)
    return
  }

  if (command === 'status') {
    emit(status(), human, renderStatus)
    return
  }

  if (command === 'run') {
    const [id, sub, ...options] = positional
    if (id === undefined || sub === undefined) {
      process.stderr.write('用法：wacmin run <方向> <子命令> [参数]\n')
      process.exitCode = 2
      return
    }
    if (DIRECTIONS[id] === undefined) {
      process.stderr.write(`未知方向：${id}。可用：${Object.keys(DIRECTIONS).join(' / ')}\n`)
      process.exitCode = 2
      return
    }

    const outcome = await runDirection(id, sub, options, {
      onStderr: (chunk) => process.stderr.write(chunk),
    })

    if (outcome.report === null) {
      /*
       * 没拿到合规报告。
       *
       * 这可能是「该方向还没实现这个子命令」，也可能是参数错到它没走到
       * 输出报告那一步。两种情况都如实转述退出码与 stderr，不要编造原因。
       */
      process.stderr.write(`方向 ${id} 未输出合规报告（退出码 ${String(outcome.exitCode)}）\n`)
      if (outcome.stdout.trim() !== '') {
        process.stderr.write(`--- stdout ---\n${outcome.stdout.slice(-2000)}\n`)
      }
      process.exitCode = outcome.exitCode
      return
    }

    emit({
      ok: outcome.exitCode === 0,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      report: outcome.report,
    }, human, () => JSON.stringify(outcome.report, undefined, 2))
    process.exitCode = outcome.exitCode
    return
  }

  if (command === 'doctor') {
    const only = positional[0]
    const rows = only === undefined
      ? status()
      : status().filter((row) => row.id === only)

    if (rows.length === 0) {
      process.stderr.write(`未知方向：${String(only)}\n`)
      process.exitCode = 2
      return
    }

    /*
     * 并行跑。四个方向的 doctor 只探测工具存在性，互相独立，串行只是
     * 白等 —— 实测串行里 exeonmac 一项就占七成时间（Python 启动开销）。
     */
    const results = await Promise.all(rows.map(async (row) => {
      if (!row.installed) {
        return { direction: row.id, ok: false, reason: '目录不存在' }
      }
      const startedAt = Date.now()
      try {
        const outcome = await runDirection(row.id, 'doctor', [], {
          timeoutMs: DOCTOR_TIMEOUT_MS,
        })
        return {
          direction: row.id,
          ok: outcome.exitCode === 0 && !outcome.timedOut,
          exitCode: outcome.exitCode,
          durationMs: Date.now() - startedAt,
          ...(outcome.timedOut ? { reason: '自检超时' } : {}),
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
    emit({ ok: allOk, results }, human, (data) => data.results
      .map((item) => `${item.ok ? '✓' : '✗'} ${item.direction.padEnd(10)}${
        item.ok ? ` ${String(item.durationMs)}ms` : ` ${item.reason ?? `退出码 ${String(item.exitCode)}`}`
      }`)
      .join('\n'))
    process.exitCode = allOk ? 0 : 5
    return
  }

  if (command === 'contract') {
    /*
     * 契约检查复用 console 的实现。
     *
     * 不复制一份：这套检查的价值就在于「只有一个判据」。两处各写一套，
     * 迟早会对同一个方向给出不同结论，那时谁也不知道该信哪个。
     */
    const { runContractCheck } = await import('../../console/src/contract-check.mjs')
    const result = await runContractCheck({
      run: (id, sub, options = []) =>
        runDirection(id, sub, options, { timeoutMs: DOCTOR_TIMEOUT_MS }),
    })
    emit(result, human, (data) => {
      const lines = []
      for (const entry of data.results) {
        lines.push(`${entry.ok ? '✓' : '✗'} ${entry.direction}`)
        for (const scenario of entry.scenarios) {
          lines.push(`  ${scenario.ok ? '✓' : '✗'} ${scenario.scenario}`)
          for (const problem of scenario.problems) {
            lines.push(`      [${problem.check}] ${problem.detail}`)
          }
        }
      }
      const total = data.results.reduce((sum, e) => sum + e.scenarios.length, 0)
      const passed = data.results.reduce(
        (sum, e) => sum + e.scenarios.filter((s) => s.ok).length, 0)
      lines.push('', `${String(passed)} / ${String(total)} 场景符合契约`)
      return lines.join('\n')
    })
    process.exitCode = result.ok ? 0 : 5
    return
  }

  if (command === 'mcp') {
    /*
     * 打印可直接粘进客户端配置的片段。
     *
     * 直接打印而不是写文件：各家客户端的配置位置不同（Claude Desktop 的
     * claude_desktop_config.json、WorkBuddy 的 mcp.json、Cline 的设置页……），
     * 猜错位置写文件比不写更麻烦。给片段，用户自己粘。
     *
     * `command` 用 `node` 而不是 `process.execPath`：后者会把当前机器的
     * 绝对路径固化进去（如 `/Users/xxx/.nvm/versions/node/v22/bin/node`），
     * 换台机器或换 Node 版本就失效，而配置里看不出这是个「本机路径」。
     * 写 `node` 由客户端从 PATH 解析，可移植得多。真需要绝对路径的人
     * 知道自己在做什么，会自己改。
     */
    const snippet = {
      mcpServers: {
        wacmin: {
          command: 'node',
          args: [MCP_ENTRY],
        },
      },
    }
    emit(snippet, human, (data) => [
      '把下面这段合并进你的 MCP 客户端配置（已有 mcpServers 时只加 wacmin 这一项）：',
      '',
      JSON.stringify(data, undefined, 2),
      '',
      `入口文件：${MCP_ENTRY}`,
      '说明：本 server 只走 stdio，不监听任何端口，不联网。',
      '若客户端找不到 node，把 command 改成 `which node` 的输出（绝对路径）。',
    ].join('\n'))
    return
  }

  if (command === 'skill') {
    const skill = join(REPO, 'ai', 'skills', 'wacmin', 'SKILL.md')
    const present = existsSync(skill)
    emit({
      path: skill,
      present,
      installHint: present
        ? '把 ai/skills/wacmin 整个目录复制到你的 skill 目录（如 ~/.workbuddy/skills/）'
        : 'SKILL.md 尚未生成',
    }, human, (data) => [
      `SKILL.md：${data.path}`,
      data.present ? '状态：已就绪' : '状态：缺失',
      `安装：${data.installHint}`,
    ].join('\n'))
    process.exitCode = present ? 0 : 5
    return
  }

  process.stderr.write(`未知命令：${command}\n\n${HELP}\n`)
  process.exitCode = 2
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
