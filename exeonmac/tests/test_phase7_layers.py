"""层自动构建测试（W-08）。

锁的是「`layers build` 只支持 base」到「base / dotnet / fonts-cn 三条路都能
走」这一步的真实行为。每条用例都对应一个**实测踩到过**的具体缺陷，不是
凑覆盖率。

## 为什么要有这批测试

W-08 之前 `build_layer` 里 base 之外的四个分支全是 `UsageError`，等于
「自动构建」只对小半个层生效。实现三层的自动构建时踩到的坑：

1. `msiexec` 的 MSI 参数没转 wine 路径 —— 宿主 `/Users/...` 传进去被当成
   相对路径，报「找不到安装包」而不是「路径没转换」，排查会绕远路。
2. `msiexec` 返回 0 但 prefix 里什么都没装 —— 退出码 0 的假成功。
3. `fontreg` 在 wine 11.21 里**根本不存在**（`wine fontreg` →
   `ShellExecuteEx failed: File not found`，退出码 1）。原来那版代码跑它、
   拿 `result.ok` 当「注册成功」，实际上永远为假，且 `notes` 变量构建后
   从未被使用。真实机制是 wine 启动时扫 `c:\\windows\\fonts\\` 目录。

## 跑法

    cd exeonmac && python3 -m unittest tests.test_phase7_layers -v

需要真实 wine 的用例在无 wine 时自动跳过（`fixtures.wine_available()`）。
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from wepack import layers as L  # noqa: E402
from wepack import paths as wexe_paths  # noqa: E402
from wepack.errors import (  # noqa: E402
    InstallFailed,
    MissingDependency,
    UsageError,
    VerifyFailed,
)
from wepack.install import host_to_wine_path, run_in_prefix  # noqa: E402
from tests import fixtures  # noqa: E402
from tests.test_phase2 import make_fake_wine, make_fake_layer  # noqa: E402


class IsolatedWexe(unittest.TestCase):
    """把 WEXE_HOME 指到临时目录，避免污染真实 ~/Library。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="exeonmac-p7-")
        self.tmp = Path(self._tmp.name)
        self.old_home = os.environ.get("WEXE_HOME")
        os.environ["WEXE_HOME"] = str(self.tmp / "wexe")
        wexe_paths.ensure_dirs()

    def tearDown(self) -> None:
        if self.old_home is None:
            os.environ.pop("WEXE_HOME", None)
        else:
            os.environ["WEXE_HOME"] = self.old_home
        self._tmp.cleanup()


# --------------------------------------------------------------------------
# run_in_prefix：wineboot_init 的泛化版本
# --------------------------------------------------------------------------


class TestRunInPrefix(IsolatedWexe):
    def test_rejects_missing_prefix(self) -> None:
        with self.assertRaises(UsageError):
            run_in_prefix(self.tmp / "nope", ["cmd", "/c", "echo"])

    def test_passes_argv_verbatim_and_sets_env(self) -> None:
        """参数必须原样传给 wine —— 不自动转路径。

        自动判断「哪个参数是路径」必然误伤 `/qn`、`/i` 这类开关，而把
        `/qn` 转成 `Z:\\qn` 不会报错，只会静默失败。
        """
        make_fake_wine(wexe_paths.wine_root())
        prefix = self.tmp / "prefix"
        prefix.mkdir()

        result = run_in_prefix(prefix, ["msiexec", "/i", "Z:\\a.msi", "/qn"])
        self.assertTrue(result.ok, result.stderr_tail)

        log = (wexe_paths.wine_root() / "calls.log").read_text()
        self.assertIn("[msiexec] [/i] [Z:\\a.msi] [/qn]", log)
        self.assertIn("WINEPREFIX=", log)

    def test_nonzero_exit_is_reported_not_raised(self) -> None:
        make_fake_wine(wexe_paths.wine_root(), exit_code=3)
        prefix = self.tmp / "prefix"
        prefix.mkdir()

        result = run_in_prefix(prefix, ["whoami"])
        self.assertFalse(result.ok)
        self.assertEqual(result.returncode, 3)

    def test_timeout_returns_timed_out_not_raise(self) -> None:
        make_fake_wine(wexe_paths.wine_root(), sleep=5)
        prefix = self.tmp / "prefix"
        prefix.mkdir()

        result = run_in_prefix(prefix, ["whoami"], timeout=1)
        self.assertTrue(result.timed_out)
        self.assertFalse(result.ok)


