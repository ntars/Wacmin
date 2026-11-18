"""阶段 0 验收测试。只用标准库 unittest，无第三方依赖。

跑法：
    cd ExeOnMac && python3 -m unittest discover -s tests -v
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
WEPACK = REPO / "bin" / "wepack"
SCHEMA = REPO / "schema" / "compat.schema.json"

sys.path.insert(0, str(REPO))
from wepack import PHASE  # noqa: E402


def run(*args: str, env: dict | None = None) -> subprocess.CompletedProcess:
    """调用 wepack，返回完整结果（含 stdout/stderr/exit code）。"""
    full_env = dict(os.environ)
    full_env["PYTHONPATH"] = str(REPO)
    if env:
        full_env.update(env)
    return subprocess.run(
        [sys.executable, "-m", "wepack", *args],
        cwd=str(REPO),
        capture_output=True,
        text=True,
        env=full_env,
    )


class TestCLIContract(unittest.TestCase):
    """命令行契约：帮助、版本、退出码。"""

    def test_help_lists_all_subcommands(self) -> None:
        r = run("--help")
        self.assertEqual(r.returncode, 0, r.stderr)
        for cmd in ("detect", "extract", "install", "package", "build",
                    "layers", "recipe", "doctor", "version"):
            self.assertIn(cmd, r.stdout, f"帮助里缺少子命令 {cmd}")

    def test_help_documents_exit_codes(self) -> None:
        r = run("--help")
        for code in ("3", "4", "5", "6", "7"):
            self.assertIn(code, r.stdout)

    def test_no_args_prints_help_and_exits_2(self) -> None:
        r = run()
        self.assertEqual(r.returncode, 2)
        self.assertIn("usage:", r.stdout)

    def test_version(self) -> None:
        r = run("version", "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        payload = json.loads(r.stdout)
        self.assertEqual(payload["phase"], PHASE)
        self.assertIn("wepack", payload)

    def test_unknown_subcommand_exits_2(self) -> None:
        r = run("frobnicate")
        self.assertEqual(r.returncode, 2)

    def test_subcommand_help_all_work(self) -> None:
        for cmd in ("detect", "extract", "install", "package", "build",
                    "layers", "recipe", "doctor"):
            r = run(cmd, "--help")
            self.assertEqual(r.returncode, 0, f"{cmd} --help 失败: {r.stderr}")
            self.assertIn("usage:", r.stdout)


class TestPhaseGuards(unittest.TestCase):
    """未实现的子命令必须明确报"未实现"，不能假装成功。"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="wepack-test-"))
        self.fake_exe = self.tmp / "setup.exe"
        self.fake_exe.write_bytes(b"MZ" + b"\x00" * 62)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_detect_implemented_returns_unsupported_for_garbage(self) -> None:
        """阶段 1 起 detect 已实现：垃圾文件应返回 4（不支持），不再是 3。"""
        r = run("detect", str(self.fake_exe), "--json")
        self.assertEqual(r.returncode, 4, r.stderr)
        payload = json.loads(r.stdout)
        self.assertFalse(payload["supported"])
        self.assertEqual(payload["kind"], "unknown")

    def test_extract_implemented_returns_unsupported_for_garbage(self) -> None:
        """阶段 1 起 extract 已实现：垃圾文件应返回 4（不支持）。"""
        r = run("extract", str(self.fake_exe), "-o", str(self.tmp / "out"), "--json")
        self.assertEqual(r.returncode, 4)

    def test_install_requires_wine_runtime(self) -> None:
        """阶段 2 起 install 已实现：缺 wine 时返回 5（缺依赖），不再是 3。"""
        r = run("install", str(self.fake_exe), "-o", str(self.tmp / "X (Win).app"), "--json",
                env={"WEXE_HOME": str(self.tmp / "wexe")})
        # 5 = 缺 wine；若环境里恰好有 wine 则可能是 4（垃圾安装包）
        self.assertIn(r.returncode, (4, 5), r.stderr)

    def test_package_rejects_non_app(self) -> None:
        r = run("package", str(self.tmp / "notanapp"), "--json")
        self.assertEqual(r.returncode, 2)
        self.assertIn(".app", json.loads(r.stdout)["error"])

    def test_package_missing_app(self) -> None:
        r = run("package", str(self.tmp / "Nope (Win).app"), "--json")
        self.assertEqual(r.returncode, 2)

    def test_detect_missing_file(self) -> None:
        r = run("detect", str(self.tmp / "ghost.exe"), "--json")
        self.assertEqual(r.returncode, 2)
        self.assertIn("不存在", json.loads(r.stdout)["error"])

    def test_layers_list_implemented(self) -> None:
        """阶段 2 起 layers list 已实现，应返回 0 并列出已知层。"""
        r = run("layers", "list", "--json", env={"WEXE_HOME": str(self.tmp / "wexe")})
        self.assertEqual(r.returncode, 0, r.stderr)
        payload = json.loads(r.stdout)
        names = {layer["name"] for layer in payload["layers"]}
        self.assertIn("base", names)

    def test_recipe_list_implemented(self) -> None:
        """阶段 5 起 recipe list 已实现，应返回 0 并给出配方库位置。"""
        with tempfile.TemporaryDirectory() as home:
            r = run("recipe", "list", "--json",
                    env={"WEXE_HOME": home, "WEXE_RECIPES": str(Path(home) / "recipes")})
            self.assertEqual(r.returncode, 0, r.stderr)
            payload = json.loads(r.stdout)
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["count"], 0)
            self.assertIn("root", payload)


