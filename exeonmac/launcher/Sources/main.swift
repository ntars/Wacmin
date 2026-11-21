// ExeOnMac launcher
//
// 职责边界（见仓库根 README.md 第 3.2.3 节）：
//   1. 定位包根目录            Bundle.main.bundlePath
//   2. 组装运行时环境          WINEPREFIX / WINEDEBUG / PATH
//   3. 读入口 exe 路径         Contents/Recipes/compat.yaml
//   4. 启动 wine
//   5. 接管窗口                MVP：wine 自己的 NSWindow 直接显示
//   6. 进程退出时清理
//
// 全部七步都已实现。窗口交给 wine 的 macOS driver 自建 NSWindow ——
// launcher 不设 NSApplicationActivationPolicy，也不抢 NSApplication
// 生命周期，否则会和 driver 争夺事件循环，表现为窗口不响应。
//
// 失败一律明确报错并落 launcher.log，绝不静默退出：双击后"什么都没发生"
// 是最难排查的故障形态。
//
// 编译：launcher/build.sh（等价 swiftc -O ... -o build/launcher）

import AppKit
import Foundation

// MARK: - 错误

/// launcher 的所有可预期失败。每条都带可执行的修复提示。
enum LauncherError: Error, CustomStringConvertible {
    case notInBundle(String)
    case missingCompat(String)
    case malformedCompat(line: Int, detail: String)
    case missingEntry(String)
    case missingRuntime(String)

    var description: String {
        switch self {
        case .notInBundle(let path):
            return "未在 .app 包内运行（bundlePath=\(path)）。请直接双击 .app，不要单独执行 launcher。"
        case .missingCompat(let path):
            return "缺少配置文件：\(path)"
        case .malformedCompat(let line, let detail):
            return "compat.yaml 第 \(line) 行无法解析：\(detail)"
        case .missingEntry(let path):
            return "入口程序不存在：\(path)"
        case .missingRuntime(let path):
            return "缺少 wine 运行时：\(path)\n修复：wepack doctor 查看详情；或把 wine 放入该目录。"
        }
    }
}

// MARK: - 包内布局

/// 包内路径的唯一来源。改布局只改这里。
struct BundleLayout {
    let bundle: URL

    init() throws {
        let path = Bundle.main.bundlePath
        // 单独执行可执行文件时，bundlePath 是其所在目录，不以 .app 结尾。
        guard path.hasSuffix(".app") else {
            throw LauncherError.notInBundle(path)
        }
        self.bundle = URL(fileURLWithPath: path, isDirectory: true)
    }

    var contents: URL { bundle.appendingPathComponent("Contents", isDirectory: true) }
    var resources: URL { contents.appendingPathComponent("Resources", isDirectory: true) }
    var privateDir: URL { resources.appendingPathComponent("Private", isDirectory: true) }
    var recipes: URL { contents.appendingPathComponent("Recipes", isDirectory: true) }
    var compatFile: URL { recipes.appendingPathComponent("compat.yaml") }
    var driveC: URL { privateDir.appendingPathComponent("drive_c", isDirectory: true) }

    /// 共享层根目录，与 wepack/paths.py 的 wexe_home() 保持一致。
    /// 允许 WEXE_HOME 覆盖，便于测试与多份隔离安装。
    var sharedRoot: URL {
        if let override = ProcessInfo.processInfo.environment["WEXE_HOME"], !override.isEmpty {
            return URL(fileURLWithPath: (override as NSString).expandingTildeInPath, isDirectory: true)
        }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("wexe", isDirectory: true)
    }

    var wineRoot: URL { sharedRoot.appendingPathComponent("runtime/wine", isDirectory: true) }

    var logFile: URL {
        sharedRoot.appendingPathComponent("logs", isDirectory: true)
            .appendingPathComponent("launcher.log")
    }

    /// wine 自己的输出日志。按应用名分开，多开几个包时不会互相覆盖。
    /// 文件名里的 `/` 与空格会被替换：应用名可能带空格（如 "7-Zip"），
    /// 空格在路径里合法但不利于命令行排查。
    func wineLogFile(app: String) -> URL {
        let safe = app.replacingOccurrences(of: "/", with: "-")
                      .replacingOccurrences(of: ":", with: "-")
                      .replacingOccurrences(of: " ", with: "-")
        return sharedRoot.appendingPathComponent("logs", isDirectory: true)
            .appendingPathComponent("wine-\(safe).log")
    }
}

