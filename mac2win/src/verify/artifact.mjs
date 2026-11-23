/**
 * 产物校验。
 *
 * ## 校验要回答的四个问题
 *
 * 1. **产物真的是 x86 PE 吗**？——读 PE 头，比对机器类型与子系统。
 * 2. **载荷完整吗**？——把 exe 当压缩包解开，逐文件比对 SHA-256。
 * 3. **必需的运行时在吗**？——node.exe 是不是 x86、入口脚本在不在。
 * 4. **安装包结构对吗**？——NSIS 的类型、压缩方法、文件数。
 *
 * ## 为什么必须解开 exe 校验
 *
 * 只看 exe 的文件大小或 PE 头，能确认「这是一个 x86 安装包」，但
 * 无法确认「里面装的东西是全的」。一个 200MB 的 exe 可能少了
 * `node.exe`、可能 `node_modules` 只拷了一半——它依然是合法的
 * x86 PE，装完却启动不了。
 *
 * 唯一可靠的办法是把载荷解出来逐项比对。这不是过度设计：
 * 少一个文件的表现是用户装完双击没反应，那种问题排查成本极高。
 *
 * ## 为什么用 7-Zip 解 NSIS
 *
 * NSIS 的载荷是 LZMA 压缩的自定义格式，没有公开的解析库。
 * 7-Zip 内置了 NSIS 解析器，能完整还原文件列表与内容——而且它
 * 解出来的是**原始字节**，可以直接算哈希比对。这是目前唯一
 * 能在 mac 上做的真实完整性校验。
 */

