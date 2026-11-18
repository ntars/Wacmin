/**
 * 构建配置。
 *
 * ## 配置的来源与优先级
 *
 * 命令行参数 > 配置文件 > 自动推断 > 默认值。
 *
 * 自动推断这一层很关键：一个 Node 项目要打包，用户其实只该说
 * 「哪个目录」。`package.json` 里的 `build` 脚本、`main` 入口、
 * `productName` 这些信息本来就在项目里，让用户再抄一遍到配置里
 * 既是重复劳动，又会两边不同步。
 *
 * ## 为什么配置项叫这个名字
 *
 * 字段名与 Tauri / Electron 那套习惯保持接近（`frontendDist`、
 * `entry`、`resources`），用户从别的打包工具迁过来时不用重新学一遍
 * 词汇表。
 */

import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { BuildError, ErrorCode } from './errors.mjs'
import { isDirectory, isFile, readJson } from '../util/fsx.mjs'
import { checkFrameworkTarget, detectFramework, inferForFramework } from './frameworks.mjs'

/** 目标架构。目前只支持 x86，字段留着以便未来扩到 x64 / arm64。 */
export const TARGET_ARCHES = ['x86', 'x64', 'arm64']

/** 产物形态。 */
export const OUTPUT_FORMATS = ['nsis', 'zip']

/**
 * 默认配置。**这里是全部默认值的唯一真源**，别处不许再写一份。
 */
export const DEFAULTS = {
  /**
   * 项目框架。`auto` 表示自动识别（读 src-tauri/、package.json 依赖等）。
   * 可选：auto / electron / nwjs / tauri / node / static
   */
  framework: 'auto',
  /** 目标架构。x86 是 32 位，能在所有 Windows 上跑。 */
  target: 'x86',
  /** 产物形态。nsis 出安装包 exe，zip 出免安装压缩包。 */
  format: 'nsis',
  /** 安装包显示名。留空则从项目推断。 */
  productName: null,
  /** 版本号。留空则从项目推断。 */
  version: null,
  /** 发布者名称。 */
  publisher: null,
  /** 应用标识（用于卸载项注册表与数据目录）。留空则从产品名生成。 */
  identifier: null,

  /** 要打包的静态前端目录（相对项目根）。留空则不打包前端。 */
  frontendDist: null,
  /** 宿主进程入口（相对项目根）。留空则不打包宿主。 */
  entry: null,
  /** 需要额外带上的资源目录（相对项目根，数组）。 */
  resources: [],
  /** 项目里已有的构建命令。留空则跳过。 */
  buildCommand: null,
  /** 打包前要跑的检查命令。 */
  preflightCommands: [],

  /** 启动器要执行的可执行文件名（安装目录内）。 */
  launcherExe: 'node.exe',
  /** 启动器传给 node 的参数模板。`{entry}` 会被替换成入口路径。 */
  launcherArgs: ['{entry}'],
  /** 启动时设置的环境变量。 */
  env: {},
  /** 宿主读数据目录的环境变量名。留空则不设。 */
  dataEnv: null,

  /** Windows x86 Node 运行时版本。23 起官方不再发布 win-x86，所以固定 22.x。 */
  runtimeVersion: '22.23.5',
  /** 离线环境用：本地 node.exe 或 win-x86 zip 的路径。 */
  runtimeArchive: null,
  /** 与 runtimeArchive 配套的期望 SHA-256。 */
  runtimeChecksum: null,

  /** Electron 版本。x86 目标必须 ≤43（v44 起移除 win32-ia32）。 */
  electronVersion: '43.0.0',
  /** 离线环境用：本地 Electron win32-ia32 zip。 */
  electronArchive: null,

  /** NW.js 版本。 */
  nwjsVersion: '0.90.0',
  /** NW.js 发行类型：normal | sdk。sdk 带开发者工具，体积大。 */
  nwjsFlavor: 'normal',
  /** 离线环境用：本地 NW.js win-ia32 zip。 */
  nwjsArchive: null,

  /**
   * 是否用 cargo-xwin 编译 Tauri 的 Rust 壳。
   *
   * 默认 false：需要 1.5GB 依赖与 10–30 分钟首次构建。开启后产物
   * 有真正的原生窗口，而不是走系统浏览器。
   */
  buildRustShell: false,
  /** src-tauri 目录（相对项目根）。默认自动探测。 */
  tauriDir: null,
  /** Rust 构建 profile：release（默认）或 debug。 */
  rustProfile: 'release',

  /** 安装包图标（.ico，相对项目根或绝对路径）。 */
  iconFile: null,
  /** 许可协议文件（.txt / .rtf）。 */
  licenseFile: null,

  /** 输出目录（相对项目根，或绝对路径）。 */
  outDir: 'dist-mac2win',
  /** 产物文件名。留空则按产品名与版本自动生成。 */
  artifactName: null,

  /** 是否在构建后做完整校验。关掉只跳过校验，不跳过安全检查。 */
  verify: true,
  /** 是否生成免安装 zip。 */
  alsoZip: false,
  /** 压缩级别。lzma 体积最小但慢，zlib 快。 */
  compression: 'lzma',
  /** 安装包是否创建桌面快捷方式。 */
  desktopShortcut: true,
  /** 安装包是否需要管理员权限。 */
  requireAdmin: false,
  /** 是否保留中间产物（staging 目录），排查问题时打开。 */
  keepStaging: false,
}

