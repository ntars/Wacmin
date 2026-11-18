"""跨阶段共享的数据模型。

阶段 0 只定义契约，不实现流程。后续阶段填充字段、增加解析器，
但已有字段名与含义不改，否则 compat.yaml 会失去向后兼容。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any


class InstallerKind(StrEnum):
    """安装器类型。与 5.1 静默参数表一一对应。"""

    NSIS = "nsis"
    INNO = "inno"
    INSTALLSHIELD = "installshield"
    MSI = "msi"
    BURN = "burn"          # WiX Burn bundle
    SQUIRREL = "squirrel"  # Electron / Squirrel.Windows
    UNKNOWN = "unknown"


#: 阶段 1 承诺支持的静态解包类型；其余记录进仓库根 README.md 第 14.5 节。
STATIC_EXTRACTABLE: frozenset[InstallerKind] = frozenset(
    {InstallerKind.NSIS, InstallerKind.INNO, InstallerKind.MSI}
)


@dataclass(slots=True)
class Detection:
    """安装器识别结果。"""

    path: Path
    kind: InstallerKind
    confidence: float                      # 0.0 - 1.0
    evidence: list[str] = field(default_factory=list)
    arch: str | None = None                # x86 / x86_64 / arm64
    product_name: str | None = None
    product_version: str | None = None
    vendor: str | None = None
    silent_args: str | None = None
    unsupported_reason: str | None = None   # 铁律 6 命中时填这里

    @property
    def supported(self) -> bool:
        return self.unsupported_reason is None and self.kind is not InstallerKind.UNKNOWN


@dataclass(slots=True)
class ExeCandidate:
    """解包后找到的候选主程序。"""

    relpath: str            # 相对解包根目录
    size: int
    score: float            # 主程序打分，越高越像入口
    reasons: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ExtractResult:
    """静态解包结果。"""

    root: Path
    kind: InstallerKind
    file_count: int
    total_bytes: int
    candidates: list[ExeCandidate] = field(default_factory=list)
    #: 安装包自己声明的启动目标（目前只有 MSI 能从 Shortcut 表拿到）。
    #: 相对解包根目录的路径，空串表示没有这项信息。
    #: 有它时优先于 candidates 的启发式打分 —— 作者写的比我们猜的准。
    shortcut_entry: str = ""

    @property
    def primary(self) -> ExeCandidate | None:
        return self.candidates[0] if self.candidates else None


@dataclass(slots=True)
class LayerRef:
    """共享层引用。"""

    name: str
    version: str | None = None
    mounted: bool = True


@dataclass(slots=True)
class InstallerRecord:
    """compat.yaml 的 installer 段。"""

    kind: InstallerKind = InstallerKind.UNKNOWN
    silent_args: str = ""
    completed: bool = False
    fallback_interactive: bool = False


@dataclass(slots=True)
class CompatConfig:
    """compat.yaml 的内存表示。

    字段顺序与仓库根 README.md 第 11.2 节的示例一致，序列化时按此顺序输出。
    """

    app: str
    version: str = ""
    entry: str = ""                       # 相对 Private 的 drive_c 路径
    installer: InstallerRecord = field(default_factory=InstallerRecord)
    layers: list[str] = field(default_factory=lambda: ["base"])
    font_map: dict[str, str] = field(default_factory=dict)
    file_associations: list[str] = field(default_factory=list)
    known_issues: list[str] = field(default_factory=list)
    bundle_id: str = ""
    icon_source: str = ""

    def to_dict(self) -> dict[str, Any]:
        """输出为 compat.yaml 的字典形态（顺序即文件顺序）。"""
        return {
            "app": self.app,
            "version": self.version,
            "entry": self.entry,
            "installer": {
                "type": str(self.installer.kind),
                "silent_args": self.installer.silent_args,
                "completed": self.installer.completed,
                "fallback_interactive": self.installer.fallback_interactive,
            },
            "layers": list(self.layers),
            "font_map": dict(self.font_map),
            "file_associations": list(self.file_associations),
            "known_issues": list(self.known_issues),
            "bundle_id": self.bundle_id,
            "icon_source": self.icon_source,
        }