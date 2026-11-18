/**
 * 桌面壳兼容垫片（shim）。
 *
 * ## 它存在的唯一理由
 *
 * 原项目的界面是照着 Tauri 写的：启动时调 `__TAURI__.core.invoke('get_host_state')`
 * 拿宿主地址与令牌，靠 `__TAURI__.event.listen('host-ready')` 接就绪事件。
 * 浏览器里没有这个全局对象，界面会一直停在「正在连接」，八秒后报失败。
 *
 * 而本次打包**不重编 Rust 壳**（arm64 mac 上没有 Windows 的 Rust 工具链），
 * 所以必须由打包工具补上这一层。补的方式是在页面脚本之前注入这个文件，
 * 用浏览器的 `fetch` 与轮询实现那几个壳命令。
 *
 * ## 为什么改前端源码不是选项
 *
 * 改源码意味着「打包工具要求被它打包的项目先改造一遍」——那就不是
 * 通用工具了，而是空谷专用脚本。垫片的价值在于**前端一行不改**，
 * 换个项目只要它用了同一套壳命令就能直接跑。
 *
 * ## 实现原则
 *
 * 1. 只实现被真实调用的命令。列在 {@link COMMANDS} 里的一目了然。
 * 2. 实现不了的（窗口控制、托盘、系统通知）返回「能力不可用」，
 *    让前端走它自己的降级分支——那些分支原项目写得很完整。
 * 3. 不假装成功。假装成功会让界面显示一个点了没反应的按钮，
 *    比诚实报错更让人困惑。
 */

