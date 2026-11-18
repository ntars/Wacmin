/**
 * `.app` 目录装配。
 *
 * ## 产物结构（与 exeonmac 完全一致）
 *
 * ```
 * {App} (Mac).app/
 * └── Contents/
 *     ├── Info.plist
 *     ├── PkgInfo                  APPL????
 *     ├── MacOS/
 *     │   └── <CFBundleExecutable> 0755
 *     ├── Resources/
 *     │   ├── AppIcon.icns         （有图标时）
 *     │   └── app/                 应用本体
 *     └── Frameworks/              （Electron 等需要时）
 * ```
 *
 * ## 为什么要在 Windows 上造目录再打包
 *
 * 有两种做法：
 *
 *   A. 先在本地产出完整 `.app` 目录，再整目录压成 zip
 *   B. 边读源文件边往 zip 里写，不落中间目录
 *
 * 选 A。理由是可验证性：`.app` 目录在磁盘上时，`verify` 可以直接
 * 遍历它检查结构；用户也能在打包失败后进去看半成品到底缺什么。
 * 做法 B 只在内存/流里过一遍，出错时什么线索都不留。
 *
 * 代价是磁盘上要多占一份产物大小的空间，但这个量级（几十到几百 MB）
 * 对桌面工具完全可接受。
 */

import { mkdir, writeFile, copyFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { buildPlist, serializePlist, validatePlistText } from './plist.mjs'
import { copyTree, isDirectory, isFile } from '../util/fsx.mjs'

/** 包内目录名。改布局只改这里。 */
export const LAYOUT = {
  contents: 'Contents',
  macos: 'Contents/MacOS',
  resources: 'Contents/Resources',
  frameworks: 'Contents/Frameworks',
  appPayload: 'Contents/Resources/app',
  plist: 'Contents/Info.plist',
  pkgInfo: 'Contents/PkgInfo',
  icon: 'Contents/Resources/AppIcon.icns',
}

/**
 * 生成 `.app` 的目录名。
 *
 * 名字里的 `/` 与 `:` 必须替换 —— macOS 上 `:` 在 Finder 里显示成 `/`，
 * 两者混用会让同一个包在命令行与 Finder 里叫两个名字。
 *
 * @param {string} appName
 * @returns {string}
 */
export function bundleDirName(appName) {
  const safe = String(appName).replace(/[/:]/g, '-').trim()
  return `${safe === '' ? 'App' : safe} (Mac).app`
}

/**
 * 目录名可用的字节预算。
 *
 * 为什么是 165 而不是 255：
 *
 * zip 内的条目名是 `<目录名>/Contents/Resources/<载荷路径>`，目录名之外
 * 的部分至少占 30 字节（` (Mac).app/Contents/Resources/`），载荷里再
 * 常见几层目录就 50~60 字节。留 90 字节给这两段，目录名可用 165 字节。
 *
 * 这个值不追求精确 —— 精确判断在打包后的 verifyZip（读真实条目名）。
 * 这里的目标是「让绝大多数合理名字都能通过，同时不产出必然解不开的包」。
 */
export const MAX_DIR_NAME_BYTES = 165

/**
 * 把应用名压到目录名字节上限内。
 *
 * **按码点截断，不按字节切** —— 直接 `Buffer.subarray` 会把汉字切成
 * 半个字（UTF-8 三字节里的前一两字节），产出非法文件名。
 *
 * 超长时截断而不报错：用户输入一个长名字，得到一个能用的包并附带
 * 「名称已截断」的警告，比直接失败更实用。真要说「必须完整保留名字」，
 * 那是用户该自己缩短的事。
 *
 * @param {string} appName
 * @returns {{name: string, truncated: boolean, bytes: number}}
 */
export function fitDirName(appName) {
  const full = String(appName).replace(/[/:]/g, '-').trim()
  const bytes = Buffer.byteLength(full, 'utf8')
  if (bytes <= MAX_DIR_NAME_BYTES) {
    return { name: full, truncated: false, bytes }
  }

  // 按码点累加，到预算就停 —— 保证不会切出半个字
  let used = 0
  let out = ''
  for (const char of full) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > MAX_DIR_NAME_BYTES) break
    out += char
    used += size
  }
  return { name: out, truncated: true, bytes: used }
}

/**
 * 建出 `.app` 的目录骨架。幂等。
 *
 * @param {string} appDir
 * @returns {Promise<Record<string, string>>} 关键路径。
 */
export async function ensureSkeleton(appDir) {
  const paths = {
    root: appDir,
    contents: join(appDir, LAYOUT.contents),
    macos: join(appDir, LAYOUT.macos),
    resources: join(appDir, LAYOUT.resources),
    frameworks: join(appDir, LAYOUT.frameworks),
    appPayload: join(appDir, LAYOUT.appPayload),
  }
  for (const path of Object.values(paths)) {
    await mkdir(path, { recursive: true })
  }
  return paths
}

/**
 * 写 `Info.plist`。
 *
 * @param {string} appDir
 * @param {object} options 见 {@link buildPlist}。
 * @returns {Promise<{path: string, document: Record<string, unknown>}>}
 */
export async function writeInfoPlist(appDir, options) {
  const document = buildPlist(options)
  const text = serializePlist(document)

  /*
   * 写之前先在本地校验。Windows 上没有 plutil，这是唯一的防线。
   * 一旦产出非法 plist，macOS 的反应是「应用已损坏」，用户完全
   * 无从知道是哪个字段出的问题。
   */
  const problems = validatePlistText(text)
  if (problems.length > 0) {
    throw new Error(`生成的 Info.plist 不合法：${problems.join('；')}`)
  }

  const target = join(appDir, LAYOUT.plist)
  await writeFile(target, text, 'utf8')
  return { path: target, document }
}

