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

  test('路径不存在时 blocked 而不是 fail', async () => {
    /*
     * 这条曾经断言 `fail`，是错的。
     *
     * `fail` 的语义是「实测执行并失败」—— 那要求先真的进了解析。路径
     * 不存在时门槛根本没执行，只能是 `blocked`。早先判 `fail` 的后果是
     * 整体结论变 `rejected`，把「路径打错」说成「AppOnWin 方向被证伪」。
     */
    const gate = await gatePlistParse('/tmp/ghost-spike.app')
    assert.equal(gate.status, GATE_STATUS.BLOCKED)
    assert.equal(gate.invalidInput, true)
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

  test('输入路径不存在时整体结论是 unverified 且标出 inputErrors', async () => {
    /*
     * 回归锁：早先这条路径会得到 `rejected`（「方向不成立」）。
     *
     * 把「路径打错」升级成「产品结论」是最坏的一类错 —— 用户会据此
     * 放弃一个可能成立的方向，或者去写一份不需要写的降级说明。
     */
    const result = await runSpike({ app: '/tmp/definitely-no-such-bundle.app' })
    assert.notEqual(result.conclusion, 'rejected')
    assert.equal(result.conclusion, 'unverified')
    assert.ok(result.inputErrors.length >= 1, '必须把输入路径错误单独列出来')
    assert.ok(result.notes.some((note) => note.includes('输入路径不合法')))
    assert.ok(result.notes.some((note) => note.includes('不是方向不成立')))
  })

  test('Mach-O 样本路径不存在时该门槛是 blocked 而不是 fail', async () => {
    const result = await runSpike({ sample: '/tmp/definitely-no-such-binary' })
    const gate1 = result.gates.find((gate) => gate.id === 1)
    assert.equal(gate1.status, GATE_STATUS.BLOCKED)
    assert.equal(gate1.invalidInput, true)
    assert.notEqual(result.conclusion, 'rejected')
  })

  test('输入路径正确但命中环境缺失时不算 inputError', async () => {
    /*
     * 反向断言：不能为了修上一个缺陷，把「环境不具备」也归到「路径写错」。
     * 两者对用户的下一步动作完全不同 —— 一个改路径，一个装 WSL2。
     */
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'aow-spike-'))
    try {
      const appDir = await makeApp(root)
      const result = await runSpike({ app: appDir })
      assert.equal(result.conclusion, 'unverified')
      assert.deepEqual(result.inputErrors, [])
      assert.ok(result.notes.some((note) => note.includes('环境不具备')))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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