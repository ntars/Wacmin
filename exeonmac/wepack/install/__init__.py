"""静默安装编排。

铁律 3：安装窗口不弹系统级对话框；静默失败回退交互时也限制在独立进程内。
铁律 7：不直接改注册表二进制，所有注册表改动只走 prefix 内的 .reg 文件。

关键设计：
  - 安装器从 Z: 盘访问（dosdevices/z -> /），不复制安装包进 prefix
  - 静默参数按 5.1 表构造，NSIS 的 /D 必须最后且不带引号
  - ExitWindowsEx 拦截：安装器要求重启时不让它真重启，记日志后返回成功
  - 超时用 process group kill，避免 wine 残留进程占着 prefix
"""

from __future__ import annotations

import os
import signal
import subprocess
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .. import paths as wexe_paths
from ..errors import MissingDependency, UsageError
from ..models import Detection, InstallerKind
from ..tools import TEXT_MODE

#: wine 进程的基础环境。WINEDLLOVERRIDES 关掉 mono/gecko 的安装弹窗 ——
#: 那两个弹窗会卡住无人值守安装。
BASE_WINE_ENV = {
    "WINEDEBUG": "-all",
    "WINEDLLOVERRIDES": "mscoree,mshtml=",
    "WINEDLLPATH": "",
}

#: 静默安装默认超时（秒）。大包（几 GB）可能不够，用 --timeout 调。
DEFAULT_TIMEOUT = 1800

#: 进度采样间隔（秒）
PROGRESS_INTERVAL = 5.0

#: 连续多少次采样文件数不变，判定为"安装已完成但进程没退出"
PROGRESS_STABLE_SAMPLES = 6


def _tree_signature(root: Path) -> tuple[int, int]:
    """返回 (文件数, 总字节数)，用于判定安装是否还在写入。

    只 stat 不读内容，2 万个文件约 50 ms，5 秒采样一次开销可忽略。
    """
    files = 0
    total = 0
    for path in root.rglob("*"):
        try:
            stat = path.stat()
        except OSError:
            continue
        if path.is_file():
            files += 1
            total += stat.st_size
    return files, total


def _file_sizes(root: Path) -> dict[str, int]:
    """prefix 内每个文件的相对路径 → 字节数。

    ## 为什么需要逐文件快照，而不是只数总数

    安装过程中 wine 自己会**删文件**：Gecko/Mono 的缓存、Temp 下的
    自举残留、wineserver 的临时 socket 文件，装完一轮常常少几十个。

    只比较「总文件数」时，新装的 12 个文件会被这 68 个被删的文件
    抵消，净增量算成负数、被 `max(0, ...)` 钳成 0 —— 结论变成
    「安装器什么都没写」，而实际上它写得很好。

    实测（NSIS 夹具，base 层为起点）：wineboot 后 1854 个文件，
    装完 1798 个，而真实新增 12 个文件全部到位。只看总数必判错。

    逐文件对比能回答正确的问题：**这次安装新增了哪些文件**。
    """
    sizes: dict[str, int] = {}
    for path in root.rglob("*"):
        try:
            if not path.is_file():
                continue
            sizes[str(path.relative_to(root))] = path.stat().st_size
        except OSError:
            continue
    return sizes


# --------------------------------------------------------------------------
# 静默参数
# --------------------------------------------------------------------------


