"""外部工具定位与调用。

7z / innoextract / msiextract 都不随系统预装，需要用户自备。
这里统一做三件事：
  1. 按固定优先级找二进制（环境变量 → PATH → 常见安装位置）
  2. 缺失时给出可复制的安装命令，而不是抛一句"找不到"
  3. 统一的 subprocess 调用封装：超时、输出捕获、错误信息翻译

优先级里 WEXE_7Z / WEXE_INNOEXTRACT / WEXE_MSIEXTRACT 环境变量最高，
便于用户指定非标准安装路径，也便于测试注入假二进制。
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .errors import MissingDependency

#: 各工具在 PATH 中的候选名（顺序即优先级）
TOOL_CANDIDATES: dict[str, tuple[str, ...]] = {
    "7z": ("7zz", "7z", "7za"),
    "innoextract": ("innoextract",),
    "msiextract": ("msiextract",),
}

#: 统一文本模式的 subprocess 关键字参数。
#:
#: ## 为什么不用裸 `text=True`
#:
#: `text=True` 用 locale 的编码解码子进程输出，且 `errors='strict'`。
#: 只要有一个字节不是合法 UTF-8 就抛 `UnicodeDecodeError` —— 而这个
#: 异常会被外面当成「工具执行失败」，报出「7z 无法解包」这种完全错误
#: 的结论，人会去查 7z 的安装。
#:
#: 这不是假想问题。以下都会产出非 UTF-8 字节：
#:   - wine 内部用 cp1252 / cp936 打印含中文的 Windows 路径
#:   - 7z 的某些本地化版本按系统代码页输出文件名
#:   - 安装器把控制字符直接写进 stderr
#:
#: 实测（改前状态，2026-11-22 复核）：一个只含 `\xff\xfe` 的 stdout
#: 足以让当时散落的 `text=True` 调用点全部崩掉。**那些调用点现在一处
#: 不剩**（裸 `text=True` 在 `wepack/` 内为 0 处，全部走本常量），
#: 由 `test_no_bare_text_true_left` 守着「以后也别加」。
#: 这里保留「当时有几处」的语境是为了解释这条常量为什么存在 ——
#: 数字写的是历史，不是现状。
#:
#: 改成 `errors='replace'`：解码永不失败，坏字节变成 U+FFFD，日志里
#: 看得出「这里有乱码」，而不是整条链路断掉。判定用的是退出码与磁盘
#: 上的实际产物，不依赖输出文本，所以替换掉几个字符不影响任何结论。
TEXT_MODE: dict[str, object] = {
    "text": True,
    "encoding": "utf-8",
    "errors": "replace",
}

#: 环境变量名 → 工具名
ENV_OVERRIDES: dict[str, str] = {
    "WEXE_7Z": "7z",
    "WEXE_INNOEXTRACT": "innoextract",
    "WEXE_MSIEXTRACT": "msiextract",
}

#: 额外搜索位置（Homebrew 两种前缀、MacPorts、用户自建）
EXTRA_DIRS = (
    Path("/opt/homebrew/bin"),
    Path("/usr/local/bin"),
    Path("/opt/local/bin"),
)

#: 应用包内自带的工具。
#:
#: ## 为什么要专门找这些位置
#
# macOS 上不少应用为了自己解压，把 `7zz` 打包进 app bundle。用户没装
# Homebrew 版，但机器上确实有一个能用的 7-Zip —— 这时候报「缺少 7z，
# 请 brew install」是错的结论，用户会去装一个功能重复的东西。
#
# 实测 BlueStacks 就带了 `7zz` 24.09，能正常解包；而 PATH 里那个同名的
# `7zz` 反而是沙箱注入的转发壳（执行返回非 0）。
#
# 顺序：这些位置排在 PATH 与 EXTRA_DIRS **之后**，因为有冒烟测试兜底，
# 只在标准位置都不可用时才轮到它们。
BUNDLED_DIRS: dict[str, tuple[Path, ...]] = {
    "7z": (
        Path("/Applications/BlueStacks.app/Contents/MacOS"),
        Path("/Applications/Keka.app/Contents/Resources/kekaqt.app/"
             "Contents/Resources"),
        Path("/Applications/BetterZip.app/Contents/Resources"),
    ),
}

INSTALL_HINTS: dict[str, str] = {
    "7z": "brew install sevenzip   # 提供 7zz；或 brew install p7zip",
    "innoextract": "brew install innoextract   # 或从 https://constexpr.org/innoextract/ 下载",
    "msiextract": "brew install msitools",
}


@dataclass(slots=True)
class Tool:
    name: str
    path: Path

    def run(self, args: list[str], *, timeout: int = 600,
            cwd: Path | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
        """调用工具，捕获输出。超时抛 MissingDependency 之外的 RuntimeError。

        注意：这里不做错误翻译，由各解包模块按自己的语义解释返回码。
        """
        merged = dict(os.environ)
        if env:
            merged.update(env)
        try:
            return subprocess.run(
                [str(self.path), *args],
                capture_output=True, **TEXT_MODE, timeout=timeout,
                cwd=str(cwd) if cwd else None, env=merged,
            )
        except subprocess.TimeoutExpired as exc:
            raise MissingDependency(
                f"{self.name} 执行超时（{timeout}s）",
                hint=f"命令：{self.path} {' '.join(args[:4])} …",
            ) from exc
        except OSError as exc:
            raise MissingDependency(f"{self.name} 无法执行：{exc}") from exc


def _smoke_test(tool: Tool) -> bool:
    """确认工具真的能跑起来。

    只检查 is_file + os.access 不够：PATH 里可能存在"转发壳"
    （例如沙箱环境注入的 brokered shim），文件存在且可执行，
    但真正调用时返回 127。这里实际执行一次，用退出码判定。
    """
    try:
        result = tool.run([], timeout=20)
    except MissingDependency:
        return False
    # 7-Zip 无参数时打印 banner 并以 0 退出；退出码 127 表示找不到真实二进制
    if result.returncode == 127:
        return False
    text = (result.stdout or "") + (result.stderr or "")
    if "ENOENT" in text or "spawnSync" in text:
        return False
    return True


def find_tool(name: str, *, required: bool = True,
              verify: bool = True) -> Tool | None:
    """定位工具。required=True 且找不到时抛 MissingDependency。

    verify=True 时会对候选做一次空调用冒烟测试，跳过跑不起来的转发壳。
    """
    candidates: list[Path] = []

    for env_name, tool_name in ENV_OVERRIDES.items():
        if tool_name != name:
            continue
        override = os.environ.get(env_name)
        if override:
            candidate = Path(override).expanduser()
            if candidate.is_file() and os.access(candidate, os.X_OK):
                candidates.append(candidate)

    for binary in TOOL_CANDIDATES.get(name, (name,)):
        found = shutil.which(binary)
        if found:
            candidates.append(Path(found))

    for binary in TOOL_CANDIDATES.get(name, (name,)):
        for directory in EXTRA_DIRS:
            candidate = directory / binary
            if candidate.is_file() and os.access(candidate, os.X_OK):
                candidates.append(candidate)

    # 应用包内自带的（BlueStacks / Keka 等）
    for directory in BUNDLED_DIRS.get(name, ()):
        for binary in TOOL_CANDIDATES.get(name, (name,)):
            candidate = directory / binary
            if candidate.is_file() and os.access(candidate, os.X_OK):
                candidates.append(candidate)

    for candidate in candidates:
        tool = Tool(name=name, path=candidate)
        if not verify or _smoke_test(tool):
            return tool

    if required:
        hint = INSTALL_HINTS.get(name, f"请安装 {name} 并确保在 PATH 中")
        if candidates:
            hint += (f"\n（找到 {candidates[0]}，但执行失败；"
                     f"它可能是个转发壳，用 WEXE_{name.upper()} 指定真实二进制）")
        raise MissingDependency(f"缺少可用的 {name}", hint=hint)
    return None


#: 工具名 → 缺了会影响什么。doctor 的 detail 文案与此处的 hint 一起构成
#: 完整的排查指引。新增工具时这张表和 TOOL_CANDIDATES 都要改 ——
#: 有 `test_probe_all_covers_every_known_tool` 盯着，漏一个会红。
TOOL_PURPOSE: dict[str, str] = {
    "7z": "解包 NSIS / InstallShield / MSI 内的 cab",
    "innoextract": "Inno 解包精度",
    "msiextract": "MSI 目录结构还原",
}


def probe_all(*, required_for: dict[str, bool] | None = None
              ) -> dict[str, dict[str, object]]:
    """探测各解包工具的可用性。

    这是「哪些工具、是否必需」的唯一来源：doctor 的逐项检查直接消费它，
    不再自己另抄一份清单。早先 doctor 与这里各维护一份，新增工具时极易
    一边改一边忘 —— 而忘了的那一边会让 doctor 声称「环境齐全」，
    实际跑起来才在解包阶段报缺依赖。

    required_for 覆盖各工具的必需性（doctor 里 7z 必需、另两个可选）；
    不传时一律按必需处理。
    """
    result: dict[str, dict[str, object]] = {}
    for name in TOOL_CANDIDATES:
        tool = find_tool(name, required=False)
        required = True if required_for is None else required_for.get(name, True)
        result[name] = {
            "ok": tool is not None,
            "path": str(tool.path) if tool else None,
            "required": required,
            "purpose": TOOL_PURPOSE.get(name, ""),
            "hint": None if tool else INSTALL_HINTS.get(name),
        }
    return result


def seven_zip() -> Tool:
    tool = find_tool("7z")
    assert tool is not None
    return tool


def tool_version(tool: Tool) -> str:
    """取工具版本字符串。取不到返回空串。

    7-Zip 不接受 --version（返回 "Command Line Error"），它无参数时
    打印 banner；innoextract / msiextract 用 --version。
    """
    if tool.name == "7z":
        try:
            result = tool.run([], timeout=20)
        except MissingDependency:
            return ""
        text = (result.stdout or "") + (result.stderr or "")
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("7-Zip"):
                return stripped
        return ""

    for flag in ("--version", "-version"):
        try:
            result = tool.run([flag], timeout=20)
        except MissingDependency:
            return ""
        text = (result.stdout or "") + (result.stderr or "")
        for line in text.splitlines():
            stripped = line.strip()
            if stripped:
                return stripped
    return ""