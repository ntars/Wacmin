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
    static func apply(layout: BundleLayout, plan: RuntimePlan, fonts: [String: String],
                      log: URL?) {
        guard !fonts.isEmpty else { return }

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
            return
        }

        let process = Process()
        process.executableURL = plan.wineBinary
        process.arguments = ["regedit", "/S", regFile.path]
        process.environment = plan.environment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            if process.terminationStatus != 0 {
                // 字体替换失败只影响观感，不影响能否运行，因此不阻断启动
                LauncherLog.write(
                    "WARN fontsub 导入退出码 \(process.terminationStatus)，界面字体可能显示为方块",
                    to: log)
            } else {
                LauncherLog.write("fontsub 已导入 \(fonts.count) 条替换", to: log)
            }
        } catch {
            LauncherLog.write("WARN 无法执行 regedit：\(error.localizedDescription)", to: log)
        }
    }
}

// MARK: - 启动

/// 拉起 wine 并把输出落到日志文件，等它退出后返回退出码。
enum WineRunner {
    /// 记录当前子进程，供信号处理时清理。
    /// wine 会再拉起 wineserver，只 kill 直接子进程会留下孤儿进程，
    /// 因此发信号前先让 wine 自己收尾（terminate 发 SIGTERM，wine 会转给 wineserver）。
    nonisolated(unsafe) static var current: Process?

    static func run(plan: RuntimePlan, appName: String, layout: BundleLayout,
                    log: URL?) -> Int32 {
        let wineLog = layout.wineLogFile(app: appName)
        try? FileManager.default.createDirectory(at: wineLog.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: wineLog.path) {
            FileManager.default.createFile(atPath: wineLog.path, contents: nil)
        }

        let process = Process()
        process.executableURL = plan.wineBinary
        process.arguments = plan.arguments
        process.environment = plan.environment
        process.currentDirectoryURL = plan.workingDirectory

        guard let handle = try? FileHandle(forWritingTo: wineLog) else {
            LauncherLog.write("WARN 无法写入 wine 日志，输出改到 stderr", to: log)
            return runWithoutLog(plan: plan)
        }
        handle.seekToEndOfFile()
        process.standardOutput = handle
        process.standardError = handle

        current = process
        do {
            try process.run()
        } catch {
            LauncherLog.write("FATAL 无法启动 wine：\(error.localizedDescription)", to: log)
            try? handle.close()
            return 1
        }
        LauncherLog.write("wine 已启动 pid=\(process.processIdentifier) → \(wineLog.path)", to: log)

        // 不用 waitUntilExit()：它内部靠 runloop 轮询，配合信号处理时行为不可控。
        // 手动轮询 terminationStatus 更可控，也便于在退出前统一 flush。
        while process.isRunning {
            Thread.sleep(forTimeInterval: 0.2)
        }
        let status = process.terminationStatus
        current = nil
        try? handle.close()
        LauncherLog.write("wine 退出 status=\(status)", to: log)
        return status
    }

    private static func runWithoutLog(plan: RuntimePlan) -> Int32 {
        let process = Process()
        process.executableURL = plan.wineBinary
        process.arguments = plan.arguments
        process.environment = plan.environment
        process.currentDirectoryURL = plan.workingDirectory
        do {
            try process.run()
        } catch {
            return 1
        }
        while process.isRunning {
            Thread.sleep(forTimeInterval: 0.2)
        }
        return process.terminationStatus
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
            let signals: [Int32] = [SIGINT, SIGTERM, SIGHUP]
            for sig in signals {
                signal(sig, SIG_IGN)
                let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
                source.setEventHandler {
                    LauncherLog.write("收到信号 \(sig)，正在停止 wine", to: logTarget)
                    WineRunner.current?.terminate()
                }
                source.resume()
                signalSources.append(source)
            }

            FontSubstitution.apply(layout: layout, plan: plan,
                                   fonts: compat.mapping("font_map"), log: logTarget)

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