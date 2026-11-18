"""wepack 命令行入口。

阶段 0 的职责：把完整命令行契约固定下来。所有子命令都有真实的参数解析、
真实的帮助文本、真实的退出码；业务实现按阶段逐步填充，未实现的子命令
统一抛 PhaseNotImplemented（退出码 3），绝不静默返回成功。

设计约束：
- stdout 只放结果，日志一律走 stderr，便于 `wepack detect x.exe --json | jq`。
- 每个子命令都能 `--json`，输出结构见仓库根 README.md 第 10.2 节。
"""

from __future__ import annotations

import argparse
import json
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

from . import PHASE, __version__
from .errors import (ExitCode, UnsupportedSoftware,
                     UsageError, VerifyFailed, WexeError)
from .log import get_logger, setup
from .tools import TEXT_MODE
from .models import STATIC_EXTRACTABLE, InstallerKind

PROG = "wepack"

#: 全部子命令名。参数解析失败时要靠它从 argv 里认出用户想跑哪个子命令，
#: 报告里才有 `command` 字段可填。新增子命令时记得同步这里。
_SUBCOMMANDS = frozenset({
    "detect", "extract", "install", "package", "build",
    "layers", "recipe", "runtime", "doctor", "version",
})


EPILOG = """\
退出码:
  0  成功
  1  未归类失败
  2  参数错误
  3  该能力属于后续阶段，尚未实现
  4  安装器类型或软件类别明确不支持
  5  缺少外部依赖（wine / sips / iconutil / 7z）
  6  prefix 创建或静默安装失败
  7  产物校验失败

示例:
  wepack doctor
  wepack detect ~/Downloads/npp.exe
  wepack extract ~/Downloads/npp.exe -o out/
  wepack install ~/Downloads/7z2408-x64.exe -o "7-Zip (Win).app"
  wepack package "7-Zip (Win).app"
  wepack build ~/Downloads/npp.exe -o ~/Applications

文档: 仓库根 README.md（第 3.2 节架构、第 10.2 节输出结构、第 14.5 节不支持清单）
"""


# --------------------------------------------------------------------------
# 参数构造
# --------------------------------------------------------------------------


def _add_common(p: argparse.ArgumentParser) -> None:
    """所有子命令共用的开关。"""
    p.add_argument("--json", action="store_true", help="以 JSON 输出结果（stdout 只含 JSON）")
    p.add_argument(
        "--report", action="store_true",
        help="输出统一运行报告（contracts/run-report.schema.json），供前端汇总使用",
    )
    p.add_argument("-v", "--verbose", action="store_true", help="输出调试日志到 stderr")


def _add_installer_arg(p: argparse.ArgumentParser, help_text: str) -> None:
    p.add_argument("installer", type=Path, metavar="INSTALLER", help=help_text)


class _ReportAwareParser(argparse.ArgumentParser):
    """在参数解析失败时仍能输出合规报告的 ArgumentParser。

    ## 为什么需要子类

    argparse 遇到「缺少必需位置参数」会直接 `error()` → 打印用法到 stderr
    → `sys.exit(2)`。整个过程发生在 main 里 `--report` 判定之前，于是
    `wepack detect --report`（漏了路径）stdout 完全是空的。

    这违反契约：`--report` 模式下**任何**结局都必须有一份报告 JSON，
    否则 console 拿到空输入只能显示成「未知错误」，用户看不出是漏了参数。

    覆写 `error()` 后，先判断本次调用是否带 `--report`（从原始 argv 里找，
    因为此刻 argparse 还没解析出 args），是则先写一份 failure_report 再退出。
    """

    #: 本次解析的原始 argv。**类属性**而非实例属性：子命令的 parser 是
    #: 另外 new 出来的实例，实例上设的值它读不到。用类属性让整棵 parser
    #: 树共享同一份 argv。
    _raw_argv: list[str] = []

    @classmethod
    def set_argv(cls, argv: list[str]) -> None:
        _ReportAwareParser._raw_argv = list(argv)

    def _wants_report(self) -> bool:
        return "--report" in _ReportAwareParser._raw_argv

    def _command_hint(self) -> str:
        """从 argv 里猜出子命令名，供报告用。"""
        for token in _ReportAwareParser._raw_argv:
            if token in _SUBCOMMANDS:
                return token
        return "unknown"

    def error(self, message: str):  # noqa: D401 - 覆写 argparse
        if not self._wants_report():
            super().error(message)

        # 带 --report：先给人读信息走 stderr，再给机器读报告走 stdout
        self.print_usage(sys.stderr)
        sys.stderr.write(f"{PROG}: error: {message}\n")

        from .report import StageTracker, failure_report
        payload = failure_report(
            tracker=StageTracker(),
            code="EOM_1003",
            message=message,
            exit_code=int(ExitCode.USAGE),
            hint="检查命令行参数，或先跑 wepack <子命令> --help",
            command=self._command_hint(),
        )
        _emit_report(payload)
        # 紧随其后就是 SystemExit —— argparse 的 error 路径不经过 main 的
        # 常规出口，不在这里显式冲刷，管道重定向时末尾的 JSON 可能丢掉。
        _out().flush()
        raise SystemExit(int(ExitCode.USAGE))


def build_parser() -> argparse.ArgumentParser:
    parser = _ReportAwareParser(
        prog=PROG,
        description="ExeOnMac：把 Windows 安装包（setup.exe / .msi）封装成可双击运行的 macOS .app。",
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=f"{PROG} {__version__} (phase {PHASE})")

    # 子 parser 会继承父 parser 的类（argparse 的行为），因此上面那个
    # 覆写过 error() 的子类对 detect / extract / install / package 同样生效，
    # 不需要显式传 parser_class。
    sub = parser.add_subparsers(dest="command", metavar="COMMAND", title="子命令")

    # -- detect ------------------------------------------------------------
    p = sub.add_parser(
        "detect",
        help="识别安装器类型（NSIS / Inno / InstallShield / MSI / Burn / Squirrel）",
        description="识别安装器类型、目标架构与产品元数据，不做任何解包或写入。",
    )
    _add_installer_arg(p, "安装包路径（setup.exe / *.msi）")
    _add_common(p)
    p.set_defaults(func=cmd_detect)

    # -- extract -----------------------------------------------------------
    p = sub.add_parser(
        "extract",
        help="静态解包安装包，输出文件树与主 exe 候选",
        description=(
            "静态解包，不执行安装器代码。阶段 1 支持 NSIS / Inno Setup / MSI 三类；"
            "其余类型返回退出码 4 并记入 README.md 第 14.5 节的不支持清单。"
        ),
    )
    _add_installer_arg(p, "安装包路径")
    p.add_argument("-o", "--out", type=Path, required=True, metavar="DIR", help="解包输出目录（必须为空或不存在）")
    p.add_argument("--format", choices=("tree", "list", "json"), default="tree", help="文件树呈现方式，默认 tree")
    p.add_argument("--max-candidates", type=int, default=5, metavar="N", help="主 exe 候选数量，默认 5")
    p.add_argument("--keep-temp", action="store_true", help="保留中间临时目录，便于排查解包问题")
    _add_common(p)
    p.set_defaults(func=cmd_extract)

    # -- install -----------------------------------------------------------
    p = sub.add_parser(
        "install",
        help="创建 prefix 并静默安装，产出 .app 骨架（含 prefix 与安装日志）",
        description=(
            "在包内 Private/ 里建立独立 Wine prefix（base 层用 APFS clonefile 复用），"
            "按安装器类型套静默参数执行安装，全过程写 install.log。"
            "本命令只装不装配：Info.plist / 图标 / launcher 由 package 补齐，"
            "或用 build 一步完成两者。"
        ),
    )
    _add_installer_arg(p, "安装包路径")
    p.add_argument("-o", "--out", type=Path, required=True, metavar="APP", help='输出 .app 路径，如 "7-Zip (Win).app"')
    p.add_argument("--app-name", metavar="NAME", help="应用名，缺省时从安装器元数据推断")
    p.add_argument("--silent-args", metavar="ARGS", help="覆盖内置静默参数（原样传给安装器）")
    p.add_argument("--interactive", action="store_true", help="跳过静默安装，直接进交互安装（窗口限制在独立进程内）")
    p.add_argument("--timeout", type=int, default=1800, metavar="SEC", help="安装超时秒数，默认 1800")
    p.add_argument("--no-layers", action="store_true",
                   help="跳过依赖层自动匹配（默认会扫描主程序导入表，按需挂载 vcpp/mfc/dotnet/fonts-cn）")
    p.add_argument("--no-recipe", action="store_true",
                   help="不读写配方库（默认装完保存配方，同一安装包下次直接复用入口与层）")
    _add_common(p)
    p.set_defaults(func=cmd_install)

    # -- package -----------------------------------------------------------
    p = sub.add_parser(
        "package",
        help="为一个已安装的 .app 生成 Info.plist、图标与 launcher",
        description="读取包内 compat.yaml，补齐 Info.plist / AppIcon.icns / MacOS/launcher 并注册到 LaunchServices。",
    )
    p.add_argument("app", type=Path, metavar="APP", help="已存在的 .app 包路径")
    p.add_argument("--icon", type=Path, metavar="ICO", help="指定图标源文件（.ico / .exe / .png）")
    p.add_argument("--badge", choices=("w", "grid", "gray", "none"), default="w",
                   help="角标样式：w（白色 W）| grid（Windows 四格）| gray（灰色底）| none")
    p.add_argument("--badge-color", default=None, metavar="HEX",
                   help="角标底色，默认 #0078D4（--badge gray 时用 #8E8E93）")
    p.add_argument("--no-register", action="store_true", help="不调用 lsregister 注册")
    p.add_argument("--entry", metavar="PATH",
                   help="入口程序，相对 Contents/Resources/Private/；缺 compat.yaml 时必填")
    p.add_argument("--app-name", metavar="NAME", help="应用名，仅缺 compat.yaml 时生效")
    _add_common(p)
    p.set_defaults(func=cmd_package)

    # -- build -------------------------------------------------------------
    p = sub.add_parser(
        "build",
        help="一键流程：detect → extract → install → package",
        description="把四个阶段串起来的便捷入口。任一环节失败即中止，不产出半成品 .app。",
    )
    _add_installer_arg(p, "安装包路径")
    p.add_argument("-o", "--out-dir", type=Path, default=Path("~/Applications").expanduser(), metavar="DIR",
                   help=".app 输出目录，默认 ~/Applications")
    p.add_argument("--app-name", metavar="NAME", help="应用名，缺省时自动推断")
    p.add_argument("--force", action="store_true", help="目标 .app 已存在时先移到废纸篓再重建")
    p.add_argument("--no-recipe", action="store_true",
                   help="不读写配方库（默认命中配方时跳过入口探测与层匹配）")
    p.add_argument("--no-layers", action="store_true", help="跳过依赖层自动匹配")
    _add_common(p)
    p.set_defaults(func=cmd_build)

    # -- layers ------------------------------------------------------------
    p = sub.add_parser("layers", help="共享层管理", description="查看、校验、挂载 wexe 共享层。")
    lsub = p.add_subparsers(dest="layers_command", metavar="ACTION", title="动作")
    q = lsub.add_parser("list", help="列出已安装的层及大小")
    _add_common(q)
    q.set_defaults(func=cmd_layers_list)
    q = lsub.add_parser("verify", help="校验层完整性（文件清单 + 校验和）")
    q.add_argument("name", nargs="?", metavar="LAYER", help="层名，缺省校验全部")
    _add_common(q)
    q.set_defaults(func=cmd_layers_verify)
    q = lsub.add_parser("mount", help="把层 clonefile 进指定 .app 的 Private/")
    q.add_argument("name", metavar="LAYER", help="层名，如 vcpp")
    q.add_argument("--app", type=Path, required=True, metavar="APP", help="目标 .app 路径")
    _add_common(q)
    q.set_defaults(func=cmd_layers_mount)

    q = lsub.add_parser("build", help="构建层（当前仅支持 base）")
    q.add_argument("name", metavar="LAYER", help="层名，目前只支持 base")
    q.add_argument("--timeout", type=int, default=600, metavar="SEC",
                   help="wineboot 超时秒数，默认 600")
    _add_common(q)
    q.set_defaults(func=cmd_layers_build)

    q = lsub.add_parser(
        "match",
        help="扫描主程序导入表，算出需要哪些层",
        description=(
            "读入口 exe 与同目录 DLL 的导入表，先比对 base 层已提供的，"
            "只对真正缺失的依赖匹配层。不挂载、不修改任何文件。"
        ),
    )
    q.add_argument("entry", type=Path, metavar="EXE", help="主程序 exe 路径")
    q.add_argument("--apply", type=Path, metavar="APP",
                   help="把匹配到的层实际挂载进该 .app")
    _add_common(q)
    q.set_defaults(func=cmd_layers_match)

    # -- recipe ------------------------------------------------------------
    p = sub.add_parser("recipe", help="配方库（~/.wexe/recipes）", description="管理已知安装包的打包配方。")
    rsub = p.add_subparsers(dest="recipe_command", metavar="ACTION", title="动作")
    q = rsub.add_parser("list", help="列出本地配方")
    _add_common(q)
    q.set_defaults(func=cmd_recipe_list)
    q = rsub.add_parser("show", help="查看某条配方内容")
    q.add_argument("key", metavar="KEY", help="配方键（安装包 SHA-256 前 16 位）或安装包路径")
    _add_common(q)
    q.set_defaults(func=cmd_recipe_show)
    q = rsub.add_parser("save", help="从已打包的 .app 导出配方")
    q.add_argument("app", type=Path, metavar="APP", help="已打包的 .app 路径")
    q.add_argument("--key", metavar="KEY", help="配方键，缺省用应用名+版本")
    _add_common(q)
    q.set_defaults(func=cmd_recipe_save)
    q = rsub.add_parser("rm", help="删除一条配方")
    q.add_argument("key", metavar="KEY", help="配方键")
    _add_common(q)
    q.set_defaults(func=cmd_recipe_rm)

    # -- runtime -----------------------------------------------------------
    p = sub.add_parser(
        "runtime",
        help="Wine 运行时管理（下载、安装、检查）",
        description=(
            "管理 ~/Library/Application Support/wexe/runtime/wine。"
            "Apple Silicon 上必须使用 x86_64 构建（经 Rosetta 2 翻译）。"
        ),
    )
    rtsub = p.add_subparsers(dest="runtime_command", metavar="ACTION", title="动作")

    q = rtsub.add_parser("status", help="查看当前运行时状态")
    _add_common(q)
    q.set_defaults(func=cmd_runtime_status)

    q = rtsub.add_parser(
        "install",
        help="下载并安装 wine 运行时（联网，约 225 MB）",
        description="默认从 Gcenx 的 macOS_Wine_builds 下载 x86_64 devel 构建。",
    )
    q.add_argument("--url", default=None, metavar="URL", help="自定义下载地址")
    q.add_argument("--archive", type=Path, metavar="TAR_XZ", help="使用本地 tar.xz，不联网")
    q.add_argument("--from-vendor", action="store_true",
                   help="从已安装的 CrossOver / Whisky 复制，不联网")
    _add_common(q)
    q.set_defaults(func=cmd_runtime_install)

    # -- doctor ------------------------------------------------------------
    p = sub.add_parser(
        "doctor",
        help="环境自检：Rosetta、wine runtime、sips、iconutil、7z、目录权限",
        description="逐项检查运行所需的外部条件，缺失项给出修复建议。",
    )
    _add_common(p)
    p.set_defaults(func=cmd_doctor)

    # -- version -----------------------------------------------------------
    p = sub.add_parser("version", help="打印版本与当前阶段")
    _add_common(p)
    p.set_defaults(func=cmd_version)

    return parser


