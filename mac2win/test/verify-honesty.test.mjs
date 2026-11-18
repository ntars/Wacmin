/**
 * 校验的诚实性测试。
 *
 * 这里防的是一个**比崩溃更危险**的缺陷：校验器说谎。
 *
 * ## 缺陷原貌
 *
 * 早期实现里，找不到 7-Zip 时走这条分支：
 *
 * ```js
 * report.add(new VerifyItem('payload', '载荷完整性', 'warn', '找不到 7-Zip，跳过解包校验'))
 * return report
 * ```
 *
 * 因为 `report.ok` 只看有没有 `fail`，所以这条路径下 `ok === true`，
 * CLI 打印「✓ 校验通过」、退出码 0。
 *
 * 而实际上：载荷里装了什么、node.exe 是 32 位还是 64 位、必需文件在不在、
 * 4000 多个文件的哈希对不对——**一项都没验**。
 *
 * 用户拿到的结论是「✓ 校验通过」，于是他放心分发。这比「校验失败」
 * 危险得多：失败会让人去查，假的通过不会。
 *
 * ## 修法的核心
 *
 * 把「验了不合格」与「压根没验」分成两个维度：
 *
 * - `report.ok`       —— 有没有查出问题
 * - `report.complete` —— 是不是全验了
 *
 * 两者组合成三态，任何一种都不能被说成「通过」以外的意思。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VerifyItem, VerifyReport } from '../src/verify/artifact.mjs'
import { x64Exe, x86Exe, fake7zip } from './fixtures.mjs'

const run = promisify(execFile)
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mac2win.mjs')

/*
 * ## 样本从哪来
 *
 * 这一组断言必须面对**真实的安装包字节**：缺工具时校验器会不会谎报通过、
 * 架构不符能不能识别、哈希比对有没有真的做。用 mock 替代就等于不测。
 *
 * 原先指向 `/tmp/uibuild/demo-1.2.3-x64-setup.exe` —— 开发机上一次手工实验
 * 的残留。CI 的 runner 是干净环境，于是这里 5 条断言连同下面几条一起静默
 * 跳过，而跳过在测试报告里是绿色的：CI 上「校验器永不说谎」这个守卫实际
 * 上没在站岗，没有人会发现。
 *
 * 现在由 `./fixtures.mjs` 现场构建，构建失败抛错而不是跳过。
 */

/**
 * 跑 CLI，带回退出码与两个流。
 *
 * ## 为什么不合并 stdout / stderr
 *
 * `--json` 模式下日志走 stderr、JSON 走 stdout（否则管道里的 JSON
 * 就被日志污染了）。合并两者会让 `JSON.parse` 在 JSON 尾部撞上日志
 * 文本——这不是 CLI 的问题，而是测试自己没尊重「两个流语义不同」。
 *
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function cli(args, env) {
  const merged = { ...process.env, ...env }
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      maxBuffer: 16 * 1024 * 1024,
      env: merged,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }
  }
}

test('未验证项不影响 ok，但会让 complete 为假', () => {
  const report = new VerifyReport('x.exe')
  report.add(new VerifyItem('pe', 'PE 格式', 'pass', 'ok'))
  report.add(new VerifyItem('payload', '载荷完整性', 'warn', '没解开', true))

  assert.equal(report.ok, true, '没有 fail 项，ok 该是 true')
  assert.equal(report.complete, false, '有未验证项，complete 必须是 false')
  assert.equal(report.unverified.length, 1)
  assert.equal(report.unverified[0].id, 'payload')
})

test('全部验过时 complete 为真', () => {
  const report = new VerifyReport('x.exe')
  report.add(new VerifyItem('pe', 'PE 格式', 'pass', 'ok'))
  report.add(new VerifyItem('payload', '载荷完整性', 'pass', '8 个文件'))

  assert.equal(report.ok, true)
  assert.equal(report.complete, true)
  assert.deepEqual(report.unverified, [])
})

test('有 fail 项时 ok 为假，complete 不影响这个判断', () => {
  const report = new VerifyReport('x.exe')
  report.add(new VerifyItem('pe', 'PE 格式', 'fail', '不是 PE'))
  report.add(new VerifyItem('payload', '载荷完整性', 'warn', '没解开', true))

  assert.equal(report.ok, false)
  assert.equal(report.complete, false)
})

test('VerifyItem 默认不是「未验证」', () => {
  // 老代码构造的四参数形式必须继续工作，否则所有既有调用点都会
  // 被误判成「未验证」，反而让 complete 永远为假。
  const item = new VerifyItem('pe', 'PE 格式', 'pass', 'ok')
  assert.equal(item.skipped, false)
})

test('缺 7-Zip 时 CLI 退出码是 5，不是 0', async () => {
  const exe = await x64Exe()

  /*
   * 这是本次修复的核心断言。
   *
   * 修复前这里会是 `code: 0` + 输出含「校验通过」——一份撒了谎的报告。
   */
  const result = await cli(['verify', exe], { MAC2WIN_NO_7ZIP: '1' })
  const text = result.stdout + result.stderr
  assert.equal(result.code, 5, `缺工具该是退出码 5（缺依赖），实际 ${String(result.code)}`)
  assert.doesNotMatch(text, /校验通过/, '没验全就不能说「校验通过」')
  assert.match(text, /校验未完成/, '必须明说未完成')
})

