#!/usr/bin/env python3
"""从 Windows SDK 的 `dwrite.h` 里机械抽出 COM vtable 槽位，并守住它。

## 为什么需要这个脚本

`launcher` 的字体替换要证明「DirectWrite 认不认这个家族名」，唯一能查的办法是
写一个只走 DirectWrite 的小探针：`DWriteCreateFactory` → `GetSystemFontCollection`
→ `FindFamilyName`。探针不依赖 CRT、不依赖头文件，**只能靠手写 vtable 槽位下标**
去调方法。而槽位下标没有任何编译期保护 —— 算错一个数字，症状是段错误或死循环，
读起来像「产品崩了」。

第 13 轮就踩过一次：`IDWriteFontFamily` 继承自 `IDWriteFontList`，`GetFamilyNames`
是 **slot 6**，不是它在自己接口体里的第 3 个。于是本轮把槽位从「注释里的一句话」
变成「由头文件生成的一张表」，并让探针只许用表里的宏。

## 一个必须做对的细节：派生接口要累计基接口的槽位

`IDWriteFontFamily : public IDWriteFontList`，而后者有 3 个方法（`GetFontCollection`
/ `GetFontCount` / `GetFont`）占 slot 3–5。所以派生接口自己的第一个方法从 6 开始。
**只数派生接口自己那几个方法、从 3 重新开始，正是第 13 轮那个错。** 本脚本的
`resolve_slots()` 就是这件事的唯一实现，`--self-test` 用一份合成的假头文件守住它。

## 用法

    python3 tools/dwrite-probe/vtable.py --check            # 与 vtable.json 对账
    python3 tools/dwrite-probe/vtable.py --emit-json        # 重新生成 vtable.json
    python3 tools/dwrite-probe/vtable.py --emit-c           # 重新生成 vtable.h
    python3 tools/dwrite-probe/vtable.py --self-test        # 只验提取逻辑（不需要 SDK）
    python3 tools/dwrite-probe/vtable.py --header /path/to/dwrite.h --check

退出码：0 = 一致 / 1 = 不一致（打印差异）/ 2 = 找不到头文件或参数错误。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SNAPSHOT = HERE / "vtable.json"
GENERATED_H = HERE / "vtable.h"

#: 探针实际用到的接口。只抽这些，避免把整份 dwrite.h 搬进仓库。
WANTED = [
    "IDWriteFactory",
    "IDWriteFontCollection",
    "IDWriteFontList",
    "IDWriteFontFamily",
    "IDWriteFont",
    "IDWriteFontFace",
    "IDWriteLocalizedStrings",
]

#: `IUnknown` 的 3 个方法（QueryInterface / AddRef / Release）不写进任何接口体，
#: 但它们占 slot 0–2 —— 所有 COM 接口的第一个自有方法都从 3 开始。
IUNKNOWN_SLOTS = 3

_IFACE_RE = re.compile(
    r'interface\s+DWRITE_DECLARE_INTERFACE\(\s*"([0-9a-fA-F\-]+)"\s*\)\s*'
    r'(\w+)\s*:\s*public\s+(\w+)\s*\{',
)
# `STDMETHOD_(UINT32, GetFontFamilyCount)()` 与 `STDMETHOD(GetFontFamily)(...)` 两种写法
_METHOD_RE = re.compile(
    r"STDMETHOD(?:_\(\s*[^,]+,\s*(\w+)\s*\)|\(\s*(\w+)\s*\))\s*\(",
)


def parse_header(text: str) -> dict[str, dict]:
    """把头文件切成 `{接口名: {iid, base, methods}}`。"""
    ifaces: dict[str, dict] = {}
    for match in _IFACE_RE.finditer(text):
        iid, name, base = match.group(1), match.group(2), match.group(3)
        body_start = match.end()
        body_end = text.find("};", body_start)
        if body_end < 0:
            raise ValueError(f"{name} 的接口体没有闭合")
        body = text[body_start:body_end]
        methods = [m.group(1) or m.group(2) for m in _METHOD_RE.finditer(body)]
        # 空接口是合法的：`IDWriteNumberSubstitution` 就是一个只有 IID 的标记接口。
        # 所以这里不报错，改由 `build_table` 只对我们真正要用的那几个要求非空 ——
        # 那才是「正则与头文件脱节」时唯一会误伤的地方。
        ifaces[name] = {"iid": iid, "base": base, "methods": methods}
    return ifaces


def resolve_slots(ifaces: dict[str, dict]) -> dict[str, dict[str, int]]:
    """把 `{接口: [方法...]}` 展开成 `{接口: {方法: 槽位}}`。

    ## 派生接口必须累计基接口

    `IDWriteFontFamily` 继承 `IDWriteFontList`，后者占 slot 3–5，所以前者的
    `GetFamilyNames` 在 slot 6。这里递归求基接口占用的槽位数，再给自有方法编号。
    """
    resolved: dict[str, dict[str, int]] = {}

    def walk(name: str, stack: tuple[str, ...] = ()) -> dict[str, int]:
        if name in resolved:
            return resolved[name]
        if name in stack:
            raise ValueError(f"继承环：{' → '.join(stack + (name,))}")
        if name == "IUnknown":
            return {}
        if name not in ifaces:
            raise ValueError(f"缺失接口定义：{name}（被 {stack[-1] if stack else '?'} 继承）")
        entry = ifaces[name]
        base_slots = walk(entry["base"], stack + (name,))
        slots = dict(base_slots)
        next_slot = IUNKNOWN_SLOTS + len(base_slots)
        for method in entry["methods"]:
            slots[method] = next_slot
            next_slot += 1
        resolved[name] = slots
        return slots

    for name in ifaces:
        walk(name)
    return resolved


def build_table(ifaces: dict[str, dict], slots: dict[str, dict[str, int]]) -> dict:
    """落盘形态：只留探针要用的接口，并带上 iid 与基接口，便于人工复查。"""
    table = {}
    for name in WANTED:
        if name not in slots:
            raise ValueError(f"头文件里没有 {name}")
        if not slots[name]:
            # 我们要用的接口一个方法都没有 → 正则真的脱节了，不是空接口。
            raise ValueError(f"{name} 抽不到任何方法 —— 正则与头文件写法脱节了")
        table[name] = {
            "iid": ifaces[name]["iid"],
            "base": ifaces[name]["base"],
            "slots": dict(slots[name]),
        }
    return table


def emit_c(table: dict) -> str:
    """生成探针 include 的宏表。名字固定为 `DW_<接口>_<方法>`。"""
    lines = [
        "/* 由 tools/dwrite-probe/vtable.py 从 Windows SDK 的 dwrite.h 生成。",
        " * 不要手改：槽位由头文件里的声明顺序决定，改这里等于改事实。",
        " * 重新生成：python3 tools/dwrite-probe/vtable.py --emit-c",
        " */",
        "#ifndef DWRITE_VTABLE_H",
        "#define DWRITE_VTABLE_H",
        "",
    ]
    for name, entry in table.items():
        lines.append(f"/* {name} : public {entry['base']} */")
        for method, slot in entry["slots"].items():
            lines.append(f"#define DW_{name}_{method} {slot}")
        lines.append("")
    lines.append("#endif")
    return "\n".join(lines) + "\n"


def default_header() -> Path | None:
    """找一个可用的 dwrite.h。

    本机的 SDK 来自 cargo-xwin 的缓存（Rust 交叉编译用），README 15.26 记了来历。
    允许用 `DWRITE_H` 环境变量覆盖，便于换机器时指到别处。
    """
    env = os.environ.get("DWRITE_H")
    if env:
        return Path(env).expanduser()
    cache = Path.home() / "Library" / "Caches" / "cargo-xwin" / "xwin" / "unpack"
    if cache.is_dir():
        for candidate in sorted(cache.glob("*/include/um/dwrite.h")):
            return candidate
    return None


#: 自检用的假头文件。刻意复刻真实文件的继承形状：一个派生接口 + 一个基接口。
SYNTHETIC_HEADER = """
interface DWRITE_DECLARE_INTERFACE("00000000-0000-0000-0000-000000000001") IFakeBase : public IUnknown
{
    STDMETHOD_(UINT32, BaseCount)() PURE;
    STDMETHOD(BaseGet)(UINT32 index) PURE;
};