// MARK: - compat.yaml 读取（受限子集解析器）

/// 只解析 wepack 自己写出的 YAML 子集：
///   - 顶层 `key: value`
///   - 一层嵌套 `key:` 后跟缩进 2 空格的 `sub: value`
///   - 字符串列表 `- item`
/// 遇到其他语法一律报错并给行号，绝不"猜"。
struct CompatFile {
    private var scalars: [String: String] = [:]
    private var lists: [String: [String]] = [:]
    private var sections: [String: [String: String]] = [:]

    static func load(_ url: URL) throws -> CompatFile {
        guard let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8) else {
            throw LauncherError.missingCompat(url.path)
        }
        var file = CompatFile()
        try file.parse(text)
        return file
    }

    private mutating func parse(_ text: String) throws {
        var currentSection: String?
        var currentList: String?

        for (index, rawLine) in text.components(separatedBy: .newlines).enumerated() {
            let lineNo = index + 1
            let line = stripComment(rawLine)
            if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }

            let indented = line.hasPrefix(" ")
            let body = line.trimmingCharacters(in: .whitespaces)

            if body.hasPrefix("- ") {
                let item = unquote(String(body.dropFirst(2)))
                guard let key = currentList else {
                    throw LauncherError.malformedCompat(line: lineNo, detail: "列表项缺少上级键")
                }
                lists[key, default: []].append(item)
                continue
            }

            guard let colon = body.firstIndex(of: ":") else {
                throw LauncherError.malformedCompat(line: lineNo, detail: "缺少冒号")
            }
            let key = String(body[body.startIndex..<colon]).trimmingCharacters(in: .whitespaces)
            let value = unquote(String(body[body.index(after: colon)...]).trimmingCharacters(in: .whitespaces))

            if indented {
                guard let section = currentSection else {
                    throw LauncherError.malformedCompat(line: lineNo, detail: "缩进行缺少上级段")
                }
                sections[section, default: [:]][key] = value
                currentList = nil
            } else if value.isEmpty {
                currentSection = key
                currentList = key
                lists[key] = []
                sections[key] = [:]
            } else {
                scalars[key] = value
                currentSection = nil
                currentList = nil
            }
        }
    }

    private func stripComment(_ line: String) -> String {
        // 只在行首或空白后的 # 视为注释，避免截断含 # 的路径
        var result = ""
        var previousWasSpace = true
        for ch in line {
            if ch == "#" && previousWasSpace { break }
            result.append(ch)
            previousWasSpace = (ch == " " || ch == "\t")
        }
        return result
    }

    private func unquote(_ value: String) -> String {
        var v = value
        if v.count >= 2 {
            let first = v.first!
            let last = v.last!
            if (first == "\"" && last == "\"") || (first == "'" && last == "'") {
                v = String(v.dropFirst().dropLast())
            }
        }
        return v
    }

    func string(_ key: String) -> String? {
        let value = scalars[key]
        return (value?.isEmpty ?? true) ? nil : value
    }

    func section(_ name: String, _ key: String) -> String? {
        let value = sections[name]?[key]
        return (value?.isEmpty ?? true) ? nil : value
    }

    /// 取整段映射，用于 `font_map` 这类键值对（Windows 字体名 → macOS 字体名）。
    func mapping(_ name: String) -> [String: String] {
        guard let raw = sections[name] else { return [:] }
        return raw.filter { !$0.key.isEmpty && !$0.value.isEmpty }
    }

    func list(_ key: String) -> [String] { lists[key] ?? [] }
}

// MARK: - 运行时环境

/// wine 进程的启动参数与环境。阶段 3 用它在 prefix 内拉起入口 exe。
struct RuntimePlan {
    let wineBinary: URL
    let arguments: [String]
    let environment: [String: String]
    let workingDirectory: URL

