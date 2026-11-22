"""launcher 编译与 LaunchServices 注册。

launcher 是 Swift 源码（`launcher/Sources/main.swift`），用 swiftc 直接编译成
`Contents/MacOS/launcher`。不做 Xcode 工程 —— 一个文件的项目引入 .xcodeproj
只会带来签名与 scheme 的额外复杂度。

编译产物缓存在 `launcher/.build/launcher`：源码没改就复用，一次打包省 1~2 秒。
缓存按「源码 mtime 更新」失效，比哈希整份源码便宜且足够准确。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from ..errors import MissingDependency, UsageError
from ..tools import TEXT_MODE

#: swiftc 参数。arm64 原生编译（launcher 本身不跨架构，wine 才走 Rosetta）。
#: `-parse-as-library` 是必需的：main.swift 用了 @main 属性，不加会报
#: "top-level code" 冲突。
SWIFTC_FLAGS = (
    "-O",
    "-whole-module-optimization",
    "-parse-as-library",
    "-target", "arm64-apple-macos13.0",
    "-framework", "AppKit",
    "-framework", "Foundation",
)

#: swiftc 默认的 ~/.cache/clang/ModuleCache 在受管环境里可能不可写。
#: 显式落到 TMPDIR：失败后只会变慢，不会让 launcher 编译整体失败。
SWIFTC_MODULE_CACHE = Path(tempfile.gettempdir()) / "wacmin-swift-module-cache"

#: LaunchServices 注册工具的可能位置。macOS 13 之后位置固定，但历史上变过，
#: 因此按优先级探测而不是写死一条路径。
_LSREGISTER_CANDIDATES = (
    "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/"
    "LaunchServices.framework/Versions/A/Support/lsregister",
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/"
    "LaunchServices.framework/Support/lsregister",
)


def repo_root() -> Path:
    """exeonmac 目录。"""
    return Path(__file__).resolve().parents[2]


def launcher_source() -> Path:
    """返回 `launcher/Sources/main.swift` 的路径。"""
    return repo_root() / "launcher" / "Sources" / "main.swift"


def cached_launcher() -> Path:
    """编译缓存的落点。"""
    return repo_root() / "launcher" / ".build" / "launcher"


def _swiftc() -> str:
    found = shutil.which("swiftc")
    if not found:
        raise MissingDependency(
            "缺少 swiftc",
            hint="安装 Xcode Command Line Tools：xcode-select --install",
        )
    return found


def compile_launcher(dest: Path, *, source: Path | None = None,
                     use_cache: bool = True) -> Path:
    """编译 launcher 到 dest，返回 dest。

    编译失败时把 swiftc 的 stderr 原样带进异常 —— 吞掉编译错误会让人
    以为"打包成功了但双击没反应"，排查成本极高。
    """
    src = Path(source) if source is not None else launcher_source()
    dest = Path(dest)
    if not src.is_file():
        raise MissingDependency(f"缺少 launcher 源码：{src}")

    cache = cached_launcher()
    cache_fresh = (
        use_cache and cache.is_file()
        and cache.stat().st_mtime >= src.stat().st_mtime
    )

    dest.parent.mkdir(parents=True, exist_ok=True)

    if cache_fresh:
        shutil.copyfile(cache, dest)
        os.chmod(dest, 0o755)
        return dest

    cache.parent.mkdir(parents=True, exist_ok=True)
    SWIFTC_MODULE_CACHE.mkdir(parents=True, exist_ok=True)
    argv = [
        _swiftc(), *SWIFTC_FLAGS,
        "-module-cache-path", str(SWIFTC_MODULE_CACHE),
        "-o", str(cache), str(src),
    ]
    result = subprocess.run(argv, capture_output=True, **TEXT_MODE)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise UsageError(
            f"launcher 编译失败（退出码 {result.returncode}）：\n{detail}",
            hint="检查 Xcode Command Line Tools 是否为最新：xcode-select --install",
        )
    if not cache.is_file():
        raise UsageError("swiftc 未产出可执行文件")

    shutil.copyfile(cache, dest)
    os.chmod(dest, 0o755)
    return dest


def _lsregister() -> Path | None:
    for candidate in _LSREGISTER_CANDIDATES:
        path = Path(candidate)
        if path.is_file() and os.access(path, os.X_OK):
            return path
    return None


def register_app(app_dir: Path) -> bool:
    """注册到 LaunchServices，成功返回 True。

    失败**不抛异常**：注册只是为了 Dock 图标与「打开方式」立刻生效，
    LaunchServices 在首次打开时还会自己重建索引。为一个可以自愈的
    副作用中断整个打包流程不划算，因此只返回布尔让调用方记 WARN。
    """
    app_dir = Path(app_dir)
    if not app_dir.is_dir():
        return False

    tool = _lsregister()
    if tool is not None:
        try:
            result = subprocess.run([str(tool), "-f", str(app_dir)],
                                    capture_output=True, **TEXT_MODE, timeout=60)
            if result.returncode == 0:
                return True
        except (OSError, subprocess.SubprocessError):
            # codesign 不可用（未装 Xcode 命令行工具）时返回 False，由调用
            # 方决定能否用未签名的方式继续。不能在这里抛 —— 签名是可选步骤。
            pass

    # 兜底：用 open -a 触发一次注册。会短暂弹一下应用，但只发生在
    # lsregister 不可用时，属于罕见路径。
    try:
        subprocess.run(["open", "-a", str(app_dir)], capture_output=True,
                       **TEXT_MODE, timeout=20)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def unregister_app(app_dir: Path) -> bool:
    """从 LaunchServices 注销。产物被删除或重建前调用，避免残留条目。"""
    tool = _lsregister()
    if tool is None:
        return False
    try:
        result = subprocess.run([str(tool), "-u", str(Path(app_dir))],
                                capture_output=True, **TEXT_MODE, timeout=60)
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


__all__ = [
    "SWIFTC_FLAGS", "cached_launcher", "compile_launcher", "launcher_source",
    "register_app", "repo_root", "unregister_app",
]