test('缺 7-Zip 时逐项列出没验什么', async () => {
  const exe = await x64Exe()

  const result = await cli(['verify', exe], { MAC2WIN_NO_7ZIP: '1' })
  const text = result.stdout + result.stderr
  /*
   * 只说「未完成」不够——用户会以为是环境的小毛病。
   * 必须点出「哪几项没验」，他才知道这个结论到底值多少。
   */
  assert.match(text, /载荷完整性/, '要说明载荷没验')
  assert.match(text, /载荷内 node\.exe 架构/, '要说明架构没验')
  assert.match(text, /文件哈希比对/, '要说明哈希没验')
  assert.match(text, /brew install sevenzip/, '要给可执行的补救命令')
})

test('缺 7-Zip 时架构项不能亮绿', async () => {
  const exe = await x64Exe()

  const result = await cli(['verify', exe, '--json'], { MAC2WIN_NO_7ZIP: '1' })
  const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')))
  const arch = parsed.items.find((item) => item.id === 'pe-arch')
  assert.ok(arch !== undefined, '应该有架构项')
  assert.notEqual(arch.status, 'pass', '没能解包时架构项不许是 pass')
  assert.equal(parsed.complete, false, 'json 里也要带 complete')
  assert.ok(parsed.unverified.length > 0, 'json 里要列出未验证项')
})

test('有 7-Zip 时校验完整且通过', async () => {
  const exe = await x64Exe()

  const result = await cli(['verify', exe])
  const text = result.stdout + result.stderr
  /*
   * 这条是上面几条的对照：不是「一律报未完成」，而是真的有工具时
   * 必须走完整校验并给出通过。否则「修成永远不说通过」也能骗过测试。
   */
  assert.equal(result.code, 0, `有工具时该校验通过，实际：${text.slice(-400)}`)
  assert.match(text, /校验通过/)
  assert.doesNotMatch(text, /校验未完成/)
})

test('架构不符时退出码是 7，与缺工具区分开', async () => {
  const exe = await x86Exe()

  /*
   * 5 与 7 必须是两条路：
   * - 5 = 我没验（装工具重跑）
   * - 7 = 验了，产物是坏的（重打包）
   *
   * 混成一个码，用户会照着错误的方向排查。
   */
  const result = await cli(['verify', exe, '--target', 'x64'])
  assert.equal(result.code, 7, `产物不合格该是退出码 7，实际 ${String(result.code)}`)
  assert.match(result.stdout + result.stderr, /校验未通过/)
})

/**
 * ## 7-Zip 的发现能力
 *
 * 这是同一轮发现的第二个缺陷：`find7zip()` 只查固定的几个绝对路径，
 * 加一个 PATH 查询。实测在一台机器上全部落空——PATH 里那个 `7zz`
 * 是构建沙箱的包装脚本（跑起来报 `spawnSync 7zz ENOENT`），
 * Homebrew 也没装 sevenzip。
 *
 * 但同一台机器上 BlueStacks 和 Parallels 各自带了一份**能用的**
 * 7-Zip，就躺在 `/Applications/*.app/Contents/MacOS/` 里。
 *
 * 「没装」和「装了你找不到」是两件事：前者要用户动手，后者是工具失职。
 */

test('MAC2WIN_7ZIP 指定的路径优先且能用', async () => {
  /*
   * ## 为什么用假二进制而不是本机那份
   *
   * 这条测的是「设了就优先用，不悄悄回落到系统里另一份」。原先的做法
   * 是先 `find7zip()` 找一个真的，找不到就跳过 —— 于是干净的机器与
   * CI runner 上全年跳过。跳过的偏偏就是这条测试存在的理由。
   *
   * `probeCandidates()` 判定一个候选「可用」的标准只有三条：是文件、
   * 能执行 `i`、输出含 `7-Zip` 与 `Formats:`。这与「是不是真 7-Zip」
   * 无关，它判定的是「这个候选会被 verify 选中」。而这里要验的正是
   * 「选中的是不是显式指定的那个」，解包能力由真实产物测试覆盖。
   */
  const { find7zip } = await import('../src/verify/artifact.mjs')
  const fake = await fake7zip()

  const previous = process.env.MAC2WIN_7ZIP
  process.env.MAC2WIN_7ZIP = fake
  try {
    assert.equal(await find7zip(), fake, '显式指定的路径该原样返回')
  } finally {
    if (previous === undefined) delete process.env.MAC2WIN_7ZIP
    else process.env.MAC2WIN_7ZIP = previous
  }
})

