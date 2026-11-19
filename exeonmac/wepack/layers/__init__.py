"""共享层管理。

层是预先构建好的 prefix 片段，用 APFS clonefile 复用到每个应用包，
避免每个包都从零 wineboot。

**层怎么来的**（`wepack layers build <name>`，构建入口就是本模块的
`build_layer()` —— 没有单独的 `build.py`，早前 docstring 写错指向过一个
不存在的文件，2026-11-20 更正）：

| 层 | 自动构建 | 来源 |
|---|---|---|
| base | ✅ | 跑一次 `wineboot -u` 得到干净 prefix |
| dotnet | ✅ | 运行时自带 `wine-mono-*/support/winemono-support.msi`，用 msiexec 静默装入 |
| fonts-cn | ✅ | 复制用户指定的本地字体文件进 `Fonts/`（须用户确认授权可再分发） |
| mfc | ❌ | wine 不实现 MFC，且无任何自动获取途径，必须用户提供 VC 可再分发包 |
| vcpp | ❌ | base 已内置全部 VC++ 运行库；仅当用户要覆盖成微软原版时才需要 |

**离线原则不变**：本工具从不代下载任何东西。dotnet 用的是运行时里**已经躺着**的
MSI（`wine-mono` 随 wine 一起分发），fonts-cn 用的是用户指定的本地字体文件。

**关于 fonts-cn 的真实定位（2026-11-19 实测修正）**

旧注释写「中文字体是真缺口：base 的 `Fonts/` 是空目录」——**这个推理是错的**。
`Fonts/` 确实是空目录（实测 0 个文件），但 wine 并不只看它：

- `wineboot` 会把**宿主系统字体**以 `Z:\\System\\Library\\Fonts\\...` 的形式自动
  登记进 `system.reg` 的 Fonts 段。实测 base 层该段 **883 条**，其中 878 条
  指向 Z: 盘宿主路径，含 PingFang 48 条 / Hiragino 22 条 / Songti 16 条 /
  Kaiti 14 条 / Heiti 10 条等。所以「中文渲染不出来」不成立。
- **这里有个必须注意的计数陷阱**：`system.reg` 里同时存在
  `[Software\\Microsoft\\Windows\\CurrentVersion\\Fonts]` 与
  `[Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts]` 两段，
  **两段的键集合完全相同**（实测都是 883 条，键集一致）。把两段相加会
  恰好得到「双倍」的假数字 —— 同一份字体被算了两次。只认 `Windows NT`
  那一段即可。
- 真正的缺口是**按 Windows 字体名查找**：`SimSun` / `Microsoft YaHei` /
  `SimHei` / `DengXian` / `MingLiU` 的精确名在 base 里**一条都没有**（实测
  全为 0），`FontSubstitutes` 的 22 条里也没有任何中文映射。
- `FontLink\\SystemLink` 把 `Tahoma`（`MS Shell Dlg` 的替身）的后备链写成
  `SIMSUN.TTC` / `MSYH.TTC` 这些 Windows 文件名，而它们在层内不存在 ——
  这条链在 base 上是断的。

因此 fonts-cn 层的定位是**把字体固化进层内、摆脱宿主依赖**，使产物能拷到
另一台机器上仍有字体；它**不是**"补上缺失的中文字体"。装进去的字体按自己
的 family 名被识别，**不会**自动变成 SimSun（要那种效果得改注册表映射，
属另一件事，本层不做）。

**挂载语义（4.2）**：读时先 Private 再 Layers，写只写 Private。
实现方式是初始化时 clonefile 叠加成单一目录树 —— 不用 overlay 文件系统
（那需要 macFUSE，已禁止）。层内容只需在 prefix 初始化时复制一次，
后续写入都落在 Private 的克隆副本上，天然满足"写不污染共享层"。
"""

from __future__ import annotations

import os
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from .. import paths as wexe_paths
from ..errors import InstallFailed, MissingDependency, UsageError, VerifyFailed