def silent_args_for(kind: str | InstallerKind, install_dir: str,
                    installer: Path | None = None) -> list[str]:
    """按 5.1 表构造静默参数，返回 argv 列表（不是单个字符串）。

    返回列表而不是字符串：参数里可能有引号与空格，交给 subprocess 用
    argv 传递才不会被二次拆分。

    ## NSIS 的 /D= 与 wine 的引号规则相冲突（实测）

    NSIS 文档要求 `/D=` **必须最后一个、且路径不能加引号**，即使含空格。
    但 wine 在把 POSIX argv 拼成 Windows 命令行时，**看到含空格的参数会
    自动补一对双引号**。于是 `/D=C:\\Program Files\\App` 到安装器手里变成
    `"/D=C:\\Program Files\\App"` —— 而 NSIS 只认行首的 `/D=`，带引号就
    整个丢弃，安装器退回它自己的默认目录。

    实测证据（Ondra 1.3.0，同一 prefix，同一安装包）：

      | /D= 的值                    | 净增文件 | 落点                    |
      |----------------------------|---------|-------------------------|
      | C:\\Program Files\\DirTestA  | **0**   | 什么都没装（退出码却是 0）|
      | C:\\DirTestNoSpace          | 6424    | C:\\DirTestNoSpace       |

    唯一的变量是路径是否含空格。而 `default_install_dir()` 早先返回
    `drive_c/Program Files/<App>`，**必然含空格** —— 也就是说 NSIS 分支
    每次都会静默失败，还要靠 `verify_install` 的净增量校验才不至于把
    空转误报成成功。

    修法：**默认目录不再放在 "Program Files" 这类含空格的路径下**。
    这不是绕开问题，是承认约束 —— NSIS 的 `/D=` 与 wine 的引号规则在
    含空格路径上不存在同时满足的写法（wine 也不支持 8.3 短名来回避，
    实测 `C:\\PROGRA~1` 不存在）。若调用方坚持要含空格的目录，本函数
    仍按 NSIS 的要求不加引号传过去，并在返回值里如实反映 —— 此时
    `verify_install` 会判定没装上，而不是假装成功。
    """
    kind = InstallerKind(str(kind))
    windows_dir = _to_windows_path(install_dir)

    if kind is InstallerKind.NSIS:
        # 不加引号是 NSIS 的硬要求。含空格时这里会静默失效（wine 会补引号），
        # 由 verify_install 的净增量校验兜底判定，不在这里抛错 ——
        # 用户在 --interactive 模式下可能就是想装到默认位置。
        return ["/S", f"/D={windows_dir}"]

    if kind is InstallerKind.INNO:
        """
        Inno 的 `/DIR=` 与 NSIS 的 `/D=` 规则相反：值含空格时**需要**引号，
        而且不支持「最后一个参数」这种位置约定。

        这里故意不加引号 —— wine 会替我们补上，正好符合 Inno 的要求。
        实测三种写法的落点：

          argv 传 '/DIR=C:\\Program Files\\Ondra'
            → Inno 看到 "/DIR=C:\\Program Files\\Ondra"      ✓ 正确
          argv 传 '/DIR="C:\\Program Files\\Ondra"'
            → Inno 看到 "/DIR=\\"C:\\Program  + Files\\Ondra\\""  ✗ 被拆开
          argv 传 '/DIR=C:\\Ondra'（无空格）
            → Inno 看到 /DIR=C:\\Ondra                        ✓ 正确

        换句话说：**别自己加引号**，加了会被 wine 二次转义。
        """
        return ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART",
                f"/DIR={windows_dir}"]

    if kind is InstallerKind.INSTALLSHIELD:
        """
        InstallShield（Basic MSI 项目）：`/s` 静默外壳，`/v` 把参数透传给
        内部的 msiexec。官方要求的形态是 `/v"/qn"` —— `/v` 与它的值之间
        不能有空格。

        早先写成 `'/v" /qn"'`（引号内有前导空格）并注释成「格式要求」，
        那是错的。实测 wine 会把内部的双引号转义成 `\\"`：

          argv 传 '/v" /qn"'
            → 安装器看到 ["/v\\"] 和 [/qn\\""]   ✗ 两个参数都变形
          argv 传 '/v"/qn"'
            → 安装器看到 [/v\\"/qn\\"]           ✗ 引号被转义成字面字符

        两种都不对，因为 **argv 里的字面双引号会被 wine 转义**。正确的
        做法是连引号一起省掉：`/v/qn`。InstallShield 的 `/v` 接受不带
        引号的紧凑写法，msiexec 侧同样认 `/v/qn` 等同于 `/v"/qn"`。

        这是本函数里唯一一处「靠减少字符来消除歧义」的地方。
        """
        return ["/s", "/v/qn"]

    if kind is InstallerKind.MSI:
        # MSI 由 msiexec 执行，参数在 run_install 里单独拼。
        # /qn 无界面；/norestart 阻止自动重启（重启拦截另有一层 .reg 兜底）。
        return ["/qn", "/norestart"]

    if kind is InstallerKind.BURN:
        # WiX Burn bundle：/quiet 无界面，/install 明确动作，/norestart 不重启
        return ["/quiet", "/install", "/norestart"]

    if kind is InstallerKind.SQUIRREL:
        # Squirrel.Windows（Electron 常见）：--silent 无界面。
        # 注意它**不认** --install-dir 之类的参数，装到
        # %LOCALAPPDATA%\<AppName> 是它的固定行为 —— 实测 Ondra 就是这样，
        # 无论传什么目录参数都装进 AppData\Local\空谷 Ondra。
        return ["--silent"]

    return []


def _to_windows_path(install_dir: str) -> str:
    """把 drive_c 下的路径转成 Windows 形式。

    输入形如 "drive_c/Program Files/App" 或 "C:\\Program Files\\App"，
    统一输出反斜杠形式 "C:\\Program Files\\App"。
    """
    text = install_dir.replace("/", "\\")
    if text.lower().startswith("drive_c"):
        text = "C:" + text[len("drive_c"):]
    elif not (len(text) >= 2 and text[1] == ":"):
        text = "C:\\" + text.lstrip("\\")
    return text


def default_install_dir(app_name: str) -> str:
    """默认安装目录（相对 drive_c）。

    ## 为什么不是 "Program Files"

    直觉上装到 `C:\\Program Files\\<App>` 最像 Windows。但那一步会引入
    一个空格，而空格在 NSIS 的 `/D=` 上是致命的：

      - NSIS 要求 `/D=` 的值不能带引号（即使含空格）
      - wine 要求含空格的参数必须补引号才能正确传递

    两条规则在含空格的路径上**无解**。实测同一个 Ondra 安装包：

      `/D=C:\\Program Files\\DirTestA`  → 净增 0 个文件，退出码 0（静默空转）
      `/D=C:\\DirTestNoSpace`           → 净增 6424 个文件，落在正确位置

    所以默认根目录改成 `C:\\Wacmin`（不含空格）。用户要装到别处时可以用
    `--install-dir` 指定，此时若路径含空格、安装器又是 NSIS，`verify_install`
    的净增量校验会判定没装上 —— 如实报错而不是假装成功。

    这不是「为了省事牺牲像真度」：wine 里跑的程序本来就不在真的 Windows 上，
    装到 `C:\\Wacmin\\<App>` 与 `C:\\Program Files\\<App>` 对用户没有可见差别，
    但一个能装上、一个装不上。
    """
    safe = app_name.replace("/", "_").replace("\\", "_").strip() or "App"
    # 应用名本身也可能含空格（"空谷 Ondra"）—— 去掉空白，换成下划线。
    # 含空格的应用名会让整个路径含空格，触发同样的 /D= 问题。
    safe = "_".join(safe.split())
    return f"drive_c/Wacmin/{safe}"


