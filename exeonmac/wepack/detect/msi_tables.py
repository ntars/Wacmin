"""MSI 表解析（读取 File / Directory / Component 表）。

为什么需要这个：MSI 的 cab 内文件名是 `fil<32位hex>`（MSI 私有编码），
解包出来全是哈希名，既无法判断哪个是主程序，也无法还原目录结构。
真实文件名在 File 表的 FileName 列，目录结构在 Directory 表。
不解析这两张表，MSI 的静态解包等于没解。

**关键实现约束**：MSI 在 CFB 容器里的流名是私有编码（例如 `_StringPool`
存成 `䡀㼿䕷䑬㹪䒲䠯`），不能按名字查找。本模块改用**内容特征识别**：

  1. _StringPool：头部 4 字节 + 每项 4 字节 (cch, refs)，各项 cch 之和
     恰好等于另一个流的字节数（那就是 _StringData）。这个等式极难偶然成立。
  2. _StringData：被上一步指认的流。
  3. _Tables：uint16 数组，全部值都能在字符串池里查到合法表名。
  4. _Columns：uint16 三元组 (table, column, name)，长度整除 6，
     且首项是 _Tables 里的合法表索引。
  5. 各表数据流：按 (行宽 = 该表列数) 与内容签名匹配。File 表靠
     "fil"+32 位十六进制的值识别，Directory 表靠 DefaultDir 的 "|" 分隔，
     Component 表靠 {GUID} 形态的 ComponentId。

二进制格式实测自 Windows Installer 5.x 产物（PowerShell 7.4.6 MSI，
56 个流、4878 个字符串、39 张表）。只读，不写 MSI。
"""

from __future__ import annotations

import re
import struct
from dataclasses import dataclass, field
from pathlib import Path

from . import cfb

#: 已知的 MSI 表名。用于校验 _Tables 的内容特征。
KNOWN_TABLES = frozenset({
    "_Validation", "_Tables", "_Columns", "_StringPool", "_StringData",
    "AdminExecuteSequence", "AdminUISequence", "AdvtExecuteSequence",
    "AppSearch", "BBControl", "Billboard", "Binary", "BindImage", "CCPSearch",
    "CheckBox", "Class", "Component", "Complus", "Condition", "Control",
    "ControlCondition", "ControlEvent", "CreateFolder", "CustomAction",
    "Dialog", "Directory", "DrLocator", "DuplicateFile", "Environment",
    "Error", "EventMapping", "Extension", "Feature", "FeatureComponents",
    "File", "FileSFPCatalog", "Font", "Icon", "IniFile", "IniLocator",
    "InstallExecuteSequence", "InstallUISequence", "LaunchCondition", "ListBox",
    "ListView", "LockPermissions", "Media", "MIME", "ModuleSignature",
    "ModuleComponents", "ModuleDependency", "ModuleExclusion", "MsiAssembly",
    "MsiAssemblyName", "MsiDigitalCertificate", "MsiDigitalSignature",
    "MsiEmbeddedChainer", "MsiEmbeddedUI", "MsiFileHash", "MsiLockPermissionsEx",
    "MsiPackageCertificate", "MsiPatchCertificate", "MsiPatchHeaders",
    "MsiPatchMetadata", "MsiPatchOldAssemblyFile", "MsiPatchOldAssemblyName",
    "MsiPatchSequence", "MsiServiceConfig", "MsiServiceConfigFailureActions",
    "MsiShortcutProperty", "MsiSFCBypass", "MsiSystemRestore", "MsiTypeLib",
    "MsiTypeLibFile", "MsiTypeLibTable", "ODBCAttribute", "ODBCDataSource",
    "ODBCDriver", "ODBCTranslator", "Patch", "PatchPackage", "ProgId",
    "Property", "PublishComponent", "RadioButton", "Registry", "RegLocator",
    "RemoveFile", "RemoveIniFile", "RemoveRegistry", "ReserveCost",
    "SelfReg", "ServiceControl", "ServiceInstall", "Shortcut", "Signature",
    "TextStyle", "TypeLib", "UIText", "Upgrade", "Verb",
})

#: File 表的 File 键形态：fil + 32 位十六进制
_FILE_KEY_RE = re.compile(r"^fil[0-9A-Fa-f]{32}$")
#: Component 表的 ComponentId：{GUID}
_GUID_RE = re.compile(r"^\{[0-9A-Fa-f\-]{36}\}$")
#: 常见文件扩展名。目录键里的「点」不会长得像这些。
#:
#: 用来区分 `Microsoft.NET`（目录名，`.NET` 是技术词）与
#: `readme.txt`（文件名）。只列真正会遇到的扩展名，宁可漏判也不要
#: 误伤 —— 漏判由 `has_directory_root()` 兜底，误伤会让整张表消失。
_FILE_EXTENSIONS_RE = re.compile(
    r"\.(?:exe|dll|sys|ocx|cpl|drv|scr|com|bat|cmd|ps1|vbs|js"
    r"|txt|md|pdf|chm|hlp|rtf|doc|docx|xls|xlsx|ppt|pptx"
    r"|ini|cfg|conf|xml|json|yaml|yml|reg|inf|manifest|config"
    r"|png|jpg|jpeg|gif|bmp|ico|svg|tif|tiff|webp"
    r"|zip|7z|rar|cab|msi|msix|appx|gz|tar|bz2|xz"
    r"|dll32|mun|resources|pdb|lib|exp|obj|resx"
    r"|html|htm|css|csv|log|dat|bin|tmp|bak|old)$",
    re.IGNORECASE)


