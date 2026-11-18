/**
 * 目录拷贝的测试。
 *
 * 重点覆盖两个曾经踩过的坑：
 *
 * 1. **软链循环**。pnpm 的 node_modules 里有循环软链，朴素的递归
 *    拷贝会无限展开直到卡死。实测空谷 316 个软链跑了 6 分钟仍在膨胀。
 * 2. **包内部 node_modules 被一起拷**。83 个包里 80 个带内部
 *    node_modules，全拷会让 3777 个文件膨胀到 5 万，构建从一分钟
 *    变成两小时。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyTree, isJunk, measureTree, walkFiles, windowsPathProblem } from '../src/util/fsx.mjs'

/** 建一个临时目录。 */
async function temp() {
  return await mkdtemp(join(tmpdir(), 'mac2win-copy-'))
}

test('拷贝基本文件与子目录', async () => {
  const root = await temp()
  try {
    const src = join(root, 'src')
    await mkdir(join(src, 'a', 'b'), { recursive: true })
    await writeFile(join(src, 'x.txt'), 'x')
    await writeFile(join(src, 'a', 'y.txt'), 'y')
    await writeFile(join(src, 'a', 'b', 'z.txt'), 'z')

    const dst = join(root, 'dst')
    const result = await copyTree(src, dst)
    assert.equal(result.files, 3)
    assert.equal(await readFile(join(dst, 'a', 'b', 'z.txt'), 'utf8'), 'z')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('剔除苹果垃圾文件', async () => {
  const root = await temp()
  try {
    const src = join(root, 'src')
    await mkdir(src, { recursive: true })
    await writeFile(join(src, 'keep.txt'), 'k')
    await writeFile(join(src, '.DS_Store'), 'junk')
    await writeFile(join(src, '._resource'), 'junk')
    await mkdir(join(src, '__MACOSX'))
    await writeFile(join(src, '__MACOSX', 'x'), 'junk')

    const dst = join(root, 'dst')
    await copyTree(src, dst)
    const files = await walkFiles(dst, { skipJunk: false })
    assert.deepEqual(files, ['keep.txt'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('解开软链而不是复制软链本身', async () => {
  const root = await temp()
  try {
    const src = join(root, 'src')
    await mkdir(join(src, 'real'), { recursive: true })
    await writeFile(join(src, 'real', 'f.txt'), 'content')
    await symlink(join(src, 'real'), join(src, 'link'))

    const dst = join(root, 'dst')
    await copyTree(src, dst)

    /*
     * 断言的是「内容在位、且没有软链」，不是「路径必须是 real/」。
     *
     * 因为 inode 去重会让**先遍历到的那个名字**保留下来——遍历顺序
     * 由文件系统决定，`link` 可能排在 `real` 前面。两种结果都正确：
     * 软链被解开成了真实目录，内容完整，Windows 上能直接用。
     *
     * 真正不能接受的是「拷了一条软链过去」——那在 Windows 上就是断链。
     */
    const files = await walkFiles(dst, { skipJunk: false })
    assert.ok(
      files.some((file) => file.endsWith('f.txt')),
      `应该有一个 f.txt，实际：${files.join(', ')}`,
    )

    const { lstat } = await import('node:fs/promises')
    for (const file of files) {
      const info = await lstat(join(dst, file))
      assert.equal(info.isSymbolicLink(), false, `${file} 不该是软链`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('循环软链不会死循环', async () => {
  const root = await temp()
  try {
    const src = join(root, 'src')
    await mkdir(join(src, 'pkg'), { recursive: true })
    await writeFile(join(src, 'pkg', 'index.js'), 'x')
    // pkg/self -> pkg，形成自引用。
    await symlink(join(src, 'pkg'), join(src, 'pkg', 'self'))

    const dst = join(root, 'dst')
    // 关键：必须能在有限时间内返回。若实现有缺陷，这里会挂死。
    const result = await copyTree(src, dst)
    assert.ok(result.files >= 1, '至少拷到一个文件')
    assert.ok(result.files < 100, `不该无限展开，实际拷了 ${String(result.files)} 个`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('skipDirs 跳过包内部 node_modules', async () => {
  const root = await temp()
  try {
    const src = join(root, 'pkg')
    await mkdir(join(src, 'node_modules', 'dep'), { recursive: true })
    await mkdir(join(src, 'lib'), { recursive: true })
    await writeFile(join(src, 'package.json'), '{}')
    await writeFile(join(src, 'lib', 'index.js'), 'x')
    await writeFile(join(src, 'node_modules', 'dep', 'index.js'), 'should not copy')

    const dst = join(root, 'dst')
    const result = await copyTree(src, dst, {
      skipDirs: (absolute, name) => name === 'node_modules',
    })

    assert.equal(result.files, 2, '只该拷 package.json 与 lib/index.js')
    const files = await walkFiles(dst, { skipJunk: false })
    assert.ok(!files.some((f) => f.includes('node_modules')), `不该有 node_modules，实际：${files.join(', ')}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('isJunk 只认三种精确叶名', () => {
  assert.equal(isJunk('.DS_Store'), true)
  assert.equal(isJunk('._anything'), true)
  assert.equal(isJunk('__MACOSX'), true)
  // 这几个不该被误伤。
  assert.equal(isJunk('notes.txt'), false)
  assert.equal(isJunk('app.tmp'), false)
  assert.equal(isJunk('macosx-notes.md'), false)
})

test('measureTree 按 inode 去重', async () => {
  const root = await temp()
  try {
    const dir = join(root, 'd')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'a.txt'), '12345')
    await symlink(join(dir, 'a.txt'), join(dir, 'b.txt'))

    const measured = await measureTree(dir)
    // 软链与目标是同一个 inode，只该算一次。
    assert.equal(measured.files, 1, '同一物理文件不该重复计数')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('软链指向祖先目录时不死循环', async () => {
  /*
   * 这一组来自一个真实缺陷：`proj/sub/back-to-root -> proj` 让 walkFiles
   * 产出 32 个文件、最深路径重复 15 层 `back-to-root`。
   *
   * 而且它只是因为撞上 macOS 的路径长度上限（ENAMETOOLONG）才停下的，
   * 纯属侥幸 —— 换个短路径就能钻得更深。后果不只是慢：这些重复展开的
   * 「文件」会被当成真实依赖塞进产物，让安装包凭空膨胀。
   */
  const root = await mkdtemp(join(tmpdir(), 'm2w-loop-'))
  try {
    const proj = join(root, 'proj')
    await mkdir(join(proj, 'sub'), { recursive: true })
    await writeFile(join(proj, 'index.js'), 'hi')
    await writeFile(join(proj, 'package.json'), '{}')
    // 软链指回项目根 —— 形成环
    await symlink(proj, join(proj, 'sub', 'back-to-root'))

    const files = await walkFiles(proj)
    assert.deepEqual(files.sort(), ['index.js', 'package.json'],
      `环必须被切断，实际：${files.join(', ')}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('多个软链指向同一目录时都要收录', async () => {
  /*
   * 这是上一条的对照：不能为了防环而把「重复」也一起干掉。
   *
   * pnpm 的 node_modules 就是这种结构：`node_modules/a` 与 `node_modules/b`
   * 都软链到 `.pnpm/pkg` 同一个真实目录。用「全局已访问集合」去重会把
   * a、b 都跳过，产物里就少了两个依赖入口 —— 真实的漏文件。
   *
   * 正确判断是「环」不是「重复」：目标是当前路径的祖先才是环。
   */
  const root = await mkdtemp(join(tmpdir(), 'm2w-alias-'))
  try {
    const proj = join(root, 'proj')
    const pkg = join(proj, 'node_modules', '.pnpm', 'pkg')
    await mkdir(pkg, { recursive: true })
    await writeFile(join(proj, 'index.js'), 'hi')
    await writeFile(join(pkg, 'index.js'), 'pkg')

    await symlink(pkg, join(proj, 'node_modules', 'a'))
    await symlink(pkg, join(proj, 'node_modules', 'b'))

    const files = await walkFiles(proj)
    assert.ok(files.includes('node_modules/a/index.js'), '软链 a 的内容应被收录')
    assert.ok(files.includes('node_modules/b/index.js'), '软链 b 的内容应被收录')
    assert.ok(files.includes('node_modules/.pnpm/pkg/index.js'), '真实路径也应被收录')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('软链指向上级但不在祖先链上时照常遍历', async () => {
  /*
   * 兄弟目录互链是合法结构，不该被误判为环。
   *
   *   proj/a/  -> 正常目录
   *   proj/b/link-to-a -> proj/a
   *
   * a 不是 b 的祖先，所以遍历 b 时进 a 是正确的。
   */
  const root = await mkdtemp(join(tmpdir(), 'm2w-sibling-'))
  try {
    const proj = join(root, 'proj')
    await mkdir(join(proj, 'a'), { recursive: true })
    await mkdir(join(proj, 'b'), { recursive: true })
    await writeFile(join(proj, 'a', 'x.js'), 'x')
    await symlink(join(proj, 'a'), join(proj, 'b', 'link-to-a'))

    const files = await walkFiles(proj)
    assert.ok(files.includes('a/x.js'))
    assert.ok(files.includes('b/link-to-a/x.js'), '兄弟目录软链应可遍历')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('断链被跳过不报错', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm2w-broken-'))
  try {
    const proj = join(root, 'proj')
    await mkdir(proj, { recursive: true })
    await writeFile(join(proj, 'index.js'), 'hi')
    await symlink(join(proj, 'does-not-exist'), join(proj, 'broken'))

    const files = await walkFiles(proj)
    assert.deepEqual(files, ['index.js'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows 非法字符被识别', () => {
  /*
   * macOS 允许 `:` `?` `*` `<` `>` `|` `"` 出现在文件名里，Windows 全不允许。
   * 这是「在 Mac 上打 Windows 包」最容易踩的坑：打包一路绿灯，用户拿到
   * exe 后解压失败或文件名被静默改写，而几乎不可能联想到是文件名问题。
   */
  for (const name of [
    'file:1.txt', 'a?b.txt', 'a*b.txt', 'a<b.txt', 'a>b.txt',
    'a|b.txt', 'a"b.txt', 'a\\b.txt',
  ]) {
    assert.notEqual(windowsPathProblem(name), null, `${name} 应被判为非法`)
  }
})

test('Windows 保留设备名被识别', () => {
  /*
   * CON / PRN / AUX / NUL / COM1-9 / LPT1-9 无论扩展名是什么都不能用作
   * 文件名 —— `con.txt` 在 Windows 上同样打不开。
   */
  for (const name of ['con', 'CON', 'con.txt', 'aux', 'nul.dat', 'com1.log', 'LPT9.txt', 'prn']) {
    assert.notEqual(windowsPathProblem(name), null, `${name} 应被判为保留名`)
  }
})

test('以点或空格结尾被识别', () => {
  // Windows 会静默丢弃结尾的点与空格，导致文件名对不上
  assert.notEqual(windowsPathProblem('trailing.'), null)
  assert.notEqual(windowsPathProblem('trailing '), null)
  assert.equal(windowsPathProblem('normal.txt'), null)
})

test('合法的 Windows 文件名不被误报', () => {
  for (const name of [
    'index.js', 'package.json', 'a b.txt', '中文文件.txt', 'a-b_c.txt',
    '.gitignore', 'x.tar.gz', 'CONSOLE.txt', 'console.js', 'com10.txt',
  ]) {
    assert.equal(windowsPathProblem(name), null, `${name} 不该被误报`)
  }
})

test('嵌套路径逐段检查', () => {
  // 只有中间某一段非法时也要抓到
  assert.notEqual(windowsPathProblem('a/bad:dir/file.txt'), null)
  assert.notEqual(windowsPathProblem('ok/con/file.txt'), null)
  assert.equal(windowsPathProblem('a/b/c/file.txt'), null)
})

test('工具自己的构建日志不进载荷', async () => {
  /*
   * `.mac2win-build.log` 是 `mac2win ui` 写在项目根目录的构建日志。
   * 不排除的话它会被打进安装包，用户装完会在程序目录里看到一个
   * 莫名其妙的日志文件，内容还是上一次构建的输出。
   */
  const root = await mkdtemp(join(tmpdir(), 'm2w-own-'))
  try {
    const proj = join(root, 'proj')
    await mkdir(proj, { recursive: true })
    await writeFile(join(proj, 'index.js'), 'hi')
    await writeFile(join(proj, '.mac2win-build.log'), 'log content')

    const files = await walkFiles(proj)
    assert.deepEqual(files, ['index.js'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
