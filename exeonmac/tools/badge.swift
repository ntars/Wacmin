// 图标角标合成 —— CoreGraphics，无第三方依赖。
//
// 为什么需要这个工具：`sips` 只能做单图层变换（缩放、转格式、裁剪），
// 不支持把两个图层合成到一张图上。macOS 自带的 `iconutil` 只负责把
// iconset 打包成 icns，也不做绘制。因此叠加角标这一步必须写代码。
//
// 用法：
//   badge <主图.png> <输出.png> [--style w|grid|none] [--color RRGGBB] [--scale 0.25]
//   badge <主图.png> <输出.png> --layout center [--color RRGGBB]
//
// `--layout corner`（默认）在右下角叠角标，用于真实图标。
// `--layout center` 在正中画一个大号白色 W，用于没有图标资源时的占位图。
//
// 角标规格（见仓库根 README.md 第 11.2 节）：
//   尺寸      主图边长的 25%
//   位置      右下角，距边 4px（按 1024 边长折算）
//   不透明度  0.9
//   底色      #0078D4（Windows 蓝）或 #8E8E93（系统灰）

import AppKit
import CoreGraphics
import Foundation

// MARK: - 参数

struct Options {
    var source: String = ""
    var output: String = ""
    var style: String = "w"
    var color: String = "0078D4"
    var scale: Double = 0.25
    var layout: String = "corner"
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("badge: " + message + "\n").utf8))
    exit(2)
}

func parseArguments() -> Options {
    var options = Options()
    var positional: [String] = []
    var index = 1
    let arguments = CommandLine.arguments

    while index < arguments.count {
        let item = arguments[index]
        switch item {
        case "--style":
            index += 1
            guard index < arguments.count else { fail("--style 缺少值") }
            options.style = arguments[index]
        case "--color":
            index += 1
            guard index < arguments.count else { fail("--color 缺少值") }
            options.color = arguments[index]
        case "--scale":
            index += 1
            guard index < arguments.count, let value = Double(arguments[index]) else {
                fail("--scale 需要数字")
            }
            options.scale = value
        case "--layout":
            index += 1
            guard index < arguments.count else { fail("--layout 缺少值") }
            options.layout = arguments[index]
        case "-h", "--help":
            print("用法：badge <主图.png> <输出.png> [--style w|grid|none] [--color RRGGBB] [--scale 0.25] [--layout corner|center]")
            exit(0)
        default:
            positional.append(item)
        }
        index += 1
    }

    guard positional.count == 2 else { fail("需要两个位置参数：主图与输出路径") }
    options.source = positional[0]
    options.output = positional[1]
    return options
}

// MARK: - 颜色

func parseColor(_ hex: String) -> CGColor {
    var text = hex.trimmingCharacters(in: .whitespaces)
    if text.hasPrefix("#") { text.removeFirst() }
    guard text.count == 6, let value = UInt32(text, radix: 16) else {
        fail("颜色格式应为 RRGGBB，收到 \(hex)")
    }
    let red = CGFloat((value >> 16) & 0xFF) / 255.0
    let green = CGFloat((value >> 8) & 0xFF) / 255.0
    let blue = CGFloat(value & 0xFF) / 255.0
    return CGColor(srgbRed: red, green: green, blue: blue, alpha: 0.9)
}

// MARK: - 绘制

/// 画一个圆角方块底。圆角半径取边长的 22%，接近 macOS Big Sur 之后的
/// 图标圆角比例，避免角标看起来像旧版系统的方角按钮。
func fillRoundedSquare(_ context: CGContext, rect: CGRect, color: CGColor) {
    let radius = rect.width * 0.22
    let path = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius,
                      transform: nil)
    context.addPath(path)
    context.setFillColor(color)
    context.fillPath()
}

