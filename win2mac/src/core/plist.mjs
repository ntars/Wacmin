/**
 * Info.plist 生成。
 *
 * ## 在 Windows 上做这件事的难点
 *
 * macOS 上有 `plutil` 可以校验 plist，Windows 上什么都没有。所以：
 *
 *   - 不能依赖 `plutil` 做校验，必须自己保证 XML 合法
 *   - 不能假设输入的应用名是 ASCII，中文、`&`、`<` 都要正确转义
 *   - 不能写二进制 plist（`bplist00`），那需要额外的序列化实现，
 *     且 macOS 读 XML plist 完全没问题
 *
 * ## 为什么手写 XML 而不是用现成库
 *
 * plist 的 XML 结构极简：`<plist>` 包一个 `<dict>`，里面是成对的
 * `<key>` 与值节点。值只有五种：`<string>` / `<integer>` / `<real>` /
 * `<true/>` `<false/>` / `<array>`。手写约 60 行，比引一个 plist 库
 * 更可控，也避免依赖供应链风险。
 *
 * **唯一必须小心的是转义**。XML 里有五个字符必须转义，漏一个就产出
 * 非法 plist，而 macOS 对此的反应是「应用已损坏」——完全没有提示
 * 是哪里错了。
 *
 * ## 字段来源
 *
 * 与 exeonmac 的 `wepack/package/plist.py` 保持同一套字段与语义，
 * 这样两个方向产出的 `.app` 在结构上完全一致，用户切换工具不会困惑。
 */

import { createHash } from 'node:crypto'

/**
 * XML 文本转义。
 * 五个必须处理的字符：
 *   & → &amp;   （必须第一个替换，否则会把后面替换产生的 & 再转一次）
 *   < → &lt;
 *   > → &gt;
 *   " → &quot;
 *   ' → &apos;
 *
 * 另外剔除 XML 1.0 不允许的控制字符（除 \t \n \r 之外的 0x00–0x1F）。
 * 应用名里混进控制字符的情况罕见，但一旦发生，产出的 plist 会让
 * macOS 直接拒绝解析。
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeXml(text) {
  return String(text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 把 JS 值序列化成 plist XML 的值节点。
 *
 * 只支持 plist 实际需要的类型。对象与数组递归处理 —— plist 没有
 * 深度限制，但我们的字段最深两层（CFBundleDocumentTypes 是数组套字典）。
 *
 * @param {unknown} value
 * @param {number} indent 当前缩进层级。
 * @returns {string}
 */
function serializeValue(value, indent) {
  const pad = '\t'.repeat(indent)

  if (typeof value === 'string') return `<string>${escapeXml(value)}</string>`
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>'
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? `<integer>${String(value)}</integer>`
      : `<real>${String(value)}</real>`
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '<array/>'
    const items = value
      .map((item) => `${pad}\t${serializeValue(item, indent + 1)}`)
      .join('\n')
    return `<array>\n${items}\n${pad}</array>`
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) return '<dict/>'
    const lines = entries.map(([key, item]) =>
      `${pad}\t<key>${escapeXml(key)}</key>\n${pad}\t${serializeValue(item, indent + 1)}`)
    return `<dict>\n${lines.join('\n')}\n${pad}</dict>`
  }

  // undefined / null / 函数：plist 里没有对应类型，当成空串
  return '<string></string>'
}

/**
 * 把字典序列化成完整的 plist 文档。
 *
 * @param {Record<string, unknown>} document
 * @returns {string} 带 XML 声明与 DOCTYPE 的完整文本。
 */
export function serializePlist(document) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
      '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    serializeValue(document, 0),
    '</plist>',
    '',
  ].join('\n')
}

/** CFBundleName 的字符上限。LaunchServices 的硬限制。 */
export const MAX_BUNDLE_NAME = 15

/** 取不到版本时的兜底值。 */
export const DEFAULT_VERSION = '1.0'

