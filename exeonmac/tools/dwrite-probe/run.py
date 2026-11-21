#!/usr/bin/env python3
"""在一个临时 prefix 里跑 DirectWrite 探针，用于「只改注册表」的对照实验。

## 为什么要有这个脚本

探针（`probe.exe`）只是一段代码，真正要回答的问题需要**对照**：同一份 base 层、
同一份 wine，只改注册表，看 DirectWrite 的答案怎么变。手工做这件事有三处必错：

1. **忘了等注册表落盘。** `regedit /S` 返回 0 时数据还在 wineserver 内存里，
   直接读 `system.reg` 会是旧值 —— 第 13 轮在这里红过两次。
2. **复用了被污染的 prefix。** 上一组写进去的键会跟着下一组走，于是「A 组也没写」
   这个前提根本不成立。每组必须从 base 层重新 clone 一份。
3. **拿退出码当结论。** 探针的结论是 stdout 里的 `familyCount` 与 `exists`，
   不是退出码；道具跑成功、答案却是「查不到」，这种情况必须能被读出来。

所以把这套流程收成一个脚本，测试与人工排查共用同一份实现。

## 用法

    python3 tools/dwrite-probe/run.py --group R --reg /path/to/only-replacements.reg
    python3 tools/dwrite-probe/run.py --group N            # 什么都不写
    python3 tools/dwrite-probe/run.py --group S,R --json   # 多组，输出 JSON

`--group` 只是给结果贴的标签。`--keep-prefix` 保留临时 prefix 便于事后翻注册表。

退出码：0 = 探针跑通并给出结论 / 2 = 环境缺失（wine / base 层 / 探针不存在）/
3 = 探针崩了或没有输出（这是真问题，别当成「查不到」）。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXEONMAC = HERE.parent.parent
sys.path.insert(0, str(EXEONMAC))


def wine_home() -> Path:
    """wine 托管目录。允许 `WEXE_HOME` 覆盖，与 wepack 用同一个环境变量。"""
    env = os.environ.get("WEXE_HOME")
    if env:
        return Path(env).expanduser()
    return Path.home() / "Library" / "Application Support" / "wexe"


def wine_binary() -> Path | None:
    candidate = wine_home() / "runtime" / "wine" / "bin" / "wine64"
    return candidate if candidate.is_file() else None


def base_layer() -> Path | None:
    candidate = wine_home() / "layers" / "base"
    return candidate if (candidate / "drive_c").is_dir() else None


def _run_wine(wine: Path, prefix: Path, args: list[str], *,
              timeout: float = 120.0) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env.update({
        "WINEPREFIX": str(prefix),
        # 关掉调试输出：MoltenVK 会往 stderr 打上百行扩展列表，混进来会淹没探针输出。
        "WINEDEBUG": "-all",
        "WINEDLLOVERRIDES": "mscoree,mshtml=",
    })
    return subprocess.run([str(wine), *args], env=env, capture_output=True,
                          timeout=timeout, text=True)


def import_registry(wine: Path, prefix: Path, reg: Path) -> None:
    """导入一份 .reg，并等到它真的落盘。

    ## 两个坑都在这里

    **坑一：路径要给 Windows 形式。** 传宿主绝对路径时 `regedit` 会报
    `ShellExecuteEx failed`、退出码非 0；转成 `z:` 盘形式才被接受（`z:` 在
    prefix 里固定映射到 `/`）。

    **坑二：`wineserver -w` 不算「落盘了」。** 它只等进程退出，而 launcher /
    regedit 退出后 wineserver 仍以服务身份活着，不触发回写 —— 第 13 轮实测
    `-w` 之后 `user.reg` 命中 0 次、`-k` 之后 1 次。所以这里 `-k` 之后还要**轮询
    文件内容**，直到看见键为止（超时则照常继续，由调用方看结果说话）。
    """
    result = _run_wine(wine, prefix, ["regedit", "/S", f"z:{reg}"], timeout=90)
    if result.returncode != 0:
        raise RuntimeError(
            f"regedit 导入失败（退出码 {result.returncode}）："
            f"{(result.stderr or result.stdout).strip()[:300]}")
    _run_wine(wine, prefix, ["wineserver", "-k"], timeout=30)
    sections = _reg_sections(reg)
    if not sections:
        raise RuntimeError(f"{reg.name} 里没有可写的值 —— 这份 .reg 是空的？")
    deadline = time.time() + 10
    # 每张表只认自己那棵根键：`system.reg` 认 HKLM，`user.reg` 认 HKCU。
    # **每一段都要在它该在的文件里**（不是「随便哪个文件里有就行」）：
    # 只落了一半同样是失败，而半个映射会让一部分字体正常、另一部分仍是方块。
    hive_of = {"system.reg": "HKEY_LOCAL_MACHINE", "user.reg": "HKEY_CURRENT_USER"}
    expected = {name: [s for s in sections if s[0].startswith(hive + "|")]
                for name, hive in hive_of.items()}
    while time.time() < deadline:
        if all(not want or _reg_has_mapping(prefix / name, want, hive)
               for name, hive in hive_of.items() for want in [expected[name]]):
            return
        time.sleep(0.25)
    raise RuntimeError("注册表 10 秒内没有落盘到 system.reg / user.reg")


def _reg_sections(reg: Path) -> list[tuple[str, list[tuple[str, str]]]]:
    r"""把 `.reg` 解析成 `[(键路径, [(值名, 值)...]), ...]`。

    键路径去掉根键、统一成落盘文件里的写法（`Software\\Wine\\...` 还原成
    单反斜杠），这样才能与 `system.reg` / `user.reg` 里的段头逐字对上。
    根键另存，因为**同一个子路径挂在 HKCU 与 HKLM 下是两处不同的存储**
    （`Replacements` 在 HKCU、`FontSubstitutes` 在 HKLM），剥掉根键就分不清了。
    """
    raw = reg.read_bytes()
    text = raw.decode("utf-16-le", errors="ignore") if raw[:2] == b"\xff\xfe" else \
        raw.decode("utf-8", errors="ignore")
    sections: list[tuple[str, list[tuple[str, str]]]] = []
    current: list[tuple[str, str]] | None = None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("[") and line.endswith("]"):
            key = line[1:-1]
            # 根键必须留下：`HKCU\...\Replacements` 与 `HKLM\...\Replacements`
            # 在落盘文件里分别是 `user.reg` 与 `system.reg` 两张不同的表。
            hive = ""
            for candidate in ("HKEY_CURRENT_USER", "HKEY_LOCAL_MACHINE",
                              "HKEY_USERS", "HKEY_CLASSES_ROOT"):
                if key.upper().startswith(candidate):
                    hive = candidate
                    key = key[len(candidate):]
                    break
            key = key.lstrip("\\").replace("\\\\", "\\")
            sections.append((f"{hive}|{key}", []))
            current = sections[-1][1]
        elif current is not None and '"="' in line and line.startswith('"'):
            name, _, value = line.partition('"="')
            current.append((name[1:], value.rstrip('"')))
    return sections


def _mapping_values(reg: Path) -> list[str]:
    """从 `.reg` 里抽出所有**值**（`"键"="值"` 的右边）。

    只用来看「这份 .reg 里有没有东西可写」。落盘判定不要用它 —— 见
    `_reg_has_mapping` 里那条假阳性的记录。
    """
    return [value for _, pairs in _reg_sections(reg) for _, value in pairs]


def _reg_has_mapping(path: Path, sections: list[tuple[str, list[tuple[str, str]]]],
                     hive: str) -> bool:
    """落盘文件里有没有这次要写的那几对 `"名"="值"`，且**在正确的段里**。

    ## 这条判据修过一次，原因是假阳性（2026-11-21 实测）

    旧版判据是「本次要写的**值**在文件里作为带引号的字符串出现过」。
    X 组写 `"SimSun"="Helvetica"`，旧判据报 `system.reg: True` —— 而这份 `.reg`
    只写了 HKCU，`system.reg` 根本不该被碰。查下去：base 层自带的
    `FontSubstitutes` 段里有 `"Helvetica"="Arial"`（wine 默认预置），字符串
    `"Helvetica"` 确实在文件里，只是**它是键名、不是我们写的值**。

    这类假阳性最坏的后果不是报错，而是**报成功**：映射写失败时判据仍然绿，
    于是「落盘了」这个前提不成立，整组对照的结论全部作废 —— 与第 7 轮
    `regedit /S` 静默失败、第 11 轮「键是上一轮写的」同一种形态。

    现在同时要求三件事：段头对得上、值名对得上、值也对得上。只写进去一半同样
    算失败 —— 半个映射会让一部分字体正常、另一部分仍是方块，是最难查的形态。

    `hive` 指定这次写入的根键（`HKEY_CURRENT_USER` / `HKEY_LOCAL_MACHINE`）：
    `user.reg` 就是 HKCU 那棵树、`system.reg` 是 HKLM，段头在落盘文件里不含根键，
    所以「段在这个文件里」必须由调用方声明根键来约束，否则两张表会互相冒充。

    ## 空集不算成功

    若 `sections` 里一段都不属于 `hive`，本函数返回 **False**，不是 True。
    `for` 循环里「不匹配就 `continue`」会让 `ok` 一直保持初值 True —— 那等于
    「没有要检查的东西」被读成「全部检查通过」。同一个坑在第 9 轮的
    `test_scan_covers_all_test_modules` 上出现过一次（glob 写错返回空集，
    前两条守卫全绿），判据必须显式拒绝空集。
    """
    relevant = [(label, pairs) for label, pairs in sections
                if label.partition("|")[0] == hive]
    if not relevant:
        return False
    try:
        raw = path.read_bytes()
    except OSError:
        return False
    # 落盘文件是纯 ASCII 头 + 可能含 UTF-8 的键值；两种解码都试一遍
    # （中文键名在 .reg 里是 UTF-16，落盘后是 UTF-8 字节）。
    for text in (raw.decode("utf-8", errors="ignore"),
                 raw.decode("utf-16-le", errors="ignore")):
        blocks = _split_blocks(text)
        if not blocks:
            continue
        ok = True
        for label, pairs in relevant:
            _, _, key = label.partition("|")
            body = blocks.get(key.lower())
            if body is None:
                ok = False
                break
            for name, value in pairs:
                if f'"{name}"="{value}"' not in body:
                    ok = False
                    break
            if not ok:
                break
        if ok:
            return True
    return False


def _split_blocks(text: str) -> dict[str, str]:
    """把落盘注册表按段切开：`{小写键路径: 段正文}`。

    段头形如 `[Software\\\\Wine\\\\Fonts\\\\Replacements] 1795273080` ——
    **双反斜杠**（内部格式的转义）+ 一个时间戳。段正文是紧随其后的
    `#time=...` 与 `"名"="值"` 行，直到下一个 `[`。

    `#time` 行必须一起收进来：判据只找 `"名"="值"` 的精确形态，注释行不含它，
    留着不影响，但丢掉正文首行会让行边界错位。
    """
    blocks: dict[str, str] = {}
    key: str | None = None
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("[") and "]" in stripped:
            head = stripped[1:stripped.index("]")]
            key = head.replace("\\\\", "\\").lower()
            blocks[key] = ""
        elif key is not None and stripped:
            blocks[key] += stripped + "\n"
    return blocks


def parse_probe(stdout: str) -> dict:
    """把探针的人类可读输出解析成结构化结果。

    只认这几个字段，够用且稳定：`familyCount`、每组 `exists` / `faces`、
    字形覆盖（`glyphs`）、以及第 15 轮加的像素层（`raster`）。

    ## 像素层的键名：`cp` 与 `cp@mode`

    `raster[A]` 是 `ALIASED`（与第 15 轮的输出格式一致，老判据不用改），
    `raster[A@gdic]` 是 `GDI_CLASSIC`、`raster[A@nat]` 是 `NATURAL`（第 16 轮加）。
    解析后每档的字段里都带 `mode`，便于断言时核对，而不是靠键名后缀推断。

    解析失败返回 `{"ok": False}` —— 让调用方能区分「探针没说话」与「查不到」。
    """
    out: dict = {"ok": False, "familyCount": None, "families": {}}
    current = None
    for line in stdout.splitlines():
        line = line.rstrip()
        if line.startswith("familyCount="):
            out["familyCount"] = int(line.split("=", 1)[1])
        elif line.startswith("FindFamilyName["):
            name = line[len("FindFamilyName["):line.index("]")]
            current = name
            exists = "exists=1" in line
            out["families"][name] = {"exists": exists, "faces": None,
                                     "glyphs": {}, "raster": {}}
        elif current and line.strip().startswith("faceCount="):
            out["families"][current]["faces"] = int(line.split("=", 1)[1])
        elif current and "glyph[" in line:
            # 形如 `    glyph[U+4E2D]=present`
            inside = line[line.index("glyph[") + 6:line.index("]")]
            value = line.split("=", 1)[1]
            out["families"][current]["glyphs"][inside] = value
        elif current and line.strip().startswith("raster["):
            # 形如 `    raster[U+4E2D@gdic] mode=gdic index=1278 ink=354 px=5244 size=38x46 hash=0x82392a23 ink-present`
            # 或 `    raster[U+10FFFD] index=0 ink=0 notdef`
            # 或 `    raster[A] mode=alias … raster-failed(create=.. bounds=.. texture=..)`
            inside = line[line.index("raster[") + 7:line.index("]")]
            fields: dict = {"verdict": "unknown"}
            for token in line[line.index("]") + 1:].split():
                if "=" in token:
                    key, _, value = token.partition("=")
                    fields[key] = value
                elif token in ("notdef", "ink-present", "EMPTY", "TOFU-SHAPED"):
                    fields["verdict"] = token
                elif token.startswith("raster-failed"):
                    fields["verdict"] = "raster-failed"
            for key in ("index", "ink", "px"):
                if key in fields:
                    fields[key] = int(fields[key])
            # `size=38x46` 拆成两个整数，便于断言纹理尺寸与子像素倍数。
            size = fields.get("size")
            if isinstance(size, str) and "x" in size:
                w, _, h = size.partition("x")
                if w.isdigit() and h.isdigit():
                    fields["w"], fields["h"] = int(w), int(h)
            out["families"][current]["raster"][inside] = fields
    out["ok"] = out["familyCount"] is not None
    return out


def _clone_base(base: Path, prefix: Path) -> None:
    """把 base 层复制成一份私有 prefix。

    优先 `cp -cR`（APFS clonefile，382 MB 亚秒级）；失败再退回 `copytree`。
    与 `wepack/prefix` 建 prefix 用的是同一种手法 —— 这里不重复实现判定，
    只是没有 Python 侧的 clonefile 接口，所以借一次 `cp`。
    """
    result = subprocess.run(["cp", "-cR", str(base), str(prefix)],
                            capture_output=True, text=True)
    if result.returncode != 0:
        shutil.rmtree(prefix, ignore_errors=True)
        shutil.copytree(base, prefix, symlinks=True)


def run_group(group: str, reg: Path | None, *, keep_prefix: bool,
              exe: Path | None = None) -> dict:
    wine = wine_binary()
    base = base_layer()
    exe = exe or (HERE / "build" / "probe.exe")
    missing = []
    if wine is None:
        missing.append(f"wine：{wine_home() / 'runtime/wine/bin/wine64'}")
    if base is None:
        missing.append(f"base 层：{wine_home() / 'layers/base'}")
    if not exe.is_file():
        missing.append(f"探针：{exe}（先跑 tools/dwrite-probe/build.sh）")
    if missing:
        raise FileNotFoundError("环境缺失 —— " + "；".join(missing))

    prefix = Path(tempfile.mkdtemp(prefix=f"dwprobe-{group}-")) / "prefix"
    try:
        # 每组从 base 层重新 clone：复用 prefix 会把上一组写进去的键带进来，
        # 于是「这一组没写」的前提直接不成立，对照组全部作废。
        _clone_base(base, prefix)
        if reg is not None:
            import_registry(wine, prefix, reg)
        shutil.copy2(exe, prefix / "drive_c" / "probe.exe")

        result = _run_wine(wine, prefix, ["c:\\probe.exe"], timeout=180)
        parsed = parse_probe(result.stdout)
        parsed["group"] = group
        parsed["exitCode"] = result.returncode
        parsed["raw"] = result.stdout
        sections = _reg_sections(reg) if reg is not None else []
        # 每张表只报「**这次**写进它了吗」：没写这段就是 False，不因为另一张表
        # 写成功而变绿。X 组的假阳性就出在这里（见 `_reg_has_mapping` 的注释）。
        parsed["registry"] = {
            name: _reg_has_mapping(prefix / name,
                                   [s for s in sections if s[0].startswith(hive + "|")],
                                   hive)
            for name, hive in (("system.reg", "HKEY_LOCAL_MACHINE"),
                               ("user.reg", "HKEY_CURRENT_USER"))
        }
        return parsed
    finally:
        _run_wine(wine, prefix, ["wineserver", "-k"], timeout=30)
        if keep_prefix:
            print(f"（prefix 保留在 {prefix}）", file=sys.stderr)
        else:
            shutil.rmtree(prefix.parent, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="DirectWrite 探针对照实验")
    parser.add_argument("--group", required=True,
                        help="组标签；可用逗号分隔多组，此时 --reg 也按顺序给")
    parser.add_argument("--reg", action="append", type=Path, default=[],
                        help="要导入的 .reg；与 --group 一一对应，用 `none` 表示不写")
    parser.add_argument("--exe", type=Path, help="探针路径（默认 build/probe.exe）")
    parser.add_argument("--keep-prefix", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    groups = [g.strip() for g in args.group.split(",") if g.strip()]
    regs: list[Path | None] = list(args.reg)
    if not regs:
        regs = [None] * len(groups)
    if len(regs) != len(groups):
        parser.error(f"--group 有 {len(groups)} 个，--reg 有 {len(regs)} 个")

    results = []
    for group, reg in zip(groups, regs):
        try:
            results.append(run_group(group, reg, keep_prefix=args.keep_prefix,
                                     exe=args.exe))
        except (FileNotFoundError, RuntimeError) as exc:
            print(f"✗ {group}：{exc}", file=sys.stderr)
            return 2 if isinstance(exc, FileNotFoundError) else 3

    if args.json:
        for item in results:
            item.pop("raw", None)
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        for item in results:
            print(f"=== {item['group']} ===")
            print(f"familyCount={item['familyCount']} "
                  f"registry={item['registry']}")
            for name, info in item["families"].items():
                glyphs = " ".join(f"{k}:{v}" for k, v in info["glyphs"].items())
                print(f"  {name}: exists={info['exists']} faces={info['faces']} {glyphs}")
                for cp, px in info.get("raster", {}).items():
                    print(f"    {cp}: {px.get('verdict')} ink={px.get('ink')} "
                          f"hash={px.get('hash', '-')}")
    bad = [r["group"] for r in results if not r["ok"]]
    if bad:
        print(f"✗ 探针没给出结论：{', '.join(bad)}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