#: 已知层名与用途。index.yaml 缺失时用它兜底。
#:
#: **这里的 dlls 列表是按真实缺口写的，不是照抄「常见 Windows 运行库清单」。**
#: 实测 wine 11.21 的 base 层：`system32` 已含全部 28 个 VC++ 运行库
#: （`msvcp*` / `msvcr*` / `vcruntime*` / `vcomp*`）与 6 个 ATL。因此：
#:
#:   - vcpp 层在 wine 下**通常不需要**，保留定义只为极端情况（用户要
#:     覆盖成微软原版运行库）。匹配器会先查 base，绝大多数包不会挂它。
#:   - **MFC 是真缺口**：base 里没有任何 `mfc*.dll`。
#:   - **.NET 是真缺口**：base 只有 `mscoree.dll` stub，没有 `mscorlib`。
#:   - **中文字体不是缺口**（见模块 docstring 的实测修正）：wineboot 已把
#:     宿主字体登记进注册表 —— `Windows NT\CurrentVersion\Fonts` 单段
#:     **882 条**（去 `#time` 元数据），其中 PingFang 48 / Hiragino 22 /
#:     Songti 16 / Kaiti 14 / Heiti 10。fonts-cn 的作用是固化字体、脱离宿主。
#:     **不写「中文字体 254 条」**：那是把两个键集相同的 Fonts 段相加的
#:     重复计数，正是 README 4.2.1 记录的那个错误（详见该节）。
BUILTIN_LAYERS: dict[str, dict] = {
    "base": {
        "description": "Windows 骨架：drive_c/windows、system32、注册表初始态",
        "dlls": [],
        "requires": [],
        "priority": 0,
    },
    "vcpp": {
        "description": "VC++ 2005-2022 运行库（base 已内置，仅用于覆盖成微软原版）",
        "dlls": ["msvcp140", "vcruntime140", "msvcr120", "msvcr100",
                 "msvcp120", "msvcp100", "vcomp140"],
        "requires": ["base"],
        "priority": 10,
    },
    "mfc": {
        "description": "MFC 运行库（mfc140u / mfc120u 等，base 不含）",
        "dlls": ["mfc140u", "mfc140", "mfc120u", "mfc120", "mfc110u",
                 "mfc110", "mfc100u", "mfc100", "mfcm140u", "mfcm140"],
        "requires": ["base"],
        "priority": 15,
    },
    "dotnet": {
        "description": ".NET Framework 4.x（base 只有 mscoree stub）",
        "dlls": ["mscoree", "mscorlib", "clr", "clrjit", "system",
                 "system.core", "mscorwks", "mscorsvr"],
        "requires": ["base"],
        "priority": 20,
    },
    "fonts-cn": {
        "description": "固化本地字体文件进 Fonts/（脱离宿主字体依赖；中文渲染本身不缺口）",
        "dlls": [],
        "requires": ["base"],
        "priority": 5,
    },
}

#: 每层必须含有的标志路径，用于 verify
LAYER_MARKERS: dict[str, str] = {
    "base": "drive_c/windows/system32",
    "vcpp": "drive_c/windows/system32",
    "mfc": "drive_c/windows/system32",
    "dotnet": "drive_c/windows/Microsoft.NET",
    "fonts-cn": "drive_c/windows/Fonts",
}


@dataclass(slots=True)
class LayerInfo:
    name: str
    path: Path
    exists: bool
    files: int = 0
    bytes: int = 0
    problems: list[str] = field(default_factory=list)
    description: str = ""

    @property
    def ok(self) -> bool:
        return self.exists and not self.problems


def _tree_size(root: Path) -> tuple[int, int]:
    files = 0
    total = 0
    for path in root.rglob("*"):
        if path.is_file() and not path.is_symlink():
            files += 1
            try:
                total += path.stat().st_size
            except OSError:
                # 统计体积时跳过读不到的文件。这是给人看的参考数字，为它中断
                # 整个层扫描不值得。
                pass
    return files, total


def layer_path(name: str) -> Path:
    return wexe_paths.layers_root() / name


