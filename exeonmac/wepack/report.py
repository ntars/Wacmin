"""统一运行报告。

## 为什么单独一个模块

`--json` 的输出结构被 119 项测试依赖，改它等于同时改测试与所有下游脚本。
但前端汇总又必须有一份四方向统一的格式。

解法是**两套并存**：

- `--json`：保持原有结构，供人读、供已有脚本用，不动。
- `--report`：输出 `contracts/run-report.schema.json` 定义的结构，供 console 用。

翻译逻辑只在这个模块里，CLI 不自己拼字段。

## 阶段与 mac2win 的对应

ExeOnMac 的实际流程是「识别 → 解包 → 建 prefix → 安装 → 扫描入口 → 包装」，
与 mac2win 的八阶段不是一一对应。这里做一层语义映射，让 console 能用
同一套阶段图渲染两个方向：

| 本方向阶段 | 语义 |
|---|---|
| preflight  | 环境自检与输入物存在性 |
| detect     | 识别安装器类型 |
| extract    | 静态解包（可选） |
| prefix     | 建隔离 prefix |
| install    | 静默安装 |
| scan       | 定位入口程序 |
| package    | 装配 .app |
| verify     | 产物校验 |
"""

from __future__ import annotations

import platform
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from . import PHASE, __version__

SCHEMA_VERSION = 1
DIRECTION = "exeonmac"

#: 阶段定义。顺序即执行顺序，未走到的标 skipped。
STAGES: tuple[tuple[str, str], ...] = (
    ("preflight", "预检"),
    ("detect", "识别安装器"),
    ("extract", "静态解包"),
    ("prefix", "创建 prefix"),
    ("install", "静默安装"),
    ("scan", "定位入口"),
    ("package", "装配应用包"),
    ("verify", "校验产物"),
)

STATUS_RUNNING = "running"
STATUS_OK = "ok"
STATUS_FAILED = "failed"
STATUS_SKIPPED = "skipped"


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


@dataclass
class StageRecord:
    """一个阶段的执行记录。"""

    status: str = STATUS_RUNNING
    started_at: float = 0.0
    duration_ms: int = 0
    message: str | None = None
    error_code: str | None = None


@dataclass
class StageTracker:
    """阶段状态跟踪器。

    用法：`enter("detect")` → 干活 → `leave("detect")`。
    出错时 `mark_failed("EOM_4001")` 把当前阶段标红。
    """

    started_at: str = field(default_factory=_now_iso)
    records: dict[str, StageRecord] = field(default_factory=dict)
    current: str | None = None
    _t0: float = 0.0

    def __post_init__(self) -> None:
        import time
        self._t0 = time.monotonic()

    def enter(self, stage_id: str) -> None:
        import time
        self.current = stage_id
        self.records[stage_id] = StageRecord(started_at=time.monotonic())

    def leave(self, stage_id: str) -> None:
        import time
        record = self.records.get(stage_id)
        if record is None:
            return
        record.status = STATUS_OK
        record.duration_ms = int((time.monotonic() - record.started_at) * 1000)
        self.current = None

    def mark_failed(self, error_code: str | None) -> None:
        """把当前阶段标为失败。"""
        import time
        if self.current is None:
            return
        record = self.records.get(self.current)
        if record is None:
            return
        record.status = STATUS_FAILED
        record.duration_ms = int((time.monotonic() - record.started_at) * 1000)
        record.error_code = error_code
        self.current = None

    def skip(self, stage_id: str) -> None:
        """显式标记某阶段跳过（例如不需要解包时）。"""
        self.records[stage_id] = StageRecord(status=STATUS_SKIPPED)

    def to_stages(self) -> list[dict[str, Any]]:
        """导出为契约要求的 stages 数组。"""
        result: list[dict[str, Any]] = []
        for index, (stage_id, title) in enumerate(STAGES):
            record = self.records.get(stage_id)
            item: dict[str, Any] = {
                "id": index,
                "name": title,
                "status": record.status if record else STATUS_SKIPPED,
                "durationMs": record.duration_ms if record else 0,
                "errorCode": record.error_code if record else None,
            }
            if record is not None and record.message:
                item["message"] = record.message
            result.append(item)
        return result


def _host() -> dict[str, Any]:
    return {
        "platform": "darwin" if platform.system() == "Darwin" else platform.system().lower(),
        "arch": platform.machine(),
        "osVersion": platform.mac_ver()[0] or platform.release(),
        "toolVersion": __version__,
    }


