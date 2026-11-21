"""测试夹具：现场构造安装包样本，不依赖开发者手工下载的文件。

## 为什么要现场造

早先这些测试靠环境变量指向开发者自己下好的样本：

    WEXE_SAMPLE_MSI=/path/to/app.msi
    WEXE_SAMPLE_INNO=/path/to/inno.exe
    WEXE_SAMPLE_NSIS=/path/to/setup.exe

没设变量就整类跳过。而**跳过在测试报告里是绿的** —— 24 项 MSI 表解析、
Inno 版本识别、NSIS 解包全部带着「skipped」标签通过，没人会去看。
等于守卫没在站岗，但没人发现。

真实样本还有第二个问题：内容随版本变化。断言写死「106 个文件」，
换个版本全崩，于是又改成宽松断言，越改越测不出东西。

现场构造则两个问题都没有：结构由测试精确控制，任何机器上都能跑，
也不需要网络。

## 三类样本的来源策略

| 类型 | 策略 | 原因 |
|------|------|------|
| MSI  | 纯 Python 构造（`msibuild`） | 结构可精确控制，零外部依赖 |
| NSIS | 调 `makensis` 编译 | 有本机工具；手写 NSIS 二进制不现实 |
| Inno | 调 ISCC 在 wine 下编译 | 解包精度只能靠真载荷验证；合成骨架测不了 `-e` / `-d` 语义 |

NSIS 需要 `makensis`，Inno 需要 ISCC + wine。缺工具时**如实跳过**并写清
原因，而不是伪造一个「看起来像 NSIS / Inno」的文件 —— 后者会让
`detect_installer` 的置信度断言变成自我欺骗。

Inno 的工具链（Inno Setup 6.0.5）首次运行时自动下载到
`~/.cache/wexe-toolchain/`，用 `innoextract -e` 抽文件（不需要跑 GUI
安装器），之后走缓存。**版本锁在 6.0.5 是有意的**：`innoextract 1.9`
的支持上限就是 6.0.5，夹具版本一旦超过它，「解包成功路径」会以「版本
过旧」为由静默跳过 —— 跳过在报告里是绿的，缺陷照样溜过去。
`TestRealInnoPayload.test_version_within_innoextract_cap` 专门守这件事。

## 合成骨架与真实产物并存

`demo_inno()` 造的是**只有标记**的骨架，用途单一但不可替代：覆盖
ASCII 与 UTF-16LE 两种标记编码的**检测**逻辑，零依赖、零等待。
真实解包路径请用 `demo_inno_real()`。两者分开，是为了让「测检测器」
的测试不必背上「编译 + wine 13 秒」的成本。

## 坏样本也必须从好样本派生

`demo_msi_truncated()` 不手写坏字节，而是把 `demo_msi()` 的**完整合法**
产物按比例砍掉尾巴。区别是决定性的：手写坏字节只能测到解析器对某个
特定值的反应，换个字节就失效；而「合法容器被砍掉尾巴」才是真实场景
（下载中断），解析器会沿着合法的 FAT 链走到越界处，复现出真实症状。

这条路径曾把一次误判变成一次真实修复：109 MB 的真实 MSI 只下到 13 MB
时，报错是「非法扇区号 0xfffffffd」，而该值在 [MS-CFB] 里完全合法。

## 缓存

`makensis` 单次要 0.2 秒，几十个测试各编一次会明显拖慢。这里编到
临时目录并做进程内缓存，同一进程复用同一个文件。

不用 `tempfile.mkdtemp` 挂模块级变量：那样文件永远不清理。这里用
`tempfile.TemporaryDirectory` 的对象持有引用，进程退出时自动删除。
"""

from __future__ import annotations

import os
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path

_HERE = Path(__file__).resolve().parent

# --------------------------------------------------------------------------
# 延迟导入（tests/ 不是包，需把自身目录放进 sys.path）
# --------------------------------------------------------------------------

import sys as _sys

if str(_HERE) not in _sys.path:
    _sys.path.insert(0, str(_HERE))
if str(_HERE.parent) not in _sys.path:
    _sys.path.insert(0, str(_HERE.parent))

import cfbwrite  # noqa: E402
import msibuild  # noqa: E402


# --------------------------------------------------------------------------
# 缓存目录
# --------------------------------------------------------------------------

_cache_dir: tempfile.TemporaryDirectory | None = None


