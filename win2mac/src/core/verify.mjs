/**
 * 产物校验。
 *
 * ## 在 Windows 上校验 macOS 包的边界
 *
 * 这里做的每一项都是「在 Windows 上能做到的检查」。做不到的必须明说，
 * 而不是假装做过：
 *
 * | 检查项 | Windows 上能做吗 | 说明 |
 * |---|---|---|
 * | Info.plist XML 合法性 | ✅ | 自己解析文本 |
 * | CFBundleExecutable 指向的文件存在 | ✅ | 遍历目录 |
 * | bundle 目录结构完整 | ✅ | 遍历目录 |
 * | zip 内权限位正确 | ✅ | 读中央目录 |
 * | 主可执行文件真的是 Mach-O | ✅ | 读文件头魔数 |
 * | `plutil -lint` 权威校验 | ❌ | 需要 macOS |
 * | `codesign -v` 签名校验 | ❌ | 需要 macOS |
 * | 双击真的能打开 | ❌ | 需要 macOS |
 *
 * 最后三项必须写进报告的 `warnings`，让用户知道「在 Windows 上验过」
 * 不等于「在 macOS 上一定能开」。这是诚实交付的一部分。
 */

import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { validatePlistText } from './plist.mjs'
import { LAYOUT } from './bundle.mjs'
import { readZipEntries, ZIP_MODES } from './wexezip.mjs'
import { isDirectory, isFile } from '../util/fsx.mjs'

/**
 * 单个路径分量的字节上限。
 *
 * APFS / HFS+ 都是 255 字节（UTF-8 计）。中文一字 3 字节，所以约 85 字。
 * 超过这个长度，产物解压时会失败 —— 而且失败信息往往只是「文件名过长」，
 * 用户很难联想到是应用名起太长了。
 */
const NAME_BYTES_LIMIT = 255

/** Mach-O 魔数（含 32/64 位与字节序变体，以及 universal binary）。 */
const MACHO_MAGIC = [
  0xfeedface, 0xfeedfacf,   // 小端 32/64
  0xcefaedfe, 0xcffaedfe,   // 大端 32/64
  0xcafebabe, 0xbebafeca,   // universal（fat）
]

/**
 * 检查文件是不是 Mach-O。
 *
 * 为什么要在 Windows 上查这个：Win2Mac 的产物是 macOS 应用，主可执行
 * 文件必须是 Mach-O。如果用户误把 `.exe` 或一个 shell 脚本当入口传进来，
 * 生成的包在 macOS 上双击会报「无法打开」——而且不会说明原因。
 *
 * @param {string} path
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function checkMachO(path) {
  if (!(await isFile(path))) {
    return { ok: false, detail: '文件不存在' }
  }
  let head
  try {
    head = await readFile(path)
  } catch (error) {
    return { ok: false, detail: `读取失败：${String(error)}` }
  }
  if (head.length < 4) {
    return { ok: false, detail: '文件过短' }
  }
  const magic = head.readUInt32BE(0)
  if (MACHO_MAGIC.includes(magic)) {
    return { ok: true, detail: `Mach-O（魔数 0x${magic.toString(16)}）` }
  }
  // 常见的错误入口类型，给出可操作的提示
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) {
    return { ok: false, detail: '这是 Windows PE 文件（MZ 头），不是 Mach-O' }
  }
  if (head.length >= 4 && head.readUInt32BE(0) === 0x7f454c46) {
    return { ok: false, detail: '这是 Linux ELF 文件，不是 Mach-O' }
  }
  if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) {
    return { ok: false, detail: '这是脚本（#! 开头），不是 Mach-O 可执行文件' }
  }
  return { ok: false, detail: `未知格式（魔数 0x${magic.toString(16)}）` }
}

/**
 * 从 plist 文本里取一个字符串键的值。
 *
 * 不引入 XML 解析器：plist 的结构固定，用正则在 `<key>X</key>` 之后
 * 找紧邻的 `<string>...</string>` 已经足够。取不到时返回 null，
 * 由调用方判定是「键不存在」还是「值类型不对」。
 *
 * @param {string} text
 * @param {string} key
 * @returns {string | null}
 */