/// 白色 `W`：用两条斜线加一条竖线拼，不依赖字体 —— 字体缺失会让字形变形。
func drawLetterW(_ context: CGContext, rect: CGRect) {
    let inset = rect.width * 0.26
    let left = rect.minX + inset
    let right = rect.maxX - inset
    let top = rect.maxY - inset
    let bottom = rect.minY + inset
    let midX = rect.midX
    let notchY = bottom + (top - bottom) * 0.42

    context.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
    context.setLineWidth(rect.width * 0.11)
    context.setLineCap(.round)
    context.setLineJoin(.round)

    context.move(to: CGPoint(x: left, y: top))
    context.addLine(to: CGPoint(x: left + (midX - left) * 0.55, y: bottom))
    context.addLine(to: CGPoint(x: midX, y: notchY))
    context.addLine(to: CGPoint(x: right - (right - midX) * 0.55, y: bottom))
    context.addLine(to: CGPoint(x: right, y: top))
    context.strokePath()
}

/// Windows 四格：2x2 方块，中间留缝。用于 `--style grid`。
func drawGrid(_ context: CGContext, rect: CGRect) {
    let gap = rect.width * 0.1
    let cell = (rect.width - gap) / 2
    context.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
    for row in 0..<2 {
        for column in 0..<2 {
            let origin = CGPoint(
                x: rect.minX + CGFloat(column) * (cell + gap),
                y: rect.minY + CGFloat(row) * (cell + gap)
            )
            context.fill(CGRect(origin: origin, size: CGSize(width: cell, height: cell)))
        }
    }
}

func render(options: Options) throws {
    guard let sourceImage = NSImage(contentsOfFile: options.source) else {
        fail("无法读取主图：\(options.source)")
    }
    var proposed = CGRect(origin: .zero, size: sourceImage.size)
    guard let sourceCG = sourceImage.cgImage(forProposedRect: &proposed, context: nil, hints: nil) else {
        fail("主图不是位图：\(options.source)")
    }

    let width = sourceCG.width
    let height = sourceCG.height
    guard width > 0, height > 0 else { fail("主图尺寸为 0") }

    guard let context = CGContext(
        data: nil, width: width, height: height,
        bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        fail("无法创建绘图上下文")
    }

    let canvas = CGRect(x: 0, y: 0, width: width, height: height)
    context.draw(sourceCG, in: canvas)

    if options.layout == "center" {
        // 占位图：整块蓝底已在 PNG 里画好，这里只补一个居中的大号白色 W。
        // 字形占画布的 52%，在 Dock 的小尺寸下仍然清晰可辨。
        let side = CGFloat(min(width, height)) * 0.52
        let rect = CGRect(
            x: (CGFloat(width) - side) / 2,
            y: (CGFloat(height) - side) / 2,
            width: side,
            height: side
        )
        switch options.style {
        case "grid":
            drawGrid(context, rect: rect)
        case "none":
            break
        default:
            drawLetterW(context, rect: rect)
        }
    } else {
        // 角标边长 = 主图边长 * scale，边距按比例折算，保证 16px 图标上也不糊成一团。
        let badgeSide = (CGFloat(min(width, height)) * CGFloat(options.scale)).rounded()
        let margin = max(1.0, (CGFloat(min(width, height)) * 0.004).rounded())
        let badgeRect = CGRect(
            x: canvas.maxX - badgeSide - margin,
            y: canvas.minY + margin,
            width: badgeSide,
            height: badgeSide
        )

        fillRoundedSquare(context, rect: badgeRect, color: parseColor(options.color))

        let glyphRect = badgeRect.insetBy(dx: badgeSide * 0.16, dy: badgeSide * 0.16)
        switch options.style {
        case "grid":
            drawGrid(context, rect: glyphRect)
        case "none":
            break
        default:
            drawLetterW(context, rect: badgeRect)
        }
    }

    guard let output = context.makeImage() else { fail("无法生成输出图") }
    let bitmap = NSBitmapImageRep(cgImage: output)
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        fail("PNG 编码失败")
    }
    try data.write(to: URL(fileURLWithPath: options.output))
}

// MARK: - 入口

let options = parseArguments()
do {
    try render(options: options)
} catch {
    fail("写入失败：\(error.localizedDescription)")
}