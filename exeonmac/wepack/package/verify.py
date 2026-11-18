"""产物校验。

仓库根 README.md 第 11.2 节列出了校验规则，本模块是它们的唯一实现。
校验失败一律抛 `VerifyFailed`（退出码 7），不做"警告后继续"——产物不合法
的包拖进 /Applications 后表现为双击闪退，比打包时直接失败难排查得多。

校验只用系统自带工具（`plutil`、`file`），不引入第三方库。
"""

from __future__ import annotations

import os
import plistlib
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from ..errors import VerifyFailed
from ..tools import TEXT_MODE


@dataclass(slots=True)
class Check:
    """一项校验结果。`ok=False` 时 `detail` 说明原因。"""

    name: str
    ok: bool
    detail: str = ""
    required: bool = True

    def to_dict(self) -> dict[str, object]:
        return {"name": self.name, "ok": self.ok, "detail": self.detail,
                "required": self.required}


@dataclass(slots=True)
class VerifyReport:
    """整包校验结果。"""

    app_dir: Path
    checks: list[Check] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return all(c.ok for c in self.checks if c.required)

    @property
    def failures(self) -> list[Check]:
        return [c for c in self.checks if c.required and not c.ok]

    def raise_if_failed(self) -> None:
        if self.ok:
            return
        lines = [f"- {c.name}：{c.detail}" for c in self.failures]
        raise VerifyFailed(
            "产物校验未通过：\n" + "\n".join(lines),
            hint="用 wepack package 重新生成，或检查 compat.yaml 的 entry 字段",
        )


def _plutil_lint(path: Path) -> tuple[bool, str]:
    """用 `plutil -lint` 校验 plist。系统工具比 plistlib 严格（会查重复键）。"""
    try:
        result = subprocess.run(["plutil", "-lint", str(path)],
                                capture_output=True, **TEXT_MODE, timeout=30)
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"无法执行 plutil：{exc}"
    if result.returncode == 0:
        return True, ""
    return False, (result.stderr or result.stdout or "").strip() or "plutil 校验失败"


def verify_bundle(app_dir: Path) -> VerifyReport:
    """跑完整校验，返回报告（不抛异常）。"""
    app_dir = Path(app_dir)
    report = VerifyReport(app_dir=app_dir)
    contents = app_dir / "Contents"

    # 1. 包目录本身
    report.checks.append(Check(
        "bundle.is_app", app_dir.is_dir() and app_dir.suffix == ".app",
        "" if app_dir.is_dir() else f"不是目录：{app_dir}",
    ))

    # 2. Info.plist 能被 plutil 解析
    plist_path = contents / "Info.plist"
    if not plist_path.is_file():
        report.checks.append(Check("plist.exists", False, f"缺少 {plist_path}"))
        document: dict = {}
    else:
        ok, detail = _plutil_lint(plist_path)
        report.checks.append(Check("plist.valid", ok, detail))
        try:
            with open(plist_path, "rb") as fh:
                document = plistlib.load(fh)
        except Exception as exc:                      # noqa: BLE001 - 任何解析失败都算不合法
            document = {}
            report.checks.append(Check("plist.readable", False, str(exc)))

    # 3. 必含键
    required_keys = (
        "CFBundleName", "CFBundleDisplayName", "CFBundleIdentifier",
        "CFBundleExecutable", "CFBundlePackageType", "CFBundleIconFile",
        "CFBundleShortVersionString", "CFBundleVersion",
        "LSMinimumSystemVersion", "NSHighResolutionCapable",
        "LSApplicationCategoryType",
    )
    missing = [k for k in required_keys if k not in document]
    report.checks.append(Check(
        "plist.required_keys", not missing,
        "缺少：" + ", ".join(missing) if missing else "",
    ))

    # 4. 不能设 LSUIElement / LSBackgroundOnly：设了就没有 Dock 图标
    hidden = [k for k in ("LSUIElement", "LSBackgroundOnly") if document.get(k)]
    report.checks.append(Check(
        "plist.visible_in_dock", not hidden,
        "不应设置：" + ", ".join(hidden) if hidden else "",
    ))

    # 5. CFBundleExecutable 指向真实可执行文件
    executable_name = document.get("CFBundleExecutable") or "launcher"
    executable = contents / "MacOS" / executable_name
    report.checks.append(Check(
        "bundle.executable",
        executable.is_file() and os.access(executable, os.X_OK),
        "" if executable.is_file() else f"缺少可执行文件：{executable}",
    ))

    # 6. 图标
    icon_file = document.get("CFBundleIconFile") or "AppIcon"
    icon_path = contents / "Resources" / (
        icon_file if icon_file.endswith(".icns") else f"{icon_file}.icns")
    report.checks.append(Check(
        "bundle.icon", icon_path.is_file(),
        "" if icon_path.is_file() else f"缺少图标：{icon_path}",
    ))

    # 7. Private/drive_c 是目录（prefix 已建立）
    private = contents / "Resources" / "Private"
    report.checks.append(Check(
        "prefix.drive_c", (private / "drive_c").is_dir(),
        "" if (private / "drive_c").is_dir() else f"缺少 {private / 'drive_c'}",
    ))

    # 8. compat.yaml 可读且 entry 指向的文件存在
    compat_path = contents / "Recipes" / "compat.yaml"
    if not compat_path.is_file():
        report.checks.append(Check("compat.exists", False, f"缺少 {compat_path}"))
    else:
        from ..recipes import parse_compat
        try:
            config = parse_compat(compat_path.read_text(encoding="utf-8"),
                                 source=str(compat_path))
        except Exception as exc:                      # noqa: BLE001
            report.checks.append(Check("compat.valid", False, str(exc)))
        else:
            report.checks.append(Check("compat.valid", True))
            entry_ok = config.entry.startswith("drive_c/")
            report.checks.append(Check(
                "compat.entry_format", entry_ok,
                "" if entry_ok else f"entry 必须以 drive_c/ 开头：{config.entry}",
            ))
            entry_path = private / config.entry
            report.checks.append(Check(
                "compat.entry_exists", entry_path.is_file(),
                "" if entry_path.is_file() else f"入口不存在：{entry_path}",
            ))

    return report


__all__ = ["Check", "VerifyReport", "verify_bundle"]