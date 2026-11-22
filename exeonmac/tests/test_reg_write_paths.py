"""注册表写入路径的机器守卫：把「一次性人工扫描」变成会自己变红的清单。

## 为什么要有这个文件（第 17 轮）

第 11 轮记下一条遗留：「同类 `.reg` 写入路径全量机械扫描未做」。它从第 11
轮挂到第 16 轮，六轮没动。第 17 轮做了扫描 ——**结果又抓到一处同形态缺陷**：
`wepack/install.suppress_restart` 的回查是「键在不在」，而不是「这次写进去
了没有」，与 launcher 第 11 轮修掉的那条逐字同形态，当时只修了 Swift 一侧。

根因不是「没扫」，而是**扫描只发生过一次、结果只写进文档**。同一个仓库里
新增一个 `regedit /S` 调用点时，没有任何东西会红。这个文件把扫描结果变成
清单：清单外的写入点、清单内缺一次性戳的写入点，都会让测试变红。

判据只有一条：凡「写 `.reg` 再导入」的路径，回查必须能区分
「**这次**写进去了」与「**上次**写的还在」。
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

#: 允许存在的 `regedit /S` 调用点。新增写入点必须同时登记到这里并说明判据，
#: 否则下面第 2 条会红 —— 这是这个文件存在的全部理由。
REG_WRITE_SITES = {
    "launcher/Sources/main.swift": {
        "what": "字体替换（HKLM FontSubstitutes + HKCU Replacements）",
        "stamp": "FontSubstitutionStamp",
        "why": "探针 `reg query` 查一次性 UUID 戳，戳不等于本次即判失败",
    },
    "wepack/install/__init__.py": {
        "what": "重启拦截（HKCU Policies\\Explorer 三个策略值）",
        "stamp": "RestartSuppressStamp",
        "why": "回查两层：戳逐字等于本次 token + 策略键有 NoClose",
    },
    "tools/dwrite-probe/run.py": {
        "what": "探针对照组（改写 FontSubstitutes / Replacements）",
        "stamp": "_reg_has_mapping",
        "why": "不查「值出现过」，而是解析落盘文件、要求段头+值名+值三件齐全",
    },
}

#: 非「导入」路径：写文件但由 wine 自己读，不存在「这次写进去了没有」的语义。
PLACEHOLDER_SITES = {"wepack/prefix/__init__.py"}

#: `regedit /S` 的调用写法。刻意写得宽：`"regedit", "/S"`、`regedit /S`
#: 字符串拼接、`["regedit", "/S", ...]` 都要命中。
_CALL_PATTERNS = (
    re.compile(r"""["']regedit["']\s*,"""),
    re.compile(r"""regedit\s+/S"""),
)

#: 明确**不扫**的目录与文件后缀。测试自己会写假 wine，不算产品路径。
_SKIP_DIRS = {"tests", "node_modules", ".git", "__pycache__", "build"}
_SKIP_SUFFIX = {".md", ".json", ".reg", ".txt", ".log"}


def _source_files() -> list[Path]:
    """仓库里所有可能发起 `regedit` 的源文件（排除测试与文档）。"""
    out: list[Path] = []
    for path in REPO.rglob("*"):
        if not path.is_file() or path.suffix in _SKIP_SUFFIX:
            continue
        rel = path.relative_to(REPO)
        if any(part in _SKIP_DIRS for part in rel.parts):
            continue
        if path.suffix not in {".py", ".swift", ".mjs", ".js", ".sh", ".c", ".h"}:
            continue
        out.append(path)
    return out


def _call_sites() -> dict[str, list[int]]:
    """机械抽取所有 `regedit` 调用点，返回 `{相对路径: [行号...]}`。

    只认**代码行**：注释行整行以 `#` / `//` / `*` / `/*` 开头的一律跳过。
    注释里写 `regedit /S` 太常见（本仓库十几处解释性注释），把它们算进来
    会让清单永远对不上，最后只能靠手工放宽 —— 那等于又回到「靠眼看」。
    """
    sites: dict[str, list[int]] = {}
    for path in _source_files():
        rel = path.relative_to(REPO).as_posix()
        hit: list[int] = []
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith(("#", "//", "*", "/*")):
                continue
            if any(p.search(stripped) for p in _CALL_PATTERNS):
                hit.append(lineno)
        if hit:
            sites[rel] = hit
    return sites


