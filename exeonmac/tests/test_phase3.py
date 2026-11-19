"""阶段 3 验收测试：.app 包装 + 图标 + launcher。

跑法：
    cd exeonmac && python3 -m unittest tests.test_phase3 -v

不依赖真实安装包：prefix 用临时目录伪造（只要求 drive_c 存在），
图标源用测试内生成的 .ico（PNG 帧与 BMP 帧两种路径都覆盖）。
只有需要真实 wine 的启动测试才走环境变量：
    WEXE_REAL_WINE=1                      启用真实 wine 启动
    WEXE_SAMPLE_NSIS=/path/to/setup.exe   用真实安装包做图标提取
"""

from __future__ import annotations

import os
import plistlib
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from wepack.errors import UsageError, VerifyFailed  # noqa: E402
from wepack.models import CompatConfig, InstallerKind, InstallerRecord  # noqa: E402
from wepack.package import (  # noqa: E402
    build_bundle, bundle_dir_name, ensure_skeleton, repackage,
)
from wepack.package import icon as icon_mod  # noqa: E402
from wepack.package import launcher_build  # noqa: E402
from wepack.package import plist as plist_mod  # noqa: E402
from wepack.package.verify import verify_bundle  # noqa: E402
from wepack.recipes import (  # noqa: E402
    compat_path, dump_compat, parse_compat, read_compat, write_compat,
)

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fixtures  # noqa: E402

#: 样本与环境探测。
#:
#: ## 为什么不再要求设 WEXE_REAL_WINE=1
#:
#: 原来的写法是 `REAL_WINE = os.environ.get("WEXE_REAL_WINE") == "1"`，
#: 于是**wine 明明装着，4 项集成测试却永远跳过**。跳过在报告里是绿的，
#: 看起来「全部通过」—— 守卫没在站岗，没人发现。
#:
#: 现在改为自动探测：`wine_binary()` 会去真实运行时目录找，有就用。
#: 想强制关闭时设 `WEXE_REAL_WINE=0`（例如在没装 wine 的机器上跑）。
SAMPLE_NSIS = os.environ.get("WEXE_SAMPLE_NSIS") or str(fixtures.demo_nsis() or "")
REAL_WINE = fixtures.wine_available()

#: launcher 收到 SIGTERM 后允许的最长退出时间（秒）。
#:
#: 实测修复后为 0.19 秒（wine 直接把信号转给子进程，无需等 wineserver 收树）。
#: 留 20 秒余量是因为真机上 wine 进程树更复杂；超过这个数就说明信号路径又断了，
#: 此时测试**失败**而不是静默 kill —— 一个停不下来的进程是产品缺陷，不是测试问题。
SIGTERM_STOP_SECONDS = 20


# --------------------------------------------------------------------------
# 脚手架
# --------------------------------------------------------------------------


def make_png(path: Path, size: int = 64, rgb: tuple[int, int, int] = (200, 60, 60)) -> Path:
    """生成一张纯色 PNG。用来造图标测试素材，不依赖外部文件。"""
    rows = bytearray()
    for _ in range(size):
        rows.append(0)
        rows += bytes((*rgb, 255)) * size

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
                     + chunk(b"IDAT", zlib.compress(bytes(rows), 6))
                     + chunk(b"IEND", b""))
    return path


