#!/usr/bin/env node
/**
 * 检查 node --test 的输出：不允许有任何 SKIP，且测试总数不得低于基线。
 *
 * ## 这个脚本为什么存在
 *
 * `node --test` 在有测试被 `t.skip()` 时**退出码是 0**，汇总里只写一行
 * `# skipped 3`。CI 上一直是绿的，而那 3 项测试从来没跑过。
 *
 * 实测过这件事：CI 日志里是
 *
 *     # tests 131
 *     # pass 128
 *     # skipped 3
 *
 * 跳过的是「控制台程序按 GUI 校验必须被拒」这类拒绝路径的核心断言 ——
 * 守卫没在站岗，但报告全绿，没人会发现。
 *
 * ## 与 exeonmac 那个同名脚本的关系
 *
 * 同一件事的两种测试框架（unittest / node:test），输出格式不同，所以
 * 各写一份。共同点：宁可红，也不允许「跳过的绿」。
 *
 * 用法：
 *     node --test test/ > log.txt 2>&1
 *     node test/check-no-skips.mjs log.txt --min 131
 */

import { readFileSync } from 'node:fs'

function parseArgs(argv) {
  const args = { log: null, min: 0 }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--min') {
      args.min = Number(argv[index + 1])
      index += 1
    } else if (!item.startsWith('-')) {
      args.log = item
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (args.log === null) {
  console.error('用法：node test/check-no-skips.mjs <日志文件> [--min N]')
  process.exit(2)
}

let text
try {
  text = readFileSync(args.log, 'utf8')
} catch (error) {
  console.error(`读不到日志：${args.log}：${error.message}`)
  process.exit(2)
}

const pick = (name) => {
  const match = text.match(new RegExp(`^# ${name} (\\d+)$`, 'mu'))
  return match === null ? null : Number(match[1])
}

const tests = pick('tests')
const skipped = pick('skipped')

if (tests === null) {
  console.error('没读到 `# tests N` 汇总行 —— 测试可能根本没跑起来')
  console.error(text.slice(-2000))
  process.exit(2)
}

console.log(`测试 ${String(tests)} 项，跳过 ${String(skipped ?? 0)} 项，下限 ${String(args.min)} 项`)

let failed = false

if ((skipped ?? 0) > 0) {
  console.error(`\n${String(skipped)} 项测试被跳过：`)
  for (const line of text.split('\n')) {
    // 形如 `ok 52 - 名字 # SKIP 原因`
    if (line.includes('# SKIP')) console.error(`  ${line.trim()}`)
  }
  console.error(
    '\n跳过在报告里是绿的，跟通过长得一样。'
    + '能用工具或自建夹具解决的问题不该用跳过处理 —— '
    + '「没装某工具」是环境问题，把它变成跳过就等于允许这个环境永远不验那段逻辑。',
  )
  failed = true
}

if (tests < args.min) {
  console.error(
    `\n测试总数 ${String(tests)} 少于基线 ${String(args.min)}：`
    + '有测试没被发现，或夹具/模块加载失败导致整块消失。',
  )
  failed = true
}

process.exit(failed ? 1 : 0)
