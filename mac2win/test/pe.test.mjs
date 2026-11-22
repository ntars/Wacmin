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
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readPeHeader,
  checkWindowsExe,
  PeError,
  PeTruncatedError,
  MACHINE_NAMES,
  SUBSYSTEM_NAMES,
} from '../src/verify/pe.mjs'
import { consolePeX86, guiPeX86Bytes } from './fixtures.mjs'

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

/*
 * ## 截断样本：为什么每条都要断言文案，而不只是 `ok === false`
 *
 * `ok === false` 这一位对「不是 PE」与「被截断」完全一样。而两者的处置
 * 相反：前者是「文件不对，别试了」；后者是「文件对，但没下完，重下」。
 * 只判 `ok` 的守卫，在两句话互换之后依旧全绿 —— 这正是 Python 侧
 * `test_reject_truncated` 一直绿着的那类假守卫。
 *
 * 所以这里同时断言：① `truncated` 标记；② 文案里出现了具体字节数或
 * 「截断」这类只在被截断时才成立的词。
 */

/** 把字节写到临时文件。 */
async function writeSample(bytes) {
  const dir = await mkdtemp(join(tmpdir(), 'pe-trunc-'))
  const file = join(dir, 'sample.exe')
  await writeFile(file, bytes)
  return file
}

test('完整样本的 declaredSize 恰好等于 fileSize', async () => {
  const file = await writeSample(await guiPeX86Bytes())
  const header = await readPeHeader(file)
  assert.equal(header.declaredSize, header.fileSize,
    '节区表声明的长度必须等于真实长度，否则截断判据会误报')
})

test('截断到 DOS 头之前：报「过短」而不是「不是 PE」', async () => {
  const full = await guiPeX86Bytes()
  // 开头确实是 MZ，但不足 64 字节
  const file = await writeSample(full.subarray(0, 32))
  await assert.rejects(readPeHeader(file), (error) => {
    assert.ok(error instanceof PeError)
    assert.ok(!(error instanceof PeTruncatedError), '连 DOS 头都不够，属于格式判不了')
    assert.match(error.message, /过短/)
    assert.match(error.message, /32 字节/)
    return true
  })
})

test('截断到 COFF 头之前：抛 PeTruncatedError 并给出所需/实际字节', async () => {
  const full = await guiPeX86Bytes()
  // e_lfanew = 0x80 = 128，读签名 + COFF 需要 128 + 24 = 152
  const file = await writeSample(full.subarray(0, 100))
  await assert.rejects(readPeHeader(file), (error) => {
    assert.ok(error instanceof PeTruncatedError, `应抛 PeTruncatedError，实际 ${error.name}`)
    assert.ok(error instanceof PeError, 'PeTruncatedError 必须仍是 PeError 的子类')
    assert.match(error.message, /152/)
    assert.match(error.message, /100 字节/)
    return true
  })
})

test('截断到可选头子系统字段之前：指出缺的是可选头', async () => {
  const full = await guiPeX86Bytes()
  // 可选头 = 128 + 24 = 152，读子系统需要到 152 + 70 = 222
  const file = await writeSample(full.subarray(0, 180))
  await assert.rejects(readPeHeader(file), (error) => {
    assert.ok(error instanceof PeTruncatedError)
    assert.match(error.message, /可选头/)
    assert.match(error.message, /222/)
    return true
  })
})

test('截断到节区表之后、像素数据之前：按节区表声明长度判', async () => {
  const full = await guiPeX86Bytes()
  // 节区表读完 = 152 + 224 + 40 = 416；样本共 1024，声明最后一节到 1024
  const file = await writeSample(full.subarray(0, 600))
  await assert.rejects(readPeHeader(file), (error) => {
    assert.ok(error instanceof PeTruncatedError)
    assert.match(error.message, /小节|节区表声明总长/)
    assert.match(error.message, /1024/)
    assert.match(error.message, /600 字节/)
    return true
  })
})

test('只差最后 1 字节也必须判为截断（边界）', async () => {
  const full = await guiPeX86Bytes()
  const file = await writeSample(full.subarray(0, full.length - 1))
  await assert.rejects(readPeHeader(file), (error) => {
    assert.ok(error instanceof PeTruncatedError)
    assert.match(error.message, new RegExp(String(full.length - 1)))
    return true
  })
})

