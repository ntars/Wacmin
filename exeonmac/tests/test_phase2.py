"""阶段 2 验收测试：prefix 创建 + 静默安装。

跑法：
    cd ExeOnMac && python3 -m unittest tests.test_phase2 -v

需要真实 wine 的测试用环境变量控制，缺失则跳过：
    WEXE_REAL_WINE=1                     启用真实 wine 的集成测试
    WEXE_SAMPLE_NSIS=/path/to/setup.exe  真实 NSIS 安装包

不依赖 wine 的测试用假 wine（shell 脚本）验证编排逻辑：
参数拼接、环境变量、超时、退出码处理、日志写入。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from wepack import paths as wexe_paths  # noqa: E402
from wepack.errors import InstallFailed, UsageError  # noqa: E402
from wepack.install import (  # noqa: E402
    _host_to_wine_path, _to_windows_path, default_install_dir, verify_install,
    InstallRun, silent_args_for, write_install_log,
)
from wepack.models import Detection, InstallerKind  # noqa: E402
from wepack.prefix import (  # noqa: E402
    clone_tree, create_prefix, free_space, prefix_disk_usage, validate_prefix,
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


# --------------------------------------------------------------------------
# 测试脚手架
# --------------------------------------------------------------------------


def make_fake_wine(root: Path, *, exit_code: int = 0, sleep: float = 0) -> Path:
    """造一个假 wine：记录调用参数与环境，按指定退出码返回。

    这样能在没有真实 wine 的情况下验证：
      - 参数是否按 5.1 表正确拼接
      - WINEPREFIX / WINEDEBUG / PATH 是否设对
      - 超时与退出码处理
    """
    bin_dir = root / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    script = bin_dir / "wine64"
    # 用 printf 而不是 echo：echo 会解释反斜杠，Windows 路径会被吃掉
    script.write_text(
        "#!/bin/sh\n"
        f'{{ printf "ARGV:"; for a in "$@"; do printf " [%s]" "$a"; done; printf "\\n"; }} '
        f'>> "{root}/calls.log"\n'
        f'printf "WINEPREFIX=%s\\n" "$WINEPREFIX" >> "{root}/calls.log"\n'
        f'printf "WINEDEBUG=%s\\n" "$WINEDEBUG" >> "{root}/calls.log"\n'
        f'printf "WINEDLLOVERRIDES=%s\\n" "$WINEDLLOVERRIDES" >> "{root}/calls.log"\n'
        f'sleep {sleep}\n'
        f"exit {exit_code}\n",
        encoding="utf-8",
    )
    script.chmod(0o755)
    return script


def make_nsis_installer() -> bytes:
    """造一个能被 detect_installer 认成 NSIS 的最小样本。

    install 命令在跑 wine 之前会先识别安装器类型，认不出来直接退出码 4。
    因此端到端测试必须给一个真能被识别的包，否则测的根本不是安装流程。
    """
    from tests.test_phase1 import build_min_pe, build_nsis_overlay

    return build_min_pe(machine=0x14C, overlay=build_nsis_overlay())


def make_fake_layer(root: Path, name: str = "base") -> Path:
    """造一个结构合法的假 base 层（含 system32 与注册表）。"""
    layer = root / name
    system32 = layer / "drive_c" / "windows" / "system32"
    system32.mkdir(parents=True)
    (system32 / "kernel32.dll").write_bytes(b"MZ" + b"\0" * 100)
    (system32 / "user32.dll").write_bytes(b"MZ" + b"\0" * 100)
    (layer / "drive_c" / "windows" / "Fonts").mkdir(parents=True)
    for reg in ("system.reg", "user.reg", "userdef.reg"):
        header = "WINE REGISTRY Version 2\n"
        (layer / reg).write_bytes(b"\xff\xfe" + header.encode("utf-16-le"))
    return layer


class IsolatedWexe(unittest.TestCase):
    """把 WEXE_HOME 指到临时目录，避免污染真实 ~/Library。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="exeonmac-p2-")
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
# 静默参数拼接
# --------------------------------------------------------------------------


class TestSilentArgs(unittest.TestCase):
    def test_nsis_slash_d_last_and_unquoted(self) -> None:
        args = silent_args_for(InstallerKind.NSIS, "drive_c/Program Files/7-Zip")
        self.assertEqual(args[0], "/S")
        self.assertEqual(args[-1], "/D=C:\\Program Files\\7-Zip")
        # /D 必须最后一项
        self.assertTrue(args[-1].startswith("/D="))
        # 不能带引号
        self.assertNotIn('"', args[-1])

    def test_nsis_slash_d_survives_without_spaces(self) -> None:
        """默认目录不含空格时，/D= 才能被 NSIS 正确接收。

        这是本套最重要的一条回归测试。实测证据（Ondra 1.3.0，同一 prefix）：

          /D=C:\\Program Files\\DirTestA  → 净增 0 个文件，退出码 0
          /D=C:\\DirTestNoSpace          → 净增 6424 个文件

        根因是 wine 会给含空格的 argv 自动补引号，而 NSIS 只认行首的
        /D=，带引号就整个丢弃。所以默认目录必须不含空格。
        """
        install_dir = default_install_dir("Ondra")
        self.assertNotIn(" ", install_dir,
                         "默认安装目录不能含空格，否则 NSIS 的 /D= 会静默失效")
        args = silent_args_for(InstallerKind.NSIS, install_dir)
        self.assertNotIn(" ", args[-1])
        self.assertNotIn('"', args[-1])

    def test_default_dir_keeps_app_name_without_spaces(self) -> None:
        """应用名本身含空格时也要清掉 —— 否则整个路径又含空格了。"""
        install_dir = default_install_dir("空谷 Ondra")
        self.assertNotIn(" ", install_dir)
        self.assertIn("空谷", install_dir)

    def test_inno_args(self) -> None:
        args = silent_args_for(InstallerKind.INNO, "drive_c/Program Files/App")
        self.assertIn("/VERYSILENT", args)
        self.assertIn("/SUPPRESSMSGBOXES", args)
        self.assertIn("/NORESTART", args)
        self.assertTrue(any(a.startswith("/DIR=") for a in args))

    def test_inno_dir_value_has_no_literal_quotes(self) -> None:
        """Inno 的 /DIR= 不能自带引号 —— wine 会把内部引号转义掉。

        实测（cmd 回显）：

          argv '/DIR=C:\\Program Files\\Ondra'
            → Inno 看到 "/DIR=C:\\Program Files\\Ondra"     ✓ 整个是一个参数
          argv '/DIR="C:\\Program Files\\Ondra"'
            → Inno 看到 "/DIR=\\"C:\\Program  + Files\\Ondra\\""  ✗ 被拆成两段

        所以「不加引号」是对的（wine 会替我们补），早期文档里写加引号是错的
        （记录在仓库根 README.md 第 15.2 节）。
        """
        args = silent_args_for(InstallerKind.INNO, "drive_c/Program Files/App")
        dir_arg = next(a for a in args if a.startswith("/DIR="))
        self.assertNotIn('"', dir_arg)
        self.assertIn("Program Files", dir_arg)

    def test_installshield_args(self) -> None:
        args = silent_args_for(InstallerKind.INSTALLSHIELD, "drive_c/App")
        self.assertEqual(args[0], "/s")
        self.assertIn("/v", args[1])

    def test_installshield_v_has_no_literal_quotes(self) -> None:
        """`/v" /qn"` 里的字面引号会被 wine 转义，必须去掉。

        实测（cmd 回显三段）：

          argv '/v" /qn"'  → 安装器看到 ["/v\\"] 和 [/qn\\""]   ✗ 两个参数都变形

        官方要求的 `/v"/qn"` 形态在 wine 下同样不行 —— 内部引号会被转义成
        \\"。唯一干净的形式是不带引号的 /v/qn，InstallShield 与 msiexec
        都认这个紧凑写法。
        """
        args = silent_args_for(InstallerKind.INSTALLSHIELD, "drive_c/App")
        for arg in args:
            self.assertNotIn('"', arg,
                             f"参数 {arg!r} 含字面引号，wine 会转义成 \\\"")
        self.assertEqual(args[1], "/v/qn")

    def test_msi_args(self) -> None:
        args = silent_args_for(InstallerKind.MSI, "")
        self.assertIn("/qn", args)
        self.assertIn("/norestart", args)

    def test_burn_args(self) -> None:
        args = silent_args_for(InstallerKind.BURN, "drive_c/App")
        self.assertIn("/quiet", args)
        self.assertIn("/install", args)
        self.assertIn("/norestart", args)

    def test_squirrel_args(self) -> None:
        self.assertEqual(silent_args_for(InstallerKind.SQUIRREL, ""), ["--silent"])

    def test_unknown_returns_empty(self) -> None:
        self.assertEqual(silent_args_for(InstallerKind.UNKNOWN, ""), [])

    def test_no_kind_produces_literal_quotes(self) -> None:
        """横向检查：任何一类安装器都不该产出含字面引号的参数。

        wine 对 argv 里的双引号一律转义。一旦某个分支写进引号，安装器
        收到的参数就会变形 —— 这类 bug 在单元测试里看不出来（argv 本身
        是「符合预期」的），只有真的跑起来才暴露。这条断言从源头上挡住。
        """
        for kind in InstallerKind:
            if kind is InstallerKind.UNKNOWN:
                continue
            for arg in silent_args_for(kind, "drive_c/Program Files/App"):
                self.assertNotIn('"', arg, f"{kind.value} 产出了含引号的参数 {arg!r}")

    def test_path_conversion(self) -> None:
        self.assertEqual(_to_windows_path("drive_c/Program Files/App"),
                         "C:\\Program Files\\App")
        self.assertEqual(_to_windows_path("C:\\App"), "C:\\App")
        self.assertEqual(_to_windows_path("Program Files/App"),
                         "C:\\Program Files\\App")

    def test_host_to_wine_path(self) -> None:
        path = _host_to_wine_path(Path("/Users/x/setup.exe"))
        self.assertTrue(path.startswith("Z:"))
        self.assertIn("Users", path)
        self.assertNotIn("/", path)

    def test_default_install_dir(self) -> None:
        self.assertEqual(default_install_dir("7-Zip"), "drive_c/Wacmin/7-Zip")
        # 路径分隔符被替换，防止注入
        self.assertNotIn("/", default_install_dir("a/b").split("Wacmin/")[1])

    def test_default_install_dir_has_no_spaces(self) -> None:
        """默认目录绝不能含空格 —— 那是 NSIS /D= 失效的充要条件。"""
        for name in ["7-Zip", "空谷 Ondra", "My App", "  ", "", "a b c"]:
            install_dir = default_install_dir(name)
            self.assertNotIn(" ", install_dir,
                             f"应用名 {name!r} 产出了含空格的目录 {install_dir!r}")