class MsiError(Exception):
    """MSI 表结构无法解析。"""


def _looks_like_filename(text: str) -> bool:
    """判断字符串是否像一个文件名（允许带相对路径）。

    File 表第一列的形态有三种，必须都认：

      - `fil<32 位 hex>`：Windows Installer 的默认命名，cab 内也是这个名字
      - `7zFM.exe` / `zh_cn.txt`：WiX 等工具链直接用真实文件名当键
      - `Microsoft.NET\\Framework\\v4.0.30319\\csc.exe`：**带路径**的形态

    第三种是真实样本暴露的：wine 自带的 winemsibuilder 就产出这种键。
    早先的实现一刀切「含 `/` 或 `\\` 即不是文件名」，于是这类 MSI 的
    File 表整张认不出来，`file_mapping` 返回空列表 —— 解包后全是哈希名，
    目录结构也还原不了。而症状只是「MSI 解出来文件名不对」，很容易
    被当成「这个包本来就这样」而不追究。

    所以判定改为看**末段**：路径分隔符之前的部分不参与判断。
    仍然要求有扩展名、无空格、长度合理 —— 这些是真正的形态约束。
    """
    if not text or len(text) > 200:
        return False
    if " " in text:
        return False
    # 只取最后一段做形态判断：带路径的键也应当被认出来
    base = text.replace("\\", "/").rsplit("/", 1)[-1]
    if not base:
        return False
    stem, dot, ext = base.rpartition(".")
    if not dot or not stem:
        return False
    return 1 <= len(ext) <= 8 and ext.isalnum()


@dataclass(slots=True)
class Column:
    table: str
    name: str
    number: int
    #: `_Columns` 第 4 个数组的原始值。低字节是列宽语义：
    #: 0–4 表示整数列（2 = 2 字节短整数，4 = 4 字节长整数），
    #: 更大（8/20/38/72/255…）表示字符串列的最大字符数。
    #: 为 0 时表示未知，退回按列名猜。
    type_code: int = 0


@dataclass(slots=True)
class MsiTables:
    """已解析的 MSI 元数据。"""

    strings: dict[int, str] = field(default_factory=dict)
    tables: list[str] = field(default_factory=list)
    columns: dict[str, list[Column]] = field(default_factory=dict)
    stream_map: dict[str, str] = field(default_factory=dict)
    """表名 → CFB 流名（编码后的原始名字）。"""


# --------------------------------------------------------------------------
# 字符串池
# --------------------------------------------------------------------------


def _parse_string_pool(pool: bytes, data: bytes,
                       encoding: str = "latin-1") -> dict[int, str] | None:
    """尝试把 pool 解析成字符串池。成功返回 1-based 字典，失败返回 None。

    判定成功必须同时满足：
      - 长度 >= 4 且 (len-4) 能被 4 整除
      - 各项 cch 之和恰好等于 data 的长度
    第二条是关键：随机字节几乎不可能满足。

    ## cch 是字节数，不是字符数

    `_StringData` 里的字符串按 MSI 的 Codepage 单字节编码（中文包是
    936，日文 932，西欧 1252）。`cch` 数的是**字节**，所以先按字节
    切片再解码，顺序不能反 —— 按字符数切片会让后面每条字符串的边界
    全部漂移，表现是「前几条正常，越往后越乱」。

    默认 latin-1 是安全的降级：单字节与码位一一对应，不抛异常也不丢
    字节。真实调用由 `_find_string_pool` 传入从 SummaryInformation
    读到的实际编码。
    """
    if len(pool) < 8 or (len(pool) - 4) % 4 != 0:
        return None
    count = (len(pool) - 4) // 4
    if count < 8 or count > 1_000_000:
        return None

    strings: dict[int, str] = {}
    offset = 0
    for index in range(1, count + 1):
        cch, _refs = struct.unpack_from("<HH", pool, 4 + (index - 1) * 4)
        if cch == 0:
            strings[index] = ""
            continue
        if offset + cch > len(data):
            return None
        strings[index] = data[offset:offset + cch].decode(encoding, "replace")
        offset += cch

    if offset != len(data):
        return None
    return strings


# --------------------------------------------------------------------------
# 内容特征识别
# --------------------------------------------------------------------------


def _u16_array(raw: bytes) -> list[int] | None:
    if len(raw) < 2 or len(raw) % 2 != 0:
        return None
    return list(struct.unpack_from(f"<{len(raw) // 2}H", raw, 0))


