---
name: wacmin
description: 跨平台打包与兼容层（四方向）。在 macOS 上把项目打成 Windows 安装包、把 Windows 安装包封装成可双击的 .app、在 Windows 上产出 macOS 应用包、评估 macOS 应用在 Windows 上的可行性。当用户提到「打成 exe / 安装包 / Windows 版」「Mac 上跑 Windows 程序」「Windows 上打 mac 包」「这个 app 能不能在 Windows 跑」，或需要排查 makensis / wine / 7z / Rosetta 相关构建失败时使用。也覆盖产物校验：架构对不对、权限位对不对、符号链接是否仍是链接。
version: "1.0.0"
author: "ntars"
license: MIT
allowed-tools: [Bash, Read, Grep, Glob]
---

# Wacmin：四方向打包与兼容层

## 这个项目能做什么

四个方向，两两对称。**先确定方向，再谈怎么做** —— 选错方向会白跑几分钟。

| 方向 | 宿主 | 动作 | 产出 |
|---|---|---|---|
| `mac2win` | macOS | 打包成 Windows 程序 | NSIS `.exe` 安装包，可选 `.zip` |
| `exeonmac` | macOS | 运行 Windows 程序 | 可双击的 `.app`（内含 wine prefix） |
| `win2mac` | Windows | 打包成 macOS 程序 | `.app` 目录 + 保留权限位的 `.zip` |
| `apponwin` | Windows | 运行 macOS 程序 | **只有评估报告**，运行能力尚未定论 |

判据很短：

- 用户要「Windows 上能装的包」且人在 Mac 上 → `mac2win`
- 用户要「Mac 上点开就能用的 app」且手上是 `.exe` → `exeonmac`
- 用户要「Mac 上能开的包」且人在 Windows 上 → `win2mac`
- 用户问「这个 mac app 能不能在 Windows 上跑」→ `apponwin`，且必须先说清只做评估

## 调用方式（三种，按场景选）

### 1. MCP 工具（agent 环境里首选）

若客户端已接入 `wacmin` MCP server，直接用工具，不要让用户去敲命令：

- `wacmin_list_directions` —— 先问「这里有什么」，永远安全
- `wacmin_doctor` —— 环境行不行，只读
- `wacmin_build` —— 要产物，会写盘
- `wacmin_verify` —— 只校验，不重打
- `wacmin_assess` —— 只评估，不执行
- `wacmin_run` —— 上面没覆盖的选项走这里，参数原样透传

### 2. 统一命令行

```bash
node ai/bin/wacmin.mjs list --human
node ai/bin/wacmin.mjs doctor --human
node ai/bin/wacmin.mjs run mac2win build <项目目录> --dry-run
node ai/bin/wacmin.mjs run exeonmac detect ~/Downloads/npp.exe
```

`wacmin run` 的退出码就是那个方向的退出码，可直接判断成败。

### 3. 各方向原生 CLI（需要该方向独有的选项时）

```bash
node mac2win/bin/mac2win.mjs --help
node win2mac/bin/win2mac.mjs --help
node apponwin/bin/apponwin.mjs --help
cd exeonmac && python3 -m wepack --help
```

## 必须遵守的三条纪律

### 一、构建前先自检

**多数构建失败不是代码问题，是缺外部工具。** 直接跑 `build` 然后在报错里
逐条翻译，比先跑 `doctor` 慢得多，而且报错往往只说「缺 makensis」，不说
「该怎么装」。

```bash
node ai/bin/wacmin.mjs doctor --human
```

自检返回 5 表示缺外部依赖，这是**环境问题**，不是用法问题。把缺什么、怎么装
直接告诉用户，不要让他去翻日志。

### 二、不要把 `ok` 与 `complete` 混为一谈

校验报告有两个正交的维度：

- `ok` —— 有没有查出问题
- `complete` —— 是不是全验了

`ok: true, complete: false` 意味着**没验完，不能声称通过**。本项目专门为这个
坑做过修复：早期缺 7-Zip 时校验器会说「✓ 校验通过」并退 0，而实际上一项都
没验。用户拿着这个结论去分发，比校验失败危险得多。

所以回答用户时，`complete` 为假就要明说「这次只验了 X，Y 和 Z 没验，因为缺
某工具」。

### 三、退出码含义固定，不要自己解释

| 码 | 含义 | 用户该做什么 |
|---|---|---|
| 0 | 成功 | —— |
| 1 | 未归类失败 | 看 stderr 尾部 |
| 2 | 参数与输入错误 | 改参数，不是环境问题 |
| 3 | 能力未实现 | 这个功能还没做，不要当成 bug |
| 4 | 明确不支持 | 输入物落在硬边界内，不要试图绕过 |
| 5 | 缺外部依赖 | 装工具，不是改代码 |
| 6 | 构建或安装失败 | 项目本身的问题 |
| 7 | 产物校验失败 | 产物坏了，需要重打 |
| 130 | 用户中断 | —— |