export function plistString(text, key) {
  const pattern = new RegExp(
    `<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`, 'u')
  const match = pattern.exec(text)
  if (match === null) return null
  return match[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * 在 macOS 上调用 `plutil -lint` 做权威校验。
 *
 * 这是唯一能真正判断 plist 是否合法的办法 —— 自己写的文本检查只能
 * 抓明显的错（标签不成对、裸 `&`），抓不到「值类型不对」「DTD 不符」
 * 这类问题。
 *
 * 非 macOS 平台直接返回 `{available: false}`，由调用方降级为文本检查。
 *
 * @param {string} plistPath
 * @returns {Promise<{available: boolean, ok: boolean, detail: string}>}
 */
export async function plutilLint(plistPath) {
  if (process.platform !== 'darwin') {
    return { available: false, ok: true, detail: '非 macOS，跳过 plutil 校验' }
  }
  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    execFile('plutil', ['-lint', plistPath], { timeout: 15000 },
      (error, stdout, stderr) => {
        if (error !== null && error.code === 'ENOENT') {
          resolve({ available: false, ok: true, detail: 'plutil 不可用' })
          return
        }
        const text = `${String(stdout)}${String(stderr)}`.trim()
        resolve({
          available: true,
          ok: error === null,
          detail: text,
        })
      })
  })
}

/**
 * 校验一个 `.app` 目录。
 *
 * @param {string} appDir
 * @returns {Promise<{ok: boolean, checks: Array<object>, warnings: string[]}>}
 */
