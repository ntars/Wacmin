/**
 * 阶段 1 验收测试：保留 Unix 权限的 zip 写入器。
 *
 * 跑法：cd win2mac && npm test
 *
 * 这套测试的核心断言只有一条：**解压后 `Contents/MacOS/` 下的文件
 * 必须可执行**。这一条不成立，整个 Win2Mac 就毫无意义 —— 产出的
 * `.app` 在 macOS 上双击会报「无法打开」，且不提示是权限问题。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, chmod } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { zipBundle, readZipEntries, ZIP_MODES, resolveMode } from '../src/core/wexezip.mjs'

const execFileAsync = promisify(execFile)

/** 造一个临时的 `.app` 目录，返回其路径。 */
async function makeApp(root, options = {}) {
  const appDir = join(root, options.name ?? 'Demo (Mac).app')
  await mkdir(join(appDir, 'Contents/MacOS'), { recursive: true })
  await mkdir(join(appDir, 'Contents/Resources'), { recursive: true })

  const launcher = join(appDir, 'Contents/MacOS/launcher')
  await writeFile(launcher, '#!/bin/sh\necho ok\n')
  await chmod(launcher, 0o755)

  await writeFile(join(appDir, 'Contents/Info.plist'), '<?xml version="1.0"?>\n')
  await writeFile(join(appDir, 'Contents/Resources/data.txt'), 'payload')
  await chmod(join(appDir, 'Contents/Resources/data.txt'), 0o644)

  return appDir
}