# --------------------------------------------------------------------------
# 输出辅助
# --------------------------------------------------------------------------


def _emit(payload: dict | list, as_json: bool) -> None:
    """统一的结果输出。JSON 走 stdout，人类可读格式由调用方自行 print。"""
    if as_json:
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")


def _emit_report(report: dict, stream=None) -> None:
    """输出统一运行报告。

    写的是 `_out()` 而非 `sys.stdout`：报告总是在 `_StdoutToStderr` 改道
    期间产出，此刻 `sys.stdout` 已经指向 stderr，直接写它会让
    `wepack ... --report | jq` 拿到空输入。

    这个函数早先把流写死成 `sys.stdout`，于是每个子命令都手抄一遍
    `json.dump(..., _out())` 再补一行 `write("\\n")` —— 函数本身反倒成了
    唯一没人调用的地方。收到 `_out()` 才是它该有的样子。
    """
    target = stream if stream is not None else _out()
    json.dump(report, target, ensure_ascii=False, indent=2)
    target.write("\n")


class _StdoutToStderr:
    """把 stdout 临时改道到 stderr。

    `--report` 要求 stdout 只含 JSON，但子命令会直接 print 人类可读文本。
    逐个子命令加 `if not args.report` 判断既啰嗦又容易漏，因此在 main 里
    统一改道：命令执行期间所有 stdout 落到 stderr，结束后再把报告写回
    真正的 stdout。这样新增子命令不会破坏契约。

    **注意**：进入改道后 `sys.stdout` 就是 stderr。子命令若要写报告，
    必须用 `_out()` 取回真正的 stdout —— 直接取 `sys.stdout` 会把 JSON
    也写进 stderr，`wepack ... --report | jq` 就拿到空输入。
    这个坑在 detect / extract / install / package 四处都踩过。
    """

    def __init__(self, real_stdout) -> None:
        self._real = real_stdout

    def __enter__(self):
        sys.stdout = sys.stderr
        return self

    def __exit__(self, *exc_info) -> bool:
        sys.stdout = self._real
        return False


#: 进程真正的 stdout。进程启动时捕获一次，之后不随 `_StdoutToStderr` 变化。
_REAL_STDOUT = sys.stdout


def _out():
    """取真正的 stdout。改道期间也返回原始流，供子命令写报告用。"""
    return _REAL_STDOUT


def _require_file(path: Path) -> Path:
    p = path.expanduser()
    if not p.exists():
        raise UsageError(f"文件不存在：{p}")
    if not p.is_file():
        raise UsageError(f"不是普通文件：{p}")
    return p.resolve()


def _require_app(path: Path) -> Path:
    p = path.expanduser()
    if p.suffix != ".app":
        raise UsageError(f"目标必须是 .app 包：{p}", hint="例如 7-Zip (Win).app")
    return p.resolve()


# --------------------------------------------------------------------------
# 子命令实现
# --------------------------------------------------------------------------


def cmd_detect(args: argparse.Namespace) -> int:
    """识别安装器类型，不写入任何文件。"""
    from .detect import detect_installer
    from .report import StageTracker

    want_report = getattr(args, "report", False)
    tracker = StageTracker() if want_report else None

    if tracker is not None:
        tracker.enter("preflight")
    path = _require_file(args.installer)
    if tracker is not None:
        tracker.leave("preflight")
        tracker.enter("detect")

    detection = detect_installer(path)
    if tracker is not None:
        tracker.leave("detect")
        # detect 只做识别，不碰后面任何阶段，如实标跳过
        for stage in ("extract", "prefix", "install", "scan", "package", "verify"):
            tracker.skip(stage)

    payload = {
        "ok": detection.supported,
        "path": str(detection.path),
        "kind": str(detection.kind),
        "confidence": detection.confidence,
        "evidence": detection.evidence,
        "arch": detection.arch,
        "product_name": detection.product_name,
        "product_version": detection.product_version,
        "vendor": detection.vendor,
        "silent_args": detection.silent_args,
        "supported": detection.supported,
        "unsupported_reason": detection.unsupported_reason,
    }
    _emit(payload, args.json)

    if not args.json:
        print(f"文件      {detection.path}")
        print(f"类型      {detection.kind}  （置信度 {detection.confidence:.2f}）")
        if detection.arch:
            print(f"架构      {detection.arch}")
        if detection.product_name:
            print(f"产品名    {detection.product_name}")
        if detection.product_version:
            print(f"版本      {detection.product_version}")
        if detection.vendor:
            print(f"厂商      {detection.vendor}")
        if detection.silent_args:
            print(f"静默参数  {detection.silent_args}")
        print("证据")
        for item in detection.evidence:
            print(f"  - {item}")
        print()
        if detection.unsupported_reason:
            print(f"不支持：{detection.unsupported_reason}")
        else:
            print(f"可用于静态解包：{'是' if detection.kind in STATIC_EXTRACTABLE else '否（需走静默安装）'}")

    if detection.unsupported_reason and detection.kind is InstallerKind.UNKNOWN:
        # 「无法识别」是明确不支持（退出码 4），不是「还没做」。
        #
        # 这里必须自己写报告。修复前直接 return，落到 main 的兜底分支，
        # 那份兜底把所有非零且未写报告的情况统一标成 EOM_7001
        # （能力未实现）—— 用户读到「阶段未实现，后续版本会支持」，
        # 而真实情况是「这个文件根本不是安装包，任何版本都不会支持」。
        # 两者对用户下一步动作的指引完全相反：前者是等，后者是换文件。
        if tracker is not None:
            from .report import failure_report
            args.report_emitted = True
            _emit_report(failure_report(
                tracker=tracker,
                code="EOM_1005",
                message=detection.unsupported_reason,
                exit_code=int(ExitCode.UNSUPPORTED),
                hint="确认文件是 NSIS / Inno / InstallShield / MSI / Burn / Squirrel 之一",
                details=list(detection.evidence),
                command="detect",
            ))
        return ExitCode.UNSUPPORTED

    # detect 是只读识别，产物就是识别结果本身，不含文件产物。
    # 这里写一份带真实阶段状态的报告，否则前端会看到 8 个阶段全灰。
    if tracker is not None:
        from .report import success_report
        args.report_emitted = True
        _emit_report(success_report(
            tracker=tracker,
            artifact=None,
            input_info={
                "path": str(detection.path),
                "kind": str(detection.kind),
                "confidence": detection.confidence,
                "evidence": list(detection.evidence),
                "arch": detection.arch,
                "supported": detection.supported,
                "unsupportedReason": detection.unsupported_reason,
            },
            command="detect",
        ))

    return ExitCode.OK