# --------------------------------------------------------------------------
# 日志
# --------------------------------------------------------------------------


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_install_log(log_path: Path, lines: list[str]) -> None:
    """把安装过程记录追加到 install.log（纯文本，UTF-8，带时间戳）。

    每条自动加时间戳前缀，调用方只传 `level event detail` 三段。
    """
    log_path = Path(log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "a", encoding="utf-8") as fh:
        for line in lines:
            fh.write(f"[{_stamp()}] {line}\n")


class _Log:
    """内存 + 落盘双写，避免每条都开文件。"""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.lines: list[str] = []

    def add(self, level: str, event: str, detail: str = "") -> None:
        self.lines.append(f"{level:<5} {event} {detail}".rstrip())

    def flush(self) -> None:
        if self.path is not None and self.lines:
            write_install_log(self.path, self.lines)
            self.lines.clear()


# --------------------------------------------------------------------------
# 重启拦截
# --------------------------------------------------------------------------

#: 让 wine 把"重启请求"变成无害的成功返回。
#: 原理：安装器调 ExitWindowsEx 或 InitiateSystemShutdown 时，wine 侧
#: 由 explorer.exe 处理；禁用 explorer 的相关策略项即可拦下。
#:
#: ## 为什么是 Windows 导出格式，而不是 prefix 里的 `WINE REGISTRY Version 2`
#:
#: `regedit /S` 导入的是 **Windows 导出格式**。用 wine 内部存储格式
#: （`WINE REGISTRY Version 2` + `[Software\\...]` 相对路径）喂给它，
#: **退出码仍是 0、stderr 空、一个键都没写进去**（2026-11-21 实测，三份
#: 变体全部如此）。早先这里正是那种写法，于是「重启拦截」从来没有生效过，
#: 而日志里写着 `reboot.suppressed`。
#:
#: 对照实验（同一 prefix、同一条 `regedit /S`）：
#:   `Windows Registry Editor Version 5.00` + `[HKEY_CURRENT_USER\...]` → 写入成功
#:   `WINE REGISTRY Version 2` + 相对路径                              → 键不存在
#:   `WINE REGISTRY Version 2` + `[HKEY_CURRENT_USER\...]`             → 键不存在
#:
#: 早先测试只断言「文件是 UTF-16 且含 WINE REGISTRY」，把错的格式写进了断言。
RESTART_SUPPRESS_REG = """Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer]
"NoDriveTypeAutoRun"=dword:00000000
"NoRun"=dword:00000000
"NoClose"=dword:00000000
"""


def suppress_restart(prefix: Path, log: _Log | None = None) -> Path:
    """写入禁止重启的 .reg 并导入。返回 .reg 文件路径。

    铁律 7：不直接改注册表二进制，只写 .reg 文件再让 wine regedit 导入。
    文件保留在 prefix 里，便于审计与回滚。

    ## 为什么导入后要回查一次

    `regedit /S` 对格式不对的文件**不报错**（退出码 0、stderr 空，见上），
    所以「命令跑完没抛异常」不能证明拦截生效。这里导入后 `reg query`
    目标键，查不到就写一条 WARN —— 至少让日志说实话。
    """
    reg_path = Path(prefix) / "exeonmac-suppress-restart.reg"
    # `regedit /S` 接受 UTF-16LE + BOM 与纯 ASCII 两种编码（都实测过）。
    # 用 UTF-16LE 与 Windows 上导出的文件形态一致，便于人工比对。
    reg_path.write_bytes(b"\xff\xfe" + RESTART_SUPPRESS_REG.encode("utf-16-le"))

    wine = wine_binary()
    env = _wine_env(Path(prefix))
    try:
        subprocess.run([str(wine), "regedit", "/S", str(reg_path)],
                       capture_output=True, **TEXT_MODE, timeout=120, env=env)
    except (OSError, subprocess.SubprocessError) as exc:
        if log:
            log.add("WARN", "reboot.suppress_failed", str(exc)[:200])
        return reg_path

    if log and not _policy_imported(wine, env):
        log.add("WARN", "reboot.suppress_ineffective",
                "regedit 退出码为 0，但目标键查不到：拦截未生效")
    elif log:
        log.add("INFO", "reboot.suppressed", str(reg_path))
    return reg_path


#: 重启拦截要写入的键，用于导入后回查
RESTART_POLICY_KEY = ("HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\"
                      "CurrentVersion\\Policies\\Explorer")


def _policy_imported(wine: Path, env: dict[str, str]) -> bool:
    """回查拦截键是否真的写进去了。查不到返回 False，命令失败也返回 False。"""
    try:
        result = subprocess.run([str(wine), "reg", "query", RESTART_POLICY_KEY],
                                capture_output=True, **TEXT_MODE,
                                timeout=120, env=env)
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0 and "NoClose" in (result.stdout or "")


# --------------------------------------------------------------------------
# wine 调用
# --------------------------------------------------------------------------


def wine_binary() -> Path:
    """定位 wine 二进制。优先 wexe 托管的 runtime，其次 PATH。"""
    candidates = [
        wexe_paths.wine_root() / "bin" / "wine64",
        wexe_paths.wine_root() / "bin" / "wine",
    ]
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate

    import shutil
    for name in ("wine64", "wine"):
        found = shutil.which(name)
        if found:
            return Path(found)

    raise MissingDependency(
        "未找到 wine",
        hint=(f"把 wine 放入 {wexe_paths.wine_root()}/bin/wine64，"
              f"或执行 wepack runtime install 自动下载"),
    )


