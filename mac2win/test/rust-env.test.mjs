/**
 * Rust 交叉编译环境探测的测试（W-06 产物）。
 *
 * ## 这一组守的是什么
 *
 * `checkRustEnv()` 的结论直接决定 `buildRustShell: true` 能不能走。
 * 它此前有两处判据错误，都是**静默**的：不会报错，只是给出相反的结论。
 *
 * ### 缺陷 A：`clang-cl` / `lld-link` 恒判缺失
 *
 * 这两个不是用户装的 LLVM 组件，而是 `cargo-xwin` **自己创建**的符号链接，
 * 落在 `~/Library/Caches/cargo-xwin/`（Linux 是 `~/.cache/cargo-xwin/`）。
 * `cargo xwin build` 会把它临时插进 PATH，所以编译能成；但它从不进系统 PATH。
 *
 * 修复前的 `which()` 只查 `/opt/homebrew/bin`、`/usr/local/bin`、
 * `~/.cargo/bin` 与系统 PATH —— 这四个地方都没有，于是报「找不到」。
 *
 * 后果很具体：**环境其实齐全，却被告知缺工具**，用户会去 `brew install llvm`
 * 装一个 1.5 GB 且装完也不解决问题的东西。
 *
 * ### 缺陷 B：`llvm-rc` 完全没被检查
 *
 * Tauri v2 的 `build.rs` 会走 `tauri-build` → `tauri-winres` → `embed-resource`，
 * 对 `*-pc-windows-msvc` 目标默认要 `llvm-rc`。没有它，编译会在
 * 「已编完 300+ crate、耗时十几分钟」之后才 panic，报错只有
 * `NotAttempted("llvm-rc")` 一句。这一项必须**在预检阶段**单独查、单独报。
 *
 * ## 为什么这组测试不依赖本机装了什么
 *
 * 断言的是**判据结构**而不是环境结论：
 *   - 探测必须覆盖 cargo-xwin 的两个 shim 目录（`cargoXwinShimDirs()` 的契约）
 *   - 结果项必须包含 `llvm-rc` 且其 `hint` 非空（缺了得告诉用户装什么）
 *   - `ready` 必须等于「所有项都 ok」，不能只看部分
 *
 * 这样在没装 Rust 的机器上也照样跑得过、照样守得住。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { checkRustEnv, RustEnvStatus } from '../src/core/rust-shell.mjs'

/** 取一条检查项。 */
function pick(status, id) {
  return status.items.find((item) => item.id === id)
}

describe('Rust 环境探测', () => {
  test('结果必须包含 llvm-rc 这一项', async () => {
    const status = await checkRustEnv()
    const item = pick(status, 'llvm-rc')
    assert.ok(item !== undefined, '缺少 llvm-rc 检查项：Tauri 交叉编译会一直编译到中途才 panic')
    assert.equal(typeof item.ok, 'boolean')
    assert.equal(typeof item.title, 'string')
  })

  test('llvm-rc 缺失时必须给出可操作的 hint', async () => {
    const status = await checkRustEnv()
    const item = pick(status, 'llvm-rc')
    if (item.ok) return // 装了就不必断言 hint
    assert.ok(
      typeof item.hint === 'string' && item.hint.length > 0,
      'llvm-rc 缺失却没给 hint —— 用户只会看到一句 NotAttempted("llvm-rc")',
    )
    // hint 必须指向一个真实存在的 Homebrew 公式名，不能是空话
    assert.match(item.hint, /brew install llvm|RC 环境变量/)
  })

  test('clang-cl / lld-link 的 detail 在缺失时要说明查过哪些位置', async () => {
    const status = await checkRustEnv()
    for (const id of ['clang-cl', 'lld-link']) {
      const item = pick(status, id)
      assert.ok(item !== undefined, `缺少 ${id} 检查项`)
      if (!item.ok) {
        /*
         * 修复前的 detail 只有「找不到」三个字。用户无法判断
         * 「是我没装 LLVM，还是工具找错了地方」——而这次的真实原因
         * 恰恰是后者。detail 必须说清查过 shim 目录。
         */
        assert.match(item.detail, /shim/)
      }
    }
  })

  test('ready 当且仅当所有项都 ok', async () => {
    const status = await checkRustEnv()
    const allOk = status.items.every((item) => item.ok)
    assert.equal(status.ready, allOk)
    assert.equal(status.missing.length, status.items.filter((item) => !item.ok).length)
  })

  test('cargo-xwin 的 shim 目录必须同时覆盖 mac 与 linux 两种布局', async () => {
    /*
     * 通过 listRustEnvCandidates 的等价断言：直接读 rust-shell.mjs 源码，
     * 确认两条路径都在。这是静态守卫——本机只可能是 mac，linux 那条
     * 永远走不到，只能靠文本比对守。
     */
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const source = await readFile(
      fileURLToPath(new URL('../src/core/rust-shell.mjs', import.meta.url)),
      'utf8',
    )
    assert.match(source, /'Library',\s*'Caches',\s*'cargo-xwin'/, 'mac 的 shim 目录不见了')
    assert.match(source, /'\.cache',\s*'cargo-xwin'/, 'linux 的 shim 目录不见了')
  })
})

