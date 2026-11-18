/**
 * 测试用产物的自建与缓存。
 *
 * ## 为什么需要这个模块
 *
 * 有一批测试要校验「一个真的构建出来的安装包」：缺 7-Zip 时校验器会不会
 * 说谎、32 位产物按 64 位校验会不会被拒、zip 产物会不会走错 PE 路径。
 * 这些断言没法用 mock 替代——它们守的正是「面对真实字节时的行为」。
 *
 * 原来的做法是指向开发机上的手工残留：
 *
 * ```js
 * const X64_EXE = '/tmp/uibuild/demo-1.2.3-x64-setup.exe'
 * ```
 *
 * 这些路径不写在任何文档里，只有换一台机器才会暴露。CI 的 runner 是干净
 * 环境，于是 14 项测试**静默跳过**——包括 `verify-honesty.test.mjs` 里守
 * 「校验器永不说谎」的四条核心断言。跳过是绿色的，所以没有任何人会发现
 * CI 上这个守卫其实没在站岗。
 *
 * 现在改为：**测试自己构建所需产物**。构建一次约 20 秒，缓存后同一次
 * `npm test` 内复用。
 *
 * ## 为什么构建失败要抛错而不是跳过
 *
 * 跳过与失败的差别在于「谁该动作」。缺 makensis 是环境问题，但把它变成
 * 跳过，就等于允许这个环境永远不验校验器。抛错会让人去装工具，装完就有
 * 了覆盖。CC 环境（CI）里 makensis 由 workflow 安装，所以抛错不会误伤。
 *
 * ## 并发安全
 *
 * `node --test` 默认按 CPU 核数并发跑测试文件，每个文件是独立进程。因此
 * 缓存不能放在模块级变量里，必须落在磁盘上；两个进程同时想构建时用
 * 目录锁串行化，先到的构建，后到的等标记文件。
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rename, rm, writeFile, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'mac2win.mjs')

/**
 * 缓存根目录。
 *
 * 带版本号：产物的构成（运行时版本、启动器内容）变了就换目录，避免旧缓存
 * 让新断言在「上一版产物」上通过。
 */
const ROOT = process.env.MAC2WIN_TEST_FIXTURES ?? join(tmpdir(), 'mac2win-fixtures-v1')

/** 每种产物一个子目录，避免同一个锁里塞多件事。 */
const KINDS = {
  /** 32 位安装包，用于架构不符、NSIS 外壳形态等断言。 */
  x86: { target: 'x86', zip: false, marker: 'fixture-1.0.0-x86-setup.exe' },
  /** 64 位安装包 + 免安装 zip，用于架构推断与 zip 校验路径。 */
  x64: { target: 'x64', zip: true, marker: 'fixture-1.0.0-x64-setup.exe' },
}

/**
 * 跑一次 CLI，返回退出码与两个流。
 *
 * @param {string[]} args
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runCli(args) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolvePromise({
          code: error === null ? 0 : (typeof error.code === 'number' ? error.code : 1),
          stdout,
          stderr,
        })
      },
    )
  })
}

/**
 * 造一个最小的静态站点项目。
 *
 * 用静态站而不是 Node 服务：体量最小，构建最快，且不涉及框架运行时的
 * 版本边界。样本的职责是「一份合法的产物」，不是「一份复杂的产物」。
 *
 * @param {string} root
 * @returns {Promise<string>} 项目目录
 */