class TestDoctor(unittest.TestCase):
    """doctor 必须真实反映环境，不能一律报 OK。"""

    def test_doctor_runs_and_reports_checks(self) -> None:
        with tempfile.TemporaryDirectory() as home:
            r = run("doctor", "--json", env={"WEXE_HOME": home})
            self.assertIn(r.returncode, (0, 5), r.stderr)
            payload = json.loads(r.stdout)
            names = {c["name"] for c in payload["checks"]}
            for expected in ("platform", "rosetta2", "python", "wine",
                             "sips", "iconutil", "7z", "wexe_home"):
                self.assertIn(expected, names)
            self.assertEqual(payload["phase"], PHASE)

    def test_doctor_creates_dirs_in_override_home(self) -> None:
        with tempfile.TemporaryDirectory() as home:
            run("doctor", "--json", env={"WEXE_HOME": home})
            self.assertTrue((Path(home) / "layers").is_dir())
            self.assertTrue((Path(home) / "runtime" / "wine").is_dir())
            self.assertTrue((Path(home) / "logs").is_dir())

    def test_doctor_does_not_create_real_home_when_overridden(self) -> None:
        """WEXE_HOME 覆盖时不应触碰真实目录。

        这条断言原来写的是 `self.assertEqual(real.exists(), before or True)`。
        `before or True` 恒等于 True，所以它实际在断言「真实目录必须存在」——
        与测试名和 docstring 说的正好相反。

        在开发机上它一直通过，因为 `~/Library/Application Support/wexe`
        早就被真实用过了；CI 是全新的 runner，那个目录不存在，于是
        `False != True`。这类「断言写成恒真式」的测试比没有测试更糟：
        它给出通过信号，却什么都没验。

        正确的做法是比对**前后状态**：跑完之后是否新增了真实目录。
        """
        real = Path.home() / "Library" / "Application Support" / "wexe"
        existed_before = real.exists()
        with tempfile.TemporaryDirectory() as home:
            run("doctor", "--json", env={"WEXE_HOME": home})
            existed_after = real.exists()

        if existed_before:
            # 本来就存在（开发机常见），无法据此判断是否被创建，
            # 但至少可以确认内容没有被写乱
            self.assertTrue(existed_after)
        else:
            self.assertFalse(
                existed_after,
                f"覆盖 WEXE_HOME 后仍创建了真实目录：{real}",
            )