def _find_string_pool(streams: dict[str, bytes],
                      encoding: str = "latin-1"
                      ) -> tuple[dict[int, str], str, str]:
    """找出 (_StringPool, _StringData) 这一对。返回 (字符串表, pool流名, data流名)。

    `encoding` 由调用方从 SummaryInformation 的 Codepage 属性取得。
    池子的**结构**判定与编码无关（cch 数的是字节），所以这里先用候选
    编码解析；若某编码下 `decode` 出替换字符过多，说明猜错了，退回
    latin-1 —— 至少不会把字节丢掉，后续还能按原始字节判断形态。
    """
    by_size = {len(raw): name for name, raw in streams.items()}

    for name, raw in streams.items():
        if len(raw) < 8 or (len(raw) - 4) % 4 != 0:
            continue
        count = (len(raw) - 4) // 4
        if count < 8:
            continue
        # 快速预筛：各项 cch 之和
        total = 0
        try:
            for index in range(count):
                total += struct.unpack_from("<H", raw, 4 + index * 4)[0]
        except struct.error:
            continue
        data_name = by_size.get(total)
        if data_name is None or data_name == name:
            continue
        strings = _parse_string_pool(raw, streams[data_name], encoding)
        if strings is not None:
            return strings, name, data_name

    raise MsiError("未找到字符串池：MSI 元数据流缺失或结构异常")


def _find_tables(streams: dict[str, bytes], strings: dict[int, str],
                 exclude: set[str]) -> tuple[list[str], str]:
    """找 _Tables：uint16 数组，值全部能映射到已知 MSI 表名。"""
    limit = max(strings) if strings else 0
    best: tuple[int, str, list[str]] | None = None

    for name, raw in streams.items():
        if name in exclude:
            continue
        values = _u16_array(raw)
        if not values or len(values) > 4096:
            continue
        if any(v > limit for v in values):
            continue
        names = [strings.get(v, "") for v in values]
        if not all(n in KNOWN_TABLES for n in names):
            continue
        if len(set(names)) != len(names):
            continue
        if best is None or len(names) > best[0]:
            best = (len(names), name, names)

    if best is None:
        raise MsiError("未找到 _Tables 流")
    return best[2], best[1]


def _find_columns(streams: dict[str, bytes], strings: dict[int, str],
                  table_names: list[str], exclude: set[str]
                  ) -> tuple[dict[str, list[Column]], str]:
    """找 _Columns 流。

    **实测格式（与多数文档描述的三元组不同）**：列主序的 4 个平行数组，
    每组 n 项，n = 总 u16 数 / 4：
        [0n, 1n)  表名对应的**字符串编号**（不是 _Tables 里的位置）
        [1n, 2n)  列序号（低 15 位有效，0x8000 表示临时列）
        [2n, 3n)  列名的字符串编号
        [3n, 4n)  列类型（本模块不用；实测取值不符合 msidbColumnType 枚举，
                  故不做解释，也不依赖它）

    用 PowerShell 7.4.6 的 MSI 实测：1600 字节 → 800 u16 → n=200，
    File 表 8 列，列名依次为 File / Component_ / FileName / FileSize /
    Version / Language / Attributes / Sequence，全部正确。
    """
    valid_table_ids = {key for key, value in strings.items()
                       if value in KNOWN_TABLES}
    if not valid_table_ids:
        raise MsiError("字符串池里没有可识别的 MSI 表名")

    limit = max(strings) if strings else 0
    best: tuple[int, str, dict[str, list[Column]]] | None = None

    for name, raw in streams.items():
        if name in exclude:
            continue
        values = _u16_array(raw)
        if not values or len(values) < 12 or len(values) > 400_000:
            continue

        for divisor in (4, 3):
            if len(values) % divisor != 0:
                continue
            n = len(values) // divisor
            if n < 4 or n > 20_000:
                continue

            table_ids = values[0:n]
            name_ids = values[2 * n:3 * n]
            type_codes = values[3 * n:4 * n] if divisor == 4 else [0] * n

            # 校验：表名编号合法、列名非空且能查到
            if not all(tid in valid_table_ids for tid in table_ids):
                continue
            if any(nid == 0 or nid > limit for nid in name_ids):
                continue
            if any(not strings.get(nid) for nid in name_ids):
                continue

            columns: dict[str, list[Column]] = {}
            for i in range(n):
                table_name = strings.get(table_ids[i], "")
                if not table_name:
                    continue
                bucket = columns.setdefault(table_name, [])
                bucket.append(Column(table=table_name,
                                     name=strings[name_ids[i]],
                                     number=len(bucket) + 1,
                                     type_code=type_codes[i]))

            # 至少要有 File 表且它有列，才算解析成功
            if not columns.get("File"):
                continue
            score = len(values)
            if best is None or score > best[0]:
                best = (score, name, columns)
            break

    if best is None:
        raise MsiError("未找到 _Columns 流")
    return best[2], best[1]