def success_report(
    *,
    tracker: StageTracker,
    artifact: str | None,
    artifact_bytes: int = 0,
    checks: list[dict[str, Any]] | None = None,
    warnings: list[str] | None = None,
    input_info: dict[str, Any] | None = None,
    command: str = "install",
    duration_ms: int = 0,
) -> dict[str, Any]:
    """组装成功报告。"""
    artifacts: list[dict[str, Any]] = []
    if artifact:
        artifacts.append({
            "path": artifact,
            "kind": "mac-app",
            "bytes": artifact_bytes,
        })

    return {
        "schemaVersion": SCHEMA_VERSION,
        "direction": DIRECTION,
        "ok": True,
        "exitCode": 0,
        "command": command,
        "startedAt": tracker.started_at,
        "finishedAt": _now_iso(),
        "durationMs": duration_ms,
        "host": _host(),
        "input": input_info or {},
        "stages": tracker.to_stages(),
        "artifacts": artifacts,
        "checks": checks or [],
        "warnings": warnings or [],
        "error": None,
    }


def failure_report(
    *,
    tracker: StageTracker,
    code: str,
    message: str,
    exit_code: int,
    hint: str | None = None,
    details: list[str] | None = None,
    command: str = "install",
) -> dict[str, Any]:
    """组装失败报告。

    失败可能发生在进入任何阶段之前（配置解析就挂了），此时全部阶段都是
    skipped，前端会显示一片灰。把第一个阶段标红并注明原因，比一片灰有用。

    失败也可能发生在**某个阶段跑完之后**：比如 detect 成功识别出「这不是
    认识的安装器」，随后判定为不支持。这种情况下 preflight / detect 都是
    ok，报告里一个 failed 都没有，但 `ok` 是 false —— 看板上会出现
    「所有阶段都绿，整体却失败」，读者无法从阶段列表里看出断在哪。
    所以这里补一条：`ok=false` 却没有 failed 阶段时，把**最后一个跑过的
    阶段**改成 failed，错误挂在真正做判断的那一步上。
    """
    stages = tracker.to_stages()
    if all(stage["status"] == STATUS_SKIPPED for stage in stages):
        stages[0]["status"] = STATUS_FAILED
        stages[0]["errorCode"] = code
        stages[0]["message"] = "流程开始前即失败"
    elif not any(stage["status"] == STATUS_FAILED for stage in stages):
        # 从后往前找最后一个真正跑过的阶段：失败就断在它之后
        for stage in reversed(stages):
            if stage["status"] == STATUS_OK:
                stage["status"] = STATUS_FAILED
                stage["errorCode"] = code
                stage["message"] = message
                break

    return {
        "schemaVersion": SCHEMA_VERSION,
        "direction": DIRECTION,
        "ok": False,
        "exitCode": exit_code,
        "command": command,
        "startedAt": tracker.started_at,
        "finishedAt": _now_iso(),
        "durationMs": 0,
        "host": _host(),
        "stages": stages,
        "artifacts": [],
        "checks": [],
        "warnings": [],
        "error": {
            "code": code,
            "message": message,
            "hint": hint,
            "details": details or [],
        },
    }


def error_code_for(exc: BaseException) -> str:
    """把异常映射成契约错误码。

    映射依据 `contracts/error-prefixes.json` 的段位：

    | 段位 | 含义 | 本方向对应 |
    |---|---|---|
    | 1xxx | 环境与输入 | 参数错、文件不存在、类型不支持 |
    | 2xxx | 外部工具 | 缺 wine / 7z / innoextract |
    | 3xxx | 运行时 | wine 运行时不可用或架构不对 |
    | 4xxx | 输入物处理 | 识别失败、解包失败 |
    | 5xxx | 产物生成 | prefix 创建、静默安装失败 |
    | 6xxx | 产物校验 | 校验不通过 |
    | 9xxx | 流程控制 | 用户中断 |
    """
    from .errors import (ExitCode, MissingDependency, PhaseNotImplemented,
                         UnsupportedSoftware, UsageError, WexeError)

    if isinstance(exc, UsageError):
        return "EOM_1003"
    if isinstance(exc, UnsupportedSoftware):
        return "EOM_1005"
    if isinstance(exc, MissingDependency):
        return "EOM_2001"
    if isinstance(exc, PhaseNotImplemented):
        return "EOM_7001"
    if isinstance(exc, KeyboardInterrupt):
        return "EOM_9001"
    if isinstance(exc, WexeError):
        return {
            ExitCode.GENERIC: "EOM_9999",
            ExitCode.USAGE: "EOM_1003",
            ExitCode.NOT_IMPLEMENTED: "EOM_7001",
            ExitCode.UNSUPPORTED: "EOM_1005",
            ExitCode.MISSING_DEP: "EOM_2001",
            ExitCode.INSTALL_FAILED: "EOM_5001",
            ExitCode.VERIFY_FAILED: "EOM_6001",
        }.get(exc.exit_code, "EOM_9999")
    return "EOM_9999"


__all__ = [
    "DIRECTION", "SCHEMA_VERSION", "STAGES", "StageTracker", "StageRecord",
    "error_code_for", "failure_report", "success_report", "PHASE",
]