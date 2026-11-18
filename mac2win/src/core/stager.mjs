/**
 * 暂存（staging）与前端注入。
 *
 * ## 目录契约
 *
 * 生成出来的安装目录长这样，启动器 `bootstrap.mjs` 完全依赖这个形状：
 *
 * ```
 * <安装目录>/
 *   app/
 *     node.exe              ← Windows x86 运行时
 *     bootstrap/
 *       bootstrap.mjs       ← 启动器
 *       launch.json         ← 启动清单（入口、参数、环境变量）
 *     ui/                   ← 前端产物（原样搬过来，注入垫片）
 *     host/                 ← 宿主 + 它的 node_modules（已扁平化）
 *     data/                 ← 运行期数据（安装时不存在，启动器自己建）
 * ```
 *
 * `app/` 这一层是刻意的：安装目录根下只放一个 `app/` 与卸载器，
 * 用户想手动清理时不容易误删；卸载时删一个目录就干净。
 */

import { readFile, writeFile } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { BuildError, ErrorCode } from './errors.mjs'
import { copyFile, copyTree, isDirectory, isFile, walkFiles } from '../util/fsx.mjs'

/** 前端注入的垫片文件名。与 `src/launcher/shim.js` 对应。 */
const SHIM_NAME = 'mac2win-shim.js'

/**
 * 把前端产物搬进暂存区，并注入桌面壳垫片。
 *
 * ## 注入位置为什么必须精确
 *
 * 垫片必须在**页面主脚本之前**执行。前端在模块顶层就调
 * `listenShell('host-ready')`，晚一步注册就收不到那条一次性广播。
 * 而 `index.html` 的主脚本是 `<script type="module" src="...">`——
 * `type="module"` 自带 `defer` 语义，会在 HTML 解析完之后才跑，
 * 所以把普通 `<script src>` 放在 `<head>` 里就足够早。
 *
 * ## `merge` 模式
 *
 * Electron / NW.js 的暂存目录里已经有项目文件了，前端产物要**合并**
 * 进去而不是覆盖整个目录。合并时前端产物优先（它是构建产物，
 * 比源码目录里的同名文件更权威）。
 *
 * @param {object} input
 * @param {string} input.source 前端产物目录。
 * @param {string} input.target 目标目录。
 * @param {string} input.shimPath 垫片源文件。
 * @param {boolean} [input.merge] 是否合并进已有目录（不先清空）。
 * @returns {Promise<{injected: boolean, reason?: string}>}
 */
export async function stageFrontend(input) {
  const { source, target, shimPath, merge = false } = input

  if (!(await isDirectory(source))) {
    throw new BuildError(ErrorCode.PROJECT_ARTIFACT_MISSING, `前端产物目录不存在：${source}`, {
      hint: '先跑项目自己的构建；或把配置里的 frontendDist 指向正确的产物目录',
    })
  }

  // merge 模式下目标里已有项目文件，直接叠加；否则整体拷贝。
  if (!merge) {
    await copyTree(source, target)
  } else {
    await mergeTree(source, target)
  }

  const indexPath = join(target, 'index.html')
  if (!(await isFile(indexPath))) {
    // 没有 index.html 就不是能直接打开的静态站点。不阻断打包
    // （可能用户只想打包宿主），但要明确告诉用户注入没做成。
    return { injected: false, reason: '产物里没有 index.html，跳过垫片注入' }
  }

  await copyFile(shimPath, join(target, SHIM_NAME))

  const html = await readFile(indexPath, 'utf8')
  if (html.includes(SHIM_NAME)) {
    return { injected: true, reason: '已注入过' }
  }

  /*
   * 相对路径 `./mac2win-shim.js` 而不是绝对路径 `/mac2win-shim.js`：
   * 打包后的资源可能被放在子路径下（比如某些静态托管），相对路径两种
   * 情况都对。同理 `runtime.json` 也是相对取。
   */
  const tag = `<script src="./${SHIM_NAME}"></script>`

  let patched
  const headClose = html.search(/<\/head\s*>/i)
  if (headClose >= 0) {
    // 放进 </head> 之前：这是最早能执行脚本、且 DOM 结构完整的位置。
    patched = `${html.slice(0, headClose)}  ${tag}\n${html.slice(headClose)}`
  } else {
    // 没有 head（极少见）：退回插在第一个 script 之前。
    const firstScript = html.search(/<script/i)
    patched = firstScript >= 0
      ? `${html.slice(0, firstScript)}${tag}\n${html.slice(firstScript)}`
      : `${tag}\n${html}`
  }

  await writeFile(indexPath, patched)
  return { injected: true }
}