def _column_widths(table_columns: list[Column]) -> list[int]:
    """把列定义转成每列的字节宽度。

    ## 为什么需要宽度

    MSI 表的数据流是**列主序 + 变宽**：每列先按行数连续存放，但每列的
    元素宽度由列类型决定。字符串键（Text）占 2 字节，短整数占 2 字节，
    长整数占 4 字节。宽度算错会让列边界整体错位，读出来的值看着像
    「一堆无意义的大数」，而首列往往仍然正确 —— 这种半对半错最难发现。

    ## 宽度从类型码来，不靠列名

    `_Columns` 第 4 个数组的低字节就是宽度语义（实测 wine 生成的 MSI）：

      | 值 | 含义                   | 字节 |
      |----|------------------------|------|
      | 2  | 短整数（i2）           |  2   |
      | 4  | 长整数（i4）           |  4   |
      | 8 / 20 / 38 / 72 / 255 | 字符串容量       |  2   |

    按列名猜宽度曾经出过大错：把 `Sequence` 当成 4 字节，于是 File 表的
    行宽算成 20 而不是真实的 18。凑巧同目录有个 20 字节/行的
    `MsiFileHash` 流（File_ + Options + 4×Hash，行数也正好相同），于是
    它被认成了 File 表 —— 首列全是真实文件键，后面几列全是哈希垃圾。
    `file_mapping` 因此返回空列表，症状表现为「这个 MSI 解不出文件名」。

    类型码不可用时（`type_code == 0`，或旧的三元组布局）才退回按列名猜，
    并保守地只认 `FileSize`：它是唯一一个有硬证据必须 4 字节的列。
    """
    widths: list[int] = []
    for col in table_columns:
        low = col.type_code & 0xFF
        if low == 4:
            widths.append(4)
        elif low in (2, 8, 20, 38, 72, 255) or 0 < low < 0x80:
            # 已知的整数宽度与字符串容量都按 2 字节存放
            widths.append(2)
        else:
            # 类型码缺失：退回最保守的按名判断
            widths.append(4 if col.name == "FileSize" else 2)
    return widths


def _read_column(raw: bytes, offset: int, rows: int, width: int) -> list[int]:
    """读一列的全部值。列主序：这一列从 offset 起连续 rows 项。

    ## 4 字节整数的编码（踩过的坑）

    直觉做法是按 `<I` 一次读 4 字节，但那样读出来是 `2148470272` 这种
    荒谬的数。真实编码是**两个 u16，高位那个带 0x8000 标记**：

        低字 = 值 & 0xFFFF
        高字 = 0x8000 | (值 >> 16)

    实测 7-Zip 的 FileSize 列原始字节 `00 0e 0f 80`：
        低字 0x0e00 = 3584
        高字 0x800f → 0x000f
        合起来 986624 字节 ≈ 964 KB —— 与 7zFM.exe 的真实体积吻合。

    按 `<I` 直读得到的 2148470272 会让人以为列宽算错了，从而去改行宽，
    把本来正确的结构判断推向错误方向。这个标记位是唯一可靠的区分点。
    """
    if width == 4:
        out: list[int] = []
        for index in range(rows):
            low, high = struct.unpack_from("<HH", raw, offset + index * 4)
            if high & 0x8000:
                out.append(((high & 0x7FFF) << 16) | low)
            else:
                # 没有标记位时按普通 u32 处理，保持对其它编码的兼容
                out.append((high << 16) | low)
        return out
    return [struct.unpack_from("<H", raw, offset + i * 2)[0] for i in range(rows)]


def _fit_rows(raw: bytes, widths: list[int], check, feature_index: int) -> int:
    """在给定列宽下推断行数，并用「特征列」内容校验。

    ## 为什么校验的不是第一列

    早先只看第一列非空，任何流都能通过 —— 真实样本上 Component 与
    Directory 双双认错，取到了 Dialog 表的数据，拼出的目录树完全错误。

    正确的做法是校验**该表独有的形态**：

      File       第 0 列  fil<32hex> 或真实文件名
      Component  第 1 列  {GUID}（ComponentId）
      Directory  第 2 列  含 "|"（DefaultDir 的 SHORT|Long 写法）

    这些形态别的表不会有，误判概率接近零。

    @returns 行数；列宽或内容假设不成立时返回 0。
    """
    row_size = sum(widths)
    if row_size <= 0 or len(raw) < row_size:
        return 0
    if len(raw) % row_size != 0:
        return 0
    rows = len(raw) // row_size
    if rows <= 0 or rows > 200_000:
        return 0
    if feature_index >= len(widths):
        return 0

    offset = sum(rows * width for width in widths[:feature_index])
    width = widths[feature_index]
    if width != 2:
        # 特征列必须是字符串列（2 字节），否则下面按字符串池取值没意义
        return 0
    for value in _read_column(raw, offset, rows, width):
        if not check(value):
            return 0
    return rows


