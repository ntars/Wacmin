"""PE 文件解析（纯标准库）。

单一真源：detect 用它判定安装器类型与架构，extract 用它给主 exe 打分，
layers 用它读导入表，package 用它取图标与版本信息。四处共用这一份实现。

只解析需要的结构，不做完整反汇编：
  - DOS/PE 头、COFF 头、Optional 头（含 DataDirectory）
  - 节区表
  - 资源目录（RT_ICON / RT_GROUP_ICON / RT_VERSION / RT_MANIFEST）
  - 导入表（DLL 名 + 函数名）
  - VS_VERSIONINFO（ProductName / ProductVersion / CompanyName）

所有偏移读取都带边界检查。任何异常统一转 PeError，调用方据此降级，
不让损坏的样本把整个流程炸掉。
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from pathlib import Path

# --------------------------------------------------------------------------
# 常量
# --------------------------------------------------------------------------

MACHINE_NAMES: dict[int, str] = {
    0x014C: "x86",
    0x8664: "x86_64",
    0xAA64: "arm64",
    0x01C0: "arm",
    0x01C4: "armv7",
    0x0200: "ia64",
}

SUBSYSTEM_GUI = 2
SUBSYSTEM_CUI = 3

RT_ICON = 3
RT_GROUP_ICON = 14
RT_VERSION = 16
RT_MANIFEST = 24

DIR_IMPORT = 1
DIR_RESOURCE = 2


class PeError(Exception):
    """PE 结构损坏或不是 PE。"""


# --------------------------------------------------------------------------
# 数据模型
# --------------------------------------------------------------------------


@dataclass(slots=True)
class Section:
    name: str
    virtual_address: int
    virtual_size: int
    raw_offset: int
    raw_size: int
    characteristics: int

    @property
    def executable(self) -> bool:
        return bool(self.characteristics & 0x20000000)

    @property
    def writable(self) -> bool:
        return bool(self.characteristics & 0x80000000)


@dataclass(slots=True)
class ResourceEntry:
    type_id: int
    name_id: int
    lang_id: int
    rva: int
    size: int


@dataclass(slots=True)
class ImportLibrary:
    dll: str
    functions: list[str] = field(default_factory=list)

    @property
    def stem(self) -> str:
        """去掉 .dll 后缀并转小写，便于与层索引比对。"""
        name = self.dll.lower()
        return name[:-4] if name.endswith(".dll") else name


@dataclass(slots=True)
class PeInfo:
    path: Path
    machine: int
    subsystem: int
    sections: list[Section]
    timestamp: int
    checksum: int
    image_base: int
    size_of_image: int
    overlay_offset: int
    """最后一段原始数据之后的位置。NSIS / Inno 的载荷从这里开始。"""
    characteristics: int = 0
    is_dotnet: bool = False

    @property
    def arch(self) -> str:
        return MACHINE_NAMES.get(self.machine, f"unknown(0x{self.machine:04x})")

    @property
    def is_gui(self) -> bool:
        return self.subsystem == SUBSYSTEM_GUI

    @property
    def overlay_size(self) -> int:
        try:
            return max(0, self.path.stat().st_size - self.overlay_offset)
        except OSError:
            return 0


# --------------------------------------------------------------------------
# 基础读取
# --------------------------------------------------------------------------


class _Reader:
    """带边界的随机读取。所有方法越界即抛 PeError。"""

    def __init__(self, path: Path) -> None:
        self.path = path
        try:
            self._fh = open(path, "rb")
            self._fh.seek(0, 2)
            self.size = self._fh.tell()
        except OSError as exc:
            raise PeError(f"无法打开 {path}：{exc}") from exc

    def close(self) -> None:
        try:
            self._fh.close()
        except OSError:
            # close() 是清理动作，重复关闭或句柄已失效都不该让调用方的
            # `with` 块抛出 —— 那会把真正的解析错误盖掉。
            pass

    def __enter__(self) -> "_Reader":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def read(self, offset: int, length: int) -> bytes:
        if offset < 0 or length < 0 or offset + length > self.size:
            raise PeError(f"读取越界：offset={offset} length={length} size={self.size}")
        self._fh.seek(offset)
        data = self._fh.read(length)
        if len(data) != length:
            raise PeError(f"短读：期望 {length} 字节，实际 {len(data)}")
        return data

    def u16(self, offset: int) -> int:
        return struct.unpack("<H", self.read(offset, 2))[0]

    def u32(self, offset: int) -> int:
        return struct.unpack("<I", self.read(offset, 4))[0]

    def u64(self, offset: int) -> int:
        return struct.unpack("<Q", self.read(offset, 8))[0]


# --------------------------------------------------------------------------
# 头部与节区
# --------------------------------------------------------------------------


def parse(path: Path) -> PeInfo:
    """解析 PE 头与节区表。"""
    path = Path(path)
    with _Reader(path) as r:
        if r.size < 0x40 or r.read(0, 2) != b"MZ":
            raise PeError("不是 MZ 可执行文件")

        e_lfanew = r.u32(0x3C)
        if e_lfanew < 0x40 or e_lfanew + 24 > r.size:
            raise PeError(f"e_lfanew 非法：0x{e_lfanew:x}")
        if r.read(e_lfanew, 4) != b"PE\0\0":
            raise PeError("缺少 PE 签名")

        coff = e_lfanew + 4
        machine = r.u16(coff)
        num_sections = r.u16(coff + 2)
        timestamp = r.u32(coff + 4)
        size_opt = r.u16(coff + 16)
        characteristics = r.u16(coff + 18)

        opt = coff + 20
        magic = r.u16(opt)
        if magic == 0x10B:      # PE32
            image_base = r.u32(opt + 28)
            data_dir = opt + 96
        elif magic == 0x20B:    # PE32+
            image_base = r.u64(opt + 24)
            data_dir = opt + 112
        else:
            raise PeError(f"未知 OptionalHeader magic：0x{magic:x}")

        subsystem = r.u16(opt + 68)
        size_of_image = r.u32(opt + 56)
        checksum = r.u32(opt + 64)

        section_table = opt + size_opt
        sections: list[Section] = []
        for i in range(num_sections):
            base = section_table + i * 40
            raw_name = r.read(base, 8)
            name = raw_name.split(b"\0", 1)[0].decode("latin-1", "replace")
            vsize, vaddr, rsize, roff = struct.unpack("<IIII", r.read(base + 8, 16))
            chars = r.u32(base + 36)
            sections.append(Section(name, vaddr, vsize, roff, rsize, chars))

        if not sections:
            raise PeError("节区表为空")

        overlay = max((s.raw_offset + s.raw_size) for s in sections)
        overlay = min(overlay, r.size)

        # .NET 判定：DataDirectory[14] (CLR Runtime Header) 非零
        clr_rva = 0
        if data_dir + 8 * 15 <= r.size:
            clr_rva = r.u32(data_dir + 8 * 14)

        info = PeInfo(
            path=path,
            machine=machine,
            subsystem=subsystem,
            sections=sections,
            timestamp=timestamp,
            checksum=checksum,
            image_base=image_base,
            size_of_image=size_of_image,
            overlay_offset=overlay,
            characteristics=characteristics,
            is_dotnet=clr_rva != 0,
        )
        return info


def rva_to_offset(info: PeInfo, rva: int) -> int:
    """RVA 转文件偏移。落在节区空隙时返回 -1。"""
    for s in info.sections:
        span = max(s.virtual_size, s.raw_size)
        if s.virtual_address <= rva < s.virtual_address + span:
            delta = rva - s.virtual_address
            if delta >= s.raw_size:
                return -1
            return s.raw_offset + delta
    return -1


def section_named(info: PeInfo, name: str) -> Section | None:
    for s in info.sections:
        if s.name == name:
            return s
    return None


# --------------------------------------------------------------------------
# 资源目录
# --------------------------------------------------------------------------


def _walk_resource_dir(r: _Reader, info: PeInfo, dir_off: int, dir_rva: int,
                       level: int, path: list[int], out: list[ResourceEntry]) -> None:
    """递归遍历资源目录树，收集叶子节点。level: 0=Type 1=Name 2=Lang。"""
    if level > 2:
        return
    header = r.read(dir_off, 16)
    named = struct.unpack_from("<H", header, 12)[0]
    ids = struct.unpack_from("<H", header, 14)[0]
    count = named + ids
    if count > 4096:
        raise PeError(f"资源目录条目过多：{count}")

    for i in range(count):
        entry_off = dir_off + 16 + i * 8
        name_field, offset_field = struct.unpack("<II", r.read(entry_off, 8))
        # 高位为 1 表示命名项（指向字符串），这里只关心数字 ID
        if name_field & 0x80000000:
            ident = -1
        else:
            ident = name_field & 0xFFFF

        if offset_field & 0x80000000:
            sub = offset_field & 0x7FFFFFFF
            _walk_resource_dir(r, info, dir_rva + sub, dir_rva, level + 1,
                               path + [ident], out)
        else:
            data_entry_off = dir_rva + (offset_field & 0x7FFFFFFF)
            de = r.read(data_entry_off, 16)
            data_rva, size = struct.unpack_from("<II", de, 0)
            lang = path[2] if len(path) >= 3 else 0
            out.append(ResourceEntry(
                type_id=path[0] if path else -1,
                name_id=path[1] if len(path) > 1 else -1,
                lang_id=lang,
                rva=data_rva,
                size=size,
            ))


def resources(info: PeInfo) -> list[ResourceEntry]:
    """返回全部资源叶子节点。无资源表时返回空列表。"""
    with _Reader(info.path) as r:
        e_lfanew = r.u32(0x3C)
        opt = e_lfanew + 24
        magic = r.u16(opt)
        data_dir = opt + (96 if magic == 0x10B else 112)
        res_rva = r.u32(data_dir + 8 * DIR_RESOURCE)
        if res_rva == 0:
            return []
        res_off = rva_to_offset(info, res_rva)
        if res_off < 0:
            return []
        out: list[ResourceEntry] = []
        try:
            _walk_resource_dir(r, info, res_off, res_off, 0, [], out)
        except PeError:
            # 资源目录损坏时降级为"没有资源"，不阻断上层
            return out
        return out


def resource_bytes(info: PeInfo, entry: ResourceEntry) -> bytes:
    """读出某个资源叶子的原始字节。"""
    off = rva_to_offset(info, entry.rva)
    if off < 0:
        raise PeError(f"资源 RVA 无法映射：0x{entry.rva:x}")
    with _Reader(info.path) as r:
        return r.read(off, entry.size)


# --------------------------------------------------------------------------
# 导入表
# --------------------------------------------------------------------------


def imports(info: PeInfo) -> list[ImportLibrary]:
    """解析导入表。返回按出现顺序排列的 DLL 与函数名。

    只读 INT/IAT 的 thunk 名字；序号导入记为 "#<ordinal>"。
    """
    with _Reader(info.path) as r:
        e_lfanew = r.u32(0x3C)
        opt = e_lfanew + 24
        magic = r.u16(opt)
        is_pe32_plus = magic == 0x20B
        data_dir = opt + (96 if magic == 0x10B else 112)
        imp_rva = r.u32(data_dir + 8 * DIR_IMPORT)
        if imp_rva == 0:
            return []
        imp_off = rva_to_offset(info, imp_rva)
        if imp_off < 0:
            return []

        result: list[ImportLibrary] = []
        thunk_size = 8 if is_pe32_plus else 4
        ordinal_flag = 1 << (63 if is_pe32_plus else 31)

        for index in range(512):    # 上限保护，正常 PE 远小于此
            desc_off = imp_off + index * 20
            try:
                desc = r.read(desc_off, 20)
            except PeError:
                break
            oft, _, _, name_rva, first_thunk = struct.unpack("<IIIII", desc)
            if name_rva == 0 and first_thunk == 0:
                break

            name_off = rva_to_offset(info, name_rva)
            if name_off < 0:
                continue
            try:
                raw = r.read(name_off, 256)
            except PeError:
                # 导入表末尾或损坏时读越界。跳过这一项而不是整轮失败 ——
                # 层匹配需要的是"能读到多少算多少"，一个坏条目不该让
                # 整个依赖分析中断。
                continue
            dll = raw.split(b"\0", 1)[0].decode("latin-1", "replace")
            if not dll:
                continue

            lib = ImportLibrary(dll=dll)
            lookup_rva = oft or first_thunk
            lookup_off = rva_to_offset(info, lookup_rva)
            if lookup_off >= 0:
                for slot in range(4096):
                    try:
                        value = r.u64(lookup_off + slot * thunk_size) if is_pe32_plus \
                            else r.u32(lookup_off + slot * thunk_size)
                    except PeError:
                        break
                    if value == 0:
                        break
                    if value & ordinal_flag:
                        lib.functions.append(f"#{value & 0xFFFF}")
                        continue
                    hint_off = rva_to_offset(info, value & 0x7FFFFFFF)
                    if hint_off < 0:
                        continue
                    try:
                        fname = r.read(hint_off + 2, 128).split(b"\0", 1)[0]
                        lib.functions.append(fname.decode("latin-1", "replace"))
                    except PeError:
                        continue
            result.append(lib)
        return result


def imported_dll_stems(info: PeInfo) -> set[str]:
    """导入的 DLL 名集合（小写、无 .dll 后缀），供层匹配使用。"""
    return {lib.stem for lib in imports(info)}


# --------------------------------------------------------------------------
# 版本资源
# --------------------------------------------------------------------------


def _align4(n: int) -> int:
    return (n + 3) & ~3


def _read_utf16z(data: bytes, offset: int, limit: int) -> str:
    end = offset
    while end + 1 < min(len(data), limit):
        if data[end] == 0 and data[end + 1] == 0:
            break
        end += 2
    try:
        return data[offset:end].decode("utf-16-le", "replace")
    except (UnicodeDecodeError, ValueError):
        return ""


def _parse_version_block(data: bytes) -> dict[str, str]:
    """解析 VS_VERSIONINFO 的 StringFileInfo，返回键值对。

    结构：wLength wValueLength wType szKey(UTF-16) padding Value
    递归进入 StringFileInfo / StringTable。只用长度字段推进，不猜布局。
    """
    result: dict[str, str] = {}

    def walk(start: int, end: int, depth: int) -> None:
        if depth > 6 or start + 6 > end:
            return
        try:
            length, value_length, _vtype = struct.unpack_from("<HHH", data, start)
        except struct.error:
            return
        if length < 6 or start + length > end:
            return
        key = _read_utf16z(data, start + 6, start + length)
        cursor = _align4(start + 6 + (len(key) + 1) * 2)

        if key in ("StringFileInfo", "StringTable", "VarFileInfo"):
            walk(cursor, start + length, depth + 1)
            return
        if key == "VS_VERSION_INFO":
            # 有 VS_FIXEDFILEINFO，跳过 52 字节后进入子块
            walk(cursor + 52, start + length, depth + 1)
            return
        # 叶子：key = 字符串键名，value 是 UTF-16 字符串
        if value_length and cursor + value_length <= start + length:
            value = data[cursor:cursor + value_length]
            text = value.decode("utf-16-le", "replace").rstrip("\0")
            result[key] = text

    walk(0, len(data), 0)
    return result


def version_strings(info: PeInfo,
                    entries: list[ResourceEntry] | None = None) -> dict[str, str]:
    """取版本资源里的字符串表。无版本资源返回空字典。

    entries 可传入已解析好的资源叶子表，避免重复走资源树 —— 调用方常常
    既要版本信息又要判断图标，两次都自己调 `resources()` 就是白读一遍。
    """
    for entry in (resources(info) if entries is None else entries):
        if entry.type_id != RT_VERSION:
            continue
        try:
            raw = resource_bytes(info, entry)
        except PeError:
            continue
        strings = _parse_version_block(raw)
        if strings:
            return strings
    return {}


def product_metadata(info: PeInfo,
                     entries: list[ResourceEntry] | None = None
                     ) -> dict[str, str | None]:
    """归一化的产品元数据。字段缺失时值为 None。"""
    strings = version_strings(info, entries)
    return {
        "product_name": strings.get("ProductName") or strings.get("FileDescription") or None,
        "product_version": strings.get("ProductVersion") or strings.get("FileVersion") or None,
        "vendor": strings.get("CompanyName") or None,
        "internal_name": strings.get("InternalName") or None,
        "original_filename": strings.get("OriginalFilename") or None,
    }