import { readdir, stat, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { humanBytes, isFile, sha256File, walkFiles } from '../util/fsx.mjs'
import { unzipFile } from '../core/zip.mjs'
import { checkWindowsExe } from './pe.mjs'

const run = promisify(execFile)

/** 一条校验项。 */
export class VerifyItem {
  /**
   * @param {string} id 稳定标识。
   * @param {string} title 标题。
   * @param {'pass'|'warn'|'fail'} status 结论。
   * @param {string} detail 说明。
   * @param {boolean} [skipped] 这一项**根本没验**（不是验了有问题）。
   */
  constructor(id, title, status, detail, skipped = false) {
    this.id = id
    this.title = title
    this.status = status
    this.detail = detail
    /*
     * 「未验证」必须与「验证后不通过」分开表达。
     *
     * 两者的处置完全不同：
     * - 不通过 → 产物坏了，别分发；
     * - 未验证 → 环境缺工具，装完重跑即可。
     *
     * 早期实现把「缺 7-Zip」记成 `warn`，于是 report.ok 仍是 true，
     * CLI 打印「校验通过」、退出码 0。用户以为一个文件都没比对过的
     * 包是好的——校验器说谎比不校验更糟。
     */
    this.skipped = skipped
  }
}

/** 校验报告。 */
export class VerifyReport {
  constructor(artifact) {
    this.artifact = artifact
    /** @type {VerifyItem[]} */
    this.items = []
    /** 载荷文件清单（如果解开了）。 */
    this.payload = null
  }

  add(item) {
    this.items.push(item)
    return this
  }

  /** 有没有「明确不合格」的项。 */
  get ok() {
    return !this.items.some((item) => item.status === 'fail')
  }

  /**
   * 校验是否**完整走完**。
   *
   * `ok === true && complete === false` 的含义是「没查出问题，
   * 但也没全验」——这种结论不能当通过用。
   */
  get complete() {
    return !this.items.some((item) => item.skipped === true)
  }

  get failures() {
    return this.items.filter((item) => item.status === 'fail')
  }

  /**
   * 哪些项没验，用于给出可执行的补救提示。
   *
   * 排除 `cause` 项：「缺 7-Zip」是**为什么没验**，不是**哪一项没验**。
   * 混进去会让提示读成「缺少 7-Zip：7-Zip 没被验证」，自相矛盾。
   */
  get unverified() {
    return this.items.filter((item) => item.skipped === true && item.cause !== true)
  }

  /** 导致校验不完整的环境原因（如缺工具）。 */
  get blockers() {
    return this.items.filter((item) => item.cause === true)
  }
}

/**
 * 找 7-Zip 可执行文件。
 *
 * ## 为什么每个候选都要真跑一次
 *
 * `which 7zz` 返回的路径不一定是能用的 7-Zip：某些环境会在 PATH 前面
 * 塞一个同名包装脚本（构建工具的沙箱层、版本管理器都会这么干）。
 * 那种脚本对 `l` 这种参数会直接报错，而错误信息长得像「安装包损坏」——
 * 排查方向会被彻底带偏。
 *
 * 所以这里对每个候选都跑一次 `i`（列出支持的格式），能正常退出才算数。
 *
 * ## 为什么要在应用包里兜底搜索
 *
 * 实测过一台机器：`brew list` 里没有 sevenzip，PATH 里只有沙箱包装
 * 脚本（跑起来报 `spawnSync 7zz ENOENT`），于是 `find7zip()` 返回 null、
 * 校验退化成「只验 PE 头」。但同一台机器上 BlueStacks 和 Parallels
 * 各自带了一份**能用的** 7-Zip——就躺在 `/Applications/*.app/Contents/MacOS/` 里。
 *
 * 「没装」和「装了你找不到」是两件完全不同的事：前者要用户动手，
 * 后者是工具的失职。所以这里补一层应用包扫描，只在常规路径全部落空时
 * 才触发，避免每次校验都去翻几百个 app 目录。
 *
 * @returns {Promise<string | null>}
 */
export async function find7zip() {
  /*
   * 测试与排障用的逃生门：显式声明「当前环境没有 7-Zip」。
   *
   * 这不是为了凑测试覆盖率。缺 7-Zip 的分支决定了报告是否可信，
   * 而它只在**用户机器恰好没装**时才会走到——开发者机器上大概率
   * 装了，于是这条分支可能一年都没人跑过。可真踩到时，用户得到的
   * 是一份撒了谎的报告。
   *
   * 有了这个开关，CI 里能稳定复现「没装 7-Zip」的完整路径。
   */
  if (process.env.MAC2WIN_NO_7ZIP === '1') return null

  /*
   * ## 显式指定的路径不能静默跳过
   *
   * `MAC2WIN_7ZIP` 是用户明确表达「用这个」的方式。如果它指向的文件
   * 不存在、或不是 7-Zip，早期实现会**默默继续往下找**，最后用上
   * 系统里另一份。
   *
   * 后果是用户在排查「为什么换了个 7-Zip 版本没变化」时会彻底走错方向：
   * `doctor` 报的是另一份的路径，而他还以为生效的是自己设的那个。
   *
   * 所以这条路径一旦设了就必须「要么用它，要么明确失败」，不参与回落。
   * 返回值给调用方时再附一句原因，让 report 能把它说清楚。
   */
  const explicit = process.env.MAC2WIN_7ZIP
  if (explicit !== undefined && explicit !== '') {
    const resolved = await probeCandidates([explicit])
    if (resolved !== null) return resolved
    /*
     * 设了但用不了：这里不返回 null，而是抛——让调用方拿到确切的
     * 错误而不是「没装 7-Zip」那种误导性结论。
     */
    const exists = await isFile(explicit)
    throw new Error(
      exists
        ? `MAC2WIN_7ZIP 指向的 ${explicit} 不是可用的 7-Zip（跑 \`i\` 没输出 7-Zip 的格式列表）`
        : `MAC2WIN_7ZIP 指向的 ${explicit} 不存在`,
    )
  }

  const direct = await probeCandidates(known7zipPaths())
  if (direct !== null) return direct

  const fromPath = await probeCandidates(await path7zipPaths())
  if (fromPath !== null) return fromPath

  /*
   * 兜底扫描限定在 `/Applications` 且只看 `*.app/Contents/MacOS/`
   * 这一层——那是 GUI 应用放主可执行文件的固定位置。
   * 不递归整个磁盘：那会变成一次几万目录的遍历，校验要等半分钟。
   */
  return probeCandidates(await bundled7zipPaths())
}

/** 已知安装位置（含环境变量与项目自带）。 */
function known7zipPaths() {
  return [
    // 项目自带（用户可手动放一份到这里，无需 Homebrew）
    join(homedir(), '.wacmin', 'mac2win', 'bin', '7zz'),
    // Homebrew（Apple Silicon / Intel 两个前缀）
    '/opt/homebrew/bin/7zz',
    '/opt/homebrew/bin/7z',
    '/usr/local/bin/7zz',
    '/usr/local/bin/7z',
    // MacPorts
    '/opt/local/bin/7zz',
    '/opt/local/bin/7z',
  ].filter((item) => item !== undefined && item !== '')
}

/**
 * 从 PATH 里找。
 *
 * 放在绝对路径之后：PATH 里可能有同名包装脚本（沙箱层、版本管理器
 * 都会这么干），已知绝对路径更可信。但 PATH 必须查——装在非常规
 * 前缀（asdf、nix、自定义 Homebrew）时这是唯一线索。
 *
 * @returns {Promise<string[]>}
 */
async function path7zipPaths() {
  const found = []
  for (const name of ['7zz', '7z', '7za']) {
    try {
      const { stdout } = await run('which', [name])
      const path = stdout.trim()
      if (path !== '') found.push(path)
    } catch {
      /* 没有就算了 */
    }
  }
  return found
}

/**
 * 从 `/Applications` 里的 GUI 应用找自带的 7-Zip。
 *
 * 不少应用（压缩工具、模拟器）会内嵌一份 7-Zip 用来解自己的包，
 * 它们是完全可用的正版二进制。
 *
 * @returns {Promise<string[]>}
 */
async function bundled7zipPaths() {
  const roots = ['/Applications']
  const found = []

  for (const root of roots) {
    let apps
    try {
      apps = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const app of apps) {
      if (!app.isDirectory() || !app.name.endsWith('.app')) continue
      const macos = join(root, app.name, 'Contents', 'MacOS')
      let entries
      try {
        entries = await readdir(macos, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue
        if (entry.name !== '7zz' && entry.name !== '7z' && entry.name !== '7za') continue
        found.push(join(macos, entry.name))
      }
    }
  }

  return found
}

/**
 * 逐个候选真跑一次 `i`，返回第一个**确认为 7-Zip** 的。
 *
 * ## 为什么不能只看退出码
 *
 * 任何程序对不认识的参数都可能返回 0——`/bin/echo i` 就是。只看退出码
 * 会把 echo、cat、甚至某个同名的包装脚本都认成 7-Zip。
 *
 * 误用后果很隐蔽：后面的 `l -slt` 拿到的是一堆无关文本，解析不出文件
 * 清单，最后报「载荷文件数 0」——看起来像安装包坏了，实际是工具选错了。
 *
 * 所以这里验**输出特征**：真 7-Zip 的 `i` 会打印自己的名字与
 * `Formats:` 段。两个都在才算数。
 *
 * 代价是每次多一次 stdout 匹配，可以忽略；收益是「选错工具」这条
 * 排查成本极高的错路被彻底堵住。
 *
 * @param {string[]} candidates
 * @returns {Promise<string | null>}
 */
async function probeCandidates(candidates) {
  for (const candidate of candidates) {
    if (!(await isFile(candidate))) continue
    try {
      const { stdout } = await run(candidate, ['i'], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
      /*
       * 两个特征都要有：
       * - `7-Zip`：程序自己报名字（版本行里一定有）；
       * - `Formats`：格式列表的段头，是 `i` 子命令的专有输出。
       *
       * 只看名字不够——包装脚本也可能把名字抄进输出里。
       */
      if (!/7-Zip/iu.test(stdout)) continue
      if (!/Formats:/u.test(stdout) && !/^Formats$/mu.test(stdout)) continue
      return candidate
    } catch {
      // 这个候选跑不起来（不是 7-Zip、或是包装脚本），换下一个。
      continue
    }
  }
  return null
}

/** 计算文件哈希。 */
async function hashFile(path) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

/**
 * 校验产物。
 *
 * @param {object} input
 * @param {string} input.artifact 产物 exe 路径。
 * @param {Array<{path: string, size: number, sha256: string}>} [input.expectedManifest]
 *   期望的载荷清单（打包阶段生成的）。给了才做逐文件比对。
 * @param {(message: string) => void} [input.onProgress]
 * @returns {Promise<VerifyReport>}
 */
export async function verifyArtifact(input) {
  const { artifact, expectedManifest, onProgress, expectTarget = 'x86', framework = null } = input
  const report = new VerifyReport(artifact)

  // --- 1. 文件存在 ---
  if (!(await isFile(artifact))) {
    report.add(new VerifyItem('exists', '产物存在', 'fail', `找不到 ${artifact}`))
    return report
  }
  const info = await stat(artifact)
  report.add(new VerifyItem('exists', '产物存在', 'pass', `${humanBytes(info.size)}（${artifact}）`))

  // 太小的 exe 一定不完整：NSIS 的桩本身就有 30KB 以上。
  if (info.size < 32 * 1024) {
    report.add(new VerifyItem(
      'size',
      '产物体积',
      'fail',
      `只有 ${humanBytes(info.size)}，小于 NSIS 桩的最小体积`,
    ))
    return report
  }

  // --- 2. PE 头 ---
  onProgress?.('校验 PE 头')
  const peResult = await checkWindowsExe(artifact, { gui: true })
  if (peResult.header === null) {
    report.add(new VerifyItem('pe', 'PE 格式', 'fail', peResult.problems.join('；')))
    return report
  }

  const header = peResult.header

  /*
   * ## 安装器外壳与应用本体是两件事
   *
   * NSIS 编译出来的 exe 永远是 **i386 的桩程序**——它是安装器，
   * 负责解包与写注册表，不是应用本身。32 位安装器能在 32 位与 64 位
   * Windows 上运行，这正是它该有的样子。
   *
   * 真正需要匹配目标架构的是**载荷里的 node.exe**（下面会单独验）。
   *
   * 早期实现把外壳当成应用来断言，于是：
   * - `--target x64` 时，外壳是 i386 → 报「不是 x86-64」→ 校验失败，
   *   而载荷其实是对的；
   * - 更早的版本反过来写死要求 i386，于是 x64 目标被盖章通过，
   *   实际载荷是 32 位——那才是真正的错。
   *
   * 现在的规则：
   * - 外壳必须是 **32 位 i386 的 GUI 程序**（NSIS 的固定形态）；
   * - 载荷的架构由 `expectTarget` 决定，单独验。
   */
  report.add(new VerifyItem(
    'pe-format',
    '安装器外壳格式',
    header.format === 'PE32' && header.isX86 ? 'pass' : 'fail',
    `${header.format} / ${header.machineName} / ${header.subsystemName}`
    + (header.format === 'PE32' && header.isX86 ? '' : '（NSIS 桩应为 32 位 i386）'),
  ))

  // --- 3. 解载荷 ---
  /*
   * 先确认工具在，再走下面那条「假设能解包」的路径。
   *
   * `couldExtract` 是这两种分支的唯一开关：它同时决定
   * 「pe-arch 能不能亮绿」和「要不要列出未验证项」。
   */
  const sevenZip = await find7zip()
  const couldExtract = sevenZip !== null

  // 应用本体的架构在后面解包后按 expectTarget 验，这里只报「待验」。
  /*
   * ## 为什么这一项不再无条件写 pass
   *
   * 它原本是 `status: 'pass'`、说明写「应用架构在载荷内校验」——
   * 措辞诚实，但状态骗人：一旦因为缺 7-Zip 没能解包，这一项
   * 依然亮绿。报告上「架构」一栏是绿的，用户自然认为架构验过了。
   *
   * 现在它跟随 `couldExtract`：解不了包就是未验证。
   */
  report.add(new VerifyItem(
    'pe-arch',
    `应用本体架构（目标 ${expectTarget}）`,
    couldExtract ? 'pass' : 'warn',
    couldExtract
      ? '安装器外壳是 32 位（NSIS 固定形态），应用架构在载荷内校验'
      : '未能解包，应用架构没有验证——绿不了',
    !couldExtract,
  ))
  report.add(new VerifyItem(
    'pe-subsystem',
    'GUI 子系统',
    header.isGui ? 'pass' : 'warn',
    header.isGui
      ? 'windows-gui，双击启动不弹控制台'
      : `${header.subsystemName}，双击会弹出控制台窗口`,
  ))

  if (!couldExtract) {
    /*
     * 缺 7-Zip 不是「警告」而是「没验」。
     *
     * 这里必须把**没验的具体内容**逐条列出来，否则用户看到
     * 几条绿勾就以为整包验过了。列出来的作用不只是诚实，
     * 它同时告诉用户「装上 7-Zip 之后会多验这四项」，
     * 让补救动作有明确的收益预期。
     *
     * 注意「缺工具」这一条（`payload-tool`）也标了 skipped，但它
     * 是**原因**而不是**被跳过的检查项**。上层把 skipped 全列进
     * 「未验证」时，读起来会变成「7-Zip 没被验证」——语义正好相反。
     * 所以它带一个 `cause` 标记，让上层能把它单独摘出来说。
     */
    const unverified = framework === 'flutter'
      ? [
        ['payload', '载荷完整性', '安装包里装了什么，一个文件都没解开看过'],
        ['payload-flutter-arch', '载荷内 Flutter 主程序架构', '无法确认装到 Windows 上的原生 exe 架构'],
        ['payload-hash', '文件哈希比对', '无法确认载荷文件的字节内容与构建时一致'],
      ]
      : [
        ['payload', '载荷完整性', '安装包里装了什么，一个文件都没解开看过'],
        ['payload-node-arch', '载荷内 node.exe 架构', '无法确认装到 Windows 上的是 32 位还是 64 位运行时'],
        ['required-node.exe', '必需文件 node.exe', '无法确认安装包里有没有运行时'],
        ['payload-hash', '文件哈希比对', '无法确认 4000 多个文件的字节内容与构建时一致'],
      ]
    for (const [id, title, detail] of unverified) {
      report.add(new VerifyItem(id, title, 'warn', detail, true))
    }
    const toolItem = new VerifyItem(
      'payload-tool',
      '缺少 7-Zip',
      'warn',
      '7-Zip 是解开 NSIS 载荷的唯一工具，没它就只剩 PE 头可信。'
      + '安装：brew install sevenzip；或把 7zz 放到 ~/.wacmin/mac2win/bin/；'
      + '或用 MAC2WIN_7ZIP 指向已有的 7-Zip',
      true,
    )
    toolItem.cause = true
    report.add(toolItem)
    return report
  }

  onProgress?.('解开安装包载荷')
  /*
   * 校验过程不落地到磁盘。
   *
   * 早期实现是把载荷解到一个临时目录再逐文件哈希。两个问题：
   *
   * 1. 4086 个文件解出来要占几百 MB，而校验只需要读一遍内容；
   * 2. 事后删那个目录是一次「批量删除」——在受管环境里可能被安全
   *    策略拦下，导致一次成功的构建被判为失败。
   *
   * 现在改用 `7zz x -so`（解到标准输出），在内存里算哈希。
   * 单文件模式逐个流式读，内存占用恒定，且全程不写磁盘。
   * 代价是每个文件要单独调一次 7zz（4086 次），但每次只做解压，
   * 实测比「解包 + 递归 stat + 读文件」还快。
   */
  const stripAppPrefix = (path) => (path.startsWith('app/') ? path.slice(4) : path)

  try {
    // 先列清单：只读目录，快，能立刻拿到文件数与总体积。
    let listing
    try {
      const { stdout } = await run(sevenZip, ['l', '-slt', artifact], { maxBuffer: 64 * 1024 * 1024 })
      listing = stdout
    } catch (error) {
      report.add(new VerifyItem(
        'payload-format',
        '安装包格式',
        'fail',
        `7-Zip 无法识别：${error.message}`,
      ))
      return report
    }

    const typeMatch = /^Type = (.+)$/m.exec(listing)
    const type = typeMatch === null ? '未知' : typeMatch[1].trim()
    report.add(new VerifyItem(
      'payload-format',
      '安装包格式',
      type.toLowerCase().includes('nsis') ? 'pass' : 'warn',
      `识别为 ${type}`,
    ))

    // 解析清单：`-slt` 是「技术列表」，每项一个 Path 块。
    const entries = parseSltListing(listing)
    const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0)

    report.add(new VerifyItem(
      'payload-count',
      '载荷文件数',
      entries.length > 0 ? 'pass' : 'fail',
      `${String(entries.length)} 个文件，共 ${humanBytes(totalBytes)}`,
    ))

    // 必需文件：不管什么项目都必须有。
    // 路径基准是「载荷内的相对路径」——NSIS 的 `File /r "app\*.*"`
    // 展开的是 app 的内容，所以载荷里没有 `app/` 这一层前缀。
    const names = entries
      .filter((entry) => !entry.isDir)
      .map((entry) => stripAppPrefix(entry.path.split('\\').join('/')))
    // Flutter 的主程序名由用户项目决定，不能写死。载荷里 `flutter/` 下
    // 任意一个 .exe 都算主程序候选；真正的架构校验在下面逐个做。
    let flutterLauncher = null
    if (framework === 'flutter') {
      flutterLauncher = names.find((name) => name.startsWith('flutter/') && name.toLowerCase().endsWith('.exe')) ?? null
      report.add(new VerifyItem(
        'required-flutter-launcher',
        '必需文件 Flutter 主程序',
        flutterLauncher === null ? 'fail' : 'pass',
        flutterLauncher === null ? '载荷里 flutter/ 下找不到 .exe' : `在载荷中：${flutterLauncher}`,
      ))
    } else {
      for (const requiredPath of ['node.exe', 'bootstrap/bootstrap.mjs', 'bootstrap/launch.json']) {
        const found = names.some((name) => name === requiredPath || name.endsWith(`/${requiredPath}`))
        report.add(new VerifyItem(
          `required-${requiredPath}`,
          `必需文件 ${requiredPath.split('/').pop()}`,
          found ? 'pass' : 'fail',
          found ? '在载荷中' : '载荷里找不到',
        ))
      }
    }

    // --- 逐个比对哈希 ---
    onProgress?.('比对哈希')

    /*
     * ## 为什么改成「一次解包 + 哈希后立即清理」
     *
     * 上一版是每个文件调一次 `7zz x -so`。4086 个文件就要启动 4086 个
     * 进程——实测空谷项目跑了 10 分钟还没完成。进程启动开销完全压过
     * 了解压本身。
     *
     * 现在改为：整包解到临时目录 → 逐文件算哈希 → 立即删除。
     * 三个考虑：
     *
     * 1. **速度**。一次解包 4 秒，之后全是本地读，总共不到 10 秒。
     * 2. **不留在磁盘上**。校验结束立刻删，且只删自己刚建的那个目录
     *    （不是批量删除用户文件），不会触发安全策略。
     * 3. **失败也能清理**。用 try/finally 保证异常路径同样删干净。
     */
    const tempDir = join(dirname(artifact), `.verify-${String(process.pid)}`)
    try {
      await run(sevenZip, ['x', '-y', `-o${tempDir}`, artifact], { maxBuffer: 64 * 1024 * 1024 })

      // 解出来的运行时/原生壳架构必须与目标一致。
      const extractedNode = join(tempDir, 'app', 'node.exe')
      if (await isFile(extractedNode)) {
        const nodePe = await checkWindowsExe(extractedNode, { gui: false })
        const nodeHeader = nodePe.header
        const wantNode = expectTarget === 'x64' ? 'x86-64' : 'i386'
        report.add(new VerifyItem(
          'payload-node-arch',
          '载荷内 node.exe 架构',
          nodeHeader !== null && nodeHeader.machineName === wantNode ? 'pass' : 'fail',
          nodeHeader === null
            ? nodePe.problems.join('；')
            : `${nodeHeader.format} / ${nodeHeader.machineName}（需要 ${wantNode}）`,
        ))
      }

      if (framework === 'flutter') {
        const wantMain = expectTarget === 'x64' ? 'x86-64' : 'i386'
        if (flutterLauncher === null) {
          report.add(new VerifyItem(
            'payload-flutter-arch',
            '载荷内 Flutter 主程序架构',
            'fail',
            'Flutter 发布目录里找不到 .exe',
          ))
        } else {
          const mainPe = await checkWindowsExe(join(tempDir, 'app', flutterLauncher), { gui: true })
          const mainHeader = mainPe.header
          report.add(new VerifyItem(
            'payload-flutter-arch',
            '载荷内 Flutter 主程序架构',
            mainHeader !== null && mainHeader.machineName === wantMain ? 'pass' : 'fail',
            mainHeader === null
              ? mainPe.problems.join('；')
              : `${flutterLauncher}：${mainHeader.format} / ${mainHeader.machineName}（需要 ${wantMain}）`,
          ))
        }
      }

      if (Array.isArray(expectedManifest) && expectedManifest.length > 0) {
        let matched = 0
        const missing = []
        const mismatched = []

        for (const manifestEntry of expectedManifest) {
          const relative = stripAppPrefix(manifestEntry.path)
          const actual = join(tempDir, 'app', relative)
          if (!(await isFile(actual))) {
            missing.push(manifestEntry.path)
            continue
          }
          const digest = await sha256File(actual)
          if (digest === manifestEntry.sha256) matched += 1
          else mismatched.push(manifestEntry.path)
        }

        const total = expectedManifest.length
        if (missing.length === 0 && mismatched.length === 0) {
          report.add(new VerifyItem(
            'payload-hash',
            '文件哈希比对',
            'pass',
            `${String(matched)} / ${String(total)} 个文件逐一匹配`,
          ))
        } else {
          report.add(new VerifyItem(
            'payload-hash',
            '文件哈希比对',
            'fail',
            `${String(matched)} / ${String(total)} 匹配；缺失 ${String(missing.length)}，哈希不符 ${String(mismatched.length)}`,
          ))
          if (missing.length > 0) {
            report.add(new VerifyItem('payload-missing', '缺失文件', 'fail', missing.slice(0, 8).join('、')))
          }
          if (mismatched.length > 0) {
            report.add(new VerifyItem('payload-mismatch', '哈希不符', 'fail', mismatched.slice(0, 8).join('、')))
          }
        }

        report.payload = { files: entries.length, matched, total }
      }
    } finally {
      // 只删自己刚建的临时目录，且用递归删单个路径——
      // 这不是「批量删除用户文件」，不会触发安全策略。
      await rm(tempDir, { recursive: true, force: true })
    }
  } catch (error) {
    report.add(new VerifyItem('payload-verify', '载荷校验', 'fail', error.message))
  }

  return report
}

/**
 * 解析 `7zz l -slt` 的输出。
 *
 * 格式是每项一段 `键 = 值`，段之间空行分隔。只需要 Path 与 Size 两项。
 *
 * @param {string} listing
 * @returns {Array<{path: string, size: number, isDir: boolean}>}
 */
function parseSltListing(listing) {
  const entries = []
  let current = null

  for (const line of listing.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') {
      if (current !== null && current.path !== '') entries.push(current)
      current = null
      continue
    }
    if (trimmed === '----------') {
      if (current !== null && current.path !== '') entries.push(current)
      current = null
      continue
    }
    const eq = trimmed.indexOf(' = ')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq)
    const value = trimmed.slice(eq + 3)

    if (key === 'Path') {
      if (current !== null && current.path !== '') entries.push(current)
      current = { path: value, size: 0, isDir: false }
    } else if (key === 'Size' && current !== null) {
      const size = Number.parseInt(value, 10)
      if (Number.isFinite(size)) current.size = size
    } else if (key === 'Folder' && current !== null) {
      current.isDir = value === '+'
    } else if (key === 'Attributes' && current !== null) {
      // 目录项的属性以 D 开头。
      if (value.startsWith('D')) current.isDir = true
    }
  }
  if (current !== null && current.path !== '') entries.push(current)

  // 过滤掉目录项与 NSIS 自己的临时目录（$PLUGINSDIR）。
  return entries.filter((entry) => !entry.isDir && !entry.path.startsWith('$'))
}


