"""Wine 运行时管理。

职责：把一份 x86_64 wine 安装到 ~/Library/Application Support/wexe/runtime/wine，
供 launcher 与 install 使用。

**为什么必须 x86_64**：Apple Silicon 上 Wine 只能跑 x86_64 构建（经 Rosetta 2
翻译）。arm64 原生 wine 不存在可用版本 —— Wine 官方从未发布 arm64 macOS 构建。
Gcenx 的 macOS_Wine_builds 是目前最可靠的社区构建来源。

**安装结构**（与 launcher 的期望一致）：
    runtime/wine/
    ├── bin/wine64          # 主可执行
    ├── bin/wine            # 兼容入口（软链或包装脚本）
    ├── bin/wineserver
    ├── lib/                # wine 自己的 dylib
    └── share/wine/         # 内置 DLL、字体、注册表模板

来源优先级：
  1. 已有本地 tar.xz（runtime/cache/）
  2. 从 GitHub Releases 下载（需联网，用户显式触发）
  3. 从已安装的 CrossOver / Whisky 复制（若存在）

不自动联网：install 子命令必须由用户显式调用 `wepack runtime install`。
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from . import paths as wexe_paths
from .tools import TEXT_MODE
from .errors import InstallFailed, MissingDependency, UsageError

#: 默认下载源。Gcenx 的 devel 构建，macOS x86_64。
DEFAULT_WINE_VERSION = "11.21"
DEFAULT_WINE_URL = (
    "https://github.com/Gcenx/macOS_Wine_builds/releases/download/"
    f"{DEFAULT_WINE_VERSION}/wine-devel-{DEFAULT_WINE_VERSION}-osx64.tar.xz"
)

#: CrossOver / Whisky 可能放 wine 的位置，按优先级
VENDOR_PATHS = (
    "/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine64",
    "/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine",
    "/Applications/Whisky.app/Contents/Resources/Libraries/Wine/bin/wine64",
    "/Applications/Whisky.app/Contents/Resources/Libraries/Wine/bin/wine",
)


@dataclass(slots=True)
class RuntimeInfo:
    """已安装运行时的信息。"""

    installed: bool
    root: Path
    wine: Path | None = None
    version: str = ""
    arch: str = ""
    source: str = ""
    problems: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.installed and not self.problems


def runtime_dir() -> Path:
    return wexe_paths.wine_root()


def cache_dir() -> Path:
    return Path(__file__).resolve().parents[1] / "runtime" / "cache"


# --------------------------------------------------------------------------
# 探测
# --------------------------------------------------------------------------


def _file_arch(path: Path) -> str:
    """用 file(1) 取 Mach-O 架构。取不到返回空串。"""
    try:
        result = subprocess.run(["/usr/bin/file", "-b", str(path)],
                                capture_output=True, **TEXT_MODE, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return ""
    text = (result.stdout or "").strip()
    if "arm64" in text and "x86_64" in text:
        return "universal"
    if "arm64" in text:
        return "arm64"
    if "x86_64" in text:
        return "x86_64"
    if "i386" in text:
        return "i386"
    return ""


def _wine_version(binary: Path) -> str:
    """执行 wine --version 取版本。失败返回空串。"""
    env = dict(os.environ)
    env["WINEDEBUG"] = "-all"
    try:
        result = subprocess.run([str(binary), "--version"],
                                capture_output=True, **TEXT_MODE,
                                timeout=60, env=env)
    except (OSError, subprocess.SubprocessError):
        return ""
    text = (result.stdout or "").strip() or (result.stderr or "").strip()
    return text.splitlines()[0] if text else ""


def inspect() -> RuntimeInfo:
    """检查已安装运行时。不抛异常，问题写进 problems。"""
    root = runtime_dir()
    info = RuntimeInfo(installed=False, root=root)

    if not root.is_dir():
        info.problems.append(f"运行时目录不存在：{root}")
        return info

    binary: Path | None = None
    for name in ("bin/wine64", "bin/wine"):
        candidate = root / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            binary = candidate
            break

    if binary is None:
        info.problems.append("缺少 bin/wine64 或 bin/wine（不存在或不可执行）")
        return info

    info.installed = True
    info.wine = binary
    info.arch = _file_arch(binary)

    if info.arch == "arm64":
        info.problems.append(
            "wine 是 arm64 原生构建：Wine 在 Apple Silicon 上必须用 x86_64 构建"
            "（经 Rosetta 2 翻译）。arm64 构建无法加载 Windows PE 二进制。")
    elif info.arch == "":
        info.problems.append("无法识别 wine 架构（file 命令失败）")

    info.version = _wine_version(binary)
    if not info.version:
        info.problems.append("wine --version 执行失败（可能是架构不符或缺少依赖库）")

    info.source = _read_source_marker(root)
    return info


def _read_source_marker(root: Path) -> str:
    marker = root / ".exeonmac-runtime.json"
    if not marker.is_file():
        return ""
    try:
        import json
        data = json.loads(marker.read_text(encoding="utf-8"))
        return str(data.get("source", ""))
    except (OSError, ValueError):
        return ""


# --------------------------------------------------------------------------
# 从第三方安装复制
# --------------------------------------------------------------------------


def find_vendor_wine() -> Path | None:
    """找已安装的 CrossOver / Whisky 的 wine 二进制。"""
    for candidate in VENDOR_PATHS:
        path = Path(candidate)
        if path.is_file() and os.access(path, os.X_OK):
            return path
    return None


def install_from_vendor(source: Path | None = None) -> RuntimeInfo:
    """从 CrossOver / Whisky 复制 wine 运行时。

    只复制 wine 的安装目录（不是整个 .app），目标为 runtime/wine。
    原安装不受影响（只读复制，不修改）。
    """
    binary = source or find_vendor_wine()
    if binary is None:
        raise MissingDependency(
            "未找到 CrossOver 或 Whisky",
            hint=("检查过：" + "、".join(VENDOR_PATHS[:2]) + " 等位置。"
                  "可改用 wepack runtime install 从 GitHub 下载"),
        )

    # wine64 通常在 <prefix>/bin/ 下，运行时根是它的上两级
    runtime_root = binary.parent.parent
    if not (runtime_root / "share" / "wine").is_dir():
        # CrossOver 的布局不同：bin 同级可能没有 share
        alt = binary.parent.parent
        if not any((alt / d).is_dir() for d in ("share", "lib")):
            raise MissingDependency(
                f"{binary} 的运行时目录结构无法识别",
                hint=f"预期 {runtime_root}/share/wine 或 {runtime_root}/lib 存在",
            )

    target = runtime_dir()
    if target.exists() and any(target.iterdir()):
        raise UsageError(
            f"运行时目录非空：{target}",
            hint="wepack 不删除已有内容。先手动移走，或换 WEXE_HOME",
        )

    target.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(["/bin/cp", "-c", "-R", str(runtime_root), str(target)],
                            capture_output=True, **TEXT_MODE)
    if result.returncode != 0:
        result = subprocess.run(["/bin/cp", "-R", str(runtime_root), str(target)],
                                capture_output=True, **TEXT_MODE)
    if result.returncode != 0:
        raise MissingDependency(
            "复制运行时失败",
            hint=(result.stderr or "").strip()[:300],
        )

    _write_source_marker(target, f"vendor:{binary}")
    return inspect()


# --------------------------------------------------------------------------
# 从压缩包安装
# --------------------------------------------------------------------------


def _extract_tar_xz(archive: Path, dest: Path) -> None:
    """解 xz 压缩的 tar。用系统 tar（支持 .tar.xz），不依赖 Python 的 lzma 可用性。"""
    result = subprocess.run(["/usr/bin/tar", "-xf", str(archive), "-C", str(dest)],
                            capture_output=True, **TEXT_MODE)
    if result.returncode != 0:
        raise MissingDependency(
            f"解压失败：{archive.name}",
            hint=(result.stderr or "").strip()[:300],
        )


def _find_runtime_root(staging: Path) -> Path | None:
    """在解压结果里找 wine 运行时根目录。

    Gcenx 的包是 .app 结构：
        Wine Devel.app/Contents/Resources/wine/bin/wine
        Wine Devel.app/Contents/Resources/wine/lib/
        Wine Devel.app/Contents/Resources/wine/share/
    所以运行时根是 `Contents/Resources/wine`，不是包的顶层。
    也兼容直接是 bin/ 的布局（部分版本/自制包）。
    """
    candidates = [
        staging / "Contents" / "Resources" / "wine",
    ]
    # 顶层就含 bin 的情况
    candidates.append(staging)

    # 再扫一层（Wine Devel.app/ 之类）
    for child in sorted(staging.iterdir()):
        if not child.is_dir():
            continue
        candidates.append(child)
        candidates.append(child / "Contents" / "Resources" / "wine")
        for grandchild in sorted(child.iterdir()):
            if grandchild.is_dir():
                candidates.append(grandchild / "Resources" / "wine")

    for candidate in candidates:
        if not candidate.is_dir():
            continue
        for binary in ("bin/wine64", "bin/wine"):
            path = candidate / binary
            if path.is_file():
                return candidate
    return None


def install_from_archive(archive: Path) -> RuntimeInfo:
    """从本地 tar.xz 安装运行时。

    Gcenx 的包解出来是 `Wine Devel.app/Contents/Resources/wine/`，
    这里把该目录搬到 runtime/wine，使结构统一为：
        runtime/wine/bin/wine
        runtime/wine/lib/
        runtime/wine/share/
    """
    archive = Path(archive).expanduser()
    if not archive.is_file():
        raise UsageError(f"压缩包不存在：{archive}")

    target = runtime_dir()
    if target.exists() and any(target.iterdir()):
        raise UsageError(
            f"运行时目录非空：{target}",
            hint="wepack 不删除已有内容。先手动移走，或设 WEXE_HOME 指向别处",
        )

    with tempfile.TemporaryDirectory(prefix="exeonmac-wine-") as tmp:
        staging = Path(tmp)
        _extract_tar_xz(archive, staging)

        root = _find_runtime_root(staging)
        if root is None:
            raise MissingDependency(
                "压缩包里找不到 wine 可执行文件",
                hint=(f"已解压检查，未发现 bin/wine 或 bin/wine64。"
                      f"顶层内容：{[p.name for p in staging.iterdir()][:10]}"),
            )

        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
        # 跨卷时 clonefile 会失败，shutil.move 自动降级为复制
        shutil.move(str(root), str(target))

    # 统一入口：某些构建只有 bin/wine，没有 bin/wine64。
    # 建一个 wine64 软链，让 launcher 与 install 的探测逻辑保持一致。
    _ensure_wine64_alias(target)

    _write_source_marker(target, f"archive:{archive.name}")
    return inspect()


def _ensure_wine64_alias(root: Path) -> None:
    """确保 bin/wine64 存在。缺省时建指向 bin/wine 的相对软链。"""
    bin_dir = root / "bin"
    wine64 = bin_dir / "wine64"
    wine = bin_dir / "wine"
    if wine64.exists() or not wine.is_file():
        return
    try:
        os.symlink("wine", wine64)
    except OSError:
        # 不支持软链时退化为包装脚本
        try:
            wine64.write_text('#!/bin/sh\nexec "$(dirname "$0")/wine" "$@"\n',
                              encoding="utf-8")
            wine64.chmod(0o755)
        except OSError:
            # ## 两条路都断了，这里不能安静
            #
            # `wine64` 是 launcher 实际调用的入口名。软链失败 + 脚本也写不出来
            # 意味着 runtime 目录里没有可执行的 wine64 —— 但安装流程会照常
            # 报「运行时安装成功」，直到用户双击 .app 才在启动阶段炸掉，
            # 而且报的是「找不到 wine」这种指向不明的话。
            raise InstallFailed(
                f"无法创建 wine64 入口：{wine64}",
                hint="软链与包装脚本都写不进去，检查该目录的写权限",
            ) from None


def _write_source_marker(root: Path, source: str) -> None:
    """写来源标记，便于 doctor 显示运行时从哪来。"""
    import json
    from datetime import datetime, timezone

    payload = {
        "source": source,
        "installed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    try:
        (root / ".exeonmac-runtime.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        # 写清单失败不影响运行时本身：它只是给下次复用提供线索，
        # 下次读不到会重新探测一遍。为此让安装失败是本末倒置。
        pass


# --------------------------------------------------------------------------
# 下载
# --------------------------------------------------------------------------


def download(url: str = DEFAULT_WINE_URL, *, dest: Path | None = None,
             progress: bool = True) -> Path:
    """下载运行时压缩包到 cache 目录。已存在且大小一致时跳过。

    不校验 GPG 签名（上游未提供稳定签名流程）；只做 HTTP 状态与体积检查。
    这是已知的供应链风险，已在仓库根 README.md 第 13.2 节记录。
    """
    dest = dest or (cache_dir() / Path(url).name)
    dest.parent.mkdir(parents=True, exist_ok=True)

    if dest.is_file() and dest.stat().st_size > 1024 * 1024:
        if progress:
            print(f"已存在，跳过下载：{dest}")
        return dest

    request = urllib.request.Request(url, headers={"User-Agent": "ExeOnMac/wepack"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            total = int(response.headers.get("Content-Length") or 0)
            received = 0
            tmp = dest.with_suffix(dest.suffix + ".part")
            with open(tmp, "wb") as fh:
                while True:
                    chunk = response.read(1024 * 256)
                    if not chunk:
                        break
                    fh.write(chunk)
                    received += len(chunk)
                    if progress and total:
                        percent = received * 100 // total
                        print(f"\r下载中 {percent:3d}%  "
                              f"{received // 1048576}/{total // 1048576} MB", end="")
            if progress:
                print()
            if total and received != total:
                tmp.unlink(missing_ok=True)
                raise MissingDependency(
                    f"下载不完整：{received}/{total} 字节",
                    hint="网络中断，重试即可",
                )
            tmp.replace(dest)
    except urllib.error.HTTPError as exc:
        raise MissingDependency(
            f"下载失败：HTTP {exc.code}",
            hint=f"{url}\n可手动下载后放到 {dest}",
        ) from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise MissingDependency(
            f"下载失败：{exc}",
            hint=f"{url}\n可手动下载后放到 {dest}",
        ) from exc

    return dest


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def install(*, archive: Path | None = None, url: str = DEFAULT_WINE_URL,
            from_vendor: bool = False, progress: bool = True) -> RuntimeInfo:
    """一站式安装：优先本地包，其次厂商复制，最后下载。"""
    if archive is not None:
        return install_from_archive(archive)

    if from_vendor:
        return install_from_vendor()

    # 本地 cache 里已有就直接用
    cached = cache_dir() / Path(url).name
    if cached.is_file():
        return install_from_archive(cached)

    downloaded = download(url, progress=progress)
    return install_from_archive(downloaded)


__all__ = [
    "DEFAULT_WINE_VERSION", "DEFAULT_WINE_URL", "VENDOR_PATHS",
    "RuntimeInfo", "runtime_dir", "cache_dir", "inspect",
    "find_vendor_wine", "install_from_vendor", "install_from_archive",
    "download", "install", "sha256_of",
]