class TestChinesePaths(unittest.TestCase):
    """中文路径的端到端处理。

    ## 这一组守的是什么

    中文不是「边角情况」—— 目标用户装的就是中文软件（微信、钉钉、
    网易云音乐）。中文路径在四类环节上各有各的坑：

      1. **拼路径**：中文要保留（用户要能看懂 `C:\\Wacmin\\记事本`），
         但不能带空格（NSIS 的 `/D=` 硬约束，见 5.6）
      2. **转 Windows 形式**：POSIX 的 `/` 要变 `\\`，`drive_c` 要变 `C:`
      3. **进 argv**：中文经 wine 传给安装器时不能变成 cp936 乱码
      4. **进 bundle id**：中文必须被剔除，但不能剔除到失去区分度

    第 4 点是本组之外的独立缺陷（见 test_phase3.TestBundleId），这里
    只覆盖前三点的可离线验证部分。
    """

    def test_chinese_preserved_but_spaces_removed(self) -> None:
        """中文保留、空格清除 —— 两个要求同时满足。"""
        install_dir = default_install_dir("我的 应用（测试）")
        self.assertIn("我的", install_dir, "中文被误删了")
        self.assertIn("应用", install_dir)
        self.assertNotIn(" ", install_dir, "空格没清掉")

    def test_chinese_path_converts_to_windows_form(self) -> None:
        """`drive_c/Wacmin/记事本` → `C:\\Wacmin\\记事本`。"""
        install_dir = default_install_dir("记事本")
        windows = _to_windows_path(install_dir)
        self.assertEqual(windows, "C:\\Wacmin\\记事本")
        self.assertNotIn("/", windows, "还有 POSIX 分隔符没换")

    def test_windows_form_has_no_space_for_nsis(self) -> None:
        """
        转成 Windows 形式后仍不含空格。

        这是 NSIS 那条链路的最后一道闸：`_to_windows_path` 若引入空格
        （比如把某个字段拼错），上面所有的努力都白费。
        """
        for name in ["记事本", "空谷 Ondra", "我的 应用（测试）", "QQ音乐", "钉钉"]:
            windows = _to_windows_path(default_install_dir(name))
            self.assertNotIn(" ", windows,
                             f"{name!r} 转成 Windows 形式后含空格：{windows!r}")

    def test_chinese_path_is_utf8_encodable(self) -> None:
        """
        路径必须能编码成 UTF-8 字节。

        看起来像废话，但它挡住一类真实故障：代码里若用
        `str(path).encode('ascii', 'replace')` 之类的写法处理路径，
        中文会静默变成 `?`，最后报「找不到目录」而看不出原因。
        """
        for name in ["记事本", "我的应用", "微信"]:
            install_dir = default_install_dir(name)
            encoded = install_dir.encode("utf-8")
            self.assertEqual(encoded.decode("utf-8"), install_dir)
            self.assertIn("记事本" if name == "记事本" else name.split()[0],
                          install_dir)

    def test_slash_and_backslash_both_neutralized(self) -> None:
        """
        应用名里的斜杠不能变成路径分隔符。

        否则 `App/With\\Slash` 会在 `C:\\Wacmin` 下建出两级目录，
        而卸载时只删第一级。
        """
        install_dir = default_install_dir("App/With\\Slash")
        # 去掉 drive_c/ 前缀后只应剩一级目录
        tail = install_dir.split("Wacmin/", 1)[1]
        self.assertNotIn("/", tail)
        self.assertNotIn("\\", tail)

    def test_emoji_kept(self) -> None:
        """emoji 是合法的文件名成分，不该被删。"""
        install_dir = default_install_dir("emoji😀 App")
        self.assertIn("😀", install_dir)
        self.assertNotIn(" ", install_dir)


# --------------------------------------------------------------------------
# clonefile
# --------------------------------------------------------------------------


class TestClone(IsolatedWexe):
    def test_clone_tree_copies_content(self) -> None:
        source = self.tmp / "src"
        (source / "sub").mkdir(parents=True)
        (source / "a.txt").write_text("hello", encoding="utf-8")
        (source / "sub" / "b.txt").write_text("world", encoding="utf-8")

        target = self.tmp / "dst"
        result = clone_tree(source, target)
        self.assertTrue(result.ok)
        self.assertEqual((target / "a.txt").read_text(), "hello")
        self.assertEqual((target / "sub" / "b.txt").read_text(), "world")
        self.assertIn(result.method, ("clonefile", "copy"))

    def test_clone_refuses_existing_target(self) -> None:
        source = self.tmp / "src"
        source.mkdir()
        target = self.tmp / "dst"
        target.mkdir()
        with self.assertRaises(UsageError):
            clone_tree(source, target)

    def test_clone_missing_source(self) -> None:
        with self.assertRaises(UsageError):
            clone_tree(self.tmp / "nope", self.tmp / "dst")

    def test_clonefile_saves_space(self) -> None:
        """clonefile 应让真实占用远小于逻辑大小。

        不能拿 st_blocks 判断：APFS 会把共享块重复计入每个副本，
        du / st_blocks 都看不出共享。只能测卷可用空间的差值。
        """
        source = self.tmp / "src"
        source.mkdir()
        size = 64 * 1024 * 1024
        (source / "big.bin").write_bytes(b"\0" * size)

        before = free_space(self.tmp)
        target = self.tmp / "dst"
        result = clone_tree(source, target)
        after = free_space(self.tmp)

        if result.method != "clonefile":
            self.skipTest("当前文件系统不支持 clonefile")

        consumed = before - after
        # clonefile 下新增 64 MB 文件只应占元数据级别（远小于 1 MB）
        self.assertLess(consumed, 1024 * 1024,
                        f"clonefile 实际占用 {consumed} 字节，预期 < 1 MB")


