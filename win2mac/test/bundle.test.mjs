/**
 * 阶段 2 验收测试：Info.plist 生成与 bundle 装配。
 *
 * 跑法：cd win2mac && npm test
 *
 * 这套测试的重点是**在 Windows 上能抓到的那部分错误**：XML 转义、
 * 字段完整性、目录结构。plist 的最终合法性由 macOS 上的 `plutil`
 * 保证 —— 有 plutil 时这里也会跑一遍，双重确认。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  MAX_BUNDLE_NAME, buildPlist, escapeXml, makeBundleId, makeBundleName,
  normalizeVersion, serializePlist, validatePlistText,
} from '../src/core/plist.mjs'
import {
  LAYOUT, MAX_DIR_NAME_BYTES, assembleBundle, bundleDirName,
  ensureSkeleton, fitDirName, installIcon,
} from '../src/core/bundle.mjs'

const execFileAsync = promisify(execFile)
const hasPlutil = process.platform === 'darwin'

describe('XML 转义', () => {
  test('五个必须转义的字符', () => {
    assert.equal(escapeXml('a&b'), 'a&amp;b')
    assert.equal(escapeXml('a<b'), 'a&lt;b')
    assert.equal(escapeXml('a>b'), 'a&gt;b')
    assert.equal(escapeXml('a"b'), 'a&quot;b')
    assert.equal(escapeXml("a'b"), 'a&apos;b')
  })

  test('& 先于其它字符替换', () => {
    /* 若先替换 < 为 &lt;，再替换 & 会把 &lt; 变成 &amp;lt; —— 经典错误 */
    assert.equal(escapeXml('<'), '&lt;')
    assert.equal(escapeXml('&<'), '&amp;&lt;')
  })

  test('剔除 XML 不允许的控制字符', () => {
    assert.equal(escapeXml('a\u0000b'), 'ab')
    assert.equal(escapeXml('a\u001Fb'), 'ab')
    /* \t \n \r 是合法的，必须保留 */
    assert.equal(escapeXml('a\tb\nc\rd'), 'a\tb\nc\rd')
  })

  test('中文与 emoji 原样保留', () => {
    assert.equal(escapeXml('微信'), '微信')
    assert.equal(escapeXml('🚀'), '🚀')
  })
})

