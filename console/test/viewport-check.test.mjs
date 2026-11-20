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

describe('长串断行质量（第 4 段）', () => {
  test('pathSegments 只在分隔符后给断点，且不丢字符', async () => {
    const { pathSegments } = await import('../web/report-view.mjs')
    const path = '/a/b-c\\d'
    const segments = pathSegments(path)
    assert.deepEqual(segments, [
      { text: '/', breakAfter: true },
      { text: 'a/', breakAfter: true },
      { text: 'b-', breakAfter: true },
      { text: 'c\\', breakAfter: true },
      { text: 'd', breakAfter: false },
    ])
    /*
     * 拼回去必须与原文一字不差 —— 断点只是**机会**，不是字符。
     * 这条是「复制出来的路径还能用」的地基。
     */
    assert.equal(segments.map((s) => s.text).join(''), path)
    assert.equal(segments.filter((s) => s.breakAfter).length, 4)
  })

  test('pathSegments 对空串与非字符串不抛异常', async () => {
    const { pathSegments } = await import('../web/report-view.mjs')
    assert.deepEqual(pathSegments(''), [])
    assert.deepEqual(pathSegments(null), [])
    assert.deepEqual(pathSegments(undefined), [])
    assert.deepEqual(pathSegments(42), [])
  })

  test('pathSegments 对无分隔符的串返回单段', async () => {
    const { pathSegments } = await import('../web/report-view.mjs')
    // SHA-256、UUID 这类没有天然边界的串，只能整段给出去
    const sha = 'a'.repeat(64)
    assert.deepEqual(pathSegments(sha), [{ text: sha, breakAfter: false }])
  })

  test('压测调用产品的 writeText，不自己另写一份断行逻辑', () => {
    /*
     * ## 这条守的是什么（本轮实测踩的坑）
     *
     * 压测注入的节点本来就绕过了 app.js 的渲染路径。最初压测**自己**在页面里
     * 实现了一遍「插入 <wbr>」，于是把产品的 `writeText` 退回 `textContent`
     * 做负向验证时，脚本仍报「断在词中间 0 处」、退出码 0 —— 压测量的是它
     * 自己的实现，产品坏了照样绿。
     *
     * 改成 `import('./app.js')` 取页面已加载的那份真实模块后，同一次负向
     * 验证立刻报 15 处、退出码 1。
     */
    assert.match(scriptCode, /import\(['"]\.\/app\.js['"]\)/u,
      '压测必须 import 页面上真实的 app.js 模块')
    assert.match(scriptCode, /writeText/u, '压测要用产品的 writeText 写文本')
    assert.doesNotMatch(scriptCode, /createElement\(['"]wbr['"]\)[\s\S]{0,200}?const segments/u,
      '压测不应自己切分文本')
  })

  test('app.js 的写入入口是 writeText，且被 export 给压测复用', () => {
    const appJs = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
    const appCode = appJs.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
    assert.match(appCode, /export function writeText\(/u,
      'writeText 必须 export，压测才能复用同一份实现')
    assert.match(appCode, /pathSegments/u, 'writeText 要用 pathSegments 切分')
    assert.match(appCode, /createElement\(['"]wbr['"]\)/u, '要真的插入 <wbr>')
    /*
     * `el()` 是创建元素的唯一入口。它若绕过 writeText 直接 `textContent`，
     * 所有由 el() 造出来的容器（阶段名、校验详情、错误提示…）就全退回硬断。
     */
    const elBody = /function el\([\s\S]{0,400}?\n\}/u.exec(appCode)
    assert.notEqual(elBody, null, '应能找到 el 函数')
    assert.match(elBody[0], /writeText\(/u, 'el() 必须走 writeText')
    assert.doesNotMatch(elBody[0], /\.textContent\s*=/u, 'el() 不应直接写 textContent')
  })

  test('style.css 不再用 word-break: break-all 处理长串', () => {
    /*
     * `break-all` 会**无视** `<wbr>`。实测同一个 139 字符路径，加不加 `<wbr>`
     * 断行位置完全一致（223px 容器下 4 处硬断照旧）。`<wbr>` 要生效，承载它的
     * 容器必须是 `overflow-wrap: anywhere`。
     */
    const resultVal = /\.result-val\s*\{([^}]*)\}/u.exec(css)
    assert.notEqual(resultVal, null, '应有 .result-val 规则')
    assert.doesNotMatch(resultVal[1], /word-break:\s*break-all/u,
      'break-all 会让 <wbr> 失效，必须换成 overflow-wrap: anywhere')
    assert.match(resultVal[1], /overflow-wrap:\s*anywhere/u, '.result-val 要用 anywhere')
    assert.match(resultVal[1], /min-width:\s*0/u, '.result-val 也要 min-width: 0')
  })

  test('选择器清单里的每一项都在 app.js 的真实渲染点里', () => {
    /*
     * 清单多一项 → 检查报「元素不存在」；少一项 → 那处永远不被量。
     * 两边都是静默失效，所以逐项核对类名确实出现在 app.js 里。
     */
    const appJs = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
    const listed = [...script.matchAll(/^\s{2}'\.([a-z-]+)',$/gmu)].map((m) => m[1])
    assert.ok(listed.length >= 9, `选择器清单应至少 9 项，实际 ${String(listed.length)}`)
    for (const cls of listed) {
      assert.match(appJs, new RegExp(`['"\`]${cls}['"\` ]`, 'u'),
        `.${cls} 在 app.js 里找不到对应渲染点`)
    }
  })

  test('判定里包含断行质量与「元素缺失」两条', () => {
    assert.match(scriptCode, /row\.lineBreaks/u, '判定要读 lineBreaks')
    assert.match(scriptCode, /item\.dirty === 0/u, '断在词中间必须判失败')
    assert.match(scriptCode, /item\.missing !== true/u,
      '选择器失效必须判失败，否则整节静默空转')
  })
})

describe('键盘焦点链路（第 5 段）', () => {
  /*
   * 这一组守的是一个「所有测试都绿着、只有键盘用户受害」的缺陷。
   *
   * 实测到的形态：`btn-contract` 的 click 处理里 `disabled = true`，鼠标
   * 点击看不出问题；真实回车之后焦点掉到 `<body>`，键盘用户要按 12 次
   * Tab 才够得到「关闭」。程序化 `.click()` 复现不出来 —— 差别在
   * Enter 是 keydown → click → keyup 三步，disabled 之后 keyup 无处可落。
   */

  test('judgeKeyboardFocus 对正常结果判通过', async () => {
    const { judgeKeyboardFocus } = await import('../scripts/viewport-check.mjs')
    const verdict = judgeKeyboardFocus({
      afterActivate: { tag: 'section', id: 'contract-panel', cls: '.panel', onBody: false, inHidden: false, ring: true },
      afterDone: {
        panelHidden: false,
        panelInViewport: true,
        bodyNodes: 65,
        active: { tag: 'section', id: 'contract-panel', cls: '.panel', onBody: false, inHidden: false, ring: true },
      },
      panelTabToClose: 1,
      afterClose: {
        panelHidden: true,
        active: { tag: 'button', id: 'btn-contract', cls: '.btn', onBody: false, inHidden: false, ring: true },
      },
    })
    assert.equal(verdict.ok, true, `不该有问题，实际：${verdict.problems.join(' / ')}`)
    assert.deepEqual(verdict.problems, [])
  })

  test('焦点掉到 body 判失败（两处都要查）', async () => {
    /*
     * 只查「检查完成后」会漏掉触发瞬间那次丢失：如果代码在 finally 里
     * 把焦点补回按钮，末态看着正常，但用户在检查跑的那几秒里是无位置感
     * 的。所以两个时点各断言一次。
     */
    const { judgeKeyboardFocus } = await import('../scripts/viewport-check.mjs')
    const base = {
      afterDone: { panelHidden: false, panelInViewport: true, bodyNodes: 65, active: { tag: 'button', id: 'btn-contract', cls: '.btn', onBody: false, inHidden: false, ring: true } },
      panelTabToClose: 1,
      afterClose: { panelHidden: true, active: { tag: 'button', id: 'btn-contract', cls: '.btn', onBody: false, inHidden: false, ring: true } },
    }
    const body = { tag: 'body', id: '', cls: '', onBody: true, inHidden: false, ring: false }

    const onActivate = judgeKeyboardFocus({ ...base, afterActivate: body })
    assert.equal(onActivate.ok, false, '触发瞬间的焦点丢失必须判失败')
    assert.ok(onActivate.problems.some((p) => p.includes('回车触发后') && p.includes('body')),
      `问题里应点名「回车触发后」，实际：${onActivate.problems.join(' / ')}`)

    const onDone = judgeKeyboardFocus({
      ...base,
      afterActivate: base.afterDone.active,
      afterDone: { ...base.afterDone, active: body },
    })
    assert.equal(onDone.ok, false, '检查完成后的焦点丢失必须判失败')
    assert.ok(onDone.problems.some((p) => p.includes('检查完成后') && p.includes('body')),
      `问题里应点名「检查完成后」，实际：${onDone.problems.join(' / ')}`)
  })

  test('焦点落在隐藏区域或没有可见焦点环都判失败', async () => {
    const { judgeKeyboardFocus } = await import('../scripts/viewport-check.mjs')
    const base = {
      afterDone: { panelHidden: false, panelInViewport: true, bodyNodes: 65, active: { tag: 'section', id: 'contract-panel', cls: '.panel', onBody: false, inHidden: false, ring: true } },
      panelTabToClose: 1,
      afterClose: { panelHidden: true, active: { tag: 'button', id: 'btn-contract', cls: '.btn', onBody: false, inHidden: false, ring: true } },
    }

    const inHidden = judgeKeyboardFocus({
      ...base,
      afterActivate: { tag: 'button', id: 'btn-contract-close', cls: '.btn', onBody: false, inHidden: true, ring: true },
    })
    assert.equal(inHidden.ok, false, '焦点在隐藏区里必须判失败')

    const noRing = judgeKeyboardFocus({
      ...base,
      afterActivate: { tag: 'section', id: 'contract-panel', cls: '.panel', onBody: false, inHidden: false, ring: false },
    })
    assert.equal(noRing.ok, false,
      '焦点落在看不见的地方等于没有焦点，必须判失败（本轮第一版修法就踩了这条：outline: none 没给替代标记）')
  })

  test('关闭后焦点必须回到触发按钮', async () => {
    const { judgeKeyboardFocus } = await import('../scripts/viewport-check.mjs')
    const verdict = judgeKeyboardFocus({
      afterActivate: { tag: 'section', id: 'contract-panel', cls: '.panel', onBody: false, inHidden: false, ring: true },
      afterDone: { panelHidden: false, panelInViewport: true, bodyNodes: 65, active: { tag: 'section', id: 'contract-panel', cls: '.panel', onBody: false, inHidden: false, ring: true } },
      panelTabToClose: 1,
      afterClose: {
        panelHidden: true,
        active: { tag: 'button', id: 'btn-contract-close', cls: '.btn', onBody: false, inHidden: true, ring: false },
      },
    })
    assert.equal(verdict.ok, false)
    assert.ok(verdict.problems.some((p) => p.includes('关闭后') && p.includes('btn-contract')),
      `应点名关闭后的落点，实际：${verdict.problems.join(' / ')}`)
  })

  test('面板没渲染出内容时判失败，防止整节空转', async () => {
    /*
     * 最危险的一种「绿」：检查根本没触发，面板里 0 个节点，于是「焦点
     * 在面板上」「关闭后回到按钮」全都能被一个空页面满足。这条守的是
     * 与「压测注入到空集合」同类的坑。
     */
    const { judgeKeyboardFocus } = await import('../scripts/viewport-check.mjs')
    const verdict = judgeKeyboardFocus({
      afterActivate: { tag: 'section', id: 'contract-panel', cls: '.panel', onBody: false, inHidden: false, ring: true },
      afterDone: { panelHidden: false, panelInViewport: true, bodyNodes: 0, active: { tag: 'section', id: 'contract-panel', cls: '.panel', onBody: false, inHidden: false, ring: true } },
      panelTabToClose: 1,
      afterClose: { panelHidden: true, active: { tag: 'button', id: 'btn-contract', cls: '.btn', onBody: false, inHidden: false, ring: true } },
    })
    assert.equal(verdict.ok, false, '面板 0 个节点必须判失败')
    assert.ok(verdict.problems.some((p) => p.includes('空转')), verdict.problems.join(' / '))
  })

  test('面板内到「关闭」的 Tab 距离超过 2 步判失败', async () => {
    const { judgeKeyboardFocus } = await import('../scripts/viewport-check.mjs')
    const verdict = judgeKeyboardFocus({
      afterActivate: { tag: 'section', id: 'contract-panel', cls: '.panel', onBody: false, inHidden: false, ring: true },
      afterDone: { panelHidden: false, panelInViewport: true, bodyNodes: 65, active: { tag: 'section', id: 'contract-panel', cls: '.panel', onBody: false, inHidden: false, ring: true } },
      panelTabToClose: -1,
      afterClose: { panelHidden: true, active: { tag: 'button', id: 'btn-contract', cls: '.btn', onBody: false, inHidden: false, ring: true } },
    })
    assert.equal(verdict.ok, false, '走不到「关闭」必须判失败')
  })

  test('判定被接进 ok 总判，不是孤立函数', () => {
    assert.match(scriptCode, /judgeKeyboardFocus\(row\.keyboard\)\.ok/u,
      'judgeKeyboardFocus 必须进 runViewportCheck 的 ok 判定，否则测了不判')
  })

  test('产品代码不用 disabled 防重入（会丢键盘焦点）', () => {
    /*
     * 这条是本轮缺陷的直接回归锁。`disabled` 在 click 处理里一设，
     * 真实回车的 keyup 无处投递，焦点退回 body —— 实测四组对照确认。
     */
    const appJs = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
    const appCode = appJs.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
    assert.doesNotMatch(appCode, /button\.disabled\s*=/u,
      '契约检查按钮不许用 disabled 防重入 —— 真实回车会丢焦点，改用 aria-disabled + 布尔量')
    assert.match(appCode, /button\.setAttribute\(\s*'aria-disabled'/u,
      '忙碌态应通过 aria-disabled 表达')
    assert.match(appCode, /let contractBusy = false/u,
      '防重入应有独立的布尔标记，不依赖 DOM 属性')
  })

  test('关闭面板后把焦点交回触发按钮', () => {
    const appJs = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
    const closeFn = /function closeContractPanel\(\)[\s\S]{0,400}?\n\}/u.exec(appJs)
    assert.notEqual(closeFn, null, '应有 closeContractPanel 函数')
    assert.match(closeFn[0], /'btn-contract'\)\.focus\(\)/u,
      '关闭后必须把焦点交回触发按钮，否则掉到 body')
    assert.match(closeFn[0], /hidden = true/u, '关闭要把面板收起')
  })

  test('契约面板可被程序化聚焦（tabindex="-1"）', () => {
    const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')
    const panelTag = /<section[^>]*id="contract-panel"[^>]*>/u.exec(html)
    assert.notEqual(panelTag, null, '应有 contract-panel 章节')
    assert.match(panelTag[0], /tabindex="-1"/u,
      '面板要能接受程序化焦点，但 -1 不进 Tab 序列')
    assert.match(panelTag[0], /role="region"/u, '面板应有 region 语义')
    assert.match(panelTag[0], /aria-label=/u, 'region 必须有可读名称，否则读屏念「区域」')
  })

  test('程序化聚焦的面板有可见反馈', () => {
    /*
     * 第一版修法写的是 `.panel:focus { outline: none }` —— 挪了焦点却不
     * 给任何标记，等于把「焦点在面板上」变成看不见的事实。检查当场报红
     * （实测三档各 1 条）。这条锁住「必须有替代标记」。
     */
    assert.match(css, /\.panel:focus\s*\{[^}]*box-shadow/u,
      '程序化聚焦的面板必须给可见标记（outline: none 之后要有 box-shadow 或 border 替代）')
  })
})