/**
 * 把 source 叠加进已存在的 target。
 *
 * 与 copyTree 的差别：目标已存在时不报错、不跳过，而是按文件覆盖。
 * 这正是「构建产物覆盖源码里的同名占位文件」需要的行为。
 */
async function mergeTree(source, target) {
  const files = await walkFiles(source)
  for (const relative of files) {
    await copyFile(join(source, relative), join(target, relative))
  }
}

/**
 * 把宿主搬进暂存区。
 *
 * ## 为什么不能只整目录拷贝
 *
 * 源码形态下，`cordis-host/node_modules/@ntars/cordis` 是一个软链，
 * 指向仓库根的 `node_modules/.pnpm/cordis@.../node_modules/cordis`。
 * 而 `cordis` 自己的依赖（`cosmokit` 等）**不在 `cordis` 目录里**，
 * 而在它上一层的 `node_modules`。
 *
 * 所以「整目录拷贝」+「解开软链」只能拿到 `cordis` 本身，拿不到
 * `cosmokit`。运行时报：
 *
 * ```
 * Cannot find package 'cosmokit' imported from …/@ntars/cordis/lib/index.js
 * ```
 *
 * ## 正确做法：拷贝代码 + 按收集结果重建 node_modules
 *
 * 1. 拷宿主的**代码**（`lib/`、`content/`、`package.json`），跳过
 *    `node_modules`——那里全是软链，拷了也没用。
 * 2. 按依赖收集器的结果，把每个包的真实内容拷进
 *    `host/node_modules/<包名>/`，形成**扁平化**结构。
 *
 * 扁平化在 Windows 上更稳：Node 从脚本所在目录逐级向上找
 * `node_modules`，扁平布局一定能找到；而 pnpm 的嵌套+软链布局
 * 依赖软链，Windows 上不成立。
 *
 * @param {object} input
 * @param {string} input.hostDir 宿主目录（含入口）。
 * @param {string} input.target 暂存区的 `host/` 目录。
 * @param {string} input.entry 入口文件绝对路径。
 * @param {Map<string, string>} [input.packages] 包名 → 包根目录（来自收集器）。
 * @param {(message: string) => void} [input.onProgress]
 * @returns {Promise<{relativeEntry: string, packageCount: number}>}
 */
export async function stageHost(input) {
  const { hostDir, target, entry, packages, aliases, onProgress, skipJunk = true } = input

  if (!(await isDirectory(hostDir))) {
    throw new BuildError(ErrorCode.PROJECT_ARTIFACT_MISSING, `宿主目录不存在：${hostDir}`, {
      hint: '确认配置里的 entry 指向一个已构建好的入口脚本',
    })
  }
  if (!entry.startsWith(hostDir)) {
    throw new BuildError(ErrorCode.CONFIG_INVALID, '入口文件不在宿主目录内', {
      details: [`入口：${entry}`, `宿主目录：${hostDir}`],
      hint: 'entry 必须位于它自己的包里（与 node_modules 同级），否则依赖解析会失败',
    })
  }

  /*
   * 拷代码，跳过 node_modules。
   *
   * ## 为什么不用 tar 管道
   *
   * `tar -cf - | tar -xf -` 本来是最快的做法（两个进程、一次 I/O 流），
   * 但它在受管环境里会失败：某些沙箱会拦截 tar 的 stdout 重定向，
   * 报 `Unrecognized archive format`。所以这里退回逐文件拷贝，
   * 靠**并发**把 3344 次系统调用压缩到可接受的时间。
   *
   * 并发度 32 是实测的平衡点：再高会撞到文件描述符上限，
   * 而单次 I/O 延迟占主导时并发收益会饱和。
   */
  const files = await walkFiles(hostDir, {
    // 遍历时就跳过 node_modules：那里有 4000+ 文件，先扫后滤白费时间。
    skipDirs: (absolute, name) => name === 'node_modules',
  })

  const BATCH = 32
  for (let index = 0; index < files.length; index += BATCH) {
    const slice = files.slice(index, index + BATCH)
    await Promise.all(slice.map(async (relative) => {
      await copyFile(join(hostDir, relative), join(target, relative))
    }))
    if ((index / BATCH) % 20 === 0) {
      onProgress?.(`已拷贝宿主 ${String(Math.min(index + BATCH, files.length))} / ${String(files.length)} 个文件`)
    }
  }

  // 按收集结果重建扁平的 node_modules。
  let packageCount = 0
  if (packages !== undefined && packages.size > 0) {
    const entries = [...packages.entries()]
    const CONCURRENCY = 4

    for (let index = 0; index < entries.length; index += CONCURRENCY) {
      const slice = entries.slice(index, index + CONCURRENCY)
      await Promise.all(slice.map(async ([name, root]) => {
        /*
         * 跳过包内部的 `node_modules`。
         *
         * pnpm 把每个包依赖的包软链进它自己的 `node_modules`——实测
         * 83 个包里 80 个都带。整目录拷会把软链农场展开成真实文件：
         * 实测 3777 个文件膨胀到 51475 个，构建时间从几十秒变成两小时。
         *
         * 依赖已由收集器统一收集并放在**同一层**的 `node_modules` 下，
         * 扁平化之后 Node 从任何位置都能解析到，不需要包内部那一份。
         */
        await copyTree(root, join(target, 'node_modules', name), {
          skipDirs: (absolute, dirName) => dirName === 'node_modules',
        })
      }))
      packageCount += slice.length
      onProgress?.(`已放入 ${String(packageCount)} / ${String(entries.length)} 个依赖包`)
    }

    /*
     * 建立别名目录。
     *
     * 源码 import 的是 `@ntars/cordis`，而真实包名是 `cordis`。
     * Node 解析时按 import 的字面量找目录，所以必须有
     * `node_modules/@ntars/cordis` 这个路径。
     *
     * 做法：把真实包的内容**再拷一份**到别名路径下。
     * 为什么不用软链：Windows 上创建软链需要管理员权限或开发者模式，
     * 用户机器上大概率失败。而别名包通常很小（cordis 本体 93 KiB），
     * 多一份的代价远低于一个「装完启动不了」的风险。
     */
    if (aliases !== undefined && aliases.size > 0) {
      for (const [aliasName, realName] of aliases) {
        const realRoot = packages.get(realName)
        if (realRoot === undefined) continue
        await copyTree(realRoot, join(target, 'node_modules', aliasName), {
          skipDirs: (absolute, name) => name === 'node_modules',
        })
        onProgress?.(`建立别名 ${aliasName} → ${realName}`)
      }
    }
  }

  return {
    relativeEntry: entry.slice(hostDir.length).replace(/^[\\/]/, ''),
    packageCount,
  }
}