export async function verifyBundle(appDir) {
  const checks = []
  const warnings = []

  const add = (name, ok, detail = '') => {
    checks.push({ name, ok, detail })
    return ok
  }

  // ① 目录本身
  add('bundle.is_app',
    (await isDirectory(appDir)) && appDir.endsWith('.app'),
    (await isDirectory(appDir)) ? '' : `不是目录：${appDir}`)

  // ② Info.plist 存在且合法
  const plistPath = join(appDir, LAYOUT.plist)
  let plistText = null
  if (!(await isFile(plistPath))) {
    add('plist.exists', false, `缺少 ${plistPath}`)
  } else {
    try {
      plistText = await readFile(plistPath, 'utf8')
    } catch (error) {
      add('plist.readable', false, String(error))
    }
    if (plistText !== null) {
      const problems = validatePlistText(plistText)
      add('plist.valid', problems.length === 0, problems.join('；'))

      /*
       * macOS 上再跑一次 plutil 做权威校验。
       *
       * 文本检查只能抓明显错误；plutil 会真正按 DTD 解析，能发现
       * 「值类型不对」「必需键缺失」这类文本层面看不出的问题。
       * 在 macOS 上开发时这一步能把问题提前暴露，而不是等用户双击。
       */
      const lint = await plutilLint(plistPath)
      if (lint.available) {
        add('plist.plutil', lint.ok, lint.detail)
      } else {
        warnings.push('未做 plutil 权威校验（' + lint.detail + '），仅文本级检查')
      }
    }
  }

  // ③ 必含键
  if (plistText !== null) {
    const required = [
      'CFBundleName', 'CFBundleDisplayName', 'CFBundleIdentifier',
      'CFBundleExecutable', 'CFBundlePackageType', 'CFBundleIconFile',
      'CFBundleShortVersionString', 'CFBundleVersion',
      'LSMinimumSystemVersion',
    ]
    const missing = required.filter((key) => plistString(plistText, key) === null)
    add('plist.required_keys', missing.length === 0,
      missing.length === 0 ? '' : `缺少：${missing.join(', ')}`)

    // ④ 不能设 LSUIElement / LSBackgroundOnly：设了就没有 Dock 图标
    const hidden = ['LSUIElement', 'LSBackgroundOnly']
      .filter((key) => plistText.includes(`<key>${key}</key>`))
    add('plist.visible_in_dock', hidden.length === 0,
      hidden.length === 0 ? '' : `不应设置：${hidden.join(', ')}`)

    // ⑤ CFBundleExecutable 指向的文件存在，且是 Mach-O
    const executableName = plistString(plistText, 'CFBundleExecutable') ?? 'launcher'
    const executablePath = join(appDir, LAYOUT.macos, executableName)
    add('bundle.executable', await isFile(executablePath),
      (await isFile(executablePath)) ? '' : `缺少可执行文件：${executablePath}`)

    if (await isFile(executablePath)) {
      const macho = await checkMachO(executablePath)
      /*
       * 主可执行文件不是 Mach-O 时**只警告不失败**。
       *
       * 理由：某些合法场景下入口不是 Mach-O —— 例如一个 shell 脚本
       * 包装器（`#!/bin/sh` 后调别的东西）。这种包在 macOS 上确实能跑。
       * 真正的硬失败留给「文件不存在」。
       */
      if (!macho.ok) {
        warnings.push(
          `主可执行文件不是 Mach-O（${macho.detail}）。` +
          'macOS 上双击可能无法打开，请确认这是有意为之。')
      }
    }
  }

  // ⑥ 图标
  const iconPath = join(appDir, LAYOUT.icon)
  if (!(await isFile(iconPath))) {
    // 缺图标不失败，只警告：没有图标的应用仍能运行
    warnings.push('缺少 AppIcon.icns，Dock 里会显示系统默认图标')
  }
  add('bundle.icon', true, (await isFile(iconPath)) ? '' : '使用系统默认图标')

  // ⑦ PkgInfo
  add('bundle.pkginfo', await isFile(join(appDir, LAYOUT.pkgInfo)),
    (await isFile(join(appDir, LAYOUT.pkgInfo))) ? '' : '缺少 PkgInfo（不影响运行）')

  /*
   * ⑦b zip 内条目名的长度。
   *
   * 这一项来自一个真实故障：90 个汉字的应用名（270 字节）能打包成功、
   * 报告「构建完成」，但 zip 里的条目名达到 290 字节，超过文件系统的
   * 255 字节上限 —— 产物根本解不开，是彻底的废包。
   *
   * 判断对象是**最长的内部条目**，不是应用名本身：
   *
   *   <名称> (Mac).app/Contents/MacOS/launcher   ← 最长，多 34 字节
   *
   * 所以应用名上限是 221 字节（约 73 个汉字），不是 255。
   */
  const dirName = basename(appDir)
  const longestEntry = `${dirName}/Contents/MacOS/launcher`
  const entryBytes = Buffer.byteLength(longestEntry, 'utf8')
  add('bundle.name_length', entryBytes <= NAME_BYTES_LIMIT,
    entryBytes <= NAME_BYTES_LIMIT
      ? ''
      : `应用名 ${Buffer.byteLength(dirName, 'utf8')} 字节，` +
        `内部条目名达 ${entryBytes} 字节（上限 ${NAME_BYTES_LIMIT}），解压会失败。` +
        '请缩短名称（中文约 70 字以内）')

  /*
   * ⑦c 符号链接不得逃出 bundle。
   *
   * .app 里的软链是正常结构（Framework 的 Versions/Current、别名等），
   * 但指向 bundle 之外的绝对路径就不对了：
   *
   *   Contents/Resources/escape -> /etc
   *
   * 这类包在 macOS 上能跑，但换一台机器就断链 —— 因为目标路径不存在。
   * 更麻烦的是打包时软链会被原样写进 zip，用户在别的机器上解压后得到
   * 一堆死链，而程序可能就靠这些链找资源。
   *
   * 只检查绝对路径与 `..` 逃逸两种情况。指向 bundle 内部的相对软链是
   * 合法的（Framework 就是这么组织的），不能一概拦。
   */
  const escapes = []
  for (const relative of await walkSymlinks(appDir)) {
    const rawTarget = await readlink(join(appDir, relative)).catch(() => null)
    if (rawTarget === null) continue

    /*
     * 软链目标是 POSIX 语义，必须先归一化。
     *
     * `.app` 里的软链目标永远是 macOS 上的路径，但校验可能跑在 Windows
     * 上。Windows 的 `symlink()` 会把 `/usr/lib/libSystem.B.dylib` 这样的
     * 目标转成 `D:\usr\lib\libSystem.B.dylib`，`readlink` 再原样返回。
     * 于是下面那句 `startsWith('/')` 判不出来，绝对路径被当成相对路径，
     * 解开后自然「跑出 bundle」——一个合法的系统库引用被误判成逃逸。
     *
     * 归一化规则：去掉盘符前缀、反斜杠转正斜杠。只做这两件事，不碰
     * `..`（相对路径的逃逸判定必须保留原始语义）。
     */
    const target = normalizeLinkTarget(rawTarget)

    /*
     * 绝对路径一律可疑：即便它现在指向 bundle 内部，换台机器路径就变了。
     * 例外是 `/usr/lib/...` 这类系统库 —— 那是系统提供的，不该算逃逸。
     */
    if (target.startsWith('/')) {
      if (!target.startsWith('/usr/lib/') && !target.startsWith('/System/')) {
        escapes.push(`${relative} → ${target}（绝对路径）`)
      }
      continue
    }

    // 相对路径：解开后若跑出 bundle 根就是逃逸
    const resolved = resolve(dirname(join(appDir, relative)), target)
    if (!resolved.startsWith(appDir + sep) && resolved !== appDir) {
      escapes.push(`${relative} → ${target}（跑出 bundle）`)
    }
  }

  add('bundle.symlink_contained', escapes.length === 0,
    escapes.length === 0
      ? ''
      : `${String(escapes.length)} 个软链指向 bundle 之外，换机器会断链。` +
        `例：${escapes.slice(0, 2).join('；')}`)

  // ⑧ 平台边界说明：在 Windows 上验不了的东西必须写出来
  if (process.platform === 'darwin') {
    warnings.push(
      'plutil 校验已执行；codesign 与实际双击仍未验证。' +
      '最终以 Finder 里打开一次为准。')
  } else {
    warnings.push(
      '本次校验在 ' + process.platform + ' 上完成，' +
      'plutil / codesign / 实际双击均未验证。' +
      '最终以 macOS 上打开一次为准。')
  }

  const ok = checks.every((check) => check.ok)
  return { ok, checks, warnings }
}