# --------------------------------------------------------------------------
# prefix 创建
# --------------------------------------------------------------------------


class TestCreatePrefix(IsolatedWexe):
    def test_requires_base_first(self) -> None:
        with self.assertRaises(UsageError) as ctx:
            create_prefix(self.tmp / "private", layers=["vcpp"])
        self.assertIn("base", str(ctx.exception))

    def test_missing_layer_raises(self) -> None:
        with self.assertRaises(InstallFailed) as ctx:
            create_prefix(self.tmp / "private", layers=["base"])
        self.assertIn("base", str(ctx.exception))

    def test_creates_prefix_from_base_layer(self) -> None:
        make_fake_layer(wexe_paths.layers_root(), "base")
        private = self.tmp / "private"
        report = create_prefix(private, layers=["base"])

        self.assertTrue(report.created)
        self.assertTrue((private / "drive_c" / "windows" / "system32").is_dir())
        self.assertTrue((private / "dosdevices" / "c:").is_symlink())
        self.assertTrue((private / "dosdevices" / "z:").is_symlink())
        self.assertEqual(validate_prefix(private), [])

    def test_dosdevices_c_is_relative(self) -> None:
        """c: 必须是相对链接，否则包移动后失效。"""
        make_fake_layer(wexe_paths.layers_root(), "base")
        private = self.tmp / "private"
        create_prefix(private, layers=["base"])
        link = private / "dosdevices" / "c:"
        target = os.readlink(link)
        self.assertEqual(target, "../drive_c")
        self.assertFalse(os.path.isabs(target))

    def test_dosdevices_z_points_to_root(self) -> None:
        make_fake_layer(wexe_paths.layers_root(), "base")
        private = self.tmp / "private"
        create_prefix(private, layers=["base"])
        self.assertEqual(os.readlink(private / "dosdevices" / "z:"), "/")

    def test_refuses_non_empty_dir(self) -> None:
        make_fake_layer(wexe_paths.layers_root(), "base")
        private = self.tmp / "private"
        private.mkdir()
        (private / "existing.txt").write_text("user data", encoding="utf-8")
        with self.assertRaises(UsageError) as ctx:
            create_prefix(private, layers=["base"])
        self.assertIn("非空", str(ctx.exception))
        # 用户数据必须原样保留
        self.assertTrue((private / "existing.txt").is_file())

    def test_multiple_layers_merge(self) -> None:
        """后挂的层应覆盖前层的同名文件。"""
        base = make_fake_layer(wexe_paths.layers_root(), "base")
        vcpp = wexe_paths.layers_root() / "vcpp"
        (vcpp / "drive_c" / "windows" / "system32").mkdir(parents=True)
        (vcpp / "drive_c" / "windows" / "system32" / "msvcp140.dll").write_bytes(b"MZ vcpp")
        # 也覆盖一个 base 已有的文件
        (vcpp / "drive_c" / "windows" / "system32" / "user32.dll").write_bytes(b"MZ from vcpp")

        private = self.tmp / "private"
        create_prefix(private, layers=["base", "vcpp"])

        system32 = private / "drive_c" / "windows" / "system32"
        self.assertTrue((system32 / "msvcp140.dll").is_file())
        self.assertEqual((system32 / "user32.dll").read_bytes(), b"MZ from vcpp")

    def test_shared_layer_not_modified(self) -> None:
        """铁律：写 Private 不能污染共享层。"""
        base = make_fake_layer(wexe_paths.layers_root(), "base")
        original = (base / "drive_c" / "windows" / "system32" / "user32.dll").read_bytes()

        private = self.tmp / "private"
        create_prefix(private, layers=["base"])

        # 改 Private 里的文件
        target = private / "drive_c" / "windows" / "system32" / "user32.dll"
        target.write_bytes(b"MODIFIED")

        # 共享层必须不变
        self.assertEqual(
            (base / "drive_c" / "windows" / "system32" / "user32.dll").read_bytes(),
            original)

    def test_placeholder_regs_written_when_missing(self) -> None:
        layer = wexe_paths.layers_root() / "base"
        system32 = layer / "drive_c" / "windows" / "system32"
        system32.mkdir(parents=True)
        (system32 / "kernel32.dll").write_bytes(b"MZ")
        # 故意不放 .reg 文件

        private = self.tmp / "private"
        create_prefix(private, layers=["base"])
        for reg in ("system.reg", "user.reg", "userdef.reg"):
            path = private / reg
            self.assertTrue(path.is_file())
            self.assertGreater(path.stat().st_size, 0)
            # wine 的 .reg 必须是 UTF-16LE + BOM
            self.assertEqual(path.read_bytes()[:2], b"\xff\xfe")

    def test_layer_file_copy_failure_is_not_reported_as_success(self) -> None:
        """合并层时复制失败必须让 mount 失败，不能悄悄少文件。

        ## 这条锁住的是什么

        `_clone_into` 早先逐个文件 `shutil.copy2`，失败就 `except OSError: pass`，
        然后照常返回 `ok=True`。`validate_prefix` 只核对几个关键路径
        （system32 / windows / 三个 .reg），少一个 DLL 或一个运行时文件它
        看不出来 —— 于是 mount 报成功，用户装完双击才炸，还要重新走十分钟
        安装才能发现。

        ## 为什么直接调 `_clone_into` 而不是走 `create_prefix`

        第一版测试是让层里放个 `chmod 000` 的文件再调 `create_prefix`，
        **但那样测不到这里的逻辑**：`_clone_into` 第一步是 `clone_tree`
        把层复制到临时目录，而 `cp -R -p` 碰到不可读文件会返回非 0，
        `clone_tree` 就已经返回 ok=False 并抛出「挂载层失败」了 —— 合并
        循环里的 `copy2` 一次都没执行，把 `except` 改回 `pass` 测试照样绿。
        （这个假绿是被反向验证抓出来的：回退产品代码后测试仍然通过。）

        所以这里绕开 `clone_tree`，直接对着已就位的 staging 调合并循环：
        把不可读文件放在 staging 的对应位置，visible 的是它复制不过去。
        """
        from wepack.prefix import _clone_into

        layer = self.tmp / "layer-vcpp"
        (layer / "drive_c" / "windows" / "system32").mkdir(parents=True)
        (layer / "drive_c" / "windows" / "system32" / "msvcp140.dll").write_bytes(b"MZ vcpp")

        private = self.tmp / "private"
        private.mkdir()

        # ## 怎么可靠地让 copy2 失败
        #
        # 第一版用 `chmod 000` 造不可读的源文件 —— 但 `cp -R -p` 会先失败，
        # 根本走不到合并循环。第二版把目标位置占成目录 —— 也不行：
        # `shutil.copy2(src, dir)` 的语义是「复制**进**这个目录」，它对
        # 目录名是合法的，不报错。
        #
        # 最后用父目录 `chmod 500`（只读）：目标文件写不进去，
        # 而 clone_tree 复制到临时目录那一步不受影响。
        system32 = private / "drive_c" / "windows" / "system32"
        system32.mkdir(parents=True)
        system32.chmod(0o500)

        try:
            result = _clone_into(layer, private)
            self.assertFalse(result.ok, "合并失败却报成功，层文件会悄无声息地缺失")
            self.assertIn("msvcp140.dll", result.note)
            self.assertIn("写入失败", result.note)
        finally:
            system32.chmod(0o755)    # 恢复，否则 TemporaryDirectory 清不掉


class TestValidatePrefix(IsolatedWexe):
    def test_reports_missing_drive_c(self) -> None:
        private = self.tmp / "private"
        private.mkdir()
        problems = validate_prefix(private)
        self.assertTrue(any("drive_c" in p for p in problems))

    def test_reports_missing_regs(self) -> None:
        private = self.tmp / "private"
        (private / "drive_c" / "windows" / "system32").mkdir(parents=True)
        (private / "drive_c" / "windows" / "system32" / "a.dll").write_bytes(b"MZ")
        (private / "dosdevices").mkdir()
        os.symlink("../drive_c", private / "dosdevices" / "c:")
        problems = validate_prefix(private)
        self.assertTrue(any("system.reg" in p for p in problems))

    def test_healthy_prefix_has_no_problems(self) -> None:
        make_fake_layer(wexe_paths.layers_root(), "base")
        private = self.tmp / "private"
        create_prefix(private, layers=["base"])
        self.assertEqual(validate_prefix(private), [])


