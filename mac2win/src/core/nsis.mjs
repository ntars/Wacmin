/**
 * NSIS 安装包脚本生成。
 *
 * ## 为什么用 NSIS 而不是别的
 *
 * | 方案 | 在 arm64 mac 上能否产出 x86 exe | 结论 |
 * | --- | --- | --- |
 * | Tauri NSIS | 需要 Rust + `i686-pc-windows-msvc`，mac 上没有 | 不可行 |
 * | Inno Setup | 官方只有 Windows 版，需 wine | 依赖 wine，脆弱 |
 * | **NSIS (makensis)** | Homebrew 有原生 mac 版，直接产出 i386 PE | **可行** |
 *
 * `makensis` 在 mac 上运行时，输出的是 NSIS 自己的 i386 桩程序加上
 * 压缩载荷。这个桩是**预编译好的 32 位 PE**，与宿主 CPU 无关——
 * 所以 arm64 mac 能产出真正的 x86 exe，不需要任何模拟层。
 *
 * ## 反斜杠的处理
 *
 * NSIS 里的路径几乎全是 Windows 风格（`$INSTDIR\app\node.exe`），
 * 而 JS 字符串里 `\a` 会被解析成 `a`、`\n` 会变成换行。逐行手写
 * `\\` 极易出错且不可读。所以这里：
 *
 * - 目标路径（`$INSTDIR\…`）一律用 {@link WIN} 常量拼接，绝不手写反斜杠；
 * - 宿主路径（`File` 指令的源）走 {@link hostPath} 统一成 `/`。
 */

import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { BuildError, ErrorCode } from './errors.mjs'

/** Windows 路径分隔符。单独抽出来，避免在字符串字面量里手写反斜杠。 */
const WIN = '\\'

/**
 * 把宿主路径的分隔符统一成 `/`。
 *
 * 只做分隔符替换，不碰其他字符——`File` 的源路径必须是宿主格式。
 */
function hostPath(path) {
  return String(path).split(WIN).join('/')
}

/** 用 Windows 分隔符拼路径。`win('$INSTDIR', 'app', 'node.exe')`。 */
function win(...parts) {
  return parts.filter((part) => part !== '' && part !== undefined).join(WIN)
}

/**
 * 转义 NSIS 字符串里的特殊字符。
 *
 * NSIS 用双引号包裹字符串，内部的双引号要写成 `$\"`；`$` 是变量前缀，
 * 字面量 `$` 要写成 `$$`。不转义会得到语法错误，或者更糟——静默截断
 * （比如产品名里带 `$` 时）。
 */
