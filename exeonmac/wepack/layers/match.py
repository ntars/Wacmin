"""依赖层匹配：看程序实际需要什么，再决定挂哪层。

## 为什么不查固定表

直觉做法是「见到 `msvcp140.dll` 就挂 vcpp 层」。这个做法在 wine 上是错的：
**wine 自带全套 VC++ 运行库**，base 层的 `system32` 里已经有 28 个
`msvcp*` / `msvcr*` / `vcruntime*` / `vcomp*` 文件。再挂一个内容相同的
vcpp 层，除了多占磁盘、多花 clonefile 时间，没有任何作用。

因此匹配必须分两步：

```
1. 扫描主 exe 及其同目录 DLL 的导入表，收集「需要什么」
2. 逐个检查 base 层「已有什么」
3. 差集 = 真正缺失的，只对这些找层
```

这样在 wine 环境里，绝大多数程序一个额外层都不需要 —— 这才是诚实的结论。

## 真正的缺口在哪

实测 base 层（382 MB / 1858 文件）：

| 依赖 | base 是否已提供 | 说明 |
|---|---|---|
| VC++ 2005–2022 运行库 | ✅ 全部提供 | wine 内置 28 个文件 |
| ATL | ✅ 提供 | `atl.dll` 等 6 个 |
| **MFC** | ❌ **缺失** | 只有 `mfc140u` 之类才需要，且要用户自备 |
| **.NET Framework** | ❌ 只有 `mscoree.dll` stub | 真跑 .NET 程序需要装（dotnet 层可自动构建，见下） |
| 中文字体 | ⚠️ 渲染不缺，**依赖宿主** | `Fonts/` 为空，但 wineboot 已把宿主 882 条登记进注册表，其中 878 条指向 `Z:` 盘 —— 能显示，但产物换台机器就丢 |

所以层定义要按**真实缺口**重写，而不是照抄「常见的 Windows 运行库清单」。

**「中文字体是缺口」这条旧结论已于 2026-11-19 推翻**：`Fonts/` 目录为空是事实，
但据此推断「中文渲染不出来」不成立。fonts-cn 层的真实定位是**固化字体、摆脱宿主
依赖**（分发问题），不是「补上缺失的中文字体」（显示问题）。完整实测与那个「两段
Fonts 相加得双倍」的计数陷阱见 `README.md` 4.2.1。

## 层的来源

五个层里 `base` / `dotnet` / `fonts-cn` 可自动构建（离线原则下也不联网：
dotnet 用运行时自带的 wine-mono MSI，fonts-cn 用用户指定的本地字体文件）；
`mfc` / `vcpp` 不可自动构建 —— 前者无合法来源，后者 base 已内置。
层目录不存在时匹配结果会明确标注 `missing`，由用户决定是补层还是接受降级。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .. import pe
from ..errors import UsageError
from . import BUILTIN_LAYERS, layer_path

#: 扫描同目录 DLL 时最多看多少个文件。
#: 真实程序很少超过 50 个自带的 DLL，设上限防止误扫一个几万文件的目录。
MAX_SIBLING_DLLS = 200

#: 系统 DLL：由 wine / base 层负责，不必也不该由应用包提供。
#: 这里列出的是「出现频率高且一定由系统提供」的部分，不是穷举 ——
#: 判断依据始终是「base 层里有没有这个文件」，本表只用于说明原因。
SYSTEM_DLL_HINTS = frozenset({
    "kernel32", "user32", "gdi32", "advapi32", "shell32", "ole32", "oleaut32",
    "comctl32", "comdlg32", "shlwapi", "ws2_32", "winmm", "version", "uxtheme",
    "dwmapi", "imm32", "msimg32", "psapi", "rpcrt4", "setupapi", "iphlpapi",
    "wininet", "winhttp", "urlmon", "crypt32", "secur32", "ntdll", "msvcrt",
    "msacm32", "odbc32", "dbghelp", "winspool", "netapi32", "userenv", "wtsapi32",
    "d3d9", "d3d11", "d3d12", "dxgi", "opengl32", "gdiplus", "mscms", "wintrust",
    "dwrite", "d2d1", "windowscodecs", "propsys", "authz", "cabinet", "msi",
    # 内核与驱动接口：wine 不提供、也不该由应用层补。
    # 出现这类导入通常意味着程序带内核驱动（反作弊、硬件狗），
    # 属仓库根 README.md 第 14.5 节明确不支持的类别，识别阶段就该拒绝。
    "ntoskrnl", "hal", "ntdll", "win32k", "win32u", "ntoskrnl.exe",
    "wdmsec", "wdfldr", "wdf01000", "fltmgr", "ndis", "tcpip",
})

#: 导入名可能带 `.exe` 后缀（如 `ntoskrnl.exe`），比对前统一剥掉。
_STRIP_SUFFIXES = (".dll", ".exe", ".sys")


def normalize_dll_name(name: str) -> str:
    """依赖名归一化：转小写、去后缀、去路径。

    PE 导入表里大小写不固定，个别样本会写 `NTOSKRNL.EXE` 或带目录的
    `C:\\Windows\\System32\\foo.dll`。统一归一化后才能与文件名比对。
    """
    text = name.strip().lower().replace("\\", "/")
    if "/" in text:
        text = text.rsplit("/", 1)[-1]
    for suffix in _STRIP_SUFFIXES:
        if text.endswith(suffix):
            text = text[: -len(suffix)]
            break
    return text


@dataclass(slots=True)
class Dependency:
    """一个被依赖的 DLL，以及它在哪一层能补上。"""

    name: str                        # 小写、无 .dll 后缀
    required_by: list[str] = field(default_factory=list)
    provided_by: str | None = None   # 提供它的层名；None 表示没有层能补
    in_base: bool = False            # base 层已有，无需额外层
    is_system: bool = False          # 系统 DLL，不算应用依赖

    @property
    def satisfied(self) -> bool:
        return self.in_base or self.provided_by is not None

    def to_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "requiredBy": list(self.required_by),
            "inBase": self.in_base,
            "isSystem": self.is_system,
            "providedBy": self.provided_by,
            "satisfied": self.satisfied,
        }


@dataclass(slots=True)
class MatchResult:
    """匹配结果。"""

    entry: str
    scanned: list[str] = field(default_factory=list)
    dependencies: list[Dependency] = field(default_factory=list)
    layers: list[str] = field(default_factory=lambda: ["base"])
    available: list[str] = field(default_factory=list)   # 已安装且需要挂的层
    missing: list[str] = field(default_factory=list)     # 需要但没安装的层
    unsolved: list[str] = field(default_factory=list)    # 没有层能补的 DLL
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.missing and not self.unsolved

    def to_dict(self) -> dict[str, object]:
        return {
            "entry": self.entry,
            "scanned": list(self.scanned),
            "layers": list(self.layers),
            "available": list(self.available),
            "missing": list(self.missing),
            "unsolved": list(self.unsolved),
            "warnings": list(self.warnings),
            "dependencies": [d.to_dict() for d in self.dependencies],
        }


# --------------------------------------------------------------------------
# 层内 DLL 索引
# --------------------------------------------------------------------------


def _windows_dll_stems(root: Path) -> set[str]:
    """扫层内 `drive_c/windows` 下所有 DLL 名（小写、无后缀）。

    **为什么是递归扫整个 `windows` 目录，而不是只看 `system32`**：
    这里踩过两次坑，两次的后果都是「明明有，却报没有」：

    1. **`syswow64` 被漏掉**。实测 base 层 `system32` 有 577 个 DLL、
       `syswow64` 有 636 个，其中 **64 个只在 `syswow64` 里**（`d3d8`、
       `commdlg`、`avifile`、`ctl3d` 等 32 位专用实现）。只扫 `system32`
       时，一个 32 位程序的这些导入会被判成「无层可补」，而它其实就在层里。
    2. **`Microsoft.NET/` 被漏掉**。dotnet 层的 `mscorlib.dll` 在
       `drive_c/windows/Microsoft.NET/Framework/v*/` 下，不在 `system32`。
       只扫 `system32` 时，一个引用 `mscorlib` 的 .NET 程序会被报成
       「无层可补」，而 dotnet 层装了却等于没认。

    `winsxs/` 也一并覆盖：实测 base 的 winsxs 里 13 个 DLL 全都同时存在于
    `system32` 或 `syswow64`（独有 0 个），所以纳入不会改变任何判定结果，
    但省掉「winsxs 会不会漏」这个需要反复复查的疑问。

    @param root 层的根目录（含 `drive_c/windows`）；目录不存在返回空集
    """
    windows = Path(root) / "drive_c" / "windows"
    if not windows.is_dir():
        return set()
    names: set[str] = set()
    try:
        for path in windows.rglob("*"):
            if path.is_file() and path.suffix.lower() == ".dll":
                names.add(path.stem.lower())
    except OSError:
        # 半途读不动（权限/坏链接）就返回已收集的部分。这是给人看的判据，
        # 为个别读不到的文件让整个匹配失败，比少几个名字更糟。
        return names
    return names


def base_dll_index() -> set[str]:
    """base 层已有的 DLL 名（小写、无后缀）。

    这是「已有什么」的唯一判据。不去查 wine 的 lib 目录，因为层才是
    真正会被挂进包里的东西 —— 判断依据必须和实际产物一致。
    """
    return _windows_dll_stems(layer_path("base"))


def _layer_dll_index(name: str) -> set[str]:
    """某一层能提供的 DLL 名。

    优先读层内的实际文件；层未安装时退回 `BUILTIN_LAYERS` 的声明，
    这样「缺层」也能给出准确的 missing 提示，而不是含糊的「未知」。
    """
    names = _windows_dll_stems(layer_path(name))
    if names:
        return names
    return {d.lower() for d in BUILTIN_LAYERS.get(name, {}).get("dlls", [])}


# --------------------------------------------------------------------------
# 扫描
# --------------------------------------------------------------------------


def _collect_imports(path: Path) -> tuple[set[str], str | None]:
    """读一个 PE 文件的导入 DLL 名。失败返回空集与原因。"""
    try:
        info = pe.parse(path)
    except pe.PeError as exc:
        return set(), str(exc)
    try:
        return pe.imported_dll_stems(info), None
    except pe.PeError as exc:
        return set(), str(exc)


def _sibling_dlls(entry_path: Path) -> list[Path]:
    """入口 exe 同目录下的 DLL。

    为什么只看同目录：Windows 的 DLL 搜索顺序里，应用目录优先于系统目录。
    程序自带的 DLL 必然和 exe 放在一起（或子目录，但子目录的加载依赖
    清单文件，属少数情况）。递归全盘扫描既慢又会把无关文件算进来。
    """
    directory = entry_path.parent
    if not directory.is_dir():
        return []
    found: list[Path] = []
    try:
        for child in sorted(directory.iterdir()):
            if len(found) >= MAX_SIBLING_DLLS:
                break
            if child.is_file() and child.suffix.lower() == ".dll":
                found.append(child)
    except OSError:
        return found
    return found


def scan_dependencies(entry_path: Path) -> tuple[set[str], list[str], list[str]]:
    """扫描入口 exe 与同目录 DLL，返回 `(依赖名集合, 扫描过的文件, 警告)`。

    依赖名统一转小写并去掉 `.dll` 后缀 —— PE 的导入表里大小写不固定，
    Windows 加载器不区分大小写，归一化后才能与 base 层的文件名比对。
    """
    entry_path = Path(entry_path)
    if not entry_path.is_file():
        raise UsageError(f"入口程序不存在：{entry_path}")

    required: set[str] = set()
    scanned: list[str] = []
    warnings: list[str] = []

    names, error = _collect_imports(entry_path)
    scanned.append(entry_path.name)
    if error:
        warnings.append(f"{entry_path.name} 导入表读取失败：{error}")
    required |= names

    siblings = _sibling_dlls(entry_path)
    for dll in siblings:
        names, error = _collect_imports(dll)
        scanned.append(dll.name)
        if error:
            # 单个 DLL 解析失败不影响整体判断，只记警告
            warnings.append(f"{dll.name} 导入表读取失败：{error}")
            continue
        required |= names

    # 程序自带的 DLL 本身不算"需要外部提供"，但它们依赖的东西算
    local_stems = {normalize_dll_name(dll.stem) for dll in siblings}
    required -= local_stems

    return required, scanned, warnings


# --------------------------------------------------------------------------
# 匹配
# --------------------------------------------------------------------------


def match_layers(private_dir: Path, entry: str, *,
                 extra_layers: list[str] | None = None) -> MatchResult:
    """根据导入表决定要挂哪些层。

    `entry` 是相对 `private_dir` 的路径（与 compat.yaml 的 `entry` 同格式）。
    """
    private_dir = Path(private_dir)
    entry_path = private_dir / entry
    result = MatchResult(entry=entry)

    required, scanned, warnings = scan_dependencies(entry_path)
    result.scanned = scanned
    result.warnings.extend(warnings)

    base_index = base_dll_index()
    base_available = layer_path("base").is_dir()

    # 收集每层能提供的 DLL，避免对每个依赖都重读一次目录
    layer_index: dict[str, set[str]] = {}
    for name in BUILTIN_LAYERS:
        if name == "base":
            continue
        layer_index[name] = _layer_dll_index(name)

    dependencies: list[Dependency] = []
    needed_layers: set[str] = set()

    for name in sorted(required):
        normalized = normalize_dll_name(name)
        if not normalized:
            continue
        dep = Dependency(name=normalized)
        dep.in_base = normalized in base_index
        dep.is_system = normalized in SYSTEM_DLL_HINTS

        if not dep.in_base:
            # 按 priority 从低到高找第一个能提供的层 —— 顺序即覆盖顺序，
            # 底座优先，避免高层用旧版本覆盖新版本
            for layer_name in sorted(layer_index,
                                     key=lambda n: BUILTIN_LAYERS.get(n, {}).get("priority", 999)):
                if normalized in layer_index[layer_name]:
                    dep.provided_by = layer_name
                    needed_layers.add(layer_name)
                    break

        dependencies.append(dep)

    result.dependencies = dependencies

    # 只保留真正需要的层，并按 priority 排序（base 恒在首位）
    ordered = sorted(needed_layers,
                     key=lambda n: BUILTIN_LAYERS.get(n, {}).get("priority", 999))
    result.layers = ["base"] + ordered

    # 分成"已安装可直接挂"与"需要但没装"两类
    for name in ordered:
        if layer_path(name).is_dir():
            result.available.append(name)
        else:
            result.missing.append(name)
            description = BUILTIN_LAYERS.get(name, {}).get("description", name)
            result.warnings.append(
                f"需要 {name} 层（{description}）但尚未安装：{layer_path(name)}"
            )

    # 既不在 base、也没有任何层能补的 DLL
    result.unsolved = [d.name for d in dependencies
                       if not d.in_base and d.provided_by is None
                       and not d.is_system]

    if not base_available:
        result.warnings.append(
            "base 层未构建，无法判断哪些依赖已由系统提供。"
            "先执行 wepack layers build base"
        )

    # 用户显式指定的额外层无条件加入（用于兜底与试验）
    for name in extra_layers or []:
        if name in result.layers:
            continue
        result.layers.append(name)
        if layer_path(name).is_dir():
            result.available.append(name)
        else:
            result.missing.append(name)

    return result


def describe(result: MatchResult) -> list[str]:
    """把匹配结果转成人类可读的几行说明，供 CLI 直接打印。"""
    lines: list[str] = []
    total = len(result.dependencies)
    in_base = sum(1 for d in result.dependencies if d.in_base)
    lines.append(f"扫描 {len(result.scanned)} 个文件，发现 {total} 个依赖 DLL")
    lines.append(f"其中 {in_base} 个由 base 层提供，无需额外层")

    if result.layers == ["base"]:
        lines.append("结论：只需 base 层，无需挂载依赖层")
    else:
        lines.append(f"需要挂载：{', '.join(result.layers)}")

    if result.missing:
        lines.append(f"缺层：{', '.join(result.missing)}")
    if result.unsolved:
        lines.append(f"无层可补：{', '.join(result.unsolved[:10])}"
                     + ("…" if len(result.unsolved) > 10 else ""))
    return lines


__all__ = [
    "Dependency", "MatchResult", "SYSTEM_DLL_HINTS",
    "base_dll_index", "describe", "match_layers", "scan_dependencies",
]