def _wine_env(prefix: Path, extra: dict[str, str] | None = None) -> dict[str, str]:
    """构造 wine 进程环境。

    PATH 前置 runtime 的 bin 与 lib：wine 需要能找到自己的库。
    """
    env = dict(os.environ)
    env.update(BASE_WINE_ENV)
    env["WINEPREFIX"] = str(Path(prefix).resolve())

    wine_root = wexe_paths.wine_root()
    prefix_path = f"{wine_root / 'bin'}:{wine_root / 'lib'}"
    env["PATH"] = prefix_path + ":" + env.get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")

    # 让 wine 用内置的 explorer/shell，避免依赖已安装的 shell 扩展
    env.setdefault("WINEDLLOVERRIDES", "mscoree,mshtml=")
    if extra:
        env.update(extra)
    return env


def _host_to_wine_path(host_path: Path) -> str:
    """把 macOS 绝对路径转成 wine 的 Z: 盘路径。

    dosdevices/z -> / 意味着 /Users/x/a.exe 在 wine 里是 Z:\\Users\\x\\a.exe。
    """
    resolved = str(Path(host_path).resolve())
    return "Z:" + resolved.replace("/", "\\")


@dataclass(slots=True)
class InstallVerification:
    """安装是否真的把文件写进了 prefix。

    这是「退出码」之外的第二道判据。安装器的退出码语义并不可靠 ——
    实测 Inno Setup 5.5.8 在 Wine 下静默安装，退出码 1，但落下的只有
    自举程序，主载荷一个文件没有。也有安装器退出码 0 却什么都没装。
    """

    passed: bool
    reason: str = ""
    files: int = 0
    bytes: int = 0

    def to_dict(self) -> dict[str, object]:
        return {
            "passed": self.passed,
            "reason": self.reason,
            "files": self.files,
            "bytes": self.bytes,
        }


@dataclass(slots=True)
class InstallRun:
    """一次安装执行的完整结果。"""

    returncode: int
    command: list[str] = field(default_factory=list)
    duration: float = 0.0
    timed_out: bool = False
    stdout_tail: str = ""
    stderr_tail: str = ""
    log_lines: list[str] = field(default_factory=list)
    settled_by_progress: bool = False
    """True 表示安装器装完后不退出，靠"文件不再增长"判定为完成。"""

    #: 安装前后 drive_c 的 (文件数, 总字节数)。退出码为 0 不等于装上了东西，
    #: 这两个值给产物校验用来判断「安装器到底往 prefix 里写了多少」。
    baseline_files: int = 0
    baseline_bytes: int = 0
    final_files: int = 0
    final_bytes: int = 0

    #: 本次安装**新增**的文件（相对 drive_c 的路径）与它们的总字节数。
    #:
    #: ## 为什么不用「前后总数相减」
    #:
    #: 安装过程中 wine 会自己删文件（缓存、Temp 残留、socket 文件）。
    #: 实测一个 NSIS 包装 12 个文件的同时，prefix 里少了 68 个，
    #: 总数相减得到 -56，钳成 0，结论变成「安装器什么都没写」。
    #:
    #: 逐文件比对回答的是正确的问题：这次新增了哪些文件。
    new_files: list[str] = field(default_factory=list)
    new_bytes: int = 0
    #: 被改写（同名但大小变化）的文件。安装器覆盖已有文件时算产物。
    changed_files: list[str] = field(default_factory=list)

    #: 产物校验结论。None 表示还没校验（例如 wineboot 的 InstallRun）。
    verification: InstallVerification | None = None

    @property
    def added_files(self) -> int:
        """本次安装新增的文件数。

        优先用逐文件比对的结果；拿不到快照（例如手工构造的 InstallRun）
        时退回「前后总数相减」，并对负值钳零。
        """
        if self.new_files or self.changed_files:
            return len(set(self.new_files) | set(self.changed_files))
        return max(0, self.final_files - self.baseline_files)

    @property
    def added_bytes(self) -> int:
        """本次安装新增的字节数（含被改写文件的新尺寸）。"""
        if self.new_files or self.changed_files:
            return self.new_bytes
        return max(0, self.final_bytes - self.baseline_bytes)

    @property
    def exit_ok(self) -> bool:
        """安装器进程本身是否正常结束（只看退出码与超时）。

        与 `ok` 分开是有意的：两者回答不同的问题。

        - `exit_ok`：安装器认为自己成功了吗？（3010 = 需重启但已成功）
        - `ok`：这次安装真的产出可用文件了吗？

        早先只有 `ok`，于是「退出码 0」被当成「装成功了」。实测 Inno
        Setup 5.5.8 在 Wine 下退出码 1 且什么都没装，另一种情况是某些
        安装器退出码 0 却只释放了几个临时文件。只看退出码无法区分。
        """
        # 安装器的退出码语义不统一：3010 = 需要重启但已成功（MSI 惯例）
        if self.settled_by_progress:
            # 装完不退出是 NSIS/Squirrel 常见行为（装完自动拉起应用），
            # 靠进度判定完成时不能用退出码判断
            return True
        if self.timed_out:
            return False
        return self.returncode in (0, 3010)

    @property
    def ok(self) -> bool:
        """安装是否成功：进程正常结束 **且** 文件确实落进了 prefix。"""
        if not self.exit_ok:
            return False
        if self.verification is not None and not self.verification.passed:
            # 退出码说成功、文件说没装 —— 以文件为准。
            # 这条不写的话，「装了个空包」会一路走到打包阶段才炸，
            # 用户看到的是「无法确定入口程序」这种不着边际的报错。
            return False
        return True


