/**
 * 工具定义与方向表的一致性测试。
 *
 * ## 为什么要专门测这个
 *
 * 工具定义（`ai/src/tools.mjs`）和方向表（`console/src/directions.mjs`）
 * 是两份独立维护的数据。它们描述同一件事：某个方向支持哪些子命令。
 *
 * 两份数据必然分叉 —— 有人在方向表里加了新子命令，忘了在工具定义里补。
 * 后果很隐蔽：agent 拿到的工具表是旧的，它不会去调那个新能力，用户问起
 * 时它会说「本项目不支持」。这不是 agent 的错，是我们的表漏了。
 *
 * 所以这里逐条比对。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { BUILD_SPECS, TOOLS, VERIFY_SPECS, buildArgv, verifyArgv } from '../src/tools.mjs'
import { DIRECTIONS } from '../../console/src/directions.mjs'

describe('工具定义基本约束', () => {
  test('工具名唯一', () => {
    const names = TOOLS.map((tool) => tool.name)
    assert.equal(new Set(names).size, names.length, '工具名不能重复')
  })

  test('每个工具的 inputSchema 都是闭合对象', () => {
    /*
     * `additionalProperties: false` 很重要：客户端据此校验参数，
     * 拼错的参数名会被立即拒绝，而不是被静默忽略。静默忽略的后果是
     * agent 以为传了 `dryrun`，实际没生效，于是它报告「跑了构建」
     * 而其实是真跑了一遍。
     */
    for (const tool of TOOLS) {
      assert.equal(
        tool.inputSchema.additionalProperties, false,
        `${tool.name} 的 inputSchema 应闭合`,
      )
    }
  })

  test('required 里列出的字段都在 properties 里', () => {
    for (const tool of TOOLS) {
      const required = tool.inputSchema.required ?? []
      for (const field of required) {
        assert.ok(
          field in tool.inputSchema.properties,
          `${tool.name} 的 required 含 ${field}，但 properties 里没有`,
        )
      }
    }
  })

  test('枚举型字段的取值都在 enum 里可枚举', () => {
    for (const tool of TOOLS) {
      for (const [key, schema] of Object.entries(tool.inputSchema.properties)) {
        if (schema.type === 'string' && Array.isArray(schema.enum)) {
          assert.ok(schema.enum.length > 0, `${tool.name}.${key} 的 enum 不该为空`)
        }
      }
    }
  })

  test('描述里说明了副作用', () => {
    /*
     * agent 靠 description 判断该不该调。会写盘的工具若不说清，
     * 它可能在用户只是想了解情况时跑一次几分钟的构建。
     */
    const build = TOOLS.find((tool) => tool.name === 'wacmin_build')
    assert.match(build.description, /写盘|耗时/u)
    const doctor = TOOLS.find((tool) => tool.name === 'wacmin_doctor')
    assert.match(doctor.description, /只读|不写/u)
  })
})