test('gui:false 路径同样拦住截断样本（electron / nwjs / runtime 走这条）', async () => {
  // 这是本轮缺陷的正面复现点：200 字节的 clock.exe 曾被判 ok:true。
  const full = await guiPeX86Bytes()
  const file = await writeSample(full.subarray(0, 200))
  const result = await checkWindowsExe(file, { gui: false })
  assert.equal(result.ok, false, '截断的样本不许被判成合格运行时')
  assert.equal(result.truncated, true, '必须标记为「被截断」而非「不是 PE」')
  assert.equal(result.header, null)
  assert.equal(result.problems.length, 1)
  assert.match(result.problems[0], /截断/)
})

test('完整样本在两条路径上都通过，且 truncated 为 false', async () => {
  const file = await writeSample(await guiPeX86Bytes())
  for (const gui of [true, false]) {
    const result = await checkWindowsExe(file, { gui })
    assert.equal(result.ok, true, `gui=${String(gui)} 不该有问题：${result.problems.join('; ')}`)
    assert.equal(result.truncated, false)
    assert.deepEqual(result.problems, [])
  }
})

test('e_lfanew 指向 DOS 头内部：报「非法」而不是「被截断」', async () => {
  const bytes = Buffer.from(await guiPeX86Bytes())
  bytes.writeUInt32LE(0x10, 0x3c)   // 16，落在 DOS 头内部
  const file = await writeSample(bytes)
  await assert.rejects(readPeHeader(file), (error) => {
    assert.ok(error instanceof PeError)
    assert.ok(!(error instanceof PeTruncatedError),
      '字段本身非法与文件不全是两回事，不该混进截断类型')
    assert.match(error.message, /非法/)
    assert.match(error.message, /16/)
    return true
  })
})

test('e_lfanew 超出 4 KiB 窗口但文件完好：扩读而不是误判截断', async () => {
  const bytes = Buffer.from(await guiPeX86Bytes())
  // 把整个 PE 头搬到 0x2000 处：窗口 4096 读不到，但文件是真的完整
  const shifted = Buffer.alloc(0x2000 + bytes.length - 0x80)
  bytes.copy(shifted, 0, 0, 0x80)                    // DOS 头留在原处
  bytes.copy(shifted, 0x2000, 0x80)                  // PE 头搬到 0x2000
  shifted.writeUInt32LE(0x2000, 0x3c)
  // 节区表的 raw 偏移也要跟着搬，否则声明的长度对不上
  const sectionTable = 0x2000 + 24 + 224
  const oldRaw = shifted.readUInt32LE(sectionTable + 20)
  shifted.writeUInt32LE(oldRaw - 0x80 + 0x2000, sectionTable + 20)
  shifted.writeUInt32LE(shifted.length - (oldRaw - 0x80 + 0x2000), sectionTable + 16)

  const file = await writeSample(shifted)
  const header = await readPeHeader(file)
  assert.equal(header.peOffset, 0x2000)
  assert.equal(header.isGui, true, '扩读之后字段必须仍然正确')
  assert.equal(header.fileSize, shifted.length)
})

test('可选头短于 70 字节：报「不是可执行镜像」而不是崩溃', async () => {
  const bytes = Buffer.from(await guiPeX86Bytes())
  bytes.writeUInt16LE(0x14, 0x80 + 4 + 16)   // SizeOfOptionalHeader = 20
  const file = await writeSample(bytes)
  await assert.rejects(readPeHeader(file), (error) => {
    assert.ok(error instanceof PeError)
    assert.ok(!(error instanceof PeTruncatedError))
    assert.match(error.message, /可选头只有 20 字节/)
    return true
  })
})

test('节区表越过文件末尾：报截断并点名节数', async () => {
  const bytes = Buffer.from(await guiPeX86Bytes())
  // 节区表起点 = 152 + 224 = 376；样本共 1024 字节，最多容 16 条。
  // 声明 20 条 → 376 + 800 = 1176 > 1024，表本身就读不完。
  bytes.writeUInt16LE(20, 0x80 + 4 + 2)
  const file = await writeSample(bytes)
  await assert.rejects(readPeHeader(file), (error) => {
    assert.ok(error instanceof PeTruncatedError, `应抛 PeTruncatedError，实际 ${error.name}`)
    assert.match(error.message, /20 个节/)
    assert.match(error.message, /1176/)
    return true
  })
})