def _identify_table_streams(streams: dict[str, bytes], strings: dict[int, str],
                            columns: dict[str, list[Column]],
                            exclude: set[str]) -> dict[str, str]:
    """把数据流对到表名。

    判定条件必须同时满足：
      1. 流长度能被该表的整行字节数整除
      2. 第一列全部值都符合该表第一列的形态

    两条一起卡，误判概率极低。行数最多者优先（同签名下更大的表更可能
    是真表，而不是恰好形状相同的别的东西）。

    只处理 File / Directory / Component 三张表 —— 其余表缺少可判定的
    内容特征，宁可留空也不猜。
    """
    remaining = {n: raw for n, raw in streams.items() if n not in exclude}

    def is_file_key(key: int) -> bool:
        # File 第 0 列：文件键。两种形态都要认 ——
        #   fil<32hex>（Windows Installer 默认）
        #   真实文件名（WiX 等工具链，7-Zip 就是这种）
        text = strings.get(key, "") or ""
        return bool(_FILE_KEY_RE.match(text)) or _looks_like_filename(text)

    def is_component_id(key: int) -> bool:
        return bool(_GUID_RE.match(strings.get(key, "") or ""))

    #: Directory 表的根目录键。这些是 Windows Installer 规定的固定属性名，
    #: 一定会出现在 Directory 表的某一列里，且别的表不会有。
    DIRECTORY_ROOTS = frozenset({
        "TARGETDIR", "SourceDir", "ProgramFilesFolder", "ProgramFiles64Folder",
        "ProgramMenuFolder", "CommonFilesFolder", "CommonFiles64Folder",
        "DesktopFolder", "StartMenuFolder", "StartupFolder", "SendToFolder",
        "WindowsFolder", "WindowsVolume", "SystemFolder", "System16Folder",
        "System64Folder", "TempFolder", "FontsFolder", "AppDataFolder",
        "LocalAppDataFolder", "CommonAppDataFolder", "PersonalFolder",
        "NetHoodFolder", "PrintHoodFolder", "RecentFolder", "TemplatesFolder",
        "FavoritesFolder", "GlobalAssemblyCache", "AdminToolsFolder",
        "CommonDocumentsFolder", "ProgramFiles6432Folder",
    })

    def is_directory_key(key: int) -> bool:
        """Directory 表第 0 列：目录键。

        ## 真实键的形态（由 msidb 导出的 idt 逐一核对过）

            TARGETDIR
            WindowsFolder
            Microsoft.NET
            Microsoft.NET|Framework|v4.0.30319
            Microsoft.NET|DirectX for Managed Code
            Microsoft.NET|Framework|v3.0|windows communication foundation

        早期实现要求「无空格、不像文件名」，结果上面 26 行里有 14 行被
        拒掉，整张 Directory 表认不出来 → relpath 全部退化成纯文件名，
        目录结构丢失。而 `file_mapping` 依然返回数据，所以测试照绿。

        但**放得太宽同样有害**，而且危害更隐蔽：只要「非空、不含路径
        分隔符」就放行，那么几乎任何流的第一列都能通过 —— `Demo.exe`、
        `readme.txt` 全是合法候选。此时 Directory 签名会凭「行数最多」
        选中**任意一条流**，把 File 表的数据当成目录树读。

        实测后果：File 流（252 字节）按 Directory 的 6 字节行宽切出
        42 行，正好比真实的 14 行多，于是 Directory 抢走 File 流；
        接着 File 签名找不到可用的流，`file_mapping` 返回空列表。
        而表面上 `open_msi` 一切正常 —— 表名、列名、字符串池全对。

        所以判据必须能区分「标识符」与「文件名」：

          - 目录键没有扩展名形态（不带 `.`）
          - 不含路径分隔符（那是 File 键的形态）
          - 长度合理、非空

        这三个条件合起来，`readme.txt` / `logo.png` 不再是候选，而
        `Microsoft.NET`（含点但不在末段）仍然是 —— 用 `.` 是否出现在
        **最后一个点之后像扩展名** 来区分，与 `_looks_like_filename` 同源。

        真正把 Directory 表钉死的是 `has_directory_root()`（整条流里
        必须出现 `TARGETDIR` 这类固定根名），形态检查只负责挡掉明显
        不是目录键的流。两者缺一不可：只靠根名，File 流在错位切片下
        也可能偶然命中；只靠形态，几乎什么都能过。
        """
        text = strings.get(key, "") or ""
        if not text or len(text) > 255:
            return False
        if "/" in text or "\\" in text:
            return False
        # `|` 是 Directory 表的父路径分隔符（`A|B|C`），出现它必然是目录键。
        # 真实样本里 `Microsoft.NET|Framework|v4.0.30319` 就是这种形态。
        if "|" in text:
            return True
        # 没有 `|` 的纯名字：可能是 `Microsoft.NET` 这类含点的目录名，
        # 也可能是 `readme.txt` 这类文件名。区分点在于**扩展名是否像
        # 可执行/数据文件**。目录名里的「扩展名」通常是 NET / Code 这种
        # 技术词，而文件名是真扩展名。
        if _looks_like_filename(text):
            return not _FILE_EXTENSIONS_RE.search(text)
        return True

    def has_directory_root(raw: bytes, widths: list[int]) -> bool:
        """整条流里是否出现过 Directory 表的根目录名。

        这是比「整列形态」更硬的证据：`TARGETDIR` / `ProgramFiles64Folder`
        这类名字只在 Directory 表里出现。
        """
        row_size = sum(widths)
        if row_size <= 0 or len(raw) == 0 or len(raw) % row_size != 0:
            return False
        rows = len(raw) // row_size
        offset = 0
        for width in widths:
            if width == 2:
                for value in _read_column(raw, offset, rows, width):
                    if strings.get(value, "") in DIRECTORY_ROOTS:
                        return True
            offset += rows * width
        return False

    def is_shortcut_key(key: int) -> bool:
        """Shortcut 表第 0 列：快捷方式键。

        形态与 Directory 键相近（都是标识符），但 Shortcut 键**不允许**
        含 `.` —— 那会让它和真实文件名撞车（Shortcut 表里有个 Name 列
        专门放 `应用名.lnk`，第 0 列反而不带扩展名）。
        """
        text = strings.get(key, "") or ""
        if not text or len(text) > 72:
            return False
        if any(ch in text for ch in "/\\ .|"):
            return False
        return True

    def has_shortcut_target(raw: bytes, widths: list[int]) -> bool:
        """整条流里是否有 `[#...]` 形态的值（Shortcut 的 Target 列）。

        ## 这里踩过两个坑

        一开始想用「Name 列以 .lnk 结尾」当证据 —— 错的。MSI 的 Name 列
        只存快捷方式显示名（`7zipFM|7-Zip File Manager`），`.lnk` 是
        安装时按系统语言拼上去的，表里根本没有。

        改用 Target 列：指向文件的快捷方式写成 `[#FileKey]`，
        `[#` 这个前缀是 Shortcut 表独有的写法（File 与 Directory 表都不
        会以它开头）。
        """
        row_size = sum(widths)
        if row_size <= 0 or len(raw) == 0 or len(raw) % row_size != 0:
            return False
        rows = len(raw) // row_size
        offset = 0
        for width in widths:
            if width == 2:
                for value in _read_column(raw, offset, rows, width):
                    if (strings.get(value, "") or "").startswith("[#"):
                        return True
            offset += rows * width
        return False

    #: (表名, 特征列下标, 判定函数, 额外证据函数)
    signatures = [
        ("Component", 1, is_component_id, None),
        ("Directory", 0, is_directory_key, has_directory_root),
        ("Shortcut", 0, is_shortcut_key, has_shortcut_target),
        ("File", 0, is_file_key, None),
    ]

    result: dict[str, str] = {}
    used: set[str] = set()

    for table, feature_index, check, extra in signatures:
        cols = columns.get(table)
        if not cols or feature_index >= len(cols):
            continue
        widths = _column_widths(cols)
        best: tuple[int, str] | None = None
        for name, raw in remaining.items():
            if name in used:
                continue
            rows = _fit_rows(raw, widths, check, feature_index)
            if rows <= 0:
                continue
            if extra is not None and not extra(raw, widths):
                continue
            if best is None or rows > best[0]:
                best = (rows, name)
        if best is not None:
            result[table] = best[1]
            used.add(best[1])

    return result


