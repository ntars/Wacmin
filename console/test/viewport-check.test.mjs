/**
 * 三档视口检查的守卫测试。
 *
 * ## 为什么要有这组测试
 *
 * `scripts/viewport-check.mjs` 会起真实 Chrome 跑真实页面，耗时十几秒，
 * 不适合放进 `npm test`。于是它变成了一个「没人跑就没人知道」的脚本 ——
 * 而这类脚本的失效方式恰恰是**静默的**：它照常退出 0，只是什么都没测到。
 *
 * 本项目已经踩过一次：最初的压测注入是对空容器改文字，页面上那些容器在
 * 初始状态全是空的，于是注入等于没注入，「0 处溢出」连续通过。是靠摘掉
 * `overflow-wrap` 做负向验证才发现的。
 *
 * 所以这里用静态断言守三件最容易坏的事：
 *
 *   1. 压测串长度仍是 139（`style.css` 注释里记录的实测值依赖它）
 *   2. 测量同时查元素外框与文本字形框（只查外框会漏掉固定列宽那一类）
 *   3. `style.css` 里那组类仍带 `min-width: 0` 与 `overflow-wrap: anywhere`
 *
 * 第 3 条是真正的价值：它把 CSS 规则和检查脚本绑在一起。谁哪天顺手删了
 * 这两行，`npm test` 会立刻红，而不是等某个用户在 375px 屏上发现路径
 * 被裁掉。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const script = readFileSync(join(ROOT, 'scripts', 'viewport-check.mjs'), 'utf8')
const css = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8')

/**
 * 去掉注释后的脚本源码。
 *
 * ## 为什么非要这一步（本轮实测踩的坑）
 *
 * 静态守卫最初写成 `assert.match(script, /Emulation\.setTouchEmulationEnabled/u)`。
 * 把代码里那一行**换成无效的 `setEmulatedMedia`** 之后，测试仍 234/234 全绿 ——
 * 因为上面那段注释里正好解释着「只有 `Emulation.setTouchEmulationEnabled`
 * 能让它成立」。断言被注释满足了，等于什么都没守。
 *
 * 这与第 1 轮附录 C 的坑同形：**改动/检查必须落在真正生效的那一小段里**。
 * 所以这里是「拿掉注释、再查代码」。
 */
const scriptCode = script
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/^\s*\/\/.*$/gmu, '')

describe('视口检查脚本', () => {
  test('压测串是 139 个字符，与 style.css 记录的实测值一致', async () => {
    /*
     * 长度一变，「注入同一个串、得到同一组溢出计数」这条可复现性就断了 ——
     * 而 style.css 里那段注释写的正是这个长度下的测量结果。
     */
    const { LONG_PATH } = await import('../scripts/viewport-check.mjs')
    assert.equal(LONG_PATH.length, 139,
      `压测串应为 139 字符，实际 ${String(LONG_PATH.length)}`)
    assert.doesNotMatch(LONG_PATH, /\s/u, '压测串不能含空格，否则会自己换行测不出问题')
  })

  test('三档视口是 375 / 768 / 1440', async () => {
    const { VIEWPORTS } = await import('../scripts/viewport-check.mjs')
    assert.deepEqual(VIEWPORTS.map((v) => v.name), ['375', '768', '1440'])
    assert.deepEqual(VIEWPORTS.map((v) => v.width), [375, 768, 1440])
  })

  test('测量同时覆盖元素外框与文本字形框', () => {
    /*
     * 只查 `getBoundingClientRect()` 会漏掉「文字跑出盒子、盒子不长大」：
     * `.check` 的列宽被钉死 200px，塞长路径时列宽一分不变，文字盖到相邻
     * 列上，而元素外框完全正常。负向验证时 768 / 1440 两档因此全报 0 处。
     *
     * `Range.getClientRects()` 才是量到的字形框，缺了它宽屏档位形同虚设。
     */
    assert.match(script, /Range\(\)/u, '要用 Range 量字形框')
    assert.match(script, /getClientRects\(\)/u, '要取 Range 的字形矩形')
    assert.match(script, /getBoundingClientRect\(\)/u, '元素外框也要查')
  })

  test('压测会造节点而不是只改现有元素的文字', () => {
    /*
     * 页面上报告类容器初始为空，只改现有元素文字等于什么都没做。
     * 必须 createElement 造出与 app.js 同构的行。
     */
    assert.match(script, /createElement/u, '压测必须造节点')
    for (const cls of ['stage-name', 'stage-msg', 'check-name', 'check-detail', 'history-label', 'contract-problem', 'dir-summary']) {
      assert.match(script, new RegExp(`'${cls}'`, 'u'),
        `压测要覆盖 .${cls}，它承载用户路径或安装器输出`)
    }
  })

  test('找不到浏览器时退出码是 2，与「有溢出」的 1 分开', () => {
    /*
     * 混成一个码会让人把环境问题当成代码缺陷去查 —— 这两种情况的处置
     * 完全不同：一个去装浏览器，一个去改样式。
     */
    assert.match(script, /no-chrome/u)
    assert.match(script, /process\.exitCode = 2/u)
    assert.match(script, /process\.exitCode = payload\.ok \? 0 : 1/u)
  })
})