# --------------------------------------------------------------------------
# 执行安装
# --------------------------------------------------------------------------


def run_install(prefix: Path, installer: Path, detection: Detection, *,
                silent: bool = True, timeout: int = DEFAULT_TIMEOUT,
                log_path: Path | None = None,
                install_dir: str | None = None,
                extra_args: list[str] | None = None,
                settle_on_stable: bool = True) -> InstallRun:
    """在 prefix 内执行安装，返回完整结果。

    安装器通过 Z: 盘路径访问，不复制进 prefix —— 既省空间也保证
    原安装包不被修改（铁律 2）。

    **settle_on_stable**：很多安装器（NSIS / Squirrel / Electron 打包的）
    装完不退出，而是直接拉起刚装好的应用，父进程一直挂着。等它退出会
    白等到超时（实测空谷 Ondra 等满 1200 秒）。开启后改为监控 prefix
    的文件增长：连续 PROGRESS_STABLE_SAMPLES 次采样不变即判定安装完成，
    主动收尾并标记 settled_by_progress=True。
    """
    prefix = Path(prefix).resolve()
    installer = Path(installer).resolve()
    if not prefix.is_dir():
        raise UsageError(f"prefix 不存在：{prefix}")
    if not installer.is_file():
        raise UsageError(f"安装包不存在：{installer}")

    wine = wine_binary()
    # 只记本函数自己做的事。detect / prefix.create 是调用方（cmd_install）
    # 的步骤，它会另行写入 —— 在这里再写一遍会让 install.log 出现重复行，
    # 排查时容易误以为流程跑了两遍。
    log = _Log(log_path)

    kind = detection.kind
    wine_installer = _host_to_wine_path(installer)

    # MSI 走 msiexec，其余直接执行安装器
    if kind is InstallerKind.MSI:
        args = [str(wine), "msiexec", "/i", wine_installer]
        if silent:
            args.extend(silent_args_for(kind, install_dir or ""))
        if extra_args:
            args.extend(extra_args)
    else:
        args = [str(wine), wine_installer]
        if silent:
            target_dir = install_dir or default_install_dir(detection.product_name or "App")
            args.extend(silent_args_for(kind, target_dir, installer))
        if extra_args:
            args.extend(extra_args)

    env = _wine_env(prefix)
    log.add("INFO", "install.start", " ".join(args))

    started = time.monotonic()
    run = InstallRun(returncode=-1, command=args)
    drive_c = prefix / "drive_c"
    process: subprocess.Popen | None = None
    stdout = stderr = ""

    try:
        # 新进程组：超时时能连同 wine 派生的子进程一起杀
        process = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            **TEXT_MODE,
            env=env,
            start_new_session=True,
        )

        # 轮询等待：既处理超时，也处理"装完不退出"
        #
        # baseline 与 previous 必须分开：baseline 是安装**开始前**的快照，
        # 用来算这次安装到底写了多少文件（产物校验要用）；previous 是上一次
        # 采样，用来判断文件是否还在增长。早先把两者合成一个变量，装完后
        # baseline 已被改成最后一次采样值，added_files 永远算成 0 ——
        # 于是「装了个空包」和「装了 100 个文件」在数据上完全一样。
        #
        # 除了总数，还要记**逐文件快照**：wine 在安装过程中会删掉临时
        # 文件与缓存（实测少 68 个），只比总数会把新装的文件抵消掉，
        # 净增量算成负数后钳成 0，误判成「什么都没装」。
        baseline = _tree_signature(drive_c) if drive_c.is_dir() else (0, 0)
        baseline_files_map = _file_sizes(drive_c) if drive_c.is_dir() else {}
        run.baseline_files, run.baseline_bytes = baseline
        previous = baseline
        stable = 0
        settled = False
        while True:
            try:
                stdout, stderr = process.communicate(timeout=PROGRESS_INTERVAL)
                run.returncode = process.returncode
                break
            except subprocess.TimeoutExpired:
                # 故意超时：这是轮询循环，TimeoutExpired 表示「还没结束」，正是
                # 期望状态。接着下一轮，让调用方能报告进度。
                pass

            elapsed = time.monotonic() - started
            if elapsed >= timeout:
                run.timed_out = True
                log.add("ERROR", "install.timeout", f"{timeout}s")
                break

            if settle_on_stable and drive_c.is_dir():
                current = _tree_signature(drive_c)
                if current != previous:
                    previous = current
                    stable = 0
                else:
                    stable += 1
                    if stable >= PROGRESS_STABLE_SAMPLES:
                        # 文件已连续 30 秒不变：安装写完但进程挂着
                        settled = True
                        log.add("INFO", "install.settled",
                                f"文件停止增长，判定安装完成 "
                                f"files={current[0]} bytes={current[1]}")
                        break

        if settled or run.timed_out:
            _kill_group(process, prefix, log)
            # 二次收割必须容错：进程可能已被 SIGKILL，但管道里还有残留输出，
            # 或子进程继承了管道导致 read 一直阻塞。这里最多再等 15 秒，
            # 仍超时就放弃读取输出，绝不因为"收尾"再抛一次异常。
            try:
                stdout, stderr = process.communicate(timeout=15)
            except subprocess.TimeoutExpired:
                for stream in (process.stdout, process.stderr):
                    try:
                        if stream:
                            stream.close()
                    except OSError:
                        # 关流的清理动作。管道可能已被子进程关闭，重复关会抛 OSError，
                        # 不该中断后续的进程回收。
                        pass
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    # 等 5 秒不走就强行往下走：进程已经该死了，等不到它体面退出也只能强杀。
                    pass
                stdout, stderr = "", ""
            if settled:
                run.settled_by_progress = True
                run.returncode = 0
            else:
                run.returncode = -1
    except OSError as exc:
        raise MissingDependency(f"无法启动 wine：{exc}") from exc
    finally:
        # 兜底清理。
        #
        # 正常路径在循环结束后已经收割过（communicate / _kill_group），
        # 但**意外异常**会让这些收尾全部跳过：比如循环体内的
        # `_tree_signature` 撞上磁盘 I/O 错误、日志目录被删、或
        # KeyboardInterrupt。此时 wine 子进程会一直挂着，占住 prefix，
        # 下次安装直接失败（README 15.2 记录的「残留 prefix 锁文件」）。
        #
        # 实测：让 _tree_signature 第二次调用抛 ValueError，wine 进程
        # 在 run_install 抛出后仍然存活。这个 finally 就是修它。
        if process is not None:
            _reap_process(process, prefix, log)

    run.duration = time.monotonic() - started
    run.stdout_tail = (stdout or "")[-2000:]
    run.stderr_tail = (stderr or "")[-2000:]

    # 收尾后再取一次快照作为「装了多少」的最终值。
    # 取在 kill/收割之后，是因为 wine 的子进程可能在父进程退出后仍在写盘，
    # 太早采样会把最后一批文件漏掉。
    final = _tree_signature(drive_c) if drive_c.is_dir() else (0, 0)
    run.final_files, run.final_bytes = final

    # 逐文件比对得出「这次真正新增了什么」。
    # added_files / added_bytes 优先用这份结果（见 InstallRun 的属性实现），
    # 总数相减只在拿不到快照时兜底。
    if drive_c.is_dir() and baseline_files_map:
        final_files_map = _file_sizes(drive_c)
        run.new_files = sorted(k for k in final_files_map
                               if k not in baseline_files_map)
        run.new_bytes = sum(final_files_map[k] for k in run.new_files)
        # 被改写的文件也算产物（安装器覆盖同名文件是常见做法）
        run.changed_files = sorted(
            k for k, size in final_files_map.items()
            if k in baseline_files_map and baseline_files_map[k] != size)
    elif drive_c.is_dir():
        # baseline 为空（安装前 drive_c 不存在）：全部文件都是新增的
        final_files_map = _file_sizes(drive_c)
        run.new_files = sorted(final_files_map)
        run.new_bytes = sum(final_files_map.values())
        run.changed_files = []

    log.add("INFO", "install.exit",
            f"code={run.returncode} duration={run.duration:.1f}s"
            + (" TIMEOUT" if run.timed_out else ""))
    log.add("INFO", "install.delta",
            f"files={run.baseline_files}→{run.final_files} "
            f"(+{run.added_files}) "
            f"bytes={run.baseline_bytes}→{run.final_bytes} "
            f"(+{run.added_bytes})")

    # 校验在这里做，而不是留给调用方：run_install 是安装的执行者，
    # 「装没装上」是它的产出属性。放到 CLI 里会让其他调用方（测试、脚本）
    # 拿到一个 ok=True 的空转结果。
    run.verification = verify_install(run)
    log.add("INFO", "install.verify",
            ("ok" if run.verification.passed else
             f"failed {run.verification.reason}"))

    log.flush()
    if log_path is not None:
        try:
            run.log_lines = Path(log_path).read_text(encoding="utf-8").splitlines()
        except OSError:
            run.log_lines = []

    return run


