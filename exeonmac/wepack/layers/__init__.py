"""共享层管理。

层是预先构建好的 prefix 片段，用 APFS clonefile 复用到每个应用包，
避免每个包都从零 wineboot。

**层怎么来的**：base 层由 `wepack layers build base` 生成 —— 跑一次
wineboot 得到干净 prefix，再把它搬进 layers/base。vcpp / dotnet / fonts-cn
需要用户提供安装包，本工具不代下载（离线原则）。

**挂载语义（4.2）**：读时先 Private 再 Layers，写只写 Private。
实现方式是初始化时 clonefile 叠加成单一目录树 —— 不用 overlay 文件系统
（那需要 macFUSE，已禁止）。层内容只需在 prefix 初始化时复制一次，
后续写入都落在 Private 的克隆副本上，天然满足"写不污染共享层"。
"""

from __future__ import annotations

import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from .. import paths as wexe_paths
from ..errors import InstallFailed, UsageError

#: 已知层名与用途。index.yaml 缺失时用它兜底。
#:
#: **这里的 dlls 列表是按真实缺口写的，不是照抄「常见 Windows 运行库清单」。**
#: 实测 wine 11.21 的 base 层：`system32` 已含全部 28 个 VC++ 运行库
#: （`msvcp*` / `msvcr*` / `vcruntime*` / `vcomp*`）与 6 个 ATL。因此：
#:
#:   - vcpp 层在 wine 下**通常不需要**，保留定义只为极端情况（用户要
#:     覆盖成微软原版运行库）。匹配器会先查 base，绝大多数包不会挂它。
#:   - **MFC 是真缺口**：base 里没有任何 `mfc*.dll`。
#:   - **.NET 是真缺口**：base 只有 `mscoree.dll` stub，没有 `mscorlib`。
#:   - **中文字体是真缺口**：base 的 `Fonts/` 是空目录。
BUILTIN_LAYERS: dict[str, dict] = {
    "base": {
        "description": "Windows 骨架：drive_c/windows、system32、注册表初始态",
        "dlls": [],
        "requires": [],
        "priority": 0,
    },
    "vcpp": {
        "description": "VC++ 2005-2022 运行库（base 已内置，仅用于覆盖成微软原版）",
        "dlls": ["msvcp140", "vcruntime140", "msvcr120", "msvcr100",
                 "msvcp120", "msvcp100", "vcomp140"],
        "requires": ["base"],
        "priority": 10,
    },
    "mfc": {
        "description": "MFC 运行库（mfc140u / mfc120u 等，base 不含）",
        "dlls": ["mfc140u", "mfc140", "mfc120u", "mfc120", "mfc110u",
                 "mfc110", "mfc100u", "mfc100", "mfcm140u", "mfcm140"],
        "requires": ["base"],
        "priority": 15,
    },
    "dotnet": {
        "description": ".NET Framework 4.x（base 只有 mscoree stub）",
        "dlls": ["mscoree", "mscorlib", "clr", "clrjit", "system",
                 "system.core", "mscorwks", "mscorsvr"],
        "requires": ["base"],
        "priority": 20,
    },
    "fonts-cn": {
        "description": "中文字体（SimSun / MS YaHei，base 的 Fonts 为空）",
        "dlls": [],
        "requires": ["base"],
        "priority": 5,
    },
}

#: 每层必须含有的标志路径，用于 verify
LAYER_MARKERS: dict[str, str] = {
    "base": "drive_c/windows/system32",
    "vcpp": "drive_c/windows/system32",
    "mfc": "drive_c/windows/system32",
    "dotnet": "drive_c/windows/Microsoft.NET",
    "fonts-cn": "drive_c/windows/Fonts",
}


@dataclass(slots=True)
class LayerInfo:
    name: str
    path: Path
    exists: bool
    files: int = 0
    bytes: int = 0
    problems: list[str] = field(default_factory=list)
    description: str = ""

    @property
    def ok(self) -> bool:
        return self.exists and not self.problems


def _tree_size(root: Path) -> tuple[int, int]:
    files = 0
    total = 0
    for path in root.rglob("*"):
        if path.is_file() and not path.is_symlink():
            files += 1
            try:
                total += path.stat().st_size
            except OSError:
                # 统计体积时跳过读不到的文件。这是给人看的参考数字，为它中断
                # 整个层扫描不值得。
                pass
    return files, total


