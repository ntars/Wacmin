**简体中文** | [English](README_EN.md)

# Wacmin

**打破 macOS 与 Windows 的架构限制，让两个平台的应用双向互通。**

Wacmin is a bidirectional interoperability suite between macOS and Windows: four directions formed by crossing two hosts with two actions.

![Status](https://img.shields.io/badge/status-4%20of%204%20delivered-brightgreen?style=flat-square)
[![GitHub license](https://img.shields.io/github/license/ntars/Wacmin?style=flat-square)](./LICENSE)
[![GitHub Star](https://img.shields.io/github/stars/ntars/Wacmin?style=flat-square)](https://github.com/ntars/Wacmin/stargazers)
[![GitHub Fork](https://img.shields.io/github/forks/ntars/Wacmin?style=flat-square)](https://github.com/ntars/Wacmin/network/members)
![GitHub Repo size](https://img.shields.io/github/repo-size/ntars/Wacmin?style=flat-square&color=3cb371)
[![GitHub Repo Languages](https://img.shields.io/github/languages/top/ntars/Wacmin?style=flat-square)](https://github.com/ntars/Wacmin/search?l=javascript)

[![Host](https://img.shields.io/badge/host-macOS%20%7C%20Windows-000000.svg?style=flat-square&logo=apple&logoColor=white)](#)
[![Directions](https://img.shields.io/badge/directions-4-2ea44f.svg?style=flat-square)](#)
[![Contract](https://img.shields.io/badge/contract-shared%20layer-8957e5.svg?style=flat-square)](#)
[![Dependencies](https://img.shields.io/badge/dependencies-0%20third--party-8957e5.svg?style=flat-square)](#六技术栈与依赖清单)

---

## 一、项目名称与定位

> **仓库描述 / Description**：`Wacmin —— 打破 macOS 与 Windows 的架构限制，四个方向实现双向互通（mac2win / exeonmac / win2mac / apponwin） | Breaking the macOS-Windows architecture barrier: four directions for two-way interop, each usable on its own.`
>
> **话题标签 / Topics**（20 个，仅英文）：`apple-silicon`, `arm64`, `cross-compilation`, `cross-compile`, `developer-tools`, `electron`, `exe`, `ia32`, `interop`, `macos`, `nsis`, `nwjs`, `packaging`, `tauri`, `windows`, `windows-installer`, `wine`, `x86`, `cross-platform`, `app-migration`


**名称**：Wacmin。取自 **W**indows **a**nd **Mac** **in**terop 的首字母拼合。

**一句话定位**：把「macOS 与 Windows 之间的应用互通」拆成四个方向，每个方向独立成立，但共用一层对外契约。

**定位的三条边界**：

1. **它是互通套件，不是虚拟机**。不提供完整的 Windows 或 macOS 运行环境，只解决「产出安装包」与「运行程序」两类具体动作。
2. **四个方向相互独立**。任一方向的依赖、测试、发布都不影响其余三个；不做「必须全装才能用」的整体包。
3. **契约先行**。退出码、错误码段位、报告结构在 `contracts/` 单点定义，四个方向必须遵守——这是它们能被称为「一个项目」而不是「四个项目的集合」的唯一理由。

**与 PCL 一类工具的关系**：本项目的 `mac2win` 方向（原名 arm2exe）只解决「在 Mac 上打 Windows 包」，不涉及游戏启动器业务。两者是不同品类。

### 1.1 文档的组织方式

本仓库采用**单文档制**：全部说明集中在根目录的 `README.md`（中文）与 `README_EN.md`（英文），许可全文集中在 `LICENSE` 与 `LICENSE-MIT`，分层路由集中在 `LICENSING.md`，第三方与商标声明集中在 `NOTICE`。子目录不保留任何独立文档。

理由有三条：

1. **五个子项目共用同一套契约与同一批外部工具**。把依赖清单拆成五份，必然出现同一份 7-Zip 条目在五处各写一遍、版本号各不相同的情况。
2. **读者需要横向对照**。四个方向的能力边界本来就靠对比才说得清；分散成五份文档后，读者要么来回切换，要么只读一份而误以为其他方向也一样。
3. **法律文本不宜分散**。两份许可全文在根目录，分层路由集中在 `LICENSING.md`，一旦分散维护，就存在某一处漏改的持续风险。

因此本文件按二十章组织，每一章内部再按方向分节。**任意一节的结论都以代码与实测为准**，不引用子文档中的二手数字。

---

## 二、项目简介

### 2.1 背景

macOS 与 Windows 之间的应用互通，长期靠三类方案：虚拟机（Parallels、VMware）、兼容层（Wine、CrossOver）、云桌面。三者各有代价——虚拟机要一份完整系统镜像，兼容层覆盖不全，云桌面依赖网络与订阅。

而在独立开发场景里，真实需求往往更窄：**只是想在这台 Mac 上打一个 Windows 安装包发给用户**，或者**只想在 Mac 上跑一下别人给的 exe 看看效果**。为这类需求装一整台虚拟机，成本与收益不成比例。

具体到四个方向，背景各不相同。

**Mac2Win 的背景**：Apple Silicon 上打 Windows x86 包，长期被认为要么需要 Windows 机器，要么需要完整交叉编译工具链。实际上 Electron 43 及以下、NW.js、Node.js 官方都发布 `win32-ia32` 或 `win-x86` 预编译包，把它们下载下来装进 NSIS 即可，全程不需要编译器。

**ExeOnMac 的背景**：在 Apple Silicon Mac 上运行 Windows 软件，虚拟机隔离性最好但要装一整个 Windows，磁盘占用以十 GB 计；商业兼容层开箱可用但闭源收费，产物落在厂商管理的共享目录里；手动配置 Wine 最灵活，但要求用户理解 `WINEPREFIX`、`WINEDLLOVERRIDES`、`wineboot` 这一套概念。更关键的一点：**这三类方案里没有一种会把 Windows 软件变成 Dock 里那个图标**，用户拿到的仍然是启动器或容器管理界面。

**Win2Mac 的背景**：反方向几乎空白。在 Windows 上产出一个 macOS `.app`，本质是装配而非编译——摆好 `Contents/` 目录结构、写一份合法 `Info.plist`、打成一个保留 Unix 权限位的 zip。难点全部在细节里：zip 中央目录的外部属性如何存 mode、bundle id 唯一性、Windows 上按角色推断权限。

**AppOnWin 的背景**：Darling 官方只支持 Linux，Windows 上要经 WSL2，GUI 支持被上游标注为 "basic and experimental"。这是四个方向里唯一可能不成立的一环，因此被排到最后，并且预先定义了降级路径。

### 2.2 要解决的问题

1. **方向不完整**。现有工具大多只做单向：要么 Mac 上跑 Windows 程序（Wine 系），要么在 Mac 上打 Windows 包（交叉编译系）。反方向（Windows 上打 macOS 包、Windows 上跑 mac 程序）几乎空白。
2. **行为不一致**。四个方向若各自设计退出码与错误格式，脚本层就得写四套判断逻辑，无法统一驱动。
3. **确定性不可比**。有些方向技术底座成熟（NSIS 打包、Wine 运行），有些方向底座本身还在实验阶段（Darling）。混在一起谈「支持」会误导用户。
4. **产物不可识别、不可卸载**。Windows 安装器默认把文件写进共享 prefix，多个软件互相干扰；装完之后找不到「程序在哪」；删除程序后 prefix 里残留注册表与 DLL，越积越多。
5. **校验器撒谎**。多数打包工具只报「构建成功」，不验产物；少数会验，但缺依赖时降级成警告而不是明确失败——用户拿到一份「已通过校验」的报告，而载荷里四千多个文件一个都没比对。

### 2.3 核心思路

**宿主 × 动作 = 2 × 2，刚好填满，没有遗漏格。**

| 顺位 | 代号 | 宿主 | 动作 | 目录 | CLI | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **Mac2Win** | macOS | 产出 Windows 安装包 | [`mac2win/`](./mac2win) | `mac2win` | 完成 |
| 2 | **ExeOnMac** | macOS | 运行 Windows 程序 | [`exeonmac/`](./exeonmac) | `wepack` | 完成 |
| 3 | **Win2Mac** | Windows | 产出 macOS 应用包 | [`win2mac/`](./win2mac) | `win2mac` | 完成 |
| 4 | **AppOnWin** | Windows | 运行 macOS 程序 | [`apponwin/`](./apponwin) | `apponwin` | 评估可用 |

**开发顺序按确定性排**：先把能成的做完，把最可能不成立的留到最后。理由见 5.1 节。

四个方向的结构同构：每个子项目都是同一套七层骨架，只是「输入物」与「产物」互换。

| 层 | 职责 | mac2win | exeonmac | apponwin | win2mac |
|---|---|---|---|---|---|
| `bin/` | 单命令入口，支持 `--json` 与 `--report` | ✓ | ✓ | ✓ | ✓ |
| `config` | 配置归一化 | ✓ | ✓ | 命令行参数 | 命令行参数 |
| `errors` | 错误码 + 退出码 | ✓ | ✓ | ✓ | ✓ |
| `detect` | 识别输入物 | 框架识别 | 安装器识别 | 包格式识别 | 框架识别 |
| `build` | 分阶段编排，失败即停 | 8 阶段 | 8 阶段 | 8 阶段（含评估） | 8 阶段 |
| `verify` | 产物校验 | 11 项 | 10 项 | 结构校验 | 结构校验 |
| `report` | 统一报告 | ✓ | ✓ | ✓ | ✓ |

### 2.4 适用场景

- 独立开发者在 Mac 上开发，需要给 Windows 用户发安装包；
- 需要在 Mac 上快速验证一个 Windows 程序的运行效果，不想开虚拟机；
- 需要在 Windows 上产出 macOS 应用包（装配式，不需编译）；
- 希望 Windows 软件出现在启动台与 Spotlight 里，像原生应用一样被找到；
- 需要在多台机器间迁移某个已配置好的 Windows 应用；
- 需要一套统一的脚本接口来驱动上述多个方向；
- 想研究 Wine prefix 的隔离与复用机制。

### 2.5 非目标

- 不做完整虚拟机：不提供系统镜像、不模拟硬件。
- 不做游戏启动器：不涉及游戏版本管理与模组。
- 不做性能优化承诺：兼容层的性能由底层决定，本项目只做接线。
- 不承诺 AppOnWin 一定成立：Darling 在 Windows 上的可行性未验证，见 5.1.2 节。
- 不做自研 PE 加载器、不接 FEX、不做 API 语义映射层。
- 不装 macFUSE、不装 kext、不装系统扩展。
- 不修改原安装包，不修改安装产物文件内容，只做路径重定向与包装。
- 不联网上传任何用户数据。

---
## 三、核心功能

### 3.1 Mac2Win：在 macOS 上产出 Windows 安装包

| 能力 | 说明 | 状态 |
|---|---|---|
| 框架识别 | 自动识别 Electron / NW.js / Tauri / 纯 Node / 静态站点 | 完成 |
| 运行时获取 | 下载对应框架的 Windows x86 预编译运行时 | 完成 |
| 依赖收集 | 从入口走 require 图，拦截原生模块 | 完成 |
| 暂存与垫片 | 按框架摆目录，注入桌面壳兼容垫片 | 完成 |
| NSIS 打包 | 生成安装脚本并编译为 `.exe` | 完成 |
| 产物校验 | 十一项校验：PE 格式、架构、GUI 子系统、必需文件、载荷内运行时架构、逐文件哈希比对 | 完成 |
| 图形界面 | 本地控制台：填路径、调参数、看进度与报告 | 完成 |

**四条落地路线**（同一套阶段编排，产物形态不同）：

| 路线 | 做法 | 产物形态 | 实测状态 |
|---|---|---|---|
| A · 预编译二进制重打包 | 下载框架官方 x86 预编译包，把用户项目塞进去，改名，NSIS 封装 | 原生窗口 | 已端到端实测：Electron 43、NW.js 0.90 |
| B · Node 运行时 + 自建启动器 | 用 Node 官方 `win-x86` 承载逻辑，自写零依赖启动器拉起宿主、托管静态文件、开浏览器 | 浏览器界面 | 已端到端实测：空谷 Ondra（Tauri 项目） |
| C · cargo-xwin 编译 Rust 壳 | `cargo xwin build --target i686-pc-windows-msvc` 在 mac 上编出真 Tauri 壳 | 原生窗口 | 依赖树已验证可链接成 PE32/i386；完整项目卡在 `llvm-rc`（本机未装），见 15.10 |
| D · 未走的路 | Wine 跑 makensis、Zig 交叉编译、Docker Windows 容器、自研 PE 链接器、换系统 WebView2 | — | 逐条记录了不走的理由 |

**八阶段编排**：`preflight` → `project-build` → `runtime` → `collect` → `stage` → `manifest` → `package` → `verify`，任一阶段失败即停，后续阶段标 `skipped`。

### 3.2 ExeOnMac：在 macOS 上运行 Windows 程序

| 能力 | 说明 | 状态 |
|---|---|---|
| 安装器识别 | 区分 NSIS / Inno Setup / InstallShield / MSI / Burn / Squirrel | 完成 |
| 静态解包 | 不安装即还原文件树与主 exe 候选 | 完成 |
| Wine 运行时 | 内置或复用 Wine，配合 Rosetta 2 翻译 x86_64 | 完成 |
| prefix 与静默安装 | 创建 Wine prefix，走各安装器的静默参数 | 完成 |
| `.app` 封装 | 生成 Info.plist、图标、Swift launcher | 完成 |
| 分层包装 | 底座、层、配方三阶段 | 完成 |
| 配方库 | 针对特定程序的兼容配方（`~/.wexe/recipes`） | 完成 |

当前实现阶段为 **phase 5**（`wepack version` 可查），测试全部通过且 **0 项跳过**。测试样本一律现场生成：MSI 用纯 Python 拼装 CFB 容器，NSIS 调 `makensis` 编译，Inno 调 ISCC 在 wine 下编译真实安装包后再用 `innoextract` 解回来。Wine 不随本项目分发，由 `wepack runtime install` 从上游获取。

#### 3.2.1 安装器识别

判定顺序固定，**硬结构证据先于字符串证据**。顺序不能换：Burn 本身也是 MSI，NSIS 的字符串也可能出现在别的安装器资源里。

| 类型 | 判定依据 | 实测置信度 |
|---|---|---|
| MSI | CFB 头 `D0CF11E0A1B11AE1` + 根存储 CLSID `000C1084-0000-0000-C000-000000000046` | 0.99 |
| WiX Burn | 同上，且流名含 `WixBundle*` | 0.90 |
| NSIS | overlay 起始 `+4` 处 `DEADBEEF`，`+8` 处 `NullsoftInst`；`.ndata` 节区 | 0.99 |
| Inno Setup | 载荷含 `Inno Setup Setup Data (x.y.z)`；`.itext` 节区 | 0.99 |
| InstallShield | `ISSetupStream` / `_setup.dll` 字符串 | 0.35–0.90 |
| Squirrel | `Squirrel` 字符串 + 同目录 `.nupkg` | 0.50–0.90 |

每种判定都输出证据链（`evidence` 数组），说明为什么判成这个类型，判错时才有得查。

**MSI 的判定为什么用 CLSID 而不是流名**：MSI 在 CFB 容器里的流名是私有编码，`_StringPool` 实际存成 `䡀㼿䕷䑬㹪䒲䠯` 这样的乱码，按名字查找必然失败。根存储 CLSID 是结构字段，不参与编码，是最可靠的依据。

#### 3.2.2 静态解包

| 类型 | 路径 | 说明 |
|---|---|---|
| NSIS | 7-Zip 直接解 | LZMA / bzip2 / deflate 支持完整，一次到位 |
| Inno Setup | innoextract（唯一可行路径） | 7-Zip 只能切出 PE 节区，已改为如实报错而非假成功 |
| MSI | msiextract 优先，回退三步流程 | 见下 |

MSI 的回退流程是三步：7-Zip 解出内嵌 `cab`、展开每个 `cab`、按 MSI 的 File 与 Directory 表把 `fil<hex>` 哈希名还原成真实文件名与目录。只做前两步的话，用户看到的是几百个哈希名文件，等于没解。

#### 3.2.3 主程序定位

解包结果里哪个 exe 是用户想双击的？打分器按位置、子系统、体积、文件名匹配、同级 DLL 数量、图标资源等维度加权，每条加减分都写进 `reasons`。关键权重：

| 信号 | 分值 |
|---|---|
| 位于 Program Files 下 | +25 |
| 位于解包根目录 | +25 |
| GUI 子系统 | +20（控制台 −30） |
| 文件名与产品名一致 | +35（近似 +20） |
| 同级 ≥3 个 DLL | +12 |
| 同级存在 `.pak` / `.asar` / `.resources` / `.dat` | +8 |
| 含图标资源 | +10 |
| 位于安装器临时目录（`$TEMP` / `$PLUGINSDIR` / `AppData/Local/Temp` / 顶层 `temp/`） | −60 |
| 文件名含 `unins` / `setup` / `update` / `node` / `python` | −45 |

两类信号是**直接排除**而不是扣分：命中运行时组件名（`msedge` / `webview2` / `edgecore` 等）或运行时路径标记（`/windows/`、`/common files/`）的 exe 不进候选列表 —— 扣分不够，Electron 应用的 `msedge.exe` 靠体积和 GUI 特征能反超主程序。

这两层里只有 `/dotnet/` 允许产品名豁免。其余标记说的是「这是系统或安装器自己的地方」，与产品名无关 —— 产品名叫 Windows 也不该把 `system32/x.exe` 当入口。`/dotnet/` 却是一个**合法安装位置**：`.NET` 运行时自己就装成 `dotnet/dotnet.exe`，而 `RUNTIME_COMPONENTS_EXEMPTABLE` 里早就认了「产品名是 .NET 时 `dotnet.exe` 就是主程序」。修复前路径层无条件排除，实测 `dotnet/MyDotnetApp.exe` 配产品名 `MyDotnetApp` 返回空 —— 一个与 .NET 无关的普通应用，只因为装在 `dotnet/` 子目录就整体消失。豁免判据与组件名层一致，都看「文件名是否匹配产品名」。

`$INSTDIR` **不**在这个列表里：它是用户选择的安装目标目录，`$INSTDIR/App.exe` 就是要装的那个程序。

黑名单遇到产品名匹配时会让步。产品名来自安装包自带的版本资源，是作者自己写的，比启发式黑名单可信：产品名叫 Node.js 时 `node.exe` 不加 `node` 的 −45，产品名叫 Chromium 时 `chromium.exe` 不被运行时组件规则排除。反面例子是实测踩到的 —— `node.exe` 拿到 +20 又被无条件扣 45，最后 `uninstall.exe` 靠 GUI +20 反超，用户双击后弹出卸载程序。

实测：NSIS 样本里 `ondra.exe` 得 75 分，`node/bin/node.exe` 被扣到 −35 分，排序正确。MSI 里 `pwsh.exe` 与 `createdump.exe` 分开，排序正确。

产品名分词要按 `.` 切开。原先只在 `-` / `_` 处切，`Microsoft .NET Runtime` 产出的是带点的 `.net`，而 exe 名的归一化形式是 `dotnet` —— `.net` 既不是它的子串也不是超串，两边永远对不上。后果不是「排序偏一点」而是**整个目录返回空**：`dotnet.exe` 拿不到 +20 近似分，随后又被黑名单里的 `dotnet` 扣掉 45 分，总分转负、被 `rank_candidates` 过滤掉。装了 .NET 运行时的目录因此被认为没有可执行程序，install 报「找不到入口」。返回空比返回错程序更难发现 —— 错程序至少还能双击试试。同时 `dotnet` 也补进了豁免表：原来排除层认「产品名是 .NET 时 `dotnet.exe` 就是主程序」（`RUNTIME_COMPONENTS_EXEMPTABLE`），扣分层却照样扣 45 分，两套规则自相矛盾。

黑名单用**子串**匹配且命中即跳出，所以条目顺序有语义：若 `a` 是 `b` 的子串且 `a` 排在前面，`b` 永远轮不到 —— 任何含 `b` 的名字必然含 `a`。早先这张表列了 28 条，其中 6 条（`uninst` / `uninstall` / `updater` / `dxsetup` / `vc_redist` / `installer`）全部被前面的短条目吞掉、一次都没生效过，并附有一段「各有目标，别当冗余删掉」的注释。那段注释是错的：它把「理论上目标不同」当成了「代码里真能命中」。现已删到 22 条，覆盖范围不变（`unins` 仍认 `uninstall.exe`，`install` 仍认 `installer.exe` / `InstallShield_*.exe`，`setup` 仍认 `dxsetup.exe`，`redist` 仍认 `vc_redist.x64.exe`），并有测试穷举检查每一对 `(a, b)`，防止后人再加一条短前缀把后面的条目变成摆设。运行时组件表与它的豁免表受同一约束，同样有测试守着。

扫描有两个独立上限：`max_files` 限制收到的候选数，`max_probes` 限制打开文件探头的次数。后者防的是另一件事 —— 无后缀文件每个都要读 2 字节判 MZ 头，探测失败的不进候选、不占 `max_files` 名额。实测 6000 个无后缀非 PE 文件配 `max_files=50` 仍要 7.8 秒，与 `max_files=4000` 几乎相同，上限完全失效；单独的 `max_probes` 把同一场景压到 93 毫秒。同级目录特征（DLL 数、资源后缀）按目录缓存，一次扫描只枚举一遍 —— 原先每个 exe 都把同目录重新枚举一遍，同目录 800 个 exe 要 3.5 秒。

同分时的次序按**目录层级**，不按路径字符长度。两者不等价：字符长度把文件名长度混进了目录深度。实测分数都是 50 时，`d/e.exe`（深度 1、7 字符）会排到 `root-program-with-long-name.exe`（深度 0、31 字符）前面 —— 而「在解包根目录」是 +25 的强信号，不该被一个短文件名反超。排序键是 `(-score, 路径层级, 字符长度, 路径)`，最后一项只保证输出稳定。

装完之后回 prefix 里找主程序，兜底那一层必须再校验一次「文件名与产品名有关」。打分器里产品名只值 +35 分，而整层扫描时「在 Program Files 下」+25、「GUI」+20、「有图标」+10 合计 55 分，足以让一份没装成功的残留程序排第一。实测在本机 base 层的 `Program Files/` 下分别搜 `Notepad`、`TotallyDifferentApp`、`Zzzz`，三次返回的都是同一个 `Windows NT/Accessories/wordpad.exe` —— 产品名对兜底结果毫无影响，用户装记事本得到写字板。这类错误不报错、不崩溃，只是安静地选中了错的程序。闸门复用打分器的归一化（`_normalize` 去分隔符与数字、`_squash` 只去分隔符），判据只认**相等 / 前缀 / 后缀**，不接受任意子串 —— 否则两字符产品名 `Pa` 会命中 `wordpad` 的中间。产品名为空时放行，没有依据时保持旧行为。

前后缀匹配还要求两边**长度差至少 2**。只差一个字符时，「前缀」与「拼写相近的另一个词」无法区分：`mode` 是 `modem` 的前缀，但 `Modem.exe` 显然不是产品名 `mode` 的程序。实测这一处漏判真的漏了过去 —— 上一条按产品名认领子目录的判据（下段）已经被词边界挡住，兜底这层却把它放了回来，端到端结果照样是错的。相等永远接受，不受此限。

按产品名认领子目录那一层（路径 ①）也得按**词**比对，不能按字符。原来的判据是 `k in name.lower() or name.lower() in k`，字符串子串没有词边界，短词会啃进长词中间：`Modem` 被产品名 `mode` 命中、`Downloads` 被 `load` 命中、`appdata` 被 `App` 命中。前两例只是认领错目录，第三例更糟 —— `AppData/Local` 的子目录被 `app` 认领一片后，`best_candidate` 会立刻返回里面的某个 exe。现在把名字切成词序列（`7-Zip 24.08` → `['7','zip','24','08']`），要求**连续词段**包含。双向仍然保留：产品名常常比目录名长，`Visual Studio Code` 装出来的目录就叫 `Code/`，去掉反向这一层路径 ① 全废 —— 而它正是 Electron 类安装器唯一能走通的路。

#### 3.2.4 prefix 创建与静默安装

按层顺序用 APFS clonefile 复制进包内，建 `dosdevices/c:`（相对链接）与 `dosdevices/z:`（指向 `/`），补齐注册表占位文件，最后校验 `system32` 非空、链接有效。

静默安装按安装器类型套参数表，通过 `Z:` 盘访问原安装包（不复制进 prefix），全过程写 `install.log`。支持超时强制清理，也支持「装完不退出」的安装器（见 4.2 节亮点十二）。

#### 3.2.5 运行时与环境自检

`wepack runtime` 管理 Wine 运行时，三条来源，优先级从高到低：

| 来源 | 命令 | 联网 | 说明 |
|---|---|---|---|
| 本地包 | `--archive x.tar.xz` | 否 | 最可控，推荐离线环境 |
| CrossOver / Whisky | `--from-vendor` | 否 | 只复制 wine 运行时目录，不动原 app |
| GitHub | 默认 | 是 | Gcenx `macOS_Wine_builds` devel 构建，约 225 MB |

`wepack doctor` 逐项检查 Rosetta 2、Wine 运行时（含架构）、Python 版本、`sips`、`iconutil`、7-Zip、可选工具、目录可写性，缺失项给出可复制的修复命令。

### 3.3 Win2Mac：在 Windows 上产出 macOS 应用包

| 能力 | 说明 | 状态 |
|---|---|---|
| 目录装配 | 生成 `.app` 目录结构（`Contents/MacOS`、`Contents/Resources`） | 完成 |
| Info.plist 生成 | 按模板生成，字段可配，`plutil` 权威校验 | 完成 |
| 权限位保留 | 自研 zip 写入器保留 Unix mode，解压后 `0755` 不丢 | 完成 |
| zip 打包 | 输出可传输的 zip | 完成 |
| 文件关联 | `--associate` 可重复，生成 `CFBundleDocumentTypes` | 完成 |
| 产物校验 | 结构、plist 字段、可执行权限位、Mach-O 类型 | 完成 |
| 契约接入 | 已接入共享契约层 | 完成 |
| bundle id 唯一性 | 中文应用名归一化后挂哈希后缀，避免撞 id | 完成 |

测试全部通过，实测可真实产出 `.app` 目录与 zip。

**为什么这个方向确定性最高**：它不涉及编译，纯装配。与 Mac2Win 完全同构（同 8 阶段、同错误码段位、同报告结构），实现时能直接搬。

**它不做什么**：不编译 Mach-O、不做代码签名、不公证、不能出 dmg。`--executable` 指向的文件必须由用户自行准备；若它不是 Mach-O，命令会明确警告而非静默放行。`hdiutil` / `codesign` / `notarytool` 都是 macOS 独占工具，这是平台硬边界。

### 3.4 AppOnWin：在 Windows 上运行 macOS 程序

| 能力 | 说明 | 状态 |
|---|---|---|
| 结构解析 | 读 `.app` 目录、`Info.plist`、Mach-O 头 | 完成 |
| 框架判定 | 从二进制与框架依赖推断技术栈 | 完成 |
| 可移植性评估 | 三级结论 `likely` / `unlikely` / `unknown` | 完成 |
| 可行性验证 | spike 三态：`pass` / `fail` / `blocked` | 完成（本机结论：环境不具备） |
| 命令行程序运行 | 加载与执行 | 未验证（门槛 1 `blocked`） |
| GUI 程序运行 | AppKit 窗口 | 未验证（决定性门槛 2 `blocked`） |

测试全部通过。`assess` 与 `parse` 是纯读操作，**任何平台都能跑**；只有 `spike` 需要真实的 Windows + WSL2 + Darling 环境。

**spike 的门槛与结论语义**：三条门槛全过才继续。第 2 条（能加载最简 AppKit 窗口）是决定性的——不通过则 AppOnWin 降级为「兼容性评估工具」（只报能不能跑，不做运行），不再占主线顺位。环境不具备时结果是 `blocked` 而非 `pass`，**`blocked` 不等于 `pass`**，这一点在数据结构上就分开。

**实测样本**：`Calculator.app` 的评估结果为 2 个二进制、21 个框架依赖、3 个 Darling 明确不支持。清单里没有的框架一律 `unknown`，不假设可用。

**可行性结论（2026-11-19 实测）：环境不具备。**

三位结论里落在第三档，既不是「成立」也不是「不成立」。依据是一次完整 `spike --app /System/Applications/Calculator.app --json` 的逐门槛状态：

| 门槛 | 状态 | 出处 |
|---|---|---|
| 1 命令行 Mach-O | `blocked` | `probeWsl()` 返回 `available:false`，`reason` = 「宿主是 darwin，不是 Windows。WSL2 只在 Windows 上可用。」 |
| 2 AppKit 窗口（决定性） | `blocked` | 同上门槛，未进入 `darling` 探测 |
| 3 Info.plist 解析 | `pass` | 真实 `.app` 解析成功，定位到 `Calculator` 主二进制 |

整体 `conclusion = unverified`，进程退出码 **5**。契约里 `5` = 「缺少外部依赖」，配对错误码 `AOW_2001`（`errorSegment: 2001/2002`），与 `exit-codes.json` 逐项一致。

**为什么不写成「待定」。** 「待定」是一个没有信息量的状态：它不区分「试了但不行」和「没法试」。这两者对下一步动作的指向完全相反——前者应放弃或降级，后者只需换一台装有 Windows + WSL2 的机器。本机结论是后者，因此写作「环境不具备」。同理，**不能因为门槛 3 通过就写成「部分成立」**：门槛 3 只证明解析能力可用（`assess` / `parse` 本来就交付这个），它不依赖 Darling，对「能不能跑」没有证明力；三条门槛全过才算成立，缺一条就是未验证。

**要变成「成立」还需什么**：一台 Windows 10+ 机器、启用 WSL2 并装一个发行版、在发行版内构建安装 Darling、准备一个可执行 Mach-O 样本（`--sample`）。四条缺一不可，详见 5.1.2。

### 3.5 共享契约层

四个方向对外表现一致的唯一定义处。

| 文件 | 作用 | 谁读 |
| --- | --- | --- |
| `contracts/exit-codes.json` | 统一退出码 | 四个方向的 CLI、`console/` |
| `contracts/error-prefixes.json` | 错误码前缀与段位分配 | 四个方向的 `errors` 模块 |
| `contracts/run-report.schema.json` | `--json` / `--report` 输出结构 | 四个方向的 CLI、`console/` |
| `contracts/validate.mjs` | 契约自检 + 报告校验 | CI 与本地检查 |

`console/` 只认这里的格式；任何方向改字段名，都必须先改这里。

### 3.6 console：四方向统一入口

| 能力 | 说明 | 状态 |
|---|---|---|
| 状态列举 | `list` 列出四个方向的可用性 | 完成 |
| 子命令转发 | `run <方向> <子命令> [参数]` | 完成 |
| 汇总自检 | `doctor` 并行跑四个方向的 `doctor` | 完成 |
| 契约检查 | `contract` 真实调用各方向，验证报告合规 | 完成 |
| Web 看板 | 本地服务 + SSE 进度推送 + 历史落盘 | 完成 |
| 视口实测 | `scripts/viewport-check.mjs` 起真实 Chrome 量三档视口（375 / 768 / 1440），四段：基线 / 压测 / 触控目标 / 断行质量 | 完成 |

测试全部通过。职责边界只有三件事：找到某方向的 CLI 起子进程调用、读回 `--report` 的 JSON 渲染、检查四个方向是否真的遵守契约。其中 17 项专门守「本模块的契约检查器与 `contracts/validate.mjs` 对同一份报告必须结论一致」—— 两个校验器各写一份实现，必然分叉，只是时间问题。

**不实现任何构建逻辑**。一旦在这里重写打包流程，就有了第二份真源，两个方向的行为必然逐渐分叉。

### 3.7 ai：把四方向能力交给 AI 调用

四种接入形态，共用同一套调度层（`console/src/directions.mjs`），不重复实现任何构建逻辑。

| 形态 | 入口 | 面向谁 | 状态 |
|---|---|---|---|
| MCP server | `ai/bin/wacmin-mcp.mjs` | Claude Desktop、WorkBuddy、Cline 等支持 MCP 的客户端 | 完成 |
| 统一命令行 | `ai/bin/wacmin.mjs` | 脚本与 agent 的工具调用 | 完成 |
| Skill | `ai/skills/wacmin/SKILL.md` | 让 agent 判断「何时该用本仓库」 | 完成 |
| 专家包 | `ai/experts/wacmin-expert.md` | 需要判断准则而非操作步骤时 | 完成 |

**MCP 工具清单**（六个，按意图分组而非逐命令映射）：

| 工具 | 作用 | 只读 |
|---|---|---|
| `wacmin_list_directions` | 四个方向各支持什么、产出什么、宿主是什么 | 是 |
| `wacmin_doctor` | 环境自检，缺工具时给出安装命令 | 是 |
| `wacmin_build` | 构建产物（唯一会写盘、可能跑数分钟的操作） | 否 |
| `wacmin_verify` | 校验已有产物，不重新构建 | 是 |
| `wacmin_assess` | 静态评估兼容性，不执行任何程序 | 是 |
| `wacmin_run` | 逃生门：给准确定位与参数，直通子命令 | 否 |

测试全部通过。协议层严格按 MCP 2025-06-18 的 stdio 传输实现：换行分隔的 JSON-RPC，`stdout` 只允许出现协议消息，日志一律走 `stderr`。

**消息严格串行**。`tools/call` 里可能是 `build` / `package` 这类写产物的操作，两条并行会争用同一个输出目录、互相覆盖中间文件，得到半成品而两次调用都「成功」。取消通知是唯一例外 —— 它必须能立即打断在途任务，排队就毫无意义了。

**为什么不用官方 SDK**：本项目全仓零第三方依赖。MCP 的 stdio 部分本身很小（换行分帧 + 几个方法名），`protocol.mjs` 与 `server.mjs` 合计不到 700 行，可读、可测、无依赖。引入 SDK 会让「clone 下来就能跑」变成「先 npm i」。

**为什么工具数只有六个而不是二十多个**：四个方向加起来二十多个子命令，全部摊平成工具会让 agent 无从选择 —— 工具名之间的差异它看不出来，只能靠猜。按意图分组后每个工具都有明确的使用时机，未建模的选项走 `wacmin_run` 透传。

---
## 四、核心特性

本章按方向组织，每条采用统一结构：**亮点名称 / 价值 / 实现方式 / 差异化 / 证据**。证据全部来自实测，不做无根据的乐观承诺。

### 4.0 全局亮点

#### 亮点一：2×2 矩阵填满，没有遗漏格

- **亮点名称**：方向完整性。
- **价值**：解决「只做单向」的问题。现有工具要么只支持 Mac 上跑 Windows，要么只支持打 Windows 包，反方向几乎空白。
- **实现方式**：宿主（macOS / Windows）× 动作（产出安装包 / 运行程序）= 4 个方向，逐个实现。
- **差异化**：把四个方向放在一个仓库、共用一层契约，而不是散成四个互不相关的项目。
- **证据**：四个目录 `mac2win/`、`exeonmac/`、`win2mac/`、`apponwin/` 均已建立并接入契约，`node console/bin/wacmin-console.mjs contract` 对四个方向的探针全部通过。

#### 亮点二：契约先行，四个方向对外表现一致

- **亮点名称**：单点契约定义。
- **价值**：解决「四套退出码，脚本层要写四个判断」的问题。
- **实现方式**：退出码、错误码段位、报告结构在 `contracts/` 单点定义；`validate.mjs` 做契约自检与报告校验。
- **差异化**：多数多方向工具各自设计错误格式，上层无法统一驱动。
- **证据**：三条铁律（退出码只追加、错误码段位不越界、`--json` 时 stdout 只有 JSON）写死在 `contracts/` 与各方向的 errors 模块里，并由 `console` 的契约检查真实调用各方向验证。

#### 亮点三：按确定性排序开发，把风险留到最后

- **亮点名称**：确定性优先的开发顺位。
- **价值**：解决「先做最难的，失败后全盘推倒」的问题。
- **实现方式**：Mac2Win（已收敛）→ ExeOnMac（底座成熟，只是活多）→ Win2Mac（纯装配，确定性最高）→ AppOnWin（底座实验性）。
- **差异化**：多数项目按「功能重要性」排序，导致地基不稳的功能先做，失败后拖累全部。
- **证据**：即使 AppOnWin 完全失败，前三项仍成立——项目有三条腿站得住。

#### 亮点四：AppOnWin 可以降级，不是全有或全无

- **亮点名称**：降级路径预先定义。
- **价值**：解决「实验性方向失败后项目无所适从」的问题。
- **实现方式**：spike 三条门槛，**第 2 条（能加载最简 AppKit 窗口）是决定性的**。不通过则 AppOnWin 降级为「兼容性评估工具」（只报能不能跑，不做运行），不再占主线顺位。
- **差异化**：多数项目对实验性功能只有「做」与「不做」两种状态。
- **证据**：降级规则写在第 5.1.2 节；`spike` 的三态结果（`pass` / `fail` / `blocked`）在数据结构上分开，`blocked` 不会被当成 `pass`。

### 4.1 Mac2Win

#### 亮点五：两小时四十一分 → 五十六秒，110 倍来自一处修正

- **价值**：空谷项目最初一次构建耗时 **6241 秒（1 小时 44 分）**，产物里塞了 **51534 个文件**。这不是环境问题，是设计缺陷。
- **实现方式**：`copyTree` 接受 `skipDirs`，拷依赖包时跳过任意层级的 `node_modules`——依赖已由收集器统一收集并扁平放在**同一层**，包内部那一份是多余的。
- **差异化**：常见做法是给 `fs.cp` 加 `dereference: true` 展开软链，但 pnpm 布局下每个包都把依赖软链进自己的 `node_modules`，展开等于把软链农场变成真实文件。
- **证据**：

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| 载荷文件数 | 51534 | **6722** |
| 构建耗时 | 6241 秒 | **56.5 秒** |
| 依赖包文件 | 3777（展开后 5 万） | 3306 |

实测 83 个依赖包里 **80 个**都带自己的 `node_modules`，这就是膨胀的来源。

#### 亮点六：软链循环按 `(dev, inode)` 去重

- **价值**：`fs.cp({dereference:true})` 在含循环软链的目录树上会无限展开。实测空谷项目 316 个软链，其中存在 `A → B → A` 的循环，`fs.cp` 跑了 6 分钟仍在增长到 374 MB 没停。
- **实现方式**：按 `(dev, inode)` 去重，同一个物理目录只拷一次，再次遇到就跳过。同时解决膨胀与死循环。
- **差异化**：单纯设递归深度上限会截断合法深层目录；单纯检测路径字符串会漏掉经由不同软链指向同一 inode 的情形。
- **证据**：同一项目由 6 分钟无进展变为 56.5 秒完成，产物 6722 个文件。

#### 亮点七：产物校验是硬门槛，而且不说谎

- **亮点名称**：三态产物校验。
- **价值**：解决「构建成功但产物不能用」，以及更隐蔽的「校验器报了通过但其实没验」。
- **实现方式**：十一项校验拆成 `ok` / `complete` 两个正交维度。`ok` 回答「有没有查出问题」，`complete` 回答「是不是全验了」。未验全时以退出码 5 明确报告「未完成」，绝不给「通过」二字。
- **差异化**：多数打包工具只报「构建成功」，不验产物；少数会验，但缺依赖时降级成警告而不是明确失败——用户拿到一份撒了谎的报告。
- **证据**：4060 个文件的逐文件 SHA-256 比对在 2 秒量级完成。缺 7-Zip 时 CLI 输出「校验未完成：N 项没有验证」并逐项列出没验什么，退出码 5。

#### 亮点八：arm64 macOS 确实能产出 Windows x86 原生 GUI 程序

- **价值**：Tauri 的 Rust 壳曾被判断为「无法在 mac 上编译」，理由是缺少 `i686-pc-windows-msvc` 工具链。这个判断是错的。
- **实现方式**：`i686-pc-windows-msvc` 是 Rust 的 tier-2 目标，可在非 Windows 主机上编译。缺的不是编译器，而是 **MSVC 的 CRT 头文件与导入库**，这些可以从微软官方 CDN 获取——`cargo-xwin` 就是做这件事的。
- **差异化**：多数方案到此为止，改走「浏览器界面 + Node 运行时」的降级路径。本项目把两条路都实现了：默认走降级路线，配置 `buildRustShell: true` 走原生壳。
- **证据**（2026-11，M 系列 Mac / arm64）：

```
rustc 1.100.0 · cargo-xwin 0.23.1
cargo xwin build --target i686-pc-windows-msvc --release
→ rsprobe.exe  92 KB  PE32 / i386 / windows-gui  入口点 69304  校验 ok
```

**一个必须知道的坑**：`cargo xwin cache xwin` 只下载 `x86_64` 与 `aarch64` 的 CRT/SDK，不含 x86。直接 build 会报 `could not open 'user32.lib'`。

设 `XWIN_ARCH=x86` **还不够**。这个变量只决定「该下载什么」，而 cargo-xwin 的缓存判据只看 `xwin/DONE` 的首行文本，从不校验文件是否真在磁盘上 —— 于是存在「`DONE` 写着 `x86`、`crt/lib/` 里只有 `x86_64`」的状态，此时重跑同一个命令仍然报同样的错。mac2win 的处理是两件事都做：build 时设 `XWIN_ARCH=x86`，预检时用 `x86-libs` 一项直接查磁盘（`crt/lib/x86`、`sdk/lib/um/x86`），不一致就在编译**前**报出来。详见 15.10.4。

#### 亮点九：Electron 的 x86 上限用实测确定，不靠猜

- **价值**：Electron 自 v44 起不再发布 `win32-ia32`。若不在预检阶段拦截，用户会等二十分钟拿到一个 404。
- **实现方式**：在预检阶段直接探测上游是否仍有该架构的产物（`curl -r 0-500` 看 HTTP 状态码），并按已知边界拦截。
- **差异化**：多数工具把版本边界写成文档里的一句话，等运行到下载阶段才失败。本项目把它做成预检的硬判据。
- **证据**：

| 版本 | `electron-vX-win32-ia32.zip` | 结论 |
| --- | --- | --- |
| v43.0.0 | 206 | 可用 |
| v44.0.0 | 404 | 已移除 |
| v45.0.0 | 404 | 已移除 |

#### 亮点十：依赖收集必须两阶段，否则产物启动即崩

- **价值**：只从 import 图收包会漏掉传递依赖。实测报错 `Cannot find package 'cosmokit'`——产物打包成功、校验通过、启动即崩。
- **实现方式**：两阶段收集：先扫 import 图得到直接依赖，再按每个包 `package.json` 的 `dependencies` 展开闭包；随后按收集结果**重建扁平 `node_modules`**，因为 pnpm 的软链布局下依赖真实位置在上一层。
- **差异化**：常见做法是直接拷整个 `node_modules`，体积爆炸且带入 devDependencies；或只拷直接依赖，运行时缺传递依赖。
- **证据**：空谷项目的依赖链上连续踩到五个坑（`cosmokit` 缺失、软链指向 `.pnpm`、别名安装、workspace 包路径、宿主按相对路径找内核），逐个修掉后端到端跑通，宿主日志显示「宿主就绪 http://127.0.0.1:9061」。

### 4.2 ExeOnMac

#### 亮点十一：用 clonefile 做层复用，382 MB 骨架只占元数据空间

- **价值**：每个应用包都需要一份完整的 Windows 骨架（`drive_c/windows`、`system32`、注册表初始态），实测 382 MB / 1858 个文件。若每个包都真实复制，装十个应用就多占 3.8 GB。
- **实现方式**：`cp -c` 调用 APFS `clonefile(2)`，建立写时复制副本。层内容在 prefix 初始化时复制一次，后续所有写入落在私有副本上。
- **差异化**：常见的共享 prefix 方案（所有应用共用一个 `WINEPREFIX`）根本不需要复制，但代价是应用之间互相污染。本项目要的是隔离，同时不想付隔离的磁盘代价，clonefile 正好在这个交叉点上。也不做硬链接——硬链接会让「写 Private 不污染共享层」失效（写任一副本都会改共享 inode）。
- **证据**：复制 64 MB 文件后，卷可用空间只减少不到 1 MB（元数据级别）。测量方法是卷可用空间差值，不是 `du`（原因见 5.5.1 节）。

#### 亮点十二：不靠退出码判断安装完成，靠文件增长

- **价值**：大量 NSIS 与 Electron/Squirrel 打包的安装器装完不退出，而是直接拉起刚装好的应用，父进程一直挂着。等它退出会白等到超时。实测某个 34 MB 的 Electron 应用安装包，装完只需 132 秒，但进程永不退出，等满 1200 秒超时才返回。
- **实现方式**：每 5 秒采样一次 prefix 的文件数与总字节数，连续 6 次不变即判定安装完成，主动收尾并标记 `settled_by_progress`。
- **差异化**：多数封装工具直接用 `subprocess.run(timeout=N)`，遇到这类安装器只能靠用户手动调小超时，而超时又会被判为失败。
- **证据**：同一安装包的耗时从 1215 秒降到 132 秒，且正确判为成功。

#### 亮点十三：MSI 表解析绕过私有编码，还原真实文件名

- **价值**：MSI 的 cab 内文件名是 `fil<32位hex>` 形式的哈希，直接解包出来既无法判断主程序，也无法还原目录结构。
- **实现方式**：自己解析 MSI 的 `_StringPool`、`_Tables`、`_Columns`、`File`、`Directory`、`Component`、`Shortcut` 表。因为 MSI 在 CFB 容器里的流名是私有编码，无法按名字查找，改用内容特征识别：字符串池各项长度之和恰好等于另一个流的字节数，那个流就是 `_StringData`。
- **差异化**：直接依赖 `msitools` 当然更简单，但它在 macOS 上并非默认可用，且引入外部依赖。自解析让 MSI 支持零依赖落地。
- **证据**：PowerShell 7.4.6 的 104 MB MSI 解出 913 个真实文件名，主程序正确识别为 `pwsh.exe`。

#### 亮点十四：运行时组件显式排除，不靠扣分

- **价值**：Electron 应用安装时会顺带装上 WebView2，里面有个 `msedge.exe`，GUI 子系统、体积、图标资源全都符合「主程序」特征。实测它一度被选为入口，用户双击 `.app` 会打开一个空白的 Edge 内核窗口。
- **实现方式**：维护一份运行时组件名单（`msedgewebview2`、`edgecore`、`msedge`、`dotnet` 等）与路径标记（`/edgecore/`、`/webview2/`、`/dotnet/`），命中即从候选中整体排除，不参与排序。
- **差异化**：打分模型里给这类文件扣分是常见做法，但扣分不够——当真正的入口因为路径深或体积小而分数偏低时，被扣分的 `msedge.exe` 仍可能排第一。**排除是确定性的，扣分是概率性的**。
- **证据**：同一安装包的入口从 `Program Files (x86)/Microsoft/EdgeCore/.../msedge.exe` 修正为 `AppData/Local/空谷 Ondra/ondra.exe`。

#### 亮点十五：安装包文件名必须清洗，不能直接当产品名

- **价值**：`Ondra-1.1.7-alpha-windows-x64-setup.exe` 若直接取文件名当产品名，会得到 `drive_c/Wacmin/Ondra-1.1.7-alpha-windows-x64-setup`。路径既不可读，也逼近 NSIS 的 260 字符路径上限。
- **实现方式**：按分隔符切分后剥掉架构、版本、阶段标记等噪声词（`setup`、`windows`、`x64`、`alpha` 等），再按规则组合：第一段很短且第二段非纯数字时合并两段（`MS Office`），否则只取第一段（`npp` 而不是 `npp 8`）。
- **差异化**：多数工具直接取文件名或直接取版本资源。前者产生不可读路径，后者在版本资源缺失时无兜底。
- **证据**：`Ondra-1.1.7-alpha-windows-x64-setup` → `Ondra`，`npp.8.6.9.Installer.x64` → `npp`，`MS-Office-setup` → `MS Office`。

#### 亮点十五之二：入口判据只允许一份，`install` 与 `package` 必须给出同一个 exe

- **价值**：`install` 找对了入口，`package` 又找一遍，两处判据不同 —— 结果就是**装什么软件，打包出来都指向同一个系统自带程序**。这类缺陷不会报错，`.app` 能双击、能启动、Dock 里有图标，只是打开的不是用户装的那个软件。
- **实现方式**：判据整体收进 `wepack/entry.py` 一个模块，`cli._find_installed_entry` 与 `package._guess_entry` 都是它的别名或调用者。搜索顺序按「最可能是本次安装产物」排：`C:\Wacmin\<产品目录>` → `Program Files\<产品目录>` → `Program Files (x86)\<产品目录>` → `AppData\Local\<产品目录>` → 四者全盘兜底（兜底必须过文件名相关性闸门）。
- **差异化**：`package` 早先的实现在 `Program Files*` 下取打分最高的 exe 就返回。打分器给「在 Program Files 下 +25」「GUI 子系统 +20」「有图标 +10」，base 层自带的 `wordpad.exe` 稳定拿 55 分，永远是第一名；而用户程序根本不在这两个目录里，压根不参与竞争。
- **证据**：同一份 prefix（W02Probe 装到 `C:\Wacmin\w02\`）实测 — 修复前 `install` 得 `drive_c/Wacmin/w02/W02Probe.exe`、`package` 得 `drive_c/Program Files/Windows NT/Accessories/wordpad.exe`；修复后两者一致为前者，`node` 侧 6 项回归锁全部通过，且把旧实现注回去后立刻有 2 项变红。

#### 亮点十五之三：`build --json` 只写一段 JSON，两半结果合成一份

- **价值**：`build` 串联 `install` 与 `package`，两者各有一份 payload。早先直接把 `--json` 透传下去，stdout 上出现**两段**拼接的 JSON，`json.load` 抛 `Extra data: line 50 column 1` —— 读取方拿不到任何结果。
- **实现方式**：子命令一律以 `json=False` 调用，它们的人类可读输出经 `_StdoutToStderr` 改道到 stderr；`build` 自己输出一份汇总，顶层含 `entry` / `layers` / `bundle_id`，`install` 与 `package` 两个子对象分装各自字段。
- **差异化**：常见的处理是「`--json` 时每个子命令都输出、调用方自己拼」。这在 shell 里勉强能用（`jq -s`），但违背了 README 10.1「stdout 只有 JSON」的契约，也让 `--report` 的语义变模糊。
- **证据**：`wepack build setup.exe -o out --json | jq -r .entry` 直接可得入口路径；单段性由 `raw_decode` 判段数的测试守住，多出第二段即红。

#### 4.2.1 层的自动构建：五个层里三个能自动做，两个不能

**结论表**（实测于 wine 11.21 / macOS arm64，2026-11-19）：

| 层 | 自动构建 | 来源 | 卡点或说明 |
|---|---|---|---|
| `base` | ✅ | 跑一次 `wineboot -u` | — |
| `dotnet` | ✅ | 运行时自带 `wine-mono-*/support/winemono-support.msi` | 装的是 wine-mono，**不是**微软 .NET Framework 本体 |
| `fonts-cn` | ✅ | 用户指定的本地字体文件 | 见下文「一层被推翻的旧结论」 |
| `mfc` | ❌ | — | wine 不实现 MFC，运行时内无任何 MFC 二进制，也无合法获取途径 |
| `vcpp` | ❌ | — | base 的 `system32` 已含全部 28 个 VC++ 运行库，通常不需要 |

**dotnet 层实测数据**：`wepack layers build dotnet` → 1851 文件 / 332.6 MB / 36 秒，`inspect_layer` 返回 `ok=True, problems=[]`。产物含 `Microsoft.NET/Framework/{v1.1.4322,v2.0.50727,v4.0.30319}/mscorlib.dll` 与 `Framework64` 对应版本。相对 base 的增量是 **61 个独有文件，其中 60 个在 `Microsoft.NET/` 下（5.4 MB）**。

**这里有个容易写错的细节**：装完 MSI 后 `mscoree.dll` 与 base **完全相同**（md5 均为 `3f9d890657e3829cecf67735d9dade16`，大小均 196608 字节）。即 MSI **没有替换** wine 的 stub，真正的增量只有 `Microsoft.NET/` 目录。把 dotnet 层描述成「升级了 mscoree」是错的。

**两条防线，防的都是同一类假成功**：

1. `msiexec` 返回 0 之后，**必须验证** `Microsoft.NET/Framework` 目录存在且有 `*/mscorlib.dll`，否则抛 `VerifyFailed`。退出码 0 但什么都没装，在本项目已经出现过多次。
2. 层已存在时**拒绝重建**（`UsageError`），不自动删除。用户可能往层里手工补过文件，静默覆盖等于毁掉他的劳动。

**一层被推翻的旧结论：中文字体不是缺口**

代码注释里原本写着「中文字体是真缺口：base 的 `Fonts/` 是空目录」。`Fonts/` 确实是空目录（实测 0 个文件），但**这个推理是错的** —— wine 并不只看那个目录：

- `wineboot` 会把宿主系统字体以 `Z:\System\Library\Fonts\...` 的形式**自动登记**进 `system.reg` 的 Fonts 段。实测 base 层该段 **883 条**（去 `#time` 元数据为 882 条），其中 878 条指向 Z: 盘宿主路径；中文族按单段计 **PingFang 48 / Hiragino 22 / Songti 16 / Kaiti 14 / Heiti 10**。所以「中文渲染不出来」不成立。
- **这里有一个必须点明的计数陷阱**：`system.reg` 里同时存在 `[Software\Microsoft\Windows\CurrentVersion\Fonts]` 与 `[Software\Microsoft\Windows NT\CurrentVersion\Fonts]` 两段，**实测两段键集合完全相同**（各 883 条，互不独有）。它们是同一份数据的两种写法，**不是两份字体**。把两段相加会得到「恰好翻倍」的假数字 —— 早前版本写下「PingFang 96 条、中文字体合计 254 条」正是这个算术，比真实值大一倍。只认 `Windows NT` 那一段。
- 真正的缺口是**按 Windows 字体名查找**：`SimSun`、`Microsoft YaHei`、`SimHei`、`DengXian`、`MingLiU` 的精确名在 base 里**一条都没有**（实测全为 0）；`FontSubstitutes` 的 21 条（去 `#time` 后）里也没有任何中文映射。
- `FontLink\SystemLink` 把 `Tahoma`（`MS Shell Dlg` 的替身）的后备链写成了 `SIMSUN.TTC` / `MSYH.TTC` 这些 Windows 文件名，而它们在层内不存在 —— 这条链在 base 上是断的。

**所以 `fonts-cn` 层的定位是「固化字体、摆脱宿主依赖」，不是「补上缺失的中文字体」**。它把用户给的字体文件放进 `Fonts/` 随产物分发，让产物拷到另一台 Mac 上仍有字体。装进去的字体按自己的 family 名被识别，**不会**自动变成 SimSun —— 要把 `SimSun` 这类名字映射过去，靠的是另一条独立的链路（见下）。

**补充：「按 Windows 名查找」这一问题已经有解，但不在本层**

上面说的 `SimSun` 找不到，由 launcher 侧的字体替换解决，与 `fonts-cn` 层是两件事：

| 环节 | 机制 | 位置 |
|---|---|---|
| 声明映射 | `compat.yaml` 的 `font_map`：`微软雅黑: PingFang SC`、`宋体: Songti SC` | 配方 |
| 生成注册表 | 写 `Contents/Resources/Private/fontsub.reg`，同时往 **`HKLM`** 的 `FontSubstitutes`（GDI 读）与 **`HKCU`** 的 `Wine\Fonts\Replacements`（DirectWrite 读）各加一份条目 | `launcher/Sources/main.swift` 的 `FontSubstitution` |
| 生效 | 启动前跑 `wine regedit /S fontsub.reg`，再 `reg query` 回查本次的 UUID 戳；失败只 WARN 不阻断启动 | 同上 |

**两条键都要写，因为 GDI 与 DirectWrite 各读各的**（2026-11-21 实测）：GDI 只读 `HKLM` 的 `FontSubstitutes`；DirectWrite 的 `dwrite.dll` 里根本没有 `FontSubstitutes` 这个字符串，它只读 **`HKCU\Software\Wine\Fonts\Replacements`**。根键正好相反，错一个就全无效。四组对照与 PE 探针实证见 15.25，GDI 那一半见 15.24。

也就是说：`font_map` 解决「软件写死微软雅黑」的显示问题，`fonts-cn` 层解决「产物的字体不依赖宿主」的分发问题。两者互不替代，别指望装个层就自动有了名字映射。

**同时纠正一个我自己写错的事实**：上一轮记录说「`fontreg` 注册了 4 条」，这是误读。`fontreg` 在 wine 11.21 里**根本不存在**：

```
$ wine fontreg
Application could not be started, or no application associated with the specified file.
ShellExecuteEx failed: File not found.        # 退出码 1
```

wine 是在启动时**直接扫目录**的，`WINEDEBUG=+font` 可直接佐证：

```
trace:font:unix_face_create unix_name .../drive_c/windows/fonts/WacminProbeCN.ttc, face_index 0..7
trace:font:insert_face_in_family_list Original font L"\\??\\C:\\windows\\fonts\\Songti.ttc" is newer ...
```

一个 ttc 里的 8 个 face 全被枚举，`is newer so skipping` 证明层内字体真被加载。因此现在的实现**不跑任何注册命令**，只保证文件落地且可读 —— 少一个外部工具依赖，也少一处「退出码 0 但什么都没做」的假成功。

**mfc / vcpp 的报错语义**（退出码按 `contracts/exit-codes.json`）：

| 命令 | 异常 | 退出码 |
|---|---|---|
| `layers build mfc` | `MissingDependency`，附手工复制路径 | 5 |
| `layers build vcpp` | `UsageError`，说明 base 已内置 28 个 | 2 |
| `layers build 未知层` | `UsageError` | 2 |
| `layers build fonts-cn`（无 `--font`） | `UsageError` | 2 |

**测试**：`tests/test_phase7_layers.py` 共 **31 项**，其中 4 项真跑 wine（2 项端到端构建：dotnet 装 MSI、fonts-cn 落文件并校验 0644 权限；2 项对真实层跑匹配）。其余不需要 wine。四条替换为「注回缺陷即变红」已验证的用例：把 `host_to_wine_path` 从别名改成包装函数 → 别名同一性测试失败；把版本排序从元组改回字符串 → `11.3.0` 与 `9.10.0` 的排序测试失败（`'9' > '1'`，字符串排序会选错版本）；把 Fonts 段解析器改成「接受任意 Fonts 段」→ `TestFontsSectionCounting` 报 `888 != 883` 变红；把层 DLL 索引改回「只扫 `system32`」→ `TestLayerDllIndexCoverage` 与 `TestMatchAgainstRealLayers` 共 **5 项**变红，报 `['commdlg', 'd3d8'] != []`。

**顺带修掉一个既有缺陷：层 DLL 索引漏了 `syswow64` 与 `Microsoft.NET/`**

`match_layers` 判断「某个依赖有没有层能补」，靠的是扫层目录里实际有哪些 DLL。原实现只扫 `drive_c/windows/system32` 与 `drive_c/windows` 两层、且都不递归，于是漏掉两类真实存在的文件：

| 漏掉的目录 | 实测规模 | 后果 |
|---|---|---|
| `drive_c/windows/syswow64` | 636 个 DLL，其中 **64 个只在 `syswow64`**（`d3d8` / `commdlg` / `avifile` / `ctl3d` …） | 32 位程序导入这些 → 报 `unsolved`「无层可补」，而它们就在 base 里 |
| `drive_c/windows/Microsoft.NET/Framework/v*/` | `mscorlib.dll` 等 5 个 | 装了 dotnet 层，`mscorlib` 仍被判「无层可补」 |

后果不是崩溃，是**误导**：`unsolved` 是让人去换方案、找替代品的信号，而实际上什么都不缺。实测修前：导入 `d3d8`+`commdlg` → `unsolved=['commdlg','d3d8']`；导入 `mscorlib` → `unsolved=['mscorlib']`。修后分别为 `[]` 与 `[]`（`mscorlib` 同时让 `layers` 从 `['base']` 变为 `['base','dotnet']`）。

判据收进单个 `_windows_dll_stems(root)`，`base_dll_index()` 与 `_layer_dll_index()` 都调它 —— 不再各写一套（README 5.3 红线）。改递归扫 `windows/` 整棵树的代价实测 **23 ms**（dotnet 层 1294 个 DLL），可以忽略。

一个必须如实记的边界：`system.dll` 在 base 与 dotnet 里**都不存在**（实测 `rglob('system.dll')` 两边均 0 个），所以引用它的程序仍报 `unsolved` —— 这是诚实的结论，不是缺陷。wine-mono 把大部分 BCL 打成单个 `mscorlib`，独立 `System.dll` 属微软原版布局。

**2026-11-19 复核时抓到的文档错误（已修，记在这里防复发）**：本节原先写「中文字体合计 254 条（PingFang 96 / Songti 28 / Kaiti 28 / Heiti 20 / Hiragino 44）」，逐项实测后发现**每一项都恰好是真实值的两倍**。根因不是抄错数，而是把 `system.reg` 里那两个键集完全相同的 Fonts 段**相加**了。真实单段值：PingFang 48 / Hiragino 22 / Songti 16 / Kaiti 14 / Heiti 10。这类错误的危险在于「数字更大、列得更细，看起来更可信」，反而比明显的错更容易被接受。为此加了 3 项结构不变量测试（两段键集必须相同、解析器只取一段、中文字体条数不得等于各段之和），不背具体条数——宿主字体随系统版本变化，写死就会再漂。

### 4.3 Win2Mac

#### 亮点十六：自研 zip 写入器，Unix 权限位越过 Windows 不丢

- **价值**：在 Windows 上打 `.app`，最大的实际障碍不是 plist 而是**可执行权限位**。Windows 没有 Unix mode 概念，用常规工具打出的 zip 解压到 macOS 后主程序是 `0644`，双击无反应。
- **实现方式**：自研 zip 写入器，在中央目录的外部属性里写 `external_attr = (mode << 16) | dosAttrs`，并把 `create_system` 置为 `3`（Unix）——只有标了 Unix，解压方才会去读高 16 位的 mode。
- **差异化**：多数跨平台 zip 库把外部属性写成 0 或只写 DOS 属性；GNU zip 会写 Unix 位但需要宿主是 Unix。自研写入器不依赖宿主，规则显式。
- **证据**：三条规则由测试守着——目录名须以 `/` 结尾并置 `S_IFDIR`、符号链接置 `S_IFLNK`、`Contents/MacOS/*` 的角色兜底为 `0755`。解压后 `ls -l` 与 `plutil -lint` 均通过。

#### 亮点十七：中文应用名不撞 bundle id

- **价值**：bundle id 是 LaunchServices 区分应用的唯一依据。而 `[^a-z0-9-.]` 这个字符类会把中文整段吃掉：`app.记事本` → `app`，`app.我的应用` → `app`，两者撞成同一个 id。撞了之后 Dock 只显示一个图标、默认打开方式互相覆盖、`lsregister -u` 卸载其一会把另一个也摘掉。
- **实现方式**：含非 ASCII 字符时在可读片段后挂 8 位 SHA-256 前缀；纯 ASCII 输入原样返回，不改变既有产物的 id（否则升级构建会让老用户变成两个应用）。
- **差异化**：常见做法是「非 ASCII 一律剔除」或「一律报错」。前者产出必然冲突的 id，后者让中文用户完全无法打包。原注释写的「宁可报错也不要产出必然冲突的 id」实际上从未生效——纯中文域名归一化后还剩 `app`，看着合法，静默产出冲突 id。
- **证据**：

| 输入 | 修前 | 修后 |
|---|---|---|
| `app.记事本` | `com.wexe.win.app` | `com.wexe.win.app-7ea4b95c` |
| `app.我的应用` | `com.wexe.win.app` | `com.wexe.win.app-59362fed` |
| `app.空谷-ondra` | `com.wexe.win.app.ondra` | `com.wexe.win.app.ondra-c0c33160` |
| `tencent.wechat` | `com.wexe.win.tencent.wechat` | 不变 |

实测 11 个常见中文应用名，修前只产出 **1 个**不同 id；修后 11 个全部不同。三处细节同样重要：`seed`（应用名）必须拌进哈希（同厂商多个中文应用反向域名相同）；「部分丢」也要兜（`cn.星玖.测试` → `cn` 还剩一段，看着非空、实则丢了全部区分度）；域名干净而 seed 是中文时也要兜。

### 4.4 console

#### 亮点十八：按进程组杀，才杀得干净

- **价值**：只杀父进程会留下孤儿。`python3 -m wepack` 会拉起 wine、7z、swiftc，杀掉 python 之后这些子进程继续占着 prefix 与端口，下次运行冲突。
- **实现方式**：子进程以独立进程组启动，超时时 `process.kill(-pid)` 对整个进程组发信号，`SIGTERM` → 等 2 秒 → `SIGKILL`。
- **差异化**：Node 的 `child.kill()` 只作用于直接子进程。跨语言的子进程树（Node → Python → Wine → Windows 程序）必须靠进程组。
- **证据**：`WACMIN_TIMEOUT_MS` 默认 30 分钟（`doctor` 为 60 秒），超时后端口与 prefix 均可立即复用。

#### 亮点十九：并行 doctor，把 555 ms 压到 486 ms

- **价值**：`console doctor` 要串行调用四个方向的 `doctor`，其中 exeonmac 一项就占 415 ms，用户体感是「卡住了」。
- **实现方式**：四个方向的 `doctor` 并发执行，结果按固定顺序回填，保证输出稳定。
- **差异化**：并发容易引入「输出顺序随机」的新问题，本项目用索引回填而非 `Promise.all` 的完成顺序。
- **证据**：串行 555 ms → 并行 486 ms。

#### 亮点二十：契约检查器自己的三个 bug

这一条不是「我们做对了什么」，而是「检查器本身也会撒谎」——写下来因为它是同类项目最容易忽略的一类缺陷。

- **价值**：`contract` 命令负责验证四个方向是否真的遵守契约。当检查器自己有 bug 时，四个方向全绿，而契约早已被违反。
- **实现方式**：白名单不再手写，改为直接从 `run-report.schema.json` 现读。
- **差异化与教训**：三个 bug 的根因是同一个——**同一份信息存了两份**。
- **证据**：

| 缺陷 | 症状 | 根因 |
|---|---|---|
| 前缀正则写成 `[A-Z]{2,4}` | 不认 `M2W` / `W2M` 里的数字 2 | 手写正则而非从契约读 |
| 白名单漏了 `checks` | 合规报告被判为含未知字段 | 手写白名单与 schema 不同步 |
| 白名单多了 `config` / `nextSteps` | 不合规报告被判为合规 | 同上 |

#### 视口实测：一个曾经空转的检查脚本

`style.css` 里有一段注释，说「注入 139 字符路径后，三档视口分别有 N 处溢出，加完这两条归零」。这句话最早**没有复现路径** —— 量出它的脚本没进仓库，等于没有证据。补 `console/scripts/viewport-check.mjs` 时才暴露出两个更根本的问题。

**脚本本身不会说「我没测到」。** 它起真实 Chrome、渲染真实页面、注入长串、量矩形，然后退出 0。第一版跑出来是「三档全部 0 处溢出」—— 看起来完美。做负向验证（把 `overflow-wrap` 整组摘掉再跑）才发现**还是 0 处**：压测注入写的是「把页面上已有的 `.stage-msg` 文字改成长串」，而那些容器在页面刚加载时**全是空的**，阶段行要等用户点一次构建才会由 `app.js` 拼出来。对空集合赋值等于什么都没做。

修法是不改文字、按 `app.js` 的真实 DOM 结构造节点，塞进真实容器。

**只量元素外框会漏掉一半。** 修完注入后负向验证有了反应，但只有 375 档报溢出，768 与 1440 都报 0 —— 而宽屏下固定列更多、本该更糟。原因是 `.check` 的列宽被钉死 `grid-template-columns: 16px 200px 1fr`：塞一个 139 字符路径进去，**列宽一分不变，文字直接盖到相邻列上**，元素外框量出来完全正常。所以每条文本节点还要用 `Range.getClientRects()` 量**实际渲染的字形框**，那才是用户眼睛看到的边界。

| 视口 | 基线 | 压测（规则在位） | 压测（规则摘掉） |
|---|---|---|---|
| 375 | 0 处 | 0 处 | 10 处 |
| 768 | 0 处 | 0 处 | 1 处 |
| 1440 | 0 处 | 0 处 | 1 处 |

复现：`node console/scripts/viewport-check.mjs`（人读表格）、`--json`（stdout 只有 JSON）。退出码 `0` 无溢出 / `1` 有溢出 / `2` 找不到 Chrome —— 分开是因为这两种情况的处置完全不同，混成一个码会让人把环境问题当代码缺陷去查。

这个脚本要跑十几秒、依赖本机装浏览器，不适合进 `npm test`。于是加 `console/test/viewport-check.test.mjs` 静态守最容易坏的几件事：压测串仍是 139 字符、测量同时覆盖外框与字形框、`style.css` 那组类仍带 `min-width: 0` 与 `overflow-wrap: anywhere`、压测必须 `import` 产品的 `writeText` 而不是自己另写一份断行逻辑。第三条与第四条是真价值 —— 谁哪天顺手删了那两行 CSS 或让 `el()` 绕开 `writeText`，`npm test` 立刻红，而不是等用户在窄屏上发现路径被裁掉或断在词中间。

### 4.5 ai

#### 亮点二十一：`stdout` 上多一个换行，MCP 客户端就断流

- **亮点名称**：把「入口」与「能力」拆开，顺带修掉一个沉睡的缺陷。
- **价值**：解决「同一个能力要同时给人和给 AI 用」的问题。人也罢、agent 也罢，都要调度四个方向；但两种用途对 `stdout` 的洁净度要求完全不同。
- **实现方式**：把调度逻辑从 `bin/wacmin-console.mjs` 搬到 `console/src/directions.mjs`，入口文件只留 argv 解析与打印，并加 `isDirectRun()` 守卫（用 `realpathSync` 比对，字符串比对会漏掉软链与 `./` 前缀）。
- **差异化**：这不是为了 MCP 新写的清理，而是暴露出一个**预先存在的真实缺陷**。`console/src/server.mjs` 的 `/api/status` 原先 `import('../bin/wacmin-console.mjs')` 来取方向列表——每来一个 HTTP 请求，就把 21 行中文用法说明写进 `stdout`，并把 `process.exitCode` 设成 2。`console` 从不读自己的 `stdout`，所以这个缺陷一直没被看见；而 MCP 规范要求 `stdout` 只出现协议消息，同一写法在 MCP 上是致命的。
- **证据**：实测 `stdout 字节数: 0`（修复后），修复前每次请求产生 21 行输出且 `exitCode after import: 2`。移除守卫后新增的测试立刻报红（9 pass / 1 fail），说明这道测试真的在守。

#### 亮点二十二：六个工具，而不是二十六个

- **亮点名称**：按意图分组，不按子命令映射。
- **价值**：解决「给了 agent 一堆工具，它反而不知道用哪个」的问题。四个方向合计二十多个子命令，全部摊平成工具后，工具名之间的差异 agent 看不出来，只能靠猜——而猜错的代价是一次真实构建。
- **实现方式**：六个工具按意图划分（列举、自检、构建、校验、评估、透传），未建模的选项统一走 `wacmin_run` 这个逃生门。
- **差异化**：多数 MCP server 采用「一个子命令一个工具」的机械映射，工具数量随 CLI 膨胀，而 agent 的选择质量随工具数量下降。
- **证据**：`wacmin_build` 的 schema 只把 `direction` 列为必填——起点字段是 `project` 还是 `installer` 取决于方向，JSON Schema 的 `required` 表达不了「A 或 B 至少一个」。硬写成 `required: ['direction','project']` 会直接拒绝所有合法的 `exeonmac` 调用。

#### 亮点二十三：构建失败不是协议错误

- **亮点名称**：两层错误分开，业务失败原样保留。
- **价值**：解决「agent 只知道出错了，不知道为什么」的问题。把构建失败包成 JSON-RPC `-32603`，agent 拿到的是「internal error」，看不到 `M2W_1002`，也就无法告诉用户「缺的不是你的项目，是 7-Zip」。
- **实现方式**：协议层错误走顶层 `error` 字段（`-32700` / `-32600` / `-32601` / `-32602` / `-32603`）；命令真的跑了但失败则走 `result.isError = true`，`content` 里带可读原因和 `stderr` 尾部。
- **差异化**：很多实现在这一层图省事，把所有非零退出码都翻译成协议错误，等于把最有价值的信息丢掉了。
- **证据**：实测失败路径返回 `isError: true`、`exitCode: 2`、`error.code: M2W_1002` 并附 `hint`，成功路径不带 `isError`；`wacmin run exeonmac doctor` 返回 5 时 `wacmin` 也返回 5，退出码严格透传。

---
## 五、设计细节与工程取舍

本章记录所有非显而易见的细节。每一条都对应一个真实踩过的坑或一次刻意的取舍，按主题分组。

### 5.1 开发顺位与风险控制

#### 5.1.1 顺位为什么这样排

```
Mac2Win  →  ExeOnMac  →  Win2Mac  →  AppOnWin
 已完成      已完成       已完成      评估可用
```

| 方向 | 确定性 | 理由 |
|---|---|---|
| Mac2Win | 高 | NSIS + 预编译运行时，已收敛 |
| ExeOnMac | 中高 | Wine + Rosetta 2，底座成熟，剩包装、层、配方三阶段工程量 |
| Win2Mac | 高 | 纯装配（zip + plist），与 Mac2Win 同构，可大量复用 |
| AppOnWin | 低 | 底座 Darling 在 Windows 需经 WSL2，GUI 被标注实验性 |

**为什么 Win2Mac 排在 ExeOnMac 之后**：它的确定性其实最高，但它可复用的东西（八阶段编排、错误码段位、报告结构）都来自 Mac2Win，排第三能直接搬。真正的难项是 ExeOnMac，不早做会积压。

**把 AppOnWin 放最后不等于不重视**：前三项做完后再投入，即使失败 Wacmin 已有三条腿站得住；反过来若先做它，失败会拖住全部排期。

#### 5.1.2 AppOnWin 的 spike 三条门槛

**spike 可随时插队**——可行性验证只需一个 WSL2 环境，不占主线工期。

1. WSL2 内装 Darling，能跑通一个最简命令行 Mach-O；
2. **能加载一个最简 AppKit 窗口**（哪怕只画一个白框）——决定性门槛；
3. 能读 `Info.plist` 并定位主二进制。

第 2 条不通过则降级为「兼容性评估工具」，不再占主线顺位。

**三态而非两态**：spike 的结果是 `pass`（实测通过）/ `fail`（实测失败）/ `blocked`（环境不具备，无法执行）。`blocked` **不等于** `pass`——把「没验」写成「通过」是这个项目最想避免的一类错误。

**`blocked` 内部还要再分一层**（2026-11-19 补）：`blocked` 有两种成因，对用户的意义完全不同，因此 spike 额外输出 `inputErrors` 把它们分开。

| 成因 | 例子 | 整体结论 | 退出码 |
|---|---|---|---|
| 环境不具备 | 宿主不是 Windows / 无 WSL2 / 无 Darling | `unverified` | 5 |
| 参数写错 | `--app /nope.app` 路径不存在、`--sample` 指向不存在的文件 | `unverified` + 非空 `inputErrors` | **2** |

分界线是「这条门槛有没有被执行过」：路径不存在时门槛根本没进入解析，谈不上失败；`fail` 的语义必须留给「真的跑了一次并失败」。早先这里把路径错误记成 `fail`，整体结论因此变 `rejected`，措辞是「本方向按设计降级为兼容性评估工具」——**用户只是少敲了一个字母，却被告诉方向被证伪了**；而同一个路径喂给 `assess` 得到的是退出码 2。同一份输入在两条子命令上给出两种含义，脚本无法据退出码分流。凡是「输入路径不合法」一律归退出码 2（配对 `AOW_1002`），与 `assess` / `parse` 保持一致。

### 5.2 契约层的设计

#### 5.2.1 退出码的九种语义

| 码 | 含义 | 何时使用 |
|---|---|---|
| 0 | 成功 | 流程跑完且产物校验通过 |
| 1 | 未归类失败 | 内部错误，或不属于其他码的失败（`9999`） |
| 2 | 参数错误 | 命令行参数缺失、拼写错误、互斥冲突（`1002` / `1003` / `1004`） |
| 3 | 能力未实现 | 该功能属于后续阶段，当前阶段明确不做（`7001`） |
| 4 | 明确不支持 | 输入物的类型或类别落在硬边界内，不尝试绕过（`1005`） |
| 5 | 缺少外部依赖 | 缺 makensis / wine / 7z / innoextract 等工具（`2001` / `2002`） |
| 6 | 构建或安装失败 | 项目构建、依赖收集、暂存、编译环节出错（`4001`–`5002`） |
| 7 | 产物校验失败 | 产物存在但不符合规范：架构错、文件缺、哈希不匹配（`6001`–`6003`） |
| 130 | 用户中断 | 收到 SIGINT / SIGTERM（`9001`） |

**3 与 4 的区别是刻意的**：3 是「现在没做，以后会做」，4 是「永远不会做」。调用方据此决定是重试还是放弃。

#### 5.2.2 错误码段位不越界

| 段位 | 范围 | 含义 |
|---|---|---|
| 1000 | 1001–1999 | 环境与输入 |
| 2000 | 2001–2999 | 外部工具 |
| 3000 | 3001–3999 | 运行时 |
| 4000 | 4001–4999 | 输入物处理 |
| 5000 | 5001–5999 | 产物生成 |
| 6000 | 6001–6999 | 产物校验 |
| 7000 | 7001–7999 | 能力未实现 |
| 9000 | 9001–9998 | 流程控制 |
| 9999 | 9999 | 内部错误 |

**九个段位，不是八个。** 这张表必须与 `contracts/error-prefixes.json` 的 `segments` 逐项一致——`9000` 的 `range` 止于 `9998`，`9999` 是独立一段。早先本文把两者合写成「`9000` / `9001–9999` 流程控制与内部错误」，而代码里 `9999` 是单独一段：后果是 `validate.mjs` 的 `segmentOf()` 按 `range` 实际区间判归属，文档却让人以为 `9999` 属于 `9000` 段，读文档去查校验器行为必然对不上。

各方向在自己的 errors 模块里定义具体码，但**段位不可越界**。`4xxx` 永远是输入物处理，不会因为某个方向的特殊需要变成别的含义。

`7xxx` 单独一段的理由：它**不是错误**，是「还没做」。混进 `1xxx` 会让前端无法区分「用户配错了」和「功能没写」。

#### 5.2.3 退出码与错误码段必须配对检查

`exit-codes.json` 的 `errorSegment` 不只是注释——它声明了「哪个错误码配哪个退出码」，`validate.mjs` 会拿它反查每一份报告。

| 退出码 | 含义 | 配对错误码 |
|---|---|---|
| 2 | 参数与输入错误 | `1002` `1003` `1004` |
| 4 | 明确不支持 | `1005` |
| 5 | 缺少外部依赖 | `2001` `2002` |
| 6 | 构建或安装失败 | `4001`–`5002` |
| 7 | 产物校验失败 | `6001`–`6003` |
| 3 | 能力未实现 | `7001` |

**`1005` 是 `1xxx` 段里唯一配退出码 4 的例外**：`1002` 是「路径写错了」，`1005` 是「这个东西本身做不了」。两者对自动化的含义完全相反——前者该重试，后者该停。实现里 `exitCodeFor()` 必须先判 `1005` 再按段位分流，顺序反了就会把它归进退出码 2。

**这条检查是后补的**。早期只校验「错误码格式对不对」，于是出现过「`verify` 失败报退出码 7，但错误码给的是 `M2W_1004`（输入物不存在，属 1xxx 段）」这类**跨段错配**——格式合法，语义错位，调用方按退出码 7 去查产物，实际问题在参数。更早还有一次：契约里 `exit 4` 标着 `errorSegment: "1002"`，而四个方向的实现都把 `1002` 映射成 2，契约与实现静默分叉了很久。两次都是同一类问题：**校验只查了存在性，没查自洽性**。

#### 5.2.4 stdout 与 stderr 的分工

`--json` / `--report` 时，**stdout 只有 JSON，日志走 stderr**。这样管道可以直接把 stdout 交给 `jq`，不需要过滤日志行。

**这条最容易破**，三个方向都踩过：

- mac2win 的 `verify` 把日志写进 stdout；
- exeonmac 的 `version` 直接 `print` 人类可读文本；
- exeonmac 的 `--report` 与 `_StdoutToStderr` 改道机制冲突——改道期间 `sys.stdout` 就是 stderr，子命令若取 `sys.stdout` 写报告，JSON 会落进 stderr，`wepack ... --report | jq` 拿到空输入。修法是统一用 `_out()`。

原则一致：**结构化输出与人类输出必须分到不同流**。

### 5.3 判定逻辑：同一判据不许两处各写一套

#### 5.3.1 doctor 与 verify 曾用两套方式判断「有没有 7-Zip」

- `doctor` 只看 PATH 里有没有 `7z`；
- `verify` 查环境变量、项目目录、Homebrew、MacPorts、PATH，最后还扫 `/Applications/*.app`。

实测那台机器上出现过自相矛盾：`doctor` 报「[FAIL] 7z 未安装」，而同一时刻 `verify` 正用 BlueStacks 里那份 7-Zip 成功解包校验。

更糟的是 `doctor` 的 FAIL 让整个自检 `allOk = false`、退出码 5——一个完全能用的环境被判为不可用，用户会去装 Homebrew 版，装完再跑才变绿。这中间他本来不需要做任何事。

**规则**：同一件事的判断逻辑只能有一处实现。`doctor` 现在报的就是 `verify` 实际会用的那个二进制路径。

**「没装」和「装了你找不到」是两件事**。前者要用户动手，后者是工具失职。实测环境：PATH 里的 `7zz` 是构建沙箱的包装脚本（跑起来报 `spawnSync 7zz ENOENT`），Homebrew 没装，但 BlueStacks 和 Parallels 各自带了一份**能用的** 7-Zip，就在 `/Applications/*.app/Contents/MacOS/` 里。

#### 5.3.2 工具探测不能只看退出码

`/bin/echo i` 的退出码也是 0。只判退出码会把它认成 7-Zip。

误用后果很隐蔽：后续的 `7zz l -slt` 拿到一堆无关文本，解析不出文件清单，最后报「载荷文件数 0」——看起来像安装包坏了，实际是工具选错了。

**现在的判据是输出特征**：`i` 的输出里必须同时出现 `7-Zip`（程序自报名字）与 `Formats:`（格式列表段头）。两个都在才算数。

ExeOnMac 侧同一问题的另一种形态：PATH 里可能存在「转发壳」——文件存在、`os.access` 通过，但真正调用时返回 127。因此工具探测除检查文件存在，还做一次空调用冒烟测试，用退出码判定，跳过跑不起来的转发壳，并在错误信息里提示用 `WEXE_7Z` 指定真实二进制。

#### 5.3.3 显式配置不许静默回退

`MAC2WIN_7ZIP` 是用户明确表达「用这个」的方式。早期实现若该路径不存在，会**默默继续往下找**，最后用上系统里另一份。

用户在排查「换了个 7-Zip 版本怎么没变化」时会彻底走错方向：`doctor` 报的是另一份的路径，而他还以为生效的是自己设的那个。

**现在的语义是「要么用它，要么明确失败」**：路径不存在报 `M2W_1003` / 退出码 2，路径存在但不是 7-Zip 也会说清原因。不参与回落。

同理，`verify` 里那个 `catch { return null }` 原本会把配置错误吞成「无法推断目标架构」，然后按默认架构往下验，最后给一个完全无关的结论。现在按错误信息区分：配置错误往上抛，解包失败才退回 `null`。

#### 5.3.4 `undefined` 与 `null` 不能混为一谈

`successReport` 原本判的是 `result.zipArtifact !== null`。调用方不传这个字段时它是 `undefined`，而 `undefined !== null` 为真——于是报告里多出一条 `{kind: 'zip', target: 'x86'}`，`path` 与 `bytes` 全缺。

两个后果：契约要求 `artifacts[].path` 是非空字符串，整份报告不合规；下游按 `artifacts.length > 0` 判断「有产物可下载」时，会渲染出一个点不动的下载链接。

**判据改为 `typeof value === 'string' && value !== ''`**。空字符串比 `undefined` 更隐蔽——`typeof '' === 'string'` 成立，只判类型会放过去。

### 5.4 失败路径：超时、重试、降级、容错

#### 5.4.1 校验结论是三态，不是两态

产物校验有三种结局，早期实现只区分前两种，把第三种错归成了第一种。

| `ok` | `complete` | 结论 | 退出码 | 错误码 |
|---|---|---|---|---|
| ✓ | ✓ | 校验通过 | 0 | — |
| ✗ | 任意 | 校验未通过（产物有问题） | 7 | `M2W_6001` |
| ✓ | ✗ | 校验未完成（环境缺工具） | 5 | `M2W_2001` |

**为什么必须分开**：`ok` 回答「有没有查出问题」，`complete` 回答「是不是全验了」。二者正交。

第三行是补上的。原先「找不到 7-Zip，跳过解包校验」被记成 `warn`，而 `ok` 只看有没有 `fail`，于是 `ok === true`、CLI 打印「校验通过」、退出码 0——**而载荷里 4000 多个文件一个都没比对**。

**为什么这比崩溃更危险**：校验失败会让人去查，假的通过不会。用户会拿着一个只验了文件头的安装包，配上「已通过校验」的结论去分发。

**5 与 7 为什么必须是两条路**：5 是「我没验，装个工具重跑就行」，7 是「验了，产物是坏的，要重打包」。合并成一个码，用户会照着错误的方向排查。

#### 5.4.2 超时后的二次收割必须容错

超时后调 `process.communicate(timeout=15)` 收割输出，这一步本身也可能超时——子进程继承了管道，即使父进程已死，管道仍不关闭。

实现里对二次收割做了完整容错：再超时就强制关闭管道句柄、`wait(5)` 兜底，绝不因为「收尾」再抛一次异常。原始实现漏了这层保护，导致超时后抛出未捕获的 `TimeoutExpired`，进程未被清理、日志也没写。

#### 5.4.3 进程组清理的三步

只 `process.terminate()` 不够：wine 会派生 `wineboot`、`services.exe`、`explorer.exe`，杀掉父进程后这些子进程继续占着 prefix，下次安装会冲突。

清理分三步：`SIGTERM` 整个进程组 → 等 5 秒让 wine 自己写注册表收尾 → `SIGKILL` 进程组。`wineserver -k` 作为更干净的备选已实现，供交互模式使用。

`console` 侧同一问题的实现是 `process.kill(-pid)`——子进程以独立进程组启动，负数 pid 表示整个组。默认超时 30 分钟，`doctor` 为 60 秒，`WACMIN_TIMEOUT_MS` 可覆盖，`0` 表示不限。

#### 5.4.4 解包失败清空半成品

解包全部方法都失败时，清掉本次在输出目录里产生的半成品，保持目录干净。不清空的话，下次用同一目录会因「非空」被拒绝，用户需要手动清理。

#### 5.4.5 安装失败不自动回退交互

静默安装失败后不自动弹交互窗口。理由：自动回退会打断批处理，且用户可能不在机器前，窗口会一直挂着。

`--interactive` 需用户显式指定。这是刻意的取舍：**少一点「智能」，多一点可预测**。

#### 5.4.6 目录非空时拒绝而非删除

`create_prefix` 与 `extract` 遇到非空目标目录时直接报错，不覆盖、不删除。理由：目标目录里可能是用户的数据，工具无权判断哪些可以删。

`--force` 参数存在，但它也只改变错误信息，不改变行为——删除是用户的决定，不是工具的工具的决定。

#### 5.4.7 退出码不足以判断安装成功

既有「退出码 1 但什么都没装」，也有「退出码 0 却只释放了几个临时文件」。因此 `run_install` 在安装前后各取一次 `drive_c` 的（文件数, 总字节数）快照，按**净增量**判定：至少 8 个文件且至少 1 MiB 才认为装上了。

阈值不设 1，是因为真实安装器即使用户中途取消也会留下自举程序与日志；只看文件数也不够，某些安装器会建一堆空目录与 0 字节占位文件。

两个概念在代码里分开表达：`InstallRun.exit_ok` 回答「安装器认为自己成功了吗」（含 MSI 的 3010 = 需重启但已成功），`InstallRun.ok` 回答「这次安装真的产出可用文件了吗」。只有前者通过、后者不通过时，日志会写明「安装器报告成功，但没有文件落到 prefix」并给出 `--interactive` / `--silent-args` 的排查建议。

#### 5.4.8 层缺失不阻断安装

应用可能不走到那条代码路径，强行失败会让「能装但缺 MFC」的包彻底装不上。缺什么由 `warnings` 明确告知，同时写进 `install.log`。

#### 5.4.9 坏配方等同没有配方

YAML 损坏或字段缺失时 `load()` 返回 `None`，回退到探测，不让一个坏缓存阻断打包。但**命中配方仍要验文件**：配方里的 `entry` 若已不存在（安装器换版本、路径变了），回退到重新扫描并记 WARN，绝不盲目信任——盲目信任缓存会产出一个双击打不开的包。

#### 5.4.10 开浏览器失败不该让应用退出

`spawn` 的 error 事件未挂监听时会冒到 `uncaughtException`，日志报 `spawn cmd ENOENT` 后进程死。修法是挂 `error` 监听，降级为日志。

### 5.5 文件与磁盘

#### 5.5.1 clonefile 的空间测量

不能用 `st_blocks` 或 `du` 判断 clonefile 是否省空间。APFS 会把共享块重复计入每个副本，`du` 无法知道块是共享的。

正确的测量方式是卷可用空间的差值：

```python
before = free_space(path)
clone_tree(src, dst)
consumed = before - free_space(path)   # 真实占用
```

这个细节导致过一次误判：用 `du -sk` 断言时，clonefile 前后都报 20 MB，被误认为「clonefile 没生效」。

**同一陷阱的另一面**：`install --json` 输出里的 `disk.allocated` 是 `st_blocks` 之和，**在 clonefile 场景下这是上界而不是真实占用**。报告里如实标注这一点，不假装它是精确值。

#### 5.5.2 zip 的 Unix 权限位必须显式写

`external_attr = (mode << 16) | dosAttrs`，并把 `create_system` 置为 `3`（Unix）——只有标了 Unix，解压方才会去读高 16 位的 mode。

三条配套规则：

| 规则 | 原因 |
|---|---|
| 目录名必须以 `/` 结尾并置 `S_IFDIR` | 否则解压方按普通文件处理，目录结构错乱 |
| 符号链接置 `S_IFLNK` | 否则链接被当普通文件写出，变成一份内容副本 |
| `Contents/MacOS/*` 在 Windows 上按角色兜底 `0755` | Windows 无 mode，只能按路径角色推断 |

**为什么不依赖宿主**：GNU zip 会写 Unix 位但需要宿主是 Unix；多数跨平台库把外部属性写成 0 或只写 DOS 属性。自研写入器不依赖宿主，规则显式且由测试守着。

#### 5.5.3 dosdevices 链接必须是相对路径

`c:` 指向 `../drive_c`，用相对链接。若用绝对路径，`.app` 拷贝到另一台机器或从备份恢复后，链接全部失效，应用无法启动。

`z:` 指向 `/` 是 Wine 标准做法，用于让安装器从 `Z:\Users\...\setup.exe` 访问原安装包——不把安装包复制进 prefix，既省空间也保证原包不被修改。

#### 5.5.4 下载落盘的两种策略

| 场景 | 策略 | 适用方向 |
|---|---|---|
| 有 `.part` 中转 | 先写临时文件，长度校验通过后 `rename`。中途失败不会留下一个看起来完整的坏文件 | ExeOnMac |
| 无 `.part` 中转 | 直接写目标文件；中断会留下半截文件，但下一次运行会因架构断言失败而丢弃重下 | Mac2Win |

**Mac2Win 的下载没有 `.part` 中转**是已知的实现差异，行为等价于「检测到坏缓存就重下」，不影响正确性。写清楚比统一口径更重要。

#### 5.5.5 覆盖写先删后建

目标目录在上游操作前先 `remove`，避免「旧文件残留 + 新文件写入失败」产生半新半旧的产物。

#### 5.5.6 打包必须剔除苹果垃圾文件

macOS 在目录里留下 `.DS_Store`、`._*`（AppleDouble）、`__MACOSX` 三类文件。它们进入 Windows 安装包后既无意义又会让用户看到怪文件。剔除规则**只认这三类精确叶名**，不做通配，避免误删用户数据。

### 5.6 外部进程的调用

#### 5.6.1 静默参数用 argv 而非字符串

参数以列表传递，不做字符串拼接。路径含空格时字符串会被二次拆分。

**NSIS 的 `/D=` 与 wine 的引号规则在含空格路径上无解。** NSIS 文档要求 `/D=` 必须是最后一个参数、且路径不能加引号（即使含空格）；而 wine 在把 POSIX argv 拼成 Windows 命令行时，看到含空格的参数会**自动补一对双引号**。

两条规则同时成立时，安装器收到的是 `"/D=C:\Program Files\App"`——NSIS 只认行首的 `/D=`，带引号就整个丢弃，退回它自己的默认目录。

实测证据（Ondra 1.3.0，同一 prefix、同一安装包）：

| `/D=` 的值 | 净增文件 | 落点 |
|---|---|---|
| `C:\Program Files\DirTestA` | **0** | 什么都没装（退出码却是 0） |
| `C:\DirTestNoSpace` | 6424 | `C:\DirTestNoSpace` |

唯一变量是路径是否含空格。wine 也不支持 8.3 短名（实测 `C:\PROGRA~1` 不存在），没有回避手段。

所以默认安装目录改成 `C:\Wacmin\<AppName>`，**不含空格**。应用名本身含空格时（如「空谷 Ondra」）也会被清成下划线。这不是牺牲像真度——在 wine 里跑的程序本来不在真的 Windows 上，装到 `C:\Wacmin\App` 与 `C:\Program Files\App` 对用户没有可见差别，但一个能装上、一个装不上。

若用 `--install-dir` 指定了含空格的路径且安装器是 NSIS，`/D=` 仍会静默失效；此时由净增量校验判定「没装上」，如实报错而不是假装成功。

**Inno 的 `/DIR=` 规则相反，但代码里同样不加引号**。Inno 要求值含空格时带引号，而 wine 会替我们补上——自己加反而被转义成 `\"`。实测：

| argv 传 | Inno 看到 | 结果 |
|---|---|---|
| `/DIR=C:\Program Files\Ondra` | `"/DIR=C:\Program Files\Ondra"` | 正确 |
| `/DIR="C:\Program Files\Ondra"` | `"/DIR=\"C:\Program` + `Files\Ondra\""` | 被拆成两段 |

**InstallShield 的 `/v` 不能带字面引号**。官方文档写 `/v"/qn"`，但在 wine 下内部引号会被转义成 `\"`，安装器收到的参数整体变形。改用紧凑写法 `/v/qn`（InstallShield 与 msiexec 都认）。

#### 5.6.2 子进程输出解码必须容错

`subprocess.run(..., text=True)` 用 locale 编码解码且 `errors='strict'`。只要有一个字节不是合法 UTF-8 就抛 `UnicodeDecodeError`——而这个异常会被外层当成「工具执行失败」，报出「7z 无法解包」这种完全错误的结论，人会去查 7z 的安装。

坏字节是常态：wine 用 cp1252/cp936 打印含中文的 Windows 路径、某些 7z 本地化版本按系统代码页输出文件名、安装器把控制字符直接写进 stderr。本项目里有 19 处 `subprocess.run`，全部裸用 `text=True`。

改为统一常量 `wepack.tools.TEXT_MODE`（`text=True` + `encoding='utf-8'` + `errors='replace'`）。判定用的是退出码与磁盘上的实际产物，不依赖输出文本，所以替换掉几个字符不影响任何结论。另有一条静态扫描测试守住：源码里不许再出现裸 `text=True`。

#### 5.6.3 校验哈希不落地到磁盘

一个 200 MB 的 exe 内 4086 个文件，若每个文件调一次 `7zz x -so`，就是 4086 次进程创建——实测耗时 10 分钟未完成。改为**一次解包 + 本地哈希**：用 `7zz x -so` 流式解到内存算哈希，空谷 4086 个文件校验耗时 0.87 秒。

#### 5.6.4 取消必须真的杀进程树，否则「已取消」是假的

MCP 客户端可以发 `notifications/cancelled` 取消一次在途的工具调用。这里有一个容易做错的地方：**把 Promise reject 掉不等于任务停了**。

如果只终止等待、不管子进程，会出现最难排查的一类现象——agent 报告「已取消」，但磁盘上多了半份产物，`~/.wacmin/mac2win/cache/` 里多了个下载了一半的运行时，下次构建读到它并断言失败，报出的错误与本次取消毫无关系。

`console/src/directions.mjs` 的 `runDirection` 因此接受一个 `signal`，`abort` 时按亮点十八的方式处理：向**整个进程组**发 `SIGTERM`，等 2 秒，仍在则 `SIGKILL`。返回结果带 `aborted: true`，调用方据此把这次运行标成「取消」而非「失败」。

**为什么是 2 秒而不是立即 `SIGKILL`**：`SIGKILL` 不给进程清理的机会，Wine prefix 会留下锁文件，下次运行报「prefix 被占用」。2 秒足够大多数进程响应 `SIGTERM` 自行退出，超时说明它卡死了，再强杀是唯一选择。

**未知的 `requestId` 一律静默忽略**。规范如此，而且客户端有可能在响应已经到达之后才发出取消——那不是错误，只是时序。

### 5.7 编码与中文

#### 5.7.1 NSIS 签名的真实偏移

NSIS 的 `firstheader` 布局是 `+0 flags`、`+4 siginfo (0xDEADBEEF)`、`+8 signature ("NullsoftInst")`、`+20 length`。签名在 `+4` 与 `+8`，**不在 overlay 起点**。

按 `overlay+0` 判断 `DEADBEEF` 会漏判。这个坑在实现时踩过一次：真实样本被判成 `unknown`，直到 dump 出 overlay 前 24 字节才发现偏移错位。

#### 5.7.2 MSI 表数据是列主序，不是行主序

第 c 列从下标 `c * rows` 开始，占 `rows` 个 u16。

`_Columns` 是**列主序的 4 个平行数组**，不是 (table, column, name) 三元组：

```
[0n, 1n)  表名对应的字符串编号（不是 _Tables 里的位置）
[1n, 2n)  列序号（低 15 位有效，0x8000 = 临时列）
[2n, 3n)  列名的字符串编号
[3n, 4n)  列类型（实测取值不符合 msidbColumnType 枚举，本工具不依赖它）
```

`_StringPool` 头部 4 字节是总字符数，随后每项 4 字节 `(cch:u16, refs:u16)`，字符串在 `_StringData` 里紧密排列、无分隔符。

**行数不一定等于 总 u16 数 ÷ 列数**：实测 PowerShell 的 File 流 18260 字节 = 9130 个 u16，8 列 × 913 行只占 7304 个，尾部还有 1826 个值属于别的数据（该 MSI 把多张表塞进同一流）。所以行数靠内容定：开头连续匹配 `fil`+32hex 的个数就是行数，再据此按列主序读取。

#### 5.7.3 中文路径的四个环节

中文不是边角情况——ExeOnMac 的目标用户装的就是中文软件。这条链路上有四个环节，每个环节的坑各不相同。

1. **拼路径：保留中文，清除空格**。默认目录是 `C:\Wacmin\<应用名>`，应用名里的空白转下划线（`空谷 Ondra` → `空谷_Ondra`）。中文必须保留（用户要能看懂 `C:\Wacmin\记事本`），空格必须清除（NSIS 的 `/D=` 硬约束）。两个要求同时成立才不冲突。注意这条规则只约束 **ExeOnMac（Wine prefix 内的静默安装）**；Mac2Win 产出的安装包由用户在真实 Windows 上交互安装，不受 `/D=` 的空格约束。
2. **转 Windows 形式：`drive_c/A/B` → `C:\A\B`**。这一步不能引入新的空格，否则前面所有的努力作废。测试 `test_windows_form_has_no_space_for_nsis` 就是守这道闸。
3. **进 argv：中文经 wine 传过去不会变乱码**。实测 `wine cmd /c "mkdir C:\Wacmin\记事本"` 落盘目录名是 UTF-8 字节 `e8 ae b0 e4 ba 8b e6 9c ac`，`if exist` 也能正确命中。
4. **进 bundle id：中文要剔除，但不能剔除到失去区分度**。详见亮点十七。

#### 5.7.4 占位注册表的编码

base 层若未自带注册表文件，需要写占位。Wine 的 `.reg` 必须是 UTF-16LE 加 BOM，头部为 `WINE REGISTRY Version 2`。写成 UTF-8 会让 wine 报错退出。

#### 5.7.5 重启拦截走 .reg 文件

安装器调 `ExitWindowsEx` 时不能让系统真重启。做法是写 `wepack-suppress-restart.reg` 到 prefix，用 `wine regedit /S` 导入。

不直接改注册表二进制，只写 `.reg` 文件。文件保留在 prefix 里，便于审计与回滚。

#### 5.7.6 3010 必须算成功

MSI 的退出码 3010 表示「成功但需重启」。这是 MSI 的惯例，不是错误。若不特殊处理，大量 MSI 会被误判为安装失败。

#### 5.7.7 Info.plist 的码点截断

`CFBundleName` 按**码点**截断（≤15 字符），不截断到半个字——一个中文字在 UTF-8 里占 3 字节，按字节截断会产生非法序列，`plutil` 直接拒绝。`CFBundleVersion` 归一化为纯数字点分，非数字段替换为 0。

#### 5.7.8 流式解码必须用 stream 模式，否则中文会碎成 U+FFFD

MCP 的 stdio 传输是字节流，`data` 事件的切块位置由内核决定，与字符边界无关。一个中文字占 3 字节，完全可能被切在前两个字节之后：

```javascript
// 错误：每块独立解码，跨块的多字节字符直接变成 U+FFFD
buffer += chunk.toString('utf8')

// 正确：TextDecoder 的 stream 模式会在内部保留未完成的字节
this.#buffer += this.#decoder.decode(chunk, { stream: true })
```

**这个错误不可挽回**：`U+FFFD` 一旦生成就写进了字符串，后续无论怎么拼接都无法还原原始字节。表现是「偶尔某个工具的返回里中文变成问号」——因为只有恰好被切开的那一次才出问题，测试时很难稳定复现。

因此 `ai/src/protocol.mjs` 的 `LineDecoder` 用 `TextDecoder` 的 `stream: true` 模式累积，并且**先解码再按 `\n` 切行**，而不是先切字节再逐行解码：一条消息可能跨越多个块，一行文本也可能被切开，两个维度都要处理。

### 5.8 界面与流式输出

#### 5.8.1 界面文案的口径必须与后端一致

后端不撒谎了，界面还在撒谎也没用。Mac2Win 的 Web 控制台原本写「`${result.verify.length} 项通过`」——那是**全部项**，包括 `warn` 和根本没验的项。10 项里 5 项没验，界面照样写「10 项通过」。

**现在的口径分四种**：

| 情形 | 文案 | 颜色 |
|---|---|---|
| 有 `fail` | `N 项失败` | 红 |
| 有未验证项 | `N 项通过，M 项未验证` | 橙 |
| 有 `warn` 但全验过 | `N 项通过，M 项有警告` | 橙 |
| 全绿 | `N 项通过` | 绿 |

未验证时用橙色而非绿色，因为绿色等于告诉用户「放心分发」。也不用红色——产物本身没查出毛病，红色会把人引向「重打包」这条错路。

#### 5.8.2 终端输出的转义序列处理

`console` 看板把子进程的 stderr 转成 SSE 事件推给浏览器。真实 stderr 带 ANSI 颜色码，处理时踩过两个坑：

1. **`▸` 与 `[` 之间夹着颜色码**。剥离必须用完整的三类序列（CSI `\x1b[...`、OSC `\x1b]...`、两字符序列），不完整的正则匹配不上。
2. **chunk 边界会切在转义序列中间**。先累积再剥离是错的——必须先用 `incompleteEscapeTail()` 把可能被切开的尾巴扣住，剥完再累积。

若不处理第二点，偶发的半截转义序列会泄漏到界面，表现为日志里出现 `[36m` 这类乱码。

#### 5.8.3 SSE 的三处一致性

Server-Sent Events 是单向流，三个边界情况必须处理：

1. **`done` 之后必须关流**。否则非浏览器客户端（比如 `curl` 或测试里的 `request` 辅助函数）会一直等 `end`，表现为超时。
2. **迟到订阅要补发早期事件**。任务启动后才连上来的浏览器，若只收实时流，会看到一片空白。用 256 KB 上限的事件缓冲，超限时优先淘汰最早的 `log` 事件（保留 `stage` / `done` 这类结构事件）。
3. **收尾要 flush**。最后一行日志若没有换行符，会被「按行切分」的逻辑留在缓冲区里丢掉。

#### 5.8.4 为什么用 SSE 而不是 WebSocket

进度是单向的（服务端 → 浏览器），SSE 足够，且原生 `EventSource` 支持、走普通 HTTP、断线自动重连。WebSocket 在这里只增加握手与心跳的复杂度。

#### 5.8.5 进度条的权重要按耗时算

若按阶段数平均，打包（占总耗时一半以上）只占 1/8，用户会看到进度条卡在 87% 不动。按预期耗时加权后，进度曲线与实际耗时大致同形。权重表见 10.3 节。

### 5.9 默认参数与为什么这样选

| 默认值 | 为什么 |
|---|---|
| `target: "x86"` | 项目定位是「在 ARM macOS 上打 x86 Windows 包」。x86 可在 32 位与 64 位 Windows 上运行，覆盖面最大 |
| `electronVersion: "43.0.0"` | v44 起官方不再发布 `win32-ia32`。这是**能用的最高版本**，不是随手取的 |
| `compression: "lzma"` | NSIS 支持的压缩里体积最小。代价是编译时间，但打包一次编译一次 |
| `desktopShortcut: true` | Windows 用户的习惯是桌面启动。设为 false 需要用户自己找到开始菜单 |
| `requireAdmin: false` | 普通用户目录安装可避免 UAC 弹窗。只有确实需要写 `Program Files` 时才打开 |
| `verify: true` | 校验是产物可信的唯一保证。关掉只跳过校验，**不跳过安全检查** |
| `outDir: "dist-mac2win"` | 前缀 `dist-` 让它在 `.gitignore` 里能被一条规则覆盖，后缀标明来源方向 |
| `WACMIN_TIMEOUT_MS: 1800000` | 30 分钟。实测最慢的真实构建（含下载）在 20 分钟内，留足余量但不至于永远挂着 |
| macOS 最低版本 `13.0` | 需要 `iconutil`、`sips` 与 APFS clonefile。13 是这三个条件同时稳定的起点 |
| `--min-macos` 默认 `13.0` | 与 ExeOnMac 的 `LSMinimumSystemVersion` 保持一致，避免同一用户的两个方向产物要求不同系统 |
| `requireAdmin: false` → 装到 `%LOCALAPPDATA%\Programs\<App>` | 每用户安装的标准位置：不需要 UAC 提权，卸载时也不会留下需要管理员才能删的残留 |

**配置校验一次报全，不是遇到第一个就退**。配置文件一次只能改一处，如果每次运行只报一个问题，用户要跑五六轮才能改完。合并后统一校验，一轮就能改完。八个校验项见 9.2 节。

### 5.10 异常输入与畸形数据

#### 5.10.1 畸形报告不让看板崩溃

`console` 要读四个方向产出的报告 JSON。这些 JSON 可能因为版本不一致、写到一半被打断、或第三方工具生成而畸形。已覆盖的九类崩溃输入：

| 输入 | 若不处理会怎样 |
|---|---|
| `stages: [null]` | 访问 `null.status` 抛 `TypeError` |
| `checks: {}` | 对对象调 `.map` 抛 `TypeError` |
| `ok: "true"`（字符串） | 字符串真值判断通过，逻辑走错分支 |
| `artifacts: [{path: null}]` | 渲染出空链接 |
| `error.code` 为数字 | 正则校验抛异常而非返回不匹配 |
| `stages[].status` 为未知值 | 进度条宽度算成 `NaN` |
| 产物名含孤立代理项 | JSON 序列化抛 `URIError` |
| `durationMs` 为负 | 格式化输出 `-1ms` |
| `input.path` 为空串 | 显示一个空路径 |

统一策略：**校验在边界做，内部不做防御性判空**。边界层把畸形输入转成带明确原因的错误，内部按类型契约写。

#### 5.10.2 zip 条目的路径穿越

条目名先统一分隔符，再拒绝以 `/` 开头或含 `..` 的路径。zip 里出现 `../../etc/passwd` 这类条目是常见攻击手法。

#### 5.10.3 Windows 文件名的四种非法形态

| 形态 | 处理 |
|---|---|
| 保留设备名（`CON`、`PRN`、`AUX`、`NUL`、`COM1`–`COM9`、`LPT1`–`LPT9`） | 检查时去掉扩展名，因为 `con.txt` 同样非法 |
| 不允许的字符（`\ / : * ? " < > \|` 与控制字符） | 打包前检查并报错 |
| 以点或空格结尾的段 | 这类名字在 Windows 上会被**静默丢弃**，导致「打包成功但文件名对不上」，必须报错 |
| 路径长度超过 260 字符 | NSIS 硬边界，报错并指出是哪一段太长 |

#### 5.10.4 帮助文本与解析器必须双向一致

三件事都要成立：help 写的选项解析器都认、解析器认的选项 help 都写了、拼错的子命令明确报错而不是被当成路径。

每条都有测试守着（三个 Node 方向是 `test/help.test.mjs`，ExeOnMac 在 `tests/test_phase0.py` 的 `TestCLIContract` 与 `test_phase6.py` 里），因为这类偏差不会崩溃——只会让人白花时间。已踩过的实例见 15.3。

**顺带修掉的一处行为缺陷**：`win2mac biuld ./proj` 与 `apponwin asseess` 早先都不识别为「未知子命令」——前者报「项目目录不存在」把人引去查路径，后者更糟，打印一大段帮助后以**退出码 0** 结束，脚本里 `|| exit 1` 完全拦不住。

### 5.11 跨平台与旧版本兼容

#### 5.11.1 路径分隔符

内部统一用 `/`，只在写 NSIS 脚本时转换。`File` 路径混用分隔符会让 makensis 找不到文件——曾拼成 `"/tmp/app\*.*"` 导致失败。

#### 5.11.2 换行符

生成的文本文件一律用 LF：NSIS 脚本由 `makensis` 在 macOS 上编译，LF 可正常工作；`Info.plist` 是 XML，LF 为规范推荐值。

#### 5.11.3 可执行判定

macOS 看 `x` 位，Windows 看扩展名。`.app` 内主程序靠 `Info.plist` 的 `CFBundleExecutable` 定位，不依赖 `x` 位——但 `Contents/MacOS/` 下的文件仍必须有 `0755`，否则系统拒绝执行。

#### 5.11.4 旧产物兼容

`CFBundleIdentifier` 的哈希后缀**只在含非 ASCII 字符时添加**。纯 ASCII 输入原样返回，不改变既有产物的 id——否则升级构建会让老用户的「同一个应用」变成两个。

#### 5.11.5 已发布码值不可改

退出码与错误码一旦发布就是对外契约。新增只能追加。`schemaVersion` 的破坏性变更必须递增，`console` 据此分支。

---

## 六、技术栈与依赖清单

### 6.1 各方向技术栈

| 模块 | 语言 / 运行时 | 是否引入第三方包 |
|---|---|---|
| Mac2Win | Node.js ≥ 20（ESM） | 否，零运行时依赖 |
| ExeOnMac | Python ≥ 3.11 + Swift 6（launcher） | 否，仅标准库与系统框架 |
| Win2Mac | Node.js ≥ 20（ESM） | 否，自研 zip 写入器 |
| AppOnWin | Node.js ≥ 20（ESM） | 否，自研 plist / Mach-O 解析 |
| console | Node.js ≥ 20（ESM） | 否 |
| ai | Node.js ≥ 18.17（ESM） | 否，MCP 协议层自研 |
| contracts | Node.js ≥ 20（ESM） | 否，为四方向共用的校验脚本 |

**这一点需要强调**：七个模块全部**不引入任何 npm / PyPI 第三方包**。PE 头解析、zip 读写、plist 解析、Mach-O 解析、CFB 复合文档解析、MSI 表解析、MIME 表、HTTP 服务、SSE 推送、YAML 子集读写、测试框架，均为自研或使用语言内置能力（Node 的 `node:test`、Python 的 `unittest`）。

**具体到 Python 侧**，全部实现只使用标准库：`argparse`、`struct`、`subprocess`、`pathlib`、`hashlib`、`urllib`、`tarfile`、`tempfile`、`shutil`、`signal`、`json`、`re`、`logging`、`dataclasses`、`enum`、`typing`、`datetime`、`time`、`os`、`sys`、`platform`、`tomllib`。

**Swift 侧**只使用系统框架 `AppKit` 与 `Foundation`。

这样做的代价是要自己写若干底层解析器；收益是零传递依赖、零供应链风险、`git clone` 后无需 `npm install` 即可运行。

### 6.2 外部工具依赖

以下工具不随本项目分发，由用户在宿主机自行安装，本项目以独立进程方式调用。

**完整清单以 [`NOTICE`](./NOTICE) 第三章为唯一来源**，其中逐项记录名称、版本、版权方、许可证、官方地址、用途与是否修改七个要素。本节只列工具名、许可证类型与用途，便于快速判断需要装什么、会不会带来许可义务；版本号等易变信息不在两处维护。

| 工具 | 许可证 | 用途 |
|---|---|---|
| **NSIS**（`makensis`） | zlib/libpng License | Mac2Win 编译安装脚本为 `.exe` |
| **7-Zip**（`7zz`） | LGPL-2.1-or-later + unRAR restriction | 解包 NSIS / Inno / MSI 容器，产物校验 |
| **Wine**（`wine64`） | LGPL-2.1-or-later | ExeOnMac 运行 Windows PE |
| **Gcenx macOS_Wine_builds** | LGPL-2.1-or-later | macOS 上可运行的 x86_64 Wine 预编译构建 |
| **Rosetta 2** | 系统组件，非开源 | Apple Silicon 上翻译 x86_64 指令 |
| **innoextract**（可选） | zlib License | 解包 Inno Setup 安装包 |
| **msitools**（可选） | LGPL-2.1-or-later | 解包 MSI；缺失时走自研 MSI 表解析器 |
| **Darling**（评估中） | LGPL-2.1-or-later（部分组件为 GPL） | AppOnWin 的运行底座，需经 WSL2 |
| **WSL2** | 系统组件 | 为 Darling 提供 Linux 环境 |
| **plutil** | 系统组件 | Win2Mac 校验 `Info.plist` 的权威性 |
| **sips / iconutil** | 系统组件 | ExeOnMac 图标缩放与 `.icns` 打包 |
| **swiftc** | 系统组件 | ExeOnMac 编译 Swift launcher 与角标合成工具 |
| **git** | GPL-2.0 | 获取源码 |
| **Homebrew**（可选） | BSD-2-Clause | 在 macOS 上安装上述工具的推荐方式 |
| **cargo-xwin**（可选） | Apache-2.0 / MIT | Mac2Win 交叉编译 Tauri 的 Rust 壳 |
| **Rust 工具链**（可选） | Apache-2.0 / MIT | Mac2Win 在 `buildRustShell: true` 时编译 Rust 壳 |
| **LLVM / clang-cl**（可选） | Apache-2.0 with LLVM Exceptions | Mac2Win 编译 Rust 壳时的链接器 |
| **MSVC CRT 头文件与库**（可选） | 允许 cargo-xwin 的此种用法，但**不允许再分发** | Mac2Win 链接 MSVC 目标；不缓存不分发 |


### 6.3 打包时纳入产物的框架运行时

Mac2Win 在打包时会把目标框架的 **Windows x86 预编译运行时**纳入产物。这些运行时不随仓库分发，由构建流程从上游官方地址下载。完整的版权方、许可证与官方地址以 [`NOTICE`](./NOTICE) 第四章为准。

| 运行时 | 版本范围 | 许可证 | 用途 |
|---|---|---|---|
| **Node.js**（win-x86） | 20 / 22 LTS（默认 22.23.5） | MIT | 纯 Node 与多数框架的应用宿主 |
| **Electron**（win32-ia32） | ≤ 43.0.0 | MIT | Electron 应用宿主 |
| **NW.js**（win-ia32） | 按项目声明（默认 0.90.0） | MIT | NW.js 应用宿主 |
| **Tauri** | 不打包运行时 | MIT / Apache-2.0 | 产物为 Rust 编译的原生 exe，无需 JS 运行时 |


**Electron 的上限为什么是 43**：Electron 官方自 v44 起不再发布 `win32-ia32` 预编译包。mac2win 在预检阶段即拦截更高版本，不让用户在下载阶段才失败。实测依据见亮点九。

**再分发义务**：Node.js、Electron、NW.js 均为 MIT，要求再分发时保留原版权声明与许可文本。打出的安装包内应包含这些运行时的 `LICENSE` 文件，或在安装向导 / 关于页面中提供可访问的许可文本。

**网络依赖的体积**（首次打包需下载，之后从 `~/.wacmin/mac2win/cache/` 复用）：

| 运行时 | 压缩包体积 | 解包后载荷 |
|---|---|---|
| Node.js 22.23.5 win-x86 | 约 32 MB | 约 80 MB |
| Electron 43.0.0 win32-ia32 | 约 100 MB | 约 220 MB |
| NW.js 0.90.0 win-ia32 | 约 90 MB | 约 200 MB |
| Wine 11.21 osx64（ExeOnMac） | 约 225 MB | 约 600 MB |

### 6.4 间接依赖与传递依赖

**本项目自身不存在传递依赖**——仓库内七个模块（四个方向、`console`、`ai`、`contracts`）均不引入 npm / PyPI 包，因此没有「A 依赖 B、B 依赖 C」的链条。

**运行时层面存在间接依赖**，由上游构建方打包，本项目不拆分、不修改。逐项说明见 [`NOTICE`](./NOTICE) 第六章，此处不复述。需要提前知道的一点：Electron / NW.js / Node.js 内含 Chromium / V8 / libuv，Wine 内含 FreeType / libpng / MoltenVK，这些组件的许可证随上游包分发，本项目不修改它们。

### 6.5 本项目未使用的技术

**完整清单以 [`NOTICE`](./NOTICE) 第八章为唯一来源**，共 17 项，含「未使用 MCP 官方 SDK」「未调用任何 LLM 接口」「未使用任何第三方代码签名服务」等容易被误认的条目。

读者最常问的四件事，在此直接回答：

| 常被误认为用了 | 实际情况 |
|---|---|
| **npm / PyPI 第三方包** | 七个模块全部零依赖，PE 头解析、zip 读写、plist / Mach-O / CFB / MSI 解析、MIME 表、HTTP 服务、SSE 推送、YAML 子集读写、测试框架均为自研或用语言内置能力 |
| **YAML 库**（PyYAML / Yams） | 配方与 `compat.yaml` 走手写的受限子集序列化；Swift launcher 自带约 130 行受限解析器。只支持本项目实际用到的语法子集，不追求通用 |
| **WebSocket** | 进度是单向的（服务端 → 浏览器），用 SSE 即可，见 [5.8.4](#584-为什么用-sse-而不是-websocket) |
| **x86 模拟器 / 文件系统驱动 / kext** | 均未使用。ExeOnMac 靠 Wine 运行时，AppOnWin 计划经 WSL2 用 Darling，两者都跑在用户态 |

### 6.6 字体与图标

**结论：本仓库不含任何字体文件，也不含任何图标素材。** 逐项权责归属见 [`NOTICE`](./NOTICE) 第九章，此处只说三件最容易被误解的事：

- **ExeOnMac 会提取图标，但图标不进仓库**。提取对象是用户提供的 Windows 安装包，结果只写进该用户本地的 `.app`，不随本项目分发。
- **中文字体要用户自己放**。本项目不附带商业字体、不提供字体下载；用户若把微软雅黑、宋体放进共享层，许可责任在用户。注意这只是为了**让产物不依赖宿主字体**——中文在 base 上本来就能显示，`wineboot` 已把宿主的中文族字体（PingFang / Hiragino / Songti / Kaiti / Heiti 等，单段计 110 条）登记进注册表（[4.2.1](#421-层的自动构建五个层里三个能自动做两个不能)）。要让软件写死的「微软雅黑」正确显示，靠的是 `font_map` 而非字体文件。
- **Win2Mac 不生成图标是合法状态**。`--icon` 接受用户提供的 `.icns`，不给就不生成，产物仍可正常分发。

控制台与看板的全部视觉元素由 CSS 绘制，没有位图、没有 SVG 素材、没有 icon font。

---

## 七、安装与部署

### 7.1 前置条件

| 项目 | 要求 |
|---|---|
| Node.js | ≥ 20（Mac2Win / Win2Mac / AppOnWin / console） |
| Python | ≥ 3.11（ExeOnMac） |
| Swift | 6.0+，需 Xcode Command Line Tools（ExeOnMac 编译 launcher） |
| 操作系统 | 按方向区分，见第 14 章 |

本项目**不需要** `npm install` 或 `pip install`——无第三方包依赖。

**Node.js 的 `≥ 20` 是硬要求**，不是保守取值：`node:test` 的 `--test` 并发模型、`fetch` 的稳定实现、ESM 顶层 await 都在 20 才齐备。**Python 的 `≥ 3.11`** 是因为需要 `tomllib` 与 `X | Y` 类型语法。

### 7.2 获取外部工具

```bash
# macOS：Homebrew
brew install makensis sevenzip

# 可选：提升 Inno 与 MSI 的解包精度
brew install innoextract msitools

# Apple Silicon 必需：Rosetta 2
softwareupdate --install-rosetta --agree-to-license

# 若 macOS 上需要 Wine 运行时（ExeOnMac）
cd exeonmac && python3 -m wepack.cli runtime install
```

Windows 侧无外部工具硬依赖；Win2Mac 建议在 macOS 上验证一次产物。

**7-Zip 的备选来源**：若无法安装 Homebrew 版，mac2win 还会依次查找 `~/.wacmin/mac2win/bin/7zz`、MacPorts、PATH，以及 `/Applications/*.app/Contents/MacOS/` 下由其它应用内嵌的 7-Zip。也可用环境变量 `MAC2WIN_7ZIP` 显式指定；该变量指向的路径不可用时会明确报错，不会静默回退。

### 7.3 契约自检

```bash
node contracts/validate.mjs
```

### 7.4 各方向安装

本项目无需安装步骤，直接以源码方式运行。若要作为命令使用，各子项目的 `package.json` 已声明 `bin` 字段，可 `npm link` 后在全局使用；ExeOnMac 的 `wepack` 可通过 `pip install -e .` 安装到当前 Python 环境。

| 方向 | 直接运行 | 全局安装（可选） |
|---|---|---|
| Mac2Win | `node mac2win/bin/mac2win.mjs` | `cd mac2win && npm link` |
| ExeOnMac | `python3 -m wepack.cli`（在 `exeonmac/` 下） | `cd exeonmac && pip install -e .` |
| Win2Mac | `node win2mac/bin/win2mac.mjs` | `cd win2mac && npm link` |
| AppOnWin | `node apponwin/bin/apponwin.mjs` | `cd apponwin && npm link` |
| console | `node console/bin/wacmin-console.mjs` | `cd console && npm link` |

### 7.5 统一入口

```bash
node console/bin/wacmin-console.mjs list
```

### 7.6 卸载

| 方向 | 卸载方式 |
|---|---|
| 全部代码 | 删除仓库目录即可，不在系统任何位置留下文件 |
| ExeOnMac 产物 | 把 `.app` 拖到废纸篓，卸载即完成 |
| ExeOnMac 共享层 | `~/Library/Application Support/wexe/` 保留，可被其他包复用；彻底清理需手动删除，该操作不可逆 |
| Mac2Win 缓存 | `~/.wacmin/mac2win/cache/`，删除后下次构建重新下载 |
| console 历史 | `~/.wacmin/history.json` |
| ai 层 | 无需卸载，不写任何状态。若已把 MCP 配置注册进客户端，需从客户端的配置文件中移除对应条目 |

`wepack` 不提供 `uninstall` 子命令，也不主动删除任何包外文件。`wexe` 主目录的清理由用户手动执行。

---

## 八、快速开始

本项目零第三方包依赖，`git clone` 后即可直接运行，无需 `npm install` 或 `pip install`。

```bash
git clone https://github.com/ntars/Wacmin.git
cd Wacmin

# 1. 契约自检（验证共享层的退出码、错误码段位、报告结构是否自洽）
node contracts/validate.mjs

# 2. 查看四个方向的状态
node console/bin/wacmin-console.mjs list

# 3. 汇总各方向的环境自检（并行执行）
node console/bin/wacmin-console.mjs doctor

# 4. 检查四个方向是否遵守契约（会真实调用各方向的命令）
node console/bin/wacmin-console.mjs contract
```

### 8.1 在 macOS 上打一个 Windows 安装包

```bash
cd mac2win

# 先看环境是否齐备
node bin/mac2win.mjs doctor

# 只跑预检并打印计划，不下载不构建不落盘
node bin/mac2win.mjs build /path/to/your-app --dry-run

# 真实构建
node bin/mac2win.mjs build /path/to/your-app

# 或打开图形界面
node bin/mac2win.mjs ui /path/to/your-app
```

产物在 `<项目>/dist-mac2win/`，文件名形如 `你的应用-1.0.0-x86-setup.exe`。

**各种项目怎么打包**（框架自动识别，用 `--framework` 可强制指定）：

| 项目类型 | 命令 | 产物形态 |
|---|---|---|
| Electron | `node bin/mac2win.mjs build ./my-electron-app` | 真正的原生窗口，主程序改名为你的产品名 |
| NW.js | `node bin/mac2win.mjs build ./my-nwjs-app` | 原生窗口 |
| Tauri | `node bin/mac2win.mjs build ./my-tauri-app` | 默认浏览器界面；要原生窗口需 `buildRustShell: true` |
| 纯 Node 服务 / 静态站点 | `node bin/mac2win.mjs build ./my-server` | 内置静态服务 + 启动器，界面走浏览器 |

Tauri 要原生窗口需额外准备（约 1.5 GB）：

```bash
rustup target add i686-pc-windows-msvc
cargo install cargo-xwin
```

然后在 `mac2win.config.json` 里设 `"buildRustShell": true`。

**常用命令**：

```bash
# 只校验已有产物
node bin/mac2win.mjs verify ./dist-mac2win/我的应用-1.0.0-x86-setup.exe

# 图形界面
node bin/mac2win.mjs ui

# 保留中间产物排查
node bin/mac2win.mjs build ./app --keep-staging

# 指定输出目录
node bin/mac2win.mjs build ./app --out ./release

# 强制指定框架
node bin/mac2win.mjs build ./app --framework electron

# 跳过校验（不推荐）
node bin/mac2win.mjs build ./app --no-verify
```

**预检的输出长什么样**：

```
✓ 宿主操作系统：macOS 27.0.0（arm64）
✓ 宿主 CPU 架构：arm64（Apple Silicon）
✓ Node 版本：v22.22.2
✓ NSIS 编译器：v3.13（/opt/homebrew/bin/makensis）
✓ 项目目录：/path/to/project
✓ 项目框架：Tauri（高可信）：存在 src-tauri/ 目录
✓ 框架与架构组合：Tauri + x86 可行
! 原生窗口：不含 Rust 壳，界面将通过系统默认浏览器打开
✓ 宿主入口：/path/to/cordis-host/lib/index.js
✓ 前端产物：/path/to/dist
✓ 目标架构：x86（32 位，可在 32 位与 64 位 Windows 上运行）
```

`!` 是警告（能继续，但有降级），`✗` 是错误（会中止）。

**离线环境**：首次打包要下载运行时。离线时预先下载并指定：

```json
{
  "runtimeArchive": "/path/to/node-v22.23.5-win-x86.zip",
  "runtimeChecksum": "9c01245683c87e3f81eedfbad82c1665611749627cd1b0b5a42921db9361b4a6",
  "electronArchive": "/path/to/electron-v43.0.0-win32-ia32.zip"
}
```

下载过一次后缓存在 `~/.wacmin/mac2win/cache/`，后续不再下载。

**常见错误码速查**：

| 码 | 一句话 | 怎么办 |
|---|---|---|
| `M2W_2001` | 缺 makensis | `brew install makensis` |
| `M2W_3001` | 运行时下载失败 | 检查网络；或配 `runtimeArchive` 指向本地文件 |
| `M2W_4001` | 项目构建失败 | 先在终端手动跑一遍 `npm run build` |
| `M2W_4003` | 含原生模块 | 换纯 JS 替代包（错误信息里有具体包名） |
| `M2W_5002` | NSIS 编译失败 | 用 `--keep-staging` 保留脚本，手工跑 makensis |
| `M2W_6001` | 产物校验不通过 | **不要分发**。日志里有逐项结果 |

### 8.2 在 macOS 上封装一个 Windows 安装包为 .app

```bash
cd exeonmac

# ① 环境自检
python3 -m wepack.cli doctor

# ② 识别安装包
python3 -m wepack.cli detect ~/Downloads/setup.exe

# ③ 静态解包（可选，用于确认主程序）
python3 -m wepack.cli extract ~/Downloads/setup.exe -o /tmp/out

# ④ 安装并产出 .app
python3 -m wepack.cli install ~/Downloads/setup.exe -o "~/Applications/MyApp (Win).app"

# ⑤ 查看结果（引号里的 ~ 不会被 shell 展开，因此这里写 $HOME）
open "$HOME/Applications/MyApp (Win).app"
```

`install` 的 `-o` 由 wepack 自己 `expanduser()`，所以上面 ④ 的 `"~/Applications/..."` 能被正确解析；但 `open` 是 shell 内建之外的独立进程，引号里的 `~` 原样传过去，实测报 `~/Applications/... does not exist`。

`install` 命令完成后会输出：

```
应用包    /Users/u/Applications/MyApp (Win).app
类型      nsis
安装目录  drive_c/Wacmin/MyApp
退出码    0（耗时 131.7s）
磁盘占用  逻辑 2.4 GB / 实际 2.4 GB
入口程序  drive_c/Wacmin/MyApp/MyApp.exe
安装日志  .../Contents/Recipes/install.log
```

**首次使用需要先装 Wine 运行时**（三选一）：

```bash
# 从 GitHub 下载（约 225 MB）
python3 -m wepack.cli runtime install

# 从已安装的 CrossOver / Whisky 复制，不联网
python3 -m wepack.cli runtime install --from-vendor

# 用本地压缩包
python3 -m wepack.cli runtime install --archive /path/to/wine-devel-11.21-osx64.tar.xz

# 查看状态
python3 -m wepack.cli runtime status
```

base 层与 launcher 只需构建一次：

```bash
python3 -m wepack.cli layers build base   # 之后所有应用包复用
sh launcher/build.sh                      # 编译 launcher
```

### 8.3 在 Windows 上打一个 macOS 应用包

```powershell
cd win2mac
node bin\win2mac.mjs build C:\path\to\app --executable .\MyApp --out .\dist
```

常用参数：

```powershell
node bin\win2mac.mjs build .\app `
  --name "我的应用" `
  --version 1.0.0 `
  --bundle-id com.example.myapp `
  --executable .\MyApp `
  --icon .\icon.icns `
  --associate .myext `
  --min-macos 13.0
```

在非 Windows 宿主上运行会输出警告但不中止；加 `--strict-host` 强制拒绝。

### 8.4 评估一个 macOS 应用能否在 Windows 上跑

```bash
# 结构与框架解析（任何平台都能跑）
node apponwin/bin/apponwin.mjs assess /path/to/MyApp.app
node apponwin/bin/apponwin.mjs parse /path/to/MyApp.app

# 可行性验证（需 Windows + WSL2 + Darling，环境不具备时报 blocked）
node apponwin/bin/apponwin.mjs spike
```

### 8.5 通过统一入口驱动任一方向

```bash
node console/bin/wacmin-console.mjs run mac2win build ../myapp --dry-run
node console/bin/wacmin-console.mjs run exeonmac version
node console/bin/wacmin-console.mjs web 7777   # 启动 Web 看板，只绑 127.0.0.1
```

### 8.6 交给 AI 调用

三种用法，按「你在哪」选一种。

**在终端里**（`wacmin` 默认输出 JSON，方便脚本与 agent 解析；加 `--human` 才人类可读）：

```bash
node ai/bin/wacmin.mjs list                          # 四个方向各支持什么
node ai/bin/wacmin.mjs status --human                # 谁装了、谁没装
node ai/bin/wacmin.mjs doctor mac2win                # 缺什么工具、怎么装
node ai/bin/wacmin.mjs run apponwin assess /Applications/X.app
node ai/bin/wacmin.mjs contract                      # 四方向契约合规检查
```

退出码严格透传：`wacmin run exeonmac doctor` 返回 5，`wacmin` 也返回 5。脚本不必解析 JSON 就能判断成败。

**在支持 MCP 的客户端里**（Claude Desktop、WorkBuddy、Cline 等），把 `ai/bin/wacmin-mcp.mjs` 注册为 stdio 服务：

```json
{
  "mcpServers": {
    "wacmin": {
      "command": "node",
      "args": ["/绝对路径/Wacmin/ai/bin/wacmin-mcp.mjs"]
    }
  }
}
```

`node ai/bin/wacmin.mjs mcp` 会直接打印本机可用的配置片段（路径已填好）。若客户端找不到 `node`，把 `command` 改成 `which node` 的输出。注册后客户端能看到六个工具，agent 自己决定何时调用。

**在 agent 的提示词里**：`ai/skills/wacmin/SKILL.md` 是给 agent 看的判别依据（何时该用本仓库、四个方向怎么选），`ai/experts/wacmin-expert.md` 是需要判断准则而非操作步骤时用的专家画像。

---

## 九、配置说明

配置分三层：**契约文件**（四个方向共用，不可按方向改写）、**方向配置文件**（各方向自己的项目级配置）、**环境变量**（部署期覆盖）。

### 9.1 契约文件

这三个文件是四个方向的共同语言。改动它们等于改动所有方向的对外行为。

| 文件 | 内容 | 改动规则 |
|---|---|---|
| `contracts/exit-codes.json` | 九种退出码的语义与每个码允许的错误码段 | **只追加，不改含义**。已发布的码值一旦改动，所有依赖它的脚本都会失效 |
| `contracts/error-prefixes.json` | 四个方向的错误码前缀（`M2W` / `EOM` / `AOW` / `W2M`）与九段位分配 | 段位不可越界；新增方向须先在此登记前缀。`WAC`、`CNT` 保留 |
| `contracts/run-report.schema.json` | `--report` / `--json` 的输出结构 | 破坏性变更须升 `schemaVersion`，`console` 据此分支 |

`contracts/validate.mjs` 是这三个文件的自检器，同时校验契约本身与单份报告：

| 类别 | 内容 |
|---|---|
| 契约自洽 | 退出码覆盖必备码值（0/1/2/130）、含义不重复、引用的错误码落在已定义段位；前缀四位齐全、互不重复、不占用保留前缀；每个段位的 `range` 都能解析回自身 |
| 报告结构 | 按 `run-report.schema.json` **递归**校验：必填字段、类型、枚举、格式、范围，以及**每一层**的 `additionalProperties: false` |
| 跨字段不变量 | `ok === (exitCode === 0)`；`ok=false` 必带 `error` 且 `ok=true` 时 `error` 必须为 `null`；`stages` 失败后不得再有 `ok` 阶段；错误码前缀属本方向、段位存在、且**与退出码配对** |

**校验器自身的测试**：`contracts/validate.test.mjs`。这个脚本是 CI 里「契约是否被遵守」的唯一权威，但它曾长期没有测试，于是两处失明一直存在：

1. **`additionalProperties: false` 从未被执行** —— schema 里每层都写着这句，脚本只比对顶层 `required`。报告里塞 `{"这个字段不该存在": 123}` 照样报「✓ 契约自洽」。
2. **段位按码值首字符推桶** —— `9999`（内部错误，独立段位）与 `9998`（属 `9000` 段，`range` 为 `9001-9998`）首位都是 9，全被推成 `9000`。后果是 `9999` 段的定义**永远命中不了**：把它从 `error-prefixes.json` 里整个删掉，校验仍全绿。

段位归属现在一律按 `error-prefixes.json` 的 `range` 实际区间判断（`segmentOf()`），两处调用共用同一实现。

**两个校验器的分工与一致性**：`contracts/validate.mjs` 离线跑单份报告，`console/src/contract-check.mjs` 真起四个方向的子进程读运行时输出。两者对**同一份报告必须给出相同结论** —— 这一条由 `console/test/contract-consistency.test.mjs`（17 个样本）守着，正是它先抓出了三处分叉：嵌套层多余字段、`ok=true` 却带 `error`、`direction` 不在枚举内（原先只有「与调用方一致」那一条，两者一起写错时就都放行了）。

```bash
# 契约自检
node contracts/validate.mjs

# 校验一份报告；--exit-code 额外比对真实进程退出码
node contracts/validate.mjs --report /tmp/report.json --exit-code 0
```

### 9.2 Mac2Win 配置文件

在项目根目录放 `mac2win.config.json`（或 `mac2win.json`，按此顺序取第一个存在的）。两个文件名等价，同时存在时以 `mac2win.config.json` 为准。

```json
{
  "productName": "空谷 Ondra",
  "version": "1.0.0",
  "publisher": "Ntarstudio",
  "target": "x86",
  "format": "nsis",
  "entry": "main.js",
  "frontendDist": "dist",
  "runtimeVersion": "22.23.5",
  "compression": "lzma",
  "desktopShortcut": true,
  "requireAdmin": false,
  "alsoZip": false,
  "verify": true
}
```

**全部 32 个可配置项**：

| 键 | 默认值 | 说明 |
|---|---|---|
| `framework` | `"auto"` | `auto` / `electron` / `nwjs` / `tauri` / `node` / `static`。`auto` 按 `package.json` 依赖与目录结构判定 |
| `target` | `"x86"` | `x86` / `x64`。`x86` 是项目的主要目标，`x64` 亦支持 |
| `format` | `"nsis"` | `nsis` / `zip` |
| `productName` | 从 `package.json` 推断 | 安装包显示名与产物文件名 |
| `version` | 从 `package.json` 推断 | 三段式版本号 |
| `publisher` | 从 `package.json` 的 `author` 推断 | 发布者，写入安装向导 |
| `identifier` | `null` | 应用标识，用于注册表卸载项 |
| `frontendDist` | 自动探测 `dist` / `build` / `out` / `.output/public` | 前端产物目录（相对项目根）。须含 `index.html` 才被采纳 |
| `entry` | 从 `package.json` 的 `bin` / `main` 推断 | 宿主入口脚本（相对项目根） |
| `resources` | `[]` | 额外随产物分发的文件或目录 |
| `buildCommand` | 有 `scripts.build` 时推断为 `npm run build` | 打包前执行的项目构建命令 |
| `preflightCommands` | `[]` | 预检阶段执行的命令，用于提前暴露环境问题 |
| `launcherExe` | `"node.exe"` | 启动器文件名，须为 `.exe` |
| `launcherArgs` | `["{entry}"]` | 启动参数，`{entry}` 会被替换为入口路径 |
| `env` | `{}` | 注入到目标应用的环境变量 |
| `dataEnv` | `null` | 指定一个环境变量名，其值作为应用数据目录 |
| `runtimeVersion` | `"22.23.5"` | Node.js 运行时版本 |
| `runtimeArchive` | `null` | 本地运行时文件（`node.exe` 或 `win-x86` zip），离线环境用 |
| `runtimeChecksum` | `null` | 与 `runtimeArchive` 配套的期望 SHA-256 |
| `electronVersion` | `"43.0.0"` | Electron 版本，**x86 目标须 ≤ 43** |
| `electronArchive` | `null` | 本地 Electron zip，离线环境用 |
| `nwjsVersion` | `"0.90.0"` | NW.js 版本 |
| `nwjsFlavor` | `"normal"` | NW.js 发行形态 |
| `nwjsArchive` | `null` | 本地 NW.js zip |
| `buildRustShell` | `false` | 是否为 Tauri 项目交叉编译 Rust 壳 |
| `tauriDir` | `null` | Tauri 的 `src-tauri` 目录路径 |
| `rustProfile` | `"release"` | Rust 编译 profile |
| `iconFile` | `null` | 安装包图标，须为 `.ico` |
| `licenseFile` | `null` | 安装向导展示的许可文件 |
| `outDir` | `"dist-mac2win"` | 输出目录（相对项目根，或绝对路径） |
| `artifactName` | `null` | 产物文件名。留空按产品名与版本自动生成 |
| `verify` | `true` | 构建后是否做完整校验。**关掉只跳过校验，不跳过安全检查** |
| `alsoZip` | `false` | 除安装包外额外生成免安装 zip |
| `compression` | `"lzma"` | `lzma` / `zlib` / `bzip2` / `none` |
| `desktopShortcut` | `true` | 是否创建桌面快捷方式 |
| `requireAdmin` | `false` | 安装是否需要管理员权限 |
| `keepStaging` | `false` | 保留中间 staging 目录，排查问题时打开 |

**配置合并顺序**（后者覆盖前者）：

```
内置默认值 → package.json 推断 → 框架推断 → 配置文件 → 命令行参数
```

**框架识别必须排在配置合并之前**，因为它决定 `entry` 与 `frontendDist` 的默认值从哪来，而这些默认值又要能被用户配置覆盖。顺序反了会导致两种情况：用户显式配置被框架推断覆盖，或框架推断完全不生效。

**配置校验在第 4 步之后统一执行**，一次性报出全部问题而不是遇到第一个就退出：

| 校验项 | 不通过时的表现 |
|---|---|
| `target` 不在允许集合内 | 报错并列出可选值 |
| `format` 不在允许集合内 | 同上 |
| `compression` 不在允许集合内 | 同上 |
| `verify` / `alsoZip` 不是布尔值 | 报错 |
| `format` 已是 `zip` 还设 `alsoZip: true` | 报「没有意义」并给出两种正确写法 |
| `version` 不是三段式 | 报错，提示至少写成 `1.0.0` |
| `entry` 与 `frontendDist` 同时为空 | 报「没有可打包的内容」 |
| `launcherExe` 不是 `.exe` | 报「Windows 的启动器只能是 PE 格式的 .exe」 |

**为什么校验要一次报全**：配置文件一次只能改一处，如果每次运行只报一个问题，用户要跑五六轮才能改完。合并后统一校验，一轮就能改完。

### 9.3 环境变量

| 变量 | 适用方向 | 默认值 | 作用 |
|---|---|---|---|
| `MAC2WIN_CACHE` | Mac2Win | `~/.wacmin/mac2win/cache` | 运行时缓存目录。跨项目复用，不必每次重下 |
| `MAC2WIN_7ZIP` | Mac2Win | 自动查找 | 显式指定 7-Zip 路径。**指向不可用时明确报错，不静默回退**（见 5.3.3） |
| `MAC2WIN_NO_7ZIP` | Mac2Win | 未设置 | 设为 `1` 时强制视为「没有 7-Zip」，用于验证「校验未完成」分支 |
| `MAC2WIN_MAKENSIS` | Mac2Win | 自动查找 | 显式指定 `makensis` 路径 |
| `MAC2WIN_NODE_BASE` | Mac2Win | `https://nodejs.org/dist` | Node.js 运行时下载基址。网络受限时可指向内网镜像 |
| `WACMIN_HOME` | console | `~/.wacmin` | 看板历史落盘目录。测试与多实例隔离用，避免污染真实历史 |
| `WACMIN_PORT` | console | `0`（随机） | Web 看板的默认端口 |
| `WACMIN_TIMEOUT_MS` | console | `1800000`（30 分钟） | 单次子进程调用的超时。`0` 表示不限 |
| `WEXE_HOME` | ExeOnMac | `~/Library/Application Support/wexe` | 运行时、prefix、共享层的根目录 |
| `WEXE_RECIPES` | ExeOnMac | `~/.wexe/recipes` | 配方库目录 |
| `WEXE_7Z` | ExeOnMac | 从 PATH 探测 | 指定 7-Zip 二进制路径 |
| `WEXE_INNOEXTRACT` | ExeOnMac | 从 PATH 探测 | 指定 innoextract 路径 |
| `WEXE_MSIEXTRACT` | ExeOnMac | 从 PATH 探测 | 指定 msiextract 路径 |

**`MAC2WIN_CACHE` 为什么按架构分开存**：`x86` 与 `x64` 的 `node.exe` 是两个不同的文件。放在同一目录会互相覆盖，最终得到「标称 x64 实际 x86」的产物——而这个错误只有在产物校验时才暴露。缓存目录名带架构标签（`node-22.23.5-win-x86` / `node-22.23.5-win-x64`），从根上避免。

**`WEXE_HOME` 在测试中被大量使用**——把共享层指向临时目录即可完全隔离，不触碰真实用户目录。

**`MAC2WIN_NO_7ZIP=1` 是为「校验未完成」分支留的逃生门**。不是为凑覆盖率：缺 7-Zip 的决定性分支只在**用户机器恰好没装**时才会走到，开发者机器上大概率装了，可能一年没人跑过——真踩到时用户得到的就是一份撒了谎的报告。

### 9.4 ExeOnMac 目录与配置

**共享层目录**（`WEXE_HOME` 可整体重定向）：

```
~/Library/Application Support/wexe/
├── layers/
│   ├── base/            # Windows 骨架（已含全套 VC++ / ATL）
│   ├── vcpp/            # VC++ 运行库（可选，仅用于覆盖成微软原版）
│   ├── mfc/             # MFC 运行库（base 不含，需用户提供）
│   ├── dotnet/          # .NET Framework（需用户提供）
│   └── fonts-cn/        # 固化用户字体，脱离宿主依赖（中文渲染本身不缺口）
├── runtime/
│   └── wine/            # Wine 运行时（x86_64）
└── logs/
```

**包内配置**（`compat.yaml`）：位于 `{App} (Win).app/Contents/Recipes/compat.yaml`，是该包的唯一事实来源。完整字段定义见 `exeonmac/schema/compat.schema.json`。

```yaml
app: 微信
version: "3.9.10"
entry: drive_c/Program Files/Tencent/WeChat/WeChat.exe
installer:
  type: nsis
  silent_args: " /S"
  completed: true
  fallback_interactive: false
layers:
  - base
  - vcpp
  - fonts-cn
font_map:
  微软雅黑: PingFang SC
  宋体: Songti SC
file_associations: []
known_issues: []
bundle_id: com.wexe.win.tencent.wechat
icon_source: exe:drive_c/Program Files/Tencent/WeChat/WeChat.exe#0
```

字段语义的补充约定：

1. **`entry` 必须相对 `Contents/Resources/Private/`**，以 `drive_c/` 开头，用正斜杠。不用 `C:\` 形式，不用绝对路径。
2. **`layers[0]` 必须是 `base`**。顺序即挂载顺序，后面的层覆盖前面的同名文件。代码里有硬校验。
3. **`silent_args` 保留前导空格**（如 `" /S"`）。NSIS 的 `/S` 与路径参数拼接时靠这个空格分隔。
4. **`font_map` 的键是 Windows 字体名**，值是 macOS 字体名。launcher 启动前生成 `fontsub.reg` 并 `wine regedit /S` 导入。
5. **`file_associations` 默认空**。非空时元素形如 `.7z`，wepack 据此生成 `CFBundleDocumentTypes`。
6. **`known_issues` 是人类可读的一句话**，不是错误码。UI 直接展示。

**配方库**（`~/.wexe/recipes/<key>.yaml`），缓存「这个安装包装出来是什么样」。

**键 = 安装包 SHA-256 前 16 位**。用内容而非文件名，是因为用户重新下载常会得到 `setup (1).exe`；用内容算键，同一份文件无论叫什么名字都能命中。

配方里存的是**入口程序与依赖层**——这两项是装完之后探测出来的，探测本身是启发式的（打分选主程序、扫导入表匹配层）。缓存它们有两个好处：

| 好处 | 说明 |
|---|---|
| 快 | 省掉入口扫描（约 10ms）与层匹配（约 24ms），33 MB 安装包的哈希只需 20ms |
| 稳 | 多主程序目录下，重新扫描理论上可能选中不同的 exe；配方锁定上次的结果 |

管理命令：

```bash
wepack recipe list                    # 列出本地配方
wepack recipe show <key|安装包路径>    # 查看某条配方
wepack recipe save <app>              # 从已打包的 .app 导出配方
wepack recipe rm <key>                # 删除配方（移到废纸篓，可恢复）
```

`--no-recipe` 可完全绕过配方库（既不读也不写），用于排查「是不是配方缓存导致的怪问题」。

**静默参数表**：

| 安装器 | 参数 | 备注 |
|---|---|---|
| NSIS | `/S /D=C:\Wacmin\AppName` | `/D` 必须最后且**不加引号**；路径不能含空格（见 5.6.1） |
| Inno Setup | `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR=C:\...` | `/DIR=` **也不加引号** —— wine 会代劳，自己加反而被转义 |
| InstallShield | `/s /v/qn` | 不能写成 `/v" /qn"`，字面引号会被 wine 转义 |
| MSI | `msiexec /i pkg.msi /qn /norestart` | |
| WiX Burn | `/quiet /install /norestart` | |
| Squirrel | `--silent` | 不认目录参数，固定装到 `%LOCALAPPDATA%\<AppName>` |

用 `--silent-args` 可覆盖内置参数。

### 9.5 Win2Mac / AppOnWin 配置

这两个方向目前只接受命令行参数，不读配置文件。

- **Win2Mac**：`--name` / `--version` / `--executable` / `--payload` / `--icon` / `--bundle-id` / `--vendor` / `--associate` / `--min-macos` / `--category` / `--strict-host` 等，完整列表见 `node win2mac/bin/win2mac.mjs build --help`。
- **AppOnWin**：`--sample` / `--app` 用于 `spike`，`assess` 与 `parse` 只接受一个 `.app` 路径。

**为什么这两个方向不做配置文件**：它们的参数规模不足以撑起一个配置文件，引入配置文件只会增加「配置与命令行谁优先」的解释成本。

---

## 十、API 与模块说明

本项目对外有三种接口：**命令行**（四个方向各一套，通过契约统一）、**本地 HTTP 接口**（每个方向的图形界面）、**MCP 工具**（供 AI 客户端调用）。对外没有 SDK，模块层面的 API 属于内部实现，此处列出职责边界以便定位问题。

三种接口都是同一层的不同外壳：它们最终都调用 `console/src/directions.mjs` 起子进程，没有一条路径绕过契约。

### 10.1 命令行接口

四个方向的子命令与退出码遵循同一套契约。

| 方向 | 命令 | 子命令 |
|---|---|---|
| Mac2Win | `mac2win` | `build` / `verify` / `ui` / `doctor` |
| ExeOnMac | `wepack` | `detect` / `extract` / `install` / `package` / `build` / `layers` / `recipe` / `runtime` / `doctor` / `version` |
| Win2Mac | `win2mac` | `build` / `verify` / `doctor` |
| AppOnWin | `apponwin` | `assess` / `parse` / `spike` / `doctor` |
| 统一入口 | `wacmin-console` | `list` / `run` / `doctor` / `contract` / `web` |
| AI 统一入口 | `wacmin` | `list` / `status` / `run` / `doctor` / `contract` / `mcp` / `skill` |

**通用选项**（四个方向一致）：`--json` 输出机器可读结果、`--report` 输出统一运行报告、`--verbose` 输出调试级日志、`-h/--help`、`--version` 输出版本。

**`-v` 的语义在四个方向上并不一致，这一条不能当成通用选项**：`mac2win` / `win2mac` / `apponwin` 的 `-v` 是 `--version` 的短名，`wepack` 的 `-v` 是 `--verbose` 的短名（`--version` 只有长名，且是顶层参数，不能跟在子命令后）。所以脚本里要取版本请统一写 `--version`；写 `-v` 时在 `wepack` 上会打开调试日志、在其余三个上会打印版本号。这条差异来自各自解析器（Node 侧手写 argv vs Python 的 `argparse`），本文件不强行统一，只要求**别用 `-v` 取版本**。

**`--json` 与 `--report` 的关系**：`--report` 的输出即 `contracts/run-report.schema.json` 定义的结构；`--json` 在部分方向上是它的别名或子集。两者的共同约束是 **stdout 只有 JSON，日志一律走 stderr**，因此管道可以直接把 stdout 交给 `jq`。

**`apponwin spike` 的退出码有四档，比通用四档多一档退出码 2 的输入错误分支**：

| 退出码 | 触发条件 | 配对错误码 |
|---|---|---|
| 0 | 三条门槛全部 `pass`（`accepted`） | — |
| 1 | 至少一条门槛 `fail`（`rejected`，方向不成立） | `AOW_9999` |
| 2 | `--sample` / `--app` 指向不存在的路径（门槛未执行，`inputErrors` 非空） | `AOW_1002` |
| 5 | 环境不具备导致 `blocked`（`unverified`） | `AOW_2001` |

`2` 与 `5` 必须分开：前者是用户改一个路径就能继续，后者是得换机器。混成同一码会让 CI 把「路径打错」记成「缺依赖」，进而触发一次毫无意义的 WSL2 安装。

**ExeOnMac 的失败输出格式**：

```json
{
  "ok": false,
  "error": "文件不存在：/tmp/x.exe",
  "hint": null,
  "exit_code": 2
}
```

`ok` 等价于 `supported`。`unsupported_reason` 非 null 时退出码为 4。

### 10.2 统一运行报告

`--report` 输出的结构由 `contracts/run-report.schema.json` 定义，`additionalProperties: false`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | integer，固定 `1` | 格式版本。破坏性变更时递增，`console` 据此分支 |
| `direction` | enum | `mac2win` / `exeonmac` / `apponwin` / `win2mac` |
| `ok` | boolean | 整体是否成功，等价于 `exitCode === 0` |
| `exitCode` | integer | 进程退出码，见 `exit-codes.json` |
| `command` | string | 实际执行的子命令 |
| `startedAt` / `finishedAt` | date-time | 起止时间 |
| `durationMs` | integer | 耗时 |
| `host` | object | 宿主快照：`platform`、`arch`（必需），`osVersion`、`toolVersion`（可选） |
| `input` | object | 输入物识别结果：`path`、`kind`、`confidence`、`evidence[]`、`supported`、`unsupportedReason` |
| `stages[]` | array | 分阶段记录，每项含 `id`、`name`、`status`（`pending`/`running`/`ok`/`failed`/`skipped`）、`durationMs`、`message`、`errorCode` |
| `artifacts[]` | array | 产物清单，每项含 `path`、`kind`、`bytes`（必需），`sha256`、`target`（可选） |
| `checks[]` | array | 产物校验项，每项含 `name`、`passed`（必需），`detail`、`severity`（可选，枚举 `required` / `advisory`） |
| `warnings[]` | string[] | 不影响成功但用户需要知道的事，如降级、精度损失 |
| `error` | object \| null | 失败详情：`code`（须匹配 `^[A-Z0-9]{2,4}_[0-9]{4}$`）、`message`（必需），`hint`、`details[]`（可选）。成功时为 `null` |

**`checks[].passed` 是布尔值，不是 `ok`**。这一点踩过坑：内部对象用 `{name, ok, detail}` 表达，直接序列化出去后契约校验报「缺少布尔型 `passed` 字段（实际键：name, ok, detail）」。因为 `additionalProperties: false`，多出来的 `ok` 也不合法。**修法是加一层字段映射，而不是改变内部命名**——内部代码语义更自然，对外契约更稳定，两者各守一边。

**`artifacts[].path` 必须是非空字符串**。这条要求抓出过一个 `undefined !== null` 的缺陷，详见 5.3.4。

**`stages` 失败即停**。失败后不应有后续阶段，因此在报告里看到 `failed` 之后再出现 `running`，本身就说明实现有问题。

### 10.3 各方向的阶段划分

以 Mac2Win 为例，`build` 的八个阶段及其权重（权重用于计算总进度百分比）：

| # | `id` | 名称 | 权重 |
|---|---|---|---|
| 1 | `preflight` | 预检 | 1 |
| 2 | `project-build` | 项目构建 | 3 |
| 3 | `runtime` | 准备运行时 | 4 |
| 4 | `collect` | 收集依赖 | 2 |
| 5 | `stage` | 暂存文件 | 4 |
| 6 | `manifest` | 生成清单 | 2 |
| 7 | `package` | 打包安装包 | 5 |
| 8 | `verify` | 校验产物 | 3 |

**权重为什么不平均**：进度条若按阶段数平均，打包（占总耗时一半以上）只占 1/8，用户会看到进度条卡在 87% 不动。按预期耗时加权后，进度曲线与实际耗时大致同形。

**ExeOnMac 的八阶段**（与 `wepack/report.py` 的 `STAGES` 逐一对应）：`preflight` → `detect` → `extract` → `prefix` → `install` → `scan` → `package` → `verify`。与 Mac2Win 的八阶段同构，区别在于第 2 步识别的是安装器而非项目、第 4 步建的是 Wine prefix 而非准备 Node 运行时。

**同一子命令不跑全部八阶段，其余阶段标 `skipped`**。`detect` 只跑 `preflight` 与 `detect`；`extract` 跑到 `extract` 为止（install 之后的阶段与它无关）；`install` 跳过 `extract`（安装不需要先解包）与 `package` / `verify`；`package` 跳过前六个，只跑 `package` 与 `verify`。报告里不出现「全灰」的假象，也不把没跑的阶段算进耗时。

### 10.4 本地 HTTP 接口

两个图形界面各起一个本地服务，**只绑 `127.0.0.1`**。

**Mac2Win 控制台**（`mac2win ui`）：

| 端点 | 方法 | 作用 |
|---|---|---|
| `/api/state` | GET | 当前状态快照 |
| `/api/preflight` | POST | 跑预检，不构建 |
| `/api/build` | POST | 启动构建 |
| `/api/cancel` | POST | 取消正在进行的构建 |
| `/api/verify` | POST | 校验指定产物 |
| `/api/probe` | POST | 探测项目目录的框架与入口 |
| `/api/reveal` | POST | 在文件管理器中定位产物 |
| `/api/events` | GET | SSE 事件流：进度、日志、完成 |

**Console 看板**（`wacmin-console web`）：

| 端点 | 方法 | 作用 |
|---|---|---|
| `/api/history` | GET | 最近 20 次运行记录 |
| `/api/status` | GET | 四个方向的可用状态 |
| `/api/contract` | GET | 契约检查结果 |
| `/api/run` | POST | 触发某个方向的某个子命令 |

**为什么用 SSE 而不是 WebSocket**：进度是单向的（服务端 → 浏览器），SSE 足够，且原生 `EventSource` 支持、走普通 HTTP、断线自动重连。WebSocket 在这里只增加握手与心跳的复杂度。

### 10.5 内部模块边界

模块 API 不在对外承诺范围内，但了解职责划分有助于定位问题。

**Mac2Win**（`mac2win/src/`）：

| 模块 | 职责 |
|---|---|
| `core/config.mjs` | 配置读取、框架推断、校验、归一化 |
| `core/preflight.mjs` | 宿主、架构、外部工具预检 |
| `core/frameworks.mjs` | 框架识别（Electron / NW.js / Tauri / Node / static） |
| `core/runtime.mjs` | Node 运行时下载、缓存、架构断言 |
| `core/electron.mjs`、`core/nwjs.mjs` | 各自框架的运行时获取与装配 |
| `core/rust-shell.mjs` | Tauri Rust 壳的 cargo-xwin 编译 |
| `core/collector.mjs` | 从入口走 require 图，拦截原生模块 |
| `core/stager.mjs` | 按框架摆目录，注入兼容垫片 |
| `core/nsis.mjs` | 生成 NSIS 脚本并编译 |
| `core/zip.mjs`、`core/zipwriter.mjs` | zip 读取（含路径穿越防护）与写入（含 Unix 权限位） |
| `core/builder.mjs` | 编排八个阶段，串起全部流程 |
| `core/report.mjs` | 阶段跟踪与报告生成 |
| `core/errors.mjs` | 错误码定义与退出码映射 |
| `verify/pe.mjs` | PE/COFF 头解析 |
| `verify/artifact.mjs` | 产物三态校验 |
| `server/app.mjs` | 控制台 HTTP 服务 |
| `launcher/bootstrap.mjs` | 产物内的启动器（静态服务 + 路径穿越防护） |

**Win2Mac**（`win2mac/src/`）：`core/bundle.mjs`（`.app` 目录装配）、`core/plist.mjs`（`Info.plist` 生成）、`core/wexezip.mjs`（保留 Unix mode 的 zip 写入器）、`core/verify.mjs`（产物校验）、`core/builder.mjs`（编排）、`core/report.mjs`、`core/errors.mjs`。

**AppOnWin**（`apponwin/src/core/`）：`macho.mjs`（Mach-O 头解析）、`plist.mjs`（`Info.plist` 解析）、`assess.mjs`（框架判定与可移植性评估）、`spike.mjs`（三条门槛验证）、`report.mjs`、`errors.mjs`。

**ExeOnMac**（`exeonmac/wepack/`）：

| 包 | 职责 |
|---|---|
| `cli.py` | 全部子命令入口、参数解析、doctor |
| `pe.py` | PE 解析：头、节区、资源树、导入表、版本资源 |
| `tools.py` | 外部工具定位与冒烟测试 |
| `runtime.py` | Wine 运行时下载、解压、架构校验 |
| `detect/` | 安装器识别，含 `cfb.py`（复合文档）、`msi_tables.py`（MSI 表解析） |
| `extract/` | 静态解包与主 exe 候选排序（`candidates.py`） |
| `prefix/` | Wine prefix 创建、clonefile、校验、空间统计 |
| `install/` | 静默安装编排、重启拦截、进程清理 |
| `layers/` | 层构建、校验、挂载、导入表匹配（`match.py`） |
| `package/` | `.app` 装配、`Info.plist`、图标合成、Swift launcher 编译、产物校验 |
| `recipes/` | compat.yaml 读写 + 配方库 |
| `models.py` | 跨阶段数据模型 |
| `errors.py` | 错误类型与退出码 |
| `paths.py` | 全局路径解析（唯一允许写状态的地方） |
| `log.py` | 日志（stderr + 可选落盘） |

**模块划分对应流程阶段，不按技术层切**。`detect/` 只做识别，`extract/` 只做解包，两者不互相调用对方的内部函数，只通过 `models.Detection` / `models.ExtractResult` 通信。

**Console**（`console/src/`）：`directions.mjs`（四个方向的调度能力：起点、子命令、产出、`runDirection` 的进程管理与取消）、`server.mjs`（本地服务、SSE、历史落盘）、`contract-check.mjs`（四方向契约合规检查，含反向探针）。

**`directions.mjs` 是「能力」，`bin/wacmin-console.mjs` 是「入口」**。两者分开的直接原因是 AI 层也要调度这四个方向，而入口文件被 `import` 时会解析 argv、打印用法、设置 `process.exitCode`——`console` 自己不读 stdout 所以长期没暴露，但 MCP 规范要求 `stdout` 只出现协议消息，同一写法在 MCP 上是致命的。拆分后入口文件加了 `isDirectRun()` 守卫（`realpathSync` 比对，不做字符串比较，否则软链与 `./` 前缀会漏判），被 `import` 时零副作用。

**AI 接入层**（`ai/src/`）：

| 模块 | 职责 |
|---|---|
| `protocol.mjs` | JSON-RPC 编解码、换行分帧、错误码常量。纯函数，不碰进程 |
| `tools.mjs` | 六个工具的定义（名称、描述、JSON Schema、注解）与参数到 argv 的翻译 |
| `server.mjs` | 握手与版本协商、`tools/list`、`tools/call` 分派、`notifications/cancelled` 取消 |

**三层的分界线是「有没有副作用」**：`protocol.mjs` 可以在任意上下文里跑；`tools.mjs` 只做纯转换，不发命令；只有 `server.mjs` 接触 stdin / stdout 与子进程。因此协议层的测试不需要起进程，工具层的测试不需要真实构建。

**为什么参数翻译层要单独存在而不是把 argv 直接暴露给 agent**：字段名与命令行的位置参数不是一一对应的——`mac2win` / `win2mac` 的起点字段叫 `project`，`exeonmac` 叫 `installer`（它没有「项目」概念，只有安装包）。若让 agent 自己拼命令行，它会把 `project` 照抄给 `exeonmac`，命令变成 `wepack build -o /tmp/o`，argparse 报「缺少 installer」——**报错指向参数缺失，真因在翻译层漏字段**。翻译层把这层映射收在一处，agent 只需要说清楚「哪个方向、起点是什么、产物放哪」。

### 10.6 MCP 工具契约

传输层按 MCP 2025-06-18 的 stdio 方式实现：**换行分隔的 JSON-RPC**，不是 LSP 的 `Content-Length:` 分帧。`stdout` 只允许出现协议消息，任何日志必须走 `stderr`——这不是洁癖，`stdout` 里多一行非协议文本，客户端解析器会当场断流。

**握手**：客户端发 `initialize`（带 `protocolVersion` / `capabilities` / `clientInfo`），服务端回 `protocolVersion` / `capabilities` / `serverInfo` / `instructions`。版本协商规则是「支持就原样回，不支持就回我方最新版」，**不能直接拒绝**——拒绝会让客户端认为服务不可用，而实际上只是版本号不同。

**工具返回的两层错误**，这一层必须分清：

| 层 | 表达方式 | 什么情况用 |
|---|---|---|
| 协议错误 | 顶层 `error` 字段（`-32700` / `-32600` / `-32601` / `-32602` / `-32603`） | 请求本身不合法：JSON 坏了、方法不存在、参数类型错 |
| 工具执行错误 | `result.isError = true`，`content` 里带可读原因 | 命令确实跑了但失败了：文件不存在、缺 7-Zip、校验未通过 |

**构建失败是有效信息，不能当成协议错误吞掉**。若把它包成 `-32603`，agent 只看到「internal error」，拿不到 `M2W_1002` 这个错误码，也就无法告诉用户「缺的不是你的项目，是 7-Zip」。

**六个工具的参数**（`required` 之外的字段都可省略）：

| 工具 | 主要参数 | 返回要点 |
|---|---|---|
| `wacmin_list_directions` | 无 | 每个方向的 `host`、`installed`、`produces`、`subcommands` |
| `wacmin_doctor` | `direction` | 各外部工具的存在性与安装命令 |
| `wacmin_build` | `direction`（必填）、`project` / `installer`（按方向二选一）、`outDir`、`arch`、`extraArgs[]` | 产物路径、字节数、`ok` / `complete`、`checks[]` |
| `wacmin_verify` | `direction`、产物路径 | 三态校验结果，不重新构建 |
| `wacmin_assess` | `appPath` | 框架判定、可移植性评分、阻断项 |
| `wacmin_run` | `direction`（必填）、`command`（必填）、`args[]` | 透传子命令的 stdout 与退出码 |

**`wacmin_build` 的 `required` 只有 `direction`，原因不是偷懒**：起点字段按方向二选一（`project` 或 `installer`），JSON Schema 的 `required` 表达不了「A 或 B 至少一个」。硬写成 `required: ['direction', 'project']` 会直接拒绝合法的 `exeonmac` 调用。校验放在翻译层做，报错信息也比 Schema 校验更贴切。

**取消**：客户端发 `notifications/cancelled`（`params.requestId`），服务端按 ID 查表并中止对应请求。未知 ID 静默忽略——规范如此，且客户端可能在响应到达后才发出取消。中止必须真的杀掉子进程**树**（`SIGTERM` → 2 秒 → `SIGKILL`），否则会出现「工具报已取消，磁盘上却多了半份产物」。

**工具注解影响客户端行为**：`readOnlyHint: true` 的工具多数客户端不弹确认框。因此 `wacmin_build` / `wacmin_run` 必须标成非只读——把 build 标成只读会让 agent 在用户不知情的情况下写盘、跑数分钟。

---
## 十一、目录结构

### 11.1 仓库结构

```
Wacmin/
├── contracts/                 共享契约（唯一真源）
│   ├── exit-codes.json        统一退出码
│   ├── exit-codes.schema.json 退出码文件的 Schema
│   ├── error-prefixes.json    错误码前缀与段位分配
│   ├── run-report.schema.json --report / --json 输出结构
│   ├── validate.mjs           契约自检 + 报告校验
│   ├── validate.test.mjs      校验器自身的测试
│   ├── doc-counts.mjs         12.1 测试计数表 + 附录 C 的唯一检查入口（--check / --min / --list）
│   ├── doc-counts.test.mjs    计数表与两版 README 的一致性守卫
│   ├── appendix-guard.mjs     附录 C 那 8 个数字的机器守卫（从代码常量与文档结构现读）
│   └── appendix-guard.test.mjs 8 个数字逐个篡改的回归锁
├── mac2win/                   方向一 · 在 macOS 上产出 Windows 安装包
│   ├── bin/mac2win.mjs        单命令入口
│   ├── src/                   核心实现
│   │   ├── core/              配置、预检、框架、运行时、收集、暂存、打包、编排、报告
│   │   ├── verify/            PE 解析与产物校验
│   │   └── server/            本地控制台 HTTP 服务
│   ├── web/                   控制台前端静态资源
│   ├── test/
│   └── package.json
├── exeonmac/                  方向二 · 在 macOS 上运行 Windows 程序
│   ├── bin/wepack             开发入口（PYTHONPATH 注入，免安装）
│   ├── wepack/                Python 包
│   │   ├── cli.py             子命令入口与 doctor
│   │   ├── pe.py              PE 解析
│   │   ├── tools.py           外部工具定位与冒烟测试
│   │   ├── runtime.py         Wine 运行时管理
│   │   ├── detect/            安装器识别（含 CFB、MSI 表解析）
│   │   ├── extract/           静态解包与主程序打分
│   │   ├── prefix/            prefix 创建与 clonefile
│   │   ├── install/           静默安装编排
│   │   ├── layers/            层构建与导入表匹配
│   │   ├── package/           .app 装配、图标、launcher 编译、校验
│   │   ├── recipes/           compat.yaml 读写与配方库
│   │   ├── entry.py           主程序入口判据（install 与 package 共用的唯一一处）
│   │   ├── report.py          统一运行报告与八阶段记录
│   │   └── models.py / errors.py / paths.py / log.py
│   ├── launcher/              Swift launcher（AppKit + Foundation）
│   ├── tools/badge.swift      图标角标合成
│   ├── runtime/fetch.sh       Wine 运行时下载脚本（免装 Python 包的入口）
│   ├── schema/compat.schema.json
│   ├── tests/
│   └── pyproject.toml
├── win2mac/                   方向三 · 在 Windows 上产出 macOS 应用包
│   ├── bin/win2mac.mjs
│   ├── src/core/              bundle / plist / wexezip / verify / builder / report / errors
│   ├── test/
│   └── package.json
├── apponwin/                  方向四 · 在 Windows 上运行 macOS 程序
│   ├── bin/apponwin.mjs
│   ├── src/core/              macho / plist / assess / spike / report / errors
│   ├── test/
│   └── package.json
├── console/                   四方向统一入口（CLI + Web 看板）
│   ├── bin/wacmin-console.mjs 可执行入口（薄壳，只解析 argv 与打印）
│   ├── scripts/               viewport-check.mjs（三档视口实测，四段判定）
│   ├── src/                    directions.mjs / server.mjs / contract-check.mjs
│   ├── web/
│   ├── test/
│   └── package.json
├── ai/                        AI 接入层（MCP / CLI / Skill / 专家包）
│   ├── bin/
│   │   ├── wacmin.mjs         统一命令行入口
│   │   └── wacmin-mcp.mjs     MCP server 入口（stdio）
│   ├── src/
│   │   ├── protocol.mjs       JSON-RPC 编解码与换行分帧
│   │   ├── tools.mjs          六个 MCP 工具定义与参数翻译
│   │   └── server.mjs         握手、工具分派、取消
│   ├── skills/wacmin/SKILL.md 供 agent 判断何时调用
│   ├── experts/wacmin-expert.md 专家包：判据与方法论
│   ├── test/
│   └── package.json
├── .github/                   CI 工作流
├── LICENSE                    Apache-2.0 全文（GitHub 据此识别仓库许可）
├── LICENSE-MIT                MIT 全文
├── LICENSING.md               分层路由表（人类可读）
├── NOTICE                     第三方组件与许可证声明（全仓唯一）
├── README.md                  中文说明（本文件）
└── README_EN.md               英文说明
```

四个方向**相互独立**：各自的依赖、测试、发布互不影响。但它们**相辅相成**：共用一层契约，因此 `console/` 能用同一套代码驱动全部四个方向。

**子目录不保留任何独立文档**。全部说明集中在本文件，许可证与合规声明集中在根目录的 `LICENSE` 与 `NOTICE`。理由见 1.1 节。

### 11.2 产物结构：ExeOnMac 的 `.app`

```
{应用名} (Win).app/
└── Contents/
    ├── Info.plist                       # 必含
    ├── PkgInfo                          # 可选，内容 APPL????
    ├── MacOS/
    │   └── launcher                     # 必含，Swift 可执行，arm64 原生
    ├── Resources/
    │   ├── AppIcon.icns                 # 必含
    │   ├── original.ico                 # 可选，原始图标备份
    │   └── Private/                     # 必含，唯一可写区
    │       ├── drive_c/                 # 安装产物落在这里
    │       ├── dosdevices/
    │       │   ├── c -> ../drive_c      # 相对链接，包移动后仍有效
    │       │   └── z -> /
    │       ├── system.reg
    │       ├── user.reg
    │       └── userdef.reg
    ├── Recipes/
    │   ├── compat.yaml                  # 必含，本包唯一事实来源
    │   └── install.log                  # 必含（可为空文件）
    └── Shared -> ../../wexe/layers       # 可选符号链接，仅供人工排查
```

`Shared` 是可选符号链接，运行时**不依赖**它：launcher 通过 `WEXE_HOME` 或 `~/Library/Application Support/wexe` 定位共享层，路径不写死进包内，包因此可移动、可备份、可分发。

**`Info.plist` 必含字段**：

| 键 | 值 | 说明 |
|---|---|---|
| `CFBundleName` | `{应用名}`，≤15 字符 | 超长从尾部按码点截断，不截断到半个字 |
| `CFBundleDisplayName` | `{应用名} (Win)` | Finder 与 Dock 显示 |
| `CFBundleIdentifier` | `com.wexe.win.{反向域名}` | 必须唯一，冲突时自动加后缀并记 `known_issues` |
| `CFBundleExecutable` | `launcher` | |
| `CFBundlePackageType` | `APPL` | |
| `CFBundleIconFile` | `AppIcon` | 不带 `.icns` 后缀 |
| `CFBundleShortVersionString` | `{version}` | 取不到时用 `1.0` |
| `CFBundleVersion` | `{version}` 的数字归一化 | 非数字段替换为 0 |
| `CFBundleInfoDictionaryVersion` | `6.0` | |
| `LSMinimumSystemVersion` | `13.0` | |
| `NSHighResolutionCapable` | `true`（布尔） | |
| `LSApplicationCategoryType` | `public.app-category.utilities` | 可被 `compat.yaml` 覆盖 |
| `NSSupportsAutomaticGraphicsSwitching` | `true`（布尔） | 双显卡切换 |

明确**不设**的键：`LSUIElement`（设了就没有 Dock 图标）、`LSBackgroundOnly`（同上）、`NSPrincipalClass`（launcher 不走 `NSApplicationMain`，自管生命周期）。`CFBundleDocumentTypes` 仅在 `compat.yaml` 的 `file_associations` 非空时生成，默认不抢系统关联。

**`install.log` 的格式**：纯文本 UTF-8，每行一个事件：

```
[YYYY-MM-DDTHH:MM:SSZ] <level> <event> <detail>
```

必含事件：

| event | 含义 |
|---|---|
| `detect` | 安装器类型与置信度 |
| `prefix.create` | prefix 路径、clonefile 来源层 |
| `install.start` | 实际执行的命令行与参数 |
| `install.exit` | 安装器退出码、耗时 |
| `install.settled` | 因文件数不再增长而主动收尾（安装器不退出） |
| `install.fallback` | 静默失败回退交互的原因 |
| `reboot.suppressed` | 拦截到 `ExitWindowsEx`，记录「假装重启成功」 |
| `scan.entry` | 选定的主 exe 与得分 |
| `package.done` | 产物路径与最终校验结果 |

日志不含用户文件内容，不含环境变量全量转储。

**图标生成链路**：

```
.ico / .exe 资源
  → 解析 ICONDIR，取最大尺寸帧（PNG 帧直接写出，BMP 帧补文件头）
  → sips 转 PNG，缩放到 1024
  → 叠加角标（CoreGraphics，tools/badge.swift）
  → 生成 AppIcon.iconset（16/32/64/128/256/512 的 @1x/@2x）
  → iconutil -c icns
```

角标规格：主图标 1/4 尺寸，内容为白色 `W` 或 Windows 四格，底色 `#0078D4`（Windows 蓝）或 `#8E8E93`（系统灰），位置右下角 4px 边距，不透明度 0.9。纯 `sips` 不支持图层叠加，因此合成那一步用仓库内的 `tools/badge.swift`（CoreGraphics，系统自带框架），仍不引入第三方图像库。

**无图标资源时用占位图**（蓝底白 W）。产物合法可分发，但外观不还原。

### 11.3 产物结构：Mac2Win 的输出

```
<项目>/
└── dist-mac2win/
    ├── 你的应用-1.0.0-x86-setup.exe      # NSIS 安装包（默认）
    ├── 你的应用-1.0.0-x86.zip            # 免安装 zip（alsoZip: true 时）
    └── staging/                          # 中间产物，默认清理
```

`staging/` 在构建成功后删除，`--keep-staging` 保留用于排查。保留时可直接对 `staging/installer.nsi` 手工跑 `makensis`。

**安装包内部结构**（NSIS 载荷）：

```
$INSTDIR/
├── node.exe              # 或改名为启动器名
├── bootstrap.mjs         # 启动器
├── launch.json           # 启动参数
├── app/                  # 应用本体
│   ├── main.js
│   └── node_modules/     # 扁平化后的依赖
└── LICENSE-*             # 各运行时的许可文本
```

**载荷路径为什么多一层 `app/`**：NSIS 的 `File /r` 展开内容时不含源目录名。若直接 `File /r "src\*.*"` 到 `$INSTDIR`，产物内的 `app/` 这一层会消失，校验报「必需文件找不到」。修法是 `SetOutPath` 先补 `app` 层。

### 11.4 产物结构：Win2Mac 的输出

```
<out>/
└── 我的应用.app/
    └── Contents/
        ├── Info.plist
        ├── PkgInfo
        ├── MacOS/
        │   └── MyApp            # 用户提供的可执行文件，权限位 0755
        └── Resources/
            ├── icon.icns        # --icon 提供时才有
            └── payload/         # --payload 指定的附加文件
```

同时产出同名 `.zip`，其中的 Unix 权限位由自研 zip 写入器显式写入。

---

## 十二、性能表现

各方向性能由其底层决定，本项目只做接线，不做性能承诺。下表为实测值，仅供横向参考。

### 12.1 关键指标

| 方向 | 关键性能指标 | 实测值 |
|---|---|---|
| Mac2Win | 完整打包（含校验，热缓存） | 约 19 秒 |
| Mac2Win | 完整打包（含校验，冷缓存） | 取决于网络。运行时约 32–100 MB |
| Mac2Win | 产物校验（4060 个文件逐文件 SHA-256） | 2 秒量级 |
| Mac2Win | 单次项目构建（真实项目） | 由项目自身决定 |
| ExeOnMac | 安装包识别 | 毫秒级 |
| ExeOnMac | 静态解包（34 MB NSIS 样本，4898 文件） | 秒级 |
| ExeOnMac | prefix 创建（clonefile 382 MB base 层） | 亚秒级，占元数据空间 |
| ExeOnMac | 静默安装（34 MB 安装包） | 约 132 秒 |
| ExeOnMac | `.app` 装配（plist + 图标 + launcher） | 秒级；launcher 编译缓存命中约 4 ms |
| Win2Mac | `.app` 装配 + zip | 2 KB 样本约 1 秒，纯 I/O |
| AppOnWin | 结构解析与框架判定 | 毫秒级（读 plist 与 Mach-O 头） |
| console | 四方向 `doctor`（串行） | 555 ms |
| console | 四方向 `doctor`（并行） | 486 ms |

**为什么 Mac2Win 的耗时有区间**：它包含「下载对应框架的 Windows 运行时」这一步。运行时候缓存在 `~/.wacmin/mac2win/cache/`，命中时只需装配与压缩；未命中时要走网络。报一个固定秒数会误导用户。

**测试规模与耗时**（本机实测，与机器性能相关）。

**这张表是本仓库测试计数的唯一来源**。README 的其余部分只写「测试全部通过」，不重复数字 —— 同一个数字存多处必然漂移，本仓库此前就出现过「总数写 978（实际 1150）」与「英文版把 mac2win 记成 131」两次分叉。

| 子项目 | 测试数 | 耗时 | 备注 |
|---|---|---|---|
| mac2win | 167 项 | 约 28 秒 | |
| exeonmac | 490 项 | 约 2 分 57 秒 | 含现场编译 NSIS / Inno 样本、3 项真实 wine 安装、2 项真实层构建与 2 项对真实层跑匹配、3 项导入期副作用守卫（静态全仓 + 动态哨兵 + 扫描范围）、2 项启动窗口内信号（SIGTERM / SIGINT，假 wine 撑开窗口）、10 项字体替换格式/根键/判据守卫（含 2 项扫真实二进制的两条字体路径） |
| win2mac | 130 项 | 约 2 秒 | |
| apponwin | 96 项 | 约 0.5 秒 | |
| console | 254 项 | 约 23 秒 | 含 8 项断行质量守卫 + 11 项键盘焦点守卫 |
| ai | 132 项 | 约 9 秒 | |
| contracts | 113 项 | 约 3 秒 | 含 15 项文档计数自检 + 32 项附录 C 守卫 + 2 项表作用域守卫 |
| **合计** | **1382 项** | — | 见下文「全仓 0 跳过」|

**全仓 0 跳过。** 这不是一个漂亮的数字，是一条硬约束：`OK (skipped=N)` 与
`# skipped N` 的退出码都是 0，跳过在报告里跟通过长得一样。实测过两次
「CI 全绿但守卫没在站岗」：

- exeonmac：CI 上 `Ran 333 tests / OK (skipped=10)`，10 项 MSI 表解析、
  Inno 版本识别、NSIS 解包从来没在 CI 上跑过；
- mac2win：CI 上 `# tests 131 / # pass 128 / # skipped 3`，跳过的是
  「控制台程序按 GUI 校验必须被拒」这类拒绝路径的核心断言。

两处都已改为**现场生成样本**（MSI 用纯 Python 拼 CFB、NSIS 调 makensis、
Inno 调 ISCC 在 wine 下真编译）而非依赖本机残留文件，并在 CI 里加了
`check_no_skips.py` / `check-no-skips.mjs`：跳过数非 0 直接红，测试总数
低于基线也红（防止夹具被删导致「变少」而不是「变红」）。

mac2win 里另有三处「本机没有可用的 7-Zip 就跳过」的测试，同样处理掉了。
它们守的是「显式指定优先于系统那份」与「doctor 和 verify 用同一判据」——
跳过条件看着合理（真没装就别测了），但干净的 CI runner 上必然没装，
于是这三条常年绿着却从不执行，而它们存在的唯一理由就是验那两件事。
改用 `fixtures.mjs` 的 `fake7zip()` 造一个满足探测判据的脚本：
`probeCandidates()` 只要求「是文件 / 能跑 `i` / 输出含 `7-Zip` 与
`Formats:`」，与「是不是真 7-Zip」无关 —— 它判定的是**这个候选会不会
被 verify 选中**，而解包能力由真实产物那几条测试覆盖。

**基线本身也从这张表读，不在别处另存一份。** `contracts/doc-counts.mjs --min <模块>`
把表格里的数字输出给 CI 的 `--min` 用；`--check` 则校验「合计 = 各分项之和」
且两版逐项相同。CI 的 `contracts` job 会跑它。

这一步不是多余的谨慎。这三个基线原先硬编码在 `ci.yml` 里（当时的 `--min 132`、
`--min 416`、`--min 43`），与这张表构成同一数字的第二份副本 —— 改表漏改
workflow，守卫就会用旧基线放行。本仓库已经因此分叉过三次：总数写 978
（实际 1150）、英文版把 mac2win 记成 131、6.5 节与 `NOTICE` 第八章各有一份
互不相同的「未使用技术」清单。**防漂移靠的不是「记得同步改」，而是让同一个
数字只有一个写入点，其余全部读它。**

### 12.2 一次真实的两小时 → 一分钟

空谷项目最初一次构建耗时 **6241 秒（1 小时 44 分）**，产物里塞了 **51534 个文件**。根因不是环境，是设计缺陷。

pnpm 把每个包依赖的包软链进它自己的 `node_modules`——实测 83 个包里 **80 个都带**。而 `copyTree` 拷包时没有跳过内部 `node_modules`，于是把软链农场展开成真实文件。

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 载荷文件数 | 51534 | **6722** |
| 构建耗时 | 6241 秒 | **56.5 秒** |
| 依赖包文件 | 3777（展开后 5 万） | 3306 |

修法：`copyTree` 接受 `skipDirs`，拷依赖包时跳过任意层级的 `node_modules`——依赖已由收集器统一收集并扁平放在**同一层**，包内部那一份是多余的。

**110 倍**的提升全部来自这一处。

### 12.3 受管环境的 I/O 开销

在沙箱、EDR 扫描、网络盘这类受管环境里，单次文件复制可能有 25–40 ms 的固定开销，且**并发不能绕过**：

| 操作 | 正常 SSD | 受管环境 |
|---|---|---|
| 单次 `copyFile` | < 1 ms | 25–40 ms |
| `/tmp` 内并发 20 次 | 4 ms | 4 ms（并发有效） |
| **跨目录**并发 20 次 | ~5 ms | 762 ms（并发无效） |

这是环境的 I/O 拦截层造成的。修掉上面的设计缺陷后，即使在受管环境里也能 56 秒完成。

**顺带排除的两个方案**：`tar -cf - | tar -xf -` 会被沙箱拦截 stdout 重定向（报 `Unrecognized archive format`）；硬链接在受管环境里同样有固定开销，且跨盘会 `EXDEV` 失败。

### 12.4 clonefile 的空间与时间

复制 64 MB 文件后，卷可用空间只减少**不到 1 MB**（元数据级别）。

**测量方法**：不能用 `st_blocks` 或 `du`——APFS 会把共享块重复计入每个副本。只能测卷可用空间的差值：

```python
before = free_space(path)
clone_tree(src, dst)
consumed = before - free_space(path)   # 这才是真实占用
```

这个细节导致过一次误判：用 `du -sk` 断言时，clonefile 前后都报 20 MB，被误认为「clonefile 没生效」。

**降级**：跨卷或非 APFS 时 clonefile 失败，自动降级 `cp -R`，结果里标 `method="copy"` 并记 WARNING。此时会真实占空间。

### 12.5 校验为何按秒计而非按分钟计

一个 200 MB 的 exe 内 4086 个文件，若每个文件调一次 `7zz x -so`，就是 4086 次进程创建——实测耗时 10 分钟未完成。

改为**一次解包 + 本地哈希**：用 `7zz x -so` 流式解到内存算哈希，空谷 4086 个文件校验耗时 **0.87 秒**。

### 12.6 为什么不做性能承诺

兼容层的性能由底层决定：Wine 的图形性能取决于 MoltenVK / D3DMetal 翻译层，Electron 产物的启动速度取决于 Chromium 冷启动。本项目只做接线，不修改这些底层。承诺具体帧率或启动时间是不负责任的。

表中列出的都是**本项目自己产生的开销**（打包、校验、装配、解析），这些可以给出实测值。

---

## 十三、安全与隐私

这一节只写实际做了什么，以及**哪些地方没有做到**。把没做的说成做了，比不做更危险。

### 13.1 网络行为

程序只在以下两种情况联网，且都由用户操作显式触发：

| 方向 | 何时联网 | 目标 |
|---|---|---|
| Mac2Win | 构建需要下载运行时，且缓存未命中 | `nodejs.org`、GitHub Releases（Electron）、`dl.nwjs.io`（NW.js）及各自镜像 |
| ExeOnMac | 用户显式执行 `wepack runtime install` | GitHub Releases（Gcenx `macOS_Wine_builds`） |

`mac2win build --dry-run`、`mac2win verify`、`apponwin assess`、`apponwin parse`、`win2mac build`（装配阶段）**完全不联网**。ExeOnMac 的 `detect` / `extract` / `package` 也不联网——只有 `runtime install` 与需要 Wine 的 `install` / `build` 会触发运行时获取。

**`ai/` 层本身完全不联网**。MCP server 只经 stdin / stdout 与本机客户端通信，`wacmin` 只起本机子进程。若 AI 客户端把工具返回的内容上传到模型服务，那是客户端的行为，不在本仓库的控制范围内——见 13.5。

**镜像的取舍**：Mac2Win 在国内直连 `nodejs.org` 常只有几十 KB/s，33 MB 的包要下十几分钟。因此维护了一份镜像列表，顺序即优先级：先官方，失败再退镜像。**校验和一律以官方为准**——镜像的 `SHASUMS256.txt` 可能与官方不同步，镜像只用来加速下载本体。

### 13.2 完整性校验：做到哪一步

**这里必须分开说，因为四个来源的保障强度不同。**

| 运行时来源 | 完整性校验 | 强度 |
|---|---|---|
| Node.js（Mac2Win） | 下载官方 `SHASUMS256.txt`，逐文件比对 SHA-256；不匹配即 `M2W_3002` 失败 | **强**：有官方发布的密码学校验和 |
| Electron（Mac2Win） | 不校验哈希；解包后断言 `electron.exe` 的 PE 架构与目标一致 | 弱：只保证「解出了正确的架构」，不保证「字节未被篡改」 |
| NW.js（Mac2Win） | 同上，断言 `nw.exe` 的架构 | 弱：同上 |
| Wine（ExeOnMac） | 只校验 HTTP 状态与 `Content-Length` 一致（下载完整性）；**不校验 GPG 签名** | 弱：能发现传输中断，不能发现源端被替换 |

**为什么 Electron 与 NW.js 没有哈希校验**：这两家上游不提供稳定的、可程序化获取的校验和清单（Electron 的 `SHASUMS256.txt` 只在部分版本的 release 附件里，格式不统一；NW.js 没有官方校验和发布渠道）。硬编码一份哈希表意味着每次版本更新都要改代码，且一旦上游重发同版本号的文件就会全部失败。

**Wine 的签名问题同样如实记录**：Gcenx 未提供稳定的 GPG 签名流程。这一风险在 `NOTICE` 第 3.5 节同样记录，不隐瞒。

**安全敏感场景的做法**：用离线路径。Mac2Win 用 `runtimeArchive` + `runtimeChecksum` 指定本地已核验的文件；ExeOnMac 用 `wepack runtime install --archive <path>` 指定本地已核验的 `tar.xz`。两条路径都会跳过下载，只做本地校验。

### 13.3 本地服务的安全边界

`mac2win ui` 与 `wacmin-console web` 各起一个本地 HTTP 服务。**这两个服务能启动子进程**，等同于本机任意代码执行的入口，因此边界必须收紧。

| 措施 | 具体做法 | 防的是什么 |
|---|---|---|
| 只绑回环地址 | `server.listen(port, '127.0.0.1')`，**绝不绑 `0.0.0.0`** | 同一局域网内任何人通过它执行命令 |
| 校验 `Origin` / `Host` | 只接受 `127.0.0.1` / `localhost` / `[::1]`，端口任意 | **DNS rebinding**：恶意网页把自己的域名解析到 `127.0.0.1`，再从浏览器打这个接口 |
| 子命令白名单 | `ALLOWED_COMMANDS` 集合，共 16 个允许值 | 请求体里拼任意命令 |
| 静态文件路径穿越防护 | 路径先 `normalize`，再确认仍在静态目录内（`startsWith(root + sep)`） | `GET /../../node.exe` 把运行时下走 |
| URL 解码失败即拒 | `decodeURIComponent` 抛错返回 400 | 畸形编码绕过路径检查 |

**Mac2Win 的产物内启动器也有同样的防护**。它服务 `ui/` 下的静态文件，判断方式相同：`normalize` 后确认仍在根目录内。这条不是理论风险——产物会被分发到用户机器上跑，那里的环境不受控。

### 13.4 解包与文件写入

| 场景 | 防护 | 适用方向 |
|---|---|---|
| zip 解包 | 条目名先统一分隔符，再拒绝以 `/` 开头或含 `..` 的路径。zip 里出现 `../../etc/passwd` 这类条目是常见攻击手法 | Mac2Win |
| Windows 路径 | 检查保留设备名（`CON`、`PRN`、`AUX`、`NUL`、`COM1`–`COM9`、`LPT1`–`LPT9`）；判断时去掉扩展名，因为 `con.txt` 同样非法 | Mac2Win |
| Windows 路径 | 拒绝 Windows 不允许的字符（`\ / : * ? " < > \|` 与控制字符） | Mac2Win |
| Windows 路径 | 拒绝以点或空格结尾的段。这类名字在 Windows 上会被**静默丢弃**，导致「打包成功但文件名对不上」 | Mac2Win |
| 下载落盘 | 先写 `.part` 临时文件，长度校验通过后 `rename`。中途失败不会留下一个看起来完整的坏文件 | ExeOnMac |
| 覆盖写 | 目标目录在上游操作前先 `remove`，避免「旧文件残留 + 新文件写入失败」产生半新半旧的产物 | Mac2Win |
| 架构断言 | 解包后仍再校验一次 PE 架构，防止缓存里躺着一份上一轮写坏的运行时 | Mac2Win |
| 目录非空 | 直接报错，不覆盖不删除。`--force` 也只改变错误信息，不改变行为 | ExeOnMac |
| 注册表修改 | 不直接改 prefix 里的注册表二进制，只写 `.reg` 文本文件交由 `wine regedit /S` 导入，文件保留便于审计与回滚 | ExeOnMac |
| 可写范围 | 仅包内 `Private/`、`Recipes/` 与 `~/Library/Application Support/wexe/`。不写 `/Library`、`/usr`、`~/.wine` | ExeOnMac |

**Mac2Win 的下载没有 `.part` 中转**，直接写目标文件；中断会留下半截文件，但下一次运行会因架构断言失败而丢弃重下，行为等价于「检测到坏缓存」。这是一处已知的实现差异，不影响正确性。

### 13.5 隐私

**没有任何遥测、埋点、崩溃上报、使用统计。** 全部代码中不存在对统计服务的网络请求。可自行验证：

```bash
grep -rn "telemetry\|analytics\|sentry\|google-analytics" \
  --include="*.mjs" --include="*.js" --include="*.py" \
  mac2win console win2mac apponwin exeonmac ai
```

**本地留下的数据**（全部在用户主目录，删掉即彻底清除）：

| 路径 | 内容 |
|---|---|
| `~/.wacmin/mac2win/cache/` | 已下载的 Node / Electron / NW.js 运行时 |
| `~/.wacmin/history.json` | 看板的最近 20 次运行记录 |
| `~/Library/Application Support/wexe/` | Wine 运行时、prefix、共享层、配方库、安装日志 |
| `~/.wexe/recipes/` | 配方库（`WEXE_RECIPES` 可覆盖） |

**看板历史为什么落在这个位置**：它是运行时数据，不该进版本库，也不该因为仓库被删而不见。`WACMIN_HOME` 可覆盖，供测试与多实例隔离——测试直接写用户真实目录是灾难，会污染开发者的看板历史。

**AI 层不新增任何本地数据**。`ai/` 不写自己的状态文件、不留对话记录、不缓存工具结果。它唯一的输出就是工具返回值，沿 stdio 管道交回客户端。

**关于 MCP 的隐私边界要说清楚**：本仓库能承诺的是「不主动外发」。但工具返回的内容（产物路径、错误信息、`doctor` 检测到的用户名与工具版本）会经客户端交给模型——**这一步由用户所选的客户端决定，不在本仓库控制范围内**。因此 `doctor` 的输出只含工具名、版本与路径，不含环境变量值与用户身份信息。若在隐私敏感环境使用，建议先确认客户端的留存策略。

### 13.6 未做的事

| 项目 | 状态 | 原因 |
|---|---|---|
| 产物代码签名 | 未实现 | 缺证书，不缺工具。瓶颈是 CA/B Forum 要求私钥必须存于 FIPS 140-2 L2+ 硬件且不可导出——与操作系统无关，换 Windows 也一样。`osslsigncode` 可在 macOS 本地签 `.exe`。见 15.11 |
| 产物公证（notarization） | 未实现 | 需 Apple Developer ID（$99/年）与 `notarytool`，后者确为 macOS 独占。**ExeOnMac 另有架构级障碍**：wine prefix 位于 bundle 内且被原地读写，签名会破坏资源封印。见 15.11.3 |
| 本地服务鉴权 | 未实现 | 只绑回环地址 + `Origin` 校验已覆盖威胁模型；加鉴权会让命令行触发变复杂而无实际收益 |
| 传输层加密 | 未实现 | 本地回环通信，加密无意义 |
| 供应链签名验证 | 仅 Node.js 有 | 见 13.2，其余上游不提供可用清单 |
| 沙箱隔离 | 未实现 | 被封装程序与用户的 macOS 处于同一用户会话，能读写用户可访问的文件 |
| 恶意安装包检测 | 未实现 | 本项目不判断安装包是否含恶意代码，只判断能否封装 |

**最后一条需要强调**：ExeOnMac 会把用户提供的安装包在 Wine 里**真实执行**（静默安装）。这与「解包看一眼」有本质区别——安装器的代码会真的跑起来，具有当前用户的文件访问权限。只对信任来源的安装包使用 `install` / `build`。

---

## 十四、兼容性说明

### 14.1 宿主与目标

| 方向 | 宿主要求 | 目标 | 实际能否跑通 |
|---|---|---|---|
| Mac2Win | macOS 11+ / Apple Silicon（建议） | Windows x86（i386 PE）与 x64 | 已实测：真实构建 + 三态校验 |
| ExeOnMac | macOS 13+ / Apple Silicon | Windows 程序（经 Wine） | 已实测：识别、解包、prefix、`.app` 封装、启动 |
| Win2Mac | Windows 10+ | macOS `.app` | 已实测：真实产出 `.app` 与 zip |
| AppOnWin | Windows 10+ / WSL2 | macOS 程序（经 Darling） | 未实测：无 Windows + WSL2 + Darling 环境 |

**Mac2Win 为什么要求 Apple Silicon**：项目定位是「在 ARM 架构的 macOS 上打 x86 Windows 包」。在 Intel Mac 上运行不会崩，但会失去这层意义，因此预检会提示。平台判定用 `process.platform !== 'darwin'`，架构不在硬拒绝范围内。

**ExeOnMac 为什么要求 macOS 13+**：需要 `iconutil`、`sips` 与 APFS clonefile，13 是这三个条件同时稳定的起点。产物内 `LSMinimumSystemVersion` 同样设为 `13.0`。

**Win2Mac 在非 Windows 上也能跑**：默认只警告「宿主不是 Windows」，加 `--strict-host` 才强制拒绝。这样做是因为在 macOS 上打包并立即用 `plutil` 校验一遍是有效的开发流程——`plutil` 是 Apple 官方工具，比自研解析器更权威。`--strict-host` 留给「必须在目标平台产出」的发布流程。

**AppOnWin 的宿主判定**：`assess` 与 `parse` 是纯读操作，**任何平台都能跑**。只有 `spike` 需要真实的 Windows + WSL2 + Darling 环境，环境不具备时报「未验证」（退出码 5）而非「通过」。

### 14.2 运行时版本要求

| 依赖 | 最低版本 | 实测版本 | 说明 |
|---|---|---|---|
| Node.js（宿主） | 20 | 22.x | 需要 `node --test`、`fetch` 与 ESM 顶层 await |
| Python（宿主） | 3.11 | 3.11+ | 需要 `tomllib`、`X \| Y` 类型语法 |
| Swift（宿主） | 6.0 | 6.0+ | ExeOnMac 编译 launcher，需 Xcode CLT |
| NSIS | 3.x | 3.13 | `MUI2` 界面与 `File /r` 行为在 3.x 稳定 |
| 7-Zip | 22.00 | 25.01 | `7zz i` 的输出格式在此版本后稳定 |
| Wine | 未固定 | 11.21 | Gcenx 的 devel 构建；其他版本未验证 |
| Rosetta 2 | 系统自带 | — | Apple Silicon 必需 |
| `plutil` | 系统自带 | — | Win2Mac 校验 `Info.plist` 时可选调用 |
| `innoextract` | 任意 | 1.9 | 可选，Inno Setup 唯一可行的解包工具 |
| `msitools` | 任意 | — | 可选，MSI 优先解包工具 |

**Node.js 的 `≥ 20` 是硬要求**，不是保守取值：`node:test` 的 `--test` 并发模型、`fetch` 的稳定实现、ESM 顶层 await 都在 20 才齐备。

### 14.3 目标运行时版本

| 运行时 | 支持范围 | 硬上限 |
|---|---|---|
| Node.js（打包进产物） | 20 / 22 LTS | 无 |
| Electron（打包进产物） | ≤ 43.0.0 | **v44 起官方不再发布 `win32-ia32`** |
| NW.js（打包进产物） | 按项目声明（默认 0.90.0） | 无 |
| Tauri | 不打包运行时 | 产物为 Rust 编译的原生 exe |

**Electron 的 43 上限无法绕过**。这属于上游发布策略，不是本项目能解决的问题。mac2win 在**预检阶段**即拦截更高版本，不让用户在下载 100 MB 之后才失败。

### 14.4 硬边界

| 限制 | 原因 | 有无绕过方案 |
|---|---|---|
| Mac2Win 的 Electron x86 只到 v43 | 官方从 v44 起不再发布 `win32-ia32` 预编译包 | 无。要更高版本只能放弃 x86 目标 |
| Mac2Win 产物无代码签名 | 缺证书（私钥须存于 FIPS 140-2 L2+ 硬件，与 OS 无关），不缺签名工具 | 可用 `osslsigncode` 在 macOS 本地签，或 CI 侧用 Windows runner 的 `signtool`。见 15.11 |
| Mac2Win 不支持原生模块（`.node`） | 编译好的机器码与 OS/CPU 绑定 | 换纯 JS 替代包；mac2win 会在依赖收集阶段拦下并指出是哪个包 |
| Mac2Win 不能在 mac 上打 macOS 包给 Windows 用 | 平台二进制格式不同（Mach-O vs PE），且需对应平台 SDK | 无。用对应平台构建 |
| Mac2Win 不能在 mac 上打 Linux 包 | 需要 Linux 的 glibc 与 ELF 工具链 | 可用 Docker，但不在本项目范围 |
| Wails / Flutter 桌面版跨架构 | 二者的 Windows 目标必须用 MSVC 完整工具链 | 无等价路径 |
| .NET / WPF 跨架构 | 需 Windows SDK 与 MSBuild | 无等价路径 |
| ExeOnMac 必须自备 Wine x86_64 | Wine 官方从未发布 arm64 macOS 构建 | 无。只能经 Rosetta 2 |
| ExeOnMac 无法覆盖全部 Windows 程序 | Wine 的兼容性由底层决定，本项目不修改 Wine | 无。只能通过配方库逐程序适配 |
| ExeOnMac 不支持内核驱动 / 反作弊 / 硬件狗 | 技术上不可行，且可能造成账号风险 | 无，且不打算支持 |
| Win2Mac 不能出 dmg / 不能签名 / 不能公证 | `hdiutil` / `codesign` / `notarytool` 都是 macOS 独占 | 可在 macOS 上补签与公证 |
| AppOnWin 可能不成立 | Darling 官方仅支持 Linux，Windows 需经 WSL2，GUI 支持被上游标注为实验性 | 降级为兼容性评估工具 |

### 14.5 ExeOnMac 明确不支持的软件类别

识别到以下特征时直接以退出码 4 中止，**不尝试绕过、不尝试降级、不给出「也许能跑」的暗示**。

**内核与驱动类**：`.sys` 驱动、内核服务注册（INF 含 `AddService` + `ServiceType=1`）、文件系统过滤驱动（`minifilter` / `FltRegisterFilter`）、虚拟网卡 / TAP 驱动、打印机驱动。原因：Wine 无内核态，驱动无法加载。

**反作弊与保护壳**：EasyAntiCheat、BattlEye、Riot Vanguard、nProtect GameGuard、XignCode3、Themida / VMProtect / Enigma。原因：反作弊依赖内核态完整性校验与 hypervisor 级检测，Wine 环境必然误判为篡改；即使强行启动也会被踢出或封号，属于对用户有害的行为。

**保护壳单独处理**：VMProtect 类只报「可能无法运行」，不中止——部分单机程序加了壳仍能跑。这是清单里唯一的软判定。

**硬件依赖**：硬件狗（`hasp` / `sentinel` / `rockey` / `aladdin`）、TPM 要求、Secure Boot 要求、专用采集卡、生物识别设备。原因：macOS 无对应硬件抽象层，且本项目不装 kext。

**系统级组件**：Windows Update 独立包（`.msu`，需完整 CBS 栈）、系统服务常驻（prefix 内服务在包退出后无宿主）、全局 shell 扩展（需 Explorer 进程，Wine 的 explorer 不支持第三方扩展）、输入法（Wine 的 IME 桥接不完整）、需要管理员提权的驱动安装。

**安装器类型**：

| 类型 | 状态 | 说明 |
|---|---|---|
| NSIS | 支持 | 7-Zip 直接解，实测 4898 文件样本通过 |
| Inno Setup | 支持（需 innoextract） | 缺 innoextract 时如实报错，不做 7z 假成功回退 |
| MSI | 支持 | msiextract 优先，回退自研表解析可还原真实文件名 |
| InstallShield | 仅识别 | 新版用 CAB + 自定义脚本，静态解包常失败，走静默安装路径 |
| WiX Burn | 仅识别 | bundle 内嵌多个 MSI，需先解 bundle |
| Squirrel | 仅识别 | `--silent` 即可，本质是解 nupkg |
| 自解压 RAR/SFX | 不支持 | 需 unrar，且多数带密码 |
| 联网下载主体的 stub installer | 不支持 | 全程离线，不代下载 |
| 加密安装包（带密码） | 不支持 | 7-Zip 会要求交互输入密码，本工具非交互 |

未列入的类型一律 `unknown`，退出码 4。

**运行时行为限制**：无窗口融合（Wine 窗口独立显示，不与 macOS 菜单栏整合）、无剪贴板双向同步保证（富文本与图片不通）、无全局快捷键、无 Retina 精确缩放（混合 DPI 多显示器可能错位）、无 GPU 直通（走 MoltenVK / D3DMetal，性能受限于翻译层）、无音频独占（走 CoreAudio 共享模式）、无 USB 设备直通（除 HID 外不保证）。

**不支持清单只增不减**。若某条目在后续版本被支持，须先修改 `README` 本节的边界描述，再改代码。

### 14.6 跨平台行为差异

同一份代码在不同宿主上行为不同的地方，全部列出：

| 场景 | macOS 上 | Windows 上 | 处理方式 |
|---|---|---|---|
| 路径分隔符 | `/` | `\` | 内部统一用 `/`，只在写 NSIS 脚本时转换 |
| 权限位 | 保留 Unix mode | 无此概念 | Win2Mac 自研 zip 写入器在中央目录的外部属性里存 mode，解压后 `0755` 不丢 |
| 文件名大小写 | 默认不敏感（APFS 可配） | 不敏感 | 不依赖大小写敏感行为 |
| 尾部点与空格 | 合法 | 被静默丢弃 | 打包前检查并报错，不静默改写 |
| 保留设备名 | 合法 | 非法 | 打包前检查并报错 |
| 换行符 | LF | CRLF | 生成的文本文件一律用 LF：NSIS 脚本由 `makensis` 在 macOS 上编译，LF 可正常工作；`Info.plist` 是 XML，LF 为规范推荐值 |
| 可执行判定 | `x` 位 | 扩展名 | `.app` 内主程序靠 `Info.plist` 的 `CFBundleExecutable` 定位，不依赖 `x` 位 |
| 结论大小写 | 不敏感 | 不敏感 | 契约中枚举值一律小写，避免平台差异 |

---
## 十五、已知问题与限制

### 15.1 按方向的已知限制

**Mac2Win**

1. **Electron 版本上限是 43**。这是官方发布策略决定的硬边界，不是本项目能绕过的。
2. **产物无代码签名**。`.exe` 会触发 SmartScreen 警告，只能建议用户点「更多信息 → 仍要运行」。签名缺的是证书而非工具——`osslsigncode` 在 macOS 上可直接签 PE，`brew install osslsigncode` 即可。证书侧受 CA/B Forum 硬件密钥要求约束（与 OS 无关）。见 15.11。
3. **原生模块不支持**。`.node` 文件是编译好的机器码，与 OS/CPU 绑定。依赖收集阶段会拦下并指出是哪个包。
4. **Tauri Rust 壳的链路已验证到「依赖树能链接成 PE」，但完整项目仍卡在 `llvm-rc`**。代码已实现（`src/core/rust-shell.mjs`），预检与配置已接通。2026-11-19 实测修正了此前两处错误归因：卡点**不是**「沙箱限制装不上 LLVM」，也**不是**「arm64 mac 编不了 i686」。真实情况是 —— Rust 链与 tauri 2.12.7 的整棵依赖树在 arm64 macOS 上都能编成 `PE32/i386`（实测 `linkprobe.exe` 1096192 字节）；完整项目卡在 `tauri-winres` 要 `llvm-rc` 编资源节，而**本机未装**该组件（属改变开发环境的操作，未自动执行）。详见 15.10。
5. **x64 目标是后加的**。三处写死 x86 的地方（运行时文件名、缓存目录、架构断言）已修正，但 x64 路径的实测覆盖面小于 x86。
6. **`--target x64` 的产物外壳仍是 i386 桩程序**。这不是缺陷：NSIS 编译出的 exe 永远是 32 位安装器，能在所有 Windows 上运行。校验规则已按此区分「外壳」与「载荷」。

**ExeOnMac**

1. **必须自备 Wine x86_64 运行时**。仓库不含二进制，用 `wepack runtime install` 装。
2. **兼容性由 Wine 决定**。本项目负责识别、解包、装前缀、打包，不修改 Wine，也不承诺某个具体 Windows 程序一定能跑。
3. **Inno 无 innoextract 时只能解出 stub 节区**，主 exe 定位会失败。已改为如实报错而非假成功。
4. **MSI 的 7z 回退只还原文件与目录**，不执行组件安装顺序与自定义动作。自研表解析只覆盖 `File` / `Directory` / `Component` / `Shortcut` 四张表。
5. **InstallShield 与 Burn 只识别不解包**，走静默安装路径。
6. **静默安装失败后不自动回退交互模式**。`--interactive` 需用户显式指定。理由：自动回退会弹出窗口打断批处理，且用户可能不在机器前。
7. **重启拦截是「假装成功」**。真正需要重启才生效的安装（罕见）会表现为「装完了但跑不起来」，需人工排查。
8. **运行时下载不校验签名**，只校验下载完整性。安全敏感场景用 `--archive`。
9. **base / dotnet / fonts-cn 三层都能自动构建**。mfc 与 vcpp 仍不可（前者无合法来源，后者 base 已内置）。详见 [4.2.1](#421-层的自动构建五个层里三个能自动做两个不能)。
10. **层匹配只看静态导入表**。`LoadLibrary` 动态加载的 DLL（插件架构、延迟加载）扫不到，这类程序需手动加层。
11. **未处理多显示器 / HiDPI 缩放下 Wine 窗口的坐标映射**。
12. **无图标资源时用占位图**（蓝底白 W）。产物合法可分发，但外观不还原。
13. **安装超时后强制 kill 进程组，但 Wine 可能在 prefix 里留下锁文件**。重试前建议手动删 `Private/.wine-*` 锁（未自动化）。
14. **MSI 表解析不覆盖所有 MSI 变体**。某些 MSI 会把多张表塞进同一流，行数靠内容特征推断，极端情形下可能判错。

**Win2Mac**

1. **产物未签名、未公证**。首次打开会触发 Gatekeeper 提示，用户需手动放行。
2. **不能出 dmg**。`hdiutil` 是 macOS 独占工具。
3. **不编译 Mach-O**。`--executable` 指向的文件必须由用户自行准备，且必须是真实的 Mach-O；否则命令会警告而非静默放行。
4. **bundle id 冲突检测依赖 `lsregister`**，该工具仅 macOS 可用。在 Windows 上构建时无法预检冲突，需在 macOS 上验证一次。

**AppOnWin**

1. **是最大不确定项**。Darling 官方仅支持 Linux，Windows 需经 WSL2，GUI 支持被上游标注为实验性。若 spike 第 2 条不通过，将降级为兼容性评估工具。
2. **本机结论是「环境不具备」，不是「不成立」**（2026-11-19 实测，见 3.4）。门槛 1 与 2 因宿主非 Windows 而 `blocked`，门槛 3 通过；整体 `unverified`、退出码 5。这个结论既不能当成通过，也不能当成证伪——它只说明本机没法验。
3. **框架清单不完整**。清单里没有的框架一律 `unknown`，不假设可用。
4. **`spike` 的 `blocked` 分为两种成因**：环境不具备（退出码 5）与输入路径写错（退出码 2，`inputErrors` 非空）。两者不可混用；混用会让「路径打错」升级成「方向被证伪」。

**console**

1. **Web 看板只绑 `127.0.0.1`**，不提供远程访问。这是刻意的安全取舍。
2. **历史只保留最近 20 次**，不提供归档与导出。

### 15.2 真机运行链路的实测结论（2026-11-19）

这一节回答一个只能靠跑才能回答的问题：**没有 wine 时会怎样，有 wine 时能不能真的把 Windows 程序跑起来**。两者都必须有实测，不能靠推断。

**环境事实**：本机装有 `wine-11.21`（x86_64，经 Rosetta 2），来自 `wepack runtime install --archive`。`which wine wine64` 在系统 PATH 里查不到 —— 这不是缺陷，运行时由 `wepack` 自己托管在 `~/Library/Application Support/wexe/runtime/wine/`，不污染系统 PATH。

**① 无 wine 分支（降级路径）**

`wine_binary()` 依序找托管运行时 → PATH，两处都没有才抛 `MissingDependency`。CLI 层捕获后退出码 5（`contracts/exit-codes.json` 的「缺少外部依赖」），错误段位 `EOM_2001`（2xxx「外部工具」）。测试覆盖在 `tests/test_phase2.py::test_install_without_wine_fails_clearly`（断言退出码恰为 5 且 payload 的 `error` 含 `wine`）与 `test_phase0.py::test_install_requires_wine_runtime`。三条路径（install / build / layers match）共用这一个判据，不各写一套。

**② 有 wine 时的一次端到端封装（本机实测，非推断）**

样本现场编译：`makensis` 编一个 NSIS 安装包，载荷 15 个文件 / 2.2 MB（含一个真实的 `PE32+ GUI x86-64` 主程序）。走 `wepack build` 一键流程：

| 阶段 | 实测结果 |
|---|---|
| 识别 | `kind=nsis`，置信度落在 NSIS 分支 |
| prefix 创建 | clonefile 复制 base 层 1858 个文件，亚秒级 |
| wineboot | `code=0`，11.5 秒 |
| 静默安装 | `code=0`，6.6 秒，净增 12 个文件 / 2.1 MB |
| 入口探测 | `drive_c/Wacmin/<app>/<App>.exe` |
| 装配校验 | 10 / 10 项通过，`lsregister` 注册成功 |
| **启动** | launcher → wine → 主 exe 进程存活（`pgrep` 可见 pid），`wine-<app>.log` 只剩 MoltenVK 图形层日志，无 `ShellExecuteEx failed` |

启动这一步是本轮唯一的**新证据**：早先只验到「产物结构合法」，没验到「双击能起进程」。第一次用自制的最小 PE（只有 DOS 头 + 可选头，无节表）时 wine 报了 `Application could not be started / ShellExecuteEx failed: Bad format` —— **这是样本的问题，不是工具的问题**：那个 PE 缺节表，Windows 加载器同样会拒绝。换成 wine 自带的真实 `notepad.exe` 作载荷后一次通过。这条经验值记下来：**验证运行链路时，载荷必须是真实可执行的 PE，最小 PE 头只能验「文件格式被识别」，验不了「能不能跑」**。

**③ 修掉的两个真实缺陷**

这次实测暴露了两个此前所有测试都没抓到的缺陷，都不是本轮引入的：

| # | 缺陷 | 后果 | 修法 |
|---|---|---|---|
| 1 | `package` 阶段的 `_guess_entry` 与 `install` 的 `_find_installed_entry` 是**两套判据** | 装任何软件，打包出来都指向 base 层自带的 `wordpad.exe` —— `.app` 能双击、能起进程，只是打开的不是用户装的东西 | 判据收进 `wepack/entry.py` 一处，两处都调它（README 5.3 的红线） |
| 2 | `build --json` 把 `--json` 透传给 `install` 与 `package`，两者各写一份 payload | stdout 上是两段拼接 JSON，`json.load` 抛 `Extra data` —— 调用方拿不到任何结果 | 子命令一律 `json=False`，人类可读输出改道 stderr；`build` 自己输出一份汇总 |

两个缺陷的共同点值得记：**它们都不报错**。缺陷 1 的产物能启动，缺陷 2 在终端里看着像正常输出。这类「静默地做错事」只能靠端到端实测抓，单元测试各自绿着也发现不了 —— 因为每一段单独看都是对的。

**④ 仍未验证的部分**

- **`wine` 不在系统 PATH 时 `runtime status` 的提示语气**：已在测试里覆盖，但没人工读过措辞是否足够可操作。
- **不同 Wine 版本的行为差异**：只测了 11.21。README 14.2 的版本要求来自上游文档，不是本机矩阵实测。
- **图形窗口的实际渲染**：本机是无人值守运行，只验证了进程存活与日志无错，没有人工确认窗口内容。这是本轮的诚实边界，不写成「已验证」。

### 15.2.1 AppOnWin 可行性结论的实测记录（2026-11-19）

3.4 给的是结论，这里给的是**跑出结论的那一次**，以及它顺带暴露的一个缺陷。

**实跑命令与输出**（本机为 macOS arm64，无 WSL2）：

| 命令 | 结论 | 退出码 |
|---|---|---|
| `node apponwin/bin/apponwin.mjs spike --json`（无样本） | `unverified`，3 条门槛全 `blocked` | 5 |
| `node apponwin/bin/apponwin.mjs spike --app /System/Applications/Calculator.app --json` | `unverified`，门槛 1/2 `blocked`、门槛 3 `pass` | 5 |
| `node apponwin/bin/apponwin.mjs assess /System/Applications/Calculator.app` | `较不可能运行`：2 个二进制 / 21 个框架 / 3 个 Darling 明确不支持 / 12 个 `unknown` | 0 |

门槛 3 通过这件事本身值得单独说：它证明的是**解析能力**（`assess` / `parse` 本来就交付这个），而它不依赖 Darling，所以对「能不能跑」零证明力。**三条门槛全过才算成立，缺一条就是未验证** —— 「过去两条中一条」不构成「部分成立」，这个中间态不存在。

**顺带抓到的缺陷：`spike` 把「路径打错」判成「方向被证伪」**

| | 修复前 | 修复后 |
|---|---|---|
| `spike --app /nope.app` 结论 | `rejected` | `unverified` + `inputErrors` 非空 |
| 该门槛状态 | `fail` | `blocked` + `invalidInput: true` |
| 退出码 | **1** | **2** |
| 用户看到的措辞 | 「本方向按设计降级为兼容性评估工具」 | 「1 条门槛因输入路径不合法而未执行（不是方向不成立）。先改正路径再重跑。」 |
| 同一路径喂 `assess` | 退出码 2（`AOW_1002`） | 退出码 2（不变） |

根因是门槛 3 的 `catch` 把 `BuildError(INPUT_NOT_FOUND)` 和真正的解析失败一起记成 `fail`，而 `fail` 一旦出现，整体结论就必然是 `rejected`。**`fail` 的语义必须留给「真的跑了一次并失败」**；路径不存在时门槛压根没进入解析，那是「我不知道」，属 `blocked`。

修的时候还发现第二层：门槛 1 原来先探环境再验样本路径，于是环境缺失时（本机就是）用户永远看不到「你的 `--sample` 写错了」这条最该先看到的提示。已把路径校验提到环境探测之前 —— **参数错误在任何机器上都该报出来，与这台机器装没装 WSL2 无关**。

回归锁在 `apponwin/test/spike.test.mjs`：新增「输入路径不存在时整体结论是 unverified 且标出 inputErrors」「Mach-O 样本路径不存在时该门槛是 blocked 而不是 fail」「输入路径正确但命中环境缺失时不算 inputError」三条，另把原「路径不存在时 fail」这条**错误断言**改为断言 `blocked`。负向验证：把旧实现注回 `spike.mjs` → 2 项立刻变红（`not ok 26` / `not ok 27`）；还原后 94/94 全绿。

### 15.3 文档与实现的三次偏离

这一节记录三处真实发生过的「文档说的和代码做的不一样」。写下来不是为了追责，是因为这三处都属于**不会崩、只会让人白花时间**的那一类，最容易被一次次放过。

**① `mac2win ui --port` / `--no-open` 在 help 里完全没有**

功能是好的、代码是对的，但 help 一个字没提。用户想指定端口时只能猜，猜不到就以为不支持。修法是把两个选项写进 help 的「图形界面选项」段。

**② `mac2win doctor` 不在 help 的「用法」段里**

命令本身支持，连「未知子命令」的错误提示里都列了它，唯独 help 的开头没写。看起来像不存在。

**③ `--report` 只有 mac2win 的 help 没写**

另外三个方向的帮助里都有「`--report` 输出统一运行报告」。统一报告契约是四个方向共用的核心机制，唯独一个方向没在帮助里露出。

#### 15.3.1 文档侧的系统性巡检（2026-11-19）

上面三处是「撞见才发现」的。2026-11-19 做了一次**机械化**的巡检：把 README 里 42 个 shell 代码块中的 267 行命令抽出来，去重得 31 条可执行的唯一命令；对其中**只读与自检类**逐条实跑，对**需要真实产物或 Windows 宿主**的只核对 help 与代码路径（两类清单见本节末，不混为一谈）；表格里的数字一律与代码里的常量逐项对账。

**结果：9 处文档与实现不一致，全部已修。** 这些都属于「读文档的人会照着做，但做不成或看到的东西不一样」的类型。此外还有 4 处目录树漏项与 1 处失效锚点，一并修正，见本节末。

| # | 位置 | 原文 | 实测 | 性质 |
|---|---|---|---|---|
| 1 | 5.2.2 段位表 | 8 行，`9000` 写 `9001–9999`、含义写「流程控制与内部错误」 | `error-prefixes.json` 有 **9 个段位**：`9000` 是 `9001–9998`（流程控制），`9999` 是独立的 `9999`（内部错误） | 数量与区间都错。`validate.mjs` 的 `segmentOf()` 按 `range` 判归属，照文档理解必然对不上 |
| 2 | 9.1 契约文件表 | 「七段位分配」 | 同上是 9 个 | 与 #1 同源 |
| 3 | 8.2 快速开始 | `open "~/Applications/MyApp (Win).app"` | 引号里的 `~` 不会被 shell 展开，`open` 报 `~/Applications/... does not exist`。**这条照抄必然失败** | 命令不可执行。注意上一行 `install -o "~/..."` 是对的——`wepack` 自己 `expanduser()`，差别在 `open` 是外部进程 |
| 4 | 6.4 间接依赖 | 「七个模块（**五个**方向、`console`、`ai`、`contracts`）」 | 方向只有 4 个（`mac2win`/`exeonmac`/`win2mac`/`apponwin`），7 = 4 + 3 | 括号内的加法不成立 |
| 5 | 附录 C 第 2 项 | 32 个配置项 / 14 项外部工具 / 10 个子命令族 | 9.2 表 **37** 行（与 `config.mjs` 的 `DEFAULTS` 37 键一致）、6.2 表 **18** 行（`NOTICE` 第三章同为 18 行）、10.1 表 **6** 行 | 三个数字全过期 |
| 6 | 附录 C 第 3 项 | 二十条亮点 | 实际 **25** 个（含「亮点十五之二」「之三」） | 漏数 |
| 7 | 5.10.4 与 18.1 | 「已踩过的实例见 18.5」/「见 15.2」 | 实例在 **15.3**（«文档与实现的三次偏离»）；15.2 是 exeonmac 真机实测、18.5 是文档同步要求 | 交叉引用指错两处 |
| 8 | 附录 C 第 6 项 | 测试规模（**16**）、校验项数（**15.5**） | 测试计数表在 **12.1**（16 是更新日志）；校验项数在 **15.6** | 引用指错两处 |
| 9 | 10.1 通用选项 | 「`-v/--version`」四方向一致 | `mac2win`/`win2mac`/`apponwin` 的 `-v` 是 version 短名；`wepack` 的 `-v` 是 **verbose** 短名，`--version` 只有长名且为顶层参数 | 语义不一致，脚本用 `-v` 取版本会拿到日志 |

**同时补了四处目录树漏项**：`contracts/doc-counts.mjs` 与 `doc-counts.test.mjs` 在 README 正文被引用（12.1 明写「基线从这张表读」）却不在 11.1 树里；`wepack/entry.py` 与 `wepack/report.py` 同理（5.3 与 10.3 都点名了它们）。

**另修一处失效链接**：英文版顶部「Dependencies」徽章指向 `#6-technology-stack-and-dependency-inventory`，而实际标题是 `## 6. Technology Stack and Dependencies`，锚点应为 `#6-technology-stack-and-dependencies`。点进去是 404 锚点而不是章节。两版内部锚点现已全部校验为 0 无效。

**核对通过的部分也留档**，避免下一轮重复劳动。**注意这里区分「本轮实跑」与「本轮未跑」**，不把未验证的写成通过：

**本轮实跑过的命令**（只读与自检类，逐条列出而不写汇总数字——本轮已经出现过一次「自己数错自己跑了几条」，所以这一栏只给清单）。另对各方向执行了 `--help` 以核对选项清单：

- `node contracts/validate.mjs` → `✓ 契约自洽`（13 条退出码、9 段位、4 前缀）
- `node contracts/doc-counts.mjs --check` → 合计与 12.1 表一致、两版逐项相同（当时为 1177 项，现以 12.1 为准）
- `node console/bin/wacmin-console.mjs list` / `doctor` / `contract` → 4 / 4 / 10-10
- `node ai/bin/wacmin.mjs list` / `status --human` / `mcp` / `skill` → 与 8.6 描述一致
- `node mac2win/bin/mac2win.mjs doctor` → 5 项全 OK
- `python3 -m wepack.cli doctor` / `version` / `recipe list` / `layers list` / `runtime status`
- `node apponwin/bin/apponwin.mjs spike`（含 `--json`）→ 退出码 5、结论 `unverified`
- `node console/bin/wacmin-console.mjs run exeonmac version` → 归一化报告，八阶段全 `skipped`
- `node mac2win/bin/mac2win.mjs build /tmp/w03proj --dry-run` → 预检 14 项全通过、列出八步计划、退出码 0（**用临时最小 Node 项目实测，不是真构建**）
- `node console/bin/wacmin-console.mjs run mac2win build /tmp/w03proj --dry-run` → 同上，经统一入口透传，退出码 0
- `node contracts/validate.mjs --report <报告> --exit-code 0` → 校验一份真实 `console run mac2win doctor` 产出的报告，`✓ 契约自洽`
- `node ai/bin/wacmin.mjs doctor mac2win --report` → 统一报告结构
- `node console/scripts/viewport-check.mjs` → 三档 0 处越界

**本轮未跑、只做了静态核对的**（不得视为已验证）：

- `mac2win build`（**去掉 `--dry-run` 的真构建**）与 `verify`（需要完整构建产物，本轮未做。`--dry-run` 分支已实跑）
- `wepack install` / `build` / `extract`（需要安装包样本；`install`/`build` 的端到端已在 run-20261119-0753 验过，本轮未复跑）
- `win2mac build` / `verify`、`apponwin assess` / `parse`（需 Windows 宿主或 `.app` 样本）
- `console web`（会常驻监听端口，无人值守环境不适合）
- README 中的 `--dry-run`、`--keep-staging`、`--framework` 等示例参数**只核对了 help 里存在该项**，未逐个跑通

**静态核对通过的项目**：

- HTTP 端点：`mac2win` 8 个（`state`/`preflight`/`build`/`cancel`/`verify`/`probe`/`reveal`/`events`）、`console` 4 个（`history`/`status`/`contract`/`run`），与 10.4 表逐项一致；
- 阶段划分：Mac2Win 八阶段与 `builder.mjs` 的 `STAGES` 及权重（1/3/4/2/4/2/5/3）完全一致；ExeOnMac 八阶段与 `report.py` 的 `STAGES` 完全一致；
- 测试计数：七套全部 0 skipped；**具体数字以 12.1 为准，此处不再抄写**（本轮初稿曾在此处硬编码一份合计，随后 apponwin 增加 3 项测试，这行立刻过期——正是本节所批评的「同一数字存多处必然漂移」）；
- 环境变量 13 个全部在代码中被真实读取（逐个 grep 到非测试文件）；
- MCP 工具 6 个，与 `ai/src/tools.mjs` 一致。

**这轮巡检本身的教训**：9 处里有 4 处（#5 #6 #7 #8）是**数字与引用**，不是文字。数字过了期不会有人发现，因为它读起来毫无破绽——这与 12.1 记的「同一个数字只许有一个写入点」是同一件事的两面。附录 C 的自检清单本身没有机器守卫，所以它会漂。**下一步应把它也纳入 `contracts/doc-counts.mjs` 的检查范围**，让这类数字由脚本读出来，而不是靠人去数。

#### 15.3.2 附录 C 补上机器守卫（2026-11-20，优化循环第 1 轮）

上一节留下的那条待办已闭环。附录 C 有 8 个人手数出来的数字，此前**没有任何东西在核对它们**。

**修前的失明是实测的，不是推断**：把中文版「37 个配置项全表（9.2）」改成 `32`、把「二十五条亮点」改成「二十条亮点」，然后跑 `node contracts/doc-counts.mjs --check` —— 输出仍是 `✓ 12.1 计数一致：7 个模块合计 1287 项`，退出码 0。守卫形同不存在。

**修法**：新增 `contracts/appendix-guard.mjs`，把 8 个数字全部改成**从真源现读再对账**，一个都不背：

| 附录 C 的说法 | 真源 | 读法 |
|---|---|---|
| 37 个配置项（9.2） | `mac2win/src/core/config.mjs` 的 `DEFAULTS` | `import` 后数键，并与 9.2 首表行数**交叉验证** |
| 13 个环境变量（9.3） | 9.3 表 | 数数据行 |
| 18 项外部工具（6.2） | 6.2 表 | 数数据行，并与 `NOTICE` 第三章**交叉验证** |
| 6 个子命令族（10.1） | 10.1 首表 | 数数据行 |
| 二十五条亮点 | `#### 亮点` 标题 | 数标题 |
| 第 5 章 11 节 | `### 5.` 标题 | 数标题 |
| `NOTICE` 十三节 | `NOTICE` 顶层编号章 | 数 `## 一、`…，并校验章号从 1 起连续 |
| 校验项 11 项（15.6） | 15.6 表 | 数数据行 |

**为什么必须交叉验证**：配置项在代码（`DEFAULTS` 37 键）与文档（9.2 表 37 行）各存一份，外部工具在 6.2 与 `NOTICE` 第三章各存一份。只对附录 C 与其中一侧，另一侧漂了照样绿。实测注掉交叉验证后，把 `DEFAULTS` 加一个键、9.2 表不动，守卫只报「附录 C 写 37、实际 38」，**不会告诉你 9.2 表也过期了**。

**接入点只有一个**：`contracts/doc-counts.mjs --check` 现在同时跑 12.1 与附录 C。CI 的 `ci.yml` 与 18.2 检查块早就在跑这条命令，因此无需改 workflow，也就不会出现「新命令没人记得跑」。另有两个只跑一半的入口 `--check-counts` / `--check-appendix`，专供测试夹具用 —— 12.1 的夹具只造两份 README，附录 C 的夹具还要 `NOTICE` 与 `config.mjs`，混在一个入口会让两边都被迫造一堆无关文件。

**负向验证（9 条，全部有效）**：8 个数字各改一处 → 每个都被点名，报错格式统一为「附录 C 写 X ⟨事实⟩，实际 Y（⟨真源⟩）」，例如 `附录 C 写 32 配置项数，实际 37（config.mjs 的 DEFAULTS 键数）`。另加一组「真源变化、附录 C 不动」：9.3 表加一行、`DEFAULTS` 加一键、`NOTICE` 第三章加一行、删一个亮点标题 —— 四种都被抓到。**注回旧实现**（去掉 `checkAppendix` 那一行）→ `appendix-guard.test.mjs` 立刻 **9 项变红**，还原后 32/32 绿。

**这一条与 12.1 是同一个病的两个病灶**：12.1 治的是「测试计数」，附录 C 治的是「文档事实」，共同点是**数字由人数、没有复算路径**。只要一个数字存在两处而没有脚本对账，它迟早会分叉 —— 差别只是被人发现，还是被用户发现。

**本轮顺带抓到一个潜伏更久的缺陷（在 `doc-counts.mjs` 里，不是新写的）**：`parseCountTable` 号称「读 12.1 表格」，实际扫描的是**整份 README** 的所有表格行，同名行后写覆盖先写。平时不出事，因为 12.1 只此一张；但 15.13 记交付体检时加了一张历史对照表，里面也有 `| contracts | 79 | 58（且 1 项红）|` —— 它排在 12.1 之后，于是 `--check` 读到的 contracts 是 **79**，而 12.1 明明写着 111。

发现它的过程值得记：这次给 12.1 的 contracts 从 79 改成 111、合计从 1287 改成 1319，`--check` 报「合计写 1319，但分项之和是 1287」。数字算错的可能先被怀疑，但算式是 167+453+130+96+230+132+111=1319，没错。再查才发现 calc 读的是 300 行之外那张历史表。**这个缺陷不会误报**（合计与分项出自同一份错读，加总仍自洽），只有在改了真值时才会暴露，所以它能潜伏很久。

修法：先裁到 `### 12.1` 一节再解析（找不到该标题时退回全文，而不是返回空表 —— 空表会让报错变成「表格缺 7 个模块」，掩盖真因）。新增 2 项守卫：一张排在 12.1 之后、含同名 `contracts` 行的旁证表不得影响读数；标题找不到时退回全文而非空表。**负向验证**：注回「整份扫描」→ 2 项立刻变红，还原后 17/17 绿。

15.13 那张历史表同时加了一句说明，标明它是快照、不随代码更新、`doc-counts.mjs` 不会读到它 —— 否则下一个读到那行 `contracts | 79` 的人会以为 12.1 还没更新。

除了「漏写」，还有一类反向问题——**help 承诺了但代码没实现**（早先 `--no-package` 就是这样）。两个方向都要守，所以每个方向的 help 测试都是双向断言的（Node 侧 `test/help.test.mjs`，`wepack` 侧 `tests/test_phase0.py` + `test_phase6.py`）。

### 15.4 校验器说谎的那一次

这一节单独写，因为它是目前遇到过的**最危险**的一类缺陷：程序没崩、测试全绿、结论明确，但结论是假的。

**现象**：在一台没装 7-Zip 的机器上跑 `mac2win verify xxx-setup.exe`，输出末尾是「✓ 校验通过」，退出码 0。

**实际验了什么**：只有 PE 头。载荷里装了什么、`node.exe` 是 32 位还是 64 位、必需文件在不在、4000 多个文件的哈希对不对——**一项都没验**。

**为什么**：`VerifyReport.ok` 只看有没有 `fail` 项；「找不到 7-Zip，跳过解包校验」这一条记成了 `warn`。`warn` 不影响 `ok`，于是报告 `ok === true`，CLI 照着打印「通过」。

**为什么比崩溃更糟**：校验失败会让人去查；假的通过不会。用户拿到的是一个只验了文件头的安装包，配上「已通过校验」的结论，然后去分发。

**修法**：把结论拆成两个正交维度，见 5.4.1。同时补了两处配套修正：

- **`find7zip()` 的发现范围**。原来只查几个固定绝对路径加 PATH。实测那台机器上 PATH 里的 `7zz` 是构建沙箱的包装脚本（跑起来报 `spawnSync 7zz ENOENT`），Homebrew 也没装——但 BlueStacks 和 Parallels 各自带了一份**能用的** 7-Zip，就在 `/Applications/*.app/Contents/MacOS/` 里。「没装」和「装了你找不到」是两件事：前者要用户动手，后者是工具失职。
- **探测逻辑不能只看退出码**。`/bin/echo i` 的退出码也是 0，早期实现会把它认成 7-Zip。误用后果很隐蔽：后面的 `l -slt` 拿到一堆无关文本，解析不出清单，最后报「载荷文件数 0」——看起来像安装包坏了。现在改为校验输出特征（既有 `7-Zip` 又有 `Formats:`）。

界面同一处也改了：原来写「`result.verify.length` 项通过」——那是**全部项**，包括 `warn` 和没验的。10 项里 5 项没验，界面照样写「10 项通过」。现在分四种口径，未验证时用橙色而非绿色。

`MAC2WIN_NO_7ZIP=1` 是为这条分支留的逃生门。不是为凑覆盖率：缺 7-Zip 的决定性分支只在**用户机器恰好没装**时才会走到，开发者机器上大概率装了，可能一年没人跑过——真踩到时用户得到的就是一份撒了谎的报告。

### 15.5 「校验器在撒谎」的第二个形态

`target: "x64"` 在配置里可选、预检说「可行」，但实现层有三处写死 x86：

| 层 | 写死的内容 | 后果 |
|---|---|---|
| 运行时下载 | 文件名 `node-v22.23.5-win-x86.zip` | 下的是 32 位运行时 |
| 缓存目录 | `node-22.23.5-win-x86/` | 两个架构互相覆盖 |
| 架构断言 | 要求 `isX86 === true` | 32 位载荷被判定通过 |
| 校验器 | `'目标架构 x86'` | 报告里写着「x86 通过」 |

合起来的效果：`--target x64` 产出一个标称 64 位、实际 32 位的包，**而且所有检查都盖章通过**。这比直接报错危险得多。

**修法**：平台标识按目标生成（Node 用 `win-x86` / `win-x64`，不是 Electron 的 `win32-ia32`）；缓存目录按架构分开；断言改为「PE 机器类型 === 目标期望值」；校验器按 `expectTarget` 断言，并把检查项标题写成「目标架构 x64」。

**一个必须澄清的语义**：修完后第一次跑 x64 会失败：

```
✗ 目标架构 x64：实际是 i386，不是 x86-64
```

但解开载荷一看，里面的 `node.exe` 是 `PE32+ / x86-64`——**应用本体是对的**。原因是 NSIS 编译出的 exe 永远是 i386 桩程序，它只是安装器。所以校验规则改成区分两个对象：

| 对象 | 期望 |
|---|---|
| 安装器外壳 | `PE32 / i386 / GUI`（NSIS 固定形态） |
| 载荷内 `node.exe` | 按 `target` 决定：`i386` 或 `x86-64` |

实测两个目标：`--target x86` → 外壳 `PE32/i386` + 载荷 `PE32/i386`；`--target x64` → 外壳 `PE32/i386` + 载荷 `PE32+/x86-64`。反向验证：拿 32 位产物按 x64 目标校验，正确拒绝。

### 15.6 「九项校验」与实际十一项的偏离

文档曾长期写「九项产物校验」，实测为 11 项。根因是校验项后来增加过（拆分了必需文件、新增了安装器外壳格式），文档未同步。

**实测的 11 项**：

| 校验项 | 判据 | 失败说明什么 |
|---|---|---|
| 产物存在 | 文件可读 | 打包失败 |
| 安装器外壳格式 | `MZ` + `PE\0\0` 签名 | 不是 Windows 可执行文件 |
| 应用本体架构 | 目标 `x86` 时断言载荷内运行时为 i386；安装器外壳恒为 32 位 NSIS，不计入本体判据 | 装到目标机上架构不符 |
| GUI 子系统 | 可选头 subsystem = `2` | 双击会弹控制台黑框 |
| 安装包格式 | 7-Zip 识别为 NSIS | 载荷结构损坏 |
| 载荷文件数 | > 0 | 空包 |
| 必需文件 `node.exe` | 在载荷中存在 | 装完启动不了 |
| 必需文件 `bootstrap.mjs` | 在载荷中存在 | 装完启动不了 |
| 必需文件 `launch.json` | 在载荷中存在 | 启动参数缺失 |
| 载荷内 `node.exe` 架构 | PE32 / i386 | 运行时架构错 |
| 文件哈希 | 逐文件 SHA-256 与构建清单比对 | 压缩/解压过程中文件损坏 |

**这 11 项只在「构建后校验」时全部出现**。`mac2win verify <已有安装包>` 没有构建清单，无法比对哈希，因此是 **10 项**——差的那一项就是「文件哈希」。这是设计使然而非缺陷：哈希的作用是证明「产物与刚构建出来时逐字节一致」，对一个来源不明的安装包无从证明。诚实报 10 项比伪称 11 项全绿更重要。

### 15.7 其他已修正的缺陷

| 缺陷 | 症状 | 根因 | 修复 |
|---|---|---|---|
| 软链循环导致打包卡死 | 6 分钟无进展，目录膨胀到 374 MB | `fs.cp({dereference:true})` 展开循环软链 | 按 `(dev, inode)` 去重 |
| 软链被当文件拷 | 单目录拷贝产出 44346 文件 / 410 MB | `Dirent.isDirectory()` 对软链返回 false，于是被当文件 `copyFile`，等于展开整个 `.pnpm` | 软链单独 `stat` 后按目标类型处理 |
| 载荷路径多一层 `app/` | 校验报「必需文件找不到」 | `File /r` 展开内容不含源目录名 | `SetOutPath` 补 `app` 层 |
| `WriteRegStr` 参数个数错 | makensis 报 `expects 4 parameters` | 把 `HKCU\Software\...` 合并成一个参数 | 根键与子键分开 |
| `File` 路径混用分隔符 | makensis 找不到文件 | 拼成 `"/tmp/app\*.*"` | 统一为 `/` |
| 改名后启动器找不到壳 | 双击闪退 | `launch.json` 写的是 `nw.exe`，实际已改名 | 记录重打包返回的真实名字 + 兜底扫描 |
| 开浏览器失败导致应用退出 | 日志报 `spawn cmd ENOENT` 后进程死 | `spawn` 的 error 事件未挂监听，冒到 `uncaughtException` | 挂 `error` 监听，降级为日志 |
| 校验阶段被安全策略拦截 | 构建成功但报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` | 解出 4088 个文件后批量删除 | 改为解包后立即删单目录，不批量 |
| 校验耗时 10 分钟未完成 | 卡在「流式比对哈希」 | 每个文件调一次 `7zz x -so`，4086 个文件 = 4086 次进程创建 | 改为一次解包 + 本地哈希 |
| 解包后多一层顶层目录 | `node.exe` 在 `node-v22.23.5-win-x86/` 下 | 官方 zip 内部有前缀目录 | 解包后摊平单层根 |
| `which 7zz` 拿到包装脚本 | 校验报「安装包损坏」 | PATH 里有同名 shim | 每个候选真跑一次 `7zz i` 验证 |
| 依赖收集漏传递依赖 | 产物启动报 `Cannot find package 'cosmokit'` | 只从 import 图收包，没展开各包声明的 `dependencies` | 两阶段收集：先扫 import，再按 `package.json` 展开闭包 |
| pnpm 布局导致依赖拷不全 | 同上 | `cordis-host/node_modules/@ntars/cordis` 是软链，它的依赖在上一层的 `node_modules` | 按收集结果重建扁平 `node_modules` |
| 依赖收多了 | 收到 `@napi-rs/canvas-darwin-arm64`、`node-gyp-build` 等 | 扫整个 `.pnpm` 同级目录，把 devDependencies 也收了 | 只读包自己 `package.json` 的 `dependencies` |
| `cfb` 解析把 `_StringPool` 当乱码 | MSI 流名全部解析失败 | 流名是私有编码 | 改用根存储 CLSID 判定 + 内容特征识别流 |
| NSIS 识别漏判 | 真实样本被判成 `unknown` | 按 `overlay+0` 判 `DEADBEEF`，实际签名在 `+4` | 修正偏移 |
| 解包判 `File` 表行数错 | 尾部数据被当成行内容 | 认为行数 = 总 u16 数 ÷ 列数 | 按内容特征（连续 `fil`+32hex）定行数 |
| 中文应用名撞 bundle id | 11 个名字只产出 1 个 id | `[^a-z0-9-.]` 把中文整段吃掉 | 非 ASCII 时挂 8 位 SHA-256 前缀 |
| 预检错误码映射表键名写错 | 在 Linux / Windows 上构建报「项目目录不存在」，用户去查路径拼写而真因是宿主不支持 | `CHECK_ERROR_CODES` 里写的是 `host-os` / `native-window`，源码里实际用的 id 是 `host-platform` / `framework-shell`。键名对不上不报错，只会静默落进 `?? PROJECT_NOT_FOUND` 兜底 | 改为实际 id，并加一条源码扫描测试：映射表的键必须在 `new Check()` 里出现过，会 fail 的检查项必须显式归码 |
| `apponwin spike` 把「路径打错」判成「方向被证伪」 | `spike --app /nope.app` 输出「本方向按设计降级为兼容性评估工具」、退出码 1；同一路径喂 `assess` 得到退出码 2 | 门槛 3 的 `catch` 把 `BuildError(INPUT_NOT_FOUND)` 一并记成 `fail`，而 `fail` 的语义是「实测执行并失败」——路径不存在时门槛压根没执行。`fail` 一旦出现，整体结论就是 `rejected` | 输入不合法单独归 `blocked` + `invalidInput` 标记，`runSpike` 汇总成 `inputErrors`，CLI 据此走退出码 2 / `AOW_1002`；门槛 1 把样本路径校验提到探测环境之前，否则环境缺失时永远看不到「路径写错」这条最该先看到的提示 |
| `contracts/validate.mjs` 把范围写法切成两个端点 | 一份 `exitCode: 6` 配 `M2W_4002` 的报告被判「退出码与错误码不一致」，而 4002 完全合法 | 用 `split(/[/-]/)` 解析 `errorSegment`：`"4001-5002"` 被切成 `['4001','5002']`，范围内的中值既不等于下界也不等于上界。长期未发现是因为真实报告多命中端点（4001 / 5002），端点恰好就是切分结果 | 抽出 `segmentAllows()` 分别处理 `-` 与 `/`；测试不只测 4002，而是把 `4001/4002/4003/5001/5002` 与 `6001/6002/6003` 全部跑一遍 —— 只测端点等于没测 |
| `win2mac --strict-host` 的报告自相矛盾 | `--strict-host` 退出码 2 配 `W2M_1001`，而契约 13 条退出码里没有任何一条声明过 1001 | 抛的是 `HOST_UNSUPPORTED`（1001），`exitCodeFor` 按段位兜底给出 2。用户收到的信号是「参数错误」，会去查路径拼写，真因是「这台机器不能干这件事」 | 改抛 `UNSUPPORTED`（1005 → 退出码 4，明确不支持）；`doctor` 的失败归码同理由 1001 改为 `TOOL_OUTDATED`（2002 → 退出码 5，doctor 的唯一失败原因就是 Node 版本过低）。`apponwin doctor` 同一处同形态缺陷一并修掉 |
| 契约缺 `3000` 段（运行时）的退出码声明 | `M2W_3001/3002/3003` 在代码里映射到退出码 5，而契约 `exit 5` 只声明 `2001/2002` | 契约文件维护滞后于实现：三个方向都预留了运行时错误码，mac2win 真的在用（Electron/NW.js 下载与架构校验），但没人回来补契约 | 本轮**未改契约**（改契约属于对外承诺变更，需人工确认），已在 15.9 列为待决项 |
| 契约检查按钮在 click 里设 `disabled`，键盘回车当场丢焦点 | 鼠标点得动，键盘按回车后焦点掉到 `<body>`、读屏从头重念；要够到面板里的「关闭」得再按 12 次 Tab；关闭后同样掉回 `body`。前三段视口检查全绿 | `Enter` 是 keydown → click → keyup 三步，click 里设 `disabled` 让元素不再是焦点目标，浏览器把焦点退回文档根，紧随的 keyup 无处投递。程序化 `.click()` 没有后续 keyup，所以复现不出来，此前所有测试都绿着 | 防重入改用布尔量 + `aria-disabled`（只改语义、不改可聚焦性）；面板加 `tabindex="-1"` 并在检查完成后 `panel.focus()`；关闭时主动把焦点交回触发按钮。判据进 `viewport-check.mjs` 第 5 段，用真实按键 + 全程 `focusin`/`focusout` 轨迹判 |
| launcher 收不到 SIGTERM，只能 `kill -9` | 关掉 ExeOnMac 产物时进程不退出；实测 SIGTERM 后 90 秒仍在运行，`launcher.log` 里连「收到信号」都没有 | `DispatchSource.makeSignalSource(queue: .main)`：`.main` 队列的 handler 由 **main run loop** 调度，而 `WineRunner.run` 用 `Thread.sleep(0.2)` 轮询子进程、一路不跑 run loop。`signal(sig, SIG_IGN)` 又把默认处置吃掉了，于是信号既不触发 handler 也不终止进程。**每个用例因此白等 60 秒兜底超时，测试还一直是绿的** | 信号源改挂独立串行队列（`DispatchQueue(label: "com.wexe.launcher.signal")`）。实测 SIGTERM 后 **0.19 秒**退出、日志出现「收到信号 15」与「wine 退出 status=15」；测试从 63.3 秒降到 3.1 秒。补两层守卫：`test_phase0` 静态断言队列不是 `.main`（防写法回退），`test_phase3` 断言「日志出现收到信号」+「20 秒内退出」（防行为回退），两者均做过负向验证 |
| 打包对「半坏 prefix」照样报成功 | `system.reg` / `user.reg` / `userdef.reg` 全删、或 `system32` 被清空、或 `dosdevices/c:` 换成普通文件之后，`wepack package` 仍 `EXIT=0`、`ok=true`、校验 10/10 全绿；而同一份 prefix 交给 wine 直接 `could not load kernel32.dll, status c0000135`（rc=53） | 装配侧第 7 项校验只断言 `Private/drive_c` **是个目录**。prefix 是否可用，`install` 侧一直用 `prefix.validate_prefix()` 判（五项），装配侧却另写了一套更宽松的判据 —— 同一条业务规则两套实现，宽松那套恰在最后一道关口上（§5.3 红线）。测试夹具也只建 `drive_c/App/`，造出来的 prefix 本身起不来，两边一起宽松所以永远绿 | 第 7 项改为调 `prefix.validate_prefix()`，项名 `prefix.drive_c` → `prefix.valid`，失败时逐项点名缺失。补 7 项回归锁（5 项判据 + 2 项 stdout 契约），注回旧判据 5 项全红。「健康判过」那条同时防矫枉过正。夹具按 `validate_prefix` 的最低要求造齐（system32 非空、`dosdevices/c:` 相对软链、三个 `.reg` 非空） |
| 字体替换从未生效过 | 日志写「fontsub 已导入 2 条替换」，注册表里一个键都没有；界面中文显示为方块。而 `regedit /S` **退出码 0、stderr 空**，看不出任何异常 | `fontsub.reg` 用的是 wine **内部格式**（`WINE REGISTRY Version 2` + 双反斜杠键）。实测同一份内容：内部格式零键写入，导出格式两条都写进去。与第 7 轮 `install.suppress_restart` 同一根因（把导出格式当存储格式），当时只改 Python 侧、Swift 这份没被同一条判据扫到 | 改写为导出格式（`Windows Registry Editor Version 5.00` + 根键全名 + 单反斜杠）；导入后不再凭退出码判成功，改为「同一份 .reg 里写一枚 UUID 戳，查戳在不在」。补 5 项静态守卫，四处负向验证均有效。**注：根键当轮取 `HKEY_CURRENT_USER`，该值在第 12 轮被证明无效，见 15.24**。详见 15.23 |
| 长路径断在词中间 | 页面不溢出、测试全绿，但 139 字符路径在 375px 下被断成 4–5 行，断点落在 `Framewo\|rks`、`dir\|ectory` 这类词正中间；三档合计 **15 处**（口径：断点两侧都属于 `[A-Za-z0-9._]`） | 为解决溢出用了 `overflow-wrap: anywhere`，它只在**任意字符之间**找断点，不利用 `/` `\\` `-` 这些天然边界；`.result-val` 还额外带 `word-break: break-all`，它**无视** `<wbr>` | 新增纯函数 `pathSegments()` 按分隔符切片、`app.js` 的 `writeText()` 逐片 `append(Text)` 并在分隔符后插 `<wbr>`，`el()` 统一走它；`.result-val` 的 `break-all` 换成 `overflow-wrap: anywhere`。修后三档 0 处。压测改为 `import('./app.js')` 调产品函数，否则压测量的是它自己 |
| 注册表文件「存在且非空」就判健康 | 把 `system.reg` 换成 35 字节纯文本，`validate_prefix` 返回 `[]`、打包校验 10/10 全绿；同一份 prefix 交给 wine 直接 `system.reg is not a valid registry file` + 「32-bit installation」、`rc=1`。`user.reg` 坏掉更隐蔽：`reg add` 返 0 但键没落盘 | 判据只看 `is_file()` 与 `st_size > 0`，从不读内容。测试夹具写的也是坏格式（UTF-16LE+BOM、无 `#arch`），**夹具造出的 prefix 自己就跑不起来** —— 判据与夹具一起宽松，缺陷永远绿 | 新增 `_check_reg_file()`：首行必须是 `WINE REGISTRY Version 2`（三个文件都查），`system.reg` 另须含 `#arch=win64`。三档致命程度实测分开，`user.reg`/`userdef.reg` 不要求 arch（否则误报）。两条夹具一并改正，常量从 `wepack.prefix` 导入 |
| 占位注册表写的是 wine 不收的格式 | `prefix._write_placeholder_regs` 写的占位表让 wine 报 `not a valid registry file` + 「32-bit installation」、`rc=1` —— 占位表的存在意义正是「让 wine 能起来」 | 自述「wine 的 .reg 是 UTF-16LE + BOM」，而那句话只对 `regedit /E` 的**导出**文件成立；prefix 里的存储格式是纯 ASCII，且必须带 `#arch=win64` | 改纯 ASCII + `#arch=win64`。实测 `rc=0`，wine 自己把占位补全成 20 万字节完整注册表 |
| 重启拦截的 `.reg` 从来没生效过 | `suppress_restart` 日志写 `reboot.suppressed`，实际一个键都没写进去；导入后 `reg query` 查不到 `NoClose` | 用 wine **内部**存储格式（`WINE REGISTRY Version 2` + 相对路径 `[Software\\...]`）喂 `regedit /S`，而它只认 **Windows 导出**格式。实测喂错格式时**退出码 0、stderr 空、零写入** —— 三组对照才切开 | 改 `Windows Registry Editor Version 5.00` + 绝对键路径；导入后回查目标键，查不到写 `WARN reboot.suppress_ineffective` 而非 INFO。`regedit /S` 静默失败，「没抛异常」不能证明生效 |
| `package --json` 失败时 stdout 两段 JSON | `wepack package <坏包> --json` 的 stdout 是「完整 payload + main 的 error 段」两段拼接，`json.load` 抛 `Extra data: line 79`，管道交给 `jq` 也直接失败 | `cmd_package` 无条件 `_emit(payload)` 之后才 `raise VerifyFailed`。与 W-02 修过的「`build --json` 两段 JSON」同因，只是发生在单个子命令内部而非父子命令之间 | 改为先判 `report.ok`：失败时只由 `main()` 输出单一段 error（带 `message` 与 `exit_code`），详细 checks 走 stderr 与 `--report`。`raw_decode` 实测修复前段数 2 → 修复后 1；回归锁 2 项，注回旧顺序即变红 |
| 测试模块导入即编译安装包，整类用例静默消失 | 跑单个测试类 `python3 -m unittest tests.test_phase2.TestCliPhase2` → `FAILED (errors=2)`、`RuntimeError: ISCC 编译失败（退出码 0）：`，而 detail 是**空的**；全量 `discover` 按字母序跑却一直是绿的 | `test_phase1.py` 在**模块顶层**求值 `REAL_INNO = str(fixtures.demo_inno_real() or "")`，导入即编译安装包；`test_phase2` 只为借两个纯字节构造函数就 `import tests.test_phase1`，而它的 `setUp` 已把 `WEXE_HOME` 指向临时目录并塞了一个只 `exit 0` 的假 wine → ISCC 被假 wine「跑」了、什么都没编、退出码干净 | 四个样本常量改为惰性函数（进程内缓存），四个类改用 `setUpClass` + `require_sample()` 拿不到就 `SkipTest`。装饰器在导入时求值，`setUpClass` 在用例真跑时才求值 —— 分界线就在这里。另把「退出码 0 但无产物」与「编译失败」的报错分开，让失败自己说清是哪一类。补 2 项守卫（子进程埋哨兵 + `ast` 扫模块顶层），负向验证：注回常量 → 两条全红 |

| 判据写在模块顶层：导入即定论，跳过成了永久的 | `test_phase2` / `test_phase3` 顶层写 `SAMPLE_NSIS = ... demo_nsis()`，**导入这两个模块就会跑 `makensis`**；用哨兵假 `makensis` 实测 marker 出现，且失败报的正是 `makensis 编译失败（退出码 0）：`。`test_phase7_layers` 的两个 `@skipUnless(fixtures.wine_available())` 在导入时定型：`WEXE_HOME=/nonexistent` 下导入后 `__unittest_skip__` 恒为 `True` | 与 15.20 同一形态，但入口有三个：① 同一份 `SAMPLE_NSIS` 在三个文件里各写一套（违反 5.3）；② `REAL_WINE = fixtures.wine_available()` 看着无副作用，实际把结论在导入时定死；③ 装饰器参数同样在导入时求值，且挂在 `decorator_list` 上，静态扫描看不到 | 判据收进 `fixtures`（`sample_*()` / `require_sample()` / `wine_ready()`），`test_phase1` 改为同名引用，另三个文件删掉模块级常量改用 `setUpClass`；缓存键带上环境变量现值。守卫从「守一个模块」扩到全仓 6 个文件，并补扫描 `decorator_list` + 加一条扫描范围守卫（防 glob 返回空集导致全绿）。负向验证：注回模块级求值 → 静态 2 条 + 动态哨兵 → 2 项红；注回装饰器 → 1 项红 |
| launcher 在启动窗口内关不掉：信号「收下了」但没人执行 | 在 `runtime ready` 之后、`wine 已启动` 之前发 SIGTERM（固定延迟 0.8 / 1.0 / 1.2 秒各两次，**6/6 复现**）：日志写了「收到信号 15，正在停止 wine」，随后 `fontsub 已导入` 与 `wine 已启动` 照常出现，25 秒后进程仍在，只能 SIGKILL。日志本身完整、无异常 | ① `signal(sig, SIG_IGN)` 已吃掉默认处置；② handler 里是 `current?.terminate()`；③ 而 `current` 只由主程序登记，`FontSubstitution.apply` 里那次 `wine regedit /S`（实测约 3 秒）自己 new 了 `Process` 走 `waitUntilExit()`，**从不登记** → 空操作。第一版修法「记 pending」仍不通：主线程阻塞在 `waitUntilExit()` 里，走不到任何检查点 | 新增 `WineRunner.runChild` 作为全文件唯一的 `Process()`，`current` 语义从「主程序」改为「当前 wine 子进程」，apply 那次 regedit 也走它；handler 只调 `noteSignal(sig)`（先记再送达），不自己判空。`runChild` 返回 `Outcome` 枚举区分 `.stoppedBySignal` 与 `.finished(15)`，避免「被打断」被当成「导入失败」后仍启动主程序。顺带修正退出码：SIGINT/2、SIGTERM/15、SIGHUP/1 各自独立（修前一律 15）。5 项回归锁（假 wine 撑开窗口），两处负向验证各 3 项红 |

| 字体替换写进了没人读的注册表根键 | 15.23 修完格式后，键确实写进去了、戳也查得到、日志写「已导入 2 条替换」，但把 `lfFaceName` 设成「微软雅黑」再跑，`WINEDEBUG=+font` 里 `dump_gdi_font_subst` **没有这条映射**、`substituting` **0 次**、`select_font` 最终选中 `Courier New` —— 字还是方块 | launcher 写的是 `HKCU\...\FontSubstitutes`。`win32u.so` 里按 UTF-16 扫字符串只有 `\Registry\Machine\...\FontSubstitutes`，没有任何 `\Registry\User\` 对应项 —— **HKCU 那份是合法注册表数据，但没有代码去读它**。与 15.23 的格式错是两层独立的错：那层让数据进得去，这层才让它被读到 | 根键改 `HKEY_LOCAL_MACHINE`（实测 `substituting` 触发、`select_font` 选中 `PingFang SC Regular`）；戳同步搬到 HKLM（否则「查得到戳」只证明写进去了、不证明在 GDI 会读的树里，判据又退化成测存在）。三组对照坐实（HKCU 无效 / HKLM 有效 / `Wine\Fonts\Replacements` 有效但因是别名语义未采用）。守卫 6 → 7 项，其中旧那条断言写死了 HKCU —— **把错误结论写进了断言**，改代码时当场变红。详见 15.24 |
| 明明两条键都写了，DirectWrite 的软件还是方块 | 15.24 修好 GDI 后，把 `lfFaceName` 设成「微软雅黑」再跑，`select_font` 选中 `PingFang SC Regular`、`substituting` 触发；但换成走 DirectWrite 的程序（同一 prefix、同一份字体），中文仍是方块，`+font` 那侧一行日志都没有 | `FontSubstitutes` 是 GDI 专用：按 UTF-16 与 ASCII 两种编码扫 `lib/wine` 全部 ELF/PE，该字面量只在 `x86_64-unix/win32u.so` 里出现 1 处，`x86_64-windows/dwrite.dll` 里一处都没有；后者只认 `HKCU\Software\Wine\Fonts\Replacements`（单字节 ANSI），反汇编 `0x18000b8a5` 处指向该串、`RegOpenKeyA` 的根键实参是 `0x80000001` 即 HKEY_CURRENT_USER | 同一份 .reg 里两条键各写一份（根键正好相反：GDI 要 HKLM，DirectWrite 要 HKCU）；戳搬到 `HKCU\Software\Wine\ExeOnMac` 与 `replacePath` 同根。六组 PE 探针对照坐实：只写 HKLM 时 `familyCount` 292、查不到「微软雅黑」；只写 HKCU 时 293、查得到；两条同写仍 293、`HKLM` 那份换成 `Wine\Fonts\Replacements` 则 292 —— 根键比键名更关键。守卫 7 → 10 项（2 项扫真实二进制的两种编码、1 项断言两条键在同一份文件里），端到端断言改为 SIGTERM 后 `wineserver -k` 再读盘（`-w` 不回写，实测 0 次）。详见 15.25 |

### 15.8 跨平台可运行性巡检（2026-11-19）

这一节回答一个只能靠盘点才能回答的问题：**代码里那些「只在 Windows 上走」的分支，到底有没有被执行过**。

本机是 darwin + arm64。三个方向的宿主都是 Windows，所以它们的平台判断分支长期处于「写在那里、从没跑过」的状态。测试全绿并不代表这些分支是对的 —— 恰恰相反，**没跑过的分支出错时也不会报错**。

**扫描方法**：机械抽取，不靠眼看。对全部 `.mjs` / `.py` 源码用五条正则匹配平台判断（`process.platform ===/!==`、`platform() ===/!==`、`sys.platform`、`platform.system()`、`platform.machine()`），共命中 30 处。

**清单与覆盖状况**：

| 位置 | 分支 | 此前有测试 | 处置 |
|---|---|---|---|
| `mac2win/src/core/preflight.mjs:88` | 非 darwin → `host-platform` 判 fail | 仅测了归码，分支本身从未执行 | 平台与架构改为可注入，新增 7 项测试 |
| `win2mac/bin/win2mac.mjs:162` | 非 win32 → 警告或 `--strict-host` 拒绝 | 无 | 见下方缺陷记录；`--strict-host` 的错误码已修 |
| `win2mac/bin/win2mac.mjs:436` | 非 darwin → 不探 `plutil` | 无 | 已由 `verifyBundle` 注入测试间接覆盖 |
| `win2mac/src/core/verify.mjs:125` | 非 darwin → `plutilLint` 直接返回不可用 | 无 | 平台可注入，新增 3 项测试 |
| `win2mac/src/core/verify.mjs:332` | 按平台给不同的「未验证」警告 | 无 | 同上 |
| `win2mac/src/core/wexezip.mjs:140/167` | Windows 的 `stat().mode` 不可信 | **有**（5 项，注入平台） | 已是正确范式，本轮未动 |
| `apponwin/src/core/spike.mjs:83` | 非 win32 → WSL2 探测直接判不可用 | **有** | 已覆盖 |
| `apponwin/bin/apponwin.mjs:99/511` | 非 win32 → 警告不拦 | **有**（doctor 实跑） | 已覆盖 |
| `console/src/directions.mjs:199` | Windows 上不 detach | 无（该分支只影响 spawn 选项） | 与下一条同源，合并覆盖 |
| `console/src/directions.mjs:344` | Windows → `taskkill /t /f` | **无，且是超时与取消的唯一兜底** | 平台与 spawn 可注入，新增 5 项测试 |
| `exeonmac/wepack/cli.py:1817` | 非 arm64 → 无需 Rosetta | **有**（doctor 实跑断言名字与结果） | 已覆盖 |
| `exeonmac/wepack/report.py:146` | 平台字段归一化 | 无（纯输出字段） | 无行为分支，不补 |

**两条优先补的分支，理由**：

1. **`console` 的 `taskkill`** —— 它是超时与取消的**唯一**兜底。走错了症状是「用户点了取消、父进程报已取消，但 wine 还在后台装东西」，而所有测试照样全绿，因为父进程确实正常退出了。
2. **`mac2win` 的宿主判断** —— 走错了症状是「在 Linux 上跑，报『项目目录不存在』」，用户去查路径拼写、权限、软链，而真正该做的是换机器。

**三条缺陷**（都是实测发现，非推断）：

1. `win2mac --strict-host` 的退出码 2 配 `W2M_1001`，而契约 13 条退出码没有任何一条声明 1001。修法见 15.7。
2. `apponwin doctor` 与 `win2mac doctor` 的失败归码同属这一类，一并修掉。
3. `contracts/validate.mjs` 的**范围解析**把 `"4001-5002"` 切成两个端点，导致范围内的 4002 / 4003 / 5001 被判越界。这条不是平台问题，是本轮为了「用契约校验巡检报告」而撞出来的。

**仍然无法在本机验证的部分**（如实标注，不写成已验证）：

- 真实的 Windows 宿主行为：`taskkill` 的实际有效性、`detach: false` 下子进程组的表现、Windows 上 `wine` 的路径语义。
- WSL2 + Darling：需要 Windows 机器，见 15.2.1。
- 上表「已覆盖」项中的 `wepack` doctor 分支：它在本机跑的是 arm64 那条，非 arm64 那条（Intel mac）靠代码审读判定为直通返回，未实测。

注入式测试证明的是**判断逻辑**，不是**平台行为**。这个区别必须说清楚：`killTree` 的 5 项测试证明了「在 win32 上会调 `taskkill` 且参数带 `/t`」，不证明「`taskkill /t` 真的能杀掉 wine 的整棵进程树」。后者只能在 Windows 上跑。

### 15.10 Tauri Rust 壳的端到端实测（2026-11-19）

本节回答一个问题：**在 arm64 macOS 上，`cargo xwin` 到底能不能把一个真实的 Tauri v2 项目编成 Windows 原生窗口程序？**

结论分三层，每层都有实测，也都有明确的边界。

#### 15.10.1 结论总表

| 层次 | 结论 | 依据 |
|---|---|---|
| Rust 交叉编译链本身 | **成立**。能编出 `PE32 / i386 / windows-GUI` | 自写探针 `rsprobe`：92160 字节，`file` 判为 `PE32 executable (GUI) Intel 80386, for MS Windows` |
| Tauri **整棵依赖树**编译+链接 | **成立**。`tauri 2.12.7` + `wry 0.57.3` + `tao 0.37.3` + `webview2-com 0.39.1` 全部链接成 PE | 探针 `linkprobe`：1096192 字节，`PE32 executable (GUI) Intel 80386` |
| Tauri **完整项目**（含 `build.rs` 资源节） | **不成立**。卡在 `llvm-rc`，且 `brew install llvm` 解决不了 | `tauri-winres 0.3.7` panic：`NotAttempted("llvm-rc")` |

**所以「arm64 mac 编不出 Windows x86 程序」这句话是错的**（前两层的实测已证伪），但「完整 Tauri 项目能一次编成带图标和版本信息的原生窗口 exe」这句话**目前也不成立**（第三层卡住）。两句都不许写成定论 —— 它们的真值取决于你说的「编出」是哪一层。

#### 15.10.2 第一层与第二层：Rust 与整棵 Tauri 依赖树

探针 `linkprobe` 刻意**不调** `generate_context!()`、不写 `build.rs`，把资源编译这一步完全排除在实验之外，只验证「tauri 的依赖树能不能在 i686-pc-windows-msvc 上编译并链接成 PE」：

```rust
#![windows_subsystem = "windows"]

fn main() {
    let builder: tauri::Builder<tauri::Wry> = tauri::Builder::default();
    std::hint::black_box(&builder);
}
```

实测命令与结果：

```
CC_i686_pc_windows_msvc=clang-cl AR_i686_pc_windows_msvc=llvm-lib \
XWIN_ARCH=x86 XWIN_CACHE_DIR=<干净目录> \
cargo xwin build --target i686-pc-windows-msvc --release

→ Finished `release` profile [optimized] target(s) in 33.07s
→ linkprobe.exe  1096192 字节
→ file: PE32 executable (GUI) Intel 80386, for MS Windows
```

#### 15.10.3 第三层：真正的卡点是 `llvm-rc`，而且是**双重**卡点

完整项目（带 `build.rs` + `tauri.conf.json` + `icons/icon.ico`）在同一个环境下：

```
thread 'main' panicked at tauri-winres-0.3.7/src/lib.rs:543:14:
called `Result::unwrap()` on an `Err` value: NotAttempted("llvm-rc")
```

`llvm-rc` 的来源链是 `tauri-build` → `tauri-winres` → `embed-resource`。**第一重卡点**是它不在任何现成安装里：Xcode 的 LLVM 没有（`Toolchains/XcodeDefault.xctoolchain/usr/bin/` 只有 `llvm-cov` / `llvm-nm` / `llvm-objdump` 等十来个，无 `llvm-rc`），cargo-xwin 也只造 `clang-cl` 与 `lld-link` 两个 shim。

**第二重卡点更隐蔽**：`brew install llvm` 确实提供 `llvm-rc`（Homebrew 官方 Binaries 列表里明确列着），但装上之后**仍然不生效**。原因在 `embed-resource` 的编译器识别方式（`src/lib.rs:692` 的 `Compiler::llvm_rc`）：

```rust
pub fn llvm_rc(executable: Cow<'static, str>) -> Result<Compiler, Cow<'static, str>> {
    if_runnable(executable, |executable| {
        CompilerType::LlvmRc {
            has_no_preprocess: Command::new(executable)
                .arg("/?")
                .output().ok()
                .map(|out| memmem::find(&out.stdout, b"no-preprocess").is_some())
                .unwrap_or(false),
        }
    })
}
```

它要**执行** `llvm-rc /?` 并检查 stdout 里有没有 `no-preprocess` 字样。实测把 `RC` 指向一个只会 `exit 0` 的替身脚本，得到的是：

```
NotAttempted("Unknown RC compiler variant: /tmp/w06/fake-rc.sh")
```

也就是说「路径可用」不够，还得**回话格式对得上**。这一层说明：把 `llvm-rc` 装到 PATH 上就能通过，但任何「假装是 rc」的包装脚本都过不了这个探针。

#### 15.10.4 顺带修掉的两个真实缺陷

这两个都不是本轮引入，而且**都不会报错**，所以此前所有测试都是绿的。

**缺陷 A：`checkRustEnv` 对 `XWIN_ARCH` 的效果判断错误。**

`XWIN_ARCH=x86` 只影响 cargo-xwin **该下载什么**，不保证**已经下到了**。而 `cargo-xwin-0.23.1/src/compiler/clang_cl.rs` 的 `setup_msvc_crt` 有这样一段提前返回：

```rust
let done_mark_file_content = fs::read_to_string(&done_mark_file);
if let Ok(content) = &done_mark_file_content {
    let mut lines = content.lines();
    if let Some(archs) = lines.next() { /* 只读首行文本 */ }
}
if !update && xwin_arches.difference(&downloaded_arches).next().is_none() {
    return Ok(());   // ← 直接返回，从不校验文件是否真在
}
```

判据是 **`DONE` 文件首行的文本**，不是磁盘上的文件。本机实测到的具体不一致：

| 事实 | 值 |
|---|---|
| `xwin/DONE` 首行 | `x86`（自称已下载） |
| `xwin/crt/lib/` 实有 | 只有 `x86_64` |
| `xwin/sdk/lib/um/` 实有 | `aarch64`、`x86_64` |

后果：`cargo xwin build --target i686-pc-windows-msvc` 一路编完 130+ crate，在**链接**阶段才吐 10 条 `could not open 'user32.lib'`，而重跑同一命令仍是同一个错（`DONE` 说「有了」）。同一份代码把 `XWIN_CACHE_DIR` 指到干净目录后一次通过 —— 同一个二进制的 `crt/lib/x86` 与 `sdk/lib/um/x86` 各 63 与 482 个文件。

修法：`checkRustEnv` 新增 `x86-libs` 一项，判据直接查**磁盘目录**（`crt/lib/x86`、`sdk/lib/um/x86`），并支持 `XWIN_CACHE_DIR` 覆盖。用户能在编译**前**被告知，而不是等十几分钟。

**缺陷 B：`buildRustShell` 调用的 `cargo xwin` 不带 `TAURI_ENV_TARGET_TRIPLE`。**

`tauri` 的 `generate_context!()` 在**宿主**上展开，`tauri-codegen-2.7.6/src/context.rs:148` 读的是 `TAURI_ENV_TARGET_TRIPLE`，不是 `TARGET`。不设这个变量时它按宿主判定为 macOS，于是生成的代码里带上 `tauri::embed_plist::...` —— 而 `embed_plist` 在 `tauri-2.12.7/src/lib.rs:75` 被 `#[cfg(target_os = "macos")]` 门控，交叉编译到 Windows 时该门未开，报：

```
error[E0433]: cannot find `embed_plist` in `tauri`
```

实测对比（同一个项目、同一份缓存）：

| `TAURI_ENV_TARGET_TRIPLE` | 结果 |
|---|---|
| 不设 | `error[E0433]`，`generate_context!()` 展开失败 |
| 设为 `i686-pc-windows-msvc` | 编译通过（此时才走到 `llvm-rc` 那一关） |

修法：`buildRustShell` 显式传 `TAURI_ENV_TARGET_TRIPLE`，值由目标三元组拼出，不写死。

#### 15.10.5 关于「跳过 `tauri_build` 也能编出 exe」

实测中见过一种很有诱惑力的做法：在 `build.rs` 里判断「`llvm-rc` 不可用就跳过 `tauri_build`」，这样编译能「成功」，也确实产出 `.exe`。

**这是假成功。** 实测该 exe 的节表：

```
sections: [('.text', 5069064), ('.rdata', 989732), ('.data', 6888),
           ('.tls', 273), ('.reloc', 151920)]
has .rsrc: False
```

没有 `.rsrc` 节，意味着**图标、版本信息、应用清单全部缺失**。这种 exe 在 Windows 上会被 SmartScreen 当成无发行者程序，右键属性里没有版本页，任务栏图标是默认空白。它能双击运行，但它不是一个可交付的 Windows 程序。

所以本节明确：**不允许把「跳过 `tauri_build`」当作 Tauri 壳的降级方案**。要么补 `llvm-rc`，要么如实报错并退回「打包 Node/前端层」路线 —— 那条路线的产物是完整的（README 十二章的基线测试守的就是它）。

#### 15.10.6 仍未验证的部分

- **装好真 `llvm-rc` 之后的完整构建**。本机未装（`brew install llvm` 需下载 457 MB bottle、占 1.9 GB，属改变用户开发环境的操作，按仓库规矩不由定时任务自动执行）。因此「第三层成立」这句话本轮**不能写**。
- **产物的真实运行**：编出的 PE 从未在 Windows 上启动过，窗口是否真的出现、WebView2 是否加载，均未验证。
- **`ico` 图标文件的形态要求**：`tauri-build` 要求 `icons/icon.ico` 存在，否则直接报错。本轮实测项目用的是空 `icon: []` 配置，未测真实 `.ico`。


### 15.9 待人工确认：契约需补 `3000` 段

**问题**：`contracts/exit-codes.json` 的 `exit 5` 只声明 `errorSegment: "2001/2002"`，但三个方向的 `exitCodeFor` 都把 `3xxx` 映射到退出码 5，且 mac2win 真的在用：

| 码 | 用途 | 触发点 |
|---|---|---|
| `M2W_3001` | 运行时下载失败 | `electron.mjs:97/123`、`nwjs.mjs:89/115` |
| `M2W_3002` | 运行时校验和不匹配 | 运行时缓存校验 |
| `M2W_3003` | 运行时架构不对 | `runtime.mjs:315/323/331`、`electron.mjs:66` |

**为何不本轮直接改**：`exit-codes.json` 是**对外承诺**（文件首行写着「码值一经发布不再改动，只追加」）。给它加一个段位声明，等于告诉所有调用方「退出码 5 也可能来自运行时问题」，这是行为契约的扩张，不是修 bug。按本仓库的规矩，这类改动要列清单等人工点头。

**两个候选方案**（供决策，本轮不执行）：

| 方案 | 改动 | 代价 |
|---|---|---|
| A. 契约补声明 | `exit 5` 的 `errorSegment` 改为 `"2001/2002/3001-3003"` | 退出码 5 的语义从「缺外部工具」扩为「缺东西（含运行时）」。语义上说得通 —— 三者都是「环境里少了某样东西」，但下游若按 2001 特判「装个工具就好」会漏掉运行时类 |
| B. 实现改归码 | 把三个 3xxx 改到 `2001` / `5002` | 不需要动契约，但**丢掉「运行时」这一层区分**。用户看到 2001 会去 `brew install`，而真因是下载被墙或缓存损坏，处置动作完全不同 |

**倾向 A**：段位表里 `3000` 段本来就定义了（「运行时：下载失败、校验和不匹配、架构不对」），缺的只是退出码那一行的引用。B 会让已定义的段位变成死代码。

**需要人工确认的一句话**：`exit 5` 是否接受 `3001-3003`。确认后改动只涉及 `contracts/exit-codes.json` 一行 + `validate.test.mjs` 一条用例。

### 15.11 代码签名与公证的评估结论（2026-11-19，不执行）

这一节回答「要不要签、能不能签、要花多少」，**不含任何签名实现**——没有证书就没有可验证的实现，写了也只是无法测试的代码。

#### 15.11.1 先推翻一条旧结论

README 此前四处写着「签名在 macOS 上无法完成」（13.6、14.4、15.1、十七章第 7 项）。**这句话只对了一半，必须拆开**：

| 说法 | 实测 | 判定 |
|---|---|---|
| `codesign` / `notarytool` / `stapler` / `spctl` 在 macOS 上可用 | 四个工具全部存在：`codesign` 在 `/usr/bin`，`notarytool 1.1.4 (43)` 与 `stapler` 在 Xcode 内，`spctl --status` → `assessments enabled` | ✅ 事实 |
| Windows exe 的 Authenticode 签名必须在 Windows 上做 | `osslsigncode` 在 Homebrew 有 bottle（`stable 2.16`，依赖 `openssl@4`），按上游 README 可在 macOS 编译并运行，且支持 PKCS#11 硬件令牌与云端 PKCS#11 模块 | ❌ **不成立** |
| macOS 产物的公证必须在 macOS 上做 | `notarytool` 是 macOS/Xcode 独占 | ✅ 成立 |

**真正的障碍不是工具，是证书**。CA/Browser Forum 与 Microsoft/Apple 自 2023-06-01 起要求 OV/EV 代码签名私钥必须存放在 FIPS 140-2 Level 2+ 认证硬件里、且不可导出（来源：CA 侧文档 fairssl.com/en/code-signing-hsm-key-storage、sslmarket.com）。这条要求与操作系统无关——**换到 Windows 上一样得插令牌**。所以「在 macOS 上做不到」是个误诊，会让人误以为买台 Windows 机器就解决了。

#### 15.11.2 本机实测：现有产物处于「签名不一致」状态

这是本轮唯一能不看证书就验证的部分。做法是复刻 `wepack` 的真实装配结构，测四项判定。

**工具链事实**：`security find-identity -v -p codesigning` → `0 valid identities found`。Xcode 在 `/Applications/Xcode.app`，`xcode-select -p` 正常。即：**工具齐全，无证书**。

**对照实验结果**（同一份 Mach-O，两种签名状态）：

| 对象 | `codesign -v` | `spctl -a -t exec` | `--verify --deep --strict` |
|---|---|---|---|
| **A：现状（只换二进制进 bundle，未重签）** | **exit 1**<br>`code has no resources but signature indicates they must be present` | **exit 1**<br>同上 | **exit 1** |
| **B：对整个 bundle 一致重签（ad-hoc）** | exit 0 | exit 3<br>`rejected`（未公证，预期） | exit 0 |

**A 的成因**：`clang` / `swiftc` 产出的 arm64 可执行文件由**链接器自动附加 ad-hoc 签名**（`flags=0x20002(adhoc,linker-signed)`，`Signature=adhoc`）。此时签名只覆盖那一个可执行文件。`wepack` 随后把 `Info.plist`、`PkgInfo`、`Resources/` 一起组装进 bundle，**没有再签一次**，于是「签名声称自己有资源封印，但实际没有」——两者对不上。

**这不是理论风险**。实测复刻的产物（`launcher` 137464 字节真实编译产物 + Info.plist）`codesign -v` 直接退 1。用户拖进 `/Applications` 后在「系统设置」里看到的是校验失败，而不是「未公证」这种至少能解释的提示。

**复现命令**（用仓库真实 launcher 源码编译，按 `wepack` 的方式装配）：

```bash
cd exeonmac && python3 -c "
from pathlib import Path
from wepack.package.launcher_build import compile_launcher
print(compile_launcher(Path('/tmp/r/launcher'), use_cache=False))"
mkdir -p /tmp/r/R.app/Contents/MacOS && cp /tmp/r/launcher /tmp/r/R.app/Contents/MacOS/
/usr/libexec/PlistBuddy -c "Add :CFBundleExecutable string launcher" \
  -c "Add :CFBundleIdentifier string com.wacmin.repro" \
  -c "Add :CFBundlePackageType string APPL" /tmp/r/R.app/Contents/Info.plist
codesign -v /tmp/r/R.app ; echo "exit=$?"    # → exit=1，code has no resources…
codesign -s - --force /tmp/r/R.app
codesign -v /tmp/r/R.app ; echo "exit=$?"    # → exit=0
```

以上三条命令本轮实跑，输出与上表一致。

#### 15.11.3 但修不了：资源封印与 WINEPREFIX 存在架构级冲突

A 的修法很直接——自内向外重签每个内层可执行文件，最后签外层 bundle。**本轮已实测该修法有效**（`codesign -v` 由 1 变 0，`--strict` 也变 0）。但这条路在 ExeOnMac 上撞墙：

`launcher/Sources/main.swift:234` 写的是 `env["WINEPREFIX"] = layout.privateDir.path`，而 `privateDir` 指向 `Contents/Resources/Private`（同文件 `:66`）。也就是说 **wine 的整个 prefix 就住在 bundle 的 `Resources/` 里，且被原地读写**。

`codesign` 会把 `Contents/Resources` 下所有文件纳入资源封印。签名之后 wine 一写 prefix，封印立刻失效：

```
签名后       → codesign -v exit=0
改写 prefix  → S.app: a sealed resource is missing or invalid   exit=1
```

**对照实验**：把 `Private/` 挪出 bundle 外部，重签后再写 prefix → `codesign -v` 仍 exit 0。

**结论（决定性的）**：ExeOnMac 要么不签名，要么必须把 prefix 移出 bundle。后者是破坏性架构改动，牵动分层、`clonefile` 前缀克隆、卸载时清理、`recipe` 路径约定四处，不在评估轮动。**这是本轮最该被记住的一条**：签名不是「加个命令」，它会反过来约束目录布局。

顺带说明本题的边界：上述冲突只存在于 ExeOnMac。Mac2Win 的产物是 `.exe`（单文件 Authenticode，无资源封印概念），Win2Mac 的产物是纯静态目录（无原地写入的运行时状态）。

#### 15.11.4 逐方向结论

| 方向 | 产物 | 签名技术路径 | 可行性 | 卡点 |
|---|---|---|---|---|
| Mac2Win | `.exe` / `.zip` | `osslsigncode` + PKCS#11 令牌，或 CI 用 `windows-latest` 跑 `signtool` | **可行** | 只需证书，无技术障碍 |
| Win2Mac | `.app`（静态） | `codesign` → `notarytool submit` → `stapler staple` | **可行** | 需 Apple Developer ID（$99/年） |
| ExeOnMac | `.app`（含可写 prefix） | 同上 | **当前布局下不可行** | 见 15.11.3，须先改布局 |
| AppOnWin | 无产物 | — | 不适用 | 方向本身结论是「环境不具备」 |

**Win2Mac 的公证前置条件**（来源：Apple 公证要求与第三方实测记录）：bundle 内**每个**可执行文件都要有 Developer ID 签名、开启 hardened runtime、带安全时间戳、且不得含 `com.apple.security.get-task-allow` 权限。缺一条即 rejected。

#### 15.11.5 成本（2026-11-19 检索，非报价）

| 方案 | 费用 | 对中国大陆独立开发者的可用性 |
|---|---|---|
| Apple Developer Program | **$99/年**（来源：Apple 官方 enroll 页） | 可用，个人身份即可 |
| Windows OV 证书 | **$150–300/年**，含 SafeNet USB 令牌 | 可用（来源：Microsoft Learn 代码签名选项页） |
| Windows EV 证书 | **$400+/年** | 可用但**不再有免 SmartScreen 的特权**——Microsoft 自 2024 年起把 EV 与 OV 的 SmartScreen 行为拉平 |
| Azure Artifact Signing（原 Trusted Signing） | **$9.99/月** | **个人开发者仅限美国与加拿大**，中国大陆个人不适用（来源：同上 Microsoft 页面明确的地理限制） |
| 自签名证书 | 免费 | 仅本地测试。公开分发会被拦 |

**必须纠正一个常见误解**：签名**不保证**用户第一次下载就不见警告。Microsoft 官方页面写明新签名文件在积累足够声誉前仍会提示，OV 与 EV 表现相同。签名的实际收益是「发布者身份可信 + 警告更轻 + 可被 SmartScreen 逐版本继承」，不是「警告消失」。

**一个诚实的成本提醒**：Windows 侧令牌是 USB 硬件，**标准 RDP 无法转发**（CA 文档明确记录，需 TeamViewer 类工具）。若签名机是云端 Windows，这条会直接影响运维方式；改用 Azure Key Vault / DigiCert KeyLocker 等云 HSM 可绕开，但 KeyLocker 约 $300/年且限 1000 次签名。

#### 15.11.6 CI 侧可行性

仓库现有 `.github/workflows/ci.yml` 已使用 `ubuntu-latest` / `macos-latest` / `windows-latest` 三种 runner（`runs-on` 实测 7 处）。因此：

- Windows 签名：`windows-latest` 上 `signtool` 是 Windows SDK 自带，无需额外安装。证书走 GitHub Secrets（base64 的 pfx 或云 HSM 凭据）。
- macOS 签名公证：`macos-latest` 上 `codesign` / `notarytool` 自带。Apple 凭据走 `notarytool store-credentials` + Secrets。
- **但这属于「发布流水线」，不属于「测试流水线」**。当前 CI 只做测试与契约校验，没有任何 push 或发布动作；加签名等于同时加发布权限，属于对外行为变更。

#### 15.11.7 本轮不做什么（明确列出）

1. **不实现任何签名代码**。无证书则无法验证，写出来就是不可测的代码——与本仓库「不把未验证写成通过」的规矩冲突。
2. **不改 ExeOnMac 的 prefix 布局**。破坏性架构改动，须人工决策后单独排期。
3. **不改 `exit-codes.json`**。签名失败应归到哪个退出码是新的对外承诺，与 15.9 同类，等人工点头。
4. **不申请证书、不创建 CI Secret**。涉及资金与外部账号。

#### 15.11.8 建议的决策路径（供人工选择）

| 优先级 | 动作 | 理由 |
|---|---|---|
| 1 | 修 15.11.2 的签名不一致——**改为显式不加 ad-hoc 签名的干净产物，或整体重签** | 无需证书。前者零成本，后者需在装配末尾加一次 `codesign -s -`（本地 ad-hoc 不解决 Gatekeeper，但至少 `codesign -v` 自洽）。**二选一必须先定，因为「不一致」比「明确未签」更糟**：它让用户看到的是「损坏」而不是「未签名」 |
| 2 | 若要真分发 macOS 产物：买 $99 Apple 会员，**同时**决定 ExeOnMac 的 prefix 是否移出 bundle | 两件事耦合，不能只做一半 |
| 3 | Windows 侧签名：按发布量决定。年发布少于 10 次时，OV 证书 + `osslsigncode`（macOS 本地即可签）比搭 Windows CI 更省事 | 技术路径已验证可用 |

---

### 15.12 视口检查脚本的静默挂死（2026-11-19 已修）

**症状**：`node console/scripts/viewport-check.mjs` 在本机跑不起来 —— 不是报错，是**不返回**。既不输出表格也不退出，挂死 6 分钟以上，只能手工杀。这类故障比报错难查得多：报错会指出位置，挂死只留一片空白。

**逐层隔离（每一层都实测，不靠猜）**：

| 层 | 实测结果 |
|---|---|
| 本地服务 | 正常，`fetch` 返回 200 / 2470 字节 |
| Chrome 进程 | 能起，`DevToolsActivePort` 正常写出 |
| WebSocket | 能 open |
| `Target.createTarget` | 49 ms 返回 |
| `Target.attachToTarget` | 15 ms 返回 |
| `Page.enable` | **永不回包** |

根因是 Chrome 在本沙箱里**自建 sandbox 失败**（`sandbox initialization failed: Operation not permitted`），renderer 进程起不来，于是页面级命令全部无响应。追加 `--no-sandbox` 后 `Page.enable` / `Runtime.enable` / `evaluate 1+1=2` 全部立刻通过。

**代码层的真正缺陷不是缺 `--no-sandbox`，是 `CdpClient.send()` 没有超时**：

```js
// 修之前：Promise 永不 settle，超时与错误分支都不存在
send(method, params = {}, sessionId) {
  return new Promise((resolve_, reject) => {
    this.pending.set(id, { resolve: resolve_, reject })
    this.socket.send(JSON.stringify(frame))
  })
}
```

`once()` 有 15 秒超时，`send()` 没有 —— 这种不对称让最常用的那条路径成了唯一会挂死的地方。修法两层：

1. **`send()` 自带 20 秒超时**，超时后 `pending.delete(id)` 清槽、错误上打 `cdpTimeout = true` 标记、`clearTimeout` 防定时器吊住进程。
2. **只在 `cdpTimeout` 出现时降级重试一次 `--no-sandbox`**。不是无条件重试：找不到 Chrome、服务端没起、页面脚本抛异常都跟沙箱无关，重试只会把同一个错误再犯一遍并掩盖真实原因。降级事实通过 `fallbackReason` 同时写进人读输出与 `--json`，避免读报告的人误以为默认就是这么跑的。

**修后实测**：同一台机器同一条命令，从「挂死 6 分钟以上」变为 **26 秒完成**，三档 375 / 768 / 1440 基线与压测均 0 处越界、页面横向溢出 0px，退出码 0，并明确打印「首次以默认参数启动时 Page.enable 超时，已用 --no-sandbox 重跑一次」。

**回归锁**：`console/test/viewport-check.test.mjs` 新增 4 项（共 10 项），锁的是「有超时」「只在 cdpTimeout 时降级」「`--no-sandbox` 不在基础参数里」「降级必须外显」四条。三处负向验证各自都能把测试打红：去掉 `send` 的 `timeoutMs` 默认值 → 1 项红；把 `sandboxSuspected` 改成恒 `true` → 1 项红；把 `--no-sandbox` 写进基础参数数组 → 1 项红。三次还原后均 10/10 绿。

**这条缺陷值得记住的地方**：它从 W-01 起就在，`npm test` 一直是绿的 —— 因为视口脚本**不在** `npm test` 里（要起真实 Chrome，太慢）。于是它成了「没人跑就没人知道」的脚本。W-07 的定时任务发现了它但没有修（当时任务范围是签名评估），本轮才补上。**凡是不进测试套件的脚本，都要有一条「它真的能跑完」的守卫**，否则绿着的测试套件会给它背书。

### 15.13 干净 clone 的交付体检（2026-11-20 实测）

体检方法：把仓库 `git clone` 到 `/tmp` 下一个全新目录，**在那里**按 18.2 逐条跑，不借用原工作区的任何产物。这是唯一能验出「本地一切正常、别人克隆下来跑不通」的方式 —— 原工作区有大量被 `.gitignore` 挡住的缓存与编译产物，它们会让缺失的文件看起来存在。

**结论：第一遍没通过，且原因不在代码。** 详下。

**① 曾有一整批成果只在工作区、从未入库。** W-01 到 W-08 的改动一直没提交，克隆出来是 9 轮之前的旧快照：

| | 工作区 | 当初的 clone |
|---|---|---|
| 文件数 | 186 | 167 |
| mac2win / win2mac / apponwin | 167 / 130 / 96 | 132 / 121 / 91 |
| console | 230 | 215 |
| contracts | 79 | 58（且 1 项**红**）|
| exeonmac | 453 | 422 |

（这张是**历史快照**，记的是当时的数字，不随代码更新；当前值以 12.1 为准。`contracts` 一行的 79 / 58 都是旧数 —— 2026-11-20 加上附录 C 守卫后为 111。`doc-counts.mjs` 只读 12.1 那一节，不会读到这张表。）

那 1 项红是 `contracts/doc-counts.test.mjs` 里硬编码的 `合计 1150 项` 与实际 1165 对不上 —— 该缺陷在 W-01 已修，但修的那行没入库，所以旧快照里它又回来了。**「本机全绿」与「可交付」之间隔着一个 `git commit`**，这是本轮最该记住的一条。

**② 18.2 的检查代码块照抄必失败。** 旧写法是：

```bash
cd mac2win  && npm test
cd exeonmac && python3 -m unittest discover -s tests
```

第一行 `cd` 之后工作目录已在 `mac2win/` 里，第二行的 `cd exeonmac` 会按 `mac2win/exeonmac` 去找，实测报 `No such file or directory`，**整块退出码 1**。也就是说「按 README 一字不差地跑」这件事本身是跑不通的。已改为每行用子 shell 括起（`(cd mac2win && npm test)`），跑完自动回到仓库根目录；改后照抄实跑，六套测试与两条契约命令全部通过。

**③ 附录 B.2 的核对清单有两处封闭断言与实际不符。** 第 3 项写「Markdown 只有 `README.md` 与 `README_EN.md`」，实际索引里有 5 个；第 4 项写「只有 `LICENSE` 与 `NOTICE`」，实际有 3 个（含 `LICENSE-MIT`）。多出的三个 md 是 `LICENSING.md`、`ai/experts/wacmin-expert.md`、`ai/skills/wacmin/SKILL.md`，**都是产品内容，不是文档冗余**。照旧清单核对的人会把它们当成「不该入库的文档」删掉。已改为列出具体文件名与用途。

**④ 通过项（逐条实测，均可复核）**：

| 检查 | 命令 | 实测结果 |
|---|---|---|
| 垃圾文件 | `find . -name '.DS_Store' -o -name '._*' -o -name '__MACOSX'` | 工作区与 clone **均 0 个** |
| 索引内垃圾 | `git ls-files \| grep -E '\.DS_Store$\|/\._\|__MACOSX/'` | 无输出 |
| 大文件 | `git ls-files \| 逐个 stat`，阈值 5 MB | 最大 311725 字节（`README_EN.md`），无超限项 |
| clone 后仓库干净 | 跑完全部测试再 `git status --porcelain` | **0 条** —— 测试不污染仓库 |
| `.gitignore` 覆盖 | 按 12 类真实产物路径逐个 `git check-ignore` | 全部命中（`dist-*/`、`*.app`、`node_modules/`、`.staging-*/`、`runtime/wine/`、`layers/*/root/`、`__pycache__/`、`*.log`、`.workbuddy/`） |
| 三档视口 | `node console/scripts/viewport-check.mjs` | 375 / 768 / 1440 基线与压测均 0 处越界，退出码 0 |

**⑤ 一个必须与仓库缺陷区分开的现象。** 整块执行 18.2 时，末尾的 `console ... contract` 有两次报 `9 / 10`，缺的那条是 `exeonmac doctor`「没有输出可解析的 JSON 报告（退出码 1）」；但单独重跑同一条命令稳定 `10 / 10`（连跑 5 次），`wepack doctor --report` 单独跑 12 次也稳定退 0。抓到 stderr 后才定性：

```
[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":10,"threshold":10,
 "targets":["/Users/.../Application Support/wexe/.doctor-probe"]}
```

是**本轮执行环境的删除守卫**在累计删了 10 次之后拦住了 doctor 清理探测文件这一步，不是 `wepack` 的缺陷 —— 手动对同一路径做写+删均正常。**这类「环境拦截伪装成产品缺陷」的情况，判据是「同一条命令单独跑能否稳定复现」**：单独跑 12 次全绿、整块跑 2 次全红，差异只在执行环境，不在代码。写进这里是为了防止下一轮把它当 bug 去改 `wepack`。

### 15.14 launcher 的信号处理：一个「测试绿着、产品坏着」的实例（2026-11-20 实测）

**这一节记录的是全部测试通过、日志看着正常，而产物实际关不掉的一处缺陷。** 它是优化循环从「性能」维度切进去的：`exeonmac` 454 项要跑 2 分多钟，先测耗时分布，第一名 `test_launcher_starts_wine` 单跑 **63.3 秒**，而其中真正在验证的部分只有约 3 秒。

**① 先分清「产品慢」还是「测试在空等」。** 63 秒里约 60 秒来自测试的兜底超时：`process.terminate()` 后 `wait(timeout=60)`，超时才 `kill()`。所以要看 `terminate` 与 `kill` 之间隔了多久，问题就落在 launcher 本身。用探针脚本复现（真实 base 层 + 真实 wine + 真实 launcher）：`wine 已启动` 2.28 秒出现，此后 SIGTERM 发出 **90 秒进程仍在**，需要 SIGKILL。同时 `launcher.log` 里**没有**「收到信号」这一行 —— 说明不是「退得慢」，是 handler 从未执行。

**② 根因是调度模型冲突，不是超时设置。** 三处叠在一起才致命：

| 环节 | 行为 |
|---|---|
| `signal(sig, SIG_IGN)` | 把 SIGTERM 的默认处置（直接终止）关掉了 |
| `DispatchSource.makeSignalSource(signal: sig, queue: .main)` | handler 排在 `.main` 队列，由 **main run loop** 调度 |
| `WineRunner.run` 的等待 | `while process.isRunning { Thread.sleep(0.2) }` —— 主线程全程占着，**从不跑 run loop** |

结果：默认处置被关、handler 又永远轮不到，SIGTERM 变成一个「收到了但什么都不发生」的信号。

**③ 用最小复现把「队列」这个变量单独摘出来。** 写 60 行 Swift 复现同样结构（`SIG_IGN` + `DispatchSource` + `Thread.sleep` 轮询），只改队列：

| 队列 | 8 秒内 handler 是否执行 | marker 文件 |
|---|---|---|
| `DispatchQueue.main` | 否 | 未写入 |
| 独立串行队列 | 是 | `收到 SIGTERM via custom` |

这一步是必要的：光看代码只能推测，而「推测 `.main` 是原因」与「实测 `.main` 是原因」在记录里必须分开写。

**④ 修法与实测。** 信号源改挂 `DispatchQueue(label: "com.wexe.launcher.signal")`，其余不动。同一套探针复跑：

| | 修前 | 修后 |
|---|---|---|
| SIGTERM 后退出 | 90 秒仍存活，需 SIGKILL | **0.19 秒**，`rc=15` |
| 日志 | 无「收到信号」 | `收到信号 15，正在停止 wine` → `wine 退出 status=15` |
| 该测试用例耗时 | 63.3 秒 | **3.1 秒** |
| `exeonmac` 全量 | 193.5 秒 | **137.5 秒** |

**⑤ 为什么这个缺陷能藏这么久 —— 兜底逻辑把缺陷吞了。** 原测试是：

```python
process.terminate()
try:
    process.wait(timeout=60)
except subprocess.TimeoutExpired:
    process.kill()          # ← 缺陷在这里被吃掉
```

`kill()` 让用例永远能收尾，于是「只能 SIGKILL」这个事实从未变成红色，只变成 60 秒的等待。这是**兜底掩盖缺陷**的典型形态：兜底本身合理（不能让套件挂死），但它必须同时**把「走了兜底」判为失败**，否则兜底就成了消音器。

**⑥ 两层守卫，各守一头，都做过负向验证。**

| 守卫 | 位置 | 守什么 | 负向验证（注回 `.main`） |
|---|---|---|---|
| 静态 | `tests/test_phase0.py::test_signal_source_not_on_main_queue` | 注册位置不是 `.main` | **1 项变红**，还原后 5/5 绿 |
| 行为 | `tests/test_phase3.py::TestRealLaunch` | 日志出现「收到信号」**且** 20 秒内退出 | **1 项变红**（`'收到信号' not found`），还原后 6/6 绿 |

只留行为测试也能抓到，但要等满 20 秒超时；只留静态测试则挡不住「换了别的写法但行为一样坏」。两条一起才既快又全。

**⑦ 仍未验证的边界**：本节只证明「SIGTERM 会被转给 wine 且 launcher 能退出」。三个信号共用同一段代码，但实测只发了 SIGTERM。**wine 收到 SIGTERM 后是否把所有窗口状态写回 prefix**（`wineserver` 收尾的完整性）没有验证 —— 本机测的是 `notepad.exe`，它没有需要保存的状态；有状态的商业软件需实机确认。

> **后续（2026-11-21）**：三个信号已逐个实测，各自都能在 0.18 秒内停下 —— 但这条路径本身在另一个窗口里是断的（信号落在 `FontSubstitution.apply` 期间会被静默吞掉），且三个信号的退出码此前一律是 15、无法区分。见 **15.22**。

### 15.15 prefix 半坏时打包照样「成功」（2026-11-20 实测，已修）

**这一节记录的缺陷与 15.14 同族：打包流程一路绿灯、退出码 0、校验 10/10，产物却是双击毫无反应的 .app。**

**① 发现路径。** 优化循环从「可用性」维度切进来，问的是「prefix 已存在但坏了的时候，`install` / `build` 会怎么提示」。查下去发现提示根本不是问题所在 —— `package` 压根不知道 prefix 坏了。

**② 判据只看「目录在不在」。** `package/verify.py` 第 7 项原来只有一行断言：`Private/drive_c` 是个目录。于是下面三种损坏全部放行：

| 破坏 | 原判定 | 真实后果（同一份 prefix 交给 wine） |
|---|---|---|
| 删掉 `system.reg` / `user.reg` / `userdef.reg` | 10/10 通过，退 0 | `wine: could not load kernel32.dll, status c0000135`（rc=53） |
| `system32` 还在但被清空 | 10/10 通过，退 0 | `could not open working directory L"C:\\windows\\system32\\"` |
| `dosdevices/c:` 换成普通文件 | 10/10 通过，退 0 | C: 盘不存在，安装路径全失效 |

实测方法：用 `build_bundle` 造一个真能过校验的包，再按上表逐项破坏，然后跑 `wepack package <app> --no-register --json`。三条全部 `EXIT=0`、`ok=true`、`failures=[]`。

**③ 为什么「目录存在」这个判据天生不够。** prefix 是否可用，`install` 侧一直在用 `prefix.validate_prefix()` 判（五项：`drive_c`、`system32` 非空、`dosdevices/c:` 是相对软链、三个 `.reg` 非空）。装配侧不调它，等于同一条业务规则有两套实现，且宽松的那套在最后一道关口上 —— 正是 §5.3 那条红线要挡的情形。

**④ 修法：判据收进一处，不另写一套。**

```python
# wepack/package/verify.py
from ..prefix import validate_prefix          # 复用，不复制
prefix_problems = validate_prefix(private)
report.checks.append(Check("prefix.valid", not prefix_problems,
                           "；".join(prefix_problems)))
```

校验项名由 `prefix.drive_c` 改为 `prefix.valid`，失败时把每一项缺失都点名（不是只说「校验未通过」）。

**⑤ 修后实测（四种 prefix 状态，逐个跑进程退出码）。**

| prefix 状态 | 进程 EXIT | `ok` | 失败项 |
|---|---|---|---|
| 健康 | 0 | `true` | 无 |
| 缺三个 `.reg` | **7** | `false` | `prefix.valid`（点名三个文件） |
| `system32` 为空 | **7** | `false` | `prefix.valid`（`system32 为空`） |
| `dosdevices/c:` 非软链 | **7** | `false` | `prefix.valid`（`dosdevices/c: 不是符号链接`） |

退出码 7 = `VERIFY_FAILED`「产物校验不通过」，与 `contracts/exit-codes.json` 一致。

**⑥ 夹具与判据一起弱，缺陷才藏得住。** 这条最值得记。测试夹具 `make_app()` 早先只建 `drive_c/App/`，连 `system32`、三个 `.reg`、`dosdevices/c:` 都不造 —— 换句话说，**夹具造出来的 prefix 本身就是起不来的**。判据只查目录在不在，夹具就刚好能过；两边一起宽松，缺陷永远绿着。修法是把夹具改成按 `validate_prefix` 的最低要求造齐，这样「判据收紧」与「夹具变真」是同一件事。

**⑦ 顺带修掉同一形态的第二处：`package --json` 失败时 stdout 两段 JSON。** `cmd_package` 早先无条件 `_emit(payload)`，之后才 `raise VerifyFailed`，于是失败时 stdout 上是「完整 payload + main 的 error 段」两段拼接。这与 W-02 修过的「`build --json` 两段 JSON」同因，只是发生在单个子命令内部。改用 `raw_decode` 实测：修复前 `段数=2`，`json.load` 抛 `Extra data`；修复后 `段数=1`，`ok=false` 与 `exit_code=7` 都在同一段里。**该缺陷在 HEAD 上就存在**（旧实现 + 删掉 entry 复现），不是本节改动引入。

**⑧ 回归锁：7 项，两侧都做负向验证。**

| 守卫 | 位置 | 守什么 | 负向验证 |
|---|---|---|---|
| 健康 prefix 必须判过 | `test_phase3.TestPrefixHealthGuard` | 防矫枉过正 | — |
| 缺 `.reg` / 空 `system32` / 坏 `dosdevices` 各一条 | 同上 | 逐项点名 | 注回旧判据 → **5 项全红**，还原后 5/5 绿 |
| 判据必须来自 `prefix` 模块 | 同上 | 不许另写一套 | 源码断言 `from ..prefix import validate_prefix` 存在、`(private / "drive_c").is_dir()` 不存在 |
| `package --json` 失败单段 | `test_phase6.TestPackageJsonFailureContract` | stdout 契约 | 注回「先 emit 再 raise」→ **2 项变红**，还原后 8/8 绿 |

**⑨ 仍未验证的边界**：本节证明的是「结构损坏能被拦住」。**prefix 结构完好但注册表内容被写坏的软件级故障（例如安装器中途被杀留下半个注册表）仍只能靠实跑 wine 发现** —— `validate_prefix` 只看文件存在与非空，不看内容可用性。这条不强解，记在此处。

### 15.16 触控目标只有 24px：鼠标点得动、手指点不准（2026-11-20 实测，已修）

**这一节记录的缺陷不在功能层：所有按钮都正常工作，自动化测试全绿，用鼠标的人完全看不出问题。**

**① 发现路径。** 优化循环从「多端适配」维度切进来，问题定位到「三档视口只验了不溢出，没验触控目标尺寸」。用 CDP 的 `Emulation.setTouchEmulationEnabled` 模拟粗指针设备，量三档下每个可点元素的命中区：

| 视口 | 可点元素 | 高度实测 | 达到 44px 的 |
|---|---|---|---|
| 375 | 12 个 | 24 / 29px（仅两个值） | **0 个** |
| 768 | 12 个 | 24 / 29px | **0 个** |
| 1440 | 12 个 | 24 / 29px | **0 个** |

最窄的是 `exeonmac` 的「层」按钮：**29×24px**。四方向卡片的按钮并排，「自检」与「构建」横向相距不到 30px —— 想点自检却点到构建，后果是真的开始一次构建。这不是「不太顺手」，是**会误触发实际动作**。

**② 为什么不能「全局调大」。** 这个工具的用户日常在终端里工作，看板的密度正是它被设计成这样的原因。桌面端把按钮从 24px 撑到 44px，一张方向卡片四个按钮会占掉一整屏。鼠标的点击精度远高于手指，对它没有这个要求。

**③ 也不能按视口宽度判断。** 「375px = 手机 = 手指」是错的：1440px 的触屏笔记本、桌面浏览器里打开的 375px 响应式预览，都会让宽度判据给出与实际输入方式相反的答案。CSS 侧用的是 `@media (pointer: coarse)` —— 它描述**输入设备本身**。

**④ 修法（`console/web/style.css`，新增 62 行）。**

```css
@media (pointer: coarse) {
  .btn { min-width: 44px; min-height: 44px; }
  .dir-actions .btn { min-width: 44px; min-height: 44px; padding: 6px 10px; }
  .checks-wrap > summary, .log-wrap > summary { min-height: 44px; display: flex; align-items: center; }
  .history-row { min-height: 44px; align-items: center; }
}
```

44px 取自 Apple HIG 的最小点击目标（44×44pt）；Material 给的是 48dp，取 44 与 HIG 对齐。用 `min-*` 而不是改 `padding`：`min-*` 只声明下界，原本更高的元素不会被压矮，原本矮的被撑到 44px，两条都成立。

**⑤ 修后实测（同一台机器、同一个脚本）。**

| 指针类型 | 12 个可点元素的高度 | 不足 44px 的 |
|---|---|---|
| 粗指针（手指，模拟） | 全部 44px | **0 个** |
| 细指针（鼠标，默认） | 仍是 24 / 29px | 12 个（**有意如此**） |

**⑥ 判定进了脚本，不靠人看。** `console/scripts/viewport-check.mjs` 由「两段测量」扩为「三段」：基线、压测、**触控**。第三段先激活 `setTouchEmulationEnabled`，再同时量溢出与命中区 —— 顺序有讲究：按钮变宽后若撑破容器，必须在同一段里被发现，否则「修好触控、弄坏布局」会成为新的回归。

**⑦ 负向验证四次，全部有效。**

| 破坏方式 | 结果 |
|---|---|
| 整块摘掉 `@media (pointer: coarse)` | 三档各 15/15 不达标，退出码 **1**；静态守卫 1 项红 |
| 只给 `min-height`、去掉 `min-width` | 「层」按钮 33×44px 被抓出，退出码 **1** |
| 把 `44px` 写进 `.btn` 基础规则（全局放大） | 静态守卫「基础规则里不该有 44px」1 项红 |
| 把 `setTouchEmulationEnabled` 换成 `setEmulatedMedia` | 静态守卫 1 项红（见 ⑧） |

**⑧ 本轮自己踩的坑（必须记）：静态守卫被注释满足了。** 初版写成 `assert.match(script, /Emulation\.setTouchEmulationEnabled/u)`，把代码里那行**换成无效的 `setEmulatedMedia`** 后，测试仍 234/234 全绿 —— 因为脚本注释里正好解释着这个 API 名。断言查的是整个文件，注释算内容。修法：先剥注释再断言（`stripCode`），并补一条反向断言 `doesNotMatch(scriptCode, /setEmulatedMedia/)`。这与第 1 轮附录 C 的坑同形：**检查必须落在真正生效的那一小段里**。

**⑨ 顺带堵掉一个静默口子。** 粗指针若没生效，按钮仍是 24px，`undersized` 理论上非空从而失败 —— 但那是**间接**失败：只要 `MIN_TOUCH_TARGET` 被调小，或页面碰巧有个别大按钮，这一节就会静默通过。已加直接断言 `row.touch.pointerCoarse === true`，把空转堵在入口。

**⑩ 仍未验证的边界**：(a) **触控目标只是尺寸达标，没有验证真机手指操作的准确率** —— 本机是无头 Chrome 模拟，物理屏的 DPI、防误触策略、系统级手势区都会影响实际体验；(b) **长路径在 375px 下折 4 行、断在词中间**（`very-/long-/directo/ry-...`）—— 本条已于优化循环第 5 轮修掉，见 **15.17**；(c) `pointer: coarse` 在老旧浏览器（Safari < 9）不被识别，那类环境会退回原尺寸 —— 属预期降级，未做特性检测兜底。

### 15.17 长路径断在词中间：不溢出、不报错，但读不出来（2026-11-21 实测，已修）

**这一节与 15.16 同源：页面完全正常，测试全绿，只有真正去读那行路径的人受影响。** 入口由 15.16⑩(b) 指定。

**① 问题形态。** `overflow-wrap: anywhere` 解决了「长串撑破容器」，代价是**断在任意字符之间**。实测 375px 下，139 字符的深目录路径被断成 4–5 行，断点落在词正中间：

```
/very-long-directory-name/.../Framewo|rks/Electron/run|time.tar.zst
把 macOS 应用打包成 Windows 可执行文件：…/Electr|on/runtime.tar.zst
```

读者得在两行之间自己把一个单词拼回去。`/` `\` `-` 这些天然边界全部没被利用。

**② 先量，再改。** 逐字符建 `Range`、按 `top` 归行、把每行还原成字符串，得到「断在哪个字上」这个可读的结论。判定口径是这一条：**断点两侧都属于 `[A-Za-z0-9._]` 才算断在词中间** —— 中文在字间断行是正常排版，断在 `/` `-` 之后是天然边界，都不算。

三档基线（用本节的检查脚本把 `writeText` 退回 `textContent` 复现修改前状态，同一压测串）：

| 视口 | 检查容器 | 总行数 | 断在词中间 |
|---|---|---|---|
| 375 | 9 个 | 38 | **9 处** |
| 768 | 9 个 | 24 | **3 处** |
| 1440 | 9 个 | 19 | **3 处** |
| 合计 | — | 81 | **15 处** |

**③ 三个关键事实，都是实测的，决定了修法。**

| 事实 | 怎么验的 | 结论 |
|---|---|---|
| `<wbr>` 不占宽度、**不进剪贴板** | 造 `/a/b<wbr>c/d`，`getSelection().toString()` | 得到 `"/a/bc/d"`，复制路径照常可用 |
| `word-break: break-all` **无视** `<wbr>` | 同一串加/不加 `<wbr>`，223px 容器 | 5 行 4 处硬断，两者完全一致 |
| `overflow-wrap: anywhere` **优先**用 `<wbr>` | 四种配置 × 四档宽度对比 | 硬断 1→0、3→0、2→0，全线归零 |

第二条是最容易漏的：`.result-val` 原本写着 `word-break: break-all`，光插 `<wbr>` 一点用都没有。**必须同时改 CSS。**

**④ 修法（两处，各管一头）。**

- `console/web/report-view.mjs` 新增 `pathSegments(text)`：纯函数，把串按 `/` `\` `-` 切成 `{text, breakAfter}` 片段。纯函数才能在 Node 里测，也才能被压测复用。
- `console/web/app.js` 新增 `export function writeText(node, text)`：**全页唯一**往 DOM 写长篇文本的入口，逐片段 `append(Text)` + 分隔符后插 `<wbr>`，不碰 `innerHTML`。`el()` 改为调它。
- `console/web/style.css`：`.result-val` 的 `word-break: break-all` → `overflow-wrap: anywhere` + `min-width: 0`。

**⑤ 修后实测（同一脚本、同一压测串）。** 三档 9 个容器共 **82 行，断在词中间 0 处**；横向溢出仍为 0px、触控目标仍 12/12 达 44px —— 修可读性没有换来布局回归。

**⑥ 判定进了脚本，成为第 4 段。** `viewport-check.mjs` 由「基线 + 压测 + 触控」扩为「基线 + 压测 + 触控 + **断行质量**」。第四段放在触控段之后、退回细指针再量：粗指针会把按钮撑宽、挤压文本列宽，量出来的形态与真实鼠标环境不同。

**⑦ 本轮踩的坑（必须记）：压测自己写了一份断行逻辑，于是它是空转的。** 压测注入的节点本来就绕过了 `app.js` 的渲染路径。初版让压测**自己**在页面里插 `<wbr>`，结果把产品的 `writeText` 退回 `textContent` 做负向验证时，脚本仍报「断在词中间 0 处」、退出码 **0** —— 压测量的是它自己的实现。改成 `import('./app.js')` 取页面上已加载的那份真实模块后，同一次负向验证立刻报 **15 处**、退 **1**。

这与 15.16⑧ 是同一形态的第三次复发：**检查必须落在真正生效的那段代码上**。区别是这次不是「注释满足了断言」，而是「压测复制了被测逻辑」。

**⑧ 负向验证六次，全部有效。**

| 破坏方式 | 结果 |
|---|---|
| `writeText` 退回 `textContent` | 三档 **15 处**断在词中间并逐个点名，退 **1** |
| `.result-val` 加回 `word-break: break-all` | 三档 **4 处**（只点 `.result-val`），退 **1** |
| 选择器清单里写一个不存在的类 | 报「元素不存在，本节对它是空转」，退 **1** |
| `el()` 绕过 `writeText` | 静态守卫 1 项红（23 项中 fail 1） |
| 压测改回自写断行逻辑 | 静态守卫 1 项红 |
| CSS 恢复 `break-all` | 静态守卫 1 项红 |

**⑨ 新增 8 项守卫**（`console/test/viewport-check.test.mjs`，15 → 23 项）：`pathSegments` 的断点位置与「拼回原文一字不差」、空串/非字符串不抛、无分隔符串返回单段、压测必须 `import('./app.js')`、`el()` 必须走 `writeText` 且不直接写 `textContent`、`.result-val` 不得用 `break-all`、选择器清单每一项都在 `app.js` 里有对应渲染点、判定里含 `dirty === 0` 与 `missing !== true`。

**⑩ 仍未验证 / 未处理**：(a) 只测了「断点位置」，**没测超长串是否会因此多折一行** —— 实测 `.result-val` 在 375px 下从 5 行变成 6 行，是 `<wbr>` 让断点更碎的正常代价，但极端窄屏（< 300px）未测；(b) 横向滚动容器 / 首尾省略（`…/last/two/segments`）是另一种取舍，本轮未做 —— 前者引入双向滚动，后者会隐藏用户最需要核对的中段；(c) Windows 路径 `C:\Users\...` 的双反斜杠已在分隔符集里，但 `\\?\C:\` 这类前缀未单独测。


### 15.18 键盘用户按回车就丢焦点：鼠标点得动、键盘摸不着（2026-11-21 实测，已修）

**这一节是 15.16 / 15.17 的第三种形态：页面不溢出、文字不断词、按钮够大，前三段检查全绿 —— 只有用键盘的人做不到。**

**① 问题形态。** 顶栏「契约检查」是个普通 `<button>`，鼠标点一次跑一次，看上去毫无问题。真实键盘按回车之后：

- 焦点**立刻掉到 `<body>`**，页面上看不见任何位置标记；
- 读屏从文档开头重新念；
- 要够到刚打开的面板里的「关闭」，得再按 **12 次 Tab**（面板在 DOM 里排在方向网格之后，视觉顺序也是这样）。

关掉面板之后同样掉回 `<body>`。整条链路上，键盘用户三次失去位置感。

**② 根因：在 click 处理里设 `disabled`。** 原实现是 `button.disabled = true` / `finally disabled = false`，用来防重入。四组对照把因果关系切开了（同一页面、同一按钮、同一台机器）：

| 场景 | 触发方式 | 之后焦点在 |
|---|---|---|
| 产品现状（handler 里设 `disabled`） | 真实 `Enter` | **`<body>`** |
| 同样的 handler | 程序化 `.click()` | 按钮上 |
| 拦截 click、handler 不执行 | 真实 `Enter` | 按钮上 |
| 拦截 click、手动只设 `disabled` | 真实 `Enter` | **`<body>`** |

差别在事件序列：**`Enter` 是 keydown → click → keyup 三步**。click 里把按钮设成 `disabled`，元素立刻不再是焦点目标，浏览器把焦点退回文档根，紧接着的 `keyup` 已无接收者。程序化 `.click()` 没有后续 keyup，所以复现不出来 —— **这就是这条缺陷此前所有测试都绿着的原因**。焦点轨迹实测（`focusin` / `focusout` 全程记录）：

```
修复后： in:section#contract-panel  →  out→:section#contract-panel
修复前： out→:body                 →  in:section#contract-panel
```

**③ 修法（三处，各管一头）。**

- `console/web/app.js`：防重入改用布尔量 `contractBusy`，忙碌态用 `aria-disabled` / `aria-busy` 表达。`aria-disabled` 只影响语义（读屏念「不可用」），**不影响可聚焦性**，焦点因此留得住。`runContractCheck` 末尾 `panel.focus()` 把焦点交给结果面板 —— 结果在页面下方（375px 下 top=601px），不移焦点用户既不知道开始没开始、也不知道结果在哪。
- `console/web/app.js` 新增 `closeContractPanel()`：收起面板后 `$('btn-contract').focus()`。面板一收，里面的「关闭」随 `hidden` 祖先一起离开无障碍树，不主动交回焦点就必然掉到 `<body>`。
- `console/web/index.html`：面板加 `tabindex="-1"` + `role="region"` + `aria-label`。`-1` 让它能接受程序化焦点但不进 Tab 序列；`role="region"` 让读屏能报「契约一致性 区域」而不是「区域」。
- `console/web/style.css`：`aria-disabled` 的忙碌态样式（`opacity: .45` + `cursor: progress`），以及 `.panel:focus { outline: none; box-shadow: inset 3px 0 0 var(--info) }`。

**④ 本轮自己踩的坑（必须记）：修完第一版被判红，判红是对的。** 第一版写的是 `.panel:focus { outline: none }` —— 挪了焦点却**不给任何可见标记**，等于把「焦点在面板上」变成看不见的事实。检查当场报红：三档各 1 条「焦点在 section#contract-panel 上但没有可见焦点环」。这与本条要修的问题是同一形态（**焦点落在看不见的地方等于没有焦点**），只是从「丢焦点」变成「焦点隐形」。改成左侧内嵌色条后通过。

**⑤ 第二个坑：判据第一版太软，负向验证抓不住。** 判据最初只看末态快照（「回车后焦点在哪」「检查完在哪」）。把产品注回 `disabled` 做负向验证时，**浏览器复跑仍然三档全绿** —— 因为 `runContractCheck` 末尾那次 `panel.focus()` 把焦点又挪回来了，中途掉到 `<body>` 的那一瞬间被末态盖住了。加上「`focusin`/`focusout` 全程轨迹里不许出现 `body`」这一条后，同一份负向代码立刻三档变红、退 **1**。

这与 15.16⑧、15.17⑦ 是同一形态的第四次复发：**检查必须落在真正生效的那段上**。这次的形态是「末态掩盖了过程」。

**⑥ 另一个纠正：Tab 距离的判据原本写错了，已改。** 初版断言「从触发按钮按 Tab 进入面板 ≤ 3 次」，实测恒为 12 次 —— 但那**不是缺陷**：契约面板在 DOM 里位于方向网格之后，视觉顺序也如此，12 次恰好是「Tab 序列与眼睛看到的位置一致」。为了让它变短而把面板挪到 DOM 前面，反而会让键盘走位与视觉错开。改为断言「**焦点已被第一段交进面板后**，Tab 到『关闭』≤ 2 次」—— 实测 1 次。

**⑦ 修后实测（真实 Chrome，三档）。**

| 视口 | 回车后焦点 | 焦点环 | 面板内到「关闭」 | 关闭后焦点 | 焦点轨迹含 body |
|---|---|---|---|---|---|
| 375 | `section#contract-panel` | 有 | 1 次 | `button#btn-contract` | 否 |
| 768 | `section#contract-panel` | 有 | 1 次 | `button#btn-contract` | 否 |
| 1440 | `section#contract-panel` | 有 | 1 次 | `button#btn-contract` | 否 |

同一次运行里前三段未回归：三档基线 / 压测 / 触控横向溢出均 **0px**、越界元素 **0** 处、断在词中间 **0** 处、触控目标 15 个中 0 个小于 44px。

**⑧ 负向验证四次，全部有效。**

| 破坏方式 | 浏览器实测 | 静态守卫 |
|---|---|---|
| `aria-disabled` 改回 `disabled` | 三档轨迹含 `out→:body`，退 **1** | 1 项红 |
| 删掉关闭后的 `focus()` | 三档关闭后焦点为 `body#`，退 **1** | 1 项红 |
| `.panel:focus` 去掉 `box-shadow`（只留 `outline: none`） | 三档 `ring=false`，退 **1** | — |
| 面板去掉 `tabindex="-1"` | 三档回车后焦点仍在触发按钮，退 **1** | 1 项红 |

**⑨ 新增 11 项守卫**（`console/test/viewport-check.test.mjs`，23 → 34 项）：`judgeKeyboardFocus` 正常数据判通过、两处 `body` 各自点名、隐藏区与无焦点环均判失败、关闭后落点必须是触发按钮、面板 0 节点判「空转」、面板内 Tab 超 2 步判失败、判定必须接进 `runViewportCheck` 的 `ok`、产品代码不许用 `button.disabled =`、`closeContractPanel` 必须交回焦点、面板必须有 `tabindex="-1"` 与 `role`/`aria-label`、`.panel:focus` 必须有可见替代标记。

**⑩ 仍未验证 / 未处理**：(a) **只测了 Chrome**，Safari / Firefox 对「disabled 元素丢焦点」的实现是否一致未验；(b) 历史行「回看」的焦点链路本轮未单独测 —— 它同样会重置面板，但走的是 SSE 而不是 fetch；(c) 读屏软件的实际朗读顺序未人工核听，只静态核对了 `role` / `aria-label` / `aria-busy` 的存在性；(d) `aria-busy` 加在按钮上是否符合规范有争议，规范推荐加在被更新的**容器**上，本轮按「表达按钮自身忙碌」处理。


### 15.19 注册表文件「存在且非空」不等于「wine 能读」（2026-11-21 实测，已修）

**这一节是 15.15 的下一层。** 15.15 证明「prefix 结构半坏必须在打包时失败」，修法是把装配侧判据改为复用 `validate_prefix()`。但那个判据本身只看 `.reg` **存在且非空** —— 于是只要文件还在、字节数不为 0，内容写成什么都能过。这一节把判据补到内容层，并顺带查出写注册表的两处代码一直在写 wine 不收的格式。

**① 缺陷：35 字节的纯文本照样判健康。** 造一个健康 prefix，把 `system.reg` 换成一行 `this is not a registry`（35 字节）：

```
validate_prefix(...)     ->  []                          # 判定健康
wine64 cmd /c "echo hi"  ->  rc=1
    system.reg is not a valid registry file
    wine: '...' is a 32-bit installation, it cannot support 64-bit applications.
```

打包侧第 7 项 `prefix.valid` 调的正是这个函数，所以这种 prefix 会被打成 `.app` 放行 —— 用户拿到的是「打包成功、双击毫无反应」，与 15.15 的形态相同，只是入口从「结构」换到了「内容」。

**② 三个文件的致命程度不同，判据必须分开。** 对 9 种畸形文件逐个跑真实 wine（wine-11.21），按「进程能否起来」与「写入能否落盘」两栏记录：

| 文件 | 首行不对 | 缺 `#arch=win64` |
|---|---|---|
| `system.reg` | `rc=1`，起不来 | **`rc=1`**，报「32-bit installation」，而文件语法完全合法 |
| `user.reg` | **`rc=0`，但 HKCU 写入静默丢失** | `rc=0`，无影响 |
| `userdef.reg` | `rc=0`，仅新用户默认值丢失 | `rc=0`，无影响 |

中档那条最阴：`user.reg` 写成 `garbage` 之后，`reg add HKCU\...` **返回 0**，紧接着 `reg query` 查不到刚写的键，`user.reg` 体积从 119640 掉回 8 字节。也就是说安装器会「成功」装完，注册的路径与序列号全没落盘，第二次启动才失效 —— **退出码、stderr 全都干净**。

所以首行检查三个文件都做，`#arch` 只对 `system.reg` 做。对另外两个要求 arch 是误报（实测它们缺 arch 完全无影响）。

**③ 首行与 arch 的实测边界**（都实测，不是查文档）：

| 写法 | 结果 |
|---|---|
| `REGEDIT4` / `Version 1` / `Version 3` / 前置空行 | 全部 `not a valid registry file`、`rc=1` |
| `Windows Registry Editor Version 5.00` | 同样 `rc=1` —— 那是 `regedit /E` 的**导出**格式，不是 prefix 里的存储格式 |
| 缺 `#arch=win64` | `rc=1`，报「32-bit installation」 |
| `#arch=win32` / `#ARCH=win64` | 同一条错误 → 精确匹配，大小写不符也无效 |
| arch 在第 3 行 / 第 6 行 / 空行之后 / CRLF / 行尾无换行 | 全部 `rc=0` → 位置不限 |
| section 里写半行 `"a"="b`（`Malformed value`） | **`rc=0`**，程序照常跑 → 只是丢一个值，不能据此判 prefix 不健康 |

最后一行决定了判据**不能**做全语法校验：那样会把「丢一个值」误判成「prefix 坏了」。

**④ 顺带查出两处代码一直在写 wine 不收的格式。** 两处都自述「wine 的 .reg 是 UTF-16LE + BOM」，而实测那句话只对 `regedit /E` 的**导出**文件成立：

- `prefix._write_placeholder_regs`：base 层没带 `.reg` 时写的占位表是 UTF-16LE+BOM 且**没有 `#arch`**。实测 `rc=1`、`system.reg is not a valid registry file` —— **占位表本身就是坏的**，而它的存在意义正是「让 wine 能起来」。改成纯 ASCII + `#arch=win64` 后 `rc=0`，wine 自己把占位补全成 20 万字节的完整注册表。
- `install.RESTART_SUPPRESS_REG`：用的是 wine **内部**存储格式（`WINE REGISTRY Version 2` + 相对键路径 `[Software\\...]`），而 `regedit /S` 只认 **Windows 导出**格式。实测喂它内部格式 **退出码 0、stderr 空、一个键都没写进去**。同一 prefix、同一条命令的三组对照：

| 文件内容 | 导入后 `reg query` |
|---|---|
| `Windows Registry Editor Version 5.00` + `[HKEY_CURRENT_USER\...]` | 键在，三个 dword 齐备 |
| `WINE REGISTRY Version 2` + 相对路径 `[Software\...]` | 键不存在 |
| `WINE REGISTRY Version 2` + `[HKEY_CURRENT_USER\...]` | 键不存在 |

即「重启拦截」从来没有生效过，而日志里一直写着 `reboot.suppressed`。改成导出格式后三个值实测写入成功。

**⑤ 修法四处，各管一头。**

- `prefix/__init__.py` 新增常量 `REG_HEADER` / `REG_ARCH_64` 与 `_check_reg_file()`：读前 64 KB，判首行与（仅 `system.reg`）arch。`validate_prefix` 在「非空」之后调它。
- `prefix._write_placeholder_regs`：改纯 ASCII + arch 行。
- `install.RESTART_SUPPRESS_REG`：改 Windows 导出格式与绝对键路径。
- `install.suppress_restart`：导入后回查 `RESTART_POLICY_KEY`，查不到就写 `WARN reboot.suppress_ineffective`。**`regedit /S` 对格式错的文件不报错，所以「命令跑完没抛异常」不能证明生效** —— 至少让日志说实话。

**⑥ 测试夹具与判据一起翻新（这是缺陷藏住的另一半原因）。** `make_fake_layer()` 与 `test_phase3.make_app()` 早先写的都是 UTF-16LE+BOM 且无 arch，**夹具造出的 prefix 自己就跑不起来**。判据只看「存在且非空」，夹具刚好能过，两边一起宽松所以永远绿。现在两处夹具都按新判据造齐，常量从 `wepack.prefix` 导入而不是各背一份字面串。

**⑦ 新增 11 项测试**（`test_phase2.py`）：`TestValidatePrefixRegContent` 9 项（纯文本 system.reg / 缺 arch / `#arch=win32` / UTF-16 BOM / 坏 user.reg / 坏 userdef.reg 均被判出；user 两件缺 arch **不**判错、arch 位置四种写法**不**误报、`Malformed value` **不**误报 —— 后三项防矫枉过正）；`TestRestartSuppressionTakesEffect` 2 项（假 wine 让 `reg query` 报找不到 → 必须落 WARN 而非 INFO；回查得到 `NoClose` → 必须落 INFO，防矫枉过正）。另修 `test_placeholder_regs_written_when_missing` 与 `test_reg_file_is_utf16` 两条**把错误格式写进断言**的旧测试。

**⑧ 负向验证（注回旧实现）。**

| 破坏方式 | 结果 |
|---|---|
| `validate_prefix` 去掉 `_check_reg_file` 调用 | 6 项变红（纯文本 / 缺 arch / win32 / BOM / user / userdef 各一） |
| `_write_placeholder_regs` 改回 UTF-16LE+BOM 无 arch | 占位表测试变红 |
| `RESTART_SUPPRESS_REG` 改回 `WINE REGISTRY Version 2` | 格式断言变红 |
| `suppress_restart` 去掉回查、无条件写 INFO | 「未生效必须落 WARN」变红 |

**⑨ 仍未验证 / 未处理**：(a) **只测了 wine-11.21**，其他版本对首行与 arch 的宽容度未验；(b) 判据只覆盖「wine 读得进去」，**不覆盖「读进去之后注册表内容是否语义正确」** —— 例如键值被改成垃圾值，wine 照样起来，这种只能靠实跑业务程序发现；(c) 32 位 prefix（`WINEARCH=win32`）本仓库不支持，故 `#arch=win32` 一律判错，若将来要支持需改这一条；(d) `regedit /S` 的静默失败是否也影响其他 `.reg` 导入路径未系统排查，目前只查了 `suppress_restart` 这一处。


### 15.20 模块导入就编译安装包：一个「借个纯函数」引发的整类消失（2026-11-21 实测，已修）

**这一节是 15.19 遗留 (a) 的处置。** 15.19 记下一条「`ISCC 编译失败（退出码 0）`是 HEAD 上就有的既有错误」，并已定位到根因；这一节把它修掉，并顺手改掉让这种缺陷得以长期存在的那个结构。

**① 症状：跑单个测试类就崩，而全量按字母序跑却没事。** `cd exeonmac && python3 -m unittest tests.test_phase2.TestCliPhase2` 得到：

```
Ran 7 tests in 1.285s
FAILED (errors=2)
RuntimeError: ISCC 编译失败（退出码 0）：
```

`detail` 是**空的**。退出码 0、stderr 空、产物不存在 —— 三条信息互相矛盾，看上去像 ISCC 自己坏了。而按 `discover` 的字母序跑（`test_phase0` → `test_phase1` → `test_phase2`）时它一直是绿的，所以这个缺陷藏了很久。

**② 根因链条有四环，缺任何一环都不成立。**

1. `tests/test_phase1.py:53` 在**模块顶层**求值 `REAL_INNO = ... str(fixtures.demo_inno_real() or "")` —— 导入模块 = 现场编译一个 Inno 安装包。
2. `tests/test_phase2.py` 有 4 处 `from tests.test_phase1 import build_min_pe, build_nsis_overlay`，只为借两个**纯字节构造函数**。
3. `test_phase2` 的 `IsolatedWexe.setUp` 把 `WEXE_HOME` 指到临时目录，并在那里写一个只 `exit 0` 的假 wine（`make_fake_wine`）。
4. 于是第 2 步的导入（发生在第 3 步之后）里，`wine_binary()` 解析到假 wine，ISCC 被假 wine「跑」了、什么也没编、退出码干净，`demo-setup.exe` 不存在 → 抛 `RuntimeError`。

**这是个顺序依赖的缺陷**：同样的代码，字母序跑没事，跑单个类就炸。它既不会被 `check_no_skips.py` 抓到（那脚本只看 `Ran N tests` 与 skipped），也不会被「全量绿」发现。

**③ 修法不是加 `try`，是把导入期的副作用去掉。** 四个样本常量改为**惰性函数**（`sample_nsis()` / `sample_inno()` / `sample_msi()` / `real_inno()`），进程内缓存；原来靠 `@unittest.skipUnless(常量 and ...)` 跳过的四个类改用 `setUpClass` + `require_sample()`，拿不到就 `raise unittest.SkipTest(...)`。**装饰器在导入时求值，`setUpClass` 在用例真的要跑时才求值** —— 分界线就在这里。

**④ 顺带让报错说清是哪一种失败。** `fixtures.demo_inno_real()` 原来对「编译失败」与「wine 什么也没做」用同一句话。现在分开：

```
ISCC 退出码 0 但没生成产物 —— 这个 wine 什么也没做：
  wine = /tmp/.../wexe/runtime/wine/bin/wine64
  WEXE_HOME = /tmp/...
多半是测试把 WEXE_HOME 指到了临时目录、那里只有一个只 exit 0 的假 wine；
也可能是 wine 自身损坏。
```

与 15.19 同属「退出码 0 的假成功」，处置原则一致：**让失败自己说出它是哪一类**，别让下一个人往编译器上找原因。

**⑤ 新增 2 项守卫，都做过负向验证。**

| 守卫 | 判据 | 负向验证（把常量注回模块顶层） |
|---|---|---|
| `test_importing_module_runs_no_external_tool` | 子进程里造一个「被调用就留痕」的假 wine + 存在的 `WEXE_ISCC`，导入后哨兵文件**不许存在** | 哨兵出现 → 该条变红 |
| `test_no_fixture_call_at_module_level` | 用 `ast` 扫模块顶层，`fixtures.demo_*` 的调用**一个都不许有**（函数体里的不算） | 报出「第 63 行：fixtures.demo_inno_real()」→ 变红 |

第一版守卫**是软判据**：只断言「导入不报错、合成夹具造得出」。负向验证时它仍然绿 —— 因为空 `WEXE_HOME` 下 `demo_inno_real()` 只是返回 `None`，不抛异常。改成埋哨兵之后同一份负向代码立刻两条全红。**这又一次证明：判据不经过负向验证就等于没写。**

**⑥ 为什么这条值得单独成节。** 它不是「某个函数写错了」，而是「测试套件之间的隐式耦合」：`test_phase2` 依赖 `test_phase1` 已经跑完（因为跑完之后 `WEXE_HOME` 已还原），这个前提从未被写下来，也从未被检查。**凡是「导入即执行」的模块级代码，都在制造这种未声明的前置条件。**

**⑦ 已系统扫描，同类代码共 3 处，本轮不改。** 用 `ast` 对 `tests/test_*.py` 的「导入时会执行的语句」统一扫（跳过函数体、照走类体），命中：

| 位置 | 导入期调用 | 性质 |
|---|---|---|
| `test_phase2.py:53/54` | `fixtures.demo_nsis()`、`fixtures.wine_available()` | 前者会跑 `makensis`（外部工具），后者只探文件 |
| `test_phase3.py:56/57` | 同上 | 同上 |
| `test_phase7_layers.py:341/394` | `fixtures.wine_available()` | 只探文件，无副作用 |

它们目前**不表现为故障**：`discover` 在跑任何用例之前就导入了这几个模块，那时 `WEXE_HOME` 还是真实的。但与 `test_phase1` 是同一形态 —— 一旦有人在 `WEXE_HOME` 被重定向期间导入它们，`REAL_WINE` / `SAMPLE_NSIS` 就会按假环境定型且**不会再纠正**（模块级常量只求值一次）。按「每轮只改一个变量」的规矩，本轮只修真正炸掉的那一处，这三处留作下一轮。

**⑧ 仍未处理**：(a) `test_phase2` 依然 `from tests.test_phase1 import build_min_pe` —— 惰性化之后它已无副作用，但更彻底的做法是把这两个纯构造函数下沉到 `fixtures.py`，让测试模块之间不再互相导入；(b) ⑦ 表里那 3 处导入期调用待改惰性；(c) CI 只跑 `discover`（字母序），不跑单类，所以这类顺序依赖在 CI 上永远是绿的 —— 值得给 CI 加一条「单独跑每一个测试类」的作业。


---

### 15.21 「导入即定论」：判据放在模块顶层，跳过就成了永久的（2026-11-21 实测，已修）

**这一节是 15.20 ⑦ 的处置。** 15.20 系统扫描出 3 处导入期调用并留作下一轮，这一节把它们全部改掉，同时发现 15.20 修得不够彻底 —— 它把「导入即编译」改成了「导入即定论」，后者更难看见。

#### ① 症状：同一形态的第二副面孔

15.20 修完后 `test_phase2` 里剩的是这行：

```python
REAL_WINE = fixtures.wine_available()      # 看着无副作用
```

它**确实**不跑外部工具，但它在导入那一刻就把「本机有没有 wine」这个结论定死了。实测（`WEXE_HOME=/nonexistent` 下导入）：

| | `TestRealWine.__unittest_skip__` | `TestRealInstall.__unittest_skip__` |
|---|---|---|
| 改前（`= fixtures.wine_available()`） | **True** | **True** |
| 改后（`setUpClass` 里判断） | False | False |

改后 `__unittest_skip__` 是 False，但用例真跑时 `setUpClass` 会照实际环境跳过 —— 这才是正确的位置。**跳过本身不是问题，「在导入时把跳过定死」才是**：一旦定型就不会再纠正，模块级常量只求值一次。

#### ② 同一形态的第三种：装饰器参数

`test_phase7_layers.py` 的两处是 `@unittest.skipUnless(fixtures.wine_available(), ...)`。这个更隐蔽 —— 代码里看不到「常量」，只是一行装饰器，但 `skipUnless` 的参数据在**导入时**求值，效果与①完全相同。

静态扫描抓不到它（它挂在 `decorator_list` 而不在模块体语句里），所以第一版 `ast` 守卫漏了这一处。补扫 `decorator_list` 后一次抓出 2 条。

#### ③ 真正的缺陷在 `test_phase2` / `test_phase3`：导入就编译

15.20 记的③说的是 `test_phase1`，但同形态的更强版本在这两个文件里 —— 它们直接抄了一份：

```python
SAMPLE_NSIS = os.environ.get("WEXE_SAMPLE_NSIS") or str(fixtures.demo_nsis() or "")
```

`demo_nsis()` 会跑 `makensis`。用哨兵脚本实测（PATH 前置一个「被调用就留痕」的假 `makensis`）：

```
$ python3 -c "import tests.test_phase3"     → marker 存在
$ python3 -c "import tests.test_phase2"     → marker 存在
RuntimeError: makensis 编译失败（退出码 0）：
```

与 15.20 的 ISCC 完全同一句话、同一个形态、同一个成因（`makensis` 是假的、`exit 0`、零产物）。**15.20 修的是「ISCC 那条路」，没有修「这条路有两个入口」这件事。**

#### ④ 修法：判据收进 `fixtures`，只留一份

四处 `SAMPLE_NSIS` 的写法完全一样，说明它是**同一判据在三个文件里各写了一套**（违反 5.3 红线）。处置：

- `tests/fixtures.py` 新增 `sample_nsis()` / `sample_inno()` / `sample_msi()` / `real_inno()` / `require_sample()` / `wine_ready()` / `reset_sample_cache()`；
- `test_phase1` 的本地定义改为**同名引用**（`sample_nsis = fixtures.sample_nsis`），调用方无需改动；
- `test_phase2` / `test_phase3` 删掉模块级常量，改为 `setUpClass` + `fixtures.require_sample(...)`；
- `test_phase7_layers` 的两个装饰器改为 `setUpClass` 里判断。

**缓存键带上环境变量现值**（`(key, os.environ.get(env_name, ""))`）。只按名字缓存会掩盖「环境变量生效」这件事 —— 测试恰恰会改环境变量再断言分支，缓存命中旧值就永远测不到新分支。

#### ⑤ 守卫从「守一个模块」扩到「守全仓」

15.20 的两条守卫只扫 `test_phase1.py`，所以才漏了另外三处。现在：

| 守卫 | 判据 | 扫描范围 |
|---|---|---|
| `test_scan_covers_all_test_modules` | glob 结果必须包含 6 个已知模块，少一个即红 | — |
| `test_no_fixture_call_at_module_level` | `ast` 扫**全部** `test_*.py` 的导入期语句 + `decorator_list`，`fixtures.*` 调用一个都不许有 | 6 个文件 |
| `test_importing_modules_runs_no_external_tool` | 子进程逐个导入全部模块，`makensis` / `wine` 两条哨兵都不许出现 | 6 个文件 |

第三条加了「扫描范围守卫」是必要的：如果 `glob` 因为路径写错返回空集，前两条会**全绿通过**（没有文件就没有违规），正是 15.16⑧ 记的「判据被空集满足」形态。

#### ⑥ 负向验证（两处，均有效）

| 注入 | 结果 |
|---|---|
| `test_phase2` 模块顶层加 `LEGACY_SAMPLE = fixtures.sample_nsis()` + `LEGACY_WINE = fixtures.wine_available()` | 静态守卫报 2 条（含精确行号）、动态守卫哨兵出现 → **2 项红** |
| `test_phase7_layers` 注回 `@unittest.skipUnless(fixtures.wine_available(), ...)` | 静态守卫报 `装饰器 fixtures.wine_available()` → **红** |

还原后 3/3 绿。

#### ⑦ 仍未处理

(a) `test_phase2` 依然 `from tests.test_phase1 import build_min_pe` —— 已无副作用，但更彻底的做法是把这两个纯字节构造函数下沉到 `fixtures.py`，让测试模块之间不再互相导入；(b) CI 只跑 `discover`（字母序），不跑单类，顺序依赖在 CI 上永远是绿的 —— 值得加一条「单独跑每一个测试类」的作业；(c) `fixtures._SAMPLE_CACHE` 是进程级的，同一进程内若先构造、后被 `reset_sample_cache()` 清掉的顺序用错仍会拿到旧值。

### 15.22 信号「收下了」但没人执行：launcher 在启动窗口内关不掉（2026-11-21 实测，已修）

**这一节是 15.14 ⑦ 的处置。** 15.14 修了「信号源挂在 `.main` 队列」这个根因，但明确留了一条未验证：三个信号共用同一段代码，实测只发了 SIGTERM。本轮先试那条 —— 结果三个信号各自都正常（各 0.18 秒退出），**真正的问题在别处**：15.14 的所有用例都等到「wine 已启动」才发信号，恰好绕过了另一个更宽的窗口。

#### ① 症状：日志写了「收到信号」，进程却照常把 wine 拉起来

复现方式与 15.14 相同（真实 base 层 + 真实 wine + 真实 launcher），只改发信号的时机 —— 不等「wine 已启动」，固定延迟 0.8 / 1.0 / 1.2 秒各发两次：

| 延迟 | 停了 | 耗时 | 日志里有「收到信号」 | 日志里有「wine 已启动」 |
|---|---|---|---|---|
| 0.8s | 否 | 25.0s | 是 | 否 |
| 0.8s | 否 | 25.0s | 是 | 否 |
| 1.0s | 否 | 25.0s | 是 | 否 |
| 1.0s | 否 | 25.0s | 是 | 否 |
| 1.2s | 否 | 25.0s | 是 | 否 |
| 1.2s | 否 | 25.0s | 是 | 否 |

**6/6 复现**。日志尾巴是这样的（完整、无异常）：

```
[04:59:18Z] launch start: .../Note (Win).app
[04:59:18Z] app=Note entry=drive_c/windows/notepad.exe
[04:59:18Z] runtime ready: .../runtime/wine/bin/wine64
[04:59:18Z] 收到信号 15，正在停止 wine
[04:59:21Z] fontsub 已导入 1 条替换        ← 注意时间戳：3 秒后
[04:59:21Z] wine 已启动 pid=17638 → ...
```

用户按了 Ctrl-C，日志说「正在停止 wine」，然后 wine 照样起来了，并且此后**再也没有任何一行**。这个缺陷的形态与 15.14 不同：不是「信号没被收到」，而是「**收到了、也认了，但没人执行**」。

#### ② 根因：`current` 是 nil 的那 3 秒

信号源注册的位置是 `FontSubstitution.apply` **之前**，而 apply 里要跑一次 `wine regedit /S` 导入字体替换。这段时间：

| 环节 | 状态 |
|---|---|
| `signal(sig, SIG_IGN)` | 已执行，SIGTERM 的默认处置**已被关掉** |
| handler | 能执行，但代码是 `WineRunner.current?.terminate()` |
| `WineRunner.current` | **nil** —— 主程序还没起，而 apply 里那个 regedit 自己 new 了 `Process`、走 `waitUntilExit()`，**从不登记** |

于是 `current?.terminate()` 是空操作。日志那行「收到信号」是真的写了，然后什么都不发生。上面日志里 `wine 已启动` 晚 3 秒出现，正是 apply 里那次 regedit 的耗时。

#### ③ 第二个问题：修「记 pending」还不够

第一版修法是「handler 发现 `current == nil` 就记进 pending，主流程在启动 wine 前检查一次」。写完后回归锁**立刻判红**，而且判得对：主线程在 apply 里阻塞于 `waitUntilExit()`，**根本走不到那个检查点**。pending 被记下了，但没有任何人执行它 —— 从「信号被丢弃」变成「信号被存起来然后丢弃」。

这也说明一件事：**光修 handler 不够，因为问题不在 handler，在于有一段代码绕过了统一登记。** 真正要修的是「`current` 只覆盖主程序」这个设计缺陷。

#### ④ 修法：所有 wine 子进程收进一个入口

| 改动 | 说明 |
|---|---|
| 新增 `WineRunner.runChild` | 唯一一处 `Process()`。登记 `current` → run → 轮询 → 清 `current` |
| `FontSubstitution.apply` 改走 `runChild` | 那次 regedit 从此也有 `current`，信号有对象可停。轮询间隔 50ms（它只跑一两秒，要快） |
| handler 只做一件事：`noteSignal(sig)` | 先记 pending，再尝试送达。**不自己判 `current == nil`** |
| `runChild` 返回 `Outcome` 枚举 | `.finished(code)` / `.stoppedBySignal(sig)` / `.late` / `.failedToStart` |

`Outcome` 不是装饰。早先返回裸 `Int32`，而「wine 自己以 15 退出」与「我们发信号停了它」的退出码是同一个 15 —— 调用方分不清该不该继续。实测过一次分叉：修完第一版后 regedit 被信号停掉，日志写 `WARN fontsub 导入退出码 15，界面字体可能显示为方块`（把「被打断」当成「字体导入失败」），然后**主程序照样被拉起来**。用户已经按了关，窗口又冒出来。

`apply` 现在返回 `Bool`（是否因信号中止），`main` 据此直接 `exit(sig)`，不再启动主程序。

#### ⑤ 顺带修掉一处退出码语义不一致

修复前，同一个用户操作（关掉这个 app）会给出三个不同的码，取决于信号从哪条路走：

| 场景 | 修前 | 修后 |
|---|---|---|
| SIGINT 停在窗口内 | 2（默认处置，趁 handler 还没注册完） | **2** |
| SIGINT 停主程序 | **15**（wine 被 terminate，转成 15） | **2** |
| SIGTERM 停主程序 | 15 | 15 |
| SIGHUP 停主程序 | **15** | **1** |

中间那两行是关键：三个信号 grep 的是同一段代码，但 `terminate()` 送的是 SIGTERM，于是 wine 一律以 15 退出，**Ctrl-C 和 kill -HUP 在退出码上与 SIGTERM 不可区分**。修后每个信号返回自己的值。实测三个信号各跑一次：`SIGINT → 2 / SIGTERM → 15 / SIGHUP → 1`，各 0.02–0.04 秒退出。

#### ⑥ 回归锁：5 项，不用真实 wine

缺陷出在「handler 到了、子进程还没有」这个**时序**上，与 wine 是什么无关。用一个「被调用就留痕、然后 sleep 120 秒」的假 wine 反而更好：窗口被撑到可控，不依赖真机上 apply 恰好耗时几秒，也不会在快机器上偶发通过。

新增 `test_phase3.TestSignalDuringStartupWindow`（5 项）：

| 用例 | 判据 |
|---|---|
| `test_sigterm_in_startup_window_stops_launcher` | 等在 `runtime ready`（信号源已注册、wine 未起）时发 SIGTERM：15 秒内退出、退出码 = 15、**哨兵里没有主程序那次调用** |
| `test_sigint_in_startup_window_stops_launcher` | 同上，退出码 = 2 |
| `test_pending_is_consumed_not_replayed` | `drainPending` 必须清 `pending`，不许每轮重复送 |
| `test_handler_records_pending_when_no_child` | handler 必须调 `noteSignal`，且 `noteSignal` 真的写 `pending` |
| `test_every_wine_child_goes_through_one_runner` | 全文件只许有**一处** `Process()` |

最后一条是结构性的：只修「记 pending」而不统一入口，下次再加一个 wine 调用就会原样重现。它也是本缺陷的成因本身 —— 同一件事两套实现，宽松的那套（不登记）正好落在大窗口上（5.3 红线）。

哨兵那条判据比退出码更硬：修复前信号被忽略后 launcher 照常拉起主程序，哨兵里有 `drive_c/App/app.exe`；修复后启动前就发现 pending，主程序**一次都不许被调用**。只允许 regedit 那次留痕（它发生在窗口之前）。

#### ⑦ 负向验证（两处，均有效）

| 注入 | 结果 |
|---|---|
| handler 退回 `WineRunner.current?.terminate()`（即只有「直接 terminate」，没有 pending） | **3 项红**：两条行为用例报「15 秒仍在」并给出日志尾，静态用例报 handler 未调 `noteSignal` |
| `apply` 退回自己 new `Process` + `waitUntilExit()` | **3 项红**：两条行为用例报「15 秒仍在」（日志里能看到「已记下信号 15」，即信号被存下了但没人执行），静态用例报 `Process()` 出现 2 处 |

还原后 5/5 绿。

#### ⑧ 仍未处理

(a) 只测了 SIGTERM 与 SIGINT 的窗口内路径，SIGHUP 同在 `signals` 数组里但没单独测（三条走同一段代码，风险低，但「同一段代码」这个理由在 15.14 已经被证明不可靠）；(b) `regedit` 被停掉意味着字体替换没生效，界面中文可能显示为方块 —— 这是有意的取舍（用户已经在关，不该为了字体再起一个进程），但**产品上没有提示**；(c) wine 收到 SIGTERM 后是否把所有窗口状态写回 prefix，仍未验证（同 15.14 ⑦）。

### 15.23 字体替换从上线起就没生效过：`regedit /S` 返回 0，一个键都没写（2026-11-21 实测，已修）

**这一节是 15.22 ⑧(b) 的处置。** 15.22 留下的问题是「`regedit` 被信号停掉后字体替换没生效，而产品没有提示」。顺着这条去查「那不被停的时候生效了吗」，答案是否 —— **和信号毫无关系，它从来就没生效过**。

#### ① 症状：日志说「已导入 2 条替换」，注册表里一条都没有

`FontSubstitution.apply` 写出的 `fontsub.reg` 用的是 wine **内部格式**：

```
WINE REGISTRY Version 2
[Software\\Microsoft\\Windows NT\\CurrentVersion\\FontSubstitutes]
"Microsoft YaHei"="PingFang SC"
```

拿真实 base 层（382 MB）与真实 wine-11.21 实测：

| 步骤 | 命令 | 结果 |
|---|---|---|
| 导入 | `wine64 regedit /S fontsub.reg` | **退出码 0**，stderr 空 |
| 回查 | `wine64 reg query "HKCU\Software\Microsoft\Windows NT\CurrentVersion\FontSubstitutes"` | **`reg: Unable to find the specified registry key`** |

退出码干净、stderr 干净、一个键都没写。launcher 的日志照原文写「fontsub 已导入 2 条替换」—— 用户看到方块中文，日志说成功了。

#### ② 同一份内容换成导出格式，一条不差地写进去

把首行改为 `Windows Registry Editor Version 5.00`、键路径改单反斜杠并带 `HKEY_CURRENT_USER\` 全名，同一条命令：

```
$ wine64 reg query "HKCU\Software\Microsoft\Windows NT\CurrentVersion\FontSubstitutes"
HKEY_CURRENT_USER\Software\Microsoft\Windows NT\CurrentVersion\FontSubstitutes
    Microsoft YaHei    REG_SZ    PingFang SC
    SimSun    REG_SZ    Songti SC
```

**这与第 7 轮修的 `install.suppress_restart` 是同一个根因**：把「导出格式」当成了「存储格式」。当时只在 Python 侧改了、并加了回查，Swift 侧这份没被同一条判据扫到 —— 一处修完不等于同类修完。

#### ③ 端到端：真 launcher 跑完，注册表里确实有

用 `launcher/build.sh` 编译的真实 launcher 装配成 `.app`（base 层 + `notepad.exe` + `font_map` 两条），`WEXE_HOME` 指到临时目录，启动后读 `launcher.log`：

```
runtime ready: .../runtime/wine/bin/wine64
fontsub 已导入 2 条替换
wine 已启动 pid=88702
```

随后对同一个 prefix 直接 `reg query`，两条 `REG_SZ` 都在。**修前同一个 `.app` 跑完是零键。**

#### ④ 判据的两版演进：为什么最后用「一次性戳」而不是「先删旧键」

这是本节最该记住的部分 —— **第一版判据被自己的负向验证判红，而且判得对**。

| 版本 | 判据 | 负向验证（注回内部格式） |
|---|---|---|
| v1 | 导入后 `reg query` 读得到字体名即成功 | **仍然判绿** —— 键是**上一轮**成功写的，本次零写入，回查却通过 |
| v2（否决） | 导入前先 `reg delete 旧键`，再导入再查 | 能判红，但**破坏性**：本次导入失败时，用户原本能用的替换值被清掉，从「旧值可用」倒退成「什么都没有」 |
| v3（采用） | 同一份 `.reg` 里额外写 `ExeOnMac\FontSubstitutionStamp = <UUID>`，导入后查这枚戳 | **正确判红**：`fontsub 回查退出码 1` + `WARN …本次的戳查不到：字体替换未生效` |

v1 的错在于测的是「注册表里有没有」，不是「这次写没写进去」—— 这与 15.18 的「末态掩盖过程」、15.16 的「判据被空集满足」同属一类。v3 的戳每次运行重新生成，旧值绝不可能蒙对；写失败时旧值仍在，不会倒退，也不产生任何破坏性动作。

戳写在 `HKCU\Software\Wine\ExeOnMac`（launcher 自有命名空间），不碰微软那个键，也不在任何 Windows 软件会读的位置。

#### ⑤ 顺带修掉第二个真缺陷：信号送达后再起子进程就停不住了

加回查那一步（多跑一次 `reg query`）之后，15.22 的 `TestSignalDuringStartupWindow` 的 SIGTERM / SIGINT 两条**立刻变红**。根因不是回查本身，而是「信号已被送达」这件事没参与判断：

- `drainPending` 送达时会清空 `pending`、只留 `deliveredSignal`；
- `runChild` 启动前只看 `pending`，于是「信号已送达并停掉上一个子进程」之后再调它，`pending` 是 nil，**放行**；
- 那个信号已经用掉、`signal(sig, SIG_IGN)` 又吃掉了默认处置 —— 新子进程谁也停不了。

修法：`runChild` 与 `run` 的启动前检查改为 `pending != nil || deliveredSignal != nil`，`late` 分支统一走 `consumePendingSignal()`（它优先取 `deliveredSignal`）。**这是「同一判据只看了一半」的又一次复发**：字段拆成两个之后，所有读它的地方都得跟着改。

#### ⑥ 第三个：自己造出来的日志噪音，也是自己发现的

`runChild` 早先用 `output != nil` 推断要不要写「wine 已启动」。回查与清键那几步传的是 `FileHandle.nullDevice`（非 nil），于是日志里冒出**三条**「wine 已启动」——一句只该在主程序启动时出现一次的话出现了三次。实测修前 `grep -c` 得 3，修后得 1。

改为显式 `announce: Bool = false` 参数，只有 `WineRunner.run` 传 `true`。**日志是排障的唯一线索，宁可多一个参数，也不能让它说假话。**

#### ⑦ 回归锁：6 项静态守卫，不需要 wine

| 用例 | 判据 |
|---|---|
| `test_writes_export_format_header` | 首行必须是 `Windows Registry Editor Version 5.00`；`WINE REGISTRY Version 2` 只许出现在注释里 |
| `test_key_path_is_fully_qualified_and_single_escaped` | 键必须是全名 + 单反斜杠，且取自 `keyPath` 常量。**当轮断言写的是 `HKEY_CURRENT_USER`，该值在第 12 轮被证明无效并改为 `HKEY_LOCAL_MACHINE`**（见 15.24 ⑦） |
| `test_single_source_for_key_path` | 键路径字面量全文件只出现 **1** 次（5.3 红线） |
| `test_import_is_verified_not_assumed` | 退出码 0 之后必须回查，且回查真的跑 `reg query` |
| `test_query_judged_on_this_run_not_leftovers` | 必须有 `UUID()` 戳、戳与字体映射在**同一份** `.reg` 里、`stampPresent` 比对的是戳本身、不许用 `reg delete` |
| `test_announce_is_explicit_not_inferred_from_output` | 必须有 `announce` 参数，且不许再用 `output != nil` 推断 |

#### ⑧ 负向验证（四处，均有效）

| 注入 | 结果 |
|---|---|
| 首行改回 `WINE REGISTRY Version 2` + 双反斜杠键 | **2 项红**（格式头 + 键路径） |
| 删掉回查（`else if false`） | **1 项红** |
| 删掉 `clearSubstitutes(...)` 调用（v2 时代的守卫） | **1 项红** |
| 「wine 已启动」退回 `output != nil && !capture` | **1 项红** |

还原后 6/6 绿。行为层另做过两次真实端到端负向验证：v3 注入内部格式 → 日志正确出现 `fontsub 回查退出码 1` 与 WARN；未注入 → 日志 `fontsub 已导入 2 条替换` 且注册表实查有值。

#### ⑨ 仍未处理

(a) 只测了 `HKCU` 下的替换路径，`HKLM` 级（系统级字体替换）没测 —— launcher 只写 `HKCU`，这是刻意的（不需要管理员权限），但「某些软件只读 HKLM」这件事未验证；(b) 字体替换生效后 macOS 侧真实渲染效果未人眼确认 —— 本轮只证明了「键写进去了」，没证明「中文不再是方块」；(c) 同一形态（把导出格式当内部格式）在 `exeonmac` 的其他 `.reg` 写入路径上未做全量扫描，只确认了 `install.suppress_restart`（第 7 轮）与本节两处。

### 15.24 `HKCU` 那份字体替换没有任何代码去读：键写进去了，字还是方块（2026-11-21 实测，已修）

**这一节是 15.23 ⑨(b) 的处置。** 15.23 把格式修对了 —— 键确实写进去了、戳也查得到 —— 但明确留了一条「只证明了键写进去了，没证明中文不再是方块」。本轮从这条往下查，撞到的是**选错了注册表根键**：15.23 修的是「写得进去吗」，本轮要问的是「写得进去之后有人读吗」。

#### ① 症状：日志依旧说成功，字体依旧没换

15.23 修完的 launcher 跑真实 `.app`，日志是干净的：

```
fontsub 已导入 2 条替换
wine 已启动 pid=18519
```

对同一个 prefix 实查，`HKCU\Software\Microsoft\Windows NT\CurrentVersion\FontSubstitutes` 下两条 `REG_SZ` 都在。到此为止 15.23 的判据全部成立。但把 `notepad.exe` 的 `lfFaceName` 设成「微软雅黑」再跑，`WINEDEBUG=+font` 的日志里：

| 观察点 | 结果 |
|---|---|
| `dump_gdi_font_subst` 列表里有这条映射吗 | **没有** |
| `find_matching_face substituting` 触发了吗 | **0 次** |
| `select_font Chosen` 最后选了谁 | **`Courier New`**（一个缺中文字形的字体） |

即：数据在注册表里，GDI 的替换表里没有它，最终选字完全没变。**这就是「按键写入了」与「字体生效了」之间的那道缝。**

#### ② 三组对照：只有 HKLM 与 wine 自有键能改到实际选字

同一份 base 层（382 MB）、同一个 wine-11.21，只改根键与写入位置，每次都用真实 `notepad.exe` 并预先设好 `lfFaceName=微软雅黑`：

| 组 | 写入位置 | `dump_gdi_font_subst` 有这条 | `substituting` | `select_font` 选中 |
|---|---|---|---|---|
| G | `HKCU\...\FontSubstitutes` | **无** | 0 次 | `Courier New`（未替换） |
| E | `HKLM\...\FontSubstitutes` | 有 | 1 次 | **`PingFang SC Regular`** |
| F | `HKCU\Software\Wine\Fonts\Replacements` | 有（走别名路径） | 0 次 | **`PingFang SC Regular`** |

`substituting` 那一行的原文（HKLM 组）：

```
00f8:trace:font:find_matching_face substituting L"Microsoft YaHei",1 -> L"PingFang SC",1
00f8:trace:font:select_font Chosen: L"PingFang SC Regular" (L"\\??\\Z:\\System\\Library\...\\PingFang.ttc"/0x0:3)
```

#### ③ 根因：wine 的字体后端只有一条注册表路径

不是「HKCU 优先级低」，是**没有代码去读**。在 `lib/wine/x86_64-unix/win32u.so` 里按 UTF-16 扫字符串，能命中的只有：

```
\Registry\Machine\Software\Microsoft\Windows NT\CurrentVersion\FontSubstitutes
```

`\Registry\User\` 有出现，但没有任何与之组合的 `FontSubstitutes` 项。也就是说 HKCU 那份是「写进去了，也确实是注册表数据，但消费方只读 Machine 树」。这与 15.23 的格式问题是**两层独立的错**：15.23 让数据进得去，本轮才让数据被读到。

#### ④ 为什么不用 `HKCU\Software\Wine\Fonts\Replacements`

它同样实测有效（F 组），而且是 winecfg 自己的界面在用的那条。选的仍是 `FontSubstitutes`，理由是语义：

- `FontSubstitutes` 是 Windows 本来的替换语义（GDI 找不到某字体时改用它指定的名字）；
- `Wine\Fonts\Replacements` 走的是**别名**语义 —— 日志里能看到 `add_family_replacement mapping L"PingFang SC" to L"Microsoft YaHei"`，等于把 mac 字体反向登记成 Windows 名字。任何枚举字体列表的程序都会看到多出来的「微软雅黑」，而它其实是苹方。

兼容层对 Windows 程序说谎的地方越少越好，所以取前者。这条判断是**取舍，不是实测结论**，记在这里以免下一轮误当缺陷去「优化」。

#### ⑤ 戳也跟着搬到 HKLM —— 否则判据又退化成「测存在」

15.23 的戳在 `HKCU\Software\Wine\ExeOnMac`。本轮把字体映射改到 HKLM 之后立刻暴露：戳仍然在 HKCU，回查照样通过，但它证明的只是「regedit 把这一条写进去了」，不证明「GDI 会读的那棵树里有」—— 与 15.23 ④ 要躲开的「测的是存在，不是生效」是同一个形态，只是换了层。

修法：`stampKeyPath` 改为 `HKEY_LOCAL_MACHINE\Software\Wine\ExeOnMac`。于是字体映射与戳在**同一份 `.reg`、同一个根键、同一个消费方**。仍然不碰微软那个键本身，仍然不需要管理员权限（改的是本 prefix 里的 `system.reg`，已是 clonefile 出来的私有副本）。

实测（修后真 launcher + 真 `.app`，`wineserver -w` 落盘后读文件）：

| 文件 | 微软雅黑 | 宋体 | 戳 |
|---|---|---|---|
| `system.reg` | **有** | **有** | **有** |
| `user.reg` | 无 | 无 | 无 |

#### ⑥ 渲染层终于有了机器判据

15.23 ⑨(b) 的空白是「没有人眼确认」，而人眼确认没法进 CI。本轮改用 `WINEDEBUG=+font` 这条通道做机器判据 —— 它不需要截图、不需要人看，且直接读的是 GDI 的决策：

| 判据 | 修前（HKCU） | 修后（HKLM） |
|---|---|---|
| `dump_gdi_font_subst` 含本次映射 | 0 条 | 有 |
| `find_matching_face substituting` 触发次数 | 0 | ≥1 |
| `select_font Chosen` 是目标字体 | 否（`Courier New`） | **是（`PingFang SC Regular`）** |

这三条都能在无窗口环境跑（`notepad.exe` 会起进程，但判据全在日志里）。**仍未做人眼确认**：字形的具体笔画是否正常、是否有缺字，属于渲染质量的最后一公里，日志证明不了。

#### ⑦ 回归锁：6 → 7 项，且旧断言本身是错的

15.23 的 `test_key_path_is_fully_qualified_and_single_escaped` 断言的是 `HKEY_CURRENT_USER` —— **它把错误结论写进了断言**，本轮改代码时它当场变红。这正是本仓库反复出现的形态：判据守住了「当时的实现」，于是实现错了判据也跟着错。

| 用例 | 判据 | 变化 |
|---|---|---|
| `test_key_path_is_fully_qualified_and_single_escaped` | 键必须是 `HKEY_LOCAL_MACHINE\...` 全名 + 单反斜杠 | 断言值由 HKCU 改为 HKLM，并附三组对照表 |
| `test_stamp_shares_the_root_the_consumer_reads` | 字体映射与戳必须以**同一个根键**开头；戳另起子键、不塞进 `FontSubstitutes` | **新增** |

新增那条的判据写成「两个常量的前缀相同」，不是「把 HKLM 再写一遍」：将来整棵树若搬家，它会跟着两个常量一起走，不会留下半截旧结论。

#### ⑧ 负向验证（两处，均有效）

| 注入 | 结果 |
|---|---|
| `keyPath` 退回 `HKEY_CURRENT_USER` | **2 项红**（根键断言 + 同根键断言） |
| 只把 `stampKeyPath` 退回 `HKEY_CURRENT_USER` | **1 项红**（同根键断言） |

还原后 7/7 绿。

#### ⑨ 仍未处理

(a) 人眼未确认字形质量 —— 只到「选中的是 PingFang SC」，没到「笔画正常、无缺字」；(b) 只测 `notepad.exe` 一种载荷，且它需要 `lfFaceName` 指向被替换的字体才会触发替换 —— 真实软件若用 DirectWrite 而非 GDI，走的可能是另一条路径（`dwrite.dll` 里没有 `FontSubstitutes` 字面量）。**本轮由 15.25 查清：确实是另一条路径，且只认 `HKCU\Software\Wine\Fonts\Replacements`，原修法对它零作用**；(c) `HKLM` 级替换对「只读 HKCU 覆盖」的软件是否仍然生效未测 —— 本轮只验了「GDI 会读 HKLM」，不涉及软件自身的偏好设置；(d) 15.23 ⑨(c) 的「同类 `.reg` 写入路径全量扫描」仍未做。

### 15.25 DirectWrite 根本不看 `FontSubstitutes`：GDI 修好了，现代软件还是方块（2026-11-21 实测，已修）

**这一节是 15.24 ⑨(b) 的处置。** 15.24 把 GDI 那条路修通了（`select_font` 确实选中了苹方），但留了一句「真实软件若用 DirectWrite，可能是另一条路径」。本轮把这条查清了：**不是「可能是」，是「一定是另一条路径」，而且原来那条对它完全无效。**

#### ① 先把「谁读哪个键」用静态扫描钉死

不猜、不读文档，直接扫整个 wine 运行时（`lib/wine/` 下全部 ELF 与 PE），数两个键名各自出现在哪些模块里：

| 键名 | 出现在 | 编码 |
|---|---|---|
| `FontSubstitutes` | 只有 `x86_64-unix/win32u.so`（GDI） | UTF-16 |
| `Software\Wine\Fonts\Replacements` | 只有 `x86_64-windows/dwrite.dll` | **单字节 ANSI** |

`dwrite.dll` 里 `FontSubstitutes` **一处都没有**。编码也不同不是巧合：`win32u.so` 走宽字符 API，`dwrite.dll` 走 `RegOpenKeyA`（ANSI 版）—— 反汇编里那条调用的根键实参是 `0x80000001`，即 `HKEY_CURRENT_USER`，键名指向 `.rdata` 里的 `Software\Wine\Fonts\Replacements`。

> 这个编码差异本轮绊过一次：守卫第一版只扫 UTF-16，`Replacements` 明明在文件里却数出 0 个命中。判据得同时认两种编码 —— 同一个键名，走 ANSI API 的模块存 ANSI、走宽字符的存 UTF-16，两者都是真的。

#### ② 运行时实证：现搓一个只走 DirectWrite 的 PE 探针

静态扫描只能证明「字符串在里面」，证明不了「它真的决定结果」。所以写了一个 4 KB 的探针：手写 COM vtable 直接调 `DWriteCreateFactory` → `GetSystemFontCollection` → `FindFamilyName`，**完全不碰 GDI**。用 `clang-cl` + `lld-link` 交叉编成 PE32+，跑在真实 wine-11.21 + 382 MB base 层上。

同一份 prefix，只改注册表，五组对照：

| 组 | 写入位置 | `familyCount` | 查到 `Microsoft YaHei` |
|---|---|---|---|
| A | 都不写 | 292 | **否** |
| B | `HKLM\...\FontSubstitutes`（15.24 的修法） | 292 | **否** |
| C | `HKCU\Software\Wine\Fonts\Replacements` | **293** | **是** |
| D | `HKLM\Software\Wine\Fonts\Replacements` | 292 | **否** |
| E | `HKCU\...\Replacements`，键名用中文「微软雅黑」 | **293** | 是（中文名同样生效） |
| F | B + C 同时写 | **293** | **是** |

四个结论，每个都是单独一次实测：

1. **`FontSubstitutes` 对 DirectWrite 零作用**（B 组，292 不变）。15.24 的修法只修好了 GDI 半边。
2. **根键必须是 `HKCU`**（C 有效 / D 无效）。与 GDI 的要求正好相反 —— 两条路径的根键不同，这是本轮最容易搞错的一点。
3. **两条键可以共存、互不干扰**（F 组）。所以正确做法是两条都写，不是二选一。
4. **中文键名同样有效**（E 组）。`font_map` 里写「微软雅黑」不需要额外转成英文名。

#### ③ 为什么 15.24 明确否决过 `Replacements`，本轮又用上了

15.24 ④ 的理由是：「`Replacements` 走别名语义（把苹方反向登记成微软雅黑），枚举字体的程序会看到多出来的『微软雅黑』，兼容层对 Windows 程序说谎越少越好。」

**那个取舍的前提是「两条路都有效，选语义更干净的那条」。** 本轮实测推翻了这个前提：对 DirectWrite 而言 `FontSubstitutes` 一条路都不通。不写 `Replacements` 的代价不是「语义差一点」，而是**所有走 DirectWrite 的软件中文一直是方块**。

所以现在两条都写：GDI 走真替换语义（`FontSubstitutes`），DirectWrite 走它唯一认的那条（`Replacements`）。别名语义的副作用（`add_family_replacement mapping L"PingFang SC" to L"Microsoft YaHei"`）只能接受 —— 替代方案是完全没有替换。

#### ④ 戳跟着搬回 HKCU，判据的表述也跟着改

15.24 把戳搬到 HKLM，理由是「与消费方同根」。本轮多了一个消费方（DirectWrite 只读 HKCU），戳只能落一处。取 `HKCU`：它与 `replacePath` 同根，且 `HKCU\Software\Wine` 是 wine 自己的命名空间，对 Windows 软件完全不可见。

守卫 `test_stamp_shares_the_root_the_consumer_reads` 的断言随之改为「戳与 `replacePath` 同根」，并加一条「两条字体路径的根键必须不同」。**判据本身没变**（戳必须住在某个真实消费方读的那棵树里），变的是「哪个消费方」—— 这也正是不能把 `HKLM`/`HKCU` 写死进断言的原因：写死的那一刻，下一个人会为了「让测试变绿」去搬常量，而不是去查「到底谁在读」。

#### ⑤ 端到端：两条键都要真的落盘

静态守卫只能保证「代码里写了这两行」。所以 `TestRealLaunch` 里加了一段：SIGTERM 之后读 prefix 的 `system.reg` 与 `user.reg`，断言两处都有键、都有映射值。

**这段断言本轮红了两次，两次都不是产品缺陷：**

| 版本 | 做法 | 结果 |
|---|---|---|
| v1 | 在「wine 已启动」之后立刻读文件 | 红 —— 注册表还在内存里，未落盘 |
| v2 | 先 `wineserver -w` 再读 | **仍红** —— `-w` 只是「等 wineserver 退出」，launcher 退出后它仍以服务身份活着，等到超时；只有 `-k` 才触发回写 |
| v3 | `wineserver -k` + 轮询等 `Replacements` 出现 | 绿 |

对照实测：`-w` 后 `user.reg` 里 `Replacements` 命中 **0** 次，`-k` 后命中 **1** 次。这条经验值得记：**「日志说成功」与「磁盘上是这样」之间隔着一次落盘，中间任何时刻读文件都不算证据。**

#### ⑥ 回归锁：+3 项，其中 2 项守的是运行时事实

| 用例 | 守什么 |
|---|---|
| `test_both_font_paths_written_in_one_file` | 两条键必须在同一份 `.reg` 里；只许生成一份文本；两条共用同一份 fonts 映射 |
| `test_font_substitutes_is_read_by_gdi_only` | **扫真实运行时**：`FontSubstitutes` 必须命中 `win32u.so`、且不许命中任何 dwrite |
| `test_replacements_is_read_by_dwrite` | **扫真实运行时**：`Replacements` 必须命中 dwrite |

后两条守的不是代码而是**运行时的事实**。哪天 wine 升级、上游把 `FontSubstitutes` 也接进 DirectWrite，它们会自己变红 —— 而不是留一份过期结论继续骗人。这类「守着环境事实」的用例在本仓库是第一次出现。

#### ⑦ 负向验证（四处，均有效）

| 注入 | 结果 |
|---|---|
| 删掉 `Replacements` 那段写入 | **1 项红**（两条键守卫） |
| `replacePath` 根键改回 `HKLM` | **1 项红**（同根键守卫） |
| 只把两条键合并成一个循环（少写一条） | **1 项红**（两条键守卫） |
| 删掉 `Replacements` 写入后跑端到端 | **1 项红**（`user.reg` 里找不到 `Replacements`） |

还原后全绿。

#### ⑧ 仍未处理

(a) **人眼仍未确认字形质量** —— 15.24 到「选中的是苹方」，本轮到「DirectWrite 也认这个名字了」，但「笔画正常、无缺字」仍然只有人眼能判；(b) DirectWrite 的实际渲染结果（fallback 到哪张字模）未验，本轮只验了「家族名解析得到」；(c) 只验了 `Microsoft YaHei` 一个名字，其它字体族（宋体、黑体）未逐个验；(d) 探针在读取 `GetFamilyNames`（家族名字符串）时会 page fault，所以只取了 `FindFamilyName` 这一层的结果 —— 手写 COM vtable 的脆弱处，不影响本条结论（`exists` 与 `familyCount` 都已决定性），但「解析到的家族名是什么」这一层没有取到。


---

## 十六、更新日志

更新日志统一写在 **GitHub 发行版**页面：<https://github.com/ntars/Wacmin/releases>

README 描述项目当前状态，发行版记录每次改了什么，两者不混写。

**当前状态**：四个方向全部建立并接入契约。Mac2Win、ExeOnMac、Win2Mac 三个方向已完成并可真实产出产物；AppOnWin 处于兼容性评估阶段，运行能力待 spike 结论。四种 AI 接入形态（MCP server / 统一命令行 / Skill / 专家包）已落地。各模块的测试规模与耗时集中在 12.1 节，此处不重复列出。

---

## 十七、后续路线图

按确定性排序，前一项是后一项的前提。

| 顺位 | 事项 | 状态 | 说明 |
|---|---|---|---|
| 1 | Mac2Win 收尾 | 已完成 | 打包、校验、图形界面全部落地，转入维护 |
| 2 | ExeOnMac 五阶段 | 已完成 | 识别、解包、prefix、静默安装、`.app` 封装、分层、配方库全部落地 |
| 3 | Win2Mac 装配式打包 | 已完成 | 保留权限位的 zip 写入器、plist 生成与校验 |
| 4 | AppOnWin 运行能力 | **环境不具备** | 2026-11-19 实测：门槛 1、2 因宿主非 Windows 而 `blocked`，门槛 3 通过，整体 `unverified` / 退出码 5。结论既非通过也非证伪，需 Windows + WSL2 + Darling 重跑，见 3.4 与 5.1.2 |
| 5 | console 全功能看板 | 已完成 | 四方向统一入口（CLI + Web）、历史持久化、进度推送全部落地；三档视口（375 / 768 / 1440）由 `console/scripts/viewport-check.mjs` 实测无溢出，负向验证可复现 |
| 5b | console 键盘可达性 | 已完成 | 焦点链路由 `viewport-check.mjs` 第 5 段用真实按键实测：触发、读结果、关闭三步均不丢焦点，见 15.18 |
| 6 | Tauri Rust 壳端到端验证 | **部分成立** | 2026-11-19 实测：Rust 链与 tauri 2.12.7 整棵依赖树在 arm64 macOS 上均能编成 `PE32/i386`（`linkprobe.exe` 1096192 字节）。完整项目卡在 `llvm-rc`——`tauri-winres` 编资源节要用，本机未装；`brew install llvm` 会提供它。**不是**架构限制，也**不是**「必换 Windows 机器」。见 15.10 |
| 7 | 代码签名支持 | **已评估（2026-11-19）** | 结论：可行，且不需要 Windows 机器——`osslsigncode` 在本机签 PE。瓶颈是证书与硬件令牌。**同时发现现有 ExeOnMac 产物签名不一致**（`codesign -v` 退 1），且因 prefix 在 bundle 内而无法以签名修复。见 15.11；决策待人工 |
| 8 | macOS 侧签名与公证 | **已评估（2026-11-19）** | 结论：Win2Mac 可行，需 Apple Developer ID（$99/年）+ 四个公证前置条件；**ExeOnMac 在当前布局下不可行**——prefix 在 bundle 内被原地写，签名必被破坏。见 15.11；决策待人工 |
| 9 | 层自动构建扩展 | 已完成（2026-11-19）| base / dotnet / fonts-cn 自动构建；mfc 无合法来源、vcpp base 已内置 |
| 10 | AI 接入层 | 已完成 | MCP server、统一命令行、Skill、专家包四种形态全部落地；协议层零依赖自研 |

**不做的事**（已明确排除，不在路线图上）：自研 PE 加载器、接入 FEX、API 语义映射层、macFUSE / kext / 系统扩展、游戏启动器业务、云桌面、**内置 LLM 或封装模型调用**。`ai/` 的定位是把本仓库能力交给外部 AI，不是自己变成 AI 工具。

---

## 十八、参与贡献

### 18.1 四条纪律

1. **退出码只追加，不改含义**。已发布的码值一旦改动，所有依赖它的脚本都会失效。
2. **错误码段位不越界**。`4xxx` 永远是输入物处理，不因某个方向的特殊需要而改变含义。
3. **`--json` / `--report` 时 stdout 只有 JSON**。日志一律走 stderr。
4. **help 文本必须与解析器一致**。三件事都要成立：help 写的选项解析器都认、解析器认的选项 help 都写了、拼错的子命令明确报错而不是被当成路径。每条都有测试守着（三个 Node 方向是 `test/help.test.mjs`，ExeOnMac 在 `tests/test_phase0.py` 的 `TestCLIContract` 与 `test_phase6.py` 里），因为这类偏差不会崩溃——只会让人白花时间。已踩过的实例见 15.3。

### 18.2 提交前检查

```bash
# 契约自检（必跑）
node contracts/validate.mjs

# 文档数字自检（必跑）。一条命令守两件事：12.1 的测试计数，
# 以及附录 C 里那 8 个人手数出来的数字（配置项 37、环境变量 13、
# 外部工具 18、子命令族 6、亮点 25、第 5 章 11 节、NOTICE 13 章、
# 产物校验 11 项）。后者 2026-11-20 之前没有任何守卫 —— 实测把
# 「37 个配置项」改成 32，旧版照样报「✓ 计数一致」。
node contracts/doc-counts.mjs --check

# 各方向自己的测试。每行都用子 shell 括起来，跑完回到仓库根目录 ——
# 否则第一行 cd 进 mac2win/ 之后，下一行 cd exeonmac 会按 mac2win/exeonmac
# 去找，报 No such file or directory（2026-11-20 在干净 clone 里实测复现）。
(cd mac2win  && npm test)
(cd exeonmac && python3 -m unittest discover -s tests)
(cd win2mac  && npm test)
(cd apponwin && npm test)
(cd console  && npm test)
(cd ai       && npm test)

# 契约合规的真实调用检查（必须仍在仓库根目录执行）
node console/bin/wacmin-console.mjs contract
```

若在 `set -e` 的脚本里跑，子 shell 的失败会正常向上传递，无需额外处理；若只想跑某一方向，直接 `cd <方向> && npm test` 亦可。

**`ai` 的测试必须在 ubuntu 上也能过**（CI 就是这么跑的）。若新增用例依赖 `darwin` 或某个外部工具，写条件跳过而不是让它变红——`ai` 层测的是「调度链路」与「协议正确性」，与具体平台的打包能力无关。

### 18.3 新增第三方组件的要求

任何新增的第三方库、框架、字体、图标、算法来源，必须先登记：**名称、版本、版权方、许可证类型、官方地址、在本项目中的用途、是否修改及修改说明**，同时更新 `README.md` 第 6 章与 `NOTICE`。

**无法确认许可证归属的组件，标注「待确认」并暂不合入，不得默认或编造。**

当前项目零第三方包依赖，这一条是为了保持这个状态而设的门槛，不是形式要求。

### 18.4 测试的组织方式

测试与实现同目录，不单独设 `test` 分支或独立的测试工程。

| 方向 | 框架 | 位置 |
|---|---|---|
| Mac2Win / Win2Mac / AppOnWin / console | `node:test`（Node 内置） | `<方向>/test/*.test.mjs` |
| ExeOnMac | `unittest`（Python 标准库） | `exeonmac/tests/test_*.py` |

**不引入测试框架依赖**，与零第三方依赖的原则一致。`node --test` 与 `python3 -m unittest discover` 已足够。

**跳过而非伪造**：需要真实 Wine / 7z / innoextract / swiftc 的测试，环境不具备时显式 `skip`，并在测试名里写明缺什么。断言里不出现「如果环境具备则……」这类条件性通过——那不是测试，是文档。

### 18.5 文档与代码同步的要求

改代码即改文档，两者在同一个提交里。具体要求：

| 改动类型 | 必须同步的位置 |
|---|---|
| 新增/删除退出码 | `contracts/exit-codes.json`、本文件 5.2.1 |
| 新增/删除错误码 | 对应方向的 `errors` 模块、`contracts/error-prefixes.json`、本文件 5.2.2 |
| 修改报告结构 | `contracts/run-report.schema.json`、本文件 10.2，并递增 `schemaVersion` |
| 新增配置项 | 该方向的配置校验、本文件 9.2 |
| 新增环境变量 | 本文件 9.3 |
| 新增子命令或选项 | 该方向 help、`test/help.test.mjs`、本文件 10.1 |
| 修改校验项 | 该方向实现、本文件 3.1 与 15.5 |
| 新增外部依赖 | 本文件第 6 章、`NOTICE` |

### 18.6 提交信息的写法

沿用现有历史风格：**一句话说清改了什么，不写「修复了一些问题」**。

```
校验未完成的提示改由 report.blockers 驱动
7-Zip：显式指定的路径不再被静默跳过
doctor：不再把能用的 7-Zip 报成未安装，并把逐项结果放进 JSON
```

格式：`范围：改了什么`。范围可以是子项目名（`mac2win` / `wepack` / `console`）、模块名（`doctor` / `verify`）或组件名（`7-Zip` / `NSIS`）。冒号用中文全角。

### 18.7 查看历史

各子项目的完整提交历史保留在子目录中：

```bash
git log --oneline -- mac2win/
git log --oneline -- exeonmac/
git log --oneline -- console/
```

### 18.8 联系方式

| 渠道 | 地址 |
|---|---|
| 仓库 | <https://github.com/ntars/Wacmin> |
| 问题反馈 | <https://github.com/ntars/Wacmin/issues> |
| 邮箱 | <ntars@qq.com> · <ntarsx@163.com> |

---

## 十九、版权与许可

Copyright (c) 2026 Ntarstudio（星玖工作室）

本项目按目录分层授权，**只使用 Apache License 2.0 与 MIT 两种宽松许可证**，全文见 [LICENSE](./LICENSE)（Apache-2.0）与 [LICENSE-MIT](./LICENSE-MIT)（MIT），分层说明见 [LICENSING.md](./LICENSING.md)。

| 范围 | 许可 |
|---|---|
| `contracts/`（共享契约层） | **Apache-2.0** |
| `console/` `mac2win/` `exeonmac/` `win2mac/` `apponwin/` `ai/` `.github/` | MIT |
| 根级 `README.md` `README_EN.md` `LICENSING.md` `NOTICE` 与各子项目 `package.json` `pyproject.toml` | MIT |
| 品牌名称、Logo、界面设计 | 保留所有权利 |

**默认归属**：上表未列出的本项目自研文件，一律适用根 `LICENSE`（Apache-2.0）。本仓库没有 `docs/` 目录（单文档制），逐路径路由见 [LICENSING.md](./LICENSING.md)。

**为什么契约层单独升为 Apache-2.0**。`contracts/` 的读者不是本项目用户，而是想按这套契约做第三方实现的人。Apache-2.0 多给两样东西：明示专利授权（第 3 条）与 NOTICE 保留义务（第 4 条 d 项）。后者恰好是契约这类「会被到处传递」的文件最需要的。

除此之外与 MIT 完全一样：可商用、可闭源、可修改、可再许可，**没有传染性**。再分发时保留版权声明、许可全文与 [NOTICE](./NOTICE) 即可。

**名称与商标**。「Ntarstudio」「星玖工作室」「Wacmin」等名称与标识归星玖工作室所有。两种许可都只给代码权利，不给商标权。

**第三方名称**。文档中出现的 Wine、Darling、Rosetta 2、NSIS、7-Zip、Electron、NW.js、Tauri、Node.js、Gcenx、Darling 等名称归各自权利人，仅用于说明依赖与兼容目标。

**无担保**。本程序按 Apache-2.0 与 MIT 条款「按现状」提供，不附带任何明示或暗示的担保。

---

## 二十、NOTICE 开源合规声明

### 20.1 声明位置

本项目采用**单一声明**：全部第三方组件、许可证义务与免责声明集中在仓库根的 [`NOTICE`](./NOTICE)。子目录不保留独立 NOTICE 文件。

| 文件 | 覆盖范围 |
|---|---|
| [`NOTICE`](./NOTICE) | 全仓：本项目自身许可、外部工具、打包纳入的运行时、间接依赖、参考过的项目、明确未使用的技术、字体与图标、免责声明全文、许可证原文索引、新增组件流程 |

理由见 1.1 节：三份 NOTICE 内容大量重叠，同一份 7-Zip 条目在五处各写一遍，一旦分散维护就存在某处漏改的持续风险。

### 20.2 全局依赖速查

完整信息（版本、版权方、许可证、官方地址、用途、是否修改）见本文 6.2 与 6.3 节，以及 `NOTICE` 的逐项条目。

| 组件 | 许可证 | 在本项目中的角色 |
|---|---|---|
| NSIS | zlib/libpng | 构建期调用，编译安装脚本 |
| 7-Zip | LGPL-2.1-or-later + unRAR 限制 | 构建期与校验期调用 |
| Wine | LGPL-2.1-or-later | ExeOnMac 运行时调用 |
| Gcenx macOS_Wine_builds | LGPL-2.1-or-later | Wine 预编译构建来源 |
| Rosetta 2 | 系统组件（非开源） | Apple Silicon 上的指令翻译 |
| innoextract | zlib License | 可选，解 Inno Setup |
| msitools | LGPL-2.1-or-later | 可选，解 MSI |
| Darling | LGPL-2.1-or-later（含 GPL 组件） | AppOnWin 评估对象 |
| Node.js / Electron / NW.js | MIT | 打包时纳入产物的框架运行时 |
| Tauri | MIT / Apache-2.0 | 目标项目自身使用，本项目不打包其运行时 |

### 20.3 许可证原文获取

| 许可证 | 地址 |
|---|---|
| MIT | 见 [LICENSE](./LICENSE) |
| LGPL-2.1-or-later | <https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html> |
| zlib License | <https://opensource.org/license/zlib> |
| unRAR license | <https://www.rarlab.com/license.htm> |
| Apache-2.0 | <https://www.apache.org/licenses/LICENSE-2.0> |

若上述链接失效，请访问 <https://www.gnu.org/licenses/> 或各项目官方仓库获取。

### 20.4 分发义务摘要

本项目**不分发** 7-Zip、Wine、NSIS、innoextract、msitools、Rosetta 2、Darling 的二进制，仅以独立进程方式调用用户自行安装的版本，因此**不触发** LGPL 的源码提供义务。

本项目**会分发** Node.js、Electron、NW.js 的运行时（打包进产物）。三者均为 MIT，义务限于保留原版权声明与许可文本，打出的安装包内应包含对应的 `LICENSE` 文件，或在安装向导 / 关于页面中提供可访问的许可文本。

若用户或第三方将上述未分发工具与本项目产物打包为单一安装包再分发，则触发 LGPL 的源码提供义务：必须同时提供对应组件的完整源码，或提供有效期不少于三年的书面源码获取方式，并保留其全部版权声明与许可证文本。

### 20.5 引入第三方组件的登记要求

任何新增的第三方库、框架、字体、图标、算法来源，必须先登记：**名称、版本、版权方、许可证类型、官方地址、在本项目中的用途、是否修改及修改说明**，并同时更新本文第 6 章与 `NOTICE`。

**无法确认许可证归属的组件，标注「待确认」并暂不合入，不得默认或编造。**

---

## 附录 A、错误码总表

按段位排列。前缀：`M2W`（Mac2Win）、`EOM`（ExeOnMac）、`AOW`（AppOnWin）、`W2M`（Win2Mac）。

### A.1 段位与退出码的配对

| 退出码 | 含义 | 配对错误码段 |
|---|---|---|
| 1 | 未归类失败 | `9999` |
| 2 | 参数与输入错误 | `1002` / `1003` / `1004` |
| 3 | 能力未实现 | `7001` |
| 4 | 明确不支持 | `1005` |
| 5 | 缺少外部依赖 | `2001` / `2002` |
| 6 | 构建或安装失败 | `4001`–`5002` |
| 7 | 产物校验失败 | `6001`–`6003` |
| 130 | 用户中断 | `9001` |

### A.2 常用错误码

| 码 | 含义 | 建议处置 |
|---|---|---|
| `M2W_1002` | 项目目录不存在 | 检查路径 |
| `M2W_1003` | 配置项非法 | 按提示改正，注意 `MAC2WIN_7ZIP` 指向的路径不可用时也报此码 |
| `M2W_1004` | 输入物不可用 | 检查文件是否完整 |
| `M2W_1005` | 明确不支持（如原生模块、Electron ≥44） | 换输入物，重试无用 |
| `M2W_2001` | 缺 makensis / 7-Zip | `brew install makensis sevenzip` |
| `M2W_2002` | 外部工具不可用 | 按 `doctor` 输出的路径核对 |
| `M2W_3001` | 运行时下载失败 | 检查网络；或配 `runtimeArchive` 指向本地文件 |
| `M2W_3002` | 运行时校验和不匹配 | 删除缓存重下，或核对 `runtimeChecksum` |
| `M2W_4001` | 项目构建命令失败 | 先在终端手动跑一遍 `npm run build` |
| `M2W_4003` | 含原生模块 | 换纯 JS 替代包（错误信息里有具体包名） |
| `M2W_5002` | NSIS 编译失败 | 用 `--keep-staging` 保留脚本，手工跑 `makensis` |
| `M2W_6001` | 产物校验不通过 | **不要分发**。日志里有逐项结果 |
| `M2W_6002` | 用已有安装包校验时的必需文件缺失 | 产物不完整 |
| `M2W_6003` | 逐文件哈希不匹配 | 压缩或解压过程损坏 |
| `EOM_1005` | 明确不支持的软件类别 | 见 14.5，不尝试绕过 |
| `EOM_2001` | 缺 Wine 运行时 | `wepack runtime install` |
| `EOM_6001` | `.app` 产物校验失败 | 见 11.2 的校验规则 |
| `W2M_1005` | 输入物不可用 | 检查 `.app` 结构与可执行文件 |
| `AOW_1005` | 明确不支持的框架 | 见 3.4 的框架清单 |
| `9999` | 内部错误 | 附完整日志提 issue |

**完整清单以 `contracts/error-prefixes.json` 与各方向的 `errors` 模块为准**。本表只列常用项。

---

## 附录 B、GitHub 推送指引

本节按 `README提示词.md` 第六章的要求给出完整可执行命令、核对清单与失败替代方案。**执行前请先备份**。

### B.1 备份（第一步，不可跳过）

```bash
# 完整备份仓库（含 .git），空目录参数确保不嵌套
BK=~/Wacmin-backup-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BK"
ditto /Users/ntars/Github/Wacmin "$BK/Wacmin"

# 确认备份完整
du -sh "$BK/Wacmin"
ls -a "$BK/Wacmin"
```

用 `ditto` 而非 `cp -R` 是因为它能完整保留扩展属性与资源叉；`cp -R` 在 macOS 上可能丢失部分元数据。

**若只需备份工作区而不含历史**，可用：

```bash
cd /Users/ntars/Github/Wacmin
git archive --format=tar.gz -o "$BK/wacmin-worktree.tar.gz" HEAD
```

### B.2 清理与核对（推送前必做）

```bash
cd /Users/ntars/Github/Wacmin

# 1. 确认当前分支与远端
git branch --show-current          # 期望 main
git remote -v                      # 期望 origin 指向 ntars/Wacmin

# 2. 查看工作区状态：应当没有任何未跟踪的临时文件
git status --short

# 3. 查看改动清单（相对 HEAD）：确认每一项都是有意为之
git diff --name-status HEAD

# 4. 查看将进入提交的文件总数与清单
git ls-files | wc -l
git ls-files

# 5. 确认没有大文件（阈值 5 MB）
git ls-files -z | xargs -0 -I{} sh -c 'test -f "{}" && sz=$(stat -f%z "{}") && [ "$sz" -gt 5242880 ] && echo "$sz {}"' 2>/dev/null | sort -rn

# 6. 确认没有 macOS 垃圾文件进入索引
git ls-files | grep -E '(^|/)\.DS_Store$|(^|/)\._[^/]*$|(^|/)__MACOSX/' || echo "无垃圾文件"
```

**核对清单**（逐项确认）：

| # | 检查项 | 期望结果 |
|---|---|---|
| 1 | `git status --short` | 除本次有意改动的文件外，无其他条目 |
| 2 | `git diff --name-status HEAD` | 删除项为 `D` 的，都是本次要删的文档；新增项为 `A` 的，都是本次要加的文件 |
| 3 | `git ls-files '*.md'` | 恰好 5 个：根目录 `README.md` / `README_EN.md`，分层许可说明 `LICENSING.md`，以及 `ai/experts/wacmin-expert.md`、`ai/skills/wacmin/SKILL.md` 两个 Skill/专家包定义。**后三个是产品内容，不是文档冗余** |
| 4 | `git ls-files` 中的许可证文件 | 恰好 3 个：`LICENSE`（Apache-2.0）、`LICENSE-MIT`、`NOTICE` |
| 5 | 大文件扫描 | 无输出，或输出项均为可解释的测试固件 |
| 6 | macOS 垃圾文件 | 「无垃圾文件」 |
| 7 | `.gitignore` 覆盖范围 | `.DS_Store`、`node_modules/`、`dist*/`、`*.log` 均在其中 |

第 3 项此前写的是「只有 `README.md` 与 `README_EN.md`」，第 4 项写的是「只有 `LICENSE` 与 `NOTICE`」——两处都与实际索引不符（2026-11-20 实测：md 共 5 个、许可证文件共 3 个）。照着旧清单核对的人会把三个正当文件当成「不该入库的文档」删掉。清单里写「只有 N 个」这种封闭断言时，必须先 `git ls-files` 数一遍再写。

### B.3 提交与推送

```bash
cd /Users/ntars/Github/Wacmin

# 1. 暂存全部改动（-A 会记录删除）
git add -A

# 2. 再次确认暂存内容
git status --short
git diff --cached --stat

# 3. 提交
git commit -m "文档合并到根目录：删除子目录 README / LICENSE / NOTICE，纠正校验项数与测试规模"

# 4. 推送
git push origin main
```

**若远端存在本地没有的历史**（例如别人提交过），先用 `git pull --rebase` 再推：

```bash
git pull --rebase origin main
git push origin main
```

**若确认远端内容全部作废、需要完整刷新**（个人仓库、无协作者时才可考虑）：

```bash
# 风险提示：这会丢弃远端所有历史提交，不可恢复
# 执行前必须已完成 B.1 的备份
git push --force-with-lease origin main
```

用 `--force-with-lease` 而非 `--force`：前者在远端被别人更新过时会拒绝推送，避免覆盖他人工作。

### B.4 推送后验证

```bash
# 远端分支与本地一致
git ls-remote origin main
git rev-parse HEAD

# 远端文件清单（需要已登录的 gh）
gh api "repos/ntars/Wacmin/git/trees/main?recursive=1" --jq '.tree[].path' | grep -E '\.(md)$'

# 期望只有 README.md / README_EN.md 两个 Markdown
```

浏览器端核对：打开 <https://github.com/ntars/Wacmin>，确认根目录只有预期的四个文档，子目录中不再有 `README.md` / `LICENSE` / `NOTICE`。

### B.5 失败替代方案

| 错误现象 | 原因 | 替代方案 |
|---|---|---|
| `remote: Permission to ntars/Wacmin.git denied` | HTTPS 凭据失效或无权 | ① `gh auth login` 后重试；② 改用 SSH：`git remote set-url origin git@github.com:ntars/Wacmin.git`；③ 检查 `git config user.email` 是否为仓库有权限的账号 |
| `fatal: unable to access ... Could not resolve host` | 网络或代理 | ① 检查代理：`git config --get http.proxy`；② 临时设 `git config --global http.proxy http://127.0.0.1:PORT`；③ 换网络环境 |
| `RPC failed; curl 56 ... unexpected disconnect` | 单次传输过大 | `git config --global http.postBuffer 524288000`；或改 `git config --global http.version HTTP/1.1`；或分批推送（先推小提交） |
| `remote: error: GH001: Large files detected` | 存在超过 100 MB 的文件 | ① 从提交中移除：`git rm --cached <file>` 后 `git commit --amend`；② 已进入历史则用 `git filter-repo --path <file> --invert-paths`；③ 确需保留则启用 Git LFS |
| `error: src refspec main does not match any` | 本地分支名不是 `main` | `git branch -M main` 后重推 |
| 文件名大小写不生效 | Git 大小写不敏感 | `git mv Readme.md README.md`（两步：先改临时名再改回），或 `git config core.ignorecase false` 后重命名 |
| `! [rejected] main -> main (non-fast-forward)` | 远端有新提交 | ① `git pull --rebase origin main` 后重推；② 确认远端内容作废时用 `git push --force-with-lease` |
| `fatal: refusing to merge unrelated histories` | 本地与远端历史无关 | `git pull --allow-unrelated-histories origin main` 后解决冲突再推 |
| `Updates were rejected because the tag already exists` | 标签冲突 | `git tag -d <tag>` 后重打，或 `git push --force origin <tag>`（仅当确认旧标签作废） |
| 推送成功但网页看不到改动 | CDN 缓存或分支不对 | ① 确认在正确分支：`git branch --show-current`；② 强制刷新网页；③ `gh api repos/ntars/Wacmin --jq .default_branch` 确认默认分支 |
| `gh: command not found` | 未装 GitHub CLI | `brew install gh` 后 `gh auth login` |
| SSH 报 `Permission denied (publickey)` | 未配置密钥 | `ssh-keygen -t ed25519 -C "your@email"` → `gh ssh-key add ~/.ssh/id_ed25519.pub` → `ssh -T git@github.com` 验证 |

### B.6 远端仓库重建（最后手段）

仅在推送反复失败且确认远端内容可完全丢弃时使用。

```bash
# 风险：删除远端仓库会一并删除 Issues、PR、Releases、Wiki、Actions 记录
# 执行前必须已完成 B.1 的备份，并导出 Issues 与 Releases

# 方式一：GitHub CLI
gh repo delete ntars/Wacmin --yes
gh repo create ntars/Wacmin --public --description "macOS 与 Windows 双向应用互通套件"
git remote set-url origin git@github.com:ntars/Wacmin.git
git push -u origin main

# 方式二：网页端
# 1. 打开 https://github.com/ntars/Wacmin/settings
# 2. 拉到最底部 Danger Zone → Delete this repository
# 3. 重新 Create a new repository，名称仍为 Wacmin，不要勾选任何初始化文件
# 4. 回到本地执行上面的 set-url 与 push 两条命令
```

**这一步会丢失全部协作记录**。个人仓库、无协作者、且已备份时才可执行。

---

## 附录 C、自检清单

按 `README提示词.md` 第五章的十项要求逐条核对。

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 是否还有口语化表达或歧义句 | 已检查。全文采用书面语，无感叹号与省略号制造的随意感；术语首次出现处给出定义 |
| 2 | 是否遗漏核心功能、配置项或依赖 | 已补全。37 个配置项全表（9.2）、13 个环境变量全表（9.3）、18 项外部工具七要素表（6.2）、6 个子命令族（10.1）。数字与 `mac2win/src/core/config.mjs` 的 `DEFAULTS`（37 键）、`NOTICE` 第三章（18 行）、10.1 表（6 行）逐项对齐 |
| 3 | 每个亮点是否都有具体依据 | 二十五条亮点均含「亮点名称 / 价值 / 实现方式 / 差异化 / 证据」五段，证据全部为实测数据或可复现命令 |
| 4 | 设计细节是否都写明 | 第 5 章 11 节，覆盖异常输入与边界、超时重试降级容错、缓存与性能、并发与一致性、存储优化、安全防护、体验微决策、默认值理由、跨平台策略 |
| 5 | 第三方项目、版权、许可证是否完整出现在 README 与 NOTICE | 第 6 章 + `NOTICE` 十三节，两处信息一致 |
| 6 | 介绍是否与实际功能与目录结构一致 | 目录结构（11.1）按实际 `ls` 结果撰写；测试规模（12.1）与实测输出一致；校验项数（15.6）按实测 11 项 / 10 项区分 |
| 7 | 是否存在来源不明、未经授权的文本、代码、素材 | 无。全部代码自研，参考过的项目在 `NOTICE` 第 7 节逐项声明且未复制代码 |
| 8 | 是否同时保护自身版权并尊重他人版权 | 第 19 章声明自身版权与商标；`NOTICE` 声明他人版权与再分发义务 |
| 9 | 是否提供与中文版同步的 `README_EN.md`，两版顶部语言切换链接 | 是。两版章节标题逐一对应，顶部互链 |
| 10 | `NOTICE` 的法律文本是否保留英文原文，信息是否与 README 一致 | 是。MIT 免责声明逐字保留英文原文，依赖清单与第 6 章一致 |

---

**最后更新**：2026-11-15 · 基于仓库当前 `main` 分支的实现状态
