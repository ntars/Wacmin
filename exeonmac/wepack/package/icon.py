"""图标提取与角标合成。

工具链只用 sips + iconutil + 仓库内的 tools/badge.swift（铁律：不引入图像库）：

    .exe / .ico
      → 解析 ICONDIR，取尺寸最大且位深最高的一帧
      → PNG 帧直接写出；BMP 帧补 BMP 文件头（并裁掉 AND 掩码）
      → sips 缩放至 1024
      → tools/badge.swift 叠加角标（CoreGraphics）
      → 生成 AppIcon.iconset（16…512 的 @1x/@2x）
      → iconutil -c icns

三个必须踩对的细节，都在实现里写了原因：

1. **DIB 的 height 是双倍**。ICO 里的 BMP 帧高度包含 AND 掩码（1bpp 透明
   掩码），`biHeight` 是「图像高 × 2」。直接交给 sips 会得到一张上下拼接、
   下半部分全黑的怪图。
2. **sips 不认 .ico 里的 DIB**。必须先把 DIB 包成完整 BMP 文件（加 14 字节
   文件头），sips 才肯读。
3. **sips 不认纯 .ico 容器**。实测 `sips -s format png x.ico` 报
   "Cannot extract image from file"，所以走 BMP 中转，不走 ico 直转。
"""

from __future__ import annotations

import shutil
import struct
import subprocess
import tempfile
import zlib
from pathlib import Path

from .. import pe
from ..errors import MissingDependency, UsageError
from ..tools import TEXT_MODE

#: 角标几何与配色（见仓库根 README.md 第 11.2 节）
BADGE_SCALE = 0.25          # 主图标 1/4
BADGE_MARGIN_PX = 4         # 右下角留 4px（1024 基准）
BADGE_OPACITY = 0.9
BADGE_COLOR_WINBLUE = "#0078D4"
BADGE_COLOR_GRAY = "#8E8E93"

#: iconset 需要的尺寸。iconutil 认的命名见 _ICONSET_NAMES。
ICONSET_SIZES = (16, 32, 64, 128, 256, 512, 1024)

#: 1024 主图。小于这个尺寸放大只会糊，但 LaunchServices 仍要求 iconset 完整。
MASTER_SIZE = 1024

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

#: iconutil 认的 iconset 文件名 → 目标像素边长
_ICONSET_NAMES: tuple[tuple[str, int], ...] = (
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
)


# --------------------------------------------------------------------------
# 外部工具
# --------------------------------------------------------------------------


def _require(binary: str) -> str:
    """定位系统工具。sips / iconutil / swiftc 都是 macOS 自带，找不到说明环境异常。"""
    found = shutil.which(binary) or (f"/usr/bin/{binary}"
                                     if Path(f"/usr/bin/{binary}").exists() else None)
    if not found:
        raise MissingDependency(f"缺少系统工具 {binary}", hint="macOS 自带该工具，请检查 PATH")
    return found


def _run(argv: list[str], *, what: str) -> subprocess.CompletedProcess:
    """执行外部命令。失败时把 stderr 原样带进异常，不吞错误。"""
    result = subprocess.run(argv, capture_output=True, **TEXT_MODE)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise UsageError(f"{what} 失败（退出码 {result.returncode}）：{detail}",
                         hint=f"命令：{' '.join(argv[:6])} …")
    return result


# --------------------------------------------------------------------------
# ICO / DIB 解析
# --------------------------------------------------------------------------


def _largest_ico_entry(data: bytes) -> tuple[int, int, int, bytes]:
    """在 .ico 容器里挑最好的一帧。

    返回 `(width, height, bpp, payload)`。

    排序依据是「先尺寸、后位深」：256x256@8bpp 比 32x32@32bpp 更适合当
    应用图标，放大到 1024 时前者只是糊，后者是彻底糊成一团。尺寸相同才
    看位深，因为高位的透明通道更完整。
    """
    if len(data) < 6:
        raise UsageError("图标数据过短，不是合法的 ICO")
    reserved, kind, count = struct.unpack("<HHH", data[:6])
    if reserved != 0 or kind != 1:
        raise UsageError(f"不是 ICO 容器（reserved={reserved} type={kind}）")
    if count == 0:
        raise UsageError("ICO 容器里没有任何条目")

    best: tuple[int, int, int, bytes] | None = None
    best_key = (-1, -1)
    for index in range(count):
        offset = 6 + index * 16
        if offset + 16 > len(data):
            break
        width_b, height_b, _colors, _reserved, _planes, bpp, size, data_offset = \
            struct.unpack("<BBBBHHII", data[offset:offset + 16])
        # 0 表示 256，这是 ICO 格式的历史包袱
        width = width_b or 256
        height = height_b or 256
        payload = data[data_offset:data_offset + size]
        if not payload:
            continue
        key = (width * height, bpp)
        if key > best_key:
            best_key = key
            best = (width, height, bpp, payload)
    if best is None:
        raise UsageError("ICO 里所有条目数据都为空")
    return best


