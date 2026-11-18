/**
 * Mach-O 解析测试。
 *
 * 跑法：cd apponwin && npm test
 *
 * 测试样本两类：
 *   1. 构造的最小 Mach-O —— 精确控制 load command，断言可预期
 *   2. 本机真实二进制（有的话）—— 验证能处理真实文件
 *
 * 不依赖外部样本文件入库：真实二进制用 `process.execPath`（Node 自己）
 * 与 `/bin/ls`（仅 macOS/Linux），缺失时自动跳过。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CPU_TYPE, MachOError, cpuNameOf, frameworkOf, isMachO, parseMachO,
} from '../src/core/macho.mjs'

/** Mach-O 魔数（大端读出的值）。 */
const MAGIC = {
  THIN_64_LE: 0xfeedfacf,   // 小端 64 位；按大端读出是这个值
  THIN_32_LE: 0xfeedface,
  FAT_BE: 0xcafebabe,
}

/**
 * 构造一个最小 thin Mach-O 64 位小端。
 *
 * 注意魔数的写法：小端文件的第一个 4 字节按小端存的是 `0xfeedfacf`，
 * 因此按字节序列读出来（大端解释）就是 `0xcffaedfe`。解析器统一按
 * 大端读前 4 字节再判断，所以这里要写 `0xcffaedfe` 的字节序。
 *
 * @param {object} options
 * @param {number} [options.cpuType]
 * @param {number} [options.fileType]
 * @param {string[]} [options.dylibs] 要写入的 LC_LOAD_DYLIB。
 * @param {string[]} [options.rpaths]
 * @param {number} [options.minOS] 打包后的版本整数。
 */
function buildThin(options = {}) {
  const cpuType = options.cpuType ?? CPU_TYPE.ARM64
  const fileType = options.fileType ?? 2
  const dylibs = options.dylibs ?? []
  const rpaths = options.rpaths ?? []
  const minOS = options.minOS ?? 0x000d0000   // 13.0.0

  const commands = []

  for (const dylib of dylibs) {
    // dylib_command: cmd(4) cmdsize(4) name_off(4) ts(4) cur(4) compat(4) + name
    const nameBuffer = Buffer.from(`${dylib}\0`, 'utf8')
    const size = 24 + nameBuffer.length
    const buffer = Buffer.alloc(size)
    buffer.writeUInt32LE(0x0000000c, 0)   // LC_LOAD_DYLIB
    buffer.writeUInt32LE(size, 4)
    buffer.writeUInt32LE(24, 8)           // name offset
    buffer.writeUInt32LE(2, 12)
    buffer.writeUInt32LE(0, 16)
    buffer.writeUInt32LE(0, 20)
    nameBuffer.copy(buffer, 24)
    commands.push(buffer)
  }

  for (const rpath of rpaths) {
    const pathBuffer = Buffer.from(`${rpath}\0`, 'utf8')
    const size = 12 + pathBuffer.length
    const buffer = Buffer.alloc(size)
    buffer.writeUInt32LE(0x8000001c, 0)   // LC_RPATH
    buffer.writeUInt32LE(size, 4)
    buffer.writeUInt32LE(12, 8)
    pathBuffer.copy(buffer, 12)
    commands.push(buffer)
  }

  // LC_BUILD_VERSION: cmd(4) cmdsize(4) platform(4) minos(4) sdk(4) ntools(4)
  {
    const buffer = Buffer.alloc(24)
    buffer.writeUInt32LE(0x00000032, 0)
    buffer.writeUInt32LE(24, 4)
    buffer.writeUInt32LE(1, 8)            // platform = macOS
    buffer.writeUInt32LE(minOS, 12)
    buffer.writeUInt32LE(minOS, 16)
    buffer.writeUInt32LE(0, 20)
    commands.push(buffer)
  }

  const body = Buffer.concat(commands)
  const header = Buffer.alloc(32)
  /*
   * 小端 64 位魔数：按小端写 0xfeedfacf，字节序列即 cf fa ed fe，
   * 解析器按大端读得 0xcffaedfe，命中 THIN_64_LE。
   */
  header.writeUInt32LE(MAGIC.THIN_64_LE, 0)
  header.writeUInt32LE(cpuType >>> 0, 4)
  header.writeUInt32LE(0, 8)              // cpusubtype
  header.writeUInt32LE(fileType, 12)
  header.writeUInt32LE(commands.length, 16)
  header.writeUInt32LE(body.length, 20)
  header.writeUInt32LE(0, 24)             // flags
  header.writeUInt32LE(0, 28)             // reserved

  return Buffer.concat([header, body])
}

