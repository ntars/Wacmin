/**
 * PE 解析器的单元测试。
 *
 * ## 为什么这些测试值得写
 *
 * PE 解析是整个校验链路的判据来源。它错一位，所有「架构正确」的
 * 结论都失去意义——而且错的方式很隐蔽：把 i386 读成 x86-64 不会
 * 报错，只会让产物被误判为通过。
 *
 * 测试用真实文件做基准：node.exe 的 win-x86 构建、NSIS 桩、
 * 以及 macOS 二进制（用来验证拒绝路径）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPeHeader, checkWindowsExe, MACHINE_NAMES, SUBSYSTEM_NAMES } from '../src/verify/pe.mjs'
import { consolePeX86 } from './fixtures.mjs'

/*
 * ## 样本从哪来
 *
 * 这三条测试要面对一个**控制台子系统**的 32 位 PE：要求 GUI 时必须被拒，
 * 并说清「会弹黑框」；不要求 GUI 时应当通过。方向相反的判定，模拟不出来。
 *
 * 原先指向 `~/.wacmin/mac2win/cache/node-22.23.5-win-x86/node.exe` ——
 * 那是「先跑一次打包」才会出现的下载缓存。干净机器与 CI runner 上没有，
 * 于是三项测试静默跳过，跳过的偏偏是「拒绝路径」的核心断言：校验器有
 * 没有真的挡住不该放行的产物。跳过是绿的，没人会发现守卫没在站岗。
 *
 * 现在由 `./fixtures.mjs` 现场拼字节构造，零网络、零外部状态。
 */
const NODE_X86 = await consolePeX86()

test('机器类型表覆盖常见架构', () => {
  assert.equal(MACHINE_NAMES[0x014c], 'i386')
  assert.equal(MACHINE_NAMES[0x8664], 'x86-64')
  assert.equal(MACHINE_NAMES[0xaa64], 'ARM64')
})

test('子系统表区分 GUI 与控制台', () => {
  assert.equal(SUBSYSTEM_NAMES[2], 'windows-gui')
  assert.equal(SUBSYSTEM_NAMES[3], 'windows-console')
})

test('拒绝非 PE 文件', async () => {
  // 用本文件自己当输入：一个 UTF-8 文本，开头不是 MZ。
  const result = await checkWindowsExe(new URL(import.meta.url).pathname, { gui: false })
  assert.equal(result.ok, false)
  assert.equal(result.header, null)
  assert.match(result.problems[0], /MZ|不是/)
})

test('拒绝不存在的文件', async () => {
  const result = await checkWindowsExe('/nonexistent/file.exe', { gui: false })
  assert.equal(result.ok, false)
})

test('正确解析 win-x86 node.exe', async () => {
  const header = await readPeHeader(NODE_X86)
  assert.equal(header.format, 'PE32', '32 位程序应该是 PE32')
  assert.equal(header.machine, 0x014c, '机器类型应该是 i386')
  assert.equal(header.machineName, 'i386')
  assert.equal(header.subsystem, 3, '样本应当是控制台程序')
  assert.equal(header.isX86, true)
  assert.equal(header.isExecutable, true)
  assert.equal(header.isGui, false)
  assert.ok(header.entryPoint > 0, '入口点不该是 0')
})

test('node.exe 不满足 GUI 要求时给出明确原因', async () => {
  const result = await checkWindowsExe(NODE_X86, { gui: true })
  assert.equal(result.ok, false)
  assert.ok(
    result.problems.some((problem) => problem.includes('windows-console')),
    `问题列表应该指出子系统不对，实际：${result.problems.join('; ')}`,
  )
})

test('不要求 GUI 时 node.exe 通过', async () => {
  const result = await checkWindowsExe(NODE_X86, { gui: false })
  assert.equal(result.ok, true, `不该有问题：${result.problems.join('; ')}`)
})