def cache_dir() -> Path:
    """进程内共享的临时目录，进程退出时由 Python 自动删除。"""
    global _cache_dir
    if _cache_dir is None:
        _cache_dir = tempfile.TemporaryDirectory(prefix="wexe-fixtures-")
        # ## 为什么注册 atexit 而不是只靠 GC
        #
        # 不显式清理的话，解释器退出时才由 GC 回收，Python 会打一句
        # `ResourceWarning: Implicitly cleaning up <TemporaryDirectory ...>`。
        # 它不影响结果，却会在报告末尾制造噪音 —— 而且将来真有目录泄漏
        # 时，也会被同一句「implicitly cleaning up」盖过去，等于把真问题
        # 藏进已知噪音里。
        import atexit

        atexit.register(_cleanup_cache)
    return Path(_cache_dir.name)


def _cleanup_cache() -> None:
    """删掉夹具临时目录。可重复调用（atexit 与测试收尾都可能触发）。"""
    global _cache_dir
    if _cache_dir is not None:
        try:
            _cache_dir.cleanup()
        except Exception:   # noqa: BLE001 - 清理失败不该影响测试结果
            pass
        _cache_dir = None


# --------------------------------------------------------------------------
# 工具探测
# --------------------------------------------------------------------------


def find_makensis() -> Path | None:
    """定位 makensis。找不到返回 None（调用方据此如实跳过）。"""
    found = shutil.which("makensis")
    if found:
        return Path(found)
    for directory in ("/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"):
        candidate = Path(directory) / "makensis"
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    return None


def find_7z() -> Path | None:
    """定位一个**真的能跑**的 7z。

    ## 为什么要冒烟测试

    `shutil.which("7zz")` 会先撞上转发壳：某些环境里 `7zz` 是个只做
    转发的脚本，文件存在、可执行，但真正跑起来返回非 0。项目自己的
    `tools.find_tool` 有冒烟测试会跳过它，但**跳过之后就再没往下找**，
    于是 BlueStacks 里那个能用的 `7zz` 永远轮不到。

    这里对每个候选都跑一次 `i`（打印版本信息），返回码 0 才认。
    """
    candidates: list[Path] = []

    from wepack import tools

    tool = tools.find_tool("7z", required=False)
    if tool is not None:
        candidates.append(tool.path)

    for name in ("7zz", "7z", "7za"):
        found = shutil.which(name)
        if found:
            candidates.append(Path(found))

    # 应用包内自带的 7zz（BlueStacks 就带了一个可用的）
    for app in ("/Applications/BlueStacks.app/Contents/MacOS/7zz",
                "/Applications/Keka.app/Contents/Resources/kekaqt.app/"
                "Contents/Resources/7zz"):
        candidate = Path(app)
        if candidate.is_file():
            candidates.append(candidate)

    for candidate in candidates:
        if _seven_zip_works(candidate):
            return candidate
    return None


def _seven_zip_works(binary: Path) -> bool:
    """跑 `i` 子命令验证二进制真的可用。"""
    try:
        result = subprocess.run([str(binary), "i"], capture_output=True,
                                timeout=30)
    except (OSError, subprocess.SubprocessError):
        return False
    if result.returncode != 0:
        return False
    # 输出里应出现 7-Zip 的标识，避免把别的同名程序当成 7z
    text = (result.stdout + result.stderr).decode("utf-8", "replace").lower()
    return "7-zip" in text or "p7zip" in text


# --------------------------------------------------------------------------
# MSI 样本
# --------------------------------------------------------------------------

_msi_cache: dict[str, Path] = {}


def demo_msi(*, product: str = "Demo", codepage: int = 1252,
             variant: str = "default", files: int = 30) -> Path:
    """构造一个结构完整的 MSI：多层目录 + 多条文件 + 两条快捷方式。

    ## 为什么要有 `files` 参数

    断言 `file_mapping` 返回 10 条以上，不是为了凑数，而是要验证
    **批量解析不丢行**：列主序 + 变宽的读取最容易在行数多时出现
    「前几行对、后面错位」，只有一两条数据看不出来。所以夹具默认放
    30 个文件，分布在三层目录里。

    ## 目录层次

    `Demo/bin`、`Demo/bin/plugins`、`Demo/docs` 三层。只有一层的样本
    测不出 relpath 拼接 —— `file_mapping` 非空、文件名也对，只是所有
    文件都挤在根上，看起来完全正常。

    ## 两条快捷方式

    一条指向 exe（真入口），一条指向 .txt（非可执行）。后者用来验证
    「入口选取必须跳过非可执行目标」。
    """
    key = f"{variant}-{product}-{codepage}-{files}"
    cached = _msi_cache.get(key)
    if cached is not None and cached.is_file():
        return cached

    # 文件名里不能有路径分隔符或空格，用 variant 区分
    path = cache_dir() / f"demo-{abs(hash(key)):x}.msi"
    msibuild.build_demo_msi(path, product=product, codepage=codepage,
                            file_count=files)
    _msi_cache[key] = path
    return path