def cmd_extract(args: argparse.Namespace) -> int:
    """静态解包，输出文件树与主 exe 候选。"""
    from .detect import detect_installer
    from .extract import extract
    from .report import StageTracker

    want_report = getattr(args, "report", False)
    tracker = StageTracker() if want_report else None

    if tracker is not None:
        tracker.enter("preflight")
    path = _require_file(args.installer)
    if tracker is not None:
        tracker.leave("preflight")
        tracker.enter("detect")

    detection = detect_installer(path)

    if detection.unsupported_reason:
        raise UnsupportedSoftware(detection.unsupported_reason)
    if tracker is not None:
        tracker.leave("detect")
        tracker.enter("extract")

    report = extract(path, args.out, kind=detection.kind,
                     product_name=detection.product_name)
    result = report.result
    assert result is not None

    if tracker is not None:
        tracker.leave("extract")
        for stage in ("prefix", "install", "scan", "package", "verify"):
            tracker.skip(stage)

    payload = {
        "ok": True,
        "root": str(result.root),
        "kind": str(result.kind),
        "file_count": result.file_count,
        "total_bytes": result.total_bytes,
        "attempts": [{"method": a.method, "ok": a.ok, "detail": a.detail}
                     for a in report.attempts],
        "warnings": report.warnings,
        "shortcut_entry": result.shortcut_entry,
        "candidates": [
            {"relpath": c.relpath, "size": c.size, "score": c.score,
             "reasons": c.reasons}
            for c in result.candidates[:args.max_candidates]
        ],
    }
    _emit(payload, args.json)

    if not args.json:
        print(f"解包目录  {result.root}")
        print(f"类型      {result.kind}")
        print(f"文件数    {result.file_count}  （{_human_size(result.total_bytes)}）")
        for attempt in report.attempts:
            mark = "OK" if attempt.ok else "FAIL"
            print(f"  [{mark}] {attempt.method or '未知方法'}: {attempt.detail}")
        for warning in report.warnings:
            print(f"  注意：{warning}")
        if result.shortcut_entry:
            # 这个值来自安装包作者写的快捷方式，比下面的打分可靠，
            # 单列一行并说明来源，避免用户以为是另一个候选
            print(f"声明入口  {result.shortcut_entry}（安装包的快捷方式指向）")
        print()
        if result.candidates:
            print("主 exe 候选")
            for index, candidate in enumerate(result.candidates[:args.max_candidates], 1):
                print(f"  {index}. {candidate.relpath}  "
                      f"（{_human_size(candidate.size)}，得分 {candidate.score}）")
                for reason in candidate.reasons:
                    print(f"       · {reason}")
        else:
            print("未找到 .exe 候选。可能是纯驱动包、纯资源包，或解包不完整。")

        if args.format in ("tree", "list"):
            _print_tree(result.root, args.format)

    if tracker is not None:
        from .report import success_report
        args.report_emitted = True
        _emit_report(success_report(
            tracker=tracker,
            artifact=str(result.root),
            artifact_bytes=result.total_bytes,
            warnings=list(report.warnings),
            input_info={
                "path": str(path),
                "kind": str(detection.kind),
                "confidence": detection.confidence,
                "productName": detection.product_name,
                "candidates": [c.relpath for c in result.candidates[:args.max_candidates]],
            },
            command="extract",
        ))

    return ExitCode.OK


def _human_size(size: int) -> str:
    units = ("B", "KB", "MB", "GB", "TB")
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{size} B"


def _print_tree(root: Path, style: str, limit: int = 200) -> None:
    """打印文件树。limit 防止大包把终端刷爆。"""
    entries = sorted(root.rglob("*"), key=lambda p: (len(p.parts), str(p)))
    print()
    print(f"文件树（最多 {limit} 条）")
    shown = 0
    for path in entries:
        if shown >= limit:
            print(f"  … 其余 {len(entries) - limit} 项省略")
            break
        rel = path.relative_to(root)
        depth = len(rel.parts) - 1
        name = rel.name + ("/" if path.is_dir() else "")
        if style == "list":
            print(f"  {rel.as_posix()}{'/' if path.is_dir() else ''}")
        else:
            print(f"  {'  ' * depth}{name}")
        shown += 1


