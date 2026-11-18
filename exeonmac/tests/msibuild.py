"""构造最小合法 MSI 数据库（只依赖标准库）。

## 为什么需要自己造

测试 MSI 相关的解析逻辑（File / Directory / Component / Shortcut 表）需要
一个 MSI 文件。早先这些测试靠 `WEXE_SAMPLE_MSI` 指向开发者手工下载的
样本，没设变量就整类跳过 —— 跳过在测试报告里是绿的，于是「MSI 表解析」
这一整块在 CI 上从来没被验证过。

真实样本还带来另一个问题：它的内容随版本变化，断言写死了就会变脆。
例如 7-Zip 的 MSI 有 106 个文件、28 个目录，换个版本全部失效。

自己造样本则两个问题都没有：结构由测试精确控制，任何机器上都能跑。

## 编码要点（全部由真实 MSI 反推并交叉核对过）

CFB 容器部分见 `cfbwrite.py`。这里只处理 MSI 的元数据流：

  - 流名是私有编码：ASCII 名每两个字符压进一个 u16
        u16 = 0x3800 + (第二个字符 << 6) + 第一个字符
    奇数长度时末字符单独存成 0x4800 + index。首字符固定 0x4840。
    实测 `File` → `䡀䌏䈯`、`_Tables` → `䡀㽿䅤䈯䠶`，与 msidb 的产物一致。

  - `_StringPool`：4 字节头 + 每项 4 字节 (cch, refs)，`cch` 之和必须
    恰好等于 `_StringData` 的字节数 —— 这是识别这一对流的唯一硬证据。

  - `_Tables`：uint16 数组，值都是字符串池下标。

  - `_Columns`：四段等长数组（表名下标 / 列序号 / 列名下标 / 列类型）。
    列类型的低字节决定字节宽度：2 = 短整数，4 = 长整数，其余（8/20/38/
    64/72/255…）是字符串容量，都按 2 字节存放。

  - 表数据流：**列主序 + 变宽**。第 c 列从头开始，连续 rows 项。
    4 字节整数的编码是「低字 + (0x8000 | 高字)」，不是直接的 u32 ——
    按 `<I` 直读会得到荒谬的大数。
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from pathlib import Path

from cfbwrite import Stream, cfb_encoding_for, write_cfb

#: MSI 流名编码用的字母表（顺序即索引）
_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._"

#: Windows Installer 数据库根存储 CLSID。
#: 字节序是 CFB 的 little-endian 前导三段，不是字符串形式的顺序。
MSI_ROOT_CLSID = bytes.fromhex("84100c0000000000c000000000000046")

#: 列类型码。低字节语义：2 = 短整数，4 = 长整数。
#: 字符串列用容量表示（InstallShield / WiX / wine 各写各的，不统一），
#: 所以这里只挑几个常见的作代表，解析侧一律按 2 字节处理。
I2 = 2
I4 = 4
S72 = 72
S255 = 255
S38 = 38
S20 = 20
L255 = 255


def encode_stream_name(name: str) -> str:
    """把 ASCII 流名编码成 MSI 在 CFB 里使用的私有形态。"""
    out = [0x4840]
    index = 0
    while index + 1 < len(name):
        low = _ALPHABET.index(name[index])
        high = _ALPHABET.index(name[index + 1])
        out.append(0x3800 + (high << 6) + low)
        index += 2
    if index < len(name):
        out.append(0x4800 + _ALPHABET.index(name[index]))
    return "".join(chr(code) for code in out)


@dataclass(slots=True)
class ColumnSpec:
    """一列的定义：名字 + 类型码。"""

    name: str
    type_code: int

    @property
    def width(self) -> int:
        """这一列的字节宽度。低字节为 4 时是长整数，其余都是 2。"""
        return 4 if (self.type_code & 0xFF) == 4 else 2


@dataclass(slots=True)
class TableSpec:
    """一张表的定义：列清单 + 行数据。

    行数据是 `list[list[object]]`，每行长度必须等于列数。
    字符串列填 `str`（会进字符串池），整数列填 `int`。
    """

    name: str
    columns: list[ColumnSpec]
    rows: list[list[object]] = field(default_factory=list)


class MsiBuilder:
    """拼装一个 MSI 数据库。

    典型用法：

        builder = MsiBuilder()
        builder.add_table(TableSpec("File", [...], [[...]]))
        builder.build()          # -> dict[流名, bytes]

    流名到这里已是编码后的形态，直接交给 `write_cfb` 即可。
    """

    def __init__(self, *, codepage: int = 1252) -> None:
        self.tables: list[TableSpec] = []
        self.property_rows: list[tuple[str, str]] = []
        #: MSI 的代码页。字符串池里的文本按它单字节编码，同时写进
        #: SummaryInformation 的 PID 1。中文包用 936。
        self.codepage = codepage

    def add_table(self, spec: TableSpec) -> TableSpec:
        self.tables.append(spec)
        return spec

    def add_property(self, key: str, value: str) -> None:
        """往 Property 表加一行（ProductName / ProductVersion 等）。"""
        self.property_rows.append((key, value))

    # -- 字符串池 ------------------------------------------------------

    def _collect_strings(self) -> tuple[list[str], dict[str, int]]:
        """收集所有需要进池的字符串，返回 (有序列表, 下标映射)。

        MSI 的字符串池下标从 1 开始（0 表示空）。顺序不重要，只要
        `_StringPool` 与 `_StringData` 一致即可，这里按首次出现排序，
        便于出问题时人工比对。
        """
        ordered: list[str] = []
        index: dict[str, int] = {}

        def intern(text: str) -> int:
            if not text:
                return 0
            if text not in index:
                ordered.append(text)
                index[text] = len(ordered)
            return index[text]

        for spec in self.tables:
            intern(spec.name)
            for column in spec.columns:
                intern(column.name)
            for row in spec.rows:
                for cell in row:
                    if isinstance(cell, str):
                        intern(cell)
        return ordered, index

    def _build_string_pool(self, strings: list[str]) -> tuple[bytes, bytes]:
        """生成 (_StringPool, _StringData) 两个流。

        `_StringPool` 结构：4 字节头 + 每项 4 字节 (cch, refs)。
        各项 cch 之和必须**恰好**等于 `_StringData` 的字节数 —— 这是
        解析侧用来认这一对流 的唯一硬证据，写的时候必须严格对上。
        """
        pool = bytearray(4)          # 4 字节头（实测为 0）
        data = bytearray()
        encoding = cfb_encoding_for(self.codepage)
        for text in strings:
            # ## cch 数的是**字节**，所以先编码再取长度
            #
            # 顺序反了（先 len(text) 再编码）时，ASCII 样本完全正常，
            # 一旦文本里有非 ASCII 字符，后面的每条字符串边界都会漂移 ——
            # 表现是「前几条对，越往后越乱」。这类 bug 只有拿真实
            # 中文样本才测得出来。
            encoded = text.encode(encoding, "replace")
            pool.extend(struct.pack("<HH", len(encoded), 1))
            data.extend(encoded)
        # 空字符串（下标 0）不占位；解析侧遇到 cch == 0 会跳过
        return bytes(pool), bytes(data)

    # -- 元数据流 ------------------------------------------------------

    def _build_tables(self, index: dict[str, int]) -> bytes:
        return struct.pack(f"<{len(self.tables)}H",
                           *(index[spec.name] for spec in self.tables))

    def _build_columns(self, index: dict[str, int]) -> bytes:
        """生成 _Columns：四段等长数组。"""
        table_ids: list[int] = []
        numbers: list[int] = []
        name_ids: list[int] = []
        types: list[int] = []

        for spec in self.tables:
            for position, column in enumerate(spec.columns, start=1):
                table_ids.append(index[spec.name])
                numbers.append(position)
                name_ids.append(index[column.name])
                types.append(column.type_code)

        flat = table_ids + numbers + name_ids + types
        return struct.pack(f"<{len(flat)}H", *flat)

    def _encode_integer(self, value: int, width: int) -> list[int]:
        """把整数编码成 2 或 4 字节对应的 u16 序列。"""
        if width == 2:
            return [value & 0xFFFF]
        low = value & 0xFFFF
        high = 0x8000 | ((value >> 16) & 0x7FFF)
        return [low, high]

    def _build_table_stream(self, spec: TableSpec, index: dict[str, int]) -> bytes:
        """生成一张表的数据流（列主序 + 变宽）。"""
        if not spec.rows:
            return b""
        rows = len(spec.rows)
        out = bytearray()
        for position, column in enumerate(spec.columns):
            width = column.width
            values: list[int] = []
            for row in spec.rows:
                cell = row[position] if position < len(row) else ""
                if width == 4:
                    values.extend(self._encode_integer(int(cell or 0), 4))
                elif isinstance(cell, int):
                    values.extend(self._encode_integer(cell, 2))
                else:
                    values.append(index.get(str(cell), 0) if cell else 0)
            out.extend(struct.pack(f"<{len(values)}H", *values))
        assert len(out) == rows * sum(c.width for c in spec.columns)
        return bytes(out)

    # -- 组装 ----------------------------------------------------------

    def build(self) -> dict[str, bytes]:
        """生成全部流的原始字节。键是**编码后**的流名。"""
        if self.property_rows:
            existing = next((s for s in self.tables if s.name == "Property"), None)
            if existing is None:
                existing = TableSpec("Property", [ColumnSpec("Property", S72),
                                                  ColumnSpec("Value", S255)])
                self.add_table(existing)
            existing.rows.extend([list(row) for row in self.property_rows])

        strings, index = self._collect_strings()
        pool, data = self._build_string_pool(strings)

        streams: dict[str, bytes] = {
            encode_stream_name("_StringPool"): pool,
            encode_stream_name("_StringData"): data,
            encode_stream_name("_Tables"): self._build_tables(index),
            encode_stream_name("_Columns"): self._build_columns(index),
        }
        for spec in self.tables:
            payload = self._build_table_stream(spec, index)
            if payload:
                streams[encode_stream_name(spec.name)] = payload
        return streams


def write_msi(path, streams: dict[str, bytes], *, title: str = "Test Installer",
              subject: str = "", author: str = "wepack tests",
              codepage: int = 1252,
              payload: dict[str, bytes] | None = None) -> None:
    """把流写成一个完整的 MSI 文件（CFB 容器 + MSI 根 CLSID）。

    `payload` 是「文件键 → 内容」，会作为额外的流写进容器。注意这些
    流名**不做 MSI 编码** —— 载荷流的名字就是文件键本身，Windows
    Installer 与 7z 都按明文查找（与 `_StringPool` 那类元数据流不同）。
    """
    cfb_streams = [Stream(name=name, data=data) for name, data in streams.items()]
    for name, data in (payload or {}).items():
        cfb_streams.append(Stream(name=name, data=data))
    write_cfb(path, cfb_streams, root_clsid=MSI_ROOT_CLSID,
              summary=_summary_information(title=title, subject=subject,
                                           author=author),
              codepage=codepage)


def build_demo_msi(path, *, product: str = "Demo", entry: str = "Demo.exe",
                   extra_files: list[str] | None = None,
                   codepage: int = 1252,
                   file_count: int = 14) -> Path:
    """造一个结构完整、能走完 detect → file_mapping → shortcut_targets 的 MSI。

    ## 目录结构与文件数

    目录做成**三层**（`bin` / `bin/plugins` / `docs` 挂在产品目录下）。
    只有一层的样本测不出 relpath 拼接 —— 早先 Directory 表解析错位就是
    这样漏过去的：`file_mapping` 非空、文件名也对，只是所有文件都挤在
    根上，看起来完全正常。

    `file_count` 默认 14：列主序 + 变宽的读取最容易在行数多时出现
    「前几行对、后面错位」，数据太少看不出来。这些文件分布在三个目录，
    顺带验证「同一组件目录下的多文件」与「跨目录」两种情形。

    ## 快捷方式

    两条 Shortcut：一条指向 exe（真入口），一条指向 .txt（非可执行）。
    后者用来验证「入口选取必须跳过非可执行目标」。
    """
    builder = MsiBuilder(codepage=codepage)
    builder.add_property("ProductName", product)
    builder.add_property("ProductVersion", "1.0.0")
    builder.add_property("Manufacturer", "Ntarstudio")

    builder.add_table(TableSpec("Directory", [
        ColumnSpec("Directory", S72),
        ColumnSpec("Directory_Parent", S72),
        ColumnSpec("DefaultDir", L255),
    ], [
        ["TARGETDIR", "", "SourceDir"],
        ["ProgramFilesFolder", "TARGETDIR", "."],
        ["INSTALLDIR", "ProgramFilesFolder", product],
        ["BinDir", "INSTALLDIR", "bin"],
        ["PluginDir", "BinDir", "plugins"],
        ["DocDir", "INSTALLDIR", "docs"],
    ]))

    files: list[list[object]] = []
    components: list[list[object]] = []
    sequence = 1

    # 主程序：放在 bin 子目录，验证 relpath 带层级
    files.append([entry, "CmpMain", entry, 627200, "", "", 0, sequence])
    components.append(["CmpMain", "{11111111-1111-1111-1111-111111111111}",
                       "BinDir", 0, "", entry])
    sequence += 1

    # 额外文件按三个目录铺开，让 relpath 的层级差异能被断言到。
    # 基础布局是「真实感」的部分（有 ini/png/dll 各种扩展名），
    # 文件数不够时按序号补齐同名风格的 dll，避免全部挤在同一种扩展名上。
    base_layout = [
        ("readme.txt", "DocDir", 4096),
        ("helper.dll", "BinDir", 81920),
        ("core.dll", "BinDir", 163840),
        ("plugin-a.dll", "PluginDir", 32768),
        ("plugin-b.dll", "PluginDir", 32768),
        ("plugin-c.dll", "PluginDir", 32768),
        ("license.txt", "DocDir", 2048),
        ("changelog.txt", "DocDir", 3072),
        ("config.ini", "BinDir", 512),
        ("logo.png", "DocDir", 10240),
        ("runtime.dll", "BinDir", 262144),
        ("updater.exe", "BinDir", 51200),
        ("crashpad.dll", "PluginDir", 40960),
    ]
    if extra_files is not None:
        layout = [(name, "BinDir", 4096) for name in extra_files]
    else:
        layout = list(base_layout)
        # 按需补齐：轮流落到三个目录，扩展名也换着来
        spare = [("module", "BinDir", 16384), ("plugin", "PluginDir", 8192),
                 ("guide", "DocDir", 1536)]
        index = 0
        while len(layout) < max(0, file_count - 1):
            stem, directory, size = spare[index % len(spare)]
            ext = "dll" if directory != "DocDir" else "txt"
            layout.append((f"{stem}-{index:03d}.{ext}", directory, size))
            index += 1
    layout = layout[:max(0, file_count - 1)]

    for index, (name, directory, size) in enumerate(layout, start=1):
        component_id = f"Cmp{index:02d}"
        files.append([name, component_id, name, size, "", "", 0, sequence])
        components.append([component_id,
                           f"{{{index:08d}-2222-2222-2222-{index:012d}}}",
                           directory, 0, "", name])
        sequence += 1

    builder.add_table(TableSpec("File", [
        ColumnSpec("File", S72), ColumnSpec("Component_", S72),
        ColumnSpec("FileName", L255), ColumnSpec("FileSize", I4),
        ColumnSpec("Version", S72), ColumnSpec("Language", S20),
        ColumnSpec("Attributes", I2), ColumnSpec("Sequence", I2),
    ], files))

    builder.add_table(TableSpec("Component", [
        ColumnSpec("Component", S72), ColumnSpec("ComponentId", S38),
        ColumnSpec("Directory_", S72), ColumnSpec("Attributes", I2),
        ColumnSpec("Condition", S255), ColumnSpec("KeyPath", S72),
    ], components))

    # 两条快捷方式：一条指向主程序，一条指向帮助文档（非可执行）
    builder.add_table(TableSpec("Shortcut", [
        ColumnSpec("Shortcut", S72), ColumnSpec("Directory_", S72),
        ColumnSpec("Name", S255), ColumnSpec("Component_", S72),
        ColumnSpec("Target", S72), ColumnSpec("Arguments", S255),
    ], [
        ["SctMain", "ProgramMenuFolder", f"{product} 主程序", "CmpMain",
         f"[#{entry}]", ""],
        ["SctHelp", "ProgramMenuFolder", f"{product} 帮助", "CmpMain",
         "[#readme.txt]", ""],
    ]))

    write_msi(path, builder.build(), title=f"{product} Installer",
              subject=product, author="Ntarstudio", codepage=codepage,
              payload=_build_payload(files, entry))
    return Path(path)


def _build_payload(files: list[list[object]], entry: str) -> dict[str, bytes]:
    """给每个 File 表条目配一份载荷流。

    ## 为什么 MSI 需要载荷流

    MSI 的「元数据」与「载荷」是分开的两样东西：File 表说「有个文件叫
    `core.dll`，大小 163840」，而真正的字节在一条以文件键命名的**流**
    里（或打包进 cab）。只有元数据没有载荷，`extract` 走到「容器解开后
    没有任何文件」那一支，判定为「可能是仅含自定义动作的包」—— 这是
    正确判断，只是夹具缺料。

    7z 解 MSI 时会把这类流直接解成同名文件，于是 `_finish_without_cab`
    能用 File 表键名把它们对上，还原成真实路径。

    ## 主程序必须是真 PE

    `updater.exe` 之类如果只有随机字节，`rank_candidates` 会拒绝它，
    测试就测不到「入口被正确识别」这件事。所以 `.exe` 一律写成最小
    PE，其余写可辨认的填充数据（内容里带上文件名，便于排查）。
    """
    from_fixtures = None
    payload: dict[str, bytes] = {}
    for row in files:
        file_key = str(row[0])
        size = int(row[3]) if len(row) > 3 and row[3] else 1024
        if file_key.lower().endswith((".exe", ".dll")):
            # 做成真 PE：候选排序与 PE 校验都靠这个
            body = _minimal_pe_bytes()
            if len(body) < size:
                body += b"\0" * (size - len(body))
            payload[file_key] = body[:max(size, len(body))]
        else:
            text = f"payload of {file_key}\n".encode("utf-8")
            payload[file_key] = (text * (size // len(text) + 1))[:size]
    return payload


def _minimal_pe_bytes(*, subsystem: int = 2) -> bytes:
    """最小 PE32+，与 `fixtures.minimal_pe` 同构，避免循环导入。"""
    FILE_ALIGN = 0x200
    section_data = b"\xc3" * 16
    section_raw = section_data + b"\0" * (FILE_ALIGN - len(section_data))

    dos = bytearray(0x80)
    dos[0:2] = b"MZ"
    struct.pack_into("<I", dos, 0x3C, 0x80)

    coff = struct.pack("<HHIIIHH", 0x8664, 1, 0, 0, 0, 240, 0x22)

    opt = bytearray(240)
    struct.pack_into("<H", opt, 0, 0x20B)
    struct.pack_into("<H", opt, 68, subsystem)
    struct.pack_into("<I", opt, 56, 0x1000)
    struct.pack_into("<I", opt, 60, FILE_ALIGN)

    section = bytearray(40)
    section[0:8] = b".text\0\0\0"
    struct.pack_into("<I", section, 8, 16)
    struct.pack_into("<I", section, 12, 0x1000)
    struct.pack_into("<I", section, 16, len(section_raw))
    struct.pack_into("<I", section, 20, FILE_ALIGN)
    section[36:40] = struct.pack("<I", 0x60000020)

    body = bytes(dos) + b"PE\0\0" + coff + bytes(opt) + bytes(section)
    if len(body) % FILE_ALIGN:
        body += b"\0" * (FILE_ALIGN - len(body) % FILE_ALIGN)
    return body + section_raw


def _summary_information(*, title: str, subject: str, author: str) -> dict[str, str]:
    """SummaryInformation 的属性集（会被 cfbwrite 编码成 OLE 属性流）。"""
    properties = {"title": title, "author": author}
    if subject:
        properties["subject"] = subject
    return properties


__all__ = [
    "MsiBuilder", "TableSpec", "ColumnSpec", "encode_stream_name",
    "write_msi", "build_demo_msi", "MSI_ROOT_CLSID",
    "I2", "I4", "S20", "S38", "S72", "S255", "L255",
]
