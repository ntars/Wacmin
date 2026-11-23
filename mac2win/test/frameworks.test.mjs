/**
 * 框架识别与配置的测试。
 *
 * 这些测试用临时目录构造各种项目形态，验证「识别对不对、推断准不准」。
 * 不依赖真实项目，所以能在任何机器上跑。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectFramework, inferForFramework, checkFrameworkTarget, describeCapabilities, FRAMEWORKS } from '../src/core/frameworks.mjs'
import { resolveConfig, FRAMEWORK_BUILD_COMMANDS } from '../src/core/config.mjs'

/** 建一个临时项目目录。 */
async function makeProject(files) {
  const root = await mkdtemp(join(tmpdir(), 'mac2win-test-'))
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content, undefined, 2))
  }
  return root
}

test('识别 Tauri：靠 src-tauri 目录', async () => {
  const root = await makeProject({
    'package.json': { name: 'app', dependencies: { '@tauri-apps/api': '^2.0.0' } },
    'src-tauri/Cargo.toml': '[package]\nname = "app"',
  })
  try {
    const result = await detectFramework(root)
    assert.equal(result.id, 'tauri')
    assert.equal(result.confidence, 'high')
    assert.match(result.evidence.join(''), /src-tauri/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('识别 Flutter：靠 pubspec.yaml', async () => {
  const root = await makeProject({
    'pubspec.yaml': 'name: demo\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n',
    'windows/CMakeLists.txt': 'cmake_minimum_required(VERSION 3.14)\n',
  })
  try {
    const result = await detectFramework(root)
    assert.equal(result.id, 'flutter')
    assert.equal(result.confidence, 'high')
    assert.match(result.evidence.join(''), /pubspec/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Flutter 发布目录从真实 .exe 推断', async () => {
  const root = await makeProject({
    'pubspec.yaml': 'name: demo\n',
    'build/windows/x64/runner/Release/demo.exe': 'MZ',
    'build/windows/x64/runner/Release/data/flutter_assets/AssetManifest.json': '{}',
  })
  try {
    const inferred = await inferForFramework('flutter', root, null)
    assert.equal(inferred.flutterReleaseDir, 'build/windows/x64/runner/Release')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Flutter x86 与 x64 都允许，但描述必须写清 Windows 构建边界', () => {
  assert.equal(checkFrameworkTarget('flutter', 'x86').ok, true)
  assert.equal(checkFrameworkTarget('flutter', 'x64').ok, true)
  const lines = describeCapabilities('flutter').join('\n')
  assert.match(lines, /Windows/)
  assert.match(lines, /原生窗口：包含/)
})

test('识别 Electron：靠依赖', async () => {
  const root = await makeProject({
    'package.json': { name: 'app', devDependencies: { electron: '^43.0.0' } },
    'main.js': '',
  })
  try {
    const result = await detectFramework(root)
    assert.equal(result.id, 'electron')
    assert.equal(result.confidence, 'high')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('常见框架的默认构建命令与显式配置优先级', async () => {
  assert.equal(FRAMEWORK_BUILD_COMMANDS.electron, 'npm run build')
  assert.equal(FRAMEWORK_BUILD_COMMANDS.tauri, 'npm run tauri build')
  assert.equal(FRAMEWORK_BUILD_COMMANDS.flutter, null)

  const tauriRoot = await makeProject({
    'src-tauri/Cargo.toml': '[package]\nname = "app"',
    'package.json': { name: 'app', dependencies: { '@tauri-apps/api': '^2.0.0' } },
    'dist/index.html': '<!doctype html><title>app</title>',
  })
  try {
    const tauriConfig = await resolveConfig({ projectRoot: tauriRoot })
    assert.equal(tauriConfig.framework, 'tauri')
    assert.equal(tauriConfig.buildCommand, 'npm run tauri build')
  } finally {
    await rm(tauriRoot, { recursive: true, force: true })
  }

  const root = await makeProject({
    'pubspec.yaml': 'name: demo\n',
    'build/windows/x64/runner/Release/demo.exe': 'MZ',
    'dist/index.html': '<!doctype html><title>demo</title>',
    'mac2win.config.json': { buildCommand: 'echo custom' },
  })
  try {
    const config = await resolveConfig({ projectRoot: root, overrides: { buildCommand: 'echo cli' } })
    assert.equal(config.framework, 'flutter')
    assert.equal(config.buildCommand, 'echo cli', '命令行应覆盖配置文件')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('覆盖所有已知框架的默认构建命令门禁', async () => {
  for (const [id, expected] of Object.entries(FRAMEWORK_BUILD_COMMANDS)) {
    assert.ok(FRAMEWORKS[id] !== undefined, `${id} 必须在 FRAMEWORKS 里登记`)
    assert.ok(expected === null || typeof expected === 'string', `${id} 的默认命令形态不对`)
  }
  for (const id of Object.keys(FRAMEWORKS)) {
    assert.ok(id in FRAMEWORK_BUILD_COMMANDS, `${id} 缺默认构建命令`)
  }
})

test('识别 NW.js：靠依赖', async () => {
  const root = await makeProject({
    'package.json': { name: 'app', devDependencies: { nw: '^0.90.0' } },
    'index.html': '',
  })
  try {
    const result = await detectFramework(root)
    assert.equal(result.id, 'nwjs')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('识别静态站点：靠 dist/index.html', async () => {
  const root = await makeProject({
    'package.json': { name: 'app' },
    'dist/index.html': '<html></html>',
  })
  try {
    const result = await detectFramework(root)
    assert.equal(result.id, 'static')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('显式指定框架优先于一切推断', async () => {
  const root = await makeProject({
    'package.json': { devDependencies: { electron: '^43.0.0' } },
    'src-tauri/Cargo.toml': '',
  })
  try {
    // 目录特征说 tauri、依赖说 electron，但用户说是 node。
    const result = await detectFramework(root, { framework: 'node' })
    assert.equal(result.id, 'node')
    assert.equal(result.confidence, 'explicit')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('空目录按静态站处理并标记为推测', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mac2win-empty-'))
  try {
    const result = await detectFramework(root)
    assert.equal(result.id, 'static')
    assert.equal(result.confidence, 'guess')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Electron 入口从 package.json main 推断', async () => {
  const root = await makeProject({ 'main.js': '' })
  try {
    const inferred = await inferForFramework('electron', root, { main: 'electron-main.js' })
    assert.equal(inferred.entry, 'electron-main.js')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Electron x86 超过 v43 被拒绝', () => {
  const ok = checkFrameworkTarget('electron', 'x86', '43.0.0')
  assert.equal(ok.ok, true)

  const bad = checkFrameworkTarget('electron', 'x86', '44.0.0')
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /44|win32-ia32/)
  assert.ok(bad.hint.includes('43'), '应该给出可用版本')
})

test('Electron x64 不受 v44 限制', () => {
  const result = checkFrameworkTarget('electron', 'x64', '45.0.0')
  assert.equal(result.ok, true)
})

test('NW.js 支持 x86', () => {
  assert.equal(checkFrameworkTarget('nwjs', 'x86').ok, true)
})

test('未知框架被拒绝', () => {
  const result = checkFrameworkTarget('wails', 'x86')
  assert.equal(result.ok, false)
})

test('框架能力表自洽', () => {
  for (const [id, framework] of Object.entries(FRAMEWORKS)) {
    assert.equal(framework.id, id, `${id} 的 id 字段应该与键一致`)
    assert.ok(framework.architectures.length > 0, `${id} 应该至少支持一个架构`)
    assert.equal(typeof framework.nativeShell, 'boolean', `${id} 的 nativeShell 应该是布尔`)
  }
})
