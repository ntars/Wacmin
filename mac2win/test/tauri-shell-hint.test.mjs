/**
 * Tauri 原生窗口提示的测试（W-06 产物）。
 *
 * ## 这一组守的是什么
 *
 * 预检里「原生窗口」这条 warn 的 hint，此前写的是：
 *
 * ```
 * Tauri 的 Rust 壳需要 i686-pc-windows-msvc 工具链，macOS 上没有。
 * 要原生窗口请在 Windows 机器上跑 tauri build
 * ```
 *
 * 两句话都与 2026-11-19 的实测相反：
 *
 * | 说法 | 实测 |
 * |---|---|
 * | 「i686 工具链 macOS 上没有」 | rustup 有 `i686-pc-windows-msvc` 目标，cargo-xwin 自建 clang-cl/lld-link shim，**能编出 PE32/i386/windows-gui** |
 * | 「要去 Windows 机器上跑」 | 不必。真正缺的是 `llvm-rc`，装上就通 |
 *
 * 后果不是报错，是**把一条可行的路描述成死路**。用户读完这段话
 * 最合理的选择就是放弃，而实际上他只差一个 `brew install llvm`。
 *
 * ## 为什么走 runPreflight 而不是直接测 checkFramework
 *
 * `checkFramework` 是模块私有函数（未 export）。硬要 export 只为测试
 * 会污染公开接口。走 `runPreflight` 端到端拿真实的 report 结构，
 * 顺带把「这条 Check 的 id 确实是 framework-shell」也验了 ——
 * 那正是 `preflight-error-codes.test.mjs` 记录过的键名漂移风险。
 *
 * ## 环境依赖
 *
 * `runPreflight` 会查 makensis / Node / 宿主平台。本机（macOS + arm64 +
 * makensis）全绿，所以断言的是「这条 Check 一定存在」而不是「整体通过」。
 * 在没装 makensis 的机器上，framework-shell 依然会产出（它只看框架），
 * 测试照旧成立。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runPreflight } from '../src/core/preflight.mjs'
import { resolveConfig } from '../src/core/config.mjs'

/** 造一个最小 Tauri 项目：只有 src-tauri 目录与前端产物。 */
async function makeTauriProject(extraConfig = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mac2win-tauri-'))
  await mkdir(join(root, 'src-tauri'), { recursive: true })
  await writeFile(join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "probe"\nversion = "0.1.0"\n')
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(join(root, 'dist', 'index.html'), '<!doctype html><title>probe</title>')
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'probe', version: '1.0.0', dependencies: { '@tauri-apps/api': '^2.0.0' } }),
  )
  if (Object.keys(extraConfig).length > 0) {
    await writeFile(join(root, 'mac2win.config.json'), JSON.stringify(extraConfig))
  }
  return root
}

/** 跑一次预检，返回 framework-shell 那一条。 */
async function shellCheck(root) {
  const config = await resolveConfig({ projectRoot: root })
  const report = await runPreflight(config)
  return report.checks.find((check) => check.id === 'framework-shell')
}

describe('Tauri 原生窗口提示', () => {
  test('未开 buildRustShell：提示里不得说 macOS 没有工具链', async () => {
    const root = await makeTauriProject()
    try {
      const check = await shellCheck(root)
      assert.ok(check !== undefined, 'framework-shell 这条检查项不见了（id 漂移？）')
      const text = `${check.detail ?? ''} ${check.hint ?? ''}`
      /*
       * 这两句是本轮删掉的错误断言，任何一个回来都算回归。
       */
      assert.doesNotMatch(text, /macOS 上没有/, '又写回「macOS 上没有 i686 工具链」了——实测能编出 PE32/i386')
      assert.doesNotMatch(text, /在 Windows 机器上跑/, '「必须换 Windows 机器」是错的：补 llvm-rc 就够')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('未开 buildRustShell：提示必须指出真正的开关与缺的东西', async () => {
    const root = await makeTauriProject()
    try {
      const check = await shellCheck(root)
      const hint = check.hint ?? ''
      assert.match(hint, /buildRustShell/, '要告诉用户怎么开启，而不是只说「不支持」')
      assert.match(hint, /llvm-rc/, '真正缺的是 llvm-rc，必须点名')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('开了 buildRustShell：不得重复断言「做不到」，应指向 rust-env 一项', async () => {
    const root = await makeTauriProject({ buildRustShell: true })
    try {
      const check = await shellCheck(root)
      assert.ok(check !== undefined)
      assert.equal(check.status, 'warn', '要编壳但没编成，应是 warn 而非 pass')
      assert.match(check.detail ?? '', /详见上面/, '预检已单列 rust-env，这里应指过去而不是复述')
      assert.doesNotMatch(`${check.detail ?? ''} ${check.hint ?? ''}`, /macOS 上没有|在 Windows 机器上跑/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('开了 buildRustShell：预检必须出现 rust-env 一项', async () => {
    const root = await makeTauriProject({ buildRustShell: true })
    try {
      const config = await resolveConfig({ projectRoot: root })
      const report = await runPreflight(config)
      const rustEnv = report.checks.find((check) => check.id === 'rust-env')
      assert.ok(rustEnv !== undefined, '开 buildRustShell 却没查 Rust 环境：缺 llvm-rc 会一直编到中途才 panic')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('非 Tauri 项目不该出现 buildRustShell 相关提示', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mac2win-node-'))
    try {
      await mkdir(join(root, 'dist'), { recursive: true })
      await writeFile(join(root, 'dist', 'index.html'), '<!doctype html>')
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0' }))
      const check = await shellCheck(root)
      assert.ok(check !== undefined)
      const text = `${check.detail ?? ''} ${check.hint ?? ''}`
      assert.doesNotMatch(text, /buildRustShell|llvm-rc/, 'Tauri 专属建议不该出现在别的框架上')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
