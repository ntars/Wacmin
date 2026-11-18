"""安装器识别。

判定顺序固定（先命中先返回，见 detect/__init__ 的文档）。每个判定都返回
证据链（evidence），让用户能看出为什么判成这个类型 —— 判错时才有得查。

原则：
  - 只读，不改原安装包。
  - 每个判定都必须有可复现的字节级依据，不靠文件名猜。
  - 置信度是给人看的相对值，不是概率。低于 0.6 时上层应提示复核。
"""

from __future__ import annotations

from pathlib import Path

from .. import pe
from ..errors import UsageError
from ..models import STATIC_EXTRACTABLE, Detection, InstallerKind
from . import cfb

# 只读前 8 MB 做字符串扫描：安装器桩都在这段内，再往后是压缩载荷
SCAN_LIMIT = 8 * 1024 * 1024


def _read_head(path: Path, limit: int = SCAN_LIMIT) -> bytes:
    try:
        with open(path, "rb") as fh:
            return fh.read(limit)
    except OSError as exc:
        raise UsageError(f"无法读取安装包：{exc}") from exc


def _find_ascii(haystack: bytes, needle: bytes) -> int:
    return haystack.find(needle)


def _find_utf16(haystack: bytes, needle: bytes) -> int:
    return haystack.find(needle.decode("latin-1").encode("utf-16-le"))


def _hit(haystack: bytes, text: str) -> bool:
    """同时检查 ASCII 与 UTF-16LE 两种编码。"""
    needle = text.encode("latin-1", "ignore")
    if not needle:
        return False
    return haystack.find(needle) >= 0 or _find_utf16(haystack, needle) >= 0


# --------------------------------------------------------------------------
# MSI / Burn
# --------------------------------------------------------------------------


#: MSI 数据库根存储的 CLSID（Windows Installer 数据库）。
#: 这是判定 MSI 最硬的结构依据 —— MSI 的表名在 CFB 容器里是 MSI 专用编码，
#: 不能按普通字符串读，所以只能靠 CLSID。
MSI_ROOT_CLSID = "000c1084-0000-0000-c000-000000000046"


def _detect_msi(path: Path, head: bytes) -> Detection | None:
    """MSI：CFB 容器，且根存储 CLSID 是 Windows Installer 数据库。"""
    if head[:8] != cfb.MAGIC:
        return None

    evidence: list[str] = ["OLE 复合文档头 D0CF11E0A1B11AE1"]
    try:
        doc = cfb.open_cfb(path)
    except cfb.CfbError as exc:
        # 是 CFB 但结构坏了：仍然按 MSI 处理，交给解包阶段报错
        evidence.append(f"CFB 解析降级：{exc}")
        return Detection(path=path, kind=InstallerKind.MSI, confidence=0.5,
                         evidence=evidence)

    streams = {s.lstrip("\x01\x02\x03\x04\x05\x06\x07\x08").lower()
               for s in doc.stream_names()}
    meta = cfb.summary_information(path)

    # WiX Burn bundle 也是 MSI，但内部有 WixBundle* 流，先判 Burn
    burn_markers = [s for s in streams if s.startswith("wixbundle")]
    if burn_markers:
        evidence.append(f"存在 Burn 命名流：{burn_markers[0]}")
        return Detection(
            path=path, kind=InstallerKind.BURN, confidence=0.9,
            evidence=evidence,
            product_name=meta.get("subject") or meta.get("title"),
            vendor=meta.get("author"),
        )

    root_clsid = doc.root_clsid()
    if root_clsid == MSI_ROOT_CLSID:
        evidence.append(f"根存储 CLSID = {root_clsid}（Windows Installer 数据库）")
        app = meta.get("application", "")
        if app:
            evidence.append(f"创建工具：{app}")
        template = meta.get("template", "")
        arch = "x86_64" if template.startswith("x64") else (
            "arm64" if "arm64" in template.lower() else "x86")
        if template:
            evidence.append(f"平台模板：{template}")
        return Detection(
            path=path, kind=InstallerKind.MSI, confidence=0.99,
            evidence=evidence, arch=arch,
            product_name=meta.get("subject") or meta.get("title"),
            vendor=meta.get("author"),
        )

    # 是 CFB 但不是 MSI（可能是旧版 InstallShield 的包装或 Office 文档）
    evidence.append(f"根存储 CLSID = {root_clsid or '空'}，不是 Windows Installer 数据库")
    evidence.append(f"CFB 内共 {len(streams)} 个流")
    return Detection(path=path, kind=InstallerKind.UNKNOWN, confidence=0.2,
                     evidence=evidence,
                     unsupported_reason="CFB 容器但不是 Windows Installer 数据库")