/**
 * 把软链目标归一化成 POSIX 形式，供包含性判定使用。
 *
 * 为什么需要这一步：`.app` 的软链目标在语义上永远是 macOS 路径，但
 * `win2mac` 会跑在 Windows 上，而 Windows 的 `symlink()` 会把 POSIX
 * 绝对路径解释成「当前盘符下的路径」，`readlink` 返回的就是
 * `D:\usr\lib\libSystem.B.dylib` 这种形态。不归一化的话：
 *
 *   - `target.startsWith('/')` 为 false → 绝对路径被当成相对路径
 *   - 相对路径分支用 `path.resolve` 解 → 得到 `D:\usr\lib\...`
 *   - 它当然不在 bundle 内 → 被判成逃逸
 *
 * 结果是一个完全合法的系统库引用被误报为「换机器会断链」。
 *
 * 归一化只做两件事：删盘符、反斜杠转正斜杠。**不动 `..`** —— 相对
 * 路径的逃逸判定必须保留原始语义，把 `..` 提前折叠会掩盖真实越界。
 *
 * @param {string} target
 * @returns {string}
 */
function normalizeLinkTarget(target) {
  // 盘符前缀：`C:\...` / `D:/...`
  let out = target.replace(/^[A-Za-z]:/, '')
  /*
   * 反斜杠一律转正斜杠。Windows 上 POSIX 绝对路径被解析成
   * `\usr\lib\...`（无盘符）时，这一步会得到 `/usr/lib/...`。
   */
  out = out.replace(/\\/g, '/')
  /*
   * 无盘符的情况：`\usr\lib\x` 转换后是 `/usr/lib/x`，已经正确。
   * 但若原串既无盘符也不以 / 或 \ 开头，说明本来就是相对路径，
   * 转换后不该凭空多出前导斜杠 —— 上面的 replace 不会加斜杠，安全。
   */
  return out
}