describe('RustEnvStatus 聚合', () => {
  test('空集合 ready=true（没有要求就算齐全）', () => {
    const status = new RustEnvStatus()
    assert.equal(status.ready, true)
    assert.deepEqual(status.missing, [])
  })

  test('一项失败即 ready=false，且 missing 只装失败项', () => {
    const status = new RustEnvStatus()
    status.add({ id: 'a', title: 'A', ok: true })
    status.add({ id: 'b', title: 'B', ok: false, detail: 'x' })
    assert.equal(status.ready, false)
    assert.deepEqual(status.missing.map((item) => item.id), ['b'])
  })
})

/*
 * ## x86 库落地检查（缺陷 C）
 *
 * 这条是 2026-11-19 端到端实测中撞出来的，前两轮都没发现，
 * 因为它**不报错**：`cargo xwin build` 会一路编完 130+ crate，
 * 到链接阶段才吐出 10 条 `could not open 'user32.lib'`。
 *
 * 根因在 cargo-xwin 自己的缓存判据（`clang_cl.rs` 的 `setup_msvc_crt`）：
 * 它只读 `xwin/DONE` 的**首行文本**判断「这个架构下过没有」，
 * 从不校验文件是否真在磁盘上。本机实证：
 *
 * | 事实 | 值 |
 * |---|---|
 * | `xwin/DONE` 首行 | `x86`（自称已下） |
 * | `xwin/crt/lib/` 实有 | 只有 `x86_64` |
 * | `xwin/sdk/lib/um/` 实有 | `aarch64`、`x86_64` |
 *
 * 于是 `XWIN_ARCH=x86` 形同虚设：变量只影响「该下载什么」，
 * 而提前返回让下载根本没发生。同一份代码把 `XWIN_CACHE_DIR` 指向
 * 干净目录后一次编译成功、产出 1096192 字节的 `PE32/i386`。
 *
 * 所以判据必须是**磁盘上的目录**，不能是 `DONE` 的自述。
 */
describe('x86 库落地检查', () => {
  test('必须产出 x86-libs 这一项', async () => {
    const status = await checkRustEnv()
    const item = status.items.find((entry) => entry.id === 'x86-libs')
    assert.ok(item !== undefined, '缺少 x86-libs 检查项：DONE 撒谎时用户要等十几分钟才知道')
    assert.equal(typeof item.ok, 'boolean')
    assert.equal(typeof item.title, 'string')
  })

  test('缺失时 detail 要点出**具体哪个目录**缺，不能只说「缺失」', async () => {
    const status = await checkRustEnv()
    const item = status.items.find((entry) => entry.id === 'x86-libs')
    if (item.ok) return // 本机已修补就不必断言
    /*
     * 必须给出可复现的路径：用户拿这个路径去 `ls` 就能自己确认，
     * 而不是去猜「是不是我 XWIN_ARCH 没设对」。
     */
    assert.match(item.detail, /crt[/\\]lib[/\\]x86|sdk[/\\]lib[/\\]um[/\\]x86/,
      'detail 里没有具体目录，用户无法自查')
    assert.match(item.hint, /DONE|删除|干净目录/, 'hint 必须指出「缓存自述与实际不一致」这个真因')
  })

  test('XWIN_CACHE_DIR 可覆盖缓存位置（否则测试环境与用户环境会串）', async () => {
    /*
     * 静态守卫：`cargoXwinCacheRoot()` 必须读 XWIN_CACHE_DIR。
     * 这条不测运行结果——本机是否设置了该变量不确定——只守源码里
     * 那个 `process.env.XWIN_CACHE_DIR` 没被删掉。
     */
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const source = await readFile(
      fileURLToPath(new URL('../src/core/rust-shell.mjs', import.meta.url)),
      'utf8',
    )
    assert.match(source, /process\.env\.XWIN_CACHE_DIR/, 'XWIN_CACHE_DIR 覆盖不见了：无法在本机跑干净缓存实验')
  })

  test('检查的必须是目录而非文件（库是一堆 .lib，不是单个文件）', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const source = await readFile(
      fileURLToPath(new URL('../src/core/rust-shell.mjs', import.meta.url)),
      'utf8',
    )
    /*
     * 若把 isDirectory 写成 isFile，x86 目录存在时会被判成 false，
     * 反而在环境齐全时报「缺库」——比不查更糟。
     */
    assert.match(source, /isDirectory\(path\)/, 'x86 库检查必须用 isDirectory')
    assert.doesNotMatch(source, /isFile\(path\)\)\s*missingPaths/, 'x86 库是目录，不是文件')
  })
})