/**
 * 把额外资源搬进暂存区。
 *
 * @param {object} input
 * @param {Array<{source: string, name: string}>} input.resources 资源清单。
 * @param {string} input.appDir 暂存区的 `app/` 目录。
 * @returns {Promise<string[]>} 落地后的相对路径。
 */
export async function stageResources(input) {
  const { resources, appDir } = input
  const landed = []

  for (const resource of resources) {
    if (!(await isDirectory(resource.source)) && !(await isFile(resource.source))) {
      throw new BuildError(ErrorCode.PROJECT_ARTIFACT_MISSING, `资源路径不存在：${resource.source}`, {
        hint: '检查配置里的 resources 列表',
      })
    }
    const target = join(appDir, resource.name)
    if (await isDirectory(resource.source)) {
      await copyTree(resource.source, target)
    } else {
      await copyFile(resource.source, target)
    }
    landed.push(resource.name)
  }

  return landed
}

/**
 * 写启动清单。
 *
 * 启动器读这个文件决定「跑哪个入口、带什么参数、设什么环境变量」。
 * 把它写成数据而不是硬编码进启动器，是为了让同一个启动器能服务
 * 任意项目——启动器不需要知道空谷是什么。
 */
export async function writeLaunchManifest(input) {
  const { bootstrapDir, manifest } = input
  await writeFile(join(bootstrapDir, 'launch.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
}

/**
 * 收集暂存区的文件清单与哈希。
 *
 * 这份清单有三个用途：
 * 1. 校验：安装包解开后逐项比对，确认没有文件在压缩/解压中损坏。
 * 2. 审计：用户能看到包里到底有什么，而不是一个黑盒 exe。
 * 3. 排错：少文件时能一眼看出少的是哪个。
 *
 * @param {string} appDir 暂存区的 `app/` 目录。
 * @returns {Promise<Array<{path: string, size: number, sha256: string}>>}
 */
export async function buildFileManifest(appDir) {
  const { sha256File } = await import('../util/fsx.mjs')
  const { stat } = await import('node:fs/promises')

  const files = await walkFiles(appDir)
  const manifest = []

  for (const relative of files) {
    const absolute = join(appDir, relative)
    const info = await stat(absolute)
    manifest.push({
      path: relative,
      size: info.size,
      sha256: await sha256File(absolute),
    })
  }

  return manifest
}

/** 从入口路径反推它所属的包根目录（最近的含 package.json 的祖先）。 */
export async function findHostRoot(entry) {
  const { dirname } = await import('node:path')
  let dir = dirname(entry)
  for (let depth = 0; depth < 32; depth += 1) {
    if (await isFile(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // 找不到 package.json 就退回入口所在目录：只要 node_modules 在
  // 某一层祖先里，Node 仍然能解析，整体拷过去依然成立。
  return dirname(entry)
}