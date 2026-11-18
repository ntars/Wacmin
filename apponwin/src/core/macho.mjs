/**
 * Mach-O 解析。
 *
 * ## 为什么自己写而不引库
 *
 * 需求很窄：读架构列表、读依赖的动态库名。`macho-parser` / `node-macho`
 * 这类库都远大于所需，且引入供应链风险。这里约 350 行覆盖全部需求。
 *
 * ## 需要处理的三种容器
 *
 * ```
 * thin Mach-O        单一架构，直接是 header + load commands
 * fat / universal    多架构容器，先读 fat 头再逐个切片
 * fat64              同上，但 offset/size 是 64 位（大文件才用）
 * ```
 *
 * 魔数（大端读取前 4 字节）：
 *
 * | 魔数 | 含义 |
 * |---|---|
 * | `0xfeedface` | thin 32 位，大端 |
 * | `0xcefaedfe` | thin 32 位，小端 |
 * | `0xfeedfacf` | thin 64 位，大端 |
 * | `0xcffaedfe` | thin 64 位，小端 |
 * | `0xcafebabe` | fat，大端 |
 * | `0xbebafeca` | fat，小端 |
 * | `0xcafebabf` | fat64，大端 |
 *
 * 实际 macOS 上的可执行文件几乎全是小端 64 位（`0xcffaedfe`）或 fat 容器。
 *
 * ## 依赖库从哪读
 *
 * load command 里 `LC_LOAD_DYLIB`(0xc) / `LC_LOAD_WEAK_DYLIB`(0x80000018) /
 * `LC_REEXPORT_DYLIB`(0x8000001f) 三种都带库路径字符串，偏移在
 * `dylib.name.offset`。框架依赖就是从这里看出来的 —— 例如
 * `/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit`。
 */

import { open } from 'node:fs/promises'

/** CPU 类型常量。 */
export const CPU_TYPE = {
  X86: 7,
  X86_64: 0x01000007,
  ARM: 12,
  ARM64: 0x0100000c,
  ARM64_32: 0x0200000c,
  POWERPC: 18,
  POWERPC64: 0x01000012,
}

/** CPU 类型的可读名。 */
const CPU_NAMES = {
  [CPU_TYPE.X86]: 'i386',
  [CPU_TYPE.X86_64]: 'x86_64',
  [CPU_TYPE.ARM]: 'arm',
  [CPU_TYPE.ARM64]: 'arm64',
  [CPU_TYPE.ARM64_32]: 'arm64_32',
  [CPU_TYPE.POWERPC]: 'ppc',
  [CPU_TYPE.POWERPC64]: 'ppc64',
}

/** 文件类型。 */
export const FILE_TYPE = {
  1: 'object',
  2: 'executable',
  3: 'fixed-vm-library',
  4: 'core',
  5: 'preload',
  6: 'dylib',
  7: 'dylinker',
  8: 'bundle',
  9: 'dylib-stub',
  10: 'dSYM',
  11: 'kext-bundle',
}

/** 会带来依赖库的 load command。 */
const DYLIB_COMMANDS = new Set([
  0x0000000c,   // LC_LOAD_DYLIB
  0x80000018,   // LC_LOAD_WEAK_DYLIB
  0x8000001f,   // LC_REEXPORT_DYLIB
  0x80000023,   // LC_LOAD_UPWARD_DYLIB
  0x0000000d,   // LC_ID_DYLIB（自身 id，不算依赖）
])

const LC_ID_DYLIB = 0x0000000d
const LC_LOAD_DYLIB = 0x0000000c
const LC_RPATH = 0x8000001c
const LC_BUILD_VERSION = 0x00000032
const LC_VERSION_MIN_MACOSX = 0x00000024

/** 魔数。 */
const MAGIC = {
  THIN_32_BE: 0xfeedface,
  THIN_32_LE: 0xcefaedfe,
  THIN_64_BE: 0xfeedfacf,
  THIN_64_LE: 0xcffaedfe,
  FAT_BE: 0xcafebabe,
  FAT_LE: 0xbebafeca,
  FAT64_BE: 0xcafebabf,
  FAT64_LE: 0xbfbafeca,
}

/** 解析失败时抛这个，带可读原因。 */
export class MachOError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MachOError'
  }
}

/**
 * 判断文件头是否是 Mach-O。
 *
 * @param {Buffer} head 文件前 4 字节即可。
 * @returns {boolean}
 */
export function isMachO(head) {
  if (head.length < 4) return false
  const magic = head.readUInt32BE(0)
  return Object.values(MAGIC).includes(magic)
}

/**
 * 解析一个 Mach-O 文件。
 *
 * @param {string} path
 * @returns {Promise<{
 *   path: string,
 *   kind: 'thin'|'fat'|'fat64',
 *   architectures: Array<{cpuType: number, cpuName: string, cpuSubtype: number, offset: number, size: number, fileType: string|null, minOS: string|null}>,
 *   dylibs: string[],
 *   rpaths: string[],
 *   frameworks: string[],
 * }>}
 */