def cmd_install(args: argparse.Namespace) -> int:
    """创建 prefix 并静默安装，产出 .app 骨架。"""
    from .detect import detect_installer
    from .errors import InstallFailed
    from .install import (InstallVerification, default_install_dir, run_install,
                          suppress_restart, wine_binary, wineboot_init)
    from .layers import mount_layer
    from .prefix import create_prefix, prefix_disk_usage

    # --report 时记录阶段，让前端能看出「走到哪一步停的」。
    want_report = getattr(args, "report", False)
    tracker = None
    if want_report:
        from .report import StageTracker
        tracker = StageTracker()

    path = _require_file(args.installer)
    app_dir = _require_app(args.out)

    # 检查顺序按"成本从低到高"排：
    #   1. 目标已存在（纯路径检查，最便宜，且这是不可恢复的参数错误）
    #   2. wine 运行时（硬前置，用户最常缺）
    #   3. 安装器类型（要读文件、解析 PE/CFB，最贵）
    if tracker is not None:
        tracker.enter("preflight")

    if app_dir.exists():
        raise UsageError(
            f"目标已存在：{app_dir}",
            hint="wepack 不删除已有 .app，请换路径或手动移走",
        )

    wine_binary()
    if tracker is not None:
        tracker.leave("preflight")
        tracker.enter("detect")

    detection = detect_installer(path)
    if detection.unsupported_reason:
        raise UnsupportedSoftware(detection.unsupported_reason)
    if tracker is not None:
        tracker.leave("detect")
        # install 不做静态解包（那是 extract 命令的事），显式标跳过。
        tracker.skip("extract")
        tracker.enter("prefix")

    app_name = _derive_app_name(args.app_name, detection, path)
    app_name = app_name.strip() or "App"

    contents = app_dir / "Contents"
    private_dir = contents / "Resources" / "Private"
    recipes_dir = contents / "Recipes"
    macos_dir = contents / "MacOS"

    for directory in (private_dir, recipes_dir, macos_dir,
                      contents / "Resources"):
        directory.mkdir(parents=True, exist_ok=True)

    log_path = recipes_dir / "install.log"
    from .install import write_install_log
    write_install_log(log_path, [
        f"INFO  detect {detection.kind} confidence={detection.confidence}",
        f"INFO  bundle {app_dir}",
    ])

    # ① 建 prefix（clonefile base 层）
    prefix_report = create_prefix(private_dir, layers=["base"])
    write_install_log(log_path, [
        f"INFO  prefix.create {private_dir}",
        *[f"INFO  clone {c.source.name} → {c.method} files={c.files}"
          for c in prefix_report.clones],
        *[f"WARN  {w}" for w in prefix_report.warnings],
    ])

    # ② 拦截重启
    suppress_restart(private_dir)
    if tracker is not None:
        tracker.leave("prefix")
        tracker.enter("install")

    # ③ 初始化 prefix（wineboot），让注册表与 system32 就位
    boot = wineboot_init(private_dir, timeout=min(args.timeout, 600))
    write_install_log(log_path, [
        f"INFO  prefix.wineboot code={boot.returncode} "
        f"duration={boot.duration:.1f}s",
    ])
    if not boot.ok:
        raise InstallFailed(
            "prefix 初始化失败（wineboot）",
            hint=(boot.stderr_tail or boot.stdout_tail or "")[:500],
        )

    # ④ 静默安装
    target_dir = default_install_dir(app_name)
    run = run_install(
        private_dir, path, detection,
        silent=not args.interactive,
        timeout=args.timeout,
        log_path=log_path,
        install_dir=target_dir,
        extra_args=args.silent_args.split() if args.silent_args else None,
    )

    # ④b 产物校验的结论：退出码 0 不等于装上了东西。
    #     校验在 run_install 内部完成（它才是安装的执行者），结论经
    #     InstallRun.ok 统一裁决；这里只取出来写日志和进 payload。
    #     delta / verify 两行 run_install 已经记过，此处不重复。
    verification = run.verification or InstallVerification(True)

    logical, actual = prefix_disk_usage(private_dir)
    write_install_log(log_path, [
        f"INFO  prefix.disk logical={logical} actual={actual}",
        f"INFO  install.result {'ok' if run.ok else 'failed'} code={run.returncode}",
    ])

    # ⑤ 安装后扫描：找主 exe
    #    先查配方：同一安装包装过一次后，入口与层都已确定，
    #    直接复用比重新扫描更稳 —— 打分是启发式的，同一份 prefix
    #    重新扫描理论上结果一致，但多程序目录下仍可能抖动。
    if tracker is not None:
        tracker.leave("install")
        tracker.enter("scan")

    recipe = None
    recipe_key_value = None
    if not getattr(args, "no_recipe", False):
        from .recipes import load, recipe_key
        try:
            recipe_key_value = recipe_key(path)
            recipe = load(recipe_key_value)
        except (UsageError, OSError):
            recipe = None

    entry = None
    if recipe is not None and recipe.entry:
        # 配方里的 entry 是上次的结果，先确认文件真的还在 ——
        # 安装器换版本后路径可能变，盲目信任会产出一个打不开的包
        if (private_dir / recipe.entry).is_file():
            entry = recipe.entry
            write_install_log(log_path, [
                f"INFO  scan.recipe key={recipe_key_value} entry={entry}",
            ])
        else:
            write_install_log(log_path, [
                f"WARN  scan.recipe key={recipe_key_value} "
                f"stale={recipe.entry}（文件已不存在，回退到重新扫描）",
            ])
            recipe = None

    if entry is None:
        entry = _find_installed_entry(private_dir, detection, app_name)

    if tracker is not None:
        tracker.leave("scan")

    # ⑥ 依赖层匹配：装完才知道主程序是哪个，才能扫它的导入表
    layers_report = None
    if entry and not args.no_layers:
        from .layers import match_layers
        layers_report = match_layers(private_dir, entry)
        write_install_log(log_path, [
            f"INFO  layers.match entry={entry} "
            f"deps={len(layers_report.dependencies)} "
            f"layers={','.join(layers_report.layers)}",
            *[f"WARN  {w}" for w in layers_report.warnings],
        ])
        # 只挂已安装的层；缺层不阻断安装 —— 应用可能不走到那条代码路径，
        # 强行失败会让"能装但缺 MFC"的包彻底装不上
        for name in layers_report.available:
            if name == "base":
                continue
            try:
                mount_layer(app_dir, name)
                write_install_log(log_path, [f"INFO  layers.mount {name}"])
            except (InstallFailed, UsageError) as exc:
                layers_report.warnings.append(f"挂载 {name} 层失败：{exc}")
                write_install_log(log_path, [f"WARN  layers.mount {name} failed={exc}"])

    # ⑦ 写配方：下次同一个安装包直接复用入口与层，跳过探测
    saved_recipe = None
    if (run.ok and entry and recipe_key_value
            and not getattr(args, "no_recipe", False)):
        from .models import CompatConfig, InstallerRecord
        from .recipes import save
        try:
            config = CompatConfig(
                app=app_name,
                version=detection.product_version or "",
                entry=entry,
                installer=InstallerRecord(
                    kind=detection.kind,
                    silent_args=detection.silent_args or "",
                    completed=True,
                    fallback_interactive=bool(args.interactive),
                ),
                layers=layers_report.layers if layers_report else ["base"],
                bundle_id="",     # bundle id 在 package 阶段才定，配方不预设
                icon_source=f"exe:{entry}#0",
            )
            saved_recipe = str(save(config, recipe_key_value))
            write_install_log(log_path, [f"INFO  recipe.save key={recipe_key_value}"])
        except (UsageError, OSError) as exc:
            write_install_log(log_path, [f"WARN  recipe.save failed={exc}"])

    if tracker is not None:
        # 阶段 3 才装配 Info.plist / 图标 / launcher，此处如实标跳过。
        tracker.skip("package")
        tracker.skip("verify")

    # 最终结论：装了文件 + 有入口，才算装成功。
    #
    # 这两条缺一不可。早先只看 run.ok 与退出码，entry 为空时函数返回 OK、
    # payload 里 ok=true，调用方拿到「成功但 entry: null」无从判断；到了
    # build 的打包阶段才由 _assemble_from_scratch 抛 UsageError（退出码 2），
    # 「安装失败」被误报成「参数错误」。现在在 install 阶段就如实失败。
    missing_entry = bool(run.ok and not entry)
    succeeded = run.ok and bool(entry)

    payload = {
        "ok": succeeded,
        "app": str(app_dir),
        "app_name": app_name,
        "kind": str(detection.kind),
        "prefix": str(private_dir),
        "install_dir": target_dir,
        "returncode": run.returncode,
        "duration": round(run.duration, 1),
        "timed_out": run.timed_out,
        "entry": entry,
        "layers": layers_report.layers if layers_report else ["base"],
        "layer_detail": layers_report.to_dict() if layers_report else None,
        "recipe": {
            "key": recipe_key_value,
            "hit": recipe is not None,
            "saved": saved_recipe,
        },
        "disk": {"logical": logical, "actual": actual},
        "verify": verification.to_dict(),
        "warnings": prefix_report.warnings + (layers_report.warnings if layers_report else []),
        "log": str(log_path),
    }
    if missing_entry:
        payload["error"] = "安装产物中未找到可执行入口"
        write_install_log(log_path, [
            "ERROR install.scan 安装产物中未找到可执行入口",
        ])
    _emit(payload, args.json)

    # 把结果挂到 args 上供 cmd_build 复用。
    # 不这么做的话 build 的 package 阶段会再探测一遍入口与层，
    # 既慢又可能得到不同结果（打分是启发式的）。
    args.install_result = payload

    if not args.json:
        print(f"应用包    {app_dir}")
        print(f"类型      {detection.kind}")
        print(f"安装目录  {target_dir}")
        print(f"退出码    {run.returncode}（耗时 {run.duration:.1f}s）")
        print(f"磁盘占用  逻辑 {_human_size(logical)} / 实际 {_human_size(actual)}")
        if entry:
            source = "配方复用" if recipe is not None else "扫描得出"
            print(f"入口程序  {entry}（{source}）")
        else:
            print("入口程序  未找到")
        if layers_report is not None:
            from .layers.match import describe
            for line in describe(layers_report):
                print(f"依赖层    {line}" if line.startswith("扫描") else f"          {line}")
        for warning in prefix_report.warnings:
            print(f"  注意：{warning}")
        for warning in (layers_report.warnings if layers_report else []):
            print(f"  注意：{warning}")
        if recipe_key_value:
            if recipe is not None:
                print(f"配方      {recipe_key_value}（命中，已跳过入口探测）")
            elif saved_recipe:
                print(f"配方      {recipe_key_value}（已保存，下次打包跳过探测）")
        print(f"安装日志  {log_path}")
        if not verification.passed:
            print()
            print(f"失败原因  {verification.reason}")
            print("安装器报告成功，但没有文件落到 prefix。常见原因：")
            print("  · 静默参数与该安装器不匹配（安装器弹了窗又自己退出）")
            print("  · 安装器在 Wine 下空转（Inno Setup 5.x 有此问题）")
            print("  可加 --interactive 走交互安装，或用 --silent-args 覆盖静默参数。")
            for line in _meaningful_stderr(run.stderr_tail):
                print(f"  {line}")
        elif missing_entry:
            print()
            print("失败原因  文件已写入 prefix，但没找到可执行入口程序。")
            print("可能装到了非预期目录、只释放了数据文件，或主程序后缀非常规。")
            print("可用 wepack package --entry <相对路径> 手工指定入口后继续。")
        elif not run.ok:
            print()
            print("安装失败。stderr 末尾：")
            for line in _meaningful_stderr(run.stderr_tail):
                print(line)

    if not succeeded:
        return ExitCode.INSTALL_FAILED

    # 成功时写统一报告。stdout 已被改道，这里写的是真 stdout。
    if tracker is not None:
        from .report import success_report
        args.report_emitted = True
        _emit_report(success_report(
            tracker=tracker,
            artifact=str(app_dir),
            artifact_bytes=actual,
            input_info={
                "path": str(path),
                "kind": str(detection.kind),
                "confidence": detection.confidence,
                "evidence": list(detection.evidence),
                "supported": True,
                "unsupportedReason": None,
            },
            warnings=prefix_report.warnings,
            command="install",
            duration_ms=int(run.duration * 1000),
        ))
    return ExitCode.OK


def _meaningful_stderr(text: str | None, *, keep: int = 12) -> list[str]:
    """从安装器的 stderr 里挑出对定位问题有用的行。

    ## 为什么需要这一层

    Wine 启动任何 GUI 程序都会往 stderr 灌一大批 MoltenVK / Vulkan 初始化
    日志（GPU 型号、扩展列表、着色器特性…）。安装器真出问题时，那几十行
    噪声会把唯一有价值的一两行彻底淹没。

    实测：Bulk Rename Utility 静默安装失败时，stderr 末尾 800 字节全是
    `[mvk-info] GPU device:` 与 `VK_*` 扩展名，用户看完不知道发生了什么。
    换成过滤后剩下的才是「为什么失败」。

    只在真正没有任何有效行时才回退原文 —— 宁可显示噪声，也不能什么都不说。
    """
    if not text or not text.strip():
        return ["(空)"]

    # MoltenVK / Vulkan 初始化噪声的特征前缀与关键词
    noise_markers = (
        "[mvk-info]", "[mvk-error]", "[mvk-warn]",
        "VK_KHR_", "VK_EXT_", "VK_GOOGLE_", "VK_INTEL_", "VK_NV_",
        "VK_MVK_", "VK_IMG_", "VK_AMD_", "VK_QCOM_",
    )
    # 这些行在日志里带 tab 缩进，必须用剥离后的内容比较
    noise_keys = (
        "GPU device:", "type:", "vendorID:", "deviceID:", "pipelineCacheUUID:",
        "GPU memory available:", "GPU memory used:", "Metal Shading Language",
        "supports the following GPU Features:", "model:",
    )

    useful: list[str] = []
    for raw in text.splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith(noise_markers):
            continue
        if stripped.startswith(noise_keys):
            continue
        # GPU 特性列表形如 "GPU Family Metal 3"，也属于噪声
        if stripped.startswith("GPU Family "):
            continue
        # "The following 145 Vulkan extensions are supported:"
        if "Vulkan extensions are supported" in stripped:
            continue
        # Vulkan 扩展条目形如 "VK_KHR_external_fence_capabilities v1"，
        # 也有的被终端宽度截断成 "XT_host_query_reset v1"（前缀丢了）。
        # 共同特征是「行尾是 v<数字>」且行内没有错误语义的词。
        tokens = stripped.split()
        if tokens and re.fullmatch(r"v\d+", tokens[-1]) and len(tokens) <= 3:
            continue
        # 剩余的都是 "Read-Write Texture Tier 2" 这类 GPU 能力名，
        # 以设备相关词开头且不含错误语义
        if stripped.startswith(("Read-Write ", "Shader ", "Sparse ", "Timeline ",
                                "Descriptor ", "Buffer ", "Draw ")):
            continue
        useful.append(line)

    if not useful:
        # 全是噪声时如实说明，别让用户以为是工具没输出
        return ["(只有 Wine 图形层日志，未给出安装器自身的错误信息)"]

    return useful[-keep:]


def _derive_app_name(explicit: str | None, detection, installer: Path) -> str:
    """推断应用名，按可信度从高到低。

    优先级：
      1. 用户显式 --app-name（最高，不容置疑）
      2. 安装器版本资源里的 ProductName
      3. 安装包文件名清洗后的结果

    第 3 步需要清洗：安装包文件名常带架构与版本尾巴，例如
    "Ondra-1.1.7-alpha-windows-x64-setup" 直接当应用名会得到
    "drive_c/Program Files/Ondra-1.1.7-alpha-windows-x64-setup"，
    既丑又会让 /D= 路径过长（NSIS 有 260 字符限制）。
    """
    if explicit:
        return explicit

    if detection.product_name:
        return detection.product_name

    return _clean_installer_stem(installer.stem)


#: 文件名里需要剥掉的噪声片段（小写比较）
_NAME_NOISE = (
    "setup", "installer", "install", "windows", "win32", "win64", "win",
    "x64", "x86", "amd64", "arm64", "i386", "alpha", "beta", "rc",
    "stable", "release", "portable", "full", "online", "offline",
)


