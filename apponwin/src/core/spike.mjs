/**
 * Spike：三条门槛的可行性验证。
 *
 * ## 这个模块最重要的设计原则
 *
 * **环境不具备时，明确报「无法验证」，绝不假装通过。**
 *
 * 一个兼容性工具最危险的失败模式不是「判定错误」，而是「在没验证的
 * 情况下给出乐观结论」。用户会据此投入一整天去装 Darling，然后失败。
 *
 * 因此三条门槛各有三种状态：
 *
 * | 状态 | 含义 |
 * |---|---|
 * | `pass` | 实际执行并成功 |
 * | `fail` | 实际执行并失败 |
 * | `blocked` | 环境不具备，无法执行 |
 *
 * `blocked` 与 `fail` 必须严格区分：前者说明「我不知道」，后者说明
 * 「我知道不行」。混为一谈会让结论失去意义。
 *
 * ## 三条门槛
 *
 * | # | 门槛 | 判据 | 决定性 |
 * |---|---|---|---|
 * | 1 | WSL2 内装 Darling，跑通最简命令行 Mach-O | 输出预期字符串 | 否 |
 * | 2 | 能加载最简 AppKit 窗口 | 屏幕上出现白框 | **是** |
 * | 3 | 能读 Info.plist 并定位主二进制 | 正确解析 CFBundleExecutable | 否 |
 *
 * 门槛 3 不依赖 Darling，任何平台都能验 —— 所以它在本机就能跑通。
 * 门槛 1 与 2 必须真的在 WSL2 + Darling 环境里执行。
 */

import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseAppBundle } from './assess.mjs'

/** 门槛状态常量。 */
export const GATE_STATUS = {
  PASS: 'pass',
  FAIL: 'fail',
  BLOCKED: 'blocked',
}

/**
 * 探测命令是否可执行。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {number} [timeout]
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code: string|null}>}
 */
function probe(command, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, stdout: String(stdout), stderr: String(stderr), code: null })
          return
        }
        const code = error.code ?? null
        resolve({
          ok: false,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: code === null ? null : String(code),
        })
      })
  })
}

/**
 * 探测 WSL2 可用性。
 *
 * 只在 Windows 上有意义。返回结构里带上「为什么不可用」，让报告能
 * 给出可操作的下一步。
 *
 * @returns {Promise<object>}
 */
export async function probeWsl() {
  if (process.platform !== 'win32') {
    return {
      available: false,
      reason: `宿主是 ${process.platform}，不是 Windows。WSL2 只在 Windows 上可用。`,
      distributions: [],
    }
  }

  const result = await probe('wsl.exe', ['--list', '--quiet'])
  if (!result.ok) {
    return {
      available: false,
      reason: 'wsl.exe 执行失败，可能未启用 WSL2 或未安装任何发行版。',
      detail: result.stderr.trim() || result.stdout.trim(),
      distributions: [],
    }
  }

  /*
   * wsl --list 输出是 UTF-16LE，Node 按 utf8 读会得到带 \0 的乱码。
   * 这里做一次清理：去掉 NUL 与首尾空白。
   */
  const cleaned = result.stdout.replace(/\0/g, '').trim()
  const distributions = cleaned.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)

  return {
    available: distributions.length > 0,
    reason: distributions.length > 0 ? null : 'WSL2 已启用但没有安装任何发行版。',
    distributions,
  }
}

/**
 * 探测 WSL2 内的 Darling。
 *
 * @returns {Promise<object>}
 */
export async function probeDarling() {
  const wsl = await probeWsl()
  if (!wsl.available) {
    return {
      available: false,
      reason: 'WSL2 不可用，Darling 无法探测。',
      wsl,
      version: null,
    }
  }

  const result = await probe('wsl.exe', ['-e', 'sh', '-c', 'command -v darling && darling --version 2>&1 || echo NOT_FOUND'], 20000)
  const output = result.stdout.replace(/\0/g, '').trim()

  if (output === '' || output === 'NOT_FOUND' || output.includes('NOT_FOUND')) {
    return {
      available: false,
      reason: 'WSL2 内未安装 Darling。',
      hint: '在 WSL2 里按 https://docs.darlinghq.org/build-instructions.html 构建安装。',
      wsl,
      version: null,
    }
  }

  return {
    available: true,
    reason: null,
    wsl,
    version: output.split(/\r?\n/u)[0],
  }
}