/**
 * 在解开的产物根目录里找 Flutter 主程序。
 *
 * 名字不能写死：Flutter 项目改名后主 exe 也跟着改名，
 * 所以按 `flutter/` 下的第一个 .exe 识别。
 */
async function findFlutterLauncher(rootDir) {
  try {
    const names = await readdir(join(rootDir, 'flutter'))
    const launcher = names.find((name) => name.toLowerCase().endsWith('.exe')) ?? null
    if (launcher === null) return null
    // zip 里的路径是 `<产品名>/flutter/<exe>`，而 NSIS 载荷里
    // 是 `flutter/<exe>`。统一返回相对于载荷根的写法。
    return join('flutter', launcher)
  } catch {
    return null
  }
}

/**
 * 校验一个目录（免安装形态）。
 *
 * zip 产物没有 NSIS 那层包装，直接查目录结构即可。
 *
 * @param {string} appDir 解开的 `app/` 目录。
 * @param {Array} expectedManifest 期望清单。
 * @returns {Promise<VerifyReport>}
 */
export async function verifyDirectory(appDir, expectedManifest, expectTarget = 'x86') {
  const report = new VerifyReport(appDir)

  const nodePath = join(appDir, 'node.exe')
  if (!(await isFile(nodePath))) {
    report.add(new VerifyItem('node', '运行时 node.exe', 'fail', '不存在'))
    return report
  }

  const peResult = await checkWindowsExe(nodePath, { gui: false })
  const header = peResult.header
  const wantNode = expectTarget === 'x64' ? 'x86-64' : 'i386'
  report.add(new VerifyItem(
    'node-arch',
    '运行时架构',
    header !== null && header.machineName === wantNode ? 'pass' : 'fail',
    header === null
      ? peResult.problems.join('；')
      : `${header.format} / ${header.machineName}（需要 ${wantNode}）`,
  ))

  if (Array.isArray(expectedManifest) && expectedManifest.length > 0) {
    const files = await walkFiles(appDir, { skipJunk: false })
    const actualSet = new Set(files.map((path) => `app/${path}`))
    const missing = expectedManifest.filter((entry) => !actualSet.has(entry.path))
    report.add(new VerifyItem(
      'manifest',
      '文件清单',
      missing.length === 0 ? 'pass' : 'fail',
      missing.length === 0
        ? `${String(expectedManifest.length)} 个文件全部在位`
        : `缺 ${String(missing.length)} 个：${missing.slice(0, 5).map((entry) => entry.path).join('、')}`,
    ))
  }

  return report
}
/**
 * 校验 zip 产物。
 *
 * ## 与 exe 校验的差别
 *
 * exe 是 NSIS 容器，要先用 7-Zip 解出载荷；zip 本身就是标准格式，
 * 用我们自己的解包器就能读，不依赖外部工具——所以这条路的校验
 * **在任何环境下都能做**，不会因为找不到 7-Zip 而降级。
 *
 * ## 验什么
 *
 * 1. zip 结构可解析（中央目录完整）；
 * 2. 文件数与清单一致；
 * 3. 逐文件 SHA-256 与打包时算的一致。
 *
 * 第 3 条是核心：它能抓到「压缩/解压过程中内容变了」这类问题。
 * zip 自带的 CRC 只防传输错误，不防逻辑错误——比如拷错源文件。
 *
 * @param {object} input
 * @param {string} input.artifact zip 路径。
 * @param {Array<{path: string, size: number, sha256: string}>} [input.expectedManifest]
 * @param {(message: string) => void} [input.onProgress]
 * @returns {Promise<VerifyReport>}
 */
