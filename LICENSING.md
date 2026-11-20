# 分层许可说明

> 本文件是人类可读的分层路由表。`LICENSE` 是 Apache-2.0 全文，`LICENSE-MIT` 是 MIT 全文。
> GitHub 只按 `LICENSE` 识别仓库主许可，因此显示为 Apache-2.0；MIT 覆盖的部分见下表。

本仓库按目录分层授权，只使用两种宽松许可证：**Apache License 2.0** 与 **MIT**。
许可全文见 [`LICENSE`](./LICENSE)（Apache-2.0）与 [`LICENSE-MIT`](./LICENSE-MIT)（MIT）。

Copyright (c) 2026 星玖工作室 Ntarstudio

---

## 零、默认归属（先看这条）

**下表未列出的、由本项目编写的文件，一律适用根 [`LICENSE`](./LICENSE)，即 Apache-2.0。**

这条兜底规则是必须的。只列目录而不写默认值，克隆者面对根级 `.gitignore`、
各子项目的 `package.json` 就无从判断归属，法律上等于没有授权。需要相反结果的
路径，必须显式写进下表——**不存在「靠猜」的路径**。

第三方与被封装进产物的运行时（Node.js、Electron、NW.js 等）不适用本兜底条款，
按第五节处理。

## 一、分层映射

| 路径 | 许可 | 说明 |
|---|---|---|
| `contracts/` | **Apache-2.0** | 共享契约层：退出码、错误码段位、报告结构、JSON Schema |
| `console/` | **MIT** | 控制台界面 |
| `mac2win/` | **MIT** | Mac 上打 Windows 包 |
| `exeonmac/` | **MIT** | Mac 上运行 Windows 程序 |
| `win2mac/` | **MIT** | Windows 上打 Mac 包 |
| `apponwin/` | **MIT** | Windows 上运行 Mac 程序 |
| `ai/` | **MIT** | AI 接入层 |
| 根级 `README.md` `README_EN.md` `LICENSING.md` `NOTICE` `.gitignore` | **MIT** | 说明文档与仓库配置 |
| `.github/` | **MIT** | CI 与仓库配置 |
| 各子项目的 `package.json` `pyproject.toml` `*.schema.json` | **MIT** | 随其所属子项目；`contracts/` 内的 schema 除外（见首行） |
| 品牌名称、Logo、界面设计 | **保留所有权利** | 不随代码许可授予 |

> 本仓库**没有** `docs/` 目录：说明文档全部收敛在根级 `README.md` 与 `README_EN.md`
> （单文档制，见第三节）。旧表把它列成 MIT，属于指向不存在路径的残留，已删除。

## 二、为什么契约层单独升为 Apache-2.0

`contracts/` 是四个方向共用的对外契约。它的读者不是本项目用户，而是**想按这套契约
做第三方实现的人**——他们可能是另一个工具的作者，需要让自己的退出码、错误码、
报告结构与本套件对齐。

Apache-2.0 比 MIT 多给两样东西，恰好是这一层最需要的：

1. **明示专利授权**（第 3 条）：第三方按契约实现时，不必担心专利纠纷。
2. **NOTICE 保留义务**（第 4 条 d 项）：归属声明不会被逐层传递后丢失。

除此之外与 MIT 完全一样：可商用、可闭源、可修改、可再许可，**没有传染性**。

## 三、单文档制

本仓库采用单文档制：许可全文集中在 `LICENSE` 与 `LICENSE-MIT`，分层路由集中在 `LICENSING.md`，
第三方组件与合规声明集中在 `NOTICE`，说明文档集中在 `README.md` 与 `README_EN.md`。
子目录不保留任何独立文档。

这样做的理由：同一份文本分散在多处维护，必然出现某一处漏改的持续风险。

## 四、商标

「Wacmin」「Mac2Win」「ExeOnMac」「Win2Mac」「AppOnWin」「星玖工作室」「Ntarstudio」
等名称、Logo 与界面设计归星玖工作室所有。

两种许可都只授予**代码**权利，不授予商标权，也不授予「暗示获得原作者背书」的权利。
修改版请更换品牌标识，或明确标注为非官方版本。

## 五、第三方组件

本项目零 npm / PyPI 第三方包依赖。被封装进产物的运行时（Node.js、Electron、NW.js 等）
由最终分发者承担许可义务，详见 [`NOTICE`](./NOTICE) 第四节。

**禁止引入 copyleft 组件**（GPL / LGPL / AGPL / MPL）：宽松许可无法反向吸收 copyleft。