interface DWRITE_DECLARE_INTERFACE("00000000-0000-0000-0000-000000000002") IFakeDerived : public IFakeBase
{
    STDMETHOD(DerivedFirst)() PURE;
    STDMETHOD(DerivedSecond)() PURE;
};
"""


def self_test() -> int:
    """只验提取逻辑，不需要 SDK。守住「派生接口累计基接口槽位」这条。"""
    ifaces = parse_header(SYNTHETIC_HEADER)
    slots = resolve_slots(ifaces)
    checks = [
        ("基接口 BaseCount", slots["IFakeBase"]["BaseCount"], 3),
        ("基接口 BaseGet", slots["IFakeBase"]["BaseGet"], 4),
        # 关键：派生接口第一个方法必须是 5（= 3 + 基接口 2 个方法），不是 3。
        ("派生 DerivedFirst", slots["IFakeDerived"]["DerivedFirst"], 5),
        ("派生 DerivedSecond", slots["IFakeDerived"]["DerivedSecond"], 6),
    ]
    failed = 0
    for label, got, want in checks:
        ok = got == want
        print(f"{'✓' if ok else '✗'} {label}: {got}" + ("" if ok else f"（应为 {want}）"))
        failed += 0 if ok else 1

    # 派生接口必须能看到基接口的方法（继承来的槽位不许丢）。
    inherited = slots["IFakeDerived"].get("BaseCount")
    ok = inherited == 3
    print(f"{'✓' if ok else '✗'} 派生接口可见基接口方法 BaseCount: {inherited}")
    failed += 0 if ok else 1
    return 0 if failed == 0 else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="dwrite vtable 槽位表")
    parser.add_argument("--header", type=Path, help="dwrite.h 路径（默认自动查找）")
    parser.add_argument("--check", action="store_true", help="与 vtable.json / vtable.h 对账")
    parser.add_argument("--emit-json", action="store_true", help="重新生成 vtable.json")
    parser.add_argument("--emit-c", action="store_true", help="重新生成 vtable.h")
    parser.add_argument("--self-test", action="store_true", help="只验提取逻辑，不需要 SDK")
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    header = args.header or default_header()
    if header is None or not Path(header).is_file():
        print("找不到 dwrite.h；用 --header 指定，或设 DWRITE_H 环境变量。",
              file=sys.stderr)
        return 2

    ifaces = parse_header(Path(header).read_text(encoding="utf-8", errors="replace"))
    table = build_table(ifaces, resolve_slots(ifaces))

    if args.emit_json:
        SNAPSHOT.write_text(
            json.dumps(table, ensure_ascii=False, indent=2, sort_keys=False) + "\n",
            encoding="utf-8")
        print(f"✓ 已写入 {SNAPSHOT.relative_to(HERE.parent.parent)}")
        return 0
    if args.emit_c:
        GENERATED_H.write_text(emit_c(table), encoding="utf-8")
        print(f"✓ 已写入 {GENERATED_H.relative_to(HERE.parent.parent)}")
        return 0

    if not args.check:
        parser.error("要么给 --check，要么给 --emit-json / --emit-c / --self-test")

    failed = 0
    if not SNAPSHOT.is_file():
        print(f"✗ 缺少快照 {SNAPSHOT.name}", file=sys.stderr)
        return 1
    want = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    for iface, entry in want.items():
        got = table.get(iface)
        if got is None:
            print(f"✗ 头文件里没有 {iface}")
            failed += 1
            continue
        if got["iid"] != entry["iid"]:
            print(f"✗ {iface} 的 iid 变了：{entry['iid']} → {got['iid']}")
            failed += 1
        if got["base"] != entry["base"]:
            print(f"✗ {iface} 的基接口变了：{entry['base']} → {got['base']}")
            failed += 1
        for method, slot in entry["slots"].items():
            actual = got["slots"].get(method)
            if actual != slot:
                print(f"✗ {iface}.{method}: 快照 {slot}，头文件 {actual}")
                failed += 1
    if failed:
        print(f"共 {failed} 处不一致；确认无误后跑 --emit-json / --emit-c 重新生成。")
        return 1
    total = sum(len(e["slots"]) for e in want.values())
    print(f"✓ {len(want)} 个接口 / {total} 个槽位与头文件一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