export async function verifyZip(input) {
  const { artifact, expectedManifest, onProgress, expectTarget = 'x86', framework = null } = input
  const report = new VerifyReport(artifact)

  if (!(await isFile(artifact))) {
    report.add(new VerifyItem('exists', '产物存在', 'fail', `找不到 ${artifact}`))
    return report
  }

  const info = await stat(artifact)
  report.add(new VerifyItem('exists', '产物存在', 'pass', `${humanBytes(info.size)}（${artifact}）`))

  if (info.size < 64) {
    report.add(new VerifyItem('size', '产物体积', 'fail', `只有 ${humanBytes(info.size)}，不可能是完整 zip`))
    return report
  }

  // --- 解包到临时目录 ---
  onProgress?.('解开压缩包')
  const tempDir = join(dirname(artifact), `.verify-zip-${String(process.pid)}`)
  try {
    let unzipped
    try {
      unzipped = await unzipFile(artifact, tempDir)
    } catch (error) {
      report.add(new VerifyItem('zip-format', '压缩包格式', 'fail', error.message))
      return report
    }

    report.add(new VerifyItem(
      'zip-format',
      '压缩包格式',
      'pass',
      `可解析，${String(unzipped.files)} 个文件`,
    ))

    // --- 必需文件 ---
    // zip 的顶层是产品名目录，所以先找到它。
    let rootDir = tempDir
    try {
      const entries = await readdir(tempDir, { withFileTypes: true })
      const dirs = entries.filter((entry) => entry.isDirectory())
      if (dirs.length === 1) rootDir = join(tempDir, dirs[0].name)
    } catch {
      /* 保持 tempDir */
    }

    const isFlutter = framework === 'flutter'
      || (framework === null && await findFlutterLauncher(rootDir) !== null)
    if (isFlutter) {
      const launcher = await findFlutterLauncher(rootDir)
      report.add(new VerifyItem(
        'required-flutter-launcher',
        '必需文件 Flutter 主程序',
        launcher === null ? 'fail' : 'pass',
        launcher === null ? '压缩包里 flutter/ 下找不到 .exe' : `在压缩包中：${launcher}`,
      ))
    } else {
      for (const requiredPath of ['node.exe', 'bootstrap/bootstrap.mjs', 'bootstrap/launch.json']) {
        const found = await isFile(join(rootDir, requiredPath))
        report.add(new VerifyItem(
          `required-${requiredPath}`,
          `必需文件 ${requiredPath.split('/').pop()}`,
          found ? 'pass' : 'fail',
          found ? '在压缩包中' : '压缩包里找不到',
        ))
      }
    }

    // --- 运行时架构 ---
    const wantArch = expectTarget === 'x64' ? 'x86-64' : 'i386'
    if (isFlutter) {
      const launcher = await findFlutterLauncher(rootDir)
      if (launcher === null) {
        report.add(new VerifyItem('payload-flutter-arch', '载荷内 Flutter 主程序架构', 'fail', 'Flutter 发布目录里找不到 .exe'))
      } else {
        const mainPe = await checkWindowsExe(join(rootDir, launcher), { gui: true })
        const header = mainPe.header
        report.add(new VerifyItem(
          'payload-flutter-arch',
          '载荷内 Flutter 主程序架构',
          header !== null && header.machineName === wantArch ? 'pass' : 'fail',
          header === null ? mainPe.problems.join('；') : `${launcher}：${header.format} / ${header.machineName}（需要 ${wantArch}）`,
        ))
      }
    } else {
      const nodePath = join(rootDir, 'node.exe')
      if (await isFile(nodePath)) {
        const nodePe = await checkWindowsExe(nodePath, { gui: false })
        const header = nodePe.header
        report.add(new VerifyItem(
          'node-arch',
          '运行时架构',
          header !== null && header.machineName === wantArch ? 'pass' : 'fail',
          header === null
            ? nodePe.problems.join('；')
            : `${header.format} / ${header.machineName}（需要 ${wantArch}）`,
        ))
      }
    }

    // --- 逐文件哈希 ---
    if (Array.isArray(expectedManifest) && expectedManifest.length > 0) {
      onProgress?.('比对哈希')
      const stripAppPrefix = (path) => (path.startsWith('app/') ? path.slice(4) : path)

      let matched = 0
      const missing = []
      const mismatched = []

      for (const entry of expectedManifest) {
        const relative = stripAppPrefix(entry.path)
        const actual = join(rootDir, relative)
        if (!(await isFile(actual))) {
          missing.push(entry.path)
          continue
        }
        const digest = await sha256File(actual)
        if (digest === entry.sha256) matched += 1
        else mismatched.push(entry.path)
      }

      const total = expectedManifest.length
      if (missing.length === 0 && mismatched.length === 0) {
        report.add(new VerifyItem(
          'payload-hash',
          '文件哈希比对',
          'pass',
          `${String(matched)} / ${String(total)} 个文件逐一匹配`,
        ))
      } else {
        report.add(new VerifyItem(
          'payload-hash',
          '文件哈希比对',
          'fail',
          `${String(matched)} / ${String(total)} 匹配；缺失 ${String(missing.length)}，哈希不符 ${String(mismatched.length)}`,
        ))
        if (missing.length > 0) {
          report.add(new VerifyItem('payload-missing', '缺失文件', 'fail', missing.slice(0, 8).join('、')))
        }
        if (mismatched.length > 0) {
          report.add(new VerifyItem('payload-mismatch', '哈希不符', 'fail', mismatched.slice(0, 8).join('、')))
        }
      }

      report.payload = { files: unzipped.files, matched, total }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }

  return report
}