/**
 * 列出目录树里所有符号链接的相对路径。
 *
 * 与 `walkFiles` 的区别：那个跳过软链（把它们当文件或目录处理），
 * 这里只要软链本身。用 lstat 而不是 stat —— stat 会跟进去，拿到的
 * 是目标的信息，就认不出这是个链接了。
 *
 * 不递归进软链：链接可能指向任意位置，跟进去会无限深。
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function walkSymlinks(root) {
  /** @type {string[]} */
  const out = []
  /** @type {string[]} */
  const queue = ['']

  while (queue.length > 0) {
    const relative = queue.shift()
    const absolute = relative === '' ? root : join(root, relative)

    let info
    try {
      info = await lstat(absolute)
    } catch {
      continue
    }

    if (relative !== '') {
      if (info.isSymbolicLink()) {
        out.push(relative)
        continue
      }
      if (!info.isDirectory()) continue
    }

    let children
    try {
      children = await readdir(absolute)
    } catch {
      continue
    }
    for (const child of children) {
      queue.push(relative === '' ? child : `${relative}/${child}`)
    }
  }
  return out
}

/**
 * 校验一个已打好的 zip。
 *
 * 重点检查 zip 里的权限位 —— 这是本方向最容易出错、也最难排查的地方。
 * 权限不对的包在 macOS 上表现为「无法打开」，完全不会提示是权限问题。
 *
 * @param {string} zipPath
 * @param {string} [appDirName] 包内顶层目录名，用于定位主可执行文件。
 * @returns {Promise<{ok: boolean, checks: Array<object>, warnings: string[]}>}
 */
export async function verifyZip(zipPath, appDirName) {
  const checks = []
  const warnings = []
  const add = (name, ok, detail = '') => {
    checks.push({ name, ok, detail })
    return ok
  }

  if (!(await isFile(zipPath))) {
    add('zip.exists', false, `文件不存在：${zipPath}`)
    return { ok: false, checks, warnings }
  }

  let entries
  try {
    entries = await readZipEntries(zipPath)
  } catch (error) {
    add('zip.readable', false, String(error))
    return { ok: false, checks, warnings }
  }

  add('zip.readable', true, `${String(entries.length)} 个条目`)

  if (entries.length === 0) {
    add('zip.nonempty', false, 'zip 里没有任何条目')
    return { ok: false, checks, warnings }
  }

  /*
   * zip 条目名长度 —— 这里查的是**真实数据**，不是估算。
   *
   * 为什么必须查真实条目：条目名 = 应用名 + ` (Mac).app/Contents/` +
   * 载荷内的相对路径。最后一段完全由用户的载荷决定，打包前无从得知。
   *
   * 实测案例：73 个汉字的应用名，加 ` (Mac).app/Contents/Resources/app/package.json`
   * 后达到 265 字节，超过 255 上限 —— 这种包解压会失败，而打包过程
   * 不报任何错。
   *
   * 打包前只能按保守值预警（见 builder.mjs），打包后这里才是权威判断。
   */
  const overlong = entries
    .map((entry) => ({ name: entry.name, bytes: Buffer.byteLength(entry.name, 'utf8') }))
    .filter((item) => item.bytes > NAME_BYTES_LIMIT)

  add('zip.entry_name_length', overlong.length === 0,
    overlong.length === 0
      ? ''
      : `${String(overlong.length)} 个条目名超过 ${String(NAME_BYTES_LIMIT)} 字节` +
        `（最长 ${String(Math.max(...overlong.map((i) => i.bytes)))} 字节），解压会失败。` +
        `例：${overlong[0].name.slice(-50)}`)

  /*
   * 顶层目录必须只有一个，且以 .app 结尾。
   *
   * 用户解开 zip 时应该得到一个 `.app` 而不是一堆散文件 —— 否则解压到
   * 桌面就污染了，而且 `.app` 脱离父目录后可能失去 bundle 语义。
   */
  const tops = new Set(entries.map((entry) => entry.name.split('/')[0]))
  add('zip.single_root', tops.size === 1,
    tops.size === 1 ? '' : `顶层有 ${String(tops.size)} 个目录：${[...tops].join(', ')}`)

  const rootName = [...tops][0] ?? ''
  add('zip.is_app_root', rootName.endsWith('.app'),
    rootName.endsWith('.app') ? '' : `顶层目录不是 .app：${rootName}`)

  // 权限位：所有目录必须是 0755 或更宽，MacOS/ 下必须是可执行
  const dirs = entries.filter((entry) => entry.isDir)
  const badDirs = dirs.filter((entry) => (entry.mode & 0o111) === 0)
  add('zip.dir_modes', badDirs.length === 0,
    badDirs.length === 0 ? '' : `${String(badDirs.length)} 个目录不可进入，如 ${badDirs[0]?.name ?? ''}`)

  const macosEntries = entries.filter((entry) =>
    entry.name.includes('/Contents/MacOS/') && !entry.isDir && !entry.isSymlink)
  const nonExecutable = macosEntries.filter((entry) => (entry.mode & 0o111) === 0)
  add('zip.executable_modes', nonExecutable.length === 0,
    nonExecutable.length === 0
      ? ''
      : `${String(nonExecutable.length)} 个可执行文件权限不足，如 ${nonExecutable[0]?.name ?? ''}`)

  /*
   * 单独强调「主可执行文件可执行」。
   *
   * 上一条已经覆盖了，但这一条是 .app 能否双击打开的**唯一决定因素**，
   * 值得单独列出来 —— 失败时用户一眼能看到是哪一项。
   */
  if (appDirName !== undefined) {
    const executableName = await guessExecutableFromZip(zipPath, appDirName)
    if (executableName !== null) {
      const target = `${appDirName}/Contents/MacOS/${executableName}`
      const entry = entries.find((item) => item.name === target)
      add('zip.main_executable',
        entry !== undefined && (entry.mode & 0o111) !== 0,
        entry === undefined
          ? `找不到 ${target}`
          : `mode ${(entry.mode & 0o777).toString(8)}`)
    }
  }

  warnings.push(
    'zip 权限位校验只保证「解压后 mode 正确」，' +
    '不代表 macOS 上一定能打开（还需 Gatekeeper 放行未签名应用）。')

  const ok = checks.every((check) => check.ok)
  return { ok, checks, warnings }
}