# --------------------------------------------------------------------------
# 安装编排（假 wine）
# --------------------------------------------------------------------------


class TestRunInstall(IsolatedWexe):
    def _setup(self) -> tuple[Path, Path]:
        """建好假 wine + 假 base 层 + prefix，返回 (prefix, installer)。"""
        make_fake_wine(wexe_paths.wine_root())
        make_fake_layer(wexe_paths.layers_root(), "base")
        private = self.tmp / "private"
        create_prefix(private, layers=["base"])

        installer = self.tmp / "setup.exe"
        installer.write_bytes(b"MZ" + b"\0" * 200)
        return private, installer

    def test_runs_with_correct_env(self) -> None:
        from wepack.install import run_install

        private, installer = self._setup()
        detection = Detection(path=installer, kind=InstallerKind.NSIS,
                              confidence=0.99, product_name="TestApp")
        run = run_install(private, installer, detection, silent=True, timeout=30)

        # 本测试只关心环境变量，不关心产物 —— 假 wine 不装文件，
        # run.ok 会因产物校验为 False，那是另一条测试的范围
        self.assertTrue(run.exit_ok)
        self.assertEqual(run.returncode, 0)

        log = (wexe_paths.wine_root() / "calls.log").read_text(encoding="utf-8")
        # macOS 上 /var 是 /private/var 的软链，必须比较解析后的路径
        self.assertIn(f"WINEPREFIX={private.resolve()}", log)
        self.assertIn("WINEDEBUG=-all", log)
        self.assertIn("mscoree", log)

    def test_installer_accessed_via_z_drive(self) -> None:
        from wepack.install import run_install

        private, installer = self._setup()
        detection = Detection(path=installer, kind=InstallerKind.NSIS,
                              confidence=0.99, product_name="TestApp")
        run_install(private, installer, detection, timeout=30)

        log = (wexe_paths.wine_root() / "calls.log").read_text(encoding="utf-8")
        argv_line = next(line for line in log.splitlines() if line.startswith("ARGV:"))
        self.assertIn("Z:", argv_line)
        # 原安装包不应被复制进 prefix
        self.assertFalse(any(private.rglob("setup.exe")))

    def test_nsis_silent_args_passed(self) -> None:
        from wepack.install import run_install

        private, installer = self._setup()
        detection = Detection(path=installer, kind=InstallerKind.NSIS,
                              confidence=0.99, product_name="TestApp")
        run_install(private, installer, detection, silent=True, timeout=30)

        log = (wexe_paths.wine_root() / "calls.log").read_text(encoding="utf-8")
        self.assertIn("/S", log)
        self.assertIn("/D=", log)

    def test_nonzero_exit_marked_failed(self) -> None:
        from wepack.install import run_install

        make_fake_wine(wexe_paths.wine_root(), exit_code=2)
        make_fake_layer(wexe_paths.layers_root(), "base")
        private = self.tmp / "private"
        create_prefix(private, layers=["base"])
        installer = self.tmp / "setup.exe"
        installer.write_bytes(b"MZ")

        detection = Detection(path=installer, kind=InstallerKind.NSIS, confidence=0.9)
        run = run_install(private, installer, detection, timeout=30)
        self.assertFalse(run.ok)
        self.assertEqual(run.returncode, 2)

    def test_3010_treated_as_success(self) -> None:
        """MSI 的 3010 = 成功但需重启，退出码层面应算成功。

        **只断言 exit_ok，不断言 ok**：3010 说的是「安装器认为自己成功了」，
        与「文件真的装进去了」是两件事。假 wine 不会装任何文件，所以
        产物校验必然判失败 —— 那正是本轮新增的行为，另有测试覆盖。

        这里直接构造 InstallRun 而非跑假 wine：POSIX 退出码只有 8 位，
        脚本 `exit 3010` 会被截断成 194（3010 & 0xFF），根本到不了 3010。
        早先的写法用 exit_code=0 冒充，等于没测这个分支。
        """
        from wepack.install import InstallRun

        run = InstallRun(returncode=3010)
        self.assertTrue(run.exit_ok)

        # 对照：普通非零退出码不算成功
        self.assertFalse(InstallRun(returncode=2).exit_ok)
        # 超时优先于退出码
        self.assertFalse(InstallRun(returncode=0, timed_out=True).exit_ok)

    def test_timeout_kills_process(self) -> None:
        from wepack.install import run_install

        make_fake_wine(wexe_paths.wine_root(), sleep=30)
        make_fake_layer(wexe_paths.layers_root(), "base")
        private = self.tmp / "private"
        create_prefix(private, layers=["base"])
        installer = self.tmp / "setup.exe"
        installer.write_bytes(b"MZ")

        detection = Detection(path=installer, kind=InstallerKind.NSIS, confidence=0.9)
        run = run_install(private, installer, detection, timeout=2)
        self.assertTrue(run.timed_out)
        self.assertFalse(run.ok)
        self.assertLess(run.duration, 15)

    def test_writes_install_log(self) -> None:
        from wepack.install import run_install

        private, installer = self._setup()
        log_path = self.tmp / "install.log"
        detection = Detection(path=installer, kind=InstallerKind.NSIS, confidence=0.9)
        run_install(private, installer, detection, timeout=30, log_path=log_path)

        self.assertTrue(log_path.is_file())
        text = log_path.read_text(encoding="utf-8")
        # run_install 只记自己的动作：安装起止、产物净增量、校验结论。
        # detect / prefix.create 由 cmd_install 记，不在这里重复。
        self.assertIn("install.start", text)
        self.assertIn("install.exit", text)
        self.assertIn("install.delta", text)
        self.assertIn("install.verify", text)

    def test_missing_prefix_raises(self) -> None:
        from wepack.install import run_install

        make_fake_wine(wexe_paths.wine_root())
        installer = self.tmp / "setup.exe"
        installer.write_bytes(b"MZ")
        detection = Detection(path=installer, kind=InstallerKind.NSIS, confidence=0.9)
        with self.assertRaises(UsageError):
            run_install(self.tmp / "nope", installer, detection, timeout=10)


