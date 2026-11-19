/**
 * Win2Mac 的宿主平台分支与契约一致性（W-05 跨平台可运行性巡检产物）。
 *
 * ## 这一组守的三件事
 *
 * 1. `verifyBundle` 在非 darwin 上必须给出「plutil / codesign / 双击均
 *    未验证」的警告。这条分支在本机走不到，但它是**在 Windows 上打完包
 *    的人唯一会看到的免责声明**。若它失效，报告会写着「校验通过」而
 *    实际什么都没验 —— 正是本仓库反复批评的「把未验证写成通过」。
 * 2. `--strict-host` 抛的错误码必须与它实际使用的退出码在契约里自洽。
 * 3. `doctor` 的失败归码必须落在退出码 5 声明的段位内。
 *
 * ## 第 2 条为什么值得单独一条测试
 *
 * 早先 `--strict-host` 抛 `HOST_UNSUPPORTED`（1001），退出码按段位兜底
 * 得 2。报告里 `exitCode: 2` 配 `W2M_1001`，而契约的 13 条退出码里
 * **没有一条声明 1001** —— 同一份输出对同一个错误给出两种含义。
 * 用 `contracts/validate.mjs --report r.json --exit-code 2` 一跑就红，
 * 但此前没有任何测试会跑它。
 *
 * 修法是改成 `UNSUPPORTED`（1005 → 退出码 4）。这条测试不跑子进程，
 * 直接把「错误码 → 退出码 → 契约段位」这条链算一遍，比跑 CLI 快得多，
 * 也不会因为环境差异而飘。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'

import { plutilLint, verifyBundle } from '../src/core/verify.mjs'
import { ErrorCode } from '../src/core/errors.mjs'
import { exitCodeFor } from '../src/core/report.mjs'

/** 造一个最小可用的 `.app`。 */
async function makeApp(root) {
  const appDir = join(root, 'Demo.app')
  await mkdir(join(appDir, 'Contents', 'MacOS'), { recursive: true })
  await writeFile(join(appDir, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Demo</string>
  <key>CFBundleDisplayName</key><string>Demo</string>
  <key>CFBundleIdentifier</key><string>com.example.demo</string>
  <key>CFBundleExecutable</key><string>Demo</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`)
  await writeFile(join(appDir, 'Contents', 'MacOS', 'Demo'), 'x')
  return appDir
}

describe('verifyBundle 的平台分支', () => {
  test('darwin：警告里说 plutil 已执行', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-plat-'))
    try {
      const appDir = await makeApp(root)
      const result = await verifyBundle(appDir, { platform: 'darwin' })
      const text = result.warnings.join('\n')
      assert.match(text, /plutil 校验已执行/u, `实际警告：${text}`)
      assert.match(text, /codesign/u, '仍要说明 codesign 未验证')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('win32：警告里明说 plutil / codesign / 双击均未验证', async () => {
    /*
     * 这是本组最重要的一条。在 Windows 上打完包，用户看到的必须是
     * 「三样都没验」，而不能是「校验通过」。
     */
    const root = await mkdtemp(join(tmpdir(), 'w2m-plat-'))
    try {
      const appDir = await makeApp(root)
      const result = await verifyBundle(appDir, { platform: 'win32' })
      const text = result.warnings.join('\n')

      assert.match(text, /win32/u, '要点出当前平台，否则用户不知道在哪验的')
      assert.match(text, /plutil/u)
      assert.match(text, /codesign/u)
      assert.match(text, /双击均未验证|实际双击/u, '必须明确「未验证」，不能含糊')
      assert.ok(!/plutil 校验已执行/u.test(text),
        '非 darwin 上不能声称 plutil 已执行 —— 那是凭空断言')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('非 darwin 上 plutilLint 不执行子进程，明确报 available:false', async () => {
    /*
     * 先断言「不执行」这个事实，而不是只断言返回值。
     *
     * 若实现改成「先跑 plutil 再判断平台」，在 Linux CI 上会因 ENOENT
     * 落到另一个分支，结论碰巧也是 available:false —— 但那样每次
     * 校验都会白起一个进程，且真正的平台判断被掩盖。
     */
    const result = await plutilLint('/tmp/不存在的.plist', { platform: 'win32' })
    assert.equal(result.available, false)
    assert.equal(result.ok, true, '不可用不等于校验失败')
    assert.match(result.detail, /非 macOS/u)
  })

  test('默认参数仍走本机平台，行为不变', async () => {
    /*
     * 注入参数不能改变默认行为。这条防止「加了参数但忘了默认值」。
     */
    const root = await mkdtemp(join(tmpdir(), 'w2m-plat-'))
    try {
      const appDir = await makeApp(root)
      const withDefault = await verifyBundle(appDir)
      const explicit = await verifyBundle(appDir, { platform: process.platform })
      assert.deepEqual(withDefault.warnings, explicit.warnings)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('错误码与契约的对应关系', () => {
  const contract = JSON.parse(
    readFileSync(new URL('../../contracts/exit-codes.json', import.meta.url), 'utf8'))

  /** 展开 `errorSegment`（列举 `1003/1004`、范围 `4001-5002`、单值 `9999`）。 */
  function expand(segment) {
    const out = new Set()
    for (const part of String(segment).split('/')) {
      const [low, high] = part.split('-')
      if (high === undefined) { out.add(Number(low)); continue }
      for (let i = Number(low); i <= Number(high); i += 1) out.add(i)
    }
    return out
  }

  /** 退出码 → 它允许的错误码序号集合。 */
  const allowedByExit = new Map()
  for (const [key, entry] of Object.entries(contract.codes)) {
    allowedByExit.set(Number(key),
      entry.errorSegment === null ? null : expand(entry.errorSegment))
  }

  /**
   * 本方向源码里真正抛出过的错误码名字集合。
   *
   * 扫 `bin/` 与 `src/` 下全部 `.mjs`，去掉注释后找 `ErrorCode.<名字>`。
   * 去掉注释是必要的：注释里大段引用旧码名（解释为什么改掉），
   * 不过滤会把它们算成「仍在使用」。
   */
  function referencedNames() {
    const roots = [
      new URL('../bin/', import.meta.url),
      new URL('../src/core/', import.meta.url),
      new URL('../src/util/', import.meta.url),
      new URL('../src/verify/', import.meta.url),
    ]
    const names = new Set()
    const walk = (dir) => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const child = new URL(entry.name, dir)
        if (entry.isDirectory()) { walk(new URL(`${entry.name}/`, dir)); continue }
        if (!entry.name.endsWith('.mjs') || entry.name === 'errors.mjs') continue
        const text = readFileSync(child, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//gu, '')
          .replace(/^\s*\/\/.*$/gmu, '')
        for (const match of text.matchAll(/ErrorCode\.([A-Z][A-Z0-9_]+)\b/gu)) names.add(match[1])
      }
    }
    for (const root of roots) walk(root)
    return names
  }

  test('--strict-host 用的错误码，其退出码在契约里有声明且段位相符', () => {
    /*
     * 这条是真实缺陷的回归锁。
     *
     * 缺陷原貌：`--strict-host` 抛 HOST_UNSUPPORTED（1001），退出码按
     * 段位兜底得 2；契约的 exit 2 只声明 1002/1003/1004，1001 不在其中
     * —— 而且 13 条退出码里没有任何一条声明过 1001。
     *
     * 用 `contracts/validate.mjs --report r.json --exit-code 2` 能查到
     * 这个矛盾，但此前没人跑它。现在把同一条判据搬进测试：
     * 不跑子进程，直接算「码 → 退出码 → 契约段位」。
     */
    const code = ErrorCode.UNSUPPORTED
    const exit = exitCodeFor(code)
    const allowed = allowedByExit.get(exit)

    assert.notEqual(allowed, undefined, `退出码 ${exit} 在契约里没有声明`)
    assert.ok(allowed.has(Number(code.slice(-4))),
      `${code} 映射到退出码 ${exit}，但契约里该退出码只声明 ${[...(allowed ?? [])].join('/')}`)
    assert.equal(exit, 4, '宿主不支持属「明确不支持」，契约对应退出码 4')
  })

  test('doctor 的失败归码落在退出码 5 的声明范围内', () => {
    /*
     * doctor 已通过的环境里不会失败，所以这条覆盖的是「Node 版本过低」
     * 那一条路径。它必须归到 2002（TOOL_OUTDATED）而不是 1001。
     */
    const code = ErrorCode.TOOL_OUTDATED
    const exit = exitCodeFor(code)
    const allowed = allowedByExit.get(exit)

    assert.equal(exit, 5)
    assert.ok(allowed.has(Number(code.slice(-4))),
      `${code} 与退出码 ${exit} 在契约里不一致`)
  })

  test('本方向实际会抛出的每个错误码，都在契约里有落点', () => {
    /*
     * 只扫**真实可达**的码，不是 `ErrorCode` 里全部 20 条。
     *
     * 理由：`errors.mjs` 是四个方向同构的骨架，里面预留了 3xxx（运行时）、
     * 4xxx（输入物处理）、5xxx（产物生成）等段位，win2mac 目前一个都没用
     * ——它接收已构建好的可执行文件，不下载运行时。断言用不到的死码，
     * 只会逼着人为了过测试去改契约。
     *
     * 可达性判定：源码里出现过 `ErrorCode.<名字>`。这条判据也顺带守住
     * 「定义了一堆码但一个都没接上」的情形 —— 真有那天，下面会报出来。
     *
     * 已知例外 `HOST_UNSUPPORTED` 单独由下一条测试守着「确实没被引用」。
     */
    const unreferenced = new Set(['HOST_UNSUPPORTED'])
    const offenders = []
    for (const [name, code] of Object.entries(ErrorCode)) {
      if (unreferenced.has(name)) continue
      if (!referencedNames().has(name)) continue
      const exit = exitCodeFor(code)
      const allowed = allowedByExit.get(exit)
      if (!allowed || !allowed.has(Number(code.slice(-4)))) {
        offenders.push(`${name} ${code} → exit ${exit}，契约只含 ${[...(allowed ?? [])].join('/')}`)
      }
    }
    assert.deepEqual(offenders, [], `这些错误码与契约不一致：\n${offenders.join('\n')}`)
  })

  test('可达性判据本身有效：至少扫到 6 个码', () => {
    /*
     * 上一条依赖 `referencedNames()`。若那个函数坏了（比如路径写错、
     * 正则不匹配），它会返回空集合，上一条就变成「零项不一致」——
     * 守卫被关掉而报告全绿。这条防止那种空转。
     */
    const names = referencedNames()
    assert.ok(names.size >= 6,
      `可达码应至少 6 个（CANCELLED 除外），实际 ${names.size}：${[...names].join(',')}`)
    for (const expected of ['UNSUPPORTED', 'TOOL_OUTDATED', 'INPUT_NOT_FOUND', 'CONFIG_MISSING']) {
      assert.ok(names.has(expected), `${expected} 应被判为可达`)
    }
  })

  test('HOST_UNSUPPORTED 确实已无生产代码引用（不是靠排掉掩盖）', () => {
    /*
     * 上一条把它排掉了。若它其实还在被用，排掉就等于关掉守卫。
     * 判定交给同一个 `referencedNames()`：它在注释被剥离后的代码里找。
     */
    assert.ok(!referencedNames().has('HOST_UNSUPPORTED'),
      '仍在使用 HOST_UNSUPPORTED（1001 在契约里没有退出码声明）')
  })
})