/**
 * 从 zip 里的 Info.plist 读出 CFBundleExecutable。
 *
 * 需要解压那一个文件，所以单独实现：只读它的本地文件头与数据，
 * 不把整个 zip 展开。
 *
 * @param {string} zipPath
 * @param {string} appDirName
 * @returns {Promise<string | null>}
 */
async function guessExecutableFromZip(zipPath, appDirName) {
  const buffer = await readFile(zipPath)
  const target = `${appDirName}/Contents/Info.plist`

  let cursor = 0
  while (cursor + 30 <= buffer.length) {
    if (buffer.readUInt32LE(cursor) !== 0x04034b50) break
    const method = buffer.readUInt16LE(cursor + 8)
    const compressedSize = buffer.readUInt32LE(cursor + 18)
    const nameLength = buffer.readUInt16LE(cursor + 26)
    const extraLength = buffer.readUInt16LE(cursor + 28)
    const name = buffer.toString('utf8', cursor + 30, cursor + 30 + nameLength)
    const dataStart = cursor + 30 + nameLength + extraLength

    if (name === target) {
      const payload = buffer.subarray(dataStart, dataStart + compressedSize)
      let text
      if (method === 0) {
        text = payload.toString('utf8')
      } else {
        const { inflateRawSync } = await import('node:zlib')
        text = inflateRawSync(payload).toString('utf8')
      }
      return plistString(text, 'CFBundleExecutable')
    }
    cursor = dataStart + compressedSize
  }
  return null
}

/**
 * 导出模式常量与软链目标归一化函数，供测试断言用。
 *
 * `normalizeLinkTarget` 本来只是内部实现细节，导出它是因为它修的缺陷
 * 在 macOS 上无法复现 —— Windows 的 `readlink` 才返回带盘符的路径。
 * 不导出就只能靠 Windows runner 验证，本机永远测不到。
 */
export { ZIP_MODES, normalizeLinkTarget }