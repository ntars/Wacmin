/**
 * 进程树终止的平台分支（W-05 跨平台可运行性巡检产物）。
 *
 * ## 为什么这一条值得单独测
 *
 * `killTree` 是超时与取消的**唯一兜底**。它的 Windows 分支在本机
 * （darwin）永远走不到，而这条分支出了错，症状是「取消成功了，
 * 但 wine 还在后台装东西」—— 用户以为停了，磁盘和 CPU 还在动，
 * 下一次构建撞上前一次的残留锁。
 *
 * 更麻烦的是**它不会报错**：`taskkill` 万一参数拼错，也只是杀不掉，
 * 子进程照常运行，父进程照常退出并报「已取消」。所有测试都能绿。
 *
 * ## 测法
 *
 * 把平台与 `spawn` 都做成可注入，然后：
 *
 *   1. 注入 win32，断言调的是 `taskkill`，且参数恰好是 `/pid N /t /f`
 *      —— `/t` 是「按树杀」的唯一手段，漏了它就留下孤儿
 *   2. 注入 win32 但 taskkill 抛错，断言不崩、退回 `child.kill`
 *   3. 注入 darwin，断言走 `process.kill(-pid)` 而不是 taskkill
 *
 * 三条都不真的杀进程：注入的 `spawn` 只记录调用，`child` 是假对象。
 * 这样测试可以跑在任何一个平台上，也不需要管理员权限。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { killTree } from '../src/directions.mjs'

/** 记录 spawn 调用的假实现。 */
function recorder(behaviour = 'ok') {
  const calls = []
  const fn = (command, args, options) => {
    calls.push({ command, args, options })
    if (behaviour === 'throw') throw new Error('taskkill 不存在')
    return { on() {}, unref() {} }
  }
  fn.calls = calls
  return fn
}

/** 假子进程：只带 pid 与可被调用的 kill。 */
function fakeChild(pid = 4321) {
  const kills = []
  return {
    pid,
    kill: (signal) => { kills.push(signal) },
    kills,
  }
}

describe('killTree 的 Windows 分支', () => {
  test('调 taskkill 且带 /t（按树杀）', () => {
    /*
     * `/t` 不能漏。没有它，taskkill 只结束直接子进程，
     * `python3 -m wepack` 拉起的 wine / 7z 会变成孤儿继续跑。
     * 这正是 detach 在 POSIX 上用进程组、在 Windows 上用 /t 的对应关系。
     */
    const spawnFn = recorder()
    const child = fakeChild(4321)

    const result = killTree(child, 'SIGTERM', { platform: 'win32', spawnFn })

    assert.equal(spawnFn.calls.length, 1, '应恰好调用一次 taskkill')
    const call = spawnFn.calls[0]
    assert.equal(call.command, 'taskkill')
    assert.deepEqual(call.args, ['/pid', '4321', '/t', '/f'],
      `参数不对：${JSON.stringify(call.args)}`)
    assert.equal(call.options.stdio, 'ignore',
      'taskkill 的输出不该混进 console 的 stdout/stderr')

    assert.equal(result.method, 'taskkill', '返回值应标明走了哪条路径')
    assert.deepEqual(child.kills, [], 'Windows 分支不应再调 child.kill')
  })

  test('taskkill 失败时退回 child.kill，不抛错', () => {
    /*
     * taskkill 可能不存在（精简版 Windows）、可能权限不足。
     * 这时必须退回直接 kill —— 杀不干净总比「一个都没杀」好，
     * 而且不能让调用方在「正在取消」的路径上再抛一次异常。
     */
    const spawnFn = recorder('throw')
    const child = fakeChild(99)

    assert.doesNotThrow(() => killTree(child, 'SIGKILL', { platform: 'win32', spawnFn }))
    assert.deepEqual(child.kills, ['SIGKILL'], '应退回 child.kill 并传原信号')
  })

  test('pid 缺失时什么都不做', () => {
    /*
     * spawn 失败时 child.pid 是 undefined。此时 taskkill /pid undefined
     * 会去杀一个叫 "undefined" 的进程（不存在，报错），纯噪声；
     * POSIX 上 process.kill(-undefined) 更会变成 kill(NaN)。
     */
    const spawnFn = recorder()
    const child = { pid: undefined, kill: () => {} }

    const result = killTree(child, 'SIGTERM', { platform: 'win32', spawnFn })
    assert.equal(result.method, 'none')
    assert.deepEqual(spawnFn.calls, [])
  })
})

describe('killTree 的 POSIX 分支', () => {
  test('darwin 上走进程组而不是 taskkill', () => {
    /*
     * POSIX 的等价手段是 `kill(-pid)`：负号表示「整个进程组」。
     * 若这里退化成 `child.kill()`，只杀直接子进程，wine 照样变孤儿。
     *
     * 用真实 pid 会真的去杀进程，所以这条只断言**没有调 taskkill**
     * 与返回值，不去真的执行 process.kill。返回值是 method: 'group'
     * 还是 'direct' 取决于 pid 是否存在 —— 这里用一个几乎肯定不存在的
     * 高位 pid，让 process.kill 抛 ESRCH，落进 catch 的 direct 分支，
     * 顺带验证「杀不掉也不能崩」。
     */
    const spawnFn = recorder()
    const child = fakeChild(2147483000)

    const result = killTree(child, 'SIGTERM', { platform: 'darwin', spawnFn })

    assert.deepEqual(spawnFn.calls, [], 'darwin 上不该出现 taskkill')
    assert.ok(['group', 'direct'].includes(result.method),
      `返回值应说明实际路径，实际 ${result.method}`)
  })

  test('默认平台取本机，不因注入参数而变', () => {
    /*
     * 注入参数不能改变默认行为。这条防止「加了 options 但读取写错，
     * 例如 `options.platform ?? 'win32'`」，那会让所有 POSIX 用户
     * 悄悄走上 taskkill 分支 —— 而 taskkill 在 mac 上根本不存在。
     */
    const spawnFn = recorder()
    const child = fakeChild(2147483000)
    const result = killTree(child, 'SIGTERM', { spawnFn })

    if (process.platform === 'win32') {
      assert.equal(result.method, 'taskkill')
    } else {
      assert.deepEqual(spawnFn.calls, [], '本机不是 Windows，不该调 taskkill')
    }
  })
})
