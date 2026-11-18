/**
 * 构建编排。
 *
 * ## 阶段划分
 *
 * ```
 * 0 预检      环境、工具、路径、目标 —— 全查完才动手
 * 1 项目构建  跑用户自己的 build 命令
 * 2 运行时    拿到 Windows x86 的 node.exe
 * 3 依赖收集  从入口走 require 图，拦住原生模块
 * 4 暂存      按目录契约摆好文件，注入垫片
 * 5 清单      算每个文件的哈希
 * 6 打包      NSIS 编译
 * 7 校验      解包比对，验 PE 与完整性
 * ```
 *
 * ## 为什么阶段之间不共享状态
 *
 * 每个阶段读「上一阶段的产物」而不是「上一阶段的内存变量」。
 * 这样任一阶段都能单独重跑（排查时极有用），也保证了
 * 「日志里看到的就是磁盘上有的」。
 *
 * ## 取消
 *
 * 长流程必须能取消。这里用 `AbortSignal` 贯穿：外部进程被 kill，
 * 阶段之间检查 `signal.aborted` 提前返回。取消不是失败，
 * 上层要能区分（用户点了取消不该报红色错误）。
 */

import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { BuildError, ErrorCode } from './errors.mjs'
import { Level } from './logger.mjs'
import { collectDependencies } from './collector.mjs'
import { ensureRuntime } from './runtime.mjs'
import { ensureElectron, repackElectron } from './electron.mjs'
import { ensureNwjs, repackNwjs } from './nwjs.mjs'
import { describeCapabilities } from './frameworks.mjs'
import { buildRustShell } from './rust-shell.mjs'
import { findMakensis, runPreflight, preflightToError } from './preflight.mjs'
import {
  buildFileManifest,
  findHostRoot,
  stageFrontend,
  stageHost,
  stageResources,
  writeLaunchManifest,
} from './stager.mjs'
import { writeNsisScript } from './nsis.mjs'
import { verifyArtifact, verifyZip } from '../verify/artifact.mjs'
import { zipDirectory } from './zipwriter.mjs'
import { copyFile, copyTree, humanBytes, isDirectory, isFile, measureTree, remove, walkFiles } from '../util/fsx.mjs'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

const run = promisify(execFile)

/** 构建阶段定义。顺序即执行顺序，界面按这个列表画进度。 */
export const STAGES = [
  { id: 'preflight', title: '预检', weight: 1 },
  { id: 'project-build', title: '项目构建', weight: 3 },
  { id: 'runtime', title: '准备运行时', weight: 4 },
  { id: 'collect', title: '收集依赖', weight: 2 },
  { id: 'stage', title: '暂存文件', weight: 4 },
  { id: 'manifest', title: '生成清单', weight: 2 },
  { id: 'package', title: '打包安装包', weight: 5 },
  { id: 'verify', title: '校验产物', weight: 3 },
]

/** 一次构建的完整结果。 */
export class BuildResult {
  constructor() {
    /** @type {string | null} */
    this.artifact = null
    /** @type {string | null} */
    this.zipArtifact = null
    this.artifactSize = 0
    this.zipSize = 0
    /** @type {object | null} */
    this.preflight = null
    /** @type {object | null} */
    this.verify = null
    this.durationMs = 0
    /** @type {Array} */
    this.manifest = []
    this.stagingDir = null
    this.scriptPath = null
  }
}

/**
 * 构建器。
 *
 * 一个实例对应一次构建。不要复用：内部的 staging 路径带时间戳，
 * 复用会让上一次的残留混进这一次。
 */
export class Builder {
  /**
   * @param {object} input
   * @param {object} input.config 归一化配置。
   * @param {import('./logger.mjs').Logger} input.logger 日志器。
   * @param {AbortSignal} [input.signal] 取消信号。
   */
  constructor(input) {
    this.config = input.config
    this.logger = input.logger
    this.signal = input.signal
    this.startedAt = Date.now()
    /** 当前阶段索引，供进度计算。 */
    this.stageIndex = 0
    /** 总权重，预先算好。 */
    this.totalWeight = STAGES.reduce((sum, stage) => sum + stage.weight, 0)
    /** 已完成阶段的权重累计。 */
    this.doneWeight = 0
    /** 进度回调。 */
    this.onProgress = null
  }

  /** 检查是否已取消。 */
  checkCancelled() {
    if (this.signal?.aborted === true) {
      throw new BuildError(ErrorCode.CANCELLED, '构建已取消')
    }
  }