def inspect_layer(name: str) -> LayerInfo:
    """检查单个层的状态。不抛异常。"""
    path = layer_path(name)
    info = LayerInfo(name=name, path=path, exists=path.is_dir(),
                     description=BUILTIN_LAYERS.get(name, {}).get("description", ""))

    if not info.exists:
        info.problems.append(f"层目录不存在：{path}")
        return info

    files, total = _tree_size(path)
    info.files = files
    info.bytes = total

    marker = LAYER_MARKERS.get(name)
    if marker and not (path / marker).exists():
        info.problems.append(f"缺少标志路径：{marker}")

    if files == 0:
        info.problems.append("层为空")

    return info


def list_layers() -> list[LayerInfo]:
    """列出所有已知层（含未安装的）。"""
    names = set(BUILTIN_LAYERS)
    root = wexe_paths.layers_root()
    if root.is_dir():
        for child in root.iterdir():
            if child.is_dir() and not child.name.startswith("."):
                names.add(child.name)
    return [inspect_layer(name) for name in sorted(names)]


def _ensure_layer_absent(target: Path) -> None:
    """层已存在时拒绝重建。

    不自动删除的理由：用户可能往层里手工补过文件，静默覆盖等于毁掉
    他的劳动。要重建就自己移走，这一步不该由工具代劳。
    """
    if target.is_dir() and any(target.iterdir()):
        raise UsageError(
            f"{target.name} 层已存在：{target}",
            hint="wepack 不删除已有内容。确认要重建时先手动移走该目录",
        )


def _staged_prefix(timeout: int):
    """在临时目录里跑 wineboot，产出一个干净 prefix 的上下文管理器。

    不直接在 layers/<name> 里跑：中途失败会留下半个 prefix，而层的
    「存在但不完整」比「不存在」难排查得多 —— 后续 `layers list` 会
    报一堆缺标志路径，用户不知道该删了重建。
    """
    import contextlib

    @contextlib.contextmanager
    def _ctx():
        from ..install import wine_binary, wineboot_init
        from ..prefix import validate_prefix

        wine_binary()               # 缺运行时立即报错，别跑到一半才发现
        with tempfile.TemporaryDirectory(prefix="exeonmac-layer-") as tmp:
            staging = Path(tmp) / "prefix"
            staging.mkdir()

            result = wineboot_init(staging, timeout=timeout)
            if not result.ok:
                raise InstallFailed(
                    "wineboot 失败，无法构建层",
                    hint=(result.stderr_tail or result.stdout_tail or "")[:600],
                )

            problems = validate_prefix(staging)
            if problems:
                raise InstallFailed("prefix 校验失败", hint="；".join(problems))

            yield staging

    return _ctx()


def _commit(staging: Path, target: Path) -> None:
    """把组装好的临时 prefix 搬到最终位置。"""
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    shutil.move(str(staging), str(target))


def build_base_layer(*, timeout: int = 600) -> LayerInfo:
    """构建 base 层：跑一次 wineboot，把干净 prefix 搬进 layers/base。

    这是阶段 2 的前置。只有第一次需要，之后所有应用包 clonefile 复用。
    """
    target = layer_path("base")
    _ensure_layer_absent(target)

    with _staged_prefix(timeout) as staging:
        # 直接搬走临时目录里的 prefix，故先复制到 target 的兄弟位置，
        # 避免 TemporaryDirectory 退出时把已搬走的内容再删一次。
        tmp_commit = target.with_name(f".{target.name}.staging")
        if tmp_commit.exists():
            shutil.rmtree(tmp_commit, ignore_errors=True)
        shutil.move(str(staging), str(tmp_commit))
        _commit(tmp_commit, target)

    return inspect_layer("base")