/**
 * 跑门槛 1：命令行 Mach-O。
 *
 * 做法：在 WSL2 里用 darling 跑一个最小的 shell 脚本包装的 Mach-O。
 * 若 darling 可用但没有任何 Mach-O 样本，状态为 blocked 而不是 pass ——
 * 没有样本就没有验证。
 *
 * @param {string | null} samplePath 本机上的 Mach-O 样本路径。
 * @returns {Promise<object>}
 */
export async function gateCommandLine(samplePath) {
  const darling = await probeDarling()
  if (!darling.available) {
    return {
      id: 1,
      name: '命令行 Mach-O',
      status: GATE_STATUS.BLOCKED,
      reason: darling.reason,
      hint: darling.hint ?? null,
    }
  }

  if (samplePath === null) {
    return {
      id: 1,
      name: '命令行 Mach-O',
      status: GATE_STATUS.BLOCKED,
      reason: 'Darling 可用，但未提供 Mach-O 样本（--sample）。',
      hint: '传一个已知可用的命令行 Mach-O，例如 /bin/echo 的副本。',
    }
  }

  const exists = await stat(samplePath).then((s) => s.isFile()).catch(() => false)
  if (!exists) {
    return {
      id: 1,
      name: '命令行 Mach-O',
      status: GATE_STATUS.FAIL,
      reason: `样本不存在：${samplePath}`,
    }
  }

  /*
   * 通过 WSL2 访问 Windows 侧文件：/mnt/<盘符>/...
   * 这里不试图自动转换路径 —— 转换规则在 WSL2 里由 wslpath 负责，
   * 让 WSL2 自己算更可靠。
   */
  const script = `p=$(wslpath '${samplePath.replace(/'/g, "'\\''")}') && darling "$p" spike-ok 2>&1`
  const result = await probe('wsl.exe', ['-e', 'sh', '-c', script], 60000)
  const output = result.stdout.replace(/\0/g, '').trim()

  if (output.includes('spike-ok')) {
    return {
      id: 1,
      name: '命令行 Mach-O',
      status: GATE_STATUS.PASS,
      reason: 'Darling 成功执行了 Mach-O 并输出预期字符串。',
      output,
    }
  }
  return {
    id: 1,
    name: '命令行 Mach-O',
    status: GATE_STATUS.FAIL,
    reason: 'Darling 执行了样本但没有输出预期字符串。',
    output: output || result.stderr,
  }
}

/**
 * 跑门槛 2：AppKit 窗口。
 *
 * **这是决定性的门槛。**
 *
 * 无法自动判定「屏幕上出现白框」—— 那需要人眼或截图分析。所以这里
 * 只做两件事：
 *
 *   1. 检查 Darling 里是否存在 AppKit 框架（存在 ≠ 能用）
 *   2. 如实报告「需要人工确认」
 *
 * 把状态标为 `blocked` 而不是 `pass`。假装能自动判定是最危险的做法。
 *
 * @returns {Promise<object>}
 */
export async function gateAppKitWindow() {
  const darling = await probeDarling()
  if (!darling.available) {
    return {
      id: 2,
      name: 'AppKit 窗口',
      status: GATE_STATUS.BLOCKED,
      reason: darling.reason,
      hint: darling.hint ?? null,
      decisive: true,
    }
  }

  // 探测 Darling 里 AppKit 框架文件是否存在
  const script = [
    'for p in /usr/libexec/darling/System/Library/Frameworks/AppKit.framework',
    '         /usr/local/lib/darling/System/Library/Frameworks/AppKit.framework',
    '         "$(dirname "$(command -v darling)")/../lib/darling/System/Library/Frameworks/AppKit.framework"; do',
    '  [ -d "$p" ] && echo "FOUND:$p" && exit 0',
    'done',
    'echo NOT_FOUND',
  ].join('\n')

  const result = await probe('wsl.exe', ['-e', 'sh', '-c', script], 30000)
  const output = result.stdout.replace(/\0/g, '').trim()

  if (output.startsWith('FOUND:')) {
    return {
      id: 2,
      name: 'AppKit 窗口',
      status: GATE_STATUS.BLOCKED,
      reason:
        'Darling 里有 AppKit.framework，但「能否真的画出窗口」无法自动判定 —— ' +
        '需要人工在图形界面里观察。',
      hint:
        '手动执行：wsl.exe -e darling /path/to/minimal-appkit-binary，' +
        '观察是否出现窗口。上游自述 AppKit 支持为「basic and experimental」。',
      frameworkPath: output.slice('FOUND:'.length),
      decisive: true,
      needsManualCheck: true,
    }
  }

  return {
    id: 2,
    name: 'AppKit 窗口',
    status: GATE_STATUS.FAIL,
    reason: 'Darling 里找不到 AppKit.framework，图形程序无法加载。',
    output,
    decisive: true,
  }
}

