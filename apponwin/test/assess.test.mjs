/**
 * plist 解析与兼容性评估测试。
 *
 * 跑法：cd apponwin && npm test
 *
 * 二进制 plist 是本套的重点：系统应用的 Info.plist 几乎全是 bplist00，
 * 只支持 XML 等于一个 .app 都读不了。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PlistError, parsePlistBuffer, parseXmlPlist, readPlist } from '../src/core/plist.mjs'
import {
  FRAMEWORK_SUPPORT, assessCompatibility, frameworkStatus, parseAppBundle,
} from '../src/core/assess.mjs'

/**
 * 构造一个最小二进制 plist。
 *
 * 只支持测试需要的类型：ASCII 字符串、整数、字典、布尔。
 * 结构：bplist00 + 对象区 + 偏移表 + trailer(32B)。
 *
 * @param {Record<string, string|number|boolean>} dict
 */
function buildBinaryPlist(dict) {
  const objects = []
  const entries = Object.entries(dict)

  // 对象顺序：先 key 字符串，再 value，最后 dict
  const keyIndexes = []
  const valueIndexes = []

  for (const [key] of entries) {
    keyIndexes.push(objects.length)
    objects.push({ type: 'string', value: key })
  }
  for (const [, value] of entries) {
    valueIndexes.push(objects.length)
    if (typeof value === 'string') objects.push({ type: 'string', value })
    else if (typeof value === 'number') objects.push({ type: 'int', value })
    else objects.push({ type: 'bool', value })
  }
  const dictIndex = objects.length
  objects.push({ type: 'dict', keyIndexes, valueIndexes })

  // 序列化对象区
  const chunks = []
  const offsets = []
  let cursor = 8   // 跳过 bplist00

  for (const object of objects) {
    offsets.push(cursor)
    let buffer
    if (object.type === 'string') {
      const data = Buffer.from(object.value, 'latin1')
      if (data.length < 15) {
        buffer = Buffer.concat([Buffer.from([0x50 | data.length]), data])
      } else {
        /*
         * 长度 ≥ 15 时低 4 位是 0xF，后面跟一个整数对象表示真实长度。
         * 这里只用 1 字节整数（长度 < 256），足够测试用。
         */
        buffer = Buffer.concat([
          Buffer.from([0x5f, 0x10, data.length & 0xff]),
          data,
        ])
      }
    } else if (object.type === 'int') {
      buffer = Buffer.from([0x10, object.value & 0xff])
    } else if (object.type === 'bool') {
      buffer = Buffer.from([object.value ? 0x09 : 0x08])
    } else if (object.type === 'dict') {
      const n = object.keyIndexes.length
      const refSize = 1
      const head = Buffer.from([0xd0 | n])
      const keys = Buffer.from(object.keyIndexes)
      const values = Buffer.from(object.valueIndexes)
      buffer = Buffer.concat([head, keys, values])
      assert.ok(refSize === 1)
    }
    chunks.push(buffer)
    cursor += buffer.length
  }

  const objectData = Buffer.concat(chunks)

  // 偏移表：每项 1 字节（对象数 < 256）
  assert.ok(objects.length < 256, '测试构造器只支持 <256 个对象')
  const offsetTable = Buffer.from(offsets)

  // trailer 32 字节
  const trailer = Buffer.alloc(32)
  trailer.writeUInt8(1, 6)                    // offsetSize
  trailer.writeUInt8(1, 7)                    // refSize
  trailer.writeBigUInt64BE(BigInt(objects.length), 8)
  trailer.writeBigUInt64BE(BigInt(dictIndex), 16)
  trailer.writeBigUInt64BE(BigInt(8 + objectData.length), 24)

  return Buffer.concat([
    Buffer.from('bplist00', 'latin1'),
    objectData,
    offsetTable,
    trailer,
  ])
}