export function escapeNsis(value) {
  return String(value)
    .replace(/\$/g, '$$$$')
    .replace(/"/g, '$\\"')
}

/**
 * 把宿主路径 + 通配符写成 NSIS 的 `File` 指令能接受的形式。
 *
 * ## 为什么不能简单拼 `WIN`
 *
 * `File` 的源路径是**宿主**路径（makensis 在 macOS 上跑）。如果拼成
 * `"/tmp/staging/app\*.*"`——前面是 `/`、后面是 `\`——makensis 会
 * 把整串当成一个文件名去找，结果报「找不到文件」，而报错里的路径
 * 看起来完全正常，极易误判。
 *
 * 所以这里统一成 `/`：`hostPath` 负责转分隔符，通配符单独拼。
 */
function fileSource(dir) {
  const normalized = hostPath(dir).replace(/\/+$/, '')
  return `${normalized}/*.*`
}

/**
 * 生成 NSIS 脚本。
 *
 * @param {object} input
 * @param {object} input.config 归一化后的配置。
 * @param {string} input.stagingAppDir 暂存区的 `app/` 目录（绝对路径）。
 * @param {string} input.outputFile 产物 exe 的绝对路径。
 * @param {string} [input.iconFile] 图标文件（.ico）。
 * @param {string} [input.licenseFile] 许可协议文件。
 * @returns {string} NSIS 脚本全文。
 */
export function renderNsisScript(input) {
  const { config, stagingAppDir, outputFile, iconFile, licenseFile } = input

  const name = escapeNsis(config.productName)
  const version = escapeNsis(config.version)
  const publisher = escapeNsis(config.publisher)
  const identifier = escapeNsis(config.identifier)

  /*
   * 安装位置。
   *
   * 需要管理员权限时装到 Program Files，否则装到用户的 LocalAppData。
   * 后者是 Windows 上「每用户安装」的标准位置：不需要 UAC 提权，
   * 卸载时也不会留下需要管理员才能删的残留。默认走后者——
   * 一个陪伴类应用没有任何理由要系统级权限。
   */
  const installDir = config.requireAdmin
    ? win('$PROGRAMFILES', name)
    : win('$LOCALAPPDATA', 'Programs', name)

  const compression = {
    lzma: 'SetCompressor /SOLID lzma',
    zlib: 'SetCompressor /SOLID zlib',
    bzip2: 'SetCompressor /SOLID bzip2',
    none: 'SetCompressor off',
  }[config.compression] ?? 'SetCompressor /SOLID lzma'

  /*
   * 快捷方式的目标。
   *
   * 默认是 `node.exe`——它承载启动器脚本，是所有形态的统一入口。
   * 但配置可以改（`launcherExe`），用于「项目自带了一个自定义启动器
   * exe」的场景：那种情况下用户希望双击直接跑自己的程序，
   * 而不是绕一层 node。
   */
  const launcherName = config.launcherExe ?? 'node.exe'
  const exeTarget = win('$INSTDIR', 'app', launcherName)
  const launcherArg = win('$INSTDIR', 'app', 'bootstrap', 'bootstrap.mjs')

  /*
   * 卸载信息在注册表里的位置。
   *
   * NSIS 的 WriteRegStr 要 4 个参数：根键、子键、值名、值。
   * 根键与子键必须分开给——把 `HKCU\Software\...` 整串塞进第一个
   * 参数会被判成「子键缺失」而报参数个数错误。
   */
  const uninstallSubKey = win(
    'Software',
    'Microsoft',
    'Windows',
    'CurrentVersion',
    'Uninstall',
    identifier,
  )
  const appSubKey = win('Software', identifier)
  const startMenuDir = win('$SMPROGRAMS', name)

  const lines = []

  lines.push('; 由 mac2win 自动生成，请勿手工修改')
  lines.push('; 改动会在下次构建时被覆盖')
  lines.push('Unicode true')
  lines.push('')
  lines.push(`Name "${name}"`)
  lines.push(`OutFile "${hostPath(outputFile)}"`)
  lines.push(`InstallDir "${installDir}"`)
  lines.push(`InstallDirRegKey HKCU "Software${WIN}${identifier}" "InstallDir"`)
  lines.push(`RequestExecutionLevel ${config.requireAdmin ? 'admin' : 'user'}`)
  lines.push(compression)
  lines.push('')

  // 版本资源。每个键都要给，否则 makensis 会对每种语言各报一条警告。
  const fourPart = toFourPartVersion(config.version)
  lines.push(`VIProductVersion "${fourPart}"`)
  lines.push(`VIAddVersionKey /LANG=2052 "ProductName" "${name}"`)
  lines.push(`VIAddVersionKey /LANG=2052 "ProductVersion" "${version}"`)
  lines.push(`VIAddVersionKey /LANG=2052 "FileVersion" "${fourPart}"`)
  lines.push(`VIAddVersionKey /LANG=2052 "CompanyName" "${publisher}"`)
  lines.push(`VIAddVersionKey /LANG=2052 "FileDescription" "${name}"`)
  lines.push(`VIAddVersionKey /LANG=2052 "LegalCopyright" "${publisher}"`)
  lines.push('')

  lines.push('!include "MUI2.nsh"')
  lines.push('')
  lines.push('!define MUI_ABORTWARNING')
  if (licenseFile !== undefined && licenseFile !== null) {
    lines.push('!insertmacro MUI_PAGE_LICENSE "' + hostPath(licenseFile) + '"')
  }
  lines.push('!insertmacro MUI_PAGE_DIRECTORY')
  lines.push('!insertmacro MUI_PAGE_INSTFILES')
  lines.push('!insertmacro MUI_UNPAGE_CONFIRM')
  lines.push('!insertmacro MUI_UNPAGE_INSTFILES')
  lines.push('')
  lines.push('!insertmacro MUI_LANGUAGE "SimpChinese"')
  lines.push('!insertmacro MUI_LANGUAGE "English"')
  lines.push('')

  if (iconFile !== undefined && iconFile !== null) {
    lines.push(`Icon "${hostPath(iconFile)}"`)
    lines.push(`UninstallIcon "${hostPath(iconFile)}"`)
    lines.push('')
  }

  // --- 安装 ---
  lines.push('Section "Install"')
  lines.push('  SectionIn RO')
  /*
   * 落地到 `$INSTDIR\app`，不是 `$INSTDIR`。
   *
   * `File /r "<src>\*.*"` 展开的是**内容**，不含源目录名本身。
   * 所以 SetOutPath 必须自己补上 `app` 这一层，否则文件会散落在
   * 安装根目录下，而启动器按契约找的是 `app/node.exe`。
   *
   * 这一层也顺带把「用户数据（app\data）」与「卸载器」隔开了：
   * 卸载时 `RMDir /r "$INSTDIR\app"` 不会碰卸载器自己。
   */
  lines.push(`  SetOutPath "$INSTDIR${WIN}app"`)
  lines.push('')
  lines.push('  ; 整个 app 目录一次解出来。载荷在编译期就被压进 exe，')
  lines.push('  ; 这里不做任何文件筛选——筛选逻辑在打包阶段已经做完了。')
  lines.push(`  File /r "${fileSource(stagingAppDir)}"`)
  lines.push('')
  lines.push('  WriteUninstaller "$INSTDIR' + WIN + 'uninstall.exe"')
  lines.push('')
  lines.push('  ; 卸载信息：控制面板的「程序和功能」读这一处')
  lines.push(`  WriteRegStr HKCU "${uninstallSubKey}" "DisplayName" "${name}"`)
  lines.push(`  WriteRegStr HKCU "${uninstallSubKey}" "DisplayVersion" "${version}"`)
  lines.push(`  WriteRegStr HKCU "${uninstallSubKey}" "Publisher" "${publisher}"`)
  lines.push(`  WriteRegStr HKCU "${uninstallSubKey}" "DisplayIcon" "${exeTarget}"`)
  lines.push(`  WriteRegStr HKCU "${uninstallSubKey}" "InstallLocation" "$INSTDIR"`)
  lines.push(`  WriteRegStr HKCU "${uninstallSubKey}" "UninstallString" '"$INSTDIR${WIN}uninstall.exe"'`)
  lines.push(`  WriteRegDWORD HKCU "${uninstallSubKey}" "NoModify" 1`)
  lines.push(`  WriteRegDWORD HKCU "${uninstallSubKey}" "NoRepair" 1`)
  lines.push('')
  lines.push(`  WriteRegStr HKCU "${appSubKey}" "InstallDir" "$INSTDIR"`)
  lines.push('')

  // --- 快捷方式 ---
  lines.push(`  ; 快捷方式指向 ${launcherName} 并带上启动器参数。`)
  lines.push('  ; node.exe 是 GUI 子系统的 nsExec 桩，双击不弹控制台窗口。')
  lines.push(`  CreateDirectory "${startMenuDir}"`)
  lines.push(
    `  CreateShortCut "${win(startMenuDir, `${name}.lnk`)}" "${exeTarget}" '"${launcherArg}"' "${exeTarget}" 0`,
  )
  lines.push(
    `  CreateShortCut "${win(startMenuDir, `卸载 ${name}.lnk`)}" "$INSTDIR${WIN}uninstall.exe"`,
  )
  if (config.desktopShortcut) {
    lines.push(
      `  CreateShortCut "${win('$DESKTOP', `${name}.lnk`)}" "${exeTarget}" '"${launcherArg}"' "${exeTarget}" 0`,
    )
  }
  lines.push('')
  lines.push('  ; 刷新图标缓存，否则新装的快捷方式可能显示空白图标')
  lines.push('  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)"')
  lines.push('SectionEnd')
  lines.push('')

  // --- 卸载 ---
  lines.push('Section "Uninstall"')
  lines.push(`  Delete "${win(startMenuDir, `${name}.lnk`)}"`)
  lines.push(`  Delete "${win(startMenuDir, `卸载 ${name}.lnk`)}"`)
  lines.push(`  RMDir "${startMenuDir}"`)
  lines.push(`  Delete "${win('$DESKTOP', `${name}.lnk`)}"`)
  lines.push('')
  lines.push('  ; 先删注册表再删文件：注册表项在卸载器自己里面，')
  lines.push('  ; 先删它能让控制面板立刻消失，观感更对。')
  lines.push(`  DeleteRegKey HKCU "${uninstallSubKey}"`)
  lines.push(`  DeleteRegKey HKCU "${appSubKey}"`)
  lines.push('')
  lines.push('  ; 递归删 app 目录。用户数据在 app\\data 里，')
  lines.push('  ; 按「卸载即清理」处理——本应用的数据全在本机、无云端副本。')
  lines.push(`  RMDir /r "$INSTDIR${WIN}app"`)
  lines.push(`  Delete "$INSTDIR${WIN}uninstall.exe"`)
  lines.push(`  RMDir "$INSTDIR"`)
  lines.push('SectionEnd')
  lines.push('')

  return lines.join('\n')
}

/**
 * 把版本号补成四段。
 *
 * `VIProductVersion` 要求严格四段数字（`1.0.0.0`），而项目版本常写成
 * `1.0.3-alpha` 或 `1.0`。这里做的是**格式适配**而不是改语义：
 * 丢掉预发布后缀，缺的段补零。
 */
export function toFourPartVersion(version) {
  const numeric = String(version).split('-')[0]
  const parts = numeric.split('.').map((part) => {
    const value = Number.parseInt(part, 10)
    return Number.isFinite(value) && value >= 0 ? Math.min(value, 65535) : 0
  })
  while (parts.length < 4) parts.push(0)
  return parts.slice(0, 4).join('.')
}

/**
 * 生成脚本并落盘。
 *
 * @param {object} input 同 {@link renderNsisScript}，另加 `scriptPath`。
 * @returns {Promise<string>} 脚本路径。
 */
export async function writeNsisScript(input) {
  const script = renderNsisScript(input)
  try {
    await writeFile(input.scriptPath, script, 'utf8')
  } catch (error) {
    throw new BuildError(ErrorCode.NSIS_SCRIPT_FAILED, `写 NSIS 脚本失败：${input.scriptPath}`, {
      details: [error.message],
    })
  }
  return join(input.scriptPath)
}