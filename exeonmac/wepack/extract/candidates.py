"""主 exe 候选打分。

解包出来的文件里，哪个是用户想双击的那个？规则要可解释、可复现，
每条加分/扣分都写进 reasons，让人能看出为什么选中了它。

打分是启发式，不是判定。命中失败时用户可用 --entry 手动指定。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import re

from .. import pe
from ..models import ExeCandidate

#: 命中即大幅扣分的文件名片段（典型非主程序）
#:
#: ## 子串匹配下，长条目会被短条目前缀吞掉
#:
#: 匹配用的是**子串**（`bad in name`）且命中即 `break`。所以若 `a` 是
#: `b` 的子串、且 `a` 排在 `b` 前面，`b` 永远不可能被命中 —— 任何含 `b`
#: 的名字必然含 `a`，循环在 `a` 处就跳出了。
#:
#: 上一版这里写着「条目有意重叠，各有目标」，并列举 `unins` 抓
#: `unins000.exe`、`uninstall` 抓完整拼写 —— **那是错的**。`unins` 是
#: `uninstall` 的前缀，`"unins" in "uninstall.exe"` 为真，`uninstall`
#: 这条一次都没执行过。把「理论上目标不同」当成「代码里真能命中」了。
#:
#: 已删的 6 条永不命中项：`uninst` / `uninstall`（被 `unins` 吞）、
#: `updater`（被 `update` 吞）、`dxsetup`（被 `setup` 吞）、
#: `vc_redist`（被 `redist` 吞）、`installer`（被 `install` 吞）。
#: 删掉不改变任何行为 —— 它们本来就没生效过。判断依据不是「看起来重复」，
#: 是 `a in b` 的字符串事实。
#:
#: 保留的短条目仍覆盖原来的长拼写：`unins` 命中 `uninstall.exe`，
#: `install` 命中 `InstallShield_xxx.exe`、`installer.exe`，
#: `setup` 命中 `dxsetup.exe`，`redist` 命中 `vc_redist.x64.exe`。
NEGATIVE_NAMES = (
    "unins", "setup", "install", "update",
    "crash", "report", "helper", "elevate", "vcredist",
    "dotnet", "redist",
    "repair", "register", "config", "settings", "diagnostic",
    "ffmpeg", "node", "python", "7za", "7zr", "aria2",
)

#: `NEGATIVE_NAMES` 里那些「既可能是辅助程序、也可能就是主程序」的词。
#:
#: ## 为什么必须单独列出来
#:
#: 这组词命中的是**同名不同角色**的情况：`node.exe` 在 Electron 应用里是
#: 运行库，但在 Node.js 安装包里就是用户要双击的那个东西；`config.exe`
#: 通常是个设置面板，可一个叫「Config」的产品主程序也叫这个名字。
#:
#: 实测踩到的错误（产品名 Node.js，解包结构取真实形态）：
#:
#:     1. uninstall.exe    5.0   ← 被选成主程序
#:     2. node.exe       -25.0   ← 真正的入口
#:
#: `node.exe` 明明拿到了「文件名与产品名近似」的 +20，随后又被 `node`
#: 无条件扣掉 45 —— **作者给主程序起的名字被自己的黑名单否掉了**。
#: 而 `uninstall.exe` 靠 GUI 子系统 +20 一路反超。用户双击后弹出卸载程序。
#:
#: 修法不是删掉这些词（它们在 Electron / Python 打包场景里仍然有效），
#: 而是：**产品名匹配命中时，这组词不再作为负面信号**。产品名来自安装包
#: 自带元数据，是「作者告诉我们这是谁」，比任何启发式都可信。
#:
#: ## `dotnet` 也必须在这张表里
#:
#: 它原来只在 `NEGATIVE_NAMES`，不在豁免表 —— 而运行时组件表里
#: `dotnet.exe` 是**可豁免**的（`RUNTIME_COMPONENTS_EXEMPTABLE`）。
#: 两套规则互相矛盾：排除层认「产品名是 .NET 时 dotnet.exe 就是主程序」，
#: 扣分层却照样扣 45 分。
#:
#: 实测（产品名 `Microsoft .NET Runtime`、目录里只有 `dotnet.exe`）：
#: `dotnet.exe` 拿 +20 近似分又被扣 45，总分负、直接掉出候选列表，
#: 整个目录返回**空** —— install 会报「找不到入口」。
AMBIGUOUS_NAMES = frozenset({
    "update", "report", "helper", "register",
    "config", "settings", "ffmpeg", "node", "python", "7za", "7zr", "aria2",
    "dotnet",
})

#: 命中即几乎排除的运行时组件。这些是安装器"顺带装上"的依赖，
#: 不是用户想双击的程序。实测 Electron 应用会连带安装 WebView2，
#: 里面有个 msedge.exe，体积与 GUI 特征都很像主程序，必须显式排除。
#:
#: 这张表同样受「子串 + break」的遮蔽约束（见 `NEGATIVE_NAMES` 的说明）：
#: 条目顺序不是随意的。若日后有人加一条 `"edge"`，排在它后面的 `msedge` /
#: `edgecore` 会全部失效，而表里还留着它们，看起来仍在生效。豁免项
#: （`chromium` / `electron.exe` / `dotnet.exe`）必须可达，否则豁免逻辑
#: 成了白写。
#:
#: ## 「互不为子串」是个错的表述（2026-11-22 复核更正）
#:
#: 这里早先写「当前 12 条互不为子串」，实测**不成立**：`webview2` 与
#: `msedge` 都是 `msedgewebview2` 的子串。真正要守的约束比它窄 ——
#: **不许有「更早的条目是更晚条目的子串」**，那才会让后者永远命中不到。
#: 当前方向恰好相反（长条目在前），所以无害：`msedgewebview2` 先命中即
#: `break`，本来就不需要再靠 `msedge` 去兜。守卫判的也是这个方向
#: （`test_no_runtime_component_is_shadowed`），与注释此前的措辞不一致 ——
#: 判据对、话说错了。
RUNTIME_COMPONENTS = (
    "msedgewebview2", "webview2", "edgecore", "msedge", "edgeupdate",
    "edge_webview", "chromium", "cefsharp", "electron.exe",
    "windowsdesktop-runtime", "dotnet.exe", "mscorsvw",
)

#: `RUNTIME_COMPONENTS` 里「本身也可能是产品」的项。
#:
#: 这组和 `AMBIGUOUS_NAMES` 是同一个道理，只是后果更重：`AMBIGUOUS_NAMES`
#: 里的词只扣 45 分，被错杀后还能靠别的加分爬回来；而 `RUNTIME_COMPONENTS`
#: 是**直接 return None**，错了就没有候选。
#:
#: 实测（产品名 Chromium，目录 `Chromium/chromium.exe`）：
#:
#:     一个候选都没有 —— 用户只能手动 --entry
#:
#: 而 Chromium 浏览器的主程序就叫 `chromium.exe`。WebView2 里的那份是
#: 运行库，Chromium 安装包里的那份是浏览器本体，区别只在于**哪个产品名
#: 在起作用**。产品名来自安装包元数据，是作者自己写的，比黑名单可信。
RUNTIME_COMPONENTS_EXEMPTABLE = frozenset({
    "chromium", "electron.exe", "dotnet.exe",
})

#: 路径片段：这些目录下的 exe 一律不是主程序。
#:
#: 比较前路径两侧会补斜杠（`padded_path`），所以条目要么带首斜杠
#: （`/windows/`）、要么靠补出来的那侧。`/$temp` / `/$pluginsdir` 原本缺
#: 尾斜杠，会命中 `$templates` / `$pluginsdirectory` 这类无关目录 ——
#: 虽然罕见，但这是「一律排除」的强规则，边界必须精确。
RUNTIME_PATH_MARKERS = (
    "/edgecore/", "/webview2/", "/microsoft/edge", "/dotnet/",
    "/windows/", "/common files/", "/$pluginsdir/", "/$temp/",
)

#: 同级目录里出现这些后缀，说明这是个「应用目录」而不是安装器临时区。
#:
#: ## 为什么收窄到这四个
#:
#: 原本这张表列了 `.dll` / `.json`，但两者毫无区分度 —— 几乎每个解包目录
#: 都有一堆 dll 和 json，命中等于没判断。留下的是「打包过的资源」专用
#: 后缀：`.pak`（Chromium/UE）、`.asar`（Electron）、`.resources`（.NET
#: 编译资源）、`.dat`（游戏与自解压包）。
#:
#: 这张表此前定义了却没人用（判断处硬编码了 `.pak` / `.asar` 两个），
#: 属于「文档承诺但代码不用」—— 现在接上，并让判断走这张表。
APP_DIR_HINTS = (".pak", ".asar", ".resources", ".dat")

#: 明显属于安装器内部临时目录的路径片段。
#:
#: ## 一律用正斜杠，别写反斜杠
#:
#: 匹配对象 `rel_lower` 来自 `Path.as_posix()`，**永远是正斜杠**。
#: 这里原本有一条 `"appdata\\local\\temp"`，含反斜杠，`in` 检查永远为假 ——
#: 一条从来没生效过的规则。`AppData/Local/Temp/setup_helper.exe` 实测
#: 拿不到这条 -60 扣分，只靠文件名里的 `setup` 掉到 -20；换个不带负面词
#: 的名字（`MyTool.exe`）就能拿 40 分，被当成主程序。
#:
#: ## `$INSTDIR` 为什么被移出去了
#:
#: 它原本和 `$TEMP` 并列，命中扣 60 分。但两者在 NSIS 里的语义完全不同：
#:
#:   - `$TEMP` / `$PLUGINSDIR` 是**安装器自己**的工作目录，解包出来的
#:     是安装逻辑的插件（nsProcess.dll 之类），确实不是应用内容；
#:   - `$INSTDIR` 是**用户选择的安装目标目录**。`$INSTDIR/App.exe` 就是
#:     用户要装的那个程序，把它当临时目录扣分等于反过来打击正确答案。
#:
#: 实测（`fixtures.demo_nsis()` 解包）7z 并不产出任何带 `$` 的顶层路径，
#: 载荷直接落在根目录 —— 这条规则防的是不存在的威胁。同样的理由，
#: `extract.SEVEN_ZIP_EXCLUDES` 里的 `$INSTDIR` 也一并去掉：排除一个
#: 不存在的目录是空操作，而万一某个 7z 版本真产出它，载荷会被静默丢掉。
TEMP_DIRS = (
    "$pluginsdir", "$temp", "$oldinstdir", "appdata/local/temp", "/temp/",
)

#: 单文件体积阈值
BIG_EXE = 200 * 1024
HUGE_EXE = 8 * 1024 * 1024


@dataclass(slots=True)
class ScoreContext:
    """打分需要的上下文，一次扫描算好，避免每个文件重复 stat。

    除了产品名，还缓存**目录特征**（同级 dll 数、资源后缀）。同一目录里
    常有好几个 exe（主程序 + 辅助程序），不缓存就要为每个 exe 把同目录
    重新枚举一遍 —— 实测同目录 800 个 exe 耗时 3.5 秒，其中绝大部分是
    重复 `iterdir`。
    """

    root: Path
    product_name: str | None = None
    product_words: tuple[str, ...] = ()
    _dir_features: dict[Path, tuple[int, frozenset[str]]] = field(
        default_factory=dict, repr=False)

    def dir_features(self, directory: Path) -> tuple[int, frozenset[str]]:
        """返回 (同级 dll 数, 同级文件后缀集合)，按目录缓存。

        只用来给「这是不是个应用目录」做启发式判断，不需要精确 —— 但
        **不能靠枚举顺序碰运气**。原先的实现是 `list(parent.iterdir())[:200]`，
        对同一目录反复枚举且只看前 200 条：目录里文件多时，dll 是否被统计
        取决于文件系统的返回顺序，同样的样本两次运行可能给出不同分数。
        现在一次枚举整目录并缓存，结果稳定且只付一次代价。
        """
        cached = self._dir_features.get(directory)
        if cached is not None:
            return cached
        try:
            entries = list(directory.iterdir())
        except OSError:
            entries = []
        dll_count = sum(1 for entry in entries if entry.suffix.lower() == ".dll")
        suffixes = frozenset(entry.suffix.lower() for entry in entries)
        features = (dll_count, suffixes)
        self._dir_features[directory] = features
        return features


def _normalize(text: str) -> str:
    """归一化用于比较：小写、去掉分隔符、去掉版本号数字。

    ## 为什么要删数字

    安装包与 exe 名常带版本号：`7-Zip 24.08`、`app_1.2.3`。不删的话
    「文件名与产品名一致」永远不可能命中。

    ## 但删数字会制造错位 —— 所以另有 `_squash`

    `7-Zip` 删掉 7 变成 `zip`，而 `7z.exe` 删掉 7 变成 `z` —— 两个都变形
    了，反而对不上。`_product_words` 因此额外收录一份**保数字**的形式
    （`_squash`），让 `7z` ↔ `7zip` 这类名字也能匹配上。
    """
    return "".join(ch for ch in _squash(text) if not ch.isdigit())


def _squash(text: str) -> str:
    """小写 + 去掉分隔符，保留数字。用于产品名比较的第二种形式。"""
    lowered = text.lower()
    for sep in ("-", "_", " ", ".", "+"):
        lowered = lowered.replace(sep, "")
    return lowered


def _product_words(name: str | None) -> tuple[str, ...]:
    """产品名拆成若干可比较的词，尽量不漏掉任何一种写法。

    实测的错位（`7-Zip` 安装包）：

        _normalize("7-Zip") = "zip"      _normalize("7z.exe")  = "z"
        _squash("7-Zip")    = "7zip"     _squash("7z.exe")     = "7z"

    只留 `_normalize` 时两者都对不上，`7z.exe` 拿 0 分、`7zFM.exe` 靠 GUI
    加分勉强胜出。补上 `_squash` 形式后 `7zip` ↔ `7z` 能互相包含。

    ## 单字符词直接丢弃

    `_normalize("7z")` 会把数字删成 `"z"` —— 这种单字符词在打分处本来就被
    `min(len(word), len(form)) >= 2` 挡住了，留着只是白比较一轮。更重要的
    是：若哪天有人调低那个阈值，单字符词会让 `"z"` 匹配上一切含 z 的名字。
    在一个「产品名只有一个字符」的极端情况下（产品名叫 `A`），保留它等于
    把阈值形同虚设。这里就掐掉，两层保险。

    ## 分词也要按点切

    原来只在 `-` / `_` 处切，`.NET` 这种带前导点的产品名会以 `.net` 的
    形态进词表 —— 而 exe 名的归一化形式是 `dotnet`，两边永远对不上。
    实测 `Microsoft .NET Runtime` 配 `dotnet.exe`：

        dotnet.exe 拿不到「文件名与产品名」的分（0 分而不是 +20）
        随后又被 NEGATIVE_NAMES 里的 `dotnet` 扣掉 45 分
        → 总分负，直接掉出候选列表，整个文件夹返回**空**

    一个装了 .NET 运行时的目录因此被认为「没有可执行程序」。这比选错
    程序更严重：后面 install 会报「找不到入口」。按点切开后 `net` 能对上
    `dotnet` 的后缀（打分器的近似匹配是双向包含）。
    """
    if not name:
        return ()
    words: set[str] = set()
    for form in (_normalize(name), _squash(name)):
        if len(form) >= 2:
            words.add(form)
    # 原始分词：处理 "Microsoft Visual Studio" → {"microsoft","visual","studio"}
    # 分隔符与 `_normalize` 用的那组保持一致（`.` 也算），否则 `.NET` 这类
    # 带点品牌会以带点的形态漏进词表。
    for part in re.split(r"[-_.\s]+", name.lower()):
        if len(part) >= 2:
            words.add(part)
    return tuple(words)


def score_exe(path: Path, relpath: str, ctx: ScoreContext) -> ExeCandidate | None:
    """给单个 exe 打分。不是有效 PE 时返回 None（直接排除）。"""
    try:
        size = path.stat().st_size
    except OSError:
        return None
    if size == 0:
        return None

    try:
        info = pe.parse(path)
    except pe.PeError:
        return None

    score = 0.0
    reasons: list[str] = []
    name = path.name.lower()
    rel_lower = relpath.lower()
    depth = rel_lower.count("/")
    # 两侧补斜杠再匹配目录片段，让「路径开头」和「路径结尾」也有边界。
    # 不补的话 `/temp/` 匹配不到顶层的 `temp/MyTool.exe` —— 根目录下的
    # 临时区恰恰是最常见形态（安装器先解到 temp 再搬走）。
    padded_path = f"/{rel_lower.strip('/')}/"

    # -- 位置 ---------------------------------------------------------
    if depth == 0:
        score += 25
        reasons.append("位于解包根目录")
    elif depth <= 2:
        score += 10
        reasons.append(f"位于第 {depth} 层目录")

    # `program files` 要带边界：`MyProgram Files/` 这种名字不该拿 Program
    # Files 的 +25。用 padded_path 判断，顺带覆盖路径开头的
    # `Program Files/...`（rel_lower 开头没有斜杠，`/program files` 匹配不上）。
    if "/program files" in padded_path:
        score += 25
        reasons.append("位于 Program Files 下")
    elif "/programfiles" in padded_path:
        score += 20
        reasons.append("位于 ProgramFiles 下")

    for temp in TEMP_DIRS:
        # `/temp/` 这类带斜杠的片段在 padded_path 上匹配（有边界），
        # `$temp` / `$pluginsdir` 这类变量名在 rel_lower 上匹配（NSIS 变量
        # 不会紧邻斜杠成词，也不必要求边界）。
        haystack = padded_path if temp.startswith("/") else rel_lower
        if temp in haystack:
            score -= 60
            reasons.append(f"位于安装器临时目录（{temp}）")
            break

    # `$PLUGINSDIR` 不在这里单独判：它已经在 `RUNTIME_PATH_MARKERS` 里被
    # **直接排除**（return None），任何含 `$pluginsdir` 的路径都走不到这一行。
    # 早先这里还有一段 `-80` 的扣分，是彻头彻尾的死代码 —— 而且和
    # `TEMP_DIRS` 里的 `$pluginsdir`（-60）语义重复，会让人误以为插件目录
    # 是「扣分排序」而非「直接排除」。

    # -- 子系统与架构 -------------------------------------------------
    if info.is_gui:
        score += 20
        reasons.append("GUI 子系统")
    else:
        # ## 扣分，但理由不能写成「不是主程序」
        #
        # 双击启动的场景里 GUI 程序更常见，所以扣分是对的。但措辞必须
        # 准确：PowerShell / Python / Node / Git 这类工具**主程序本身
        # 就是**控制台程序。实测 pwsh.msi 里 pwsh.exe 正是唯一入口，
        # 却被标注成「通常不是主程序」—— 理由与结论自相矛盾，用户看
        # 了会以为选错了。
        score -= 30
        reasons.append("控制台子系统（命令行工具的主程序也是这一类）")

    if info.arch in ("x86_64", "arm64"):
        score += 5
        reasons.append(f"{info.arch} 架构")

    if info.is_dotnet:
        score += 3
        reasons.append(".NET 程序")

    # -- 体积 ---------------------------------------------------------
    if size >= HUGE_EXE:
        score += 15
        reasons.append(f"体积 {size // 1024 // 1024} MB")
    elif size >= BIG_EXE:
        score += 10
        reasons.append(f"体积 {size // 1024} KB")

    # -- 文件名与产品名匹配 -------------------------------------------
    # 记下是否命中，后面判断负面信号要不要豁免时要看它。
    #
    # 两种形式都比：`_normalize` 去数字（对 `app_1.2.3` 有效），`_squash`
    # 保数字（对 `7z` ↔ `7zip` 有效）。只比一种必然漏掉一半场景 ——
    # 见 `_product_words` 里记的那次错位。
    matched_product = False
    exe_forms = tuple(f for f in (_normalize(path.stem), _squash(path.stem)) if f)
    for word in ctx.product_words:
        if not word:
            continue
        if exe_forms and word in exe_forms:
            score += 35
            matched_product = True
            reasons.append(f"文件名与产品名一致（{path.stem}）")
            break
        # 近似匹配：一方包含另一方，且短的一方有足够长度。
        # 阈值降到 2 是因为 `7z` / `vs` / `qq` 这类两字母品牌确实存在；
        # 再低（1）会让 `z` 匹配上一切含 z 的名字。
        if any(word in form or form in word
               for form in exe_forms if min(len(word), len(form)) >= 2):
            score += 20
            matched_product = True
            reasons.append(f"文件名与产品名近似（{path.stem}）")
            break

    # -- 运行时组件：直接排除，不参与排序 -----------------------------
    # 这些是安装器顺带装的依赖（WebView2 / Edge / .NET），不是主程序。
    # 扣分不够 —— 必须整体排除，否则 Electron 应用会选中 msedge.exe。
    #
    # 例外：产品名匹配且该项属于 RUNTIME_COMPONENTS_EXEMPTABLE 时放行。
    # 这里的错杀比 AMBIGUOUS_NAMES 严重得多 —— 那是扣分，这是直接没有候选。
    for marker in RUNTIME_COMPONENTS:
        if marker in name:
            if matched_product and marker in RUNTIME_COMPONENTS_EXEMPTABLE:
                reasons.append(
                    f"命中运行时组件名 {marker}，但与产品名匹配，按主程序处理")
                break
            return None

    # 路径标记两侧补上斜杠再比较，让 "/edgecore/" 也能匹配开头的 "EdgeCore/..."
    #
    # ## `/dotnet/` 要允许产品名豁免
    #
    # 其余标记（`/windows/`、`/common files/`、`/$pluginsdir/`）说的是「这是
    # 系统或安装器自己的地方」，与产品名无关 —— 产品名叫 Windows 也不该把
    # `windows/system32/x.exe` 当入口。`/dotnet/` 不同：它是一个**合法安装
    # 位置**。实测这些形态都被无条件排除，连真正的主程序一起消失：
    #
    #     dotnet/MyDotnetApp.exe       产品名 MyDotnetApp       → 空
    #     dotnet/MyDotnetApp.exe       产品名 MyDotnetApp 1.0   → 空
    #
    # 而 `.NET` 运行时本身装出来就是这个结构（`dotnet/dotnet.exe`），
    # `RUNTIME_COMPONENTS_EXEMPTABLE` 里也明确认了「产品名是 .NET 时
    # `dotnet.exe` 就是主程序」—— 组件名那层给了豁免，路径这层却一律排除，
    # 两处结论又矛盾。所以这里对 `/dotnet/` 单独允许产品名豁免，判据与组件
    # 名层一致（都看 `matched_product`）。
    padded_path = f"/{rel_lower.strip('/')}/"
    for marker in RUNTIME_PATH_MARKERS:
        if marker not in padded_path:
            continue
        if marker == "/dotnet/" and matched_product:
            reasons.append(
                "位于 dotnet/ 下，但与产品名匹配，按主程序处理")
            continue
        return None

    # -- 文件名负面信号 -----------------------------------------------
    # `matched_product` 为真时跳过 AMBIGUOUS_NAMES 里的词：产品名匹配说明
    # 这个文件名就是作者给主程序起的，不该再被自己的黑名单否掉。
    # `uninstall` / `setup` / `vcredist` 这类无歧义的词照旧扣分 ——
    # 「产品名叫 Uninstall」这种事不存在。
    for bad in NEGATIVE_NAMES:
        if bad not in name:
            continue
        if matched_product and bad in AMBIGUOUS_NAMES:
            reasons.append(f"文件名含 {bad}，但与产品名匹配，不扣分")
            break
        score -= 45
        reasons.append(f"文件名含 {bad}")
        break

    # -- 同级目录特征 -------------------------------------------------
    dll_count, resource_suffixes = ctx.dir_features(path.parent)
    if dll_count >= 3:
        score += 12
        reasons.append(f"同级有 {dll_count} 个 DLL（应用目录特征）")
    hit = resource_suffixes.intersection(APP_DIR_HINTS)
    if hit:
        score += 8
        shown = "/".join(sorted(hit))
        reasons.append(f"同级存在 {shown}（打包资源特征）")

    # -- 资源：版本信息与图标 -------------------------------------------
    # 资源目录只解析一次。`pe.product_metadata` 内部会调 `pe.version_strings`，
    # 后者又调 `pe.resources`；图标判断也要 `pe.resources` —— 各调一次就是
    # 把同一棵资源树走两遍、把同一个文件开两遍。
    try:
        entries = pe.resources(info)
    except pe.PeError:
        entries = []

    try:
        meta = pe.product_metadata(info, entries)
    except pe.PeError:
        meta = {}
    if meta.get("product_name"):
        score += 8
        reasons.append(f"有版本资源：{meta['product_name']}")
    original = (meta.get("original_filename") or "").lower()
    if original and original == name:
        score += 5
        reasons.append("版本资源 OriginalFilename 与文件名一致")

    # 图标资源是"这是给人点的程序"的强信号
    if any(r.type_id == pe.RT_GROUP_ICON for r in entries):
        score += 10
        reasons.append("含图标资源")

    return ExeCandidate(relpath=relpath, size=size, score=round(score, 1),
                        reasons=reasons)


def _looks_like_pe(path: Path) -> bool:
    """只看前 2 字节。MSI 解包出来的文件常没有扩展名。"""
    try:
        with open(path, "rb") as fh:
            return fh.read(2) == b"MZ"
    except OSError:
        return False


def rank_candidates(root: Path, *, product_name: str | None = None,
                    limit: int = 5, max_files: int = 4000,
                    max_probes: int = 4000,
                    include_extensionless: bool = True) -> list[ExeCandidate]:
    """扫描 root 下所有 exe，按分数降序返回前 limit 个。

    include_extensionless: MSI 的 cab 内文件名形如 `fil<32位hex>`，没有
    `.exe` 后缀。开启后对无后缀文件做 MZ 头探测，把它们也纳入候选。
    NSIS / Inno 解包不需要这个（文件名是真实的），默认开着也无害 ——
    只是多读 2 字节。

    ## 两个上限管的是不同东西

    `max_files` 限制**收到的候选数**，防止病态样本里几十万个 exe 把打分
    拖死。`max_probes` 限制**打开文件探头的次数**，防的是另一件事：
    无后缀文件每个都要打开读 2 字节，而探测失败的文件不进 `exe_paths`、
    不占 `max_files` 名额。实测 6000 个无后缀非 PE 文件配 `max_files=50`
    仍然耗时 7.8 秒 —— 与 `max_files=4000` 几乎相同，上限完全没起作用。

    两个上限分开是因为「用一次 open 换一个候选」和「用一次 open 换零个
    候选」的成本差着两个数量级，而后者在大安装包里很常见（一堆 `.dat`
    之类的无后缀资源）。达到 `max_probes` 后停止探测无后缀文件，但
    `.exe` 照常收集 —— 主程序几乎总是带 `.exe` 后缀，探测是为 MSI 那种
    哈希文件名准备的，不该让它反过来挤掉真候选。
    """
    ctx = ScoreContext(root=root, product_name=product_name,
                       product_words=_product_words(product_name))

    exe_paths: list[Path] = []
    probes = 0
    for path in root.rglob("*"):
        if len(exe_paths) >= max_files:
            break
        if not path.is_file():
            continue
        suffix = path.suffix.lower()
        if suffix == ".exe":
            exe_paths.append(path)
        elif include_extensionless and suffix not in (
            ".dll", ".sys", ".png", ".jpg", ".ico", ".bmp", ".txt", ".xml",
            ".json", ".js", ".map", ".pdb", ".cab", ".msi", ".mst", ".msp",
        ):
            if probes >= max_probes:
                continue
            probes += 1
            if _looks_like_pe(path):
                exe_paths.append(path)

    # 浅层优先，保证截断时先扫到根目录的 exe
    exe_paths.sort(key=lambda p: (len(p.relative_to(root).parts), str(p)))

    candidates: list[ExeCandidate] = []
    for path in exe_paths:
        rel = path.relative_to(root).as_posix()
        candidate = score_exe(path, rel, ctx)
        if candidate is not None:
            candidates.append(candidate)

    # 同分时的次序：浅层优先，再按路径字典序保证稳定。
    #
    # 这里用**路径层级**而不是 `len(relpath)`。两者不等价，字符长度会把
    # 文件名长度混进目录深度：实测 `d/e.exe`（深度 1、7 字符）在分数相同
    # 时排到了根目录的 `root-program-with-long-name.exe`（深度 0、31 字符）
    # 前面 —— 而「在根目录」是更强的信号，不该被一个短文件名反超。
    # 7-Zip 目录里 `7zG.exe` 压过 `7zFM.exe` 也是同一处退化：两者同为 GUI、
    # 同体积档，并列 50 分，最后靠文件名长度分胜负，纯属巧合。
    candidates.sort(key=lambda c: (
        -c.score,
        c.relpath.count("/"),
        len(c.relpath),
        c.relpath,
    ))
    return candidates[:limit]


def best_candidate(root: Path, *, product_name: str | None = None) -> ExeCandidate | None:
    """单个根目录下最可能的入口程序，没有候选时返回 None。

    这是「多根、每根取一个」循环内的那一步。安装后的 prefix 里入口可能落在
    Program Files、Program Files (x86)、AppData/Local 等多个位置，调用方
    要逐根试 —— 每根只需要第一名，把 `rank_candidates(limit=1)[0]` 散在
    各处既啰嗦又容易在空列表上越界。
    """
    ranked = rank_candidates(root, product_name=product_name, limit=1)
    return ranked[0] if ranked else None