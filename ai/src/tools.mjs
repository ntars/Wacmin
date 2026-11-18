/**
 * MCP 工具定义。
 *
 * ## 设计取向：少而准，而不是多而全
 *
 * 四个方向加起来有二十多个子命令，全部摊平成工具会让 agent 无从选择 ——
 * 工具名之间的差异它看不出来，只能靠猜。所以这里按**意图**分组，而不是
 * 按命令逐一映射：
 *
 *   - `wacmin_list_directions`  先问「这里有什么」，永不出错
 *   - `wacmin_doctor`           问「环境行不行」，只读、无副作用
 *   - `wacmin_build`            要产物（内部按方向分派到对应命令）
 *   - `wacmin_verify`           只校验已有产物，不重新打
 *   - `wacmin_assess`           只评估不做，用于「能不能跑」这类问题
 *   - `wacmin_run`              逃生门：给准确定位与参数，直通子命令
 *
 * `wacmin_run` 这扇逃生门是刻意的：把二十多个子命令的参数全部建模成
 * schema，维护成本高且必然滞后于各方向的实现。留一个泛化入口，参数
 * 原样透传，能力不会因为本文件没跟上而丢失。
 *
 * ## 为什么每个工具都声明 annotations
 *
 * `readOnlyHint` 直接决定客户端要不要弹确认框。把 build 标成只读会让
 * agent 在用户不知情的情况下跑一次几分钟的构建并写盘 —— 那是不可接受
 * 的副作用。反过来把 doctor 标成非只读，会让每次自检都打断用户。
 *
 * ## 方向与命令的对应关系
 *
 * 这张表**必须**与 `console/src/directions.mjs` 的 `subcommands` 一致。
 * 测试里有一条专门比对两者，防止一边改了另一边忘。
 */

