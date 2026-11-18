"""统一报告的契约测试。

报告是前端汇总的唯一输入。这里守住三件事：码值前缀与段位正确、
ok 与 exitCode 一致、阶段状态机不留空白。
"""

from __future__ import annotations

import io
import json
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CONTRACTS = ROOT.parent / "contracts"

sys.path.insert(0, str(ROOT))

from wepack import PHASE, __version__  # noqa: E402
from wepack.errors import (  # noqa: E402
    ExitCode, InstallFailed, MissingDependency, PhaseNotImplemented,
    UnsupportedSoftware, UsageError, VerifyFailed,
)
from wepack.report import (  # noqa: E402
    DIRECTION, SCHEMA_VERSION, STAGES, StageTracker,
    error_code_for, failure_report, success_report,
)


def load_contract(name: str) -> dict:
    return json.loads((CONTRACTS / name).read_text(encoding="utf-8"))


class TestContractAlignment(unittest.TestCase):
    """报告结构与共享契约必须一致。"""

    def test_direction_matches_contract(self) -> None:
        prefixes = load_contract("error-prefixes.json")
        self.assertEqual(DIRECTION, "exeonmac")
        self.assertEqual(prefixes["prefixes"][DIRECTION], "EOM")

    def test_schema_version(self) -> None:
        self.assertEqual(SCHEMA_VERSION, 1)

    def test_stage_count(self) -> None:
        self.assertEqual(len(STAGES), 8)
        self.assertEqual(STAGES[0][0], "preflight")
        self.assertEqual(STAGES[-1][0], "verify")


class TestErrorCodes(unittest.TestCase):
    """错误码映射到正确的段位。"""

    def test_usage_error_is_1xxx(self) -> None:
        self.assertEqual(error_code_for(UsageError("x")), "EOM_1003")

    def test_unsupported_is_1xxx(self) -> None:
        self.assertEqual(error_code_for(UnsupportedSoftware("x")), "EOM_1005")

    def test_missing_dependency_is_2xxx(self) -> None:
        self.assertEqual(error_code_for(MissingDependency("x")), "EOM_2001")

    def test_install_failed_is_5xxx(self) -> None:
        self.assertEqual(error_code_for(InstallFailed("x")), "EOM_5001")

    def test_verify_failed_is_6xxx(self) -> None:
        self.assertEqual(error_code_for(VerifyFailed("x")), "EOM_6001")

    def test_not_implemented_is_7xxx(self) -> None:
        self.assertEqual(error_code_for(PhaseNotImplemented("x", 3)), "EOM_7001")

    def test_unknown_is_9999(self) -> None:
        self.assertEqual(error_code_for(RuntimeError("x")), "EOM_9999")

    def test_all_codes_use_direction_prefix(self) -> None:
        cases = [
            UsageError("x"), UnsupportedSoftware("x"), MissingDependency("x"),
            InstallFailed("x"), VerifyFailed("x"), PhaseNotImplemented("x", 3),
            RuntimeError("x"),
        ]
        for exc in cases:
            code = error_code_for(exc)
            self.assertTrue(code.startswith("EOM_"), f"{type(exc).__name__} → {code}")

    def test_all_codes_use_defined_segment(self) -> None:
        segments = set(load_contract("error-prefixes.json")["segments"])
        cases = [
            UsageError("x"), UnsupportedSoftware("x"), MissingDependency("x"),
            InstallFailed("x"), VerifyFailed("x"), PhaseNotImplemented("x", 3),
            RuntimeError("x"),
        ]
        for exc in cases:
            code = error_code_for(exc)
            bucket = f"{code[-4]}000"
            self.assertIn(bucket, segments, f"{code} 的段位 {bucket} 未定义")


class TestStageTracker(unittest.TestCase):
    """阶段状态机。"""

    def test_enter_leave_marks_ok(self) -> None:
        tracker = StageTracker()
        tracker.enter("detect")
        tracker.leave("detect")
        stage = next(s for s in tracker.to_stages() if s["name"] == "识别安装器")
        self.assertEqual(stage["status"], "ok")
        self.assertGreaterEqual(stage["durationMs"], 0)

    def test_untouched_stages_are_skipped(self) -> None:
        tracker = StageTracker()
        tracker.enter("detect")
        tracker.leave("detect")
        stages = tracker.to_stages()
        self.assertEqual(len(stages), 8)
        self.assertEqual(stages[0]["status"], "skipped")

    def test_mark_failed_records_code(self) -> None:
        tracker = StageTracker()
        tracker.enter("install")
        tracker.mark_failed("EOM_5001")
        stage = next(s for s in tracker.to_stages() if s["name"] == "静默安装")
        self.assertEqual(stage["status"], "failed")
        self.assertEqual(stage["errorCode"], "EOM_5001")

    def test_skip_is_explicit(self) -> None:
        tracker = StageTracker()
        tracker.skip("extract")
        stage = next(s for s in tracker.to_stages() if s["name"] == "静态解包")
        self.assertEqual(stage["status"], "skipped")


