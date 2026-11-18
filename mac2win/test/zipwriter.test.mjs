/**
 * zip 写入器的测试。
 *
 * 用**自己写的解包器**读回来验证——这不是自证循环：解包器已经被
 * 系统 `unzip` 交叉验证过，两者是独立的实现。真正的自证循环是
 * 「写和读用同一份错误假设」，这里写与读的代码路径完全不同。
 *
 * 写入器的设计取舍（Unix 权限位为什么必须写进外部属性）见仓库根
 * README.md 第 4.3 节亮点十六。
 *
 * 另外还验一件事：压缩率。曾经把 `.exe` 当作「已压缩」直接存储，
 * 结果 73 MB 的包压完还是 73 MB——这个测试防它回归。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, zipDirectory } from '../src/core/zipwriter.mjs'
import { unzipFile } from '../src/core/zip.mjs'

/** 建临时目录。 */
async function temp() {
  return await mkdtemp(join(tmpdir(), 'mac2win-zipw-'))
}

test('CRC-32 与已知值一致', () => {
  // "123456789" 的 CRC-32 是 0xCBF43926，这是 CRC 的标准测试向量。
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
  assert.equal(crc32(Buffer.from('')), 0)
})

test('打包再解包，内容一致', async () => {
  const root = await temp()
  try {
    const src = join(root, 'src')
    await mkdir(join(src, 'sub'), { recursive: true })
    await writeFile(join(src, 'a.txt'), '你好世界')
    await writeFile(join(src, 'sub', 'b.txt'), 'nested')

    const zipPath = join(root, 'out.zip')
    const result = await zipDirectory({ source: src, outputFile: zipPath, rootName: 'myapp' })
    assert.equal(result.files, 2)

    const extracted = join(root, 'x')
    const unzipped = await unzipFile(zipPath, extracted)
    assert.equal(unzipped.files, 2)

    // 顶层应该是 rootName，而不是散文件。
    assert.equal(await readFile(join(extracted, 'myapp', 'a.txt'), 'utf8'), '你好世界')
    assert.equal(await readFile(join(extracted, 'myapp', 'sub', 'b.txt'), 'utf8'), 'nested')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('可压缩内容确实被压缩', async () => {
  const root = await temp()
  try {
    const src = join(root, 'src')
    await mkdir(src, { recursive: true })
    // 高度重复的内容，deflate 应该压得很小。
    await writeFile(join(src, 'big.txt'), 'abcdefgh'.repeat(50_000))

    const zipPath = join(root, 'out.zip')
    const result = await zipDirectory({ source: src, outputFile: zipPath, rootName: 'app' })

    assert.equal(result.bytes, 400_000, '原始大小')
    assert.ok(
      result.compressedBytes < 20_000,
      `重复文本应该压到 20KB 以内，实际 ${String(result.compressedBytes)}`,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('.exe 会被尝试压缩（曾误判为已压缩）', async () => {
  const root = await temp()
  try {
    const src = join(root, 'src')
    await mkdir(src, { recursive: true })
    // 模拟 PE 的典型形态：大量重复字节（代码段常见）。
    await writeFile(join(src, 'fake.exe'), Buffer.alloc(200_000, 0x41))

    const zipPath = join(root, 'out.zip')
    const result = await zipDirectory({ source: src, outputFile: zipPath, rootName: 'app' })

    assert.ok(
      result.compressedBytes < 10_000,
      `.exe 里的重复内容应该能压，实际 ${String(result.compressedBytes)}`,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('已压缩格式不强行压（体积不该变大）', async () => {
  const root = await temp()
  try {
    const src = join(root, 'src')
    await mkdir(src, { recursive: true })
    // 随机字节，压不动。
    const random = Buffer.alloc(100_000)
    for (let index = 0; index < random.length; index += 1) {
      random[index] = Math.floor(Math.random() * 256)
    }
    await writeFile(join(src, 'noise.png'), random)

    const zipPath = join(root, 'out.zip')
    const result = await zipDirectory({ source: src, outputFile: zipPath, rootName: 'app' })

    // 压不动就该存储，包体只比原始多一点点头部开销。
    assert.ok(
      result.compressedBytes < result.bytes + 2048,
      `不该显著变大：原始 ${String(result.bytes)}，压缩后 ${String(result.compressedBytes)}`,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('空目录报错而不是产出坏包', async () => {
  const root = await temp()
  try {
    const src = join(root, 'empty')
    await mkdir(src, { recursive: true })
    await assert.rejects(
      () => zipDirectory({ source: src, outputFile: join(root, 'x.zip') }),
      /源目录为空/,
    )
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

    const zipPath = join(root, 'out.zip')
    const result = await zipDirectory({ source: src, outputFile: zipPath, rootName: 'app' })
    assert.equal(result.files, 1, '只该打进 keep.txt')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