describe('bundle id', () => {
  test('基本转换', () => {
    assert.equal(makeBundleId('tencent.wechat'), 'com.wexe.mac.tencent.wechat')
  })

  test('已带前缀不重复', () => {
    assert.equal(makeBundleId('com.wexe.mac.a.b'), 'com.wexe.mac.a.b')
  })

  test('大写转小写', () => {
    assert.equal(makeBundleId('Tencent.WeChat'), 'com.wexe.mac.tencent.wechat')
  })

  test('中文名用哈希兜底，不同名得不同 id', () => {
    /*
     * 这是关键：若中文名归一化后直接返回 com.wexe.mac.app，
     * 所有中文应用会共用同一个 id，LaunchServices 会把它们当成
     * 同一个应用，Dock 图标与默认打开方式全部错乱。
     */
    const a = makeBundleId('app.演示应用', '演示应用')
    const b = makeBundleId('app.另一个应用', '另一个应用')
    assert.notEqual(a, b)
    assert.match(a, /^com\.wexe\.mac\.app-[0-9a-f]{8}$/u)
    assert.match(b, /^com\.wexe\.mac\.app-[0-9a-f]{8}$/u)
  })

  test('末段叫 app 但前面有厂商时不丢段', () => {
    assert.equal(makeBundleId('com.wexe.mac.vendor.app'), 'com.wexe.mac.vendor.app')
  })

  test('结果只含合法字符', () => {
    const id = makeBundleId('My App_测试')
    assert.match(id, /^com\.wexe\.mac\.[a-z0-9.-]+$/u)
  })

  /*
   * ## 部分丢字符同样要兜
   *
   * 早先只兜了「归一化后一个合法段都不剩」这一种形态。但**部分丢**更
   * 隐蔽：归一化后还剩几段，看起来像成功了，实际把区分度全丢了。
   *
   *   `cn.星玖.测试`  → 剥成 `cn`
   *   `cn.另一个厂商` → 剥成 `cn`   ← 撞成同一个 id
   *
   * 这两个包在同一个 LaunchServices 数据库里会被当成同一个应用。
   */
  test('中文厂商名不能撞成同一个 id', () => {
    const a = makeBundleId('cn.星玖.测试', '同一个应用')
    const b = makeBundleId('cn.另一个厂商', '同一个应用')
    assert.notEqual(a, b, `不同中文厂商撞了 id：${a}`)
    assert.match(a, /^com\.wexe\.mac\.cn-[0-9a-f]{8}$/u)
  })

  test('中英混排保留可读前缀', () => {
    const id = makeBundleId('app.空谷-ondra', '空谷 Ondra')
    assert.match(id, /^com\.wexe\.mac\.app\.ondra-[0-9a-f]{8}$/u,
      `应保留可读的 ondra 片段，实际 ${id}`)
  })

  test('纯 ASCII 不加后缀（向后兼容）', () => {
    // 老产物已经是 com.wexe.mac.tencent.wechat，改了就变成「另一个应用」
    assert.equal(makeBundleId('tencent.wechat'), 'com.wexe.mac.tencent.wechat')
    assert.equal(makeBundleId('cn.example.app'), 'com.wexe.mac.cn.example.app')
  })

  test('中文名横向比较：全部唯一', () => {
    const names = ['记事本', '我的应用', '微信', '网易云音乐', '腾讯会议',
      '钉钉', '微信开发者工具', '空谷 Ondra', 'QQ音乐']
    const seen = new Map()
    for (const name of names) {
      // 模拟真实调用：vendor 默认 app，slug 为空时退化成 vendor
      const id = makeBundleId(`cn.星玖.${name}`, name)
      assert.ok(!seen.has(id), `「${name}」与「${seen.get(id)}」撞了：${id}`)
      seen.set(id, name)
    }
    assert.equal(seen.size, names.length)
  })
})

describe('CFBundleName', () => {
  test('短名保留', () => {
    assert.equal(makeBundleName('微信'), '微信')
  })

  test('超长按码点截断', () => {
    const name = makeBundleName('一二三四五六七八九十一二三四五六七')
    assert.equal(Array.from(name).length, MAX_BUNDLE_NAME)
    assert.equal(name.includes('\ufffd'), false, '不能截出半个字')
  })

  test('ASCII 超长截断', () => {
    assert.equal(makeBundleName('1234567890123456789'), '123456789012345')
  })

  test('空名兜底', () => {
    assert.equal(makeBundleName('   '), 'App')
  })
})

describe('版本归一化', () => {
  test('普通版本', () => {
    assert.deepEqual(normalizeVersion('3.9.10'), ['3.9.10', '3.9.10'])
  })

  test('预发布版 build 是纯数字', () => {
    const [short, build] = normalizeVersion('3.9.10-beta.2')
    assert.equal(short, '3.9.10-beta.2')
    assert.match(build, /^[0-9.]+$/u)
    assert.equal(build, '3.9.10.0.2')
  })

  test('空值兜底', () => {
    assert.deepEqual(normalizeVersion(''), ['1.0', '1.0'])
    assert.deepEqual(normalizeVersion(null), ['1.0', '1.0'])
  })

  test('全零退回 1.0', () => {
    assert.equal(normalizeVersion('0.0.0')[1], '1.0')
  })
})