def demo_msi_chinese() -> Path:
    """中文 MSI（Codepage 936）。

    存在的意义是**锁住编码处理**：字符串池与 SummaryInformation 都按
    MSI 的 Codepage 解码。写死 latin-1 时，英文样本全绿、中文样本全乱，
    而乱码不会让任何断言失败（`????` 依然是合法字符串）。
    """
    return demo_msi(product="示例产品", codepage=936, variant="cn")


def demo_msi_truncated(*, keep_ratio: float = 0.55,
                       variant: str = "default") -> Path:
    """把一个**完整合法**的 MSI 按比例截断，模拟下载中断。

    ## 为什么必须从完整样本截出来

    手写一个「看起来像截断」的文件没有意义：那样只能测到解析器对某个
    特定坏字节的反应，换个字节就失效。真实场景是「合法容器被砍掉尾巴」，
    必须让头、DIFAT、FAT 全部先是真的，再把数据砍掉 —— 这样解析器才会
    沿着合法的 FAT 链走到越界处，复现出真实症状。

    ## 复现的症状（实测 109 MB 的 pwsh.msi 只下到 13 MB 时）

        CfbError: 非法扇区号：0xfffffffd

    这句话把「文件不全」报成了「结构非法」，于是排查方向被引到 CFB
    规范上去，去查 FATSECT 是不是合法值 —— 而它本来就合法，问题在于
    文件根本没有那么多扇区。修复后应报 ``CfbTruncatedError`` 并说明
    实际字节数与声明扇区数。

    `keep_ratio` 取 0.55 而非更小的值：太小可能砍在 FAT 之前，走的是
    「读不到 FAT」而非「链走到特殊值」；0.55 实测能稳定命中后者。
    """
    full = demo_msi(variant=variant)
    data = full.read_bytes()
    cut = max(1024, int(len(data) * keep_ratio))
    # 对齐到扇区边界，避免「截断在扇区中间」这个次要因素干扰主判据
    cut -= (cut - 512) % 512
    path = cache_dir() / f"demo-{abs(hash((variant, keep_ratio, 'trunc'))):x}.msi"
    path.write_bytes(data[:cut])
    return path


# --------------------------------------------------------------------------
# NSIS 样本
# --------------------------------------------------------------------------

_nsis_cache: dict[str, Path] = {}

_NSIS_SCRIPT = """\
; 最小 NSIS 安装包：一个 exe + 若干数据文件，装到 $INSTDIR
Unicode true
Name "Demo Setup"
OutFile "{outfile}"
InstallDir "$PROGRAMFILES\\Demo"
RequestExecutionLevel user
SilentInstall silent

Section "Main"
  SetOutPath "$INSTDIR"
{file_lines}
SectionEnd
"""

#: 载荷文件数。`verify_install` 要求至少 8 个文件、1 MiB，
#: 太小的包装完会被判成「空转」。这里放 12 个，主程序做 1.5 MB。
_NSIS_FILE_COUNT = 12


def _incompressible(seed: int, size: int) -> bytes:
    """生成不可压缩的伪随机字节。

    ## 为什么载荷必须不可压缩

    NSIS 默认用 zlib 压整个载荷。如果夹具放的是全零填充或重复文本，
    1.7 MB 会被压到 2 KB —— 产物只剩 41 KB，`verify_install` 的
    「至少 1 MiB」门槛永远达不到，端到端测试就永远测的是失败路径。

    真实安装包里的 exe/dll 本来就是高熵数据（压缩过的代码、资源），
    压不动。用确定性伪随机数模拟这一点：不引入 `random` 的全局状态，
    同一个 seed 永远产出同一串字节，测试可重复。
    """
    out = bytearray(size)
    state = seed & 0xFFFFFFFF
    for index in range(size):
        # xorshift32：够快、周期够长、无外部依赖
        state ^= (state << 13) & 0xFFFFFFFF
        state ^= state >> 17
        state ^= (state << 5) & 0xFFFFFFFF
        out[index] = state & 0xFF
    return bytes(out)


def _build_payload_exe(path: Path) -> None:
    """造一个最小但合法的 PE32+，让解包后的候选评分有真东西可看。

    只用 MZ + PE 签名 + 一个 `.text` 节区。够 `wepack.pe` 认出它是 PE、
    够 `rank_candidates` 给出分数，不需要真的能跑起来。

    ## 为什么不从 test_phase1 借 `build_min_pe`

    夹具必须能独立构造样本，不该反向依赖测试模块 —— 那是循环依赖，
    而且会把「导入测试模块」与「构造样本」这两件事绑在一起（详见
    README 15.20：`test_phase1` 早先确实在模块级求值夹具，导致
    `test_phase2` 借一个纯函数时踩到假 wine）。
    """
    path.write_bytes(minimal_pe())


