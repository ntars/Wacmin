/**
 * Windows PE（Portable Executable）文件解析。
 *
 * ## 为什么要自己解析而不是调 `file` 命令
 *
 * `file` 给的是人看的字符串（`PE32 executable (GUI) Intel 80386`），
 * 想判断「是不是 x86」「是不是 GUI 子系统」得去正则匹配那句英文——
 * 一旦系统换了 `file` 版本、措辞变了，校验就静默失效，而产物看起来
 * 一切正常。自己读二进制是唯一稳定的事实来源。
 *
 * ## 只解析用得到的字段
 *
 * 一个完整的 PE 解析器要处理几百个结构体。打包校验真正需要的只有：
 * 机器类型（确认 x86）、子系统（确认 GUI，双击不弹黑框）、
 * 以及是否为合法 PE。其余字段读了也没人用，只会增加出错面。
 *
 * 参考：Microsoft PE/COFF Specification。
 */

import { stat } from 'node:fs/promises'

import { readHead } from '../util/fsx.mjs'

/** PE 机器类型码 → 可读名称。 */
export const MACHINE_NAMES = {
  0x014c: 'i386',
  0x8664: 'x86-64',
  0x01c0: 'ARM',
  0x01c4: 'ARMv7',
  0xaa64: 'ARM64',
  0x0200: 'IA64',
}

/** 子系统码 → 可读名称。 */
export const SUBSYSTEM_NAMES = {
  1: 'native',
  2: 'windows-gui',
  3: 'windows-console',
  5: 'os2-console',
  7: 'posix-console',
  9: 'windows-ce-gui',
  10: 'efi-application',
}

/** 解析失败时抛出，携带人能看懂的原因。 */
export class PeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PeError'
  }
}

/**
 * 文件比它自己的节区表声明的还短 —— 即「被截断」。
 *
 * 单独一个类型而不是复用 `PeError`：两者的处置完全相反。`PeError` 表示
 * 「这不是可执行文件，别试了」；本类表示「这是个可执行文件，但没下完」，
 * 该做的是重下或重拷。上层若只有一个 `catch PeError`，这条区分就白做。
 */
export class PeTruncatedError extends PeError {
  constructor(message) {
    super(message)
    this.name = 'PeTruncatedError'
  }
}

/** DOS 头长度：`e_lfanew` 位于 0x3C、占 4 字节，读它至少要 64 字节。 */
const DOS_HEADER_MIN = 64

/** PE 签名（4 字节）+ COFF 头（20 字节）。 */
const SIGNATURE_AND_COFF = 24

/** COFF 头长度。 */
const COFF_HEADER_SIZE = 20

/** 节区表每条 40 字节。 */
const SECTION_ENTRY_SIZE = 40

/**
 * 头部读取窗口。
 *
 * PE 头与节区表几乎总在前 4 KiB 内（本机 657 个真实 exe 全部如此），
 * 所以先读这一段。个别 `e_lfanew` 很大的样本会超出，那时按需再扩读一次
 * —— 不能把「超出窗口」当成「文件被截断」，那是两句相反的话。
 */
const HEAD_WINDOW = 4096

/**
 * 解析一个 PE 文件的头部。
 *
 * ## 为什么必须知道文件的真实长度（2026-11-22 实测）
 *
 * 早先这里只读前 4 KiB 就下判断，从不问「文件有多长」。后果实测：把真实
 * `clock.exe`（40960 字节）截断到 **200 字节**（0.5%），
 * `checkWindowsExe(path, { gui: false })` 返回 `ok: true`、`problems: []`
 * ——因为头 200 字节里的机器类型、特征位、可选头 magic 全都在，判据一个
 * 都没落空。而 `electron` / `nwjs` / `runtime` / `artifact` 四条链路走的
 * 正是 `gui: false`，于是「只下了一半的运行时」会被判成合格产物。
 *
 * 判据取节区表：每个节都写明 `PointerToRawData + SizeOfRawData`，最大值
 * 就是这个 PE 声称自己有多长。实测 7 层 wine 目录下 **657 个真实 exe**
 * 逐个核 `need == size`，**全部精确相等、误报 0**；overlay 型安装包
 * （NSIS / Inno）的载荷挂在最后一节之后，`need < size`，同样不受影响。
 *
 * ## 三类「头不对」也要分开说
 *
 * 早先一个 `if (peOffset < 64 || peOffset + 24 > head.length)` 同时容纳：
 * ① `e_lfanew` 真的非法（指向 DOS 头内部）；② 文件短于该偏移（截断）；
 * ③ 偏移超出 4 KiB 窗口但文件完好。三者对用户的指向各不相同。
 *
 * @param {string} path 文件路径。
 * @returns {Promise<object>} 头部信息。
 * @throws {PeTruncatedError} 文件比自身节区表声明的短。
 * @throws {PeError} 不是合法 PE 时抛出。
 */