def _dib_to_bmp(dib: bytes) -> bytes:
    """把 ICO 里的 DIB 帧包成 sips 能读的 BMP 文件。

    两个必要修正：

    1. `biHeight` 是图像高度的 **两倍**（含 AND 掩码）。sips 按 BMP 规范读，
       不修正就会把掩码当成图像下半部分，得到上下拼接的怪图。
    2. 只保留像素数据，丢掉 AND 掩码。sips 会自己从 32bpp 的 alpha 通道
       取透明信息，掩码留着反而让它把整张图当成不透明。
    """
    if len(dib) < 40:
        raise UsageError("DIB 头不足 40 字节")
    header_size = struct.unpack("<I", dib[:4])[0]
    if header_size < 40 or header_size > len(dib):
        raise UsageError(f"DIB 头长度异常：{header_size}")

    width, height, _planes, bpp = struct.unpack("<iiHH", dib[4:16])
    if width <= 0 or height == 0:
        raise UsageError(f"DIB 尺寸非法：{width}x{height}")

    real_height = abs(height) // 2 or abs(height)
    if real_height == 0:
        raise UsageError("DIB 高度折算后为 0")

    palette_entries = 0
    if bpp <= 8:
        used = struct.unpack("<I", dib[32:36])[0]
        palette_entries = used or (1 << bpp)
    pixel_offset = 14 + header_size + palette_entries * 4

    row_bytes = ((width * bpp + 31) // 32) * 4
    pixel_bytes = row_bytes * real_height
    body = bytearray(dib[:pixel_offset])
    # biHeight 修正为真实高度
    struct.pack_into("<i", body, 8, real_height)

    available = dib[pixel_offset:pixel_offset + pixel_bytes]
    if len(available) < pixel_bytes:
        # 数据不足时按实际长度裁，宁可少几行也不报错中断整条流水线
        real_height = len(available) // row_bytes if row_bytes else 0
        if real_height == 0:
            raise UsageError("DIB 像素数据为空")
        struct.pack_into("<i", body, 8, real_height)
    body += available

    file_size = 14 + len(body)
    bmp_header = b"BM" + struct.pack("<IHHI", file_size, 0, 0, pixel_offset)
    return bmp_header + bytes(body)


def _frames_from_exe(exe_path: Path) -> bytes:
    """从 .exe 的 RT_GROUP_ICON + RT_ICON 资源重建一个 .ico 容器。

    Windows 把图标拆成两处：RT_GROUP_ICON 存目录（每帧的尺寸/位深/对应
    RT_ICON 的 ID），RT_ICON 存各帧数据。要拼回完整 .ico 才能复用同一套
    解析逻辑，否则要写两份。
    """
    try:
        info = pe.parse(exe_path)
    except pe.PeError as exc:
        raise UsageError(f"无法解析 PE 结构：{exc}") from exc

    entries = pe.resources(info)
    groups = [e for e in entries if e.type_id == pe.RT_GROUP_ICON]
    icons = {e.name_id: e for e in entries if e.type_id == pe.RT_ICON}
    if not groups or not icons:
        raise UsageError(f"{exe_path.name} 不含图标资源")

    # 有多个图标组时取第一个（资源 ID 最小的通常是主图标）
    group = min(groups, key=lambda e: e.name_id)
    raw = pe.resource_bytes(info, group)
    if len(raw) < 6:
        raise UsageError("RT_GROUP_ICON 数据过短")

    _reserved, _kind, count = struct.unpack("<HHH", raw[:6])
    frames: list[tuple[int, int, int, int, int]] = []   # (w, h, bpp, size, icon_id)
    for index in range(count):
        offset = 6 + index * 14
        if offset + 14 > len(raw):
            break
        width_b, height_b, _colors, _reserved, _planes, bpp, size, icon_id = \
            struct.unpack("<BBBBHHIH", raw[offset:offset + 14])
        frames.append((width_b or 256, height_b or 256, bpp, size, icon_id))

    usable = [f for f in frames if f[4] in icons]
    if not usable:
        raise UsageError("图标组引用的 RT_ICON 全部缺失")

    # 重建 ICO：目录按原始顺序，数据紧跟在目录之后
    header = struct.pack("<HHH", 0, 1, len(usable))
    directory = bytearray()
    blobs = bytearray()
    base_offset = 6 + 16 * len(usable)
    for width, height, bpp, _size, icon_id in usable:
        blob = pe.resource_bytes(info, icons[icon_id])
        directory += struct.pack(
            "<BBBBHHII",
            width if width < 256 else 0,
            height if height < 256 else 0,
            0, 0, 1, bpp, len(blob), base_offset + len(blobs),
        )
        blobs += blob
    return header + bytes(directory) + bytes(blobs)


def extract_largest_ico_frame(ico_path: Path, out_png: Path) -> Path:
    """从 `.ico` 或 `.exe` 取出尺寸最大的一帧，转成 PNG，返回 out_png。

    源文件是 `.exe` 时先重建 ICO 容器，后续走同一套路径。
    """
    ico_path = Path(ico_path)
    out_png = Path(out_png)
    if not ico_path.is_file():
        raise UsageError(f"图标源不存在：{ico_path}")

    data = ico_path.read_bytes()
    if data[:2] == b"MZ":
        data = _frames_from_exe(ico_path)
    elif data[:8] == _PNG_SIGNATURE:
        # 直接给 PNG 的情况：拷过去即可，sips 会负责缩放
        out_png.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ico_path, out_png)
        return out_png

    _width, _height, _bpp, payload = _largest_ico_entry(data)

    out_png.parent.mkdir(parents=True, exist_ok=True)
    if payload[:8] == _PNG_SIGNATURE:
        # Vista 之后的大尺寸帧常直接存 PNG，无需中转
        out_png.write_bytes(payload)
        return out_png

    bmp = _dib_to_bmp(payload)
    with tempfile.TemporaryDirectory(prefix="wexe-icon-") as tmp:
        bmp_path = Path(tmp) / "frame.bmp"
        bmp_path.write_bytes(bmp)
        _run([_require("sips"), "-s", "format", "png", str(bmp_path),
              "--out", str(out_png)], what="sips 转换图标帧")
    if not out_png.is_file():
        raise UsageError("sips 未产出 PNG")
    return out_png


