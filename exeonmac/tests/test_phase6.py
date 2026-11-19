"""阶段 6 验收测试：入口判据单一真源 + build 输出契约。

这两组测试都是**回归锁**，锁的是 2026-11-19 端到端实测中真实踩到的两个
缺陷。它们不是「顺手补的覆盖率」，每一条都能在修复前的 HEAD 上跑红。

## 缺陷一：install 与 package 各写了一套入口判据

实测（W02Probe 装到 `C:\\Wacmin\\w02\\`，同一份 prefix）：

    install  → drive_c/Wacmin/w02/W02Probe.exe       （对）
    package  → drive_c/Program Files/Windows NT/Accessories/wordpad.exe

根因：`package._guess_entry` 只在 `Program Files*` 下取打分最高的 exe。
base 层自带 `wordpad.exe`（55 分）永远第一，而用户程序在 `C:\\Wacmin\\`
下根本不在搜索范围内。后果是**装什么软件，打包出来都指向写字板**。

## 缺陷二：`build --json` 往 stdout 写了两段 JSON

`cmd_build` 把 `args.json` 透传给 `cmd_install` 与 `cmd_package`，两者各
自 `_emit` 一份，于是 stdout 上是两段拼接的 JSON。`json.load` 抛
`Extra data: line 50 column 1`，而 README 10.1 的契约是「stdout 只有
JSON，能直接交给 jq」。

跑法：
    cd exeonmac && python3 -m unittest tests.test_phase6 -v
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from wepack.models import Detection, InstallerKind  # noqa: E402


def _run(*args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PYTHONPATH"] = str(REPO)
    return subprocess.run([sys.executable, "-m", "wepack", *args],
                          cwd=str(REPO), capture_output=True, text=True, env=env)


def _write_pe(path: Path) -> None:
    """写一个带合法 PE 头的假 exe（打分器会看子系统与架构）。"""
    import struct

    path.parent.mkdir(parents=True, exist_ok=True)
    dos = bytearray(64)
    dos[0:2] = b"MZ"
    struct.pack_into("<I", dos, 0x3C, 64)
    coff = struct.pack("<HHIIIHH", 0x8664, 1, 0, 0, 0, 0xF0, 0x0022)
    opt = bytearray(0xF0)
    struct.pack_into("<H", opt, 0, 0x20B)     # PE32+
    struct.pack_into("<H", opt, 68, 2)        # Subsystem = GUI
    path.write_bytes(bytes(dos) + b"PE\0\0" + coff + bytes(opt) + b"\0" * 256)


class TestEntryJudgementSingleSource(unittest.TestCase):
    """`install` 与 `package` 必须用同一套判据找入口。"""

    def test_package_and_install_agree_on_wacmin_entry(self) -> None:
        """同一个 prefix，两条路径必须指向同一个 exe。

        这是缺陷一的直接回归锁：修复前 `package` 侧会返回 wordpad.exe，
        而 `install` 侧返回用户自己的程序 —— 两者不一致就是 bug。

        夹具刻意还原真实场景的两个关键特征：
          1. 用户程序在 `C:\\Wacmin\\<App>\\`（本工具默认安装位置）
          2. `Program Files\\Windows NT\\Accessories\\` 下有 base 层自带的
             wordpad.exe（打分器眼中的第一名）
        """
        from wepack.entry import find_installed_entry
        from wepack.package import _guess_entry

        with tempfile.TemporaryDirectory() as tmp:
            private = Path(tmp) / "Private"
            # ① 用户程序：默认安装位置
            _write_pe(private / "drive_c" / "Wacmin" / "MyProg" / "MyProg.exe")
            # ② base 层自带、打分更高的干扰项
            _write_pe(private / "drive_c" / "Program Files" / "Windows NT"
                      / "Accessories" / "wordpad.exe")
            _write_pe(private / "drive_c" / "Program Files" / "Internet Explorer"
                      / "iexplore.exe")

            detection = Detection(path=Path("/x.exe"), kind=InstallerKind.NSIS,
                                  confidence=0.9, product_name="MyProg")

            install_entry = find_installed_entry(private, detection, "MyProg")
            package_entry = _guess_entry(private, app_name="MyProg")

            self.assertIsNotNone(install_entry)
            self.assertEqual(
                install_entry, package_entry,
                f"install 与 package 的入口不一致：{install_entry} vs {package_entry}")
            self.assertIn("Wacmin/MyProg/MyProg.exe", install_entry)
            self.assertNotIn("wordpad", install_entry.lower())

    def test_package_never_falls_back_to_system_components(self) -> None:
        """没有用户程序时，宁可返回 None，也不能认领系统组件。

        修复前的 `_guess_entry` 在裸 prefix 上会返回 wordpad.exe —— 一个
        用户从没装过、也不该被当成入口的程序。返回 None 让调用方提示
        「用 --entry 指定」，比给出一个错的好。
        """
        from wepack.package import _guess_entry

        with tempfile.TemporaryDirectory() as tmp:
            private = Path(tmp) / "Private"
            _write_pe(private / "drive_c" / "Program Files" / "Windows NT"
                      / "Accessories" / "wordpad.exe")
            self.assertIsNone(
                _guess_entry(private, app_name="TotallyUnknownApp"),
                "没有匹配的程序时必须返回 None，不能拿系统组件凑数")

    def test_cli_module_reexports_the_same_functions(self) -> None:
        """`cli` 里的那几个下划线函数必须是 `entry` 模块的别名。

        迁到 `entry.py` 时保留了 `cli._find_installed_entry` 等旧名，让既有
        测试与调用点不用改。但**别名只能是同一个对象**，不能是复印一份 ——
        复印件就是第二套判据，正是这次要消灭的东西。
        """
        from wepack import cli, entry

        pairs = [
            ("_find_installed_entry", "find_installed_entry"),
            ("_names_relate", "names_relate"),
            ("_name_tokens", "name_tokens"),
            ("_contains_token_run", "contains_token_run"),
            ("_filename_relates_to_product", "filename_relates_to_product"),
        ]
        for cli_name, entry_name in pairs:
            self.assertIs(
                getattr(cli, cli_name), getattr(entry, entry_name),
                f"cli.{cli_name} 与 entry.{entry_name} 不是同一个对象，"
                f"说明又出现了一份副本")


class TestBuildJsonContract(unittest.TestCase):
    """`build --json` 的 stdout 必须是**一段**可解析的 JSON。"""

    def test_build_help_declares_actual_stages(self) -> None:
        """build 的帮助文本必须写清它实际做的三步，且声明不含 extract。

        早先写的是「detect → extract → install → package」，但 `cmd_build`
        从不调用 extract —— 静态解包是为「先看看里面有什么」准备的独立
        能力，安装不需要先解包。文档说四步、代码做三步，属于 §5.3 那类
        「同一件事两处各说一套」的漂移。
        """
        r = _run("build", "--help")
        self.assertEqual(r.returncode, 0, r.stderr)
        for stage in ("detect", "install", "package"):
            self.assertIn(stage, r.stdout, f"帮助里缺少实际上会执行的 {stage}")
        self.assertIn("不含 extract", r.stdout,
                      "帮助必须显式声明不含 extract，否则又与实现脱节")

    def test_build_json_is_single_document(self) -> None:
        """缺陷二的回归锁：stdout 只能有一段 JSON。

        用 `raw_decode` 而非 `json.load` 来判别段数 —— `json.load` 只会
        说「Extra data」，说不出到底多了一段还是格式坏了。
        """
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            # 垃圾安装包 → 退出码 4，但 stdout 仍必须是一段完整 JSON
            installer = tmp_path / "garbage.exe"
            installer.write_bytes(b"MZ" + b"\0" * 64)

            r = _run("build", str(installer), "-o", str(tmp_path / "out"), "--json")
            self.assertEqual(r.returncode, 4, r.stderr)

            decoder = json.JSONDecoder()
            text = r.stdout.strip()
            self.assertTrue(text, "stdout 不能为空")

            first, end = decoder.raw_decode(text)
            rest = text[end:].strip()
            self.assertEqual(
                rest, "",
                f"stdout 里还有第 {2} 段内容：{rest[:80]!r} —— "
                f"契约要求只有一段 JSON")
            self.assertFalse(first["ok"])
            self.assertEqual(first["exit_code"], 4)

    def test_build_payload_has_both_halves(self) -> None:
        """成功路径的汇总 JSON 必须同时含安装与装配两半的信息。

        早先两段 JSON 各含一半，调用方要自己拼。现在合在一处，
        但字段不能因此丢掉 —— 这条锁住键名。
        """
        from wepack import cli

        source = Path(cli.__file__).read_text(encoding="utf-8")
        # 汇总 payload 里必须出现这三个顶层键
        for key in ('"install":', '"package":', '"entry":'):
            self.assertIn(key, source, f"build 汇总输出缺少 {key} 字段")


if __name__ == "__main__":
    unittest.main()