def make_bmp_frame(size: int = 32, bpp: int = 32) -> bytes:
    """造一个 ICO 里的 DIB 帧（含双倍高度与 AND 掩码）。"""
    row_bytes = ((size * bpp + 31) // 32) * 4
    mask_row = ((size + 31) // 32) * 4
    pixels = bytes((10, 120, 210, 255)) * size * size
    mask = bytes(mask_row * size)

    header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, bpp,
                         0, len(pixels) + len(mask), 0, 0, 0, 0)
    return header + pixels + mask


def make_ico(path: Path, frames: list[tuple[int, int, bytes]]) -> Path:
    """拼一个 .ico 容器。frames 每项是 (宽, 高, 数据)。"""
    header = struct.pack("<HHH", 0, 1, len(frames))
    directory = bytearray()
    blobs = bytearray()
    base = 6 + 16 * len(frames)
    for width, height, data in frames:
        bpp = 32
        directory += struct.pack("<BBBBHHII",
                                 width if width < 256 else 0,
                                 height if height < 256 else 0,
                                 0, 0, 1, bpp, len(data), base + len(blobs))
        blobs += data
    path.write_bytes(header + bytes(directory) + bytes(blobs))
    return path


def make_app(tmp: Path, *, entry: str = "drive_c/App/app.exe",
             app_name: str = "Demo") -> Path:
    """造一个已装好 prefix 的 .app 骨架（只建目录与假 exe）。"""
    app_dir = tmp / bundle_dir_name(app_name)
    paths = ensure_skeleton(app_dir)
    entry_path = paths["private"] / entry
    entry_path.parent.mkdir(parents=True, exist_ok=True)
    entry_path.write_bytes(b"MZ" + b"\0" * 128)
    return app_dir


# --------------------------------------------------------------------------
# Info.plist
# --------------------------------------------------------------------------


class TestBundleId(unittest.TestCase):
    def test_reverse_domain(self):
        self.assertEqual(plist_mod.make_bundle_id("tencent.wechat"),
                         "com.wexe.win.tencent.wechat")

    def test_prefix_not_duplicated(self):
        """传入已带前缀的值不应产出 com.wexe.win.com.wexe.win.x。"""
        self.assertEqual(plist_mod.make_bundle_id("com.wexe.win.tencent.wechat"),
                         "com.wexe.win.tencent.wechat")

    def test_uppercase_lowered(self):
        self.assertEqual(plist_mod.make_bundle_id("Tencent.WeChat"),
                         "com.wexe.win.tencent.wechat")

    def test_illegal_chars_replaced(self):
        """空格、中文、下划线都转连字符；bundle id 只允许 [a-z0-9-.]。"""
        result = plist_mod.make_bundle_id("My App_测试")
        self.assertTrue(result.startswith("com.wexe.win."))
        self.assertRegex(result, r"^com\.wexe\.win\.[a-z0-9.\-]+$")

    def test_empty_raises(self):
        with self.assertRaises(UsageError):
            plist_mod.make_bundle_id("   ")

    # ----------------------------------------------------------------
    # 非 ASCII 名的唯一性
    #
    # 这一组的由来：bundle id 是 LaunchServices 区分应用的唯一依据，
    # 而归一化会把中文整段吃掉。两个中文应用共用同一个 id 时，
    # LaunchServices 当作同一个应用 —— Dock 只显示一个图标、默认打开
    # 方式互相覆盖、卸载其一会把另一个也摘掉。
    # ----------------------------------------------------------------

    def test_chinese_names_get_distinct_ids(self):
        """纯中文应用名必须得到互不相同的 bundle id。"""
        names = ["记事本", "我的应用", "微信", "网易云音乐", "腾讯会议", "钉钉"]
        ids = {n: plist_mod.make_bundle_id(f"app.{n}", seed=n) for n in names}
        self.assertEqual(len(set(ids.values())), len(names),
                         f"中文应用名撞了 id：{ids}")

    def test_chinese_vendor_gets_distinct_ids(self):
        """
        中文厂商名同样要保留区分度。

        修前 `cn.星玖.测试` 与 `cn.另一个厂商` 都归一化成 `com.wexe.win.cn` ——
        段还在，看起来像成功了，实际把区分度全丢了。
        """
        a = plist_mod.make_bundle_id("cn.星玖.测试", seed="同一个应用")
        b = plist_mod.make_bundle_id("cn.另一个厂商", seed="同一个应用")
        self.assertNotEqual(a, b, f"不同中文厂商撞了 id：{a}")

    def test_partial_charset_loss_also_hashed(self):
        """
        「只丢掉一部分」时也要哈希。

        早先只兜「全部段为空」这一种形态，而 `app.空谷-ondra` 归一化后
        还剩 `app.ondra`，看着非空、实则丢了中文那半截。
        """
        a = plist_mod.make_bundle_id("app.空谷-ondra", seed="空谷 Ondra")
        b = plist_mod.make_bundle_id("app.空谷-另一个", seed="空谷 另一个")
        self.assertNotEqual(a, b)

    def test_pure_ascii_unchanged(self):
        """
        纯 ASCII 不加后缀 —— 否则升级构建会让老用户变成两个应用。
        """
        self.assertEqual(plist_mod.make_bundle_id("tencent.wechat"),
                         "com.wexe.win.tencent.wechat")

    def test_result_still_legal(self):
        """挂了哈希后缀也必须只含 [a-z0-9.-]。"""
        for name in ["记事本", "我的应用", "空谷 Ondra", "QQ音乐"]:
            result = plist_mod.make_bundle_id(f"app.{name}", seed=name)
            self.assertRegex(result, r"^com\.wexe\.win\.[a-z0-9.\-]+$",
                             f"{name} 产出了非法 bundle id：{result}")

    def test_seed_breaks_tie_under_same_vendor(self):
        """
        同一厂商下的多个中文应用：域名相同、只有应用名不同。

        只哈希域名不够 —— 必须把 seed 也拌进去。
        """
        a = plist_mod.make_bundle_id("app", seed="记事本")
        b = plist_mod.make_bundle_id("app", seed="我的应用")
        self.assertNotEqual(a, b)


class TestBundleName(unittest.TestCase):
    def test_short_kept(self):
        self.assertEqual(plist_mod.make_bundle_name("微信"), "微信")

    def test_truncated_to_15(self):
        name = plist_mod.make_bundle_name("1234567890123456789")
        self.assertEqual(len(name), 15)
        self.assertEqual(name, "123456789012345")

    def test_cjk_truncation_is_whole_chars(self):
        """按码点截断，不能截出半个字。"""
        name = plist_mod.make_bundle_name("一二三四五六七八九十一二三四五六七")
        self.assertEqual(len(name), 15)
        self.assertFalse(name.endswith("\ufffd"))

    def test_trailing_punctuation_trimmed(self):
        self.assertEqual(plist_mod.make_bundle_name("ABCDEFGHIJKLMNO..."),
                         "ABCDEFGHIJKLMNO")

    def test_empty_fallback(self):
        self.assertEqual(plist_mod.make_bundle_name("   "), "App")


class TestVersion(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(plist_mod.normalize_version("3.9.10"),
                         ("3.9.10", "3.9.10"))

    def test_prerelease_build_is_numeric(self):
        """CFBundleVersion 必须是纯数字点分，非数字段换 0。"""
        short, build = plist_mod.normalize_version("3.9.10-beta.2")
        self.assertEqual(short, "3.9.10-beta.2")
        self.assertRegex(build, r"^[0-9.]+$")
        self.assertEqual(build, "3.9.10.0.2")

    def test_empty_defaults(self):
        self.assertEqual(plist_mod.normalize_version(None), ("1.0", "1.0"))
        self.assertEqual(plist_mod.normalize_version(""), ("1.0", "1.0"))

    def test_all_zero_falls_back(self):
        """全是 0 的版本没有比较意义。"""
        self.assertEqual(plist_mod.normalize_version("0.0.0")[1], "1.0")


class TestPlistDocument(unittest.TestCase):
    def test_required_keys(self):
        doc = plist_mod.build_plist(app_name="微信",
                                    bundle_id="com.wexe.win.tencent.wechat",
                                    version="3.9.10")
        for key in ("CFBundleName", "CFBundleDisplayName", "CFBundleIdentifier",
                    "CFBundleExecutable", "CFBundlePackageType", "CFBundleIconFile",
                    "CFBundleShortVersionString", "CFBundleVersion",
                    "LSMinimumSystemVersion", "NSHighResolutionCapable",
                    "LSApplicationCategoryType"):
            self.assertIn(key, doc)

    def test_no_dock_hiding_keys(self):
        """LSUIElement / LSBackgroundOnly 设了就没有 Dock 图标。"""
        doc = plist_mod.build_plist(app_name="X", bundle_id="com.wexe.win.x.y",
                                    version="1.0")
        self.assertNotIn("LSUIElement", doc)
        self.assertNotIn("LSBackgroundOnly", doc)

    def test_display_name_suffix(self):
        doc = plist_mod.build_plist(app_name="7-Zip", bundle_id="com.wexe.win.a.b",
                                    version="24.08")
        self.assertEqual(doc["CFBundleDisplayName"], "7-Zip (Win)")

    def test_document_types_only_when_requested(self):
        plain = plist_mod.build_plist(app_name="X", bundle_id="com.wexe.win.a.b",
                                      version="1.0")
        self.assertNotIn("CFBundleDocumentTypes", plain)
        with_types = plist_mod.build_plist(app_name="X", bundle_id="com.wexe.win.a.b",
                                           version="1.0",
                                           file_associations=[".7z", ".zip"])
        self.assertEqual(len(with_types["CFBundleDocumentTypes"]), 1)
        self.assertIn("public.7z",
                      with_types["CFBundleDocumentTypes"][0]["LSItemContentTypes"])

    def test_write_is_plutil_valid(self):
        """落盘的文件必须能被 plutil -lint 通过。"""
        with tempfile.TemporaryDirectory() as tmp:
            app_dir = Path(tmp) / "T (Win).app"
            target = plist_mod.write_plist(app_dir, app_name="T",
                                           bundle_id="com.wexe.win.t.t",
                                           version="1.0")
            self.assertTrue(target.is_file())
            result = subprocess.run(["plutil", "-lint", str(target)],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_special_chars_escaped(self):
        """应用名带 & < > 时 plist 仍合法 —— 手写 XML 最容易在这里出错。"""
        with tempfile.TemporaryDirectory() as tmp:
            app_dir = Path(tmp) / "A (Win).app"
            target = plist_mod.write_plist(app_dir, app_name="A&B<C>",
                                           bundle_id="com.wexe.win.a.b",
                                           version="1.0")
            with open(target, "rb") as fh:
                doc = plistlib.load(fh)
            self.assertEqual(doc["CFBundleDisplayName"], "A&B<C> (Win)")


# --------------------------------------------------------------------------
# compat.yaml
# --------------------------------------------------------------------------


class TestCompatRoundtrip(unittest.TestCase):
    def _sample(self) -> CompatConfig:
        return CompatConfig(
            app="微信", version="3.9.10",
            entry="drive_c/Program Files/Tencent/WeChat/WeChat.exe",
            installer=InstallerRecord(kind=InstallerKind.NSIS,
                                      silent_args=" /S", completed=True),
            layers=["base", "vcpp", "fonts-cn"],
            font_map={"微软雅黑": "PingFang SC", "宋体": "Songti SC"},
            file_associations=[".7z"],
            known_issues=["需要中文字体层"],
            bundle_id="com.wexe.win.tencent.wechat",
            icon_source="exe:drive_c/x.exe#0",
        )

    def test_roundtrip(self):
        config = self._sample()
        restored = parse_compat(dump_compat(config))
        self.assertEqual(restored.app, config.app)
        self.assertEqual(restored.version, config.version)
        self.assertEqual(restored.entry, config.entry)
        self.assertEqual(restored.installer.kind, InstallerKind.NSIS)
        self.assertEqual(restored.installer.silent_args, " /S")
        self.assertTrue(restored.installer.completed)
        self.assertEqual(restored.layers, config.layers)
        self.assertEqual(restored.font_map, config.font_map)
        self.assertEqual(restored.file_associations, [".7z"])
        self.assertEqual(restored.bundle_id, config.bundle_id)

    def test_field_order_stable(self):
        """字段顺序固定，diff 才不会每写一次就变。"""
        text = dump_compat(self._sample())
        keys = [line.split(":")[0] for line in text.splitlines()
                if line and not line.startswith(" ")]
        self.assertEqual(keys[:3], ["app", "version", "entry"])

    def test_leading_space_in_silent_args_preserved(self):
        """NSIS 的 " /S" 前导空格是语义的一部分，丢了会拼出错误的命令行。"""
        text = dump_compat(self._sample())
        self.assertIn('silent_args: " /S"', text)
        self.assertEqual(parse_compat(text).installer.silent_args, " /S")

    def test_numeric_version_stays_string(self):
        """版本号 24.08 不能变成浮点 24.08（会丢末尾 0）。"""
        config = self._sample()
        config.version = "24.08"
        self.assertEqual(parse_compat(dump_compat(config)).version, "24.08")

    def test_hash_in_path_not_comment(self):
        """icon_source 里的 #0 是内容，不能当注释切掉。"""
        text = dump_compat(self._sample())
        self.assertIn("#0", text)
        self.assertEqual(parse_compat(text).icon_source, "exe:drive_c/x.exe#0")

    def test_empty_lists(self):
        config = CompatConfig(app="X", entry="drive_c/a.exe")
        restored = parse_compat(dump_compat(config))
        self.assertEqual(restored.file_associations, [])
        self.assertEqual(restored.known_issues, [])
        self.assertEqual(restored.layers, ["base"])

    def test_base_always_first(self):
        config = CompatConfig(app="X", entry="drive_c/a.exe",
                              layers=["vcpp", "base"])
        restored = parse_compat(dump_compat(config))
        self.assertEqual(restored.layers[0], "base")

    def test_missing_app_raises(self):
        with self.assertRaises(UsageError):
            parse_compat("entry: drive_c/a.exe\n")

    def test_missing_entry_raises(self):
        with self.assertRaises(UsageError):
            parse_compat("app: X\n")

    def test_bad_syntax_reports_line(self):
        """报错必须带行号 —— 只说"解析失败"对用户毫无帮助。"""
        text = "app: X\nentry: drive_c/a.exe\n  孤立缩进\n"
        with self.assertRaises(UsageError) as ctx:
            parse_compat(text)
        self.assertIn("3", str(ctx.exception))

    def test_unknown_installer_kind_degrades(self):
        """读到不认识的类型降级为 unknown，不报错 —— 兼容新版本写出的文件。"""
        text = ("app: X\nentry: drive_c/a.exe\ninstaller:\n"
                "  type: futuristic\n  completed: true\n")
        self.assertEqual(parse_compat(text).installer.kind, InstallerKind.UNKNOWN)

    def test_write_and_read_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            app_dir = Path(tmp) / "X (Win).app"
            write_compat(self._sample(), app_dir)
            self.assertTrue(compat_path(app_dir).is_file())
            self.assertEqual(read_compat(app_dir).app, "微信")

    def test_read_missing_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(UsageError):
                read_compat(Path(tmp) / "Nothing.app")


# --------------------------------------------------------------------------
# 图标
# --------------------------------------------------------------------------


class TestIcoExtraction(unittest.TestCase):
    def test_png_frame_passthrough(self):
        """Vista 之后的 256x256 帧常直接存 PNG，应原样取出。"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            png = make_png(tmp_path / "frame.png", 64)
            ico = make_ico(tmp_path / "a.ico", [(64, 64, png.read_bytes())])
            out = icon_mod.extract_largest_ico_frame(ico, tmp_path / "out.png")
            self.assertEqual(out.read_bytes(), png.read_bytes())

    def test_bmp_frame_converted(self):
        """BMP 帧要补文件头并裁掉 AND 掩码，否则尺寸会变成两倍高。"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            ico = make_ico(tmp_path / "b.ico", [(32, 32, make_bmp_frame(32))])
            out = icon_mod.extract_largest_ico_frame(ico, tmp_path / "out.png")
            self.assertTrue(out.is_file())
            result = subprocess.run(["sips", "-g", "pixelHeight", str(out)],
                                    capture_output=True, text=True)
            self.assertIn("32", result.stdout)

    def test_picks_largest_frame(self):
        """多帧时选尺寸最大的，不是第一个。"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            small = make_png(tmp_path / "s.png", 16, (255, 0, 0))
            large = make_png(tmp_path / "l.png", 128, (0, 255, 0))
            ico = make_ico(tmp_path / "c.ico", [
                (16, 16, small.read_bytes()),
                (128, 128, large.read_bytes()),
            ])
            out = icon_mod.extract_largest_ico_frame(ico, tmp_path / "out.png")
            self.assertEqual(out.read_bytes(), large.read_bytes())

    def test_missing_source_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(UsageError):
                icon_mod.extract_largest_ico_frame(
                    Path(tmp) / "nope.ico", Path(tmp) / "out.png")

    def test_not_an_ico_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.ico"
            bad.write_bytes(b"not an icon at all")
            with self.assertRaises(UsageError):
                icon_mod.extract_largest_ico_frame(bad, Path(tmp) / "out.png")


class TestPlaceholderIcon(unittest.TestCase):
    def test_generates_valid_png(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = icon_mod.placeholder_icon(Path(tmp) / "ph.png", size=64)
            self.assertTrue(out.is_file())
            self.assertEqual(out.read_bytes()[:8], b"\x89PNG\r\n\x1a\n")
            result = subprocess.run(["sips", "-g", "pixelWidth", str(out)],
                                    capture_output=True, text=True)
            self.assertIn("64", result.stdout)


class TestIconPipeline(unittest.TestCase):
    def test_build_app_icon(self):
        """完整链路：ico → 缩放 → 角标 → icns。"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            ico = make_ico(tmp_path / "src.ico", [(64, 64, make_bmp_frame(64))])
            resources = tmp_path / "Resources"
            out = icon_mod.build_app_icon(ico, resources, style="w")
            self.assertEqual(out.name, "AppIcon.icns")
            self.assertGreater(out.stat().st_size, 1000)
            # 原始图标应被备份
            self.assertTrue((resources / "original.ico").is_file())

    def test_icns_has_1024_representation(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            ico = make_ico(tmp_path / "src.ico", [(64, 64, make_bmp_frame(64))])
            out = icon_mod.build_app_icon(ico, tmp_path / "Resources")
            result = subprocess.run(["sips", "-g", "pixelWidth", str(out)],
                                    capture_output=True, text=True)
            self.assertIn("1024", result.stdout)

    def test_style_none_skips_badge(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            master = make_png(tmp_path / "m.png", 128)
            out = icon_mod.compose_badge(master, tmp_path / "o.png", style="none")
            self.assertEqual(out.read_bytes(), master.read_bytes())

    def test_no_icon_resource_degrades_to_placeholder(self):
        """源文件没有图标资源时降级为占位图，不抛异常。"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            empty = tmp_path / "empty.ico"
            empty.write_bytes(struct.pack("<HHH", 0, 1, 0))
            out = icon_mod.build_app_icon(empty, tmp_path / "Resources")
            self.assertTrue(out.is_file())


# --------------------------------------------------------------------------
# launcher 编译与注册
# --------------------------------------------------------------------------


class TestLauncherBuild(unittest.TestCase):
    def test_source_exists(self):
        self.assertTrue(launcher_build.launcher_source().is_file())

    def test_compile(self):
        """编译到临时目录，断言是 arm64 Mach-O 且可执行。"""
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "Contents" / "MacOS" / "launcher"
            out = launcher_build.compile_launcher(dest, use_cache=False)
            self.assertTrue(out.is_file())
            self.assertTrue(os.access(out, os.X_OK))
            result = subprocess.run(["file", str(out)], capture_output=True, text=True)
            self.assertIn("arm64", result.stdout)

    def test_cache_reused(self):
        """第二次编译应走缓存（毫秒级）。"""
        import time
        with tempfile.TemporaryDirectory() as tmp:
            first = Path(tmp) / "a" / "launcher"
            launcher_build.compile_launcher(first, use_cache=True)
            started = time.monotonic()
            second = Path(tmp) / "b" / "launcher"
            launcher_build.compile_launcher(second, use_cache=True)
            self.assertLess(time.monotonic() - started, 1.0)
            self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_missing_source_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(Exception):
                launcher_build.compile_launcher(Path(tmp) / "x",
                                                source=Path(tmp) / "nope.swift")


# --------------------------------------------------------------------------
# 装配与校验
# --------------------------------------------------------------------------


class TestBundleAssembly(unittest.TestCase):
    def test_bundle_dir_name(self):
        self.assertEqual(bundle_dir_name("7-Zip"), "7-Zip (Win).app")
        self.assertEqual(bundle_dir_name("微信"), "微信 (Win).app")

    def test_slash_in_name_replaced(self):
        """应用名里的 / 会把目录名切出一个子目录，必须替换。"""
        self.assertNotIn("/", bundle_dir_name("a/b"))

    def test_ensure_skeleton_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            app_dir = Path(tmp) / "X (Win).app"
            first = ensure_skeleton(app_dir)
            second = ensure_skeleton(app_dir)
            self.assertEqual(first, second)
            for path in second.values():
                self.assertTrue(path.is_dir())

    def test_missing_prefix_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            app_dir = Path(tmp) / "X (Win).app"
            ensure_skeleton(app_dir)
            with self.assertRaises(UsageError):
                build_bundle(app_dir, app_name="X", bundle_id="com.wexe.win.a.b",
                             version="1.0", entry="drive_c/a.exe",
                             register=False)

    def test_not_app_suffix_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(UsageError):
                build_bundle(Path(tmp) / "plain", app_name="X",
                             bundle_id="com.wexe.win.a.b", version="1.0",
                             entry="drive_c/a.exe", register=False)

    def test_full_assembly(self):
        """端到端：骨架 + compat + plist + 图标 + launcher + 校验。"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            app_dir = make_app(tmp_path, app_name="Demo")
            ico = make_ico(tmp_path / "src.ico", [(64, 64, make_bmp_frame(64))])

            report = build_bundle(
                app_dir, app_name="Demo", bundle_id="com.wexe.win.demo.demo",
                version="1.2.3", entry="drive_c/App/app.exe",
                icon_source=ico, register=False,
                installer=InstallerRecord(kind=InstallerKind.NSIS, completed=True),
            )

            self.assertTrue(report.ok, [c.to_dict() for c in report.checks])
            self.assertTrue(report.plist.is_file())
            self.assertTrue(report.icon.is_file())
            self.assertTrue(report.launcher.is_file())
            self.assertTrue(report.compat.is_file())
            self.assertFalse(report.registered)

            # 结构必须符合仓库根 README.md 第 10.2 节的 run-report 契约
            contents = app_dir / "Contents"
            for rel in ("Info.plist", "PkgInfo", "MacOS/launcher",
                        "Resources/AppIcon.icns", "Resources/Private/drive_c",
                        "Recipes/compat.yaml"):
                self.assertTrue((contents / rel).exists(), rel)

    def test_assembly_without_icon_source_uses_entry(self):
        """没指定图标时用入口 exe 作源。假 exe 没资源 → 降级占位图。"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            app_dir = make_app(tmp_path, app_name="Demo")
            report = build_bundle(app_dir, app_name="Demo",
                                  bundle_id="com.wexe.win.demo.demo",
                                  version="1.0", entry="drive_c/App/app.exe",
                                  register=False)
            self.assertTrue(report.ok, [c.to_dict() for c in report.checks])
            self.assertTrue(report.icon.is_file())

    def test_repackage_preserves_config(self):
        """repackage 只重建可变部分，不丢 compat 里的字段。"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            app_dir = make_app(tmp_path, app_name="Demo")
            ico = make_ico(tmp_path / "src.ico", [(64, 64, make_bmp_frame(64))])
            build_bundle(app_dir, app_name="Demo", bundle_id="com.wexe.win.demo.demo",
                         version="2.0", entry="drive_c/App/app.exe",
                         icon_source=ico, register=False,
                         font_map={"微软雅黑": "PingFang SC"},
                         known_issues=["测试问题"])
            report = repackage(app_dir, register=False)
            self.assertTrue(report.ok)
            config = read_compat(app_dir)
            self.assertEqual(config.font_map, {"微软雅黑": "PingFang SC"})
            self.assertEqual(config.known_issues, ["测试问题"])
            self.assertEqual(config.version, "2.0")


class TestVerify(unittest.TestCase):
    def test_good_bundle_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            app_dir = make_app(tmp_path, app_name="Demo")
            ico = make_ico(tmp_path / "s.ico", [(64, 64, make_bmp_frame(64))])
            build_bundle(app_dir, app_name="Demo", bundle_id="com.wexe.win.demo.demo",
                         version="1.0", entry="drive_c/App/app.exe",
                         icon_source=ico, register=False)
            report = verify_bundle(app_dir)
            self.assertTrue(report.ok, [c.to_dict() for c in report.checks])

    def test_missing_icon_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            app_dir = make_app(tmp_path, app_name="Demo")
            ico = make_ico(tmp_path / "s.ico", [(64, 64, make_bmp_frame(64))])
            build_bundle(app_dir, app_name="Demo", bundle_id="com.wexe.win.demo.demo",
                         version="1.0", entry="drive_c/App/app.exe",
                         icon_source=ico, register=False)
            (app_dir / "Contents/Resources/AppIcon.icns").unlink()
            report = verify_bundle(app_dir)
            self.assertFalse(report.ok)
            self.assertIn("bundle.icon", [c.name for c in report.failures])

    def test_missing_executable_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            app_dir = make_app(tmp_path, app_name="Demo")
            ico = make_ico(tmp_path / "s.ico", [(64, 64, make_bmp_frame(64))])
            build_bundle(app_dir, app_name="Demo", bundle_id="com.wexe.win.demo.demo",
                         version="1.0", entry="drive_c/App/app.exe",
                         icon_source=ico, register=False)
            (app_dir / "Contents/MacOS/launcher").unlink()
            report = verify_bundle(app_dir)
            self.assertFalse(report.ok)
            self.assertIn("bundle.executable", [c.name for c in report.failures])

    def test_missing_entry_detected(self):
        """compat.yaml 的 entry 指向不存在的文件 → 校验必须抓出来。"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            app_dir = make_app(tmp_path, app_name="Demo")
            ico = make_ico(tmp_path / "s.ico", [(64, 64, make_bmp_frame(64))])
            build_bundle(app_dir, app_name="Demo", bundle_id="com.wexe.win.demo.demo",
                         version="1.0", entry="drive_c/App/app.exe",
                         icon_source=ico, register=False)
            (app_dir / "Contents/Resources/Private/drive_c/App/app.exe").unlink()
            report = verify_bundle(app_dir)
            self.assertFalse(report.ok)
            self.assertIn("compat.entry_exists",
                          [c.name for c in report.failures])

    def test_hidden_app_detected(self):
        """设了 LSUIElement 就没有 Dock 图标，必须报出来。"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            app_dir = make_app(tmp_path, app_name="Demo")
            ico = make_ico(tmp_path / "s.ico", [(64, 64, make_bmp_frame(64))])
            build_bundle(app_dir, app_name="Demo", bundle_id="com.wexe.win.demo.demo",
                         version="1.0", entry="drive_c/App/app.exe",
                         icon_source=ico, register=False)
            plist_path = app_dir / "Contents/Info.plist"
            with open(plist_path, "rb") as fh:
                doc = plistlib.load(fh)
            doc["LSUIElement"] = True
            with open(plist_path, "wb") as fh:
                plistlib.dump(doc, fh)
            report = verify_bundle(app_dir)
            self.assertFalse(report.ok)
            self.assertIn("plist.visible_in_dock",
                          [c.name for c in report.failures])

    def test_raise_if_failed(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = verify_bundle(Path(tmp) / "Nothing.app")
            with self.assertRaises(VerifyFailed):
                report.raise_if_failed()


# --------------------------------------------------------------------------
# 真实启动（需 wine）
# --------------------------------------------------------------------------


@unittest.skipUnless(REAL_WINE, "需要 WEXE_REAL_WINE=1 与已安装的 wine 运行时")
class TestRealLaunch(unittest.TestCase):
    def test_launcher_starts_wine(self):
        """真实启动：launcher 应把 wine 拉起来并写入日志。

        用 base 层里的 notepad.exe 作入口，不依赖额外安装包。
        """
        from wepack import paths as wexe_paths

        base = wexe_paths.layers_root() / "base"
        if not (base / "drive_c/windows/notepad.exe").is_file():
            self.skipTest("base 层未构建")

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            app_dir = tmp_path / "Note (Win).app"
            paths = ensure_skeleton(app_dir)
            # ## 必须复制「内容」到 private/，不是复制 base 目录本身
            #
            # `cp -cR base private` 会得到 `private/base/drive_c/...`，
            # 于是 build_bundle 看到的 `private/drive_c` 不存在，报
            # 「prefix 不存在」。源路径结尾加 `/.` 才是复制内容。
            #
            # 这条测试此前一直被 `WEXE_REAL_WINE=1` 挡在门外，所以这个
            # 写法错误从来没被发现 —— 门一开就露出来了。
            subprocess.run(["cp", "-cR", f"{base}/.", str(paths["private"])],
                           check=True)
            config = CompatConfig(
                app="Note", version="1.0",
                entry="drive_c/windows/notepad.exe",
                installer=InstallerRecord(kind=InstallerKind.UNKNOWN, completed=True),
                bundle_id="com.wexe.win.note.note",
                font_map={"微软雅黑": "PingFang SC"},
            )
            write_compat(config, app_dir)
            build_bundle(app_dir, app_name="Note",
                         bundle_id="com.wexe.win.note.note", version="1.0",
                         entry="drive_c/windows/notepad.exe",
                         installer=config.installer, font_map=config.font_map,
                         register=False)

            # ## 共享根目录里必须有 runtime/wine
            #
            # launcher 只认 `$WEXE_HOME/runtime/wine`（与 wepack/paths.py
            # 的 wexe_home() 一致），没有就 FATAL。测试为了隔离日志把
            # WEXE_HOME 指到临时目录，那里自然是空的。
            #
            # 用软链接把真实的 runtime 接进来：wine 是全局共享的只读资源，
            # 链接过去既真实又不占空间；logs / layers 仍落在临时目录，
            # 测试之间互不干扰。
            home = tmp_path / "home"
            home.mkdir(parents=True, exist_ok=True)
            real_runtime = wexe_paths.runtime_root()
            if real_runtime.is_dir():
                (home / "runtime").symlink_to(real_runtime)

            env = dict(os.environ, WEXE_HOME=str(home))
            process = subprocess.Popen(
                [str(app_dir / "Contents/MacOS/launcher")],
                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                import time
                deadline = time.monotonic() + 30
                log = tmp_path / "home" / "logs" / "launcher.log"
                while time.monotonic() < deadline:
                    if log.is_file() and "wine 已启动" in log.read_text(encoding="utf-8"):
                        break
                    time.sleep(0.2)
                text = log.read_text(encoding="utf-8") if log.is_file() else ""
                self.assertIn("wine 已启动", text)

                # ## SIGTERM 必须真的停得下来，这是产品契约不是测试便利
                #
                # 早先这里只写 `terminate()` 然后 `wait(timeout=60)`，超时就
                # `kill()` 兜底 —— 于是「launcher 收不到信号、只能 SIGKILL」
                # 这个真实缺陷被兜底逻辑整个吞掉了：测试一直是绿的，代价是
                # 每个用例白等 60 秒（单跑实测 63.3 秒，而其中真正验证的部分
                # 只有约 3 秒）。
                #
                # 根因在 `DispatchSource.makeSignalSource(queue: .main)`：main
                # 队列的 handler 由 main run loop 调度，而 `WineRunner.run` 用
                # `Thread.sleep` 轮询子进程、全程不跑 run loop，两者叠加后
                # 信号既不触发 handler（已被 `signal(sig, SIG_IGN)` 吃掉默认
                # 处置）、也不终止进程。
                #
                # 所以这里必须**断言**两件事，缺一不可：
                #   1. 日志里出现「收到信号」，证明 handler 真的执行过
                #   2. 进程在 SIGTERM_STOP_SECONDS 内退出，证明不是靠 kill 兜底
                process.terminate()
                stopped = True
                try:
                    process.wait(timeout=SIGTERM_STOP_SECONDS)
                except subprocess.TimeoutExpired:
                    stopped = False
                    process.kill()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        pass
                text = log.read_text(encoding="utf-8") if log.is_file() else ""
                self.assertIn("收到信号", text,
                              f"launcher 没处理 SIGTERM，日志尾部：{text[-500:]}")
                self.assertTrue(
                    stopped,
                    f"SIGTERM 后 {SIGTERM_STOP_SECONDS} 秒仍未退出，"
                    f"只能靠 SIGKILL 收尾。日志尾部：{text[-500:]}")
            finally:
                # ## 管道必须显式关闭
                #
                # wait() 只回收进程，**不关** stdout/stderr —— 这两个
                # BufferedReader 要等 GC 才释放。套件跑完时会冒出
                # `ResourceWarning: unclosed file`，虽然不影响结果，
                # 但真有 fd 泄漏时也会被同样一句警告盖住，等于噪音
                # 把真问题埋了。这里读完再关，行为上更严谨。
                for stream in (process.stdout, process.stderr):
                    try:
                        if stream is not None and not stream.closed:
                            stream.close()
                    except (OSError, ValueError):
                        pass

                # ## 最后按 prefix 收一次 wine 进程
                #
                # terminate() 只杀了测试自己启动的 launcher，而 launcher
                # 拉起的 wine 进程树（notepad.exe + explorer.exe）会脱离
                # 进程组继续活着。实测：跑完整个套件后 Dock 里留着 2 个
                # wine 图标，是 notepad 与 explorer 挂在已删除的临时
                # prefix 上。
                #
                # wineserver -k 按 WINEPREFIX 匹配，正好只清这一个 prefix，
                # 不碰其他测试或用户自己的 wine 进程。
                try:
                    from wepack.install import kill_prefix_processes

                    kill_prefix_processes(paths["private"])
                except Exception:      # noqa: BLE001 - 收尾失败不该改变测试结论
                    pass


if __name__ == "__main__":
    unittest.main()