def minimal_pe(*, machine: int = 0x8664, subsystem: int = 2,
               overlay: bytes = b"") -> bytes:
    """最小可解析的 PE32+（x86_64）。

    布局：DOS 头（64 字节，e_lfanew=0x80）+ PE 签名 + COFF 头 +
    可选头（PE32+ 是 240 字节）+ 一个 `.text` 节区。

    只求 `wepack.pe.parse` 能读出 machine / subsystem / 节区表，不求能执行。
    """
    SECTION_ALIGN = 0x1000
    FILE_ALIGN = 0x200

    section_name = b".text\0\0\0"
    section_data = b"\xc3" * 16              # 一个 ret，凑数
    section_raw = section_data + b"\0" * (FILE_ALIGN - len(section_data))

    dos = bytearray(0x80)
    dos[0:2] = b"MZ"
    struct.pack_into("<I", dos, 0x3C, 0x80)  # e_lfanew

    coff = struct.pack("<HHIIIHH",
                       0x8664 if machine == 0x8664 else machine,
                       1,            # NumberOfSections
                       0, 0, 0,      # TimeDateStamp / PointerToSymbolTable / NumberOfSymbols
                       240,          # SizeOfOptionalHeader（PE32+）
                       0x22)         # Characteristics: EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE

    opt = bytearray(240)
    struct.pack_into("<H", opt, 0, 0x20B)          # PE32+
    struct.pack_into("<H", opt, 68, subsystem)     # Subsystem
    struct.pack_into("<I", opt, 56, SECTION_ALIGN) # SizeOfImage
    struct.pack_into("<I", opt, 60, FILE_ALIGN)    # SizeOfHeaders

    section = bytearray(40)
    section[0:8] = section_name
    struct.pack_into("<I", section, 8, 16)          # VirtualSize
    struct.pack_into("<I", section, 12, 0x1000)     # VirtualAddress
    struct.pack_into("<I", section, 16, len(section_raw))   # SizeOfRawData
    struct.pack_into("<I", section, 20, FILE_ALIGN)         # PointerToRawData
    section[36:40] = struct.pack("<I", 0x60000020)  # CODE | EXECUTE | READ

    body = bytes(dos) + b"PE\0\0" + coff + bytes(opt) + bytes(section)
    body += b"\0" * (FILE_ALIGN - len(body) % FILE_ALIGN if len(body) % FILE_ALIGN else 0)
    return body + section_raw + overlay


def demo_nsis() -> Path | None:
    """用 makensis 现场编译一个 NSIS 安装包。

    返回 None 表示本机没有 makensis —— 调用方应如实跳过，并在跳过原因
    里写清「未安装 makensis」，而不是伪装成样本缺失。

    ## 载荷规模

    放 12 个文件（主 exe 1.5 MB，其余几十 KB），总量 2 MB 出头。
    不是为了「像真的一样大」，而是 `verify_install` 的判定门槛是
    「至少 8 个文件且至少 1 MiB」—— 太小的包装完会被判成空转，
    端到端测试就永远测不到成功路径。
    """
    cached = _nsis_cache.get("demo")
    if cached is not None and cached.is_file():
        return cached

    makensis = find_makensis()
    if makensis is None:
        return None

    work = cache_dir() / "nsis"
    work.mkdir(parents=True, exist_ok=True)

    # 主程序：真 PE + 高熵尾巴，撑到 1.5 MB。
    # 尾巴必须是伪随机而不是全零 —— 全零会被 zlib 压成几十字节，
    # 整个安装包只剩 40 KB，装出来达不到 1 MiB 门槛。
    main_exe = work / "Demo.exe"
    if not main_exe.is_file():
        body = minimal_pe()
        main_exe.write_bytes(body + _incompressible(1, 1_500_000 - len(body)))

    # 其余文件：dll 用真 PE 头 + 高熵主体（候选评分会看 PE 头），
    # 文本写成高熵数据（真实安装包里的 .txt 也多是日志/许可，压不动）
    payloads: list[Path] = [main_exe]
    for index in range(1, _NSIS_FILE_COUNT):
        if index % 3 == 0:
            path = work / f"lib-{index:02d}.dll"
            if not path.is_file():
                path.write_bytes(minimal_pe() + _incompressible(index, 40_960))
        else:
            path = work / f"data-{index:02d}.txt"
            if not path.is_file():
                path.write_bytes(_incompressible(index, 60_000))
        payloads.append(path)

    file_lines = "\n".join(f'  File "{path}"' for path in payloads)

    outfile = work / "demo-setup.exe"
    script = work / "demo.nsi"
    script.write_text(_NSIS_SCRIPT.format(outfile=outfile,
                                          file_lines=file_lines),
                      encoding="utf-8")

    # makensis 的退出码：0 成功，1 警告，>1 失败
    result = subprocess.run(
        [str(makensis), "-V2", str(script)],
        capture_output=True, timeout=120)
    if result.returncode > 1 or not outfile.is_file():
        raise RuntimeError(
            f"makensis 编译失败（退出码 {result.returncode}）："
            f"{result.stderr.decode('utf-8', 'replace')[-500:]}")

    _nsis_cache["demo"] = outfile
    return outfile