class TestHostToWinePathAlias(unittest.TestCase):
    def test_public_alias_is_same_object(self) -> None:
        """`host_to_wine_path` 必须是 `_host_to_wine_path` 的**同一个对象**。

        两套判据必然漂移 —— 本项目已因同类问题出过事故（README 5.3 红线）。
        用 `is` 而不是 `==`，是因为后者对两个行为相同的函数也成立。
        """
        from wepack.install import _host_to_wine_path

        self.assertIs(host_to_wine_path, _host_to_wine_path)

    def test_converts_absolute_path_to_z_drive(self) -> None:
        self.assertTrue(host_to_wine_path(Path("/Users/x/a.msi")).startswith("Z:"))


# --------------------------------------------------------------------------
# find_mono_msi：定位运行时自带的 wine-mono
# --------------------------------------------------------------------------


class TestFindMonoMsi(IsolatedWexe):
    def _make_mono(self, versions: dict[str, bool]) -> Path:
        """造 mono 目录。值是「是否放 winemono-support.msi」。"""
        mono_root = wexe_paths.wine_root() / "share" / "wine" / "mono"
        mono_root.mkdir(parents=True, exist_ok=True)
        for ver, with_msi in versions.items():
            support = mono_root / f"wine-mono-{ver}" / "support"
            support.mkdir(parents=True, exist_ok=True)
            if with_msi:
                (support / "winemono-support.msi").write_bytes(b"MSI" + b"\0" * 64)
        return mono_root

    def test_missing_mono_dir_raises_missing_dependency(self) -> None:
        with self.assertRaises(MissingDependency) as ctx:
            L.find_mono_msi()
        self.assertIn("wine-mono", str(ctx.exception))

    def test_picks_newest_version_not_directory_order(self) -> None:
        """多版本共存时按版本号排序，不能依赖目录列表顺序。

        `11.3.0` 与 `9.10.0`：字符串排序会把 `9.10.0` 排在 `11.3.0` 之后，
        因为 '9' > '1'。按元组 (11,3,0) > (9,10,0) 才是对的。
        """
        self._make_mono({"9.10.0": True, "11.3.0": True})
        msi = L.find_mono_msi()
        self.assertIn("wine-mono-11.3.0", str(msi))

    def test_skips_version_without_msi(self) -> None:
        self._make_mono({"11.3.0": False, "11.2.0": True})
        msi = L.find_mono_msi()
        self.assertIn("wine-mono-11.2.0", str(msi))

    def test_dir_without_any_msi_raises(self) -> None:
        self._make_mono({"11.3.0": False})
        with self.assertRaises(MissingDependency) as ctx:
            L.find_mono_msi()
        self.assertIn("winemono-support.msi", str(ctx.exception))


# --------------------------------------------------------------------------
# build_layer：分发与四条失败路径
# --------------------------------------------------------------------------


class TestBuildLayerDispatch(IsolatedWexe):
    def test_mfc_raises_missing_dependency_with_path_hint(self) -> None:
        """mfc 无法自动构建，但报错必须给出可操作的手工路径。"""
        with self.assertRaises(MissingDependency) as ctx:
            L.build_layer("mfc")
        hint = ctx.exception.hint or ""
        self.assertIn("mfc*.dll", hint)
        self.assertIn("system32", hint)

    def test_vcpp_raises_usage_error_explaining_it_is_builtin(self) -> None:
        with self.assertRaises(UsageError) as ctx:
            L.build_layer("vcpp")
        self.assertIn("内置", str(ctx.exception))

    def test_unknown_layer_raises_usage_error(self) -> None:
        with self.assertRaises(UsageError) as ctx:
            L.build_layer("no-such-layer")
        self.assertIn("未知层", str(ctx.exception))

    def test_fonts_cn_without_files_raises_usage_error(self) -> None:
        with self.assertRaises(UsageError) as ctx:
            L.build_layer("fonts-cn")
        self.assertIn("至少一个字体文件", str(ctx.exception))

    def test_dispatch_reaches_dotnet_branch(self) -> None:
        """`build_layer('dotnet')` 必须真的走到 dotnet 分支。

        用一个**空** mono 目录让它抛 MissingDependency —— 若分发写错，
        抛的会是 UsageError「未知层」，两者靠异常类型即可区分。
        """
        with self.assertRaises(MissingDependency):
            L.build_layer("dotnet")