class TestReports(unittest.TestCase):
    """报告结构与契约字段。"""

    def test_success_report_fields(self) -> None:
        tracker = StageTracker()
        report = success_report(
            tracker=tracker, artifact="/tmp/X (Win).app",
            artifact_bytes=1024, command="install",
        )
        self.assertTrue(report["ok"])
        self.assertEqual(report["exitCode"], 0)
        self.assertIsNone(report["error"])
        self.assertEqual(report["schemaVersion"], 1)
        self.assertEqual(report["direction"], "exeonmac")
        self.assertEqual(report["artifacts"][0]["kind"], "mac-app")
        self.assertEqual(len(report["stages"]), 8)

    def test_failure_report_marks_first_stage(self) -> None:
        report = failure_report(
            tracker=StageTracker(), code="EOM_1003",
            message="文件不存在", exit_code=2,
        )
        self.assertFalse(report["ok"])
        self.assertEqual(report["exitCode"], 2)
        self.assertEqual(report["stages"][0]["status"], "failed")
        self.assertEqual(report["stages"][0]["errorCode"], "EOM_1003")
        self.assertEqual(report["stages"][1]["status"], "skipped")

    def test_failure_report_hint_nullable(self) -> None:
        report = failure_report(
            tracker=StageTracker(), code="EOM_9999",
            message="x", exit_code=1,
        )
        self.assertIsNone(report["error"]["hint"])
        self.assertEqual(report["error"]["details"], [])

    def test_ok_equals_exit_code_zero(self) -> None:
        """契约要求 ok === (exitCode == 0)，两条路径都不能破。"""
        ok = success_report(tracker=StageTracker(), artifact=None)
        bad = failure_report(
            tracker=StageTracker(), code="EOM_1003", message="x", exit_code=2,
        )
        self.assertEqual(ok["ok"], ok["exitCode"] == 0)
        self.assertEqual(bad["ok"], bad["exitCode"] == 0)


class TestCliReportFlag(unittest.TestCase):
    """--report 的对外行为。"""

    def run_cli(self, *args: str) -> subprocess.CompletedProcess:
        # bin/wepack 是 shell 包装脚本，用 -m 走模块入口更稳（不依赖可执行位）。
        return subprocess.run(
            [sys.executable, "-m", "wepack", *args],
            capture_output=True, text=True, timeout=120, cwd=str(ROOT),
        )

    def test_version_report_is_pure_json(self) -> None:
        result = self.run_cli("version", "--report")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["direction"], "exeonmac")
        self.assertTrue(payload["ok"])

    def test_detect_missing_file_report(self) -> None:
        result = self.run_cli("detect", "/tmp/definitely-ghost.exe", "--report")
        self.assertEqual(result.returncode, 2)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["exitCode"], 2)
        self.assertTrue(payload["error"]["code"].startswith("EOM_1"))

    def test_report_stdout_contains_only_json(self) -> None:
        """人类可读文本必须落到 stderr，stdout 只有 JSON。"""
        result = self.run_cli("version", "--report")
        self.assertNotIn("phase", result.stdout)
        json.loads(result.stdout)

    def test_legacy_json_unchanged(self) -> None:
        """原有 --json 结构不能被改动，119 项测试依赖它。"""
        result = self.run_cli("version", "--json")
        payload = json.loads(result.stdout)
        self.assertIn("wepack", payload)
        self.assertIn("phase", payload)
        self.assertEqual(payload["phase"], PHASE)
        self.assertEqual(payload["wepack"], __version__)