/** 配置文件名，按顺序查找第一个存在的。 */
const CONFIG_FILENAMES = ['mac2win.config.json', 'mac2win.json']

/**
 * 读项目里的配置文件。
 *
 * @param {string} projectRoot 项目根目录。
 * @returns {Promise<object>} 配置内容，找不到时返回空对象。
 */
export async function readConfigFile(projectRoot) {
  for (const name of CONFIG_FILENAMES) {
    const path = join(projectRoot, name)
    if (!(await isFile(path))) continue
    let raw
    try {
      raw = await readJson(path)
    } catch (error) {
      throw new BuildError(ErrorCode.CONFIG_INVALID, `配置文件解析失败：${name}`, {
        details: [error.message],
        hint: '检查 JSON 语法：多余逗号、单引号、注释都是不合法的',
      })
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BuildError(ErrorCode.CONFIG_INVALID, `配置文件内容必须是对象：${name}`, {
        hint: '顶层应该写成 { "productName": "…" } 这样的结构',
      })
    }
    return { ...raw, __configPath: path }
  }
  return {}
}

/**
 * 从 `package.json` 推断配置。
 *
 * 只读几个稳定的字段，不做花哨猜测：猜错了比不猜更糟，
 * 用户会得到一个名字对不上的安装包却不知道从哪改。
 */
async function inferFromPackageJson(projectRoot) {
  const path = join(projectRoot, 'package.json')
  if (!(await isFile(path))) return {}

  let pkg
  try {
    pkg = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return {}
  }

  const inferred = {}
  // 保留原始对象供框架识别复用，避免读两次文件。
  // 用不可枚举属性：它不该出现在展开结果里，也不该被当成配置项。
  Object.defineProperty(inferred, '__raw', { value: pkg, enumerable: false })

  const name = pkg.productName ?? pkg.displayName ?? pkg.name
  if (typeof name === 'string' && name.trim() !== '') inferred.productName = name.trim()
  if (typeof pkg.version === 'string' && pkg.version.trim() !== '') inferred.version = pkg.version.trim()
  if (typeof pkg.description === 'string') inferred.description = pkg.description
  const author = pkg.author
  if (typeof author === 'string' && author.trim() !== '') inferred.publisher = author.trim()
  else if (author !== null && typeof author === 'object' && typeof author.name === 'string') inferred.publisher = author.name

  // 构建脚本：优先 build，其次 compile。
  const scripts = pkg.scripts ?? {}
  if (typeof scripts.build === 'string') inferred.buildCommand = 'npm run build'
  else if (typeof scripts.compile === 'string') inferred.buildCommand = 'npm run compile'

  // 入口：`bin` 是单值或对象，`main` 是模块入口。
  if (typeof pkg.bin === 'string') inferred.entry = pkg.bin
  else if (pkg.bin !== null && typeof pkg.bin === 'object') {
    const first = Object.values(pkg.bin).find((value) => typeof value === 'string')
    if (first !== undefined) inferred.entry = first
  }
  if (inferred.entry === undefined && typeof pkg.main === 'string') inferred.entry = pkg.main

  return inferred
}

/**
 * 自动探测常见的前端产物目录。
 *
 * 顺序按「越靠后越可能是最终产物」排：`dist` 是 Vite / Rollup 的默认，
 * `build` 是 CRA 的默认，`.output` 是 Nuxt 的。
 */
async function inferFrontendDist(projectRoot) {
  for (const candidate of ['dist', 'build', 'out', '.output/public']) {
    const path = join(projectRoot, candidate)
    if (await isDirectory(path)) {
      // 有 index.html 才算「能直接打开的前端产物」。
      if (await isFile(join(path, 'index.html'))) return candidate
    }
  }
  return null
}

