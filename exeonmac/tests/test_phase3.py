"""阶段 3 验收测试：.app 包装 + 图标 + launcher。

跑法：
    cd exeonmac && python3 -m unittest tests.test_phase3 -v

不依赖真实安装包：prefix 用临时目录伪造（按 `prefix.validate_prefix` 的最低要求造齐
system32 / dosdevices / 三个 .reg），图标源用测试内生成的 .ico（PNG 帧与 BMP 帧两种
路径都覆盖）。只有需要真实 wine 的启动测试才走环境变量：
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
from wepack.prefix import REG_ARCH_64, REG_HEADER  # noqa: E402
from wepack.package import (  # noqa: E402
    build_bundle, bundle_dir_name, ensure_skeleton, repackage,
)
from wepack import pe as pe_mod  # noqa: E402
from wepack.package import icon as icon_mod  # noqa: E402
from wepack.package import launcher_build  # noqa: E402
from wepack.package import plist as plist_mod  # noqa: E402
from wepack.package.verify import verify_bundle  # noqa: E402
from wepack.recipes import (  # noqa: E402
    compat_path, dump_compat, parse_compat, read_compat, write_compat,
)

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fixtures  # noqa: E402

#: 样本与环境探测一律走惰性函数，**模块顶层不留任何求值**。
#:
#: ## 为什么不再要求设 WEXE_REAL_WINE=1
#:
#: 原来的写法是 `REAL_WINE = os.environ.get("WEXE_REAL_WINE") == "1"`，
#: 于是**wine 明明装着，4 项集成测试却永远跳过**。跳过在报告里是绿的，
#: 看起来「全部通过」—— 守卫没在站岗，没人发现。现在改为自动探测：
#: `wine_binary()` 会去真实运行时目录找，有就用。想强制关闭时设
#: `WEXE_REAL_WINE=0`。
#:
#: ## 为什么第 9 轮连自动探测也从模块顶层挪走
#:
#: `REAL_WINE = fixtures.wine_available()` 看着无副作用，实际**在导入时
#: 就把结论定型了**：早先导入时若 `WEXE_HOME` 指向临时目录（没有 wine），
#: 本模块的真实启动用例此后永远跳过，哪怕后来环境里出现了 wine。
#: 第 8 轮修的是「导入即编译」，这一处是「导入即定论」，同一个错误：
#: 模块级的求值结果不会跟着环境变。改用 `setUpClass` + `require_*()`。

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


def _min_pe_bytes() -> bytes:
    """造一个结构合法、能被 `pe.parse` 读通的最小 PE32+（无资源、无 overlay）。

    与 `test_phase1.build_min_pe` 同构，但这里不跨模块导入 —— 两个测试
    模块各自独立跑是常态，夹具依赖会让单跑一个文件时失败。
    """
    e_lfanew = 0x40
    opt_size = 240
    header_size = e_lfanew + 24 + opt_size + 40        # 一个 .text 节
    raw_ptr = (header_size + 0x1FF) & ~0x1FF
    raw_size = 0x200

    dos = bytearray(e_lfanew)
    dos[0:2] = b"MZ"
    struct.pack_into("<I", dos, 0x3C, e_lfanew)

    coff = bytearray(20)
    struct.pack_into("<H", coff, 0, 0x8664)            # x86_64
    struct.pack_into("<H", coff, 2, 1)                 # 1 个节
    struct.pack_into("<H", coff, 16, opt_size)

    opt = bytearray(opt_size)
    struct.pack_into("<H", opt, 0, 0x20B)              # PE32+
    struct.pack_into("<Q", opt, 24, 0x140000000)       # ImageBase
    struct.pack_into("<H", opt, 68, 2)                 # Subsystem=GUI
    struct.pack_into("<I", opt, 56, 0x4000)            # SizeOfImage

    sec = bytearray(40)
    sec[0:6] = b".text\0"
    struct.pack_into("<I", sec, 8, raw_size)           # VirtualSize
    struct.pack_into("<I", sec, 12, 0x1000)            # VirtualAddress
    struct.pack_into("<I", sec, 16, raw_size)          # SizeOfRawData
    struct.pack_into("<I", sec, 20, raw_ptr)           # PointerToRawData

    body = bytearray(raw_ptr + raw_size)
    body[0:e_lfanew] = dos
    body[e_lfanew:e_lfanew + 4] = b"PE\0\0"
    off = e_lfanew + 4
    body[off:off + 20] = coff
    body[off + 20:off + 20 + opt_size] = opt
    body[off + 20 + opt_size:off + 20 + opt_size + 40] = sec
    return bytes(body)


def make_truncated_pe(path: Path) -> Path:
    """造一个「节区表声称的长度 > 实际长度」的 PE —— 即被截断的文件。

    砍掉最后一个节尾部 16 字节，`pe.truncated()` 必须为 True，
    而 `parse()` 仍能读通（头与节区表都在文件前部）。
    """
    path.write_bytes(_min_pe_bytes()[:-16])
    return path


def make_noicon_pe(path: Path) -> Path:
    """造一个完整但没有资源表的 PE —— 正常的「无图标」样本。"""
    path.write_bytes(_min_pe_bytes())
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
    """造一个已装好 prefix 的 .app 骨架（只建目录与假 exe）。

    ## 为什么连 system32 / dosdevices / .reg 一起造

    这里的目标是「一个真的装了东西的 prefix」。早先只建 `drive_c/App/`，
    看着够用，但那样造出来的 prefix 连 wine 都起不来（实测 `could not
    load kernel32.dll, status c0000135`）。装配校验曾经只断言 `drive_c`
    是个目录，所以假 prefix 也能 10/10 全绿 —— 夹具与判据一起弱，
    缺陷就藏得住。现在夹具按 `validate_prefix` 的最低要求造齐：
    system32 非空、`dosdevices/c:` 是相对软链、三个 `.reg` 非空。
    """
    app_dir = tmp / bundle_dir_name(app_name)
    paths = ensure_skeleton(app_dir)
    private = paths["private"]

    # wine 认得出这个 prefix 的最低要求，逐条对应 prefix.validate_prefix
    system32 = private / "drive_c" / "windows" / "system32"
    system32.mkdir(parents=True, exist_ok=True)
    (system32 / "kernel32.dll").write_bytes(b"MZ" + b"\0" * 64)

    dosdevices = private / "dosdevices"
    dosdevices.mkdir(parents=True, exist_ok=True)
    c_link = dosdevices / "c:"
    if c_link.is_symlink() or c_link.exists():
        c_link.unlink()
    os.symlink("../drive_c", c_link)          # 相对路径，包可移动

    # 注册表按 validate_prefix 的判据造齐：纯 ASCII、首行是版本行、
    # system.reg 带 #arch=win64。早先写的是 UTF-16LE+BOM 且无 arch，
    # 那个文件 wine 实测判「not a valid registry file」+「32 位安装」、rc=1
    # —— 夹具造出来的 prefix 自己就跑不起来，判据跟着一起宽松，缺陷才绿着。
    for name in ("system.reg", "user.reg", "userdef.reg"):
        (private / name).write_bytes(
            f"{REG_HEADER}\n;; test fixture\n{REG_ARCH_64}\n".encode("ascii"))

    entry_path = private / entry
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


class TestIcoTruncationIsNotEmptiness(unittest.TestCase):
    """「文件不全」与「没有这个资源」必须是两条不同的路（第 19 轮新增）。

    ## 这条锁住的是什么（2026-11-22 实测，带真实样本）

    三处同形缺陷，全部是「两种相反原因共用一句话 / 共用一条分支」：

    1. `_dib_to_bmp()` 的 `header_size < 40 or header_size > len(dib)`：
       12 字节（OS/2 老格式，真不认识）与 4000 字节（文件只有 100 字节，
       真被截断）报的都是「DIB 头长度异常」。
    2. `_largest_ico_entry()` 的 payload 用切片取，越界时静默变短：
       一个声明 payload=1000 字节、实际文件 22 字节的 ICO，报的是
       「ICO 里所有条目数据都为空」—— 目录项完整、尺寸位深全对，只是
       数据没下完。用户会去换图标，实际该做的是重下。
    3. `build_app_icon()` 的 `except UsageError` 把「截断」也当「没图标」，
       于是真实 `notepad.exe` 截到 50000 字节会得到 `ok=True` + 占位图 +
       **零告警**。

    `assertRaises(UsageError)` 对这三条全是绿的，因为它只要求「抛了」。
    所以每条都断言文案，并在第 3 条上断言「不许静默成功」。
    """

    def test_dib_header_too_small_says_unsupported_format(self) -> None:
        """`header_size < 40` 是「格式不认识」，不许说成「被截断」。"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            frame = bytearray(make_bmp_frame(64))
            struct.pack_into("<I", frame, 0, 12)      # BITMAPCOREHEADER
            ico = make_ico(tmp_path / "a.ico", [(64, 64, bytes(frame))])
            with self.assertRaises(UsageError) as ctx:
                icon_mod.extract_largest_ico_frame(ico, tmp_path / "o.png")
            message = str(ctx.exception)
            self.assertIn("不支持", message, f"实际：{message}")
            self.assertNotIn("截断", message, f"实际：{message}")

    def test_dib_header_longer_than_data_says_truncated(self) -> None:
        """`header_size > len(dib)` 是「文件不全」，指引必须是重下。"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            # 声明 4000 字节头，但整个 DIB 只有 100 字节（且 ICO 目录如实
            # 记录 size=100，绕过「payload 短于声明」那一层，直达 _dib_to_bmp）
            frame = bytearray(100)
            struct.pack_into("<I", frame, 0, 4000)
            struct.pack_into("<iiHH", frame, 4, 64, 128, 1, 32)
            ico = make_ico(tmp_path / "b.ico", [(64, 64, bytes(frame))])
            with self.assertRaises(UsageError) as ctx:
                icon_mod.extract_largest_ico_frame(ico, tmp_path / "o.png")
            message = str(ctx.exception)
            self.assertIn("截断", message, f"实际：{message}")
            self.assertNotIn("不支持", message, f"实际：{message}")

    def test_ico_directory_truncated_names_the_shortfall(self) -> None:
        """目录声明 N 条却装不下第 N 条时，报「目录被截断」并给出字节数。"""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "c.ico"
            # 声明 3 条，只给 1 条目录项的空间
            path.write_bytes(struct.pack("<HHH", 0, 1, 3)
                             + struct.pack("<BBBBHHII", 64, 64, 0, 0, 1, 32, 16, 22))
            with self.assertRaises(UsageError) as ctx:
                icon_mod.extract_largest_ico_frame(path, Path(tmp) / "o.png")
            message = str(ctx.exception)
            self.assertIn("目录被截断", message, f"实际：{message}")
            self.assertIn("38", message, f"应给出需要的字节数，实际：{message}")

    def test_ico_payload_shorter_than_declared_is_truncation(self) -> None:
        """payload 声明 1000 字节但文件只有 22 字节——不许报「数据为空」。"""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "d.ico"
            path.write_bytes(struct.pack("<HHH", 0, 1, 1)
                             + struct.pack("<BBBBHHII", 64, 64, 0, 0, 1, 32, 1000, 22))
            with self.assertRaises(UsageError) as ctx:
                icon_mod.extract_largest_ico_frame(path, Path(tmp) / "o.png")
            message = str(ctx.exception)
            self.assertIn("截断", message, f"实际：{message}")
            self.assertNotIn("所有条目数据都为空", message, f"实际：{message}")

    def test_truncated_exe_raises_pe_truncated_not_usage(self) -> None:
        """截断的 exe 走图标路径时，抛的是 `PeTruncatedError`，不是 `UsageError`。

        这一条是整组的关键：`build_app_icon` 用 `except UsageError` 判
        「降级为占位图」，所以只要截断被包装成 `UsageError`，就一定会
        静默降级。类型本身即是判据。
        """
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            exe = make_truncated_pe(tmp_path / "cut.exe")
            self.assertTrue(pe_mod.truncated(pe_mod.parse(exe)),
                            "夹具本身必须是截断的")
            with self.assertRaises(pe_mod.PeTruncatedError):
                icon_mod.extract_largest_ico_frame(exe, tmp_path / "o.png")

    def test_build_app_icon_does_not_silently_degrade_on_truncation(self) -> None:
        """截断的 exe 不许静默产出占位图 —— 必须抛错让上层报 WARN。"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            exe = make_truncated_pe(tmp_path / "cut.exe")
            resources = tmp_path / "Resources"
            with self.assertRaises(pe_mod.PeTruncatedError):
                icon_mod.build_app_icon(exe, resources)
            self.assertFalse((resources / "AppIcon.icns").is_file(),
                             "截断时不该产出任何 icns")

    def test_build_app_icon_still_degrades_when_really_no_icon(self) -> None:
        """完整但确实没有图标的 exe 仍要降级为占位图 —— 别把正路堵死。

        这条与上一条是一对：判据必须能分开两种失败，而不是一刀切禁止降级。
        """
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            exe = make_noicon_pe(tmp_path / "noicon.exe")
            resources = tmp_path / "Resources"
            out = icon_mod.build_app_icon(exe, resources)
            self.assertTrue(out.is_file(), "无图标资源时应降级为占位图")
            self.assertEqual(out.name, "AppIcon.icns")


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