class TestProcessCleanup(unittest.TestCase):
    """run_install 的兜底回收：异常路径不能留下 wine 子进程。

    ## 为什么需要这组测试

    正常路径在循环结束后会 `communicate()` 收割，超时走 `_kill_group()`。
    但**意外异常**会让这些收尾全部跳过 —— 比如循环体内的
    `_tree_signature` 撞上磁盘 I/O 错误、日志目录被删、或 KeyboardInterrupt。

    实测：让 `_tree_signature` 第二次调用抛 ValueError，`run_install` 抛出
    后 wine 进程仍然存活（pgrep 能查到 PID）。残留进程占住 prefix，下次
    安装直接失败 —— 这正是仓库根 README.md 第 15.2 节里「残留 prefix 锁文件」的成因之一。
    """

    def test_reap_closes_pipes_and_kills_process(self) -> None:
        """_reap_process 对仍存活的进程要杀掉并关闭管道。"""
        import subprocess as sp

        from wepack.install import _reap_process

        process = sp.Popen(
            ["/bin/sh", "-c", "sleep 30"],
            stdout=sp.PIPE, stderr=sp.PIPE, text=True,
            start_new_session=True,
        )
        _reap_process(process)

        self.assertIsNotNone(process.poll(), "进程应已退出")
        self.assertTrue(process.stdout.closed, "stdout 管道应已关闭")
        self.assertTrue(process.stderr.closed, "stderr 管道应已关闭")

    def test_reap_is_idempotent(self) -> None:
        """重复调用不能抛异常 —— 它跑在 finally 里，再抛会吞掉原始错误。"""
        import subprocess as sp

        from wepack.install import _reap_process

        process = sp.Popen(["/bin/echo", "hi"], stdout=sp.PIPE,
                           stderr=sp.PIPE, text=True)
        process.wait(timeout=10)
        # 已退出的进程连调三次都不该出问题
        for _ in range(3):
            _reap_process(process)

    def test_unexpected_exception_does_not_leak_process(self) -> None:
        """循环体内抛非 OSError 异常时，wine 进程必须被回收。

        这是端到端版本：真跑一次 run_install，中途让 _tree_signature 炸掉，
        然后确认没有残留进程。
        """
        import subprocess as sp
        import time as _time

        from wepack import install as install_mod
        from wepack.models import Detection, InstallerKind

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            prefix = root / "prefix"
            (prefix / "drive_c").mkdir(parents=True)

            fake_wine = root / "wine64"
            fake_wine.write_text("#!/bin/sh\nsleep 30\n", encoding="utf-8")
            fake_wine.chmod(0o755)

            installer = root / "setup.exe"
            installer.write_bytes(b"MZ")

            original_sig = install_mod._tree_signature
            original_bin = install_mod.wine_binary
            calls = {"n": 0}

            def exploding_sig(path):
                calls["n"] += 1
                if calls["n"] >= 2:
                    raise ValueError("模拟循环体内的意外异常")
                return original_sig(path)

            install_mod._tree_signature = exploding_sig
            install_mod.wine_binary = lambda: fake_wine
            try:
                detection = Detection(path=installer, kind=InstallerKind.NSIS,
                                      confidence=0.9)
                with self.assertRaises(ValueError):
                    install_mod.run_install(prefix, installer, detection, timeout=60)
                _time.sleep(0.5)
                leftover = sp.run(["pgrep", "-f", str(fake_wine)],
                                  capture_output=True, text=True).stdout.strip()
                self.assertEqual(leftover, "", f"残留进程：{leftover}")
            finally:
                install_mod._tree_signature = original_sig
                install_mod.wine_binary = original_bin

    def test_kill_group_calls_wineserver_with_matching_prefix(self) -> None:
        """_kill_group 必须用 wineserver -k 收尾，且带对 WINEPREFIX。

        ## 这条守的是一段「文档写了、代码没写」的空承诺

        `_kill_group` 的 docstring 一直列着三步收尾，第 3 步是
        「按 WINEPREFIX 用 wineserver -k 清掉残留」。但实现里只有前两步，
        第三步根本不存在。

        后果实测：跑一轮含真实安装的测试，Dock 里堆了 12 个 wine 图标
        （6 对）。killpg 只覆盖原进程组，而 wine 的服务进程会脱离进程组，
        杀不到 —— 这正是需要 wineserver -k 的原因。

        ## 还有一个更隐蔽的坑：不能用 `wine_binary() + "wineserver"`

        第一版实现是 `[wine64, "wineserver", "-k"]`。`wine64` 是 Windows
        程序加载器，它把 `wineserver` 当成 Windows 可执行文件去
        `ShellExecuteEx`，报 `File not found`，实测 2.2 秒白跑一次、
        一个进程都没杀。看起来「调过了」，实际是空转。

        所以这里必须拦**真实的** wineserver 路径：把 wineserver 二进制
        本身替换成一个记录参数的脚本，并断言调用链走的是它。
        """
        import subprocess as sp

        from wepack import install as install_mod

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            prefix = root / "prefix"
            (prefix / "drive_c").mkdir(parents=True)

            # 伪造一个 wineserver 可执行文件，记录收到的参数
            log = root / "wineserver-calls.log"
            fake_server = root / "wineserver"
            fake_server.write_text(
                f'#!/bin/sh\necho "$@" >> "{log}"\nexit 0\n', encoding="utf-8")
            fake_server.chmod(0o755)

            original = install_mod.wineserver_binary
            install_mod.wineserver_binary = lambda: fake_server
            try:
                process = sp.Popen(["/bin/sh", "-c", "sleep 30"],
                                   stdout=sp.PIPE, stderr=sp.PIPE,
                                   text=True, start_new_session=True)
                try:
                    install_mod._kill_group(process, prefix)
                finally:
                    try:
                        process.wait(timeout=5)
                    except sp.TimeoutExpired:
                        process.kill()
                    for stream in (process.stdout, process.stderr):
                        if stream and not stream.closed:
                            stream.close()
            finally:
                install_mod.wineserver_binary = original

            self.assertTrue(log.is_file(), "wineserver 从未被调用")
            calls = log.read_text(encoding="utf-8")
            self.assertIn("-k", calls, f"没有传 -k，实际参数：{calls!r}")

    def test_wineserver_binary_is_not_wine_loader(self) -> None:
        """定位到的必须是 wineserver 本身，不是 wine64。

        单独一条，因为「找到了一个可执行文件」和「找到的是对的那个」
        是两件事。前者会让上一条通过、而实际仍在空转。
        """
        from wepack.install import wineserver_binary, wine_binary

        server = wineserver_binary()
        if server is None:
            self.skipTest("本机没有 wineserver")   # 不会发生，wine 是必需依赖
        self.assertEqual(server.name, "wineserver",
                         f"定位到的是 {server.name}，不是 wineserver")
        self.assertNotEqual(server, wine_binary(),
                            "wineserver 与 wine 加载器不可能是同一个文件")

    def test_cleanup_failure_is_reported_not_silent(self) -> None:
        """清理没成功时必须返回 False 并写 WARN，不能静默吞掉。

        ## 这条守的是「静默成功」

        早先 `kill_prefix_processes` 把三种失败（找不到 wineserver、超时、
        OSError）全部 `pass`。后果不是「清理偶尔失败」，而是**清理从来
        没成功过也没人知道** —— 实测连调用方式都是错的（把 wine64 加载器
        当 wineserver 传），日志里却与成功完全一样。

        安静地失败比响亮地失败危险：没人会去查一个看起来正常的日志。
        """
        import tempfile as tf

        from wepack import install as install_mod
        from wepack.install import _Log, kill_prefix_processes

        with tf.TemporaryDirectory() as tmp:
            root = Path(tmp)
            prefix = root / "prefix"
            (prefix / "drive_c").mkdir(parents=True)
            log = _Log(root / "install.log")

            original = install_mod.wineserver_binary
            install_mod.wineserver_binary = lambda: None
            try:
                ok = kill_prefix_processes(prefix, log=log)
            finally:
                install_mod.wineserver_binary = original

            self.assertFalse(ok, "找不到 wineserver 时不该报成功")
            self.assertTrue(log.lines, "失败必须留下日志，不能静默")
            joined = "\n".join(log.lines)
            self.assertIn("WARN", joined)
            self.assertIn("cleanup", joined)

    def test_cleanup_success_does_not_log_noise(self) -> None:
        """对照组：成功时不写日志。

        只测「失败要报」会让实现倾向于「无条件写一条」，那样每次正常
        安装都会多一行 WARN，用户很快学会忽略 WARN —— 真出问题时也
        不会看。成功路径必须干净。
        """
        import tempfile as tf

        from wepack.install import _Log, kill_prefix_processes

        with tf.TemporaryDirectory() as tmp:
            root = Path(tmp)
            prefix = root / "prefix"
            (prefix / "drive_c").mkdir(parents=True)
            log = _Log(root / "install.log")

            ok = kill_prefix_processes(prefix, log=log)
            self.assertTrue(ok, "正常清理应返回 True")
            self.assertEqual(log.lines, [], f"成功时不该有日志：{log.lines}")

    def test_kill_group_without_prefix_still_kills(self) -> None:
        """没给 prefix 时，前两步照常执行，不能因此不杀进程。

        有些调用点（如回收一个与 prefix 无关的子进程）拿不到 prefix。
        此时跳过 wineserver 是合理的，但绝不能连 killpg 也一起跳过 ——
        那会让「可选参数」变成「静默不清理」。
        """
        import subprocess as sp

        from wepack.install import _kill_group

        process = sp.Popen(["/bin/sh", "-c", "sleep 30"],
                           stdout=sp.PIPE, stderr=sp.PIPE,
                           text=True, start_new_session=True)
        try:
            _kill_group(process)          # 不传 prefix
        finally:
            try:
                process.wait(timeout=5)
            except sp.TimeoutExpired:
                process.kill()
            for stream in (process.stdout, process.stderr):
                if stream and not stream.closed:
                    stream.close()
        self.assertIsNotNone(process.poll(), "进程应已被杀")


