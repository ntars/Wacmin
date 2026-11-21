"""阶段 1 验收测试：安装器识别 + 静态解包。

跑法：
    cd ExeOnMac && python3 -m unittest tests.test_phase1 -v

## 样本从哪来

早先这里依赖环境变量指向开发者手工下载的样本，没设就整类跳过：

    WEXE_SAMPLE_NSIS=/path/to/setup.exe
    WEXE_SAMPLE_INNO=/path/to/inno.exe
    WEXE_SAMPLE_MSI=/path/to/app.msi

**跳过在测试报告里是绿的**，于是 21 项检测/解包测试从来没在 CI 上跑过。
现在改为现场构造（`fixtures.py`）：MSI 用纯 Python 拼、NSIS 用 makensis
编译、Inno 合成标记。环境变量仍然优先 —— 想用真实样本对照时可以指过去。

    WEXE_7Z=/path/to/7zz        指定 7z 二进制
"""

from __future__ import annotations

import os
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
sys.path.insert(0, str(Path(__file__).resolve().parent))

from wepack import pe  # noqa: E402
from wepack.detect import cfb, detect_installer  # noqa: E402
from wepack.detect import msi_tables  # noqa: E402
from wepack.extract.candidates import _normalize, rank_candidates  # noqa: E402
from wepack.models import InstallerKind  # noqa: E402

import fixtures  # noqa: E402

#: 环境变量优先（想用真实样本对照时指过去），否则用现场构造的夹具。
#:
#: `real_inno()` 与 `sample_inno()` 分开：前者是真编译产物（有载荷，能解包），
#: 后者是最小骨架（只有标记，够测检测）。混用会让「检测」类测试
#: 无谓地背上「编译 + wine」的成本。
#:
#: ## 为什么这四个都改成了惰性函数，而不是模块级常量
#:
#: 早先它们是在**导入时**求值的常量，其中 `fixtures.demo_inno_real()` 会经
#: `wine_binary()` 读 `WEXE_HOME`。而 `test_phase2` 的用例把 `WEXE_HOME`
#: 指到临时目录、塞一个只 `exit 0` 的假 wine，只为借本模块的 `build_min_pe`
#: 就会 `import tests.test_phase1` —— 于是 ISCC 在假 wine 下空编、退出码 0、
#: 产物不存在，抛出 `RuntimeError: ISCC 编译失败（退出码 0）：`（detail 为空，
#: 因为假 wine 什么也没说）。整类消失、剩下的用例变成 error。
#:
#: **导入一个测试模块不应该有外部副作用**。夹具在「用例真的要跑」时才构造。
_SAMPLE_CACHE: dict[str, str] = {}


def sample_nsis() -> str:
    if "nsis" not in _SAMPLE_CACHE:
        _SAMPLE_CACHE["nsis"] = (
            os.environ.get("WEXE_SAMPLE_NSIS") or str(fixtures.demo_nsis() or ""))
    return _SAMPLE_CACHE["nsis"]


def sample_inno() -> str:
    """合成骨架：只有标记，够测检测与版本读取，零依赖。"""
    if "inno" not in _SAMPLE_CACHE:
        _SAMPLE_CACHE["inno"] = (
            os.environ.get("WEXE_SAMPLE_INNO") or str(fixtures.demo_inno()))
    return _SAMPLE_CACHE["inno"]


def sample_msi() -> str:
    if "msi" not in _SAMPLE_CACHE:
        _SAMPLE_CACHE["msi"] = (
            os.environ.get("WEXE_SAMPLE_MSI") or str(fixtures.demo_msi()))
    return _SAMPLE_CACHE["msi"]


def real_inno() -> str:
    """真编译产物：ISCC + wine 现场编译，约 13 秒。**只在用例要跑时才调**。"""
    if "real-inno" not in _SAMPLE_CACHE:
        _SAMPLE_CACHE["real-inno"] = (
            os.environ.get("WEXE_SAMPLE_INNO") or str(fixtures.demo_inno_real() or ""))
    return _SAMPLE_CACHE["real-inno"]


def require_sample(getter, reason: str) -> Path:
    """在 `setUpClass` 里取夹具：拿不到就如实跳过，拿到就返回路径。

    替代原先的 `@unittest.skipUnless(常量 and ...)`：装饰器在**导入时**求值，
    正是上面那段踩坑的入口。
    """
    value = getter()
    if not value or not Path(value).is_file():
        raise unittest.SkipTest(reason)
    return Path(value)


# --------------------------------------------------------------------------
# 导入期副作用守卫（见上面那段说明的踩坑）
# --------------------------------------------------------------------------


class TestImportHasNoSideEffects(unittest.TestCase):
    """导入一个测试模块不许碰环境、不许调外部工具。

    ## 为什么要专门守这件事

    `test_phase2` 里有几处 `from tests.test_phase1 import build_min_pe`。
    早先 `test_phase1` 把夹具求值写在模块级，于是「借一个纯函数」的代价
    变成「跑一次 ISCC 编译」；而当 `test_phase2` 的用例已把 `WEXE_HOME`
    指到临时目录（那里有只 `exit 0` 的假 wine），编译静默失败，抛出的
    `RuntimeError` 让 `test_phase2` 的两条用例变 error。**整类消失是不会
    被 `check_no_skips.py` 抓到的** —— 它只看 `Ran N tests` 与 skipped。

    所以守两层：① 子进程里导入模块，不许有 stderr 输出、不许非零退出；
    ② 静态断言模块顶层不再出现夹具调用（防有人又写回常量）。
    """

    def test_importing_module_runs_no_external_tool(self) -> None:
        """导入时不许调任何外部工具。

        ## 判据怎么造才抓得住

        第一版只断言「导入不报错」，负向验证时把常量写回模块顶层**仍然是
        绿的** —— 因为空 `WEXE_HOME` 下 `demo_inno_real()` 只是返回 `None`，
        不抛异常。判据太软了。

        现在改成埋哨兵：造一个「被调用就在文件里留痕」的假 wine，并把
        `WEXE_ISCC` 指向一个存在的文件（`find_iscc()` 因此会返回它），
        于是**只要模块级求值了夹具，就一定会执行这个假 wine**。导入后
        检查哨兵文件在不在 —— 在，就是导入带了副作用。
        """
        with tempfile.TemporaryDirectory(prefix="exeonmac-import-") as tmp:
            root = Path(tmp)
            sentinel = root / "wine-was-called"
            wine = root / "wexe" / "runtime" / "wine" / "bin" / "wine64"
            wine.parent.mkdir(parents=True)
            wine.write_text(f'#!/bin/sh\n: > "{sentinel}"\nexit 0\n', encoding="utf-8")
            wine.chmod(0o755)
            # find_iscc() 只判 is_file()，不执行 —— 给个占位文件就够
            iscc = root / "ISCC.exe"
            iscc.write_bytes(b"stub")

            env = dict(os.environ)
            env["WEXE_HOME"] = str(root / "wexe")
            env["WEXE_ISCC"] = str(iscc)
            env.pop("WEXE_SAMPLE_INNO", None)
            env["PYTHONPATH"] = str(REPO) + os.pathsep + str(REPO / "tests")
            r = subprocess.run(
                [sys.executable, "-c",
                 "import tests.test_phase1 as m; print('ok', bool(m.sample_inno()))"],
                cwd=str(REPO), capture_output=True, text=True, env=env, timeout=120)
            self.assertEqual(r.returncode, 0,
                             f"导入就失败了：stderr={r.stderr[-800:]}")
            # 合成骨架零依赖，任何环境都造得出来；造不出说明它偷偷要了外部工具
            self.assertIn("ok True", r.stdout,
                          f"零依赖的合成夹具没造出来：{r.stdout!r}")
            self.assertFalse(
                sentinel.exists(),
                "导入 test_phase1 时执行了 wine —— 模块顶层又在求值夹具了。"
                "这会让 test_phase2 在假 wine 环境下导入它时整类崩掉。")

    def test_no_fixture_call_at_module_level(self) -> None:
        """静态守卫：`fixtures.demo_*` 不许出现在模块顶层。

        判据用 `ast`：只扫**模块体直接语句**里对 `fixtures.demo_*` 的调用，
        函数体里的不算（`sample_*()` 内部当然要调）。
        """
        import ast

        def walk_import_time(node):
            """遍历「导入时就会执行」的节点：跳过函数体，类体照走。

            类体在 import 时执行，函数体不执行 —— 分界线就在这里，
            所以只能手写遍历，不能直接 `ast.walk`。
            """
            for child in ast.iter_child_nodes(node):
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef,
                                      ast.Lambda)):
                    continue
                yield child
                yield from walk_import_time(child)

        tree = ast.parse((REPO / "tests" / "test_phase1.py").read_text("utf-8"))
        offenders: list[str] = []
        for sub in walk_import_time(tree):
            if (isinstance(sub, ast.Call)
                    and isinstance(sub.func, ast.Attribute)
                    and isinstance(sub.func.value, ast.Name)
                    and sub.func.value.id == "fixtures"
                    and sub.func.attr.startswith("demo_")):
                offenders.append(f"第 {sub.lineno} 行：fixtures.{sub.func.attr}()")
        self.assertEqual(offenders, [],
                         "模块顶层又在求值夹具了 —— 导入会带上外部副作用，"
                         "而 test_phase2 借本模块的函数时会踩到假 wine：\n"
                         + "\n".join(offenders))


def have_7z() -> bool:
    return fixtures.find_7z() is not None


def have_innoextract() -> bool:
    from wepack import tools
    return tools.find_tool("innoextract", required=False) is not None


def innoextract_max_inno_version() -> tuple[int, ...] | None:
    """读出本机 innoextract 支持的最高 Inno 版本。

    `innoextract --version` 会打出
    "Extracts installers created by Inno Setup 1.2.10 to 6.0.5"，
    取最后那个版本号。读不到返回 None。
    """
    import re

    from wepack import tools

    tool = tools.find_tool("innoextract", required=False)
    if tool is None:
        return None
    result = tool.run(["--version"], timeout=60)
    text = (getattr(result, "stdout", "") or "") + (result.stderr or "")
    match = re.search(r"to\s+(\d+(?:\.\d+)+)", text)
    if not match:
        return None
    return tuple(int(part) for part in match.group(1).split("."))


def installer_inno_version(path: Path) -> tuple[int, ...] | None:
    """读出安装包所需的 Inno 版本。"""
    from wepack.extract import _inno_payload_version

    raw = _inno_payload_version(path)
    if not raw:
        return None
    parts = []
    for chunk in raw.split("."):
        digits = "".join(ch for ch in chunk if ch.isdigit())
        if not digits:
            break
        parts.append(int(digits))
    return tuple(parts) or None


# --------------------------------------------------------------------------
# 合成 PE / CFB 构造器（不依赖外部样本）
# --------------------------------------------------------------------------


def build_min_pe(*, machine: int = 0x8664, subsystem: int = 2,
                 overlay: bytes = b"", sections: tuple[str, ...] = (".text",)) -> bytes:
    """构造一个结构合法、能被 pe.parse 读通的最小 PE。

    只填解析器实际读取的字段，其余补 0。用于在无外部样本时验证
    PE 解析与安装器识别的判定逻辑。
    """
    e_lfanew = 0x40
    num_sections = len(sections)
    opt_size = 240 if machine == 0x8664 else 224
    header_size = e_lfanew + 24 + opt_size + num_sections * 40
    raw_ptr = (header_size + 0x1FF) & ~0x1FF

    dos = bytearray(e_lfanew)
    dos[0:2] = b"MZ"
    struct.pack_into("<I", dos, 0x3C, e_lfanew)

    coff = bytearray(20)
    struct.pack_into("<H", coff, 0, machine)
    struct.pack_into("<H", coff, 2, num_sections)
    struct.pack_into("<H", coff, 16, opt_size)

    opt = bytearray(opt_size)
    if machine == 0x8664:
        struct.pack_into("<H", opt, 0, 0x20B)
        struct.pack_into("<Q", opt, 24, 0x140000000)
        struct.pack_into("<I", opt, 56, 0x4000)
    else:
        struct.pack_into("<H", opt, 0, 0x10B)
        struct.pack_into("<I", opt, 28, 0x400000)
        struct.pack_into("<I", opt, 56, 0x4000)
    struct.pack_into("<H", opt, 68, subsystem)

    sec_table = bytearray()
    raw_cursor = raw_ptr
    section_data = bytearray()
    for index, name in enumerate(sections):
        entry = bytearray(40)
        encoded = name.encode("latin-1")[:8]
        entry[0:len(encoded)] = encoded
        payload = b"\x90" * 0x200
        struct.pack_into("<I", entry, 8, len(payload))       # VirtualSize
        struct.pack_into("<I", entry, 12, 0x1000 * (index + 1))  # VirtualAddress
        struct.pack_into("<I", entry, 16, len(payload))      # SizeOfRawData
        struct.pack_into("<I", entry, 20, raw_cursor)        # PointerToRawData
        struct.pack_into("<I", entry, 36, 0x60000020)        # code|execute|read
        sec_table += entry
        section_data += payload
        raw_cursor += len(payload)

    body = bytes(dos) + b"PE\0\0" + bytes(coff) + bytes(opt) + bytes(sec_table)
    body = body.ljust(raw_ptr, b"\0")
    return body + bytes(section_data) + overlay


def build_nsis_overlay() -> bytes:
    """构造 NSIS firstheader：flags + DEADBEEF + NullsoftInst + 长度。"""
    head = bytearray(28)
    struct.pack_into("<I", head, 4, 0xDEADBEEF)
    head[8:20] = b"NullsoftInst"
    struct.pack_into("<I", head, 20, 28)
    return bytes(head) + b"\0" * 64


# --------------------------------------------------------------------------
# PE 解析
# --------------------------------------------------------------------------