/**
 * 生成 `com.wexe.mac.{反向域名}`。
 *
 * 与 exeonmac 的 `com.wexe.win.*` 形成对照：两个方向的包在同一个
 * LaunchServices 数据库里也不会撞。
 *
 * **非 ASCII 名的处理**：bundle id 只允许 `[a-z0-9.-]`，中文应用名
 * 归一化后会变空。若直接返回 `com.wexe.mac.app`，所有中文应用会共用
 * 同一个 id —— LaunchServices 会把它们当成同一个应用，Dock 图标、
 * 默认打开方式、Spotlight 索引全部错乱。
 *
 * 所以只要归一化会丢字符，就用短哈希兜底，保证不同中文名得到不同 id。
 *
 * ## 两种丢字符的形态，都要兜
 *
 * 早先只兜了「全丢」：`app.演示应用` 剥完一个合法段都不剩，走哈希分支。
 * 但**部分丢**同样致命，而且更隐蔽 —— 归一化后还剩几段合法值，看起来
 * 像成功了，实际上把区分度全丢了：
 *
 *   `cn.星玖.测试`   → 剥成 `cn`      （应用这一级没了）
 *   `cn.另一个厂商`  → 剥成 `cn`      （和上面撞成同一个 id）
 *
 * 实测 11 个常见中文应用名配 `--vendor cn.星玖`，修前只产出 **1 个
 * 不同的 bundle id**，修后 11 个两两不同。
 *
 * 兜底形态是 `com.wexe.mac.<可读前缀>-<8 位哈希>`：保留厂商这一段方便
 * 人在 Console.app / lsregister 里辨认，哈希负责保证唯一。哈希的输入
 * 同时包含反向域名与 seed（应用名），因为同一厂商下的多个中文应用
 * 反向域名相同、只有应用名不同。
 *
 * @param {string} reverseDomain
 * @param {string} [seed] 用于生成兜底哈希的原始名（通常是应用名）。
 * @returns {string}
 */
export function makeBundleId(reverseDomain, seed) {
  let raw = String(reverseDomain).trim().toLowerCase()
  for (const prefix of ['com.wexe.mac.', 'com.wexe.']) {
    if (raw.startsWith(prefix)) {
      raw = raw.slice(prefix.length)
      break
    }
  }

  /* 非 ASCII 字符一定会被归一化吃掉，提前记下，后面决定要不要哈希兜底。
   * 用码点判断而不是靠「归一化前后长度是否变化」：`A` → `a` 也是变化，
   * 但那不丢区分度。 */
  const lossy = /[^\x20-\x7e]/u.test(raw)

  const cleaned = raw.replace(/[^a-z0-9\-.]/g, '-')
  const segments = cleaned.split('.').map((s) => s.replace(/^-+|-+$/g, '')).filter(Boolean)

  /*
   * 判断是否「没有有效信息」：所有段都是占位词（app / unknown）。
   *
   * 注意只在**全部**段都是占位时才兜底。若只是末段叫 `app`（例如
   * `vendor.app`），那是有意义的 —— 它代表厂商 vendor 下的 app。
   * 早先的实现逐段过滤占位词，把 `com.wexe.mac.vendor.app` 错削成
   * `com.wexe.mac.vendor`，丢掉了应用这一级。
   */
  const placeholders = new Set(['app', 'unknown'])
  const meaningful = segments.filter((segment) => !placeholders.has(segment))
  const digest = createHash('sha256')
    .update(`${raw}\u0000${String(seed ?? '')}`)
    .digest('hex')
    .slice(0, 8)

  if (meaningful.length === 0) {
    return `com.wexe.mac.app-${digest}`
  }

  /* 部分丢字符：段还在，但已经不唯一了。挂哈希后缀救回来。
   * 纯 ASCII 的输入不受影响 —— `tencent.wechat` 仍是原样。 */
  if (lossy) {
    return `com.wexe.mac.${segments.join('.')}-${digest}`
  }

  return `com.wexe.mac.${segments.join('.')}`
}

/**
 * `CFBundleName`：≤15 字符，按码点截断。
 *
 * 用 `Array.from` 而不是 `slice`：后者按 UTF-16 码元切，emoji 与
 * 部分中日韩字符会被切成半个代理对，产出乱码。
 *
 * @param {string} app
 * @returns {string}
 */
export function makeBundleName(app) {
  const name = String(app).trim()
  if (name === '') return 'App'
  const chars = Array.from(name)
  if (chars.length <= MAX_BUNDLE_NAME) return name
  const truncated = chars.slice(0, MAX_BUNDLE_NAME).join('').replace(/[\s\-_.·、，,]+$/u, '')
  return truncated || chars.slice(0, MAX_BUNDLE_NAME).join('')
}

/**
 * 把任意版本串拆成 `(CFBundleShortVersionString, CFBundleVersion)`。
 *
 * `CFBundleShortVersionString` 给人看，原样保留。
 * `CFBundleVersion` 给系统比大小，必须是纯数字点分 —— 非数字段换 0。
 *
 * @param {string | null | undefined} version
 * @returns {[string, string]}
 */