async function makeProject(root) {
  const project = join(root, 'site')
  await mkdir(project, { recursive: true })
  await writeFile(
    join(project, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title></head>'
      + '<body><p>mac2win test fixture</p></body></html>\n',
  )
  await writeFile(
    join(project, 'package.json'),
    `${JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2)}\n`,
  )
  return project
}

/**
 * 等另一个进程把产物构建完。
 *
 * 超时给 5 分钟：一次构建 20 秒上下，但 CI 的 runner 可能更慢，且首次
 * 构建要下载 Node 运行时（如果缓存未命中）。
 *
 * @param {string} marker
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitFor(marker, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(marker)) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  return false
}

/**
 * 确保某类产物已构建，返回其路径。
 *
 * @param {'x86' | 'x64'} kind
 * @returns {Promise<{exe: string, zip: string | null, dir: string}>}
 */
export async function ensure(kind) {
  const spec = KINDS[kind]
  if (spec === undefined) throw new Error(`未知的样本类型：${kind}`)

  const dir = join(ROOT, kind)
  const marker = join(dir, spec.marker)
  const zipPath = spec.zip ? join(dir, spec.marker.replace(/\.exe$/u, '.zip')) : null

  const ready = async () => {
    if (!existsSync(marker)) return false
    if (zipPath !== null && !existsSync(zipPath)) return false
    return true
  }

  if (await ready()) return { exe: marker, zip: zipPath, dir }

  /*
   * 目录锁。`mkdir` 是原子操作：两个进程同时抢，只有一个成功。
   * 抢不到的转去等标记文件——等不到再抢一次，处理「持锁进程崩了」。
   *
   * 先建 ROOT：`mkdir(lock, { recursive: false })` 在父目录不存在时抛的是
   * ENOENT 而不是 EEXIST，会被下面 `error.code !== 'EEXIST'` 当成真实故障
   * 抛出去——第一次跑（缓存全空）必然撞上。
   */
  await mkdir(ROOT, { recursive: true })
  const lock = `${dir}.lock`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lock, { recursive: false })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error

      if (await waitFor(marker)) {
        if (zipPath === null || existsSync(zipPath)) return { exe: marker, zip: zipPath, dir }
      }
      // 锁还在但产物没出来：可能持锁进程已死。第二轮直接重建。
      if (attempt === 1) await rm(lock, { recursive: true, force: true })
    }
  }

  try {
    await mkdir(dir, { recursive: true })

    /*
     * 在临时目录里构建，成功后再整体改名。
     *
     * 直接往最终目录里构建的话，中途失败会留下半份产物，下次被判成
     * 「已就绪」——那正是要避免的「假缓存」。
     */
    const staging = await mkdtemp(join(tmpdir(), `m2w-fx-${kind}-`))
    try {
      const project = await makeProject(staging)
      const out = join(staging, 'out')
      const args = [
        'build', project,
        '--out', out,
        '--target', spec.target,
        '--frontend', '.',
        ...(spec.zip ? ['--also-zip'] : []),
      ]
      const result = await runCli(args)

      if (result.code !== 0) {
        const tail = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-20).join('\n')
        throw new Error(
          `构建测试样本失败（${kind}），退出码 ${String(result.code)}。\n`
            + `缺少打包工具时先装：brew install makensis sevenzip\n`
            + `--- 输出尾部 ---\n${tail}`,
        )
      }

      const produced = await readdir(out)
      const exe = produced.find((name) => name.endsWith('.exe'))
      if (exe === undefined) {
        throw new Error(`构建成功但输出目录里没有 .exe：${produced.join('、')}`)
      }

      // 逐个搬进最终目录，最后写标记文件——标记是「全部就绪」的唯一信号。
      const wanted = spec.zip
        ? [exe, exe.replace(/\.exe$/u, '.zip')]
        : [exe]
      for (const name of wanted) {
        await rename(join(out, name), join(dir, name))
      }
      await writeFile(join(dir, '.ready'), `${new Date().toISOString()}\n`)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  } finally {
    await rm(lock, { recursive: true, force: true })
  }

  return { exe: marker, zip: zipPath, dir }
}

/**
 * 32 位样本：用于「架构不符被拒」与「NSIS 外壳固定 32 位」。
 *
 * @returns {Promise<string>}
 */
export async function x86Exe() {
  return (await ensure('x86')).exe
}

/**
 * 64 位样本：用于架构自动推断。
 *
 * @returns {Promise<string>}
 */
export async function x64Exe() {
  return (await ensure('x64')).exe
}

/**
 * 64 位 zip 样本：用于「zip 不该走 PE 校验路径」。
 *
 * @returns {Promise<string>}
 */
export async function x64Zip() {
  const { zip } = await ensure('x64')
  if (zip === null) throw new Error('x64 样本应当同时产出 zip')
  return zip
}

/**
 * 造一个**控制台子系统**的 32 位 PE，纯本地构造，不联网、不打包。
 *
 * ## 为什么不能直接用 x86Exe()
 *
 * `x86Exe()` 是真实打包产物，子系统是 `windows-gui`（双击不弹黑框）。
 * 而这几条测试要守的是**相反方向**的判定：一个 `windows-console` 的
 * 程序，在要求 GUI 时必须被拒、并说清「会弹出控制台黑框」。
 *
 * 早先它们指向 `~/.wacmin/mac2win/cache/node-22.23.5-win-x86/node.exe`
 * —— 那是「先跑一次打包」才会出现的下载缓存。换台机器、换个 CI
 * runner 就没有，于是 3 项测试静默跳过。而跳过的正是「拒绝路径」
 * 的核心断言：校验器有没有真的挡住不该放行的产物。
 *
 * ## 为什么自己拼字节而不是找别的现成 exe
 *
 * PE 头只有十几个字段是判定要用的（machine / subsystem / 节区数 /
 * 入口点）。手拼一个结构合法的 PE，比找一个「恰好是 console 的 x86
 * exe」可控得多，也不受任何外部状态影响。
 *
 * @returns {Promise<string>} 文件路径
 */
