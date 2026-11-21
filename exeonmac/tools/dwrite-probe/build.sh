#!/bin/sh
# 编译 DirectWrite 探针（x86_64 Windows PE）。
#
# ## 为什么不链接 SDK 的导入库
#
# 探针只用 5 个 Windows API（`DWriteCreateFactory`、`GetStdHandle`、`WriteFile`、
# `WideCharToMultiByte`、`ExitProcess`）。为这 5 个符号去指一份 100+ MB 的 SDK
# 缓存不划算，而且那份缓存是本机 cargo-xwin 的副产物、别人机器上不一定存在 ——
# 一旦路径写死，这个工具就只能在**当前这台机器**上编，clone 下来的人只能干看。
#
# 所以导入库现场用 `lld-link /lib /def:` 从 `imports.def` 生成。导入库的格式
# 要求极低（每个符号一张跳转存根），手写 .def 完全够用，也不依赖任何 SDK。
#
# 依赖只剩两个交叉编译工具，都是 Xcode 与 rustup 自带的：
#   clang-cl  → ~/Library/Caches/cargo-xwin/clang-cl（符号链接到 Xcode 的 clang）
#   lld-link  → ~/Library/Caches/cargo-xwin/lld-link（符号链接到 rustup 的 rust-lld）
#
# 用法：
#   tools/dwrite-probe/build.sh [输出路径]
#
# 退出码：2 = 缺工具（去补环境）；1 = 编译失败（去看代码）。
set -eu

here=$(cd "$(dirname "$0")" && pwd)
out=${1:-"$here/build/probe.exe"}

cache="$HOME/Library/Caches/cargo-xwin"
clang_cl="$cache/clang-cl"
lld_link="$cache/lld-link"

if [ ! -x "$clang_cl" ]; then
    echo "缺 clang-cl：$clang_cl" >&2
    echo "它由 cargo-xwin 建好（符号链接到 Xcode 的 clang），不在系统 PATH 里。" >&2
    exit 2
fi
if [ ! -x "$lld_link" ]; then
    echo "缺 lld-link：$lld_link" >&2
    echo "它由 cargo-xwin 建好（符号链接到 rustup 的 rust-lld），不在系统 PATH 里。" >&2
    exit 2
fi

mkdir -p "$(dirname "$out")" "$here/build/lib"

# ① 现场生成导入库。`/lib` 模式只写 .lib，不产出 exe。
for dll in dwrite kernel32; do
    "$lld_link" /lib /machine:x64 \
        "/def:$here/imports.$dll.def" \
        "/out:$here/build/lib/$dll.lib"
done

# ② 编 .obj。
#
# -GS- 关掉栈保护（否则要 __security_check_cookie，而那属于 CRT）；
# -fno-builtin 阻止 clang 把手写的 slen 折成 strlen（那同样会拖进 CRT）。
#
# `--` 不能省：clang-cl 会把 `/Users/...` 这样的绝对路径当成 `/U` 选项，
# 报「no input files」—— 报错完全没提路径，很容易误判成文件不存在。
"$clang_cl" --target=x86_64-pc-windows-msvc \
    -c -O1 -GS- -fno-builtin \
    -I"$here" \
    -Fo"$here/build/probe.obj" \
    -- "$here/probe.c"

# ③ 链接。`/nodefaultlib` 让它不要去找 msvcrt / libcmt（本机也没有）。
"$lld_link" /nodefaultlib /entry:entry /subsystem:console \
    /out:"$out" \
    "$here/build/probe.obj" \
    "/libpath:$here/build/lib" \
    dwrite.lib kernel32.lib

echo "built: $out"
file "$out"
