/**
 * 帮助文本与子命令分发的一致性。
 *
 * ## 这一组守的核心一条
 *
 * 未知子命令必须**报错**，不能静默打印一份帮助再退出码 0。
 *
 * 早先 apponwin 就是这样：`apponwin asseess ./Foo.app` 会打印一大段帮助
 * 然后以 0 退出。脚本里 `apponwin assess "$APP" || exit 1` 这种写法完全
 * 失效 —— 拼错命令也算成功。这类缺陷不会崩、不会报错，只会让自动化
 * 静默跑空，是最难发现的一种。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(ROOT, 'bin', 'apponwin.mjs')

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

describe('apponwin 帮助与分发一致性', () => {
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

  test('拼错的子命令必须报错并给出退出码 2', async () => {
    /*
     * 这是本组的核心。退出码 0 + 打印帮助是最坏的处理方式：
     * 人看着像正常，脚本里 `|| exit 1` 也拦不住。
     */
    const { code, stdout, stderr } = await execRaw(['asseess', './Foo.app'])
    const combined = `${stdout}${stderr}`
    assert.equal(code, 2, `未知子命令应以退出码 2 结束，实际 ${code}`)
    assert.match(combined, /未知子命令/u, `没有报「未知子命令」：${combined.slice(0, 200)}`)
    assert.match(combined, /assess/u, '没有给出可用命令清单')
  })

  test('四个子命令都被识别', async () => {
    /*
     * 逐个跑一次，只验证「命令本身被识别」——
     * 参数缺失导致的退出码是正常的，不作为失败依据。
     */
    for (const command of ['assess', 'parse', 'spike', 'doctor']) {
      const { stdout, stderr } = await execRaw([command])
      const combined = `${stdout}${stderr}`
      assert.ok(!/未知子命令/u.test(combined),
        `\`apponwin ${command}\` 被当成未知命令：${combined.slice(0, 200)}`)
    }
  })

  test('无参数时打印帮助且退出码为 0', async () => {
    const { code, stdout } = await execRaw([])
    assert.equal(code, 0)
    assert.match(stdout, /apponwin/u)
    assert.match(stdout, /用法/u)
  })

  test('help 的用法段列全了四个子命令', async () => {
    const help = await getHelp()
    for (const command of ['assess', 'parse', 'spike', 'doctor']) {
      const pattern = new RegExp(`apponwin ${command}(?![a-z-])`)
      assert.ok(pattern.test(help),
        `help 的用法段里没有 \`apponwin ${command}\``)
    }
  })
})