/**
 * 解析并校验配置。
 *
 * @param {object} input
 * @param {string} input.projectRoot 项目根目录（绝对路径）。
 * @param {object} [input.overrides] 命令行传进来的覆盖项。
 * @returns {Promise<object>} 归一化后的完整配置。
 */
export async function resolveConfig(input) {
  const { projectRoot, overrides = {} } = input

  const absoluteRoot = resolve(projectRoot)
  if (!(await isDirectory(absoluteRoot))) {
    throw new BuildError(ErrorCode.PROJECT_NOT_FOUND, `项目目录不存在：${absoluteRoot}`, {
      hint: '确认路径拼写，或先用 --project 指定正确目录',
    })
  }

  const fromFile = await readConfigFile(absoluteRoot)
  const fromPackage = await inferFromPackageJson(absoluteRoot)

  /*
   * 框架识别必须在「合并配置」之前做：框架决定 entry / frontendDist
   * 的默认值从哪来，而这些值又要能被用户配置覆盖。顺序反了会导致
   * 「用户显式配置被框架推断覆盖」或「框架推断完全不生效」。
   */
  const detected = await detectFramework(absoluteRoot, { framework: overrides.framework ?? fromFile.framework })
  const fromFramework = await inferForFramework(detected.id, absoluteRoot, fromPackage.__raw ?? null)

  const merged = { ...DEFAULTS, ...fromPackage, ...fromFramework, ...fromFile, ...overrides }

  merged.__framework = detected
  merged.framework = detected.id

  // 前端产物目录与入口都是「相对项目根」的语义，必须在这里定死，
  // 否则后续所有阶段都要各自拼一次路径，必然有一处拼错。
  if (merged.frontendDist === null || merged.frontendDist === undefined) {
    merged.frontendDist = await inferFrontendDist(absoluteRoot)
  }
  if (merged.frontendDist !== null) {
    merged.frontendDist = isAbsolute(merged.frontendDist)
      ? merged.frontendDist
      : join(absoluteRoot, merged.frontendDist)
  }
  if (merged.entry !== null && merged.entry !== undefined) {
    merged.entry = isAbsolute(merged.entry) ? merged.entry : join(absoluteRoot, merged.entry)
  }

  merged.projectRoot = absoluteRoot
  merged.outDir = isAbsolute(merged.outDir) ? merged.outDir : join(absoluteRoot, merged.outDir)

  // 产品名兜底：连 package.json 都没有时用目录名，总比空着强。
  if (merged.productName === null || String(merged.productName).trim() === '') {
    merged.productName = absoluteRoot.split('/').pop() ?? 'app'
  }
  if (merged.version === null || String(merged.version).trim() === '') merged.version = '0.0.0'
  if (merged.publisher === null || String(merged.publisher).trim() === '') merged.publisher = merged.productName
  if (merged.identifier === null || String(merged.identifier).trim() === '') {
    merged.identifier = `com.mac2win.${slugify(merged.productName)}`
  }

  merged.resources = (Array.isArray(merged.resources) ? merged.resources : []).map((item) =>
    isAbsolute(item) ? item : join(absoluteRoot, item),
  )

  // 图标与许可协议是可选的单文件，同样要归一化成绝对路径。
  for (const key of ['iconFile', 'licenseFile', 'runtimeArchive', 'tauriDir']) {
    if (merged[key] === null || merged[key] === undefined || merged[key] === '') {
      merged[key] = null
      continue
    }
    merged[key] = isAbsolute(merged[key]) ? merged[key] : join(absoluteRoot, merged[key])
  }

  // launcherArgs 里可能只有一个 `{entry}` 占位符，也可能带别的参数。
  merged.launcherArgs = (Array.isArray(merged.launcherArgs) ? merged.launcherArgs : ['{entry}'])
    .map((item) => String(item))

  validate(merged)
  return merged
}