describe('XML plist', () => {
  const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Demo</string>
  <key>CFBundleExecutable</key>
  <string>Demo</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>`

  test('读字符串与布尔', () => {
    const parsed = parseXmlPlist(SAMPLE)
    assert.equal(parsed.CFBundleName, 'Demo')
    assert.equal(parsed.LSMinimumSystemVersion, '11.0')
    assert.equal(parsed.NSHighResolutionCapable, true)
  })

  test('读整数与实数', () => {
    const text = `<?xml version="1.0"?><plist><dict>
      <key>a</key><integer>42</integer>
      <key>b</key><real>1.5</real>
    </dict></plist>`
    const parsed = parseXmlPlist(text)
    assert.equal(parsed.a, 42)
    assert.equal(parsed.b, 1.5)
  })

  test('读嵌套数组与字典', () => {
    const text = `<?xml version="1.0"?><plist><dict>
      <key>list</key><array>
        <dict><key>x</key><string>1</string></dict>
        <dict><key>y</key><string>2</string></dict>
      </array>
    </dict></plist>`
    const parsed = parseXmlPlist(text)
    assert.equal(parsed.list.length, 2)
    assert.equal(parsed.list[0].x, '1')
    assert.equal(parsed.list[1].y, '2')
  })

  test('自闭合空 dict 与 array', () => {
    const text = `<?xml version="1.0"?><plist><dict>
      <key>emptyDict</key><dict/>
      <key>emptyArray</key><array/>
      <key>emptyString</key><string/>
    </dict></plist>`
    const parsed = parseXmlPlist(text)
    assert.deepEqual(parsed.emptyDict, {})
    assert.deepEqual(parsed.emptyArray, [])
    assert.equal(parsed.emptyString, '')
  })

  test('还原 XML 实体', () => {
    const text = `<?xml version="1.0"?><plist><dict>
      <key>name</key><string>A&amp;B&lt;C&gt;</string>
    </dict></plist>`
    assert.equal(parseXmlPlist(text).name, 'A&B<C>')
  })

  test('还原数字实体', () => {
    const text = `<?xml version="1.0"?><plist><dict>
      <key>name</key><string>&#65;&#x42;</string>
    </dict></plist>`
    assert.equal(parseXmlPlist(text).name, 'AB')
  })

  test('中文原样保留', () => {
    const text = `<?xml version="1.0"?><plist><dict>
      <key>name</key><string>微信</string>
    </dict></plist>`
    assert.equal(parseXmlPlist(text).name, '微信')
  })

  test('注释与 DOCTYPE 被跳过', () => {
    const text = `<?xml version="1.0"?>
<!-- 这是注释 -->
<!DOCTYPE plist PUBLIC "x" "y">
<plist><dict><key>a</key><string>b</string></dict></plist>`
    assert.equal(parseXmlPlist(text).a, 'b')
  })

  test('标签不成对时报错', () => {
    const text = '<?xml version="1.0"?><plist><dict><key>a</key></plist>'
    assert.throws(() => parseXmlPlist(text), PlistError)
  })

  test('缺少 plist 闭合标签时报错', () => {
    /*
     * 这条来自一个真实缺陷：截断的 Info.plist（少了 </plist>）被静默
     * 接受，于是后续所有判断都建立在错误前提上，用户只看到「无法判定」
     * 却不知道根因。
     */
    const text = '<?xml version="1.0"?><plist><dict><key>a</key><string>X</string></dict>'
    assert.throws(() => parseXmlPlist(text), /缺少闭合标签/u)
  })

  test('缺少 dict 闭合标签时报错', () => {
    const text = '<?xml version="1.0"?><plist><dict><key>a</key><string>X</string></plist>'
    assert.throws(() => parseXmlPlist(text), PlistError)
  })

  test('没有 plist 包裹仍可解析', () => {
    /*
     * 有些工具生成的 plist 省略外层 <plist>，只有 <dict>。
     * 这种应该照常接受 —— 严格性针对「结构不完整」，不是「必须长这样」。
     */
    const text = '<?xml version="1.0"?><dict><key>a</key><string>X</string></dict>'
    assert.equal(parseXmlPlist(text).a, 'X')
  })

  test('未知标签报错', () => {
    const text = '<?xml version="1.0"?><plist><dict><key>a</key><weird/></dict></plist>'
    assert.throws(() => parseXmlPlist(text), PlistError)
  })
})

describe('二进制 plist', () => {
  test('读字符串字典', () => {
    const buffer = buildBinaryPlist({
      CFBundleExecutable: 'Demo',
      CFBundleIdentifier: 'com.example.demo',
    })
    const parsed = parsePlistBuffer(buffer)
    assert.equal(parsed.CFBundleExecutable, 'Demo')
    assert.equal(parsed.CFBundleIdentifier, 'com.example.demo')
  })

  test('读整数与布尔', () => {
    const buffer = buildBinaryPlist({ count: 42, enabled: true, disabled: false })
    const parsed = parsePlistBuffer(buffer)
    assert.equal(parsed.count, 42)
    assert.equal(parsed.enabled, true)
    assert.equal(parsed.disabled, false)
  })

  test('过短 buffer 报错', () => {
    assert.throws(() => parsePlistBuffer(Buffer.from('bplist00')), PlistError)
  })

  test('偏移表越界报错', () => {
    const buffer = Buffer.alloc(64)
    buffer.write('bplist00', 0, 'latin1')
    // trailer 里把 offsetTableOffset 设成超大值
    buffer.writeBigUInt64BE(0xffffn, 64 - 32 + 24)
    assert.throws(() => parsePlistBuffer(buffer), PlistError)
  })
})

describe('真实 plist 文件', () => {
  test('读本机某个 Info.plist', {
    skip: process.platform !== 'darwin',
  }, async () => {
    /*
     * 用系统应用的真实 plist 验证 —— 它们通常是二进制格式，
     * 这是构造样本覆盖不到的部分。
     */
    const candidates = [
      '/System/Applications/Calculator.app/Contents/Info.plist',
      '/System/Applications/Notes.app/Contents/Info.plist',
    ]
    let parsed = null
    let used = null
    for (const path of candidates) {
      const exists = await stat(path).then(() => true).catch(() => false)
      if (!exists) continue
      parsed = await readPlist(path)
      used = path
      break
    }
    if (parsed === null) return   // 没有样本就跳过
    assert.ok(typeof parsed.CFBundleIdentifier === 'string', `来自 ${used}`)
    assert.ok(parsed.CFBundleIdentifier.includes('.'))
  })
})

describe('框架支持清单', () => {
  test('已知框架返回清单里的信息', () => {
    const status = frameworkStatus('AppKit')
    assert.equal(status.name, 'AppKit')
    assert.equal(status.status, 'partial')
    assert.ok(status.note.length > 0)
  })

  test('未知框架返回 unknown 而不是 works', () => {
    /*
     * 这是最关键的断言：清单里没有的框架**不能**被假设为可用。
     * 假设可用会导致乐观的错判。
     */
    const status = frameworkStatus('SomeVendorPrivateFramework')
    assert.equal(status.status, 'unknown')
    assert.match(status.note, /不能假设可用/u)
  })

  test('Metal 与 SwiftUI 标为 broken', () => {
    assert.equal(frameworkStatus('Metal').status, 'broken')
    assert.equal(frameworkStatus('SwiftUI').status, 'broken')
  })

  test('Foundation 标为 works', () => {
    assert.equal(frameworkStatus('Foundation').status, 'works')
  })

  test('每项都有 note 与 confidence', () => {
    for (const [name, info] of Object.entries(FRAMEWORK_SUPPORT)) {
      assert.ok(typeof info.note === 'string' && info.note.length > 0, name)
      assert.ok(['high', 'medium', 'low'].includes(info.confidence), name)
      assert.ok(['works', 'partial', 'broken', 'unknown'].includes(info.status), name)
    }
  })
})

describe('兼容性评估', () => {
  /**
   * 造一个最小的 parsed 结果。
   * @param {string[]} frameworks
   * @param {object} [overrides]
   */
  function fakeParsed(frameworks, overrides = {}) {
    return {
      path: '/tmp/X.app',
      bundleId: 'com.example.x',
      name: 'X',
      version: '1.0',
      executableName: 'X',
      mainExecutableExists: true,
      minimumSystemVersion: '11.0',
      plistError: null,
      binaries: frameworks.length > 0 || overrides.hasBinary !== false
        ? [{ path: 'Contents/MacOS/X', architectures: ['arm64'], frameworks, dylibs: [] }]
        : [],
      frameworks,
      dylibs: [],
      info: {},
      ...overrides,
    }
  }

  test('只依赖 Foundation 时 likely', () => {
    const result = assessCompatibility(fakeParsed(['Foundation', 'CoreFoundation']))
    assert.equal(result.verdict, 'likely')
  })

  test('依赖 Metal 时 unlikely', () => {
    const result = assessCompatibility(fakeParsed(['Foundation', 'Metal']))
    assert.equal(result.verdict, 'unlikely')
    assert.ok(result.reasons.some((r) => r.includes('明确不支持')))
  })

  test('依赖 AppKit 时 unlikely（部分支持也算风险）', () => {
    const result = assessCompatibility(fakeParsed(['Foundation', 'AppKit']))
    assert.equal(result.verdict, 'unlikely')
  })

  test('依赖未知框架时 unknown', () => {
    /*
     * 木桶效应：未知框架的严重度高于 partial 但低于 broken。
     * 不能因为「其它都 works」就说 likely。
     */
    const result = assessCompatibility(fakeParsed(['Foundation', 'MysteryKit']))
    assert.equal(result.verdict, 'unknown')
    assert.ok(result.reasons.some((r) => r.includes('无公开支持信息')))
  })

  test('没有任何二进制时 unknown', () => {
    const result = assessCompatibility({
      ...fakeParsed([]),
      binaries: [],
      frameworks: [],
    })
    assert.equal(result.verdict, 'unknown')
    assert.ok(result.reasons.some((r) => r.includes('未找到任何 Mach-O')))
  })

  test('broken 优先于 unknown', () => {
    const result = assessCompatibility(fakeParsed(['Metal', 'MysteryKit']))
    assert.equal(result.verdict, 'unlikely')
  })

  test('统计各状态数量', () => {
    const result = assessCompatibility(
      fakeParsed(['Foundation', 'AppKit', 'Metal', 'MysteryKit']))
    assert.equal(result.counts.works, 1)
    assert.equal(result.counts.partial, 1)
    assert.equal(result.counts.broken, 1)
    assert.equal(result.counts.unknown, 1)
  })

  test('非 x86_64 架构给出警告', () => {
    const result = assessCompatibility(fakeParsed(['Foundation']))
    assert.ok(result.archWarnings.some((w) => w.includes('x86_64')))
  })

  test('含 x86_64 时不警告架构', () => {
    const parsed = fakeParsed(['Foundation'])
    parsed.binaries[0].architectures = ['x86_64', 'arm64']
    const result = assessCompatibility(parsed)
    assert.equal(result.archWarnings.length, 0)
  })

  test('每次都带时效声明', () => {
    const result = assessCompatibility(fakeParsed(['Foundation']))
    assert.match(result.disclaimer, /可能随 Darling 版本变化/u)
  })
})

describe('.app 解析', () => {
  /** 造一个最小 .app。 */
  async function makeApp(root, options = {}) {
    const appDir = join(root, options.name ?? 'Demo.app')
    await mkdir(join(appDir, 'Contents/MacOS'), { recursive: true })
    await writeFile(join(appDir, 'Contents/Info.plist'), options.plist ?? `<?xml version="1.0"?>
<plist><dict>
  <key>CFBundleExecutable</key><string>Demo</string>
  <key>CFBundleIdentifier</key><string>com.example.demo</string>
  <key>CFBundleName</key><string>Demo</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>`)
    if (options.withExecutable !== false) {
      await writeFile(join(appDir, 'Contents/MacOS/Demo'), 'not really macho')
    }
    return appDir
  }

  test('读基本信息', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aow-app-'))
    try {
      const appDir = await makeApp(root)
      const parsed = await parseAppBundle(appDir)
      assert.equal(parsed.bundleId, 'com.example.demo')
      assert.equal(parsed.executableName, 'Demo')
      assert.equal(parsed.mainExecutableExists, true)
      assert.equal(parsed.minimumSystemVersion, '11.0')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('非 .app 目录报错', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aow-app-'))
    try {
      await assert.rejects(() => parseAppBundle(root), /不是 \.app/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('不存在路径报契约错误码', async () => {
    /*
     * 必须带 AOW_1002（输入不存在）而不是 AOW_9999（内部错误）。
     *
     * 用户看到「内部错误」会以为是工具的 bug，而实际只是路径传错 ——
     * 错误码的段位直接决定用户能不能自己定位问题。
     */
    await assert.rejects(
      () => parseAppBundle('/tmp/ghost-apponwin.app'),
      (error) => {
        assert.equal(error.code, 'AOW_1002')
        assert.match(error.message, /路径不存在/u)
        return true
      })
  })

  test('缺 Info.plist 时 plistError 有值但不抛异常', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aow-app-'))
    try {
      const appDir = join(root, 'Broken.app')
      await mkdir(join(appDir, 'Contents'), { recursive: true })
      const parsed = await parseAppBundle(appDir)
      assert.notEqual(parsed.plistError, null)
      assert.equal(parsed.bundleId, null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('主可执行文件不存在时如实标记', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aow-app-'))
    try {
      const appDir = await makeApp(root, { withExecutable: false })
      const parsed = await parseAppBundle(appDir)
      assert.equal(parsed.executableName, 'Demo')
      assert.equal(parsed.mainExecutableExists, false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})