describe('CDP 等待必须有超时（防静默挂死）', () => {
  /*
   * ## 这组锁的是一个真实故障，不是假想
   *
   * 2026-11-19 实测：受限沙箱里 Chrome 自建 sandbox 失败
   * （`sandbox initialization failed: Operation not permitted`），
   * renderer 起不来。Chrome 进程照常启动、`DevToolsActivePort` 照常写出、
   * WebSocket 照常能连 —— 只有 `Page.enable` 永远不回包。
   *
   * 旧实现里 `send()` 的 Promise **永不 settle**，既没有超时也没有错误
   * 分支，于是脚本挂死 6 分钟以上，既不输出也不退出。这比报错糟得多：
   * 报错会告诉你哪里不对，挂死只留一片空白，看门狗和 CI 都以为它还在跑。
   *
   * 修法是两层：`send()` 自身带超时并标记 `cdpTimeout`；主流程只在
   * 这个标记出现时降级重试 `--no-sandbox`。
   */

  test('send() 有超时参数与 cdpTimeout 标记', () => {
    assert.match(script, /send\(method, params = \{\}, sessionId, timeoutMs = \d+\)/u,
      'send 必须带默认超时（不能是永不结算的 Promise）')
    assert.match(script, /cdpTimeout = true/u,
      '超时错误要打标记，供主流程判断是否值得降级重试')
    assert.match(script, /this\.pending\.delete\(id\)/u,
      '超时后必须清掉 pending 槽，否则已死的请求会一直占内存')
    assert.match(script, /clearTimeout\(timer\)/u,
      '正常返回时要清掉定时器，否则进程会被未触发的定时器吊住')
  })

  test('只有 CDP 超时才降级 --no-sandbox，其他错误照常抛', () => {
    /*
     * 无条件重试会把真实错误掩盖掉一半：找不到 Chrome、服务端没起、
     * 页面脚本抛异常，都跟沙箱无关，重试一遍只是把同一个错误再犯一次。
     */
    assert.match(script, /error\?\.cdpTimeout === true/u,
      '降级判据必须是 cdpTimeout 标记，不能是「任意异常」')
    assert.match(script, /--no-sandbox/u)
    assert.match(script, /if \(!sandboxSuspected \|\| options\.noSandbox === true\) throw error/u,
      '非超时错误、或用户已显式要求 no-sandbox 时，必须直接抛')
  })

  test('--no-sandbox 是第二档，默认参数里不带它', () => {
    /*
     * `--no-sandbox` 削弱隔离，不该成为默认。断言的是「按需 unshift」，
     * 也就是它只出现在条件分支里，不在 args 字面量里。
     */
    assert.match(script, /if \(noSandbox\) args\.unshift\('--no-sandbox'\)/u,
      '--no-sandbox 只能按需追加，不能写死在基础参数里')
    const baseArgs = /const args = \[([\s\S]*?)\n  \]/u.exec(script)
    assert.notEqual(baseArgs, null, '应能找到基础参数数组')
    assert.doesNotMatch(baseArgs[1], /--no-sandbox/u,
      '基础参数里不应出现 --no-sandbox')
  })

  test('降级事实要输出到人读界面与 JSON，不能悄悄发生', () => {
    assert.match(script, /fallbackReason/u,
      '降级后要带 fallbackReason，否则读报告的人不知道换了运行方式')
    assert.match(script, /注：本次以 --no-sandbox 运行/u,
      '人读输出要明写降级，避免被误认为默认行为')
  })
})

