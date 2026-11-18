/**
 * 目标架构的测试。
 *
 * 这里防的是一个曾经真实存在的缺陷：`--target x64` 时
 * 运行时下载写死 win-x86，于是产出标称 64 位、实际 32 位的包，
 * 而校验器写死要求 i386，反而盖章通过。
 *
 * 覆盖三件事：
 * 1. 运行时缓存目录按架构分开（否则两个架构互相覆盖）；
 * 2. 平台标识命名正确（Node 用 win-x86，不是 Electron 的 win32-ia32）；
 * 3. 校验器能识别「载荷架构与目标不符」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { runtimeCacheDir } from '../src/core/runtime.mjs'
import { verifyArtifact } from '../src/verify/artifact.mjs'
import { x86Exe, x64Exe, x64Zip } from './fixtures.mjs'

test('运行时缓存目录按架构分开', () => {
  const x86 = runtimeCacheDir('22.23.5', 'x86')
  const x64 = runtimeCacheDir('22.23.5', 'x64')
  assert.notEqual(x86, x64, '两个架构不能共用目录，否则互相覆盖')
  assert.ok(x86.includes('win-x86'), `x86 目录名应含 win-x86，实际 ${x86}`)
  assert.ok(x64.includes('win-x64'), `x64 目录名应含 win-x64，实际 ${x64}`)
})

test('平台标识用 Node 的命名而不是 Electron 的', () => {
  // Node 官方叫 win-x86 / win-x64；Electron 叫 win32-ia32 / win32-x64。
  // 混用会导致下载 404。
  assert.ok(runtimeCacheDir('22.23.5', 'x86').includes('win-x86'))
  assert.ok(!runtimeCacheDir('22.23.5', 'x86').includes('win32-ia32'))
})

test('未知架构明确报错', () => {
  assert.throws(() => runtimeCacheDir('22.23.5', 'arm64'), /没有.*构建/)
})

test('缓存根在用户主目录下', () => {
  const dir = runtimeCacheDir('22.23.5', 'x86')
  assert.ok(dir.startsWith(homedir()), `缓存应在主目录下，实际 ${dir}`)
})

/**
 * ## 样本从哪来
 *
 * 下面几条要面对真实产物：32 位包按 64 位校验会不会被拒、NSIS 外壳是不是
 * 固定 32 位、zip 会不会走错 PE 路径。这些都无法用 mock 替代。
 *
 * 原先指向 `/tmp/x86v2/` 与 `/tmp/uibuild/` 里的手工残留，在干净的 CI
 * 环境上静默跳过。现在由 `./fixtures.mjs` 现场构建，构建失败抛错。
 */

test('校验器能识别载荷架构与目标不符', async () => {
  const artifact = await x86Exe()

  // 拿 32 位产物按 x64 目标校验，必须被拒。
  const report = await verifyArtifact({ artifact, expectTarget: 'x64' })
  assert.equal(report.ok, false, '32 位产物不该通过 x64 校验')
  assert.ok(
    report.items.some((item) => item.id === 'payload-node-arch' && item.status === 'fail'),
    '失败项应指向载荷内 node.exe 架构',
  )
})

test('同一产物按 x86 目标校验通过', async () => {
  const artifact = await x86Exe()

  const report = await verifyArtifact({ artifact, expectTarget: 'x86' })
  assert.equal(report.ok, true, `x86 产物按 x86 校验应通过：${report.failures.map((f) => f.detail).join('; ')}`)
})

test('安装器外壳始终是 32 位（NSIS 固定形态）', async () => {
  const artifact = await x86Exe()

  const report = await verifyArtifact({ artifact, expectTarget: 'x86' })
  const shell = report.items.find((item) => item.id === 'pe-format')
  assert.ok(shell !== undefined, '应该有外壳格式检查项')
  assert.equal(shell.status, 'pass')
  assert.match(shell.detail, /PE32/)
})

/**
 * 以下覆盖 `verify` 子命令的两个真实缺陷：
 *
 * 1. 独立校验不传 expectTarget，x64 产物被误判失败；
 * 2. zip 产物走 exe 的 PE 校验路径，报「不是 MZ 开头（实际 504b）」。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const run = promisify(execFile)
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mac2win.mjs')

/** 跑一次 CLI，返回 { code, stdout }。 */
async function cli(args) {
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args], { maxBuffer: 16 * 1024 * 1024 })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.code ?? 1, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('verify 自动推断 x64 产物，不再误判', async () => {
  const exe = await x64Exe()

  const result = await cli(['verify', exe])
  assert.match(result.stdout, /推断目标架构：x64/)
  assert.equal(result.code, 0, `x64 产物该校验通过，实际：${result.stdout.slice(-400)}`)
})

test('verify 能校验 zip 产物（不走 PE 路径）', async () => {
  const zip = await x64Zip()

  const result = await cli(['verify', zip])
  // 曾经的报错是「不是 MZ 开头（实际 504b）」——504b 是 PK 的十六进制。
  assert.doesNotMatch(result.stdout, /不是 MZ 开头/, 'zip 不该走 PE 校验路径')
  assert.match(result.stdout, /压缩包格式/)
  assert.equal(result.code, 0, `zip 产物该校验通过，实际：${result.stdout.slice(-400)}`)
})

test('--also-zip 出双产物', async () => {
  /*
   * 这个测试原本直接拿 `/tmp/t1` 当项目目录，且不做任何存在性检查。
   *
   * 它在开发机上碰巧一直通过 —— 因为 `/tmp/t1` 是之前手工实验留下的
   * 目录，一直躺在那里。CI 的 runner 是干净环境，于是必然报
   * 「项目目录不存在：/tmp/t1」，还带着 `2 !== 0` 这种让人以为是构建
   * 逻辑坏了的断言失败。
   *
   * 修法是自己造项目，并且用完就删。测试不该依赖宿主机上恰好存在的
   * 残留目录 —— 那种依赖不写在任何地方，只有换机器时才会暴露。
   */
  const root = await mkdtemp(join(tmpdir(), 'm2w-alsozip-'))
  try {
    const project = join(root, 'proj')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'index.html'), '<!doctype html><title>t</title>')
    await writeFile(join(project, 'package.json'), JSON.stringify({
      name: 'alsozip-demo',
      version: '1.0.0',
      main: 'index.html',
    }))

    const out = join(root, 'out')
    const result = await cli(['build', project, '--also-zip', '--out', out])
    assert.equal(result.code, 0, `构建该成功：${result.stdout.slice(-600)}`)
    assert.match(result.stdout, /安装包 .*\.exe/)
    assert.match(result.stdout, /压缩包 .*\.zip/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