class TestSchema(unittest.TestCase):
    """compat.yaml schema 必须合法且约束到位。"""

    def test_schema_is_valid_json(self) -> None:
        data = json.loads(SCHEMA.read_text(encoding="utf-8"))
        self.assertEqual(data["type"], "object")
        self.assertFalse(data["additionalProperties"])

    def test_schema_requires_core_fields(self) -> None:
        data = json.loads(SCHEMA.read_text(encoding="utf-8"))
        for field in ("app", "entry", "installer", "layers"):
            self.assertIn(field, data["required"])

    def test_schema_installer_enum_matches_model(self) -> None:
        sys.path.insert(0, str(REPO))
        from wepack.models import InstallerKind

        data = json.loads(SCHEMA.read_text(encoding="utf-8"))
        schema_kinds = set(data["properties"]["installer"]["properties"]["type"]["enum"])
        model_kinds = {str(k) for k in InstallerKind}
        self.assertEqual(schema_kinds, model_kinds)

    def test_example_from_spec_validates(self) -> None:
        """按仓库根 README.md 第 10.2 节的字段表做人工校验（不引 jsonschema 依赖）。"""
        sample = {
            "app": "微信",
            "version": "3.9.10",
            "entry": "drive_c/Program Files/Tencent/WeChat/WeChat.exe",
            "installer": {"type": "nsis", "silent_args": " /S",
                          "completed": True, "fallback_interactive": False},
            "layers": ["base", "vcpp", "fonts-cn"],
            "font_map": {"微软雅黑": "PingFang SC"},
            "file_associations": [],
            "known_issues": [],
            "bundle_id": "com.wexe.win.tencent.wechat",
            "icon_source": "exe:drive_c/Program Files/Tencent/WeChat/WeChat.exe#0",
        }
        data = json.loads(SCHEMA.read_text(encoding="utf-8"))
        self.assertEqual(set(sample) - set(data["properties"]), set())
        import re
        self.assertRegex(sample["entry"], data["properties"]["entry"]["pattern"])
        self.assertRegex(sample["bundle_id"], data["properties"]["bundle_id"]["pattern"])


class TestLauncherSkeleton(unittest.TestCase):
    """launcher 骨架必须能编译，且在缺依赖时明确报错而非静默。"""

    def test_swift_source_exists(self) -> None:
        self.assertTrue((REPO / "launcher" / "Sources" / "main.swift").is_file())
        self.assertTrue((REPO / "launcher" / "build.sh").is_file())

    @unittest.skipUnless(shutil.which("swiftc"), "需要 swiftc")
    def test_launcher_compiles(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "launcher"
            r = subprocess.run(["sh", str(REPO / "launcher" / "build.sh"), str(out)],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertTrue(out.is_file())
            self.assertTrue(os.access(out, os.X_OK))

    @unittest.skipUnless(shutil.which("swiftc"), "需要 swiftc")
    def test_launcher_outside_bundle_errors(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "launcher"
            subprocess.run(["sh", str(REPO / "launcher" / "build.sh"), str(out)],
                           capture_output=True, check=True)
            r = subprocess.run([str(out)], capture_output=True, text=True,
                               env={**os.environ, "WEXE_HOME": tmp})
            self.assertEqual(r.returncode, 1)
            self.assertIn(".app", r.stderr)

    @unittest.skipUnless(shutil.which("swiftc"), "需要 swiftc")
    def test_launcher_missing_runtime_errors(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            app = Path(tmp) / "7-Zip (Win).app"
            (app / "Contents" / "MacOS").mkdir(parents=True)
            (app / "Contents" / "Recipes").mkdir(parents=True)
            priv = app / "Contents" / "Resources" / "Private" / "drive_c" / "App"
            priv.mkdir(parents=True)
            (priv / "app.exe").write_bytes(b"MZ")
            (app / "Contents" / "Recipes" / "compat.yaml").write_text(
                "app: Test\nentry: drive_c/App/app.exe\n", encoding="utf-8")
            binary = app / "Contents" / "MacOS" / "launcher"
            subprocess.run(["sh", str(REPO / "launcher" / "build.sh"), str(binary)],
                           capture_output=True, check=True)
            r = subprocess.run([str(binary)], capture_output=True, text=True,
                               env={**os.environ, "WEXE_HOME": tmp})
            self.assertEqual(r.returncode, 1)
            self.assertIn("wine", r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)