/**
 * Spike 测试。
 *
 * 跑法：cd apponwin && npm test
 *
 * ## 这套测试真正在守护什么
 *
 * 不是「spike 能通过」，而是**「环境不具备时绝不谎报通过」**。
 *
 * 一个兼容性工具最危险的失败模式是给出乐观的错判 —— 用户会据此投入
 * 一整天装 Darling 然后失败。所以本套的核心断言全部围绕：
 *
 *   - blocked ≠ pass
 *   - 整体结论在有任何 blocked 时必须是 unverified
 *   - 退出码 5 而非 0
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  GATE_STATUS, gatePlistParse, probeWsl, runSpike,
} from '../src/core/spike.mjs'

describe('WSL2 探测', () => {
  test('非 Windows 宿主明确报不可用', async () => {
    const result = await probeWsl()
    if (process.platform === 'win32') return   // 在 Windows 上跳过这条
    assert.equal(result.available, false)
    assert.match(result.reason, /不是 Windows/u)
    assert.deepEqual(result.distributions, [])
  })
})

describe('门槛 3：Info.plist 解析', () => {
  /** 造一个最小 .app。 */
  async function makeApp(root) {
    const appDir = join(root, 'Demo.app')
    await mkdir(join(appDir, 'Contents/MacOS'), { recursive: true })
    await writeFile(join(appDir, 'Contents/Info.plist'), `<?xml version="1.0"?>
<plist><dict>
  <key>CFBundleExecutable</key><string>Demo</string>
  <key>CFBundleIdentifier</key><string>com.example.demo</string>
</dict></plist>`)
    await writeFile(join(appDir, 'Contents/MacOS/Demo'), 'x')
    return appDir
  }

  test('合法 .app 通过', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aow-spike-'))
    try {
      const appDir = await makeApp(root)
      const gate = await gatePlistParse(appDir)
      assert.equal(gate.status, GATE_STATUS.PASS)
      assert.equal(gate.detail.executable, 'Demo')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('未提供样本时 blocked 而不是 pass', async () => {
    /*
     * 这条断言是整套测试的核心。
     *
     * 「没给样本」不等于「解析能力没问题」。把这种情况标成 pass，
     * 就会在没有验证的情况下宣称能力可用。
     */
    const gate = await gatePlistParse(null)
    assert.equal(gate.status, GATE_STATUS.BLOCKED)
    assert.match(gate.reason, /未提供/u)
  })

  test('缺 CFBundleExecutable 时 fail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aow-spike-'))
    try {
      const appDir = join(root, 'NoExe.app')
      await mkdir(join(appDir, 'Contents'), { recursive: true })
      await writeFile(join(appDir, 'Contents/Info.plist'),
        '<?xml version="1.0"?><plist><dict><key>CFBundleName</key><string>X</string></dict></plist>')
      const gate = await gatePlistParse(appDir)
      assert.equal(gate.status, GATE_STATUS.FAIL)
      assert.match(gate.reason, /CFBundleExecutable/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('主二进制不存在时 fail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aow-spike-'))
    try {
      const appDir = join(root, 'Missing.app')
      await mkdir(join(appDir, 'Contents'), { recursive: true })
      await writeFile(join(appDir, 'Contents/Info.plist'), `<?xml version="1.0"?>
<plist><dict><key>CFBundleExecutable</key><string>Ghost</string></dict></plist>`)
      const gate = await gatePlistParse(appDir)
      assert.equal(gate.status, GATE_STATUS.FAIL)
      assert.match(gate.reason, /不存在/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('plist 损坏时 fail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aow-spike-'))
    try {
      const appDir = join(root, 'Broken.app')
      await mkdir(join(appDir, 'Contents/MacOS'), { recursive: true })
      await writeFile(join(appDir, 'Contents/Info.plist'), 'not a plist at all')
      const gate = await gatePlistParse(appDir)
      assert.equal(gate.status, GATE_STATUS.FAIL)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('路径不存在时 fail', async () => {
    const gate = await gatePlistParse('/tmp/ghost-spike.app')
    assert.equal(gate.status, GATE_STATUS.FAIL)
  })
})

describe('完整 spike 结论', () => {
  /** 造一个合法 .app 供门槛 3 使用。 */
  async function makeApp(root) {
    const appDir = join(root, 'Demo.app')
    await mkdir(join(appDir, 'Contents/MacOS'), { recursive: true })
    await writeFile(join(appDir, 'Contents/Info.plist'), `<?xml version="1.0"?>
<plist><dict>
  <key>CFBundleExecutable</key><string>Demo</string>
  <key>CFBundleIdentifier</key><string>com.example.demo</string>
</dict></plist>`)
    await writeFile(join(appDir, 'Contents/MacOS/Demo'), 'x')
    return appDir
  }

  test('非 Windows 宿主上结论必须是 unverified', async () => {
    /*
     * 本机没有 WSL2 与 Darling，门槛 1 与 2 必然 blocked。
     * 结论必须是 unverified —— 绝不能是 accepted。
     */
    if (process.platform === 'win32') return

    const root = await mkdtemp(join(tmpdir(), 'aow-spike-'))
    try {
      const appDir = await makeApp(root)
      const result = await runSpike({ app: appDir })

      assert.equal(result.conclusion, 'unverified')
      assert.equal(result.decisiveGate, 2)

      const blocked = result.gates.filter((gate) => gate.status === GATE_STATUS.BLOCKED)
      assert.ok(blocked.length >= 2, '门槛 1 与 2 应因环境不具备而 blocked')

      const pass = result.gates.filter((gate) => gate.status === GATE_STATUS.PASS)
      assert.ok(pass.length >= 1, '门槛 3 不依赖 Darling，本机应能通过')

      assert.ok(result.notes.some((note) => note.includes('未验证')))
      assert.ok(result.notes.some((note) => note.includes('不是通过')))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('未提供任何样本时也不谎报通过', async () => {
    if (process.platform === 'win32') return
    const result = await runSpike({})
    assert.equal(result.conclusion, 'unverified')
    for (const gate of result.gates) {
      assert.notEqual(gate.status, GATE_STATUS.PASS)
    }
  })

  test('三条门槛齐全且带 id 与名称', async () => {
    const result = await runSpike({})
    assert.equal(result.gates.length, 3)
    const ids = result.gates.map((gate) => gate.id).sort()
    assert.deepEqual(ids, [1, 2, 3])
    for (const gate of result.gates) {
      assert.ok(typeof gate.name === 'string' && gate.name.length > 0)
      assert.ok(Object.values(GATE_STATUS).includes(gate.status))
      assert.ok(typeof gate.reason === 'string' && gate.reason.length > 0)
    }
  })

  test('门槛 2 标为决定性', async () => {
    const result = await runSpike({})
    const gate2 = result.gates.find((gate) => gate.id === 2)
    assert.equal(gate2.decisive, true)
  })

  test('结论只有三种取值', async () => {
    const result = await runSpike({})
    assert.ok(['accepted', 'rejected', 'unverified'].includes(result.conclusion))
  })
})

describe('门槛状态语义', () => {
  test('blocked 与 fail 是不同的常量', () => {
    /*
     * 这两个值如果混用，整套结论就失去意义：
     * blocked = 我不知道；fail = 我知道不行。
     */
    assert.notEqual(GATE_STATUS.BLOCKED, GATE_STATUS.FAIL)
    assert.equal(GATE_STATUS.PASS, 'pass')
    assert.equal(GATE_STATUS.FAIL, 'fail')
    assert.equal(GATE_STATUS.BLOCKED, 'blocked')
  })
})