# --------------------------------------------------------------------------
# 对外入口
# --------------------------------------------------------------------------


def open_msi(path: Path) -> MsiTables:
    """解析 MSI 元数据（字符串池、表名、列定义、数据流映射）。"""
    path = Path(path)
    try:
        doc = cfb.open_cfb(path)
    except cfb.CfbError as exc:
        raise MsiError(f"不是有效的 MSI 容器：{exc}") from exc

    streams: dict[str, bytes] = {}
    for entry in doc.entries:
        if not entry.is_stream or entry.size == 0:
            continue
        try:
            streams[entry.name] = doc.read_entry(entry)
        except cfb.CfbError:
            continue

    # ## 字符串池按 MSI 的 Codepage 解码
    #
    # 硬编码 latin-1 的后果：中文/日文/韩文包的所有表内容整片乱码。
    # 症状很有欺骗性 —— 表结构、行数、列数全对，只是字符串全是 `????`，
    # 于是 `file_mapping` 拼出的 relpath 里没有中文，看起来像「这个包
    # 本来就用英文名」。而 `_looks_like_filename` 之类的形态判断仍能
    # 通过（问号不影响形态），错误一路传到解包归位才暴露。
    codepage = cfb.read_codepage(doc)
    encoding = cfb.codepage_to_encoding(codepage)

    strings, pool_name, data_name = _find_string_pool(streams, encoding)
    exclude = {pool_name, data_name}

    table_names, tables_name = _find_tables(streams, strings, exclude)
    exclude.add(tables_name)

    columns, columns_name = _find_columns(streams, strings, table_names, exclude)
    exclude.add(columns_name)

    stream_map = _identify_table_streams(streams, strings, columns, exclude)

    return MsiTables(strings=strings, tables=table_names, columns=columns,
                     stream_map=stream_map)