class TestInstallVerification(unittest.TestCase):
    """安装产物校验：退出码 0 不等于装上了东西。

    ## 为什么需要这组测试

    实测 Inno Setup 5.5.8 的安装器在 `wine-11.21` 下静默安装会「空转」：
    退出码非零、把自举程序（`_setup64.tmp` / `_shfoldr.dll`）解到
    `Temp/is-*.tmp/_isetup`，但主载荷一个文件都没落下。

    只要代码只看退出码，这种空转就会被判成成功，接着产出一个双击
    没反应的空壳 .app —— 用户完全不知道问题出在安装这一步。
    这组测试锁死「以文件为准」这条判据。
    """

    def _run(self, *, files: int, size: int,
             returncode: int = 0, settled: bool = False) -> InstallRun:
        """造一个已完成的安装结果，直接给最终快照。"""
        return InstallRun(
            returncode=returncode,
            settled_by_progress=settled,
            baseline_files=1000, baseline_bytes=200_000_000,
            final_files=1000 + files, final_bytes=200_000_000 + size,
        )

    def test_empty_install_fails_despite_zero_exit(self) -> None:
        """退出码 0 但一个文件没写 —— 必须判失败。"""
        run = self._run(files=0, size=0, returncode=0)
        verdict = verify_install(run)
        run.verification = verdict

        self.assertFalse(verdict.passed)
        self.assertIn("未向 prefix 写入任何文件", verdict.reason)
        self.assertTrue(run.exit_ok, "退出码层面仍是成功的")
        self.assertFalse(run.ok, "但整体必须判失败")

    def test_inno_bootstrap_only_is_not_success(self) -> None:
        """模拟 Inno 5.x 空转：只落下几个自举文件。

        这是真实观测到的量级 —— `_setup64.tmp`、`_shfoldr.dll`、
        `_isetup/*` 合计不到 10 个文件、几十 KB。
        """
        run = self._run(files=4, size=60_000, returncode=1)
        verdict = verify_install(run)
        run.verification = verdict

        self.assertFalse(verdict.passed)
        self.assertIn("安装产物过少", verdict.reason)
        self.assertFalse(run.ok)

    def test_file_count_without_bytes_is_not_success(self) -> None:
        """文件数够但全是空文件 —— 也不算装上。

        某些安装器会建一堆空目录与 0 字节占位文件。只看文件数会误判。
        """
        run = self._run(files=50, size=0, returncode=0)
        verdict = verify_install(run)
        self.assertFalse(verdict.passed)

    def test_real_install_passes(self) -> None:
        """正常安装：几百个文件、几十 MB。"""
        run = self._run(files=320, size=45_000_000, returncode=0)
        verdict = verify_install(run)
        run.verification = verdict

        self.assertTrue(verdict.passed)
        self.assertEqual(verdict.files, 320)
        self.assertEqual(verdict.bytes, 45_000_000)
        self.assertTrue(run.ok)

    def test_settled_install_still_needs_files(self) -> None:
        """靠进度判完成（settled）也不能绕过产物校验。"""
        run = self._run(files=0, size=0, settled=True)
        verdict = verify_install(run)
        run.verification = verdict

        self.assertTrue(run.exit_ok, "settled 在退出码层面算成功")
        self.assertFalse(run.ok, "但没装文件就是失败")

    def test_added_counts_never_negative(self) -> None:
        """安装比基线还小（安装器删了东西）时不能算出负数。"""
        run = InstallRun(
            returncode=0,
            baseline_files=100, baseline_bytes=10_000,
            final_files=90, final_bytes=9_000,
        )
        self.assertEqual(run.added_files, 0)
        self.assertEqual(run.added_bytes, 0)

    def test_unverified_run_keeps_legacy_behaviour(self) -> None:
        """没跑过校验的 InstallRun（如 wineboot）保持原有语义。

        不能因为「verification 为 None」就一律判失败 —— wineboot 的
        InstallRun 从不做产物校验，它关心的是退出码。
        """
        run = InstallRun(returncode=0)
        self.assertIsNone(run.verification)
        self.assertTrue(run.ok)

    def test_to_dict_shape(self) -> None:
        """校验结果要能直接进 JSON payload。"""
        verdict = verify_install(self._run(files=200, size=30_000_000))
        payload = verdict.to_dict()
        self.assertEqual(set(payload), {"passed", "reason", "files", "bytes"})
        self.assertIsInstance(payload["passed"], bool)
        self.assertIsInstance(payload["files"], int)


class TestInstallLog(unittest.TestCase):
    def test_append_with_timestamp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "sub" / "install.log"
            write_install_log(log, ["INFO  detect nsis", "INFO  done"])
            write_install_log(log, ["INFO  second"])
            lines = log.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 3)
            for line in lines:
                self.assertRegex(line, r"^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\] ")


class TestRestartSuppression(IsolatedWexe):
    def test_reg_file_is_utf16(self) -> None:
        from wepack.install import suppress_restart

        make_fake_wine(wexe_paths.wine_root())
        make_fake_layer(wexe_paths.layers_root(), "base")
        private = self.tmp / "private"
        create_prefix(private, layers=["base"])

        reg = suppress_restart(private)
        self.assertTrue(reg.is_file())
        self.assertEqual(reg.read_bytes()[:2], b"\xff\xfe")
        self.assertIn("WINE REGISTRY", reg.read_bytes().decode("utf-16-le"))


# --------------------------------------------------------------------------
# 运行时管理
# --------------------------------------------------------------------------


class TestRuntime(IsolatedWexe):
    def test_inspect_not_installed(self) -> None:
        from wepack import runtime

        info = runtime.inspect()
        self.assertFalse(info.installed)
        self.assertTrue(info.problems)

    def test_inspect_detects_arm64_as_bad(self) -> None:
        """arm64 原生 wine 在 Apple Silicon 上不可用，必须报错。"""
        from wepack import runtime

        binary = wexe_paths.wine_root() / "bin" / "wine64"
        binary.parent.mkdir(parents=True, exist_ok=True)
        binary.write_text("#!/bin/sh\necho 'wine-11.21'\n", encoding="utf-8")
        binary.chmod(0o755)

        info = runtime.inspect()
        # 假脚本会被 file 识别为脚本而非 Mach-O，arch 为空 → 报问题
        self.assertTrue(info.installed)
        self.assertTrue(info.problems)

    def test_install_from_archive_missing_binary(self) -> None:
        from wepack import runtime
        from wepack.errors import MissingDependency

        archive = self.tmp / "bad.tar.xz"
        archive.write_bytes(b"not a real archive")
        with self.assertRaises(MissingDependency):
            runtime.install_from_archive(archive)


class TestAppNameDerivation(unittest.TestCase):
    """应用名推断：安装包文件名必须清洗，不能原样当产品名。"""

    def test_strips_arch_and_version_noise(self) -> None:
        from wepack.cli import _clean_installer_stem

        self.assertEqual(
            _clean_installer_stem("Ondra-1.1.7-alpha-windows-x64-setup"), "Ondra")
        self.assertEqual(_clean_installer_stem("npp.8.6.9.Installer.x64"), "npp")
        self.assertEqual(_clean_installer_stem("7z2408-x64"), "7z2408")

    def test_keeps_real_product_name(self) -> None:
        from wepack.cli import _clean_installer_stem

        self.assertEqual(_clean_installer_stem("Notepad++"), "Notepad++")
        self.assertEqual(_clean_installer_stem("WeChatSetup"), "WeChatSetup")

    def test_short_prefix_merges_non_numeric(self) -> None:
        """第一段很短且第二段不是数字时合并，如 MS Office。"""
        from wepack.cli import _clean_installer_stem

        self.assertEqual(_clean_installer_stem("MS-Office-setup"), "MS Office")

    def test_explicit_name_wins(self) -> None:
        from wepack.cli import _derive_app_name
        from wepack.models import Detection, InstallerKind

        detection = Detection(path=Path("/x.exe"), kind=InstallerKind.NSIS,
                              confidence=0.9, product_name="FromResource")
        self.assertEqual(
            _derive_app_name("Explicit", detection, Path("/a/setup-x64.exe")),
            "Explicit")

    def test_product_name_beats_filename(self) -> None:
        from wepack.cli import _derive_app_name
        from wepack.models import Detection, InstallerKind

        detection = Detection(path=Path("/x.exe"), kind=InstallerKind.NSIS,
                              confidence=0.9, product_name="RealProduct")
        self.assertEqual(
            _derive_app_name(None, detection, Path("/a/Ondra-1.1.7-x64-setup.exe")),
            "RealProduct")


