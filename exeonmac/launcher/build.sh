#!/bin/sh
# 编译 ExeOnMac launcher。
# 用法：launcher/build.sh [输出路径]
# 默认输出到 launcher/build/launcher。
set -eu

here=$(cd "$(dirname "$0")" && pwd)
out=${1:-"$here/build/launcher"}
src="$here/Sources/main.swift"

mkdir -p "$(dirname "$out")"

# swiftc 默认把 Clang 模块缓存写到 ~/.cache/clang/ModuleCache。受管环境
# 可能不允许写 HOME 下的缓存目录，此时编译会以 "Operation not permitted"
# 失败（与源码无关）。把缓存放进临时目录：它是可重建的编译中间产物，
# 不存在跨进程复用需求；launcher 本身仍按输出路径缓存。
module_cache=${TMPDIR:-/tmp}/wacmin-swift-module-cache
mkdir -p "$module_cache"

swiftc -O \
  -whole-module-optimization \
  -parse-as-library \
  -target arm64-apple-macos13.0 \
  -framework AppKit \
  -framework Foundation \
  -module-cache-path "$module_cache" \
  -o "$out" \
  "$src"

echo "built: $out"
file "$out"