/**
 * 构造一个 fat 容器，把多个 thin 切片打进去。
 *
 * 布局：fat 头 + 每个切片的 padding + 切片内容。
 * 每个切片的 offset 必须精确等于它在文件里的实际起点，否则解析器会
 * 读到错误位置 —— 这里先算出全部 offset，再按 offset 拼装。
 *
 * @param {Buffer[]} slices
 */
function buildFat(slices) {
  const headerSize = 8 + 20 * slices.length
  const ALIGN = 0x1000

  // ① 先算每个切片的实际起点（按 ALIGN 对齐）
  const offsets = []
  let cursor = headerSize
  for (const slice of slices) {
    const aligned = Math.ceil(cursor / ALIGN) * ALIGN
    offsets.push(aligned)
    cursor = aligned + slice.length
  }

  // ② 写 fat 头。cputype 必须取自切片自身（偏移 4 处），
  //    否则所有架构都会报成同一个 —— 那是测试构造器的 bug，不是解析器的。
  const header = Buffer.alloc(headerSize)
  header.writeUInt32BE(MAGIC.FAT_BE, 0)
  header.writeUInt32BE(slices.length, 4)
  slices.forEach((slice, index) => {
    const base = 8 + index * 20
    // 切片是小端 thin，cputype 在偏移 4，按小端读
    const sliceCpu = slice.readUInt32LE(4)
    header.writeUInt32BE(sliceCpu >>> 0, base)
    header.writeUInt32BE(0, base + 4)
    header.writeUInt32BE(offsets[index], base + 8)
    header.writeUInt32BE(slice.length, base + 12)
    header.writeUInt32BE(12, base + 16)   // align = 2^12
  })

  // ③ 按 offset 拼装，空隙填 0
  const total = cursor
  const out = Buffer.alloc(total)
  header.copy(out, 0)
  slices.forEach((slice, index) => {
    slice.copy(out, offsets[index])
  })
  return out
}

