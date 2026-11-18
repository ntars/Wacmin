"""Info.plist 生成。

字段严格按仓库根 README.md 第 11.2 节的字段表。三条约束必须同时满足：

  1. `CFBundleName` ≤15 字符 —— LaunchServices 的硬限制，超了 Finder 会
     显示成截断后的乱码，且无法通过后续修改恢复。
  2. `CFBundleExecutable` 必须指向真实存在的文件 —— 否则双击直接闪退，
     用户看不到任何提示。
  3. **不设** `LSUIElement` / `LSBackgroundOnly` —— 设了就没有 Dock 图标，
     违反阶段 3 的验收项。

序列化用标准库 `plistlib`，不手写 XML：plist 的转义规则（`&` `<` `>` 与
控制字符）比看起来麻烦，手写容易在应用名带特殊符号时产出非法 XML。
`sort_keys=False` 保证键顺序与本文档的表格一致，便于人工比对。
"""

from __future__ import annotations

import hashlib
import plistlib
import re
from pathlib import Path
from typing import Any

from ..errors import UsageError

#: CFBundleName 的字符上限。LaunchServices 的硬限制。
MAX_BUNDLE_NAME = 15

#: 反向域名里允许的字符。大写会被转小写，其余非法字符转连字符。
_DOMAIN_SAFE = re.compile(r"[^a-z0-9\-.]")

#: 版本号里允许保留的字符。
_VERSION_SAFE = re.compile(r"[^0-9A-Za-z._+\-]")

#: 取不到版本时的兜底值。
DEFAULT_VERSION = "1.0"


def make_bundle_id(reverse_domain: str, seed: str | None = None) -> str:
    """`com.wexe.win.{反向域名}`，非法字符归一化。

    例：`tencent.wechat` → `com.wexe.win.tencent.wechat`

    归一化规则（顺序不能换）：
      1. 转小写 —— bundle id 大小写不敏感，混写只会让 lsregister 判重失效
      2. 非 `[a-z0-9-.]` 的字符转连字符 —— 空格、中文、下划线都走这条
      3. 空段去掉 —— `a..b` 这类会产生非法 id

    ## 为什么非 ASCII 要挂哈希后缀

    bundle id 是 LaunchServices 区分应用的唯一依据。`[^a-z0-9-.]` 会把
    中文整段吃掉，而归一化后「还剩几段」并不代表「还有区分度」：

      `app.记事本`        → `app`      （应用这一级没了）
      `app.我的应用`      → `app`      （和上面撞成同一个 id）
      `app.空谷-ondra`    → `app.ondra`（只留下 ASCII 那半截）

    实测 6 个常见中文应用名，修前产出的 bundle id **只有 2 个不同值**。
    两个中文应用共用同一个 bundle id 时，LaunchServices 当作同一个应用：
    Dock 只显示一个图标、默认打开方式互相覆盖、`lsregister -u` 卸载其一
    会把另一个也摘掉。

    纯中文域名（`app.记事本`）更糟 —— 归一化后仍然非空（`app`），旧代码
    不会走到 `UsageError` 分支，于是**静默产出冲突 id**，而注释里写的
    「宁可报错也不要冲突」完全没有生效。

    现在改为：含非 ASCII 字符时在可读片段后挂 8 位哈希。纯 ASCII 输入
    原样返回，不改变既有产物的 id。

    `seed` 用于哈希的额外输入（通常是应用名）。同一厂商下的多个中文应用
    反向域名相同、只有应用名不同，只哈希域名仍会撞。

    归一化后一个合法段都不剩、又没有 seed 可哈希时，才抛 UsageError：
    那时确实没有任何区分信息可用。
    """
    raw = reverse_domain.strip().lower()
    # 去掉可能被误传进来的前缀，避免出现 com.wexe.win.com.wexe.win.x
    for prefix in ("com.wexe.win.", "com.wexe."):
        if raw.startswith(prefix):
            raw = raw[len(prefix):]
            break

    # 非 ASCII 字符一定会被归一化吃掉，提前记下
    lossy = any(ord(ch) > 0x7E or ord(ch) < 0x20 for ch in raw)
    digest = hashlib.sha256(f"{raw}\0{seed or ''}".encode()).hexdigest()[:8]

    cleaned = _DOMAIN_SAFE.sub("-", raw)
    segments = [seg.strip("-") for seg in cleaned.split(".")]
    segments = [seg for seg in segments if seg]
    if not segments:
        if seed:
            # 域名全被吃掉，但应用名可哈希 —— 用它兜底，不要放弃
            return f"com.wexe.win.app-{digest}"
        raise UsageError(
            f"无法从 {reverse_domain!r} 推导 bundle id",
            hint="请用 --bundle-id 显式指定，形如 com.wexe.win.vendor.app",
        )

    base = "com.wexe.win." + ".".join(segments)

    if lossy:
        return f"{base}-{digest}"

    """
    ## 域名本身干净、区分度却在 seed 里

    调用方传进来的 reverse_domain 常是 `app` 这种占位值（应用名猜不出
    厂商时的兜底），真正区分两个应用的是 seed。此时 raw 全是 ASCII，
    上面的 lossy 判断为假，于是两个中文应用会拿到同一个 `com.wexe.win.app`。

    所以 seed 含非 ASCII 时也要哈希 —— 但基名要带上 seed 的可读片段，
    否则 `com.wexe.win.app-abc` 看不出是哪个应用。
    """
    if seed:
        seed_text = str(seed)
        if any(ord(ch) > 0x7E or ord(ch) < 0x20 for ch in seed_text):
            slug = _DOMAIN_SAFE.sub("-", seed_text.strip().lower())
            slug = "-".join(part for part in slug.split("-") if part)
            return f"{base}.{slug}-{digest}" if slug else f"{base}-{digest}"

    return base