# --------------------------------------------------------------------------
# Inno 样本
# --------------------------------------------------------------------------

_INNO_MAGIC = b"Inno Setup Setup Data ("

#: Inno Setup 工具链缓存位置。
#:
#: ## 为什么要落到 ~/.cache 而不是临时目录
#:
#: 装一次是 11 MB、85 个文件，每次跑测试重解一遍没有意义。放 ~/.cache
#: 是 XDG 约定的缓存语义：删掉不会有任何损失，下次自动重建。
INNO_TOOLCHAIN_CACHE = Path.home() / ".cache" / "wexe-toolchain"

#: 下载源：Inno Setup 官方 GitHub releases。
#:
#: ## 为什么锁定 6.0.5 而不是最新版
#:
#: `innoextract 1.9`（Homebrew 当前的版本）只支持到 Inno **6.0.5**。
#: 用它去解 6.2.2 以上的包会如实失败，于是「解包成功路径」这条测试
#: 永远只能跳过 —— 而跳过的原因看起来像环境缺失，实际是**夹具版本
#: 选错了**。锁到 innoextract 的支持上限，才测得到真实成功路径。
INNO_SETUP_VERSION = "6.0.5"
INNO_SETUP_URL = (
    "https://github.com/jrsoftware/issrc/releases/download/"
    f"is-{INNO_SETUP_VERSION.replace('.', '_')}/"
    f"innosetup-{INNO_SETUP_VERSION}.exe"
)


def find_iscc() -> Path | None:
    """定位 Inno Setup 编译器 ISCC.exe。

    三条路，按成本从低到高：
      1. 环境变量 `WEXE_ISCC` 直指二进制（CI 里预置用）；
      2. 缓存目录里已有（上次解出来的）；
      3. 本机装着 Inno Setup（wine prefix 里）。

    返回 None 表示确实没有，调用方据此降级到合成夹具。
    """
    override = os.environ.get("WEXE_ISCC")
    if override:
        candidate = Path(override).expanduser()
        if candidate.is_file():
            return candidate

    cached = INNO_TOOLCHAIN_CACHE / f"innosetup-{INNO_SETUP_VERSION}" / "ISCC.exe"
    if cached.is_file():
        return cached

    for prefix in (Path.home() / ".wine",
                   Path.home() / "Library" / "Application Support" / "wexe" / "prefix"):
        candidate = prefix / "drive_c" / "Program Files (x86)" / "Inno Setup 6" / "ISCC.exe"
        if candidate.is_file():
            return candidate
    return None


def _install_inno_toolchain() -> Path | None:
    """下载并解出 ISCC.exe 到缓存目录，返回 ISCC 路径。

    ## 为什么是「下载安装器再解它」而不是下 zip

    Inno Setup 官方只发 .exe 安装器，没有便携版 zip。解它恰好可以用
    我们自己已经依赖的 innoextract —— 用 `--silent` 装不了（那要 wine
    跑 GUI），但 `-e` 直接抽文件就够了，编译器本身不依赖注册表。

    整个过程只发生在首次运行，之后走缓存。
    """
    import urllib.request

    target = INNO_TOOLCHAIN_CACHE / f"innosetup-{INNO_SETUP_VERSION}"
    iscc = target / "ISCC.exe"
    if iscc.is_file():
        return iscc

    extractor = None
    try:
        from wepack import tools

        extractor = tools.find_tool("innoextract", required=False)
    except Exception:       # noqa: BLE001 - 探测失败当作没有
        extractor = None
    if extractor is None:
        return None

    target.mkdir(parents=True, exist_ok=True)
    installer = target / f"innosetup-{INNO_SETUP_VERSION}.exe"
    if not installer.is_file():
        try:
            with urllib.request.urlopen(INNO_SETUP_URL, timeout=180) as response:
                installer.write_bytes(response.read())
        except Exception:   # noqa: BLE001 - 没有网络就降级，不抛给调用方
            return None

    # innoextract 会把应用文件放在 `<out>/app/` 下
    staging = target / "_staging"
    result = extractor.run(
        ["--silent", "-e", "-m", "-d", str(staging), str(installer)], timeout=300)
    if result.returncode != 0:
        return None

    app_dir = staging / "app"
    source = app_dir if app_dir.is_dir() else staging
    for child in source.iterdir():
        destination = target / child.name
        if destination.exists():
            continue
        if child.is_dir():
            shutil.copytree(child, destination)
        else:
            shutil.copy2(child, destination)
    shutil.rmtree(staging, ignore_errors=True)
    installer.unlink(missing_ok=True)

    return iscc if iscc.is_file() else None