test('显式指定优先于系统里那份', async () => {
  /*
   * 上一条只证明「能返回自己」，还不足以证明「优先」——如果
   * find7zip 先查系统路径、最后才看环境变量，上一条照样通过。
   *
   * 这条把系统里那份也找出来做对照：两者不同，必须返回显式指定的
   * 那个。找不到系统那份时（干净的 CI）就跳过对照，只断言显式优先
   * 这一半 —— 不跳过整条。
   */
  const { find7zip } = await import('../src/verify/artifact.mjs')
  const fake = await fake7zip()

  const previous = process.env.MAC2WIN_7ZIP
  delete process.env.MAC2WIN_7ZIP
  let systemOne = null
  try {
    systemOne = await find7zip()
  } finally {
    if (previous !== undefined) process.env.MAC2WIN_7ZIP = previous
  }

  process.env.MAC2WIN_7ZIP = fake
  try {
    assert.equal(await find7zip(), fake, '显式指定的路径必须优先')
  } finally {
    if (previous === undefined) delete process.env.MAC2WIN_7ZIP
    else process.env.MAC2WIN_7ZIP = previous
  }

  if (systemOne !== null && systemOne !== fake) {
    // 对照成立：两份都在，结果必须是显式那份
    assert.notEqual(systemOne, fake, '前提：系统那份与假二进制不是同一个文件')
  }
})

test('MAC2WIN_7ZIP 指向非 7-Zip 时明确报错', async () => {
  const { find7zip } = await import('../src/verify/artifact.mjs')

  const previous = process.env.MAC2WIN_7ZIP
  /*
   * 指向 `/bin/echo`：文件存在、可执行、对 `i` 也返回 0，但输出里
   * 没有 7-Zip 的格式列表。
   *
   * ## 行为变更说明
   *
   * 早先这条断言的是「不要选中 echo，继续往下找，最后用上别的 7-Zip」。
   * 但「静默回退」本身是个缺陷：用户明确设了变量，程序却用了另一个
   * 二进制，他会在「换了版本怎么没变化」上白耗时间。
   *
   * 现在的语义是「要么用它，要么明确失败」。所以这里断言 rejects，
   * 并且错误信息要同时说清「哪个路径」和「为什么不行」。
   */
  process.env.MAC2WIN_7ZIP = '/bin/echo'
  try {
    await assert.rejects(
      () => find7zip(),
      (error) => {
        assert.match(error.message, /\/bin\/echo/u, '要指出是哪个路径')
        assert.match(error.message, /不是可用的 7-Zip/u, '要说明为什么不行')
        return true
      },
    )
  } finally {
    if (previous === undefined) delete process.env.MAC2WIN_7ZIP
    else process.env.MAC2WIN_7ZIP = previous
  }
})

test('MAC2WIN_NO_7ZIP=1 时明确返回找不到', async () => {
  const { find7zip } = await import('../src/verify/artifact.mjs')

  const previous = process.env.MAC2WIN_NO_7ZIP
  process.env.MAC2WIN_NO_7ZIP = '1'
  try {
    assert.equal(await find7zip(), null, '这个开关必须能强制走「没有 7-Zip」分支')
  } finally {
    if (previous === undefined) delete process.env.MAC2WIN_NO_7ZIP
    else process.env.MAC2WIN_NO_7ZIP = previous
  }
})

/**
 * ## doctor 与 verify 必须用同一个判据
 *
 * 这是同轮发现的第三处问题，也是最容易被用户撞上的一处：**doctor 是
 * 排查的第一步**，它说什么，用户就信什么。
 *
 * 原来的实现里两处判据不同：
 *
 * - `doctor`   → `probe('7z', ['i'])`：只看 PATH
 * - `verify`   → `find7zip()`：查环境变量、项目目录、Homebrew、
 *                MacPorts、PATH，最后还扫 `/Applications/*.app`
 *
 * 于是出现自相矛盾：doctor 报「[FAIL] 7z 未安装」，而同一时刻 verify
 * 正用 BlueStacks 里那份 7-Zip 成功解包。更糟的是 doctor 的 FAIL 让
 * `allOk = false`、退出码 5，一个完全能用的环境被判定为不可用。
 */