    static func make(layout: BundleLayout, compat: CompatFile) throws -> RuntimePlan {
        let binary = layout.wineRoot.appendingPathComponent("bin/wine64")
        guard FileManager.default.isExecutableFile(atPath: binary.path) else {
            throw LauncherError.missingRuntime(binary.path)
        }

        guard let entry = compat.string("entry"), !entry.isEmpty else {
            throw LauncherError.malformedCompat(line: 0, detail: "缺少 entry 字段")
        }
        let entryURL = layout.privateDir.appendingPathComponent(entry)
        guard FileManager.default.fileExists(atPath: entryURL.path) else {
            throw LauncherError.missingEntry(entryURL.path)
        }

        var env = ProcessInfo.processInfo.environment
        env["WINEPREFIX"] = layout.privateDir.path
        env["WINEDEBUG"] = "-all"                       // 生产静默
        env["WINEDLLOVERRIDES"] = "mscoree,mshtml="     // 关掉 mono/gecko 安装弹窗
        env["WEXE_BUNDLE"] = layout.bundle.path
        // 共享 runtime 与层内工具进 PATH，优先级高于系统
        let extraPath = [
            layout.wineRoot.appendingPathComponent("bin").path,
            layout.wineRoot.appendingPathComponent("lib").path,
        ].joined(separator: ":")
        env["PATH"] = extraPath + ":" + (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")

        return RuntimePlan(
            wineBinary: binary,
            arguments: [entryURL.path],
            environment: env,
            workingDirectory: entryURL.deletingLastPathComponent()
        )
    }
}

// MARK: - 日志

/// launcher 自己的日志与 wine 的 stdout/stderr 分开：
/// 前者进 logs/launcher.log，后者进 logs/wine-<app>.log。
enum LauncherLog {
    static func write(_ message: String, to file: URL?) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        let line = "[\(stamp)] \(message)\n"
        guard let file else {
            FileHandle.standardError.write(Data(line.utf8))
            return
        }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        if let handle = try? FileHandle(forWritingTo: file) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try? handle.close()
        } else {
            try? line.write(to: file, atomically: true, encoding: .utf8)
        }
    }
}

// MARK: - 字体替换

/// 把 compat.yaml 的 `font_map` 写成 prefix 内的 fontsub.reg 并导入。
///
/// Windows 软件把「微软雅黑」写死在字体设置里，macOS 上没有这个字体，
/// wine 会退回一个缺少中文字形的替代字体，界面里的中文变成方块。
/// 注册表项 `FontSubstitutes` 让 GDI 在找不到字体时改用它指定的名字，
/// 而那个名字（PingFang SC）在 macOS 字体服务里是存在的。
///
/// 走 `.reg` 文件而不是直接改注册表二进制：文本文件可审计、可回滚，
/// 也符合 ARCHITECTURE.md 第 9 节的安全约定。
enum FontSubstitution {
    /// 返回「本次调用是否因收到信号而中止」。
    ///
    /// 早先返回 Void。加这个返回值是因为：信号若落在 regedit 期间，regedit
    /// 会被停掉，但**主程序仍会被拉起** —— 用户已经按了关，却看见窗口又
    /// 冒出来。调用方必须能据此直接收工。
    @discardableResult
    static func apply(layout: BundleLayout, plan: RuntimePlan, fonts: [String: String],
                      log: URL?) -> Bool {
        guard !fonts.isEmpty else { return false }

        var lines = [
            "WINE REGISTRY Version 2",
            ";; 由 ExeOnMac launcher 生成，请勿手工修改",
            "",
            "[Software\\\\Microsoft\\\\Windows NT\\\\CurrentVersion\\\\FontSubstitutes]",
        ]
        for (windowsName, macName) in fonts.sorted(by: { $0.key < $1.key }) {
            lines.append("\"\(windowsName)\"=\"\(macName)\"")
        }
        let text = lines.joined(separator: "\r\n") + "\r\n"

        let regFile = layout.privateDir.appendingPathComponent("fontsub.reg")
        do {
            try text.write(to: regFile, atomically: true, encoding: .utf8)
        } catch {
            LauncherLog.write("WARN 写 fontsub.reg 失败：\(error.localizedDescription)", to: log)
            return false
        }

        // ## 这一步也必须走 WineRunner 的统一入口
        //
        // 早先这里自己 new 一个 Process 再 `waitUntilExit()`，于是
        // `WineRunner.current` 在整个 regedit 期间都是 nil。而信号源就在
        // 这一步之前注册完毕、`signal(sig, SIG_IGN)` 也已吃掉默认处置 ——
        // 这段时间到达的信号没有可停对象，被静默丢弃（实测 6/6 复现）。
        //
        // 走统一入口后，`current` 覆盖到它，信号在这里也有对象可停。
        // 轮询间隔取 50ms：regedit 只跑一两秒，要让它尽快响应信号。
        let outcome = WineRunner.runChild(
            plan: plan, arguments: ["regedit", "/S", regFile.path],
            output: FileHandle.nullDevice, log: log, drainLimit: 0.05)

        switch outcome {
        case .late:
            // 启动前就欠着信号：压根没起 regedit。用户已经在关，直接收工。
            LauncherLog.write("fontsub 未执行：信号先到", to: log)
            return true
        case .stoppedBySignal(let sig):
            // regedit 被信号停掉：用户已经在关，不能让主程序接着冒出来。
            LauncherLog.write("fontsub 被信号 \(sig) 中止，不再启动主程序", to: log)
            return true
        case .finished(let status):
            if status != 0 {
                // 字体替换失败只影响观感，不影响能否运行，因此不阻断启动
                LauncherLog.write(
                    "WARN fontsub 导入退出码 \(status)，界面字体可能显示为方块",
                    to: log)
            } else {
                LauncherLog.write("fontsub 已导入 \(fonts.count) 条替换", to: log)
            }
            return false
        case .failedToStart:
            LauncherLog.write("WARN 无法执行 regedit", to: log)
            return false
        }
    }
}

