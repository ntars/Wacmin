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
    values = _mapping_values(reg)
    if not values:
        raise RuntimeError(f"{reg.name} 里没有可写的值 —— 这份 .reg 是空的？")
    deadline = time.time() + 10
    while time.time() < deadline:
        if any(_reg_has_mapping(p, values) for p in (prefix / "system.reg", prefix / "user.reg")):
            return
        time.sleep(0.25)
    raise RuntimeError("注册表 10 秒内没有落盘到 system.reg / user.reg")


def _mapping_values(reg: Path) -> list[str]:
    """从 .reg 里抽出所有**值**（`"键"="值"` 的右边），用于确认落盘。

    不能只看「文件变了没有」：`regedit` 每次都会顺手写一堆 `#time` 与缓存，
    用 mtime 判断会把「一个键都没写进去」也判成成功。也不能只看某个固定字面量
    （比如 `Microsoft YaHei`）：中文键名那一组写的是「微软雅黑」，同一个值却
    长得不同 —— 那正是第 13 轮「E 组」要验的东西。
    """
    raw = reg.read_bytes()
    text = raw.decode("utf-16-le", errors="ignore") if raw[:2] == b"\xff\xfe" else \
        raw.decode("utf-8", errors="ignore")
    values = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith('"') or '"="' not in line:
            continue
        values.append(line.split('"="', 1)[1].rstrip('"'))
    return values


def _reg_has_mapping(path: Path, values: list[str]) -> bool:
    """落盘文件里有没有这次要写的那些值。

    判据取「**所有**值都在」而不是「任意一个在」：只写进去一半同样是失败，
    而半个映射会让一部分字体正常、另一部分仍是方块 —— 最难查的形态。
    """
    if not values:
        return False
    try:
        raw = path.read_bytes()
    except OSError:
        return False
    # 注册表文件是 UTF-16LE（wine 用 `#time` 注释标记版本），统一按 utf-16 里找。
    for encoding in ("utf-16-le", "utf-8"):
        text = raw.decode(encoding, errors="ignore")
        if all(f'"{v}"' in text for v in values):
            return True
    return False


def parse_probe(stdout: str) -> dict:
    """把探针的人类可读输出解析成结构化结果。

    只认这几个字段，够用且稳定：`familyCount`、每组 `exists` / `faces`、
    字形覆盖（`glyphs`）、以及第 15 轮加的像素层（`raster`）。
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
            # 形如 `    raster[U+4E2D] index=1278 ink=538 px=1748 size=38x46 hash=0x390a433b ink-present`
            # 或 `    raster[U+10FFFD] index=0 ink=0 notdef`
            # 或 `    raster[A] index=36 … raster-failed(create=.. bounds=.. texture=..)`
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
        values = _mapping_values(reg) if reg is not None else []
        parsed["registry"] = {
            "system.reg": _reg_has_mapping(prefix / "system.reg", values),
            "user.reg": _reg_has_mapping(prefix / "user.reg", values),
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