class TestLayerAlreadyExistsGuard(IsolatedWexe):
    def test_refuses_to_rebuild_nonempty_layer(self) -> None:
        """层已存在时必须拒绝，不能静默覆盖用户手工补的文件。"""
        layer = L.layer_path("dotnet")
        layer.mkdir(parents=True)
        (layer / "keep-me.txt").write_text("用户手工放进来的")

        with self.assertRaises(UsageError) as ctx:
            L._ensure_layer_absent(layer)
        self.assertIn("已存在", str(ctx.exception))
        self.assertTrue((layer / "keep-me.txt").exists())

    def test_allows_when_layer_missing_or_empty(self) -> None:
        L._ensure_layer_absent(self.tmp / "never-created")
        empty = self.tmp / "empty"
        empty.mkdir()
        L._ensure_layer_absent(empty)     # 不抛即通过


# --------------------------------------------------------------------------
# build_fonts_layer：参数校验（不需要 wine）
# --------------------------------------------------------------------------


class TestBuildFontsLayerValidation(IsolatedWexe):
    def test_missing_file_raises(self) -> None:
        with self.assertRaises(UsageError) as ctx:
            L.build_fonts_layer([self.tmp / "nope.ttf"])
        self.assertIn("不存在", str(ctx.exception))

    def test_rejects_unsupported_suffix(self) -> None:
        bad = self.tmp / "font.woff2"
        bad.write_bytes(b"wOF2")
        with self.assertRaises(UsageError) as ctx:
            L.build_fonts_layer([bad])
        self.assertIn("不支持", str(ctx.exception))

    def test_accepts_ttf_ttc_otf_only(self) -> None:
        """三种合法扩展名都要放行到「开始构建」那一步（此处会因缺 wine 失败）。"""
        for suffix in (".ttf", ".ttc", ".otf"):
            path = self.tmp / f"ok{suffix}"
            path.write_bytes(b"\0" * 16)
            # 扩展名校验通过后才会往下走；缺 wine 时抛的不是 UsageError
            with self.assertRaises((InstallFailed, MissingDependency,
                                    OSError, RuntimeError)):
                L.build_fonts_layer([path])


# --------------------------------------------------------------------------
# 层内 DLL 索引的覆盖范围（不需要 wine）
# --------------------------------------------------------------------------


class TestLayerDllIndexCoverage(IsolatedWexe):
    """层 DLL 索引必须覆盖 `syswow64` 与 `Microsoft.NET/`。

    这两处漏掉时，匹配器会把「层里明明有」的依赖报成 `unsolved`
    （「无层可补」），而 `unsolved` 是让人去换方案、找替代品的信号。
    报错的成本远高于多扫几个目录：用户会以为这个程序根本跑不了。

    缺陷形态实测（2026-11-20，修前）：32 位程序导入 `d3d8` / `commdlg`
    → 两者都在 base 的 `syswow64` 里，却都被报 `unsolved`；.NET 程序
    导入 `mscorlib` → 它就在 dotnet 层的 `Microsoft.NET/` 下，同样被报
    `unsolved`。
    """

    def test_index_includes_syswow64_only_dlls(self) -> None:
        """32 位专用 DLL 只在 syswow64，必须被认到。"""
        from wepack.layers.match import _windows_dll_stems

        root = self.tmp / "layer"
        sys32 = root / "drive_c/windows/system32"
        wow = root / "drive_c/windows/syswow64"
        sys32.mkdir(parents=True)
        wow.mkdir(parents=True)
        (sys32 / "kernel32.dll").write_bytes(b"MZ")
        (wow / "d3d8.dll").write_bytes(b"MZ")        # 只在 syswow64

        names = _windows_dll_stems(root)
        self.assertIn("d3d8", names)
        self.assertIn("kernel32", names)

    def test_index_includes_nested_dotnet_dlls(self) -> None:
        """dotnet 层的 mscorlib 在 Microsoft.NET 下，必须被认到。"""
        from wepack.layers.match import _windows_dll_stems

        root = self.tmp / "layer"
        nested = (root / "drive_c/windows/Microsoft.NET/Framework/v4.0.30319")
        nested.mkdir(parents=True)
        (nested / "mscorlib.dll").write_bytes(b"MZ")
        (nested / "System.Core.dll").write_bytes(b"MZ")

        names = _windows_dll_stems(root)
        self.assertIn("mscorlib", names)
        self.assertIn("system.core", names)

    def test_missing_drive_c_returns_empty_not_raise(self) -> None:
        """层目录不存在时返回空集，不抛异常（未安装的层要能正常探测）。"""
        from wepack.layers.match import _windows_dll_stems

        self.assertEqual(_windows_dll_stems(self.tmp / "never"), set())

    def test_base_index_and_generic_index_share_one_judgement(self) -> None:
        """`base_dll_index()` 与 `_layer_dll_index('base')` 必须走同一判据。

        同一份「层里有什么」写两遍必然漂移 —— 本项目已因同类问题出过
        事故（README 5.3 红线）。这里比集合而不是比对象：两者都是函数，
        但结果必须逐项相同。

        **树是自造的，不读真实层**：早前版本在隔离环境下 `skipTest`，
        而「全仓 0 跳过」是硬约束 —— 用 skip 换绿灯等于守卫没站岗。
        自造树反而判别力更强：`syswow64` 顶部放一个 DLL，只扫 `system32`
        的实现会漏掉它，两者立刻不等。
        """
        from wepack.layers.match import _layer_dll_index, base_dll_index

        windows = L.layer_path("base") / "drive_c" / "windows"
        (windows / "system32").mkdir(parents=True)
        (windows / "syswow64").mkdir(parents=True)
        (windows / "system32" / "kernel32.dll").write_bytes(b"MZ")
        (windows / "syswow64" / "d3d8.dll").write_bytes(b"MZ")

        base = base_dll_index()
        generic = _layer_dll_index("base")
        self.assertEqual(base, generic)
        self.assertIn("d3d8", base, "两处判据都漏了 syswow64")