def _wine_for_build() -> Path | None:
    """编译夹具要用的 wine 二进制。"""
    try:
        from wepack.install import wine_binary

        binary = wine_binary()
        return binary if binary.is_file() else None
    except Exception:       # noqa: BLE001
        return None


def demo_inno_real() -> Path | None:
    """**真实编译**一个 Inno Setup 安装包，返回 .exe；做不到返回 None。

    ## 为什么要真编译

    `innoextract` 支持的格式细节（压缩算法、内部文件表布局、目录语义）
    只有真编译产物才能覆盖。合成夹具只能证明「检测器认得那串标记」，
    证明不了「解包链路能把应用文件还原到正确目录」—— 而后者才是用户
    真正会碰到的路径。

    ## 载荷

    主程序 1.5 MB（高熵尾巴，防止 lzma2 把它压成几十字节），外加
    dll/txt 若干。为的是让 `verify_install` 的「至少 1 MiB」门槛能被
    真实跨过，而不是靠夹具放宽标准。
    """
    cached = _inno_cache.get("real")
    if cached is not None and cached.is_file():
        return cached

    iscc = find_iscc() or _install_inno_toolchain()
    if iscc is None:
        return None
    wine = _wine_for_build()
    if wine is None:
        return None

    work = cache_dir() / "inno"
    work.mkdir(parents=True, exist_ok=True)
    build = work / "src"
    build.mkdir(exist_ok=True)

    # 主程序：真 PE + 高熵尾巴
    main_exe = build / "Demo.exe"
    if not main_exe.is_file():
        body = minimal_pe()
        main_exe.write_bytes(body + _incompressible(7, 1_500_000 - len(body)))

    # 辅助文件：一个 dll（真 PE 头）+ 若干文本
    (build / "Demo.dll").write_bytes(minimal_pe() + _incompressible(11, 40_960))
    (build / "readme.txt").write_bytes(b"wexe Inno fixture\n" + _incompressible(13, 60_000))

    script = build / "demo.iss"
    script.write_text(_INNO_SCRIPT, encoding="utf-8")

    prefix = work / "prefix"
    env = dict(os.environ)
    env["WINEPREFIX"] = str(prefix)
    env["WINEDEBUG"] = "-all"

    result = subprocess.run(
        [str(wine), str(iscc), script.name],
        capture_output=True, timeout=300, env=env, cwd=str(build))
    outfile = build / "demo-setup.exe"
    if not outfile.is_file():
        detail = (result.stderr or result.stdout or b"").decode("utf-8", "replace")[-500:]
        # ## 退出码 0 但没产物，与「编译失败」是两件事
        #
        # 实测踩到过：`WEXE_HOME` 被指到临时目录后，`wine_binary()` 解析成
        # 测试自己塞进去的假 wine（只 `exit 0`），ISCC 什么也没编、退出码
        # 干净、stderr 空。此时报「ISCC 编译失败（退出码 0）」会让下一个
        # 看到它的人往编译器上找原因，而问题在**用哪个 wine 跑**。
        # 和 15.19 同属「退出码 0 的假成功」，所以至少要让报错说清是哪一种。
        if result.returncode == 0 and not detail.strip():
            raise RuntimeError(
                "ISCC 退出码 0 但没生成产物 —— 这个 wine 什么也没做：\n"
                f"  wine = {wine}\n"
                f"  WEXE_HOME = {os.environ.get('WEXE_HOME', '(未设置)')}\n"
                "多半是测试把 WEXE_HOME 指到了临时目录、那里只有一个只 "
                "exit 0 的假 wine；也可能是 wine 自身损坏。")
        raise RuntimeError(f"ISCC 编译失败（退出码 {result.returncode}）：{detail}")

    _inno_cache["real"] = outfile
    return outfile