export async function readPeHeader(path) {
  let size
  try {
    size = (await stat(path)).size
  } catch (error) {
    throw new PeError(`无法读取 ${path}：${error.message}`)
  }

  let head = await readHead(path, HEAD_WINDOW)

  if (head.length < DOS_HEADER_MIN) {
    throw new PeError(
      `文件过短：${head.length} 字节，不足 DOS 头（${DOS_HEADER_MIN} 字节），无法判断格式`,
    )
  }

  // DOS 头：开头必须是 "MZ"。
  if (head[0] !== 0x4d || head[1] !== 0x5a) {
    throw new PeError(`不是 MZ 开头（实际 ${head.subarray(0, 2).toString('hex')}），不是 Windows 可执行文件`)
  }

  // e_lfanew：PE 头相对文件开头的偏移，位于 DOS 头 0x3C 处。
  const peOffset = head.readUInt32LE(0x3c)
  if (peOffset < DOS_HEADER_MIN) {
    throw new PeError(
      `e_lfanew 非法：${String(peOffset)} 指向 DOS 头内部（应 ≥ ${DOS_HEADER_MIN}），不是合法 PE`,
    )
  }
  if (peOffset + SIGNATURE_AND_COFF > size) {
    throw new PeTruncatedError(
      `文件被截断：e_lfanew=${String(peOffset)}，读 PE 签名与 COFF 头需要 `
      + `${String(peOffset + SIGNATURE_AND_COFF)} 字节，实际只有 ${String(size)} 字节`,
    )
  }
  if (peOffset + SIGNATURE_AND_COFF > head.length) {
    // 偏移超出 4 KiB 窗口，但文件本身够长 —— 扩读，不是截断。
    head = await readHead(path, Math.min(size, peOffset + SIGNATURE_AND_COFF))
  }

  // PE 签名：'P' 'E' 0x00 0x00。
  const signature = head.readUInt32LE(peOffset)
  if (signature !== 0x00004550) {
    throw new PeError(`PE 签名错误（期望 50450000，实际 ${signature.toString(16)}）`)
  }

  const coff = peOffset + 4
  const machine = head.readUInt16LE(coff)
  const sectionCount = head.readUInt16LE(coff + 2)
  const optionalHeaderSize = head.readUInt16LE(coff + 16)
  const characteristics = head.readUInt16LE(coff + 18)

  // 可选头紧跟 COFF 头。magic 0x10b = PE32，0x20b = PE32+（64 位）。
  const optional = coff + COFF_HEADER_SIZE

  // 子系统位于可选头偏移 68（PE32 与 PE32+ 同位置），读它需要 70 字节可选头。
  const optionalExtent = optional + 70
  if (optionalHeaderSize < 70) {
    throw new PeError(
      `可选头只有 ${String(optionalHeaderSize)} 字节，不足 70 —— 这不是可执行镜像（如 .obj），无法读出子系统`,
    )
  }
  if (optionalExtent > size) {
    throw new PeTruncatedError(
      `文件被截断：读可选头（含子系统字段）需要到 ${String(optionalExtent)} 字节，`
      + `实际只有 ${String(size)} 字节`,
    )
  }
  if (optionalExtent > head.length) {
    head = await readHead(path, Math.min(size, optionalExtent))
  }

  const optionalMagic = head.readUInt16LE(optional)
  const is64 = optionalMagic === 0x20b
  if (optionalMagic !== 0x10b && optionalMagic !== 0x20b) {
    throw new PeError(`可选头 magic 未知（${optionalMagic.toString(16)}），不是合法 PE`)
  }

  const subsystem = head.readUInt16LE(optional + 68)

  // 镜像基址与入口点用于判断「是不是一个真程序」而非资源 DLL。
  const entryPoint = head.readUInt32LE(optional + 16)

  // 节区表紧跟可选头。读不到表 = 文件比它自己声明的头还短。
  const sectionTable = optional + optionalHeaderSize
  const sectionTableEnd = sectionTable + sectionCount * SECTION_ENTRY_SIZE
  if (sectionTableEnd > size) {
    throw new PeTruncatedError(
      `文件被截断：节区表声明 ${String(sectionCount)} 个节，读完需要到 `
      + `${String(sectionTableEnd)} 字节，实际只有 ${String(size)} 字节`,
    )
  }
  if (sectionTableEnd > head.length) {
    head = await readHead(path, Math.min(size, sectionTableEnd))
  }

  // 节区表声明的文件长度：每个节 raw 数据的末尾，取最大值。
  let declaredSize = 0
  for (let index = 0; index < sectionCount; index += 1) {
    const base = sectionTable + index * SECTION_ENTRY_SIZE
    const rawSize = head.readUInt32LE(base + 16)
    const rawOffset = head.readUInt32LE(base + 20)
    if (rawOffset + rawSize > declaredSize) declaredSize = rawOffset + rawSize
  }
  if (declaredSize > size) {
    throw new PeTruncatedError(
      `文件被截断：节区表声明总长 ${String(declaredSize)} 字节（最后一节到 `
      + `${String(declaredSize)}），实际只有 ${String(size)} 字节 —— 可能未下载完或被截断`,
    )
  }

  return {
    path,
    format: is64 ? 'PE32+' : 'PE32',
    machine,
    machineName: MACHINE_NAMES[machine] ?? `未知(${machine.toString(16)})`,
    subsystem,
    subsystemName: SUBSYSTEM_NAMES[subsystem] ?? `未知(${String(subsystem)})`,
    sectionCount,
    optionalHeaderSize,
    characteristics,
    entryPoint,
    /** 是否为可执行镜像（而非 DLL）。 */
    isExecutable: (characteristics & 0x0002) !== 0,
    /** 是否为 32 位 x86。 */
    isX86: machine === 0x014c,
    /** 是否为 GUI 子系统（双击不弹控制台窗口）。 */
    isGui: subsystem === 2,
    peOffset,
    /** 文件真实长度。 */
    fileSize: size,
    /** 节区表声明的长度。`declaredSize > fileSize` 即被截断。 */
    declaredSize,
  }
}

