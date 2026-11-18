/**
 * 构建编排：八个阶段串起来。
 *
 * ## 阶段划分
 *
 * 与 mac2win 的八阶段一一对应，只把「Windows 安装包」换成「macOS 应用包」。
 * 两个方向都是「把项目打成一个对端能装的东西」，流程本来就同构，因此
 * console 可以用同一套阶段图渲染两个方向。
 *
 * ```
 * preflight   → 环境与输入检查
 * project-build → 跑项目自己的构建（可选）
 * runtime     → 准备目标架构的运行时（Electron / Node）
 * collect     → 收集依赖与产物
 * stage       → 暂存文件到 .app 结构
 * manifest    → 生成 Info.plist / PkgInfo
 * package     → 打成 zip（保留权限位）
 * verify      → 校验产物
 * ```
 *
 * ## 与 mac2win 的关键差异
 *
 * mac2win 产出 `.exe`（NSIS），Windows 上双击即用，权限位无意义。
 * win2mac 产出 `.app`，它是**可执行目录**，权限位决定能否双击打开。
 * 因此 `package` 阶段必须用 `wexezip`（保留 Unix mode）而不是
 * mac2win 的 `zipwriter`。
 */

import { mkdir, readFile } from 'node:fs/promises'
import { join, basename, resolve, isAbsolute, relative } from 'node:path'
import { BuildError, ErrorCode } from './errors.mjs'
import { assembleBundle, bundleDirName, fitDirName } from './bundle.mjs'
import { makeBundleId } from './plist.mjs'
import { zipBundle } from './wexezip.mjs'
import { verifyBundle, verifyZip } from './verify.mjs'
import { isDirectory, isFile, measureTree, remove } from '../util/fsx.mjs'

/**
 * 执行完整构建。
 *
 * @param {object} input
 * @param {string} input.projectRoot 项目目录。
 * @param {string} input.outDir 输出目录。
 * @param {string} input.appName 应用名。
 * @param {string} [input.version] 版本号。
 * @param {string} [input.executable] 主可执行文件路径（相对项目根或绝对）。
 * @param {string} [input.payload] 应用本体（相对项目根或绝对），默认整个项目。
 * @param {string} [input.icon] `.icns` 路径。
 * @param {string} [input.bundleId] 显式指定 bundle id。
 * @param {string} [input.vendor] 厂商反向域名片段。
 * @param {boolean} [input.noVerify] 跳过产物校验。
 * @param {boolean} [input.keepWork] 保留中间 `.app` 目录。
 * @param {object} input.tracker StageTracker 实例。
 * @param {(message: string) => void} [input.onProgress]
 * @returns {Promise<{artifact: string, appDir: string, appName: string, bundleId: string, bytes: number, files: number}>}
 */