# --------------------------------------------------------------------------
# PE 类安装器
# --------------------------------------------------------------------------


def _detect_nsis(path: Path, head: bytes, info: pe.PeInfo | None) -> Detection | None:
    """NSIS：overlay 起始是 firstheader，签名 DEADBEEF + "NullsoftInst"。

    firstheader 布局（实测 NSIS 3.x）：
      +0  flags        uint32（0x00000000）
      +4  siginfo      uint32 = 0xDEADBEEF
      +8  signature    12 字节 "NullsoftInst"
      +20 length_of_header uint32
    所以签名在 overlay+4 与 overlay+8，不在 overlay 起点。
    """
    evidence: list[str] = []
    score = 0.0

    if info is not None and info.overlay_offset > 0:
        try:
            with open(path, "rb") as fh:
                fh.seek(info.overlay_offset)
                marker = fh.read(32)
            if marker[4:8] == b"\xef\xbe\xad\xde":
                evidence.append(f"overlay@{info.overlay_offset:#x}+4 命中 DEADBEEF")
                score += 0.45
            if marker[8:20] == b"NullsoftInst":
                evidence.append("overlay+8 命中 NullsoftInst 签名")
                score += 0.45
        except OSError:
            # 读 overlay 失败就少一条证据，不是错误：文件可能被占用或已经
            # 不在。识别会靠其余特征继续打分，够不够由阈值判定。
            pass

    # 节区 .ndata：NSIS 专用未初始化数据段，几乎只有 NSIS 会生成
    if info is not None and pe.section_named(info, ".ndata") is not None:
        evidence.append("存在 .ndata 节区（NSIS 特征）")
        score += 0.15

    if _hit(head, "NSIS Error") or _hit(head, "Nullsoft"):
        evidence.append("字符串命中 NSIS Error / Nullsoft")
        score += 0.1

    if score < 0.4:
        return None
    return Detection(path=path, kind=InstallerKind.NSIS, confidence=min(score, 0.99),
                     evidence=evidence)


def _detect_inno(path: Path, head: bytes, info: pe.PeInfo | None) -> Detection | None:
    """Inno Setup：载荷头 "Inno Setup Setup Data (x.y.z)"，或 Setup.e32 存在。

    ## 标记必须同时按 ASCII 与 UTF-16LE 查

    Inno 从 6.x 起默认编 Unicode 版，载荷头里的
    `Inno Setup Setup Data (6.2.2)` 是 **UTF-16LE**，每个字符后面跟一个
    0 字节。只按 ASCII 查时，Unicode 版的包一个特征都命不中 ——
    结果不是「版本号读不到」，而是整个 Inno 类型被判成 unknown，
    于是走 PE 回退路径，把节区当载荷解出来。

    早先这里用裸 `head.find(marker)`，而同一文件的 NSIS 检测用的是
    能兼容两种编码的 `_hit`。这种「同一份代码里两种写法」正是缺陷的
    典型来源：写 NSIS 时想到了 Unicode，写 Inno 时忘了。
    """
    evidence: list[str] = []
    score = 0.0

    marker = b"Inno Setup Setup Data"
    # 两种编码都试：ASCII 版（实测 7.1.1 就是 ASCII）与 UTF-16LE
    idx = _find_ascii(head, marker)
    wide = False
    if idx < 0:
        idx = _find_utf16(head, marker)
        wide = idx >= 0
    if idx >= 0:
        # 后面紧跟 " (6.7.0)" 这样的版本。UTF-16 下每个字符占 2 字节，
        # 所以要按 2 字节步进取，再用 utf-16-le 解。
        tail = head[idx + len(marker) * (2 if wide else 1):][:48]
        if wide:
            decoded = tail.decode("utf-16-le", "replace")
        else:
            decoded = tail.decode("latin-1", "replace")
        version = ""
        stripped = decoded.lstrip()
        if stripped.startswith("("):
            version = stripped[1:].split(")", 1)[0].strip()
        evidence.append(f"载荷头命中 Inno Setup Setup Data @{idx:#x}"
                        + ("（UTF-16LE）" if wide else "")
                        + (f"（版本 {version}）" if version else ""))
        score += 0.7

    if _hit(head, "Inno Setup"):
        evidence.append("字符串命中 Inno Setup")
        score += 0.15

    # Inno 的 stub 通常含 Setup.e32 / SetupLdr 字样
    for text in ("Setup.e32", "SetupLdr", "InnoSetupLdr"):
        if _hit(head, text):
            evidence.append(f"字符串命中 {text}")
            score += 0.1
            break

    # Inno 常见节区名
    if info is not None:
        for name in (".itext", ".idata", ".data"):
            if pe.section_named(info, name) is not None and name == ".itext":
                evidence.append("存在 .itext 节区（Inno 特征）")
                score += 0.15

    if score < 0.4:
        return None
    return Detection(path=path, kind=InstallerKind.INNO, confidence=min(score, 0.99),
                     evidence=evidence)


