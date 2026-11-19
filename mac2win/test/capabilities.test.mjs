/**
 * 产物能力说明的测试（W-06 产物）。
 *
 * ## 这一组守的是什么
 *
 * `describeCapabilities()` 生成的文字会被写进**安装目录的 README.txt**，
 * 也就是最终用户装完软件后唯一能看到的说明。它此前对 Tauri 项目写的是：
 *
 * ```
 * 原生窗口：不包含（Rust 壳需要 Windows 工具链，无法在 arm64 mac 上编译）
 * ```
 *
 * **这句话是错的**，而且错在两个层次：
 *
 * 1. **事实错**：2026-11-19 实测，arm64 macOS 上
 *    `cargo xwin build --target i686-pc-windows-msvc` 能编出真实的
 *    `PE32 / i386 / windows-gui`（探针 92160 字节）。跨架构编译这条路是通的。
 * 2. **归因错**：真正拦住完整 Tauri 项目的是 `llvm-rc` 缺失（`tauri-winres`
 *    生成 Windows 资源节要用），这跟 CPU 架构**毫无关系** —— 在 Intel mac
 *    上一样缺。把原因说成「arm64 编不了」，会让 Intel mac 用户白等一个
 *    永远不会到来的修复。
 *
 * 而且这句话没有任何测试守着，所以它在 README、代码注释、路线图里
 * 被反复复制，越传越像定论。这一组测试给这句话上锁：
 * **不许再出现架构层面的断言**。
 *
 * ## 断言的是「不该说什么」，不是「必须说什么」
 *
 * 这条说明的措辞以后可能改（改成更简、更准确都行），但有一类话永远
 * 不能说：把「缺一个可选工具的某个组件」说成「这台机器做不到」。
 * 所以这里用反向断言（`assert.doesNotMatch`），不锁死措辞。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { describeCapabilities, FRAMEWORKS } from '../src/core/frameworks.mjs'

describe('Tauri 产物说明', () => {
  test('不得声称「arm64 mac 上无法编译」', () => {
    const lines = describeCapabilities('tauri').join('\n')
    /*
     * 这两条是原句里的两个要害词。任何一个出现都说明错误断言被写回来了。
     */
    assert.doesNotMatch(lines, /无法在\s*arm64\s*上?编译/, '又写回「arm64 上无法编译」了')
    assert.doesNotMatch(lines, /arm64/i, '产物说明里不该出现架构断言：本机实测能编出 PE32/i386')
  })

  test('不得把「需要 Windows 工具链」当成不包含原生窗口的理由', () => {
    const lines = describeCapabilities('tauri').join('\n')
    assert.doesNotMatch(lines, /需要\s*Windows\s*工具链/, '归因错误：真正缺的是 llvm-rc，与宿主/目标平台无关')
  })

  test('必须说明本次未包含原生窗口，并给出降级行为', () => {
    const lines = describeCapabilities('tauri').join('\n')
    assert.match(lines, /原生窗口：.*未包含/, '用户必须知道产物里没有原生窗口')
    assert.match(lines, /降级行为：.*浏览器/, '必须说清降级后界面从哪打开')
  })

  test('未开启 Rust 壳时不得暗示「不可能开启」', () => {
    const lines = describeCapabilities('tauri').join('\n')
    /*
     * 「本次未包含」与「不可能包含」是两件事。前者是事实陈述，
     * 后者会让用户直接放弃这条路。
     */
    assert.doesNotMatch(lines, /不可能|永远不支持|不支持此功能/)
  })
})

describe('其他框架的产物说明', () => {
  test('Electron 与 NW.js 声明包含原生窗口', () => {
    for (const id of ['electron', 'nwjs']) {
      assert.equal(FRAMEWORKS[id].nativeShell, true, `${id} 应为原生壳`)
      const lines = describeCapabilities(id).join('\n')
      assert.match(lines, /原生窗口：包含/, `${id} 的说明应声明包含原生窗口`)
    }
  })

  test('node 与 static 说明自己本就没有原生壳', () => {
    for (const id of ['node', 'static']) {
      assert.equal(FRAMEWORKS[id].nativeShell, false)
      const lines = describeCapabilities(id).join('\n')
      assert.match(lines, /这类项目本身没有原生壳/)
    }
  })

  test('未知框架 id 退回 static，不抛异常', () => {
    const lines = describeCapabilities('不存在的框架')
    assert.ok(Array.isArray(lines) && lines.length > 0)
    assert.match(lines.join('\n'), /项目类型：/)
  })

  test('每条说明都含「项目类型」与「说明」两行，便于 README 排版', () => {
    for (const id of Object.keys(FRAMEWORKS)) {
      const lines = describeCapabilities(id)
      assert.ok(lines.some((line) => line.startsWith('项目类型：')), `${id} 缺项目类型行`)
      assert.ok(lines.some((line) => line.startsWith('说明：')), `${id} 缺说明行`)
    }
  })
})