(function installShim() {
  'use strict'

  // 已经装过就不重复装（页面可能被同一份脚本注入两次）。
  if (globalThis.__TAURI__ !== undefined) return

  /**
   * 读打包时写下的连接信息。
   *
   * 启动器会在宿主就绪后把 `{url, token, port}` 写到静态根的
   * `runtime.json`，这里同源取——不加时间戳参数会被浏览器缓存住，
   * 于是永远读到 `pending` 状态。
   */
  async function readRuntime() {
    try {
      const response = await fetch(`./runtime.json?t=${String(Date.now())}`, { cache: 'no-store' })
      if (!response.ok) return null
      return await response.json()
    } catch {
      return null
    }
  }

  /** 就绪的判定：拿到了 url 与 token，且不是 pending 占位。 */
  function isReady(state) {
    return state !== null
      && state.pending !== true
      && typeof state.url === 'string'
      && typeof state.token === 'string'
  }

  /** 把运行时状态转成前端期望的 `HostState` 形状。 */
  function toHostState(state) {
    if (isReady(state)) {
      return { state: 'ready', url: state.url, token: state.token, port: state.port }
    }
    // 还没就绪：报 starting，前端会继续等事件而不判失败。
    return { state: 'starting' }
  }

  /**
   * 轮询等宿主就绪。
   *
   * 为什么不用 SSE / WebSocket：启动器只是个静态服务，加一条推送通道
   * 要多写几十行协议代码，而这里等的是「几百毫秒内的一个状态翻转」。
   * 250ms 一次轮询的代价可以忽略，代码量少一个数量级。
   */
  async function waitReady(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const state = await readRuntime()
      if (isReady(state)) return state
      if (Date.now() > deadline) return null
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  /** 事件监听器注册表：事件名 → 回调集合。 */
  const listeners = new Map()
  /** 已经派发过的一次性事件，防止重复通知。 */
  const fired = new Set()

  /** 派发一个事件。 */
  function emit(event, payload) {
    const set = listeners.get(event)
    if (set === undefined) return
    for (const handler of set) {
      try {
        handler({ event, id: 0, payload })
      } catch (error) {
        console.error(`[shim] 事件处理器出错（${event}）`, error)
      }
    }
  }

  /** 后台盯着就绪状态，一到就派发一次 `host-ready`。 */
  function watchReady() {
    if (fired.has('host-ready')) return
    void waitReady().then((state) => {
      if (state === null) {
        if (!fired.has('host-failed')) {
          fired.add('host-failed')
          emit('host-failed', '宿主启动超时，请查看安装目录下 data/launcher.log')
        }
        return
      }
      if (fired.has('host-ready')) return
      fired.add('host-ready')
      emit('host-ready', { url: state.url, token: state.token, port: state.port })
    })
  }

  /** 打开一个 URL。壳里是系统浏览器，这里也一样。 */
  function openUrl(url) {
    if (typeof url !== 'string' || url === '') return
    globalThis.open(url, '_blank', 'noopener,noreferrer')
  }

  /**
   * 命令实现表。
   *
   * 键就是前端 `invokeShell('xxx')` 里的命令名。没列在这里的命令
   * 一律走 `unsupported()`，让前端降级。
   */
  const COMMANDS = {
    /** 读宿主连接状态。这是最关键的一条，没有它界面连不上。 */
    async get_host_state() {
      return toHostState(await readRuntime())
    },

    /** 重启宿主。浏览器形态下没有重启宿主的能力，如实拒绝。 */
    async restart_host() {
      throw new Error('浏览器形态下无法重启宿主，请关闭应用后重新打开')
    },

    /** 用系统浏览器打开链接。 */
    async open_browser(args) {
      openUrl(args?.url)
      return null
    },

    /** 打开外部链接（opener 插件的命令名）。 */
    'plugin:opener|open_url'(args) {
      openUrl(args?.url)
      return null
    },

    /** 数据目录。启动器把数据放在安装目录下的 data/。 */
    async app_data_path() {
      return './data'
    },

    /** 在文件管理器里显示某个路径。浏览器做不到，如实拒绝。 */
    async reveal_in_folder() {
      throw new Error('浏览器形态下无法打开文件管理器')
    },

    /** 打开日志目录。同上。 */
    async open_log_dir() {
      throw new Error('浏览器形态下无法打开日志目录，日志在安装目录的 data/launcher.log')
    },

    /** 关闭应用：调启动器的退出接口。 */
    async resolve_close() {
      try {
        await fetch('./__mac2win/quit', { method: 'POST' })
      } catch {
        /* 已经关了 */
      }
      // 等启动器把服务停掉，页面自然会失联；再补一句提示免得用户困惑。
      setTimeout(() => {
        document.body.innerHTML = '<div style="font:14px system-ui;padding:40px;color:#666">应用已关闭，可以关掉这个标签页了。</div>'
      }, 400)
      return null
    },

    /** 系统通知。浏览器有 Notification API，但语义与桌面不同，如实拒绝。 */
    async 'plugin:notification|is_permission_granted'() {
      return false
    },

    /** 深度链接。浏览器形态没有这个概念。 */
    async take_deep_links() {
      return []
    },

    /** 托盘静音。没有托盘。 */
    async set_tray_muted() {
      return null
    },
  }

  /**
   * 处理一条壳命令。
   *
   * 前端对「壳能力不可用」有专门的判据：错误消息以「桌面能力不可用」开头。
   * 这里必须用同样的前缀，否则前端会把「没有这个能力」误判成「请求失败」，
   * 从而显示一个更含糊的错误。
   */
  async function invoke(command, args) {
    const handler = COMMANDS[command]
    if (handler === undefined) {
      throw new Error(`桌面能力不可用：浏览器形态下没有命令 ${command}`)
    }
    return await handler(args ?? {})
  }

  /** 注册事件监听，返回取消函数（与 Tauri 的语义一致）。 */
  async function listen(event, handler) {
    let set = listeners.get(event)
    if (set === undefined) {
      set = new Set()
      listeners.set(event, set)
    }
    set.add(handler)

    if (event === 'host-ready' || event === 'host-failed') watchReady()

    return () => {
      set.delete(handler)
    }
  }

  // --- 装上全局对象 ---
  globalThis.__TAURI__ = {
    core: { invoke },
    event: { listen },
    // 通知插件留一个空壳，前端的 `api()` 会拿到 undefined 并降级。
    // 不给这个键的话前端读 `__TAURI__.notification` 得到 undefined，
    // 结果一样，但显式写出来能让人知道「这里确实没有」而不是「忘了写」。
    notification: undefined,
  }

  console.info('[shim] 桌面壳兼容层已装载（浏览器形态）')
})()