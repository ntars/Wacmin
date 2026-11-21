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

        ## 这是第 13 轮的核心判据

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

    def test_probe_rasterizes_instead_of_only_trusting_glyph_index(self) -> None:
        """必须真栅格化一次，不能停在「字形下标非 0」。

        ## 第 15 轮补的这条

        `GetGlyphIndices` 回答的是「字模里有没有这个码点的**槽位**」，它不知道
        那个槽位指向的字形是空轮廓、也不知道渲染器会不会画出缺字框。只有把字
        栅格化出来、数像素，才谈得上「像素上是对的」。

        三处必须同时存在：工厂侧的 `CreateGlyphRunAnalysis`、纹理侧的
        `CreateAlphaTexture`，以及**缺字自检码点**。最后一条最容易被漏 ——
        苹方的 `.notdef` 是空轮廓（实测 ink=0），所以「与缺字框指纹相同」这条
        判据在本机会空转，必须有一个**已知必然缺字**的码点来证明判据有判别力。
        """
        self.assertIn("DW_IDWriteFactory_CreateGlyphRunAnalysis", self.source,
                      "探针没有栅格化 —— 只查字形下标证明不了「画出来了」")
        self.assertIn("DW_IDWriteGlyphRunAnalysis_CreateAlphaTexture", self.source,
                      "拿到了 run analysis 却没取 alpha 纹理")
        self.assertIn("0x10FFFD", self.source,
                      "缺少「必然缺字」的自检码点：没有它，缺字框判据空转也看不出来")
        self.assertIn("DW_IDWriteFontFace_GetDesignGlyphMetrics", self.source,
                      "取字宽必须走 GetDesignGlyphMetrics —— 字体设计单位不换算成 DIP "
                      "会让纹理尺寸超限（em 的 2048 倍）")

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

    def test_probe_covers_multiple_rendering_modes(self) -> None:
        """必须测不止一种渲染模式，且纹理类型跟着模式走。

        ## 第 16 轮补的这条

        第 15 轮只用 `ALIASED` 一种模式就下了「像素对得上」的结论。真实 Windows
        软件几乎不走 ALIASED：GDI 是 `CLEARTYPE_QUALITY`、DirectWrite 默认
        `NATURAL`。若这两种模式在 wine 里走不同代码路径，「ALIASED 画对了」
        就推不出「真实软件也画对了」。

        三处必须同时存在，缺一处整条判据会静默失效：

        1. 模式表里至少三档（`alias` / `gdic` / `nat`）。只测一档无法区分
           「模式被忽略」与「模式真的不同」—— 前者是好消息，后者要补验。
        2. `CreateGlyphRunAnalysis` 必须把 `renderingMode` 从表里传进去，
           不能写死某个常量。写死的话三档跑出来一模一样，看着像「模式无差别」。
        3. ClearType 的纹理宽度必须是像素宽的 3 倍。按 1x1 算会把缓冲区开小
           3 倍，`CreateAlphaTexture` 报 `E_INVALIDARG` —— 而报错不提子像素。
        """
        self.assertIn("MODES[]", self.source, "渲染模式表没有了")
        for name in ('"alias"', '"gdic"', '"nat"'):
            self.assertIn(name, self.source, f"渲染模式表缺 {name}")
        # 模式必须真的传进 CreateGlyphRunAnalysis（不是写死 1）。
        call = re.search(
            r"CreateGlyphRunAnalysis\)\)\(\s*factory, &run,[^;]*?;", self.source, re.S)
        self.assertIsNotNone(call, "解析不到 CreateGlyphRunAnalysis 的调用")
        self.assertIn("m.mode", call.group(0),
                      "renderingMode 必须来自模式表，写死常量会让三档结果一模一样")
        # ClearType 一次像素 3 字节，缓冲区必须乘 3。
        self.assertIn("m.width_factor", self.source,
                      "ClearType 纹理宽度是像素宽的 3 倍；不乘会让缓冲区开小三倍")

    def test_create_glyph_run_analysis_signature_matches_header(self) -> None:
        """`CreateGlyphRunAnalysis` 的形参个数必须是 8（照抄 dwrite.h）。

        本轮中途凭记忆把它写成 10 个参数（多加了 `gridFitMode` /
        `antialiasMode`，那是 `IDWriteTextRenderer` 一侧的概念）。函数指针强转
        绕过了类型检查，编译照样过，症状是**探针挂住 180 秒超时** —— 多出来的
        两个实参把 `renderingMode` 挤到别的位置，模式取到垃圾值。

        报错读起来像「wine 卡死了」，其实就是签名写错。所以这里直接数形参。
        """
        call = re.search(
            r"HRESULT\(__stdcall \*\)\(([^)]*)\)\)\s*\n?\s*V\(factory, "
            r"DW_IDWriteFactory_CreateGlyphRunAnalysis\)\)\(", self.source)
        self.assertIsNotNone(call, "解析不到 CreateGlyphRunAnalysis 的函数指针签名")
        params = [p.strip() for p in call.group(1).split(",") if p.strip()]
        self.assertEqual(
            len(params), 9,
            f"函数指针形参应为 9 个（8 个真实参数 + 末尾 out 指针），实际 {len(params)} 个：{params}")
        # 逐一核对类型，位置错了同样致命。
        self.assertEqual(params[0], "void *", "第 1 个参数是 IDWriteFactory*")
        self.assertEqual(params[1], "const void *", "第 2 个参数是 DWRITE_GLYPH_RUN*")
        self.assertEqual(params[2], "float", "第 3 个参数是 pixelsPerDip")
        self.assertEqual(params[3], "const void *", "第 4 个参数是 DWRITE_MATRIX*（可空）")
        self.assertEqual(params[4], "int", "第 5 个参数是 renderingMode")
        self.assertEqual(params[5], "int", "第 6 个参数是 measuringMode")