def find_mono_msi() -> Path:
    """定位运行时自带的 wine-mono 支持包。

    `wine-mono-<ver>/support/winemono-support.msi` 随 wine 一起分发，
    所以 dotnet 层不需要用户提供任何文件，也不联网。

    返回最新版本的那一个（多版本共存时按版本号排序，不按目录列表顺序）。
    """
    mono_root = wexe_paths.wine_root() / "share" / "wine" / "mono"
    if not mono_root.is_dir():
        raise MissingDependency(
            "运行时不含 wine-mono，无法构建 dotnet 层",
            hint=f"预期目录：{mono_root}。用 wepack runtime install 重装运行时",
        )

    def _version_key(path: Path) -> tuple:
        # wine-mono-11.3.0 → (11, 3, 0)。非数字段退化为空元组（排最后）。
        parts = path.name.rsplit("-", 1)[-1].split(".")
        try:
            return tuple(int(p) for p in parts)
        except ValueError:
            return ()

    candidates = sorted(
        (p for p in mono_root.iterdir() if p.is_dir()),
        key=_version_key, reverse=True,
    )
    for mono_dir in candidates:
        msi = mono_dir / "support" / "winemono-support.msi"
        if msi.is_file():
            return msi

    raise MissingDependency(
        "wine-mono 目录存在但没有 winemono-support.msi",
        hint=f"检查 {mono_root}/*/support/ 下是否有该文件",
    )


def build_dotnet_layer(*, timeout: int = 600) -> LayerInfo:
    """构建 dotnet 层：把 wine-mono 的 MSI 静默装进一个干净 prefix。

    ## 为什么这条路能自动做

    实测（2026-11-19）`wine-mono-11.3.0/support/winemono-support.msi`
    用 `wine64 msiexec /i ... /qn` 装完，prefix 里会出现
    `drive_c/windows/Microsoft.NET/Framework/{v1.1.4322,v2.0.50727,v4.0.30319}/mscorlib.dll`
    与 196608 字节的 `mscoree.dll`。而 base 层只有 mscoree 的 stub、
    没有 `Microsoft.NET` 目录 —— 所以这确实是 base 的缺口，不是重复劳动。

    **注意这不是 .NET Framework 本体**：wine-mono 是 wine 自己的托管运行时
    实现，覆盖大多数 .NET 程序，但不保证与微软原版行为一致。需要原版
    .NET 的程序仍得用户提供微软安装包（本函数不处理）。
    """
    target = layer_path("dotnet")
    _ensure_layer_absent(target)

    msi = find_mono_msi()

    with _staged_prefix(timeout) as staging:
        from ..install import host_to_wine_path, run_in_prefix

        # MSI 通过 Z: 盘访问，不复制进 prefix —— 与 run_install 的做法一致。
        # 不转换路径的话 wine 会把 /Users/... 当成相对路径，msiexec 报
        # 「找不到安装包」而不是「路径没转换」，排查会绕远路。
        result = run_in_prefix(
            staging, ["msiexec", "/i", host_to_wine_path(msi), "/qn"],
            timeout=timeout,
        )
        if not result.ok:
            raise InstallFailed(
                "wine-mono 安装失败，dotnet 层未建成",
                hint=(result.stderr_tail or result.stdout_tail or "")[:600],
            )

        # 装完必须真的出现 .NET 结构，否则「msiexec 返回 0」是空转。
        # 这类「退出码 0 但什么都没做」的假成功在本项目已出现过多次。
        framework = staging / "drive_c" / "windows" / "Microsoft.NET" / "Framework"
        if not framework.is_dir():
            raise VerifyFailed(
                "msiexec 返回成功但 prefix 里没有 Microsoft.NET/Framework",
                hint=f"检查 {msi} 是否与当前 wine 版本匹配",
            )
        if not any(framework.glob("*/mscorlib.dll")):
            raise VerifyFailed(
                "Microsoft.NET/Framework 下没有 mscorlib.dll",
                hint=f"目录内容：{sorted(p.name for p in framework.iterdir())[:5]}",
            )

        tmp_commit = target.with_name(f".{target.name}.staging")
        if tmp_commit.exists():
            shutil.rmtree(tmp_commit, ignore_errors=True)
        shutil.move(str(staging), str(tmp_commit))
        _commit(tmp_commit, target)

    return inspect_layer("dotnet")


