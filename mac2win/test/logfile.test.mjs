/**
 * 构建日志落盘时机测试。
 *
 * ## 这一组守的是什么
 *
 * 日志器会在构造时 `mkdirSync(dirname(file))`。如果入口把
 * `<projectRoot>/.mac2win-build.log` 直接传进构造函数，那么用一个
 * **不存在的路径** 调 `mac2win build` 会先把那个目录造出来 ——
 * 紧接着 `resolveConfig` 里「目录不存在」的检查必然通过，因为目录
 * 刚被自己创建了。
 *
 * 结果：用户写错一个字母，拿到的是「既没有 entry 也没有 frontendDist」
 * （M2W_1003），与真实原因（路径拼写错，M2W_1002）毫无关系；而且
 * 磁盘上凭空多出一个空目录。
 *
 * 这不是假想问题，是实测出来的：`mac2win build /tmp/nonexist-xyz`
 * 在修复前回报 M2W_1003 并留下 /tmp/nonexist-xyz。
 *
 * ## 守的两条
 *
 * 1. `Logger` 不传 `file` 时不碰磁盘 —— 构造本身必须无副作用。
 * 2. `attachFile` 延迟挂载时，**构造到挂载之间**产生的日志要补写进
 *    文件。那段日志往往正是报错原因，漏了等于日志从中间开始。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Logger } from '../src/core/logger.mjs'

/** 建一个临时目录，返回路径与清理函数。 */
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'mac2win-log-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe('Logger 落盘时机', () => {
  test('不传 file 时构造无副作用，不创建任何目录', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const target = join(dir, 'not-yet', 'build.log')

      new Logger({ sink: () => {} })

      assert.equal(existsSync(join(dir, 'not-yet')), false,
        '构造 Logger 不应创建目录 —— 否则目录存在性检查会失效')
      assert.equal(existsSync(target), false)
    } finally {
      await cleanup()
    }
  })

  test('构造时传 file 仍然立即落盘（旧行为不能丢）', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const target = join(dir, 'nested', 'build.log')
      const logger = new Logger({ file: target })
      logger.info('第一条')

      const text = await readFile(target, 'utf8')
      assert.match(text, /第一条/)
    } finally {
      await cleanup()
    }
  })

  test('attachFile 补写挂载前已产生的日志', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const target = join(dir, 'late', 'build.log')
      const logger = new Logger({ sink: () => {} })

      // 挂载前：这几条只在内存与终端里
      logger.info('挂载前的第一句')
      logger.error('挂载前的失败原因', { code: 'M2W_1002' })

      logger.attachFile(target)
      logger.info('挂载后的收尾')

      const text = await readFile(target, 'utf8')
      assert.match(text, /挂载前的第一句/, '挂载前的日志必须补写，否则文件从中间开始')
      assert.match(text, /挂载前的失败原因/)
      assert.match(text, /M2W_1002/, '错误码要带进文件')
      assert.match(text, /挂载后的收尾/)
    } finally {
      await cleanup()
    }
  })

  test('attachFile 之后新日志继续追加，不覆盖', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const target = join(dir, 'append', 'build.log')
      const logger = new Logger({ sink: () => {} })

      logger.attachFile(target)
      logger.info('一')
      logger.info('二')

      const text = await readFile(target, 'utf8')
      assert.match(text, /一/)
      assert.match(text, /二/)
      assert.equal(text.indexOf('一') < text.indexOf('二'), true, '顺序要按产生顺序')
    } finally {
      await cleanup()
    }
  })

  test('挂载路径的父目录会被建出来', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const target = join(dir, 'a', 'b', 'c', 'build.log')
      const logger = new Logger({ sink: () => {} })
      logger.attachFile(target)
      logger.info('在最深处')

      const info = await stat(target)
      assert.equal(info.isFile(), true)
    } finally {
      await cleanup()
    }
  })

  test('重复 attachFile 从内存重建文件，不重复堆积', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const target = join(dir, 'twice', 'build.log')
      const logger = new Logger({ sink: () => {} })
      logger.attachFile(target)
      logger.info('唯一一条')

      // 再挂一次：文件应被重建（writeFileSync 覆盖），而不是追加
      logger.attachFile(target)
      logger.info('第二条')

      const text = await readFile(target, 'utf8')
      const occurrences = text.split('唯一一条').length - 1
      assert.equal(occurrences, 1, '重复挂载不能让同一行在文件里出现两次')
      assert.match(text, /第二条/)
    } finally {
      await cleanup()
    }
  })
})
