"""阶段 4 验收测试：依赖层自动匹配。

跑法：
    cd exeonmac && python3 -m unittest tests.test_phase4 -v

核心断言是「**不该挂的层不要挂**」：wine 的 base 层已含全套 VC++ 运行库，
所以见到 `msvcp140.dll` 就挂 vcpp 层是错的。本套测试用构造的 PE 精确
控制导入表，逐条验证判定逻辑。

需要真实 base 层的测试用 WEXE_HOME 指向临时目录构造假层，不碰真实环境。
"""

from __future__ import annotations

import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from wepack.layers import BUILTIN_LAYERS, layer_path  # noqa: E402
from wepack.layers.match import (  # noqa: E402
    Dependency, MatchResult, base_dll_index, describe, match_layers,
    normalize_dll_name, scan_dependencies,
)

#: PE 头长度。节区数据从这里开始，避免与头部重叠。
_PE_HEADER = 0x400


# --------------------------------------------------------------------------
# 构造测试用 PE
# --------------------------------------------------------------------------


def build_pe(path: Path, imports: list[str]) -> Path:
    """造一个只含导入表的最小 PE32+。

    为什么自己造而不是用真样本：测试要精确控制「导入了哪些 DLL」，
    真样本的导入表随版本变化，断言会变脆。这个构造器只实现 pe.py
    实际读取的字段（DOS 头、COFF、Optional 头、一个 .idata 节）。
    """
    dos = bytearray(64)
    dos[0:2] = b"MZ"
    struct.pack_into("<I", dos, 0x3C, 64)

    # COFF：machine=0x8664(x64)，1 个节区，可选头 240 字节
    coff = struct.pack("<HHIIIHH", 0x8664, 1, 0, 0, 0, 240, 0x22)

    opt = bytearray(240)
    struct.pack_into("<H", opt, 0, 0x20B)        # PE32+
    struct.pack_into("<I", opt, 56, 0x2000)      # SizeOfImage
    struct.pack_into("<H", opt, 68, 2)           # GUI subsystem
    # 导入表目录项：RVA 0x1000，大小覆盖所有描述符
    struct.pack_into("<II", opt, 112 + 8 * 1, 0x1000, 40 * len(imports) + 40)

    section = struct.pack("<8sIIIIIIHHI", b".idata", 0x1000, 0x1000,
                          _PE_HEADER, 0x400, 0, 0, 0, 0, 0xC0000040)
    header = (bytes(dos) + b"PE\0\0" + coff + bytes(opt) + section)
    header = header.ljust(_PE_HEADER, b"\0")

    body = bytearray(0x400)
    name_offset = 0x200
    descriptors = b""
    for dll in imports:
        descriptors += struct.pack("<IIIII", 0, 0, 0, 0x1000 + name_offset, 0)
        encoded = dll.encode("latin-1")
        body[name_offset:name_offset + len(encoded) + 1] = encoded + b"\0"
        name_offset += len(encoded) + 1
    body[0:len(descriptors)] = descriptors

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + bytes(body))
    return path


def make_layer(home: Path, name: str, dlls: list[str]) -> Path:
    """在临时 WEXE_HOME 里造一个层，system32 下放指定的空 DLL 文件。"""
    root = home / "layers" / name / "drive_c" / "windows" / "system32"
    root.mkdir(parents=True, exist_ok=True)
    for dll in dlls:
        (root / f"{dll}.dll").write_bytes(b"MZ")
    return home / "layers" / name


def make_prefix(tmp: Path, imports: list[str], *,
                name: str = "demo") -> tuple[Path, str]:
    """造一个只含主程序的假 prefix，返回 `(private_dir, entry)`。"""
    private = tmp / "Prefix"
    entry_rel = f"drive_c/App/{name}.exe"
    build_pe(private / entry_rel, imports)
    return private, entry_rel