export function normalizeVersion(version) {
  const text = String(version ?? '').trim()
  if (text === '') return [DEFAULT_VERSION, DEFAULT_VERSION]

  const short = text.replace(/[^0-9A-Za-z._+-]/g, '') || DEFAULT_VERSION
  const parts = text.split(/[._+-]/).map((segment) => {
    const match = /^\d+/.exec(segment)
    return match === null ? '0' : match[0]
  })
  let build = parts.join('.').replace(/^\.+|\.+$/g, '')
  if (build === '' || /^[0.]+$/.test(build)) build = DEFAULT_VERSION
  return [short, build]
}

/**
 * 组装 Info.plist 的字典（未序列化）。
 *
 * 字段与 exeonmac 的 `build_plist` 一一对应。刻意**不设**的键：
 *
 *   - `LSUIElement` / `LSBackgroundOnly`：设了就没有 Dock 图标
 *   - `NSPrincipalClass`：launcher 自管生命周期，不走 NSApplicationMain
 *
 * @param {object} input
 * @param {string} input.appName
 * @param {string} input.bundleId
 * @param {string} input.version
 * @param {string} [input.executable] CFBundleExecutable，默认 launcher。
 * @param {string[]} [input.fileAssociations] 形如 ['.txt']，默认空。
 * @param {string} [input.category]
 * @param {string} [input.minMacOS]
 * @returns {Record<string, unknown>}
 */
export function buildPlist(input) {
  const [shortVersion, buildVersion] = normalizeVersion(input.version)
  const executable = input.executable ?? 'launcher'

  const document = {
    CFBundleName: makeBundleName(input.appName),
    CFBundleDisplayName: `${input.appName} (Mac)`,
    CFBundleIdentifier: input.bundleId,
    CFBundleExecutable: executable,
    CFBundlePackageType: 'APPL',
    CFBundleSignature: '????',
    CFBundleIconFile: 'AppIcon',
    CFBundleShortVersionString: shortVersion,
    CFBundleVersion: buildVersion,
    CFBundleInfoDictionaryVersion: '6.0',
    LSMinimumSystemVersion: input.minMacOS ?? '11.0',
    NSHighResolutionCapable: true,
    LSApplicationCategoryType: input.category ?? 'public.app-category.utilities',
    NSSupportsAutomaticGraphicsSwitching: true,
  }

  const associations = (input.fileAssociations ?? []).filter((ext) => ext.trim() !== '')
  if (associations.length > 0) {
    document.CFBundleDocumentTypes = [{
      CFBundleTypeName: `${input.appName} 文档`,
      CFBundleTypeRole: 'Editor',
      LSHandlerRank: 'Alternate',
      LSItemContentTypes: associations.map((ext) => `public.${ext.replace(/^\./, '').toLowerCase()}`),
    }]
  }

  return document
}

/**
 * 校验一段文本是否像合法的 XML plist。
 *
 * 这不是完整的 XML 解析器，只做「能在 Windows 上抓到大部分错误」的检查：
 *
 *   1. 有 XML 声明
 *   2. 有 `<plist` 根节点
 *   3. 标签成对（粗略统计 `<dict>` / `</dict>` 数量）
 *   4. 没有裸露的 `&`（未转义的 `&` 是最常见的破坏来源）
 *
 * 完整的合法性由 macOS 上的 `plutil -lint` 保证，那才是权威。这里的
 * 目的是**在 Windows 上就发现明显错误**，不把问题留到用户机器上。
 *
 * @param {string} text
 * @returns {string[]} 问题列表，空数组表示通过。
 */
export function validatePlistText(text) {
  const problems = []

  if (!text.startsWith('<?xml')) problems.push('缺少 XML 声明')
  if (!text.includes('<plist')) problems.push('缺少 <plist> 根节点')
  if (!text.trimEnd().endsWith('</plist>')) problems.push('缺少 </plist> 结束标签')

  for (const tag of ['dict', 'array', 'plist']) {
    const open = (text.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length
    const close = (text.match(new RegExp(`</${tag}>`, 'g')) ?? []).length
    if (open !== close) {
      problems.push(`<${tag}> 标签不成对：${String(open)} 开 / ${String(close)} 闭`)
    }
  }

  /*
   * 裸 & 检查：合法的 & 只应出现在实体引用里（&amp; &lt; 等）。
   * 用负向断言找「后面不是合法实体名」的 &。
   */
  const bareAmp = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.exec(text)
  if (bareAmp !== null) {
    const position = bareAmp.index
    const context = text.slice(Math.max(0, position - 30), position + 30)
    problems.push(`存在未转义的 &：…${context}…`)
  }

  return problems
}