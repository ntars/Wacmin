#!/usr/bin/env node
/**
 * 发布验收清单的可执行版本（README 18.5 的权威执行入口）。
 *
 * 设计取舍：
 * - 只调用各模块自己的入口，不重新实现测试或契约逻辑；文档说怎么验，
 *   这里就按文档原样跑，避免「验收脚本自己另立一套标准」。
 * - 产物检查分两层：默认只验报告（可在任意机器重跑）；只有传入
 *   --artifacts 时才验证本机实测留下的真实 .exe / .app 产物。
 * - 不引入第三方依赖：Node 标准库的 spawnSync 足够。
 *
 * 用法：
 *   node contracts/acceptance.mjs
 *   node contracts/acceptance.mjs --artifacts
 *   node contracts/acceptance.mjs --root /path/to/Wacmin --skip-exeonmac-tests
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = join(HERE, '..')

function parseArgs(argv) {
  const opts = {
    root: DEFAULT_ROOT,
    artifacts: false,
    skipExeonmacTests: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--artifacts') opts.artifacts = true
    else if (arg === '--skip-exeonmac-tests') opts.skipExeonmacTests = true
    else if (arg === '--root' && argv[i + 1]) opts.root = argv[++i]
    else {
      process.stderr.write(`未知参数：${arg}\n`)
      process.exit(2)
    }
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
const results = []

/** 跑一条命令；expect 可追加输出断言，防止「退出 0 但内容空转」。 */
function run(name, cmd, args, { cwd = opts.root, expect, timeoutMs = 900000 } = {}) {
  const started = Date.now()
  // node --test 的通配符由 shell 展开；其余命令不用 shell，避免参数被二次解释。
  const useShell = cmd === 'node' && args[0] === '--test'
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, shell: useShell })
  const out = ((r.stdout || '') + (r.stderr || '')).trim()
  const ok = r.status === 0 && (!expect || expect(out))
  results.push({ name, ok, status: r.status, durationMs: Date.now() - started, tail: out.split('\n').slice(-5).join('\n') })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name} (rc=${r.status}, ${Date.now() - started}ms)\n`)
  if (!ok) process.stdout.write(out.slice(-4000) + '\n')
  return ok
}

const NODE_TESTS = {
  mac2win: ['node', ['--test', 'test/*.test.mjs']],
  win2mac: ['node', ['--test', 'test/*.test.mjs']],
  apponwin: ['node', ['--test', 'test/*.test.mjs']],
  console: ['node', ['--test', 'test/*.test.mjs']],
  ai: ['node', ['--test', 'test/*.test.mjs']],
  contracts: ['node', ['--test', '*.test.mjs']],
}

// 仓库级门禁：契约、文档、四方向入口。
run('validate', 'node', ['contracts/validate.mjs'])
run('doc-counts', 'node', ['contracts/doc-counts.mjs', '--check'])
run('console-contract', 'node', ['console/bin/wacmin-console.mjs', 'contract'])
run('console-doctor', 'node', ['console/bin/wacmin-console.mjs', 'doctor'])
run('exeonmac-deps', 'python3', ['tests/check_deps.py'], { cwd: join(opts.root, 'exeonmac') })

// 各模块全量测试。这里用 shell 展开通配符，行为与开发者在终端里一致。
for (const [dir, [cmd, args]] of Object.entries(NODE_TESTS)) {
  run(`tests:${dir}`, cmd, args, { cwd: join(opts.root, dir), shell: true })
}
if (!opts.skipExeonmacTests) {
  run('tests:exeonmac', 'python3', ['-m', 'unittest', 'discover', '-s', 'tests'], {
    cwd: join(opts.root, 'exeonmac'),
    expect: out => out.includes('OK'),
  })
}

// 报告与产物：默认只查 verifiable 的报告；--artifacts 才要求本机实测文件在。
const evidenceDir = process.env.WACMIN_EVIDENCE_DIR || join(opts.root, '.acceptance')
const e2eExe = join(evidenceDir, 'e2e-1.0.0-x86-setup.exe')
const e2eReport = join(evidenceDir, 'report.json')
const wexeReport = join(evidenceDir, 'wepack-build.json')

if (opts.artifacts) {
  if (existsSync(e2eExe)) {
    run('mac2win-verify', 'node', ['mac2win/bin/mac2win.mjs', 'verify', e2eExe])
  } else {
    results.push({ name: 'mac2win-verify', ok: false, status: null, tail: `缺少 ${e2eExe}` })
    process.stdout.write(`FAIL mac2win-verify (缺少产物)\n`)
  }
} else if (existsSync(e2eExe)) {
  run('mac2win-verify', 'node', ['mac2win/bin/mac2win.mjs', 'verify', e2eExe])
}
if (existsSync(e2eReport)) {
  run('mac2win-report', 'node', ['contracts/validate.mjs', '--report', e2eReport])
}
if (existsSync(wexeReport)) {
  run('wepack-build-report', 'python3', ['-c',
    `import json,sys; d=json.load(open(sys.argv[1])); assert d['ok']; checks=d['package']['checks']; assert len(checks)==10 and all(c['ok'] for c in checks); assert d['install']['verify']['passed']`,
    wexeReport,
  ])
}
run('viewport-check', 'node', ['scripts/viewport-check.mjs'], { cwd: join(opts.root, 'console') })

const failed = results.filter(r => !r.ok)
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`)
if (failed.length) {
  process.stderr.write(`失败项：${failed.map(r => r.name).join(', ')}\n`)
  process.exit(1)
}