describe('与方向表一致', () => {
  test('build 支持的方向都在方向表里', () => {
    for (const direction of Object.keys(BUILD_SPECS)) {
      assert.ok(
        DIRECTIONS[direction] !== undefined,
        `BUILD_SPECS 里的 ${direction} 不在方向表中`,
      )
    }
  })

  test('build 支持的方向确实声明了 build 子命令', () => {
    /*
     * 这条防的是「工具说有、方向说没有」。
     * agent 照着工具表调 build，方向回「未知子命令」—— 用户看到的是
     * 一个自相矛盾的产品。
     */
    for (const direction of Object.keys(BUILD_SPECS)) {
      assert.ok(
        DIRECTIONS[direction].subcommands.includes('build'),
        `${direction} 声明了 build 参数表，但方向表里没有 build 子命令`,
      )
    }
  })

  test('声明了 build 子命令的方向都有参数表', () => {
    /*
     * 反向：方向说有 build，工具表却没有。agent 于是永远调不到它。
     */
    for (const [direction, spec] of Object.entries(DIRECTIONS)) {
      if (spec.subcommands.includes('build')) {
        assert.ok(
          BUILD_SPECS[direction] !== undefined,
          `${direction} 有 build 子命令，但工具定义里没有它的参数表`,
        )
      }
    }
  })

  test('verify 参数表覆盖所有方向', () => {
    for (const direction of Object.keys(DIRECTIONS)) {
      assert.ok(
        VERIFY_SPECS[direction] !== undefined,
        `${direction} 缺 verify 参数表`,
      )
    }
  })

  test('apponwin 不在 build 参数表里', () => {
    /*
     * apponwin 的设计目标就是评估，没有 build 子命令。
     * 给它写参数表会让工具表说谎。
     */
    assert.equal(BUILD_SPECS.apponwin, undefined)
    assert.ok(!DIRECTIONS.apponwin.subcommands.includes('build'))
  })

  test('构建工具把 project 与 installer 都列出来', () => {
    /*
     * 两者描述同一件事（本次构建的主输入）但名字不同。只列 `project`
     * 并写「exeonmac 传安装包路径」，agent 会照着字段名理解成「项目目录」，
     * 然后困惑于「安装包不是目录」。
     *
     * 而 `required` 表达不了「按方向二选一」，所以两个都不设 required，
     * 由翻译层按方向校验。
     */
    const build = TOOLS.find((tool) => tool.name === 'wacmin_build')
    assert.ok('project' in build.inputSchema.properties)
    assert.ok('installer' in build.inputSchema.properties)
    assert.equal(build.inputSchema.required.includes('project'), false)
    assert.equal(build.inputSchema.required.includes('installer'), false)
    assert.ok(build.inputSchema.required.includes('direction'))
    assert.match(build.description, /installer/u, '描述里要说清 exeonmac 用 installer')
  })

  test('工具声明的方向枚举与方向表一致', () => {
    const build = TOOLS.find((tool) => tool.name === 'wacmin_build')
    const declared = build.inputSchema.properties.direction.enum
    for (const direction of declared) {
      assert.ok(DIRECTIONS[direction] !== undefined, `${direction} 不在方向表中`)
    }

    const list = TOOLS.find((tool) => tool.name === 'wacmin_list_directions')
    // list 不需要参数，但它的存在意味着能列出全部方向
    assert.deepEqual(list.inputSchema.properties, {})
  })
})