def _clean_installer_stem(stem: str) -> str:
    """把安装包文件名清洗成可读的应用名。

    "Ondra-1.1.7-alpha-windows-x64-setup" → "Ondra"
    "7z2408-x64"                          → "7z2408"（数字保留，可能是产品名）
    "npp.8.6.9.Installer.x64"             → "npp"
    """
    import re

    # 先按常见分隔符切分
    tokens = re.split(r"[-_.\s]+", stem)
    kept: list[str] = []
    for token in tokens:
        if not token:
            continue
        lowered = token.lower()
        if lowered in _NAME_NOISE:
            continue
        # 纯版本号（1.1.7 已被切分成 1/1/7，这里处理 2408 这类）
        if token.isdigit() and len(token) >= 2 and kept:
            continue
        kept.append(token)

    if not kept:
        return stem

    # 组合规则：产品名通常在最前，后面是版本与平台。
    # 只在第一段很短（如 "MS Office" 的 "MS"）且第二段不是纯数字时才合并两段，
    # 避免 "npp 8" 这种把版本号粘进名字的结果。
    if len(kept) >= 2 and len(kept[0]) <= 3 and not kept[1].isdigit():
        name = f"{kept[0]} {kept[1]}"
    else:
        name = kept[0]
    return name.strip() or stem


def _name_tokens(name: str) -> list[str]:
    """把名字切成小写词序列，只保留字母数字。

    `7-Zip 24.08` → `['7', 'zip', '24', '08']`，`Notepad++` → `['notepad']`，
    `Node.js` → `['node', 'js']`。用于按**词**而不是按字符比对名字。
    """
    return [t for t in re.split(r"[^0-9a-z]+", name.lower()) if t]


def _contains_token_run(haystack: list[str], needle: list[str]) -> bool:
    """needle 是否作为**连续子序列**出现在 haystack 里。

    不是字符串子串 —— `['mode']` 不出现在 `['modem']` 里，因为词已经切
    开了。这正是要的效果：`Modem` 这个目录名不该被产品名 `mode` 认领。
    """
    span = len(needle)
    if span == 0 or span > len(haystack):
        return False
    return any(haystack[i:i + span] == needle
               for i in range(len(haystack) - span + 1))


def _names_relate(name: str, keywords: set[str]) -> bool:
    """目录名与任一个关键词是否**按词**相关，双向包含。

    ## 为什么不能直接用字符串子串

    原来这一层是 `k in name.lower() or name.lower() in k`。字符串子串没有
    词边界，短词会啃进长词中间：

        `modem`.lower() 含 `mode`       → 目录 Modem      被产品名 mode 认领
        `downloads`     含 `load`       → 目录 Downloads  被产品名 load 认领
        `appdata`       含 `app`        → 目录 appdata    被产品名 App 认领

    这些目录下都可能有 exe，路径 ① 一旦认领错目录，`best_candidate` 会
    立刻返回里面的 exe —— 用户装 App，入口指向 appdata 里的某个东西。

    ## 为什么必须双向

    产品名常常比目录名长（目录是作者自己起的短名）：

        目录 Ondra    产品名 Ondra 1.2.3          →  正向命中
        目录 App      产品名 App Installer         →  正向命中
        目录 Code     产品名 Visual Studio Code    →  反向命中

    只要一个方向就够了，但两个方向都得留着 —— 去掉反向，`Visual Studio
    Code` 装出来的 `Code/` 目录就认不出来，路径 ① 全废。

    ## 反向方向也有同样的词边界问题

    未被修掉的一例：目录 `nt` 配产品名 `Windows NT` 会命中（`['nt']` 确实
    是 `['windows','nt']` 的连续子段）。这个认领是**正确**的 —— 那两步
    就是同一个词。字符串子串在这里也一样命中，所以词边界没让它变差。
    真正的把关在下一步：`best_candidate` 要在该目录里选出主程序，而
    `Windows NT/Accessories/` 下的东西会被兜底闸门与排除规则筛掉。
    """
    dir_tokens = _name_tokens(name)
    if not dir_tokens:
        return False
    for keyword in keywords:
        key_tokens = _name_tokens(keyword)
        if not key_tokens:
            continue
        if (_contains_token_run(dir_tokens, key_tokens)
                or _contains_token_run(key_tokens, dir_tokens)):
            return True
    return False


def _filename_relates_to_product(relpath: str, product: str) -> bool:
    """文件名（去后缀）是否与产品名有关。无关时兜底不该认它。

    ## 为什么兜底需要这道闸

    `rank_candidates` 的产品名匹配只值 +35 分。整层扫描时「在 Program
    Files 下 +25」「GUI +20」「有图标 +10」加起来就 55 分，足以让一个
    毫不相关的残留程序排到第一。实测在 base 层的 `Program Files/` 下分别
    搜 `Notepad`、`TotallyDifferentApp`、`Zzzz`，三次返回的都是同一个
    `Windows NT/Accessories/wordpad.exe` —— 产品名对兜底结果毫无影响。

    ## 判据复用 candidates 的归一化

    `_normalize` 去分隔符与数字（`PDF24` → `pdf`），`_squash` 只去分隔符
    （`7-Zip` → `7zip`）。两种形式都比，避免 `7z` ↔ `7zip` 这类错位。

    ## 只认「相等 / 前缀 / 后缀」，不认任意子串

    任意子串会把 `Pa` 匹配到 `wordpad`（`pa` 出现在中间）。要求前后缀
    之后这类误判消失，而真实场景都还能过：

        notepad  ↔ notepad    相等
        7z       ↔ 7zfm       前缀
        net      ↔ dotnet     后缀（产品名 "Microsoft .NET Runtime"）
        code     ↔ code       相等（产品名 "Microsoft Visual Studio Code"）

    ## 前后缀还要留够余量

    只要求「前缀或后缀」仍然太松：多出来的那一个字符足以把无关名字粘
    上来。`mode` 是 `modem` 的前缀，只差 1 个字符 —— 于是产品名 `mode`
    会认领 `Modem.exe`。实测这条真的漏过去了：路径 ① 已经被词边界判据
    挡住（`Modem` 目录不被 `mode` 认领），兜底这一层却把它放了回来，
    端到端结果照样是错的。

    所以要求被比较的两边**长度差至少 2**：

        modem  ↔ mode     差 1 → 拒绝
        appx   ↔ app      差 1 → 拒绝
        7zfm   ↔ 7z       差 2 → 接受
        dotnet ↔ net      差 3 → 接受

    相等永远接受，不受此限。这条不影响现有的任何一个真实用例（逐项验过：
    `App`/`MyApp`/`node`/`chromium`/`notepad++`/`Code`/`firefox`/`dotnet`/
    `7z`/`7zFM` 全部照旧通过）。

    ## 与打分器保持一致的边界

    `7zFM.exe` 配产品名 `7-Zip` 时**过不了这道闸** —— 因为归一化后是
    `zfm` vs `zip`/`7zip`，打分器本身也不认为它们相关（上一轮确认过：
    `7zFM` 是靠 GUI 加分胜出的，不是靠产品名匹配）。这里不另立标准：
    闸门比打分器宽，兜底就会返回打分器都觉得不像的东西。

    实际 7-Zip 安装包走的是路径 ①（产品名匹配子目录 `7-Zip/`），不经过
    兜底，所以这条边界不影响真实使用。

    产品名为空时**放行**：调用方没给名字，就没有依据筛，此时返回排名第一
    与旧行为一致（也多亏这条，既有调用点不会因为新闸门全部失配）。
    """
    if not product:
        return True

    from .extract.candidates import _normalize, _product_words, _squash

    stem = relpath.rsplit("/", 1)[-1]
    if stem.lower().endswith(".exe"):
        stem = stem[:-4]
    forms = tuple(f for f in (_normalize(stem), _squash(stem)) if len(f) >= 2)
    if not forms:
        return False

    for word in _product_words(product):
        # 分词保留原样，`.NET` 这种会带着前导点进来（`_product_words` 只在
        # `-` / `_` 处切分，不切 `.`）。这里再归一化一次，让 `.net` → `net`
        # 能对上 `dotnet` 的后缀。改 `_product_words` 会牵动打分器，不在
        # 这个提交里做。
        word = _squash(word) if len(word) >= 2 else ""
        if len(word) < 2:
            continue
        for form in forms:
            if word == form:
                return True
            # 前后缀匹配要求长度差 ≥ 2。只差 1 个字符时，「前缀」和「拼写
            # 相近的另一个词」无法区分 —— `mode` 是 `modem` 的前缀，但
            # Modem.exe 显然不是产品名 mode 的程序。
            if form.startswith(word) or form.endswith(word):
                if len(form) - len(word) >= 2:
                    return True
            if word.startswith(form) or word.endswith(form):
                if len(word) - len(form) >= 2:
                    return True
    return False