describe('触控目标尺寸', () => {
  /*
   * ## 这组守的是什么
   *
   * 2026-11-20 实测：375px 下 12 个可点元素的高度是 **24–29px**，一个都
   * 不到 44px。鼠标点得动，手指点不准 —— 四个方向卡片的按钮并排，「自检」
   * 与「构建」相距不到 30px，点错就是真的开始一次构建。
   *
   * 这类缺陷不会出现在功能测试里（功能全对），也不会被用户报告（他们只会
   * 觉得「这看板在手机上不好用」）。所以用两条线守：运行时由
   * `viewport-check.mjs` 真量真断言，静态层在这里把 CSS 与判据绑住。
   */

  test('最小触控目标是 44px，与 Apple HIG 对齐', async () => {
    const { MIN_TOUCH_TARGET } = await import('../scripts/viewport-check.mjs')
    assert.equal(MIN_TOUCH_TARGET, 44,
      'HIG 的最小点击目标是 44×44pt；改这个数要有依据')
  })

  test('放大规则只在 pointer: coarse 下生效，不能全局放大', () => {
    /*
     * 全局把按钮撑到 44px 会让桌面端变松散 —— 鼠标精度远高于手指，
     * 紧凑的终端风格看板正是这个工具的用户习惯的密度。
     *
     * 更关键的是：不能用视口宽度判断。1440px 的触屏笔记本、桌面浏览器里
     * 打开的 375px 响应式预览，都会让宽度判据给出与实际输入方式相反的
     * 答案。`pointer` 描述的是输入设备本身。
     */
    const block = /@media \(pointer: coarse\) \{([\s\S]*?)\n\}/u.exec(css)
    assert.notEqual(block, null, '应有 @media (pointer: coarse) 分组')

    const body = block[1]
    assert.match(body, /\.btn[\s\S]*?min-height:\s*44px/u,
      '粗指针下 .btn 要有 min-height: 44px')
    assert.match(body, /\.btn[\s\S]*?min-width:\s*44px/u,
      '粗指针下 .btn 要有 min-width: 44px')
    assert.match(body, /\.history-row[\s\S]{0,80}?min-height:\s*44px/u,
      '历史行整行可点，也要够高')
    assert.match(body, /summary[\s\S]{0,200}?min-height:\s*44px/u,
      '两个 summary 是折叠开关，也要够高')

    /*
     * 反向断言：`.btn` 的基础规则里不许有 44px。若哪天有人「顺手」把它
     * 写进基础规则，全局都会变大，这条会红。
     */
    const baseBtn = /^\.btn \{([\s\S]*?)\n\}/mu.exec(css)
    assert.notEqual(baseBtn, null, '应有 .btn 基础规则')
    assert.doesNotMatch(baseBtn[1], /min-(height|width):\s*44px/u,
      '.btn 基础规则里不该有 44px，放大只应在粗指针下发生')
  })

  test('脚本真的激活了粗指针，而非只按宽度跳过', () => {
    /*
     * `Emulation.setEmulatedMedia` 带 `{name:'pointer', value:'coarse'}`
     * **无效** —— 实测 `matchMedia('(pointer: coarse)')` 仍回 false。
     * 只有 `setTouchEmulationEnabled` 能让它成立。
     *
     * 这是本轮实测踩到的第一个坑，写成断言防止下一轮又去试错。
     *
     * 注意查的是 `scriptCode`（去注释后）而不是 `script`：两者的注释里
     * 都提到了这些 API 名，直接查 `script` 会被注释满足，空转。
     */
    assert.match(scriptCode, /Emulation\.setTouchEmulationEnabled/u,
      '要激活触控模拟，否则 pointer: coarse 永远不成立、整节空转')
    assert.doesNotMatch(scriptCode, /Emulation\.setEmulatedMedia/u,
      'setEmulatedMedia 改不了 pointer 能力（实测无效），别再用它')
    assert.match(scriptCode, /pointerCoarse/u,
      '要记录粗指针是否真的生效，否则「0 个不达标」可能是没测到')
  })

  test('触控段同时量溢出，防止「修好触控、弄坏布局」', () => {
    /*
     * 按钮从 24px 撑到 44px 会变宽。`.dir-actions` 是 flex-wrap，正常情况
     * 下只会换行；但若哪天改成 nowrap 或去掉 wrap，就会撑破卡片 ——
     * 而那时基线档（细指针）仍是 0 处溢出，发现不了。
     */
    assert.match(scriptCode, /touchOverflow/u,
      '触控档必须同时跑溢出测量')
    assert.match(scriptCode, /row\.touchOverflow\.offenders\.length === 0/u,
      '触控档的溢出要进最终判定，不能只量不判')
  })

  test('粗指针没生效时直接判失败，不留「静默通过」的口子', () => {
    /*
     * 粗指针失效时按钮仍是 24px，`undersized` 会非空 —— 但那是**间接**
     * 失败。若哪天 `MIN_TOUCH_TARGET` 被调小，或页面碰巧有个别大按钮，
     * 这一节就会静默通过。所以要直接断言模拟生效。
     */
    assert.match(scriptCode, /row\.touch\.pointerCoarse === true/u,
      '模拟没生效时必须判失败，否则整节是空转')
  })
})

describe('长串换行规则', () => {
  test('承载长串的类都有 min-width: 0 与 overflow-wrap: anywhere', () => {
    /*
     * 两手缺一不可：
     *   - `min-width: 0` 允许网格项小于内容宽度
     *   - `overflow-wrap: anywhere` 允许任意字符间断行，并让最小内容宽度
     *     按单字符算
     *
     * 只写 `break-word` 不参与最小内容宽度计算，网格仍会被撑开。
     */
    const block = /\n\.dir-summary,\n([\s\S]*?)\{\n([\s\S]*?)\n\}/u.exec(css)
    assert.notEqual(block, null, '应有承载长串的类分组')

    const selectors = `.dir-summary,\n${block[1]}`
    for (const cls of ['dir-summary', 'contract-problem', 'stage-name', 'stage-msg',
      'check-name', 'check-detail', 'history-label', 'error-msg', 'error-hint']) {
      assert.match(selectors, new RegExp(`\\.${cls}`, 'u'), `.${cls} 要在分组里`)
    }

    assert.match(block[2], /min-width:\s*0/u, '分组里要有 min-width: 0')
    assert.match(block[2], /overflow-wrap:\s*anywhere/u, '分组里要有 overflow-wrap: anywhere')
  })
})