export async function parseMachO(path) {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    if (size < 8) throw new MachOError('文件过短，不是 Mach-O')

    const head = Buffer.alloc(Math.min(4096, size))
    await handle.read(head, 0, head.length, 0)
    const magic = head.readUInt32BE(0)

    if (magic === MAGIC.FAT_BE || magic === MAGIC.FAT64_BE
      || magic === MAGIC.FAT_LE || magic === MAGIC.FAT64_LE) {
      return await parseFat(handle, path, magic, size)
    }
    if (magic === MAGIC.THIN_64_LE || magic === MAGIC.THIN_64_BE
      || magic === MAGIC.THIN_32_LE || magic === MAGIC.THIN_32_BE) {
      const slice = await parseSlice(handle, 0, size, magic)
      return {
        path,
        kind: 'thin',
        architectures: [{ ...slice, offset: 0, size }],
        dylibs: slice.dylibs,
        rpaths: slice.rpaths,
        frameworks: slice.frameworks,
      }
    }
    throw new MachOError(`不是 Mach-O（魔数 0x${magic.toString(16)}）`)
  } finally {
    await handle.close()
  }
}

/**
 * 解析 fat 容器。
 *
 * @param {import('node:fs/promises').FileHandle} handle
 * @param {string} path
 * @param {number} magic
 * @param {number} size
 */
async function parseFat(handle, path, magic, size) {
  const is64 = magic === MAGIC.FAT64_BE || magic === MAGIC.FAT64_LE
  const little = magic === MAGIC.FAT_LE || magic === MAGIC.FAT64_LE
  const read32 = (buffer, offset) => little
    ? buffer.readUInt32LE(offset)
    : buffer.readUInt32BE(offset)

  const header = Buffer.alloc(8)
  await handle.read(header, 0, 8, 0)
  const count = read32(header, 4)
  if (count === 0 || count > 32) {
    throw new MachOError(`fat 架构数异常：${String(count)}`)
  }

  // fat_arch 是 20 字节，fat_arch_64 是 32 字节
  const entrySize = is64 ? 32 : 20
  const table = Buffer.alloc(entrySize * count)
  await handle.read(table, 0, table.length, 8)

  const architectures = []
  const dylibs = new Set()
  const rpaths = new Set()

  for (let index = 0; index < count; index += 1) {
    const base = index * entrySize
    const cpuType = read32(table, base) | 0
    const cpuSubtype = read32(table, base + 4) | 0

    let offset
    let sliceSize
    if (is64) {
      // fat_arch_64: cputype(4) cpusubtype(4) offset(8) size(8) align(4) reserved(4)
      const high = read32(table, base + 8)
      const low = read32(table, base + 12)
      offset = high * 0x100000000 + low
      const sizeHigh = read32(table, base + 16)
      const sizeLow = read32(table, base + 20)
      sliceSize = sizeHigh * 0x100000000 + sizeLow
    } else {
      offset = read32(table, base + 8)
      sliceSize = read32(table, base + 12)
    }

    if (offset + sliceSize > size) {
      throw new MachOError(
        `fat 切片越界：arch ${String(index)} offset=${String(offset)} size=${String(sliceSize)}`)
    }

    let slice = null
    try {
      slice = await parseSlice(handle, offset, sliceSize, null)
    } catch (error) {
      /*
       * 单个切片解析失败不中断整体。
       *
       * 真实场景：某些 fat 二进制里混有非常规架构切片（如 arm64e 的
       * 特殊 subtype），解析它的 load command 可能遇到不认识的命令。
       * 只要其它切片能读，架构信息就是有效的。
       */
      slice = { cpuName: cpuNameOf(cpuType), fileType: null, minOS: null, dylibs: [], rpaths: [], frameworks: [], error: String(error) }
    }

    architectures.push({
      cpuType,
      cpuName: cpuNameOf(cpuType),
      cpuSubtype,
      offset,
      size: sliceSize,
      fileType: slice.fileType,
      minOS: slice.minOS,
      ...(slice.error === undefined ? {} : { error: slice.error }),
    })
    for (const dylib of slice.dylibs) dylibs.add(dylib)
    for (const rpath of slice.rpaths) rpaths.add(rpath)
  }

  const frameworks = new Set()
  for (const dylib of dylibs) {
    const framework = frameworkOf(dylib)
    if (framework !== null) frameworks.add(framework)
  }

  return {
    path,
    kind: is64 ? 'fat64' : 'fat',
    architectures,
    dylibs: [...dylibs].sort(),
    rpaths: [...rpaths].sort(),
    frameworks: [...frameworks].sort(),
  }
}

/**
 * 解析单个 thin 切片。
 *
 * @param {import('node:fs/promises').FileHandle} handle
 * @param {number} offset 切片在文件内的起始偏移。
 * @param {number} sliceSize
 * @param {number|null} knownMagic 已知魔数（thin 文件直接给），null 表示从数据读。
 */