/**
 * 把名字洗成只能出现在标识符里的样子。
 *
 * ## 为什么中文名要挂哈希后缀
 *
 * `identifier` 进的是 NSIS 生成的注册表路径
 * （`HKCU\Software\<identifier>`），是同一台机器上区分两个应用的唯一
 * 依据。而 `[^a-z0-9]` 这个字符类会把**所有**中文整段吃掉：
 *
 *   记事本      → app
 *   我的应用    → app
 *   微信        → app
 *   网易云音乐  → app
 *
 * 实测 11 个常见中文产品名，修前只产出 **4 个不同 identifier**，其中
 * 7 个撞在 `com.mac2win.app`。装两个中文应用后，后装的会把先装的
 * `InstallDir` 覆盖掉，卸载其一会删掉另一个的注册表项 —— 控制面板里
 * 只剩一个「程序」，而文件都还在。
 *
 * ## 规则
 *
 * 含非 ASCII 字符时，在可读片段后挂 8 位哈希。纯 ASCII 名原样返回，
 * 不改变已有产物的 identifier（升级构建不会让老用户变成两个条目）。
 *
 * 纯中文名归一化后为空，形态是 `app-<哈希>` —— 保留 `app` 便于辨认
 * 「这是兜底值」，哈希保证不撞。空名（清洗后仍为空且无中文）才返回
 * 裸 `app`；调用方（`resolveConfig`）在此之前已用目录名兜底。
 *
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
  const text = String(name)
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // 纯 ASCII：可读片段本身就唯一，不加后缀，保持向后兼容
  const lossy = /[^\x20-\x7e]/.test(text)
  if (cleaned === '') {
    if (!lossy) return 'app'
    const digest = createHash('sha256').update(text).digest('hex').slice(0, 8)
    return `app-${digest}`
  }
  if (!lossy) return cleaned
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 8)
  return `${cleaned}-${digest}`
}

/**
 * 校验配置取值。
 *
 * 全部错误一次报完，而不是遇到第一个就停：用户改配置时希望一轮改完，
 * 而不是「改一个、重跑、再报一个」来回五次。
 */
function validate(config) {
  const problems = []

  if (!TARGET_ARCHES.includes(config.target)) {
    problems.push({
      message: `target 取值不合法：${String(config.target)}`,
      hint: `可选值：${TARGET_ARCHES.join(' / ')}`,
    })
  }
  if (!OUTPUT_FORMATS.includes(config.format)) {
    problems.push({
      message: `format 取值不合法：${String(config.format)}`,
      hint: `可选值：${OUTPUT_FORMATS.join(' / ')}`,
    })
  }
  if (!['lzma', 'zlib', 'bzip2', 'none'].includes(config.compression)) {
    problems.push({
      message: `compression 取值不合法：${String(config.compression)}`,
      hint: '可选值：lzma / zlib / bzip2 / none',
    })
  }
  if (typeof config.verify !== 'boolean') {
    problems.push({ message: 'verify 必须是布尔值 true / false' })
  }
  if (typeof config.alsoZip !== 'boolean') {
    problems.push({ message: 'alsoZip 必须是布尔值 true / false' })
  }
  if (config.format === 'zip' && config.alsoZip === true) {
    problems.push({
      message: 'format 已是 zip，alsoZip 没有意义',
      hint: '要么用 format: "zip" 只出压缩包，要么用 format: "nsis" + alsoZip: true 出两种',
    })
  }
  if (!/^\d+\.\d+\.\d+/.test(String(config.version))) {
    problems.push({
      message: `version 不像版本号：${String(config.version)}`,
      hint: '至少写成 1.0.0 这样的三段式',
    })
  }
  if (config.entry === null && config.frontendDist === null) {
    problems.push({
      message: '既没有 entry 也没有 frontendDist，没有可打包的内容',
      hint: '在配置里指定 entry（宿主入口脚本）或 frontendDist（前端产物目录）',
    })
  }
  if (config.launcherExe !== 'node.exe' && !/\.exe$/i.test(String(config.launcherExe))) {
    problems.push({
      message: `launcherExe 必须是 .exe 文件：${String(config.launcherExe)}`,
      hint: 'Windows 的启动器只能是 PE 格式的 .exe',
    })
  }

  if (problems.length > 0) {
    throw new BuildError(ErrorCode.CONFIG_INVALID, `配置有 ${String(problems.length)} 处问题`, {
      details: problems.map((item) => item.message),
      hint: problems[0].hint,
    })
  }
}

/** 把配置里不该出现在日志中的大字段摘掉，供日志打印。 */
export function describeConfig(config) {
  const pick = (value) => (value === null || value === undefined ? '（未设置）' : String(value))
  return [
    `项目根     ${config.projectRoot}`,
    `产品名     ${config.productName} ${config.version}`,
    `目标架构   ${config.target}`,
    `产物形态   ${config.format}${config.alsoZip === true && config.format === 'nsis' ? '（另出 zip）' : ''}`,
    `前端产物   ${pick(config.frontendDist)}`,
    `宿主入口   ${pick(config.entry)}`,
    `额外资源   ${config.resources.length === 0 ? '（无）' : config.resources.join(', ')}`,
    `构建命令   ${pick(config.buildCommand)}`,
    `输出目录   ${config.outDir}`,
  ]
}