def _detect_installshield(path: Path, head: bytes,
                          info: pe.PeInfo | None) -> Detection | None:
    """InstallShield：ISSetupStream / _setup.dll / InstallShield 字样。"""
    evidence: list[str] = []
    score = 0.0

    for text in ("ISSetupStream", "_setup.dll", "InstallShield", "InstallShield_PC_Indis"):
        if _hit(head, text):
            evidence.append(f"字符串命中 {text}")
            score += 0.35 if text in ("ISSetupStream", "_setup.dll") else 0.2

    if score < 0.35:
        return None
    return Detection(path=path, kind=InstallerKind.INSTALLSHIELD,
                     confidence=min(score, 0.9), evidence=evidence)


def _detect_squirrel(path: Path, head: bytes,
                     info: pe.PeInfo | None) -> Detection | None:
    """Squirrel（Electron）：Squirrel 字样 + 同目录 .nupkg，或 Update.exe 结构。"""
    evidence: list[str] = []
    score = 0.0

    if _hit(head, "Squirrel"):
        evidence.append("字符串命中 Squirrel")
        score += 0.3
    if _hit(head, "Update.exe"):
        evidence.append("字符串命中 Update.exe（Squirrel 更新器）")
        score += 0.15

    siblings = list(path.parent.glob("*.nupkg"))
    if siblings:
        evidence.append(f"同目录存在 {len(siblings)} 个 .nupkg 包")
        score += 0.35

    if score < 0.5:
        return None
    return Detection(path=path, kind=InstallerKind.SQUIRREL,
                     confidence=min(score, 0.9), evidence=evidence)


# --------------------------------------------------------------------------
# 不支持类别预检（铁律 6）
# --------------------------------------------------------------------------

#: 命中即拒绝的特征。键是给人看的类别名，值是字节级特征。
#:
#: 精度优先：这里的误判会直接封杀一个正常软件，代价远高于漏判。
#: 所以只收高区分度的长签名，不收 "Sentinel" 这种在别的安装器里也会出现的
#: 通用词（实测 Inno Setup 的编译产物里就有 "FSentinel" 之类的字符串）。
BLOCKED_MARKERS: dict[str, tuple[str, ...]] = {
    "反作弊(EasyAntiCheat)": ("EasyAntiCheat", "EasyAntiCheat_EOS"),
    "反作弊(BattlEye)": ("BEClient2", "BEService", "BattlEye"),
    "反作弊(Vanguard)": ("vgk.sys", "Riot Vanguard"),
    "反作弊(nProtect)": ("GameGuard.des", "npggNT.des", "nProtect GameGuard"),
    "反作弊(XignCode3)": ("x3.xem", "XignCode"),
    "硬件狗(Aladdin)": ("hasp_windows_", "hasplms", "haspds_windows", "Hardlock.sys"),
    "硬件狗(SafeNet)": ("sntlkeyssrvr", "SentinelLM", "Sentinel RMS"),
}

#: 内核驱动的判定需要"路径 + 扩展名"同时命中，单看 ".sys" 会误伤
#: （很多正常安装器带 .sys 只是驱动安装的可选项）。
DRIVER_PATH_MARKERS = ("\\system32\\drivers\\", "/system32/drivers/")
DRIVER_SUFFIXES = (".sys",)


