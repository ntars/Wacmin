/**
 * 「输入物类型不对」的拒绝路径测试。
 *
 * ## 这一组守的是什么
 *
 * Wacmin 的四方向矩阵里，Windows 可执行文件归 Mac2Win / ExeOnMac 处理，
 * Win2Mac 只装配 macOS 包。把 .exe 塞进 `--executable` 时，产物在
 * macOS 上必然打不开 —— 而且这个错误本来会推迟到用户双击那一刻才暴露，
 * 那时离构建现场已经很远，很难联想到是入口文件选错了。
 *
 * 修复前 Win2Mac 完全不看入口文件的类型：一个 `MZ` 开头的 PE 文件会被
 * 老老实实装进 `Contents/MacOS/` 并写进 `CFBundleExecutable`，打包过程
 * 一路绿灯报「构建完成」。
 *
 * ## 为什么退出码必须是 4 而不是 2
 *
 * 文件好端端在那儿，类型根本不对 —— 这不是「路径写错」（2），是
 * 「这件事做不了」（4）。自动化拿到 2 会重试，拿到 4 才该停。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runBuild } from '../src/core/builder.mjs'
import { StageTracker } from '../src/core/report.mjs'

/** 各平台可执行文件的开头几字节。 */
const HEADS = {
  pe: Buffer.from([0x4d, 0x5a, 0x90, 0x00]),           // "MZ"
  elf: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),         // "\x7fELF"
  macho64: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),     // 小端 Mach-O 64
}

/** 建一个最小项目，返回目录与其中的可执行文件名。 */
async function makeProject(head) {
  const dir = await mkdtemp(join(tmpdir(), 'win2mac-type-'))
  await writeFile(join(dir, 'app.bin'), Buffer.concat([head, Buffer.alloc(128)]))
  return dir
}

describe('主可执行文件的类型校验', () => {
  test('PE（.exe）被拒绝，报 W2M_1005 而不是打包成功', async () => {
    const dir = await makeProject(HEADS.pe)
    try {
      await assert.rejects(
        () => runBuild({
          projectRoot: dir,
          executable: 'app.bin',
          appName: 'Demo',
          version: '1.0.0',
          outDir: join(dir, 'dist'),
          keepWork: false,
          noVerify: true,
          tracker: new StageTracker(),
        }),
        (error) => {
          assert.equal(error.code, 'W2M_1005', `应报明确不支持，实际 ${error.code}`)
          assert.match(error.message, /PE|MZ/)
          assert.match(String(error.hint), /ExeOnMac/,
            '要指向正确的方向，而不只是说「不行」')
          return true
        })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('ELF（Linux 可执行）被拒绝', async () => {
    const dir = await makeProject(HEADS.elf)
    try {
      await assert.rejects(
        () => runBuild({
          projectRoot: dir,
          executable: 'app.bin',
          appName: 'Demo',
          version: '1.0.0',
          outDir: join(dir, 'dist'),
          keepWork: false,
          noVerify: true,
          tracker: new StageTracker(),
        }),
        (error) => {
          assert.equal(error.code, 'W2M_1005')
          assert.match(error.message, /ELF/)
          return true
        })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('真 Mach-O 放行，不被类型检查误拦', async () => {
    const dir = await makeProject(HEADS.macho64)
    try {
      // 只要不因为类型被拒就算通过；后面若因别的原因失败，
      // 错误码不应是 1005。
      let code = null
      try {
        await runBuild({
          projectRoot: dir,
          executable: 'app.bin',
          appName: 'Demo',
          version: '1.0.0',
          outDir: join(dir, 'dist'),
          keepWork: false,
          noVerify: true,
          tracker: new StageTracker(),
        })
      } catch (error) {
        code = error.code
      }
      assert.notEqual(code, 'W2M_1005', 'Mach-O 不该被类型检查拦下')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