/**
 * 跑门槛 3：读 Info.plist 并定位主二进制。
 *
 * 这条**不依赖 Darling**，任何平台都能验，所以本机可以跑通。
 *
 * @param {string | null} appPath
 * @returns {Promise<object>}
 */
export async function gatePlistParse(appPath) {
  if (appPath === null) {
    return {
      id: 3,
      name: 'Info.plist 解析',
      status: GATE_STATUS.BLOCKED,
      reason: '未提供 .app 样本（--app）。',
      hint: '传任意一个 .app 路径即可验证解析能力。',
    }
  }

  try {
    const parsed = await parseAppBundle(appPath)
    if (parsed.plistError !== null) {
      return {
        id: 3,
        name: 'Info.plist 解析',
        status: GATE_STATUS.FAIL,
        reason: `Info.plist 解析失败：${parsed.plistError}`,
      }
    }
    if (parsed.executableName === null) {
      return {
        id: 3,
        name: 'Info.plist 解析',
        status: GATE_STATUS.FAIL,
        reason: 'Info.plist 里没有 CFBundleExecutable。',
      }
    }
    if (!parsed.mainExecutableExists) {
      return {
        id: 3,
        name: 'Info.plist 解析',
        status: GATE_STATUS.FAIL,
        reason: `CFBundleExecutable 指向的文件不存在：Contents/MacOS/${parsed.executableName}`,
      }
    }
    return {
      id: 3,
      name: 'Info.plist 解析',
      status: GATE_STATUS.PASS,
      reason: '成功解析 Info.plist 并定位到主二进制。',
      detail: {
        bundleId: parsed.bundleId,
        executable: parsed.executableName,
        binaries: parsed.binaries.length,
      },
    }
  } catch (error) {
    return {
      id: 3,
      name: 'Info.plist 解析',
      status: GATE_STATUS.FAIL,
      reason: String(error),
    }
  }
}

/**
 * 跑完整 spike。
 *
 * @param {object} input
 * @param {string | null} [input.sample] Mach-O 样本路径。
 * @param {string | null} [input.app] `.app` 样本路径。
 * @returns {Promise<object>}
 */
export async function runSpike(input = {}) {
  const gates = await Promise.all([
    gateCommandLine(input.sample ?? null),
    gateAppKitWindow(),
    gatePlistParse(input.app ?? null),
  ])

  /*
   * 整体结论：
   *
   *   - 任一决定性门槛 fail → 方向不成立，降级
   *   - 任一门槛 blocked    → 无法判定，必须说「未验证」
   *   - 全部 pass           → 方向成立
   *
   * 注意 blocked 不等于 pass。这是本模块最重要的一条逻辑。
   */
  const anyFail = gates.some((gate) => gate.status === GATE_STATUS.FAIL)
  const anyBlocked = gates.some((gate) => gate.status === GATE_STATUS.BLOCKED)

  let conclusion
  if (anyFail) {
    conclusion = 'rejected'
  } else if (anyBlocked) {
    conclusion = 'unverified'
  } else {
    conclusion = 'accepted'
  }

  const notes = []
  if (conclusion === 'unverified') {
    const blocked = gates.filter((gate) => gate.status === GATE_STATUS.BLOCKED)
    notes.push(
      `${String(blocked.length)} 条门槛因环境不具备而**未验证**（不是通过）。` +
      '结论不能据此认为方向可行。')
    if (process.platform !== 'win32') {
      notes.push(
        `当前宿主是 ${process.platform}。AppOnWin 的运行时验证必须在 ` +
        'Windows + WSL2 + Darling 环境里完成。')
    }
  }
  if (conclusion === 'rejected') {
    notes.push('至少一条门槛实际执行并失败，本方向按设计降级为「兼容性评估工具」。')
  }
  if (conclusion === 'accepted') {
    notes.push('三条门槛全部实际执行并通过，可以进入阶段 1 之后的实现。')
  }

  return {
    gates,
    conclusion,
    notes,
    /*
     * 门槛 2 是决定性的，单独标出来。
     * 前端可以据此把它的状态放在最显眼位置。
     */
    decisiveGate: 2,
  }
}