  /**
   * 进入一个阶段。写日志、推进度。
   *
   * @param {string} id 阶段 id。
   */
  enterStage(id) {
    const index = STAGES.findIndex((stage) => stage.id === id)
    if (index >= 0) {
      this.stageIndex = index
      const stage = STAGES[index]
      this.logger.step(`[${String(index + 1)}/${String(STAGES.length)}] ${stage.title}`)
      this.onProgress?.({
        stage: stage.id,
        stageTitle: stage.title,
        index,
        total: STAGES.length,
        percent: Math.round((this.doneWeight / this.totalWeight) * 100),
      })
    }
    this.checkCancelled()
  }

  /** 离开一个阶段，把它的权重计入进度。 */
  leaveStage(id) {
    const stage = STAGES.find((item) => item.id === id)
    if (stage !== undefined) this.doneWeight += stage.weight
    this.onProgress?.({
      stage: id,
      index: this.stageIndex,
      total: STAGES.length,
      percent: Math.round((this.doneWeight / this.totalWeight) * 100),
    })
  }

  /**
   * 跑完整构建。
   *
   * @returns {Promise<BuildResult>}
   */
  async build() {
    const result = new BuildResult()
    const config = this.config

    // --- 0. 预检 ---
    this.enterStage('preflight')
    const report = await runPreflight(config, (message) => { this.logger.debug(message) })
    result.preflight = report

    for (const check of report.checks) {
      if (check.status === 'pass') this.logger.info(`✓ ${check.title}：${check.detail}`)
      else if (check.status === 'warn') this.logger.warn(`${check.title}：${check.detail}${check.hint === undefined ? '' : `（${check.hint}）`}`)
      else this.logger.error(`${check.title}：${check.detail}${check.hint === undefined ? '' : ` → ${check.hint}`}`)
    }

    if (report.failed) throw preflightToError(report)
    this.leaveStage('preflight')

    // --- 1. 项目构建 ---
    this.enterStage('project-build')

    /*
     * 先跑检查命令，再跑构建命令。
     *
     * `preflightCommands` 是用户自己的门槛：跑 lint、跑测试、校验
     * 版本号一致性。放在构建**之前**，因为这些检查通常是「代码就绪
     * 了没」的判据，不通过就没必要浪费几分钟去构建。
     *
     * 任一命令失败即中止——这是检查的本意。用户如果想让某条失败也
     * 继续，就不该把它写进这个列表。
     */
    if (Array.isArray(config.preflightCommands) && config.preflightCommands.length > 0) {
      for (const command of config.preflightCommands) {
        this.logger.info(`检查：${command}`)
        await this.runProjectBuild(command, { kind: 'check' })
        this.logger.success(`检查通过：${command}`)
      }
    }

    if (config.buildCommand !== null && config.buildCommand !== '') {
      await this.runProjectBuild(config.buildCommand)
    } else {
      this.logger.info('未配置构建命令，跳过（假定产物已就绪）')
    }
    this.leaveStage('project-build')

    // --- 2. 运行时 ---
    this.enterStage('runtime')
    /*
     * 运行时按框架分流。
     *
     * Electron / NW.js 自带原生壳，所以它们要的是**框架自己的**
     * 预编译二进制；Tauri / 纯 Node / 静态站没有可用的壳，走
     * 「node.exe + 启动器」这条路。
     *
     * 两条路都必须有一个 Windows x86 的 Node 运行时：
     * - Electron / NW.js 用它跑启动器（拉起原生壳、托管静态服务）；
     * - 其余形态它就是应用本体。
     */
    const framework = this.config.framework
    const nodeRuntime = await ensureRuntime({
      version: config.runtimeVersion,
      archive: config.runtimeArchive,
      checksum: config.runtimeChecksum,
      // 架构必须传下去：不传就会一律下 win-x86，
      // 于是 --target x64 得到的是 32 位包。
      target: config.target,
      onProgress: (message) => { this.logger.info(message) },
    })
    this.logger.success(
      `Node 运行时就绪 v${nodeRuntime.version}，SHA-256 ${nodeRuntime.sha256.slice(0, 16)}…${nodeRuntime.fromCache ? '（缓存）' : ''}`,
    )

    let shellRuntime = null
    if (framework === 'electron') {
      shellRuntime = await ensureElectron({
        version: config.electronVersion,
        target: config.target,
        archive: config.electronArchive,
        onProgress: (message) => { this.logger.info(message) },
      })
      this.logger.success(`Electron ${shellRuntime.version} 就绪（${config.target}）`)
    } else if (framework === 'nwjs') {
      shellRuntime = await ensureNwjs({
        version: config.nwjsVersion,
        target: config.target,
        flavor: config.nwjsFlavor,
        archive: config.nwjsArchive,
        onProgress: (message) => { this.logger.info(message) },
      })
      this.logger.success(`NW.js ${shellRuntime.version} 就绪（${config.target}）`)
    } else if (framework === 'tauri') {
      if (config.buildRustShell === true) {
        /*
         * 显式要求编译 Rust 壳。
         *
         * 这条路真实存在且能产出真正的原生窗口，代价是 1.5GB 依赖
         * 与 10–30 分钟首次构建。预检阶段已经确认环境齐全，
         * 这里直接编。
         */
        this.logger.info('正在用 cargo-xwin 编译 Rust 壳（首次构建较慢）')
        const rustResult = await buildRustShell({
          projectRoot: config.projectRoot,
          tauriDir: config.tauriDir ?? undefined,
          profile: config.rustProfile,
          onProgress: (message) => { this.logger.info(message) },
          signal: this.signal,
        })
        this.rustExe = rustResult.exePath
        this.logger.success(
          `Rust 壳编译完成 ${rustResult.exePath}（${(rustResult.durationMs / 1000).toFixed(0)} 秒）`,
        )
      } else {
        // 不编 Rust 壳时必须明确告知，不能让用户以为拿到了原生窗口。
        this.logger.warn('Tauri 的 Rust 壳需要 cargo-xwin 才能跨架构编译，本次未启用')
        this.logger.warn('产物不含原生窗口，界面将通过系统默认浏览器打开')
        this.logger.debug('要原生窗口：配置里设 buildRustShell: true（需 Rust + LLVM + cargo-xwin）')
      }
    }
    this.leaveStage('runtime')

    // --- 3. 依赖收集 ---
    this.enterStage('collect')
    let collected = null
    let hostRoot = null
    if (config.entry !== null) {
      collected = await collectDependencies({
        entry: config.entry,
        onProgress: (message) => { this.logger.debug(message) },
      })
      hostRoot = await findHostRoot(config.entry)
      this.logger.info(`从入口走到 ${String(collected.packages.size)} 个外部包`)
      if (collected.unresolved.length > 0) {
        // 解析不了的说明符多半是「只在类型层引用」的包，不影响运行。
        this.logger.debug(`有 ${String(collected.unresolved.length)} 个说明符未解析（通常不影响运行）`)
      }
    } else {
      this.logger.info('未配置宿主入口，跳过依赖收集')
    }
    this.leaveStage('collect')

    // --- 4. 暂存 ---
    this.enterStage('stage')
    const staging = await this.prepareStaging(result, nodeRuntime, hostRoot, shellRuntime, collected)
    this.logger.info(`暂存目录 ${staging.appDir}`)
    this.leaveStage('stage')

    // --- 5. 清单 ---
    this.enterStage('manifest')
    const manifest = await buildFileManifest(staging.appDir)
    const manifestPath = join(staging.bootstrapDir, 'files.json')
    await writeFile(manifestPath, `${JSON.stringify({ files: manifest }, undefined, 2)}\n`)
    const measured = await measureTree(staging.appDir)
    this.logger.info(`载荷 ${String(manifest.length)} 个文件，${humanBytes(measured.bytes)}`)
    result.manifest = manifest
    this.leaveStage('manifest')

    // --- 6. 打包 ---
    this.enterStage('package')
    await mkdir(config.outDir, { recursive: true })

    /*
     * 产物形态分流。
     *
     * `nsis` 出安装包 exe（默认），`zip` 出免安装压缩包。
     * 两者都基于同一个暂存区，区别只在最后一步怎么封。
     *
     * `alsoZip` 让 nsis 模式额外再出一个 zip——发布时常常两个都要：
     * 给普通用户安装包，给便携用户压缩包。
     */
    const wantNsis = config.format === 'nsis'
    const wantZip = config.format === 'zip' || config.alsoZip === true

    if (wantNsis) {
      const artifactName = config.artifactName ?? defaultArtifactName(config)
      const artifactPath = join(config.outDir, artifactName)

      const scriptPath = join(staging.stagingDir, 'installer.nsi')
      await writeNsisScript({
        config,
        stagingAppDir: staging.appDir,
        outputFile: artifactPath,
        scriptPath,
        iconFile: config.iconFile,
        licenseFile: config.licenseFile,
      })
      result.scriptPath = scriptPath
      await this.compileNsis(scriptPath)
      result.artifact = artifactPath
      result.artifactSize = (await stat(artifactPath)).size
      this.logger.success(`安装包 ${artifactPath}（${humanBytes(result.artifactSize)}）`)
    }

    if (wantZip) {
      const zipName = config.artifactName === null
        ? defaultArtifactName(config).replace(/\.exe$/, '.zip')
        : config.artifactName.replace(/\.exe$/, '.zip')
      const zipPath = join(config.outDir, zipName)

      this.logger.info('生成免安装压缩包')
      const zipped = await zipDirectory({
        source: staging.appDir,
        outputFile: zipPath,
        rootName: String(config.productName).replace(/[\\/:*?"<>|]/g, '-').trim() || 'app',
        onProgress: (message) => { this.logger.debug(message) },
      })
      this.logger.success(
        `压缩包 ${zipPath}（${humanBytes(zipped.compressedBytes)}，`
        + `${String(zipped.files)} 个文件，原始 ${humanBytes(zipped.bytes)}）`,
      )
      result.zipArtifact = zipPath
      result.zipSize = zipped.compressedBytes
      // 纯 zip 模式下它就是主产物。
      if (!wantNsis) {
        result.artifact = zipPath
        result.artifactSize = zipped.compressedBytes
      }
    }

    this.leaveStage('package')

    // --- 7. 校验 ---
    this.enterStage('verify')
    if (config.verify) {
      /*
       * 按产物类型选校验方式。
       *
       * exe 走「PE 头 + 解 NSIS 载荷逐文件哈希」；zip 走
       * 「解 zip 逐文件哈希」。两条路的共同点：都要验到**每个文件的
       * 内容**，而不只是包本身能打开。
       */
      const targets = []
      if (result.artifact !== null && result.artifact.endsWith('.exe')) {
        targets.push({ path: result.artifact, kind: 'exe' })
      }
      if (result.zipArtifact !== null) {
        targets.push({ path: result.zipArtifact, kind: 'zip' })
      }

      let allOk = true
      const allFailures = []
      const allUnverified = []

      for (const target of targets) {
        this.logger.info(`校验 ${target.path.split('/').pop()}`)
        const verifyReport = target.kind === 'exe'
          ? await verifyArtifact({
            artifact: target.path,
            expectedManifest: manifest,
            expectTarget: config.target,
            onProgress: (message) => { this.logger.debug(message) },
          })
          : await verifyZip({
            artifact: target.path,
            expectedManifest: manifest,
            expectTarget: config.target,
            onProgress: (message) => { this.logger.debug(message) },
          })

        // 只保留主产物的报告给界面展示，避免两份报告互相覆盖。
        if (target === targets[0]) result.verify = verifyReport

        for (const item of verifyReport.items) {
          if (item.status === 'pass') this.logger.info(`✓ ${item.title}：${item.detail}`)
          else if (item.status === 'warn') this.logger.warn(`${item.title}：${item.detail}`)
          else this.logger.error(`${item.title}：${item.detail}`)
        }

        if (!verifyReport.ok) {
          allOk = false
          for (const failure of verifyReport.failures) {
            allFailures.push(`${target.path.split('/').pop()}：${failure.title}：${failure.detail}`)
          }
        }
        /*
         * 「没验」与「验了不合格」分开收。
         *
         * 产物的字节内容有没有问题，与机器上有没有 7-Zip 是两件事。
         * 前者要重打，后者装个工具重跑就行——混在一个错误码里，
         * 用户会照着「产物损坏」的方向白查半天。
         */
        for (const skipped of verifyReport.unverified) {
          allUnverified.push(`${target.path.split('/').pop()}：${skipped.title}`)
        }
      }

      if (!allOk) {
        throw new BuildError(ErrorCode.VERIFY_FAILED, '产物校验未通过', {
          details: allFailures,
          hint: '产物已生成但不可信，不要分发。日志里有逐项结果，可用 --keep-staging 保留中间产物排查',
        })
      }

      /*
       * 产物没查出问题，但没验全——这不能算构建成功。
       *
       * ## 为什么构建也要卡这一条
       *
       * `verify: true` 是默认值，意思是「构建完自动验一遍」。如果
       * 缺 7-Zip 时这里放行，用户得到的是一个**标着通过、实际只验了
       * PE 头**的产物，还会照着校验结论去分发。构建命令必须和
       * 独立的 `verify` 子命令给出一致的结论，否则同一个包在两处
       * 得到两个答案，信任就没了。
       */
      if (allUnverified.length > 0) {
        throw new BuildError(ErrorCode.TOOL_MISSING, '产物校验未完成（缺 7-Zip）', {
          details: allUnverified,
          hint: '安装 7-Zip 后重跑：brew install sevenzip。'
            + '或用 --no-verify 明确跳过校验（产物未经验证，不推荐）',
        })
      }
    } else {
      this.logger.warn('校验被关闭（verify: false），产物未经验证')
    }
    this.leaveStage('verify')

    // --- 收尾：清理或保留暂存区 ---
    if (!config.keepStaging) {
      await remove(staging.stagingDir)
    } else {
      this.logger.info(`已保留暂存目录 ${staging.stagingDir}`)
      result.stagingDir = staging.stagingDir
    }

    result.durationMs = Date.now() - this.startedAt
    return result
  }

  /**
   * 跑项目自己的命令（构建或检查）。
   *
   * 命令是用户配置的字符串，必须走 shell——否则 `npm run build`
   * 里的 `&&` 与管道都不成立。这也是唯一需要信任用户配置的地方，
   * 但用户本来就在自己的项目里跑自己的脚本，没有额外风险。
   *
   * @param {string} command 命令。
   * @param {object} [options]
   * @param {'build' | 'check'} [options.kind] 用来决定失败文案。
   */
  async runProjectBuild(command, options = {}) {
    const kind = options.kind ?? 'build'
    this.logger.info(`执行 ${command}`)
    try {
      await new Promise((resolve, reject) => {
        const child = execFile('/bin/sh', ['-c', command], {
          cwd: this.config.projectRoot,
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, FORCE_COLOR: '0' },
        }, (error, stdout, stderr) => {
          if (error !== null) {
            reject(Object.assign(error, { stdout, stderr }))
            return
          }
          resolve({ stdout, stderr })
        })

        // 把子进程的输出实时转进日志，而不是等它结束一次性打印。
        // 构建命令动辄跑几分钟，没有实时输出用户无法判断是不是卡住了。
        child.stdout?.setEncoding('utf8')
        child.stdout?.on('data', (chunk) => {
          for (const line of String(chunk).split('\n')) {
            if (line.trim() !== '') this.logger.debug(`  ${line}`)
          }
        })
        child.stderr?.setEncoding('utf8')
        child.stderr?.on('data', (chunk) => {
          for (const line of String(chunk).split('\n')) {
            if (line.trim() !== '') this.logger.debug(`  ${line}`)
          }
        })

        // 取消时杀掉整个进程组：构建命令常常会派生子进程（tsc、vite），
        // 只杀父进程会留下一堆孤儿继续占 CPU。
        this.signal?.addEventListener('abort', () => {
          child.kill('SIGTERM')
          setTimeout(() => { child.kill('SIGKILL') }, 3000).unref()
        }, { once: true })
      })
    } catch (error) {
      const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : ''
      const tail = stderr.split('\n').slice(-12).filter((line) => line.trim() !== '')
      throw new BuildError(
        ErrorCode.PROJECT_BUILD_FAILED,
        kind === 'check' ? `检查命令未通过：${command}` : `项目构建命令失败：${command}`,
        {
          details: tail,
          hint: kind === 'check'
            ? '检查不通过时不继续打包。修好问题，或从 preflightCommands 里移除这条'
            : '先在终端里手动跑一遍这条命令，确认它自己能成功',
        },
      )
    }
  }

  /**
   * 准备暂存目录。
   *
   * ## 三种形态
   *
   * | 框架 | app/ 里的结构 | 谁负责开窗口 |
   * | --- | --- | --- |
   * | electron | electron/（含改名后的 exe + resources/app） | Electron 自己 |
   * | nwjs | nwjs/（含改名后的 exe + 项目文件） | NW.js 自己 |
   * | tauri / node / static | host/ + ui/ + bootstrap | 启动器（开浏览器） |
   *
   * 三种形态都带 `node.exe` 与 `bootstrap/`：Electron / NW.js 的
   * 启动器负责拉起原生壳并托管静态服务，其余形态的启动器就是应用本体。
   * 统一入口让 NSIS 的快捷方式目标永远只有一个。
   */
  async prepareStaging(result, nodeRuntime, hostRoot, shellRuntime, collected) {
    const config = this.config
    const framework = config.framework
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const stagingDir = join(config.outDir, `.staging-${stamp}`)
    const appDir = join(stagingDir, 'app')
    const bootstrapDir = join(appDir, 'bootstrap')

    await mkdir(bootstrapDir, { recursive: true })

    const { copyFile } = await import('../util/fsx.mjs')
    const { fileURLToPath } = await import('node:url')
    const { dirname } = await import('node:path')
    const here = dirname(fileURLToPath(import.meta.url))
    const launcherSource = join(here, '..', 'launcher', 'bootstrap.mjs')
    const shimSource = join(here, '..', 'launcher', 'shim.js')

    // 运行时：所有形态都需要（Electron / NW.js 也用它跑启动器）
    /*
     * 文件名跟 `launcherExe` 走，不写死 `node.exe`。
     *
     * NSIS 的快捷方式指向 `app/<launcherExe>`，暂存区必须放同名文件，
     * 否则快捷方式指向一个不存在的路径——用户双击闪一下就没了。
     * 这两处必须用同一个真源。
     */
    const runtimeName = config.launcherExe ?? 'node.exe'
    await copyFile(nodeRuntime.nodePath, join(appDir, runtimeName))
    this.logger.debug(`${runtimeName} ${humanBytes((await stat(join(appDir, runtimeName))).size)}`)

    // 启动器与垫片
    await copyFile(launcherSource, join(bootstrapDir, 'bootstrap.mjs'))
    await copyFile(shimSource, join(bootstrapDir, 'shim.js'))
    this.logger.debug('启动器已就位')

    /** 前端产物目录：三种形态都要，垫片注入靠它。 */
    let uiDir = join(appDir, 'ui')

    if (framework === 'electron' && shellRuntime !== null) {
      // --- Electron：把项目塞进 resources/app，主程序改名 ---
      const repacked = await repackElectron({
        electronDir: shellRuntime.dir,
        projectRoot: config.projectRoot,
        target: appDir,
        productName: config.productName,
        exclude: ['dist-mac2win', '.staging'],
        onProgress: (message) => { this.logger.debug(message) },
      })
      this.shellExeName = repacked.exeName
      this.logger.info(`Electron 重打包完成，主程序 ${repacked.exeName}，${String(repacked.appFiles)} 个项目文件`)

      // Electron 的界面由它自己加载，但仍要把垫片放进它的资源目录，
      // 让「浏览器形态降级」与「原生形态」共用同一套前端代码。
      const electronAppDir = join(appDir, 'electron', 'resources', 'app')
      if (config.frontendDist !== null) {
        const injected = await stageFrontend({
          source: config.frontendDist,
          target: electronAppDir,
          shimPath: shimSource,
          merge: true,
        })
        this.logger.info(injected.injected ? '已向 Electron 前端注入桌面壳垫片' : `垫片未注入：${injected.reason}`)
      }
      uiDir = electronAppDir
    } else if (framework === 'nwjs' && shellRuntime !== null) {
      // --- NW.js：项目文件与主程序同级 ---
      const repacked = await repackNwjs({
        nwjsDir: shellRuntime.dir,
        projectRoot: config.projectRoot,
        target: appDir,
        productName: config.productName,
        mainEntry: config.nwjsMain ?? undefined,
        exclude: ['dist-mac2win', '.staging'],
        onProgress: (message) => { this.logger.debug(message) },
      })
      this.shellExeName = repacked.exeName
      this.logger.info(`NW.js 重打包完成，主程序 ${repacked.exeName}，${String(repacked.appFiles)} 个项目文件`)

      const nwDir = join(appDir, 'nwjs')
      if (config.frontendDist !== null) {
        const injected = await stageFrontend({
          source: config.frontendDist,
          target: nwDir,
          shimPath: shimSource,
          merge: true,
        })
        this.logger.info(injected.injected ? '已向 NW.js 前端注入桌面壳垫片' : `垫片未注入：${injected.reason}`)
      }
      uiDir = nwDir
    } else {
      // --- Tauri / Node / 静态站：启动器 + 静态服务 ---
      if (config.frontendDist !== null) {
        const frontendResult = await stageFrontend({
          source: config.frontendDist,
          target: uiDir,
          shimPath: shimSource,
        })
        if (frontendResult.injected) this.logger.info('已向前端注入桌面壳垫片')
        else this.logger.warn(`垫片未注入：${frontendResult.reason ?? '未知原因'}`)
      }

      if (config.entry !== null && hostRoot !== null) {
        const staged = await stageHost({
          hostDir: hostRoot,
          target: join(appDir, 'host'),
          entry: config.entry,
          packages: collected?.packages,
          aliases: collected?.aliases,
          onProgress: (message) => { this.logger.debug(message) },
        })
        this.logger.info(
          `宿主已就位，入口 ${staged.relativeEntry}，${String(staged.packageCount)} 个依赖包`,
        )

        /*
         * 把同级目录里被宿主引用的其它包（如 dsh-sidecar）也放进来。
         *
         * ## 为什么要专门处理
         *
         * 原项目的宿主用 `<宿主目录>/../../dsh-sidecar` 找内核——这是
         * Tauri 版的 `Resources/` 布局。而 `dsh-sidecar` 在 pnpm 里是
         * workspace 包，路径是 `<repo>/dsh-sidecar`，与 `cordis-host`
         * 同级。所以它不在 `cordis-host` 目录内，`stageHost` 拷不到。
         *
         * 做法：从宿主目录的兄弟目录里找同名包，按同样的相对位置摆进
         * `app/`。这样宿主原本的相对路径逻辑无需修改就能工作。
         */
        const sidecar = await this.stageSiblingPackage(hostRoot, appDir, 'dsh-sidecar', collected)
        if (sidecar !== null) {
          this.sidecarEntry = sidecar.entry
          this.logger.info(`内核已就位 ${sidecar.entry}`)
        }
      }
    }

    /*
     * Rust 壳（可选）。
     *
     * 编译好的 exe 与它需要的资源一起放进 `app/tauri/`。Tauri 的
     * exe 会从自己所在目录找 `resources/`，所以整棵树要一起搬。
     */
    if (this.rustExe !== undefined && this.rustExe !== null) {
      const { dirname: dirOf } = await import('node:path')
      const rustDir = dirOf(this.rustExe)
      const tauriTarget = join(appDir, 'tauri')
      await copyTree(rustDir, tauriTarget, {
        filter: (name) => name.endsWith('.exe') || !name.includes('.pdb'),
      })
      this.logger.info(`Rust 壳已就位 ${join('tauri', this.rustExe.split('/').pop())}`)
      this.shellExeName = this.rustExe.split('/').pop()
    }

    // 额外资源
    if (config.resources.length > 0) {
      const landed = await stageResources({
        resources: config.resources.map((source) => ({ source, name: source.split('/').pop() })),
        appDir,
      })
      this.logger.info(`额外资源 ${landed.join('、')}`)
    }

    /*
     * 启动清单。
     *
     * Electron / NW.js 的启动器不需要拉起宿主（原生壳自己会加载项目），
     * 但仍然要知道「用哪个 exe 启动」。其余形态靠 entry 拉起宿主。
     *
     * ## 为什么用重打包返回的 exeName，而不是原始名字
     *
     * 重打包阶段会把 `electron.exe` / `nw.exe` 改名成产品名。
     * 如果这里还写原始名字，启动器会去找一个不存在的文件，
     * 表现是「双击快捷方式闪一下就没了」——而且日志里只有一句
     * 「原生壳不存在」，用户完全看不出是自己改了产品名导致的。
     * 单一真源：名字由重打包决定，这里只负责记录。
     */
    const shellExe = this.rustExe !== undefined && this.rustExe !== null
      ? `tauri/${this.shellExeName ?? this.rustExe.split('/').pop()}`
      : shellRuntime === null
        ? null
        : framework === 'electron'
          ? `electron/${this.shellExeName ?? shellRuntime.exeName}`
          : `nwjs/${this.shellExeName ?? shellRuntime.exeName}`

    await writeLaunchManifest({
      bootstrapDir,
      manifest: {
        framework,
        entry: config.entry !== null && hostRoot !== null
          ? config.entry.slice(hostRoot.length).replace(/^[\\/]/, '')
          : null,
        nodeArgs: config.launcherArgs.filter((arg) => arg !== '{entry}'),
        env: config.env,
        dataEnv: config.dataEnv,
        sidecarEntry: this.sidecarEntry ?? null,
        /** 原生壳可执行文件（相对 app/）。null 表示没有原生壳。 */
        shellExe,
        productName: config.productName,
        version: config.version,
        builtAt: new Date().toISOString(),
        target: config.target,
      },
    })

    // 写一份人可读的说明进安装目录，用户装完能知道这是什么。
    const capabilityLines = describeCapabilities(framework)
    await writeFile(
      join(stagingDir, 'README.txt'),
      [
        `${config.productName} ${config.version}`,
        '',
        `由 mac2win 打包，目标架构 ${config.target}（Windows 32 位）`,
        `构建于 ${new Date().toISOString()}`,
        '',
        '能力说明：',
        ...capabilityLines.map((line) => `  ${line}`),
        '',
        '目录说明：',
        '  app/node.exe                 Windows x86 Node 运行时',
        '  app/bootstrap/               启动器',
        ...(framework === 'electron' ? ['  app/electron/                Electron 运行时与项目文件'] : []),
        ...(framework === 'nwjs' ? ['  app/nwjs/                    NW.js 运行时与项目文件'] : []),
        ...(framework === 'tauri' || framework === 'node' || framework === 'static'
          ? ['  app/ui/                      前端页面', '  app/host/                    宿主服务与依赖']
          : []),
        '  app/data/                    运行期数据（首次启动时创建）',
        '',
      ].join('\n'),
      'utf8',
    )

    return { stagingDir, appDir, bootstrapDir }
  }

  /**
   * 把一个「宿主同级」的包摆进 app/，返回它在宿主侧的相对入口。
   *
   * ## 背景
   *
   * 空谷的三层架构是：壳 → 宿主（cordis-host）→ 内核（dsh-sidecar）。
   * 宿主按 `../dsh-sidecar/lib/index.js`（相对自己）找内核，也就是
   * 两者必须**同级**。
   *
   * 在仓库里它们是两个平级的 workspace 包；在 Tauri 的 `Resources/`
   * 里也是平级。所以打包时同样要摆成 `app/host` 与 `app/dsh-sidecar`。
   *
   * 找不到时返回 null 并让宿主用它自己的默认路径——不阻断，因为
   * 有些项目确实没有独立内核进程。
   *
   * @param {string} hostRoot 宿主目录。
   * @param {string} appDir 暂存区的 app 目录。
   * @param {string} packageDirName 兄弟包的目录名。
   * @param {object | null} collected 依赖收集结果。
   * @returns {Promise<{entry: string} | null>}
   */
  async stageSiblingPackage(hostRoot, appDir, packageDirName, collected) {
    const source = join(hostRoot, '..', packageDirName)
    if (!(await isDirectory(source))) return null

    const target = join(appDir, packageDirName)

    // 拷代码（跳过 node_modules，依赖由收集结果决定）。
    const files = await walkFiles(source, {
      skipDirs: (absolute, name) => name === 'node_modules',
    })
    const BATCH = 32
    for (let index = 0; index < files.length; index += BATCH) {
      const slice = files.slice(index, index + BATCH)
      await Promise.all(slice.map(async (relative) => {
        await copyFile(join(source, relative), join(target, relative))
      }))
    }

    /*
     * 依赖：把它自己声明的运行时依赖放进它的 node_modules。
     *
     * 内核目前没有运行时依赖，但结构要留——否则哪天加了依赖，就会在
     * 用户机器上 MODULE_NOT_FOUND，而那种失败极难定位。
     */
    if (collected?.packages !== undefined) {
      const pkgPath = join(source, 'package.json')
      if (await isFile(pkgPath)) {
        let pkg = null
        try {
          pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
        } catch {
          pkg = null
        }
        const wanted = new Set(Object.keys(pkg?.dependencies ?? {}))
        for (const name of wanted) {
          const root = collected.packages.get(name)
          if (root !== undefined) {
            // 同样跳过包内部 node_modules：依赖已扁平化放在这一层。
            await copyTree(root, join(target, 'node_modules', name), {
              skipDirs: (absolute, dirName) => dirName === 'node_modules',
            })
          }
        }
      }
    }

    return { entry: `${packageDirName}/lib/index.js` }
  }

  /** 调 makensis 编译。 */
  async compileNsis(scriptPath) {
    const makensis = await findMakensis()
    if (makensis === null) {
      throw new BuildError(ErrorCode.TOOL_MISSING, '找不到 makensis', {
        hint: '安装：brew install makensis',
      })
    }

    this.logger.info('编译安装包（大载荷下 LZMA 压缩可能需要几十秒）')
    try {
      const { stdout } = await run(makensis, ['-V2', scriptPath], {
        maxBuffer: 32 * 1024 * 1024,
        cwd: join(scriptPath, '..'),
      })
      // makensis 的输出有体积统计，收进日志供核对。
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        if (/Total size|Install data|EXE header/.test(trimmed)) this.logger.debug(trimmed)
      }
    } catch (error) {
      const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
      const tail = output.split('\n').filter((line) => line.trim() !== '').slice(-15)
      throw new BuildError(ErrorCode.NSIS_COMPILE_FAILED, 'NSIS 编译失败', {
        details: tail,
        hint: `脚本在 ${scriptPath}，可手工执行 makensis "${scriptPath}" 查看完整输出`,
      })
    }
  }
}

/** 默认产物名：`产品名-版本-目标架构-setup.exe`。 */
export function defaultArtifactName(config) {
  const safeName = String(config.productName).replace(/[\\/:*?"<>|]/g, '-').trim() || 'app'
  const version = String(config.version).split('-')[0]
  return `${safeName}-${version}-${config.target}-setup.exe`
}