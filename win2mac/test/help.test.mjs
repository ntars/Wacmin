/**
 * 帮助文本、子命令分发与实际行为的一致性。
 *
 * ## 这一组守的三件事
 *
 * 1. help 声明的选项，解析器都认（否则用户按文档敲会报 Unknown option）
 * 2. 解析器接受的选项，help 都写了（否则用户不知道功能存在）
 * 3. 拼错的子命令要明确报「未知子命令」，而不是被当成路径 ——
 *    后者会报「项目目录不存在」，把人引到完全错误的方向
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(ROOT, 'bin', 'win2mac.mjs')

/** 跑一次命令，不论退出码都返回输出。 */
function execRaw(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

async function getHelp() {
  const { stdout } = await execRaw(['--help'])
  return stdout
}

describe('win2mac 帮助与分发一致性', () => {
  test('help 提到的每个长选项都被解析器接受', async () => {
    const help = await getHelp()
    const source = await readFile(BIN, 'utf8')

    const claimed = new Set()
    for (const m of help.matchAll(/--([a-z][a-z0-9-]*)/g)) claimed.add(m[1])

    const start = source.indexOf('options: {')
    const end = source.indexOf('\n      },', start)
    const block = source.slice(start, end === -1 ? start + 4000 : end)
    const accepted = new Set()
    for (const m of block.matchAll(/^\s+'?([a-zA-Z][a-zA-Z0-9-]*)'?:/gm)) accepted.add(m[1])
    // --version 在 parseArgs 之前手工拦，--help 是 h 别名
    accepted.add('help')
    accepted.add('version')

    const bogus = [...claimed].filter((o) => !accepted.has(o)).sort()
    assert.deepEqual(bogus, [],
      `help 里写了但解析器不认：${bogus.join(', ')}`)
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
      `解析器支持但 help 没写（用户不知道存在）：${silent.join(', ')}`)
  })

  test('拼错的子命令明确报「未知子命令」', async () => {
    /*
     * 早先的实现把任何第一个位置参数都当项目路径，于是
     * `win2mac biuld ./proj` 报的是「项目目录不存在：…/biuld」，
     * 把人引去查路径、查权限，而真正的原因是 build 拼错了。
     */
    const { code, stdout, stderr } = await execRaw(['biuld', './proj'])
    const combined = `${stdout}${stderr}`
    assert.equal(code, 2, `未知子命令应以退出码 2 结束，实际 ${code}`)
    assert.match(combined, /未知子命令/u, `没有报「未知子命令」：${combined.slice(0, 200)}`)
    assert.match(combined, /build/u, '没有给出可用命令清单')
    assert.ok(!/项目目录不存在/u.test(combined),
      '仍被当成路径处理了 —— 会把人引向错误方向')
  })

  test('以路径形态给出的参数仍按路径处理', async () => {
    /*
     * 便捷用法 `win2mac ./myapp` 不能因为上面的检查而失效。
     * 含分隔符或以 `.` 开头的参数一律当路径。
     */
    const { stdout, stderr } = await execRaw(['./nonexist'])
    const combined = `${stdout}${stderr}`
    assert.ok(!/未知子命令/u.test(combined),
      '路径形态的参数被误判成未知子命令')
    assert.match(combined, /项目目录不存在|不存在/u,
      `应按路径处理并报不存在，实际：${combined.slice(0, 200)}`)
  })

  test('无参数时打印帮助且退出码为 0', async () => {
    const { code, stdout } = await execRaw([])
    assert.equal(code, 0)
    assert.match(stdout, /win2mac/u)
    assert.match(stdout, /用法/u)
  })
})
