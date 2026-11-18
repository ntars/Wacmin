#!/bin/sh
# 编译 ExeOnMac launcher。
# 用法：launcher/build.sh [输出路径]
# 默认输出到 launcher/build/launcher。
set -eu

here=$(cd "$(dirname "$0")" && pwd)
out=${1:-"$here/build/launcher"}
src="$here/Sources/main.swift"

mkdir -p "$(dirname "$out")"

swiftc -O \
  -whole-module-optimization \
  -parse-as-library \
  -target arm64-apple-macos13.0 \
  -framework AppKit \
  -framework Foundation \
  -o "$out" \
  "$src"

echo "built: $out"
file "$out"