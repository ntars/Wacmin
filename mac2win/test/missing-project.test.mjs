/**
 * 入口的「不存在的项目目录」行为测试。
 *
 * ## 这一组守的是什么
 *
 * 与 `logfile.test.mjs` 守的是同一个缺陷的两端：那边测 `Logger` 的
 * 契约，这边测 **从命令行敲进去之后真的发生了什么**。
 *
 * 修复前的实测表现（记在这里，防止将来被改回去）：
 *
 * ```
 * $ mac2win build /tmp/nonexist-xyz
 * ✗ [M2W_1003] 配置有 1 处问题
 *   · 既没有 entry 也没有 frontendDist，没有可打包的内容
 * ```
 *
 * 三处都错：
 *   1. 错误码错 —— 该报 M2W_1002（项目目录不存在），报成了配置非法
 *   2. 原因错 —— 用户的真实问题是路径写错，与 entry 配置无关
 *   3. 有副作用 —— /tmp/nonexist-xyz 被凭空创建出来，里面对着一份日志
 *
 * 根因是日志器在构造时就 `mkdirSync` 了 `dirname(logPath)`，
 * 而 logPath 正是 `<projectRoot>/.mac2win-build.log`。
 *
 * ## 为什么必须用子进程测
 *
 * 这三条（退出码、文案、磁盘副作用）都是**进程外可观测**的行为，
 * 在同一个进程里测会绕开真实的入口顺序。`report.test.mjs` 用同样
 * 的方式测过「缺参数也吐报告」，理由一致。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir as mkdirp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = join(HERE, '..', 'bin', 'mac2win.mjs')

/** 跑一次 CLI，返回 `{ status, stdout, stderr }`。 */
function runCli(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  })
}

describe('项目目录不存在', () => {
  test('回报 M2W_1002 而不是 M2W_1003', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mac2win-missing-'))
    const missing = join(dir, 'does-not-exist')
    try {
      const result = runCli(['build', missing])

      assert.equal(result.status, 2, `退出码应为 2（参数与输入错误：路径写错），实际 ${result.status}`)
      // 不带 --json / --report 时，人类日志走 stdout（--report 才切到 stderr）
      assert.match(result.stdout, /M2W_1002/,
        '必须报「项目目录不存在」。报 M2W_1003 会让用户去查 entry 配置，方向完全错')
      assert.doesNotMatch(result.stdout, /既没有 entry 也没有 frontendDist/,
        '这句是配置阶段的结论，前提（目录存在）不成立时不能出现')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('不在磁盘上留下任何痕迹', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mac2win-missing-'))
    const missing = join(dir, 'does-not-exist')
    try {
      runCli(['build', missing])

      assert.equal(existsSync(missing), false,
        '构建不存在的目录不能把它创建出来 —— 这既是副作用，也会掩盖后续的错误判断')
      assert.equal(existsSync(join(missing, '.mac2win-build.log')), false,
        '日志文件不能落在不存在的项目里')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('--report 下也是 M2W_1002，且 stdout 只有 JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mac2win-missing-'))
    const missing = join(dir, 'does-not-exist')
    try {
      const result = runCli(['build', missing, '--report'])

      // stdout 必须是纯 JSON：人类可读日志要全部走 stderr
      const report = JSON.parse(result.stdout)
      assert.equal(report.direction, 'mac2win')
      assert.equal(report.ok, false)
      assert.equal(report.exitCode, 2)
      assert.equal(report.error.code, 'M2W_1002')
      assert.match(report.error.message, /项目目录不存在/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('真实目录仍能正常落盘日志（修复不能误伤正常路径）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mac2win-present-'))
    try {
      // 空项目：配置阶段就会失败，但目录是真实存在的，日志该落下来
      const result = runCli(['build', dir])

      assert.equal(result.status, 2, `空目录应报配置问题（退出码 2），实际 ${result.status}`)
      assert.equal(existsSync(join(dir, '.mac2win-build.log')), true,
        '目录存在时日志要正常落盘，这是排查问题的主要凭据')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('输入物落在硬边界内', () => {
  /* 硬边界指「这件事本身做不了」，与「路径写错」是两回事：
   * 前者换文件才有用，后者改路径就好。错误码必须分得开，
   * 否则自动化会把不可重试的失败当成可重试的。 */

  test('不支持的 --target 报 M2W_1005 且退出码 4', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mac2win-boundary-'))
    try {
      // 造一个最小可识别项目，让预检能走到目标架构那一步
      await mkdirp(join(dir, 'src'))
      await writeFile(join(dir, 'package.json'), JSON.stringify({
        name: 'demo', version: '1.0.0', main: 'src/index.js',
      }))
      await writeFile(join(dir, 'src', 'index.js'), 'console.log(1)\n')

      const result = runCli(['build', dir, '--target', 'arm64'])

      assert.equal(result.status, 4,
        `arm64 落在硬边界内，退出码应为 4，实际 ${result.status}`)
      assert.match(result.stdout, /M2W_1005/,
        '应报「明确不支持」。修复前这一步统统报 M2W_1002（项目目录不存在），'
        + '把用户引向查路径，而路径其实是对的')
      assert.doesNotMatch(result.stdout, /项目目录不存在/,
        '路径是好的，不能说它不存在')
      assert.match(result.stdout, /x86/,
        '要告诉用户可选什么，而不只是说他选的错了')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
