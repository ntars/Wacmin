#!/usr/bin/env python3
"""确认测试依赖齐全，缺一个就退出 1。

## 这一步为什么存在

测试里的 `skipUnless(依赖在)` 是防御性写法：依赖缺了就不跑，而不是伪造
样本。方向是对的，但它有个副作用 —— CI 上依赖意外缺失时会**静默降级成
跳过**，报告照旧全绿。`OK (skipped=N)` 的退出码是 0。

所以把「依赖必须齐全」提成一个独立断言。缺任何一个就在这里红，而不是
等测试跑完由 `check_no_skips.py` 兜。区别在报错时机：

- 这里红 → 环境没装好，去改 workflow；
- check_no_skips 红 → 夹具或探测逻辑有缺陷，去改代码。

两者的排查方向完全不同，混在一起会浪费时间。

## 为什么用 wepack.tools 而不是 shutil.which 了事

`which` 只能证明「有个叫这个名字的东西在 PATH 里」。实测踩过：PATH 里
那个 `7zz` 是转发壳，文件存在、可执行，但跑起来返回非 0。而
`tools.find_tool` 带冒烟测试（真跑一遍 `i` 看输出），会把这类假货排除
掉 —— 它判断的是「能不能用」，不是「在不在」。

用法（在 exeonmac/ 目录下）：
    python3 tests/check_deps.py
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

# 允许从任意目录调用：把项目根放进 sys.path，`import wepack` 才成立。
# 用 `python3 -m unittest` 跑时 cwd 已经是项目根，但脚本会被 CI 直接调用，
# 也可能被人从别处 `python3 path/to/check_deps.py`，两种情况都要支持。
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

#: 名字 → 说明。说明会出现在报错里，告诉人缺了会影响什么。
REQUIRED = {
    "7z": "NSIS/MSI 解包与夹具冒烟测试",
    "innoextract": "Inno 解包；也是下载 ISCC 工具链时用的解包器",
    "makensis": "现场编译 NSIS 夹具",
    "swiftc": "编译 launcher（Xcode CLT 自带）",
    "wine": "真实安装与启动的集成测试",
    "base_layer": "真实安装测试的 prefix 底座",
}


def main() -> int:
    problems: list[tuple[str, str]] = []

    # ---- 走 wepack 自己探测的（带冒烟测试） ----
    from wepack import tools

    for name in ("7z", "innoextract"):
        tool = tools.find_tool(name, required=False)
        if tool is None:
            problems.append((name, f"找不到可用实例（用途：{REQUIRED[name]}）"))
        else:
            print(f"  [OK]   {name:<12} {tool.path}")

    # ---- 只需在 PATH 里的 ----
    for name in ("makensis", "swiftc"):
        path = shutil.which(name)
        if path is None:
            problems.append((name, f"不在 PATH（用途：{REQUIRED[name]}）"))
        else:
            print(f"  [OK]   {name:<12} {path}")

    # ---- wine：不在 PATH，由 wepack 自己定位 ----
    try:
        from wepack.install import wine_binary

        wine = wine_binary()
    except Exception as exc:        # noqa: BLE001 - 探测失败一律当作不可用
        problems.append(("wine", f"{exc}（用途：{REQUIRED['wine']}）"))
    else:
        if wine.is_file():
            print(f"  [OK]   {'wine64':<12} {wine}")
        else:
            problems.append(("wine", f"{wine} 不存在（用途：{REQUIRED['wine']}）"))

    # ---- base 层：真实安装测试的底座 ----
    from wepack import paths

    notepad = (paths.layers_root() / "base"
               / "drive_c" / "windows" / "notepad.exe")
    if notepad.is_file():
        print(f"  [OK]   {'base 层':<11} {notepad.parent.parent.parent}")
    else:
        problems.append(("base 层", f"未构建，缺 {notepad}"
                                    f"（用途：{REQUIRED['base_layer']}）"))

    if problems:
        print("\n依赖不全：", file=sys.stderr)
        for name, reason in problems:
            print(f"  - {name}：{reason}", file=sys.stderr)
        print("\n测试里的 skipUnless 会把这些静默降级成跳过，报告照样全绿 —— "
              "所以必须在这里拦住。", file=sys.stderr)
        return 1

    print("\n依赖齐全")
    return 0


if __name__ == "__main__":
    sys.exit(main())