def _rows(path: Path, tables: MsiTables, table: str) -> list[dict[str, str]]:
    """读某张表的数据行。

    ## 数据布局

    **列主序 + 变宽**：整张表按列依次存放，第 c 列从「前面所有列的总字节
    数」开始，连续 rows 项，每项宽度由列类型决定（2 或 4 字节）。

    早先的实现按「每列都是 2 字节、按 u16 下标切片」读取，在有 4 字节
    整数列的表上整体错位 —— File 表的 FileSize / Sequence 就是这类列。
    真实样本上表现为首列内容正确、后续列全错，而 `file_mapping` 直接
    返回空列表（因为 relpath 拼不出来）。

    rows 由「流长度 ÷ 整行字节数」得出，并要求第一列内容全部符合该表
    形态；不符合则放弃这张表，不返回错位数据。
    """
    stream_name = tables.stream_map.get(table)
    cols = tables.columns.get(table)
    if stream_name is None or not cols:
        return []

    try:
        doc = cfb.open_cfb(path)
        entry = doc.find(stream_name)
        if entry is None:
            return []
        raw = doc.read_entry(entry)
    except cfb.CfbError:
        return []

    widths = _column_widths(cols)
    row_size = sum(widths)
    if row_size <= 0 or len(raw) < row_size or len(raw) % row_size != 0:
        return []

    rows = len(raw) // row_size
    if rows <= 0:
        return []

    # 逐列读出原始值
    columns_values: list[list[int]] = []
    offset = 0
    for width in widths:
        columns_values.append(_read_column(raw, offset, rows, width))
        offset += rows * width

    result: list[dict[str, str]] = []
    for row_index in range(rows):
        row: dict[str, str] = {}
        for col_index, col in enumerate(cols):
            value = columns_values[col_index][row_index]
            # 宽度为 4 的列是整数，不是字符串池索引，原样转字符串
            if widths[col_index] == 4:
                row[col.name] = "" if value == 0 else str(value)
            else:
                row[col.name] = tables.strings.get(value, "") if value else ""
        result.append(row)
    return result


def file_table(path: Path) -> list[dict[str, str]]:
    """File 表：File / Component_ / FileName / FileSize / Version / …"""
    tables = open_msi(path)
    return _rows(Path(path), tables, "File")


def directory_table(path: Path) -> list[dict[str, str]]:
    """Directory 表：Directory / Directory_Parent / DefaultDir。"""
    tables = open_msi(path)
    return _rows(Path(path), tables, "Directory")


def component_table(path: Path) -> list[dict[str, str]]:
    """Component 表：Component / ComponentId / Directory_ / Attributes / …"""
    tables = open_msi(path)
    return _rows(Path(path), tables, "Component")


# --------------------------------------------------------------------------
# 文件名与目录还原
# --------------------------------------------------------------------------

SHORT_LONG_SEPARATOR = "|"


def resolve_filename(file_name: str) -> str:
    """FileName 列可能是 "SHORT~1.EXE|LongName.exe"，取长名。"""
    if SHORT_LONG_SEPARATOR in file_name:
        short, long = file_name.split(SHORT_LONG_SEPARATOR, 1)
        return long or short
    return file_name


def resolve_default_dir(default_dir: str) -> tuple[str, str]:
    """DefaultDir 列形如 "SHORT|Long" 或 "Source:Target"，返回 (短名, 长名)。

    ## `.` 与 `SourceDir` 是占位，不是目录名

    Windows Installer 规定：DefaultDir 为 `.` 表示「本目录沿用父级」，
    根节点（TARGETDIR）写 `SourceDir` 表示「安装源」。把 `.` 当成真实
    目录名会拼出 `./Microsoft.NET/Framework/...` 这种路径 —— 解包归位
    时会多出一层名为 `.` 的目录，`relpath` 也不再是干净的相对路径。

    真实样本（wine 生成的 .NET 安装器）的 `ProgramFilesFolder` 就是
    `TARGETDIR` + `.`，正是这条路。
    """
    target = default_dir.split(":", 1)[-1] if ":" in default_dir else default_dir
    if SHORT_LONG_SEPARATOR in target:
        short, long = target.split(SHORT_LONG_SEPARATOR, 1)
        target = long or short
    # `.` / `SourceDir` 都表示「这一级不新增名字」
    if target in (".", "SourceDir"):
        return "", ""
    return target, target


def build_directory_paths(directory_rows: list[dict[str, str]]) -> dict[str, str]:
    """Directory 表展开成 目录键 → 相对路径（正斜杠，无前导斜杠）。"""
    nodes: dict[str, tuple[str | None, str]] = {}
    for row in directory_rows:
        key = row.get("Directory", "")
        if not key:
            continue
        parent = row.get("Directory_Parent", "") or None
        _, long_name = resolve_default_dir(row.get("DefaultDir", ""))
        nodes[key] = (parent, long_name)

    resolved: dict[str, str] = {}

    def resolve(key: str, depth: int = 0) -> str:
        if key in resolved:
            return resolved[key]
        if depth > 64:
            return ""
        node = nodes.get(key)
        if node is None:
            return ""
        parent, name = node
        if parent is None or parent not in nodes:
            # 根节点（TARGETDIR / ProgramFilesFolder 等）：路径为空
            resolved[key] = ""
            return ""
        parent_path = resolve(parent, depth + 1)
        if not name:
            # DefaultDir 是占位（`.` / `SourceDir`）：这一级不新增名字，
            # 直接沿用父级路径。不这么处理会拼出 `./Microsoft.NET/...`。
            resolved[key] = parent_path
            return parent_path
        path = f"{parent_path}/{name}" if parent_path else name
        resolved[key] = path
        return path

    for key in list(nodes):
        resolve(key)
    return resolved


