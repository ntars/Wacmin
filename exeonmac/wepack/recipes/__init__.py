"""配方库与包内配置读写。

两处来源：
  1. `Contents/Recipes/compat.yaml` —— 该包自身的配置（唯一事实来源）
  2. `~/.wexe/recipes/<key>.yaml`  —— 跨包复用的已知配方

配方键 = 安装包 SHA-256 前 16 位（首选，稳定）或产品名+版本（次选）。
阶段 5 验收：同一安装包第二次打包直接套用配方，跳过探测。

## 为什么手写 YAML

引入 PyYAML 只为读一个几十行的受限结构不值得：多一个依赖就多一处版本
冲突，而这个项目对「零第三方依赖」有明确承诺（见 README 徽章）。

因此只支持本工具自己写出的子集：

    顶层标量          key: value
    一层嵌套          section:
                        sub: value
    字符串列表        layers:
                        - base

**超出子集一律报错并给行号**，绝不"猜"用户的意图。宁可报错让人改文件，
也不要静默读错一个字段然后在几十秒后表现为"双击没反应"。
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path

from .. import paths as wexe_paths
from ..errors import UsageError
from ..models import CompatConfig, InstallerRecord, InstallerKind

#: 需要加引号的字符。含这些字符的值一律用双引号包起来。
_NEEDS_QUOTE = set(':#"\'{}[],&*?|>%@`')

#: 顶层字段顺序，与仓库根 README.md 第 11.2 节的示例一致。
_FIELD_ORDER = (
    "app", "version", "entry", "installer", "layers", "font_map",
    "file_associations", "known_issues", "bundle_id", "icon_source",
)


# --------------------------------------------------------------------------
# 配方键
# --------------------------------------------------------------------------


def recipe_key(installer: Path) -> str:
    """安装包的配方键：SHA-256 前 16 位。

    用文件内容而不是文件名：同一份安装包被改名、被重新下载到不同目录，
    内容不变，配方应当复用。反过来，版本升级后内容变了，键自动变化，
    不会误用旧配方。
    """
    installer = Path(installer)
    if not installer.is_file():
        raise UsageError(f"文件不存在：{installer}")
    digest = hashlib.sha256()
    with open(installer, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()[:16]


# --------------------------------------------------------------------------
# 序列化
# --------------------------------------------------------------------------


def _scalar(value: object) -> str:
    """把一个标量转成 YAML 安全形式。

    需要引号的情形：空串、含 `: # " '` 等 YAML 元字符、首尾有空格、
    看起来像数字或布尔但实际是字符串（版本号 `1.0` 被读成浮点会丢末尾 0）。
    """
    text = str(value)
    if text == "":
        return '""'
    if any(ch in _NEEDS_QUOTE for ch in text) or text != text.strip():
        escaped = text.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    # 纯数字串（含小数点）会被 YAML 读成数字，强制加引号保持字符串语义
    if text.replace(".", "", 1).isdigit():
        return f'"{text}"'
    lowered = text.lower()
    if lowered in {"true", "false", "null", "yes", "no", "on", "off", "~"}:
        return f'"{text}"'
    return text


def dump_compat(config: CompatConfig) -> str:
    """把 CompatConfig 序列化成 compat.yaml 文本。

    字段顺序固定（`_FIELD_ORDER`），空值仍写出：字段缺失会让 launcher 与
    wepack 走不同的默认值分支，空值至少语义唯一。
    """
    lines: list[str] = []

    lines.append(f"app: {_scalar(config.app)}")
    lines.append(f"version: {_scalar(config.version)}")
    lines.append(f"entry: {_scalar(config.entry)}")

    lines.append("installer:")
    lines.append(f"  type: {_scalar(str(config.installer.kind))}")
    lines.append(f"  silent_args: {_scalar(config.installer.silent_args)}")
    lines.append(f"  completed: {'true' if config.installer.completed else 'false'}")
    lines.append(f"  fallback_interactive: "
                 f"{'true' if config.installer.fallback_interactive else 'false'}")

    layers = list(config.layers) or ["base"]
    # 规范要求 layers[0] 必须是 base（挂载顺序 = 覆盖顺序，base 是底座）。
    # 写的时候就把 base 提到首位，读的时候再兜一次，两头都不给错序留空间。
    if "base" in layers:
        layers = ["base"] + [layer for layer in layers if layer != "base"]
    else:
        layers.insert(0, "base")
    lines.append("layers:")
    for layer in layers:
        lines.append(f"  - {_scalar(layer)}")

    if config.font_map:
        lines.append("font_map:")
        for win_font, mac_font in config.font_map.items():
            lines.append(f"  {_scalar(win_font)}: {_scalar(mac_font)}")
    else:
        lines.append("font_map: {}")

    if config.file_associations:
        lines.append("file_associations:")
        for ext in config.file_associations:
            lines.append(f"  - {_scalar(ext)}")
    else:
        lines.append("file_associations: []")

    if config.known_issues:
        lines.append("known_issues:")
        for issue in config.known_issues:
            lines.append(f"  - {_scalar(issue)}")
    else:
        lines.append("known_issues: []")

    lines.append(f"bundle_id: {_scalar(config.bundle_id)}")
    lines.append(f"icon_source: {_scalar(config.icon_source)}")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# 解析
# --------------------------------------------------------------------------


def _unquote(text: str) -> str:
    """去掉成对的引号并还原转义。不成对时原样返回（由调用方判定是否合法）。"""
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        inner = text[1:-1]
        if text[0] == '"':
            return inner.replace('\\"', '"').replace("\\\\", "\\")
        return inner.replace("''", "'")
    return text


def _strip_comment(line: str) -> str:
    """去掉行尾注释。

    只在「行首或空白之后的 `#`」处截断：路径里的 `#`（如
    `exe:...#0`）是合法内容，不能当注释切掉。引号内的 `#` 也保留。
    """
    in_single = False
    in_double = False
    previous_space = True
    for index, ch in enumerate(line):
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        elif ch == "#" and previous_space and not in_single and not in_double:
            return line[:index]
        if not in_single and not in_double:
            previous_space = ch in " \t"
    return line


def parse_compat(text: str, *, source: str = "compat.yaml") -> CompatConfig:
    """解析受限 YAML 子集，返回 CompatConfig。

    出错时抛 UsageError 并带行号与原文。行号是排查的唯一抓手 ——
    "解析失败"四个字对用户毫无帮助。
    """
    scalars: dict[str, str] = {}
    sections: dict[str, dict[str, str]] = {}
    lists: dict[str, list[str]] = {}

    current_section: str | None = None
    current_list: str | None = None

    for line_no, raw_line in enumerate(text.splitlines(), start=1):
        line = _strip_comment(raw_line).rstrip()
        if not line.strip():
            continue

        indented = line[0] in " \t"
        body = line.strip()

        if body.startswith("- "):
            item = _unquote(body[2:].strip())
            if current_list is None:
                raise UsageError(
                    f"{source} 第 {line_no} 行：列表项缺少上级键",
                    hint=f"原文：{raw_line.strip()}",
                )
            lists[current_list].append(item)
            continue

        if ":" not in body:
            raise UsageError(
                f"{source} 第 {line_no} 行：缺少冒号",
                hint=f"原文：{raw_line.strip()}",
            )

        key, _, rest = body.partition(":")
        key = _unquote(key.strip())
        value = rest.strip()

        if indented:
            if current_section is None:
                raise UsageError(
                    f"{source} 第 {line_no} 行：缩进行缺少上级段",
                    hint=f"原文：{raw_line.strip()}",
                )
            sections[current_section][key] = _unquote(value)
            current_list = None
            continue

        if value == "" or value in ("[]", "{}"):
            current_section = key
            current_list = key if value == "" else None
            sections.setdefault(key, {})
            lists.setdefault(key, [])
        else:
            scalars[key] = _unquote(value)
            current_section = None
            current_list = None

    app = scalars.get("app", "").strip()
    if not app:
        raise UsageError(f"{source} 缺少必填字段 app")

    entry = scalars.get("entry", "").strip()
    if not entry:
        raise UsageError(f"{source} 缺少必填字段 entry",
                         hint="entry 应形如 drive_c/Program Files/App/App.exe")

    installer_section = sections.get("installer", {})
    kind_text = installer_section.get("type", "unknown").strip() or "unknown"
    try:
        kind = InstallerKind(kind_text)
    except ValueError:
        # 认不出的类型降级为 unknown 而不是报错：compat.yaml 可能由更新版本
        # 的 wepack 写出，旧版本读到新类型应当能继续工作
        kind = InstallerKind.UNKNOWN

    record = InstallerRecord(
        kind=kind,
        silent_args=installer_section.get("silent_args", ""),
        completed=_as_bool(installer_section.get("completed", "false")),
        fallback_interactive=_as_bool(
            installer_section.get("fallback_interactive", "false")),
    )

    layers = lists.get("layers") or ["base"]
    if "base" in layers:
        layers = ["base"] + [layer for layer in layers if layer != "base"]
    elif layers:
        layers.insert(0, "base")

    font_map = {k: v for k, v in sections.get("font_map", {}).items() if k and v}

    return CompatConfig(
        app=app,
        version=scalars.get("version", ""),
        entry=entry,
        installer=record,
        layers=layers,
        font_map=font_map,
        file_associations=lists.get("file_associations", []),
        known_issues=lists.get("known_issues", []),
        bundle_id=scalars.get("bundle_id", ""),
        icon_source=scalars.get("icon_source", ""),
    )


def _as_bool(text: str) -> bool:
    return text.strip().lower() in {"true", "yes", "on", "1"}


# --------------------------------------------------------------------------
# 落盘
# --------------------------------------------------------------------------


def compat_path(app_dir: Path) -> Path:
    """包内 compat.yaml 的规范位置。"""
    return Path(app_dir) / "Contents" / "Recipes" / "compat.yaml"


def write_compat(config: CompatConfig, app_dir: Path) -> Path:
    """写 `Contents/Recipes/compat.yaml`，返回其路径。"""
    target = compat_path(app_dir)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(dump_compat(config), encoding="utf-8")
    return target


def read_compat(app_dir: Path) -> CompatConfig:
    """读 `Contents/Recipes/compat.yaml`。文件缺失抛 UsageError。"""
    target = compat_path(app_dir)
    if not target.is_file():
        raise UsageError(
            f"缺少配置文件：{target}",
            hint="该目录不是 wepack 产出的 .app，或 package 步骤未完成",
        )
    try:
        text = target.read_text(encoding="utf-8")
    except OSError as exc:
        raise UsageError(f"无法读取 {target}：{exc}") from exc
    return parse_compat(text, source=str(target))


# --------------------------------------------------------------------------
# 配方库（阶段 5）
# --------------------------------------------------------------------------


def load(key: str) -> CompatConfig | None:
    """从 `~/.wexe/recipes` 读配方，不存在返回 None（不抛异常）。"""
    path = wexe_paths.recipes_root() / f"{key}.yaml"
    if not path.is_file():
        return None
    try:
        return parse_compat(path.read_text(encoding="utf-8"), source=str(path))
    except (UsageError, OSError):
        # 配方损坏等同于没有配方：让调用方回退到重新探测，
        # 而不是因为一个坏缓存彻底失败
        return None


def save(config: CompatConfig, key: str) -> Path:
    """写配方到 `~/.wexe/recipes/<key>.yaml`，返回路径。"""
    root = wexe_paths.recipes_root()
    root.mkdir(parents=True, exist_ok=True)
    target = root / f"{key}.yaml"
    target.write_text(dump_compat(config), encoding="utf-8")
    return target


def list_recipes() -> list[dict]:
    """列出本地配方：`[{key, app, version, path, updated}]`。"""
    root = wexe_paths.recipes_root()
    if not root.is_dir():
        return []
    out: list[dict] = []
    for path in sorted(root.glob("*.yaml")):
        try:
            config = parse_compat(path.read_text(encoding="utf-8"), source=str(path))
        except (UsageError, OSError):
            out.append({
                "key": path.stem, "app": None, "version": None,
                "path": str(path), "updated": None, "ok": False,
            })
            continue
        stamp = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        out.append({
            "key": path.stem,
            "app": config.app,
            "version": config.version,
            "path": str(path),
            "updated": stamp.astimezone().isoformat(timespec="seconds"),
            "ok": True,
        })
    return out


__all__ = [
    "compat_path", "dump_compat", "list_recipes", "load", "parse_compat",
    "read_compat", "recipe_key", "save", "write_compat",
]