test('doctor 不再把可用的 7-Zip 报成未安装', async () => {
  /*
   * ## 用 MAC2WIN_7ZIP 把「可用的 7-Zip」这件事确定下来
   *
   * 原先靠 `find7zip()` 在本机碰运气，找不到就跳过 —— 而干净机器与
   * CI runner 上必然找不到，于是这条测试常年绿着但从不执行。
   *
   * 这里直接指定一个假 7z（能满足 probeCandidates 的三条判据）。
   * doctor 与 verify 共用 find7zip()，所以只要两边判据一致，
   * doctor 就必须认它。这恰好是这条测试要守的东西。
   */
  const fake = await fake7zip()

  const result = await cli(['doctor', '--json'], { MAC2WIN_7ZIP: fake })
  const parsed = JSON.parse(result.stdout)
  const check = (parsed.checks ?? []).find((item) => item.name === '7z')

  /*
   * 这条断言同时守三件事：
   * 1. doctor 与 verify 用同一个判据（不能一个说没装、一个在用）；
   * 2. doctor 的 --json 必须含逐项结果——否则用 CI 的人拿不到
   *    「哪一项不合格」，只能再去 grep 文本输出；
   * 3. 字段名必须是契约里的 `passed`（不是内部的 `ok`），且
   *    `additionalProperties: false` 意味着不能两个都留。
   */
  assert.ok(check !== undefined, 'doctor --json 必须含 checks，且要有 7z 项')
  assert.equal(check.passed, true, `MAC2WIN_7ZIP 指向可用文件，doctor 不该说 7z 未安装`)
  assert.equal(check.severity, 'required', '缺 7-Zip 是硬性问题，不是建议项')
})

test('doctor 报出的 7-Zip 路径就是 verify 会用的那个', async () => {
  const fake = await fake7zip()

  const result = await cli(['doctor'], { MAC2WIN_7ZIP: fake })
  const text = result.stdout + result.stderr
  /*
   * 不只要求「不报错」，还要求报出**同一条路径**。
   * 只说 OK 但指向另一个二进制，等于把矛盾藏起来了。
   */
  assert.ok(text.includes(fake), `doctor 该报出 ${fake}，实际：${text.slice(-300)}`)
})

/**
 * ## 显式指定的工具路径不能静默跳过
 *
 * `MAC2WIN_7ZIP` 是用户明确表达「用这个」的方式。原来它指向的文件
 * 不存在时，`find7zip()` 会**默默继续往下找**，最后用上系统里另一份。
 *
 * 后果是排查方向彻底跑偏：`doctor` 报的是另一份的路径，用户还以为
 * 生效的是自己设的那个，于是反复怀疑版本、怀疑缓存，就是想不到
 * 「你设的那个压根没被用上」。
 */

test('MAC2WIN_7ZIP 指向不存在的路径时明确报错', async () => {
  const { find7zip } = await import('../src/verify/artifact.mjs')

  const previous = process.env.MAC2WIN_7ZIP
  process.env.MAC2WIN_7ZIP = '/nonexistent/wrong-path/7zz'
  try {
    await assert.rejects(
      () => find7zip(),
      /不存在/u,
      '设了却不存在，必须抛错而不是静默回退',
    )
  } finally {
    if (previous === undefined) delete process.env.MAC2WIN_7ZIP
    else process.env.MAC2WIN_7ZIP = previous
  }
})

test('MAC2WIN_7ZIP 配错时 doctor 给配置错误码而非内部错误', async () => {
  const result = await cli(['doctor'], { MAC2WIN_7ZIP: '/nonexistent/wrong-path/7zz' })
  const text = result.stdout + result.stderr
  /*
   * 退出码 2（参数与输入）才对：用户改一个环境变量就能解决。
   * 早期这里是 `M2W_9999`（内部错误）+ 退出码 1，把人引向「程序有 bug」。
   */
  assert.equal(result.code, 2, `配置错误该是退出码 2，实际 ${String(result.code)}`)
  assert.match(text, /M2W_1003/, '该报配置错误码')
  assert.doesNotMatch(text, /M2W_9999/, '这不是内部错误')
  assert.match(text, /MAC2WIN_7ZIP/, '要说清是哪个变量的问题')
})

test('MAC2WIN_7ZIP 配错时 verify 也不会误报「无法推断架构」', async () => {
  const exe = await x64Exe()

  const result = await cli(['verify', exe], { MAC2WIN_7ZIP: '/nonexistent/wrong-path/7zz' })
  const text = result.stdout + result.stderr
  /*
   * 原来这里会先打一行「无法推断目标架构，按 x86 校验」——因为它把
   * 配置错误吞成了「解包失败」，然后继续按默认架构往下验，最后报
   * 一个完全无关的结论。这条断言守的就是「别继续」。
   */
  assert.equal(result.code, 2, `配置错误该是退出码 2，实际 ${String(result.code)}`)
  assert.doesNotMatch(text, /无法推断目标架构/, '配置错误不该被降级成「推断失败」')
  assert.match(text, /MAC2WIN_7ZIP/, '要指向真正的原因')
})
