"""静态解包。

铁律：只读原安装包，不改它。解包产物写进 -o 指定目录。

三条路径：
  NSIS  → 7z 直接解（7z 对 NSIS 的 LZMA/bzip2/deflate 支持完整）
  Inno  → 优先 innoextract（能还原真实目录结构），回退 7z（只能解出
          原始文件，目录结构靠安装脚本还原，精度下降要明确告知）
  MSI   → 优先 msiextract，回退 7z（只能取出内嵌流）

失败不抛裸异常给用户看：返回带 attempts 的报告，让上层决定是否降级到
"直接跑静默安装"（阶段 2 的路径）。
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path

from .. import tools
from ..errors import MissingDependency, UnsupportedSoftware, UsageError
from ..models import STATIC_EXTRACTABLE, ExtractResult, InstallerKind
from . import candidates as candidates_mod

#: 7z 解包时排除安装器自己的插件目录（不是应用内容）。
#:
#: `$INSTDIR` 不在这里：它是用户选择的**安装目标目录**，`$INSTDIR/App.exe`
#: 就是要装的那个程序。实测 7z 解 NSIS 时不产出任何带 `$` 的顶层路径
#: （载荷直接落根目录），排除它是空操作；而万一某个 7z 版本真的产出，
#: 载荷会被静默丢掉。见 candidates.TEMP_DIRS 的同类说明。
SEVEN_ZIP_EXCLUDES = ("$PLUGINSDIR", "$TEMP", "$OLDINSTDIR")

#: PE 节区名。7z 认不出安装包格式时会退回「按 PE 容器切开」，
#: 产出的就是这些名字 —— 它们是编译器分段，不是安装载荷。
PE_SECTION_NAMES = frozenset({
    ".text", ".data", ".rdata", ".idata", ".edata", ".reloc", ".rsrc",
    ".rsrc_1", ".tls", ".bss", ".itext", ".didata", ".pdata", ".xdata",
    ".ndata", ".sdata", "CERTIFICATE", "[0]",
})


@dataclass(slots=True)
class ExtractAttempt:
    """单次解包尝试的结果，用于日志与降级决策。"""

    method: str
    ok: bool
    detail: str = ""
    stderr: str = ""


@dataclass(slots=True)
class ExtractReport:
    """完整解包报告：包含所有尝试过的方法。"""

    result: ExtractResult | None = None
    attempts: list[ExtractAttempt] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.result is not None and self.result.file_count > 0


def _prepare_out_dir(out_dir: Path) -> None:
    """输出目录必须为空或不存在。

    非空时不覆盖、不删除 —— 用户目录里的东西一律不由我们清理。
    """
    if not out_dir.exists():
        out_dir.mkdir(parents=True)
        return
    if not out_dir.is_dir():
        raise UsageError(f"输出路径已存在且不是目录：{out_dir}")
    if any(out_dir.iterdir()):
        raise UsageError(
            f"输出目录非空：{out_dir}",
            hint="wepack 不删除已有内容，请换一个目录或手动清空",
        )


def _count_tree(root: Path) -> tuple[int, int]:
    """统计文件数与总字节数。"""
    count = 0
    total = 0
    for path in root.rglob("*"):
        if path.is_file():
            count += 1
            try:
                total += path.stat().st_size
            except OSError:
                # 解包后的体积统计，跳过不可读项。解包本身已经完成，这里只是
                # 给调用方一个参考数字。
                pass
    return count, total


def _seven_zip_extract(installer: Path, out_dir: Path,
                       attempt: ExtractAttempt) -> bool:
    """用 7z 解包到 out_dir。返回是否成功。

    ## 为什么成功之后还要再验一遍

    7z 对**认不出的**安装包不会报错：它退回「把 PE 容器切开」，
    把 `.text` / `.data` / `.rsrc` / `CERTIFICATE` 这些编译器分段
    当成文件解出来，返回码仍是 0。

    Inno Setup 正是这种情况。实测 Notepad3 6.7.0 安装器（4.88 MB）：
    7z 报 `Type = PE`，解出 33 个文件、共 4.7 MB，返回 0 —— 光看返回码
    和文件数完美，但里面**没有一个应用文件**，全是节区切片。

    对比同一台机器上的 NSIS 包（Notepad++ / Everything），7z 会打出
    两段 Type（`PE` 之后还有 `Nsis`），因为它在 PE 之后继续识别了
    真正的载荷容器。所以「只有 PE、没有第二段 Type」就是没认出来的信号。

    两道校验都上：
      1. 结构 —— 产物若是清一色 PE 节区名，判定失败
      2. 归档 —— `7z l -slt` 的 Type 只有 PE，说明 7z 没识别出载荷格式

    失败时如实报错，交给上层决定降级，而不是把垃圾当成果交出去。
    """
    tool = tools.seven_zip()
    args = ["x", str(installer), f"-o{out_dir}", "-y", "-bd", "-bso0", "-bsp0"]
    for pattern in SEVEN_ZIP_EXCLUDES:
        args.append(f"-x!{pattern}")

    result = tool.run(args, timeout=900)
    attempt.method = f"7z ({tool.path.name})"
    attempt.stderr = (result.stderr or "")[-2000:]

    # 7z 返回码：0=成功，1=有警告但完成，2=致命错误，7=命令行错误，8=内存不足
    if result.returncode in (0, 1):
        reason = _reject_pe_sections(out_dir, installer, tool)
        if reason is not None:
            attempt.ok = False
            attempt.detail = reason
            return False
        attempt.ok = True
        attempt.detail = ("解包成功" if result.returncode == 0
                          else "解包完成但有警告（部分条目跳过）")
        return True

    attempt.ok = False
    attempt.detail = f"7z 返回码 {result.returncode}"
    return False


def _reject_pe_sections(out_dir: Path, installer: Path, tool) -> str | None:
    """判断 7z 只是把 PE 容器切开了。是则返回拒绝理由，否则返回 None。"""
    entries = [item for item in out_dir.iterdir()]
    files = [item for item in entries if item.is_file()]
    if not files:
        return None

    names = {item.name for item in files}
    if not names <= PE_SECTION_NAMES:
        return None

    # 清一色节区名 —— 再用 7z 自己的归档类型确认一次，避免误伤
    listed = tool.run(["l", "-slt", str(installer)], timeout=300)
    kinds = [
        line.split("=", 1)[1].strip()
        for line in (listed.stdout or "").splitlines()
        if line.startswith("Type = ")
    ]
    if len(kinds) > 1:
        return None

    return (
        f"7z 未识别出安装包格式（归档类型仅 {kinds[0] if kinds else 'PE'}），"
        f"只切出了 {len(files)} 个 PE 节区"
        f"（{', '.join(sorted(names)[:4])}…），不是安装载荷")



def _inno_extract(installer: Path, out_dir: Path,
                  attempt: ExtractAttempt) -> bool:
    """用 innoextract 解 Inno Setup 安装包。能还原真实目录结构。"""
    tool = tools.find_tool("innoextract", required=False)
    if tool is None:
        attempt.method = "innoextract"
        attempt.ok = False
        attempt.detail = (
            "未安装 innoextract（Inno Setup 载荷只有它能解；"
            "7z 对 Inno 只会切开 PE 容器，拿不到应用文件）")
        return False

    # --silent 只输出错误与警告；-e 解应用文件；-m 排除安装临时文件。
    #
    # 这里**不能**写 --no-icon：innoextract 1.9 没有这个选项，参数解析
    # 失败会直接返回码 1（错误信息只在 stderr 第一行），表现为「Inno 解包
    # 永远失败」而看不出是参数写错。图标由我们自己从 exe 资源取，本来
    # 也不需要 innoextract 帮忙。
    args = ["--silent", "-e", "-m", "-d", str(out_dir), str(installer)]
    result = tool.run(args, timeout=900)
    attempt.method = f"innoextract ({tool.path.name})"
    attempt.stderr = (result.stderr or "")[-2000:]

    if result.returncode == 0:
        attempt.ok = True
        attempt.detail = "解包成功（已还原目录结构）"
        return True

    attempt.ok = False
    attempt.detail = _inno_failure_reason(result, installer)
    return False


def _inno_failure_reason(result, installer: Path) -> str:
    """把 innoextract 的失败翻译成用户能行动的话。

    innoextract 对**不支持的 Inno 版本**只说 "not a supported version"，
    不指出本机版本与安装包版本的关系。用户看到这句话无从下手：是安装包
    坏了，还是要升级工具？实测 innoextract 1.9 只支持到 Inno 6.0.5，
    而 Notepad3 6.7.0 这类新包就会撞上这条。
    """
    stderr = (result.stderr or "") + (getattr(result, "stdout", "") or "")
    lowered = stderr.lower()

    version = _inno_payload_version(installer)
    if "not supported" in lowered or "unsupported" in lowered or version:
        detail = f"innoextract 返回码 {result.returncode}"
        if version:
            detail += f"：安装包由 Inno Setup {version} 生成"
        detail += "，本机 innoextract 版本过旧"
        return detail

    return f"innoextract 返回码 {result.returncode}"


def _inno_payload_version(installer: Path) -> str:
    """读出 "Inno Setup Setup Data (x.y.z)" 里的版本号，读不到返回空串。

    ## UTF-16LE 也要认

    Inno 6.x 起默认编 Unicode 版，标记字符串是 UTF-16LE（每个字符后跟
    一个 0 字节）。只按 ASCII 查的话，本函数对 Unicode 版包永远返回空串，
    于是两条结论同时错：

      1. 「版本过旧」的提示给不出来 —— 用户看到的是干巴巴的返回码；
      2. 更糟的是，「版本够不够」的判断退化成「读不到版本 → 当作不旧」，
         于是一个真正需要新版 innoextract 的包会被反复重试并报出
         与真实原因无关的错误。

    返回的版本号是纯数字点分串（`6.2.2`），供 `packaging` 风格比较。
    """
    marker = b"Inno Setup Setup Data"
    try:
        with installer.open("rb") as handle:
            head = handle.read(2 * 1024 * 1024)
    except OSError:
        return ""

    idx = head.find(marker)
    width = 1
    if idx < 0:
        # 转成 UTF-16LE 再找一次
        wide = marker.decode("latin-1").encode("utf-16-le")
        idx = head.find(wide)
        width = 2
    if idx < 0:
        return ""

    tail = head[idx + len(marker) * width:][:48]
    if width == 2:
        text = tail.decode("utf-16-le", "replace").lstrip()
    else:
        text = tail.decode("latin-1", "replace").lstrip()
    if not text.startswith("("):
        return ""
    return text[1:].split(")", 1)[0].strip()


def _msi_extract(installer: Path, out_dir: Path,
                 attempt: ExtractAttempt) -> bool:
    """解 MSI。

    优先 msiextract（直接还原目录结构）。
    回退方案三步走：
      1. 7z 解出内嵌的 cab*.cab
      2. 每个 cab 解到临时目录
      3. 用 MSI 的 File / Directory 表把 fil<hex> 改名成真实文件名并归位
    只做前两步的话，用户看到的是 cab 和一堆哈希名，等于没解。
    """
    from ..detect import msi_tables

    tool = tools.find_tool("msiextract", required=False)
    if tool is not None:
        result = tool.run(["-C", str(out_dir), str(installer)], timeout=900)
        attempt.method = f"msiextract ({tool.path.name})"
        attempt.stderr = (result.stderr or "")[-2000:]
        if result.returncode == 0:
            attempt.ok = True
            attempt.detail = "解包成功（已还原目录结构）"
            return True
        attempt.detail = f"msiextract 返回码 {result.returncode}"

    seven = tools.seven_zip()

    # 第一步：解出 MSI 容器内的流（含 cab）
    staging = out_dir.parent / f".{out_dir.name}.msi-stage"
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)

    result = seven.run(["x", str(installer), f"-o{staging}", "-y", "-bd",
                        "-bso0", "-bsp0"], timeout=900)
    if result.returncode not in (0, 1):
        attempt.method = f"7z ({seven.path.name})"
        attempt.stderr = (result.stderr or "")[-2000:]
        attempt.ok = False
        attempt.detail = f"7z 解 MSI 容器失败，返回码 {result.returncode}"
        shutil.rmtree(staging, ignore_errors=True)
        return False

    # 第二步：把每个 cab 解出来
    cabs = sorted(staging.glob("*.cab"))

    if not cabs:
        return _finish_without_cab(
            staging, out_dir, installer, attempt, seven)

    raw_dir = out_dir / "_cab"
    raw_dir.mkdir(parents=True, exist_ok=True)
    extracted = 0
    for cab in cabs:
        cab_result = seven.run(["x", str(cab), f"-o{raw_dir}", "-y", "-bd",
                                "-bso0", "-bsp0"], timeout=900)
        if cab_result.returncode in (0, 1):
            extracted += 1

    shutil.rmtree(staging, ignore_errors=True)

    if extracted == 0:
        attempt.method = f"7z ({seven.path.name})"
        attempt.ok = False
        attempt.detail = f"解出 {len(cabs)} 个 cab 但全部展开失败"
        return False

    # 第三步：用 MSI 表还原真实文件名与目录
    renamed = 0
    failed = 0
    mapping_note = ""
    try:
        mapping = msi_tables.file_mapping(installer)
        if mapping:
            renamed, failed = msi_tables.rename_cab_files(out_dir, mapping)
            mapping_note = f"，按 File 表还原 {renamed} 个真实文件名"
            if failed:
                mapping_note += f"（{failed} 个未匹配）"
        else:
            mapping_note = "，但 File 表解析为空，文件保留哈希名"
    except msi_tables.MsiError as exc:
        mapping_note = f"，File 表解析失败（{exc}），文件保留哈希名"

    # 清掉中间目录：cab 原件与已搬空的 _cab
    for leftover in (raw_dir,):
        if leftover.exists() and not any(leftover.iterdir()):
            leftover.rmdir()
        elif leftover.exists():
            shutil.rmtree(leftover, ignore_errors=True)

    attempt.method = f"7z ({seven.path.name})"
    attempt.ok = True
    attempt.detail = (f"解包完成：展开 {extracted}/{len(cabs)} 个 cab"
                      f"{mapping_note}")
    return True


def _finish_without_cab(staging: Path, out_dir: Path, installer: Path,
                        attempt, seven) -> bool:
    """MSI 容器里没有独立 cab 文件时走这条路。

    ## 为什么会有这种 MSI

    Windows Installer 的载荷有两种放法：

      A. 独立流 —— 容器里有 `product.cab` 这样的流，7z 先解出 cab，
         再解 cab 得到载荷。
      B. 内联 —— 7z 在**容器这一层直接解出货真价实的载荷文件**，
         不产生中间 cab。

    7-Zip 官方的 MSI 用的是 B。早先的实现只认 A，第一步解完发现没有
    `*.cab` 就报「MSI 内未找到 cab 载荷（可能是仅含自定义动作的包）」，
    而实际上 106 个文件已经完整解出来了，全都被 `shutil.rmtree` 删掉。
    这是真实的误判：错误信息还把原因指向「包可能不含载荷」，与事实相反。

    ## 怎么判断真的是这种情况

    用 File 表的文件键去比对 staging 里的文件名。只要有一半以上的键
    能找到对应文件，就认定容器层已经给出了载荷 —— 这不是猜测，是
    用 MSI 自己的元数据验证过的。

    键名与文件名**可能差一个前导下划线**：MSI 的 File 表用 `7zFM.exe`，
    7z 解出来是 `_7zFM.exe`（Windows Installer 用前缀区分同名文件）。
    两种形态都认。
    """
    from ..detect import msi_tables

    files = [item for item in staging.iterdir() if item.is_file()]
    if not files:
        shutil.rmtree(staging, ignore_errors=True)
        attempt.method = f"7z ({seven.path.name})"
        attempt.ok = False
        attempt.detail = "MSI 容器解开后没有任何文件（可能是仅含自定义动作的包）"
        return False

    try:
        mapping = msi_tables.file_mapping(installer)
    except msi_tables.MsiError:
        mapping = []

    if not mapping:
        shutil.rmtree(staging, ignore_errors=True)
        attempt.method = f"7z ({seven.path.name})"
        attempt.ok = False
        attempt.detail = (
            f"MSI 容器解开 {len(files)} 个文件，但 File 表无法解析，"
            "无法还原文件名与目录结构")
        return False

    present = {item.name for item in files}
    matched = [item for item in mapping
               if item["file_key"] in present
               or f"_{item['file_key']}" in present
               or item["filename"] in present]
    if len(matched) < len(mapping) * 0.5:
        shutil.rmtree(staging, ignore_errors=True)
        attempt.method = f"7z ({seven.path.name})"
        attempt.ok = False
        attempt.detail = (
            f"MSI 容器解开 {len(files)} 个文件，"
            f"但与 File 表只对上 {len(matched)}/{len(mapping)} 项，"
            "无法确认这些就是载荷")
        return False

    # 按 File 表把文件搬到真实路径
    by_key = {}
    for item in mapping:
        for key in (item["file_key"], f"_{item['file_key']}", item["filename"]):
            by_key.setdefault(key, item)

    moved = 0
    for item in files:
        record = by_key.get(item.name)
        if record is None:
            continue
        target = out_dir / "files" / record["relpath"]
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            target.unlink()
        shutil.move(str(item), str(target))
        moved += 1

    shutil.rmtree(staging, ignore_errors=True)

    attempt.method = f"7z ({seven.path.name})"
    attempt.ok = True
    attempt.detail = (f"解包完成：容器内直接展开 {moved} 个文件，"
                      f"按 File 表还原目录结构")
    return True


# --------------------------------------------------------------------------
# 对外入口
# --------------------------------------------------------------------------


def extract(installer: Path, out_dir: Path, *, kind: InstallerKind | None = None,
            product_name: str | None = None) -> ExtractReport:
    """把安装包静态解到 out_dir，返回完整报告。

    不做任何写入原包的举动；所有产物都在 out_dir 下。
    """
    installer = Path(installer).expanduser().resolve()
    if not installer.is_file():
        raise UsageError(f"文件不存在：{installer}")
    out_dir = Path(out_dir).expanduser().resolve()

    if kind is None:
        from ..detect import detect_installer
        kind = detect_installer(installer).kind

    if kind not in STATIC_EXTRACTABLE:
        raise UnsupportedSoftware(
            f"{kind} 不支持静态解包",
            hint="阶段 2 会用静默安装代替；现在可先执行 wepack detect 看识别结果",
        )

    _prepare_out_dir(out_dir)
    report = ExtractReport()

    if kind is InstallerKind.NSIS:
        attempt = ExtractAttempt(method="", ok=False)
        _seven_zip_extract(installer, out_dir, attempt)
        report.attempts.append(attempt)

    elif kind is InstallerKind.INNO:
        attempt = ExtractAttempt(method="", ok=False)
        if not _inno_extract(installer, out_dir, attempt):
            report.attempts.append(attempt)
            # 7z 对 Inno 只切 PE 容器，拿不到载荷。仍然试一次是为了覆盖
            # 「Inno 外壳 + 7z 能认的附加压缩包」这种复合包，失败是正常的。
            fallback = ExtractAttempt(method="", ok=False)
            _seven_zip_extract(installer, out_dir, fallback)
            report.attempts.append(fallback)
        else:
            report.attempts.append(attempt)

    elif kind is InstallerKind.MSI:
        attempt = ExtractAttempt(method="", ok=False)
        _msi_extract(installer, out_dir, attempt)
        report.attempts.append(attempt)
        if attempt.ok and "7z" in attempt.method:
            report.warnings.append(
                "未安装 msiextract，已用 7z + MSI 表解析还原：文件名与目录已按 "
                "File/Directory 表还原，但 MSI 的组件安装顺序、自定义动作未执行。"
                "如需完整目录语义，建议 brew install msitools")

    if not any(a.ok for a in report.attempts):
        # 全部失败：清掉本次产生的半成品，保持输出目录干净
        for child in out_dir.iterdir():
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink(missing_ok=True)
        detail = "；".join(f"{a.method or '未知方法'}: {a.detail}"
                          for a in report.attempts)
        hint = detail or "所有解包方法均未成功"

        # ## 先看容器本身有没有结构问题
        #
        # 解包失败时各个工具只会给「返回码 2」这类信息，看不出根因。
        # 而 MSI 的容器结构在识别阶段就能验：文件被截断时 7z 也会失败，
        # 用户拿到「返回码 2」只会去查 7z 装得对不对 —— 实测截断 47% 的
        # 真实 MSI 就是这个症状。这里主动验一次，把真实原因放到最前面。
        #
        # ## 为什么这里用 UsageError 而不是 MissingDependency
        #
        # 两者退出码不同：UsageError=2、MissingDependency=5（EOM_2001「缺
        # Wine 运行时」）。文件截断没有任何依赖可装，报 5 会让脚本判定
        # 「环境缺工具」并去跑 brew install —— 装完再试还是失败。
        # 它的性质与「文件不存在」相同：输入不可用，属于用法/输入问题。
        # 沿用退出码 2，不新增错误码（退出码是对外契约）。
        truncated = _cfb_truncation_reason(installer)
        if truncated:
            raise UsageError(
                f"解包失败：{installer.name} —— 安装包文件不完整",
                hint=f"{truncated}\n（各解包工具的输出：{hint}）",
            )

        if kind is InstallerKind.INNO:
            # Inno 没有 Python 纯实现可用，innoextract 是唯一可靠路径。
            # 不给这句提示，用户只会看到「解包失败」而不知道该装什么。
            # 「未安装」和「版本过旧」是两种不同处境，建议也不同，别混成一句。
            stale = any("版本过旧" in a.detail for a in report.attempts)
            if stale:
                hint += ("\ninnoextract 已安装但版本过旧，升到最新版再试："
                         "brew upgrade innoextract（上游 1.9 只支持到 Inno 6.0.5）")
            else:
                hint += ("\nInno Setup 安装包需要 innoextract 才能静态解包："
                         "brew install innoextract。")
            hint += ("\n静态解包只是可选步骤——直接跑 wepack install 会走 "
                     "Wine 静默安装，同样能生成 .app")
        raise MissingDependency(
            f"解包失败：{installer.name}",
            hint=hint,
        )

    file_count, total_bytes = _count_tree(out_dir)
    ranked = candidates_mod.rank_candidates(out_dir, product_name=product_name, limit=5)

    report.result = ExtractResult(
        root=out_dir, kind=kind, file_count=file_count,
        total_bytes=total_bytes, candidates=ranked,
        shortcut_entry=(_msi_shortcut_entry(installer, out_dir)
                        if kind is InstallerKind.MSI else ""),
    )
    return report


def _cfb_truncation_reason(installer: Path) -> str:
    """安装包是 CFB 容器时，检查它是否被截断。返回可读原因，无问题返回空串。

    只在解包已经失败之后才调用 —— 目的是把「工具返回码 2」翻译成用户
    能据此行动的话（重下文件）。不参与解包决策，也不对非 CFB 文件做任何事。
    """
    from ..detect import cfb

    if not cfb.is_cfb(installer):
        return ""
    try:
        cfb.open_cfb(installer)
    except cfb.CfbTruncatedError as exc:
        return f"{exc}"
    except cfb.CfbError as exc:
        return f"OLE 复合文档结构异常：{exc}"
    return ""


def _msi_shortcut_entry(installer: Path, out_dir: Path) -> str:
    """从 MSI 的 Shortcut 表取出作者声明的启动目标。

    返回相对 out_dir 的路径，取不到返回空串。

    只接受能落到实处的目标：Shortcut 里也常有指向 `.chm` / `.txt` 的
    条目（7-Zip 就有「7-Zip Help」指向帮助文件），那些不是启动入口。
    用「文件存在 + MZ 头」两条把它筛掉 —— 光看扩展名不够，MSI 里
    文件名可能没有后缀。
    """
    from ..detect import msi_tables

    try:
        targets = msi_tables.shortcut_targets(installer)
    except (msi_tables.MsiError, OSError):
        return ""

    for item in targets:
        relative = item["relpath"]
        candidate = out_dir / "files" / relative
        if not candidate.is_file():
            continue
        try:
            with candidate.open("rb") as handle:
                if handle.read(2) != b"MZ":
                    continue
        except OSError:
            continue
        return f"files/{relative}"
    return ""


def find_candidates(root: Path, *, limit: int = 5,
                    product_name: str | None = None) -> list:
    """在已解包目录里找主 exe 候选。"""
    return candidates_mod.rank_candidates(root, product_name=product_name, limit=limit)


__all__ = ["extract", "find_candidates", "ExtractReport", "ExtractAttempt"]