class TestPeParser(unittest.TestCase):
    def test_parse_minimal_pe64(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.exe"
            path.write_bytes(build_min_pe(machine=0x8664, subsystem=2))
            info = pe.parse(path)
            self.assertEqual(info.arch, "x86_64")
            self.assertTrue(info.is_gui)
            self.assertFalse(info.is_dotnet)
            self.assertGreater(info.overlay_offset, 0)

    def test_parse_minimal_pe32(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.exe"
            path.write_bytes(build_min_pe(machine=0x14C, subsystem=3))
            info = pe.parse(path)
            self.assertEqual(info.arch, "x86")
            self.assertFalse(info.is_gui)

    def test_reject_non_pe(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.bin"
            path.write_bytes(b"not a pe file at all")
            with self.assertRaises(pe.PeError):
                pe.parse(path)

    def test_reject_truncated(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.exe"
            path.write_bytes(b"MZ" + b"\0" * 20)
            with self.assertRaises(pe.PeError):
                pe.parse(path)

    def test_overlay_detected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.exe"
            path.write_bytes(build_min_pe(overlay=b"X" * 500))
            info = pe.parse(path)
            self.assertEqual(info.overlay_size, 500)

    def test_section_lookup(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.exe"
            path.write_bytes(build_min_pe(sections=(".text", ".ndata")))
            info = pe.parse(path)
            self.assertIsNotNone(pe.section_named(info, ".ndata"))
            self.assertIsNone(pe.section_named(info, ".missing"))


# --------------------------------------------------------------------------
# 安装器识别
# --------------------------------------------------------------------------


class TestDetectSynthetic(unittest.TestCase):
    def test_detect_nsis_by_overlay(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "setup.exe"
            path.write_bytes(build_min_pe(machine=0x14C, overlay=build_nsis_overlay(),
                                          sections=(".text", ".ndata")))
            detection = detect_installer(path)
            self.assertEqual(detection.kind, InstallerKind.NSIS)
            self.assertGreaterEqual(detection.confidence, 0.8)
            self.assertTrue(detection.supported)
            self.assertTrue(any("DEADBEEF" in e for e in detection.evidence))

    def test_detect_inno_by_marker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "setup.exe"
            payload = b"Inno Setup Setup Data (6.7.0)" + b"\0" * 64
            path.write_bytes(build_min_pe(machine=0x14C, overlay=payload))
            detection = detect_installer(path)
            self.assertEqual(detection.kind, InstallerKind.INNO)
            self.assertIn("6.7.0", " ".join(detection.evidence))

    def test_detect_unknown(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "setup.exe"
            path.write_bytes(build_min_pe())
            detection = detect_installer(path)
            self.assertEqual(detection.kind, InstallerKind.UNKNOWN)
            self.assertFalse(detection.supported)
            self.assertIsNotNone(detection.unsupported_reason)

    def test_plain_pe_is_not_inno(self) -> None:
        """普通 PE（只有节区、无 Inno 标记）不得被判成 Inno。

        实测背景：SumatraPDF 3.5.2 这类 NSIS/Inno 都不是的自解压包，
        检出 unknown（置信度 0.00）才是正确行为。误报比漏报更糟 ——
        会把包交给 innoextract 死磕，用户等不到结果。
        """
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "portable.exe"
            path.write_bytes(build_min_pe(
                machine=0x14C, overlay=b"Some unrelated overlay data" + b"\0" * 32,
                sections=(".text", ".rdata", ".data")))
            detection = detect_installer(path)
            self.assertNotEqual(detection.kind, InstallerKind.INNO)

    def test_inno_marker_without_version_still_detected(self) -> None:
        """载荷头没有版本号括号时也要能认，版本字段留空即可。"""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "setup.exe"
            payload = b"Inno Setup Setup Data" + b"\0" * 64
            path.write_bytes(build_min_pe(machine=0x14C, overlay=payload))
            detection = detect_installer(path)
            self.assertEqual(detection.kind, InstallerKind.INNO)

    def test_inno_silent_args_are_setup_flags(self) -> None:
        """Inno 的静默参数必须是 Inno 自己的旗标，不能套 NSIS 的 /S。

        套错参数的结果是静默安装变成交互安装，自动化流程直接卡死等窗口。
        """
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "setup.exe"
            payload = b"Inno Setup Setup Data (6.7.0)" + b"\0" * 64
            path.write_bytes(build_min_pe(machine=0x14C, overlay=payload))
            detection = detect_installer(path)
            args = detection.silent_args or ""
            self.assertIn("/VERYSILENT", args)
            self.assertIn("/SUPPRESSMSGBOXES", args)
            self.assertIn("/NORESTART", args)
            self.assertNotEqual(args.strip(), "/S", "不能套用 NSIS 的 /S")

    def test_detect_missing_file(self) -> None:
        from wepack.errors import UsageError
        with self.assertRaises(UsageError):
            detect_installer(Path("/tmp/definitely-not-here-12345.exe"))

    def test_blocked_anticheat(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "setup.exe"
            path.write_bytes(build_min_pe(overlay=b"EasyAntiCheat" + b"\0" * 64))
            detection = detect_installer(path)
            self.assertFalse(detection.supported)
            self.assertIn("反作弊", detection.unsupported_reason or "")

    def test_blocked_driver_requires_path_and_suffix(self) -> None:
        """只有 .sys 字样不拦；路径 + .sys 同时出现才拦。"""
        with tempfile.TemporaryDirectory() as tmp:
            benign = Path(tmp) / "a.exe"
            benign.write_bytes(build_min_pe(overlay=b"optional .sys component" + b"\0" * 64))
            reason = detect_installer(benign).unsupported_reason or ""
            self.assertNotIn("内核驱动", reason)

            driver = Path(tmp) / "b.exe"
            driver.write_bytes(build_min_pe(
                overlay=b"\\system32\\drivers\\evil.sys" + b"\0" * 64))
            self.assertIn("内核驱动", detect_installer(driver).unsupported_reason or "")

    def test_silent_args_filled(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "setup.exe"
            path.write_bytes(build_min_pe(machine=0x14C, overlay=build_nsis_overlay()))
            self.assertEqual(detect_installer(path).silent_args, "/S")


# --------------------------------------------------------------------------
# CFB / MSI
# --------------------------------------------------------------------------


class TestCfb(unittest.TestCase):
    def test_reject_non_cfb(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "x.msi"
            path.write_bytes(b"not ole at all")
            self.assertFalse(cfb.is_cfb(path))
            with self.assertRaises(cfb.CfbError):
                cfb.open_cfb(path)

    def test_summary_information_missing_stream(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "x.msi"
            path.write_bytes(cfb.MAGIC + b"\0" * 600)
            # 结构不完整时应返回空字典而不是抛异常
            self.assertEqual(cfb.summary_information(path), {})


class TestCfbTruncation(unittest.TestCase):
    """截断的文件必须被认成「不完整」，而不是「结构非法」。

    ## 为什么单独立一类

    这不是「多加一条断言」，而是锁住一个已经骗过人的错误。实测把一个
    109 MB 的真实 MSI 下到 13 MB（下载被代理 502 掐断），`detect` 报：

        CFB 解析降级：非法扇区号：0xfffffffd

    `0xfffffffd` 是 FATSECT —— [MS-CFB] 里**完全合法**的标记，表示
    「此扇区存放 FAT 表本身」。于是排查方向被引到规范上，去查
    `_sector()` 为什么拒绝合法值，甚至准备改常量表。真正的原因跟 CFB
    毫无关系：文件根本没有那么多扇区。

    这条错误信息会**主动误导**。所以判据不是「抛异常了没」，而是
    「抛出的异常有没有说清是数据不全」。
    """

    def test_truncated_reports_truncation_not_illegal_sector(self) -> None:
        path = fixtures.demo_msi_truncated()
        with self.assertRaises(cfb.CfbTruncatedError) as ctx:
            cfb.open_cfb(path)
        message = str(ctx.exception)
        # 必须指出「截断」这个真实原因
        self.assertIn("截断", message)
        # 必须给出可核对的数字，否则用户无从判断该不该重下
        self.assertIn("字节", message)
        # 绝对不能再用「非法扇区号」这种把人引向规范的措辞
        self.assertNotIn("非法扇区号", message)

    def test_truncation_error_is_still_cfberror(self) -> None:
        """CfbTruncatedError 是 CfbError 的子类。

        调用方（`detect._detect_msi`）已经按 `CfbError` 捕获并降级处理，
        新增的子类不能打破这个契约 —— 否则截断会从「降级」变成
        「抛未捕获异常」，症状比原来更糟。
        """
        self.assertTrue(issubclass(cfb.CfbTruncatedError, cfb.CfbError))

    def test_truncated_still_degrades_to_msi_detection(self) -> None:
        """截断文件仍应判成 msi（低置信度），而不是 unknown。

        判成 msi 是有意的：OLE 头已经证明它是 MSI 容器，缺的只是数据。
        交给解包阶段报错，比在识别阶段说「不知道这是什么」更有用。
        但置信度必须低，让上层提示复核。
        """
        path = fixtures.demo_msi_truncated()
        detection = detect_installer(path)
        self.assertEqual(detection.kind, InstallerKind.MSI)
        self.assertLess(detection.confidence, 0.6)
        # 证据里要能看出是截断，而不是笼统的「解析失败」
        joined = " ".join(detection.evidence)
        self.assertIn("截断", joined)

    def test_complete_msi_is_not_flagged_as_truncated(self) -> None:
        """完整样本不能因为新加的判断被误报。

        这条是前一条的对照组：只测「截断会报错」还不够 —— 如果
        `_truncated_at` 写成恒真，前三条照样全过，而所有正常文件都会
        被当成截断。这类「守卫过度」的缺陷不会让测试变红，只会让产品
        对每个正常文件都报警。
        """
        path = fixtures.demo_msi()
        doc = cfb.open_cfb(path)          # 不应抛任何异常
        self.assertGreater(len(doc.stream_names()), 5)
        detection = detect_installer(path)
        self.assertEqual(detection.kind, InstallerKind.MSI)
        self.assertGreater(detection.confidence, 0.9)

    def test_sector_names_cover_all_special_values(self) -> None:
        """四个特殊标记都要有可读名字。

        只覆盖部分值时，漏掉的那个在报错里会退化成 `未知特殊值`，
        等于把「我知道这是什么」变成「我不知道」。
        """
        for value in (cfb.FREESECT, cfb.ENDOFCHAIN, cfb.FATSECT, cfb.DIFSECT):
            self.assertIn(value, cfb.SECTOR_NAMES)
            self.assertTrue(cfb.SECTOR_NAMES[value])


class TestExtractTruncatedDiagnosis(unittest.TestCase):
    """截断的包在**解包**阶段也要说清原因，不能只说「工具返回码 2」。

    ## 为什么检测阶段修了还不够

    `detect` 现在能正确报「文件被截断」。但用户实际执行的是 `wepack extract`
    或 `install`，那条路走的是解包。解包失败时各工具只给「返回码 2」，
    用户看到会去查 7z 装得对不对 —— 而 7z 完全正常，是文件缺了一半。

    诊断信息必须在**用户真正会走到的那一步**也给出。
    """

    def test_extract_failure_mentions_truncation(self) -> None:
        from wepack.errors import UsageError
        from wepack.extract import extract

        path = fixtures.demo_msi_truncated()
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            out.mkdir()
            with self.assertRaises(UsageError) as ctx:
                extract(path, out, kind=InstallerKind.MSI)
            error = ctx.exception
            # 标题要指出「文件不完整」，这是用户唯一能据此行动的信息
            self.assertIn("不完整", error.message)
            # hint 要给出可核对的数字
            hint = error.hint or ""
            self.assertIn("截断", hint)
            self.assertIn("字节", hint)

    def test_truncation_is_not_reported_as_missing_dependency(self) -> None:
        """文件损坏不能报成「缺依赖」。

        MissingDependency 的退出码是 5（EOM_2001「缺 Wine 运行时」）。
        用它报文件截断，脚本会判定「环境缺工具」并去装东西 —— 装完再
        试还是失败，而且用户被告知的方向从一开始就是错的。

        这条测试守的是**错误类型选得对不对**，不是「有没有抛异常」。
        """
        from wepack.errors import MissingDependency, UsageError
        from wepack.extract import extract

        path = fixtures.demo_msi_truncated()
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            out.mkdir()
            with self.assertRaises(UsageError) as ctx:
                extract(path, out, kind=InstallerKind.MSI)
            self.assertNotIsInstance(ctx.exception, MissingDependency)
            # 退出码 2（输入不可用），与「文件不存在」同类
            self.assertEqual(int(ctx.exception.exit_code), 2)

    def test_extract_complete_msi_still_works(self) -> None:
        """对照组：完整包不能因为新加的预检被拦。

        只测「截断会报错」是不够的 —— 若预检写错，把所有包都判成截断，
        上一条照样通过，而所有正常解包全废。
        """
        from wepack.extract import extract

        path = fixtures.demo_msi()
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            out.mkdir()
            report = extract(path, out, kind=InstallerKind.MSI)
            self.assertTrue(report.ok)
            self.assertGreater(report.result.file_count, 20)


class TestMsiTables(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.sample = require_sample(sample_msi, "需要 WEXE_SAMPLE_MSI")

    def test_open_msi_finds_tables(self) -> None:
        tables = msi_tables.open_msi(self.sample)
        # 字符串池要覆盖到「表名 + 列名 + 数据」三类，规模太小说明只解析
        # 出了其中一部分。真实安装包几百到几千条，合成样本几十条。
        self.assertGreater(len(tables.strings), 40)
        self.assertIn("File", tables.tables)
        self.assertIn("Directory", tables.tables)

    def test_file_columns(self) -> None:
        tables = msi_tables.open_msi(self.sample)
        names = [c.name for c in tables.columns.get("File", [])]
        for expected in ("File", "Component_", "FileName", "FileSize"):
            self.assertIn(expected, names)

    def test_file_mapping_non_empty(self) -> None:
        mapping = msi_tables.file_mapping(self.sample)
        # 门槛设 10：真实安装包几十到几千条，合成样本 30 条。
        # 要验的是「批量读取不丢行」，一两条数据看不出来。
        self.assertGreater(len(mapping), 10)
        for item in mapping[:5]:
            # 文件键有两种形态，都要接受：
            #   fil<32hex>  Windows Installer 默认命名
            #   真实文件名  WiX 等工具链（7-Zip 就是这种）
            # 早先这里断言必须以 "fil" 开头，用真实样本才发现那是错的假设。
            self.assertTrue(
                item["file_key"].startswith("fil") or "." in item["file_key"],
                f"文件键形态异常：{item['file_key']}")
            self.assertTrue(item["filename"])
            self.assertNotIn("|", item["filename"])
            # relpath 必须真的带上目录层级，否则说明 Directory 表没解析出来
            self.assertTrue(item["relpath"].endswith(item["filename"]),
                            f"relpath 与 filename 不一致：{item['relpath']}")

    def test_file_mapping_has_directory_structure(self) -> None:
        """真实 MSI 的 relpath 应当带目录层级。

        这是一条「只有真实样本能验」的测试：合成样本里目录树往往只有
        一层，而真实安装包的 Evergreen 结构要深得多。早先的实现因为把
        4 字节整数列当 2 字节读，Directory 表整体错位，relpath 退化成
        纯文件名 —— 而 file_mapping 依然「非空」，测试照样绿。
        """
        mapping = msi_tables.file_mapping(self.sample)
        with_dir = [item for item in mapping if "/" in item["relpath"]]
        self.assertGreater(len(with_dir), len(mapping) * 0.5,
                           "超过一半的 relpath 没有目录层级，Directory 表可能没解析出来")

    def test_file_sizes_are_readable_integers(self) -> None:
        """FileSize 是 4 字节整数列。

        它的正确读取依赖「列宽可变」这一认知 —— 早先所有列都按 2 字节
        读，FileSize 会读到两个错位的 u16，得到一个荒谬的数字。这里用
        「大小为正且总和接近安装包体积量级」来卡住。
        """
        files = msi_tables.file_table(self.sample)
        sizes = [int(item["FileSize"]) for item in files if item.get("FileSize")]
        self.assertGreater(len(sizes), 5, "没有读到任何 FileSize")
        self.assertTrue(all(size > 0 for size in sizes), "存在非正的 FileSize")
        self.assertGreater(sum(sizes), 100_000, "FileSize 总和过小，可能读错列")
        self.assertLess(sum(sizes), 5_000_000_000, "FileSize 总和大得离谱，可能读错列")

    def test_resolve_filename_takes_long(self) -> None:
        self.assertEqual(msi_tables.resolve_filename("PROGRA~1.EXE|Program.exe"),
                         "Program.exe")
        self.assertEqual(msi_tables.resolve_filename("plain.exe"), "plain.exe")

    def test_resolve_default_dir(self) -> None:
        self.assertEqual(msi_tables.resolve_default_dir("SHORT|Long")[1], "Long")
        self.assertEqual(msi_tables.resolve_default_dir("Source:Target")[1], "Target")


# --------------------------------------------------------------------------
# 主 exe 打分
# --------------------------------------------------------------------------


class TestCandidates(unittest.TestCase):
    def test_normalize_strips_version_and_sep(self) -> None:
        self.assertEqual(_normalize("7-Zip 24.08"), "zip")
        self.assertEqual(_normalize("NotePad++"), "notepad")

    def test_rank_prefers_gui_app_over_helper(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "app").mkdir()
            (root / "app" / "Real.exe").write_bytes(build_min_pe(subsystem=2))
            (root / "app" / "unins000.exe").write_bytes(build_min_pe(subsystem=2))
            (root / "app" / "helper.exe").write_bytes(build_min_pe(subsystem=3))

            ranked = rank_candidates(root, product_name="Real", limit=5)
            self.assertTrue(ranked)
            self.assertEqual(ranked[0].relpath, "app/Real.exe")

    def test_rank_skips_non_pe(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "fake.exe").write_bytes(b"not a pe")
            self.assertEqual(rank_candidates(root, limit=5), [])

    def test_rank_finds_extensionless_pe(self) -> None:
        """MSI cab 里的文件没有扩展名，应能被 MZ 探测纳入。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "fil0123456789ABCDEF0123456789ABCDEF").write_bytes(
                build_min_pe(subsystem=2))
            ranked = rank_candidates(root, limit=5)
            self.assertEqual(len(ranked), 1)
            self.assertTrue(ranked[0].relpath.startswith("fil"))

    def test_console_program_can_be_the_main_entry(self) -> None:
        """控制台程序只要更像主程序，就应该排到 GUI 辅助程序前面。

        ## 这条测试守的是什么

        控制台子系统会被扣 30 分（双击场景下 GUI 更常见）。但
        PowerShell / Python / Node / Git 这类工具，**主程序本来就是**
        控制台程序。实测 pwsh.msi 里唯一入口 `pwsh.exe` 是控制台程序，
        而同目录 `createdump.exe` 也是 —— 全靠文件名与体积拉开差距。

        如果哪天有人把「控制台 = 不是主程序」写成硬排除，这条会红：
        下面 `Tool.exe`（控制台、与产品名一致）必须压过
        `Setup.exe`（GUI、名字带负面信号）。
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "bin").mkdir()
            (root / "bin" / "Tool.exe").write_bytes(build_min_pe(subsystem=3))
            (root / "bin" / "Setup.exe").write_bytes(build_min_pe(subsystem=2))
            ranked = rank_candidates(root, product_name="Tool", limit=5)
            self.assertTrue(ranked)
            self.assertEqual(ranked[0].relpath, "bin/Tool.exe")
            # 理由要如实描述「命令行工具的主程序也是这一类」，
            # 不能写成「不是主程序」而与自己选出的结果自相矛盾
            joined = " ".join(ranked[0].reasons)
            self.assertIn("命令行工具", joined)
            self.assertNotIn("不是主程序", joined)

    def test_best_candidate_is_empty_safe(self) -> None:
        """没有候选时返回 None，不能让调用方在空列表上越界。

        `best_candidate` 是 install / package 两处「逐根试」循环里的那一步。
        这两处要求的是"这根下有没有入口"，不是"前五名是谁"，所以单独一个
        返回 Optional 的函数比让每处都写 `ranked[0] if ranked else None`
        更不容易出错 —— 早先两处各抄一遍，写法还不完全一致。
        """
        from wepack.extract.candidates import best_candidate

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # 空目录
            self.assertIsNone(best_candidate(root))
            # 有文件但没有可执行 PE
            (root / "readme.txt").write_text("hi", encoding="utf-8")
            self.assertIsNone(best_candidate(root))

    def test_best_candidate_returns_the_top_ranked(self) -> None:
        """有候选时必须与 rank_candidates(limit=1)[0] 完全一致。"""
        from wepack.extract.candidates import best_candidate

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "App.exe").write_bytes(build_min_pe(subsystem=2))
            (root / "updater.exe").write_bytes(build_min_pe(subsystem=2))

            expected = rank_candidates(root, product_name="App", limit=1)[0]
            actual = best_candidate(root, product_name="App")
            self.assertIsNotNone(actual)
            self.assertEqual(actual.relpath, expected.relpath)
            self.assertEqual(actual.score, expected.score)
            # 产品名匹配的应该胜出
            self.assertEqual(actual.relpath, "App.exe")


class TestAmbiguousNameExemption(unittest.TestCase):
    """产品名匹配时，歧义词不该再被自己的黑名单否掉。

    ## 这条锁住的是一个会把用户引向错误结果的缺陷

    `NEGATIVE_NAMES` 里有些词是「同名不同角色」的：`node.exe` 在 Electron
    应用里是运行库，在 Node.js 安装包里就是主程序本身。早先它们被无条件
    扣 45 分，而产品名匹配给的 +20/+35 在前、扣分在后 —— 扣分赢了。

    实测（产品名 Node.js）：

        1. uninstall.exe    5.0   ← 被选成主程序
        2. node.exe       -25.0   ← 真正的入口

    用户双击后弹出卸载程序。这不是排序不够好，是给出了错的答案。
    """

    def test_product_match_survives_ambiguous_negative_word(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "node.exe").write_bytes(build_min_pe(subsystem=3))
            (root / "uninstall.exe").write_bytes(build_min_pe(subsystem=2))

            ranked = rank_candidates(root, product_name="Node.js", limit=5)
            self.assertTrue(ranked)
            self.assertEqual(
                ranked[0].relpath, "node.exe",
                "产品名匹配的主程序输给了卸载程序 —— 黑名单压过了作者元数据")
            # 理由里要说明为什么没扣分，不能悄悄跳过
            joined = " ".join(ranked[0].reasons)
            self.assertIn("与产品名匹配，不扣分", joined)

    def test_ambiguous_word_still_penalized_without_product_match(self) -> None:
        """没有产品名匹配时，歧义词照旧扣分 —— 否则就是删掉规则而非收窄。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "node.exe").write_bytes(build_min_pe(subsystem=3))
            (root / "MyApp.exe").write_bytes(build_min_pe(subsystem=2))

            ranked = rank_candidates(root, product_name="MyApp", limit=5)
            self.assertEqual(ranked[0].relpath, "MyApp.exe")
            node = next(c for c in ranked if c.relpath == "node.exe")
            self.assertLess(node.score, 0)
            self.assertIn("文件名含 node", " ".join(node.reasons))

    def test_unambiguous_word_penalized_even_when_product_matches(self) -> None:
        """`uninstall` / `setup` 这类词无歧义，产品名匹配也不能豁免。

        产品名叫「Uninstall」这种事不存在，而把卸载程序认成主程序是实打实
        会发生的。豁免只针对 AMBIGUOUS_NAMES 那张表。
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "Real.exe").write_bytes(build_min_pe(subsystem=2))
            (root / "unins000.exe").write_bytes(build_min_pe(subsystem=2))
            (root / "setup.exe").write_bytes(build_min_pe(subsystem=2))

            ranked = rank_candidates(root, product_name="Uninstall", limit=5)
            unins = next(c for c in ranked if "unins" in c.relpath)
            self.assertIn("文件名含 unins", " ".join(unins.reasons))

    def test_ambiguous_set_is_subset_of_negative_names(self) -> None:
        """`AMBIGUOUS_NAMES` 必须是 `NEGATIVE_NAMES` 的子集。

        豁免的逻辑是「命中负面词，但这个词是歧义的 → 不扣分」。若某个词
        只在 AMBIGUOUS_NAMES 里而不在 NEGATIVE_NAMES 里，它永远不会被
        检查到 —— 属于「写进了豁免表却毫无作用」，改名单时最容易出的错。
        """
        from wepack.extract.candidates import AMBIGUOUS_NAMES, NEGATIVE_NAMES

        orphan = AMBIGUOUS_NAMES - set(NEGATIVE_NAMES)
        self.assertEqual(orphan, set(),
                         f"这些词在豁免表里但不在负面名单里，永远不生效：{orphan}")

    def test_no_negative_name_is_shadowed_completely(self) -> None:
        """负面名单里不能有「永远不会被命中」的条目。

        匹配是子串匹配且命中即 `break`。若 `a` 是 `b` 的子串、且 `a` 排在
        `b` 之前，`b` 永远轮不到 —— 任何含 `b` 的名字必然含 `a`，循环在
        `a` 处就跳出了。这是字符串事实，不是审美判断。

        ## 上一版这条测试的判据是错的

        它只断言 `helper.exe` 不在名单里，然后把 `unins` ⊂ `uninstall`
        当作「有意重叠」放过去了，注释还写着「各自要抓不同的短名文件
        （`unins000.exe` vs `UninstallTool.exe`）」。但 `unins` 是
        `uninstall` 的**前缀**，`"unins" in "uninstall.exe"` 为真 ——
        `uninstall` 这条一次都没执行过。把「理论上目标不同」当成「代码里
        真能命中」了。

        现在做的是穷举：对每一对 (a, b) 检查 `a in b` 且 a 更靠前。
        """
        from wepack.extract.candidates import NEGATIVE_NAMES

        shadowed: list[tuple[str, str]] = []
        for index, longer in enumerate(NEGATIVE_NAMES):
            for shorter in NEGATIVE_NAMES[:index]:
                if shorter in longer:
                    shadowed.append((longer, shorter))
                    break

        self.assertEqual(
            shadowed, [],
            f"这些条目永远不会被命中（前面的短条目是它的子串）：{shadowed}")

    def test_removed_long_entries_are_still_covered(self) -> None:
        """删掉长条目后，它们原本要抓的文件名仍必须被扣分。

        「删除不改变行为」这句话要能验证。`uninstall.exe` / `dxsetup.exe`
        这类长拼写此前由被吞掉的长条目「认领」，实际生效的一直是短条目 ——
        这条确认短条目确实认得它们。
        """
        from wepack.extract.candidates import NEGATIVE_NAMES

        for name in ("uninstall.exe", "uninst.exe", "updater.exe",
                     "dxsetup.exe", "vc_redist.x64.exe", "installer.exe",
                     "InstallShield_prereq.exe"):
            with self.subTest(name=name):
                hit = next((bad for bad in NEGATIVE_NAMES
                            if bad in name.lower()), None)
                self.assertIsNotNone(
                    hit, f"{name} 不再被任何负面词命中 —— 删条目前没验证覆盖")

    def test_removed_entries_actually_behave_the_same(self) -> None:
        """端到端：长拼写文件名仍然被扣 45 分。"""
        with tempfile.TemporaryDirectory() as tmp:
            for name in ("uninstall.exe", "dxsetup.exe", "vc_redist.x64.exe"):
                with self.subTest(name=name):
                    root = Path(tmp) / name.replace(".", "_")
                    root.mkdir()
                    (root / name).write_bytes(build_min_pe(subsystem=2))

                    ranked = rank_candidates(root, limit=5)
                    self.assertEqual(len(ranked), 1)
                    self.assertTrue(
                        any("文件名含" in r for r in ranked[0].reasons),
                        f"{name} 没拿到负面词扣分：{ranked[0].reasons}")


class TestRuntimeComponentExemption(unittest.TestCase):
    """运行时组件的排除必须能被产品名豁免，但只对「本身也可能是产品」的项。

    ## 为什么这条比歧义词那条更要紧

    `AMBIGUOUS_NAMES` 命中只是扣 45 分，被错杀后还能靠别的加分爬回来；
    `RUNTIME_COMPONENTS` 是**直接 return None**，错了连候选都没有。

    实测（产品名 Chromium，目录 `Chromium/chromium.exe`）：一个候选都
    没有，用户只能手动 `--entry`。而 Chromium 浏览器的主程序就叫
    `chromium.exe`。WebView2 里那份是运行库、Chromium 安装包里那份是
    浏览器本体，区别只在于哪个产品名在起作用。
    """

    def test_chromium_browser_can_be_the_entry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "Chromium").mkdir()
            (root / "Chromium" / "chromium.exe").write_bytes(build_min_pe(subsystem=2))

            ranked = rank_candidates(root, product_name="Chromium", limit=5)
            self.assertTrue(
                ranked,
                "Chromium 本体一个候选都没有 —— 排除规则吃掉了正确答案")
            self.assertEqual(ranked[0].relpath, "Chromium/chromium.exe")

    def test_webview2_runtime_still_excluded(self) -> None:
        """防回归：豁免不能变成「运行时组件都不排了」。

        这是 `RUNTIME_COMPONENTS` 存在的**原始理由** —— Electron 应用会
        连带装 WebView2，里面有个 msedge.exe 体积与 GUI 特征都很像主程序。
        放宽豁免时最容易把这条一起放掉。
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "app").mkdir()
            (root / "app" / "MyApp.exe").write_bytes(build_min_pe(subsystem=2))
            (root / "WebView2").mkdir()
            (root / "WebView2" / "msedge.exe").write_bytes(build_min_pe(subsystem=2))
            (root / "WebView2" / "msedgewebview2.exe").write_bytes(
                build_min_pe(subsystem=2))

            ranked = rank_candidates(root, product_name="MyApp", limit=10)
            rels = [c.relpath for c in ranked]
            self.assertEqual(ranked[0].relpath, "app/MyApp.exe")
            self.assertNotIn("WebView2/msedge.exe", rels)
            self.assertNotIn("WebView2/msedgewebview2.exe", rels)

    def test_non_exemptable_runtime_still_blocked_even_with_match(self) -> None:
        """`mscorsvw` / `edgeupdate` 这类无歧义项，产品名匹配也不能放行。

        没有任何产品叫「mscorsvw」。豁免表是白名单，不是开关。
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "mscorsvw.exe").write_bytes(build_min_pe(subsystem=3))

            ranked = rank_candidates(root, product_name="mscorsvw", limit=5)
            self.assertEqual(ranked, [], "无歧义的运行时组件被产品名豁免了")

    def test_no_runtime_component_is_shadowed(self) -> None:
        """运行时组件表里不能有「永远不会被命中」的条目。

        同样是子串 + break。若有人加一条 `"edge"` 排在前面，
        后面的 `msedge` / `edgecore` / `edgeupdate` 会全部失效 ——
        而表里还留着它们，读代码的人会以为它们仍在生效。
        """
        from wepack.extract.candidates import RUNTIME_COMPONENTS

        shadowed: list[tuple[str, str]] = []
        for index, longer in enumerate(RUNTIME_COMPONENTS):
            for shorter in RUNTIME_COMPONENTS[:index]:
                if shorter in longer:
                    shadowed.append((longer, shorter))
                    break

        self.assertEqual(
            shadowed, [],
            f"这些运行时组件永远不会被命中：{shadowed}")

    def test_exemptable_components_are_reachable(self) -> None:
        """豁免表里的每项都必须真的能走到豁免分支。

        若某个豁免项被前面的条目遮蔽，循环会先 `return None`，豁免逻辑
        永远执行不到 —— 那不是「豁免没生效」，是「豁免写了个不可能到达
        的分支」。这种缺陷在代码评审里极难看出来。
        """
        from wepack.extract.candidates import (
            RUNTIME_COMPONENTS,
            RUNTIME_COMPONENTS_EXEMPTABLE,
        )

        for item in RUNTIME_COMPONENTS_EXEMPTABLE:
            with self.subTest(item=item):
                index = RUNTIME_COMPONENTS.index(item)
                for earlier in RUNTIME_COMPONENTS[:index]:
                    self.assertNotIn(
                        earlier, item,
                        f"{item!r} 被前面的 {earlier!r} 遮蔽，豁免永不生效")

    def test_dotnet_path_marker_allows_product_exemption(self) -> None:
        """`/dotnet/` 路径标记必须允许产品名豁免，其余标记不许。

        ## 这条锁住的是什么

        路径标记层原本是**无条件** `return None`，没有豁免机制：

            for marker in RUNTIME_PATH_MARKERS:
                if marker in padded_path:
                    return None

        而 `/dotnet/` 与其余标记性质不同。其余说的是「这是系统或安装器
        自己的地方」（`/windows/`、`/common files/`、`/$pluginsdir/`），
        与产品名无关 —— 产品名叫 Windows 也不该把 `system32/x.exe` 当
        入口。`/dotnet/` 却是一个**合法安装位置**。

        实测（修复前，这些目录全部返回空）：

            dotnet/MyDotnetApp.exe   产品名 MyDotnetApp   → 空
            dotnet/dotnet.exe        产品名 .NET Runtime  → 空

        第二例还与组件名层的结论矛盾：`RUNTIME_COMPONENTS_EXEMPTABLE`
        明确认了「产品名是 .NET 时 `dotnet.exe` 就是主程序」，扣分层给了
        豁免，路径层却照样排除。
        """
        cases = [
            # (子目录, 文件名, 产品名, 期望能找到)
            ("dotnet", "dotnet.exe", "Microsoft .NET Runtime", True),
            ("dotnet", "MyDotnetApp.exe", "MyDotnetApp", True),
            ("dotnet", "dotnet", "MyDotnetApp", True),
            # 产品名无关时仍要排除
            ("dotnet", "dotnet.exe", "MyApp", False),
            ("dotnet", "helper.exe", "MyApp", False),
        ]
        for subdir, fname, product, expect in cases:
            with self.subTest(fname=fname, product=product):
                with tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    d = root / subdir
                    d.mkdir(parents=True)
                    (d / fname).write_bytes(build_min_pe(subsystem=2))

                    ranked = rank_candidates(root, product_name=product, limit=5)
                    found = [c.relpath for c in ranked]
                    if expect:
                        self.assertIn(
                            f"{subdir}/{fname}", found,
                            f"{subdir}/{fname} 配产品名 {product!r} 被路径标记"
                            "无条件排除了 —— 这是个合法安装位置")
                    else:
                        self.assertNotIn(
                            f"{subdir}/{fname}", found,
                            f"产品名 {product!r} 与该文件无关，路径标记不该放行")

    def test_other_path_markers_never_exempt(self) -> None:
        """`/windows/` 等标记不能因为改了 `/dotnet/` 就一起松开。

        用「产品名恰好等于文件名」构造最强匹配，仍然必须排除 ——
        否则有人把豁免写成 `if matched_product: continue`（不分标记）
        也能让上面那条测试通过。
        """
        cases = [
            ("windows/system32", "x.exe", "x"),
            ("Common Files/vendor", "y.exe", "y"),
            ("EdgeCore", "app.exe", "App"),
            ("WebView2", "msedge.exe", "msedge"),
        ]
        for subdir, fname, product in cases:
            with self.subTest(marker=subdir):
                with tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    d = root / subdir
                    d.mkdir(parents=True)
                    (d / fname).write_bytes(build_min_pe(subsystem=2))

                    ranked = rank_candidates(root, product_name=product, limit=5)
                    self.assertNotIn(
                        f"{subdir}/{fname}", [c.relpath for c in ranked],
                        f"{subdir}/ 不是合法安装位置，产品名匹配也不该放行")


class TestProductNameNormalization(unittest.TestCase):
    """产品名与 exe 名必须用同一套归一化，否则数字开头的品牌全部错位。

    ## 这条锁住的是什么

    `_normalize` 删掉所有数字（为了剥掉 `24.08` 这类版本号）。但产品名与
    exe 名一起变形，会同时走样成谁也认不出谁：

        _normalize("7-Zip")  = "zip"     _normalize("7z.exe") = "z"
        _normalize("PDF24")  = "pdf"     _normalize("PDF24.exe") = "pdf"

    第二个例子反而碰巧对上了，第一个则彻底错位 —— `7z.exe` 拿 0 分。
    修法是同时比较「保数字」的形式（`_squash`）：`7zip` ↔ `7z` 能互相包含。

    另外近似匹配的阈值原本要求双方都 ≥3 字符，`7z` 只有 2 字符，永远不够。
    降到 2 是因为 `7z` / `3CX` / `QQ` 这类两字符品牌真实存在。
    """

    def test_squash_preserves_digits(self) -> None:
        from wepack.extract.candidates import _normalize, _squash

        self.assertEqual(_squash("7-Zip"), "7zip")
        self.assertEqual(_squash("PDF24"), "pdf24")
        self.assertEqual(_squash("app_1.2.3"), "app123")
        # _normalize 仍要剥掉版本号数字，这是它存在的理由
        self.assertEqual(_normalize("7-Zip"), "zip")
        self.assertEqual(_normalize("PDF24"), "pdf")

    def test_product_words_include_both_forms(self) -> None:
        from wepack.extract.candidates import _product_words

        words = _product_words("7-Zip")
        self.assertIn("7zip", words, "缺保数字形式，7z.exe 匹配不上产品名")
        self.assertIn("zip", words)

    def test_digit_brand_exe_matches_product(self) -> None:
        """`7z.exe` 在 7-Zip 安装包里必须拿到产品名匹配分。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "7z.exe").write_bytes(build_min_pe(subsystem=3))

            ranked = rank_candidates(root, product_name="7-Zip", limit=5)
            self.assertTrue(ranked)
            self.assertGreater(
                ranked[0].score, 0,
                "7z.exe 在 7-Zip 包里拿不到分 —— 归一化把两边都改了形")
            self.assertIn("产品名", " ".join(ranked[0].reasons))

    def test_two_letter_brand_matches(self) -> None:
        """两字符品牌（3CX）也要能匹配，阈值不能卡在 3。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "3CXPhone.exe").write_bytes(build_min_pe(subsystem=2))
            (root / "unins000.exe").write_bytes(build_min_pe(subsystem=2))

            ranked = rank_candidates(root, product_name="3CX", limit=5)
            self.assertEqual(ranked[0].relpath, "3CXPhone.exe")

    def test_threshold_actually_allows_two_char_words(self) -> None:
        """阈值降到 2 必须真的生效 —— `QQ` 这类两字符品牌是判据。

        `3CX` 那条测不出阈值差别：`3cx` 有 3 个字符，旧阈值 3 也能过。
        这里用 `QQ`：产品名词 `qq` 只有 2 字符，exe 归一化后是 `qqmusic`
        （7 字符），近似匹配的入口条件是 `min(len)=2`。阈值卡 3 时这条
        永远不成立，文件只能靠位置和体积硬撑。
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # 放在深层目录、无 GUI 加分，只剩产品名匹配能救它
            deep = root / "a" / "b" / "c"
            deep.mkdir(parents=True)
            (deep / "QQMusic.exe").write_bytes(build_min_pe(subsystem=3))
            (root / "Setup.exe").write_bytes(build_min_pe(subsystem=2))

            ranked = rank_candidates(root, product_name="QQ", limit=5)
            qq = next(c for c in ranked if c.relpath.endswith("QQMusic.exe"))
            self.assertIn(
                "与产品名", " ".join(qq.reasons),
                "两字符产品名没匹配上 —— 近似匹配阈值还卡在 3")

    def test_short_word_does_not_match_everything(self) -> None:
        """阈值降到 2 之后，单字符不能匹配上一切（防过度放宽）。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "zebra.exe").write_bytes(build_min_pe(subsystem=2))
            (root / "Real.exe").write_bytes(build_min_pe(subsystem=2))

            ranked = rank_candidates(root, product_name="z", limit=5)
            # 产品名 "z" 归一化后是 "z"（1 字符），不该匹配 zebra
            zebra = next((c for c in ranked if c.relpath == "zebra.exe"), None)
            if zebra is not None:
                self.assertNotIn(
                    "与产品名", " ".join(zebra.reasons),
                    "单字符产品名匹配上了任意含该字母的文件")

    def test_product_words_drop_single_char_forms(self) -> None:
        """`_product_words` 不该产出单字符词。

        `_normalize("7z")` 把数字删成 `"z"` —— 这种词在打分处被
        `min(len(word), len(form)) >= 2` 挡住，本来就不参与比较。留着它
        只是白跑一轮，而且一旦有人调低那个阈值，`"z"` 会匹配上一切含 z
        的名字。掐在源头是第二层保险。

        注意别顺手把有用的形式也删了：`7z` 的 `_squash` 形式（`"7z"`，
        两个字符）必须留下，否则 `7-Zip` 场景又退回旧的错位。
        """
        from wepack.extract.candidates import _product_words

        for name in ("7z", "A", "X", "3CX", "QQ", "7-Zip", "Node.js",
                     "Microsoft Visual Studio"):
            with self.subTest(name=name):
                words = _product_words(name)
                singles = [w for w in words if len(w) < 2]
                self.assertEqual(singles, [],
                                 f"{name!r} 产出单字符词 {singles}")

        self.assertIn("7z", _product_words("7z"),
                      "掐单字符时把 7z 的有用形式也删了")

    def test_product_words_split_on_dot(self) -> None:
        """分词必须按 `.` 切开，否则 `.NET` 会以带点形态进词表。

        原来只在 `-` / `_` 处切，`Microsoft .NET Runtime` 产出 `'.net'`。
        而 exe 名的归一化形式是 `dotnet` —— `.net` 既不是它的子串也不是
        它的超串，两边永远对不上。
        """
        from wepack.extract.candidates import _product_words

        words = _product_words("Microsoft .NET Runtime")
        self.assertIn("net", words, "`.NET` 没被切成 `net`，dotnet.exe 匹配不上")
        self.assertNotIn(".net", words, "词表里还留着带点的形态")
        # 点号切分不能把连字符/下划线场景弄丢
        self.assertIn("7zip", _product_words("7-Zip"))
        self.assertIn("app123", _product_words("app_1.2.3"))

    def test_dotnet_runtime_finds_its_own_entry(self) -> None:
        """产品名 `Microsoft .NET Runtime` + 目录里只有 `dotnet.exe`。

        ## 这条锁住一个「返回空列表」的 bug

        修 `.` 分词之前：`dotnet.exe` 拿不到产品名分（词表里是 `.net`），
        随后又被 `NEGATIVE_NAMES` 里的 `dotnet` 扣掉 45 分，`score_exe`
        总分转负、`rank_candidates` 过滤掉它，整个目录返回**空**。调用方
        `_find_installed_entry` 因此返回 None，install 报「找不到入口」。

        返回空比返回错程序更难发现 —— 错程序至少还能双击试试。
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "dotnet.exe").write_bytes(build_min_pe(subsystem=2))

            ranked = rank_candidates(
                root, product_name="Microsoft .NET Runtime", limit=5)
            self.assertTrue(
                ranked,
                "装了 .NET 运行时的目录被认为没有可执行程序")
            self.assertEqual(ranked[0].relpath, "dotnet.exe")
            self.assertGreater(ranked[0].score, 0,
                               "dotnet.exe 总分仍为负 —— 扣分没被豁免")

    def test_dotnet_is_ambiguous_not_unconditionally_negative(self) -> None:
        """`dotnet` 必须同时在负面名单与豁免表里。

        两处判断原本矛盾：`RUNTIME_COMPONENTS_EXEMPTABLE` 认「产品名是
        .NET 时 dotnet.exe 就是主程序」，`NEGATIVE_NAMES` 却照样扣 45 分。
        在豁免表里补上 `dotnet`，让扣分层与排除层取同一个结论。
        """
        from wepack.extract.candidates import (AMBIGUOUS_NAMES,
                                               NEGATIVE_NAMES,
                                               RUNTIME_COMPONENTS,
                                               RUNTIME_COMPONENTS_EXEMPTABLE)

        self.assertIn("dotnet", NEGATIVE_NAMES)
        self.assertIn("dotnet", AMBIGUOUS_NAMES,
                      "dotnet 不在豁免表，扣分层与排除层结论矛盾")
        # 排除层已认它可豁免，扣分层必须跟上
        self.assertIn("dotnet.exe", RUNTIME_COMPONENTS)
        self.assertIn("dotnet.exe", RUNTIME_COMPONENTS_EXEMPTABLE)

    def test_unrelated_product_still_penalizes_dotnet(self) -> None:
        """上一条的反面：产品名与 .NET 无关时，dotnet.exe 照旧被甩开。

        豁免只在「产品名匹配」时生效，不能变成无条件放行 —— 否则
        Electron 应用里顺带装的 dotnet.exe 会盖过真正的主程序。
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "MyApp.exe").write_bytes(build_min_pe(subsystem=2))
            (root / "dotnet.exe").write_bytes(build_min_pe(subsystem=2))

            ranked = rank_candidates(root, product_name="MyApp", limit=5)
            self.assertEqual(ranked[0].relpath, "MyApp.exe")
            dotnet = next((c for c in ranked if c.relpath == "dotnet.exe"), None)
            if dotnet is not None:
                self.assertLess(dotnet.score, ranked[0].score,
                                "无关产品名下 dotnet.exe 没被压下去")


class TestTempDirSemantics(unittest.TestCase):
    """`$INSTDIR` 不是临时目录，不能按临时目录扣分。

    ## 语义差别

    - `$TEMP` / `$PLUGINSDIR` 是**安装器自己**的工作目录，里面的 exe 是
      安装逻辑（nsProcess 之类），确实不是应用内容；
    - `$INSTDIR` 是**用户选择的安装目标目录**，`$INSTDIR/App.exe` 就是
      用户要装的那个程序。

    实测 7z 解 NSIS（`fixtures.demo_nsis()`）时载荷直接落在根目录，不产出
    任何带 `$` 的顶层路径 —— 这条规则防的是不存在的威胁，却有反过来打击
    正确答案的风险。
    """

    def test_instdir_is_not_treated_as_temp(self) -> None:
        from wepack.extract.candidates import TEMP_DIRS

        joined = " ".join(TEMP_DIRS).lower()
        self.assertNotIn(
            "$instdir", joined,
            "$INSTDIR 是安装目标目录，不是临时目录；扣分会把正确的主程序压低")

    def test_temp_and_pluginsdir_are_still_excluded(self) -> None:
        """收窄的只是 $INSTDIR，$TEMP / $PLUGINSDIR 的排除必须保留。"""
        from wepack.extract.candidates import TEMP_DIRS

        joined = " ".join(TEMP_DIRS).lower()
        self.assertIn("$temp", joined)
        self.assertIn("$pluginsdir", joined)

    def test_seven_zip_does_not_exclude_instdir(self) -> None:
        """解包时同样不能把 `$INSTDIR` 排掉 —— 那会把载荷静默丢掉。"""
        from wepack.extract import SEVEN_ZIP_EXCLUDES

        upper = [x.upper() for x in SEVEN_ZIP_EXCLUDES]
        self.assertNotIn("$INSTDIR", upper)
        # 该排的还在
        self.assertIn("$PLUGINSDIR", upper)

    def test_temp_dirs_use_forward_slashes_only(self) -> None:
        """临时目录条目不能含反斜杠 —— 匹配对象永远是 posix 路径。

        `rel_lower` 来自 `Path.as_posix()`，永远是正斜杠。这里原本有一条
        `"appdata\\\\local\\\\temp"`，`in` 检查永远为假，是一条从来没生效过的
        规则。实测 `AppData/Local/Temp/setup_helper.exe` 拿不到这条 -60 扣分，
        只靠文件名里的 `setup` 掉到 -20；换个不带负面词的名字就能拿 40 分，
        被当成主程序。
        """
        from wepack.extract.candidates import TEMP_DIRS

        for entry in TEMP_DIRS:
            with self.subTest(entry=entry):
                self.assertNotIn(
                    "\\", entry,
                    f"{entry!r} 含反斜杠，在 posix 路径上永远不会命中")

    def test_appdata_local_temp_is_penalized(self) -> None:
        """真实临时目录必须真的扣分（上一条的端到端对照）。"""
        from wepack.extract.candidates import ScoreContext, score_exe

        rel = "drive_c/users/Public/AppData/Local/Temp/MyTool.exe"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p = root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(build_min_pe(subsystem=2))

            candidate = score_exe(p, rel, ScoreContext(root=root))
            self.assertIsNotNone(candidate)
            self.assertIn("临时", " ".join(candidate.reasons),
                          "AppData/Local/Temp 下的文件没有拿到临时目录扣分")

    def test_temp_in_product_name_is_not_penalized(self) -> None:
        """产品名含 temp 的目录不能被误判成临时目录（防过度匹配）。

        `/temp/` 带斜杠边界，所以 `TempMonitor/` 不会命中 —— 否则一个叫
        「Temp Monitor」的软件永远选不出主程序。
        """
        from wepack.extract.candidates import ScoreContext, score_exe

        rel = "drive_c/Program Files/TempMonitor/TempMonitor.exe"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p = root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(build_min_pe(subsystem=2))

            candidate = score_exe(p, rel, ScoreContext(root=root))
            self.assertIsNotNone(candidate)
            self.assertNotIn("临时", " ".join(candidate.reasons),
                             "产品名含 Temp 的目录被当成临时目录了")

    def test_path_markers_have_trailing_slash(self) -> None:
        """`$` 变量类路径标记必须带尾斜杠，否则会命中同前缀的无关目录。

        `/$temp` 会命中 `$templates`，`/$pluginsdir` 会命中 `$pluginsdirectory`。
        这条规则是「一律排除」，边界不精确就等于误杀。
        """
        from wepack.extract.candidates import RUNTIME_PATH_MARKERS

        for marker in RUNTIME_PATH_MARKERS:
            if "$" in marker:
                with self.subTest(marker=marker):
                    self.assertTrue(
                        marker.endswith("/"),
                        f"{marker!r} 缺尾斜杠，会命中同前缀的无关目录")

    def test_dollar_temp_prefix_is_not_overmatched(self) -> None:
        """端到端对照：`$templates` 不能被当成 `$temp`。"""
        from wepack.extract.candidates import ScoreContext, score_exe

        rel = "$templates/MyApp.exe"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p = root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(build_min_pe(subsystem=2))

            candidate = score_exe(p, rel, ScoreContext(root=root))
            self.assertIsNotNone(
                candidate, "$templates 被当成 $temp 排除了")

    def test_pluginsdir_is_excluded_not_merely_penalized(self) -> None:
        """`$PLUGINSDIR` 是直接排除，不是扣分。

        早先扣分逻辑里有一段 `-80` 的 `$pluginsdir` 判断，但路径标记
        已经先把它排除了 —— 那段永远执行不到，是死代码。这条锁住「插件
        目录是排除语义」，顺带确认删掉那段之后行为没变。
        """
        from wepack.extract.candidates import ScoreContext, score_exe

        rel = "$PLUGINSDIR/nsProcess.exe"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p = root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(build_min_pe(subsystem=2))

            self.assertIsNone(
                score_exe(p, rel, ScoreContext(root=root)),
                "$PLUGINSDIR 下的文件必须被直接排除")

    def test_top_level_temp_dir_is_penalized(self) -> None:
        """顶层的 `temp/` 也要扣分。

        `TEMP_DIRS` 里 `"/temp/"` 带前导斜杠，而 `rel_lower` 是
        `temp/MyTool.exe` —— 开头没有斜杠，`in` 永远为假。实测这个文件拿
        35 分（第 1 层 +10、GUI +20、x86_64 +5），一分没扣。

        根目录下的临时区恰恰是最常见的形态：安装器先把载荷解到 temp，
        再搬到目标位置。漏掉它等于这条规则在最该生效的地方失效。
        """
        from wepack.extract.candidates import ScoreContext, score_exe

        rel = "temp/MyTool.exe"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p = root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(build_min_pe(subsystem=2))

            candidate = score_exe(p, rel, ScoreContext(root=root))
            self.assertIsNotNone(candidate)
            self.assertTrue(
                any("临时目录" in r for r in candidate.reasons),
                f"顶层 temp 没有命中临时目录规则，得分 {candidate.score}："
                f"{candidate.reasons}")
            self.assertLess(candidate.score, 0,
                            "扣了 60 分之后分数应当为负")

    def test_temp_prefix_without_boundary_is_not_penalized(self) -> None:
        """`templates` / `MyTemp` / `TempDir` 不能被当成 `temp`。

        补边界是为了让顶层 `temp/` 命中，但不能顺手把同前缀的普通目录
        一起打掉 —— 那是把一条规则变成一片。
        """
        from wepack.extract.candidates import ScoreContext, score_exe

        for rel in ("templates/MyTool.exe", "MyTemp/MyTool.exe",
                    "TempDir/MyTool.exe", "attempt/MyTool.exe"):
            with self.subTest(rel=rel), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                p = root / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(build_min_pe(subsystem=2))

                candidate = score_exe(p, rel, ScoreContext(root=root))
                self.assertIsNotNone(candidate)
                self.assertFalse(
                    any("临时目录" in r for r in candidate.reasons),
                    f"{rel} 被误判成临时目录")

    def test_program_files_needs_word_boundary(self) -> None:
        """`Program Files` 要带左边界，但顶层出现时也要命中。

        两个方向都要测：原来的 `"program files" in rel_lower` 是纯子串，
        `MyProgram Files/` 照样拿 +25；而如果要加左斜杠又容易写成
        `"/program files"` 只在一处判断 —— 解包后 `Program Files/` 常常
        就在根的下一层，rel_lower 开头没有斜杠。
        """
        from wepack.extract.candidates import ScoreContext, score_exe

        cases = [
            ("Program Files/App/App.exe", True, "顶层"),
            ("drive_c/Program Files/App/App.exe", True, "prefix 内"),
            ("Program Files (x86)/App/App.exe", True, "x86 变体"),
            ("ProgramFiles/App/App.exe", True, "无空格变体"),
            ("MyProgram Files/App/App.exe", False, "前面粘了别的词"),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for rel, expect, tag in cases:
                with self.subTest(tag=tag):
                    p = root / rel
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_bytes(build_min_pe(subsystem=2))

                    candidate = score_exe(p, rel, ScoreContext(root=root))
                    self.assertIsNotNone(candidate)
                    hit = any("Program Files" in r or "ProgramFiles" in r
                              for r in candidate.reasons)
                    self.assertEqual(hit, expect,
                                     f"{rel}: 命中={hit}，预期={expect}")


class TestAppDirHints(unittest.TestCase):
    """同级打包资源后缀要有区分度。

    `APP_DIR_HINTS` 早先列了 `.dll` / `.json` 却没人调用（判断处硬编码了
    `.pak` / `.asar`）—— 典型的「文档承诺但代码不用」。接上之后必须保证
    留下的后缀真有区分度：`.dll` / `.json` 几乎每个目录都有，命中等于没判断。
    """

    def test_hints_exclude_meaningless_suffixes(self) -> None:
        from wepack.extract.candidates import APP_DIR_HINTS

        self.assertNotIn(".dll", APP_DIR_HINTS, ".dll 到处都是，没有区分度")
        self.assertNotIn(".json", APP_DIR_HINTS, ".json 到处都是，没有区分度")
        for suffix in (".pak", ".asar"):
            self.assertIn(suffix, APP_DIR_HINTS)

    def test_hint_actually_affects_score(self) -> None:
        """接上之后必须真的影响打分，不能还是死常量。

        造两个内容相同的目录，只有一个放了 `.resources`，分数应当更高。
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plain = root / "plain"
            packed = root / "packed"
            plain.mkdir()
            packed.mkdir()
            for d in (plain, packed):
                (d / "App.exe").write_bytes(build_min_pe(subsystem=2))
            (packed / "resources.resources").write_bytes(b"\0" * 64)

            scored = {}
            for rel in ("plain/App.exe", "packed/App.exe"):
                ranked = rank_candidates(root, limit=10)
                scored[rel] = next(c for c in ranked if c.relpath == rel)

            self.assertGreater(
                scored["packed/App.exe"].score, scored["plain/App.exe"].score,
                "放 .resources 的目录没有拿到加分 —— 常量仍然是死的")
            self.assertIn(".resources",
                          " ".join(scored["packed/App.exe"].reasons))


class TestSiblingDirFeatures(unittest.TestCase):
    """同级目录特征必须统计完整，不能只看枚举顺序里的前 N 条。

    ## 这条锁住的是什么

    旧实现是 `list(parent.iterdir())[:200]`：先枚举整个目录再切片，只看
    前 200 条。两个问题：

    1. **统计偏差**：目录里文件超过 200 个时，dll 是否被计入取决于
       `iterdir` 的返回顺序。实测 310 个文件里 10 个 dll，有 2 个落在
       索引 200 之后 —— 统计到 8 个而不是 10 个。
    2. **重复劳动**：同一目录里每个 exe 都把整目录重新枚举一遍。实测
       同目录 800 个 exe 要 3.5 秒，绝大部分耗在重复 `iterdir`。

    `iterdir` 的顺序由文件系统决定（APFS/HFS+/ext4/NTFS 各不相同），
    所以问题 1 是**不可复现**的：同样的样本换个机器，分数可能不同。
    测试因此不去构造「顺序恰好不利」的目录，而是直接断言「统计的是全量」。
    """

    def test_counts_all_dlls_not_just_first_200(self) -> None:
        """超过 200 个同级文件时，200 条之外的 dll 也要计入。

        枚举顺序在这里被**显式控制**：dll 全部排在后面。真实文件系统的
        `iterdir` 顺序由 hash 决定，靠运气摆位会让这条测试时而通过时而
        失败 —— 而「时而通过」的回归测试等于没有。控制顺序后，切片实现
        必然只看到 0 个 dll，全量实现必然看到 7 个。
        """
        from unittest import mock

        from wepack.extract.candidates import ScoreContext

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            d = root / "bin"
            d.mkdir()
            for i in range(300):
                (d / f"asset{i:03d}.png").write_bytes(b"\0" * 4)
            for i in range(7):
                (d / f"lib{i}.dll").write_bytes(b"\0" * 4)

            real = sorted(Path.iterdir(d), key=lambda p: p.suffix != ".png")

            with mock.patch.object(Path, "iterdir",
                                   autospec=True,
                                   side_effect=lambda _self: iter(real)):
                ctx = ScoreContext(root=root)
                dll_count, suffixes = ctx.dir_features(d)

            self.assertEqual(dll_count, 7,
                             f"同级 dll 统计成 {dll_count} 个，应为 7 个 —— "
                             "要么还在切片，要么统计的不是全量")
            self.assertIn(".png", suffixes)

    def test_features_are_cached_per_directory(self) -> None:
        """同一目录只枚举一次；不同目录各算各的。"""
        from unittest import mock

        from wepack.extract.candidates import ScoreContext

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = root / "a"
            b = root / "b"
            for d in (a, b):
                d.mkdir()
            (a / "one.dll").write_bytes(b"\0" * 4)
            (b / "x.dll").write_bytes(b"\0" * 4)
            (b / "y.dll").write_bytes(b"\0" * 4)

            ctx = ScoreContext(root=root)
            with mock.patch.object(Path, "iterdir",
                                   autospec=True,
                                   side_effect=Path.iterdir) as spy:
                first = ctx.dir_features(a)
                second = ctx.dir_features(a)
                other = ctx.dir_features(b)

            self.assertEqual(first, second, "同一目录两次结果不一致")
            self.assertEqual(first[0], 1)
            self.assertEqual(other[0], 2)
            self.assertEqual(spy.call_count, 2,
                             f"枚举了 {spy.call_count} 次，应为 2 次"
                             "（目录 a 一次、目录 b 一次）")

    def test_repeated_scoring_does_not_reread_directory(self) -> None:
        """同目录多个 exe：目录只枚举一次，分数还都对。"""
        from unittest import mock

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            d = root / "bin"
            d.mkdir()
            for name in ("A.exe", "B.exe", "C.exe"):
                (d / name).write_bytes(build_min_pe(subsystem=2))
            for i in range(4):
                (d / f"lib{i}.dll").write_bytes(b"\0" * 4)

            with mock.patch.object(Path, "iterdir",
                                   autospec=True,
                                   side_effect=Path.iterdir) as spy:
                ranked = rank_candidates(root, limit=10)

            self.assertEqual(len(ranked), 3)
            for c in ranked:
                self.assertIn("同级有 4 个 DLL", " ".join(c.reasons))
            # 三个 exe 同处一个目录，目录枚举必须只有一次 ——
            # 按 exe 数量增长（3 次）就是缓存没生效。
            self.assertEqual(
                spy.call_count, 1,
                f"目录被枚举了 {spy.call_count} 次，应为 1 次 —— 缓存没生效")


class TestScanLimits(unittest.TestCase):
    """扫描的两个上限管的是不同东西，不能混用。

    ## 这条锁住的是什么

    `max_files` 统计的是**收到的候选数**。无后缀文件在探测失败后不进
    `exe_paths`，不占名额 —— 于是一堆无后缀资源文件能让「上限」完全
    失效。实测 6000 个无后缀非 PE 文件配 `max_files=50`，耗时 7.8 秒，
    与 `max_files=4000` 的 7.0 秒几乎相同。

    所以 `max_probes` 单独统计**打开探头的次数**。这两条测试都用 mock
    数 `_looks_like_pe` 的调用次数，不真的去 open —— 断言的是逻辑，
    不该被磁盘或沙箱的 I/O 速度影响。
    """

    def test_probe_limit_caps_extensionless_opens(self) -> None:
        """达到 max_probes 后不再探测无后缀文件。"""
        from unittest import mock

        from wepack.extract import candidates as cand_mod

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            d = root / "res"
            d.mkdir()
            (root / "App.exe").write_bytes(build_min_pe(subsystem=2))
            for i in range(50):
                (d / f"data{i:03d}").write_bytes(b"XX" + b"\0" * 8)

            with mock.patch.object(cand_mod, "_looks_like_pe",
                                   return_value=False) as spy:
                ranked = rank_candidates(root, product_name="App",
                                         limit=5, max_probes=7)

            self.assertEqual(spy.call_count, 7,
                             f"探测了 {spy.call_count} 次，上限是 7 —— "
                             "max_probes 没有生效")
            self.assertEqual([c.relpath for c in ranked], ["App.exe"])

    def test_exe_still_collected_after_probe_limit(self) -> None:
        """探测额度用尽后，`.exe` 必须照常收集。

        探测是为 MSI 的哈希文件名准备的；额度耗在无后缀资源上之后，
        真候选不该被连带丢掉。
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            res = root / "res"
            res.mkdir()
            for i in range(20):
                (res / f"data{i:03d}").write_bytes(b"XX" + b"\0" * 8)
            (root / "Real.exe").write_bytes(build_min_pe(subsystem=2))

            ranked = rank_candidates(root, product_name="Real",
                                     limit=5, max_probes=1)

            self.assertEqual([c.relpath for c in ranked], ["Real.exe"],
                             "探测额度用尽后把 .exe 也丢了")

    def test_probe_limit_does_not_starve_msi_candidates(self) -> None:
        """默认上限足够覆盖 MSI 解包目录里的无后缀文件。"""
        from wepack.extract import candidates as cand_mod

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            msi_name = "fil" + "a" * 32
            (root / msi_name).write_bytes(build_min_pe(subsystem=2))

            ranked = rank_candidates(root, product_name="App", limit=5)

            self.assertEqual(len(ranked), 1,
                             "默认 max_probes 太小，MSI 的哈希名文件被漏掉")
            self.assertEqual(ranked[0].relpath, msi_name)


class TestTieBreakOrder(unittest.TestCase):
    """同分时的次序由**目录层级**决定，不能混进文件名长度。

    ## 这条锁住的是什么

    排序键原本是 `(-score, len(relpath), relpath)` —— 用字符长度当「浅层
    优先」的代理。两者不等价：一个根目录的长名文件和一层深目录的短名
    文件，长度可能反过来。实测分数都是 50 时，`d/e.exe`（深度 1、7 字符）
    排到了 `root-program-with-long-name.exe`（深度 0、31 字符）前面。

    「在解包根目录」是 +25 的强信号，同分时却不优先，等于让文件名长度
    决定了胜负。7-Zip 目录里的 `7zG.exe` 压过 `7zFM.exe` 是同一处退化
    （两者同为 GUI、同体积档，并列时纯靠长度分）。
    """

    def test_root_wins_tie_against_shorter_deep_path(self) -> None:
        """同分时根目录优先，哪怕深层那个路径短得多。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # 根目录 +25（无体积加分）= 25
            (root / "root-program-with-long-name.exe").write_bytes(
                build_min_pe(subsystem=2))
            # 深度 1 +10，再加 HUGE 体积 +15 = 25，与上面同分
            d = root / "d"
            d.mkdir()
            (d / "e.exe").write_bytes(
                build_min_pe(subsystem=2) + b"\0" * (9 * 1024 * 1024))

            ranked = rank_candidates(root, limit=5)

            self.assertEqual(len(ranked), 2)
            self.assertEqual(ranked[0].score, ranked[1].score,
                             "构造有误：两者应当同分，否则测不到 tie-break")
            self.assertEqual(
                ranked[0].relpath, "root-program-with-long-name.exe",
                "同分时深层短路径反超了根目录 —— 排序键又用字符长度了")

    def test_shallow_wins_tie_among_deep_paths(self) -> None:
        """都不在根目录时，层级浅的优先 —— 哪怕它的路径更长。

        深度 1 和深度 2 拿的是同一个位置分（+10），所以这条必须靠 tie-break
        分胜负。构造时刻意让浅层那个的**路径更长**（目录名长），这样旧代码
        按字符长度排会把深层短的排前面。
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            shallow = root / "verylongdirectoryname"
            deep = root / "a" / "b"
            shallow.mkdir()
            deep.mkdir(parents=True)
            blob = build_min_pe(subsystem=2)
            (shallow / "x.exe").write_bytes(blob)
            (deep / "y.exe").write_bytes(blob)

            ranked = rank_candidates(root, limit=5)

            self.assertEqual(len(ranked), 2)
            self.assertEqual(ranked[0].score, ranked[1].score,
                             "构造有误：深度 1 与深度 2 应当同分")
            # 前置断言：浅层那个的路径确实更长，否则测不出两者的差别
            self.assertGreater(
                len("verylongdirectoryname/x.exe"), len("a/b/y.exe"),
                "构造有误：浅层的路径没比深层长，测不到旧实现的退化")
            self.assertEqual(ranked[0].relpath, "verylongdirectoryname/x.exe",
                             "深度 1 的没排在深度 2 前面")


class TestResourceReadOnce(unittest.TestCase):
    """同一个 exe 的资源目录只解析一次。

    ## 这条锁住的是什么

    `score_exe` 既要版本资源（产品名、OriginalFilename）又要图标。原先是
    各自调用 `pe.resources(info)`：一次在 `pe.product_metadata` 内部，一次
    在图标判断处 —— 同一个文件、同一棵资源树走两遍。

    修复的办法是让 `pe.version_strings` / `pe.product_metadata` 接受调用方
    已经解析好的叶子表。这条测试数的是 `pe.resources` 的实际调用次数，
    不是耗时 —— 耗时受磁盘和沙箱影响，调用次数只由代码结构决定。
    """

    def test_resources_parsed_once_per_exe(self) -> None:
        from unittest import mock

        from wepack import pe as pe_mod

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "App.exe").write_bytes(build_min_pe(subsystem=2))

            with mock.patch.object(pe_mod, "resources",
                                   wraps=pe_mod.resources) as spy:
                rank_candidates(root, limit=3)

            self.assertEqual(
                spy.call_count, 1,
                f"资源目录被解析了 {spy.call_count} 次，应为 1 次 —— "
                "product_metadata 和图标判断又各走了一遍")

    def test_metadata_still_correct_when_entries_passed(self) -> None:
        """传入 entries 与不传，结果必须完全一致。"""
        from wepack import pe as pe_mod

        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "App.exe"
            p.write_bytes(build_min_pe(subsystem=2))

            info = pe_mod.parse(p)
            entries = pe_mod.resources(info)
            self.assertEqual(
                pe_mod.product_metadata(info),
                pe_mod.product_metadata(info, entries),
                "传入已解析的资源表改变了结果")


# --------------------------------------------------------------------------
# 编码：MSI 的 Codepage 与 Inno 的标记编码
# --------------------------------------------------------------------------


class TestMsiCodepage(unittest.TestCase):
    """MSI 的字符串必须按 Codepage 解码，不能写死 latin-1。

    ## 这条锁住的是什么

    字符串池与 SummaryInformation 里的文本都是**单字节串**，编码由同一
    属性集里的 PID 1（Codepage）指定。写死 latin-1 时：

      - 英文包完全正常（ASCII 是 latin-1 的子集）
      - 中文包整片乱码，而乱码不会让任何断言失败（`????` 是合法字符串）

    于是「编码错了」这件事在测试里看不出来，只有拿到真实中文包或用
    Codepage 936 的样本才会暴露。
    """

    def test_chinese_strings_round_trip(self) -> None:
        """中文产品名要能完整读回来。"""
        path = fixtures.demo_msi_chinese()
        tables = msi_tables.open_msi(path)
        everything = " ".join(tables.strings.values())
        self.assertIn("示例产品", everything,
                      "中文 MSI 的字符串池未按 Codepage 936 解码")

    def test_chinese_file_paths(self) -> None:
        """relpath 里的中文目录名不能变成问号。"""
        path = fixtures.demo_msi_chinese()
        mapping = msi_tables.file_mapping(path)
        self.assertTrue(mapping)
        relpaths = [item["relpath"] for item in mapping]
        self.assertTrue(any("示例产品" in p for p in relpaths),
                        f"中文目录名丢失：{relpaths[:3]}")
        for p in relpaths:
            self.assertNotIn("?", p, f"relpath 出现替换字符：{p}")

    def test_chinese_shortcut_names(self) -> None:
        """快捷方式显示名是中文时也要正确。"""
        path = fixtures.demo_msi_chinese()
        targets = msi_tables.shortcut_targets(path)
        self.assertTrue(targets)
        self.assertTrue(any("主程序" in t["name"] for t in targets),
                        f"快捷方式名未解码：{[t['name'] for t in targets]}")

    def test_summary_information_uses_codepage(self) -> None:
        """SummaryInformation 的标题也要按 Codepage 解。"""
        path = fixtures.demo_msi_chinese()
        meta = cfb.summary_information(path)
        self.assertIn("示例产品", meta.get("title", ""),
                      f"标题未按 Codepage 解码：{meta}")

    def test_codepage_is_1252_for_default_sample(self) -> None:
        """对照组：默认样本是 1252，中文不该出现。

        有这条才说明上面几条不是因为「恰好都能过」而通过。
        """
        path = fixtures.demo_msi(variant="ascii-check")
        self.assertEqual(cfb.read_codepage(cfb.open_cfb(path)), 1252)


class TestInnoMarkerEncoding(unittest.TestCase):
    """Inno 的版本标记两种编码都要认。

    ## 为什么两种都要测

    实测 Inno 7.1.1 的安装器把标记写成 **ASCII**：

        b'Inno Setup Setup Data (7.1.1)\\x00...'

    而 Unicode 版（6.x 起可选）是 UTF-16LE。早先的检测代码只按 ASCII
    查（裸 `head.find`），Unicode 版的包一个特征都命不中，整个 Inno
    类型被判成 unknown，于是走 PE 回退路径把节区当载荷解出来。

    同一份文件里 NSIS 的检测用的是能兼容两种编码的 `_hit` —— 写 NSIS
    时想到了 Unicode，写 Inno 时忘了。这种「同类逻辑两种写法」就是
    缺陷的典型来源。
    """

    def test_ascii_marker(self) -> None:
        path = fixtures.demo_inno(version="6.2.2", wide=False)
        detection = detect_installer(path)
        self.assertEqual(detection.kind, InstallerKind.INNO)
        self.assertTrue(any("6.2.2" in e for e in detection.evidence),
                        f"版本未解析：{detection.evidence}")

    def test_utf16_marker(self) -> None:
        path = fixtures.demo_inno(version="6.3.1", wide=True)
        detection = detect_installer(path)
        self.assertEqual(detection.kind, InstallerKind.INNO,
                         "UTF-16LE 编码的标记未被识别")
        self.assertTrue(any("6.3.1" in e for e in detection.evidence),
                        f"版本未解析：{detection.evidence}")

    def test_version_is_clean(self) -> None:
        """版本号不能带括号、空白或引号。

        `_inno_payload_version` 的返回值会被用来比较版本号（"版本是否
        过旧"），带一个多余字符就会让比较结论完全错。
        """
        from wepack.extract import _inno_payload_version

        for wide in (False, True):
            path = fixtures.demo_inno(version="6.2.2", wide=wide)
            version = _inno_payload_version(path)
            self.assertEqual(version, "6.2.2",
                             f"wide={wide} 时版本号不干净：{version!r}")

    def test_helper_agrees_with_detect(self) -> None:
        path = fixtures.demo_inno(version="7.0.0", wide=False)
        from wepack.extract import _inno_payload_version

        version = _inno_payload_version(path)
        self.assertIn(version, " ".join(detect_installer(path).evidence))


# --------------------------------------------------------------------------
# 真实样本（现场构造，见 fixtures.py）
# --------------------------------------------------------------------------


class TestRealNsis(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.sample = require_sample(sample_nsis, "需要 makensis 才能现场编译 NSIS 样本")

    def test_detect(self) -> None:
        detection = detect_installer(self.sample)
        self.assertEqual(detection.kind, InstallerKind.NSIS)
        self.assertGreaterEqual(detection.confidence, 0.9)
        self.assertTrue(detection.supported)

    @unittest.skipUnless(have_7z(), "需要 7z")
    def test_extract(self) -> None:
        from wepack.extract import extract
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            report = extract(self.sample, out)
            self.assertTrue(report.ok)
            self.assertGreater(report.result.file_count, 0)
            self.assertTrue(report.result.candidates)


class TestRealInno(unittest.TestCase):
    """Inno 的真实路径：检测、版本读取、解包、7z 回退。

    ## 样本来源的层级

    `sample_inno()` 优先取环境变量（真实产品包对照），否则取
    `fixtures.demo_inno()` 的合成骨架 —— 骨架只有标记，够测检测与
    版本读取，但解不了包。

    解包类测试要的是**真载荷**，所以单独用 `real_inno()`：它来自
    `fixtures.demo_inno_real()`，由 Inno Setup 6.0.5 的 ISCC 在 wine
    下现场编译。这个版本号是刻意选的 —— `innoextract 1.9` 支持到
    6.0.5，正好在上限。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.sample = require_sample(sample_inno, "需要 WEXE_SAMPLE_INNO")

    def test_detect(self) -> None:
        detection = detect_installer(self.sample)
        self.assertEqual(detection.kind, InstallerKind.INNO)
        self.assertTrue(detection.supported)

    def test_version_is_reported(self) -> None:
        """载荷头里的版本号要能被读出来，否则无从判断 innoextract 是否支持。"""
        detection = detect_installer(self.sample)
        evidence = " ".join(detection.evidence)
        self.assertIn("版本", evidence, f"未解析出 Inno 版本：{detection.evidence}")

    def test_payload_version_helper_agrees_with_detect(self) -> None:
        """_inno_payload_version 与检测器读到的版本必须一致。

        这个 helper 是给「版本过旧」报错用的。它要是读错了版本，
        用户会看到一句自信的错误结论，比不给提示更糟。
        """
        from wepack.extract import _inno_payload_version

        version = _inno_payload_version(self.sample)
        self.assertTrue(version, "未读出 Inno 版本")
        self.assertIn(version, " ".join(detect_installer(self.sample).evidence))


class TestRealInnoPayload(unittest.TestCase):
    """真实 Inno 安装包（ISCC 编译）的解包路径。

    ## 为什么这组必须存在且不能跳过

    历史上这条路径**从来没有被真跑通过**：参数里写了 `--no-icon`
    （innoextract 1.9 没这个选项），解析失败返回码 1，错误只在 stderr
    第一行 —— 表现为「Inno 解包永远失败」，没人想到是参数写错。

    后来又出现反向问题：夹具版本写成 6.2.2，超出 innoextract 的支持
    上限，测试以「版本过旧」为由跳过，跳过在报告里是绿的。跳过条件
    看起来精确，实际是**夹具版本选错**伪装成环境限制。

    现有夹具是真编译产物、版本正好在上限，这条路才第一次被真的走通。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.sample = require_sample(real_inno, "需要 ISCC + wine 才能现场编译 Inno 样本")

    def test_detect_says_inno(self) -> None:
        detection = detect_installer(self.sample)
        self.assertEqual(detection.kind, InstallerKind.INNO,
                         f"真编译产物没被认成 Inno：{detection.evidence}")
        self.assertTrue(detection.supported)

    def test_version_within_innoextract_cap(self) -> None:
        """夹具版本必须落在 innoextract 的支持区间内。

        这条断言是**守卫的守卫**：夹具版本一旦被改高，解包测试会静默
        跳过。这里直接把它变成红。
        """
        need = installer_inno_version(self.sample)
        cap = innoextract_max_inno_version()
        self.assertIsNotNone(need, "读不出夹具的 Inno 版本")
        self.assertIsNotNone(cap, "读不出 innoextract 的支持上限")
        self.assertLessEqual(
            need, cap,
            f"夹具是 Inno {'.'.join(map(str, need))}，"
            f"超过本机 innoextract 上限 {'.'.join(map(str, cap))} —— "
            "解包测试会因为夹具版本过高而被跳过，请改 INNO_SETUP_VERSION")

    @unittest.skipUnless(have_innoextract(), "需要 innoextract")
    def test_extract_with_innoextract(self) -> None:
        """有 innoextract 时的成功路径：必须解出真实应用文件。

        ## 断言为什么盯目录结构与 PE 头

        innoextract 的失败方式不止「返回非 0」。它也可能返回 0 但只
        解出安装器自己的临时文件（漏掉 `-e`）。所以这里核对的是
        「应用目录结构还原了没有」和「解出来的东西真是 PE 不是分段」，
        而不是「文件数 > 0」。
        """
        from wepack.extract import extract

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            report = extract(self.sample, out)

            self.assertTrue(report.ok)
            self.assertGreater(report.result.file_count, 0)

            # 关键断言：产物必须是 PE 文件，不是编译器分段
            exes = [p for p in out.rglob("*") if p.suffix.lower() in (".exe", ".dll")]
            self.assertTrue(exes, "未解出任何 exe/dll")
            samples = [p for p in exes if p.stat().st_size > 64 * 1024]
            self.assertTrue(samples, "解出的可执行文件都太小，可疑")
            for path in samples[:3]:
                with path.open("rb") as handle:
                    self.assertEqual(handle.read(2), b"MZ",
                                     f"{path.name} 不是合法 PE")

            # 不能有 PE 节区名混在产物里
            names = {p.name for p in out.rglob("*") if p.is_file()}
            leaked = names & {".text", ".data", "CERTIFICATE"}
            self.assertFalse(leaked, f"产物里混入了 PE 节区：{leaked}")

            # innoextract 的标志性行为：把应用文件还原到 app/ 下，
            # 且保留安装脚本里写的目录层级（bin / docs）
            relpaths = {p.relative_to(out).as_posix()
                        for p in out.rglob("*") if p.is_file()}
            self.assertTrue(any("bin/" in r for r in relpaths),
                            f"没还原出 bin 目录：{sorted(relpaths)}")
            self.assertTrue(any("docs/" in r for r in relpaths),
                            f"没还原出 docs 目录：{sorted(relpaths)}")

            self.assertTrue(report.result.candidates, "未识别出主程序候选")
            # 主程序应当是 bin 里那个 1.5 MB 的 exe，不是 dll / txt
            top = report.result.candidates[0]
            self.assertTrue(top.relpath.endswith("Demo.exe"),
                            f"最高分候选不是主程序：{top.relpath}")

    @unittest.skipUnless(have_7z(), "需要 7z")
    def test_seven_zip_never_fakes_success(self) -> None:
        """7z 对 Inno 包无论怎么失败，都不得被当成解包成功。

        ## 这条测试真正锁的是什么

        7z 对 Inno 的失败方式**随版本与包内容变化**，实测见过两种：

          1. 切开 PE 容器：返回 0，解出 `.text` / `.data` / `.rsrc` /
             `CERTIFICATE` 共 33 个文件 4.7 MB —— 返回码与文件数都像
             成功，里面没有一个应用文件（Notepad3 6.7.0，7z 23.x）；
          2. 直接报致命错误：返回 2，一个文件都不产出
             （本机 7z 24.09 对 ISCC 6.0.5 编译的包就是这种）。

        所以断言不能写死「必须返回非 0」或「必须报节区」—— 那是把某一次
        实测的偶然行为当成契约。这里锁的是**共同的坏结果**：不能是成功，
        不能留下被当成果交付的垃圾，失败必须有可读的理由。

        ## 为什么不走 `extract()`

        顶层 `extract()` 在装了 innoextract 时会先成功、根本不进 7z
        回退，于是这条测试会以「回退路径不会被触发」为由跳过 —— 而 7z
        这一段是独立逻辑（`_reject_pe_sections`），与 innoextract 在不在
        毫无关系。直接测这一层，跳过条件只剩「本机没有 7z」。
        """
        from wepack.extract import ExtractAttempt, _seven_zip_extract

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            out.mkdir()
            attempt = ExtractAttempt(method="", ok=False)
            ok = _seven_zip_extract(self.sample, out, attempt)

            self.assertFalse(
                ok, f"7z 解 Inno 被当成了成功（detail={attempt.detail}）")
            self.assertTrue(attempt.detail, "失败却没有给出理由")
            self.assertRegex(
                attempt.detail, r"(节区|PE|返回码)",
                f"失败理由没说清原因：{attempt.detail}")

            # 无论走哪条失败路径，输出目录都不能留下「看起来是成果」的残渣
            leftovers = [p.name for p in out.iterdir()]
            self.assertEqual(leftovers, [], f"失败后残留：{leftovers}")


class TestInnoExtractArgs(unittest.TestCase):
    """innoextract 的**参数构造**必须能被独立验证。

    ## 为什么这组非有不可

    本机没有 innoextract（PyPI 上没有，brew 又被宿主沙箱拒绝），所以
    「真实解包」那条路径只能如实跳过。但历史上最严重的一次 Inno 故障
    恰恰出在**参数**上：`--no-icon` 这个不存在的选项让 innoextract 1.9
    的解析器直接返回码 1，而错误信息只在 stderr 第一行，表现为「Inno
    解包永远失败」，没人想到是参数写错。

    参数构造与二进制是否存在无关。用假二进制（脚本）把 argv 记下来，
    就能在不装 innoextract 的机器上锁住这件事。
    """

    def _run_with_fake(self, script_body: str) -> tuple[list[str], bool, str]:
        """注入假 innoextract，返回 (收到的 argv, ok, detail)。"""
        from wepack.extract import _inno_extract, ExtractAttempt

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            record = root / "args.txt"
            fake = root / "innoextract"
            fake.write_text(
                "#!/bin/sh\n"
                f'printf "%s\\n" "$@" > {record}\n'
                + script_body,
                encoding="utf-8")
            fake.chmod(0o755)

            installer = root / "setup.exe"
            installer.write_bytes(fixtures.demo_inno().read_bytes())
            out_dir = root / "out"

            os.environ["WEXE_INNOEXTRACT"] = str(fake)
            try:
                attempt = ExtractAttempt(method="", ok=False, detail="")
                ok = _inno_extract(installer, out_dir, attempt)
            finally:
                os.environ.pop("WEXE_INNOEXTRACT", None)

            argv = (record.read_text(encoding="utf-8").splitlines()
                    if record.is_file() else [])
            return argv, ok, attempt.detail

    def test_args_contain_no_unsupported_flags(self) -> None:
        """不得出现 innoextract 1.9 不认识的选项。

        `--no-icon` 是真实踩过的坑：加上它之后参数解析失败，返回码 1，
        错误信息藏在 stderr 第一行，看起来像「安装包不支持」。
        """
        argv, _ok, _detail = self._run_with_fake("exit 0\n")
        self.assertNotIn("--no-icon", argv,
                         "--no-icon 在 innoextract 1.9 不存在，会让参数解析失败")
        # 只允许这三个已知选项
        flags = [a for a in argv if a.startswith("-")]
        for flag in flags:
            self.assertIn(flag, ("--silent", "-e", "-m", "-d"),
                          f"未知选项 {flag}")

    def test_args_include_required_flags(self) -> None:
        """`-e`（解应用文件）与 `-d`（指定目标目录）必须都在。

        少了 `-e` 只会解出安装器自己的临时文件；少了 `-d` 会解到当前
        工作目录，等于污染用户目录。
        """
        argv, _ok, _detail = self._run_with_fake("exit 0\n")
        self.assertIn("--silent", argv)
        self.assertIn("-e", argv)
        self.assertIn("-d", argv)
        # -d 后面必须跟一个目录
        index = argv.index("-d")
        self.assertLess(index + 1, len(argv), "-d 后面缺少目录参数")

    def test_nonzero_exit_is_reported_as_failure(self) -> None:
        """返回码非 0 必须如实判失败，不能因为解出了几个文件就算成功。"""
        argv, ok, detail = self._run_with_fake("exit 1\n")
        self.assertTrue(argv, "假二进制没被调用到")
        self.assertFalse(ok, "返回码 1 被当成了成功")
        self.assertIn("1", detail, "失败原因里应带上返回码")


class TestPeSectionGuard(unittest.TestCase):
    """7z 把 PE 容器切开的产物必须被拒绝。

    Inno Setup 的核心困境：唯一可靠的解包工具是 innoextract，而它没有
    macOS 官方二进制、brew 也可能装不上。此时 7z 是唯一退路，但它对
    Inno 只会按 PE 容器切开并**返回 0**。没有这道闸门，用户拿到的就是
    一堆 .text/.data/.rsrc —— 看起来解包成功了，实际一个应用文件都没有。
    """

    def test_all_sections_is_rejected(self) -> None:
        from wepack.extract import _reject_pe_sections

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            for name in (".text", ".data", ".rdata", ".rsrc",
                         ".reloc", "CERTIFICATE", "[0]"):
                (out / name).write_bytes(b"\x00" * 16)
            reason = _reject_pe_sections(out, Path("/nonexistent.exe"), _NoopTool())
            self.assertIsNotNone(reason, "清一色 PE 节区必须被拒绝")
            self.assertIn("PE 节区", reason)

    def test_real_payload_is_accepted(self) -> None:
        from wepack.extract import _reject_pe_sections

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            for name in ("app.exe", "readme.txt", ".text"):
                (out / name).write_bytes(b"\x00" * 16)
            reason = _reject_pe_sections(out, Path("/nonexistent.exe"), _NoopTool())
            self.assertIsNone(reason, "含真实文件名时不得拒绝")

    def test_two_stage_type_is_accepted(self) -> None:
        """7z 认出载荷时会打出两段 Type（PE + Nsis），此时不拦。"""
        from wepack.extract import _reject_pe_sections

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            for name in (".text", ".data"):
                (out / name).write_bytes(b"\x00" * 16)
            tool = _NoopTool(stdout="Type = PE\nType = Nsis\n")
            reason = _reject_pe_sections(out, Path("/nonexistent.exe"), tool)
            self.assertIsNone(reason, "7z 已识别出载荷格式时不得拒绝")


class _NoopTool:
    """假的 7z，只为让 _reject_pe_sections 能跑完而不真的执行命令。"""

    class _Result:
        def __init__(self, stdout: str) -> None:
            self.stdout = stdout
            self.stderr = ""
            self.returncode = 0

    def __init__(self, stdout: str = "Type = PE\n") -> None:
        self._stdout = stdout

    def run(self, args, timeout=0):  # noqa: ARG002
        return self._Result(self._stdout)


class TestRealMsi(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.sample = require_sample(sample_msi, "需要 WEXE_SAMPLE_MSI")

    def test_detect(self) -> None:
        detection = detect_installer(self.sample)
        self.assertEqual(detection.kind, InstallerKind.MSI)
        self.assertTrue(detection.supported)

    @unittest.skipUnless(have_7z(), "需要 7z")
    def test_extract_restores_names(self) -> None:
        from wepack.extract import extract
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            report = extract(self.sample, out)
            self.assertTrue(report.ok)
            # 应该还原出真实文件名，而不是只有 fil<hex>
            names = [p.name for p in out.rglob("*") if p.is_file()]
            real = [n for n in names if not n.startswith("fil") and "." in n]
            self.assertGreater(len(real), 10, "MSI 文件名未还原")

    def test_shortcut_table_parses(self) -> None:
        """Shortcut 表要能解析出「作者声明的启动目标」。

        这是入口定位的权威来源 —— 比按体积/架构猜可靠。实测 7-Zip 的
        Shortcut 表把入口明确写成 `[#_7zFM.exe]`。
        """
        tables = msi_tables.open_msi(self.sample)
        self.assertIn("Shortcut", tables.stream_map,
                      "Shortcut 表未被识别")

        items = msi_tables.shortcut_table(self.sample)
        self.assertTrue(items, "Shortcut 表解析为空")
        # 至少有一条指向文件（[#...]），而不是只打开目录
        self.assertTrue(any(x["target"].startswith("[#") for x in items),
                        f"没有指向文件的快捷方式：{items}")

    def test_shortcut_targets_resolve_to_real_files(self) -> None:
        targets = msi_tables.shortcut_targets(self.sample)
        self.assertTrue(targets, "Shortcut 目标解析为空")
        for item in targets:
            self.assertIn("relpath", item)
            self.assertTrue(item["relpath"], "relpath 为空")

    @unittest.skipUnless(have_7z(), "需要 7z")
    def test_shortcut_entry_beats_heuristic(self) -> None:
        """安装包声明的入口要能被取出来，且确实是 PE 文件。

        实测发现启发式与 Shortcut 表会给出**不同**答案：7-Zip 的
        首候选是 `7zG.exe`（体积更大），而作者声明的是 `7zFM.exe`。
        不要求两者一致，但声明值必须能落到真实可执行文件上。
        """
        from wepack.extract import extract
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            report = extract(self.sample, out)
            entry = report.result.shortcut_entry
            self.assertTrue(entry, "未从 Shortcut 表取出入口")

            path = out / entry
            self.assertTrue(path.is_file(), f"声明的入口不存在：{entry}")
            with path.open("rb") as handle:
                self.assertEqual(handle.read(2), b"MZ",
                                 f"声明的入口不是 PE：{entry}")

    def test_shortcut_skips_non_executable_target(self) -> None:
        """指向 .chm / .txt 的快捷方式不能被当成启动入口。

        7-Zip 有「7-Zip Help」指向 `7-zip.chm`。只看 target 前缀会把它
        当成入口，装出来的 .app 双击打开的是帮助文档。
        """
        targets = msi_tables.shortcut_targets(self.sample)
        chm = [t for t in targets if t["relpath"].lower().endswith((".chm", ".txt"))]
        # 目标列表本身允许包含它们（那是事实），但入口选取必须跳过 ——
        # 这条断言锁住「选取阶段有做 PE 校验」这一点
        from wepack.extract import _msi_shortcut_entry
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            (out / "files").mkdir()
            entry = _msi_shortcut_entry(self.sample, out)
            # 目录是空的，一个文件都不存在 → 不应返回任何入口
            self.assertEqual(entry, "")
            if chm:
                self.assertFalse(entry.lower().endswith((".chm", ".txt")))


class TestTools(unittest.TestCase):
    """工具探测必须验证"真的能跑"，不能只看文件存在。"""

    def test_shim_is_rejected(self) -> None:
        """转发壳（文件存在但执行返回 127）必须被拒绝。"""
        from wepack import tools
        with tempfile.TemporaryDirectory() as tmp:
            shim = Path(tmp) / "7zz"
            shim.write_text("#!/bin/sh\nexit 127\n", encoding="utf-8")
            shim.chmod(0o755)
            result = tools.find_tool("7z", required=False)
            # 环境里若真有可用 7z，则本次断言只验证 shim 不被优先选中
            if result is not None:
                self.assertNotEqual(result.path, shim)

    def test_env_override_wins(self) -> None:
        from wepack import tools
        with tempfile.TemporaryDirectory() as tmp:
            real = Path(tmp) / "my7z"
            real.write_text("#!/bin/sh\necho '7-Zip (z) 25.01'\nexit 0\n", encoding="utf-8")
            real.chmod(0o755)
            os.environ["WEXE_7Z"] = str(real)
            try:
                tool = tools.find_tool("7z", required=False)
                self.assertIsNotNone(tool)
                self.assertEqual(tool.path, real)
            finally:
                os.environ.pop("WEXE_7Z", None)

    def test_missing_required_raises_with_hint(self) -> None:
        from wepack import tools
        from wepack.errors import MissingDependency
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["WEXE_INNOEXTRACT"] = str(Path(tmp) / "nope")
            try:
                # 环境里没装 innoextract 时才应抛
                if tools.find_tool("innoextract", required=False) is None:
                    with self.assertRaises(MissingDependency) as ctx:
                        tools.find_tool("innoextract", required=True)
                    self.assertIn("innoextract", str(ctx.exception))
            finally:
                os.environ.pop("WEXE_INNOEXTRACT", None)

    def test_probe_all_covers_every_known_tool(self) -> None:
        """probe_all 必须覆盖 TOOL_CANDIDATES 的每一项，且字段齐全。

        这条是防漂移的：doctor 现在完全靠 probe_all 出检查项，早先两边
        各抄一份清单时，新增工具只改一边会让 doctor 声称「环境齐全」，
        实际跑起来才在解包阶段报缺依赖。漏改 TOOL_PURPOSE 则会让
        缺工具时的提示退化成「未安装（）」—— 括号里什么都没有。
        """
        from wepack import tools

        probes = tools.probe_all()
        self.assertEqual(set(probes), set(tools.TOOL_CANDIDATES))

        for name, probe in probes.items():
            with self.subTest(tool=name):
                self.assertEqual(
                    set(probe), {"ok", "path", "required", "purpose", "hint"})
                self.assertIn(name, tools.TOOL_PURPOSE,
                              f"{name} 缺 TOOL_PURPOSE，缺工具时的提示会没有用途说明")
                # ok 与 path 必须一致：有路径就是可用，没路径就是不可用
                self.assertEqual(probe["ok"], probe["path"] is not None)
                # 不可用时必须给得出安装命令
                if not probe["ok"]:
                    self.assertTrue(probe["hint"], f"{name} 缺失时没有安装提示")

    def test_probe_all_respects_required_override(self) -> None:
        """required_for 要能覆盖必需性，doctor 靠它区分 7z 与两个可选项。"""
        from wepack import tools

        probes = tools.probe_all(
            required_for={"7z": True, "innoextract": False, "msiextract": False})
        self.assertTrue(probes["7z"]["required"])
        self.assertFalse(probes["innoextract"]["required"])
        self.assertFalse(probes["msiextract"]["required"])
        # 不传时一律按必需
        self.assertTrue(tools.probe_all()["msiextract"]["required"])


class TestTextMode(unittest.TestCase):
    """子进程输出的解码必须容错。

    ## 为什么这组非有不可

    `text=True` 用 locale 编码解码、`errors='strict'`。只要有一个字节
    不是合法 UTF-8 就抛 `UnicodeDecodeError`，而这个异常会被外层当成
    「工具执行失败」，报出「7z 无法解包」这种完全错误的结论 —— 人会去
    查 7z 的安装，而真正的原因是输出里有坏字节。

    坏字节是常态而非意外：wine 用 cp1252/cp936 打印含中文的 Windows
    路径、某些 7z 本地化版本按系统代码页输出文件名、安装器把控制字符
    直接写进 stderr。
    """

    def test_bad_bytes_do_not_raise(self) -> None:
        """非 UTF-8 字节不能让整条链路崩掉。"""
        from wepack.tools import TEXT_MODE

        script = (
            "import sys; "
            "sys.stdout.buffer.write(b'\\xff\\xfe CJK: C:\\\\\\xd6\\xd0\\xce\\xc4'); "
            "sys.stdout.flush()"
        )
        result = subprocess.run([sys.executable, "-c", script],
                                capture_output=True, **TEXT_MODE)
        self.assertEqual(result.returncode, 0)
        # 坏字节变成替换字符，其余内容完整保留
        self.assertIn("CJK", result.stdout)
        self.assertIn("\ufffd", result.stdout)

    def test_good_bytes_pass_through(self) -> None:
        """合法的 UTF-8 不能被误伤 —— 中文要原样取回。"""
        from wepack.tools import TEXT_MODE

        script = "import sys; sys.stdout.buffer.write('中文路径'.encode('utf-8'))"
        result = subprocess.run([sys.executable, "-c", script],
                                capture_output=True, **TEXT_MODE)
        self.assertEqual(result.stdout, "中文路径")

    def test_no_bare_text_true_left(self) -> None:
        """
        源码里不许再出现裸 `text=True`。

        散落各处的裸 `text=True` 正是这组缺陷的来源形态 —— 修一处漏十处。
        用静态扫描守住：新增调用点必须走 TEXT_MODE。
        """
        offenders = []
        for path in (REPO / "wepack").rglob("*.py"):
            source = path.read_text(encoding="utf-8")
            for lineno, line in enumerate(source.splitlines(), 1):
                stripped = line.strip()
                # 注释里的说明文字不算
                if stripped.startswith("#") or stripped.startswith('"'):
                    continue
                if "text=True" in line and "**TEXT_MODE" not in line:
                    offenders.append(f"{path.relative_to(REPO)}:{lineno}")
        self.assertEqual(offenders, [],
                         "这些地方用了裸 text=True，必须改用 TEXT_MODE：" 
                         + ", ".join(offenders))


# --------------------------------------------------------------------------
# 安装失败时的错误信息可读性
# --------------------------------------------------------------------------


class TestStderrFilter(unittest.TestCase):
    """安装失败时，Wine 的图形层日志不能淹没真正的错误。

    实测背景：Bulk Rename Utility 静默安装失败，stderr 末尾 800 字节
    全是 `[mvk-info] GPU device:` 与 `VK_*` 扩展名。用户看到那一屏
    GPU 型号和着色器特性，得不到任何关于"为什么装不上"的信息。
    """

    def _filter(self, text):
        from wepack.cli import _meaningful_stderr
        return _meaningful_stderr(text)

    def test_vulkan_noise_is_dropped(self) -> None:
        noise = "\n".join([
            "[mvk-info] GPU device:",
            "\tmodel: Apple M4",
            "\ttype: Integrated",
            "\tvendorID: 0x106b",
            "\tGPU memory available: 12124 MB",
            "\tMetal Shading Language 3.1",
            "\t\tRead-Write Texture Tier 2",
            "\tThe following 145 Vulkan extensions are supported:",
            "\t\tVK_KHR_external_fence_capabilities v1",
            "Runtime error: install aborted",
        ])
        lines = self._filter(noise)
        self.assertEqual(lines, ["Runtime error: install aborted"])

    def test_pure_noise_says_so(self) -> None:
        """全是噪声时必须明说，不能让用户以为工具没输出。"""
        lines = self._filter("[mvk-info] GPU device:\n\tVK_KHR_x v1\n")
        self.assertEqual(len(lines), 1)
        self.assertIn("只有 Wine 图形层日志", lines[0])

    def test_truncated_extension_names_are_dropped(self) -> None:
        """被终端宽度截断的扩展名（丢了 VK_KH 前缀）也要过滤。

        实测里出现过 "XT_host_query_reset v1" —— 前缀被吃掉后不再以
        VK_ 开头，只按前缀判断就会漏掉这一行。
        """
        text = "XT_host_query_reset v1\nerror: install failed\nfmt v2\n"
        self.assertEqual(self._filter(text), ["error: install failed"])

    def test_empty_input(self) -> None:
        self.assertEqual(self._filter(""), ["(空)"])
        self.assertEqual(self._filter(None), ["(空)"])

    def test_keeps_tail_only(self) -> None:
        """有效行只保留最后若干条，避免刷屏。"""
        text = "\n".join(f"error line {i}" for i in range(40))
        lines = self._filter(text)
        self.assertEqual(len(lines), 12)
        self.assertEqual(lines[-1], "error line 39")


# --------------------------------------------------------------------------
# CLI 集成
# --------------------------------------------------------------------------


class TestFallbackProductGate(unittest.TestCase):
    """全盘兜底必须校验「文件名与产品名有关」。

    ## 这条锁住的是什么

    `_find_installed_entry` 的第 ② 步是「产品名匹配不到子目录时，从整层
    里再找找」。它调用 `rank_candidates(root, product_name=product)` 后
    **直接返回第一个不被排除的候选** —— 不看这个候选与产品名有没有关系。

    而产品名在打分里只值 +35 分。整层扫描时「在 Program Files 下 +25」
    「GUI +20」「有图标 +10」合计 55 分，足以让毫不相关的残留程序排第一。

    实测（本机 base 层真实内容，`Program Files/` 下）：

        产品名 Notepad             → Windows NT/Accessories/wordpad.exe
        产品名 TotallyDifferentApp → Windows NT/Accessories/wordpad.exe
        产品名 Zzzz                → Windows NT/Accessories/wordpad.exe

    三次返回同一个东西：产品名对兜底结果毫无影响。用户装 Notepad，得到
    写字板。这类错误不会报错、不会崩，只是安静地选中了错的程序 ——
    比崩溃更难发现。
    """

    def test_unrelated_filename_is_rejected(self) -> None:
        from wepack.cli import _filename_relates_to_product

        cases = [
            ("Windows NT/Accessories/wordpad.exe", "Notepad", False),
            ("Windows NT/Accessories/wordpad.exe", "TotallyDifferentApp", False),
            ("Windows NT/Accessories/wordpad.exe", "Zzzz", False),
            ("Internet Explorer/iexplore.exe", "Notepad", False),
            ("Mozilla Firefox/firefox.exe", "Notepad", False),
            ("RealApp/RealApp.exe", "Notepad", False),
        ]
        for rel, product, expect in cases:
            with self.subTest(rel=rel, product=product):
                self.assertEqual(
                    _filename_relates_to_product(rel, product), expect,
                    f"{rel} 配产品名 {product!r} 的判定不对")

    def test_related_filename_is_accepted(self) -> None:
        """真实产品形态都要能过闸，否则兜底等于关闭。

        覆盖几种不同的对应关系：完全同名、带目录前缀、产品名多词（取其中
        一段）、带后缀差异（`Notepad++`）、点号品牌（`.NET` → `dotnet`）。
        """
        from wepack.cli import _filename_relates_to_product

        cases = [
            ("App/App.exe", "App"),
            ("MyApp/bin/MyApp.exe", "MyApp"),
            ("Node.js/node.exe", "Node.js"),
            ("Chromium/chromium.exe", "Chromium"),
            ("Notepad++/notepad++.exe", "Notepad++"),
            ("Microsoft VS Code/Code.exe", "Microsoft Visual Studio Code"),
            ("Mozilla Firefox/firefox.exe", "Firefox"),
            ("dotnet/dotnet.exe", "Microsoft .NET Runtime"),
            ("7-Zip/7z.exe", "7-Zip"),
            ("7-Zip/7zFM.exe", "7z"),
        ]
        for rel, product in cases:
            with self.subTest(rel=rel, product=product):
                self.assertTrue(
                    _filename_relates_to_product(rel, product),
                    f"{rel} 配产品名 {product!r} 被误拒，兜底会漏掉它")

    def test_short_product_name_does_not_match_middle_substring(self) -> None:
        """两字符产品名不能靠**中间**子串匹配。

        `Pa` 出现在 `wordpad` 的中间。若判据用 `word in form`（任意子串），
        两字符的产品名会命中大量无关文件。只认前缀/后缀就不会。
        """
        from wepack.cli import _filename_relates_to_product

        self.assertFalse(
            _filename_relates_to_product(
                "Windows NT/Accessories/wordpad.exe", "Pa"),
            "两字符产品名靠中间子串匹配上了 wordpad")

    def test_empty_product_name_still_passes(self) -> None:
        """产品名为空时放行 —— 没有依据筛，保持旧行为。

        这条同时是兼容性保证：既有调用点若拿不到产品名（detect 失败、
        用户没给 app_name），兜底不能因为新闸门全部失配。
        """
        from wepack.cli import _filename_relates_to_product

        self.assertTrue(
            _filename_relates_to_product("Anything/x.exe", ""),
            "产品名为空时被拦，既有调用点会全部失配")

    def test_gate_is_wired_into_the_fallback(self) -> None:
        """闸门必须真的接在兜底路径上，不能只是定义了个函数。

        用临时 prefix 构造：`Program Files/` 下只有一个与本产品无关的
        exe，兜底应当返回 None 而不是那个 exe。
        """
        from wepack.cli import _find_installed_entry

        class _Detection:
            product_name = "Notepad"

        with tempfile.TemporaryDirectory() as tmp:
            private = Path(tmp)
            pf = private / "drive_c" / "Program Files" / "Unrelated"
            pf.mkdir(parents=True)
            (pf / "Unrelated.exe").write_bytes(build_min_pe(subsystem=2))

            self.assertIsNone(
                _find_installed_entry(private, _Detection(), "Notepad"),
                "兜底把一个与产品名无关的 exe 当成了安装入口")

    def test_gate_allows_a_real_match(self) -> None:
        """上一条的对照：有关联时必须找到，别把闸门做成关死。"""
        from wepack.cli import _find_installed_entry

        class _Detection:
            product_name = "MyTool"

        with tempfile.TemporaryDirectory() as tmp:
            private = Path(tmp)
            d = private / "drive_c" / "Program Files" / "SomethingElse"
            d.mkdir(parents=True)
            (d / "MyTool.exe").write_bytes(build_min_pe(subsystem=2))

            self.assertEqual(
                _find_installed_entry(private, _Detection(), "MyTool"),
                "drive_c/Program Files/SomethingElse/MyTool.exe")


class TestProductDirMatching(unittest.TestCase):
    """路径 ① 用产品名认领子目录时，必须**按词**比对，不能按字符。

    ## 这条锁住的是什么

    `_find_installed_entry` 的路径 ① 先枚举搜索根下的每个子目录，用
    `matches(目录名)` 判断它是不是本产品的目录，命中就把目录交给
    `best_candidate` 选主程序。原来的判据是：

        any(k in name.lower() or name.lower() in k for k in keywords)

    字符串子串没有词边界，短词会啃进长词中间。实测（本机 base 层真实
    目录名 + 常见产品名）：

        目录 Modem      产品名 mode    →  命中（`mode` 在 `modem` 中间）
        目录 Downloads  产品名 load    →  命中（`load` 在 `downloads` 中间）
        目录 appdata    产品名 App     →  命中（`app` 在 `appdata` 开头）

    前两例只是认领错目录，第三例更糟：`AppData/Local` 被当成产品目录后，
    `best_candidate` 会立刻返回里面的某个 exe。用户装一个叫 `App` 的
    程序，入口可能指向 appdata 里毫不相干的东西。

    ## 为什么词边界不伤真匹配

    真实的产品目录名与产品名总在**词**这一级对应：

        目录 Ondra    产品名 Ondra 1.2.3          正向（目录名是产品名一段）
        目录 App      产品名 App Installer        正向
        目录 Code     产品名 Visual Studio Code   反向（产品名包含目录名）
        目录 7-Zip    产品名 7-Zip 24.08          正向

    反向方向必须留着，否则 `Visual Studio Code` 装出来的 `Code/` 目录
    认不出来，路径 ① 全废 —— 而路径 ① 是 Electron 类安装器唯一能走通
    的路（它们忽略 NSIS 的 `/D=`，把应用装到 `AppData/Local/<产品名>`）。
    """

    def test_short_keyword_does_not_bite_into_longer_directory(self) -> None:
        """短词不能靠字符中间命中长目录名。"""
        from wepack.cli import _names_relate

        cases = [
            ("Modem", {"mode"}),
            ("Downloads", {"load"}),
            ("appdata", {"app"}),
            ("Program", {"pa"}),
            ("Wacmin", {"win"}),
        ]
        for name, keywords in cases:
            with self.subTest(name=name, keywords=keywords):
                self.assertFalse(
                    _names_relate(name, keywords),
                    f"目录 {name!r} 被产品名 {sorted(keywords)!r} 认领了 —— "
                    "路径 ① 会走进这个目录，best_candidate 立刻返回里面的 exe")

    def test_real_product_directories_still_match(self) -> None:
        """词边界不能把真实形态一起挡掉，否则路径 ① 等于关闭。"""
        from wepack.cli import _names_relate

        cases = [
            ("Ondra", {"ondra 1.2.3"}),          # 目录名是产品名的一段
            ("App", {"app installer"}),
            ("Code", {"visual studio code"}),    # 产品名包含目录名
            ("7-Zip", {"7-zip 24.08"}),
            ("notepad++", {"notepad++"}),
            ("Node.js", {"node.js"}),
            ("VLC", {"vlc media player"}),
            ("MyApp", {"myapp"}),
        ]
        for name, keywords in cases:
            with self.subTest(name=name, keywords=keywords):
                self.assertTrue(
                    _names_relate(name, keywords),
                    f"目录 {name!r} 配产品名 {sorted(keywords)!r} 被误拒")

    def test_unrelated_names_do_not_match(self) -> None:
        from wepack.cli import _names_relate

        cases = [
            ("Unrelated", {"notepad"}),
            ("Internet Explorer", {"notepad"}),
            ("Windows NT", {"notepad"}),
            ("Common Files", {"notepad"}),
        ]
        for name, keywords in cases:
            with self.subTest(name=name, keywords=keywords):
                self.assertFalse(_names_relate(name, keywords))

    def test_token_run_must_be_contiguous(self) -> None:
        """连续子段才有意义 —— 散落的词不算。

        `['zip', 'app']` 里两个词都在，但不相邻，不能算命中
        `['my', 'zip', 'app']` 之外的形态。
        """
        from wepack.cli import _contains_token_run

        self.assertTrue(_contains_token_run(
            ["my", "zip", "app"], ["zip", "app"]))
        self.assertFalse(_contains_token_run(
            ["zip", "x", "app"], ["zip", "app"]))
        self.assertFalse(_contains_token_run(["a"], ["a", "b"]))
        self.assertFalse(_contains_token_run(["a", "b"], []))

    def test_wrong_directory_does_not_hijack_the_entry(self) -> None:
        """端到端：路径 ① 不能因为字符子串而走进无关目录。

        构造 `Program Files/Modem/Modem.exe` 与
        `Program Files/MyApp/MyApp.exe`，产品名叫 `mode`。字符子串判据
        会把 `Modem` 当成产品目录并返回 `Modem.exe`；按词比对则不认。
        """
        from wepack.cli import _find_installed_entry

        class _Detection:
            product_name = "mode"

        with tempfile.TemporaryDirectory() as tmp:
            private = Path(tmp)
            pf = private / "drive_c" / "Program Files"
            (pf / "Modem").mkdir(parents=True)
            (pf / "Modem" / "Modem.exe").write_bytes(build_min_pe(subsystem=2))

            self.assertIsNone(
                _find_installed_entry(private, _Detection(), "mode"),
                "路径 ① 把 Modem/ 当成产品目录，入口指向了 Modem.exe")

    def test_appdata_does_not_match_app(self) -> None:
        """`appdata` 被产品名 `App` 认领是最隐蔽的一例。

        `AppData/Local` 是搜索根之一，若它的**子目录**（各应用的目录）
        又被 `app` 认领一片，兜底会返回完全无关的程序。这里直接锁判据，
        因为端到端构造要摆出一整棵 AppData 树，容易被后续改动绕过。
        """
        from wepack.cli import _names_relate

        self.assertFalse(_names_relate("appdata", {"app"}))
        self.assertFalse(_names_relate("AppData", {"app"}))
        # 真正的产品目录仍要认
        self.assertTrue(_names_relate("App", {"app"}))
        self.assertTrue(_names_relate("App Installer", {"app"}))


class TestCliPhase1(unittest.TestCase):
    def _run(self, *args: str) -> subprocess.CompletedProcess:
        env = dict(os.environ)
        env["PYTHONPATH"] = str(REPO)
        return subprocess.run([sys.executable, "-m", "wepack", *args],
                              cwd=str(REPO), capture_output=True, text=True, env=env)

    def test_detect_json_schema(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "setup.exe"
            path.write_bytes(build_min_pe(machine=0x14C, overlay=build_nsis_overlay()))
            result = self._run("detect", str(path), "--json")
            self.assertEqual(result.returncode, 0, result.stderr)
            import json
            payload = json.loads(result.stdout)
            for key in ("kind", "confidence", "evidence", "supported",
                        "silent_args", "unsupported_reason"):
                self.assertIn(key, payload)
            self.assertEqual(payload["kind"], "nsis")

    def test_detect_unknown_exits_4(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "x.exe"
            path.write_bytes(b"garbage")
            self.assertEqual(self._run("detect", str(path)).returncode, 4)

    def test_detect_unknown_report_says_unsupported_not_unimplemented(self) -> None:
        """无法识别时必须报 EOM_1005，不能报 EOM_7001。

        退出码 4 是「明确不支持」，7xxx 段是「还没做」。这两件事对用户的
        指引完全相反：前者该换个文件，后者该等新版本。修复前 detect 在
        返回 4 时没有自己写报告，落到 main 的兜底分支被统一标成 EOM_7001，
        于是「这个 exe 根本不是安装包」被说成「后续阶段才支持」。

        只断言退出码的测试发现不了这个问题 —— 退出码一直是对的。
        """
        import json
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "x.exe"
            path.write_bytes(b"garbage")
            result = self._run("detect", str(path), "--report")
            self.assertEqual(result.returncode, 4, result.stderr)

            report = json.loads(result.stdout)
            self.assertFalse(report["ok"])
            self.assertEqual(report["exitCode"], 4)
            self.assertEqual(report["error"]["code"], "EOM_1005")
            self.assertFalse(report["error"]["code"].startswith("EOM_7"),
                             "7xxx 段只表示「能力未实现」，不该用来描述不支持的输入")

            # 必须有一个阶段被标红，且挂的是同一个错误码。
            # 否则看板上会出现「阶段全绿但整体失败」，读者看不出断在哪。
            failed = [s for s in report["stages"] if s["status"] == "failed"]
            self.assertEqual(len(failed), 1, f"应恰有一个失败阶段，实际 {failed}")
            self.assertEqual(failed[0]["errorCode"], "EOM_1005")
            self.assertEqual(failed[0]["name"], "识别安装器",
                             "判断发生在识别阶段，标红应落在这一步")

    def test_extract_rejects_unsupported_kind(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "x.exe"
            path.write_bytes(b"garbage")
            out = Path(tmp) / "out"
            result = self._run("extract", str(path), "-o", str(out))
            self.assertEqual(result.returncode, 4)


if __name__ == "__main__":
    unittest.main(verbosity=2)