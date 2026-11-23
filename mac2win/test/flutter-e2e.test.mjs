/**
 * Flutter 打包闭环的端到端测试。
 *
 * 这里不用 mock 产物：Flutter 路径的核心风险正是「真实 release 目录里
 * 到底哪些文件被复制进 NSIS / zip、主 exe 架构有没有被验到」。用 wine
 * 自带的真实 PE 充当 release 主程序，能把这个闭环完整跑一遍。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function run(args, options) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, options, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : (typeof error.code === 'number' ? error.code : 1), stdout, stderr })
    })
  })
}
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mac2win.mjs')
const REAL_PE_CANDIDATES = [
  join(homedir(), 'Library/Application Support/wexe/runtime/wine/lib/wine/i386-windows/clock.exe'),
  join(homedir(), 'Library/Application Support/wexe/runtime/wine/lib/wine/i386-windows/notepad.exe'),
]

async function firstPe() {
  for (const candidate of REAL_PE_CANDIDATES) {
    try {
      await readFile(candidate)
      return candidate
    } catch {
      // 换下一个候选。
    }
  }
  return null
}

async function makeFlutterProject(root, pe) {
  const project = join(root, 'flutter-app')
  const release = join(project, 'build/windows/x64/runner/Release')
  await mkdir(join(release, 'data/flutter_assets'), { recursive: true })
  await mkdir(join(project, 'dist'), { recursive: true })
  await writeFile(join(project, 'pubspec.yaml'), 'name: flutter_demo\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n')
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'flutter-demo', version: '1.0.0' }))
  await writeFile(join(project, 'dist/index.html'), '<!doctype html><title>demo</title>')
  await copyFile(pe, join(release, 'demo.exe'))
  await writeFile(join(release, 'data/flutter_assets/AssetManifest.json'), '{}')
  return project
}

test('Flutter 发布目录可构建 NSIS 与 zip，两种产物都能独立校验', { timeout: 60_000 }, async () => {
  const pe = await firstPe()
  assert.ok(pe !== null, '需要 wine 自带真实 PE 作 Flutter 主程序')

  const root = await mkdtemp(join(tmpdir(), 'm2w-flutter-e2e-'))
  try {
    const project = await makeFlutterProject(root, pe)
    const out = join(root, 'out')
    const build = await run([
      CLI, 'build', project, '--out', out, '--target', 'x86', '--also-zip',
    ], { maxBuffer: 16 * 1024 * 1024 })
    assert.equal(build.code, 0, `构建应成功：${build.stderr.slice(-2000)}`)
    assert.match(build.stdout, /Flutter 产物已就位/)
    assert.match(build.stdout, /载荷内 Flutter 主程序架构：flutter\/demo\.exe：PE32 \/ i386/)

    for (const name of ['flutter-demo-1.0.0-x86-setup.exe', 'flutter-demo-1.0.0-x86-setup.zip']) {
      const verify = await run([CLI, 'verify', join(out, name)], {
        maxBuffer: 16 * 1024 * 1024,
      })
      assert.equal(verify.code, 0, `${name} 校验应通过：${verify.stderr.slice(-2000)}`)
      assert.match(verify.stdout, /必需文件 Flutter 主程序：在/)
      assert.match(verify.stdout, /载荷内 Flutter 主程序架构：flutter\/demo\.exe/)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
