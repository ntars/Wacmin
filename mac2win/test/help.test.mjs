/**
 * 帮助文本与实际解析器的一致性。
 *
 * ## 为什么值得单独一组测试
 *
 * help 是用户唯一能自己查到的「这个工具能干什么」。它与代码不一致时，
 * 用户不会去读源码 —— 只会得出「这个功能不存在」的结论，或者反过来
 * 按文档敲了个参数却报 `Unknown option`。
 *
 * 本项目已经踩过两类真实事例：
 *
 *   1. `mac2win ui` 支持 `--port` / `--no-open`，但 help 里一个字没提，
 *      用户根本无从知道能指定端口
 *   2. `mac2win doctor` 是正式支持的命令，错误提示里都列了，但 help 的
 *      「用法」段漏了它 —— 看起来像不存在
 *
 * 这类偏差不会导致崩溃，只会让人白花时间，所以只能靠断言守住。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const run = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(ROOT, 'bin', 'mac2win.mjs')

/** 跑一次 --help，拿到文本。 */
async function getHelp() {
  const { stdout } = await run(process.execPath, [BIN, '--help'])
  return stdout
}

describe('帮助文本与解析器一致', () => {
  test('help 提到的每个长选项都被解析器接受', async () => {
    const help = await getHelp()
    const source = await readFile(BIN, 'utf8')

    // help 里的长选项（--help / --version 在 parseArgs 之前手工处理）
    const claimed = new Set()
    for (const m of help.matchAll(/--([a-z][a-z0-9-]*)/g)) claimed.add(m[1])

    // 解析器的 options 表（key 可能带引号，如 'no-open'）
    const start = source.indexOf('options: {')
    const end = source.indexOf('\n      },', start)
    const block = source.slice(start, end === -1 ? start + 4000 : end)
    const accepted = new Set()
    for (const m of block.matchAll(/^\s+'?([a-zA-Z][a-zA-Z0-9-]*)'?:/gm)) accepted.add(m[1])
    // --version 在 parseArgs 之前手工拦，--help 是 parseArgs 的 h 别名
    accepted.add('help')
    accepted.add('version')

    const bogus = [...claimed].filter((o) => !accepted.has(o)).sort()
    assert.deepEqual(bogus, [],
      `help 里写了但解析器不认的选项（用户敲了会报 Unknown option）：${bogus.join(', ')}`)
  })

  test('解析器接受的每个长选项都在 help 里出现过', async () => {
    const help = await getHelp()
    const source = await readFile(BIN, 'utf8')

    const start = source.indexOf('options: {')
    const end = source.indexOf('\n      },', start)
    const block = source.slice(start, end === -1 ? start + 4000 : end)
    const accepted = new Set()
    for (const m of block.matchAll(/^\s+'?([a-zA-Z][a-zA-Z0-9-]*)'?:/gm)) accepted.add(m[1])

    const mentioned = new Set()
    for (const m of help.matchAll(/--([a-z][a-z0-9-]*)/g)) mentioned.add(m[1])

    const silent = [...accepted].filter((o) => !mentioned.has(o)).sort()
    assert.deepEqual(silent, [],
      `解析器支持但 help 没写的选项（用户不知道存在）：${silent.join(', ')}`)
  })

  test('help 的「用法」段列全了所有子命令', async () => {
    const help = await getHelp()
    /*
     * 从错误提示里取「权威命令清单」—— 那是代码自己认为可用的命令，
     * 比在 help 文本里找更可靠。
     */
    const source = await readFile(BIN, 'utf8')
    /*
     * 源码里那一行是模板字符串：
     *   process.stderr.write(`可用：build / verify / ui / doctor\n`)
     * 所以拿到的捕获组末尾会带**字面**的 `\n` 两个字符（反斜杠 + n），
     * 不是真正的换行。要一并剥掉，否则命令名会变成 `doctor\n`
     * 这种永远匹配不上的东西。
     */
    const match = source.match(/可用：([^`]+)/)
    assert.ok(match, '没找到「可用：」错误提示，无法确定权威命令清单')

    const commands = match[1]
      .replace(/\\n/g, ' ')
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
    assert.ok(commands.length >= 3, `命令清单解析异常：${match[1]}`)

    for (const command of commands) {
      // 用词边界匹配：`mac2win doctor` 后面可能是换行、空格或行尾
      const pattern = new RegExp(`mac2win ${command}(?![a-z-])`)
      assert.ok(pattern.test(help),
        `help 的用法段里没有 \`mac2win ${command}\` —— 用户会以为它不存在`)
    }
  })

  test('每个子命令都能被真正执行到（不报未知命令）', async () => {
    /*
     * 逐个跑一次不带参数的子命令。这里只关心「命令本身被识别」——
     * 参数缺失导致的非零退出码是正常的，不当作失败。
     *
     * 注意不能用 promisify(execFile)：那个包装在子进程返回非零时也会
     * reject，把「缺少参数」误判成测试失败。这里用 callback 版本，
     * 无论退出码都继续看输出。
     */
    const source = await readFile(BIN, 'utf8')
    const match = source.match(/可用：([^`]+)/)
    assert.ok(match, '没找到「可用：」错误提示，无法确定权威命令清单')
    const commands = match[1].replace(/\\n/g, ' ').split('/')
      .map((s) => s.trim()).filter(Boolean)

    const execRaw = (cmd) => new Promise((resolve) => {
      execFile(process.execPath, [BIN, cmd], (error, stdout, stderr) => {
        resolve({ error, stdout: stdout ?? '', stderr: stderr ?? '' })
      })
    })

    for (const command of commands) {
      if (command === 'ui') continue // ui 会起服务，不在这里跑
      const result = await execRaw(command)
      const combined = `${result.stdout}${result.stderr}`
      assert.ok(!/未知命令|Unknown command/u.test(combined),
        `\`mac2win ${command}\` 被当成未知命令：${combined.slice(0, 200)}`)
    }
  })
})