/** 写临时文件并返回路径。 */
async function withTemp(buffer, fn) {
  const root = await mkdtemp(join(tmpdir(), 'aow-macho-'))
  try {
    const path = join(root, 'sample')
    await writeFile(path, buffer)
    return await fn(path, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('Mach-O 识别', () => {
  test('识别 thin 64 位小端', async () => {
    await withTemp(buildThin(), async (path) => {
      assert.equal(isMachO(await readHead(path)), true)
    })
  })

  test('识别 fat', async () => {
    const fat = buildFat([buildThin(), buildThin()])
    await withTemp(fat, async (path) => {
      assert.equal(isMachO(await readHead(path)), true)
    })
  })

  test('PE 文件不是 Mach-O', async () => {
    await withTemp(Buffer.from('MZ\x90\x00\x03', 'latin1'), async (path) => {
      assert.equal(isMachO(await readHead(path)), false)
    })
  })

  test('ELF 不是 Mach-O', async () => {
    const buffer = Buffer.alloc(8)
    buffer.writeUInt32BE(0x7f454c46, 0)
    await withTemp(buffer, async (path) => {
      assert.equal(isMachO(await readHead(path)), false)
    })
  })

  test('过短文件不是 Mach-O', () => {
    assert.equal(isMachO(Buffer.from([0xcf])), false)
  })
})

/** 读前 4 字节。 */
async function readHead(path) {
  const { open } = await import('node:fs/promises')
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(4)
    await handle.read(buffer, 0, 4, 0)
    return buffer
  } finally {
    await handle.close()
  }
}

describe('thin 解析', () => {
  test('读架构与文件类型', async () => {
    await withTemp(buildThin(), async (path) => {
      const result = await parseMachO(path)
      assert.equal(result.kind, 'thin')
      assert.equal(result.architectures.length, 1)
      assert.equal(result.architectures[0].cpuName, 'arm64')
      assert.equal(result.architectures[0].fileType, 'executable')
    })
  })

  test('读依赖库', async () => {
    const buffer = buildThin({
      dylibs: ['/usr/lib/libSystem.B.dylib', '/usr/lib/libz.1.dylib'],
    })
    await withTemp(buffer, async (path) => {
      const result = await parseMachO(path)
      assert.deepEqual(result.dylibs.sort(), [
        '/usr/lib/libSystem.B.dylib', '/usr/lib/libz.1.dylib',
      ])
    })
  })

  test('从依赖里提取框架名', async () => {
    const buffer = buildThin({
      dylibs: [
        '/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit',
        '/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation',
        '/usr/lib/libSystem.B.dylib',
      ],
    })
    await withTemp(buffer, async (path) => {
      const result = await parseMachO(path)
      assert.deepEqual(result.frameworks.sort(), ['AppKit', 'Foundation'])
    })
  })

  test('读 rpath', async () => {
    const buffer = buildThin({ rpaths: ['@executable_path/../Frameworks'] })
    await withTemp(buffer, async (path) => {
      const result = await parseMachO(path)
      assert.deepEqual(result.rpaths, ['@executable_path/../Frameworks'])
    })
  })

  test('读最低系统版本', async () => {
    await withTemp(buildThin({ minOS: 0x000d0000 }), async (path) => {
      const result = await parseMachO(path)
      assert.equal(result.architectures[0].minOS, '13.0.0')
    })
  })

  test('x86_64 架构名', async () => {
    await withTemp(buildThin({ cpuType: CPU_TYPE.X86_64 }), async (path) => {
      const result = await parseMachO(path)
      assert.equal(result.architectures[0].cpuName, 'x86_64')
    })
  })

  test('非 Mach-O 抛错', async () => {
    await withTemp(Buffer.from('not a macho file at all'), async (path) => {
      await assert.rejects(() => parseMachO(path), MachOError)
    })
  })

  test('过短文件抛错', async () => {
    await withTemp(Buffer.from([1, 2, 3]), async (path) => {
      await assert.rejects(() => parseMachO(path), MachOError)
    })
  })
})

describe('fat 解析', () => {
  test('读多架构', async () => {
    const fat = buildFat([buildThin(), buildThin({ cpuType: CPU_TYPE.X86_64 })])
    await withTemp(fat, async (path) => {
      const result = await parseMachO(path)
      assert.equal(result.kind, 'fat')
      assert.equal(result.architectures.length, 2)
      const names = result.architectures.map((arch) => arch.cpuName).sort()
      assert.deepEqual(names, ['arm64', 'x86_64'])
    })
  })

  test('合并各切片的框架', async () => {
    const fat = buildFat([
      buildThin({ dylibs: ['/System/Library/Frameworks/AppKit.framework/AppKit'] }),
      buildThin({
        cpuType: CPU_TYPE.X86_64,
        dylibs: ['/System/Library/Frameworks/Metal.framework/Metal'],
      }),
    ])
    await withTemp(fat, async (path) => {
      const result = await parseMachO(path)
      assert.deepEqual(result.frameworks.sort(), ['AppKit', 'Metal'])
    })
  })

  test('架构数为 0 时报错', async () => {
    const header = Buffer.alloc(8)
    header.writeUInt32BE(MAGIC.FAT_BE, 0)
    header.writeUInt32BE(0, 4)
    await withTemp(header, async (path) => {
      await assert.rejects(() => parseMachO(path), /架构数异常/u)
    })
  })

  test('切片越界时报错', async () => {
    const header = Buffer.alloc(8 + 20)
    header.writeUInt32BE(MAGIC.FAT_BE, 0)
    header.writeUInt32BE(1, 4)
    header.writeUInt32BE(CPU_TYPE.ARM64 >>> 0, 8)
    header.writeUInt32BE(0, 12)
    header.writeUInt32BE(0xfffff000, 16)   // offset 远超文件长度
    header.writeUInt32BE(0x1000, 20)
    header.writeUInt32BE(12, 24)
    await withTemp(header, async (path) => {
      await assert.rejects(() => parseMachO(path), /越界/u)
    })
  })
})

describe('辅助函数', () => {
  test('frameworkOf 识别三种形态', () => {
    assert.equal(
      frameworkOf('/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit'),
      'AppKit')
    assert.equal(frameworkOf('/usr/lib/libSystem.B.dylib'), null)
    assert.equal(frameworkOf('@rpath/Foo.framework/Foo'), 'Foo')
  })

  test('cpuNameOf 常见类型', () => {
    assert.equal(cpuNameOf(CPU_TYPE.ARM64), 'arm64')
    assert.equal(cpuNameOf(CPU_TYPE.X86_64), 'x86_64')
    assert.equal(cpuNameOf(CPU_TYPE.X86), 'i386')
  })

  test('未知 CPU 类型有可读名', () => {
    assert.match(cpuNameOf(0x999), /^unknown\(0x/u)
  })
})

describe('真实二进制', () => {
  /*
   * 用 Node 自己的可执行文件作真实样本。
   *
   * 这个样本的格式随平台而变，所以断言也必须分平台 —— 之前这里只写了
   * 「能解析出架构」一种预期，在 macOS 上跑得过，到了 Windows runner 上
   * 必然失败：Windows 的 node.exe 是 PE（魔数 0x4d5a = `MZ`），本来就
   * 不是 Mach-O，解析器正确拒绝反而是对的。
   *
   * 顺带说明为什么值得保留这个测试：它覆盖了「拿到一个真实的、体积
   * 几十 MB 的二进制」这条路径，比手搓的 32 字节样本更接近实际输入。
   */

  test('解析 Node 可执行文件', async () => {
    if (process.platform === 'win32') {
      /*
       * Windows 宿主：node.exe 是 PE/COFF，解析器必须明确拒绝，
       * 而不是崩溃、不是返回空架构、更不是把 `MZ` 当成 Mach-O 魔数
       * 硬解下去。这一条等价于 AppOnWin 在 Windows 上评估 PE 输入时
       * 的第一道防线。
       */
      await assert.rejects(
        () => parseMachO(process.execPath),
        (error) => {
          assert.match(error.message, /不是 Mach-O/u,
            `期望明确拒绝非 Mach-O 输入，实际报错：${error.message}`)
          return true
        },
        'Windows 的 node.exe 是 PE 格式，解析器必须拒绝',
      )
      return
    }

    const result = await parseMachO(process.execPath)
    assert.ok(result.architectures.length > 0)
    assert.ok(['thin', 'fat', 'fat64'].includes(result.kind))
    for (const arch of result.architectures) {
      assert.ok(typeof arch.cpuName === 'string')
    }
  })

  test('解析 /bin/ls（仅类 Unix）', {
    skip: process.platform === 'win32',
  }, async () => {
    const exists = await stat('/bin/ls').then(() => true).catch(() => false)
    if (!exists) return
    const result = await parseMachO('/bin/ls')
    assert.ok(result.architectures.length > 0)
  })
})