async function parseSlice(handle, offset, sliceSize, knownMagic) {
  const head = Buffer.alloc(Math.min(32, sliceSize))
  await handle.read(head, 0, head.length, offset)

  const magic = knownMagic ?? head.readUInt32BE(0)
  const is64 = magic === MAGIC.THIN_64_LE || magic === MAGIC.THIN_64_BE
  const little = magic === MAGIC.THIN_64_LE || magic === MAGIC.THIN_32_LE

  if (!little && magic !== MAGIC.THIN_64_BE && magic !== MAGIC.THIN_32_BE) {
    // fat 容器里理论上是 thin 魔数，走到这里说明嵌套异常
    throw new MachOError(`切片魔数不是 thin Mach-O：0x${magic.toString(16)}`)
  }

  const read32 = (buffer, at) => little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at)

  const cpuType = read32(head, 4) | 0
  const cpuSubtype = read32(head, 8) | 0
  const fileTypeRaw = read32(head, 12)
  const commandCount = read32(head, 16)
  const commandBytes = read32(head, 20)

  // header 本身占 32 字节（64 位）或 28 字节（32 位）
  const headerSize = is64 ? 32 : 28
  if (commandBytes > sliceSize || commandCount > 1024) {
    throw new MachOError(
      `load command 尺寸异常：${String(commandCount)} 条 / ${String(commandBytes)} 字节`)
  }

  const commands = Buffer.alloc(Math.min(commandBytes, 65536))
  await handle.read(commands, 0, commands.length, offset + headerSize)

  const dylibs = []
  const rpaths = []
  let minOS = null
  let cursor = 0

  for (let index = 0; index < commandCount; index += 1) {
    if (cursor + 8 > commands.length) break
    const command = read32(commands, cursor)
    const size = read32(commands, cursor + 4)
    if (size < 8 || cursor + size > commands.length) break

    if (DYLIB_COMMANDS.has(command) && command !== LC_ID_DYLIB) {
      /*
       * dylib_command: cmd(4) cmdsize(4) name_offset(4) timestamp(4)
       *                current_version(4) compatibility_version(4)
       * 名字字符串从 command 起点算起，偏移是 name_offset。
       */
      const nameOffset = read32(commands, cursor + 8)
      if (nameOffset < 12 || nameOffset >= size) {
        cursor += size
        continue
      }
      const raw = commands.subarray(cursor + nameOffset, cursor + size)
      const end = raw.indexOf(0)
      const name = raw.subarray(0, end < 0 ? raw.length : end).toString('utf8')
      if (name !== '') dylibs.push(name)
    } else if (command === LC_RPATH) {
      // rpath_command: cmd(4) cmdsize(4) path_offset(4)
      const pathOffset = read32(commands, cursor + 8)
      if (pathOffset >= 12 && pathOffset < size) {
        const raw = commands.subarray(cursor + pathOffset, cursor + size)
        const end = raw.indexOf(0)
        rpaths.push(raw.subarray(0, end < 0 ? raw.length : end).toString('utf8'))
      }
    } else if (command === LC_BUILD_VERSION) {
      // build_version_command: platform(4) minos(4) sdk(4)
      minOS = versionToString(read32(commands, cursor + 12))
    } else if (command === LC_VERSION_MIN_MACOSX) {
      minOS = versionToString(read32(commands, cursor + 8))
    }

    cursor += size
  }

  const frameworks = new Set()
  for (const dylib of dylibs) {
    const framework = frameworkOf(dylib)
    if (framework !== null) frameworks.add(framework)
  }

  return {
    cpuName: cpuNameOf(cpuType),
    cpuSubtype,
    fileType: FILE_TYPE[fileTypeRaw] ?? `unknown(${String(fileTypeRaw)})`,
    minOS,
    dylibs,
    rpaths,
    frameworks: [...frameworks],
  }
}

/**
 * Mach-O 的版本号是 `xxxx.yy.zz` 打包进 32 位：高 16 位主版本，
 * 次 8 位次版本，低 8 位补丁。
 *
 * @param {number} value
 */
function versionToString(value) {
  const major = (value >>> 16) & 0xffff
  const minor = (value >>> 8) & 0xff
  const patch = value & 0xff
  return `${String(major)}.${String(minor)}.${String(patch)}`
}

/**
 * 从 dylib 路径里取框架名。
 *
 * 三种形态：
 *   /System/Library/Frameworks/AppKit.framework/Versions/C/AppKit  → AppKit
 *   /usr/lib/libSystem.B.dylib                                    → null（不是框架）
 *   @rpath/Foo.framework/Foo                                      → Foo
 *
 * @param {string} dylib
 * @returns {string | null}
 */
export function frameworkOf(dylib) {
  const match = /([^/]+)\.framework\//u.exec(dylib)
  return match === null ? null : match[1]
}

/**
 * CPU 类型转可读名。
 *
 * @param {number} cpuType
 */
export function cpuNameOf(cpuType) {
  return CPU_NAMES[cpuType] ?? `unknown(0x${(cpuType >>> 0).toString(16)})`
}