def layer_path(name: str) -> Path:
    return wexe_paths.layers_root() / name


def inspect_layer(name: str) -> LayerInfo:
    """检查单个层的状态。不抛异常。"""
    path = layer_path(name)
    info = LayerInfo(name=name, path=path, exists=path.is_dir(),
                     description=BUILTIN_LAYERS.get(name, {}).get("description", ""))

    if not info.exists:
        info.problems.append(f"层目录不存在：{path}")
        return info

    files, total = _tree_size(path)
    info.files = files
    info.bytes = total

    marker = LAYER_MARKERS.get(name)
    if marker and not (path / marker).exists():
        info.problems.append(f"缺少标志路径：{marker}")

    if files == 0:
        info.problems.append("层为空")

    return info


def list_layers() -> list[LayerInfo]:
    """列出所有已知层（含未安装的）。"""
    names = set(BUILTIN_LAYERS)
    root = wexe_paths.layers_root()
    if root.is_dir():
        for child in root.iterdir():
            if child.is_dir() and not child.name.startswith("."):
                names.add(child.name)
    return [inspect_layer(name) for name in sorted(names)]


def build_base_layer(*, timeout: int = 600) -> LayerInfo:
    """构建 base 层：跑一次 wineboot，把干净 prefix 搬进 layers/base。

    这是阶段 2 的前置。只有第一次需要，之后所有应用包 clonefile 复用。

    流程：
      1. 在临时目录跑 wineboot -u（不直接在 layers/base 里跑，
         否则中途失败会留下半个 prefix）
      2. 校验 system32 非空
      3. 搬到 layers/base
    """
    from ..install import wine_binary, wineboot_init
    from ..prefix import validate_prefix

    wine_binary()   # 缺运行时立即报错，不要跑到一半才发现

    target = layer_path("base")
    if target.is_dir() and any(target.iterdir()):
        raise UsageError(
            f"base 层已存在：{target}",
            hint="wepack 不删除已有内容。确认要重建时先手动移走该目录",
        )

    with tempfile.TemporaryDirectory(prefix="exeonmac-base-") as tmp:
        staging = Path(tmp) / "prefix"
        staging.mkdir()

        result = wineboot_init(staging, timeout=timeout)
        if not result.ok:
            raise InstallFailed(
                "wineboot 失败，无法构建 base 层",
                hint=(result.stderr_tail or result.stdout_tail or "")[:600],
            )

        problems = validate_prefix(staging)
        if problems:
            raise InstallFailed(
                "base 层校验失败",
                hint="；".join(problems),
            )

        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
        shutil.move(str(staging), str(target))

    return inspect_layer("base")


def verify_layer(name: str) -> list[str]:
    """校验层完整性。返回问题列表。"""
    return inspect_layer(name).problems


def mount_layer(app_dir: Path, name: str) -> Path:
    """把层 clonefile 进 .app 的 Private/。"""
    from ..prefix import _clone_into

    private_dir = Path(app_dir) / "Contents" / "Resources" / "Private"
    if not private_dir.is_dir():
        raise UsageError(f"不是已安装的 .app（缺 Private/）：{app_dir}")

    source = layer_path(name)
    if not source.is_dir():
        raise InstallFailed(
            f"层不存在：{name}",
            hint=f"预期 {source}。先执行 wepack layers build {name}",
        )

    result = _clone_into(source, private_dir)
    if not result.ok:
        raise InstallFailed(f"挂载 {name} 失败", hint=result.note)
    return private_dir


__all__ = [
    "BUILTIN_LAYERS", "LAYER_MARKERS", "LayerInfo",
    "layer_path", "inspect_layer", "list_layers", "build_base_layer",
    "verify_layer", "mount_layer",
    "match", "match_layers", "describe", "scan_dependencies",
]


def __getattr__(name: str):
    """惰性转出 match 子模块的符号。

    这样 `from wepack.layers import match_layers` 能直接工作，同时
    不引入循环导入（match.py 反过来要 import 本模块的 BUILTIN_LAYERS）。

    必须用 importlib 而不是 `from . import match`：后者会走模块的
    `__getattr__`，导致无限递归。
    """
    if name in ("match", "match_layers", "describe", "scan_dependencies",
                "base_dll_index", "Dependency", "MatchResult",
                "normalize_dll_name"):
        import importlib
        module = importlib.import_module(f"{__name__}.match")
        return module if name == "match" else getattr(module, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")