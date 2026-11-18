/**
 * 阶段 3 验收测试：产物校验与端到端构建。
 *
 * 跑法：cd win2mac && npm test
 *
 * 端到端测试是本套的核心 —— 它走完整条链路（装配 → 打包 → 校验），
 * 再解压回磁盘检查权限，模拟用户真实使用路径。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, stat, symlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { assembleBundle } from '../src/core/bundle.mjs'
import { zipBundle } from '../src/core/wexezip.mjs'
import { checkMachO, plistString, verifyBundle, verifyZip, normalizeLinkTarget } from '../src/core/verify.mjs'
import { StageTracker } from '../src/core/report.mjs'
import { runBuild } from '../src/core/builder.mjs'

const execFileAsync = promisify(execFile)
const hasUnzip = process.platform !== 'win32'

/** Mach-O 64 位小端魔数，后面补足最小长度。 */
function machoBytes(size = 32) {
  const buffer = Buffer.alloc(size)
  buffer.writeUInt32BE(0xcffaedfe, 0)   // 小端 64 位
  return buffer
}

/** 造一个最小可用的 `.app`。 */
async function makeApp(root, options = {}) {
  const appDir = join(root, options.name ?? 'Demo (Mac).app')
  const payload = join(root, 'payload')
  await mkdir(payload, { recursive: true })
  await writeFile(join(payload, 'index.js'), 'code')

  const executable = join(root, 'MyApp')
  await writeFile(executable, options.macho === false ? '#!/bin/sh\n' : machoBytes())
  await chmod(executable, 0o755)

  await assembleBundle({
    appDir,
    appName: options.appName ?? 'Demo',
    bundleId: options.bundleId ?? 'com.wexe.mac.demo.app',
    version: options.version ?? '1.0.0',
    executable,
    payload,
    iconPath: options.icon,
  })
  return appDir
}