describe('plist 文档', () => {
  test('必含键齐全', () => {
    const doc = buildPlist({
      appName: '微信', bundleId: 'com.wexe.mac.tencent.wechat', version: '3.9.10',
    })
    for (const key of [
      'CFBundleName', 'CFBundleDisplayName', 'CFBundleIdentifier',
      'CFBundleExecutable', 'CFBundlePackageType', 'CFBundleIconFile',
      'CFBundleShortVersionString', 'CFBundleVersion', 'LSMinimumSystemVersion',
      'NSHighResolutionCapable', 'LSApplicationCategoryType',
    ]) {
      assert.ok(key in doc, `缺少 ${key}`)
    }
  })

  test('不设隐藏应用的键', () => {
    const doc = buildPlist({ appName: 'X', bundleId: 'com.wexe.mac.x.y', version: '1.0' })
    assert.equal('LSUIElement' in doc, false)
    assert.equal('LSBackgroundOnly' in doc, false)
  })

  test('显示名带 (Mac) 后缀', () => {
    const doc = buildPlist({ appName: 'Demo', bundleId: 'com.wexe.mac.a.b', version: '1.0' })
    assert.equal(doc.CFBundleDisplayName, 'Demo (Mac)')
  })

  test('默认不生成文档类型', () => {
    const doc = buildPlist({ appName: 'X', bundleId: 'com.wexe.mac.a.b', version: '1.0' })
    assert.equal('CFBundleDocumentTypes' in doc, false)
  })

  test('声明关联时生成文档类型', () => {
    const doc = buildPlist({
      appName: 'X', bundleId: 'com.wexe.mac.a.b', version: '1.0',
      fileAssociations: ['.txt', '.md'],
    })
    assert.equal(doc.CFBundleDocumentTypes.length, 1)
    assert.deepEqual(doc.CFBundleDocumentTypes[0].LSItemContentTypes,
      ['public.txt', 'public.md'])
  })

  test('序列化后通过文本校验', () => {
    const text = serializePlist(buildPlist({
      appName: 'A&B<C>', bundleId: 'com.wexe.mac.a.b', version: '1.0',
    }))
    assert.deepEqual(validatePlistText(text), [])
    assert.ok(text.includes('A&amp;B&lt;C&gt;'))
  })

  test('plutil 权威校验', { skip: !hasPlutil }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-plist-'))
    try {
      const path = join(root, 'Info.plist')
      await writeFile(path, serializePlist(buildPlist({
        appName: 'A&B<C>测试', bundleId: 'com.wexe.mac.a.b', version: '1.2.3-beta.1',
      })))
      const { stdout } = await execFileAsync('plutil', ['-lint', path])
      assert.match(stdout, /OK/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('plist 文本校验', () => {
  test('缺 XML 声明被抓出', () => {
    assert.ok(validatePlistText('<plist></plist>').some((p) => p.includes('XML 声明')))
  })

  test('标签不成对被抓出', () => {
    const text = '<?xml version="1.0"?>\n<plist><dict><key>a</key></plist>'
    assert.ok(validatePlistText(text).some((p) => p.includes('不成对')))
  })

  test('裸 & 被抓出', () => {
    const text = '<?xml version="1.0"?>\n<plist><dict><key>a</key><string>x & y</string></dict></plist>'
    const problems = validatePlistText(text)
    assert.ok(problems.some((p) => p.includes('未转义')))
  })

  test('合法实体不误报', () => {
    const text = '<?xml version="1.0"?>\n<plist><dict><key>a</key><string>&amp;&#65;</string></dict></plist>'
    assert.deepEqual(validatePlistText(text), [])
  })
})

describe('bundle 装配', () => {
  test('目录名带 (Mac).app', () => {
    assert.equal(bundleDirName('7-Zip'), '7-Zip (Mac).app')
    assert.equal(bundleDirName('微信'), '微信 (Mac).app')
  })

  test('名字里的斜杠被替换', () => {
    assert.equal(bundleDirName('a/b').includes('/'), false)
  })

  test('骨架幂等', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-bundle-'))
    try {
      const appDir = join(root, 'X (Mac).app')
      const first = await ensureSkeleton(appDir)
      const second = await ensureSkeleton(appDir)
      assert.deepEqual(first, second)
      for (const path of Object.values(second)) {
        assert.ok((await stat(path)).isDirectory())
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('完整装配产出正确结构', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-bundle-'))
    try {
      const payload = join(root, 'payload')
      await mkdir(payload, { recursive: true })
      await writeFile(join(payload, 'index.js'), 'code')

      const executable = join(root, 'MyApp')
      await writeFile(executable, '#!/bin/sh\n')

      const appDir = join(root, 'Demo (Mac).app')
      const result = await assembleBundle({
        appDir,
        appName: 'Demo',
        bundleId: 'com.wexe.mac.demo.app',
        version: '1.0.0',
        executable,
        payload,
      })

      assert.equal(result.paths.executable, 'Contents/MacOS/MyApp')
      for (const relative of [
        LAYOUT.plist, LAYOUT.pkgInfo, `${LAYOUT.macos}/MyApp`,
        `${LAYOUT.appPayload}/index.js`,
      ]) {
        assert.ok((await stat(join(appDir, relative))).isFile(), `缺少 ${relative}`)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('PkgInfo 内容是 APPL????', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-bundle-'))
    try {
      const payload = join(root, 'p')
      await mkdir(payload)
      const executable = join(root, 'X')
      await writeFile(executable, 'x')
      const appDir = join(root, 'X (Mac).app')
      await assembleBundle({
        appDir, appName: 'X', bundleId: 'com.wexe.mac.x.x',
        version: '1.0', executable, payload,
      })
      const content = await readFile(join(appDir, LAYOUT.pkgInfo), 'latin1')
      assert.equal(content, 'APPL????')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('非 .icns 图标被拒绝并说明原因', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-bundle-'))
    try {
      const icon = join(root, 'icon.ico')
      await writeFile(icon, 'fake')
      const appDir = join(root, 'X (Mac).app')
      await ensureSkeleton(appDir)
      await assert.rejects(
        () => installIcon(appDir, icon),
        /必须是 \.icns/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('不传图标时不报错', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w2m-bundle-'))
    try {
      const appDir = join(root, 'X (Mac).app')
      await ensureSkeleton(appDir)
      assert.equal(await installIcon(appDir, null), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('目录名字节上限', () => {
  /*
   * 这一组来自一个真实故障：90 个汉字的应用名（270 字节）能打包成功、
   * 报告「构建完成」，但 zip 条目名达 290 字节，超过文件系统 255 上限 ——
   * 产物解不开，是彻底的废包。
   *
   * 目录名之外还有 ` (Mac).app/Contents/Resources/` 与载荷路径，所以
   * 目录名本身的预算只有 165 字节。
   */

  test('短名原样保留', () => {
    const result = fitDirName('微信')
    assert.equal(result.name, '微信')
    assert.equal(result.truncated, false)
    assert.equal(result.bytes, 6)
  })

  test('刚好到上限不截断', () => {
    const name = '应'.repeat(55)   // 55 * 3 = 165
    const result = fitDirName(name)
    assert.equal(result.bytes, 165)
    assert.equal(result.truncated, false)
    assert.equal(result.name, name)
  })

  test('超一个字节就截断', () => {
    const name = '应'.repeat(56)   // 168 字节
    const result = fitDirName(name)
    assert.equal(result.truncated, true)
    assert.ok(result.bytes <= MAX_DIR_NAME_BYTES)
  })

  test('截断不切出半个汉字', () => {
    /*
     * 按字节直接 subarray 会把汉字切成 UTF-8 里的前一两字节，
     * 产出非法文件名。必须按码点累加。
     */
    const result = fitDirName('应'.repeat(200))
    assert.equal(result.name.includes('\ufffd'), false, '不能出现替换字符')
    assert.equal(Buffer.byteLength(result.name, 'utf8'), result.bytes)
    // 每个字都应完整
    assert.equal(result.name.length, result.bytes / 3)
  })

  test('emoji 按 4 字节计', () => {
    const result = fitDirName('🎉'.repeat(100))
    assert.ok(result.bytes <= MAX_DIR_NAME_BYTES)
    assert.equal(result.name.includes('\ufffd'), false)
  })

  test('混合中英文按字节累加', () => {
    const result = fitDirName('A'.repeat(100) + '应'.repeat(100))
    assert.ok(result.bytes <= MAX_DIR_NAME_BYTES)
    assert.equal(result.truncated, true)
  })

  test('空名返回空（由调用方兜底）', () => {
    assert.equal(fitDirName('   ').name, '')
  })

  test('替换路径分隔符', () => {
    assert.equal(fitDirName('a/b:c').name, 'a-b-c')
  })
})