/**
 * 检查一个 PE 文件是否符合「x86 Windows GUI 可执行文件」的要求。
 *
 * @param {string} path 文件路径。
 * @param {object} [expect] 期望值。
 * @param {boolean} [expect.gui] 是否要求 GUI 子系统。默认 true。
 * @returns {Promise<object>} `{ ok, header, problems }`。
 */
export async function checkWindowsExe(path, expect = {}) {
  const { gui = true } = expect
  const problems = []

  let header
  try {
    header = await readPeHeader(path)
  } catch (error) {
    // 「被截断」与「不是 PE」分开报：前者还有救（重下即可），后者没有。
    // 文案已自带原因，不再套前缀；机器可读的那一位放在 `truncated` 上。
    const message = error instanceof PeError ? error.message : `解析失败：${error.message}`
    return {
      ok: false,
      header: null,
      problems: [message],
      truncated: error instanceof PeTruncatedError,
    }
  }

  if (!header.isX86) {
    problems.push(`机器类型是 ${header.machineName}（0x${header.machine.toString(16)}），不是 x86 / i386（0x14c）`)
  }
  if (!header.isExecutable) {
    problems.push('COFF 特征位未标记可执行（IMAGE_FILE_EXECUTABLE_IMAGE），这是库而不是程序')
  }
  if (header.format !== 'PE32') {
    problems.push(`格式是 ${header.format}，32 位 x86 程序应为 PE32`)
  }
  if (gui && !header.isGui) {
    problems.push(`子系统是 ${header.subsystemName}，期望 windows-gui（双击启动会弹出控制台黑框）`)
  }
  if (header.entryPoint === 0) {
    problems.push('入口点地址为 0，文件无法启动')
  }

  return { ok: problems.length === 0, header, problems, truncated: false }
}