/**
 * 写 `PkgInfo`。
 *
 * 内容固定为 `APPL????`（8 字节，不带换行）。老工具会读它判断包类型，
 * 新系统不看，但写了没有坏处，且能避免某些第三方工具报「包不完整」。
 *
 * @param {string} appDir
 */
export async function writePkgInfo(appDir) {
  const target = join(appDir, LAYOUT.pkgInfo)
  await writeFile(target, 'APPL????', 'latin1')
  return target
}

/**
 * 把一个可执行文件放进 `Contents/MacOS/`。
 *
 * 权限由打包阶段统一处理（`wexezip` 会按 `Contents/MacOS/` 前缀给 0755），
 * 这里只负责把文件放对位置。
 *
 * @param {string} appDir
 * @param {string} source 源可执行文件。
 * @param {string} [name] 包内文件名，默认取源文件名。
 * @returns {Promise<string>} 包内相对路径。
 */
export async function installExecutable(appDir, source, name) {
  if (!(await isFile(source))) {
    throw new Error(`可执行文件不存在：${source}`)
  }
  const targetName = name ?? basename(source)
  const target = join(appDir, LAYOUT.macos, targetName)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
  return `${LAYOUT.macos}/${targetName}`
}

/**
 * 把应用本体放进 `Contents/Resources/app/`。
 *
 * @param {string} appDir
 * @param {string} source 源目录或文件。
 * @param {string} [subPath] 在 `app/` 下的相对路径，默认铺在根。
 * @param {string[]} [excludePaths] 要整体跳过的绝对路径（如输出目录本身）。
 * @returns {Promise<{files: number, bytes: number}>}
 */
export async function installPayload(appDir, source, subPath = '', excludePaths = []) {
  const target = subPath === ''
    ? join(appDir, LAYOUT.appPayload)
    : join(appDir, LAYOUT.appPayload, subPath)

  if (await isDirectory(source)) {
    await mkdir(target, { recursive: true })
    const result = await copyTree(source, target, { excludePaths })
    return { files: result.files, bytes: result.bytes }
  }
  if (await isFile(source)) {
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
    const info = await stat(target)
    return { files: 1, bytes: info.size }
  }
  throw new Error(`应用本体不存在：${source}`)
}

/**
 * 放图标。源文件必须是 `.icns`。
 *
 * 在 Windows 上无法把 `.ico` / `.png` 转成 `.icns`（需要 `iconutil`），
 * 所以只接受已经准备好的 `.icns`。没有图标也能打包，只是 Dock 里
 * 显示系统默认图标。
 *
 * @param {string} appDir
 * @param {string | null} icnsPath
 * @returns {Promise<string | null>} 写入的路径，未提供时返回 null。
 */
export async function installIcon(appDir, icnsPath) {
  if (icnsPath === null || icnsPath === undefined) return null
  if (!(await isFile(icnsPath))) {
    throw new Error(`图标文件不存在：${icnsPath}`)
  }
  if (!icnsPath.toLowerCase().endsWith('.icns')) {
    throw new Error(
      `图标必须是 .icns：${icnsPath}\n` +
      '在 Windows 上无法把 .ico / .png 转成 .icns（需要 macOS 的 iconutil）。\n' +
      '请先准备好 .icns，或用 --no-icon 跳过图标。',
    )
  }
  const target = join(appDir, LAYOUT.icon)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(icnsPath, target)
  return target
}

/**
 * 一站式装配。
 *
 * @param {object} input
 * @param {string} input.appDir 目标 `.app` 目录。
 * @param {string} input.appName
 * @param {string} input.bundleId
 * @param {string} input.version
 * @param {string} input.executable 源可执行文件路径。
 * @param {string} [input.executableName] 包内文件名。
 * @param {string} input.payload 应用本体（目录或文件）。
 * @param {string} [input.iconPath] `.icns` 路径。
 * @param {string[]} [input.fileAssociations]
 * @returns {Promise<{paths: object, plist: object, files: number, bytes: number}>}
 */
export async function assembleBundle(input) {
  const paths = await ensureSkeleton(input.appDir)

  const executableName = input.executableName ?? basename(input.executable)
  const relativeExecutable = await installExecutable(
    input.appDir, input.executable, executableName)

  const plist = await writeInfoPlist(input.appDir, {
    appName: input.appName,
    bundleId: input.bundleId,
    version: input.version,
    executable: executableName,
    fileAssociations: input.fileAssociations,
    minMacOS: input.minMacOS,
    category: input.category,
  })

  await writePkgInfo(input.appDir)

  const payload = await installPayload(
    input.appDir, input.payload, '', input.payloadExcludes ?? [])
  const icon = await installIcon(input.appDir, input.iconPath ?? null)

  return {
    paths: { ...paths, executable: relativeExecutable, icon },
    plist,
    files: payload.files,
    bytes: payload.bytes,
  }
}

/**
 * 列出 `.app` 目录的完整结构，供 `--dry-run` 与调试用。
 *
 * @param {string} appDir
 * @param {number} [limit] 最多返回多少项。
 * @returns {Promise<string[]>}
 */
export async function describeBundle(appDir, limit = 200) {
  const out = []
  const queue = ['']
  while (queue.length > 0 && out.length < limit) {
    const relative = queue.shift()
    const absolute = relative === '' ? appDir : join(appDir, relative)
    if (!existsSync(absolute)) continue
    const children = await readdir(absolute, { withFileTypes: true })
    for (const child of children) {
      const childRelative = relative === '' ? child.name : `${relative}/${child.name}`
      out.push(child.isDirectory() ? `${childRelative}/` : childRelative)
      if (child.isDirectory() && !child.isSymbolicLink()) queue.push(childRelative)
      if (out.length >= limit) break
    }
  }
  return out
}