export async function runBuild(input) {
  const { tracker, onProgress } = input
  const projectRoot = resolve(input.projectRoot)
  const outDir = resolve(input.outDir)

  // ── preflight ──────────────────────────────────────────────────────────
  tracker.enter('preflight')

  if (!(await isDirectory(projectRoot))) {
    throw new BuildError(ErrorCode.INPUT_NOT_FOUND,
      `项目目录不存在：${projectRoot}`,
      { hint: '确认路径是否正确；这是目录不是文件' })
  }

  const appName = String(input.appName ?? basename(projectRoot)).trim() || 'App'

  /*
   * 应用名过长时**自动截断**，不报错。
   *
   * 真实的长度上限取决于载荷内最长的相对路径，打包前无从得知：
   *
   *   <应用名> (Mac).app/Contents/Resources/app/<载荷路径>
   *                                    └─ 这段由用户项目决定
   *
   * 所以策略是两层：
   *   1. 打包前按保守值截断（这里），保证绝大多数情况能出包
   *   2. 打包后 verifyZip 读真实条目名做权威判断，超限则整体失败
   *
   * 截断而不报错的理由：用户输入一个长名字，得到一个能用的包并附带
   * 警告，比直接失败更实用。按码点截断，不会切出半个汉字。
   */
  const fitted = fitDirName(appName)
  const finalAppName = fitted.truncated ? fitted.name : appName
  const preflightWarnings = []
  if (fitted.truncated) {
    preflightWarnings.push(
      `应用名过长（${String(Buffer.byteLength(appName, 'utf8'))} 字节），` +
      `已截断为「${fitted.name}」。` +
      '文件系统单个名称上限 255 字节，zip 条目名还要拼上目录结构。')
  }

  const executablePath = resolvePath(projectRoot, input.executable)
  if (executablePath === null) {
    throw new BuildError(ErrorCode.CONFIG_MISSING,
      '缺少主可执行文件（--executable）',
      {
        hint: 'macOS 应用包必须有一个 Mach-O 入口，例如 --executable dist/app',
        details: ['Win2Mac 不会替你编译 macOS 二进制 —— 那需要 macOS 工具链。'],
      })
  }
  if (!(await isFile(executablePath))) {
    throw new BuildError(ErrorCode.INPUT_NOT_FOUND,
      `主可执行文件不存在：${executablePath}`,
      { hint: '先构建出 macOS 产物，再用 --executable 指向它' })
  }

  /*
   * 指到 Windows PE 或 Linux ELF 时直接拒绝（退出码 4，明确不支持）。
   *
   * 这不是「路径写错」，也不是「文件缺了」：文件好端端在那儿，类型根本
   * 不对。Wacmin 的四方向矩阵里，Windows 的可执行文件由 Mac2Win /
   * ExeOnMac 处理，Win2Mac 只装配 macOS 包。塞一个 .exe 进来当
   * CFBundleExecutable，产物在 macOS 上必然打不开，而且错误会推迟到
   * 用户双击那一刻才出现 —— 那时离构建现场已经很远了。
   *
   * 在入口处说清楚，比让用户拿到一个坏包再回头排查有用得多。
   */
  const execHead = await readFile(executablePath).then(
    (buf) => buf.subarray(0, 4), () => null)
  if (execHead !== null && execHead.length >= 2) {
    const beMagic = execHead.length >= 4 ? execHead.readUInt32BE(0) : 0
    const isPE = execHead[0] === 0x4d && execHead[1] === 0x5a          // "MZ"
    const isELF = beMagic === 0x7f454c46                                // "\x7fELF"
    if (isPE || isELF) {
      throw new BuildError(ErrorCode.UNSUPPORTED,
        `主可执行文件是 ${isPE ? 'Windows PE（MZ 头）' : 'Linux ELF'}，不是 macOS 的 Mach-O`,
        {
          hint: 'Win2Mac 只装配 macOS 应用包，不做跨平台转换；'
            + '要在 macOS 上跑 Windows 程序，用 ExeOnMac 方向',
          details: [`文件：${executablePath}`],
        })
    }
  }

  const payloadPath = resolvePath(projectRoot, input.payload) ?? projectRoot
  if (!(await isDirectory(payloadPath)) && !(await isFile(payloadPath))) {
    throw new BuildError(ErrorCode.INPUT_NOT_FOUND,
      `应用本体不存在：${payloadPath}`)
  }

  const appDirName = bundleDirName(finalAppName)
  const appDir = join(outDir, appDirName)
  const zipPath = join(outDir, `${appDirName.replace(/\.app$/u, '')}.zip`)

  const slugName = slug(finalAppName)
  const vendor = input.vendor ?? 'app'
  const bundleId = input.bundleId ?? makeBundleId(
    slugName === '' ? vendor : `${vendor}.${slugName}`, finalAppName)

  /*
   * 输出目录落在载荷内部时，必须把它整棵子树排除掉。
   *
   * ## 不加会怎样
   *
   * 默认 `--out` 是 `<项目>/dist-win2mac`，默认载荷是整个项目。第二次
   * 构建于是把第一次的产物当作载荷再打一遍，产物每构建一次翻一倍：
   *
   *   proj (Mac).app/Contents/Resources/app/dist-win2mac/proj (Mac).app/...
   *
   * 更糟的是失败信息完全没有指向性 —— 内层 .app 在复制中丢了可执行
   * 权限，verify 报的是 `zip.executable_modes`「权限不足」，人会去查
   * 权限，而真正的原因是「自己打自己」。
   *
   * ## 判断方式
   *
   * 只有输出目录**在**载荷之内才排除；`--out ../dist` 这种在外的情况
   * 不产生任何影响，也是更推荐的用法（会出一条提示）。
   */
  const payloadExcludes = []
  if (await isDirectory(payloadPath)) {
    const relativeOut = relative(payloadPath, outDir)
    const inside = relativeOut !== ''
      && !relativeOut.startsWith('..')
      && !isAbsolute(relativeOut)
    if (inside) payloadExcludes.push(outDir)
  }

  await mkdir(outDir, { recursive: true })

  // 目标已存在时先清掉：半成品目录会让后续装配写出混乱结构
  if (await isDirectory(appDir)) await remove(appDir)

  tracker.leave('preflight')

  // ── project-build ──────────────────────────────────────────────────────
  /*
   * 这一步在 Windows 上是**空转**的，但阶段必须存在。
   *
   * 原因：mac2win 在这一步跑 `npm run build`，win2mac 理论上也该跑。
   * 但 macOS 产物的构建（Xcode / swiftc / electron-builder --mac）
   * 在 Windows 上根本不可能完成。所以这里如实标记为「跳过」，
   * 并在报告里说明原因，而不是假装跑过了。
   */
  tracker.enter('project-build')
  tracker.skip('project-build', 'Windows 上无法构建 macOS 原生产物，需在 macOS 侧预先准备好')
  onProgress?.('跳过项目构建：macOS 产物需在 macOS 上构建')

  // ── runtime ────────────────────────────────────────────────────────────
  /*
   * 同样如实跳过。mac2win 在这一步下载目标架构的 Electron / Node
   * 二进制，win2mac 如果要支持 Electron 应用，也需要下载 darwin 版
   * （Electron 官方确实提供 darwin-arm64 / darwin-x64 产物）。
   *
   * 但那需要额外的「框架识别 + 运行时替换」逻辑，属后续增量。
   * 当前阶段先把「纯装配」这条路做扎实：用户给什么可执行文件，
   * 就装什么。
   */
  tracker.enter('runtime')
  tracker.skip('runtime', '当前版本不自动替换运行时，使用用户提供的可执行文件')

  // ── collect ────────────────────────────────────────────────────────────
  tracker.enter('collect')
  const payloadSize = await measureTree(
    (await isDirectory(payloadPath)) ? payloadPath : resolve(payloadPath, '..'),
    { excludePaths: payloadExcludes })
  tracker.leave('collect')

  // ── stage ──────────────────────────────────────────────────────────────
  tracker.enter('stage')
  const assembled = await assembleBundle({
    appDir,
    appName: finalAppName,
    bundleId,
    version: input.version ?? '1.0',
    executable: executablePath,
    executableName: basename(executablePath),
    payload: payloadPath,
    iconPath: input.icon,
    fileAssociations: input.fileAssociations,
    minMacOS: input.minMacOS,
    category: input.category,
    payloadExcludes,
  })
  tracker.leave('stage')

  // ── manifest ───────────────────────────────────────────────────────────
  /*
   * Info.plist 与 PkgInfo 在 assembleBundle 里已经写了。这里单独
   * 占一个阶段是为了让阶段图与 mac2win 对齐，且给前端一个「清单已生成」
   * 的明确信号。
   */
  tracker.enter('manifest')
  tracker.leave('manifest')

  // ── package ────────────────────────────────────────────────────────────
  tracker.enter('package')
  const zipResult = await zipBundle({
    source: appDir,
    outputFile: zipPath,
    rootName: appDirName,
    executableName: basename(executablePath),
    onProgress,
  })
  tracker.leave('package')

  // ── verify ─────────────────────────────────────────────────────────────
  tracker.enter('verify')
  const warnings = [...preflightWarnings]

  const bundleCheck = await verifyBundle(appDir)
  warnings.push(...bundleCheck.warnings)
  for (const check of bundleCheck.checks) {
    if (!check.ok) {
      tracker.markFailed(ErrorCode.VERIFY_FAILED)
      throw new BuildError(ErrorCode.VERIFY_FAILED,
        `产物校验不通过：${check.name}`,
        { hint: check.detail, details: bundleCheck.checks
          .filter((item) => !item.ok)
          .map((item) => `${item.name}：${item.detail}`) })
    }
  }

  const zipCheck = await verifyZip(zipPath, appDirName)
  warnings.push(...zipCheck.warnings)
  for (const check of zipCheck.checks) {
    if (!check.ok) {
      tracker.markFailed(ErrorCode.VERIFY_FAILED)
      throw new BuildError(ErrorCode.VERIFY_FAILED,
        `zip 校验不通过：${check.name}`,
        { hint: check.detail })
    }
  }

  tracker.leave('verify')

  // 中间目录默认删掉：用户要的是 zip，留着 `.app` 只会占空间
  if (input.keepWork !== true) {
    await remove(appDir)
  }

  return {
    artifact: zipPath,
    appDir: input.keepWork === true ? appDir : null,
    appName: finalAppName,
    bundleId,
    bytes: zipResult.compressedBytes,
    files: zipResult.files,
    dirs: zipResult.dirs,
    symlinks: zipResult.symlinks,
    payloadBytes: payloadSize.bytes,
    payloadFiles: payloadSize.files,
    warnings,
  }
}

/**
 * 把相对路径按项目根解析；空值返回 null。
 * @param {string} root
 * @param {string | undefined} value
 * @returns {string | null}
 */
function resolvePath(root, value) {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const text = String(value)
  // 绝对路径直接用；Windows 上 `C:\...` 会被 isAbsolute 认出来
  return isAbsolute(text) ? resolve(text) : resolve(root, text)
}

/**
 * 把应用名转成 bundle id 片段。
 *
 * 非 ASCII 名（中文、日文等）无法转成合法片段，返回空串 ——
 * 由调用方用哈希兜底，而不是塞一个 `app` 占位（那会让所有中文应用撞 id）。
 *
 * @param {string} name
 */
function slug(name) {
  const cleaned = String(name).toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return cleaned
}