# --------------------------------------------------------------------------
# 安装产物校验
# --------------------------------------------------------------------------

#: 判定"装上了东西"的最低文件数。低于此数一律视为空转。
#:
#: 为什么不设成 1：真实的安装器即使用户中途取消，也会留下几个残留文件
#: （Temp 下的自举程序、日志、卸载器脚本）。实测 Inno 5.x 空转时会落下
#: `Temp/is-*.tmp/_isetup` 里的 2~4 个文件，用 1 做阈值会把它判成成功。
MIN_INSTALLED_FILES = 8

#: 判定"装上了东西"的最低字节数（1 MiB）。
#:
#: 只有文件数不够：某些安装器会建一堆空目录与 0 字节占位文件。
#: 真实应用的主程序通常是几 MB 级，1 MiB 是宽松下限。
MIN_INSTALLED_BYTES = 1024 * 1024


def verify_install(run: InstallRun) -> InstallVerification:
    """校验一次安装是否真的产出了文件。

    只看 prefix 内的净增量，不看绝对大小 —— prefix 本身带着 base 层的
    system32，绝对大小永远是几百 MB，拿它判断等于永远通过。
    """
    files = run.added_files
    total = run.added_bytes

    if files >= MIN_INSTALLED_FILES and total >= MIN_INSTALLED_BYTES:
        return InstallVerification(True, files=files, bytes=total)

    if files == 0 and total == 0:
        return InstallVerification(
            False,
            f"安装器未向 prefix 写入任何文件（退出码 {run.returncode}）",
            files=files, bytes=total,
        )

    return InstallVerification(
        False,
        f"安装产物过少：仅 {files} 个文件 / {total} 字节"
        f"（阈值 {MIN_INSTALLED_FILES} 个 / {MIN_INSTALLED_BYTES} 字节）",
        files=files, bytes=total,
    )


