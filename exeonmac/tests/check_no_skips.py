#!/usr/bin/env python3
"""检查 unittest 输出：不允许有任何跳过，且测试总数不得低于基线。

## 这个脚本为什么存在

`python3 -m unittest discover` 在有测试被跳过时**退出码仍是 0**：

    Ran 333 tests in 96s
    OK (skipped=10)

CI 上一直是绿的，而 10 项测试从来没跑过。跳过在报告里长得跟通过一样，
所以没人会去看 —— 守卫没在站岗，但没人发现。

unittest 没有 `--fail-on-skip`。这个脚本补上这件事，同时守住测试总数：
夹具被误删、模块导入失败导致整类消失，都会让测试「变少」而不是「变红」。

用法：
    python3 -m unittest discover -s tests -v > log.txt 2>&1
    python3 tests/check_no_skips.py log.txt --min 333
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("log", type=Path, help="unittest 的输出日志")
    parser.add_argument("--min", type=int, default=0,
                        help="测试总数的下限，低于它视为有测试没被发现")
    args = parser.parse_args()

    if not args.log.is_file():
        print(f"日志不存在：{args.log}", file=sys.stderr)
        return 2

    text = args.log.read_text(encoding="utf-8", errors="replace")

    summary = [line for line in text.splitlines() if line.startswith("Ran ")]
    if not summary:
        print("没读到测试汇总行 —— 测试可能根本没跑起来", file=sys.stderr)
        print(text[-2000:], file=sys.stderr)
        return 2

    last = summary[-1]
    match = re.search(r"Ran (\d+) tests?", last)
    if not match:
        print(f"汇总行格式不认识：{last}", file=sys.stderr)
        return 2
    ran = int(match.group(1))

    # ## skipped=N 不在 `Ran` 行上
    #
    # unittest 的汇总长这样，跳过计数在**下一行**的 OK / FAILED 括号里：
    #
    #     ----------------------------------------------------------------------
    #     Ran 333 tests in 96.475s
    #
    #     OK (skipped=10)
    #
    # 只在 `Ran` 行上找会永远读成 0，这个脚本就变成恒真式。
    tail = "\n".join(text.splitlines()[-8:])
    skip_match = re.search(r"skipped=(\d+)", tail)
    skipped = int(skip_match.group(1)) if skip_match else 0

    print(f"测试 {ran} 项，跳过 {skipped} 项，下限 {args.min} 项")

    failed = False

    if skipped:
        print(f"\n{skipped} 项测试被跳过：", file=sys.stderr)
        shown = 0
        for line in text.splitlines():
            # unittest -v 的两种排版都要认：
            #   `test_x (mod.Cls.test_x) ... skipped '需要 7z'`   ← 无 docstring
            #   ```
            #   test_x (mod.Cls.test_x)
            #   一句说明 ... skipped '需要 7z'                       ← 有 docstring
            #   ```
            if "skipped '" in line or "... skipped" in line:
                print(f"  {line.strip()}", file=sys.stderr)
                shown += 1
        if not shown:
            print("  （日志里没找到明细行，加 -v 重跑才有）", file=sys.stderr)
        print("\n跳过在报告里是绿的，跟通过长得一样。"
              "能用工具解决的问题不该用跳过处理 —— "
              "要么把依赖装进环境，要么把断言改成不依赖它。", file=sys.stderr)
        failed = True

    if ran < args.min:
        print(f"\n测试总数 {ran} 少于基线 {args.min}："
              "有测试没被发现，或夹具/模块导入失败导致整类消失。",
              file=sys.stderr)
        failed = True

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