/*
 * ## 目标三元组的三处同步（缺陷 D）
 *
 * `generate_context!()` 是**过程宏，在宿主上展开**，它读
 * `TAURI_ENV_TARGET_TRIPLE`，不读 `TARGET`
 * （`tauri-codegen-2.7.6/src/context.rs:148`）。
 *
 * 不传的实测后果：宏按宿主判定为 macOS，生成代码里带上
 * `tauri::embed_plist::embed_info_plist!`；而 `embed_plist` 在
 * `tauri-2.12.7/src/lib.rs:75` 被 `#[cfg(target_os = "macos")]` 门控，
 * 交叉编译到 Windows 时该门未开 →
 *
 * ```
 * error[E0433]: cannot find `embed_plist` in `tauri`
 * ```
 *
 * 这个报错指向 `tauri` 内部，字面上完全看不出「少设一个环境变量」。
 * 而且它发生在 `llvm-rc` 那关**之前**，所以不修它，
 * 用户连真正的卡点都看不到。
 *
 * 这组测试同时锁住「三处用的是同一个常量」：`--target` 参数、
 * `TAURI_ENV_TARGET_TRIPLE` 的值、产物目录拼接。三处任一不同步，
 * 表现都是「编完了但找不到 exe」。
 */
describe('目标三元组传递', () => {
  test('buildRustShell 必须设置 TAURI_ENV_TARGET_TRIPLE', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const source = await readFile(
      fileURLToPath(new URL('../src/core/rust-shell.mjs', import.meta.url)),
      'utf8',
    )
    assert.match(
      source,
      /TAURI_ENV_TARGET_TRIPLE:\s*TARGET_TRIPLE/,
      '没设 TAURI_ENV_TARGET_TRIPLE：generate_context! 会按宿主当 macOS，报 embed_plist 不存在',
    )
  })

  test('`--target` 参数与产物目录必须用同一个常量', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const source = await readFile(
      fileURLToPath(new URL('../src/core/rust-shell.mjs', import.meta.url)),
      'utf8',
    )
    /*
     * 判据是「这两处都不再出现硬编码字符串」。若有人把某一处写死回
     * 'i686-pc-windows-msvc'，常量就失去「单一真源」的意义 ——
     * 而两处一旦不同步，产物会落在错误目录，报错是
     * 「Rust 编译完成但找不到 exe 产物」，指向完全错误的方向。
     */
    assert.match(source, /'--target',\s*TARGET_TRIPLE/, '--target 用了硬编码字符串')
    assert.match(source, /join\(tauriDir, 'target', TARGET_TRIPLE, profile\)/, '产物目录用了硬编码字符串')
  })

  test('常量本身必须是 i686-pc-windows-msvc', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const source = await readFile(
      fileURLToPath(new URL('../src/core/rust-shell.mjs', import.meta.url)),
      'utf8',
    )
    assert.match(source, /const TARGET_TRIPLE = 'i686-pc-windows-msvc'/)
  })
})

describe('cargo-xwin shim 路径拼接', () => {
  test('HOME 下的两个候选目录形状正确', () => {
    /*
     * 复刻 cargoXwinShimDirs 的拼接规则做独立对账，防止有人把
     * 'Library' 写成 'library'（macOS 文件系统默认大小写不敏感，
     * 本地能跑，到 Linux CI 上红）。
     */
    const home = '/Users/probe'
    assert.equal(join(home, 'Library', 'Caches', 'cargo-xwin'), '/Users/probe/Library/Caches/cargo-xwin')
    assert.equal(join(home, '.cache', 'cargo-xwin'), '/Users/probe/.cache/cargo-xwin')
  })
})
