/**
 * console 的集成测试。
 *
 * console 的价值在于「跨方向统一」：四个方向输出同一种报告。
 * 因此这里测的不是 console 自己的逻辑，而是**各方向是否真的按契约输出**。
 * 某个方向偷偷改了字段名，这里就会红。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DIRECTIONS, runDirection, status } from '../bin/wacmin-console.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const prefixes = JSON.parse(readFileSync(join(REPO, 'contracts', 'error-prefixes.json'), 'utf8'))

test('四个方向全部注册', () => {
  assert.deepEqual(Object.keys(DIRECTIONS).sort(), ['apponwin', 'exeonmac', 'mac2win', 'win2mac'])
})

test('四个方向目录都存在', () => {
  for (const row of status()) {
    assert.equal(row.installed, true, `${row.id} 目录不存在`)
  }
})

test('exeonmac 报告符合契约', async () => {
  const { report } = await runDirection('exeonmac', 'version')
  assert.notEqual(report, null, 'exeonmac 未输出报告')
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.direction, 'exeonmac')
  assert.equal(report.ok, report.exitCode === 0)
  assert.ok(Array.isArray(report.stages))
})

test('mac2win 失败报告符合契约', async () => {
  const { report } = await runDirection('mac2win', 'verify')
  assert.notEqual(report, null, 'mac2win 未输出报告')
  assert.equal(report.direction, 'mac2win')
  assert.equal(report.ok, false)
  assert.equal(report.ok, report.exitCode === 0)
  assert.match(report.error.code, /^M2W_\d{4}$/)
})

test('win2mac 在非 Windows 上只警告不拒绝', async () => {
  /*
   * 行为变更：win2mac 的 doctor 不再把「非 Windows」当硬失败。
   *
   * 理由：打包是纯文件操作，任何平台都能做；真正只能在 Windows 上做的
   * 是构建 Windows 侧原生产物，而 win2mac 本来就不做那件事。拒绝会让
   * macOS 上的开发者无法自测。要严格模式用 --strict-host。
   */
  const { report } = await runDirection('win2mac', 'doctor')
  assert.notEqual(report, null, 'win2mac 未输出报告')
  assert.equal(report.direction, 'win2mac')
  assert.equal(report.exitCode, 0)
  assert.equal(report.ok, true)
})

test('apponwin 在非 Windows 上仍可做解析与评估', async () => {
  /*
   * 行为变更：apponwin 的 doctor 不再把「非 Windows」当硬失败。
   *
   * 理由：解析 .app 与评估框架依赖都是纯读操作，任何平台都能做 ——
   * 而这正是本方向当前真正交付的能力。需要 Windows 的是「真的跑起来」，
   * 那由 spike 子命令单独负责，并以 unverified / 退出码 5 表达。
   */
  const { report } = await runDirection('apponwin', 'doctor')
  assert.notEqual(report, null, 'apponwin 未输出报告')
  assert.equal(report.direction, 'apponwin')
  assert.equal(report.exitCode, 0)
  assert.equal(report.ok, true)
})

test('未知方向被拒绝', async () => {
  await assert.rejects(() => runDirection('nope', 'build'), /未知方向/)
})

test('每个方向的错误码前缀与契约一致', async () => {
  const cases = [
    ['mac2win', 'verify'],
    ['exeonmac', 'detect', ['/tmp/ghost-does-not-exist.exe']],
  ]
  for (const [id, command, extra] of cases) {
    const { report } = await runDirection(id, command, extra ?? [])
    assert.notEqual(report, null, `${id} 未输出报告`)
    if (report.ok) continue
    const expected = prefixes.prefixes[id]
    assert.ok(
      report.error.code.startsWith(`${expected}_`),
      `${id} 的错误码 ${report.error.code} 未使用前缀 ${expected}`,
    )
  }
})
/*
 * ── 成功路径的契约覆盖 ────────────────────────────────────────────────
 *
 * 上面那些测试只覆盖了 doctor 与「必然失败」的探测。这个组合有一个
 * 致命的盲区：**成功的构建路径从来没被检查过**。
 *
 * 真实缺陷就是这么漏掉的 —— win2mac 的 build 在 `--report` 模式下
 * 仍把人读日志写进 stdout，JSON 报告被冲成一堆无法解析的文本。契约
 * 检查跑的是 doctor（人读文本本来就走 stderr）和 verify 的失败分支
 * （走 catch），两条路径都恰好没问题，于是 bug 一直躲着。
 *
 * 结论：光验失败路径不够。成功路径同样要跑，而且必须真的造出一个
 * 能成功的输入，不能用「反正它会失败」来搪塞。
 */

/** 造一个最小可构建项目：一个 Mach-O 魔数开头的可执行文件 + 一点点载荷。 */
async function makeBuildableProject() {
  const { mkdtemp, mkdir, writeFile, chmod } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const root = await mkdtemp(join(tmpdir(), 'wacmin-contract-'))
  const project = join(root, 'proj')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'app.js'), 'code')
  const executable = join(project, 'MyApp')
  const buffer = Buffer.alloc(32)
  buffer.writeUInt32BE(0xcffaedfe, 0)   // Mach-O 64 位小端
  await writeFile(executable, buffer)
  await chmod(executable, 0o755)
  return { root, project }
}

test('win2mac 成功构建的报告可解析且字段完整', async () => {
  const { root, project } = await makeBuildableProject()
  const { rm } = await import('node:fs/promises')
  try {
    /*
     * 输出目录放在项目**外面**。
     *
     * 这不是为了绕开问题 —— 默认位置（项目内）也已经支持，但这条测试
     * 要验的是「报告结构」，让输出目录的位置不成为干扰变量。
     */
    const { report, exitCode } = await runDirection('win2mac', 'build', [
      project, '--executable', join(project, 'MyApp'), '--out', join(root, 'out'),
    ])
    assert.notEqual(report, null,
      `win2mac 成功构建没有输出可解析的报告（退出码 ${String(exitCode)}）—— ` +
      '通常是人类可读日志混进了 stdout')
    assert.equal(report.direction, 'win2mac')
    assert.equal(report.command, 'build')
    assert.equal(report.ok, true)
    assert.equal(report.exitCode, 0)
    assert.equal(report.exitCode, exitCode)
    assert.ok(Array.isArray(report.stages) && report.stages.length > 0)
    assert.equal(report.artifacts.length, 1, '成功构建必须报告一个产物')
    assert.equal(typeof report.artifacts[0].path, 'string')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('apponwin assess 成功路径的报告可解析', async () => {
  const { root, project } = await makeBuildableProject()
  const { rm, mkdir, writeFile, readFile, chmod } = await import('node:fs/promises')
  try {
    // 造一个最小 .app：Info.plist + MacOS 下的可执行文件
    const app = join(root, 'Demo.app')
    await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true })
    await writeFile(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Demo</string>
<key>CFBundleExecutable</key><string>Demo</string>
<key>CFBundleIdentifier</key><string>com.example.demo</string>
</dict></plist>
`)
    await writeFile(join(app, 'Contents', 'MacOS', 'Demo'),
      await readFile(join(project, 'MyApp')))
    await chmod(join(app, 'Contents', 'MacOS', 'Demo'), 0o755)

    const { report, exitCode } = await runDirection('apponwin', 'assess', [app])
    assert.notEqual(report, null,
      `apponwin assess 没有输出可解析的报告（退出码 ${String(exitCode)}）`)
    assert.equal(report.direction, 'apponwin')
    assert.equal(report.command, 'assess')
    assert.equal(report.exitCode, exitCode)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
