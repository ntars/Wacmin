/**
 * 标识符唯一性测试。
 *
 * ## 这一组守的是什么
 *
 * `identifier` 进的是 NSIS 生成的注册表路径（`HKCU\Software\<identifier>`），
 * 是同一台 Windows 机器上区分两个应用的**唯一**依据。
 *
 * `slugify` 用 `[^a-z0-9]` 这个字符类做清洗，而它会把所有中文整段吃掉。
 * 于是「记事本」「我的应用」「微信」全部清洗成 `app`，产出的 identifier
 * 一模一样。装两个中文应用后：
 *
 *   - 后装的把先装的 `InstallDir` 注册表值覆盖掉
 *   - 卸载其一会 `DeleteRegKey` 删掉另一个的项
 *   - 控制面板「程序和功能」里只剩一个条目，而文件都还在
 *
 * 这类问题在测试里只有「拿多个名字横向比较」才暴露得出来 —— 单个名字
 * 的断言永远是绿的。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { slugify } from '../src/core/config.mjs'

/** 常见的中文产品名，足够覆盖「纯中文」「中英混排」两种形态。 */
const CJK_NAMES = [
  '记事本', '我的应用', '微信', '网易云音乐', '腾讯会议',
  '钉钉', '微信开发者工具', '空谷 Ondra', '星玖 应用', 'QQ音乐',
]

describe('slugify：标识符唯一性', () => {
  test('中文名必须两两不同', () => {
    const ids = new Map()
    for (const name of CJK_NAMES) {
      const id = slugify(name)
      assert.ok(!ids.has(id), `「${name}」与「${ids.get(id)}」撞了同一个标识符：${id}`)
      ids.set(id, name)
    }
    assert.equal(ids.size, CJK_NAMES.length)
  })

  test('纯中文名带哈希后缀', () => {
    // 归一化后为空，形态是 app-<8 位十六进制>
    assert.match(slugify('记事本'), /^app-[0-9a-f]{8}$/u)
    assert.match(slugify('微信'), /^app-[0-9a-f]{8}$/u)
  })

  test('中英混排保留可读片段', () => {
    // 可读的 ASCII 部分要留住，方便在注册表里辨认
    const id = slugify('空谷 Ondra')
    assert.match(id, /^ondra-[0-9a-f]{8}$/u)
  })

  test('纯 ASCII 名不加后缀', () => {
    /*
     * 向后兼容是硬要求：老用户已经装了 `com.mac2win.notepad`，
     * 如果新版本改成 `com.mac2win.notepad-abc12345`，升级构建会产出
     * 一个「新应用」——注册表里两条、控制面板里两个、旧的不再被更新。
     */
    assert.equal(slugify('Notepad'), 'notepad')
    assert.equal(slugify('MyApp'), 'myapp')
    assert.equal(slugify('a b c'), 'a-b-c')
  })

  test('结果只含合法字符', () => {
    for (const name of CJK_NAMES) {
      const id = slugify(name)
      assert.match(id, /^[a-z0-9-]+$/u, `「${name}」产出了非法标识符：${id}`)
    }
  })

  test('空名仍给 app 占位', () => {
    // 没有任何可哈希的输入，只能给占位值
    assert.equal(slugify(''), 'app')
    assert.equal(slugify('   '), 'app')
    assert.equal(slugify('---'), 'app')
  })

  test('同一名字每次得到相同结果', () => {
    // identifier 必须稳定，否则每次构建都被当成新应用
    for (const name of CJK_NAMES) {
      assert.equal(slugify(name), slugify(name), `「${name}」的结果不稳定`)
    }
  })

  test('仅大小写不同视为同一个应用', () => {
    // 纯 ASCII 路径下大小写归一，符合 Windows 标识符惯例
    assert.equal(slugify('Notepad'), slugify('notepad'))
    assert.equal(slugify('Notepad'), slugify('NOTEPAD'))
  })
})