/** 各方向 build 子命令的参数（与各方向 `--help` 实测输出一致）。 */
const BUILD_PARAMS = {
  mac2win: {
    description: '在 macOS 上把项目打成 Windows 安装包（NSIS .exe，可选同时出 .zip）。宿主必须是 macOS。',
    properties: {
      project: { type: 'string', description: '项目目录绝对路径。' },
      out: { type: 'string', description: '输出目录，默认 <项目>/dist-mac2win。' },
      target: { type: 'string', enum: ['x86', 'x64'], description: '载荷架构，默认 x86。' },
      format: { type: 'string', enum: ['nsis', 'zip'], description: '产物形态，默认 nsis。' },
      name: { type: 'string', description: '产品名，影响产物文件名。' },
      version: { type: 'string', description: '版本号，如 1.2.3。' },
      entry: { type: 'string', description: '宿主入口脚本（相对项目根）。' },
      frontend: { type: 'string', description: '前端产物目录（相对项目根）。' },
      icon: { type: 'string', description: '.ico 图标绝对路径。' },
      alsoZip: { type: 'boolean', description: '同时生成免安装 zip。' },
      dryRun: { type: 'boolean', description: '只跑预检并打印计划，不下载不构建不落盘。' },
    },
    required: ['project'],
    map: (args) => {
      const out = []
      if (typeof args.out === 'string' && args.out !== '') out.push('--out', args.out)
      if (typeof args.target === 'string' && args.target !== '') out.push('--target', args.target)
      if (typeof args.format === 'string' && args.format !== '') out.push('--format', args.format)
      if (typeof args.name === 'string' && args.name !== '') out.push('--name', args.name)
      if (typeof args.version === 'string' && args.version !== '') out.push('--version', args.version)
      if (typeof args.entry === 'string' && args.entry !== '') out.push('--entry', args.entry)
      if (typeof args.frontend === 'string' && args.frontend !== '') out.push('--frontend', args.frontend)
      if (typeof args.icon === 'string' && args.icon !== '') out.push('--icon', args.icon)
      if (args.alsoZip === true) out.push('--also-zip')
      if (args.dryRun === true) out.push('--dry-run')
      return out
    },
  },  win2mac: {
    description: '在 Windows 上把项目装配成 macOS .app 目录与保留权限位的 .zip。宿主建议 Windows。',
    properties: {
      project: { type: 'string', description: '项目目录绝对路径。' },
      out: { type: 'string', description: '输出目录，默认 <项目>/dist-win2mac。' },
      name: { type: 'string', description: '应用名，默认取项目目录名。' },
      version: { type: 'string', description: '版本号，如 1.2.3。' },
      executable: { type: 'string', description: '主可执行文件（Mach-O）路径。这是必填项。' },
      payload: { type: 'string', description: '应用本体（目录或文件），默认整个项目。' },
      icon: { type: 'string', description: '.icns 图标路径。Windows 上无法从 .ico 转换。' },
      bundleId: { type: 'string', description: '显式指定 CFBundleIdentifier。' },
      vendor: { type: 'string', description: '厂商片段，用于生成 bundle id。' },
      minMacos: { type: 'string', description: 'LSMinimumSystemVersion，默认 11.0。' },
      category: { type: 'string', description: 'LSApplicationCategoryType。' },
      keepWork: { type: 'boolean', description: '保留中间 .app 目录。' },
      strictHost: { type: 'boolean', description: '宿主不是 Windows 时直接拒绝。' },
    },
    required: ['project', 'executable'],
    map: (args) => {
      const out = []
      if (typeof args.out === 'string' && args.out !== '') out.push('--out', args.out)
      if (typeof args.name === 'string' && args.name !== '') out.push('--name', args.name)
      if (typeof args.version === 'string' && args.version !== '') out.push('--version', args.version)
      if (typeof args.executable === 'string' && args.executable !== '') out.push('--executable', args.executable)
      if (typeof args.payload === 'string' && args.payload !== '') out.push('--payload', args.payload)
      if (typeof args.icon === 'string' && args.icon !== '') out.push('--icon', args.icon)
      if (typeof args.bundleId === 'string' && args.bundleId !== '') out.push('--bundle-id', args.bundleId)
      if (typeof args.vendor === 'string' && args.vendor !== '') out.push('--vendor', args.vendor)
      if (typeof args.minMacos === 'string' && args.minMacos !== '') out.push('--min-macos', args.minMacos)
      if (typeof args.category === 'string' && args.category !== '') out.push('--category', args.category)
      if (args.keepWork === true) out.push('--keep-work')
      if (args.strictHost === true) out.push('--strict-host')
      return out
    },
  },
  exeonmac: {
    description: '在 macOS 上把 Windows 安装包封装成可双击运行的 .app（内含 wine prefix）。宿主必须是 macOS。',
    properties: {
      installer: { type: 'string', description: 'Windows 安装包路径（setup.exe 或 .msi）。' },
      out: { type: 'string', description: '输出目录。' },
      name: { type: 'string', description: '应用显示名。' },
    },
    required: ['installer'],
    map: (args) => {
      const out = []
      if (typeof args.out === 'string' && args.out !== '') out.push('-o', args.out)
      if (typeof args.name === 'string' && args.name !== '') out.push('--name', args.name)
      return out
    },
  },
  /*
   * 这里**没有** apponwin。
   *
   * AppOnWin 的设计目标就是评估，`--help` 里根本没有 build 子命令。
   * 早先为了「四个方向都齐」给它补了一个空 map，结果工具表开始说谎：
   * agent 照着表调 build，方向回「未知子命令」，用户看到一个自相矛盾
   * 的产品。工具的可用范围必须与实现一致，宁可少一个也不要有假的。
   *
   * 测试里有一条专门守这个：BUILD_SPECS 的键集必须等于「声明了 build
   * 子命令的方向」集合，两边都不能多。
   */
}

/** 各方向 verify 子命令需要的参数。 */
const VERIFY_PARAMS = {
  mac2win: { field: 'artifact', description: '待校验的 .exe 或 .zip 路径。' },
  win2mac: { field: 'artifact', description: '待校验的 .app 目录或 .zip 路径。' },
  exeonmac: { field: 'artifact', description: '待校验的 .app 目录路径。' },
  apponwin: { field: 'artifact', description: '待校验的 .app 目录路径。' },
}

/**
 * 生成的工具清单。
 *
 * 注意 `name` 一律用 `wacmin_` 前缀：MCP 客户端会把多个 server 的工具
 * 汇到一个命名空间里，没有前缀时「doctor」「build」这种通用词极易撞名。
 */