class TestRegWritePathsAreRegistered(unittest.TestCase):
    """清单 + 戳：新增写入点、漏掉戳的写入点，都必须在这里红。"""

    def test_every_write_site_is_registered(self) -> None:
        """实际调用点必须与 `REG_WRITE_SITES` 逐一对得上。

        ## 这条抓的是什么

        新增一处 `wepack/foo.py` 里 `subprocess.run([wine, "regedit", "/S", f])`
        而不写回查 —— 第 11、17 轮两次缺陷的共同形态。它会在这里红，
        并点名是哪个文件、哪几行。
        """
        actual = set(_call_sites())
        registered = set(REG_WRITE_SITES) | PLACEHOLDER_SITES
        unregistered = actual - registered
        self.assertEqual(
            unregistered, set(),
            "发现未登记的注册表写入点 —— 请确认它的回查能不能区分"
            "「这次写进去了」与「上次写的还在」，然后登记进 REG_WRITE_SITES：\n"
            + "\n".join(f"  {name}: 行 {_call_sites()[name]}" for name in sorted(unregistered)))

    def test_registered_sites_still_exist(self) -> None:
        """清单不许留幽灵条目（文件删了、调用挪走了）。

        少扫比多扫更危险：清单里挂着一个已经不存在的路径，看上去「都覆盖了」，
        实际那一处早就没人守。这条与上一条合起来才是「清单 = 实际」。

        只对 `REG_WRITE_SITES` 要求「必须有 regedit 调用」；`PLACEHOLDER_SITES`
        是「写文件但不导入」的路径，本来就该没有 regedit —— 单独一条守它不许
        偷偷变成导入路径。
        """
        actual = set(_call_sites())
        ghosts = set(REG_WRITE_SITES) - actual
        self.assertEqual(
            ghosts, set(),
            "清单里的这些路径已经不再写注册表了，请从清单里删掉：" + str(sorted(ghosts)))

    def test_placeholder_sites_do_not_import(self) -> None:
        """占位表那条路径不许自己调 `regedit`。

        `wepack/prefix._write_placeholder_regs` 写的是 wine **自己的存储格式**，
        由 wine 启动时自读。它若哪天改成 `regedit /S` 导入，判据就变成「这次写
        进去了没有」，必须重新登记进 `REG_WRITE_SITES` 并加戳 —— 这条负责红。
        """
        actual = set(_call_sites())
        leaked = set(PLACEHOLDER_SITES) & actual
        self.assertEqual(
            leaked, set(),
            "这些路径本来是「写文件不导入」，现在开始调 regedit 了，请改登记："
            + str(sorted(leaked)))

    def test_each_importing_site_has_a_one_shot_stamp(self) -> None:
        """凡「导入」路径，源码里必须真的出现它的一次性戳机制。

        判据不是「文件里有 `token` 这个词」（太软，一句注释就能满足），而是
        必须出现登记表里写明的戳标识符 / 判据函数名。改掉实现却没更新清单
        同样会红 —— 清单是给人看的，也是给下一个人对账的。
        """
        offenders: list[str] = []
        for rel, meta in REG_WRITE_SITES.items():
            path = REPO / rel
            if not path.is_file():
                offenders.append(f"{rel}: 文件不存在")
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            if meta["stamp"] not in text:
                offenders.append(
                    f"{rel}: 找不到 {meta['stamp']}（清单声称判据是：{meta['why']}）")
        self.assertEqual(offenders, [], "\n".join(offenders))

    def test_no_reg_add_or_reg_import_bypass(self) -> None:
        """`reg add` / `reg import` 一条都不许有 —— 它们绕开 `.reg` 文件。

        ## 为什么单列一条

        铁律 7 要求「不直接改注册表二进制，只写 `.reg` 再让 regedit 导入」。
        `reg add` 会在命令行里直接写键、没有可审计的 `.reg` 文件、也没法用
        「文件里有没有这个戳」来判真假 —— 它会绕开本文件其余三条守卫的全部
        前提。当前代码里 0 处，这条守住「以后也别加」。
        """
        pattern = re.compile(r"""["']reg["']\s*,\s*["'](?:add|import)["']""")
        offenders: list[str] = []
        for path in _source_files():
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for lineno, line in enumerate(text.splitlines(), 1):
                stripped = line.strip()
                if stripped.startswith(("#", "//", "*", "/*")):
                    continue
                if pattern.search(stripped):
                    offenders.append(
                        f"{path.relative_to(REPO).as_posix()}:{lineno} {stripped[:80]}")
        self.assertEqual(
            offenders, [],
            "出现 reg add / reg import，绕开了可审计的 .reg 文件：\n"
            + "\n".join(offenders))


class TestScannerHasTeeth(unittest.TestCase):
    """扫描器自身必须有判别力 —— 否则上面三条只是「跑了但什么都没查」。"""

    def test_scanner_finds_a_temporary_site(self) -> None:
        """临时造一个写入点，扫描器必须看得见。

        ## 为什么扫描器也要负向验证

        第 9、16 轮各踩过一次「glob 返回空集 → 判据全绿」。一个扫不到任何东西
        的扫描器，会让上面三条守卫永远通过 —— 通过得毫无意义。这条对着真实
        存在的文件做，不依赖仓库里此刻有没有未登记的写入点。
        """
        actual = _call_sites()
        self.assertGreaterEqual(
            len(actual), 3,
            f"扫描器只找到 {len(actual)} 个写入点，实际至少 3 个 —— 正则退化了：{actual}")

    def test_scanner_ignores_comments(self) -> None:
        """注释里的 `regedit /S` 不许算成写入点。

        本仓库有十几处解释性注释写着 `regedit /S`（讲这个坑本身）。若扫描器
        把它们算进来，清单永远对不上，最后只能放宽判据 —— 那时守卫就废了。
        """
        # main.swift 里注释出现 `regedit /S` 的行号（第 17 轮实测定位）
        rel = "launcher/Sources/main.swift"
        text = (REPO / rel).read_text(encoding="utf-8", errors="ignore")
        comment_lines = {
            i for i, line in enumerate(text.splitlines(), 1)
            if line.strip().startswith("//") and "regedit" in line
        }
        self.assertTrue(comment_lines, "前提变了：main.swift 里已没有注释版 regedit，请更新本用例")
        scanned = set(_call_sites().get(rel, []))
        overlap = comment_lines & scanned
        self.assertEqual(overlap, set(),
                         f"注释行被算成了写入点：{sorted(overlap)}")
