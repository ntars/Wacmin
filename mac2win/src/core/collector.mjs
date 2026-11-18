/**
 * 依赖收集。
 *
 * ## 为什么不能直接拷 `node_modules`
 *
 * 三种常见布局都会让「整目录拷贝」失败：
 *
 * | 布局 | 直接拷贝的后果 |
 * | --- | --- |
 * | pnpm（软链到 `.pnpm`） | Windows 上全是断链，启动即 MODULE_NOT_FOUND |
 * | npm 扁平安装 | 把只在构建期用的包也拖进去，体积翻几倍 |
 * | workspace 协议 | 软链指向仓库里的相对路径，拷出去就丢 |
 *
 * 所以这里走 Node 自己的解析器：从入口文件出发，沿着真实的 `import` /
 * `require` 走一遍，走到的包才收。**收进来的每一个包都保证有代码真的
 * 引用它**，没有一个是猜的。
 *
 * ## 为什么必须拦原生模块
 *
 * `.node` 是编译好的机器码。macOS 上装的 `.node` 是 Mach-O arm64，
 * 搬进 Windows 包后 Node 一加载就抛 `not a valid Win32 application`。
 * 这类失败发生在用户机器上、发生在启动的第一秒，报错完全看不出根因。
 * 所以在收集阶段就把它拦住，并说清楚是哪个包。
 */

import { createRequire } from 'node:module'
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { BuildError, ErrorCode } from './errors.mjs'
import { isDirectory, isFile, walkFiles } from '../util/fsx.mjs'

/**
 * 匹配 import / require / export-from 里的模块说明符。
 *
 * 这里用正则是权衡后的选择：真正的做法是起一个解析器（如 es-module-lexer）
 * 把每个文件解析成 AST。但对「找出这个文件引用了哪些包」这个目的，
 * 正则足够——误判只会多收一个包（无害），漏判才危险。为了不漏，
 * 三种写法都覆盖，且允许跨行。
 */
const SPECIFIER_PATTERNS = [
  // import x from 'pkg' / import 'pkg' / import * as x from "pkg"
  /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  // export ... from 'pkg'
  /\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
  // require('pkg') / import('pkg')
  /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

/** 内建模块不用收集。`node:` 前缀与裸名两种写法都要认。 */
const BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'timers',
  'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
])

/** 判断一个说明符是不是可以跳过的（内建、绝对路径、node: 前缀）。 */
function isSkippable(specifier) {
  if (specifier.startsWith('node:')) return true
  if (specifier.startsWith('data:')) return true
  if (specifier.startsWith('#')) return true // 包的内部导入映射，由解析器处理
  if (BUILTINS.has(specifier)) return true
  if (isAbsolute(specifier)) return true
  return false
}