class TestEntryDiscovery(IsolatedWexe):
    """入口发现：必须能找到 AppData/Local 下的应用，且排除运行时组件。"""

    def _make_prefix(self) -> Path:
        private = self.tmp / "private"
        (private / "drive_c" / "windows" / "system32").mkdir(parents=True)
        (private / "drive_c" / "windows" / "system32" / "a.dll").write_bytes(b"MZ")
        (private / "dosdevices").mkdir()
        os.symlink("../drive_c", private / "dosdevices" / "c:")
        for reg in ("system.reg", "user.reg", "userdef.reg"):
            (private / reg).write_bytes(b"\xff\xfe" + "WINE REGISTRY Version 2\n".encode("utf-16-le"))
        return private

    def _write_pe(self, path: Path, *, gui: bool = True) -> None:
        """写一个能被 pe.parse 读通的最小 PE。"""
        from tests.test_phase1 import build_min_pe

        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(build_min_pe(subsystem=2 if gui else 3))

    def test_finds_app_in_wacmin_default_dir(self) -> None:
        """默认安装目录（C:\\Wacmin\\<App>）必须能被扫到。

        这条跟着 `default_install_dir` 的改动一起加。默认目录从
        `Program Files` 改成 `Wacmin` 之后，若扫描逻辑没跟上，会出现
        「装成功了但找不到入口」这种自相矛盾的结果 —— 安装器返回 0、
        产物校验也通过（文件确实落进去了），却在最后一步报「无法确定
        入口程序」。这类 bug 比装不上更让人困惑，因为每一步看起来都对。
        """
        from wepack.cli import _find_installed_entry
        from wepack.models import Detection, InstallerKind

        private = self._make_prefix()
        app_dir = private / "drive_c" / "Wacmin" / "MyApp"
        self._write_pe(app_dir / "myapp.exe")

        detection = Detection(path=Path("/x.exe"), kind=InstallerKind.NSIS,
                              confidence=0.9, product_name="MyApp")
        entry = _find_installed_entry(private, detection, "MyApp")
        self.assertIsNotNone(entry, "默认目录 C:\\Wacmin 下的入口没被扫到")
        self.assertIn("Wacmin/MyApp/myapp.exe", entry)
        self.assertTrue((private / entry).is_file())

    def test_wacmin_dir_has_priority_over_program_files(self) -> None:
        """C:\\Wacmin 优先于 Program Files —— 那才是本工具自己写的位置。

        Program Files 里可能残留 base 层自带的系统组件（或上一次别的
        安装留下的东西）。既然默认装到 Wacmin，就应该先认那里。
        """
        from wepack.cli import _find_installed_entry
        from wepack.models import Detection, InstallerKind

        private = self._make_prefix()
        # Program Files 下放一个同名的
        self._write_pe(private / "drive_c" / "Program Files" / "MyApp" / "myapp.exe")
        # Wacmin 下也放一个
        self._write_pe(private / "drive_c" / "Wacmin" / "MyApp" / "myapp.exe")

        detection = Detection(path=Path("/x.exe"), kind=InstallerKind.NSIS,
                              confidence=0.9, product_name="MyApp")
        entry = _find_installed_entry(private, detection, "MyApp")
        self.assertIsNotNone(entry)
        self.assertIn("Wacmin", entry,
                      f"应优先命中 C:\\Wacmin，实际 {entry}")

    def test_finds_app_in_appdata_local(self) -> None:
        """Electron/Squirrel 安装器会忽略 /D=，装到 AppData/Local。"""
        from wepack.cli import _find_installed_entry
        from wepack.models import Detection, InstallerKind

        private = self._make_prefix()
        app_dir = private / "drive_c" / "users" / "u" / "AppData" / "Local" / "MyApp"
        self._write_pe(app_dir / "myapp.exe")

        detection = Detection(path=Path("/x.exe"), kind=InstallerKind.NSIS,
                              confidence=0.9, product_name="MyApp")
        entry = _find_installed_entry(private, detection, "MyApp")
        self.assertIsNotNone(entry)
        self.assertIn("AppData/Local/MyApp/myapp.exe", entry)
        self.assertTrue((private / entry).is_file())

    def test_excludes_webview2_and_edge(self) -> None:
        """WebView2 的 msedge.exe 不能被当成主程序。"""
        from wepack.cli import _find_installed_entry
        from wepack.models import Detection, InstallerKind

        private = self._make_prefix()
        edge = (private / "drive_c" / "Program Files (x86)" / "Microsoft"
                / "EdgeCore" / "157.0" / "msedge.exe")
        self._write_pe(edge)

        detection = Detection(path=Path("/x.exe"), kind=InstallerKind.NSIS,
                              confidence=0.9)
        entry = _find_installed_entry(private, detection, "SomethingElse")
        # 要么找不到，要么不是 msedge
        if entry is not None:
            self.assertNotIn("msedge", entry.lower())
            self.assertNotIn("edgecore", entry.lower())

    def test_returns_none_when_nothing_found(self) -> None:
        from wepack.cli import _find_installed_entry
        from wepack.models import Detection, InstallerKind

        private = self._make_prefix()
        detection = Detection(path=Path("/x.exe"), kind=InstallerKind.NSIS,
                              confidence=0.9)
        self.assertIsNone(_find_installed_entry(private, detection, "NoSuchApp"))


class TestRuntimeComponentsExcluded(unittest.TestCase):
    """候选打分必须整体排除运行时组件，不是简单扣分。"""

    def test_webview2_returns_none(self) -> None:
        from wepack.extract.candidates import ScoreContext, score_exe
        from tests.test_phase1 import build_min_pe

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("msedge.exe", "msedgewebview2.exe"):
                path = root / name
                path.write_bytes(build_min_pe(subsystem=2))
                ctx = ScoreContext(root=root, product_name="App",
                                   product_words=("app",))
                self.assertIsNone(score_exe(path, name, ctx),
                                  f"{name} 应被排除")

    def test_edgecore_path_excluded(self) -> None:
        from wepack.extract.candidates import ScoreContext, score_exe
        from tests.test_phase1 import build_min_pe

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "EdgeCore" / "app.exe"
            path.parent.mkdir()
            path.write_bytes(build_min_pe(subsystem=2))
            ctx = ScoreContext(root=root, product_name="App", product_words=("app",))
            self.assertIsNone(score_exe(path, "EdgeCore/app.exe", ctx))


class TestSettleOnStable(IsolatedWexe):
    """安装器装完不退出时，应靠文件停止增长判定完成，而不是等超时。"""

    def test_settles_when_files_stop_growing(self) -> None:
        from wepack.install import run_install

        # 假 wine：写一个文件后长时间挂住（模拟装完拉起应用）
        make_fake_wine(wexe_paths.wine_root(), sleep=300)
        make_fake_layer(wexe_paths.layers_root(), "base")
        private = self.tmp / "private"
        create_prefix(private, layers=["base"])
        installer = self.tmp / "setup.exe"
        installer.write_bytes(b"MZ")

        # 预先放个文件，让"文件数不变"能被判定
        (private / "drive_c" / "marker.txt").write_text("x", encoding="utf-8")

        detection = Detection(path=installer, kind=InstallerKind.NSIS, confidence=0.9)
        run = run_install(private, installer, detection, timeout=120,
                          settle_on_stable=True)

        # 应在远小于 120 秒内判定完成
        self.assertTrue(run.settled_by_progress)
        # 只断言 exit_ok：本测试验证的是「装完不退出也能收尾」，
        # 假 wine 没有真装文件，run.ok 会因产物校验为 False（另有测试覆盖）
        self.assertTrue(run.exit_ok)
        self.assertFalse(run.timed_out)
        self.assertLess(run.duration, 90)

    def test_timeout_still_works_when_disabled(self) -> None:
        from wepack.install import run_install

        make_fake_wine(wexe_paths.wine_root(), sleep=300)
        make_fake_layer(wexe_paths.layers_root(), "base")
        private = self.tmp / "private"
        create_prefix(private, layers=["base"])
        installer = self.tmp / "setup.exe"
        installer.write_bytes(b"MZ")

        detection = Detection(path=installer, kind=InstallerKind.NSIS, confidence=0.9)
        run = run_install(private, installer, detection, timeout=3,
                          settle_on_stable=False)
        self.assertTrue(run.timed_out)
        self.assertFalse(run.ok)