def _find_installed_entry(private_dir: Path, detection, app_name: str) -> str | None:
    """在安装后的 prefix 里找主 exe，返回相对 private_dir 的路径。

    搜索顺序（按"最可能是安装目标"排序）：
      0. `C:\\Wacmin` 下的产品目录 —— 本工具的默认安装位置（见 install.default_install_dir）
      1. Program Files / Program Files (x86) 下的产品目录
      2. AppData/Local 下的产品目录 —— Electron/Squirrel 类安装器会忽略
         NSIS 的 /D=，把应用装到 AppData/Local/<产品名>（实测空谷 Ondra 如此）
      3. Program Files 全盘兜底
      4. AppData/Local 全盘兜底

    ## 为什么 C:\\Wacmin 排第一

    默认安装目录之所以不是 Program Files，是因为 NSIS 的 `/D=` 在含空格
    路径上必然失效（详见 install.silent_args_for 的说明）。既然默认装到
    `C:\\Wacmin\\<App>`，这里就必须先搜那里 —— 否则会出现「装成功了但
    找不到入口」这种自相矛盾的结果。

    排在 Program Files 之前还有一层理由：那是本工具自己写的位置，命中
    即可确定是本次安装的产物；Program Files 里可能残留 base 层自带的
    系统组件。

    都不命中时返回 None，由调用方提示用户手动指定。
    """
    from .extract.candidates import best_candidate, rank_candidates

    drive_c = private_dir / "drive_c"
    if not drive_c.is_dir():
        return None

    product = (detection.product_name or app_name or "").strip()
    keywords = {app_name.lower()} if app_name else set()
    if product:
        keywords.add(product.lower())
    keywords = {k for k in keywords if k}

    def matches(name: str) -> bool:
        return _names_relate(name, keywords)

    # 候选搜索根，按优先级排列。
    #
    # 这里原本是 `list[tuple[Path, bool]]`，第二项在两处遍历里都被 `_`
    # 丢弃 —— 是「曾经打算区分某种状态、后来没用上」的残留。留着它会让
    # 读代码的人以为那个 bool 有意义（比如「是否递归」），进而照着它写
    # 新逻辑。直接退回成路径列表。
    search_roots: list[Path] = [
        drive_c / "Wacmin",
        drive_c / "Program Files",
        drive_c / "Program Files (x86)",
    ]
    # AppData/Local 是每个用户的，遍历所有用户目录
    users_dir = drive_c / "users"
    if users_dir.is_dir():
        for user_home in users_dir.iterdir():
            if not user_home.is_dir():
                continue
            local = user_home / "AppData" / "Local"
            if local.is_dir():
                search_roots.append(local)

    # ① 先按产品名匹配子目录
    for root in search_roots:
        if not root.is_dir():
            continue
        try:
            children = [c for c in root.iterdir() if c.is_dir()]
        except OSError:
            continue
        for candidate_dir in children:
            if not matches(candidate_dir.name):
                continue
            candidate = best_candidate(candidate_dir, product_name=product)
            if candidate is not None:
                absolute = candidate_dir / candidate.relpath
                try:
                    return absolute.relative_to(private_dir).as_posix()
                except ValueError:
                    continue

    # ② 全盘兜底：排除系统目录
    #
    # ## 这里必须校验「与产品名有关」，否则返回的是纯排名第一
    #
    # `rank_candidates(root, product_name=product)` 里产品名只占 +35 分。
    # 在 Program Files 这种整层扫描里，一份没装成功的残留程序照样能靠
    # 「在 Program Files 下 +25」「GUI +20」「有图标 +10」拿到 60 分以上，
    # 把产品名那 35 分淹掉 —— 于是不管搜哪个产品名，返回值都一样。
    #
    # 实测（base 层真实内容，`Program Files/` 下搜三个毫不相关的名字）：
    # 产品名 Notepad / TotallyDifferentApp / Zzzz，返回的都是同一个
    # `Windows NT/Accessories/wordpad.exe`。用户装 Notepad，得到写字板。
    #
    # 兜底的本意是「产品名匹配不到子目录时，再从整层里找找」，不是
    # 「随便给一个能双击的 exe」。所以要求文件名与产品名有关系 ——
    # 判据复用 candidates 里的归一化，比在这里另写一套更不容易漂移。
    excluded_prefixes = (
        "drive_c/windows/",
        "drive_c/Program Files/Common Files/",
        "drive_c/Program Files/Windows ",
        "drive_c/Program Files/Internet Explorer/",
    )
    for root in search_roots:
        if not root.is_dir():
            continue
        ranked = rank_candidates(root, product_name=product, limit=10)
        for candidate in ranked:
            if not _filename_relates_to_product(candidate.relpath, product):
                continue
            absolute = root / candidate.relpath
            try:
                relative = absolute.relative_to(private_dir).as_posix()
            except ValueError:
                continue
            if any(relative.startswith(prefix) for prefix in excluded_prefixes):
                continue
            return relative

    return None


def cmd_package(args: argparse.Namespace) -> int:
    """给一个已装好 prefix 的 .app 补齐 Info.plist / 图标 / launcher。"""
    from .package import repackage
    from .package.icon import BADGE_COLOR_GRAY, BADGE_COLOR_WINBLUE

    app = _require_app(args.app)
    if not app.exists():
        raise UsageError(f".app 不存在：{app}",
                         hint="先跑 wepack install 建立包骨架与 prefix")

    color = args.badge_color or (
        BADGE_COLOR_GRAY if args.badge == "gray" else BADGE_COLOR_WINBLUE)

    want_report = getattr(args, "report", False)
    tracker = None
    if want_report:
        from .report import StageTracker
        tracker = StageTracker()
        for stage in ("preflight", "detect", "extract", "prefix", "install", "scan"):
            tracker.skip(stage)
        tracker.enter("package")

    report = repackage(
        app,
        style=args.badge,
        color=color,
        icon_source=args.icon,
        register=not args.no_register,
        entry=getattr(args, "entry", None),
        app_name=getattr(args, "app_name", None),
        layers=getattr(args, "layers", None),
    )

    if tracker is not None:
        tracker.leave("package")
        tracker.enter("verify")

    checks = [c.to_dict() for c in report.checks]
    payload = {
        "ok": report.ok,
        "app": str(report.app_dir),
        "app_name": report.app_name,
        "bundle_id": report.bundle_id,
        "version": report.version,
        "entry": report.entry,
        "plist": str(report.plist) if report.plist else None,
        "icon": str(report.icon) if report.icon else None,
        "launcher": str(report.launcher) if report.launcher else None,
        "compat": str(report.compat) if report.compat else None,
        "registered": report.registered,
        "checks": checks,
        "warnings": report.warnings,
    }
    _emit(payload, args.json)

    if not args.json:
        print(f"应用包    {report.app_dir}")
        print(f"Bundle ID {report.bundle_id}")
        print(f"入口程序  {report.entry}")
        print("校验")
        for check in report.checks:
            mark = "OK  " if check.ok else ("FAIL" if check.required else "WARN")
            line = f"  [{mark}] {check.name}"
            if check.detail:
                line += f"  {check.detail}"
            print(line)
        for warning in report.warnings:
            print(f"  注意：{warning}")
        if report.registered:
            print("已注册到 LaunchServices")
        elif not args.no_register:
            print("注册到 LaunchServices 失败（首次打开时系统会自行重建索引）")

    if tracker is not None:
        tracker.leave("verify")

    if not report.ok:
        raise VerifyFailed("产物校验未通过：" + "；".join(
            f"{c.name}（{c.detail}）" for c in report.checks if c.required and not c.ok))

    if want_report and tracker is not None:
        from .report import success_report
        args.report_emitted = True
        _emit_report(success_report(
            tracker=tracker,
            artifact=str(report.app_dir),
            artifact_bytes=_tree_size(report.app_dir),
            checks=checks,
            warnings=report.warnings,
            input_info={"path": str(app), "kind": "app-bundle"},
            command="package",
        ))

    return ExitCode.OK


def cmd_build(args: argparse.Namespace) -> int:
    """一键流程：install → package。"""
    from .package import bundle_dir_name
    from .package.plist import make_bundle_id

    path = _require_file(args.installer)

    # build 复用 install 与 package 的代码路径，不复制逻辑。
    # 这样两处行为永远一致，不会出现"分步能成、一键失败"的怪现象。
    from .detect import detect_installer
    detection = detect_installer(path)
    if detection.unsupported_reason:
        raise UnsupportedSoftware(detection.unsupported_reason)

    app_name = _derive_app_name(args.app_name, detection, path).strip() or "App"
    out_dir = args.out_dir.expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    app_dir = out_dir / bundle_dir_name(app_name)

    if app_dir.exists():
        if not args.force:
            raise UsageError(
                f"目标已存在：{app_dir}",
                hint="加 --force 会把它移到废纸篓后重建",
            )
        _trash(app_dir)

    # ① 安装。构造一份与 install 子命令等价的参数对象，直接复用其实现。
    install_args = argparse.Namespace(
        installer=path, out=app_dir, app_name=app_name,
        timeout=getattr(args, "timeout", 1800),
        interactive=False, silent_args=None,
        no_layers=getattr(args, "no_layers", False),
        no_recipe=getattr(args, "no_recipe", False),
        json=args.json, report=False, verbose=getattr(args, "verbose", False),
    )
    code = cmd_install(install_args)
    if code != ExitCode.OK:
        return code

    # ② 装配。install 已经确定了入口与层，直接传进去，
    #    避免 package 再探测一遍（慢且可能结果不同）。
    installed = getattr(install_args, "install_result", {}) or {}
    bundle_id = make_bundle_id(
        f"{detection.vendor or 'app'}.{app_name}".lower(), seed=app_name)
    package_args = argparse.Namespace(
        app=app_dir, icon=None, badge="w", badge_color=None,
        no_register=False, json=args.json, report=False,
        entry=installed.get("entry"),
        app_name=app_name,
        layers=installed.get("layers"),
        verbose=getattr(args, "verbose", False),
    )
    return cmd_package(package_args)


def _tree_size(root: Path) -> int:
    """目录总字节数（按 st_size 累加，符号链接不跟随）。"""
    total = 0
    for path in Path(root).rglob("*"):
        try:
            if path.is_file() and not path.is_symlink():
                total += path.stat().st_size
        except OSError:
            continue
    return total


def _trash(target: Path) -> None:
    """把路径移到废纸篓，可恢复。

    **不用 `rm`**：删错了没法救。三条路径按可靠性降级：

      1. `osascript` 调 Finder —— 最标准，但需要「自动化」权限，
         沙箱环境下会报 -10004 权限违例
      2. `trash` CLI（若用户装了）
      3. 手动移到 `~/.Trash/` 并处理重名

    第 3 条是最后兜底，纯 Python 实现，不依赖任何外部权限。
    """
    import subprocess

    target = Path(target).expanduser().resolve()
    if not target.exists():
        return

    # ① Finder
    script = (
        'tell application "Finder" to delete POSIX file "'
        + str(target) + '"'
    )
    try:
        result = subprocess.run(["osascript", "-e", script],
                                capture_output=True, **TEXT_MODE, timeout=30)
        if result.returncode == 0:
            return
    except (OSError, subprocess.SubprocessError):
        # osascript 是「想请 Finder 帮忙」的锦上添花，系统没开辅助功能
        # 就失败。后面还有 trash 命令行兜底，这里不能中断流程。
        # osascript 是「想请 Finder 帮忙」的锦上添花，系统没开辅助功能
        # 就失败。后面还有 trash 命令行兜底，这里不能中断流程。
        pass

    # ② trash CLI
    if shutil.which("trash"):
        try:
            result = subprocess.run(["trash", str(target)],
                                    capture_output=True, **TEXT_MODE, timeout=30)
            if result.returncode == 0:
                return
        except (OSError, subprocess.SubprocessError):
            # trash 命令不可用（macOS 未装 trash-cli）时继续走下一步。
            # 后面还有直接 rmtree 的兜底，用户要删的东西最终都会被删掉。
            # trash 命令不可用（macOS 未装 trash-cli）时继续走下一步。
            # 后面还有直接 rmtree 的兜底，用户要删的东西最终都会被删掉。
            pass

    # ③ 直接移进 ~/.Trash，重名时加时间戳后缀
    trash_dir = Path.home() / ".Trash"
    if not trash_dir.is_dir():
        raise UsageError(
            f"无法把 {target} 移到废纸篓：{trash_dir} 不存在",
            hint=f"请手动删除：{target}",
        )
    destination = trash_dir / target.name
    if destination.exists():
        from datetime import datetime
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        destination = trash_dir / f"{target.stem}.{stamp}{target.suffix}"
    try:
        shutil.move(str(target), str(destination))
    except OSError as exc:
        raise UsageError(
            f"无法把 {target} 移到废纸篓：{exc}",
            hint=f"请手动删除：{target}",
        ) from exc