describe('Mach-O 检测', () => {
  test('识别 Mach-O 64 位小端', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-v-'))
    try {
      const path = join(root, 'bin')
      await writeFile(path, machoBytes())
      const result = await checkMachO(path)
      assert.equal(result.ok, true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('识别 universal binary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-v-'))
    try {
      const path = join(root, 'bin')
      const buffer = Buffer.alloc(32)
      buffer.writeUInt32BE(0xcafebabe, 0)
      await writeFile(path, buffer)
      assert.equal((await checkMachO(path)).ok, true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('PE 文件被识别并给出明确原因', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-v-'))
    try {
      const path = join(root, 'bin')
      await writeFile(path, Buffer.from('MZ\x90\x00', 'latin1'))
      const result = await checkMachO(path)
      assert.equal(result.ok, false)
      assert.match(result.detail, /Windows PE/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('脚本被识别', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-v-'))
    try {
      const path = join(root, 'bin')
      await writeFile(path, '#!/bin/sh\necho hi\n')
      const result = await checkMachO(path)
      assert.equal(result.ok, false)
      assert.match(result.detail, /脚本/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('ELF 被识别', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-v-'))
    try {
      const path = join(root, 'bin')
      const buffer = Buffer.alloc(16)
      buffer.writeUInt32BE(0x7f454c46, 0)
      await writeFile(path, buffer)
      assert.match((await checkMachO(path)).detail, /ELF/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('plist 取值', () => {
  test('取出字符串键', () => {
    const text = '<key>CFBundleExecutable</key>\n\t<string>launcher</string>'
    assert.equal(plistString(text, 'CFBundleExecutable'), 'launcher')
  })

  test('还原实体', () => {
    const text = '<key>CFBundleName</key><string>A&amp;B</string>'
    assert.equal(plistString(text, 'CFBundleName'), 'A&B')
  })

  test('键不存在返回 null', () => {
    assert.equal(plistString('<key>Other</key><string>x</string>', 'Missing'), null)
  })
})

describe('bundle 校验', () => {
  test('合法包全过', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-v-'))
    try {
      const appDir = await makeApp(root)
      const result = await verifyBundle(appDir)
      assert.equal(result.ok, true,
        result.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; '))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('缺 Info.plist 被抓出', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-v-'))
    try {
      const appDir = await makeApp(root)
      await rm(join(appDir, 'Contents/Info.plist'))
      const result = await verifyBundle(appDir)
      assert.equal(result.ok, false)
      assert.ok(result.checks.some((c) => c.name === 'plist.exists' && !c.ok))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('缺可执行文件被抓出', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-v-'))
    try {
      const appDir = await makeApp(root)
      await rm(join(appDir, 'Contents/MacOS/MyApp'))
      const result = await verifyBundle(appDir)
      assert.equal(result.ok, false)
      assert.ok(result.checks.some((c) => c.name === 'bundle.executable' && !c.ok))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('设了 LSUIElement 被抓出', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-v-'))
    try {
      const appDir = await makeApp(root)
      const plistPath = join(appDir, 'Contents/Info.plist')
      const text = await readFile(plistPath, 'utf8')
      await writeFile(plistPath, text.replace('</dict>', '<key>LSUIElement</key><true/></dict>'))
      const result = await verifyBundle(appDir)
      assert.equal(result.ok, false)
      assert.ok(result.checks.some((c) => c.name === 'plist.visible_in_dock' && !c.ok))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('非 Mach-O 主程序只警告不失败', async () => {
    /*
     * 脚本作入口是合法场景（shell 包装器）。这种包在 macOS 上能跑，
     * 所以不该硬失败 —— 但必须警告，让用户知道风险。
     */
    const root = await mkdtemp(join(tmpdir(), 'w2m-v-'))
    try {
      const appDir = await makeApp(root, { macho: false })
      const result = await verifyBundle(appDir)
      assert.equal(result.ok, true)
      assert.ok(result.warnings.some((w) => w.includes('不是 Mach-O')))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('平台边界写进 warnings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-v-'))
    try {
      const appDir = await makeApp(root)
      const result = await verifyBundle(appDir)
      assert.ok(result.warnings.some((w) => w.includes('codesign')))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('zip 校验', () => {
  test('合法 zip 全过', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-v-'))
    try {
      const appDir = await makeApp(root, { name: 'T (Mac).app' })
      const zipPath = join(root, 'out.zip')
      await zipBundle({
        source: appDir, outputFile: zipPath,
        rootName: 'T (Mac).app', executableName: 'MyApp',
      })
      const result = await verifyZip(zipPath, 'T (Mac).app')
      assert.equal(result.ok, true,
        result.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; '))
      assert.ok(result.checks.some((c) => c.name === 'zip.main_executable' && c.ok))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('权限不足的 zip 被抓出', async () => {
    /*
     * 手工造一个「权限位全 0」的 zip，模拟用错写入器的情况。
     * 这是本方向最需要防的回归。
     */
    const root = await mkdtemp(join(tmpdir(), 'w2m-v-'))
    try {
      const appDir = await makeApp(root, { name: 'T (Mac).app' })
      const zipPath = join(root, 'out.zip')
      await zipBundle({
        source: appDir, outputFile: zipPath,
        rootName: 'T (Mac).app', executableName: 'MyApp',
      })

      // 把 zip 里所有 external_attr 清零，模拟不写权限的写入器
      const buffer = await readFile(zipPath)
      let eocd = -1
      for (let i = buffer.length - 22; i >= 0; i -= 1) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
      }
      let cursor = buffer.readUInt32LE(eocd + 16)
      const count = buffer.readUInt16LE(eocd + 10)
      for (let i = 0; i < count; i += 1) {
        buffer.writeUInt32LE(0, cursor + 38)   // external_attr = 0
        const nameLength = buffer.readUInt16LE(cursor + 28)
        const extraLength = buffer.readUInt16LE(cursor + 30)
        const commentLength = buffer.readUInt16LE(cursor + 32)
        cursor += 46 + nameLength + extraLength + commentLength
      }
      const brokenZip = join(root, 'broken.zip')
      await writeFile(brokenZip, buffer)

      const result = await verifyZip(brokenZip, 'T (Mac).app')
      assert.equal(result.ok, false)
      assert.ok(result.checks.some((c) =>
        (c.name === 'zip.executable_modes' || c.name === 'zip.main_executable') && !c.ok))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('多顶层目录被抓出', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-v-'))
    try {
      const one = join(root, 'One.app')
      const two = join(root, 'Two.app')
      for (const dir of [one, two]) {
        await mkdir(join(dir, 'Contents'), { recursive: true })
        await writeFile(join(dir, 'Contents/x'), 'x')
      }
      // 用父目录打包，得到两个顶层
      const zipPath = join(root, 'out.zip')
      await zipBundle({ source: root, outputFile: zipPath, rootName: 'bundle' })
      const result = await verifyZip(zipPath, 'bundle')
      // 顶层只有一个 bundle，但里面不是 .app
      assert.equal(result.checks.some((c) => c.name === 'zip.is_app_root' && !c.ok), true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('端到端构建', () => {
  test('runBuild 产出可校验的 zip', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-e2e-'))
    try {
      const project = join(root, 'proj')
      const dist = join(project, 'dist')
      await mkdir(dist, { recursive: true })
      await writeFile(join(dist, 'index.js'), 'code')
      await writeFile(join(dist, 'MyApp'), machoBytes())
      await chmod(join(dist, 'MyApp'), 0o755)

      const tracker = new StageTracker()
      const result = await runBuild({
        projectRoot: project,
        outDir: join(root, 'out'),
        appName: 'Demo',
        version: '1.2.3',
        executable: 'dist/MyApp',
        payload: 'dist',
        tracker,
      })

      assert.ok(result.artifact.endsWith('.zip'))
      assert.equal((await stat(result.artifact)).isFile(), true)
      assert.match(result.bundleId, /^com\.wexe\.mac\./u)
      assert.ok(result.files > 0)

      const check = await verifyZip(result.artifact,
        result.artifact.split(/[\\/]/).pop().replace(/\.zip$/u, '.app'))
      assert.equal(check.ok, true,
        check.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; '))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('缺可执行文件时报 CONFIG_MISSING', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-e2e-'))
    try {
      const project = join(root, 'proj')
      await mkdir(project, { recursive: true })
      await assert.rejects(
        () => runBuild({
          projectRoot: project,
          outDir: join(root, 'out'),
          appName: 'X',
          tracker: new StageTracker(),
        }),
        /缺少主可执行文件/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('项目目录不存在时报 INPUT_NOT_FOUND', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-e2e-'))
    try {
      await assert.rejects(
        () => runBuild({
          projectRoot: join(root, 'nope'),
          outDir: join(root, 'out'),
          appName: 'X',
          executable: 'x',
          tracker: new StageTracker(),
        }),
        /项目目录不存在/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('阶段状态符合契约', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-e2e-'))
    try {
      const project = join(root, 'proj')
      const dist = join(project, 'dist')
      await mkdir(dist, { recursive: true })
      await writeFile(join(dist, 'MyApp'), machoBytes())
      await chmod(join(dist, 'MyApp'), 0o755)

      const tracker = new StageTracker()
      await runBuild({
        projectRoot: project,
        outDir: join(root, 'out'),
        appName: 'Demo',
        executable: 'dist/MyApp',
        payload: 'dist',
        tracker,
      })

      const stages = tracker.toStages()
      assert.equal(stages.length, 8)
      const byName = Object.fromEntries(stages.map((s) => [s.name, s]))
      assert.equal(byName['预检'].status, 'ok')
      assert.equal(byName['装配应用包'].status, 'ok')
      assert.equal(byName['校验产物'].status, 'ok')
      /*
       * 项目构建与运行时这两个阶段在 Windows 上是空转的，
       * 必须显式标 skipped 并带原因，而不是假装成功。
       */
      assert.equal(byName['项目构建'].status, 'skipped')
      assert.ok(byName['项目构建'].message?.includes('macOS'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keepWork 保留中间目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-e2e-'))
    try {
      const project = join(root, 'proj')
      const dist = join(project, 'dist')
      await mkdir(dist, { recursive: true })
      await writeFile(join(dist, 'MyApp'), machoBytes())
      await chmod(join(dist, 'MyApp'), 0o755)

      const result = await runBuild({
        projectRoot: project,
        outDir: join(root, 'out'),
        appName: 'Demo',
        executable: 'dist/MyApp',
        payload: 'dist',
        keepWork: true,
        tracker: new StageTracker(),
      })
      assert.notEqual(result.appDir, null)
      assert.equal((await stat(result.appDir)).isDirectory(), true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('解压后可执行（真实 unzip）', { skip: !hasUnzip }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-e2e-'))
    try {
      const project = join(root, 'proj')
      const dist = join(project, 'dist')
      await mkdir(dist, { recursive: true })
      await writeFile(join(dist, 'index.js'), 'code')
      await writeFile(join(dist, 'MyApp'), '#!/bin/sh\necho ran\n')
      await chmod(join(dist, 'MyApp'), 0o755)

      const result = await runBuild({
        projectRoot: project,
        outDir: join(root, 'out'),
        appName: 'Demo',
        executable: 'dist/MyApp',
        payload: 'dist',
        tracker: new StageTracker(),
      })

      const unpackDir = join(root, 'unpacked')
      await mkdir(unpackDir)
      await execFileAsync('unzip', ['-q', result.artifact, '-d', unpackDir])

      const { stdout } = await execFileAsync('ls', [
        '-l', join(unpackDir, 'Demo (Mac).app/Contents/MacOS/MyApp')])
      assert.match(stdout, /^-rwx/u, `解压后应可执行，实际：${stdout}`)

      // plist 也要能被 plutil 读懂
      if (process.platform === 'darwin') {
        const lint = await execFileAsync('plutil', [
          '-lint', join(unpackDir, 'Demo (Mac).app/Contents/Info.plist')])
        assert.match(lint.stdout, /OK/u)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('软链不得逃出 bundle', () => {
  /*
   * .app 里的软链是正常结构（Framework 的 Versions/Current 等），但指向
   * bundle 之外的绝对路径就错了：换台机器就断链，而程序可能靠它找资源。
   *
   * 打包时软链会被原样写进 zip，所以这种包在别的机器上解压后得到一堆死链。
   */

  /** 造一个最小可用的 .app，可选地加软链。 */
  async function makeApp(root, links = []) {
    const appDir = join(root, 'Demo (Mac).app')
    await mkdir(join(appDir, 'Contents', 'MacOS'), { recursive: true })
    await mkdir(join(appDir, 'Contents', 'Resources'), { recursive: true })
    await writeFile(join(appDir, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Demo</string>
<key>CFBundleDisplayName</key><string>Demo</string>
<key>CFBundleIdentifier</key><string>com.test.demo</string>
<key>CFBundleExecutable</key><string>Demo</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>`)
    await writeFile(join(appDir, 'Contents', 'MacOS', 'Demo'), 'binary')
    await chmod(join(appDir, 'Contents', 'MacOS', 'Demo'), 0o755)
    await writeFile(join(appDir, 'Contents', 'PkgInfo'), 'APPL????')

    for (const link of links) {
      await mkdir(join(appDir, link.dir), { recursive: true })
      await symlink(link.target, join(appDir, link.dir, link.name))
    }
    return appDir
  }

  test('指向 bundle 外的绝对路径被判失败', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-sym-'))
    try {
      const appDir = await makeApp(root, [
        { dir: 'Contents/Resources', name: 'escape', target: '/etc' },
      ])
      const result = await verifyBundle(appDir)
      const check = result.checks.find((c) => c.name === 'bundle.symlink_contained')
      assert.ok(check !== undefined, '应有 symlink_contained 检查项')
      assert.equal(check.ok, false)
      assert.match(check.detail, /escape/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('bundle 内相对软链放行', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-sym-ok-'))
    try {
      const appDir = await makeApp(root, [
        { dir: 'Contents/Resources', name: 'inside', target: '../MacOS/Demo' },
      ])
      const result = await verifyBundle(appDir)
      const check = result.checks.find((c) => c.name === 'bundle.symlink_contained')
      assert.equal(check.ok, true, check.detail)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('用 .. 跑出 bundle 的相对软链被判失败', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-sym-up-'))
    try {
      const appDir = await makeApp(root, [
        { dir: 'Contents/Resources', name: 'up', target: '../../../../etc' },
      ])
      const result = await verifyBundle(appDir)
      const check = result.checks.find((c) => c.name === 'bundle.symlink_contained')
      assert.equal(check.ok, false)
      assert.match(check.detail, /跑出 bundle/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('系统库软链放行', async () => {
    /*
     * `/usr/lib/libSystem.B.dylib` 这类是系统提供的，指向它不算逃逸 ——
     * 很多 .app 都这么引用系统库。
     */
    const root = await mkdtemp(join(tmpdir(), 'w2m-sym-sys-'))
    try {
      const appDir = await makeApp(root, [
        { dir: 'Contents/Resources', name: 'sys', target: '/usr/lib/libSystem.B.dylib' },
      ])
      const result = await verifyBundle(appDir)
      const check = result.checks.find((c) => c.name === 'bundle.symlink_contained')
      assert.equal(check.ok, true, check.detail)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /*
   * 下面三条针对的是只在 Windows 上才会出现的路径形态。
   *
   * CI 上真红过一次：`/usr/lib/libSystem.B.dylib` 这样的合法系统库引用，
   * 在 Windows 上被 `symlink()` 解释成 `D:\usr\lib\libSystem.B.dylib`，
   * `readlink` 原样返回，于是 `startsWith('/')` 判不出来，绝对路径走了
   * 相对路径分支，解开后「跑出 bundle」——误报。
   */
  test('归一化：Windows 盘符路径还原为 POSIX 绝对路径', () => {
    assert.equal(normalizeLinkTarget('D:\\usr\\lib\\libSystem.B.dylib'),
      '/usr/lib/libSystem.B.dylib')
    assert.equal(normalizeLinkTarget('C:/System/Library/x'), '/System/Library/x')
  })

  test('归一化：无盘符的 Windows 绝对路径也能还原', () => {
    // 某些环境不写盘符，直接给 `\usr\lib\x`
    assert.equal(normalizeLinkTarget('\\usr\\lib\\x'), '/usr/lib/x')
  })

  test('归一化不改变相对路径语义', () => {
    // `..` 必须原样保留，否则逃逸判定会失效
    assert.equal(normalizeLinkTarget('../../etc'), '../../etc')
    assert.equal(normalizeLinkTarget('..\\..\\etc'), '../../etc')
    assert.equal(normalizeLinkTarget('../MacOS/Demo'), '../MacOS/Demo')
  })

  test('Framework 的 Versions/Current 结构放行', async () => {
    /*
     * 标准 Framework 布局靠三条软链组织：
     *   X.framework/X           -> Versions/Current/X
     *   X.framework/Resources   -> Versions/Current/Resources
     *   X.framework/Versions/Current -> A
     * 这些都是 bundle 内部的相对链，必须放行。
     */
    const root = await mkdtemp(join(tmpdir(), 'w2m-sym-fw-'))
    try {
      const appDir = await makeApp(root)
      const fw = join(appDir, 'Contents', 'Frameworks', 'X.framework')
      await mkdir(join(fw, 'Versions', 'A'), { recursive: true })
      await writeFile(join(fw, 'Versions', 'A', 'X'), 'binary')
      await symlink('A', join(fw, 'Versions', 'Current'))
      await symlink('Versions/Current/X', join(fw, 'X'))

      const result = await verifyBundle(appDir)
      const check = result.checks.find((c) => c.name === 'bundle.symlink_contained')
      assert.equal(check.ok, true, check.detail)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('输出目录不得被当作载荷打包', () => {
  /*
   * 这是一条真实踩到的坑，不是假想场景。
   *
   * win2mac 的默认 `--out` 是 `<项目>/dist-win2mac`，而默认载荷是
   * 整个项目 —— 两者一叠加，第二次构建就会把第一次的产物再打一遍：
   *
   *   proj (Mac).app/Contents/Resources/app/dist-win2mac/proj (Mac).app/...
   *
   * 产物每构建一次翻一倍。而且内层 .app 在复制中丢了可执行权限，
   * verify 报 `zip.executable_modes`「权限不足」——错误信息把人引向
   * 权限，真正的原因却是自己打自己。这里锁死「排除输出目录」这个契约。
   */
  test('输出目录在项目内时，构建两次产物大小不翻倍', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-nest-'))
    try {
      const project = join(root, 'proj')
      await mkdir(project, { recursive: true })
      await writeFile(join(project, 'app.js'), 'code')
      await writeFile(join(project, 'MyApp'), machoBytes())
      await chmod(join(project, 'MyApp'), 0o755)

      const build = () => runBuild({
        projectRoot: project,
        outDir: join(project, 'dist-win2mac'),   // 就在项目里面
        appName: 'Nest',
        executable: 'MyApp',
        tracker: new StageTracker(),
      })

      const first = await build()
      const firstBytes = first.bytes
      const second = await build()

      /*
       * 第二次的产物里不该出现第一次的产物目录。
       *
       * 断言用「大小不显著增长」而不是精确相等 —— zip 里有时间戳之类
       * 的抖动，但嵌套会让大小成倍上涨，量级差异足以判定。
       */
      assert.ok(second.bytes < firstBytes * 1.5,
        `第二次构建产物异常膨胀：${String(firstBytes)} → ${String(second.bytes)} 字节`)

      /*
       * 只看条目名，不能整段匹配 unzip 输出 —— 首行 `Archive:` 里就带着
       * 产物自己的路径（必然含 dist-win2mac），那样断言会假失败。
       */
      const listing = await execFileAsync('unzip', ['-Z1', second.artifact])
      assert.ok(!listing.stdout.includes('dist-win2mac'),
        '产物里出现了 dist-win2mac，说明输出目录被当成了载荷')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('输出目录在项目外时不受影响', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-nest-'))
    try {
      const project = join(root, 'proj')
      await mkdir(project, { recursive: true })
      await writeFile(join(project, 'app.js'), 'code')
      await writeFile(join(project, 'MyApp'), machoBytes())
      await chmod(join(project, 'MyApp'), 0o755)

      const result = await runBuild({
        projectRoot: project,
        outDir: join(root, 'out'),   // 项目之外，最干净的用法
        appName: 'Out',
        executable: 'MyApp',
        tracker: new StageTracker(),
      })
      assert.equal(result.files > 0, true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