// MARK: - 启动

/// 拉起 wine 并把输出落到日志文件，等它退出后返回退出码。
enum WineRunner {
    /// 记录**当前正在跑的 wine 子进程**，供信号处理时清理。
    ///
    /// 这里说的是「所有」wine 子进程，不只是主程序：`FontSubstitution.apply`
    /// 里那次 `wine regedit /S` 也算。它同样会拉起 wineserver、同样会挂住，
    /// 而且它跑的时机正好在信号源注册之后 —— 见下面 `pending` 的说明。
    ///
    /// wine 会再拉起 wineserver，只 kill 直接子进程会留下孤儿进程，
    /// 因此发信号前先让 wine 自己收尾（terminate 发 SIGTERM，wine 会转给 wineserver）。
    nonisolated(unsafe) static var current: Process?

    /// 收到信号时若**还没有子进程可停**，先把信号记在这里。
    ///
    /// ## 为什么必须有这个字段（实测缺陷，2026-11-21）
    ///
    /// 信号源注册在 `FontSubstitution.apply` **之前**。从那一刻到主程序真的
    /// 跑起来之间，`current` 可能是 nil，而 `signal(sig, SIG_IGN)` 已经把
    /// 默认处置吃掉了 —— 于是 handler 里 `current?.terminate()` 是**空操作**：
    /// 信号被静默吞掉，launcher 随后照常把 wine 拉起来，再也停不下来。
    ///
    /// 实测（固定 1.0 秒延迟发 SIGTERM，6/6 复现）：日志里只有「收到信号 15」，
    /// 没有「wine 已启动」，也没有「wine 退出」；25 秒后进程仍在，只能 SIGKILL。
    /// 日志本身看起来一切正常，这正是它藏得住的原因：
    /// **信号"收下了"，只是没人执行**。
    ///
    /// 记下信号，由每个「即将启动子进程」「正在等子进程」的地方检查并消费，
    /// 把从注册信号到 wine 真正跑起来之间整段窗口关掉。
    nonisolated(unsafe) static var pending: Int32?

    /// 本次 `runChild` 已经实际送达过的信号，只用于判定结局。
    ///
    /// `pending` 会被 `drainPending` 清空（这是对的：不能重复发），于是
    /// 「送过了」这件事需要一个单独的记号，否则 `runChild` 结束时看到
    /// pending 为空，会把「我们停的」误判成「它自己退的」。
    nonisolated(unsafe) private static var deliveredSignal: Int32?

    // MARK: - 子进程的统一跑法