#: Inno Setup 编译脚本。
#:
#: `Compression=lzma2` 与真实产品一致；不带 `SolidCompression` 是为了让
#: `-m` 与 `-e` 的语义差异清楚可见。
_INNO_SCRIPT = """[Setup]
AppName=Demo
AppVersion=1.0.0
DefaultDirName={autopf}\\Demo
DefaultGroupName=Demo
OutputDir=.
OutputBaseFilename=demo-setup
Compression=lzma2
UninstallDisplayIcon={app}\\Demo.exe

[Files]
Source: "Demo.exe"; DestDir: "{app}\\bin"; Flags: ignoreversion
Source: "Demo.dll"; DestDir: "{app}\\bin"; Flags: ignoreversion
Source: "readme.txt"; DestDir: "{app}\\docs"; Flags: ignoreversion

[Icons]
Name: "{group}\\Demo"; Filename: "{app}\\bin\\Demo.exe"
"""


def demo_inno(*, version: str = "6.0.0", wide: bool = False) -> Path:
    """合成一个 Inno Setup 安装包（只含标记，不含真载荷）。

    ## 什么时候用它，什么时候用 `demo_inno_real`

    这个函数造的是**只有标记的骨架**，用途受限但不可替代：覆盖
    「ASCII 标记」与「UTF-16LE 标记」两种编码的检测与版本读取。

    真实解包路径请用 `demo_inno_real()` —— 它需要 ISCC + wine，
    可选；这个函数零依赖，测检测器时不必承担那套成本。

    ## 两套编码都要覆盖（`wide` 参数）

    实测 Inno 7.1.1 的安装器，标记是 **ASCII**：

        b'Inno Setup Setup Data (7.1.1)\\x00...'

    而 Unicode 版（6.x 起可选）是 UTF-16LE，每字符后跟一个 0 字节。
    两者都要能读 —— 早先的检测代码只按 ASCII 查，Unicode 版包会被
    整个判成 unknown。所以两条路径各有测试。

    ## 结构

    Inno 的检测依据是载荷里的 `Inno Setup Setup Data (x.y.z)` 标记。
    这里造一个 PE32，把标记追加在 PE 镜像之后（overlay）—— 与真实
    文件一致：Inno 的载荷就是追加在 stub 后面的。

    默认版本是 `6.0.0`（不是 `6.2.2`）：合成骨架的版本号会被
    「innoextract 能否支持」的判断读走。写成超出支持上限的版本，会让
    一个只需要「检测」的测试去背一个它根本不该承担的跳过条件。
    """
    key = f"{version}-{int(wide)}"
    cached = _inno_cache.get(key)
    if cached is not None and cached.is_file():
        return cached

    pe = minimal_pe()

    marker = f"Inno Setup Setup Data ({version})"
    overlay = bytearray()
    encoding = "utf-16-le" if wide else "latin-1"
    overlay.extend(marker.encode(encoding))
    overlay.extend(b"\0\0")
    # 几个真实存在于 Inno 安装包里的字符串，作为辅助证据
    for text in ("Inno Setup", "SetupLdr"):
        overlay.extend(text.encode(encoding))
        overlay.extend(b"\0\0")
    overlay.extend(b"\0" * 64)      # 尾部填充，保证标记不贴边

    path = cache_dir() / f"inno-{version}-{'wide' if wide else 'ascii'}.exe"
    path.write_bytes(pe + bytes(overlay))
    _inno_cache[key] = path
    return path


_inno_cache: dict[str, Path] = {}


# --------------------------------------------------------------------------
# 真实 wine 运行时探测
# --------------------------------------------------------------------------


def wine_available() -> bool:
    """本机是否有可用的 wine 运行时。

    ## 为什么要自动探测而不是要求设环境变量

    早先的写法是 `REAL_WINE = os.environ.get("WEXE_REAL_WINE") == "1"`，
    于是**wine 明明装着，3 项集成测试却永远跳过**。跳过在报告里是绿的，
    看起来「全部通过」。

    wine 是 wexe 自己的运行时，`wine_binary()` 本来就会去真实位置找。
    有就用，没有才跳过 —— 这样才符合「守卫是否在站岗」的判断标准。
    """
    if os.environ.get("WEXE_REAL_WINE") == "0":
        return False        # 显式关闭仍然尊重
    try:
        from wepack.install import wine_binary

        return wine_binary().is_file()
    except Exception:       # noqa: BLE001 - 探测失败一律当作不可用
        return False


def base_layer_available() -> bool:
    """base 层是否已构建（真实启动测试需要它）。"""
    try:
        from wepack import paths

        base = paths.layers_root() / "base"
        return (base / "drive_c" / "windows" / "notepad.exe").is_file()
    except Exception:       # noqa: BLE001
        return False


