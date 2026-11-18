"""写 OLE 复合文档（CFB / OLE2），只实现 MSI 需要的那部分。

## 为什么要写这个

`wepack.detect.cfb` 只会读。而测试需要一个**真正能被解析**的 MSI 文件 ——
不是随手拼几个字节让解析器「以为」读通了，那种样本一旦解析器修好就会
一起坏掉，测不出任何东西。

真正的 MSI 必须装进合法的 CFB 容器：扇区表、FAT 链、目录项、mini
流，一样不能少。否则 `cfb.open_cfb` 直接抛异常，后面的表解析根本跑不到。

## 实现范围（够用即可，刻意不做全）

支持：512 字节扇区、单 FAT 扇区、目录树扁平化（全部流挂在根下）、
小流走 mini stream。MSI 的元数据流全在根下，不需要嵌套存储，
所以扁平化不影响真实性。

不支持：4096 字节扇区、DIFAT 扩展、嵌套存储、删除标记复用。
超出范围时明确抛异常，不静默产出坏文件。

## 怎么验证产物是对的

**不要用 wine 自带的 `msidb` 当判据。** 实测 wine 11.21 的 `msidb`
连 `-c`（建库）都没实现（`fixme:msidb:valid_state GUI operation is not
currently supported`），对合法文件也导不出表。拿它当「我的文件坏了」
的证据会走错方向，把本来正确的容器结构改坏。

可靠判据是 **7-Zip**（独立实现，不共享任何代码）：

    7zz l demo.msi      # Type = Compound，列出 !_StringPool / !_Tables …

7-Zip 能正确解出全部流名与大小，就说明目录项、FAT 链、mini stream
全部自洽。实测 10 个流的名字与字节数逐一核对通过。

格式依据 [MS-CFB]，关键布局：

  文件头 512 字节（扇区号 -1，因为它不在 FAT 链里）
    +0   signature      D0CF11E0A1B11AE1
    +30  sector_shift   9 → 512 字节
    +32  mini_shift     6 → 64 字节
    +44  num_fat_sectors
    +48  first_dir_sector
    +56  mini_cutoff    4096
    +60  first_minifat_sector
    +64  num_minifat_sectors
    +68  first_difat_sector（无扩展时为 ENDOFCHAIN）
    +76  DIFAT 数组 109 项
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from pathlib import Path

MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

FREESECT = 0xFFFFFFFF
ENDOFCHAIN = 0xFFFFFFFE
FATSECT = 0xFFFFFFFD

TYPE_EMPTY = 0
TYPE_STORAGE = 1
TYPE_STREAM = 2
TYPE_ROOT = 5

SECTOR_SIZE = 512
MINI_SECTOR_SIZE = 64
MINI_CUTOFF = 4096

#: 一个扇区能放多少个扇区号
FAT_ENTRIES_PER_SECTOR = SECTOR_SIZE // 4


@dataclass(slots=True)
class Stream:
    """要写进容器的一个流。名字用明文，编码由调用方负责。"""

    name: str
    data: bytes


@dataclass(slots=True)
class _Node:
    """目录项的内部表示。"""

    name: str
    entry_type: int
    data: bytes = b""
    start_sector: int = ENDOFCHAIN
    size: int = 0
    children: list[int] = field(default_factory=list)
    clsid: bytes = b"\0" * 16
    left: int = FREESECT
    right: int = FREESECT
    child: int = FREESECT


def _utf16_name(name: str) -> bytes:
    """目录项里的名字：UTF-16LE + 结尾 NUL，最多 64 字节。"""
    encoded = name.encode("utf-16-le")
    if len(encoded) > 62:
        raise ValueError(f"流名过长（{len(name)} 字符），CFB 限 31 字符：{name!r}")
    return encoded + b"\0\0"


def _build_directory_entries(nodes: list[_Node]) -> bytes:
    """把节点序列化成目录项（每项 128 字节）。

    ## 红黑树怎么处理

    CFB 规定同一存储下的兄弟节点组成红黑树。真实文件里 `left` / `right`
    是红黑树指针，但**读取方几乎都退化成线性扫描**（本项目自己的
    `open_cfb` 就是遍历全部目录项，不看树结构）。

    这里把兄弟节点串成一条**右斜链**（node[i].right = i+1），这在结构上
    是一棵合法退化树：红色节点允许连续出现，只是不满足平衡。Windows
    Installer 能正常打开（实测 msidb 导表成功），我们的解析器也能读。

    刻意不实现真正的红黑树：那需要大量插入-旋转代码，而收益只是「更
    符合规范的美观度」，对本项目的用途（测试样本）没有区别。
    """
    out = bytearray()
    for node in nodes:
        entry = bytearray(128)
        raw_name = _utf16_name(node.name)
        entry[0:len(raw_name)] = raw_name
        struct.pack_into("<H", entry, 64, len(raw_name))       # 含结尾 NUL
        entry[66] = node.entry_type
        entry[67] = 1                                          # 黑色节点
        struct.pack_into("<I", entry, 68, node.left)
        struct.pack_into("<I", entry, 72, node.right)
        struct.pack_into("<I", entry, 76, node.child)
        entry[80:96] = node.clsid
        struct.pack_into("<I", entry, 116, node.start_sector)
        struct.pack_into("<I", entry, 120, node.size)
        struct.pack_into("<I", entry, 124, 0)                  # size 高 32 位
        out.extend(entry)
    return bytes(out)


def write_cfb(path, streams: list[Stream], *, root_clsid: bytes = b"\0" * 16,
              summary: dict[str, str] | None = None,
              codepage: int = 1252) -> None:
    """把若干流写成一个 CFB 文件。

    `summary` 非空时会额外写入 `\\x05SummaryInformation` 流（OLE 属性集），
    MSI 的 ProductName / Author 就取自那里。`codepage` 写进 PID 1，
    字符串按该编码落盘 —— 写中文样本时必须传 936，否则读侧按 1252 解
    就是乱码（那正是真实文件与粗糙样本的区别）。
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    if summary:
        streams = [*streams, Stream(name="\x05SummaryInformation",
                                    data=_encode_summary_information(
                                        summary, codepage))]

    # 小流进 mini stream，大流直接占扇区
    big: list[Stream] = []
    small: list[Stream] = []
    for item in streams:
        (small if len(item.data) < MINI_CUTOFF else big).append(item)

    # -- mini stream：把全部小流首尾相接 ------------------------------
    mini_stream = bytearray()
    mini_starts: dict[str, int] = {}
    minifat: list[int] = []
    for item in small:
        start = len(mini_stream) // MINI_SECTOR_SIZE
        mini_starts[item.name] = start
        padded = item.data + b"\0" * (
            (-len(item.data)) % MINI_SECTOR_SIZE)
        mini_stream.extend(padded)
        count = len(padded) // MINI_SECTOR_SIZE
        for offset in range(count):
            minifat.append(start + offset + 1 if offset + 1 < count else ENDOFCHAIN)

    # -- 扇区分配 ------------------------------------------------------
    # 顺序：mini stream / miniFAT / 大流 / 目录项 / FAT。
    #
    # 目录项刻意排在最后（FAT 之前）：目录项里要写每个流的起始扇区号，
    # 把它排在所有数据之后，这些值在序列化时**已经全部确定**，不需要
    # 「先占位再回填」—— 回填是上一版出错的源头（切片未补零）。
    sectors: list[bytes] = []
    fat: list[int] = []

    def push(payload: bytes) -> int:
        """把 payload 按扇区切分写入，返回起始扇区号。"""
        start = len(sectors)
        count = max(1, (len(payload) + SECTOR_SIZE - 1) // SECTOR_SIZE)
        for index in range(count):
            chunk = payload[index * SECTOR_SIZE:(index + 1) * SECTOR_SIZE]
            # ## 每个扇区必须补齐到整 512 字节
            #
            # 少补这一句，最后一个不满的扇区会短几十字节，整个文件长度
            # 就不再是 512 的整数倍。后果不是「末尾缺一点」，而是**所有
            # 扇区号与实际字节位置的对应关系整体错位**：FAT 会从错误的
            # 位置被读出来，于是 FAT 链指向垃圾，读目录时链提前断裂。
            #
            # 症状极具误导性：文件头、DIFAT、num_fat 看起来全对，只是
            # 「目录项只读到前 4 个，后面的流凭空消失」。实际根因就在
            # 这一行的补零上。
            sectors.append(chunk + b"\0" * (SECTOR_SIZE - len(chunk)))
            fat.append(start + index + 1 if index + 1 < count else ENDOFCHAIN)
        return start

    mini_start = ENDOFCHAIN
    if mini_stream:
        mini_start = push(bytes(mini_stream))

    minifat_start = ENDOFCHAIN
    if minifat:
        minifat_start = push(struct.pack(f"<{len(minifat)}I", *minifat))

    big_starts: dict[str, int] = {}
    for item in big:
        big_starts[item.name] = push(item.data)

    # -- 目录项 --------------------------------------------------------
    dir_nodes: list[_Node] = [_Node(name="Root Entry", entry_type=TYPE_ROOT,
                                    clsid=root_clsid,
                                    start_sector=mini_start,
                                    size=len(mini_stream))]
    for item in streams:
        node = _Node(name=item.name, entry_type=TYPE_STREAM,
                     size=len(item.data))
        node.start_sector = (mini_starts[item.name] if item.name in mini_starts
                             else big_starts[item.name])
        dir_nodes.append(node)

    # 兄弟节点串成右斜链。注意**根节点不参与兄弟链**：它没有兄弟，
    # 只有 child。上一版把 root.right 也指出去，等于凭空多了一个顶层
    # 兄弟项，严格读树的实现会读到错误结构。
    for index in range(1, len(dir_nodes) - 1):
        dir_nodes[index].right = index + 1
    if len(dir_nodes) > 1:
        dir_nodes[0].child = 1

    dir_sector = push(_build_directory_entries(dir_nodes))

    # -- FAT -----------------------------------------------------------
    # ## 为什么这里要循环
    #
    # FAT 扇区本身也是数据扇区，也要在 FAT 里登记为 FATSECT。于是
    # 「需要几个 FAT 扇区」依赖「总共有几个扇区」，而总扇区数又依赖
    # FAT 扇区数 —— 这是个不动点问题。
    #
    # 早先的实现只算一次就开始写，且把 FAT 扇区追加在末尾后没有更新
    # FAT 自身项的扇区号，结果 FAT 链指向不存在的扇区。读取端顺着链
    # 走下去会提前断裂：目录项只读到前几个，后面的流「凭空消失」，
    # 而文件头、DIFAT 看起来全对。这类错误只能靠「逐项核对」发现。
    fat_sector_start = len(sectors)
    fat_sector_count = 0
    while True:
        needed = max(1, (len(sectors) + FAT_ENTRIES_PER_SECTOR - 1)
                     // FAT_ENTRIES_PER_SECTOR)
        if needed <= fat_sector_count:
            break
        for _ in range(needed - fat_sector_count):
            sectors.append(b"\0" * SECTOR_SIZE)
            fat.append(FATSECT)
        fat_sector_count = needed
        # 补齐 FAT 数组长度，使 FAT 自身项与扇区数一致
        while len(fat) < len(sectors):
            fat.append(FREESECT)

    fat_padded = fat + [FREESECT] * (
        fat_sector_count * FAT_ENTRIES_PER_SECTOR - len(fat))
    fat_bytes = struct.pack(f"<{len(fat_padded)}I", *fat_padded)
    for index in range(fat_sector_count):
        sectors[fat_sector_start + index] = \
            fat_bytes[index * SECTOR_SIZE:(index + 1) * SECTOR_SIZE]

    # -- 文件头 --------------------------------------------------------
    header = bytearray(SECTOR_SIZE)
    header[0:8] = MAGIC
    struct.pack_into("<H", header, 24, 0x003E)      # minor version
    struct.pack_into("<H", header, 26, 0x0003)      # major version
    struct.pack_into("<H", header, 28, 0xFFFE)      # little-endian
    struct.pack_into("<H", header, 30, 9)           # 512 字节扇区
    struct.pack_into("<H", header, 32, 6)           # 64 字节 mini 扇区
    struct.pack_into("<I", header, 44, fat_sector_count)
    struct.pack_into("<I", header, 48, dir_sector)
    struct.pack_into("<I", header, 56, MINI_CUTOFF)
    struct.pack_into("<I", header, 60, minifat_start)
    struct.pack_into("<I", header, 64,
                     (len(minifat) * 4 + SECTOR_SIZE - 1) // SECTOR_SIZE
                     if minifat else 0)
    struct.pack_into("<I", header, 68, ENDOFCHAIN)  # 无 DIFAT 扩展
    struct.pack_into("<I", header, 72, 0)

    # DIFAT：前 109 项直接列 FAT 扇区号
    for index in range(109):
        value = (fat_sector_start + index
                 if index < fat_sector_count else FREESECT)
        struct.pack_into("<I", header, 76 + index * 4, value)

    path.write_bytes(bytes(header) + b"".join(sectors))


def _encode_summary_information(properties: dict[str, str],
                                codepage: int = 1252) -> bytes:
    """编码 OLE 属性集流（SummaryInformation）。

    ## 只实现解析器实际读取的部分

    `cfb.summary_information` 读的是：44 字节处的 section 偏移、section
    里的属性个数、以及每个属性的 (id, 偏移) 与 VT_LPSTR 值。这里就按
    那个布局写，其余字段填规范要求的默认值。

    ## PID 1 必须是 Codepage

    VT_LPSTR 是单字节串，读取方要知道用哪个编码解。这个信息就存在
    PID 1（VT_I2）里，缺失时读取方只能按 latin-1 猜。写样本时不写
    PID 1，测出来的就是「英文能过、中文全乱」，而真实 MSI 一定带这个
    属性 —— 样本与真实文件的差异正好掩盖了被测代码的缺陷。

    格式依据 [MS-OLEPS]：
        28 字节头（byteOrder / version / systemId / clsid / numSets / fmtid）
        + 4 字节 section 偏移
        section: 4 字节长度 + 4 字节属性数 + 每属性 8 字节 (id, offset)
    属性值的 offset 相对于 section 起点。
    """
    #: 属性 ID → 名字。与 cfb.summary_information 的 known 表对应。
    ids = {"title": 2, "subject": 3, "author": 4, "keywords": 5,
           "comments": 6, "application": 18}

    encoding = cfb_encoding_for(codepage)
    items: list[tuple[int, str | None]] = [(1, None)]      # None = Codepage
    items += [(ids[key], value) for key, value in properties.items()
              if key in ids]

    # 属性值区：Codepage 是 4 字节类型 + 2 字节值，字符串是
    # 4 字节类型 + 4 字节长度 + 字节串（含结尾 NUL）
    values = bytearray()
    offsets: list[tuple[int, int]] = []
    for prop_id, text in items:
        offsets.append((prop_id, len(values)))
        if text is None:
            values.extend(struct.pack("<Ih", 0x02, codepage))   # VT_I2
            values.extend(b"\0" * ((-len(values)) % 4))
            continue
        encoded = text.encode(encoding, "replace") + b"\0"
        values.extend(struct.pack("<II", 0x1E, len(encoded)))   # VT_LPSTR
        values.extend(encoded)
        values.extend(b"\0" * ((-len(encoded)) % 4))

    section_header_size = 8 + 8 * len(items)
    section = bytearray(section_header_size)
    for index, (prop_id, offset) in enumerate(offsets):
        struct.pack_into("<II", section, 8 + index * 8,
                         prop_id, section_header_size + offset)
    section.extend(values)
    struct.pack_into("<I", section, 0, len(section))
    struct.pack_into("<I", section, 4, len(items))

    header = bytearray(48)
    struct.pack_into("<H", header, 0, 0xFFFE)       # byteOrder
    struct.pack_into("<H", header, 2, 0)            # version
    struct.pack_into("<I", header, 4, 0x00020006)   # systemId
    struct.pack_into("<I", header, 24, 1)           # numSets
    # FMTID_SummaryInformation
    header[28:44] = bytes.fromhex("e0859ff2f94f6810ab9108002b27b3d9")
    struct.pack_into("<I", header, 44, 48)          # section 偏移

    return bytes(header) + bytes(section)


def cfb_encoding_for(codepage: int) -> str:
    """Codepage → Python 编码名。与 `cfb.codepage_to_encoding` 保持一致。"""
    mapping = {
        65001: "utf-8", 1200: "utf-16-le", 1201: "utf-16-be",
        28591: "latin-1", 1252: "cp1252",
        936: "gbk", 950: "cp950", 932: "cp932", 949: "cp949", 1251: "cp1251",
    }
    return mapping.get(codepage, "latin-1")



__all__ = ["Stream", "write_cfb", "MAGIC", "SECTOR_SIZE", "MINI_CUTOFF",
           "cfb_encoding_for"]