    /// 一个 wine 子进程的结局。
    ///
    /// ## 为什么不用裸退出码
    ///
    /// 早先返回 Int32。但「wine 自己以 15 退出」与「我们发信号停了它」在
    /// 退出码上是同一个 15 —— 调用方分不清该不该继续往下走。信号落在
    /// regedit 期间时，regedit 会被停掉，主程序却仍被拉起：用户已经按了关，
    /// 窗口又冒出来一次。结局必须显式。
    enum Outcome {
        /// 子进程正常跑完（不管退出码是多少，那是它自己的事）。
        case finished(Int32)
        /// 因为收到信号被停掉。
        case stoppedBySignal(Int32)
        /// 启动前就欠着信号，压根没起。
        case late
        /// 起不来（缺文件、无权限等）。
        case failedToStart
    }

    /// 跑一个 wine 子进程并等它结束。**所有** wine 子进程都走这里。
    ///
    /// ## 为什么必须收成一个入口
    ///
    /// 早先只有主程序走 `WineRunner`，`FontSubstitution.apply` 自己另写了一份
    /// `Process` + `waitUntilExit()`。于是「登记当前子进程」这件事只有主程序
    /// 做了，apply 期间到达的信号没有可停对象 —— 同一件事两套实现，宽松的
    /// 那一套（不登记）正好落在大窗口上（README 5.3 的红线）。
    ///
    /// 收成一个入口后，`current` 的语义从「主程序」变成「当前 wine 子进程」，
    /// 信号无论落在哪一段都有对象可停。
    static func runChild(plan: RuntimePlan, arguments: [String],
                         output: Any? = nil,
                         log: URL?,
                         drainLimit: TimeInterval = 0.2) -> Outcome {
        // 起子进程之前先看有没有欠着的信号。有就压根别起 —— 起了再杀会留下
        // 一棵需要收尾的进程树，不起是干净的。
        if pending != nil {
            // 不清空：留给调用方判断「本次启动被信号叫停」，由主流程统一收尾。
            LauncherLog.write("已有待处理信号，不再启动 wine 子进程", to: log)
            return .late
        }

        let process = Process()
        process.executableURL = plan.wineBinary
        process.arguments = arguments
        process.environment = plan.environment
        if let output {
            process.standardOutput = output
            process.standardError = output
        }
        // 每个子进程的「送过信号没有」从零开始 —— 上一个子进程的记号不能
        // 带进来，否则 regedit 被停之后，主程序哪怕正常退出也会被判成
        // 「被信号停掉」。
        deliveredSignal = nil
        current = process
        do {
            try process.run()
        } catch {
            current = nil
            LauncherLog.write("FATAL 无法启动 wine：\(error.localizedDescription)", to: log)
            return .failedToStart
        }
        // 「已启动」这一行必须留在 runChild 里 —— 它是「wine 真的起来了」的
        // 唯一证据，`test_phase3.TestRealLaunch` 与排障的人都靠它。重构时漏掉
        // 过一次，表现为用例报「没等到 wine 已启动」而 wine 其实在跑。
        // regedit 这类短命令不写，避免日志噪音；带 output 的是主程序。
        if output != nil {
            LauncherLog.write("wine 已启动 pid=\(process.processIdentifier)", to: log)
        }

        // ## 送达为什么有两个入口
        //
        // `noteSignal`（handler 线程）在 pending 有值且 current 非空时会立刻
        // 送一次，所以大多情况不必等轮询；这里再在启动后立刻补一次，覆盖
        // 「信号早于 current 赋值到达」的窗口；轮询环兜住剩下的竞态。
        // 三条路都只调 `drainPending`，结局统一由 `deliveredSignal` 判定。
        drainPending(log: log)

        while process.isRunning {
            drainPending(log: log)
            Thread.sleep(forTimeInterval: drainLimit)
        }
        let status = process.terminationStatus
        current = nil

        // 不在这里清空 deliveredSignal：调用方（`apply` 与 `main`）要靠它
        // 决定退出码。下一个 `runChild` 开头会重置，不会串到别的子进程。
        if let sig = deliveredSignal {
            return .stoppedBySignal(sig)
        }
        return .finished(status)
    }