def build_fonts_layer(font_files: list[Path], *,
                      timeout: int = 600) -> LayerInfo:
    """构建 fonts-cn 层：把用户指定的字体文件放进 prefix 的 Fonts 目录。

    ## 这一层解决什么

    **不是**"补上缺失的中文字体" —— base 上中文本来就能显示（`wineboot`
    已把宿主字体登记进注册表，单段 882 条，详见模块 docstring 的实测修正；
    注意不是「254 条」，那是两段相加的重复计数）。
    它解决的是**依赖宿主**：那些条目全是 `Z:\\System\\Library\\Fonts\\...`
    指向本机路径，产物拷到别的 Mac 上就打不开了。

    把字体文件放进 `Fonts/` 后，字体会随层一起分发，不再指向宿主。

    ## 为什么必须由用户指定文件

    工具不能替用户决定"拿哪一份字体"：
      - 微软雅黑 / 宋体属微软授权，不可再分发；
      - macOS 自带的黑体、宋体同样不可随产物分发；
      - 可再分发的只有 Noto / 思源 / 文泉驿这类开源字体，且不在系统默认位置。

    因此这里只做"把给定文件装进层"这件机械的事，来源由用户负责并自行确认
    授权。工具不代下载、也不自动从系统字体里挑 —— 那等于把授权风险静默
    转嫁给用户。

    ## 注册靠目录扫描，不是 fontreg

    wine **没有** `fontreg` 可执行文件（实测 wine 11.21：`wine fontreg`
    → `ShellExecuteEx failed: File not found`，退出码 1）。它是在启动时
    直接扫 `c:\\windows\\fonts\\` 目录的：`WINEDEBUG=+font` 可见
    `unix_face_create ... WacminProbeCN.ttc, face_index 0..7`，即一个 ttc
    里的 8 个 face 都被枚举。

    因此本函数**不跑任何注册命令**，只保证文件落地且可读；注册表由 wine
    首次启动该 prefix 时自行补全。少一个外部工具依赖，也少一处"退出码 0
    但什么都没做"的假成功。

    ## ttc 为什么要提示

    macOS 的中文字体多是 `.ttc`（TrueType Collection，一个文件装多套字）。
    wine 能读（上面的 trace 就是 ttc），但 Windows 侧惯用单套 `.ttf`，且
    一个 ttc 占的磁盘可能很大（Songti.ttc 实测 66.9 MB）。这里不自动拆包
    （那需要额外工具），只如实提示。

    @param font_files 至少一个字体文件；扩展名限 ttf / ttc / otf
    """
    if not font_files:
        raise UsageError(
            "fonts-cn 层需要至少一个字体文件",
            hint=("示例：wepack layers build fonts-cn --font ~/fonts/NotoSansSC-Regular.ttf "
                  "（字体须为你有权再分发的文件）"),
        )

    resolved: list[Path] = []
    for raw in font_files:
        path = Path(raw).expanduser()
        if not path.is_file():
            raise UsageError(f"字体文件不存在：{path}")
        if path.suffix.lower() not in (".ttf", ".ttc", ".otf"):
            raise UsageError(
                f"不支持的字体格式：{path.suffix}",
                hint="只接受 ttf / ttc / otf",
            )
        resolved.append(path)

    target = layer_path("fonts-cn")
    _ensure_layer_absent(target)

    with _staged_prefix(timeout) as staging:
        fonts_dir = staging / "drive_c" / "windows" / "Fonts"
        fonts_dir.mkdir(parents=True, exist_ok=True)

        # 用 copyfile 而不是 copy2：后者会连扩展属性与 BSD flags 一起复制，
        # 实测从 /System/Library/Fonts 拷出来时 copystat 触发
        # `PermissionError: [Errno 1] Operation not permitted`（沙箱不允许
        # 对目标设 chflags）。字体只需要文件内容，元数据没有意义。
        for path in resolved:
            dest = fonts_dir / path.name
            shutil.copyfile(path, dest)
            os.chmod(dest, 0o644)

        # 装完验证文件真的在、且非空。这一步防的是"copyfile 静默产出 0 字节"
        # 这类假成功 —— 字体文件为 0 时 wine 扫到也不会报错，只是渲染不出字。
        for path in resolved:
            dest = fonts_dir / path.name
            if not dest.is_file() or dest.stat().st_size == 0:
                raise VerifyFailed(
                    f"字体文件未正确写入：{dest.name}",
                    hint=f"源文件 {path}（{path.stat().st_size} 字节）",
                )

        tmp_commit = target.with_name(f".{target.name}.staging")
        if tmp_commit.exists():
            shutil.rmtree(tmp_commit, ignore_errors=True)
        shutil.move(str(staging), str(tmp_commit))
        _commit(tmp_commit, target)

    info = inspect_layer("fonts-cn")
    ttc = [p.name for p in resolved if p.suffix.lower() == ".ttc"]
    if ttc:
        info.problems.append(
            f"含 ttc 集合文件（{', '.join(ttc)}），建议换成单套 ttf 以减小体积")
    return info