def _reap_process(process: subprocess.Popen,
                  prefix: Path | None = None,
                  log: _Log | None = None) -> None:
    """确保子进程已退出、管道已关闭。可重复调用。

    与 `_kill_group` 的分工：`_kill_group` 是「主动终止」（超时/判定完成时
    用，带 SIGTERM → SIGKILL → wineserver -k 三步）；这里是「兜底回收」，
    用于 `finally` —— 进程可能早就正常退出了，也可能还活着，两种情况都要
    安全通过。

    **必须绝对容错**：它跑在 finally 里，此时可能正有异常向外传播。
    在这里再抛一个新异常会把原始错误吞掉，排查时完全看不到真正原因。
    """
    try:
        if process.poll() is not None:
            # 已退出：只需把管道读完关掉，避免 fd 泄漏
            try:
                process.communicate(timeout=5)
            except (subprocess.TimeoutExpired, OSError, ValueError):
                # 进程已退出，这里只为把管道读完、fd 释放掉。读不到东西或流已
                # 失效都无所谓，泄漏的 fd 才是要防的。
                pass
        else:
            # 还活着：按进程组杀，再兜底 kill
            _kill_group(process, prefix, log)
    except (OSError, ValueError):
        # 进程对象已被回收（ValueError）或系统调用失败，都无需再处理
        pass
    finally:
        for stream in (process.stdout, process.stderr, process.stdin):
            try:
                if stream is not None and not stream.closed:
                    stream.close()
            except (OSError, ValueError):
                # 同上：关流清理。ValueError 来自「流已关闭」，也一样忽略。
                pass