# --------------------------------------------------------------------------
# 角标与 icns
# --------------------------------------------------------------------------


def badge_tool() -> Path:
    """返回 badge 可执行文件路径，必要时现场编译。

    编译产物放 `tools/.build/badge`，跟着仓库走，不污染系统临时目录。
    已存在且比源码新则直接复用，避免每次打包都等 1 秒的编译。
    """
    root = Path(__file__).resolve().parents[2]
    source = root / "tools" / "badge.swift"
    binary = root / "tools" / ".build" / "badge"

    if not source.is_file():
        raise MissingDependency(f"缺少角标工具源码：{source}")

    if binary.is_file() and binary.stat().st_mtime >= source.stat().st_mtime:
        return binary

    binary.parent.mkdir(parents=True, exist_ok=True)
    _run([_require("swiftc"), "-O", "-o", str(binary), str(source)],
         what="编译角标工具")
    return binary


def compose_badge(master_png: Path, out_png: Path, *, style: str = "w",
                  color: str = BADGE_COLOR_WINBLUE,
                  layout: str = "corner") -> Path:
    """在主图上叠角标，返回 out_png。

    `style` 取 `w` / `grid` / `none`；`none` 时直接拷贝，不叠加。
    `layout` 取 `corner`（右下角，真实图标）或 `center`（正中大号 W，占位图）。
    """
    master_png = Path(master_png)
    out_png = Path(out_png)
    if style == "none":
        out_png.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(master_png, out_png)
        return out_png

    tool = badge_tool()
    out_png.parent.mkdir(parents=True, exist_ok=True)
    _run([str(tool), str(master_png), str(out_png),
          "--style", style, "--color", color.lstrip("#"),
          "--layout", layout],
         what="合成图标角标")
    return out_png


def build_icns(master_png: Path, out_icns: Path) -> Path:
    """把 1024x1024 PNG 打成 `.icns`，返回 out_icns。

    iconutil 要求 iconset 目录名以 `.iconset` 结尾且文件名严格匹配，
    少一个尺寸就会在 Retina 上退回低分辨率版本。
    """
    master_png = Path(master_png)
    out_icns = Path(out_icns)
    sips = _require("sips")

    with tempfile.TemporaryDirectory(prefix="wexe-icns-") as tmp:
        iconset = Path(tmp) / "AppIcon.iconset"
        iconset.mkdir()
        for name, size in _ICONSET_NAMES:
            target = iconset / name
            _run([sips, "-z", str(size), str(size), str(master_png),
                  "--out", str(target)], what=f"sips 缩放 {name}")
        out_icns.parent.mkdir(parents=True, exist_ok=True)
        _run([_require("iconutil"), "-c", "icns", str(iconset), "-o", str(out_icns)],
             what="iconutil 打包 icns")

    if not out_icns.is_file():
        raise UsageError("iconutil 未产出 icns")
    return out_icns


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    """PNG 块：长度 + 类型 + 数据 + CRC32。"""
    return (struct.pack(">I", len(data)) + kind + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))


