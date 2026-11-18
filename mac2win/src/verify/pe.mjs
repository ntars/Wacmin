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
 * 解析一个 PE 文件的头部。
 *
 * @param {string} path 文件路径。
 * @returns {Promise<object>} 头部信息。
 * @throws {PeError} 不是合法 PE 时抛出。
 */
export async function readPeHeader(path) {
  // 头部只在前 4KiB 内，读这一段就够判断全部需要的字段。
  const head = await readHead(path, 4096)

  if (head.length < 64) {
    throw new PeError('文件太小，不可能是 PE（不足 DOS 头长度）')
  }

  // DOS 头：开头必须是 "MZ"。
  if (head[0] !== 0x4d || head[1] !== 0x5a) {
    throw new PeError(`不是 MZ 开头（实际 ${head.subarray(0, 2).toString('hex')}），不是 Windows 可执行文件`)
  }

  // e_lfanew：PE 头相对文件开头的偏移，位于 DOS 头 0x3C 处。
  const peOffset = head.readUInt32LE(0x3c)
  if (peOffset < 64 || peOffset + 24 > head.length) {
    throw new PeError(`PE 头偏移 ${String(peOffset)} 越界，文件可能被截断`)
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
  const optional = coff + 20
  const optionalMagic = head.readUInt16LE(optional)
  const is64 = optionalMagic === 0x20b
  if (optionalMagic !== 0x10b && optionalMagic !== 0x20b) {
    throw new PeError(`可选头 magic 未知（${optionalMagic.toString(16)}），不是合法 PE`)
  }

  // 子系统位于可选头偏移 68（PE32 与 PE32+ 同位置）。
  const subsystem = optional + 68 + 2 > head.length ? null : head.readUInt16LE(optional + 68)

  // 镜像基址与入口点用于判断「是不是一个真程序」而非资源 DLL。
  const entryPoint = head.readUInt32LE(optional + 16)

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
    return {
      ok: false,
      header: null,
      problems: [error instanceof PeError ? error.message : `解析失败：${error.message}`],
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

  return { ok: problems.length === 0, header, problems }
}