def build_layer(name: str, *, timeout: int = 600,
                font_files: list[Path] | None = None) -> LayerInfo:
    """按名字构建层。这是 CLI 的唯一入口。"""
    if name == "base":
        return build_base_layer(timeout=timeout)
    if name == "dotnet":
        return build_dotnet_layer(timeout=timeout)
    if name == "fonts-cn":
        return build_fonts_layer(font_files or [], timeout=timeout)
    if name == "mfc":
        raise MissingDependency(
            "mfc 层无法自动构建：wine 不实现 MFC，也没有可再分发的来源",
            hint=("实测 wine 11.21 的 base 层 system32 里没有任何 mfc*.dll，"
                  "i386-windows/ 里也没有，运行时内亦无 MFC 二进制。"
                  "需要你自备 VC++ 可再分发包（含 mfc140u.dll 等），"
                  "装进一个临时 prefix 后把 system32 下的 mfc*.dll 复制到 "
                  f"{layer_path('mfc')}/drive_c/windows/system32/"),
        )
    if name == "vcpp":
        raise UsageError(
            "vcpp 层不需要构建：base 已内置全部 VC++ 运行库",
            hint=("实测 base 的 system32 含 msvcp*/msvcr*/vcruntime*/vcomp* 共 28 个。"
                  "只有要把它们覆盖成微软原版时才需要自备安装包"),
        )
    raise UsageError(
        f"未知层：{name}",
        hint=f"可用：{', '.join(sorted(BUILTIN_LAYERS))}",
    )


def verify_layer(name: str) -> list[str]:
    """校验层完整性。返回问题列表。"""
    return inspect_layer(name).problems


def mount_layer(app_dir: Path, name: str) -> Path:
    """把层 clonefile 进 .app 的 Private/。"""
    from ..prefix import _clone_into

    private_dir = Path(app_dir) / "Contents" / "Resources" / "Private"
    if not private_dir.is_dir():
        raise UsageError(f"不是已安装的 .app（缺 Private/）：{app_dir}")

    source = layer_path(name)
    if not source.is_dir():
        raise InstallFailed(
            f"层不存在：{name}",
            hint=f"预期 {source}。先执行 wepack layers build {name}",
        )

    result = _clone_into(source, private_dir)
    if not result.ok:
        raise InstallFailed(f"挂载 {name} 失败", hint=result.note)
    return private_dir


__all__ = [
    "BUILTIN_LAYERS", "LAYER_MARKERS", "LayerInfo",
    "layer_path", "inspect_layer", "list_layers",
    "build_base_layer", "build_dotnet_layer", "build_fonts_layer",
    "build_layer", "find_mono_msi",
    "verify_layer", "mount_layer",
    "match", "match_layers", "describe", "scan_dependencies",
]


def __getattr__(name: str):
    """惰性转出 match 子模块的符号。

    这样 `from wepack.layers import match_layers` 能直接工作，同时
    不引入循环导入（match.py 反过来要 import 本模块的 BUILTIN_LAYERS）。

    必须用 importlib 而不是 `from . import match`：后者会走模块的
    `__getattr__`，导致无限递归。
    """
    if name in ("match", "match_layers", "describe", "scan_dependencies",
                "base_dll_index", "Dependency", "MatchResult",
                "normalize_dll_name"):
        import importlib
        module = importlib.import_module(f"{__name__}.match")
        return module if name == "match" else getattr(module, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")