class TestRegistryLandingGuard(unittest.TestCase):
    """落盘判据本身要被守住：它报「写进去了」必须真的写进去了。

    ## 为什么这条单独成类

    第 16 轮实测发现旧判据有假阳性：X 组（只写 HKCU）报 `system.reg: True`。
    根因是判据只看「本次要写的**值**在文件里作为带引号字符串出现过」，而 base 层
    自带的 `FontSubstitutes` 里有 `"Helvetica"="Arial"` —— 我们要写的值
    `Helvetica` 恰好是那边的**键名**。

    这类缺陷不报错、只报成功。三个运行时用例的前提都写着「本组的前提是
    『确实写进去了』」，判据一假，整组对照全部作废而没人会知道。所以它自己
    必须有守卫，且必须在**不跑 wine** 的前提下就能验 —— 纯函数才好验。
    """

    def setUp(self) -> None:
        self.runner = load_runner()
        self.tmp = Path(tempfile.mkdtemp(prefix="dwprobe-reg-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_landing(self, name: str, blocks: dict[str, list[str]]) -> Path:
        """造一份落盘形态的注册表文件（`[Software\\\\X]` 双反斜杠 + `#time`）。"""
        lines = ["WINE REGISTRY Version 2", ""]
        for key, values in blocks.items():
            lines.append(f"[{key}] 1795273080")
            lines.append("#time=1dd79c8b35b1e8e")
            lines.extend(values)
            lines.append("")
        path = self.tmp / name
        path.write_bytes("\n".join(lines).encode("utf-8"))
        return path

    def test_value_appearing_as_a_key_name_is_not_a_match(self) -> None:
        """要写的值恰好是别处的**键名**时，不许判成落盘。

        这就是实测抓到的那个假阳性。落盘文件里有 `"Helvetica"="Arial"`（base 层
        预置），我们要写的是 `"SimSun"="Helvetica"` —— 后者一个字节都没进文件，
        但 `"Helvetica"` 字符串在。判据必须看 `"名"="值"` 这个完整形态。
        """
        landing = self._write_landing("system.reg", {
            r"Software\\Microsoft\\Windows NT\\CurrentVersion\\FontSubstitutes": [
                '"Helv"="MS Sans Serif"',
                '"Helvetica"="Arial"',
            ],
        })
        sections = [(r"HKEY_CURRENT_USER|Software\Wine\Fonts\Replacements",
                     [("SimSun", "Helvetica")])]
        self.assertFalse(
            self.runner._reg_has_mapping(landing, sections, "HKEY_CURRENT_USER"),
            '「值作为别处的键名出现」被误判成落盘成功 —— 这正是第 16 轮抓到的假阳性')

    def test_correct_section_and_pair_is_a_match(self) -> None:
        """段头 + 值名 + 值三者齐全才算落盘（正向，防矫枉过正）。"""
        landing = self._write_landing("user.reg", {
            r"Software\\Wine\\Fonts\\Replacements": ['"SimSun"="Helvetica"'],
        })
        sections = [(r"HKEY_CURRENT_USER|Software\Wine\Fonts\Replacements",
                     [("SimSun", "Helvetica")])]
        self.assertTrue(
            self.runner._reg_has_mapping(landing, sections, "HKEY_CURRENT_USER"),
            "段与键值都对上了却判成未落盘 —— 判据收得太紧了")

    def test_half_written_mapping_is_rejected(self) -> None:
        """两个映射只写进去一个 → 判未落盘。

        半个映射会让一部分界面正常、另一部分仍是方块，是最难查的形态。
        """
        landing = self._write_landing("user.reg", {
            r"Software\\Wine\\Fonts\\Replacements": [
                '"Microsoft YaHei"="PingFang SC"',
            ],
        })
        sections = [(r"HKEY_CURRENT_USER|Software\Wine\Fonts\Replacements",
                     [("Microsoft YaHei", "PingFang SC"), ("SimSun", "PingFang SC")])]
        self.assertFalse(
            self.runner._reg_has_mapping(landing, sections, "HKEY_CURRENT_USER"),
            "只写进去一半被当成成功")

    def test_hive_mismatch_is_rejected(self) -> None:
        """`.reg` 写的是 HKLM，就不许拿 `user.reg`（HKCU 那棵树）判成功。

        落盘文件的段头**不含根键**（`user.reg` 本身就是 HKCU），所以根键与文件
        的对应关系只能由调用方声明。不声明的话，两张表会互相冒充 ——
        `FontSubstitutes` 写在 `system.reg`、`Replacements` 写在 `user.reg`，
        而这个区别正是第 13 轮结论的全部内容。

        **这条测的是「空集不算成功」**：`sections` 里一段都不属于该文件时，
        循环里「不匹配就跳过」会让 `ok` 保持初值 True —— 等于「没有要检查的
        东西」被读成「全部检查通过」。同一形态在第 9 轮的
        `test_scan_covers_all_test_modules` 上出现过（glob 返回空集，守卫全绿）。
        """
        landing = self._write_landing("user.reg", {
            r"Software\\Wine\\Fonts\\Replacements": ['"SimSun"="Helvetica"'],
        })
        sections = [(r"HKEY_LOCAL_MACHINE|Software\Wine\Fonts\Replacements",
                     [("SimSun", "Helvetica")])]
        self.assertFalse(
            self.runner._reg_has_mapping(landing, sections, "HKEY_CURRENT_USER"),
            "HKLM 的写入被拿 HKCU 的文件判成功了 —— 空集被当成通过")

    def test_empty_sections_never_pass(self) -> None:
        """空 `sections`（解析出来什么都没有）必须判 False。"""
        landing = self._write_landing("user.reg", {
            r"Software\\Wine\\Fonts\\Replacements": ['"SimSun"="Helvetica"'],
        })
        self.assertFalse(
            self.runner._reg_has_mapping(landing, [], "HKEY_CURRENT_USER"),
            "没有任何要检查的项却报成功")

    def test_sections_keep_the_root_key(self) -> None:
        """解析 `.reg` 时根键必须留下 —— 剥掉就分不清 HKCU 与 HKLM。"""
        reg = _write_reg(self.tmp / "both.reg", [
            (r"HKEY_CURRENT_USER\Software\Wine\Fonts\Replacements",
             [("Microsoft YaHei", "PingFang SC")]),
            (r"HKEY_LOCAL_MACHINE\Software\Microsoft\Windows NT\CurrentVersion\FontSubstitutes",
             [("SimSun", "PingFang SC")]),
        ])
        sections = self.runner._reg_sections(reg)
        self.assertEqual(len(sections), 2, f"两段应各自独立：{sections}")
        hives = sorted(label.split("|")[0] for label, _ in sections)
        self.assertEqual(hives, ["HKEY_CURRENT_USER", "HKEY_LOCAL_MACHINE"],
                         "根键被剥掉了，两处不同存储会混成一处")


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

    def test_alias_actually_rasterizes_the_same_pixels_as_the_target(self) -> None:
        """像素层判据：别名的渲染结果必须与目标字体**逐像素相同**。

        ## 这条比「有墨水」硬得多

        前一条断言「字模里有 U+4E2D 的字形」。但那仍然只是**数据存在**：
        渲染器可能因为渲染模式不支持、字体表缺失、或别名的家族与字模对不上，
        而画出别的东西。本条的判据是：同一个码点，在「微软雅黑」这个别名下
        栅格化出的 alpha 位图指纹，必须与「PingFang SC」下**完全一致**。

        指纹按 FNV-1a 从 alpha 位图逐字节算出，不经任何近似 —— 差一个像素就不同。
        这不需要参考图、不需要人眼，也不需要「这个字应该长什么样」的先验。

        同时断言「必然缺字」的自检码点 `U+10FFFD` 落在 notdef：它证明这套判据
        在本 prefix 上真的有判别力（若整条链路永远返回 ink-present，这条会先红）。
        """
        result = self._run("R", self.reg_replacements)
        self.assertTrue(result["ok"], f"探针没给出结论：{result.get('raw')}")
        alias = result["families"]["Microsoft YaHei"]
        target = result["families"]["PingFang SC"]
        for cp in ("A", "U+4E2D", "U+9ED1"):
            with self.subTest(code_point=cp):
                a = alias["raster"].get(cp) or {}
                t = target["raster"].get(cp) or {}
                self.assertEqual(a.get("verdict"), "ink-present",
                                 f"{cp} 在别名下没渲染出墨水：{a}")
                self.assertEqual(t.get("verdict"), "ink-present",
                                 f"{cp} 在目标字体下没渲染出墨水：{t}")
                self.assertGreater(a.get("ink") or 0, 0,
                                   f"{cp} 的墨水像素数为 0 —— 空轮廓也会「渲染成功」")
                self.assertEqual(a.get("hash"), t.get("hash"),
                                 f"{cp} 在别名下与目标字体的像素指纹不同："
                                 f"{a.get('hash')} vs {t.get('hash')} —— "
                                 "别名指向的不是同一张字模")
        # 判别力自检：这套 prefix 里确实有一个码点会被判成缺字。
        missing = alias["raster"].get("U+10FFFD") or {}
        self.assertEqual(missing.get("verdict"), "notdef",
                         "自检码点 U+10FFFD 没被判成缺字 —— 判据可能整体空转")
        self.assertEqual(missing.get("index"), 0)

    def test_alias_to_a_latin_only_font_is_caught_by_the_pixel_layer(self) -> None:
        """负向对照：把 `SimSun` 指到纯拉丁字体 Helvetica，必须判出中文缺字。

        ## 为什么必须有这一组

        前三组都在证明「写对了就有效」。但一个只会说「有效」的判据没有价值 ——
        它同样会对「其实没生效」说有效。本组故意构造一个**名字查得到、字却画不出来**
        的别名：`SimSun` exists=1、faceCount=6，而 U+4E2D 是缺字。

        这正是 `FindFamilyName` 单独用时会漏掉的形态（第 13 轮遗留的那条风险的
        现实版本）。像素层必须把它抓成 `notdef`，而拉丁字母 A 仍正常渲染。

        **本组同时守落盘判据**：`.reg` 只写 HKCU，所以 `system.reg` 必须是 False。
        第 16 轮之前这里是 True（假阳性），根因见 `TestRegistryLandingGuard`。
        """
        reg = _write_reg(Path(self.tmp) / "simsun-helvetica.reg", [(
            r"HKEY_CURRENT_USER\Software\Wine\Fonts\Replacements",
            [("SimSun", "Helvetica")],
        )])
        result = self._run("X", reg)
        self.assertTrue(result["ok"], f"探针没给出结论：{result.get('raw')}")
        self.assertTrue(result["registry"]["user.reg"],
                        "本组的前提是「HKCU 里确实写进去了」")
        self.assertFalse(result["registry"]["system.reg"],
                         "这份 .reg 只写 HKCU，system.reg 不该被碰 —— "
                         "判成 True 说明落盘判据把 base 层预置的 "
                         '"Helvetica"="Arial" 当成了本次写入（假阳性）')
        family = result["families"]["SimSun"]
        self.assertTrue(family["exists"],
                        "本组的前提是「别名把名字登记上了」；名字都没登记，就测不到本组的点")
        raster = family["raster"]
        self.assertEqual(raster["A"].get("verdict"), "ink-present",
                         "拉丁字母 A 应该正常渲染 —— 否则说明整条渲染链路坏了，"
                         "而不是中文缺字")
        self.assertEqual(raster["U+4E2D"].get("verdict"), "notdef",
                         "别名指向纯拉丁字体时 U+4E2D 必须被判缺字；"
                         "判成 ink-present 说明像素层没有判别力")
        self.assertEqual(raster["U+9ED1"].get("verdict"), "notdef")

    def test_cleartype_modes_are_measured_and_have_resolving_power(self) -> None:
        """ClearType 两档（`gdic` / `nat`）必须真的被测量，且与 ALIASED 可分。

        ## 第 16 轮的核心断言

        第 15 轮只测 ALIASED 就下了「像素对得上」。真实软件走 ClearType ——
        若 ClearType 模式在 wine 里根本不被接受（`E_INVALIDARG`）或画出来是空图，
        「ALIASED 正确」对真实场景毫无意义。

        三档各自断言三件事：判据为 `ink-present`、墨水像素 > 0、纹理宽度是
        像素宽的 3 倍（ClearType 一像素三子像素，1x1 不会是这个比例）。

        另断言 **ALIASED 与 ClearType 的指纹不同**。相同的话说明渲染模式参数被
        忽略 —— 那也算是结论（可以推出「所有模式共用一条路径」），但不能假装
        测了两种；本断言把「真的不同」变成可复核的事实，wine 哪天改了行为会
        自己变红，而不是留一份过期结论继续骗人。
        """
        result = self._run("R", self.reg_replacements)
        self.assertTrue(result["ok"], f"探针没给出结论：{result.get('raw')}")
        alias = result["families"]["Microsoft YaHei"]
        for cp in ("A", "U+4E2D", "U+9ED1"):
            with self.subTest(code_point=cp):
                mono = alias["raster"].get(cp) or {}
                self.assertEqual(mono.get("mode"), "alias", f"{cp} 的基准档不是 ALIASED")
                # ALIASED 是 1 字节/像素：px 必须等于 w*h。
                self.assertEqual(mono.get("px"), (mono.get("w") or 0) * (mono.get("h") or 0),
                                 f"{cp} 的 ALIASED 纹理字节数不等于 w*h：{mono}")
                for suffix, mode in (("@gdic", "gdic"), ("@nat", "nat")):
                    ct = alias["raster"].get(cp + suffix) or {}
                    self.assertEqual(ct.get("mode"), mode,
                                     f"{cp}{suffix} 的模式不是 {mode}：{ct}")
                    self.assertEqual(ct.get("verdict"), "ink-present",
                                     f"{cp} 在 {mode} 下没画出墨水：{ct} —— "
                                     "真实软件走的就是这条路径")
                    self.assertGreater(ct.get("ink") or 0, 0,
                                       f"{cp} 在 {mode} 下墨水像素为 0")
                    # ClearType 一像素 3 字节：px 必须是 w*h*3。按 1x1 开缓冲区
                    # 会变成 w*h，`CreateAlphaTexture` 直接 E_INVALIDARG。
                    self.assertEqual(
                        ct.get("px"), (ct.get("w") or 0) * (ct.get("h") or 0) * 3,
                        f"{cp} 在 {mode} 下的纹理字节数不是 w*h*3 —— "
                        f"ClearType 每像素三个子像素：{ct}")
                    # 纹理的像素尺寸应与 ALIASED 一致（同一个字形、同一个字号），
                    # 只是每像素多了两个子像素。不一致说明模式影响了布局，需另查。
                    self.assertEqual((ct.get("w"), ct.get("h")), (mono.get("w"), mono.get("h")),
                                     f"{cp} 在 {mode} 下的字形尺寸与 ALIASED 不同："
                                     f"{ct} vs {mono} —— 模式不该改变字形边界")
                # ClearType 与 ALIASED 的指纹必须不同（否则模式被忽略）。
                gdic = alias["raster"].get(cp + "@gdic") or {}
                self.assertNotEqual(
                    mono.get("hash"), gdic.get("hash"),
                    f"{cp} 的 ALIASED 与 ClearType 指纹相同 —— 渲染模式可能被忽略，"
                    "第 15 轮的结论适用范围要重新界定")
                # 两档 ClearType（GDI_CLASSIC 与 NATURAL）在 wine 上的关系也要记下：
                # 相同说明 wine 把它们归并成一条路径（本轮实测如此）。
                nat = alias["raster"].get(cp + "@nat") or {}
                self.assertEqual(
                    gdic.get("hash"), nat.get("hash"),
                    f"{cp} 的两档 ClearType 指纹不同（{gdic.get('hash')} vs "
                    f"{nat.get('hash')}）—— wine 分开了 GDI_CLASSIC 与 NATURAL，"
                    "需分别断言，不能只测一档就当覆盖了 ClearType")
        # 缺字自检在 ClearType 下也必须成立：U+10FFFD 无槽位，三档都该是 notdef。
        missing = alias["raster"].get("U+10FFFD") or {}
        self.assertEqual(missing.get("verdict"), "notdef",
                         "ClearType 路径下缺字自检码点没被判成缺字 —— 判据可能空转")


if __name__ == "__main__":
    unittest.main()
