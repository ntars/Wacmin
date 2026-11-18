"""日志。

默认写 stderr，避免污染 stdout 的机器可读输出（`--json`）。
同时支持落盘到 wexe/logs/<name>.log，供阶段 2 的安装过程留证。
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

LOGGER_NAME = "wepack"

_FORMAT = "%(asctime)s %(levelname)-7s %(message)s"
_DATE_FORMAT = "%H:%M:%S"


def get_logger() -> logging.Logger:
    return logging.getLogger(LOGGER_NAME)


def setup(verbose: bool = False, logfile: Path | None = None) -> logging.Logger:
    """初始化日志。重复调用是幂等的，只调整级别与新增文件句柄。"""
    logger = get_logger()
    logger.setLevel(logging.DEBUG if verbose else logging.INFO)
    logger.propagate = False

    if not any(getattr(h, "_wepack_stream", False) for h in logger.handlers):
        stream = logging.StreamHandler(stream=sys.stderr)
        stream.setFormatter(logging.Formatter(_FORMAT, _DATE_FORMAT))
        stream._wepack_stream = True  # type: ignore[attr-defined]
        logger.addHandler(stream)

    if logfile is not None:
        logfile.parent.mkdir(parents=True, exist_ok=True)
        target = str(logfile.resolve())
        if not any(getattr(h, "_wepack_path", None) == target for h in logger.handlers):
            fh = logging.FileHandler(target, encoding="utf-8")
            fh.setFormatter(logging.Formatter(_FORMAT, _DATE_FORMAT))
            fh._wepack_path = target  # type: ignore[attr-defined]
            logger.addHandler(fh)

    return logger