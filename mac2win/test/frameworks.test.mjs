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
import { detectFramework, inferForFramework, checkFrameworkTarget, FRAMEWORKS } from '../src/core/frameworks.mjs'

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