# --------------------------------------------------------------------------
# CLI 集成
# --------------------------------------------------------------------------


class TestCliPhase2(IsolatedWexe):
    def _run(self, *args: str) -> subprocess.CompletedProcess:
        env = dict(os.environ)
        env["PYTHONPATH"] = str(REPO)
        return subprocess.run([sys.executable, "-m", "wepack", *args],
                              cwd=str(REPO), capture_output=True, text=True, env=env)

    def test_layers_list_json(self) -> None:
        result = self._run("layers", "list", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        names = {layer["name"] for layer in payload["layers"]}
        for expected in ("base", "vcpp", "dotnet", "fonts-cn"):
            self.assertIn(expected, names)

    def test_layers_verify_all_missing(self) -> None:
        result = self._run("layers", "verify", "--json")
        payload = json.loads(result.stdout)
        # 一个层都没装时，results 为空，ok=True（没有已安装的层可校验）
        self.assertIn("results", payload)

    def test_runtime_status_not_installed(self) -> None:
        result = self._run("runtime", "status", "--json")
        self.assertEqual(result.returncode, 5, result.stderr)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["installed"])
        self.assertTrue(payload["problems"])

    def test_install_without_wine_fails_clearly(self) -> None:
        installer = self.tmp / "setup.exe"
        installer.write_bytes(b"MZ" + b"\0" * 100)
        result = self._run("install", str(installer),
                           "-o", str(self.tmp / "X (Win).app"), "--json")
        # 缺 wine 应该是退出码 5，并给出明确提示
        self.assertEqual(result.returncode, 5, result.stderr)
        payload = json.loads(result.stdout)
        self.assertIn("wine", payload["error"].lower())

    def test_install_refuses_existing_app(self) -> None:
        make_fake_wine(wexe_paths.wine_root())
        make_fake_layer(wexe_paths.layers_root(), "base")
        installer = self.tmp / "setup.exe"
        installer.write_bytes(b"MZ")
        app = self.tmp / "X (Win).app"
        app.mkdir()

        result = self._run("install", str(installer), "-o", str(app), "--json")
        payload = json.loads(result.stdout)
        self.assertEqual(result.returncode, 2)
        self.assertIn("已存在", payload["error"])

    def test_install_that_writes_nothing_fails(self) -> None:
        """安装器退出码 0 但没装任何文件 —— 必须报退出码 6，不能报成功。

        这是空转检测的端到端验证。修复前这里返回 0，payload 里 ok=true、
        entry=null，调用方拿到「成功但没入口」无从判断；到 build 的打包
        阶段才抛 UsageError（退出码 2），把安装失败误报成参数错误。
        """
        make_fake_wine(wexe_paths.wine_root(), exit_code=0)
        make_fake_layer(wexe_paths.layers_root(), "base")
        installer = self.tmp / "setup.exe"
        installer.write_bytes(make_nsis_installer())

        result = self._run("install", str(installer),
                           "-o", str(self.tmp / "Empty (Win).app"), "--json")
        self.assertEqual(result.returncode, 6, result.stderr)

        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertFalse(payload["verify"]["passed"])
        self.assertEqual(payload["verify"]["files"], 0)
        self.assertIn("未向 prefix 写入任何文件", payload["verify"]["reason"])
        # 退出码是事实，不该被我们改写
        self.assertEqual(payload["returncode"], 0)

    def test_install_finding_nothing_reports_missing_entry(self) -> None:
        """装了文件但找不到入口时，payload 要给出明确原因。

        与空转区分开：这里文件落下了，只是没有可执行入口。
        """
        make_fake_wine(wexe_paths.wine_root(), exit_code=0)
        make_fake_layer(wexe_paths.layers_root(), "base")
        installer = self.tmp / "setup.exe"
        installer.write_bytes(make_nsis_installer())

        # 让假 wine 往 prefix 里写足够多的数据文件，但不写 .exe
        #
        # **必须按调用次数递增文件名**：install 会先跑一次 wineboot_init，
        # 用的是同一个假 wine。若每次写同名文件，第二次调用写完还是那 10 个，
        # 相对基线（wineboot 之后）的净增量是 0，产物校验会判空转。
        script = wexe_paths.wine_root() / "bin" / "wine64"
        drive_c = self.tmp / "Empty (Win).app" / "Contents" / "Resources" / "Private" / "drive_c"
        counter = wexe_paths.wine_root() / "invocations"
        script.write_text(
            "#!/bin/sh\n"
            f'printf "x" >> "{counter}"\n'
            f'n=$(wc -c < "{counter}" | tr -d " ")\n'
            f'mkdir -p "{drive_c}/Program Files/Payload"\n'
            'i=0\n'
            "while [ $i -lt 12 ]; do\n"
            f'  dd if=/dev/zero of="{drive_c}/Program Files/Payload/d${{n}}_${{i}}.dat" '
            "bs=200000 count=1 2>/dev/null\n"
            "  i=$((i+1))\n"
            "done\n"
            "exit 0\n",
            encoding="utf-8",
        )
        script.chmod(0o755)

        result = self._run("install", str(installer),
                           "-o", str(self.tmp / "Empty (Win).app"), "--json")
        self.assertEqual(result.returncode, 6, result.stderr)

        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertTrue(payload["verify"]["passed"], "文件确实装上了")
        self.assertIsNone(payload["entry"])
        self.assertIn("未找到可执行入口", payload["error"])


# --------------------------------------------------------------------------
# 真实 wine 集成（需 WEXE_REAL_WINE=1）
# --------------------------------------------------------------------------


@unittest.skipUnless(REAL_WINE, "需要 WEXE_REAL_WINE=1")
class TestRealWine(unittest.TestCase):
    """真实 wine 测试不能隔离 WEXE_HOME —— wine 装在真实 wexe 目录下。

    这两个测试只读真实运行时，不写 layers，所以不需要隔离。
    """

    def test_wine_binary_found(self) -> None:
        from wepack.install import wine_binary

        binary = wine_binary()
        self.assertTrue(binary.is_file())

    def test_wineboot_creates_prefix(self) -> None:
        from wepack.install import wineboot_init
        from wepack.prefix import validate_prefix

        with tempfile.TemporaryDirectory(prefix="exeonmac-real-") as tmp:
            private = Path(tmp) / "private"
            private.mkdir()
            result = wineboot_init(private, timeout=300)
            self.assertTrue(result.ok, result.stderr_tail)
            self.assertTrue((private / "drive_c" / "windows" / "system32").is_dir())
            self.assertEqual(validate_prefix(private), [])


@unittest.skipUnless(REAL_WINE and SAMPLE_NSIS and Path(SAMPLE_NSIS).is_file(),
                     "需要 WEXE_REAL_WINE=1 与 WEXE_SAMPLE_NSIS")
class TestRealInstall(unittest.TestCase):
    """端到端安装测试。用真实 base 层，但 prefix 建在临时目录。

    不改真实 layers（base 层已由 layers build 建好），只在临时目录
    建 prefix 与安装，测试结束自动清理。
    """

    def test_install_nsis(self) -> None:
        """端到端：clonefile base → wineboot → 静默安装 → 找到主 exe。"""
        from wepack.detect import detect_installer
        from wepack.install import default_install_dir, run_install, wineboot_init
        from wepack.layers import inspect_layer
        from wepack.prefix import create_prefix

        base = inspect_layer("base")
        if not base.ok:
            self.skipTest(f"base 层未就绪：{base.problems}")

        with tempfile.TemporaryDirectory(prefix="exeonmac-e2e-") as tmp:
            private = Path(tmp) / "private"
            create_prefix(private, layers=["base"])
            wineboot_init(private, timeout=300)

            installer = Path(SAMPLE_NSIS)
            detection = detect_installer(installer)
            run = run_install(private, installer, detection, timeout=900,
                              install_dir=default_install_dir("Ondra"))
            self.assertTrue(run.ok, run.stderr_tail[-800:])

            # 安装产物应落在 Program Files 下
            program_files = private / "drive_c" / "Program Files"
            self.assertTrue(program_files.is_dir())
            self.assertTrue(any(program_files.rglob("*.exe")),
                            "Program Files 下没有 exe")

            # system.reg 应有内容
            self.assertGreater((private / "system.reg").stat().st_size, 1024)


if __name__ == "__main__":
    unittest.main(verbosity=2)