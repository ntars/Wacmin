"""OLE 复合文档（Compound File Binary，即 CFB / OLE2）最小解析器。

MSI 文件本质是一个 CFB 容器，里面以"命名流"形式存着各个表：
  _Tables / _StringPool / _StringData / _Columns / _Validation …
Windows Installer 判定看是否存在 `Windows Installer` 这个流的名字，
SummaryInformation 里还有 Title / Subject / Author 等可读元数据。

只实现读：列目录项、按名字取流内容。不写、不建、不压缩。
结构参考 [MS-CFB]。所有偏移读取带边界检查，异常统一抛 CfbError。
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from pathlib import Path

MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

FREESECT = 0xFFFFFFFF
ENDOFCHAIN = 0xFFFFFFFE
FATSECT = 0xFFFFFFFD
DIFSECT = 0xFFFFFFFC

TYPE_EMPTY = 0
TYPE_STORAGE = 1
TYPE_STREAM = 2
TYPE_ROOT = 5

MAXREGSECT = 0xFFFFFFFA

#: 特殊扇区值的可读名字。用于报错 —— 只印 `0xfffffffd` 时，读的人
#: 得先背下 [MS-CFB] 的常量表才知道它是什么意思。
SECTOR_NAMES = {
    FREESECT: "FREESECT(空闲)",
    ENDOFCHAIN: "ENDOFCHAIN(链尾)",
    FATSECT: "FATSECT(该扇区存放 FAT 表本身)",
    DIFSECT: "DIFSECT(该扇区存放 DIFAT)",
}


class CfbError(Exception):
    """不是 CFB，或结构损坏。"""


class CfbTruncatedError(CfbError):
    """文件被截断 —— 容器头完好，但字节数不足以覆盖声明的扇区。

    单独设一个类型，是因为它和「结构真的坏了」的处理方式完全不同：
    前者重下文件即可，后者才需要查解析器。早先两者都抛 CfbError，
    报错还统一是「非法扇区号」—— 实测一次下载中断（109 MB 的包只
    拿到 13 MB）就足以让 detect 输出该信息，把排查方向引到 CFB 规范
    上去。错误信息必须能区分「数据不全」和「代码有错」。
    """


@dataclass(slots=True)
class DirEntry:
    name: str
    entry_type: int
    start_sector: int
    size: int
    left: int
    right: int
    child: int
    clsid: bytes = b"\0" * 16

    @property
    def is_stream(self) -> bool:
        return self.entry_type == TYPE_STREAM

    @property
    def is_storage(self) -> bool:
        return self.entry_type == TYPE_STORAGE


@dataclass(slots=True)
class CfbFile:
    path: Path
    sector_size: int
    mini_sector_size: int
    entries: list[DirEntry] = field(default_factory=list)
    _data: bytes = b""
    _fat: list[int] = field(default_factory=list)
    _minifat: list[int] = field(default_factory=list)
    _mini_stream: bytes = b""
    _cutoff: int = 4096
    #: 头部声明的扇区总数（num_fat × 每 FAT 扇区项数 只是上界；这里用
    #: 「文件应当有多大」来反推，仅用于截断诊断的措辞）
    _declared_sectors: int = 0

    # -- 目录 ---------------------------------------------------------

    def stream_names(self) -> list[str]:
        return [e.name for e in self.entries if e.is_stream]

    def root(self) -> DirEntry | None:
        for e in self.entries:
            if e.entry_type == TYPE_ROOT:
                return e
        return None

    def root_clsid(self) -> str:
        """根存储的 CLSID，形如 000c1084-0000-0000-c000-000000000046。

        MSI 的根存储固定为 {000C1084-0000-0000-C000-000000000046}
        （Windows Installer 数据库）。这是判定 MSI 最可靠的结构依据 ——
        MSI 的表名在容器里是 MSI 专用编码，不能按普通字符串读。
        """
        root = self.root()
        if root is None or len(root.clsid) != 16 or root.clsid == b"\0" * 16:
            return ""
        raw = root.clsid
        # CFB 里 CLSID 按 little-endian 存前三个字段
        return (f"{raw[3]:02x}{raw[2]:02x}{raw[1]:02x}{raw[0]:02x}-"
                f"{raw[5]:02x}{raw[4]:02x}-"
                f"{raw[7]:02x}{raw[6]:02x}-"
                f"{raw[8]:02x}{raw[9]:02x}-"
                f"{raw[10]:02x}{raw[11]:02x}{raw[12]:02x}{raw[13]:02x}"
                f"{raw[14]:02x}{raw[15]:02x}")

    def find(self, name: str) -> DirEntry | None:
        """按名字找流。

        CFB 规定内置流的名字前带一个保留控制字符（\x05），例如
        `\x05SummaryInformation`、`\x05DocumentSummaryInformation`。
        MSI 的表流则常带 `!` 前缀（`!File`、`!_StringPool`）。
        比较时剥掉这些前缀，调用方不需要关心这个细节。
        """
        target = name.lstrip("!").lower()
        for e in self.entries:
            if not e.is_stream:
                continue
            normalized = e.name.lstrip("\x01\x02\x03\x04\x05\x06\x07\x08").lstrip("!").lower()
            if normalized == target or e.name.lower() == name.lower():
                return e
        return None

    def has_stream(self, name: str) -> bool:
        return self.find(name) is not None

    # -- 读取 ---------------------------------------------------------

    def read_stream(self, name: str) -> bytes:
        entry = self.find(name)
        if entry is None:
            raise CfbError(f"流不存在：{name}")
        return self.read_entry(entry)

    def read_entry(self, entry: DirEntry) -> bytes:
        if entry.size == 0:
            return b""
        # 小于阈值的流存放在 mini stream 里
        if entry.size < self._mini_cutoff():
            return self._read_mini(entry)
        return self._read_chain(entry.start_sector, entry.size)

    def _mini_cutoff(self) -> int:
        return self._cutoff

    def _sector(self, index: int) -> bytes:
        if index > MAXREGSECT:
            # ## 特殊值不等于「文件坏了」
            #
            # FATSECT / DIFSECT / ENDOFCHAIN / FREESECT 在 CFB 里都是合法
            # 标记，只是**不能当作数据扇区号来寻址**。它们出现在「该给
            # 扇区号」的位置，说明上一步的链走得不对：
            #   - 文件被截断 → FAT 没读全 → 链读到错位 → 撞上特殊值
            #   - 文件真损坏 / 解析器有 bug → 同样的症状
            # 所以这里区分「文件长度不足以覆盖声明的扇区数」（截断，
            # 重下即可）与其余情况（结构可疑，需要查）。
            name = SECTOR_NAMES.get(index, "未知特殊值")
            if self._truncated_at(index):
                raise CfbTruncatedError(
                    f"文件被截断：扇区号 {name} 指向 0x{index:08x}，"
                    f"但文件只有 {len(self._data):,} 字节"
                    f"（{self._sector_count():,} 个扇区），"
                    f"不足以覆盖声明的 {self._declared_sectors:,} 个扇区。"
                    f"请确认下载完整。")
            raise CfbError(
                f"扇区号 {name} 不能当作数据扇区寻址："
                f"FAT 链在此处走到了特殊标记，通常是 FAT 表读取错位。")
        start = (index + 1) * self.sector_size
        end = start + self.sector_size
        if end > len(self._data):
            # 文件尾部可能不足一个完整扇区，补齐
            chunk = self._data[start:]
            return chunk + b"\0" * (self.sector_size - len(chunk))
        return self._data[start:end]

    def _sector_count(self) -> int:
        """文件里实际可用的扇区数（不含 512 字节头）。"""
        return max(0, (len(self._data) - 512) // self.sector_size)

    def _truncated_at(self, index: int) -> bool:
        """该扇区号是否落在「文件声明有、实际没有」的区间里。

        两个判据任一成立即认为是截断：
          1. 扇区号超出文件实际扇区数
          2. 字节长度不是扇区大小的整数倍（截断在扇区中间）
        """
        if len(self._data) % self.sector_size != 0:
            # 头 512 字节 + N 个整扇区才是完整的；除不尽就是断在半路
            if (len(self._data) - 512) % self.sector_size != 0:
                return True
        return index >= self._sector_count()

    def _read_chain(self, start: int, size: int) -> bytes:
        parts: list[bytes] = []
        seen: set[int] = set()
        current = start
        while current not in (ENDOFCHAIN, FREESECT) and len(parts) * self.sector_size < size:
            if current in seen:
                raise CfbError("FAT 链成环")
            seen.add(current)
            parts.append(self._sector(current))
            if current >= len(self._fat):
                # ## 这里原本是静默 break
                #
                # FAT 表没读出这一项，意味着链无法继续。早先直接 break，
                # 把「数据不全」伪装成「流就这么长」—— 调用方拿到短一截
                # 的字节还以为读成功了。目录链尤其致命：目录项被截断后，
                # 后面的流全部「凭空消失」，而没有任何一处报错。
                raise CfbTruncatedError(
                    f"FAT 表只覆盖 {len(self._fat):,} 个扇区，"
                    f"但链需要第 {current:,} 项。文件可能被截断。")
            current = self._fat[current]
        return b"".join(parts)[:size]

    def _read_mini(self, entry: DirEntry) -> bytes:
        parts: list[bytes] = []
        seen: set[int] = set()
        current = entry.start_sector
        while current not in (ENDOFCHAIN, FREESECT) and len(parts) * self.mini_sector_size < entry.size:
            if current in seen:
                raise CfbError("MiniFAT 链成环")
            seen.add(current)
            offset = current * self.mini_sector_size
            parts.append(self._mini_stream[offset:offset + self.mini_sector_size])
            if current >= len(self._minifat):
                break
            current = self._minifat[current]
        return b"".join(parts)[:entry.size]


def is_cfb(path: Path) -> bool:
    """只看前 8 字节，不解析。用于快速分流。"""
    try:
        with open(path, "rb") as fh:
            return fh.read(8) == MAGIC
    except OSError:
        return False


#: CFB 头部固定 512 字节（[MS-CFB] 2.2）。短于它就连扇区大小指数都读不到。
HEADER_SIZE = 512


def open_cfb(path: Path) -> CfbFile:
    """解析 CFB 结构，返回可读对象。

    ## 「头不对」与「文件不全」必须分开报（2026-11-22 实测）

    早先两个条件合在一个 `if` 里：

        if len(data) < 512 or data[:8] != MAGIC:
            raise CfbError("不是 OLE 复合文档")

    实测：写 `MAGIC + b"\\0"*92`（共 100 字节，magic **完全正确**）进去，
    报的却是「不是 OLE 复合文档」。对 MSI 而言这是最误导人的一句 ——
    用户会以为「下载到的不是 msi」，从而去换来源重下，而真实原因是这个
    文件只下了一部分。`detect._detect_msi` 的前置守卫同样是
    `if head[:8] != cfb.MAGIC: return None`，能走到这里就一定以 magic 开头。

    所以这里拆成两条：先判长度（被截断，抛 `CfbTruncatedError`），
    再判 magic（真不是 CFB，抛 `CfbError`）。前者调用方按精确类型能分辨，
    后者不能 —— 混在一个类型里，上层就没法给出「请重下」这种提示。
    """
    path = Path(path)
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise CfbError(f"无法读取 {path}：{exc}") from exc

    if len(data) < HEADER_SIZE:
        raise CfbTruncatedError(
            f"文件被截断：{len(data)} 字节，CFB 头固定 {HEADER_SIZE} 字节 —— "
            f"文件可能未下载完或被截断")
    if data[:8] != MAGIC:
        raise CfbError(f"不是 OLE 复合文档：前 8 字节为 {data[:8].hex()}")

    sector_shift = struct.unpack_from("<H", data, 30)[0]
    mini_shift = struct.unpack_from("<H", data, 32)[0]
    if sector_shift not in (9, 12):
        raise CfbError(f"不支持的扇区大小指数：{sector_shift}")
    sector_size = 1 << sector_shift
    mini_size = 1 << mini_shift if mini_shift else 64

    num_fat = struct.unpack_from("<I", data, 44)[0]
    first_dir = struct.unpack_from("<I", data, 48)[0]
    cutoff = struct.unpack_from("<I", data, 56)[0]
    first_minifat = struct.unpack_from("<I", data, 60)[0]
    num_minifat = struct.unpack_from("<I", data, 64)[0]
    first_difat = struct.unpack_from("<I", data, 68)[0]
    num_difat = struct.unpack_from("<I", data, 72)[0]

    cfb = CfbFile(path=path, sector_size=sector_size, mini_sector_size=mini_size,
                  _data=data)
    cfb._cutoff = cutoff or 4096
    # FAT 的项数就是「最多能寻址多少个扇区」，用作声明值的上界估计，
    # 只影响截断报错的措辞，不参与解析决策。
    cfb._declared_sectors = max(num_fat, 1) * (sector_size // 4)

    # -- DIFAT：先取头 109 项，再顺着 DIFAT 扇区链继续 ----------------
    fat_sectors: list[int] = []
    for i in range(109):
        value = struct.unpack_from("<I", data, 76 + i * 4)[0]
        if value == FREESECT:
            break
        fat_sectors.append(value)

    difat = first_difat
    guard = 0
    per_sector = sector_size // 4 - 1
    while difat not in (ENDOFCHAIN, FREESECT) and guard < num_difat + 8:
        sector = cfb._sector(difat)
        for i in range(per_sector):
            value = struct.unpack_from("<I", sector, i * 4)[0]
            if value == FREESECT:
                continue
            fat_sectors.append(value)
        difat = struct.unpack_from("<I", sector, per_sector * 4)[0]
        guard += 1

    # -- FAT ----------------------------------------------------------
    # ## 越界的 FAT 扇区必须在读之前就判定为截断
    #
    # `_sector()` 对「起点超出文件尾」的请求会补零返回（那是为了容忍
    # 最后一个不完整扇区）。可 FAT 扇区越界时补零的后果不是「少几个
    # 字节」：整张 FAT 表读出来全是 0，于是每一项都指向扇区 0，链在
    # 0 → 0 之间打转，最终报 `FAT 链成环`。
    #
    # 那个报错会把人引去查环检测代码，而环检测本身是对的。真实原因
    # 是文件不够长。所以这里先检查，别让补零把截断伪装成结构错误。
    actual_sectors = cfb._sector_count()
    for sector_index in fat_sectors[:max(num_fat, len(fat_sectors))]:
        if sector_index >= actual_sectors:
            raise CfbTruncatedError(
                f"文件被截断：FAT 表声明要用第 {sector_index:,} 号扇区，"
                f"但文件只有 {len(data):,} 字节（{actual_sectors:,} 个扇区，"
                f"扇区大小 {sector_size}）。请确认下载完整。")

    fat: list[int] = []
    for sector_index in fat_sectors[:max(num_fat, len(fat_sectors))]:
        sector = cfb._sector(sector_index)
        count = sector_size // 4
        fat.extend(struct.unpack_from(f"<{count}I", sector, 0))
    cfb._fat = fat

    # -- MiniFAT ------------------------------------------------------
    minifat: list[int] = []
    if first_minifat not in (ENDOFCHAIN, FREESECT):
        raw = cfb._read_chain(first_minifat, num_minifat * sector_size)
        count = len(raw) // 4
        minifat = list(struct.unpack_from(f"<{count}I", raw, 0))
    cfb._minifat = minifat

    # -- 目录项 -------------------------------------------------------
    dir_raw = cfb._read_chain(first_dir, 0x7FFFFFFF)
    entries: list[DirEntry] = []
    for offset in range(0, len(dir_raw) - 127, 128):
        chunk = dir_raw[offset:offset + 128]
        name_len = struct.unpack_from("<H", chunk, 64)[0]
        entry_type = chunk[66]
        if entry_type == TYPE_EMPTY or name_len < 2 or name_len > 64:
            continue
        raw_name = chunk[:name_len - 2]
        try:
            name = raw_name.decode("utf-16-le", "replace")
        except UnicodeDecodeError:
            continue
        left, right, child = struct.unpack_from("<III", chunk, 68)
        clsid = chunk[80:96]
        start, size_lo, size_hi = struct.unpack_from("<III", chunk, 116)
        size = size_lo if sector_size == 512 else (size_lo | (size_hi << 32))
        entries.append(DirEntry(name=name, entry_type=entry_type,
                                start_sector=start, size=size,
                                left=left, right=right, child=child,
                                clsid=clsid))
    cfb.entries = entries

    # -- mini stream：根目录项指向的普通流 ------------------------------
    root = next((e for e in entries if e.entry_type == TYPE_ROOT), None)
    if root is not None and root.size > 0:
        cfb._mini_stream = cfb._read_chain(root.start_sector, root.size)

    return cfb


def summary_information(path: Path) -> dict[str, str]:
    """读 SummaryInformation 流的属性集，返回可读的元数据。

    只处理 VT_LPSTR(0x1E) / VT_LPWSTR(0x1F) 两种字符串属性，其余跳过。
    属性 ID 与含义见 [MS-OLEPS] 的 Property ID 定义。

    ## 字符串按 Codepage 解码，不是 latin-1

    VT_LPSTR 存的是**单字节串**，具体编码由同一属性集里的 PID 1
    （Codepage）指定。硬编码 latin-1 时，英文 MSI 看起来正常，任何
    非西欧语言的包都会整片乱码——标题变成 `²úÆ·`，作者变成 `????????`，
    而 `revision`/`application` 这类纯 ASCII 字段仍然正确，很容易被
    误判成「这个包本来就没写标题」。

    实测 wine 的 126d.msi：PID 1 = 1252。中文 MSI 一般是 936。
    Codepage 缺失时才退回 latin-1（此时字节与码位一一对应，不会抛异常）。
    """
    known = {
        2: "title", 3: "subject", 4: "author", 5: "keywords",
        6: "comments", 7: "template", 8: "last_saved_by",
        9: "revision", 18: "application", 19: "doc_security",
    }
    try:
        cfb = open_cfb(path)
        entry = cfb.find("SummaryInformation")
        if entry is None:
            return {}
        raw = cfb.read_entry(entry)
    except (CfbError, OSError):
        return {}

    if len(raw) < 48:
        return {}
    try:
        # Header: byteOrder(2) version(2) systemId(4) clsid(16) numSets(4) fmtid(16) offset(4)
        section_offset = struct.unpack_from("<I", raw, 44)[0]
        if section_offset + 8 > len(raw):
            return {}
        num_props = struct.unpack_from("<I", raw, section_offset + 4)[0]
        if num_props > 512:
            return {}
    except struct.error:
        return {}

    # 先扫一遍拿到 Codepage（PID 1，VT_I2：2 字节有符号），再解字符串
    encoding = "latin-1"
    for i in range(num_props):
        entry_off = section_offset + 8 + i * 8
        if entry_off + 8 > len(raw):
            break
        prop_id, prop_off = struct.unpack_from("<II", raw, entry_off)
        if prop_id != 1:
            continue
        abs_off = section_offset + prop_off
        if abs_off + 6 > len(raw):
            break
        if struct.unpack_from("<I", raw, abs_off)[0] != 0x02:
            break
        codepage = struct.unpack_from("<h", raw, abs_off + 4)[0]
        encoding = codepage_to_encoding(codepage)
        break

    result: dict[str, str] = {}
    for i in range(num_props):
        entry_off = section_offset + 8 + i * 8
        if entry_off + 8 > len(raw):
            break
        prop_id, prop_off = struct.unpack_from("<II", raw, entry_off)
        abs_off = section_offset + prop_off
        if abs_off + 4 > len(raw):
            continue
        try:
            vtype = struct.unpack_from("<I", raw, abs_off)[0]
        except struct.error:
            continue
        key = known.get(prop_id)
        if key is None:
            continue
        if vtype == 0x1E:      # VT_LPSTR：4 字节长度 + 字节串（含结尾 0）
            length = struct.unpack_from("<I", raw, abs_off + 4)[0]
            text = raw[abs_off + 8:abs_off + 8 + max(0, length - 1)]
            result[key] = text.decode(encoding, "replace").strip("\0")
        elif vtype == 0x1F:    # VT_LPWSTR：4 字节字符数 + UTF-16
            count = struct.unpack_from("<I", raw, abs_off + 4)[0]
            byte_len = max(0, count - 1) * 2
            text = raw[abs_off + 8:abs_off + 8 + byte_len]
            result[key] = text.decode("utf-16-le", "replace").strip("\0")
    return result


def read_codepage(doc: CfbFile) -> int:
    """从已打开的 CFB 里读 SummaryInformation 的 Codepage（PID 1）。

    读不到时返回 0，调用方据此退回 latin-1 降级。单独抽出来是因为
    `msi_tables` 已经持有 `CfbFile` 对象，没必要为了一个整数再开一次
    文件。
    """
    entry = doc.find("SummaryInformation")
    if entry is None:
        return 0
    try:
        raw = doc.read_entry(entry)
    except CfbError:
        return 0
    if len(raw) < 48:
        return 0
    try:
        section_offset = struct.unpack_from("<I", raw, 44)[0]
        if section_offset + 8 > len(raw):
            return 0
        num_props = struct.unpack_from("<I", raw, section_offset + 4)[0]
        if num_props > 512:
            return 0
        for i in range(num_props):
            entry_off = section_offset + 8 + i * 8
            if entry_off + 8 > len(raw):
                break
            prop_id, prop_off = struct.unpack_from("<II", raw, entry_off)
            if prop_id != 1:
                continue
            abs_off = section_offset + prop_off
            if abs_off + 6 > len(raw):
                return 0
            if struct.unpack_from("<I", raw, abs_off)[0] != 0x02:
                return 0
            return struct.unpack_from("<h", raw, abs_off + 4)[0]
    except struct.error:
        return 0
    return 0


def codepage_to_encoding(codepage: int) -> str:
    """把 Windows Codepage 转成 Python 的编码名。

    只映射实际会遇到的几个。65001 是 UTF-8（此时 VT_LPSTR 里其实是
    UTF-8 字节），1200 是 UTF-16LE。未知值退回 latin-1 —— 单字节一一
    对应，不会抛异常也不会丢字节，比猜错编码安全。

    ## 为什么不用 `cp{codepage}` 硬拼

    `cp{936}` 在 Python 里确实存在，但不是所有编号都有对应 codec，
    未知编号会抛 LookupError，把整个元数据读取变成异常路径。这里显式
    白名单，未知就退，行为可预测。
    """
    mapping = {
        65001: "utf-8",
        1200: "utf-16-le",
        1201: "utf-16-be",
        28591: "latin-1",
        1252: "cp1252",
        936: "gbk",        # 简体中文
        950: "cp950",      # 繁体中文
        932: "cp932",      # 日文
        949: "cp949",      # 韩文
        1251: "cp1251",    # 西里尔
    }
    return mapping.get(codepage, "latin-1")