def make_bundle_name(app: str) -> str:
    """`CFBundleName`：≤15 字符，从尾部截断。

    按码点截断而不是按字节：中文一个字算一个字符，不会截出半个字。
    截断后不留尾随空格与标点 —— 那会让 Dock 里看起来像排版错误。
    """
    name = app.strip()
    if not name:
        return "App"
    if len(name) <= MAX_BUNDLE_NAME:
        return name
    truncated = name[:MAX_BUNDLE_NAME].rstrip(" -_.·、，,")
    return truncated or name[:MAX_BUNDLE_NAME]


def normalize_version(version: str | None) -> tuple[str, str]:
    """把任意版本串拆成 `(CFBundleShortVersionString, CFBundleVersion)`。

    `CFBundleShortVersionString` 是给人看的，原样保留可读形式。
    `CFBundleVersion` 是给系统比大小的，必须是纯数字点分（`1.2.3`），
    非数字段一律换成 0 —— 这是 Apple 的硬要求，不满足会被 App Store
    与部分系统组件拒绝。

    例：`3.9.10-beta.2` → (`3.9.10-beta.2`, `3.9.10.0.0`)
    """
    text = (version or "").strip()
    if not text:
        return DEFAULT_VERSION, DEFAULT_VERSION

    short = _VERSION_SAFE.sub("", text) or DEFAULT_VERSION

    parts: list[str] = []
    for segment in re.split(r"[._+\-]", text):
        match = re.match(r"\d+", segment)
        parts.append(match.group(0) if match else "0")
    build = ".".join(parts).strip(".")
    # 全是 0 时没有比较意义，退回 1.0
    if not build or set(build.replace(".", "")) <= {"0"}:
        build = DEFAULT_VERSION
    return short, build


def _document_types(file_associations: list[str], app_name: str) -> list[dict[str, Any]]:
    """由文件关联后缀生成 `CFBundleDocumentTypes`。

    默认空数组不生成 —— 声明了就抢系统默认打开方式，这是侵入性行为，
    必须由用户在 compat.yaml 里显式要求。
    """
    if not file_associations:
        return []
    exts = [ext.lower().lstrip(".") for ext in file_associations if ext.strip()]
    if not exts:
        return []
    return [{
        "CFBundleTypeName": f"{app_name} 文档",
        "CFBundleTypeRole": "Editor",
        "LSHandlerRank": "Alternate",
        "LSItemContentTypes": [f"public.{ext}" for ext in exts],
    }]


def build_plist(*, app_name: str, bundle_id: str, version: str,
                file_associations: list[str] | None = None,
                category: str = "public.app-category.utilities",
                min_macos: str = "13.0") -> dict[str, Any]:
    """组装 Info.plist 的字典形态（未序列化）。

    单独抽出来是为了让测试能直接断言字段，不必落盘再读回。
    """
    short_version, build_version = normalize_version(version)
    document: dict[str, Any] = {
        "CFBundleName": make_bundle_name(app_name),
        "CFBundleDisplayName": f"{app_name} (Win)",
        "CFBundleIdentifier": bundle_id,
        "CFBundleExecutable": "launcher",
        "CFBundlePackageType": "APPL",
        "CFBundleSignature": "????",
        "CFBundleIconFile": "AppIcon",
        "CFBundleShortVersionString": short_version,
        "CFBundleVersion": build_version,
        "CFBundleInfoDictionaryVersion": "6.0",
        "LSMinimumSystemVersion": min_macos,
        "NSHighResolutionCapable": True,
        "LSApplicationCategoryType": category,
        "NSSupportsAutomaticGraphicsSwitching": True,
    }
    types = _document_types(file_associations or [], app_name)
    if types:
        document["CFBundleDocumentTypes"] = types
    return document


def write_plist(app_dir: Path, *, app_name: str, bundle_id: str, version: str,
                min_macos: str = "13.0",
                file_associations: list[str] | None = None,
                category: str = "public.app-category.utilities") -> Path:
    """写出 `Contents/Info.plist`（XML plist，UTF-8），返回其路径。"""
    app_dir = Path(app_dir)
    contents = app_dir / "Contents"
    contents.mkdir(parents=True, exist_ok=True)

    document = build_plist(
        app_name=app_name,
        bundle_id=bundle_id,
        version=version,
        file_associations=file_associations,
        category=category,
        min_macos=min_macos,
    )
    target = contents / "Info.plist"
    with open(target, "wb") as fh:
        plistlib.dump(document, fh, fmt=plistlib.FMT_XML, sort_keys=False)
    return target


__all__ = [
    "DEFAULT_VERSION", "MAX_BUNDLE_NAME",
    "build_plist", "make_bundle_id", "make_bundle_name",
    "normalize_version", "write_plist",
]