describe('zip 权限位', () => {
  test('主可执行文件在 zip 里是 0755', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-zip-'))
    try {
      const appDir = await makeApp(root)
      const zipPath = join(root, 'out.zip')
      await zipBundle({ source: appDir, outputFile: zipPath, executableName: 'launcher' })

      const entries = await readZipEntries(zipPath)
      const launcher = entries.find((entry) => entry.name.endsWith('/Contents/MacOS/launcher'))
      assert.ok(launcher !== undefined, 'zip 里应包含 launcher')
      assert.equal(launcher.mode & 0o777, 0o755)
      assert.notEqual(launcher.mode & 0o111, 0, '必须有执行位')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('普通文件保持 0644', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-zip-'))
    try {
      const appDir = await makeApp(root)
      const zipPath = join(root, 'out.zip')
      await zipBundle({ source: appDir, outputFile: zipPath })

      const entries = await readZipEntries(zipPath)
      const data = entries.find((entry) => entry.name.endsWith('data.txt'))
      assert.ok(data !== undefined)
      assert.equal(data.mode & 0o777, 0o644)
      assert.equal(data.mode & 0o111, 0, '普通文件不该有执行位')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('目录带 S_IFDIR 且以 / 结尾', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-zip-'))
    try {
      const appDir = await makeApp(root)
      const zipPath = join(root, 'out.zip')
      await zipBundle({ source: appDir, outputFile: zipPath })

      const entries = await readZipEntries(zipPath)
      const dirs = entries.filter((entry) => entry.isDir)
      assert.ok(dirs.length > 0, '应有目录条目')
      for (const dir of dirs) {
        assert.ok(dir.name.endsWith('/'), `目录条目必须以 / 结尾：${dir.name}`)
        assert.notEqual(dir.mode & 0o111, 0, `目录必须可进入：${dir.name}`)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('符号链接被正确标记', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-zip-'))
    try {
      const appDir = await makeApp(root)
      await symlink('launcher', join(appDir, 'Contents/MacOS/alias'))
      const zipPath = join(root, 'out.zip')
      const result = await zipBundle({ source: appDir, outputFile: zipPath })

      assert.equal(result.symlinks, 1)
      const entries = await readZipEntries(zipPath)
      const alias = entries.find((entry) => entry.name.endsWith('/alias'))
      assert.ok(alias !== undefined)
      assert.equal(alias.isSymlink, true, '应标记为符号链接而不是普通文件')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Windows 上没有 POSIX 位时按角色兜底', async () => {
    /*
     * 模拟 Windows 场景：源文件权限是 0o666（Windows 上 stat 的典型值）。
     * 主可执行文件仍必须是 0755 —— 这是本模块存在的理由。
     */
    const root = await mkdtemp(join(tmpdir(), 'w2m-zip-'))
    try {
      const appDir = await makeApp(root)
      await chmod(join(appDir, 'Contents/MacOS/launcher'), 0o666)
      const zipPath = join(root, 'out.zip')
      await zipBundle({ source: appDir, outputFile: zipPath, executableName: 'launcher' })

      const entries = await readZipEntries(zipPath)
      const launcher = entries.find((entry) => entry.name.endsWith('/Contents/MacOS/launcher'))
      assert.equal(launcher.mode & 0o777, 0o755, 'Windows 上也要给出 0755')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('自定义 executableName 生效', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-zip-'))
    try {
      const appDir = await makeApp(root)
      const custom = join(appDir, 'Contents/MacOS/MyApp')
      await writeFile(custom, '#!/bin/sh\n')
      await chmod(custom, 0o600)   // 故意给错权限，验证会被纠正
      const zipPath = join(root, 'out.zip')
      await zipBundle({ source: appDir, outputFile: zipPath, executableName: 'MyApp' })

      const entries = await readZipEntries(zipPath)
      const entry = entries.find((item) => item.name.endsWith('/Contents/MacOS/MyApp'))
      assert.equal(entry.mode & 0o777, 0o755)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('zip 结构', () => {
  test('顶层只有一个 .app 目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-zip-'))
    try {
      const appDir = await makeApp(root, { name: 'X (Mac).app' })
      const zipPath = join(root, 'out.zip')
      await zipBundle({ source: appDir, outputFile: zipPath, rootName: 'X (Mac).app' })

      const entries = await readZipEntries(zipPath)
      const tops = new Set(entries.map((entry) => entry.name.split('/')[0]))
      assert.deepEqual([...tops], ['X (Mac).app'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('中文与特殊字符路径正确编码', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-zip-'))
    try {
      const appDir = await makeApp(root, { name: '演示 & App (Mac).app' })
      const zipPath = join(root, 'out.zip')
      await zipBundle({ source: appDir, outputFile: zipPath, rootName: '演示 & App (Mac).app' })

      const entries = await readZipEntries(zipPath)
      assert.ok(entries.some((entry) => entry.name.startsWith('演示 & App (Mac).app/')))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('空目录报错而不是产出空 zip', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-zip-'))
    try {
      const empty = join(root, 'Empty.app')
      await mkdir(empty, { recursive: true })
      await assert.rejects(
        () => zipBundle({ source: empty, outputFile: join(root, 'out.zip') }),
        /源目录为空/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('真实解压往返', () => {
  /*
   * 这套测试只在有 `unzip` 的平台上跑。它是唯一能证明「权限位真的
   * 被解压方识别」的证据 —— 只读中央目录不算，因为那可能是自己
   * 写自己读，两头都错却互相印证。
   */
  const hasUnzip = process.platform !== 'win32'

  test('unzip 后 launcher 仍可执行', { skip: !hasUnzip }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-unzip-'))
    try {
      const appDir = await makeApp(root, { name: 'T (Mac).app' })
      const zipPath = join(root, 'out.zip')
      await zipBundle({
        source: appDir, outputFile: zipPath,
        rootName: 'T (Mac).app', executableName: 'launcher',
      })

      const outDir = join(root, 'x')
      await mkdir(outDir)
      await execFileAsync('unzip', ['-q', zipPath, '-d', outDir])

      const { stdout } = await execFileAsync('ls', ['-l', join(outDir, 'T (Mac).app/Contents/MacOS/launcher')])
      assert.match(stdout, /^-rwx/u, `解压后应有执行权限，实际：${stdout}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('unzip 后符号链接仍是链接', { skip: !hasUnzip }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-unzip-'))
    try {
      const appDir = await makeApp(root, { name: 'T (Mac).app' })
      await symlink('launcher', join(appDir, 'Contents/MacOS/alias'))
      const zipPath = join(root, 'out.zip')
      await zipBundle({ source: appDir, outputFile: zipPath, rootName: 'T (Mac).app' })

      const outDir = join(root, 'x')
      await mkdir(outDir)
      await execFileAsync('unzip', ['-q', zipPath, '-d', outDir])

      const { stdout } = await execFileAsync('ls', ['-l', join(outDir, 'T (Mac).app/Contents/MacOS/alias')])
      assert.match(stdout, /^l/u, `应是符号链接，实际：${stdout}`)
      assert.match(stdout, /alias -> launcher/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('unzip 后目录可进入', { skip: !hasUnzip }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-unzip-'))
    try {
      const appDir = await makeApp(root, { name: 'T (Mac).app' })
      const zipPath = join(root, 'out.zip')
      await zipBundle({ source: appDir, outputFile: zipPath, rootName: 'T (Mac).app' })

      const outDir = join(root, 'x')
      await mkdir(outDir)
      // 若目录权限不对，unzip 会报 "exists but is not directory"
      const result = await execFileAsync('unzip', ['-o', '-q', zipPath, '-d', outDir])
      assert.equal(result.stderr.includes('is not directory'), false,
        `解压出现目录错误：${result.stderr}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('Windows 平台下的权限推断', () => {
  /*
   * 这一组测试存在的原因，是 CI 上真出过一次事故。
   *
   * 旧实现写的是「取到 0 才兜底」：
   *     const perm = (info.mode & 0o777) || DEFAULT_DIR_MODE
   * 但 Windows 的 `stat().mode` 恒非零 —— 目录返回 0o40666，文件返回
   * 0o100666。于是兜底从未触发，产物里的目录权限写成 0o40666，
   * **解压后进不去**，普通文件写成 0666 而不是 0644。
   *
   * 更麻烦的是这个缺陷在任何 Mac/Linux 上都复现不了，只有 Windows
   * runner 才会红。所以这里通过注入 platform 参数，把那条分支搬到
   * 本机来测 —— 不必依赖 CI 环境。
   */

  /** 造一个模拟 Windows 的 Stats：mode 非零但不含执行位。 */
  function winStats(kind) {
    // Windows 实测值：目录 0o40666，文件 0o100666
    return { mode: kind === 'dir' ? 0o40666 : 0o100666 }
  }

  test('目录在 Windows 上给 0755，可进入', () => {
    const mode = resolveMode(winStats('dir'), 'Contents/', 'dir', 'launcher', 'win32')
    assert.equal(mode & 0o777, 0o755)
    assert.notEqual(mode & 0o111, 0, '目录必须可进入，否则解压后 cd 不进去')
    assert.equal(mode & ZIP_MODES.S_IFDIR, ZIP_MODES.S_IFDIR, '必须带 S_IFDIR')
  })

  test('普通文件在 Windows 上给 0644，不是 0666', () => {
    const mode = resolveMode(winStats('file'), 'Contents/Resources/data.txt', 'file', 'launcher', 'win32')
    assert.equal(mode & 0o777, 0o644, `实际 0o${(mode & 0o777).toString(8)}，期望 0o644`)
    assert.equal(mode & ZIP_MODES.S_IFREG, ZIP_MODES.S_IFREG)
  })

  test('MacOS/ 下的文件在 Windows 上仍是 0755', () => {
    const mode = resolveMode(winStats('file'), 'Contents/MacOS/launcher', 'file', 'launcher', 'win32')
    assert.equal(mode & 0o777, 0o755)
  })

  test('符号链接在 Windows 上仍是 0777', () => {
    const mode = resolveMode(winStats('file'), 'Contents/Resources/alias', 'symlink', 'launcher', 'win32')
    assert.equal(mode & 0o777, 0o777)
    assert.equal(mode & ZIP_MODES.S_IFLNK, ZIP_MODES.S_IFLNK)
  })

  test('非 Windows 上目录缺执行位时会被补上', () => {
    // 源目录权限 0644（没有执行位）不能原样写进 zip
    const mode = resolveMode({ mode: 0o40644 }, 'Contents/', 'dir', 'launcher', 'darwin')
    assert.notEqual(mode & 0o111, 0, '目录无论源权限如何都必须可进入')
  })

  test('非 Windows 上普通文件的组/其他写权限被收掉', () => {
    const mode = resolveMode({ mode: 0o100666 }, 'Contents/Resources/x.txt', 'file', 'launcher', 'darwin')
    assert.equal(mode & 0o777, 0o644)
  })

  test('两种平台对同一份 Windows 源产出一致的目录权限', () => {
    const a = resolveMode(winStats('dir'), 'Contents/', 'dir', 'launcher', 'win32')
    const b = resolveMode(winStats('dir'), 'Contents/', 'dir', 'launcher', 'darwin')
    assert.equal(a & 0o777, b & 0o777, '目录权限不应随宿主平台漂移')
  })
})

describe('模式常量', () => {
  test('导出值与 POSIX 定义一致', () => {
    assert.equal(ZIP_MODES.S_IFDIR, 0o040000)
    assert.equal(ZIP_MODES.S_IFLNK, 0o120000)
    assert.equal(ZIP_MODES.EXECUTABLE_MODE, 0o755)
    assert.equal(ZIP_MODES.CREATE_SYSTEM_UNIX, 3)
  })
})