def cmd_layers_list(args: argparse.Namespace) -> int:
    from .layers import list_layers

    infos = list_layers()
    payload = {
        "ok": True,
        "layers": [
            {"name": i.name, "path": str(i.path), "exists": i.exists,
             "ok": i.ok, "files": i.files, "bytes": i.bytes,
             "description": i.description, "problems": i.problems}
            for i in infos
        ],
    }
    _emit(payload, args.json)

    if not args.json:
        width = max((len(i.name) for i in infos), default=6)
        for info in infos:
            mark = "OK  " if info.ok else ("MISS" if not info.exists else "BAD ")
            size = _human_size(info.bytes) if info.exists else "-"
            print(f"[{mark}] {info.name:<{width}}  {size:>10}  {info.description}")
            for problem in info.problems:
                if info.exists:
                    print(f"           · {problem}")
    return ExitCode.OK


def cmd_layers_verify(args: argparse.Namespace) -> int:
    from .layers import list_layers, verify_layer

    if args.name:
        problems = verify_layer(args.name)
        payload = {"ok": not problems, "layer": args.name, "problems": problems}
        _emit(payload, args.json)
        if not args.json:
            if problems:
                print(f"{args.name} 校验失败：")
                for problem in problems:
                    print(f"  · {problem}")
            else:
                print(f"{args.name} 校验通过")
        return ExitCode.OK if not problems else ExitCode.VERIFY_FAILED

    results = {info.name: info.problems for info in list_layers() if info.exists}
    failed = {k: v for k, v in results.items() if v}
    payload = {"ok": not failed, "results": results}
    _emit(payload, args.json)
    if not args.json:
        for name, problems in results.items():
            print(f"{name}: {'通过' if not problems else '失败'}")
            for problem in problems:
                print(f"  · {problem}")
    return ExitCode.OK if not failed else ExitCode.VERIFY_FAILED


def cmd_layers_mount(args: argparse.Namespace) -> int:
    from .layers import mount_layer

    private = mount_layer(args.app, args.name)
    payload = {"ok": True, "layer": args.name, "private": str(private)}
    _emit(payload, args.json)
    if not args.json:
        print(f"已挂载 {args.name} → {private}")
    return ExitCode.OK


def cmd_layers_build(args: argparse.Namespace) -> int:
    from .layers import build_base_layer

    if args.name != "base":
        raise UsageError(
            f"层 {args.name} 需要用户提供安装包，无法自动构建",
            hint=("当前只支持自动构建 base。vcpp / dotnet / fonts-cn "
                  "需手动把安装结果放进 layers/<name>/"),
        )

    info = build_base_layer(timeout=args.timeout)
    payload = {"ok": info.ok, "layer": info.name, "path": str(info.path),
               "files": info.files, "bytes": info.bytes,
               "problems": info.problems}
    _emit(payload, args.json)

    if not args.json:
        if info.ok:
            print(f"base 层已构建：{info.path}")
            print(f"  {info.files} 个文件，{_human_size(info.bytes)}")
        else:
            print("构建未完成：")
            for problem in info.problems:
                print(f"  · {problem}")
    return ExitCode.OK if info.ok else ExitCode.VERIFY_FAILED


def cmd_layers_match(args: argparse.Namespace) -> int:
    """扫描导入表，算出需要哪些层。不写文件（除非给了 --apply）。"""
    from .layers import match_layers
    from .layers.match import describe

    exe = args.entry.expanduser()
    if not exe.is_file():
        raise UsageError(f"文件不存在：{exe}")

    # entry 用相对 Private 的路径表示；直接给 exe 时从它所在目录反推 Private。
    # 找不到 Private 祖先时退化为"以 exe 所在目录为根"，只扫这一个文件。
    private_dir = _guess_private_dir(exe)
    if private_dir is not None:
        try:
            entry_rel = exe.resolve().relative_to(private_dir.resolve()).as_posix()
        except ValueError:
            entry_rel = exe.name
            private_dir = exe.parent
    else:
        private_dir = exe.parent
        entry_rel = exe.name

    result = match_layers(private_dir, entry_rel)

    applied: list[str] = []
    if args.apply is not None:
        from .layers import mount_layer
        app_dir = _require_app(args.apply)
        for name in result.available:
            if name == "base":
                continue
            mount_layer(app_dir, name)
            applied.append(name)

    payload = {**result.to_dict(), "ok": result.ok, "applied": applied}
    _emit(payload, args.json)

    if not args.json:
        for line in describe(result):
            print(line)
        print()
        if result.dependencies:
            print("依赖明细")
            for dep in result.dependencies:
                if dep.in_base:
                    source = "base"
                elif dep.provided_by:
                    source = f"{dep.provided_by} 层"
                elif dep.is_system:
                    source = "系统（无需处理）"
                else:
                    source = "无层可补"
                print(f"  {dep.name:<18} {source}")
        if applied:
            print(f"\n已挂载：{', '.join(applied)}")

    if result.missing:
        # 缺层不是"命令失败"，而是"需要用户补东西"，用 5（缺外部依赖）更准确
        return ExitCode.MISSING_DEP
    return ExitCode.OK


def _guess_private_dir(exe: Path) -> Path | None:
    """从 exe 路径往上找 `Resources/Private` 祖先。找不到返回 None。"""
    for parent in exe.resolve().parents:
        if parent.name == "Private" and parent.parent.name == "Resources":
            return parent
    return None


def cmd_recipe_list(args: argparse.Namespace) -> int:
    """列出本地配方。"""
    from .recipes import list_recipes
    from . import paths as wexe_paths

    recipes = list_recipes()
    payload = {
        "ok": True,
        "root": str(wexe_paths.recipes_root()),
        "count": len(recipes),
        "recipes": recipes,
    }
    _emit(payload, args.json)

    if not args.json:
        if not recipes:
            print(f"配方库为空：{wexe_paths.recipes_root()}")
            print("跑一次 wepack build 或 wepack recipe save 后会在这里生成配方。")
        else:
            width = max(len(r["key"]) for r in recipes)
            print(f"配方库  {wexe_paths.recipes_root()}（{len(recipes)} 条）")
            print()
            for item in recipes:
                if not item["ok"]:
                    print(f"  [BAD ] {item['key']:<{width}}  文件损坏：{item['path']}")
                    continue
                app = item["app"] or "-"
                version = item["version"] or "-"
                print(f"  {item['key']:<{width}}  {app}  {version}  {item['updated']}")
    return ExitCode.OK


def cmd_recipe_show(args: argparse.Namespace) -> int:
    """查看一条配方。`key` 也可以直接给安装包路径，自动算键。"""
    from .recipes import load, recipe_key

    raw = args.key
    path = Path(raw).expanduser()
    key = raw
    if path.is_file():
        key = recipe_key(path)

    config = load(key)
    if config is None:
        payload = {"ok": False, "key": key, "error": f"配方不存在：{key}"}
        _emit(payload, args.json)
        if not args.json:
            print(f"没有找到配方：{key}")
            print("用 wepack recipe list 查看已有的键。")
        return ExitCode.USAGE

    payload = {"ok": True, "key": key, "config": config.to_dict()}
    _emit(payload, args.json)
    if not args.json:
        from .recipes import dump_compat
        print(f"配方 {key}")
        print()
        print(dump_compat(config), end="")
    return ExitCode.OK


def cmd_recipe_save(args: argparse.Namespace) -> int:
    """从已打包的 .app 导出配方，供下次打包跳过探测。"""
    from .recipes import read_compat, save

    app = _require_app(args.app)
    config = read_compat(app)
    key = args.key or _recipe_key_from_config(config)
    target = save(config, key)

    payload = {"ok": True, "key": key, "path": str(target),
               "app": config.app, "version": config.version}
    _emit(payload, args.json)
    if not args.json:
        print(f"配方已保存：{target}")
        print(f"  键 {key}")
        print(f"  应用 {config.app} {config.version}")
        print("同一安装包下次 build 时会自动套用，跳过入口探测与层匹配。")
    return ExitCode.OK


def cmd_recipe_rm(args: argparse.Namespace) -> int:
    """删除一条配方。只删配方库里的文件，不碰任何 .app。"""
    from . import paths as wexe_paths

    root = wexe_paths.recipes_root()
    target = root / f"{args.key}.yaml"
    if not target.is_file():
        raise UsageError(f"配方不存在：{args.key}",
                         hint=f"用 wepack recipe list 查看 {root} 下已有的键")

    # 删的是配方库里的缓存文件，不是用户数据。仍然走废纸篓，可恢复。
    _trash(target)
    payload = {"ok": True, "key": args.key, "removed": str(target)}
    _emit(payload, args.json)
    if not args.json:
        print(f"配方已移到废纸篓：{target}")
    return ExitCode.OK


def _recipe_key_from_config(config) -> str:
    """没有安装包可哈希时，用应用名+版本拼一个稳定的键。

    这里不追求全局唯一：配方库是用户本地的缓存，同名同版本撞车时
    后写的覆盖前写的，属于可接受行为（内容本来就一样）。

    版本为空时只留应用名 —— 拼成 `t-` 这种带尾巴的键既难看又难输入。
    """
    import re

    parts = [config.app.strip(), (config.version or "").strip()]
    base = "-".join(p for p in parts if p)
    cleaned = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff._-]+", "-", base).strip("-")
    return (cleaned or "recipe").lower()[:64]


def cmd_version(args: argparse.Namespace) -> int:
    payload = {"wepack": __version__, "phase": PHASE, "python": platform.python_version()}
    _emit(payload, args.json)
    if not args.json:
        print(f"wepack {__version__}  phase {PHASE}  python {platform.python_version()}")
    return ExitCode.OK


# -- runtime ----------------------------------------------------------------


def cmd_runtime_status(args: argparse.Namespace) -> int:
    from . import runtime

    info = runtime.inspect()
    payload = {
        "ok": info.ok,
        "installed": info.installed,
        "root": str(info.root),
        "wine": str(info.wine) if info.wine else None,
        "version": info.version,
        "arch": info.arch,
        "source": info.source,
        "problems": info.problems,
    }
    _emit(payload, args.json)

    if not args.json:
        print(f"运行时目录  {info.root}")
        if not info.installed:
            print("状态        未安装")
            for problem in info.problems:
                print(f"  · {problem}")
            print()
            print("安装方式：wepack runtime install")
        else:
            print(f"状态        已安装")
            print(f"wine        {info.wine}")
            print(f"版本        {info.version or '未知'}")
            print(f"架构        {info.arch or '未知'}")
            if info.source:
                print(f"来源        {info.source}")
            for problem in info.problems:
                print(f"  问题：{problem}")

    return ExitCode.OK if info.ok else ExitCode.MISSING_DEP