# --------------------------------------------------------------------------
# 惰性样本入口（测试模块唯一允许的取夹具方式）
# --------------------------------------------------------------------------
#
# ## 为什么样本一律走函数，不走模块级常量
#
# 早先 `test_phase1` / `test_phase2` / `test_phase3` 都在模块顶层写
#
#     SAMPLE_NSIS = os.environ.get(...) or str(fixtures.demo_nsis() or "")
#
# 于是**导入一个测试模块 = 现场跑一次 makensis / ISCC 编译**。看起来只是
# 「慢一点」，实际后果是：任何改了 `WEXE_HOME` 或 `PATH` 的用例，只要在
# 之后导入这些模块（`test_phase2` 只为借 `build_min_pe` 就 import
# `test_phase1`），编译就会落到假工具上 —— 假工具 `exit 0` 什么也没编，
# 抛 `RuntimeError: makensis 编译失败（退出码 0）：`，detail 为空。整类
# 用例消失，而 `check_no_skips.py` 只看 `Ran N tests` 与 skipped，抓不到。
#
# 分界线就一条：**函数体在调用时执行，模块体在导入时执行**。
# 夹具放进函数，导入就只剩「定义函数」这一件无副作用的事。
#
# 进程内缓存是必要的（NSIS 一次 0.4 秒、Inno 一次 13 秒），但缓存键跟着
# 环境变量走 —— 先设 `WEXE_SAMPLE_INNO` 再取值与环境变量为空时取值，
# 必须得到不同结果，否则「环境变量生效」这件事会被缓存掩盖。

_SAMPLE_CACHE: dict[tuple[str, str], str] = {}


def _cached(key: str, env_name: str, build) -> str:
    """按「名字 + 该样本对应的环境变量现值」缓存。

    只按名字缓存会让「先取值、后设环境变量」得到旧结果 —— 而测试恰恰
    会改环境变量再断言环境变量生效。键里带上环境变量现值，两种顺序
    都能得到各自正确的结果。
    """
    cache_key = (key, os.environ.get(env_name, ""))
    if cache_key not in _SAMPLE_CACHE:
        _SAMPLE_CACHE[cache_key] = build()
    return _SAMPLE_CACHE[cache_key]


def sample_nsis() -> str:
    """真实 NSIS 安装包（makensis 现场编译）。缺 makensis 时返回空串。"""
    return _cached("nsis", "WEXE_SAMPLE_NSIS",
                   lambda: os.environ.get("WEXE_SAMPLE_NSIS") or str(demo_nsis() or ""))


def sample_inno() -> str:
    """合成 Inno 骨架：只有标记，够测检测与版本读取，零依赖。"""
    return _cached("inno", "WEXE_SAMPLE_INNO",
                   lambda: os.environ.get("WEXE_SAMPLE_INNO") or str(demo_inno()))


def sample_msi() -> str:
    """纯 Python 构造的 MSI，零外部依赖。"""
    return _cached("msi", "WEXE_SAMPLE_MSI",
                   lambda: os.environ.get("WEXE_SAMPLE_MSI") or str(demo_msi()))


def real_inno() -> str:
    """真编译产物：ISCC + wine 现场编译，约 13 秒。**只在用例要跑时才调**。"""
    return _cached("real-inno", "WEXE_SAMPLE_INNO",
                   lambda: os.environ.get("WEXE_SAMPLE_INNO") or str(demo_inno_real() or ""))


def reset_sample_cache() -> None:
    """清掉进程内样本缓存（测试改环境变量后要重新取）。"""
    _SAMPLE_CACHE.clear()


def require_sample(getter, reason: str):
    """在 `setUpClass` 里取夹具：拿不到就如实跳过，拿到就返回路径。

    替代 `@unittest.skipUnless(常量 and ...)` —— 装饰器在**导入时**求值，
    正是上面那段踩坑的入口；`setUpClass` 在用例真跑时才求值。

    返回 `Path`；夹具不存在时抛 `unittest.SkipTest`，原因原样带出，
    不伪装成「样本缺失」。
    """
    import unittest
    from pathlib import Path

    value = getter()
    if not value or not Path(value).is_file():
        raise unittest.SkipTest(reason)
    return Path(value)


def wine_ready() -> bool:
    """`wine_available()` 的别名，语义是「此刻」而非「导入时」。

    存在的理由：模块级 `REAL_WINE = fixtures.wine_available()` 会在导入时
    定型，之后哪怕环境中出现了 wine 也永远为 False（跳过在报告里是绿的）。
    统一走函数，每次问都重新探测。
    """
    return wine_available()


__all__ = [
    "cache_dir", "find_makensis", "find_7z",
    "demo_msi", "demo_msi_chinese", "demo_msi_truncated",
    "demo_nsis", "demo_inno", "demo_inno_real",
    "sample_nsis", "sample_inno", "sample_msi", "real_inno",
    "reset_sample_cache", "require_sample",
    "wine_available", "wine_ready", "base_layer_available",
]