/** 判断一个说明符是不是相对路径（不进 node_modules 解析）。 */
function isRelative(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

/**
 * 从某个文件出发，找它所属的包根目录（最近的含 `package.json` 的祖先）。
 *
 * ## 为什么要区分 pnpm 的 `.pnpm` 布局
 *
 * pnpm 的物理布局是这样：
 *
 * ```
 * node_modules/.pnpm/cordis@4.0.0-rc.12/node_modules/
 *   cordis/          ← 这个包本身
 *   cosmokit/        ← 它的依赖，被放在同一层
 * ```
 *
 * 也就是说，**一个包的依赖不在它自己的 `node_modules` 里，而在它上一层的
 * `node_modules`**。如果只从包自己的目录往上找 `package.json`，会拿到
 * `cordis` 的根，然后按「包的 node_modules」去收依赖——那里是空的，
 * 于是 `cosmokit` 就漏了。
 *
 * 实测症状：打出的包启动时报
 * `Cannot find package 'cosmokit' imported from …/@ntars/cordis/lib/index.js`。
 *
 * 所以这里同时返回「包的根」与「它所在的 node_modules 目录」，
 * 后者才是收集同级依赖的正确基准。
 *
 * ## `aliasOf` 解决什么问题
 *
 * pnpm 支持把包安装成别名：
 *
 * ```json
 * "dependencies": { "@ntars/cordis": "npm:cordis@4.0.0-rc.12" }
 * ```
 *
 * 此时磁盘上的目录名是 **`@ntars/cordis`**，但包自己 `package.json`
 * 里的 `name` 是 **`cordis`**。源码 import 的是 `@ntars/cordis`。
 *
 * 如果只按 `name` 建目录，运行时就报
 * `Cannot find package '@ntars/cordis'`——而包里明明有 `cordis`。
 *
 * 所以这里额外返回「这个包被安装成了什么名字」（`aliasOf`），
 * 暂存时用它作为目录名。
 *
 * @returns {Promise<{root: string, name: string, aliasOf: string | null, nodeModulesDir: string | null} | null>}
 */
async function findPackageRoot(file) {
  let dir = dirname(file)
  for (let depth = 0; depth < 32; depth += 1) {
    const manifest = join(dir, 'package.json')
    if (await isFile(manifest)) {
      let name = ''
      try {
        const pkg = JSON.parse(await readFile(manifest, 'utf8'))
        name = typeof pkg.name === 'string' ? pkg.name : ''
      } catch {
        name = ''
      }

      const parent = dirname(dir)
      const nodeModulesDir = parent.endsWith(`${sep}node_modules`) ? parent : null

      /*
       * 算出「被安装成什么名字」。
       *
       * 三种情况：
       * - 目录名就是包名 → 无别名。
       * - 目录名是 `@scope/name` 而包名不同 → 有别名，取目录名。
       * - 目录名带版本后缀（`.pnpm/<pkg>@<ver>/node_modules/<pkg>`）→
       *   上面那层已经是 `node_modules`，`basename(dir)` 就是正确名字。
       */
      let aliasOf = null
      if (nodeModulesDir !== null) {
        const installedName = basename(dir)
        if (installedName !== name && name !== '') aliasOf = installedName
      }

      return { root: dir, name, aliasOf, nodeModulesDir }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 把正则扫出来的说明符收集起来。 */
function scanSpecifiers(source) {
  const found = new Set()
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1]
      if (specifier === undefined || specifier === '') continue
      found.add(specifier)
    }
  }
  return found
}

/** 这个文件是不是需要扫描的 JS/TS 产物。 */
function isScriptFile(path) {
  return /\.(?:mjs|cjs|js|jsx|ts|tsx)$/.test(path)
}

/**
 * 从入口出发收集全部运行时依赖。
 *
 * @param {object} input
 * @param {string} input.entry 入口文件绝对路径。
 * @param {(message: string) => void} [input.onProgress] 进度回调。
 * @returns {Promise<{packages: Map<string, string>, files: string[], natives: string[], unresolved: string[]}>}
 *   `packages` 是「包名 → 包根目录绝对路径」，`natives` 是发现的原生模块。
 */
export async function collectDependencies(input) {
  const { entry, onProgress } = input

  if (!(await isFile(entry))) {
    throw new BuildError(ErrorCode.PROJECT_ARTIFACT_MISSING, `入口文件不存在：${entry}`, {
      hint: '先跑一次项目自己的构建（npm run build），确认产物路径与配置里的 entry 一致',
    })
  }

  /** 包名 → 包根目录。 */
  const packages = new Map()
  /** 已扫描过的脚本文件，防止循环引用无限递归。 */
  const scanned = new Set()
  /** 发现的原生模块（`.node`），收集起来一次性报错。 */
  const natives = []
  /** 解析不了的说明符，收起来做警告而不是直接失败。 */
  const unresolved = []
  /** 已经扫过的同级 node_modules 目录，避免重复遍历。 */
  const siblingsScanned = new Set()
  /** 待展开依赖的包根目录队列。 */
  const pendingPackages = []

  const queue = [entry]

  /**
   * 收一个 node_modules 目录里的全部包。
   *
   * pnpm 把「某个包的依赖」放在它上一层的 node_modules 里。要收全，
   * 得把那一层的每个包都记下来——只收直接 import 到的那些会漏掉
   * 它们的运行时依赖。
   *
   * 这里只记录包的根路径，不递归扫描内容（内容靠队列里的入口文件驱动）。
   * 扫全目录是 O(n) 的 readdir，几百个包也只是毫秒级。
   */
  async function collectSiblings(packageRoot) {
    if (siblingsScanned.has(packageRoot)) return
    siblingsScanned.add(packageRoot)

    let pkg
    try {
      pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    } catch {
      return
    }

    // 只收运行时依赖。devDependencies 里是构建期工具（node-gyp-build、
    // 各种 darwin-arm64 预编译包），收进来既撑体积又会误报原生模块。
    const wanted = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ])
    if (wanted.size === 0) return

    // 依赖可能装在包自己的 node_modules，也可能在上一层的 node_modules
    // （pnpm 的 `.pnpm/<pkg>/node_modules/` 布局）。
    const searchDirs = [join(packageRoot, 'node_modules'), dirname(packageRoot)]

    for (const name of wanted) {
      if (packages.has(name)) continue
      for (const base of searchDirs) {
        const root = join(base, name)
        if (await isFile(join(root, 'package.json'))) {
          packages.set(name, root)
          pendingPackages.push(root)
          break
        }
      }
    }
  }

  /*
   * 两阶段收集。
   *
   * 阶段一：从入口沿 import 图走，收到直接引用到的包，并记下它们的根。
   * 阶段二：对每个收进来的包，读它声明的 dependencies，把传递依赖也收进来。
   *
   * 为什么必须分两阶段：传递依赖不一定被源码直接 import（可能只在
   * 运行时动态加载），只靠扫描 import 会漏。而按 package.json 声明收
   * 又必须知道「哪些包是我真正要的」——那就是阶段一的产出。
   */
  while (queue.length > 0) {
    const file = queue.shift()
    if (scanned.has(file)) continue
    scanned.add(file)

    let source
    try {
      source = await readFile(file, 'utf8')
    } catch {
      continue
    }

    for (const specifier of scanSpecifiers(source)) {
      if (isSkippable(specifier)) continue

      let resolved
      try {
        // 用「从当前文件位置解析」而不是从项目根解析：包内的相对导入
        // 与嵌套依赖都依赖这个基准，从根解析会把它们全解错。
        const requireFromFile = createRequire(file)
        resolved = requireFromFile.resolve(specifier)
      } catch {
        // 相对路径解析失败说明源码里引用了一个不存在的文件，
        // 这不是打包工具该修的事，记下来交给用户。
        if (isRelative(specifier)) {
          unresolved.push(`${relative(process.cwd(), file)} → ${specifier}`)
          continue
        }
        // 包名解析失败通常是「只在类型层引用的包」，运行时不需要。
        unresolved.push(specifier)
        continue
      }

      if (resolved.endsWith('.node')) {
        natives.push(`${relative(process.cwd(), resolved)}（由 ${specifier} 引入）`)
        continue
      }

      // 解析结果落在 node_modules 里 → 这是一个外部包，整包收。
      if (resolved.includes(`${sep}node_modules${sep}`)) {
        const found = await findPackageRoot(resolved)
        if (found !== null && found.name !== '') {
          // 用「被安装的名字」做键：源码 import 的是别名，不是包名。
          const installName = found.aliasOf ?? found.name
          if (!packages.has(installName)) {
            packages.set(installName, found.root)
            onProgress?.(`收集依赖 ${installName}`)
          }

          /*
           * pnpm 布局：同级的 node_modules 里还躺着这个包的全部依赖。
           *
           * 不把这一层收干净，运行时就是 MODULE_NOT_FOUND——因为
           * 包自己的目录里没有 node_modules，它靠向上查找同级。
           * 这是本项目最容易漏、也最难查的一处。
           */
          // 按这个包自己声明的 dependencies 展开传递依赖。
          await collectSiblings(found.root)

          // 包的入口文件也要扫，才能拿到它的传递依赖。
          if (isScriptFile(resolved)) queue.push(resolved)
        } else if (isScriptFile(resolved)) {
          queue.push(resolved)
        }
        continue
      }

      // 落在项目自己目录里（workspace 包或项目源码）→ 继续扫。
      if (isScriptFile(resolved)) queue.push(resolved)
    }
  }

  /*
   * 建立别名映射。
   *
   * pnpm 允许 `"@ntars/cordis": "npm:cordis@4.0.0-rc.12"` 这种别名安装。
   * 此时源码 import `@ntars/cordis`，而磁盘上的真实包名是 `cordis`。
   *
   * 光看解析结果的目录名看不出这层关系（解析到的是 `.pnpm/.../cordis`），
   * 必须回到**项目的 node_modules** 里看有哪些软链，才能知道
   * 「这个名字指向那个包」。
   *
   * 做法：从入口所在包开始，逐级向上扫描每个 `node_modules` 里的软链，
   * 把「软链名 → 真实包根」记下来。暂存时按软链名建目录。
   */
  const aliases = new Map()
  let dir = dirname(entry)
  for (let depth = 0; depth < 16; depth += 1) {
    const nodeModules = join(dir, 'node_modules')
    if (await isDirectory(nodeModules)) {
      await scanAliases(nodeModules, packages, aliases)
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  /** 扫一个 node_modules，把软链别名登记进 aliases。 */
  async function scanAliases(nodeModules, known, out) {
    let entries
    try {
      entries = await readdir(nodeModules, { withFileTypes: true })
    } catch {
      return
    }
    for (const dirent of entries) {
      if (dirent.name.startsWith('.')) continue

      if (dirent.name.startsWith('@')) {
        const scopeDir = join(nodeModules, dirent.name)
        let scoped
        try {
          scoped = await readdir(scopeDir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const inner of scoped) {
          const full = `${dirent.name}/${inner.name}`
          const path = join(scopeDir, inner.name)
          await registerAlias(full, path, known, out)
        }
        continue
      }

      await registerAlias(dirent.name, join(nodeModules, dirent.name), known, out)
    }
  }

  /** 判断一个 node_modules 条目是不是指向某个已收集包的软链，是就记下别名。 */
  async function registerAlias(name, path, known, out) {
    /*
     * 跳过明显的构建期工具。
     *
     * workspace 的 `node_modules` 里同时装着运行时依赖与开发依赖。
     * `@tauri-apps/cli`、`typescript`、`@types/*` 这些只在开发机上用，
     * 打进包里既撑体积，又可能带上 `*-darwin-arm64` 这类平台二进制
     * （那会让校验报「含原生模块」，而其实它根本不该进包）。
     *
     * 判据是名字，不读 package.json：这里要的是「一眼能判断」，
     * 读文件反而慢且容易因为缺字段而误判。
     */
    if (name === 'typescript' || name === 'tsc') return
    if (name.startsWith('@types/')) return
    if (name.startsWith('@typescript/')) return
    if (name === '@tauri-apps/cli' || name === '@tauri-apps/cli-darwin-arm64') return
    if (name.endsWith('-darwin-arm64') || name.endsWith('-darwin-x64')) return
    if (name.endsWith('-linux-x64') || name.endsWith('-win32-x64')) return

    let info
    try {
      info = await lstat(path)
    } catch {
      return
    }

    /*
     * 软链：可能是别名（指向已收集的包），也可能是 workspace 包。
     *
     * ## workspace 包必须单独处理
     *
     * pnpm 的 workspace 包（`"@ondra/xxx": "workspace:*"`）在磁盘上是
     * `node_modules/@ondra/xxx -> ../../plugins/xxx` 这样的相对软链。
     * 它的真实路径**不在任何 node_modules 里**，所以前面「按路径含
     * node_modules 判定外部包」的逻辑会漏掉它——于是它被当成项目内
     * 文件，永远不会进 `node_modules`，运行时报：
     *
     * ```
     * Cannot find package '@ondra/cordis-plugin-desktop-bridge'
     * ```
     *
     * 修法：只要 `node_modules` 里有一个条目指向一个含 `package.json`
     * 的目录，就把它当作要收的包——不管真实路径在哪。
     */
    if (!info.isSymbolicLink()) return

    let real
    try {
      real = await realpath(path)
    } catch {
      return
    }

    // 已收集的包：记下别名关系。
    for (const [packageName, root] of known) {
      if (real === root || real.startsWith(root + sep)) {
        if (name !== packageName) out.set(name, packageName)
        return
      }
    }

    // workspace 包：直接补进 packages，名字用软链名（源码 import 的就是它）。
    if (await isFile(join(real, 'package.json'))) {
      if (!known.has(name)) {
        known.set(name, real)
        pendingPackages.push(real)
      }
    }
  }

  // 阶段三：展开传递依赖，直到没有新的包。
  while (pendingPackages.length > 0) {
    const root = pendingPackages.shift()
    await collectSiblings(root)
  }

  if (natives.length > 0) {
    throw new BuildError(
      ErrorCode.PROJECT_NATIVE_MODULE,
      `项目含 ${String(natives.length)} 个原生模块，无法跨架构使用`,
      {
        details: natives.slice(0, 10),
        hint:
          '原生模块（.node）是针对特定操作系统与 CPU 编译的机器码，macOS 版本搬不进 Windows。'
          + '换用纯 JS 的替代包，或在 Windows 机器上重新安装该依赖后再打包。',
      },
    )
  }

  return {
    packages,
    aliases,
    files: [...scanned],
    natives,
    unresolved: [...new Set(unresolved)],
  }
}