    /// signal handler 的唯一入口：先记下信号，再由轮询环送达。
    ///
    /// ## 为什么「记下」与「执行」必须分开
    ///
    /// 早先 handler 自己判 `current == nil`：空则只记 pending，非空则直接
    /// `terminate()`。看着更"及时"，实际让两种到达时机走两条不同的路 ——
    /// `runChild` 只能从 pending 看出「这次是我们停的」，于是非空时送达的
    /// 信号被判成「wine 自己以 15 退出」，退出码语义分叉（实测：
    /// regedit 被停掉后日志写「导入退出码 15…可能显示为方块」，主程序照起）。
    ///
    /// 现在 handler 只做一件事：记下来。送达统一交给 `runChild` 的轮询环，
    /// 200ms（regedit 期间 50ms）内必然送出。多等一个轮询周期的代价，
    /// 换「结局唯一可判定」。
    static func noteSignal(_ sig: Int32, log: URL?) {
        pending = sig
        LauncherLog.write("已记下信号 \(sig)，交由子进程轮询环送达", to: log)
        // 有子进程在跑就立刻送一次，不必等下一轮 —— 记下的同时也送达。
        drainPending(log: log)
    }

    /// 取走「已被信号叫停」的那个信号值。
    ///
    /// 优先用 `deliveredSignal`（真送出去过的那个），它比 `pending` 更准：
    /// 送达时 `pending` 已被清空，只剩这里还有值。两者都为空说明中止原因
    /// 不是信号，调用方不该走这条路。
    static func consumePendingSignal() -> Int32 {
        let sig = deliveredSignal ?? pending ?? SIGTERM
        deliveredSignal = nil
        pending = nil
        return sig
    }

    /// 把「到了但没处发」的信号补发到当前子进程，返回送达的信号值。
    ///
    /// 只在 `current` 存在时消费 pending —— 否则会把信号从一个还发不出去的
    /// 时刻提前丢掉，等于回到修复前的行为。
    @discardableResult
    static func drainPending(log: URL?) -> Int32? {
        guard let sig = pending, current != nil else { return nil }
        pending = nil
        deliveredSignal = sig
        LauncherLog.write("送达信号 \(sig) 到正在跑的 wine", to: log)
        current?.terminate()
        return sig
    }

    static func run(plan: RuntimePlan, appName: String, layout: BundleLayout,
                    log: URL?) -> Int32 {
        let wineLog = layout.wineLogFile(app: appName)
        try? FileManager.default.createDirectory(at: wineLog.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: wineLog.path) {
            FileManager.default.createFile(atPath: wineLog.path, contents: nil)
        }

        // 启动前就欠着信号：连日志文件都不必开，直接返回。
        if pending != nil {
            LauncherLog.write("启动前已有待处理信号，不拉起主程序", to: log)
            return pending ?? 0
        }

        guard let handle = try? FileHandle(forWritingTo: wineLog) else {
            LauncherLog.write("WARN 无法写入 wine 日志，输出改到 stderr", to: log)
            switch runChild(plan: plan, arguments: plan.arguments, log: log) {
            case .finished(let status): return status
            case .stoppedBySignal(let sig): return sig
            case .late: return pending ?? 0
            case .failedToStart: return 1
            }
        }
        handle.seekToEndOfFile()

        // 不用 waitUntilExit()：它内部靠 runloop 轮询，配合信号处理时行为不可控。
        // `runChild` 手动轮询 terminationStatus 更可控，也便于在退出前统一 flush。
        //
        // 退出码语义：被我们发信号停掉时返回信号值本身（15）。这与
        // 「wine 自己收到 SIGTERM 后以 15 退出」是同一个码 —— 同一个用户
        // 操作必须给出同一个码，否则脚本里按退出码判断会时灵时不灵。
        let outcome = runChild(plan: plan, arguments: plan.arguments, output: handle,
                              log: log)
        try? handle.close()
        switch outcome {
        case .finished(let status):
            LauncherLog.write("wine 退出 status=\(status)", to: log)
            return status
        case .stoppedBySignal(let sig):
            LauncherLog.write("wine 被信号 \(sig) 停掉", to: log)
            return sig
        case .late:
            let sig = pending ?? 0
            pending = nil
            LauncherLog.write("启动前已有待处理信号 \(sig)，未拉起主程序", to: log)
            return sig
        case .failedToStart:
            return 1
        }
    }
}