def _check_blocked(head: bytes) -> str | None:
    """扫前 8 MB 找明确不支持的标记。返回命中类别名，未命中返回 None。"""
    for category, markers in BLOCKED_MARKERS.items():
        for marker in markers:
            needle = marker.encode("latin-1", "ignore")
            if needle and head.find(needle) >= 0:
                return category

    # 内核驱动：必须同时出现驱动目录与 .sys 文件名
    lowered = head.lower()
    for path_marker in DRIVER_PATH_MARKERS:
        idx = lowered.find(path_marker.encode())
        if idx < 0:
            continue
        window = lowered[idx:idx + 120]
        if any(window.find(suffix.encode()) >= 0 for suffix in DRIVER_SUFFIXES):
            return "内核驱动"
    return None


# --------------------------------------------------------------------------
# 对外入口
# --------------------------------------------------------------------------


def detect_installer(path: Path) -> Detection:
    """识别安装包类型。

    判定顺序：MSI/Burn → NSIS → Inno → InstallShield → Squirrel → unknown。
    顺序不能换：Burn 也是 MSI，NSIS 的字符串也可能出现在其他安装器的资源里，
    所以硬证据（结构签名）先于软证据（字符串）。
    """
    path = Path(path).expanduser().resolve()
    if not path.is_file():
        raise UsageError(f"文件不存在：{path}")

    head = _read_head(path)

    # 铁律 6：先看是不是明确不支持的类别
    blocked = _check_blocked(head)

    info: pe.PeInfo | None = None
    pe_error: str | None = None
    if head[:2] == b"MZ":
        try:
            info = pe.parse(path)
        except pe.PeError as exc:
            pe_error = str(exc)

    detection: Detection | None = None
    for detector in (_detect_msi, _detect_nsis, _detect_inno,
                     _detect_installshield, _detect_squirrel):
        if detector is _detect_msi:
            result = detector(path, head)
        else:
            result = detector(path, head, info)
        if result is not None and result.kind is not InstallerKind.UNKNOWN:
            detection = result
            break

    if detection is None:
        evidence = []
        if pe_error:
            evidence.append(f"PE 解析失败：{pe_error}")
        if info is not None:
            evidence.append(f"PE {info.arch}，overlay {info.overlay_size} 字节")
            evidence.append("未命中任何已知安装器签名")
        else:
            evidence.append("非 PE、非 CFB，无法归类")
        detection = Detection(path=path, kind=InstallerKind.UNKNOWN,
                              confidence=0.0, evidence=evidence,
                              unsupported_reason="无法识别的安装器类型")

    # 补齐 PE 通用信息
    if info is not None:
        detection.arch = detection.arch or info.arch
        if detection.product_name is None:
            try:
                meta = pe.product_metadata(info)
            except pe.PeError:
                meta = {}
            detection.product_name = meta.get("product_name")
            detection.product_version = meta.get("product_version")
            detection.vendor = detection.vendor or meta.get("vendor")

    # 静默参数按 5.1 表填默认值（真正路径参数在阶段 2 拼）
    if detection.silent_args is None:
        detection.silent_args = DEFAULT_SILENT_ARGS.get(detection.kind, "")

    # 不支持类别覆盖
    if blocked:
        detection.unsupported_reason = (
            f"不支持的软件类别：{blocked}。ExeOnMac 不提供内核态/反作弊环境，"
            f"强行运行可能导致账号风险。"
        )
    elif detection.kind is InstallerKind.UNKNOWN and detection.unsupported_reason is None:
        detection.unsupported_reason = "无法识别的安装器类型"

    # 静态解包能力标注（不影响"能否安装"，只影响阶段 1 的 extract）
    if detection.kind not in STATIC_EXTRACTABLE and detection.unsupported_reason is None:
        detection.evidence.append(
            f"{detection.kind} 不支持静态解包，需走阶段 2 的静默安装路径")

    return detection


#: 5.1 静默参数表。{dir} 由阶段 2 替换成实际安装目录。
DEFAULT_SILENT_ARGS: dict[InstallerKind, str] = {
    InstallerKind.NSIS: "/S",
    InstallerKind.INNO: "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART",
    InstallerKind.INSTALLSHIELD: '/s /v" /qn"',
    InstallerKind.MSI: "/qn",
    InstallerKind.BURN: "/quiet /install /norestart",
    InstallerKind.SQUIRREL: "--silent",
    InstallerKind.UNKNOWN: "",
}


__all__ = ["detect_installer", "DEFAULT_SILENT_ARGS", "BLOCKED_MARKERS"]