class LayerHomeMixin:
    """把 WEXE_HOME 指向临时目录，测试不碰真实层。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.home = self.tmp / "home"
        self._old_home = os.environ.get("WEXE_HOME")
        os.environ["WEXE_HOME"] = str(self.home)

    def tearDown(self) -> None:
        if self._old_home is None:
            os.environ.pop("WEXE_HOME", None)
        else:
            os.environ["WEXE_HOME"] = self._old_home
        self._tmp.cleanup()


# --------------------------------------------------------------------------
# 名称归一化
# --------------------------------------------------------------------------


class TestNormalize(unittest.TestCase):
    def test_lowercase(self):
        self.assertEqual(normalize_dll_name("MFC140U.DLL"), "mfc140u")

    def test_strip_dll_suffix(self):
        self.assertEqual(normalize_dll_name("msvcp140.dll"), "msvcp140")

    def test_strip_exe_suffix(self):
        """导入表里偶尔会写 ntoskrnl.exe，必须归一化后才能比对。"""
        self.assertEqual(normalize_dll_name("NTOSKRNL.EXE"), "ntoskrnl")

    def test_strip_path(self):
        self.assertEqual(
            normalize_dll_name(r"C:\Windows\System32\foo.dll"), "foo")

    def test_already_clean(self):
        self.assertEqual(normalize_dll_name("kernel32"), "kernel32")


# --------------------------------------------------------------------------
# 扫描
# --------------------------------------------------------------------------


class TestScan(unittest.TestCase):
    def test_reads_imports(self):
        with tempfile.TemporaryDirectory() as tmp:
            private, entry = make_prefix(Path(tmp), ["KERNEL32.dll", "USER32.dll"])
            required, scanned, warnings = scan_dependencies(private / entry)
            self.assertEqual(required, {"kernel32", "user32"})
            self.assertEqual(scanned, ["demo.exe"])
            self.assertEqual(warnings, [])

    def test_missing_entry_raises(self):
        from wepack.errors import UsageError
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(UsageError):
                scan_dependencies(Path(tmp) / "nope.exe")

    def test_scans_sibling_dlls(self):
        """同目录 DLL 的导入也算 —— 程序自带的 DLL 会拉进更多依赖。"""
        with tempfile.TemporaryDirectory() as tmp:
            private, entry = make_prefix(Path(tmp), ["KERNEL32.dll"])
            build_pe(private / "drive_c/App/helper.dll", ["MFC140U.dll"])
            required, scanned, _ = scan_dependencies(private / entry)
            self.assertIn("mfc140u", required)
            self.assertIn("helper.dll", scanned)

    def test_local_dll_not_counted_as_dependency(self):
        """程序自带的 DLL 本身不该被当成"需要外部提供"。"""
        with tempfile.TemporaryDirectory() as tmp:
            private, entry = make_prefix(Path(tmp), ["KERNEL32.dll", "helper.dll"])
            build_pe(private / "drive_c/App/helper.dll", [])
            required, _, _ = scan_dependencies(private / entry)
            self.assertNotIn("helper", required)
            self.assertIn("kernel32", required)

    def test_broken_dll_only_warns(self):
        """一个坏 DLL 不该让整轮扫描失败。"""
        with tempfile.TemporaryDirectory() as tmp:
            private, entry = make_prefix(Path(tmp), ["KERNEL32.dll"])
            (private / "drive_c/App/broken.dll").write_bytes(b"not a pe")
            required, scanned, warnings = scan_dependencies(private / entry)
            self.assertIn("kernel32", required)
            self.assertTrue(any("broken.dll" in w for w in warnings))


# --------------------------------------------------------------------------
# 匹配：核心断言
# --------------------------------------------------------------------------


class TestMatch(LayerHomeMixin, unittest.TestCase):
    def test_vcpp_already_in_base_not_mounted(self):
        """**核心断言**：base 已有 msvcp140 时，绝不挂 vcpp 层。

        这是本阶段最重要的判断。wine 自带全套 VC++ 运行库，
        盲目挂 vcpp 层只会白占磁盘。
        """
        make_layer(self.home, "base", ["kernel32", "msvcp140", "vcruntime140"])
        private, entry = make_prefix(
            self.tmp, ["KERNEL32.dll", "MSVCP140.dll", "VCRUNTIME140.dll"])
        result = match_layers(private, entry)
        self.assertEqual(result.layers, ["base"])
        self.assertEqual(result.available, [])
        self.assertTrue(result.ok)

    def test_mfc_triggers_layer(self):
        """base 不含 MFC，导入 mfc140u 必须匹配到 mfc 层。"""
        make_layer(self.home, "base", ["kernel32"])
        make_layer(self.home, "mfc", ["mfc140u"])
        private, entry = make_prefix(
            self.tmp, ["KERNEL32.dll", "MFC140U.dll"])
        result = match_layers(private, entry)
        self.assertEqual(result.layers, ["base", "mfc"])
        self.assertEqual(result.available, ["mfc"])
        self.assertTrue(result.ok)

    def test_dotnet_triggers_layer(self):
        make_layer(self.home, "base", ["kernel32", "mscoree"])
        make_layer(self.home, "dotnet", ["mscorlib"])
        private, entry = make_prefix(
            self.tmp, ["KERNEL32.dll", "mscorlib.dll"])
        result = match_layers(private, entry)
        self.assertIn("dotnet", result.layers)
        self.assertIn("dotnet", result.available)

    def test_missing_layer_reported(self):
        """层没安装时要报 missing，而不是当作已满足。"""
        make_layer(self.home, "base", ["kernel32"])
        private, entry = make_prefix(
            self.tmp, ["KERNEL32.dll", "MFC140U.dll"])
        result = match_layers(private, entry)
        self.assertIn("mfc", result.layers)
        self.assertIn("mfc", result.missing)
        self.assertEqual(result.available, [])
        self.assertFalse(result.ok)
        self.assertTrue(any("尚未安装" in w for w in result.warnings))

    def test_unsolved_dependency(self):
        """既不在 base、也没有层能补的 DLL 要列进 unsolved。"""
        make_layer(self.home, "base", ["kernel32"])
        private, entry = make_prefix(
            self.tmp, ["KERNEL32.dll", "somevendorlib.dll"])
        result = match_layers(private, entry)
        self.assertIn("somevendorlib", result.unsolved)
        self.assertFalse(result.ok)

    def test_system_dll_not_unsolved(self):
        """系统 DLL 不算未解决 —— 它们由 wine 提供，不是应用依赖。"""
        make_layer(self.home, "base", ["kernel32"])
        private, entry = make_prefix(
            self.tmp, ["KERNEL32.dll", "NTOSKRNL.EXE"])
        result = match_layers(private, entry)
        self.assertEqual(result.unsolved, [])
        self.assertTrue(result.ok)

    def test_layer_order_by_priority(self):
        """层按 priority 排序，base 恒首位。"""
        make_layer(self.home, "base", ["kernel32"])
        make_layer(self.home, "mfc", ["mfc140u"])
        make_layer(self.home, "dotnet", ["mscorlib"])
        private, entry = make_prefix(
            self.tmp, ["KERNEL32.dll", "MFC140U.dll", "mscorlib.dll"])
        result = match_layers(private, entry)
        self.assertEqual(result.layers[0], "base")
        # mfc priority 15 < dotnet 20
        self.assertLess(result.layers.index("mfc"), result.layers.index("dotnet"))

    def test_no_base_layer_warns(self):
        """base 未构建时无法判断哪些已提供，必须警告。"""
        private, entry = make_prefix(self.tmp, ["KERNEL32.dll"])
        result = match_layers(private, entry)
        self.assertTrue(any("base 层未构建" in w for w in result.warnings))

    def test_extra_layers_forced(self):
        """用户显式指定的层无条件加入。"""
        make_layer(self.home, "base", ["kernel32"])
        make_layer(self.home, "fonts-cn", [])
        private, entry = make_prefix(self.tmp, ["KERNEL32.dll"])
        result = match_layers(private, entry, extra_layers=["fonts-cn"])
        self.assertIn("fonts-cn", result.layers)
        self.assertIn("fonts-cn", result.available)

    def test_to_dict_shape(self):
        make_layer(self.home, "base", ["kernel32"])
        private, entry = make_prefix(self.tmp, ["KERNEL32.dll"])
        payload = match_layers(private, entry).to_dict()
        for key in ("entry", "scanned", "layers", "available", "missing",
                    "unsolved", "warnings", "dependencies"):
            self.assertIn(key, payload)


# --------------------------------------------------------------------------
# base 索引
# --------------------------------------------------------------------------


class TestBaseIndex(LayerHomeMixin, unittest.TestCase):
    def test_reads_system32(self):
        make_layer(self.home, "base", ["kernel32", "user32", "msvcp140"])
        index = base_dll_index()
        self.assertEqual(index, {"kernel32", "user32", "msvcp140"})

    def test_missing_base_returns_empty(self):
        self.assertEqual(base_dll_index(), set())

    def test_only_dll_files(self):
        """system32 里的 exe 不算 DLL 索引。"""
        layer = make_layer(self.home, "base", ["kernel32"])
        (layer / "drive_c/windows/system32/notepad.exe").write_bytes(b"MZ")
        self.assertEqual(base_dll_index(), {"kernel32"})


# --------------------------------------------------------------------------
# 层定义
# --------------------------------------------------------------------------


class TestBuiltinLayers(unittest.TestCase):
    def test_base_has_no_dlls(self):
        """base 的 dlls 声明为空 —— 它的内容由 wineboot 决定，不该硬编码。"""
        self.assertEqual(BUILTIN_LAYERS["base"]["dlls"], [])

    def test_mfc_layer_exists(self):
        """MFC 是真实缺口，必须有对应层。"""
        self.assertIn("mfc", BUILTIN_LAYERS)
        self.assertIn("mfc140u", BUILTIN_LAYERS["mfc"]["dlls"])

    def test_all_layers_require_base(self):
        for name, spec in BUILTIN_LAYERS.items():
            if name == "base":
                continue
            self.assertIn("base", spec["requires"], name)

    def test_base_priority_lowest(self):
        priorities = {n: s["priority"] for n, s in BUILTIN_LAYERS.items()}
        self.assertEqual(min(priorities, key=priorities.get), "base")

    def test_dotnet_declares_mscorlib(self):
        """base 只有 mscoree stub，真跑 .NET 需要 mscorlib。"""
        self.assertIn("mscorlib", BUILTIN_LAYERS["dotnet"]["dlls"])


# --------------------------------------------------------------------------
# 描述输出
# --------------------------------------------------------------------------


class TestDescribe(unittest.TestCase):
    def test_only_base(self):
        result = MatchResult(entry="a.exe", dependencies=[
            Dependency(name="kernel32", in_base=True, is_system=True)])
        lines = describe(result)
        self.assertTrue(any("只需 base 层" in line for line in lines))

    def test_lists_layers(self):
        result = MatchResult(entry="a.exe", layers=["base", "mfc"])
        lines = describe(result)
        self.assertTrue(any("mfc" in line for line in lines))

    def test_reports_missing(self):
        result = MatchResult(entry="a.exe", layers=["base", "mfc"],
                             missing=["mfc"])
        lines = describe(result)
        self.assertTrue(any("缺层" in line for line in lines))


if __name__ == "__main__":
    unittest.main()