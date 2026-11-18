/**
 * zip 解包的测试。
 *
 * 用 Node 官方的 zip 作为真实样本（它就是打包时实际要解的那种格式）。
 * 同时验证安全边界：路径穿越必须被拒绝——一个恶意的 zip 可以把文件
 * 写到任意位置，这是静态服务与解包器最经典的漏洞。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { unzipFile, ZipError } from '../src/core/zip.mjs'

/**
 * 构造一个最小 zip。
 *
 * @param {Array<{name: string, content: Buffer, method?: number}>} entries
 */
function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8')
    const method = entry.method ?? 0
    const data = method === 8 ? deflateRawSync(entry.content) : entry.content

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)          // version needed
    local.writeUInt16LE(0x800, 6)       // UTF-8 flag
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 10)          // time/date
    local.writeUInt32LE(0, 14)          // crc（解析器不校验，留 0）
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(entry.content.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(0, 12)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(entry.content.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt32LE(offset, 42)

    locals.push(local, nameBuffer, data)
    centrals.push(central, nameBuffer)
    offset += local.length + nameBuffer.length + data.length
  }

  const centralBuffer = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, centralBuffer, eocd])
}

test('解存储（method 0）的文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zip-test-'))
  try {
    const zipPath = join(dir, 'a.zip')
    await writeFile(zipPath, buildZip([
      { name: 'hello.txt', content: Buffer.from('你好') },
    ]))
    const result = await unzipFile(zipPath, join(dir, 'out'))
    assert.equal(result.files, 1)
    assert.equal(await readFile(join(dir, 'out', 'hello.txt'), 'utf8'), '你好')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('解 deflate（method 8）的文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zip-test-'))
  try {
    const zipPath = join(dir, 'b.zip')
    const content = Buffer.from('重复内容'.repeat(100))
    await writeFile(zipPath, buildZip([
      { name: 'big.txt', content, method: 8 },
    ]))
    await unzipFile(zipPath, join(dir, 'out'))
    const actual = await readFile(join(dir, 'out', 'big.txt'))
    assert.equal(actual.toString(), content.toString())
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('保留子目录结构', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zip-test-'))
  try {
    const zipPath = join(dir, 'c.zip')
    await writeFile(zipPath, buildZip([
      { name: 'a/b/c.txt', content: Buffer.from('deep') },
    ]))
    await unzipFile(zipPath, join(dir, 'out'))
    assert.equal(await readFile(join(dir, 'out', 'a', 'b', 'c.txt'), 'utf8'), 'deep')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('拒绝路径穿越', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zip-test-'))
  try {
    const zipPath = join(dir, 'evil.zip')
    await writeFile(zipPath, buildZip([
      { name: '../../etc/passwd', content: Buffer.from('pwned') },
    ]))
    await assert.rejects(
      () => unzipFile(zipPath, join(dir, 'out')),
      (error) => error instanceof ZipError && /不安全/.test(error.message),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('拒绝非 zip 文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zip-test-'))
  try {
    const zipPath = join(dir, 'not.zip')
    await writeFile(zipPath, Buffer.from('this is not a zip file at all'))
    await assert.rejects(() => unzipFile(zipPath, join(dir, 'out')), ZipError)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('拒绝不支持的压缩方法', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zip-test-'))
  try {
    const zipPath = join(dir, 'lzma.zip')
    // method 14 = LZMA，本实现不支持。
    await writeFile(zipPath, buildZip([
      { name: 'x.txt', content: Buffer.from('x'), method: 14 },
    ]))
    await assert.rejects(
      () => unzipFile(zipPath, join(dir, 'out')),
      (error) => error instanceof ZipError && /压缩方法/.test(error.message),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