export async function consolePeX86() {
  const dir = join(ROOT, 'console-x86')
  const file = join(dir, 'console-stub.exe')
  if (existsSync(file)) return file

  await mkdir(dir, { recursive: true })

  const FILE_ALIGN = 0x200
  const SECTION_ALIGN = 0x1000

  const dos = Buffer.alloc(0x80)
  dos.write('MZ', 0, 'latin1')
  dos.writeUInt32LE(0x80, 0x3c)             // e_lfanew

  const coff = Buffer.alloc(20)
  coff.writeUInt16LE(0x014c, 0)             // Machine: i386
  coff.writeUInt16LE(1, 2)                  // NumberOfSections
  coff.writeUInt16LE(224, 16)               // SizeOfOptionalHeader（PE32）
  coff.writeUInt16LE(0x0102, 18)            // EXECUTABLE_IMAGE | 32BIT_MACHINE

  const opt = Buffer.alloc(224)
  opt.writeUInt16LE(0x10b, 0)               // PE32
  opt.writeUInt32LE(0x1000, 16)             // AddressOfEntryPoint
  opt.writeUInt32LE(0x400000, 28)           // ImageBase
  opt.writeUInt32LE(SECTION_ALIGN, 32)      // SectionAlignment
  opt.writeUInt32LE(FILE_ALIGN, 36)         // FileAlignment
  opt.writeUInt32LE(SECTION_ALIGN * 2, 56)  // SizeOfImage
  opt.writeUInt32LE(FILE_ALIGN, 60)         // SizeOfHeaders
  opt.writeUInt16LE(3, 68)                  // Subsystem: windows-console

  const section = Buffer.alloc(40)
  section.write('.text', 0, 'latin1')
  section.writeUInt32LE(FILE_ALIGN, 8)      // VirtualSize
  section.writeUInt32LE(SECTION_ALIGN, 12)  // VirtualAddress
  section.writeUInt32LE(FILE_ALIGN, 16)     // SizeOfRawData
  section.writeUInt32LE(FILE_ALIGN, 20)     // PointerToRawData
  section.writeUInt32LE(0x60000020, 36)     // CODE | EXECUTE | READ

  const headers = Buffer.concat([
    dos,
    Buffer.from('PE\0\0', 'latin1'),
    coff,
    opt,
    section,
  ])
  const padded = Buffer.concat([headers, Buffer.alloc(FILE_ALIGN - headers.length)])
  // 一个 ret，凑数；判定只读头部，不执行
  const body = Buffer.alloc(FILE_ALIGN)
  body[0] = 0xc3

  await writeFile(file, Buffer.concat([padded, body]))
  return file
}

/**
 * 造一个**能被 find7zip 认作 7-Zip** 的可执行脚本。
 *
 * ## 为什么不能直接 t.skip
 *
 * `verify-honesty.test.mjs` 里有三条测试以「这台机器上没有可用的
 * 7-Zip」为由跳过。它们守的是三件很实的事：
 *
 *   1. `MAC2WIN_7ZIP` 设了就优先用（不能悄悄回落到系统里另一份）
 *   2. doctor 与 verify 用**同一个判据**（不能一个说没装、一个在用）
 *   3. doctor 报出的路径就是 verify 实际会用的那个
 *
 * 前两条在开发机上大概率不跳过（Homebrew 装了），到了干净的 CI
 * runner 上就静默变绿。跳过的是「两个判据会不会打架」——
 * 而这正是这三条测试存在的唯一理由。
 *
 * ## 假二进制为什么够用
 *
 * `probeCandidates()` 的判定只有三条：是文件、能执行 `i`、输出里同时
 * 有 `7-Zip` 与 `Formats:`。这三条与「是不是真的 7-Zip」无关——
 * 它判定的是**这个候选会被 verify 选中**。而这三条测试要验的正是
 * 「选中的那个是不是 doctor 也认的那一个」，与解包能力无关
 * （解包由 x86Exe/x64Exe 那几条真实产物测试覆盖）。
 *
 * 同一个文件里已有先例：`MAC2WIN_7ZIP 指向非 7-Zip 时明确报错`
 * 就用 `/bin/echo` 当假二进制。
 *
 * @returns {Promise<string>} 可直接赋给 MAC2WIN_7ZIP 的路径
 */
export async function fake7zip() {
  const dir = join(ROOT, 'fake-7z')
  const file = join(dir, '7zz')
  if (existsSync(file)) return file

  await mkdir(dir, { recursive: true })
  /*
   * 用 sh 脚本而不是二进制：跨机器可移植，且改动一眼看得懂。
   * 输出格式照抄真实 `7zz i` 的前两行与 Formats 段头——换版本时
   * 这两处最不容易变。
   */
  await writeFile(
    file,
    [
      '#!/bin/sh',
      'if [ "$1" = "i" ]; then',
      '  echo "7-Zip (z) 24.09 (arm64) : Copyright (c) 1999-2024 Igor Pavlov"',
      '  echo ""',
      '  echo "Formats:"',
      '  echo "  C  Crc32"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  )
  await chmod(file, 0o755)
  return file
}
