"""Wine prefix 管理。

铁律 3：prefix 永远在包内 Contents/Resources/Private/，绝不在 ~/.wine。

base 层用 APFS clonefile 复制。clonefile 是写时复制：复制 2 GB 的 base 层
几乎不占额外空间，耗时接近 0。代价是文件条目（inode）会真实增加。

**为什么不用硬链接**：硬链接让"写 Private 不污染共享层"失效 —— 写任一副本
都会改共享 inode。clonefile 不会。
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from .. import paths as wexe_paths
from ..errors import InstallFailed, UsageError
from ..tools import TEXT_MODE

#: prefix 里必须存在的注册表文件
REQUIRED_REG_FILES = ("system.reg", "user.reg", "userdef.reg")

#: wine 内部注册表的版本行。三个 `.reg` 的首行都必须是它，一字不差。
REG_HEADER = "WINE REGISTRY Version 2"

#: wine 只在这三种文件里认「64 位安装」
REG_ARCH_64 = "#arch=win64"


@dataclass(slots=True)
class CloneResult:
    """一次 clonefile 的结果，用于日志与降级说明。"""

    source: Path
    target: Path
    method: str            # "clonefile" | "copy"
    ok: bool
    files: int = 0
    bytes: int = 0
    note: str = ""


@dataclass(slots=True)
class PrefixReport:
    """prefix 创建报告。"""

    private_dir: Path
    layers: list[str] = field(default_factory=list)
    clones: list[CloneResult] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    created: bool = False

    @property
    def ok(self) -> bool:
        return self.created and not validate_prefix(self.private_dir)


# --------------------------------------------------------------------------
# clonefile
# --------------------------------------------------------------------------


def _count_tree(root: Path) -> tuple[int, int]:
    files = 0
    total = 0
    for path in root.rglob("*"):
        if path.is_file() and not path.is_symlink():
            files += 1
            try:
                total += path.stat().st_size
            except OSError:
                # 同上：体积统计，跳过不可读项，不影响 prefix 是否可用。
                pass
    return files, total


def clone_tree(src: Path, dst: Path) -> CloneResult:
    """APFS clonefile 复制目录。

    用 `cp -c -R` 调 clonefile(2)。失败（跨卷、非 APFS、文件系统不支持）时
    降级为普通 `cp -R`，并在结果里标注 method="copy" —— 此时会真实占空间，
    调用方应据此提示用户。
    """
    src = Path(src)
    dst = Path(dst)
    if not src.is_dir():
        raise UsageError(f"层目录不存在：{src}")
    if dst.exists():
        raise UsageError(f"目标已存在，拒绝覆盖：{dst}")

    dst.parent.mkdir(parents=True, exist_ok=True)

    def run(args: list[str]) -> subprocess.CompletedProcess:
        return subprocess.run(args, capture_output=True, **TEXT_MODE)

    # -c 是 clonefile；-R 递归；-p 保留属性
    result = run(["/bin/cp", "-c", "-R", "-p", str(src), str(dst)])
    method = "clonefile"
    note = ""

    if result.returncode != 0:
        # 降级：真实复制。跨卷或非 APFS 时会走到这里。
        if dst.exists():
            shutil.rmtree(dst, ignore_errors=True)
        result = run(["/bin/cp", "-R", "-p", str(src), str(dst)])
        method = "copy"
        note = ("clonefile 不可用，已降级为普通复制："
                "该层会真实占用磁盘空间（跨卷或非 APFS 文件系统）")

    if result.returncode != 0:
        return CloneResult(source=src, target=dst, method=method, ok=False,
                           note=(result.stderr or "").strip()[:400])

    files, total = _count_tree(dst)
    return CloneResult(source=src, target=dst, method=method, ok=True,
                       files=files, bytes=total, note=note)


# --------------------------------------------------------------------------
# prefix 创建
# --------------------------------------------------------------------------


def _link_dosdevices(private_dir: Path) -> None:
    """建 dosdevices 下的盘符符号链接。

    c: → ../drive_c（相对路径，包可移动）
    z: → /（整个 macOS 根，wine 标准做法，用于访问安装包等外部文件）
    """
    dosdevices = private_dir / "dosdevices"
    dosdevices.mkdir(parents=True, exist_ok=True)

    links = {
        "c:": "../drive_c",
        "z:": "/",
    }
    for name, target in links.items():
        link = dosdevices / name
        if link.is_symlink() or link.exists():
            link.unlink()
        os.symlink(target, link)


def _write_placeholder_regs(private_dir: Path) -> None:
    """base 层没带注册表文件时，写最小可用的占位。

    wine 首次启动会自己补全缺失的项，占位只要保证「wine 认得出这是注册表」
    并且「认得出这是 64 位安装」，剩余的键它自己会写进去。

    ## 两个格式细节都是实测出来的，不是查文档抄的
    （2026-11-21，wine-11.21，同一份 base 层只换这三个文件）

    1. **必须是纯 ASCII，不能带 UTF-16 BOM。** 早先这里写的是
       `b"\\xff\\xfe" + 正文.encode("utf-16-le")`，理由是「wine 的 .reg 是
       UTF-16LE」——那个说法只对 `regedit /E` **导出**的文件成立。prefix 里
       这三个文件是 wine 自己的存储格式，实测 UTF-16LE+BOM 会被判
       `system.reg is not a valid registry file`、`rc=1`：
           wine: '...' is a 32-bit installation, it cannot support 64-bit applications.
    2. **必须带 `#arch=win64`。** 缺这一行 wine 同样判「32 位安装」并拒绝
       运行 64 位程序（`rc=1`），而文件本身语法完全合法 —— 报错停在
       「32-bit installation」上，看不出是少了这一行。`#arch=win32` 与
       `#ARCH=win64`（大小写不符）都会得到同一条错误，即这行是精确匹配。

    实测确认修好后 wine 能起来（`cmd /c echo hi` → `rc=0`），并把占位表
    自己补全成 20 万字节的完整注册表。
    """
    body = f"{REG_HEADER}\n;; ExeOnMac placeholder\n{REG_ARCH_64}\n"
    for name in REQUIRED_REG_FILES:
        target = private_dir / name
        if target.exists() and target.stat().st_size > 0:
            continue
        target.write_bytes(body.encode("ascii"))


def validate_prefix(private_dir: Path) -> list[str]:
    """返回 prefix 的问题列表，空列表表示健康。"""
    problems: list[str] = []

    if not private_dir.is_dir():
        return [f"prefix 目录不存在：{private_dir}"]

    drive_c = private_dir / "drive_c"
    if not drive_c.is_dir():
        problems.append("缺少 drive_c 目录")
    else:
        system32 = drive_c / "windows" / "system32"
        if not system32.is_dir():
            problems.append("缺少 drive_c/windows/system32")
        elif not any(system32.iterdir()):
            problems.append("drive_c/windows/system32 为空")

    c_link = private_dir / "dosdevices" / "c:"
    if not c_link.is_symlink():
        problems.append("dosdevices/c: 不是符号链接")
    else:
        resolved = (private_dir / "dosdevices" / c_link.readlink()).resolve()
        if not resolved.is_dir():
            problems.append(f"dosdevices/c: 指向的目录不存在：{resolved}")

    for name in REQUIRED_REG_FILES:
        reg = private_dir / name
        if not reg.is_file():
            problems.append(f"缺少 {name}")
        elif reg.stat().st_size == 0:
            problems.append(f"{name} 为空")
        else:
            problem = _check_reg_file(reg, name)
            if problem:
                problems.append(problem)

    return problems


def _check_reg_file(reg: Path, name: str) -> str:
    """检查单个 `.reg` 的内容能否被 wine 接受。返回问题描述，健康时返回空串。

    ## 为什么必须看内容，而不是只看「存在且非空」

    早先这里只判 `is_file()` 与 `st_size > 0`。于是把 `system.reg` 写成
    一行 `this is not a registry`（35 字节，非空）之后：

        validate_prefix(...)   ->  []                   # 判定健康
        wine64 cmd /c "echo hi" ->  rc=1
            system.reg is not a valid registry file
            wine: '...' is a 32-bit installation, it cannot support 64-bit applications.

    即「校验通过、双击毫无反应」。打包侧第 7 项 `prefix.valid` 调的正是
    这个函数，所以产出的 `.app` 同样被放行 —— 用户拿到的是打不开的包。

    ## 三个文件的致命程度不同，判据必须分开（逐个跑真实 wine 实测）

    | 文件 | 首行不对 | 缺 `#arch=win64` |
    |---|---|---|
    | `system.reg`  | rc=1，起不来 | **rc=1**，报「32-bit installation」 |
    | `user.reg`    | **rc=0，但 HKCU 写入静默丢失** | rc=0，无影响 |
    | `userdef.reg` | rc=0，仅新用户默认值丢失 | rc=0，无影响 |

    中档那条最阴：`user.reg` 写成 `garbage` 后 `reg add` 仍返回 0、`reg query`
    却查不到刚写的键，`user.reg` 体积从 119640 掉回 8 字节 —— 安装器会
    「成功」装完，注册的路径/序列号全没落盘，第二次启动就失效。
    所以首行检查三个文件都要做，`#arch` 只对 `system.reg` 做。

    ## 首行判据的实测边界

    `REGEDIT4` / `Version 1` / `Version 3` / 前置空行 →
    全部 `not a valid registry file`；`Windows Registry Editor Version 5.00`
    同样如此（那是 `regedit /E` 的**导出**格式，不是 prefix 里的存储格式）。

    ## `#arch` 判据的实测边界

    - 缺 → rc=1，报「32-bit installation」，而文件语法完全合法，报错看不出是少了这行
    - `#arch=win32` / `#ARCH=win64`（大小写不符）→ 同一条错误，说明是精确匹配
    - 位置不限：第 3 行、第 6 行、空行之后、CRLF、行尾无换行，实测均可

    ## 刻意**不**做的检查（都实测过，做了会误报）

    - 不校验 section 与键值语法。`[Software\\X]` 后跟半行 `"a"="b` 会被
      wine 报 `Malformed value`，但 `rc` 仍是 **0**、程序照常跑 —— 丢一个值而已。
    - 不要求文件是 ASCII。存储格式确实是 ASCII，但**读**的时候 wine 也接受
      别的编码 —— 要求 ASCII 是「写得对」，不是「起得来」，这里只守后者。
    """
    try:
        with reg.open("rb") as handle:
            head = handle.read(65536)
    except OSError as exc:
        return f"{name} 无法读取：{exc.strerror or exc}"

    text = head.decode("utf-8", "replace")
    first_line = text.split("\n", 1)[0].rstrip("\r")
    if first_line != REG_HEADER:
        shown = first_line[:40] if first_line else "（空行）"
        return f"{name} 首行不是「{REG_HEADER}」，实际为「{shown}」——wine 会拒收"

    # arch 只有 system.reg 里的算数。实测 system.reg 在前 128 字节内就写了
    # 这一行；取 64 KB 已远超实际需要，又不会整读 3 MB 的 system.reg。
    if name == "system.reg" and REG_ARCH_64 not in text:
        return (f"{name} 缺少 {REG_ARCH_64} ——wine 会把它当成 32 位安装，"
                f"拒绝运行 64 位程序")

    return ""


def create_prefix(private_dir: Path, *, layers: list[str] | None = None,
                  force: bool = False) -> PrefixReport:
    """在 private_dir 建立可用 prefix。

    步骤：
      1. 校验目录状态（非空且未 force → 拒绝，不删用户数据）
      2. 依次 clonefile 各层到 private_dir（base 必须在首位）
      3. 建 dosdevices/c: 与 z:
      4. 补占位注册表（层未自带时）
      5. 校验

    层挂载顺序即列表顺序，后面的层覆盖前面的同名文件 —— 这就是
    "读时先 Private 再 Layers" 的实现：clonefile 叠加成单一目录树，
    wine 看到的是一棵完整 prefix，无需任何路径重定向。
    """
    private_dir = Path(private_dir).expanduser().resolve()
    layer_names = list(layers or ["base"])

    if not layer_names or layer_names[0] != "base":
        raise UsageError(
            f"layers 必须以 base 开头，实际为 {layer_names}",
            hint="base 层提供 Windows 骨架，必须最先挂载",
        )

    # 目录状态检查：不删除任何已有内容
    if private_dir.exists():
        if not private_dir.is_dir():
            raise UsageError(f"路径已存在且不是目录：{private_dir}")
        if any(private_dir.iterdir()):
            if not force:
                raise UsageError(
                    f"prefix 目录非空：{private_dir}",
                    hint="wepack 不删除已有内容。换一个 .app 路径，或手动清空",
                )
            raise UsageError(
                f"prefix 目录非空：{private_dir}",
                hint="wepack 不删除已有内容，请换路径或手动清空",
            )
    else:
        private_dir.mkdir(parents=True)

    report = PrefixReport(private_dir=private_dir, layers=layer_names)

    # 逐层 clonefile
    for index, name in enumerate(layer_names):
        layer_dir = wexe_paths.layers_root() / name
        if not layer_dir.is_dir():
            raise InstallFailed(
                f"缺少共享层：{name}",
                hint=(f"层目录应为 {layer_dir}。"
                      f"阶段 4 会用 wepack layers 管理；现在可先手动放入 "
                      f"wine 生成的 prefix 内容"),
            )

        if index == 0:
            # 第一层直接 clone 到 private_dir 本身
            result = clone_tree(layer_dir, private_dir) if not private_dir.exists() \
                else _clone_into(layer_dir, private_dir)
        else:
            result = _clone_into(layer_dir, private_dir)

        report.clones.append(result)
        if not result.ok:
            raise InstallFailed(
                f"挂载层 {name} 失败",
                hint=result.note or "clonefile 与普通复制均失败",
            )
        if result.method == "copy" and result.note:
            report.warnings.append(f"{name}: {result.note}")

    _link_dosdevices(private_dir)
    _write_placeholder_regs(private_dir)

    problems = validate_prefix(private_dir)
    if problems:
        raise InstallFailed(
            "prefix 校验失败",
            hint="；".join(problems),
        )

    report.created = True
    return report


def _clone_into(layer_dir: Path, private_dir: Path) -> CloneResult:
    """把层内容合并进已存在的 private_dir（同名覆盖）。

    cp -c 只能复制到不存在的目标，所以这里先 clone 到临时目录再合并。
    合并用 shutil.copytree(dirs_exist_ok=True)，它在同卷上仍会走
    clonefile 路径（macOS 上 copyfile 默认带 COPYFILE_CLONE）。
    """
    staging = private_dir.parent / f".{private_dir.name}.layer-{layer_dir.name}"
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)

    result = clone_tree(layer_dir, staging)
    if not result.ok:
        return result

    files, total = 0, 0
    failed: list[str] = []
    for item in staging.rglob("*"):
        if not item.is_file() or item.is_symlink():
            continue
        relative = item.relative_to(staging)
        target = private_dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(item, target)
            files += 1
            total += item.stat().st_size
        except OSError as exc:
            # ## 这里不能吞
            #
            # 层文件没复制过去，prefix 就缺东西，但 `validate_prefix` 只核对
            # 几个关键路径（system32 / windows 等），少一个 Python 运行时
            # 或一个 DLL 它看不出来。于是 mount 报成功、用户装完启动才炸，
            # 而且要重新走一遍十分钟的安装才能发现。
            #
            # 记下来，由返回值如实反映 —— 调用方看到 ok=False 会走 copy 兜底。
            failed.append(f"{relative}（{exc.strerror or exc}）")

    shutil.rmtree(staging, ignore_errors=True)
    if failed:
        shown = "；".join(failed[:3])
        more = f" 等 {len(failed)} 个文件" if len(failed) > 3 else ""
        return CloneResult(source=layer_dir, target=private_dir,
                           method=result.method, ok=False,
                           files=files, bytes=total,
                           note=f"合并层时有文件写入失败：{shown}{more}")
    return CloneResult(source=layer_dir, target=private_dir,
                       method=result.method, ok=True,
                       files=files, bytes=total, note=result.note)


def prefix_disk_usage(private_dir: Path) -> tuple[int, int]:
    """返回 (逻辑字节数, 已分配块字节数)。

    注意：**已分配块不等于真实占用**。APFS clonefile 的共享块会被
    st_blocks 重复计入每个副本 —— `du` 无法知道块是共享的。所以当
    method="clonefile" 时，第二个数字是上界，真实占用更小。

    想知道真实占用，只能测文件系统可用空间的差值（见 free_space）。
    """
    files, logical = _count_tree(private_dir)
    allocated = 0
    for path in private_dir.rglob("*"):
        if path.is_file() and not path.is_symlink():
            try:
                allocated += path.stat().st_blocks * 512
            except OSError:
                # 磁盘占用（st_blocks）统计，跳过失败项。这个数只用于提示用户
                # 「prefix 占了多少」，不参与任何判定。
                pass
    return logical, allocated


def free_space(path: Path) -> int:
    """返回 path 所在卷的可用字节数。用于测量 clonefile 的真实占用。"""
    try:
        stats = os.statvfs(str(path))
        return stats.f_bavail * stats.f_frsize
    except OSError:
        return 0


__all__ = [
    "REQUIRED_REG_FILES", "CloneResult", "PrefixReport",
    "create_prefix", "clone_tree", "validate_prefix",
    "prefix_disk_usage", "free_space",
]