describe('参数翻译', () => {
  /**
   * 各方向的最简合法参数。
   *
   * 字段名确实不同：mac2win / win2mac 要 `project`（项目目录），
   * exeonmac 要 `installer`（Windows 安装包路径）—— 后者没有「项目」，
   * 它的输入就是一个包。用统一名字会在翻译层静默丢参数。
   */
  const MINIMAL = {
    mac2win: { project: '/tmp/p' },
    win2mac: { project: '/tmp/p', executable: '/tmp/p/App' },
    exeonmac: { installer: '/tmp/setup.exe' },
  }

  test('buildArgv 对每个方向的最简参数都不抛异常', () => {
    for (const [direction, args] of Object.entries(MINIMAL)) {
      assert.doesNotThrow(
        () => buildArgv(direction, args),
        `${direction} 的最简参数不该抛异常`,
      )
    }
  })

  test('缺主位置参数时明确报错而不是产出残缺命令', () => {
    /*
     * 早先只读 `args.project`，于是 exeonmac 的 installer 被整条丢掉，
     * 命令变成 `wepack build -o /tmp/o`，argparse 报「缺少 installer」——
     * 报错指向参数缺失，而真实原因是翻译层漏了字段。
     */
    assert.throws(() => buildArgv('exeonmac', { out: '/tmp/o' }), /installer/u)
    assert.throws(() => buildArgv('mac2win', { out: '/tmp/o' }), /project/u)
  })

  test('buildArgv 未知方向明确报错', () => {
    assert.throws(() => buildArgv('__x__', { project: '/tmp/p' }), /不支持构建/u)
  })

  test('apponwin 不在可构建方向里', () => {
    /*
     * 它没有 build 子命令。工具表若给它留位置，agent 就会去调，
     * 然后拿到「未知子命令」—— 一个自相矛盾的产品。
     */
    assert.throws(() => buildArgv('apponwin', { project: '/tmp/p' }), /不支持构建/u)
  })

  test('verifyArgv 未知方向明确报错', () => {
    assert.throws(() => verifyArgv('__x__', { artifact: '/tmp/a' }), /不支持校验/u)
  })

  test('主位置参数总在首位', () => {
    for (const [direction, args] of Object.entries(MINIMAL)) {
      const full = {
        ...args,
        out: '/tmp/out',
        name: 'Demo',
        version: '1.0.0',
      }
      const argv = buildArgv(direction, full)
      const expected = args.project ?? args.installer
      assert.equal(argv[0], expected, `${direction} 的主参数应在首位`)
    }
  })

  test('布尔 false 不产生任何 flag', () => {
    const argv = buildArgv('mac2win', {
      project: '/tmp/p',
      dryRun: false,
      alsoZip: false,
      keepWork: false,
      strictHost: false,
    })
    for (const flag of ['--dry-run', '--also-zip', '--keep-work', '--strict-host']) {
      assert.ok(!argv.includes(flag), `${flag} 不该出现`)
    }
  })

  test('布尔 true 产生对应 flag', () => {
    const argv = buildArgv('mac2win', { project: '/tmp/p', dryRun: true, alsoZip: true })
    assert.ok(argv.includes('--dry-run'))
    assert.ok(argv.includes('--also-zip'))
  })

  test('空字符串参数被丢弃而不是产生空值', () => {
    /*
     * `--out ""` 会让各方向把空字符串当输出目录，然后在写盘时才发现
     * 路径非法 —— 白白跑一遍预检。
     */
    const argv = buildArgv('mac2win', { project: '/tmp/p', out: '', name: '' })
    assert.ok(!argv.includes('--out'))
    assert.ok(!argv.includes('--name'))
  })

  test('win2mac 的 executable 被正确翻译', () => {
    const argv = buildArgv('win2mac', {
      project: '/tmp/p',
      executable: '/tmp/p/MyApp',
    })
    assert.ok(argv.includes('--executable'))
    assert.ok(argv.includes('/tmp/p/MyApp'))
  })

  test('exeonmac 用 -o 而不是 --out', () => {
    /*
     * exeonmac 是 Python argparse，短选项是 `-o`。用 `--out` 也能通
     * （argparse 会匹配长名），但既然参数表照着实测的 --help 写，
     * 就用实测的形式。
     */
    const argv = buildArgv('exeonmac', { installer: '/tmp/setup.exe', out: '/tmp/o' })
    assert.equal(argv[0], '/tmp/setup.exe')
    assert.ok(argv.includes('-o'))
    assert.ok(argv.includes('/tmp/o'))
  })

  test('verifyArgv 的产物路径在首位', () => {
    for (const direction of Object.keys(VERIFY_SPECS)) {
      const argv = verifyArgv(direction, { artifact: '/tmp/a.exe' })
      assert.equal(argv[0], '/tmp/a.exe', `${direction} 的产物路径应在首位`)
    }
  })

  test('extraArgs 被追加在末尾', () => {
    const argv = buildArgv('mac2win', {
      project: '/tmp/p',
      extraArgs: ['--verbose', '--compression', 'zlib'],
    })
    assert.deepEqual(argv.slice(-3), ['--verbose', '--compression', 'zlib'])
  })

  test('extraArgs 里的非字符串被转成字符串', () => {
    /*
     * `spawn` 的 args 数组里出现数字会让 Node 抛 TypeError，
     * 而这发生在起进程那一刻，错误信息与「参数里有个数字」无关。
     */
    const argv = buildArgv('mac2win', { project: '/tmp/p', extraArgs: [1, true] })
    assert.ok(argv.every((item) => typeof item === 'string'))
  })
})
