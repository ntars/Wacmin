/**
 * NSIS 脚本生成的测试。
 *
 * 这里不跑 makensis（那是集成测试的事），只验证**生成的脚本内容**
 * 是否包含正确的关键指令。理由：makensis 的报错会指出行号，但
 * 「少了一条 WriteRegStr」这类错误 makensis 不会报——它照样能编译
 * 成功，只是装完在控制面板里看不到卸载项。那种缺陷只能靠内容断言抓。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderNsisScript, escapeNsis, toFourPartVersion } from '../src/core/nsis.mjs'

/** 一份最小的配置，够生成脚本。 */
function makeConfig(overrides = {}) {
  return {
    productName: '测试应用',
    version: '1.2.3',
    publisher: '星玖工作室',
    identifier: 'com.example.test',
    requireAdmin: false,
    compression: 'lzma',
    desktopShortcut: true,
    ...overrides,
  }
}

/** 生成脚本。 */
function render(config) {
  return renderNsisScript({
    config,
    stagingAppDir: '/tmp/staging/app',
    outputFile: '/tmp/out/setup.exe',
  })
}

test('转义 $ 与双引号', () => {
  assert.equal(escapeNsis('a$b'), 'a$$b')
  assert.equal(escapeNsis('say "hi"'), 'say $\\"hi$\\"')
})

test('版本号补成四段', () => {
  assert.equal(toFourPartVersion('1.0'), '1.0.0.0')
  assert.equal(toFourPartVersion('1.2.3'), '1.2.3.0')
  assert.equal(toFourPartVersion('1.0.3-alpha'), '1.0.3.0')
  assert.equal(toFourPartVersion('2.0.0.1'), '2.0.0.1')
})

test('包含必需的头部指令', () => {
  const script = render(makeConfig())
  assert.match(script, /^Unicode true$/m)
  assert.match(script, /^Name "测试应用"$/m)
  assert.match(script, /^OutFile "\/tmp\/out\/setup\.exe"$/m)
  assert.match(script, /SetCompressor \/SOLID lzma/)
  assert.match(script, /!include "MUI2\.nsh"/)
})

test('安装路径落在 $INSTDIR\\app，与启动器契约一致', () => {
  const script = render(makeConfig())
  // 这一条最关键：File /r 展开的是内容，SetOutPath 必须自己补 app 这一层。
  assert.match(script, /SetOutPath "\$INSTDIR\\app"/)
  // 源路径统一成 /（makensis 在 mac 上跑，File 的源是宿主路径）。
  assert.match(script, /File \/r "\/tmp\/staging\/app\/\*\.\*"/)
})

test('注册表写入参数个数正确', () => {
  const script = render(makeConfig())
  // WriteRegStr 必须 4 个参数：根键、子键、值名、值。
  // 曾经写成 3 个（把 HKCU\Software\... 合并成一串），makensis 直接报错。
  const lines = script.split('\n').filter((line) => line.includes('WriteRegStr'))
  assert.ok(lines.length > 0, '应该有注册表写入')
  for (const line of lines) {
    // 值本身可能用单引号包裹（UninstallString 带引号路径时需要），
    // 所以最后一个参数两种引号都接受。
    assert.match(
      line,
      /^\s*WriteRegStr HKCU "[^"]+" "[^"]+" (".*"|'.*')$/,
      `参数格式不对：${line}`,
    )
  }
})

test('卸载项包含控制面板需要的全部字段', () => {
  const script = render(makeConfig())
  for (const field of ['DisplayName', 'DisplayVersion', 'Publisher', 'DisplayIcon', 'UninstallString', 'InstallLocation']) {
    assert.match(script, new RegExp(`"${field}"`), `缺 ${field}，控制面板会显示不全`)
  }
})

test('快捷方式指向 node.exe 并带启动器参数', () => {
  const script = render(makeConfig())
  assert.match(script, /CreateShortCut "[^"]*测试应用\.lnk" "\$INSTDIR\\app\\node\.exe" '"\$INSTDIR\\app\\bootstrap\\bootstrap\.mjs"'/)
})

test('关掉桌面快捷方式时不生成桌面项', () => {
  const script = render(makeConfig({ desktopShortcut: false }))
  assert.doesNotMatch(script, /CreateShortCut "\$DESKTOP/)
})

test('需要管理员权限时装到 Program Files', () => {
  const script = render(makeConfig({ requireAdmin: true }))
  assert.match(script, /InstallDir "\$PROGRAMFILES\\测试应用"/)
  assert.match(script, /RequestExecutionLevel admin/)
})

test('默认装到用户目录，不需要提权', () => {
  const script = render(makeConfig())
  assert.match(script, /InstallDir "\$LOCALAPPDATA\\Programs\\测试应用"/)
  assert.match(script, /RequestExecutionLevel user/)
})

test('卸载时递归删 app 目录', () => {
  const script = render(makeConfig())
  assert.match(script, /RMDir \/r "\$INSTDIR\\app"/)
})

test('压缩选项映射正确', () => {
  assert.match(render(makeConfig({ compression: 'zlib' })), /SetCompressor \/SOLID zlib/)
  assert.match(render(makeConfig({ compression: 'none' })), /SetCompressor off/)
})

test('产品名里的 $ 被转义，不会当成变量', () => {
  const script = render(makeConfig({ productName: 'App$Name' }))
  assert.match(script, /Name "App\$\$Name"/)
})