def file_mapping(path: Path) -> list[dict[str, str]]:
    """文件清单：[{file_key, filename, relpath, component, version}]。

    relpath 是相对安装根的路径，filename 是真实文件名。
    """
    tables = open_msi(path)
    files = _rows(Path(path), tables, "File")
    directories = _rows(Path(path), tables, "Directory")
    components = _rows(Path(path), tables, "Component")

    dir_paths = build_directory_paths(directories)
    component_dir = {row.get("Component", ""): row.get("Directory_", "")
                     for row in components}

    result: list[dict[str, str]] = []
    for row in files:
        file_key = row.get("File", "")
        if not file_key:
            continue
        filename = resolve_filename(row.get("FileName", ""))
        if not filename:
            continue
        component = row.get("Component_", "")
        dir_key = component_dir.get(component, "")
        rel_dir = dir_paths.get(dir_key, "")
        relpath = f"{rel_dir}/{filename}" if rel_dir else filename
        result.append({
            "file_key": file_key,
            "filename": filename,
            "relpath": relpath,
            "component": component,
            "version": row.get("Version", ""),
        })
    return result


def shortcut_table(path: Path) -> list[dict[str, str]]:
    """读 Shortcut 表：[{key, name, target, arguments, directory, component}]。

    ## 为什么值得单独解析

    快捷方式就是「用户会从哪儿启动这个程序」的权威答案 —— 它由安装包
    作者写下，比我们按体积/架构/图标猜出来的主程序候选可靠得多。

    Shortcut 表的 `Target` 列有三种写法，语义完全不同：

      `[#FileKey]`      → 指向 File 表里的某个文件（最常见）
      `[PropertyName]`  → 指向一个目录属性，这么写通常只是打开文件夹
      裸文件名           → 1.x 的旧写法，直接就是文件名

    先只认 `[#...]` 这一种。另外两种需要解析 Property 表与格式字符串，
    在拿到足够样本前不猜。
    """
    tables = open_msi(path)
    rows = _rows(Path(path), tables, "Shortcut")
    result: list[dict[str, str]] = []
    for row in rows:
        target = (row.get("Target") or "").strip()
        result.append({
            "key": row.get("Shortcut", ""),
            # Name 列是 "短名|长名"，与 FileName 同一种写法，复用同一个解析
            "name": resolve_filename(row.get("Name", "") or ""),
            "target": target,
            "arguments": row.get("Arguments", ""),
            "directory": row.get("Directory_", ""),
            "component": row.get("Component_", ""),
        })
    return result


def shortcut_targets(path: Path) -> list[dict[str, str]]:
    """把 Shortcut 表翻成「会启动哪个文件」的清单。

    只保留 `Target` 形如 `[#FileKey]` 且能在 File 表里找到对应文件的条目，
    返回 `[{relpath, name, arguments}]`，`relpath` 与 `file_mapping` 一致。

    找不到就返回空列表 —— 上游据此回退到启发式打分，而不是拿着一个
    解不出来的 Target 硬猜。
    """
    shortcuts = shortcut_table(path)
    if not shortcuts:
        return []

    files = file_mapping(path)
    by_key = {item["file_key"]: item for item in files}

    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in shortcuts:
        target = item["target"]
        if not (target.startswith("[#") and target.endswith("]")):
            continue
        file_key = target[2:-1]
        record = by_key.get(file_key)
        if record is None:
            # File 键大小写不敏感，退一步再找一次
            lowered = file_key.lower()
            record = next(
                (v for k, v in by_key.items() if k.lower() == lowered), None)
        if record is None:
            continue
        relpath = record["relpath"]
        if relpath in seen:
            continue
        seen.add(relpath)
        result.append({
            "relpath": relpath,
            "name": item["name"],
            "arguments": item["arguments"],
        })
    return result


def rename_cab_files(extract_root: Path, mapping: list[dict[str, str]]) -> tuple[int, int]:
    """把 cab 里解出的 fil<hex> 改名成真实文件名并移到目标目录。

    cab 内的文件名就是 File 表的 File 键，直接按 file_key 匹配。
    返回 (成功数, 失败数)。
    """
    import shutil

    by_key = {item["file_key"].lower(): item for item in mapping}
    ok = 0
    failed = 0

    for candidate in list(extract_root.rglob("*")):
        if not candidate.is_file():
            continue
        item = by_key.get(candidate.name.lower())
        if item is None:
            continue
        target = extract_root / "files" / item["relpath"]
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                target.unlink()
            shutil.move(str(candidate), str(target))
            ok += 1
        except OSError:
            failed += 1

    return ok, failed


__all__ = [
    "MsiError", "open_msi", "file_table", "directory_table", "component_table",
    "file_mapping", "build_directory_paths", "resolve_filename",
    "resolve_default_dir", "rename_cab_files", "KNOWN_TABLES",
    "shortcut_table", "shortcut_targets",
]