class TestPrefixHealthGuard(unittest.TestCase):
    """`prefix.valid` 这条校验的回归锁。

    ## 为什么需要这一组

    早先 `verify_bundle` 只断言 `Private/drive_c` 是个目录。只要那个目录
    还在，把 system32 清空、三个 `.reg` 全删、`dosdevices/c:` 改成普通
    文件，校验照样 **10/10 全绿**、`wepack package` 照样退 0。而同一份
    prefix 交给真实 wine 是直接起不来的（实测 `could not load
    kernel32.dll, status c0000135`，rc=53）。

    即：用户会拿到一个「打包成功、双击毫无反应」的 .app。四条用例分别锁
    「缺什么会被点名」与「什么都不缺时不许误报」两头。
    """

    def _bundle(self, tmp_path: Path) -> Path:
        app_dir = make_app(tmp_path, app_name="Demo")
        ico = make_ico(tmp_path / "s.ico", [(64, 64, make_bmp_frame(64))])
        build_bundle(app_dir, app_name="Demo", bundle_id="com.wexe.win.demo.demo",
                     version="1.0", entry="drive_c/App/app.exe",
                     icon_source=ico, register=False)
        return app_dir

    def test_healthy_prefix_passes(self):
        """造齐的 prefix 必须判过 —— 防矫枉过正，把正常包也拦下。"""
        with tempfile.TemporaryDirectory() as tmp:
            app_dir = self._bundle(Path(tmp))
            report = verify_bundle(app_dir)
            self.assertTrue(report.ok, [c.to_dict() for c in report.failures])
            self.assertIn("prefix.valid", [c.name for c in report.checks])

    def test_missing_registry_detected(self):
        """缺 .reg 的 prefix，wine 起不来，校验必须报出来。"""
        with tempfile.TemporaryDirectory() as tmp:
            app_dir = self._bundle(Path(tmp))
            private = app_dir / "Contents/Resources/Private"
            for name in ("system.reg", "user.reg", "userdef.reg"):
                (private / name).unlink()
            report = verify_bundle(app_dir)
            self.assertFalse(report.ok)
            self.assertIn("prefix.valid", [c.name for c in report.failures])
            detail = next(c.detail for c in report.failures if c.name == "prefix.valid")
            self.assertIn("system.reg", detail)

    def test_empty_system32_detected(self):
        """system32 还在但被清空 —— 只看「目录存在」会漏，必须看内容。"""
        with tempfile.TemporaryDirectory() as tmp:
            app_dir = self._bundle(Path(tmp))
            system32 = app_dir / "Contents/Resources/Private/drive_c/windows/system32"
            shutil.rmtree(system32)
            system32.mkdir()
            report = verify_bundle(app_dir)
            self.assertFalse(report.ok)
            detail = next(c.detail for c in report.failures if c.name == "prefix.valid")
            self.assertIn("system32 为空", detail)

    def test_broken_dosdevices_link_detected(self):
        """dosdevices/c: 不是软链 → wine 的 C: 盘不存在。"""
        with tempfile.TemporaryDirectory() as tmp:
            app_dir = self._bundle(Path(tmp))
            link = app_dir / "Contents/Resources/Private/dosdevices/c:"
            link.unlink()
            link.write_bytes(b"not a symlink")
            report = verify_bundle(app_dir)
            self.assertFalse(report.ok)
            detail = next(c.detail for c in report.failures if c.name == "prefix.valid")
            self.assertIn("dosdevices/c:", detail)

    def test_check_uses_prefix_module_not_own_copy(self):
        """判据必须来自 `wepack.prefix.validate_prefix`，不许在这里另写一套。

        同一判据两处各写一套，改一处必漏另一处（README 5.3）。做法是往
        prefix 里造一个只有 `validate_prefix` 认得出的问题，看校验是否跟着变红。
        """
        import wepack.package.verify as verify_mod
        source = Path(verify_mod.__file__).read_text(encoding="utf-8")
        self.assertIn("from ..prefix import validate_prefix", source)
        self.assertNotIn('(private / "drive_c").is_dir()', source)