def placeholder_icon(out_png: Path, *, color: str = BADGE_COLOR_WINBLUE,
                     size: int = MASTER_SIZE) -> Path:
    """生成一张占位图标：圆角方块底 + 白色 W。

    为什么需要它：不少 Windows 可执行文件确实没有图标资源（控制台程序、
    被裁过的精简版安装包）。这时如果让 `bundle.icon` 校验失败，整个打包
    流程就卡死了 —— 但缺图标的 `.app` 完全能正常运行，只是 Dock 里难看。

    因此降级：生成一张风格统一的占位图标，让产物合法可分发，同时在
    `known_issues` 里记一条。宁可给一张规整的蓝底 W，也不要交付一个
    带空白图标的包，更不要为了图标让整个流程失败。

    直接用 zlib 手写 PNG，不引入 Pillow —— 这里只需要填一个圆角矩形。
    """
    out_png = Path(out_png)
    out_png.parent.mkdir(parents=True, exist_ok=True)

    hex_text = color.lstrip("#")
    if len(hex_text) != 6:
        hex_text = BADGE_COLOR_WINBLUE.lstrip("#")
    red = int(hex_text[0:2], 16)
    green = int(hex_text[2:4], 16)
    blue = int(hex_text[4:6], 16)

    # 圆角半径取边长的 22%，与 badge.swift 的角标保持同一套视觉比例
    radius = size * 0.22
    rows = bytearray()
    for y in range(size):
        rows.append(0)                                # 每行的 filter 类型：None
        for x in range(size):
            # 计算到最近圆角圆心的距离，判断是否落在圆角外
            dx = max(radius - x, x - (size - 1 - radius), 0)
            dy = max(radius - y, y - (size - 1 - radius), 0)
            inside = (dx * dx + dy * dy) <= radius * radius
            if inside:
                rows += bytes((red, green, blue, 255))
            else:
                rows += b"\x00\x00\x00\x00"

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n"
           + _png_chunk(b"IHDR", header)
           + _png_chunk(b"IDAT", zlib.compress(bytes(rows), 9))
           + _png_chunk(b"IEND", b""))
    out_png.write_bytes(png)
    return out_png


def build_app_icon(source: Path, resources_dir: Path, *, style: str = "w",
                   color: str = BADGE_COLOR_WINBLUE) -> Path:
    """一站式：源文件 → `AppIcon.icns`，同时保留 `original.ico`。

    返回 `AppIcon.icns` 路径。中间文件全部在临时目录，不在产物里留垃圾。

    源文件取不到图标资源时降级为占位图标（蓝底 + W），不抛异常 ——
    缺图标的包仍可运行，不该阻断装配。
    """
    source = Path(source)
    resources_dir = Path(resources_dir)
    resources_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="wexe-appicon-") as tmp:
        frame_png = Path(tmp) / "frame.png"
        extracted = True
        try:
            extract_largest_ico_frame(source, frame_png)
        except UsageError:
            # 源文件没有图标资源，或资源结构损坏
            extracted = False
            placeholder_icon(frame_png, color=color)

        master = Path(tmp) / "master.png"
        _run([_require("sips"), "-z", str(MASTER_SIZE), str(MASTER_SIZE),
              str(frame_png), "--out", str(master)], what="sips 放大至 1024")

        badged = Path(tmp) / "badged.png"
        if extracted:
            compose_badge(master, badged, style=style, color=color)
        else:
            # 占位图只有一块蓝底，需要补上居中的白色 W
            compose_badge(master, badged, style=style, color=color, layout="center")

        out_icns = resources_dir / "AppIcon.icns"
        build_icns(badged, out_icns)

    # 原始图标备份：重建时不必再回头找安装包
    try:
        if source.suffix.lower() == ".exe":
            (resources_dir / "original.ico").write_bytes(_frames_from_exe(source))
        elif source.suffix.lower() == ".ico":
            shutil.copyfile(source, resources_dir / "original.ico")
    except (UsageError, OSError):
        # 备份失败不影响主流程：icns 已经生成，重建时用户可用 --icon 指定
        pass

    return out_icns


__all__ = [
    "BADGE_SCALE", "BADGE_MARGIN_PX", "BADGE_OPACITY",
    "BADGE_COLOR_WINBLUE", "BADGE_COLOR_GRAY", "ICONSET_SIZES", "MASTER_SIZE",
    "badge_tool", "build_app_icon", "build_icns", "compose_badge",
    "extract_largest_ico_frame", "placeholder_icon",
]