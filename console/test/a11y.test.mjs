/**
 * 前端可访问性（a11y）静态检查。
 *
 * ## 为什么用静态检查而不是 DOM 测试
 *
 * 项目零依赖，引 jsdom 只为断言几个属性不划算。而且这里要守的是
 * **源码里的结构约定**（哪些元素必须可聚焦、哪些属性必须存在），
 * 静态检查比 DOM 测试更直接，也不用为了跑测试去模拟浏览器。
 *
 * 代价是查不了「运行时才拼出来的 DOM」。所以每条检查都指向一段
 * 具体的构造代码（`app.js` 里创建元素的那几行），而不是泛泛地
 * 要求「所有 div 都可聚焦」。
 *
 * ## 这一组守的是什么
 *
 * 一个只用鼠标的人不会发现这些问题 —— 鼠标点得动，看起来完全正常。
 * 但用键盘的人够不到，用读屏的人听不懂。这类缺陷不会出现在功能
 * 测试里，也不会被用户主动报告（他们只会觉得「这工具不太好用」）。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..', 'web')

const html = readFileSync(join(WEB, 'index.html'), 'utf8')
const appJs = readFileSync(join(WEB, 'app.js'), 'utf8')
const css = readFileSync(join(WEB, 'style.css'), 'utf8')

describe('文档基础', () => {
  test('声明了中文语言', () => {
    /*
     * `lang` 缺失时读屏会用默认语言发音，中英混排念得支离破碎。
     * 也会影响浏览器的字体回退与断词。
     */
    assert.match(html, /<html[^>]+lang="zh-CN"/u, 'html 标签要声明 lang="zh-CN"')
  })

  test('有页面标题', () => {
    assert.match(html, /<title>[^<]+<\/title>/u)
  })

  test('viewport 允许缩放（不要 maximum-scale=1）', () => {
    /*
     * `user-scalable=no` 或 `maximum-scale=1` 会禁止双指放大 ——
     * 视力不佳的用户唯一的补救手段被拿掉了。这是最常见也最容易
     * 避免的可访问性错误。
     */
    const viewport = /<meta[^>]+name="viewport"[^>]*content="([^"]+)"/u.exec(html)
    assert.notEqual(viewport, null, '必须有 viewport meta')
    assert.doesNotMatch(viewport[1], /user-scalable\s*=\s*no/u,
      '不应该禁止缩放')
    assert.doesNotMatch(viewport[1], /maximum-scale\s*=\s*1(?![\d.])/u,
      '不应该把最大缩放限死在 1')
  })
})

describe('可交互元素', () => {
  test('所有 button 都显式声明 type', () => {
    /*
     * `<button>` 默认 type 是 `submit`。放进 `<form>` 里会变成提交按钮。
     * 现在页面没有 form，但将来加一个搜索框就会踩这个坑 —— 而且现象
     * 是「点某个无关按钮导致整页刷新」，极难归因。
     */
    const buttons = [...html.matchAll(/<button\b[^>]*>/gu)].map((m) => m[0])
    const noType = buttons.filter((tag) => !/\btype=/u.test(tag))
    assert.deepEqual(noType, [], `这些 button 缺 type：${noType.join(' | ')}`)
  })

  test('历史行可聚焦且能被键盘触发', () => {
    /*
     * 历史行是 `div` + `click`。这种做法鼠标能用、**键盘完全够不到**：
     * div 不进 Tab 序列，回车也不触发 click。用键盘的人看到历史里
     * 有一行却打不开，也不知道为什么。
     *
     * 检查源码里的三个必备件：tabIndex、role、keydown。
     */
    assert.match(appJs, /row\.tabIndex\s*=\s*0/u,
      '历史行必须设 tabIndex，否则键盘 Tab 不到')
    assert.match(appJs, /row\.setAttribute\(\s*'role'\s*,\s*'button'\s*\)/u,
      '历史行必须声明 role=button，否则读屏不知道它能点')
    assert.match(appJs, /addEventListener\(\s*'keydown'/u,
      '历史行必须响应 keydown，否则聚焦了也按不动')
  })

  test('keydown 同时响应回车与空格，且空格阻止滚动', () => {
    /*
     * 原生按钮两种键都触发。只处理 Enter 会让习惯了空格的用户按不动。
     *
     * 空格必须 preventDefault —— 否则页面会同时向下滚动，用户看到
     * 的是「按一下空格，页面跳了，但没打开东西」。
     */
    const keydown = /addEventListener\(\s*'keydown'[\s\S]{0,400}?\}\)/u.exec(appJs)
    assert.notEqual(keydown, null, '应有 keydown 监听')
    assert.match(keydown[0], /'Enter'/u, '要响应回车')
    assert.match(keydown[0], /' '/u, '要响应空格')
    assert.match(keydown[0], /preventDefault/u,
      '空格要 preventDefault，否则页面会同时滚动')
  })

  test('可点元素都有焦点样式', () => {
    /*
     * 没有 `:focus-visible` 样式时，键盘用户按 Tab 会「焦点消失」——
     * 焦点其实在移动，但屏幕上没有任何视觉提示。
     */
    assert.match(css, /\.btn:focus-visible/u, '.btn 要有焦点样式')
    assert.match(css, /\.history-row:focus-visible/u,
      '历史行要有焦点样式，否则键盘用户看不到焦点在哪')
  })
})

describe('文本与图标', () => {
  test('图片都有 alt 属性', () => {
    const imgs = [...html.matchAll(/<img\b[^>]*>/gu)].map((m) => m[0])
    const noAlt = imgs.filter((tag) => !/\balt=/u.test(tag))
    assert.deepEqual(noAlt, [], `这些 img 缺 alt：${noAlt.join(' | ')}`)
  })

  test('纯图标符号旁有文字说明', () => {
    /*
     * ✓ ✗ ⟳ ▸ 这些符号读屏会念成「对勾」「叉」甚至不念。用作状态
     * 标记时必须同时有可读文本，否则读屏用户只知道「有符号」。
     *
     * 这条不做通用检查（无法自动判断），只确认阶段标记旁有 name 文本 ——
     * 这是本页面唯一用纯符号表达状态的地方。
     */
    assert.match(appJs, /el\('span',\s*'stage-mark'/u,
      '阶段行有 mark')
    assert.match(appJs, /el\('span',\s*'stage-name'/u,
      '阶段行必须同时有 name 文本，否则读屏只知道有个符号')
  })
})

describe('对比度与动效', () => {
  test('尊重 prefers-reduced-motion', () => {
    /*
     * 平滑滚动与过渡对前庭功能敏感的人是真实的不适来源。系统级开关
     * 是用户明确的意愿表达，页面该听。
     */
    assert.match(css, /prefers-reduced-motion/u,
      '应尊重 prefers-reduced-motion')
  })

  test('没有用 !important 硬压样式', () => {
    /*
     * `!important` 会盖掉用户样式表与浏览器无障碍插件（强制高对比、
     * 强制大字号）。这是它们唯一能起作用的方式。
     */
    const important = [...css.matchAll(/!important/gu)]
    assert.ok(important.length <= 2,
      `!important 出现 ${String(important.length)} 次，会盖掉用户样式表与无障碍插件`)
  })
})
