r"""DirectWrite 探针的守卫。

跑法：
    cd exeonmac && python3 -m unittest tests.test_dwrite_probe -v

## 这个模块守的是什么

`launcher` 的字体替换写两条注册表键（GDI 用 `HKLM\...\FontSubstitutes`，DirectWrite
用 `HKCU\Software\Wine\Fonts\Replacements`）。这条结论的唯一证据是一个只走
DirectWrite 的小探针 —— 它在第 13 轮是现场手搓在 `/tmp` 里的，跑完就没了。

那意味着两件事同时成立：结论没人能复核，而结论错了也没人会发现。本模块把它
收进仓库（`tools/dwrite-probe/`），并分三层守：

1. **槽位表**：`vtable.py` 从真实 SDK 的 `dwrite.h` 抽 vtable 槽位，抽法与快照对账。
   手写槽位下标算错时，症状是段错误或死循环 —— 读起来像「产品崩了」。
2. **静态**：`probe.c` 只许用 `vtable.h` 里的宏调槽位，不许出现裸数字。
3. **运行时**：真跑 wine，三组对照（都不写 / 只写 HKLM / 只写 HKCU）各跑一次探针，
   断言 DirectWrite 只在 HKCU 那组认得「微软雅黑」。

运行时那层要 base 层（382 MB）与 wine，缺了跳过 —— 但 `check_no_skips.py`
会把跳过判红，所以在本机与 CI 上它们都必须真跑。
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

import tests.fixtures as fixtures  # noqa: E402

PROBE_DIR = REPO / "tools" / "dwrite-probe"
VTABLE_JSON = PROBE_DIR / "vtable.json"
VTABLE_H = PROBE_DIR / "vtable.h"
PROBE_C = PROBE_DIR / "probe.c"


def load_runner():
    """导入 `tools/dwrite-probe/run.py`。

    ## 为什么不用 `import tools.dwrite_probe.run`

    目录名 `dwrite-probe` 带连字符，不是合法模块名 —— 有意为之：这个目录是工具，
    不是包，不该被 `import` 成产品代码。用 `spec_from_file_location` 显式加载，
    路径写在一处，将来挪目录只改这里。
    """
    import importlib.util

    path = PROBE_DIR / "run.py"
    spec = importlib.util.spec_from_file_location("dwrite_probe_run", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _write_reg(path: Path, sections: list[tuple[str, list[tuple[str, str]]]]) -> Path:
    """写一份「导出格式」的 .reg（UTF-16LE + BOM），与 launcher 的产出一致。"""
    lines = ["Windows Registry Editor Version 5.00", ""]
    for key, values in sections:
        lines.append(f"[{key}]")
        for name, value in values:
            lines.append(f'"{name}"="{value}"')
        lines.append("")
    text = "\r\n".join(lines) + "\r\n"
    path.write_bytes(b"\xff\xfe" + text.encode("utf-16-le"))
    return path


class TestVtableTable(unittest.TestCase):
    """槽位表必须由头文件生成，且抽法本身要被自检守住。"""

    def test_self_test_passes(self) -> None:
        """派生接口必须累计基接口的槽位。

        这是第 13 轮踩过的那个坑：`IDWriteFontFamily : public IDWriteFontList`，
        后者占 slot 3–5，所以 `GetFamilyNames` 是 **6** 不是 3。`--self-test`
        用一份合成的假头文件守住这条 —— 它不需要 SDK，所以任何机器上都会真跑。
        """
        result = subprocess.run(
            [sys.executable, str(PROBE_DIR / "vtable.py"), "--self-test"],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0,
                         f"vtable 自检失败：\n{result.stdout}\n{result.stderr}")
        self.assertIn("派生 DerivedFirst: 5", result.stdout,
                      "自检必须断言派生接口第一个方法在 slot 5（= 3 + 基接口 2 个）")

    def test_snapshot_matches_generated_header(self) -> None:
        """`vtable.h` 与 `vtable.json` 必须逐槽一致。

        两者都是生成的，但一个是给测试读的、一个是给编译器读的。只更新其中一份
        的话，探针会用旧槽位去调新头文件里的顺序 —— 编译照样过，运行时段错误。
        """
        table = json.loads(VTABLE_JSON.read_text(encoding="utf-8"))
        header = VTABLE_H.read_text(encoding="utf-8")
        macros = {m.group(1): int(m.group(2)) for m in
                  re.finditer(r"#define\s+(DW_\w+)\s+(\d+)", header)}
        self.assertTrue(macros, "vtable.h 里一个槽位宏都没有 —— 生成失败？")
        expected = {}
        for iface, entry in table.items():
            for method, slot in entry["slots"].items():
                expected[f"DW_{iface}_{method}"] = slot
        self.assertEqual(macros, expected,
                         "vtable.h 与 vtable.json 不一致；跑 --emit-c 重新生成")

    def test_family_names_slot_is_inherited(self) -> None:
        """`GetFamilyNames` 必须落在 6 且 `GetFontCount` 在 4 —— 继承关系的直接体现。"""
        table = json.loads(VTABLE_JSON.read_text(encoding="utf-8"))
        family = table["IDWriteFontFamily"]
        self.assertEqual(family["base"], "IDWriteFontList")
        self.assertEqual(family["slots"]["GetFontCount"], 4)
        self.assertEqual(family["slots"]["GetFamilyNames"], 6)
        self.assertEqual(family["slots"]["GetFirstMatchingFont"], 7)


class TestProbeSourceGuards(unittest.TestCase):
    """探针源码的静态守卫：槽位只许来自宏表，并且必须真查字形覆盖。"""

    def setUp(self) -> None:
        self.source = PROBE_C.read_text(encoding="utf-8")

    def test_every_vtable_call_uses_a_generated_macro(self) -> None:
        """`V(obj, slot)` 的第二个实参只许是 `DW_` 宏或函数参数 `slot`。

        裸数字是最危险的形态：`V(coll, 5)` 能编能跑，只是调错方法 —— 而错的方法
        签名不同，表现为崩溃或垃圾地址。本仓库不允许这种写法出现在探针里。
        """
        calls = re.findall(r"V\(\s*\w+\s*,\s*([^)]+)\)", self.source)
        self.assertGreaterEqual(len(calls), 10,
                                f"只找到 {len(calls)} 处 V 调用 —— 扫描口径不对？")
        bad = [c for c in calls if not (c.strip().startswith("DW_") or c.strip() == "slot")]
        self.assertEqual(bad, [], f"这些槽位不是宏：{bad}")

    def test_probe_checks_glyph_coverage_not_just_family_name(self) -> None:
        """必须查字形覆盖，不能只查「家族名解析得到」。

        ## 这是本轮的核心判据

        `FindFamilyName` 返回 true 只说明**名字**被登记了。`Replacements` 是别名
        语义：把一个没有中文字形的拉丁字体的名字登记成「微软雅黑」，名字照样查得到，
        界面照样方块。真正要证明的是「这张字模里有 U+4E2D 的字形」。

        所以探针必须走 `GetGlyphIndices`，且必须对中文码点断言下标非 0。
        """
        self.assertIn("DW_IDWriteFontFace_GetGlyphIndices", self.source,
                      "探针没有查字形下标 —— 只验名字会放过「别名指向无中文字形的字体」")
        self.assertIn("0x4E2D", self.source, "探针没有查 U+4E2D 的覆盖")
        # `.notdef` 判据：下标 0 是缺字，不是「查到但为空」。
        self.assertIn("glyph != 0", self.source,
                      "「有字形」的判据必须是下标非 0（0 是 .notdef 缺字框）")

    def test_build_script_does_not_depend_on_sdk_paths(self) -> None:
        """编译脚本不许写死 SDK 缓存路径。

        早先版本从 `~/Library/Caches/cargo-xwin/xwin/unpack/.../lib/um/x64` 取
        `dwrite.lib`。那是本机 cargo-xwin 的副产物，别人机器上没有 —— 写死它等于
        让这个工具只能在当前这台机器上编，clone 下来的人看到的是「缺 dwrite.lib」，
        很容易误判成缺组件。
        """
        script = (PROBE_DIR / "build.sh").read_text(encoding="utf-8")
        self.assertNotIn("unpack/Win11SDK", script,
                         "编译脚本又指回 SDK 缓存了；导入库应由 imports.*.def 现场生成")
        self.assertIn("/lib /machine:x64", script)
        self.assertTrue((PROBE_DIR / "imports.dwrite.def").is_file())
        self.assertTrue((PROBE_DIR / "imports.kernel32.def").is_file())


class TestDirectWriteRuntime(unittest.TestCase):
    """真跑 wine 的三组对照：DirectWrite 只认 HKCU 那条键。

    ## 为什么三组都要跑，而不是只跑「有效」那一组

    只跑 R 组（写 Replacements）能证明「写了就有效」，但证明不了「不写就无效」——
    而后者才是「必须再写一条键」的理由。三组齐跑才能把
    `FontSubstitutes` 对 DirectWrite 零作用这件事变成可复核的事实，
    而不是第 13 轮留在文档里的一句话。
    """

    @classmethod
    def setUpClass(cls) -> None:
        if not fixtures.wine_ready():
            raise unittest.SkipTest("本机无 wine 运行时")
        if not fixtures.base_layer_available():
            raise unittest.SkipTest("base 层未构建")
        if not (PROBE_DIR / "build" / "probe.exe").is_file():
            raise unittest.SkipTest("探针未编译（跑 tools/dwrite-probe/build.sh）")
        cls.tmp = Path(tempfile.mkdtemp(prefix="dwprobe-test-"))
        cls.reg_replacements = _write_reg(cls.tmp / "only-replacements.reg", [(
            r"HKEY_CURRENT_USER\Software\Wine\Fonts\Replacements",
            [("Microsoft YaHei", "PingFang SC")],
        )])
        cls.reg_substitutes = _write_reg(cls.tmp / "only-substitutes.reg", [(
            r"HKEY_LOCAL_MACHINE\Software\Microsoft\Windows NT\CurrentVersion\FontSubstitutes",
            [("Microsoft YaHei", "PingFang SC")],
        )])

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(getattr(cls, "tmp", cls.tmp), ignore_errors=True)

    def _run(self, group: str, reg: Path | None) -> dict:
        return load_runner().run_group(group, reg, keep_prefix=False)

    def test_baseline_does_not_know_the_name(self) -> None:
        """什么都不写：DirectWrite 的集合里没有「微软雅黑」，`PingFang SC` 在。

        后半句同样重要 —— 目标字体本来就在集合里，说明后续两组差别不是
        「找不到苹方」，而是「认不认那个 Windows 名字」。
        """
        result = self._run("N", None)
        self.assertTrue(result["ok"], f"探针没给出结论：{result.get('raw')}")
        self.assertEqual(result["familyCount"], 292,
                         "base 层的字体家族数变了；家族数变化会让下一条的差分成噪声")
        self.assertFalse(result["families"]["Microsoft YaHei"]["exists"])
        self.assertTrue(result["families"]["PingFang SC"]["exists"])

    def test_font_substitutes_alone_has_no_effect_on_directwrite(self) -> None:
        """只写 `HKLM\\...\\FontSubstitutes`：家族数仍 292、名字仍查不到。

        这是第 12 轮修法（GDI 那条）对现代软件零作用的直接证据。若哪天 wine 把
        两条路径合并，这条会红 —— 那就该重新评估还要不要写第二条键。
        """
        result = self._run("S", self.reg_substitutes)
        self.assertTrue(result["ok"], f"探针没给出结论：{result.get('raw')}")
        self.assertTrue(result["registry"]["system.reg"],
                        "本组的前提是「HKLM 里确实写进去了」，落盘检查失败则本组无意义")
        self.assertEqual(result["familyCount"], 292)
        self.assertFalse(result["families"]["Microsoft YaHei"]["exists"])

    def test_replacements_makes_the_name_resolve_with_chinese_glyphs(self) -> None:
        """只写 `HKCU\\Software\\Wine\\Fonts\\Replacements`：名字查得到、中文有字形。

        这是「两条键都要写」的正面证据，也是第 13 轮的结论。三件事同时断言：
        家族数 +1（别名多出一个家族）、名字 exists、以及 U+4E2D / U+9ED1 有字形。
        最后一条是本轮新增的 —— 只断前两条的话，别名指向一个没有中文字形的
        拉丁字体也会通过。
        """
        result = self._run("R", self.reg_replacements)
        self.assertTrue(result["ok"], f"探针没给出结论：{result.get('raw')}")
        self.assertTrue(result["registry"]["user.reg"],
                        "本组的前提是「HKCU 里确实写进去了」")
        self.assertEqual(result["familyCount"], 293)
        family = result["families"]["Microsoft YaHei"]
        self.assertTrue(family["exists"], "Replacements 写进去后 DirectWrite 应认得这个名字")
        self.assertEqual(family["faces"], 12,
                         "家族的字面数应为 12（与 PingFang SC 同一张字模）")
        self.assertEqual(family["glyphs"].get("U+4E2D"), "present",
                         "名字解析到了，但字模里没有 U+4E2D —— 别名指向了无中文字形的字体")
        self.assertEqual(family["glyphs"].get("U+9ED1"), "present")


if __name__ == "__main__":
    unittest.main()