class TestMatchAgainstRealLayers(IsolatedWexe):
    """用**真实**层目录跑一次匹配，证明索引不是只在假造的树上成立。

    假造的树只能证明「rglob 会递归」，证明不了真实层的目录布局被覆盖。
    这两条断言的就是本轮修掉的两个具体误判。

    ## 为什么跳过判据在 `setUpClass` 而不在装饰器

    `@unittest.skipUnless(fixtures.wine_available(), ...)` 的参数据在**导入时**
    求值，于是「本机有没有 wine」在导入那一刻就定了。若导入发生在
    `WEXE_HOME` 被重定向的上下文里（例如别处先改了环境），这两类用例
    此后永远跳过，而跳过在报告里是绿的。`setUpClass` 在用例真跑时才问。
    """

    @classmethod
    def setUpClass(cls) -> None:
        if not fixtures.wine_ready():
            raise unittest.SkipTest("需要真实 wine 运行时")

    def setUp(self) -> None:
        super().setUp()
        real_layers = (Path.home() / "Library" / "Application Support"
                       / "wexe" / "layers")
        if not (real_layers / "base" / "drive_c" / "windows" / "syswow64").is_dir():
            self.skipTest("本机没有真实 base 层（含 syswow64）")
        link = wexe_paths.layers_root()
        if link.exists() or link.is_symlink():
            if link.is_symlink():
                link.unlink()
            else:
                for child in link.iterdir():
                    if child.is_dir():
                        import shutil as _sh
                        _sh.rmtree(child, ignore_errors=True)
                link.rmdir()
        link.symlink_to(real_layers, target_is_directory=True)

    def _match(self, imports: list[str]) -> object:
        from tests.test_phase4 import build_pe
        private = self.tmp / f"Prefix{len(imports)}"
        entry_rel = "drive_c/App/Demo.exe"
        build_pe(private / entry_rel, imports)
        return L.match_layers(private, entry_rel)

    def test_syswow64_only_imports_are_not_flagged_unsolved(self) -> None:
        """32 位专用 DLL（只在 syswow64）不得被判「无层可补」。"""
        result = self._match(["kernel32.dll", "d3d8.dll", "commdlg.dll"])
        self.assertEqual(result.unsolved, [],
                         f"这些其实在 syswow64 里：{result.unsolved}")

    def test_dotnet_import_selects_dotnet_layer_and_drops_mscorlib(self) -> None:
        """.NET 程序应匹配到 dotnet 层，且 mscorlib 不再算未解决。"""
        if not L.layer_path("dotnet").is_dir():
            self.skipTest("本机没有 dotnet 层")
        result = self._match(["kernel32.dll", "mscorlib.dll"])
        self.assertIn("dotnet", result.layers)
        self.assertNotIn("mscorlib", result.unsolved)


# --------------------------------------------------------------------------
# 真实 wine：dotnet 与 fonts-cn 的端到端构建
# --------------------------------------------------------------------------


