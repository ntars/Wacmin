"""统一错误类型与退出码。

退出码是 CLI 的对外契约，脚本与自动化依赖它，不要随意改动。
"""

from __future__ import annotations

from enum import IntEnum


class ExitCode(IntEnum):
    """进程退出码。"""

    OK = 0
    GENERIC = 1            # 未归类的失败
    USAGE = 2              # 参数错误（argparse 也用 2）
    NOT_IMPLEMENTED = 3    # 该能力属于后续阶段，当前阶段未实现
    UNSUPPORTED = 4        # 安装器类型或软件类别明确不支持
    MISSING_DEP = 5        # 缺 wine runtime / sips / 7z 等外部依赖
    INSTALL_FAILED = 6     # prefix 创建或静默安装失败
    VERIFY_FAILED = 7      # 产物校验不通过


class WexeError(Exception):
    """所有 wepack 主动抛出的错误的基类。"""

    exit_code: ExitCode = ExitCode.GENERIC

    def __init__(self, message: str, *, hint: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint


class UsageError(WexeError):
    exit_code = ExitCode.USAGE


class PhaseNotImplemented(WexeError):
    """能力存在接口但实现属于后续阶段。"""

    exit_code = ExitCode.NOT_IMPLEMENTED

    def __init__(self, capability: str, phase: int) -> None:
        super().__init__(
            f"{capability} 尚未实现：属于阶段 {phase} 的交付内容",
            hint="当前仓库处于阶段 0，仅完成接口定义。",
        )
        self.capability = capability
        self.phase = phase


class UnsupportedSoftware(WexeError):
    """识别为铁律 6 明确不支持的类别（驱动 / 反作弊 / 硬件狗 / TPM）。"""

    exit_code = ExitCode.UNSUPPORTED


class MissingDependency(WexeError):
    exit_code = ExitCode.MISSING_DEP


class InstallFailed(WexeError):
    exit_code = ExitCode.INSTALL_FAILED


class VerifyFailed(WexeError):
    exit_code = ExitCode.VERIFY_FAILED