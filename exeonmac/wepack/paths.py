"""全局路径解析。

所有可变状态只允许落在两处（铁律 3）：
  1. 包内 Contents/Resources/Private/
  2. ~/Library/Application Support/wexe/

环境变量 WEXE_HOME 可整体重定向 wexe 主目录，测试时用它隔离，不去碰真实目录。
"""

from __future__ import annotations

import os
from pathlib import Path

APP_SUPPORT_DIR = "wexe"


def wexe_home() -> Path:
    """共享层主目录，默认 ~/Library/Application Support/wexe。"""
    override = os.environ.get("WEXE_HOME")
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / "Library" / "Application Support" / APP_SUPPORT_DIR


def layers_root() -> Path:
    return wexe_home() / "layers"


def runtime_root() -> Path:
    return wexe_home() / "runtime"


def wine_root() -> Path:
    """wine 二进制目录，launcher 会把其中的 bin 加进 PATH。"""
    return runtime_root() / "wine"


def logs_root() -> Path:
    return wexe_home() / "logs"


def recipes_root() -> Path:
    """本地配方库，按阶段 5 的约定放在 ~/.wexe/recipes。"""
    override = os.environ.get("WEXE_RECIPES")
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / ".wexe" / "recipes"


def ensure_dirs() -> None:
    """创建 wexe 主目录骨架，幂等。"""
    for path in (layers_root(), wine_root(), logs_root()):
        path.mkdir(parents=True, exist_ok=True)