export const TOOLS = [
  {
    name: 'wacmin_list_directions',
    title: '列出四个方向及其能力',
    description: [
      '列出本仓库的四个方向（mac2win / exeonmac / win2mac / apponwin），',
      '以及每个方向支持哪些子命令、产出什么、需要什么宿主系统、当前是否就绪。',
      '在不确定该用哪个方向时，先调这个。它不执行任何构建，无副作用。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'wacmin_doctor',
    title: '环境自检',
    description: [
      '对指定方向做环境自检：宿主平台与架构、Node / Python 版本、',
      '外部工具（makensis / wine / 7z / sips / iconutil / swiftc 等）是否就位。',
      '只读探测，不写任何文件，不启动构建。排除「跑不起来」类问题时先调这个。',
      '不传 direction 时并行检查四个方向。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['mac2win', 'exeonmac', 'win2mac', 'apponwin'],
          description: '要自检的方向。省略则四个方向并行自检。',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'wacmin_build',
    title: '构建产物',
    description: [
      '按方向构建产物。这是唯一会写盘、耗时可能达数分钟的操作。',
      'direction 决定语义：mac2win 出 Windows 安装包，exeonmac 出 macOS .app，',
      'win2mac 出 macOS .app 与 zip，apponwin 不支持构建（只能评估）。',
      '主输入按方向二选一：mac2win / win2mac 传 project（项目目录），',
      'exeonmac 传 installer（Windows 安装包路径）。',
      '先用 wacmin_doctor 确认环境，否则常见失败是「缺 makensis」而不是代码问题。',
      '想先看计划不落盘时传 dryRun。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['mac2win', 'exeonmac', 'win2mac'],
          description: '构建方向。apponwin 不提供构建。',
        },
        /*
         * `project` 与 `installer` 只列一个是不行的。
         *
         * 两个字段描述的是同一件事 —— 这次构建的**主输入** —— 但名字不同：
         * mac2win / win2mac 的输入是项目目录，exeonmac 的输入是 Windows
         * 安装包。把它统一成 `project` 并写「exeonmac 传安装包路径」，
         * agent 会照着字段名理解成「项目目录」，然后困惑于「安装包不是目录」。
         *
         * 所以两个都列，都不设 required，由翻译层按方向校验（缺了就明确
         * 报「方向 X 的构建需要 Y 参数」）。这比在 schema 里硬性 required
         * 更准确：required 无法表达「按方向二选一」。
         */
        project: { type: 'string', description: '项目目录绝对路径。mac2win / win2mac 用这个。' },
        installer: { type: 'string', description: 'Windows 安装包路径（.exe / .msi）。exeonmac 用这个。' },
        out: { type: 'string', description: '输出目录。省略则用该方向的默认值。' },
        target: { type: 'string', enum: ['x86', 'x64'], description: 'mac2win 的载荷架构。' },
        name: { type: 'string', description: '产品名 / 应用名。' },
        version: { type: 'string', description: '版本号。' },
        executable: { type: 'string', description: 'win2mac 必填：主可执行文件路径。' },
        dryRun: { type: 'boolean', description: '只跑预检，不下载不构建不落盘。' },
        extraArgs: {
          type: 'array',
          items: { type: 'string' },
          description: '原样追加给该方向的额外参数，用于本工具未建模的选项。',
        },
      },
      required: ['direction'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'wacmin_verify',
    title: '校验已有产物',
    description: [
      '校验一个已存在的产物，不重新构建。',
      '回答的是「这个包能不能用」：架构对不对、必需文件在不在、权限位对不对、',
      '符号链接是否仍为链接。报告里 ok 与 complete 是两个维度：',
      'ok 表示有没有查出问题，complete 表示是不是全验了 ——',
      'complete 为假时即使 ok 为真也不能当作通过。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['mac2win', 'exeonmac', 'win2mac', 'apponwin'],
          description: '用哪个方向的校验器。',
        },
        artifact: { type: 'string', description: '产物路径（.exe / .zip / .app 目录）。' },
        target: { type: 'string', enum: ['x86', 'x64'], description: '期望的载荷架构，省略则自动推断。' },
        extraArgs: {
          type: 'array',
          items: { type: 'string' },
          description: '原样追加给该方向的额外参数。',
        },
      },
      required: ['direction', 'artifact'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'wacmin_assess',
    title: '评估兼容性（不执行）',
    description: [
      '只做静态评估，不运行任何程序：解析 .app 结构、判定框架、指出不支持的类别。',
      'apponwin 用 assess，exeonmac 用 detect 识别安装器类型。',
      '注意：本工具给的是「看起来能不能」，不是「跑起来行不行」。',
      '真正的运行验证需要在目标宿主上实测。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['apponwin', 'exeonmac'],
          description: 'apponwin 评估 .app；exeonmac 识别 Windows 安装器类型。',
        },
        path: { type: 'string', description: '.app 目录或安装包路径。' },
        extraArgs: {
          type: 'array',
          items: { type: 'string' },
          description: '原样追加的额外参数。',
        },
      },
      required: ['direction', 'path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'wacmin_run',
    title: '直通子命令（逃生门）',
    description: [
      '把子命令与参数原样传给某个方向，不做任何解释或校验。',
      '当上面几个工具没有覆盖你要用的选项时用这个。',
      'args 里的元素会按顺序拼到命令行，因此不要在里面放 shell 元字符 ——',
      '本服务不经过 shell，它们会被当成普通字符串传给程序。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['mac2win', 'exeonmac', 'win2mac', 'apponwin'],
          description: '目标方向。',
        },
        command: { type: 'string', description: '子命令名，如 build / verify / doctor / layers。' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '按顺序传给子命令的参数，例如 ["--dry-run"]。',
        },
      },
      required: ['direction', 'command'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
]

/** 方向 → build 参数表的映射，供 server 组装 argv。 */
export const BUILD_SPECS = BUILD_PARAMS

/** 方向 → verify 参数字段的映射。 */
export const VERIFY_SPECS = VERIFY_PARAMS

/**
 * 把 `wacmin_build` 的参数翻译成某个方向的 argv。
 *
 * @param {string} direction
 * @param {object} args
 * @returns {string[]}
 */
export function buildArgv(direction, args) {
  const spec = BUILD_PARAMS[direction]
  if (spec === undefined) {
    throw new Error(`方向 ${direction} 不支持构建`)
  }
  const mapped = spec.map(args)
  /*
   * 主位置参数放最前面。
   *
   * 三个方向的 build 都把它当第一个位置参数，但**字段名不同**：
   * mac2win 与 win2mac 叫 `project`（项目目录），exeonmac 叫 `installer`
   * （Windows 安装包路径）—— 后者根本没有「项目」，它的输入就是一个包。
   *
   * 早先这里只读 `args.project`，于是 exeonmac 的安装包路径被整条丢掉，
   * 命令变成 `wepack build -o /tmp/o`，argparse 报「缺少 installer」。
   * 报错信息指向参数缺失，而真实原因是翻译层把字段漏了。
   *
   * 所以按方向取对应的字段，取不到就明确报错，而不是悄悄产出一条残缺命令。
   */
  const primaryField = PRIMARY_FIELD[direction]
  if (primaryField !== undefined && (typeof args[primaryField] !== 'string' || args[primaryField] === '')) {
    throw new Error(`方向 ${direction} 的构建需要 ${primaryField} 参数`)
  }
  const primary = primaryField === undefined ? '' : args[primaryField]
  const extra = Array.isArray(args.extraArgs) ? args.extraArgs.map(String) : []
  return [primary, ...mapped, ...extra].filter((item) => item !== '')
}

/**
 * 各方向 build 的主位置参数字段名。
 *
 * 这张表存在的理由见 {@link buildArgv} 的注释：字段名确实不同，
 * 用统一的名字会静默丢参数。
 */
const PRIMARY_FIELD = {
  mac2win: 'project',
  win2mac: 'project',
  exeonmac: 'installer',
}

/**
 * 把 `wacmin_verify` 的参数翻译成 argv。
 *
 * @param {string} direction
 * @param {object} args
 * @returns {string[]}
 */
export function verifyArgv(direction, args) {
  if (VERIFY_SPECS[direction] === undefined) {
    throw new Error(`方向 ${direction} 不支持校验`)
  }
  const out = [String(args.artifact ?? '')]
  if (typeof args.target === 'string') out.push('--target', args.target)
  if (Array.isArray(args.extraArgs)) out.push(...args.extraArgs.map(String))
  return out.filter((item) => item !== '')
}