**5 与 7 必须分开讲**：5 是「我没验」（装工具重跑），7 是「验了，产物是坏的」
（重打包）。混成一个，用户会照着错误的方向排查。

## 常见任务的做法

### 「帮我把这个项目打成 Windows 安装包」

```bash
# 1. 确认宿主是 macOS，且工具齐备
node ai/bin/wacmin.mjs run mac2win doctor

# 2. 先跑预检，不落盘，看它打算做什么
node ai/bin/wacmin.mjs run mac2win build <项目目录> --dry-run

# 3. 预检通过再真跑
node ai/bin/wacmin.mjs run mac2win build <项目目录> --target x86
```

第 2 步不要跳。`--dry-run` 会检查入口文件、前端产物目录、框架判定、
架构可行性，这些错了在真跑时也要花时间才能暴露。

### 「这个 .exe 能不能在 Mac 上跑」

```bash
# 先识别安装器类型，再决定
node ai/bin/wacmin.mjs run exeonmac detect <安装包路径>
```

`detect` 能给的类型有 NSIS / Inno / InstallShield / MSI / Burn / Squirrel。
不是所有类型都能处理 —— 返回 4 表示明确不支持，此时不要建议用户「再试试
别的参数」，那是浪费时间。

### 「这个包打出来能用吗」

```bash
node ai/bin/wacmin.mjs run mac2win verify <产物路径>
```

读结果时先看 `exitCode`，再看 `complete`，最后看 `checks` 里哪一项没过。
架构不符是 7，缺工具是 5，两者处置完全不同。

## 环境依赖（缺了会退 5）

| 方向 | 必需 | 用途 |
|---|---|---|
| `mac2win` | `makensis` | 编译 NSIS 安装包 |
| `mac2win` | `7z` | 校验时解包比对 |
| `exeonmac` | `wine`（x86_64） | 运行 Windows 程序 |
| `exeonmac` | Rosetta 2 | Apple Silicon 上跑 x86 wine |
| `exeonmac` | `7z` / `innoextract` | 静态解包 |
| `win2mac` | 无（Node 内置即可） | —— |
| `apponwin` | 无（纯解析） | —— |

macOS 上装法：`brew install makensis sevenzip`。
Rosetta 2：`softwareupdate --install-rosetta --agree-to-license`。

## 不要做的事

- **不要在没跑 `doctor` 的情况下反复重试 `build`**。缺工具时重试一百次也是失败。
- **不要把 `ok: true` 当成「一切正常」**，先看 `complete`。
- **不要承诺 `apponwin` 一定能跑**。它目前只有评估能力，运行能力的三条门槛
  里第 2 条（AppKit 窗口）尚未在目标环境实测通过。用户问「能不能跑」时，
  如实说「能评估，但运行能力还没有定论」。
- **不要修改产物内容**。本项目的设计原则是「只做路径重定向与包装，不改原
  安装包、不改安装产物」。需要改内容时，那已经超出本项目范围。
- **不要联网**。本项目不发起任何网络请求，除了 mac2win 下载 Node 运行时
  （可用 `--runtime` 指定离线文件绕过）。

## 出错时怎么查

1. 先看 `exitCode`，对照上表定位到类别
2. `5` → 跑 `doctor`，把缺的工具告诉用户
3. `6` / `7` → 看报告的 `error.code`，形如 `M2W_1002`，前缀表示方向，
   段位表示类别（1xxx 环境输入 / 2xxx 外部工具 / 4xxx 输入物处理 /
   5xxx 产物生成 / 6xxx 产物校验）
4. `2` → 参数问题，去看对应方向的 `--help`
5. 都没有头绪 → 把 `stderr` 尾部（最后几十行）原样贴出来，不要只贴摘要

## 项目仓库结构

```
ai/                 本 skill、MCP server、统一 CLI
console/            本地看板（Web + SSE 进度）
contracts/          退出码与报告格式的唯一真源
mac2win/            macOS → Windows 安装包
exeonmac/           macOS 上运行 Windows 程序
win2mac/            Windows → macOS 应用包
apponwin/           Windows 上运行 macOS 程序（评估）
```

四个方向各有一份契约实现，报告格式统一。`contracts/` 是唯一真源 ——
任何关于退出码、错误码段位的问题都以它为准，不要凭报告里的某个字段猜。