class TestRealLayerBuild(IsolatedWexe):
    """真跑一次 wineboot + 装 MSI。慢（约 1 分钟/层），但这是唯一能证明
    「自动构建真的成立」的方式 —— mock 只能证明代码路径通，证明不了
    wine 真的照做。

    ## 跳过判据放在 `setUpClass`

    理由同 `TestMatchAgainstRealLayers`：装饰器在导入时求值会把结论定型，
    跳过还是绿。

    ## 为什么要把 runtime 软链进临时目录

    `WEXE_HOME` 是**整体**重定向（`paths.wexe_home()`），`wine_root()` 由它
    推出，所以隔离掉 `WEXE_HOME` 就等于把 wine 也隔离掉了。上一轮手工验证
    时正是因为这一点，`dotnet` 构建误报「运行时不含 wine-mono」—— 那是测试
    环境问题，不是代码缺陷。这里用软链把真实运行时接进来，让用例自洽。
    """

    @classmethod
    def setUpClass(cls) -> None:
        if not fixtures.wine_ready():
            raise unittest.SkipTest("需要真实 wine 运行时")

    def setUp(self) -> None:
        super().setUp()
        real_wine = Path.home() / "Library" / "Application Support" / "wexe" / "runtime" / "wine"
        if not real_wine.is_dir():
            self.skipTest("本机没有真实 wexe wine 运行时")

        # `ensure_dirs()` 已经建了一个空的 runtime/wine，先拿掉再软链。
        # 这里不删整个 runtime：沙箱不允许，而且只替换 wine 这一层就够。
        link = wexe_paths.wine_root()
        if link.is_dir() and not link.is_symlink():
            for child in link.iterdir():        # 空目录，防御性清一遍
                if child.is_file():
                    child.unlink()
            link.rmdir()
        elif link.is_symlink():
            link.unlink()
        link.symlink_to(real_wine, target_is_directory=True)

    def test_dotnet_layer_contains_mscorlib(self) -> None:
        msi = L.find_mono_msi()
        self.assertTrue(msi.is_file())

        info = L.build_dotnet_layer(timeout=600)
        self.assertTrue(info.exists, info.problems)
        self.assertTrue(info.ok, info.problems)
        self.assertGreater(info.files, 100)
        self.assertGreater(info.bytes, 10 * 1024 * 1024)

        framework = (L.layer_path("dotnet") / "drive_c" / "windows"
                     / "Microsoft.NET" / "Framework")
        self.assertTrue(framework.is_dir())
        self.assertTrue(list(framework.glob("*/mscorlib.dll")))

    def test_fonts_layer_puts_file_where_wine_scans(self) -> None:
        """字体必须落在 `drive_c/windows/Fonts/` 且非空。

        位置是硬要求：wine 启动时只扫这个目录（`WINEDEBUG=+font` 可见
        `unix_face_create ... c:/windows/fonts/<name>`）。放错目录等于没装。
        """
        source = self.tmp / "Probe.ttf"
        # 用真实 ttf 头，避免 wine 侧后续读到时行为不明
        font = Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf")
        if font.is_file():
            import shutil as _sh
            _sh.copyfile(font, source)
        else:
            source.write_bytes(b"\0\0\1\0" + b"\0" * 64)

        info = L.build_fonts_layer([source], timeout=600)
        self.assertTrue(info.ok, info.problems)

        placed = L.layer_path("fonts-cn") / "drive_c" / "windows" / "Fonts" / source.name
        self.assertTrue(placed.is_file(), f"字体没落到 {placed}")
        self.assertEqual(placed.stat().st_size, source.stat().st_size)
        self.assertEqual(placed.stat().st_mode & 0o777, 0o644)


def parse_fonts_section(reg_text: str) -> dict[str, str]:
    """从 system.reg 文本里取出 `Windows NT\\CurrentVersion\\Fonts` 一段。

    只取 **Windows NT** 这一段，不是随手取一个「Fonts」。原因是
    `system.reg` 里同时存在 `Windows\\CurrentVersion\\Fonts` 与
    `Windows NT\\CurrentVersion\\Fonts`，两段键集合完全相同 —— 同一份
    宿主字体被登记了两遍。合并两段会得到恰好翻倍的假数字。
    """
    section = {}
    current = None
    want = r"[Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts]"
    for line in reg_text.splitlines():
        if line.startswith("["):
            current = line.split("]")[0] + "]"
            continue
        if current == want and "=" in line and not line.strip().startswith(";"):
            key, _, value = line.partition("=")
            section[key.strip().strip('"')] = value.strip().strip('"')
    return section