class TestEmitReportStream(unittest.TestCase):
    """`_emit_report` 必须写进真 stdout，而不是改道期间的 sys.stdout。

    ## 为什么这条单独测

    这个函数早先把流写死成 `sys.stdout`。报告总是在 `_StdoutToStderr`
    改道**期间**产出，此刻 `sys.stdout` 已经是 stderr —— 于是每个子命令
    都手抄一遍 `json.dump(..., _out())` + `write("\\n")`，函数本身成了全仓
    零调用点的摆设。收到 `_out()` 之后它才有资格被调用。

    端到端断言（子进程里跑 `--report` 看 stdout 是否纯净）能发现症状，
    但定位不到具体函数。这一条直接盯住那个约定。
    """

    def test_writes_to_real_stdout_during_redirection(self) -> None:
        """改道期间报告只进 _out()，一个字节都不漏进 sys.stdout。

        ## 为什么必须替换模块级 `_REAL_STDOUT` 而不是 `sys.stdout`

        `_REAL_STDOUT` 在**模块导入时**就绑定了进程真正的 stdout，这是
        刻意的：`_StdoutToStderr` 只临时改 `sys.stdout`，不该影响"真
        stdout 是谁"这个判断。所以单测里替换 `sys.stdout` 是无效的 ——
        报告照样写进真终端（第一版测试就是这么写的，JSON 直接打到屏幕上
        而断言拿到空串）。要验证这个约定，只能替换那个模块常量。
        """
        from wepack import cli

        real = io.StringIO()
        stray = io.StringIO()
        original_stdout = sys.stdout
        original_real = cli._REAL_STDOUT
        sys.stdout = real
        cli._REAL_STDOUT = real
        try:
            with cli._StdoutToStderr(real):
                # 模拟改道：此刻 sys.stdout 指向别处，_out() 仍应给 real
                sys.stdout = stray
                cli._emit_report({"ok": True, "probe": 1})
        finally:
            sys.stdout = original_stdout
            cli._REAL_STDOUT = original_real

        payload = json.loads(real.getvalue())
        self.assertEqual(payload, {"ok": True, "probe": 1})
        self.assertEqual(stray.getvalue(), "")

    def test_coerces_to_json_with_trailing_newline(self) -> None:
        """结尾要有换行，否则 `| jq` 之后终端提示符会粘在最后一个括号上。"""
        from wepack.cli import _emit_report

        buf = io.StringIO()
        _emit_report({"a": 1}, stream=buf)
        self.assertTrue(buf.getvalue().endswith("}\n"))
        # 中文不能被转成 \uXXXX —— 报告要给人看得懂
        buf2 = io.StringIO()
        _emit_report({"名称": "测试"}, stream=buf2)
        self.assertIn("测试", buf2.getvalue())

    def test_explicit_stream_argument_wins(self) -> None:
        """传了 stream 就用它，供 main() 在改道结束后补写。"""
        from wepack.cli import _emit_report

        buf = io.StringIO()
        _emit_report({"b": 2}, stream=buf)
        self.assertEqual(json.loads(buf.getvalue()), {"b": 2})


class TestMissingArgumentReport(unittest.TestCase):
    """缺少必需位置参数时，--report 仍必须输出合规报告。

    ## 为什么需要这组测试

    argparse 遇到「缺少必需位置参数」会直接 `error()` → 打印用法到 stderr
    → `SystemExit(2)`，整个过程发生在 main 里 `--report` 判定之前。于是
    `wepack detect --report`（漏了路径）stdout 完全是空的。

    这违反契约：`--report` 模式下**任何**结局都必须有一份报告 JSON，
    否则 console 拿到空输入只能显示「未知错误」，用户看不出是漏了参数。

    修复靠 `_ReportAwareParser` 覆写 `error()`。子 parser 会继承父
    parser 的类，所以覆写对全部子命令同时生效，不需要逐个传 parser_class。
    """

    def run_cli(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-m", "wepack", *args],
            capture_output=True, text=True, timeout=120, cwd=str(ROOT),
        )

    def test_each_subcommand_emits_report_without_args(self) -> None:
        """每个需要位置参数的子命令，漏参数时都要吐报告。"""
        for command in ("detect", "extract", "install", "package"):
            with self.subTest(command=command):
                result = self.run_cli(command, "--report")
                self.assertEqual(result.returncode, 2, result.stderr)

                # stdout 必须能解析成 JSON —— 空字符串过不了这一关
                payload = json.loads(result.stdout)
                self.assertEqual(payload["direction"], "exeonmac")
                self.assertFalse(payload["ok"])
                self.assertEqual(payload["exitCode"], 2)
                self.assertEqual(payload["command"], command)
                # 契约：ok === (exitCode === 0)
                self.assertEqual(payload["ok"], payload["exitCode"] == 0)
                # 缺参数属于「环境与输入」段位
                self.assertRegex(payload["error"]["code"], r"^EOM_1\d{3}$")
                # 人读提示仍走 stderr（argparse 自己打的是英文 usage:）
                self.assertIn("usage", result.stderr)

    def test_no_report_flag_keeps_plain_usage(self) -> None:
        """不带 --report 时保持 argparse 原本的行为，不能吐出 JSON。"""
        result = self.run_cli("detect")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "", "stdout 不该有内容")
        self.assertIn("usage", result.stderr)


if __name__ == "__main__":
    unittest.main()