// MARK: - 入口

@main
struct ExeOnMacLauncher {
    static func main() {
        var logTarget: URL?
        do {
            let layout = try BundleLayout()
            logTarget = layout.logFile
            LauncherLog.write("launch start: \(layout.bundle.path)", to: logTarget)

            let compat = try CompatFile.load(layout.compatFile)
            let app = compat.string("app") ?? layout.bundle.deletingPathExtension().lastPathComponent
            LauncherLog.write("app=\(app) entry=\(compat.string("entry") ?? "-")", to: logTarget)

            let plan = try RuntimePlan.make(layout: layout, compat: compat)
            LauncherLog.write("runtime ready: \(plan.wineBinary.path)", to: logTarget)

            // 信号处理：用户按 Ctrl-C 或系统要求退出时，把信号转给 wine，
            // 让它有机会保存配置并关掉 wineserver。直接 _exit 会留下僵尸进程，
            // 下次启动会看到"另一个实例正在运行"。
            //
            // ## 为什么信号源不能挂在 `.main` 队列上
            //
            // `.main` 队列的 handler 由 **main run loop** 调度，而下方
            // `WineRunner.run` 用 `Thread.sleep` 轮询子进程、全程不跑 run loop，
            // 主线程从启动 wine 到退出都在这个循环里。两者叠加的后果是：
            // 信号源注册成功、`signal(sig, SIG_IGN)` 又把默认处置吃掉，
            // 于是 SIGTERM 既不会终止进程，也不会触发 handler ——
            // launcher 对外表现为"杀不掉"，只能 SIGKILL。
            //
            // 实测（sigprobe 最小复现）：同样结构下 `.main` 队列的 handler
            // 8 秒内一次都没执行，换独立串行队列立刻收到。因此这里必须用
            // 自己的队列，不能依赖主线程有空转。
            let signalQueue = DispatchQueue(label: "com.wexe.launcher.signal")
            let signals: [Int32] = [SIGINT, SIGTERM, SIGHUP]
            for sig in signals {
                signal(sig, SIG_IGN)
                let source = DispatchSource.makeSignalSource(signal: sig, queue: signalQueue)
                source.setEventHandler {
                    LauncherLog.write("收到信号 \(sig)，正在停止 wine", to: logTarget)
                    // 一律先记进 pending，再尝试送达 —— 「记下」与「执行」
                    // 必须分开，否则两种到达时机走两条不同的路（有子进程时
                    // 直接 terminate、没有时只记 pending），`runChild` 就分不清
                    // 「我们停的」与「它自己以 15 退的」，退出码语义随之分叉。
                    WineRunner.noteSignal(sig, log: logTarget)
                }
                source.resume()
                signalSources.append(source)
            }

            let interrupted = FontSubstitution.apply(layout: layout, plan: plan,
                                                    fonts: compat.mapping("font_map"),
                                                    log: logTarget)

            // 信号若落在 fontsub 期间，用户已经在关这个应用了 —— 不能再把
            // 主程序拉起来让他看见窗口冒出来。这一步此前缺失：regedit 被停，
            // 主程序照起，等于「按了关反而多开一个窗口」。
            if interrupted {
                // 用记下/送达的实际信号值，不能兜底成 SIGTERM —— 那样 Ctrl-C
                // 会以 15 退出，与「被 SIGTERM 关」不可区分。
                let sig = WineRunner.consumePendingSignal()
                LauncherLog.write("fontsub 被信号中止，退出码 \(sig)", to: logTarget)
                exit(sig)
            }

            let status = WineRunner.run(plan: plan, appName: app, layout: layout, log: logTarget)
            exit(status)
        } catch {
            let message = (error as? LauncherError)?.description ?? "\(error)"
            LauncherLog.write("FATAL \(message)", to: logTarget)
            FileHandle.standardError.write(Data(("ExeOnMac launcher 失败：\n" + message + "\n").utf8))
            exit(1)
        }
    }

    /// 持有信号源，避免被 ARC 提前释放。
    nonisolated(unsafe) static var signalSources: [DispatchSourceSignal] = []
}