class TestFontsSectionCounting(unittest.TestCase):
    """锁字体计数的口径，防「两段相加得双倍」。

    这批用例的形状来自一次真实错误：文档里写 base 层「中文字体合计 254 条，
    PingFang 96 条」，而实测单段只有 48 条 PingFang。根因不是写错了数，
    是**把两段重复登记相加**。数字看起来「更大更权威」，反而更容易被信。

    所以这里不背具体条数（宿主字体随系统版本变），只锁结构不变量：
    两段键集相同、单段口径才是真源。
    """

    REG = (Path.home() / "Library" / "Application Support" / "wexe"
           / "layers" / "base" / "system.reg")

    def setUp(self) -> None:
        if not self.REG.is_file():
            self.skipTest("本机没有 base 层的 system.reg")
        self.text = self.REG.read_text(encoding="utf-8", errors="replace")

    def _section(self, header: str) -> dict[str, str]:
        out = {}
        current = None
        for line in self.text.splitlines():
            if line.startswith("["):
                current = line.split("]")[0] + "]"
                continue
            if current == header and "=" in line and not line.strip().startswith(";"):
                key, _, value = line.partition("=")
                out[key.strip().strip('"')] = value.strip().strip('"')
        return out

    def test_two_fonts_sections_have_identical_keys(self) -> None:
        """两段键集必须相同 —— 相同才说明它们是同一份数据的两种写法。

        若某天真变得不同，说明 wine 行为变了，那时 `parse_fonts_section`
        只认 Windows NT 一段就可能漏数据，这条会先红。
        """
        plain = self._section(r"[Software\\Microsoft\\Windows\\CurrentVersion\\Fonts]")
        ntdll = self._section(r"[Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts]")
        self.assertTrue(plain, "没解析到 Fonts 段，解析器可能坏了")
        self.assertEqual(set(plain), set(ntdll),
                         "两段 Fonts 键集不同，字体计数口径需要重新确认")

    def _all_fonts_sections(self) -> dict[str, dict[str, str]]:
        """取出 system.reg 里**所有**以 Fonts 结尾的段。"""
        out: dict[str, dict[str, str]] = {}
        current = None
        for line in self.text.splitlines():
            if line.startswith("["):
                current = line.split("]")[0] + "]"
                if current.endswith("\\\\Fonts]"):
                    out.setdefault(current, {})
                continue
            if current in out and "=" in line and not line.strip().startswith(";"):
                key, _, value = line.partition("=")
                out[current][key.strip().strip('"')] = value.strip().strip('"')
        return out

    def test_parser_returns_single_section_not_sum_of_sections(self) -> None:
        """解析器必须只返回一段的量，不能把多段加总。

        **这条的判别力靠「与多段之和不相等」**：两段键集相同，所以
        「合并成字典」长度不变，若只跟前一段比长度，写错了也发现不了。
        只有跟「各段条数之和」比，加总式的错误才会变红。
        """
        section = parse_fonts_section(self.text)
        sections = self._all_fonts_sections()
        self.assertGreater(len(sections), 1, "只找到一段 Fonts，本用例失去意义")
        summed = sum(len(s) for s in sections.values())
        self.assertEqual(len(section), len(sections[next(iter(
            [k for k in sections if "Windows NT" in k] or [next(iter(sections))]))]))
        self.assertNotEqual(len(section), summed,
                            "解析结果等于各段之和，说明发生了重复计数")

    def test_zh_font_count_is_not_doubled(self) -> None:
        """中文字体条数取单段，不得等于「各段加总」的结果。"""
        families = ["PingFang", "Songti", "Kaiti", "Heiti", "Hiragino"]

        def zh_count(entries: dict[str, str]) -> int:
            return sum(1 for k, v in entries.items()
                       if any(f.lower() in v.lower() or f.lower() in k.lower()
                              for f in families))

        single = zh_count(parse_fonts_section(self.text))
        summed = sum(zh_count(s) for s in self._all_fonts_sections().values())
        self.assertGreater(single, 0, "一个中文字体都没找到，判据可能失效")
        self.assertGreater(summed, single, "各段之和应大于单段，否则本用例无判别力")
        # 真源是 single。若代码或文档出现 summed 那一档，即为重复计数
        self.assertNotEqual(single, summed)
