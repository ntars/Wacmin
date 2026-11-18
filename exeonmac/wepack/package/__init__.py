""".app 装配。

产物必须是标准 bundle（铁律 1）：`Info.plist` + `MacOS/launcher` +
`Resources/`。不发明后缀，不写系统目录。

## 装配顺序为什么是这样

```
1. 目录骨架        ← 后面每一步都要往里面写
2. compat.yaml     ← 图标来源、入口、字体映射都在这里，是后续步骤的输入
3. Info.plist      ← 需要 compat 里的 file_associations 生成文档类型
4. 图标            ← 最慢的一步（swift 编译 + iconutil），放中间便于失败即停
5. launcher 编译   ← 次慢，可缓存
6. 校验            ← 最后跑，任何一步的产物不对都在这里被抓出来
7. 注册            ← 失败不阻断（LaunchServices 会自愈）
```

## 为什么 install 和 package 分开

`install` 负责"把 Windows 软件装进 prefix"，`package` 负责"把 prefix 包成
.app"。分开的好处是重装软件不必重编译 launcher，改图标不必重装软件。
`build` 是两者的串联，给不想分两步的用户用。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from ..errors import UsageError
from ..models import CompatConfig, InstallerRecord
from ..recipes import read_compat, write_compat
from . import icon as icon_mod
from . import launcher_build
from . import plist as plist_mod
from .verify import Check, verify_bundle


@dataclass(slots=True)
class PackageReport:
    """装配结果。供 CLI 输出与 --report 使用。"""

    app_dir: Path
    app_name: str
    bundle_id: str
    version: str
    entry: str
    plist: Path | None = None
    icon: Path | None = None
    launcher: Path | None = None
    compat: Path | None = None
    registered: bool = False
    checks: list[Check] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return all(c.ok for c in self.checks if c.required)


def bundle_dir_name(app_name: str) -> str:
    """`.app` 的目录名：`{应用名} (Win).app`。

    名字里的 `/` 与 `:` 必须替换 —— macOS 上 `:` 在 Finder 里显示成 `/`，
    两者混用会让同一个包在命令行与 Finder 里叫两个名字。
    """
    safe = app_name.replace("/", "-").replace(":", "-").strip()
    return f"{safe or 'App'} (Win).app"


def ensure_skeleton(app_dir: Path) -> dict[str, Path]:
    """建出 .app 的目录骨架，返回关键路径。

    幂等：已存在的目录不报错，方便 `package` 单独重跑。
    """
    app_dir = Path(app_dir)
    contents = app_dir / "Contents"
    paths = {
        "contents": contents,
        "macos": contents / "MacOS",
        "resources": contents / "Resources",
        "private": contents / "Resources" / "Private",
        "recipes": contents / "Recipes",
    }
    for directory in paths.values():
        directory.mkdir(parents=True, exist_ok=True)
    return paths


def build_bundle(app_dir: Path, *, app_name: str, bundle_id: str, version: str,
                 entry: str, style: str = "w", color: str = icon_mod.BADGE_COLOR_WINBLUE,
                 icon_source: Path | None = None, installer: InstallerRecord | None = None,
                 layers: list[str] | None = None,
                 font_map: dict[str, str] | None = None,
                 file_associations: list[str] | None = None,
                 known_issues: list[str] | None = None,
                 detect_layers: bool = True,
                 register: bool = True) -> PackageReport:
    """把一个已装好 prefix 的 `.app` 补齐成合法 bundle。

    调用前 `Contents/Resources/Private/drive_c` 必须已存在（由 `install` 建立）。
    本函数不创建 prefix —— 那是 install 的职责，混在一起会让"只改图标"
    变成"重装软件"。
    """
    app_dir = Path(app_dir)
    if app_dir.suffix != ".app":
        raise UsageError(f"目标必须是 .app 包：{app_dir}")

    paths = ensure_skeleton(app_dir)
    private = paths["private"]
    if not (private / "drive_c").is_dir():
        raise UsageError(
            f"prefix 不存在：{private / 'drive_c'}",
            hint="先跑 wepack install 建立 prefix，再跑 package",
        )

    report = PackageReport(
        app_dir=app_dir, app_name=app_name, bundle_id=bundle_id,
        version=version, entry=entry,
    )

    # 依赖层：未显式指定时按导入表算。
    # 为什么在 package 里也算一次：install 与 package 可能分开跑，
    # 用户装完隔几天才打包，此时 compat.yaml 若只写 ["base"]，
    # launcher 就不知道该挂哪些层，运行期会缺 DLL。
    resolved_layers = list(layers or [])
    if not resolved_layers and detect_layers:
        try:
            from ..layers import match_layers
            match = match_layers(private, entry)
            resolved_layers = match.layers
            report.warnings.extend(match.warnings)
            if match.missing:
                report.warnings.append(
                    "缺层：" + "、".join(match.missing)
                    + "（已写入 compat.yaml，补齐后可重跑 package）"
                )
        except Exception as exc:                      # noqa: BLE001 - 匹配失败不阻断装配
            report.warnings.append(f"依赖层匹配失败，按 base 处理：{exc}")
            resolved_layers = ["base"]
    if not resolved_layers:
        resolved_layers = ["base"]

    # ① compat.yaml —— 后续步骤的输入
    config = CompatConfig(
        app=app_name,
        version=version,
        entry=entry,
        installer=installer or InstallerRecord(),
        layers=resolved_layers,
        font_map=font_map or {},
        file_associations=file_associations or [],
        known_issues=known_issues or [],
        bundle_id=bundle_id,
        icon_source=f"exe:{entry}#0" if icon_source is None else f"file:{icon_source.name}",
    )
    report.compat = write_compat(config, app_dir)

    # ② Info.plist
    report.plist = plist_mod.write_plist(
        app_dir, app_name=app_name, bundle_id=bundle_id, version=version,
        file_associations=file_associations,
    )

    # ③ 图标。拿不到源图时降级为不生成，但记 WARN —— 缺图标的包仍能跑，
    #    只是 Dock 里显示成默认的空白应用图标。
    source = icon_source
    if source is None:
        entry_path = private / entry
        if entry_path.is_file():
            source = entry_path
    if source is not None and Path(source).is_file():
        try:
            report.icon = icon_mod.build_app_icon(
                Path(source), paths["resources"], style=style, color=color)
        except Exception as exc:                      # noqa: BLE001 - 图标失败不阻断装配
            report.warnings.append(f"图标生成失败：{exc}")
    else:
        report.warnings.append(f"找不到图标源：{source or entry}")

    # ④ launcher
    report.launcher = launcher_build.compile_launcher(paths["macos"] / "launcher")

    # ⑤ PkgInfo：老工具会读，写一行不影响新系统
    pkg_info = paths["contents"] / "PkgInfo"
    if not pkg_info.exists():
        pkg_info.write_bytes(b"APPL????")

    # ⑥ 校验
    verification = verify_bundle(app_dir)
    report.checks = verification.checks
    if not verification.ok:
        report.warnings.extend(f"{c.name}：{c.detail}" for c in verification.failures)

    # ⑦ 注册。放在校验之后：不合法的包注册进 LaunchServices 只会污染数据库
    if register and verification.ok:
        report.registered = launcher_build.register_app(app_dir)

    return report


def repackage(app_dir: Path, *, style: str = "w",
              color: str = icon_mod.BADGE_COLOR_WINBLUE,
              icon_source: Path | None = None, register: bool = True,
              bundle_id: str | None = None,
              entry: str | None = None,
              app_name: str | None = None,
              version: str | None = None,
              layers: list[str] | None = None) -> PackageReport:
    """基于已有 compat.yaml 重建 .app 的可变部分。

    用于两种场景：只换图标、只重编译 launcher。不碰 prefix，因此很快。

    **没有 compat.yaml 时不再直接报错**：改为从目录名与 prefix 推断。
    理由是 `install` 与 `package` 允许分开跑，而用户手工装配一个 .app
    （例如用第三方工具装完再套壳）也该能打包。推断不出来时才要求
    显式指定 `entry`。
    """
    app_dir = Path(app_dir)
    try:
        config = read_compat(app_dir)
    except UsageError:
        return _assemble_from_scratch(
            app_dir, style=style, color=color, icon_source=icon_source,
            register=register, bundle_id=bundle_id,
            entry=entry, app_name=app_name, version=version, layers=layers,
        )

    # 调用方（如 build）已知层结果时以它为准：那是刚在 install 阶段
    # 实测出来的，比 compat.yaml 里的旧值更可信
    resolved = list(layers) if layers else config.layers

    return build_bundle(
        app_dir,
        app_name=config.app,
        bundle_id=bundle_id or config.bundle_id
        or plist_mod.make_bundle_id(_guess_reverse_domain(config.app), seed=config.app),
        version=config.version,
        entry=config.entry,
        style=style,
        color=color,
        icon_source=icon_source,
        installer=config.installer,
        layers=resolved,
        font_map=config.font_map,
        file_associations=config.file_associations,
        known_issues=config.known_issues,
        # compat.yaml 已有 layers，不再重新探测 —— 用户可能手工调整过顺序
        detect_layers=False,
        register=register,
    )


def _assemble_from_scratch(app_dir: Path, *, style: str, color: str,
                           icon_source: Path | None, register: bool,
                           bundle_id: str | None, entry: str | None,
                           app_name: str | None,
                           version: str | None,
                           layers: list[str] | None = None) -> PackageReport:
    """没有 compat.yaml 时的装配路径：从目录名与 prefix 推断字段。"""
    private = app_dir / "Contents" / "Resources" / "Private"
    if not (private / "drive_c").is_dir():
        raise UsageError(
            f"prefix 不存在：{private / 'drive_c'}",
            hint="先跑 wepack install 建立 prefix，再跑 package",
        )

    name = app_name or _name_from_bundle(app_dir)
    resolved_entry = entry or _guess_entry(private)
    if not resolved_entry:
        raise UsageError(
            f"无法自动确定入口程序：{app_dir}",
            hint="用 --entry 指定，形如 drive_c/Program Files/App/App.exe",
        )

    return build_bundle(
        app_dir,
        app_name=name,
        bundle_id=bundle_id or plist_mod.make_bundle_id(
            _guess_reverse_domain(name), seed=name),
        version=version or "",
        entry=resolved_entry,
        style=style,
        color=color,
        icon_source=icon_source,
        layers=layers,
        # 调用方给了层就直接用；没给才按导入表探测
        detect_layers=not layers,
        register=register,
    )


def _name_from_bundle(app_dir: Path) -> str:
    """从 `X (Win).app` 反推应用名。"""
    stem = app_dir.stem
    for suffix in (" (Win)", "(Win)"):
        if stem.endswith(suffix):
            return stem[: -len(suffix)].strip() or stem
    return stem


def _guess_entry(private: Path) -> str | None:
    """在 prefix 里找最像主程序的 exe。

    复用 extract 阶段的候选打分（GUI 子系统、体积、位置、含图标资源），
    而不是简单取第一个 exe —— 一个目录里常有 updater / crashpad 之类的
    辅助程序，直接取第一个经常错。
    """
    from ..extract.candidates import best_candidate

    drive_c = private / "drive_c"
    roots = [drive_c / "Program Files", drive_c / "Program Files (x86)"]
    for root in roots:
        if not root.is_dir():
            continue
        candidate = best_candidate(root)
        if candidate is None:
            continue
        try:
            return (root / candidate.relpath).relative_to(private).as_posix()
        except ValueError:
            continue
    return None


def _guess_reverse_domain(app_name: str) -> str:
    """从应用名猜一个反向域名。

    只作为兜底：正常路径是 install 阶段用安装器的 CompanyName 生成。
    这里把应用名转成小写连字符形式，保证 bundle id 至少是合法的。
    """
    cleaned = "".join(ch if ch.isalnum() else "-" for ch in app_name.lower())
    cleaned = "-".join(part for part in cleaned.split("-") if part)
    return f"app.{cleaned or 'unknown'}"


__all__ = [
    "PackageReport", "build_bundle", "bundle_dir_name", "ensure_skeleton",
    "repackage",
]