def cmd_runtime_install(args: argparse.Namespace) -> int:
    from . import runtime

    existing = runtime.inspect()
    if existing.installed and not existing.problems:
        payload = {"ok": True, "already_installed": True,
                   "wine": str(existing.wine), "version": existing.version}
        _emit(payload, args.json)
        if not args.json:
            print(f"运行时已就绪：{existing.wine}（{existing.version}）")
        return ExitCode.OK

    info = runtime.install(
        archive=args.archive,
        url=args.url or runtime.DEFAULT_WINE_URL,
        from_vendor=args.from_vendor,
        progress=not args.json,
    )

    payload = {
        "ok": info.ok,
        "installed": info.installed,
        "root": str(info.root),
        "wine": str(info.wine) if info.wine else None,
        "version": info.version,
        "arch": info.arch,
        "source": info.source,
        "problems": info.problems,
    }
    _emit(payload, args.json)

    if not args.json:
        if info.ok:
            print(f"安装完成：{info.wine}")
            print(f"版本 {info.version}  架构 {info.arch}")
        else:
            print("安装未完成，问题：")
            for problem in info.problems:
                print(f"  · {problem}")

    return ExitCode.OK if info.ok else ExitCode.MISSING_DEP


# -- doctor -----------------------------------------------------------------


def _check_rosetta() -> tuple[bool, str]:
    """Apple Silicon 上必须有 Rosetta 2，否则 x86_64 wine 起不来。"""
    if platform.machine() != "arm64":
        return True, f"非 Apple Silicon（{platform.machine()}），无需 Rosetta"
    probe = Path("/Library/Apple/usr/libexec/oah/libRosettaRuntime")
    if probe.exists():
        return True, "Rosetta 2 已安装"
    # 兜底：用 arch -x86_64 跑一个极轻的命令
    try:
        r = subprocess.run(["/usr/bin/arch", "-x86_64", "/usr/bin/true"],
                           capture_output=True, timeout=10)
        if r.returncode == 0:
            return True, "Rosetta 2 已安装（arch -x86_64 探测通过）"
    except (OSError, subprocess.SubprocessError):
        # 探测本身失败就当「没装」：arch 命令不存在或超时，结论一致，
        # 都是「现在跑不了 x86_64」。
        pass
    return False, "未安装 Rosetta 2，执行：softwareupdate --install-rosetta --agree-to-license"


def _check_wine() -> tuple[bool, str]:
    """wine 运行时。阶段 2 起是必需项（install 依赖它）。

    用 runtime.inspect() 而不是只看文件存在 —— 它会校验架构必须是 x86_64，
    arm64 原生构建在 Apple Silicon 上跑不了 Windows PE。
    """
    from . import runtime

    info = runtime.inspect()
    if not info.installed:
        return False, (f"未安装。执行 wepack runtime install"
                       f"（预期位置 {info.root}/bin/wine64）")
    if info.problems:
        return False, "；".join(info.problems)
    return True, f"{info.wine}（{info.version}，{info.arch}）"


def _check_tool(name: str, path: str | None = None) -> tuple[bool, str]:
    resolved = path or shutil.which(name)
    if resolved and Path(resolved).exists():
        return True, resolved
    return False, f"缺少 {name}"


def cmd_doctor(args: argparse.Namespace) -> int:
    from . import paths

    checks: list[dict] = []

    def record(name: str, required: bool, result: tuple[bool, str]) -> None:
        ok, detail = result
        checks.append({"name": name, "ok": ok, "required": required, "detail": detail})

    record("platform", True, (platform.machine() == "arm64" or platform.machine() == "x86_64",
                              f"{platform.system()} {platform.release()} / {platform.machine()}"))
    record("rosetta2", platform.machine() == "arm64", _check_rosetta())
    record("python", True, (sys.version_info >= (3, 11), platform.python_version()))
    record("wine", True, _check_wine())
    record("sips", True, _check_tool("sips", "/usr/bin/sips"))
    record("iconutil", True, _check_tool("iconutil", "/usr/bin/iconutil"))

    # 解包工具清单与必需性统一由 tools.probe_all 给出，doctor 不再自抄一份。
    # 早先两边各写一遍：7z 在这里带版本号探活、另两个走 _check_optional_tool，
    # 而 tools.probe_all 里的同一批数据无人问津 —— 新增工具时必然漏掉一边。
    from . import tools as _tools
    probes = _tools.probe_all(required_for={"7z": True, "innoextract": False,
                                            "msiextract": False})
    for name, probe in probes.items():
        if probe["ok"]:
            detail = str(probe["path"])
            if name == "7z":
                # 7z 的版本号对排查很关键（p7zip 与 7-Zip 官方版行为有差异）
                tool = _tools.find_tool("7z", required=False)
                if tool is not None:
                    detail = f"{tool.path}（{_tools.tool_version(tool)}）"
            record(name, bool(probe["required"]), (True, detail))
        else:
            purpose = probe["purpose"] or "解包"
            hint = probe["hint"] or f"请安装 {name}"
            if probe["required"]:
                record(name, True, (False, f"缺少 {name}：{hint}（阶段 1 静态解包必需）"))
            else:
                record(name, False, (False, f"未安装（{purpose}）。{hint}"))

    # 目录可写性
    home = paths.wexe_home()
    try:
        paths.ensure_dirs()
        probe = home / ".doctor-probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        record("wexe_home", True, (True, str(home)))
    except OSError as exc:
        record("wexe_home", True, (False, f"{home} 不可写：{exc}"))

    failed_required = [c for c in checks if c["required"] and not c["ok"]]

    # --report 模式：输出契约报告，供 console 汇总
    # 这不是「另一套输出」，而是把上面同一份 checks 换一种封装。
    # 早先缺这一步，导致 console 的 doctor 汇总对 exeonmac 只能显示
    # EOM_7001（尚未接入统一报告）。
    if getattr(args, "report", False):
        from .report import StageTracker, failure_report, success_report

        tracker = StageTracker()
        tracker.enter("preflight")

        # doctor 的 checks 结构与本方向的 report.checks 不同：
        # 这里是 {name, ok, required, detail}，报告要 {name, passed, detail, severity}
        report_checks = [
            {
                "name": c["name"],
                "passed": c["ok"],
                "detail": c["detail"],
                "severity": "required" if c["required"] else "advisory",
            }
            for c in checks
        ]

        if failed_required:
            tracker.mark_failed("EOM_2001")
            report = failure_report(
                tracker=tracker,
                code="EOM_2001",
                message=f"{len(failed_required)} 项必需条件不满足："
                        + "、".join(c["name"] for c in failed_required),
                exit_code=int(ExitCode.MISSING_DEP),
                hint="见 doctor 的逐项输出",
                command="doctor",
            )
            # 失败报告里也带上 checks，用户才能看到是哪一项
            report["checks"] = report_checks
        else:
            tracker.leave("preflight")
            report = success_report(
                tracker=tracker,
                artifact=None,
                checks=report_checks,
                command="doctor",
            )
        # 写进真正的 stdout（此刻 sys.stdout 已被改道到 stderr）
        _emit_report(report)
        # 告诉 main「报告已输出」，否则它会用兜底报告覆盖这一份
        # （兜底报告只有 stages 与 error，没有 checks）
        args.report_emitted = True
        return ExitCode.OK if not failed_required else ExitCode.MISSING_DEP

    payload = {
        "phase": PHASE,
        "ok": not failed_required,
        "checks": checks,
        "wexe_home": str(home),
    }
    _emit(payload, args.json)

    if not args.json:
        width = max(len(c["name"]) for c in checks)
        for c in checks:
            mark = "OK  " if c["ok"] else ("FAIL" if c["required"] else "WARN")
            print(f"[{mark}] {c['name']:<{width}}  {c['detail']}")
        print()
        if failed_required:
            print(f"{len(failed_required)} 项必需条件不满足，先修复再进入后续阶段。")
        else:
            print(f"必需条件全部满足。当前阶段 {PHASE}。")
        optional_missing = [c["name"] for c in checks if not c["required"] and not c["ok"]]
        if optional_missing:
            print(f"可选但缺失：{', '.join(optional_missing)}"
                  f"（不阻塞阶段 {PHASE}，影响后续阶段或降低精度）")

    return ExitCode.OK if not failed_required else ExitCode.MISSING_DEP


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    # 注入原始 argv：参数解析失败时 _ReportAwareParser.error 要靠它判断
    # 是否带了 --report，以及用户想跑哪个子命令。
    parser.set_argv(sys.argv[1:] if argv is None else argv)
    args = parser.parse_args(argv)

    if not getattr(args, "command", None):
        parser.print_help()
        return ExitCode.USAGE

    setup(verbose=getattr(args, "verbose", False))
    log = get_logger()
    log.debug("wepack %s phase %s argv=%s", __version__, PHASE, argv if argv is not None else sys.argv[1:])

    want_report = getattr(args, "report", False)
    real_stdout = sys.stdout

    try:
        if want_report:
            # 命令执行期间 stdout 改道到 stderr，保证最后 stdout 只有报告 JSON。
            with _StdoutToStderr(real_stdout):
                code = int(args.func(args))
        else:
            code = int(args.func(args))
    except WexeError as exc:
        log.error("%s", exc.message)
        if exc.hint:
            log.error("提示：%s", exc.hint)
        if getattr(args, "json", False):
            _emit_report({"ok": False, "error": exc.message, "hint": exc.hint,
                          "exit_code": int(exc.exit_code)}, stream=real_stdout)
        if want_report:
            from .report import StageTracker, error_code_for, failure_report
            _emit_report(failure_report(
                tracker=StageTracker(),
                code=error_code_for(exc),
                message=exc.message,
                exit_code=int(exc.exit_code),
                hint=exc.hint,
                command=getattr(args, "command", "unknown"),
            ), stream=real_stdout)
        return int(exc.exit_code)
    except KeyboardInterrupt:
        log.error("已中断")
        if want_report:
            from .report import StageTracker, failure_report
            _emit_report(failure_report(
                tracker=StageTracker(),
                code="EOM_9001",
                message="已中断",
                exit_code=130,
                command=getattr(args, "command", "unknown"),
            ), stream=real_stdout)
        return 130

    # 子命令自己已经把报告写进 stdout 时不要再写一份。
    # 约定：子命令若支持 --report，会在 args 上挂 report_emitted=True。
    if want_report and not getattr(args, "report_emitted", False):
        from .report import StageTracker, failure_report, success_report
        tracker = StageTracker()
        command = getattr(args, "command", "unknown")
        if code == 0:
            # 命令成功但没写报告（如 version / doctor）：给一份最小的成功报告，
            # 保证 ok 与 exitCode 一致。契约要求 ok === (exitCode == 0)，不能破。
            payload = success_report(tracker=tracker, artifact=None, command=command)
        else:
            payload = failure_report(
                tracker=tracker,
                code="EOM_7001",
                message=f"{command} 尚未接入统一报告",
                exit_code=code,
                hint="该子命令属于后续阶段，或尚未迁移到 --report",
                command=command,
            )
        _emit_report(payload, stream=real_stdout)
    return code


if __name__ == "__main__":
    raise SystemExit(main())