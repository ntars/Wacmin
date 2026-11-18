#!/bin/sh
# 下载并安装 Wine 运行时（x86_64，经 Rosetta 2 运行）。
#
# 用法：
#   runtime/fetch.sh                  # 从 GitHub 下载默认版本
#   runtime/fetch.sh <url>            # 指定下载地址
#   runtime/fetch.sh --vendor         # 从 CrossOver / Whisky 复制
#   runtime/fetch.sh --archive <file> # 用本地 tar.xz
#
# 等价于 wepack runtime install，这里只是给不想装 Python 包的人一个入口。
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
PYTHON=${PYTHON:-python3}

exec env PYTHONPATH="$here${PYTHONPATH:+:$PYTHONPATH}" \
    "$PYTHON" -m wepack runtime install "$@"