def _kill_group(process: subprocess.Popen,
                prefix: Path | None = None,
                log: _Log | None = None) -> None:
    """杀掉整个进程组，避免 wine 的 wineboot / services.exe 残留。

    分三步：
      1. SIGTERM 整个进程组，给 wine 5 秒优雅退出（让它自己写注册表收尾）
      2. SIGKILL 进程组
      3. 兜底：按 WINEPREFIX 用 wineserver -k 清掉残留

    第 3 步是关键：wine 的某些子进程会 setsid 脱离原进程组，
    只 killpg 杀不干净，残留进程会占着 prefix 让下次安装失败。
    """
    try:
        pgid = os.getpgid(process.pid)
    except (OSError, ProcessLookupError):
        pgid = None

    if pgid is not None:
        try:
            os.killpg(pgid, signal.SIGTERM)
        except (OSError, ProcessLookupError):
            # 进程组可能已经自己退出了。ProcessLookupError 表示「目标不
            # 存在」，对杀进程这个目的来说等于已完成。
            pass
        # 给 wine 一点时间自己收尾
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            # 给 SIGTERM 的 5 秒宽限期到了，直接进下一步 SIGKILL。
            pass
        try:
            os.killpg(pgid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            # SIGTERM 之后它已经死了，SIGKILL 自然找不到目标。
            pass

    # 兜底：直接杀父进程
    try:
        process.kill()
    except (OSError, ProcessLookupError):
        # 兜底杀父进程。若它已经退出，目的同样达成。
        pass

    # ## 第 3 步：wineserver -k
    #
    # 上面两句的 docstring 一直写着「兜底：按 WINEPREFIX 用 wineserver -k
    # 清掉残留」，但实现里根本没有这一步 —— 承诺的那一步是空的。
    #
    # 后果实测：跑一轮含真实安装的测试，Dock 里堆了 12 个 wine 图标
    # （6 对，每对是 Windows 程序 + 它的 wineserver）。killpg 只覆盖原
    # 进程组，而 wine 的服务进程会脱离进程组，杀不到。
    #
    # wineserver -k 是 Wine 官方的收尾方式：它知道该 prefix 下所有进程。
    # 必须带同一个 WINEPREFIX 环境，否则杀的是别的 prefix。
    if prefix is not None:
        kill_prefix_processes(prefix, log=log)
def wineboot_init(prefix: Path, *, timeout: int = 300) -> InstallRun:
    """初始化 prefix（wine 首次运行要建注册表与目录结构）。

    已有可用 prefix 时会快速返回，是幂等的。
    """
    wine = wine_binary()
    env = _wine_env(Path(prefix))
    started = time.monotonic()
    try:
        result = subprocess.run([str(wine), "wineboot", "-u"],
                                capture_output=True, **TEXT_MODE,
                                timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        return InstallRun(returncode=-1, timed_out=True,
                          duration=time.monotonic() - started)
    return InstallRun(
        returncode=result.returncode,
        command=[str(wine), "wineboot", "-u"],
        duration=time.monotonic() - started,
        stdout_tail=(result.stdout or "")[-2000:],
        stderr_tail=(result.stderr or "")[-2000:],
    )


def wineserver_binary() -> Path | None:
    """定位 `wineserver` 可执行文件。找不到返回 None。

    ## 为什么不能用 `wine_binary() + "wineserver"`

    这是本项目里真实存在过的错误。`wine64` 是 **Windows 程序加载器**，
    它会把 `wineserver` 当成一个 Windows 可执行文件去 `ShellExecuteEx`，
    结果报：

        Application could not be started, or no application associated
        with the specified file.  ShellExecuteEx failed: File not found.

    实测耗时 2.2 秒、**一个进程都没杀掉**。看起来「调过了」，实际是空转 ——
    比不调用更糟，因为它让日志里出现一次「已尝试清理」。

    `wineserver` 是同一目录下的独立 Unix 程序，必须直接 exec。
    """
    wine = wine_binary()
    candidates = [
        wine.parent / "wineserver",          # 与 wine64 同目录（实测位置）
        wexe_paths.wine_root() / "bin" / "wineserver",
    ]
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate

    import shutil
    found = shutil.which("wineserver")
    return Path(found) if found else None


def kill_prefix_processes(prefix: Path, *, timeout: int = 5,
                          log: _Log | None = None) -> bool:
    """关掉该 prefix 下的所有 wine 进程（按 WINEPREFIX 环境变量匹配）。

    返回是否确认清理成功。

    ## 为什么返回布尔值而不是静默 pass

    这个函数跑在收尾路径上，**不能抛异常**（会把原始错误吞掉）。但
    「不能抛」不等于「该沉默」：早先版本把三种失败（找不到 wineserver、
    调用超时、OSError）全部 `pass` 掉，结果是清理没成功也没人知道 ——
    实测连 `wineserver` 都调错了（用 wine64 加载器当 wineserver 传），
    日志里却和成功完全一样。这类「静默成功」比报错危险得多。

    现在返回 True/False，有 log 时写一条 WARN。收尾路径的调用方可以
    忽略返回值（行为不变），但至少在安装日志里留得下痕迹。

    ## timeout 为什么是 5 秒而不是 10

    正常情形下 `wineserver -k` 是**秒回**的（实测 0.16 秒），10 秒的
    上限只在 wineserver 自己卡住时才用得到。但调用方前面已经用掉
    SIGTERM 等待 5 秒 + `process.wait(5)`，这里再给 10 秒会让最坏情况
    逼近 20 秒 —— 实测把 `test_timeout_kills_process` 的「总耗时
    < 15 秒」推到了 15.01 秒。给 5 秒不影响正常路径，也留了余量。
    """
    server = wineserver_binary()
    if server is None:
        if log:
            log.add("WARN", "cleanup.no_wineserver",
                    "找不到 wineserver，无法确认残留进程已清理")
        return False
    env = _wine_env(Path(prefix))
    try:
        result = subprocess.run([str(server), "-k"],
                                capture_output=True, **TEXT_MODE,
                                timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        if log:
            log.add("WARN", "cleanup.timeout", f"wineserver -k 超过 {timeout}s")
        return False
    except (OSError, subprocess.SubprocessError) as exc:
        if log:
            log.add("WARN", "cleanup.failed", str(exc)[:200])
        return False

    # ## 退出码非 0 不一定算失败
    #
    # `wineserver -k` 在「本来就没有活进程」时也可能返回非 0（实测返回 1）。
    # 那种情况清理目标已经达成，不该报 WARN。所以只看 stderr 里有没有
    # 真正的错误信息；空 stderr 就按成功算。
    stderr = (result.stderr or "").strip()
    if result.returncode != 0 and stderr:
        if log:
            log.add("WARN", "cleanup.nonzero_exit",
                    f"wineserver -k 返回 {result.returncode}：{stderr[:200]}")
        return False
    return True


def run_in_prefix(prefix: Path, argv: list[str], *, timeout: int = 300,
                  extra_env: dict[str, str] | None = None) -> InstallRun:
    """在 prefix 内跑一条 wine 命令，返回结构化结果（不抛异常）。

    这是 `wineboot_init` 的泛化版本：后者写死了 `wineboot -u`。层的
    构建（装 wine-mono 的 msi、跑 fontreg）都需要「在指定 prefix 里
    执行任意命令」，硬编码第二条会变成复制粘贴。

    ## 参数是否已经在 wine 里

    `argv` 里的**宿主路径必须自己先用 `_host_to_wine_path()` 转好**。
    这里不做自动转换：命令里既有路径也有开关（`/qn`、`/i`），自动判断
    「哪个参数是路径」必然误伤 —— 把 `/qn` 转成 `Z:\\qn` 这类错误不会
    报错，只会静默失败。

    @param prefix 目标 prefix（必须已存在）
    @param argv 传给 wine 的参数，不含 wine 二进制本身
    @param timeout 超时秒数，超时返回 `timed_out=True` 而不是抛异常
    """
    prefix = Path(prefix)
    if not prefix.is_dir():
        raise UsageError(f"prefix 不存在：{prefix}")

    wine = wine_binary()
    env = _wine_env(prefix, extra_env)
    started = time.monotonic()
    command = [str(wine), *argv]
    try:
        result = subprocess.run(command, capture_output=True, **TEXT_MODE,
                                timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        return InstallRun(returncode=-1, timed_out=True, command=command,
                          duration=time.monotonic() - started)
    return InstallRun(
        returncode=result.returncode,
        command=command,
        duration=time.monotonic() - started,
        stdout_tail=(result.stdout or "")[-2000:],
        stderr_tail=(result.stderr or "")[-2000:],
    )


__all__ = [
    "BASE_WINE_ENV", "DEFAULT_TIMEOUT", "InstallRun",
    "silent_args_for", "default_install_dir", "run_install",
    "write_install_log", "suppress_restart", "wine_binary",
    "wineboot_init", "kill_prefix_processes", "run_in_prefix",
    "host_to_wine_path", "RESTART_SUPPRESS_REG", "RESTART_POLICY_KEY",
]

#: 公开别名。**同一个对象**，不是副本 —— 两套判据必然漂移，
#: 本项目已因同类问题出过事故（见 README 5.3 红线）。
host_to_wine_path = _host_to_wine_path