# --------------------------------------------------------------------------
# 真实启动（需 wine）
# --------------------------------------------------------------------------


class TestRealLaunch(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not fixtures.wine_ready():
            raise unittest.SkipTest("需要已安装的 wine 运行时")

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

                # ## 两条字体键必须都真的落进 prefix 的注册表文件
                #
                # 静态守卫只能保证「代码里写了这两行」，不能保证「regedit 真的
                # 把它们吃进去了」。第 11 轮栽的就是这个：代码、断言、日志全都
                # 说「已导入 2 条替换」，实测零键写入。
                #
                # ## 为什么断言必须放在这里（本轮踩了两次）
                #
                # 第一版把这段放在「wine 已启动」之后，当场红了：`user.reg` 里
                # 找不到 `Replacements`。不是没写进去，而是**wine 还没落盘** ——
                # 注册表在 wineserver 活着期间是内存里的，日志说「已导入」时读
                # 文件，读到的必然是变更前的旧内容。
                #
                # 第二版改成 `wineserver -w`（等它自己收尾）仍然红。实测：
                # `-w` 只是「等 wineserver 退出」，而 launcher 退出后 wineserver
                # 仍以服务身份活着，`-w` 会一直等到超时；只有 `-k`（让它退出）
                # 才触发回写。对照实测：`-w` 后 `user.reg` 里 `Replacements`
                # 命中 0 次，`-k` 后命中 1 次。
                #
                # 这也说明一件事：「日志说成功」和「磁盘上是这样」之间隔着一次
                # 落盘，中间任何时刻读文件都不算证据。
                try:
                    from wepack.install import wine_binary

                    subprocess.run([str(wine_binary()), "wineserver", "-k"],
                                   env=dict(os.environ,
                                            WINEPREFIX=str(paths["private"])),
                                   capture_output=True, timeout=60)
                    # 回写是异步的：`-k` 返回后文件还要过一小会儿才更新。
                    import time as _time

                    deadline = _time.monotonic() + 15
                    while _time.monotonic() < deadline:
                        if "Replacements" in (paths["private"] / "user.reg").read_text(
                                encoding="utf-8", errors="replace"):
                            break
                        _time.sleep(0.2)
                except Exception:      # noqa: BLE001 - 落盘失败会在下面断言里暴露
                    pass

                system_reg = (paths["private"] / "system.reg").read_text(
                    encoding="utf-8", errors="replace")
                user_reg = (paths["private"] / "user.reg").read_text(
                    encoding="utf-8", errors="replace")
                self.assertIn("FontSubstitutes", system_reg,
                              "GDI 的 FontSubstitutes 应写进 system.reg（HKLM）")
                self.assertIn("Replacements", user_reg,
                              "DirectWrite 的 Replacements 应写进 user.reg（HKCU）")
                # 映射本身也得在：键在但值为空等于没替换。
                self.assertIn("PingFang SC", system_reg,
                              "GDI 那条键里缺少中文映射值")
                self.assertIn("PingFang SC", user_reg,
                              "DirectWrite 那条键里缺少中文映射值")
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


# --------------------------------------------------------------------------
# 启动窗口内的信号（不需要真实 wine）
# --------------------------------------------------------------------------


class TestSignalDuringStartupWindow(unittest.TestCase):
    """信号落在「已注册 handler、但 wine 还没起来」这段窗口里，必须也能停下。

    ## 这是第 2 轮遗留①，实测 6/6 复现的真缺陷

    第 2 轮把信号源从 `.main` 队列挪到独立串行队列，修掉了「SIGTERM 后
    90 秒仍在」的问题；但当时只测了「wine 已启动之后」发信号这一种时序。
    实际情况是信号源注册在 `FontSubstitution.apply` **之前**，而 apply 里
    要跑一次 `wine regedit /S`（本机实测约 3 秒）。这段时间：

      - `WineRunner.current` 还是 nil
      - `signal(sig, SIG_IGN)` 已经把默认处置吃掉了

    于是 handler 里 `current?.terminate()` 是**空操作**：日志写了「收到信号
    15」，进程却照常把 wine 拉起来，然后永远不退出。实测（固定 1.0 秒延迟
    发 SIGTERM，6/6 复现）：只等到「收到信号」，25 秒后进程仍在，只能
    SIGKILL。日志本身看着一切正常 —— **信号"收下了"，只是没人执行**。

    ## 为什么不用真实 wine 也能测

    缺陷出在「handler 到了、子进程还没有」这个**时序**上，与 wine 是什么
    无关。用一个「起来就睡住」的假 wine 反而更好：窗口被撑到可控，不依赖
    真机上 apply 恰好耗时几秒，也不会在快机器上偶发通过。

    假 wine 一被调用就写哨兵文件，所以「信号被忽略、wine 照样被拉起」这个
    失败态有直接证据，而不只是看退出码。
    """

    #: 假 wine 收到调用后睡多久。远大于下面等信号的时间，保证它不会自己退出。
    FAKE_WINE_SLEEP = 120.0

    def _bundle(self, tmp: Path, sentinel: Path) -> Path:
        """造一个 .app，其 wine 是「留痕 + 睡住」的假货。"""
        app_dir = make_app(tmp, entry="drive_c/App/app.exe", app_name="Sigwin")
        private = app_dir / "Contents" / "Resources" / "Private"

        conf = CompatConfig(
            app="Sigwin", version="1.0", entry="drive_c/App/app.exe",
            installer=InstallerRecord(kind=InstallerKind.UNKNOWN, completed=True),
            bundle_id="com.wexe.win.sigwin.sigwin",
            # 非空 font_map 才会真的跑 apply 里那次 regedit，
            # 而这正是缺陷窗口的来源。留空就绕过了，测不到东西。
            font_map={"微软雅黑": "PingFang SC"},
        )
        write_compat(conf, app_dir)
        build_bundle(app_dir, app_name="Sigwin",
                     bundle_id="com.wexe.win.sigwin.sigwin", version="1.0",
                     entry="drive_c/App/app.exe", installer=conf.installer,
                     font_map=conf.font_map, register=False)

        # 假 wine 放在共享根目录下，launcher 只认 $WEXE_HOME/runtime/wine/bin/wine64
        wine_bin = tmp / "home" / "runtime" / "wine" / "bin"
        wine_bin.mkdir(parents=True)
        script = wine_bin / "wine64"
        script.write_text(
            "#!/bin/sh\n"
            # 每次被调用都留痕：regedit 那次与主程序那次都会记。
            f'printf "%s\\n" "$*" >> "{sentinel}"\n'
            f"sleep {self.FAKE_WINE_SLEEP}\n",
            encoding="utf-8",
        )
        script.chmod(0o755)
        return app_dir

    def _run_and_signal(self, app_dir: Path, tmp: Path, sig: int):
        """启动 launcher，等它进入窗口后发信号，返回 (是否停, 退出码, 日志)。"""
        import signal as signal_mod
        import time

        home = tmp / "home"
        env = dict(os.environ, WEXE_HOME=str(home))
        proc = subprocess.Popen(
            [str(app_dir / "Contents" / "MacOS" / "launcher")],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        log = home / "logs" / "launcher.log"
        try:
            # ## 等什么、不等什么，是这组用例的关键
            #
            # 早先所有启动类用例都等「wine 已启动」才发信号 —— 那正好**跳过**
            # 了缺陷窗口，所以 6 次实测全绿。这里必须等到「runtime ready」，
            # 即信号源已注册、但 wine 还没起来的那一刻。
            deadline = time.monotonic() + 30
            entered = False
            while time.monotonic() < deadline:
                text = log.read_text(encoding="utf-8", errors="replace") if log.is_file() else ""
                if "runtime ready" in text:
                    entered = True
                    break
                if proc.poll() is not None:
                    break
                time.sleep(0.02)
            self.assertTrue(entered, "launcher 没走到 runtime ready，无法定位窗口")

            proc.send_signal(sig)
            stopped = True
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                stopped = False
                proc.kill()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
        finally:
            for stream in (proc.stdout, proc.stderr):
                try:
                    if stream is not None and not stream.closed:
                        stream.close()
                except (OSError, ValueError):
                    pass

        text = log.read_text(encoding="utf-8", errors="replace") if log.is_file() else ""
        return stopped, proc.returncode, text

    def _assert_stopped_in_window(self, sig: int, name: str) -> None:
        import signal as signal_mod

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            sentinel = tmp_path / "wine-calls.log"
            app_dir = self._bundle(tmp_path, sentinel)

            stopped, code, text = self._run_and_signal(app_dir, tmp_path, sig)

            self.assertTrue(
                stopped,
                f"{name} 落在启动窗口内时 launcher 停不下来（15 秒仍在）。"
                f"日志尾部：{text[-600:]}")
            # 退出码要与「wine 被信号停掉」那条路径一致，同一个用户操作
            # 不能给出两个码（详见 main.swift 第一道检查点处的说明）。
            self.assertEqual(code, sig,
                             f"{name} 的退出码应为 {sig}（与 wine 被停掉时一致），"
                             f"实际 {code}。日志尾部：{text[-600:]}")

            calls = sentinel.read_text(encoding="utf-8") if sentinel.is_file() else ""
            # ## 这条才是缺陷的直接证据，比退出码更硬
            #
            # 修复前：信号被忽略后 launcher 照常把 wine 拉起来，于是哨兵里
            # 有主程序那次调用（`drive_c/App/app.exe`）。修复后：启动前就
            # 发现 pending，直接返回，主程序一次都不许被调用 ——
            # **只在 regedit 那次留痕是允许的**（它发生在窗口之前）。
            self.assertNotIn(
                "app.exe", calls,
                f"{name} 落在启动窗口内时 wine 主程序仍被拉起（哨兵记录：{calls!r}）"
                "—— 说明信号被静默丢弃了")

    def test_sigterm_in_startup_window_stops_launcher(self) -> None:
        """SIGTERM 落在窗口内也要停得下来。"""
        import signal as signal_mod

        self._assert_stopped_in_window(signal_mod.SIGTERM, "SIGTERM")

    def test_sigint_in_startup_window_stops_launcher(self) -> None:
        """SIGINT 同一条路径（三个信号共用一段 handler，但只测一个不够）。"""
        import signal as signal_mod

        self._assert_stopped_in_window(signal_mod.SIGINT, "SIGINT")

    def test_pending_is_consumed_not_replayed(self) -> None:
        """pending 只能送达一次，不许在后续轮询里反复 terminate。

        反复 `terminate()` 本身不致命（进程已死时是空操作），但会掩盖
        「pending 没被清空」这类编程错误，也让日志里出现一串无意义的
        「送达信号」。这里静态断言送达路径有清空动作。
        """
        source = (REPO / "launcher" / "Sources" / "main.swift").read_text(
            encoding="utf-8")
        drain = source.split("static func drainPending")[1].split("\n    }")[0]
        self.assertIn("pending = nil", drain,
                      "送达后必须清空 pending，否则每轮轮询都会重复送达")

    def test_handler_records_pending_when_no_child(self) -> None:
        """handler 必须把信号记下来，不能只写日志、也不能自己判空后丢弃。

        这是缺陷的根因所在：`current?.terminate()` 在 nil 上是空操作，
        而默认处置已被 `signal(sig, SIG_IGN)` 关掉 —— 只写日志等于吞信号。
        """
        source = (REPO / "launcher" / "Sources" / "main.swift").read_text(
            encoding="utf-8")
        handler = source.split("source.setEventHandler")[1].split("source.resume()")[0]
        self.assertIn("WineRunner.noteSignal(sig", handler,
                      "handler 必须调 noteSignal 把信号记下来，否则窗口内到达的信号会被丢弃")
        # noteSignal 内部必须真的写 pending，否则「记下」是空的。
        note = source.split("static func noteSignal")[1].split("\n    }")[0]
        self.assertIn("pending = sig", note,
                      "noteSignal 必须写 pending，它是「信号已到但还没送达」的唯一事实来源")

    def test_every_wine_child_goes_through_one_runner(self) -> None:
        """所有 wine 子进程必须走 `runChild`，不许有第二份 Process 实现。

        这条是本缺陷的结构性成因：`FontSubstitution.apply` 早先自己 new 一个
        `Process` 再 `waitUntilExit()`，于是整个 regedit 期间 `current` 都是
        nil，信号没有可停对象。同一件事两套实现、宽松的那套落在大窗口上 ——
        只修「记 pending」而不统一入口，下次再加一个 wine 调用就会重现。
        """
        source = (REPO / "launcher" / "Sources" / "main.swift").read_text(
            encoding="utf-8")
        # 允许的出现处：runChild 自己一处（它在函数体内 argv 已定）。
        occurrences = source.count("Process()")
        self.assertEqual(
            occurrences, 1,
            f"launcher 里只许有一处 `Process()`（即 runChild），实际 {occurrences} 处 —— "
            "另起一个就会再次出现「有子进程但信号找不到它」")


# --------------------------------------------------------------------------
# 字体替换真的写进去了没有（不需要真实 wine 的部分）
# --------------------------------------------------------------------------


class TestFontSubstitutionFormat(unittest.TestCase):
    """## 这个类是「字体替换从上线的第一天起就没生效过」的回归锁。

    缺陷（2026-11-21 实测）：`FontSubstitution.apply` 写出的 `fontsub.reg`
    用的是 wine **内部格式**（首行 `WINE REGISTRY Version 2`、键路径双反斜杠）。
    实测 `wine regedit /S` 对该格式 **退出码 0、stderr 空、零键写入**，
    紧接着 `reg query` 同一条键报 `Unable to find the specified registry key`。
    而 launcher 的日志一直写「fontsub 已导入 2 条替换」。

    这与第 7 轮在 Python 侧修掉的 `install.suppress_restart` 是同一根因
    （把导出格式当成存储格式），当时只在 Python 侧扫过，Swift 侧漏了。
    """

    def setUp(self) -> None:
        self.source = (REPO / "launcher" / "Sources" / "main.swift").read_text(
            encoding="utf-8")

    def _apply_body(self) -> str:
        return self.source.split("static func apply(")[1].split(
            "\n    /// 导入后回查")[0]

    def test_writes_export_format_header(self) -> None:
        """首行必须是 `Windows Registry Editor Version 5.00`。

        内部格式那一行（`WINE REGISTRY Version 2`）只许出现在注释里 ——
        注释里那句是在解释「为什么不用它」，不许是真正写进文件的内容。
        """
        body = self._apply_body()
        code = "\n".join(line for line in body.splitlines()
                         if not line.strip().startswith("//"))
        self.assertIn("Windows Registry Editor Version 5.00", code,
                      "fontsub.reg 首行必须是导出格式头，否则 regedit /S 静默不写")
        self.assertNotIn("WINE REGISTRY Version 2", code,
                         "内部格式（WINE REGISTRY Version 2）会被 regedit /S 静默丢弃")

    def test_key_path_is_fully_qualified_and_single_escaped(self) -> None:
        """键路径必须是 `HKEY_LOCAL_MACHINE\\...` 全名 + 单反斜杠。

        内部格式用 `Software\\\\...` 双反斜杠且不带根键，导出格式两者都不同。

        ## 根键为什么从 HKCU 改成 HKLM（2026-11-21 第 12 轮实测）

        早先这里断言的是 `HKEY_CURRENT_USER`，理由是「不需要管理员权限」。
        第 12 轮三组对照证明 **wine 的 GDI 只读 HKLM 那一份**：

        | 写法 | 替换表里有 | 最终选中 |
        |---|---|---|
        | HKCU `FontSubstitutes` | 无 | `Courier New`（未替换） |
        | HKLM `FontSubstitutes` | 有 | `PingFang SC Regular` |
        | HKCU `Wine\\Fonts\\Replacements` | 有 | `PingFang SC Regular` |

        即 HKCU 那份写进去也算注册表数据，但**没有代码去读它** —— 第 11 轮
        修好了格式（键写得进去了），字体仍没替换成功，原因就在这里。
        """
        self.assertIn('"HKEY_LOCAL_MACHINE\\\\Software\\\\Microsoft\\\\Windows NT\\\\'
                      'CurrentVersion\\\\FontSubstitutes"',
                      self.source,
                      "字体替换必须写 HKLM —— wine 的 GDI 不读 HKCU 那一份")
        body = self._apply_body()
        self.assertIn("[\\(keyPath)]", body,
                      "写文件的键路径必须取自 keyPath 常量，不许就地再抄一份")

    def test_stamp_shares_the_root_the_consumer_reads(self) -> None:
        """戳必须与**至少一条**字体映射同根，否则「查得到」证明不了「会被采用」。

        ## 这条断言改过两次，每次都因为消费方变了

        第 11 轮的戳放在 `HKCU\\Software\\Wine\\ExeOnMac`，断言是「戳查得到」。
        第 12 轮发现 GDI 只读 HKLM，于是把戳搬到 HKLM，断言改成「与 keyPath 同根」。
        第 13 轮又发现 DirectWrite 只读 **HKCU** 的 `Replacements`，于是戳搬回
        HKCU，断言改成「与 replacePath 同根」。

        **判据本身没变**（戳必须住在某个真实消费方读的那棵树里），变的是
        「哪个消费方」。这也说明为什么不能把 `HKLM` 或 `HKCU` 写死进断言 ——
        写死的那一刻，下一个人就会为了「让测试变绿」去搬常量，而不是去查
        「到底谁在读」。
        """
        stamp = self._constant_value("stampKeyPath")
        replace = self._constant_value("replacePath")
        key = self._constant_value("keyPath")

        # 戳与 DirectWrite 的消费路径必须同根：这是本轮新增的那个消费方。
        self.assertEqual(stamp.split("\\\\")[0], replace.split("\\\\")[0],
                         f"戳必须与 Replacements 同根（DirectWrite 读这条），"
                         f"实际戳={stamp} / replace={replace}")
        self.assertTrue(stamp.startswith("HKEY_CURRENT_USER\\\\"),
                        f"DirectWrite 只读 HKCU，戳必须跟它同根，实际 {stamp}")

        # 两条字体路径必须各写各的根键 —— 写成同一个等于放弃其中一条。
        self.assertNotEqual(key.split("\\\\")[0], replace.split("\\\\")[0],
                            "GDI 与 DirectWrite 的根键不同，两条都要写")
        # 戳不许落在被替换的那个键里：混进去会被当成一条字体映射。
        self.assertNotEqual(key, stamp, "戳必须另起子键，不许塞进 FontSubstitutes")
        self.assertNotEqual(replace, stamp, "戳必须另起子键，不许塞进 Replacements")
        self.assertIn("Software\\\\Wine\\\\ExeOnMac", stamp,
                      "戳必须落在 launcher 自有命名空间，不碰微软的键")

    def _constant_value(self, name: str) -> str:
        """从 Swift 源码里取出一个字符串常量的值。"""
        marker = f"static let {name} = \""
        index = self.source.find(marker)
        self.assertNotEqual(index, -1, f"源码里找不到常量 {name}")
        start = index + len(marker)
        return self.source[start:self.source.index("\"", start)]

    def test_single_source_for_key_path(self) -> None:
        """键路径只许有一份字面量：写文件与回查共用常量。

        两处各写一套是本项目反复出事故的形态（README 5.3 红线）。
        """
        literal = "Software\\\\Microsoft\\\\Windows NT\\\\CurrentVersion\\\\FontSubstitutes"
        count = self.source.count(literal)
        self.assertEqual(count, 1,
                         f"键路径字面量出现 {count} 次，只许出现在 keyPath 常量里")
        replacement = "Software\\\\Wine\\\\Fonts\\\\Replacements"
        count = self.source.count(replacement)
        self.assertEqual(count, 1,
                         f"Replacements 键路径出现 {count} 次，只许出现在 replacePath 常量里")

    def test_both_font_paths_written_in_one_file(self) -> None:
        """GDI 与 DirectWrite 两条键必须在**同一份** .reg 里写。

        ## 为什么必须同批

        分两次导入时，「戳查得到」不再能证明两条都写进去了 —— 只证明第二条
        进去了。同批写入是「戳」这个判据成立的前提（第 11 轮④的同一逻辑）。

        ## 为什么两条都要写（2026-11-21 第 13 轮实测）

        全 wine 运行时里 `FontSubstitutes` 字面量只出现在 `win32u.so`（GDI），
        `dwrite.dll` 里一处都没有；后者只认 `Software\\Wine\\Fonts\\Replacements`。
        实测 PE 探针（只调 DirectWrite，不碰 GDI）五组对照：

        | 写入位置 | familyCount | 查到 Microsoft YaHei |
        |---|---|---|
        | 都不写 | 292 | 否 |
        | HKLM `FontSubstitutes` | 292 | 否 |
        | HKLM `Replacements` | 292 | 否 |
        | HKCU `Replacements` | 293 | **是** |
        | 两条同时写 | 293 | **是** |

        只写 `FontSubstitutes` 的现状下，所有 DirectWrite 软件的中文一直是方块。
        """
        body = self._apply_body()
        self.assertIn("[\\(keyPath)]", body, "必须写 GDI 的 FontSubstitutes")
        self.assertIn("[\\(replacePath)]", body, "必须写 DirectWrite 的 Replacements")
        # 两条路径共用同一个映射来源，不许各写一份不同的字面量。
        self.assertEqual(body.count("for (windowsName, macName) in fonts.sorted"),
                         2,
                         "两条键必须各写一遍同一份 fonts 映射，不许只写一条")
        # 只许生成一份 .reg 文本：两条键与戳同批导入。
        self.assertEqual(body.count("let text = lines.joined"), 1,
                         "两条键与戳必须同批写入同一份 .reg")

    def test_import_is_verified_not_assumed(self) -> None:
        """导入后必须回查，不能凭「退出码 0」判定成功。

        `regedit /S` 对格式不对的文件不报错，这条已在 Python 侧与 Swift 侧
        各实测一次。「命令跑完没抛异常」从来不是证据。
        """
        body = self._apply_body()
        self.assertIn("stampPresent(", body,
                      "退出码 0 之后必须回查本次的戳，否则格式错了也报「已导入」")
        guard = self.source.split("private static func runQuery")[1]
        self.assertIn('"reg", "query"', guard,
                      "回查必须真的跑 reg query，不能只看文件写没写成")

    def test_query_judged_on_this_run_not_leftovers(self) -> None:
        """回查必须能证明「**这次**写进去了」，不能读到上一轮留下的值。

        ## 这条是本轮负向验证抓出来的第二个缺陷

        第一版判据是「导入后 reg query 读得到字体名即成功」。把内部格式注回去
        做负向验证时它**仍然判绿** —— 键是上一轮成功写的，本次一个字节都没写，
        回查却通过。判据测的是「注册表里有没有」，不是「这次写没写进去」。

        ## 修法：一次性戳，而不是先删旧键

        「导入前 reg delete」也能让判据变严，但那是破坏性操作：本次导入失败时，
        用户原本能用的替换值被清掉，从「旧值可用」倒退成「什么都没有」。

        现在同一份 .reg 里额外写一个 `ExeOnMac\\FontSubstitutionStamp = <UUID>`，
        导入后查这枚戳。每次运行都是新 UUID，旧值绝不可能蒙对。
        """
        body = self._apply_body()
        self.assertIn("UUID().uuidString", body,
                      "戳必须每次运行重新生成，写死就退化成「读到上一次」")
        self.assertIn("stampKeyPath", body, "戳必须写进 launcher 自有命名空间")
        # 戳与字体映射必须在**同一份** .reg 里：分两次导入就让「一起被吃掉」
        # 这个前提失效，回查到戳也证明不了字体写进去了。
        self.assertEqual(body.count("let text = lines.joined"), 1,
                         "只许生成一份 .reg 文本，戳与字体映射同批写入")
        self.assertNotIn("reg\", \"delete\"", self.source,
                         "不许用 reg delete 清旧键 —— 破坏性，失败时倒退")
        guard = self.source.split("private static func stampPresent")[1].split(
            "\n    }")[0]
        self.assertIn("query.contains(stamp)", guard,
                      "回查必须比对本次的戳，不能只判「键存在」")

    def test_announce_is_explicit_not_inferred_from_output(self) -> None:
        """「wine 已启动」只许由调用方显式声明，不许用 `output != nil` 推断。

        ## 这是本轮自己造出来又自己修掉的噪音

        加上 `reg delete` 之后它传的是 `FileHandle.nullDevice`（非 nil），
        于是日志里冒出两条莫须有的「wine 已启动」—— 一句只该在主程序启动时
        出现一次的话出现了三次。实测修前 `grep -c` 得 **3**，修后得 **1**。
        """
        self.assertIn("announce: Bool = false", self.source,
                      "runChild 必须有显式的 announce 参数")
        self.assertNotIn("if output != nil && !capture", self.source,
                         "不许再用 output 是否为 nil 推断要不要写「已启动」")
        body = self.source.split("static func runChild")[1].split(
            "static func noteSignal")[0]
        self.assertIn("if announce {", body)
        # 主程序那一处必须显式传 true，否则真实启动用例靠的那行日志会消失。
        run = self.source.split("static func run(")[1]
        self.assertIn("announce: true", run,
                      "主程序启动必须传 announce: true —— 「wine 已启动」是 TestRealLaunch 的唯一凭据")


class TestDirectWriteFontPath(unittest.TestCase):
    """## 「两条字体路径」这个结论的机器守卫。

    这条守卫守的不是 launcher 的代码，而是**运行时的事实**：wine 的
    `dwrite.dll` 到底认哪个注册表键。它每次运行都去扫真实运行时二进制，
    所以哪天 wine 升级、上游把 `FontSubstitutes` 也接进 DirectWrite，
    这条会自己变红，而不是留着一份过期结论继续骗人。

    本轮（2026-11-21 第 13 轮）扫出来的分布是：

    * `FontSubstitutes`（UTF-16）→ 只出现在 `x86_64-unix/win32u.so`，1 处
    * `Software\\Wine\\Fonts\\Replacements`（UTF-16）→ 只出现在
      `x86_64-windows/dwrite.dll`，1 处

    这个分布解释了为什么第 12 轮修完 GDI 之后，DirectWrite 软件的中文
    仍然是方块 —— 两条完全独立的路径，只修了其中一条。
    """

    @classmethod
    def setUpClass(cls) -> None:
        if not fixtures.wine_available():
            raise unittest.SkipTest("本机无 wine 运行时")
        from wepack.install import wine_binary

        cls.wine_lib = wine_binary().parent.parent / "lib" / "wine"

    def _scan(self, needle: str) -> dict[str, int]:
        """在真实 wine 运行时里数一个字面量出现在哪些 ELF/PE 里。

        ## 两种编码都要扫（本轮实测的细节）

        `FontSubstitutes` 在 `win32u.so` 里是 **UTF-16**（它走 `*W` 系列 API）；
        `Replacements` 在 `dwrite.dll` 里是 **单字节 ANSI** —— 与它调
        `RegOpenKeyA`（不是 `RegOpenKeyExW`）完全对得上。第一版守卫只扫
        UTF-16，于是 `Replacements` 明明在文件里却数出 0 个命中。

        判据不能只认一种编码：同一个键名，走 ANSI API 的模块存 ANSI、
        走宽字符 API 的模块存 UTF-16，两者都是真的。
        """
        needles = (needle.encode("utf-16-le"), needle.encode("ascii"))
        hits: dict[str, int] = {}
        if not self.wine_lib.is_dir():
            self.skipTest(f"运行时目录不存在：{self.wine_lib}")
        for path in self.wine_lib.rglob("*"):
            if not path.is_file():
                continue
            try:
                raw = path.read_bytes()
            except OSError:
                continue
            if not (raw[:2] == b"MZ" or raw[:4] == b"\xcf\xfa\xed\xfe"):
                continue
            count = sum(raw.count(n) for n in needles)
            if count:
                hits[str(path.relative_to(self.wine_lib))] = count
        return hits

    def test_font_substitutes_is_read_by_gdi_only(self) -> None:
        """`FontSubstitutes` 只被 GDI（win32u）读，dwrite 里一处都没有。

        这条是「必须再写一条 Replacements」的直接依据。若哪天 dwrite 也
        开始读它，这条会红 —— 那就该重新评估是否还需要两条键。
        """
        hits = self._scan("FontSubstitutes")
        self.assertTrue(hits, "运行时里找不到 FontSubstitutes —— 扫描范围不对")
        self.assertIn("x86_64-unix/win32u.so", hits,
                      f"GDI 应读 FontSubstitutes，实际命中 {hits}")
        dwrite_hits = {k: v for k, v in hits.items() if "dwrite" in k}
        self.assertEqual(dwrite_hits, {},
                         f"dwrite 不该读 FontSubstitutes，实际命中 {dwrite_hits}")

    def test_replacements_is_read_by_dwrite(self) -> None:
        """`Software\\Wine\\Fonts\\Replacements` 在 dwrite.dll 里存在。

        这是 DirectWrite 侧唯一生效的那条键。若它消失，说明上游改了实现，
        launcher 写的 `replacePath` 也就失去依据。
        """
        hits = self._scan("Software\\Wine\\Fonts\\Replacements")
        self.assertTrue(hits, "运行时里找不到 Replacements —— 扫描范围不对")
        dwrite_hits = {k: v for k, v in hits.items() if "dwrite" in k}
        self.assertTrue(dwrite_hits,
                        f"dwrite 应读 Replacements，实际只命中 {hits}")


if __name__ == "__main__":
    unittest.main()