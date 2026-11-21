[简体中文](README.md) | **English**

# Wacmin

**Breaking the architectural barrier between macOS and Windows, enabling bidirectional application interoperability.**

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
[![Dependencies](https://img.shields.io/badge/dependencies-0%20third--party-8957e5.svg?style=flat-square)](#6-technology-stack-and-dependencies)

---

## 1. Name and Positioning

> **仓库描述 / Description**：`Wacmin —— 打破 macOS 与 Windows 的架构限制，四个方向实现双向互通（mac2win / exeonmac / win2mac / apponwin） | Breaking the macOS-Windows architecture barrier: four directions for two-way interop, each usable on its own.`
>
> **话题标签 / Topics**（20 个，仅英文）：`apple-silicon`, `arm64`, `cross-compilation`, `cross-compile`, `developer-tools`, `electron`, `exe`, `ia32`, `interop`, `macos`, `nsis`, `nwjs`, `packaging`, `tauri`, `windows`, `windows-installer`, `wine`, `x86`, `cross-platform`, `app-migration`


**Name**: Wacmin. Formed from the initials of **W**indows **a**nd **Mac** **in**terop.

**One-sentence positioning**: It decomposes "application interoperability between macOS and Windows" into four directions. Each direction stands independently, yet all four share a single external contract layer.

**Three boundaries of the positioning**:

1. **It is an interoperability suite, not a virtual machine.** It does not provide a complete Windows or macOS runtime environment; it solves exactly two classes of concrete actions: "produce an installer" and "run a program".
2. **The four directions are mutually independent.** Dependencies, tests and releases of any one direction do not affect the other three. There is no monolithic bundle that must be installed wholesale.
3. **Contract first.** Exit codes, error-code segments and report structure are defined at a single point in `contracts/`, and all four directions must comply. This is the sole reason they can be called "one project" rather than "a collection of four projects".

**Relationship to tools such as PCL**: The `mac2win` direction of this project (formerly named arm2exe) only addresses "building a Windows package on a Mac". It does not involve game-launcher business logic. The two are different product categories.

### 1.1 How This Documentation Is Organised

This repository adopts a **single-document model**: all explanatory material is consolidated in `README.md` (Chinese) and `README_EN.md` (English) at the repository root, while licensing and compliance statements are consolidated in `LICENSE` and `NOTICE` at the root. No subdirectory retains any standalone document.

There are three reasons:

1. **The five subprojects share one contract and one set of external tools.** Splitting the dependency inventory into five copies guarantees that the same 7-Zip entry is written five times with five possibly divergent version numbers.
2. **Readers need cross-direction comparison.** The capability boundaries of the four directions are only intelligible in contrast. Once dispersed across five documents, readers must either switch back and forth or read one and mistakenly assume the others behave the same.
3. **Legal texts should not be dispersed.** The three MIT texts have identical content with different attribution formats; maintained separately, there is a persistent risk that one copy is left unamended.

This file is therefore organised into twenty chapters, each subdivided by direction. **Every conclusion in any section is grounded in code and measurement**, never in second-hand numbers quoted from an older sub-document.

---

## 2. Overview

### 2.1 Background

Interoperability between macOS and Windows has long relied on three classes of solutions: virtual machines (Parallels, VMware), compatibility layers (Wine, CrossOver), and cloud desktops. Each carries a cost: a virtual machine requires a complete system image, a compatibility layer has incomplete coverage, and a cloud desktop depends on network and subscription.

In independent-development scenarios, the real requirement is often far narrower: **just build a Windows installer on this Mac and send it to users**, or **just run an exe someone sent me to see how it behaves**. Installing an entire virtual machine for such needs is a poor cost-benefit trade.

Concretely, the background of each direction differs.

**Mac2Win**: Producing Windows x86 packages on Apple Silicon has long been assumed to require either a Windows machine or a full cross-compilation toolchain. In reality, Electron ≤ 43, NW.js and Node.js all publish `win32-ia32` or `win-x86` prebuilt binaries upstream. Downloading them and packing them into NSIS requires no compiler at all.

**ExeOnMac**: Running Windows software on Apple Silicon Macs has three conventional answers. A virtual machine offers the best isolation but requires a whole Windows installation, with disk usage measured in tens of gigabytes. A commercial compatibility layer works out of the box but is closed-source and paid, with artefacts confined to a vendor-managed shared directory. Manual Wine configuration is the most flexible but demands that users understand `WINEPREFIX`, `WINEDLLOVERRIDES` and `wineboot`. More importantly: **none of these three turns the Windows application into that icon in the Dock**. What users get is still a launcher or a container-management interface.

**Win2Mac**: The reverse direction is nearly vacant. Producing a macOS `.app` on Windows is assembly rather than compilation: lay out the `Contents/` directory structure, write a valid `Info.plist`, and pack a zip that preserves Unix permission bits. The difficulty lies entirely in details: how zip central-directory external attributes store the mode, bundle identifier uniqueness, and inferring permissions by role on Windows.

**AppOnWin**: Darling officially supports Linux only; on Windows it requires WSL2, and GUI support is labelled "basic and experimental" upstream. This is the only one of the four directions that may fail to hold, and it is therefore placed last with a pre-defined fallback path.

### 2.2 Problems to Solve

1. **Incomplete direction coverage.** Most existing tools are unidirectional: either running Windows programs on a Mac (the Wine family) or building Windows packages on a Mac (the cross-compilation family). The reverse direction—building macOS packages on Windows and running macOS programs on Windows—is nearly vacant.
2. **Inconsistent behaviour.** If four directions each design their own exit codes and error formats, the scripting layer must implement four sets of branching logic and cannot drive them uniformly.
3. **Incomparable determinism.** Some directions rest on mature foundations (NSIS packaging, Wine execution) while others rest on a foundation still in the experimental stage (Darling). Discussing "support" without distinguishing them misleads users.
4. **Artefacts that cannot be identified or uninstalled.** Windows installers write files into a shared prefix by default, so multiple applications interfere with each other; after installation users cannot find where the program went; after deletion registry entries and DLLs remain in the prefix and accumulate.
5. **Verifiers that lie.** Most packaging tools report only "build succeeded" without verifying the artefact; a few verify, but degrade missing dependencies into warnings rather than explicit failure—so the user receives a report marked "verification passed" while not a single file among four thousand in the payload was compared.

### 2.3 Core Approach

**Host × action = 2 × 2, exactly filling the matrix with no missing cell.**

| Order | Codename | Host | Action | Directory | CLI | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **Mac2Win** | macOS | Produce Windows installer | [`mac2win/`](./mac2win) | `mac2win` | Complete |
| 2 | **ExeOnMac** | macOS | Run Windows programs | [`exeonmac/`](./exeonmac) | `wepack` | Complete |
| 3 | **Win2Mac** | Windows | Produce macOS app bundle | [`win2mac/`](./win2mac) | `win2mac` | Complete |
| 4 | **AppOnWin** | Windows | Run macOS programs | [`apponwin/`](./apponwin) | `apponwin` | Assessment-capable |

**Development order is sorted by determinism**: finish what can succeed first, leave what is most likely to fail for last. The reasoning is in section 5.1.

The four directions are structurally isomorphic: each subproject follows the same seven-layer skeleton, with only the "input artefact" and "output artefact" swapped.

| Layer | Responsibility | mac2win | exeonmac | apponwin | win2mac |
|---|---|---|---|---|---|
| `bin/` | Single command entry, supports `--json` and `--report` | ✓ | ✓ | ✓ | ✓ |
| `config` | Configuration normalisation | ✓ | ✓ | CLI flags | CLI flags |
| `errors` | Error codes + exit codes | ✓ | ✓ | ✓ | ✓ |
| `detect` | Identify the input artefact | Framework detection | Installer detection | Package format detection | Framework detection |
| `build` | Phased orchestration, stop on failure | 8 phases | 8 phases | 8 phases (incl. assessment) | 8 phases |
| `verify` | Artefact verification | 11 checks | 10 checks | Structural checks | Structural checks |
| `report` | Unified report | ✓ | ✓ | ✓ | ✓ |

### 2.4 Applicable Scenarios

- Independent developers working on macOS who need to ship installers to Windows users;
- Quickly validating how a Windows program behaves on a Mac without starting a virtual machine;
- Producing macOS app bundles on Windows (assembly-based, no compilation);
- Making Windows software appear in Launchpad and Spotlight like a native application;
- Migrating an already-configured Windows application between machines;
- Needing a uniform scripting interface to drive several of the above directions;
- Studying Wine prefix isolation and reuse mechanics.

### 2.5 Non-Goals

- No complete virtual machine: no system images, no hardware emulation.
- No game launcher: no game version management or mod handling.
- No performance promises: compatibility-layer performance is determined by the layer beneath; this project only wires things together.
- No promise that AppOnWin will hold: Darling's feasibility on Windows is unverified; see section 5.1.2.
- No self-developed PE loader, no FEX integration, no API semantic mapping layer.
- No macFUSE, kext or system extension installation.
- No modification of original installers and no modification of installed file contents; only path redirection and wrapping.
- No uploading of any user data over the network.

---
## 3. Core Features

### 3.1 Mac2Win: Producing Windows Installers on macOS

| Capability | Description | Status |
|---|---|---|
| Framework detection | Automatically identifies Electron / NW.js / Tauri / plain Node / static site | Complete |
| Runtime acquisition | Downloads the Windows x86 prebuilt runtime for the corresponding framework | Complete |
| Dependency collection | Walks the require graph from the entry point, intercepts native modules | Complete |
| Staging and shims | Lays out directories per framework, injects desktop-shell compatibility shims | Complete |
| NSIS packaging | Generates the install script and compiles it into an `.exe` | Complete |
| Artefact verification | Eleven checks: PE format, architecture, GUI subsystem, required files, payload runtime architecture, per-file hash comparison | Complete |
| Graphical interface | Local console: enter paths, adjust parameters, watch progress and reports | Complete |

**Four concrete routes** (one orchestration, four artefact shapes):

| Route | Approach | Artefact shape | Measured status |
|---|---|---|---|
| A · Prebuilt binary repackaging | Download the framework's official x86 prebuilt package, insert the user's project, rename, wrap with NSIS | Native window | End-to-end verified: Electron 43, NW.js 0.90 |
| B · Node runtime + custom launcher | Use the official Node `win-x86` build to host application logic; write a zero-dependency launcher that spawns the host process, serves static files and opens the browser | Browser UI | End-to-end verified: the Ondra (Tauri) project |
| C · cargo-xwin Rust shell | `cargo xwin build --target i686-pc-windows-msvc` compiles a genuine Tauri shell on macOS | Native window | Dependency tree verified to link into PE32/i386; complete project blocks on `llvm-rc` (not installed here), see 15.10 |
| D · Roads not taken | Running makensis under Wine, Zig cross-compilation, Docker Windows containers, a self-developed PE linker, swapping in the system WebView2 | — | Reasons recorded per entry |

**Eight-phase orchestration**: `preflight` → `project-build` → `runtime` → `collect` → `stage` → `manifest` → `package` → `verify`. Any failing phase halts the run and all subsequent phases are marked `skipped`.

### 3.2 ExeOnMac: Running Windows Programs on macOS

| Capability | Description | Status |
|---|---|---|
| Installer detection | Distinguishes NSIS / Inno Setup / InstallShield / MSI / Burn / Squirrel | Complete |
| Static extraction | Restores the file tree and main-exe candidates without installing | Complete |
| Wine runtime | Bundled or reused Wine, with Rosetta 2 translating x86_64 | Complete |
| Prefix and silent install | Creates the Wine prefix, applies each installer's silent parameters | Complete |
| `.app` packaging | Generates Info.plist, icon, Swift launcher | Complete |
| Layered packaging | Three stages: base, layers, recipes | Complete |
| Recipe library | Per-program compatibility recipes (`~/.wexe/recipes`) | Complete |

The current implementation stage is **phase 5** (queryable via `wepack version`). All tests pass, with **0 skipped**. Test samples are always generated on the spot: MSI is assembled as a CFB container in pure Python, NSIS is compiled with `makensis`, and Inno is compiled with ISCC under wine and then unpacked back with `innoextract`. Wine is not distributed with this project; `wepack runtime install` fetches it from upstream.

#### 3.2.1 Installer Detection

The decision order is fixed, and **hard structural evidence precedes string evidence**. The order cannot be swapped: Burn is itself an MSI, and NSIS strings can appear inside other installers' resources.

| Type | Evidence | Measured confidence |
|---|---|---|
| MSI | CFB header `D0CF11E0A1B11AE1` + root storage CLSID `000C1084-0000-0000-C000-000000000046` | 0.99 |
| WiX Burn | Same, plus stream names containing `WixBundle*` | 0.90 |
| NSIS | `DEADBEEF` at overlay `+4`, `NullsoftInst` at `+8`; `.ndata` section | 0.99 |
| Inno Setup | Payload contains `Inno Setup Setup Data (x.y.z)`; `.itext` section | 0.99 |
| InstallShield | `ISSetupStream` / `_setup.dll` strings | 0.35–0.90 |
| Squirrel | `Squirrel` string plus a sibling `.nupkg` | 0.50–0.90 |

Every decision emits an evidence chain (the `evidence` array) explaining why the type was chosen, so a misjudgement can be investigated.

**Why MSI detection uses the CLSID rather than stream names**: MSI stream names inside a CFB container are privately encoded. `_StringPool` is actually stored as mojibake such as `䡀㼿䕷䑬㹪䒲䠯`, so lookup by name necessarily fails. The root storage CLSID is a structural field, not subject to that encoding, and is therefore the most reliable marker.

#### 3.2.2 Static Extraction

| Type | Path | Note |
|---|---|---|
| NSIS | 7-Zip extracts directly | LZMA / bzip2 / deflate fully supported in one pass |
| Inno Setup | innoextract (the only viable path) | 7-Zip can only slice out the PE section; now reported honestly instead of as a false success |
| MSI | msiextract preferred, three-step fallback | See below |

The MSI fallback has three steps: 7-Zip extracts the embedded `cab` files, each `cab` is expanded, then MSI `File` and `Directory` tables are used to restore `fil<hex>` hash names into real file names and directories. Skipping the first two steps would leave the user staring at hundreds of hash-named files, which amounts to no extraction at all.

#### 3.2.3 Entry Point Location

Which exe among the extracted files is the one the user wants to double-click? The scorer weights location, subsystem, size, filename match, sibling DLL count and icon resources, and every adjustment is written into `reasons`. Key weights:

| Signal | Score |
|---|---|
| Under Program Files | +25 |
| At the extraction root | +25 |
| GUI subsystem | +20 (console −30) |
| Filename matches product name | +35 (approximate +20) |
| ≥ 3 sibling DLLs | +12 |
| Sibling `.pak` / `.asar` / `.resources` / `.dat` present | +8 |
| Contains icon resources | +10 |
| In an installer temp directory (`$TEMP` / `$PLUGINSDIR` / `AppData/Local/Temp` / top-level `temp/`) | −60 |
| Filename contains `unins` / `setup` / `update` / `node` / `python` | −45 |

Two kinds of signal **exclude outright** rather than deduct: an exe matching a runtime component name (`msedge` / `webview2` / `edgecore` etc.) or a runtime path marker (`/windows/`, `/common files/`) never reaches the candidate list. Deduction is not enough — an Electron app's bundled `msedge.exe` has the size and GUI traits to outrank the real entry point.

Of these two layers, only `/dotnet/` admits a product-name exemption. The other markers say "this is the system's or the installer's own area", which has nothing to do with the product name — a product called Windows still should not make `system32/x.exe` the entry point. `/dotnet/` is different: it is a **legitimate install location**. The .NET runtime itself installs as `dotnet/dotnet.exe`, and `RUNTIME_COMPONENTS_EXEMPTABLE` already accepts that "when the product is .NET, `dotnet.exe` is the main program". Before the fix the path layer excluded unconditionally: `dotnet/MyDotnetApp.exe` with product name `MyDotnetApp` returned nothing — an ordinary app unrelated to .NET, vanishing entirely just because it was installed under a `dotnet/` subdirectory. The exemption uses the same predicate as the component-name layer: does the filename match the product name.

`$INSTDIR` is **not** on that list: it is the install target directory the user chose, so `$INSTDIR/App.exe` is precisely the program being installed.

Blacklists yield when the product name matches. The product name comes from the installer's own version resource — the author wrote it, so it outranks any heuristic. When the product is called Node.js, `node.exe` does not take the −45 for `node`; when it is called Chromium, `chromium.exe` is not excluded by the runtime component rule. The failure that motivated this was measured, not hypothetical: `node.exe` earned +20 and then took an unconditional −45, letting `uninstall.exe` overtake it on GUI +20 alone. The user double-clicked and got an uninstaller.

Measured: in an NSIS sample `ondra.exe` scored 75 while `node/bin/node.exe` was penalised to −35, giving the correct ordering. In an MSI, `pwsh.exe` and `createdump.exe` were correctly separated.

Product-name tokenization must also split on `.`. It originally split only on `-` and `_`, so `Microsoft .NET Runtime` yielded a dotted `.net`, while the normalized form of the exe name is `dotnet` — `.net` is neither a substring nor a superstring of it, so the two could never match. The consequence is not "slightly off ordering" but **an entirely empty directory result**: `dotnet.exe` earns no +20 similarity points, then loses 45 to the `dotnet` blacklist entry, so its total goes negative and `rank_candidates` filters it out. A directory containing the .NET runtime was therefore judged to have no executable at all, and install reported "entry not found". An empty result is harder to spot than a wrong one — at least a wrong program can be double-clicked and tried. `dotnet` was also added to the exemption set: the exclusion layer already accepted that `dotnet.exe` is the main program when the product is .NET (`RUNTIME_COMPONENTS_EXEMPTABLE`), while the penalty layer kept deducting 45 — two rules contradicting each other.

The blacklist matches by **substring** and breaks on the first hit, so entry order carries meaning: if `a` is a substring of `b` and `a` comes first, `b` can never be reached — every name containing `b` also contains `a`. The list originally held 28 entries, of which 6 (`uninst` / `uninstall` / `updater` / `dxsetup` / `vc_redist` / `installer`) were entirely swallowed by shorter entries ahead of them and never fired once, annotated with a comment claiming "each has its own target, do not delete as redundant". That comment was wrong: it confused "different targets in theory" with "actually reachable in code". The list is now 22 entries with unchanged coverage (`unins` still catches `uninstall.exe`, `install` still catches `installer.exe` / `InstallShield_*.exe`, `setup` still catches `dxsetup.exe`, `redist` still catches `vc_redist.x64.exe`), and a test enumerates every `(a, b)` pair so nobody can later add a short prefix and turn the entries behind it into decoration. The runtime component table and its exemption table obey the same constraint and are guarded the same way.

Scanning has two independent limits: `max_files` caps how many candidates are collected, `max_probes` caps how many files are opened for probing. The latter guards a different failure — extensionless files each need a 2-byte MZ header read, and files that fail the probe never become candidates, so they do not consume `max_files`. Measured: 6000 extensionless non-PE files under `max_files=50` still took 7.8 seconds, essentially the same as `max_files=4000`, so the limit did nothing; a separate `max_probes` brought the same case down to 93 ms. Sibling directory features (DLL count, resource suffixes) are cached per directory and enumerated once per scan — the original code re-enumerated the same directory for every exe, costing 3.5 seconds for 800 exes in one directory.

Ties are broken by **directory depth**, not by path character length. The two are not equivalent: character length folds filename length into apparent depth. Measured, with both candidates at 50 points: `d/e.exe` (depth 1, 7 characters) outranked `root-program-with-long-name.exe` (depth 0, 31 characters) — yet "at the extraction root" is a +25 signal that a short filename should not override. The sort key is `(-score, path depth, character length, path)`, with the last term existing only to keep output stable.

After installation, the fallback layer that looks for the main executable back inside the prefix must re-check that the filename relates to the product name. In the scorer the product name is worth only +35 points, while a whole-directory scan adds "under Program Files" +25, "GUI" +20, and "has an icon" +10 — 55 points combined, enough for a leftover program from a failed install to rank first. Measured on this machine's real base layer, searching `Program Files/` for `Notepad`, `TotallyDifferentApp`, and `Zzzz` returned the same `Windows NT/Accessories/wordpad.exe` all three times: the product name had no effect on the fallback result, and installing Notepad yielded WordPad. This kind of error raises nothing and crashes nothing — it just quietly picks the wrong program. The gate reuses the scorer's normalization (`_normalize` strips separators and digits, `_squash` strips separators only) and accepts only **equality / prefix / suffix**, not arbitrary substrings — otherwise the two-character product name `Pa` would match the middle of `wordpad`. An empty product name passes through: with no basis to filter on, the old behaviour is kept.

Prefix and suffix matches additionally require a **length difference of at least 2**. When the two differ by a single character, "prefix" and "a similarly spelled different word" cannot be told apart: `mode` is a prefix of `modem`, yet `Modem.exe` is plainly not the program for a product named `mode`. This miss really did slip through — the claim-the-subdirectory check described in the next paragraph had already been fenced by word boundaries, but the fallback layer let it back in, and the end-to-end result was still wrong. Equality is always accepted, regardless of length.

The layer that claims a subdirectory by product name (path ①) must also compare by **word**, not by character. The original predicate was `k in name.lower() or name.lower() in k`; string substrings have no word boundaries, so a short word bites into the middle of a longer one: `Modem` matched by the product name `mode`, `Downloads` by `load`, `appdata` by `App`. The first two only claim the wrong directory; the third is worse — once subdirectories of `AppData/Local` are claimed by `app`, `best_candidate` immediately returns some exe inside one of them. Names are now split into word sequences (`7-Zip 24.08` → `['7','zip','24','08']`) and a **contiguous run of words** is required. Both directions are kept: product names are often longer than directory names, so `Visual Studio Code` installs into a directory called `Code/`, and dropping the reverse direction would break path ① entirely — yet that is the only path Electron-style installers can take.

#### 3.2.4 Prefix Creation and Silent Installation

Layers are cloned into the bundle in order with APFS clonefile, `dosdevices/c:` (a relative link) and `dosdevices/z:` (pointing at `/`) are created, placeholder registry files are filled in, and finally `system32` non-emptiness and link validity are verified.

Silent installation applies the parameter table per installer type and reaches the original installer via drive `Z:` (the installer is never copied into the prefix). The whole process is written to `install.log`. Timeout-forced cleanup is supported, as are installers that never exit after finishing (see highlight twelve in section 4.2).

#### 3.2.5 Runtime and Environment Self-Check

`wepack runtime` manages the Wine runtime from three sources, in descending priority:

| Source | Command | Network | Note |
|---|---|---|---|
| Local archive | `--archive x.tar.xz` | No | Most controllable, recommended for offline environments |
| CrossOver / Whisky | `--from-vendor` | No | Copies only the Wine runtime directory, leaves the original app untouched |
| GitHub | Default | Yes | Gcenx `macOS_Wine_builds` devel build, about 225 MB |

`wepack doctor` checks Rosetta 2, the Wine runtime (including architecture), the Python version, `sips`, `iconutil`, 7-Zip, optional tools and directory writability item by item, and prints copy-pasteable remediation commands for anything missing.

### 3.3 Win2Mac: Producing macOS App Bundles on Windows

| Capability | Description | Status |
|---|---|---|
| Directory assembly | Generates the `.app` structure (`Contents/MacOS`, `Contents/Resources`) | Complete |
| Info.plist generation | Template-driven, fields configurable, authoritative validation via `plutil` | Complete |
| Permission preservation | A custom zip writer preserves Unix mode, so `0755` survives extraction | Complete |
| zip packaging | Produces a transferable zip | Complete |
| File association | `--associate` repeatable, generates `CFBundleDocumentTypes` | Complete |
| Artefact verification | Structure, plist fields, executable permission bits, Mach-O type | Complete |
| Contract integration | Wired into the shared contract layer | Complete |
| bundle id uniqueness | Non-ASCII application names are normalised with a hash suffix to avoid collisions | Complete |

All tests pass, and a real `.app` directory plus zip can be produced.

**Why this direction has the highest determinism**: it involves no compilation, only assembly. It is fully isomorphic to Mac2Win (same 8 phases, same error-code segments, same report structure), so the implementation could be transplanted directly.

**What it does not do**: it does not compile Mach-O, does not code-sign, does not notarise, and cannot produce a dmg. The file pointed to by `--executable` must be supplied by the user; if it is not a Mach-O, the command warns explicitly rather than silently proceeding. `hdiutil` / `codesign` / `notarytool` are macOS-exclusive tools, which is a hard platform boundary.

### 3.4 AppOnWin: Running macOS Programs on Windows

| Capability | Description | Status |
|---|---|---|
| Structure parsing | Reads the `.app` directory, `Info.plist`, Mach-O header | Complete |
| Framework determination | Infers the technology stack from binaries and framework dependencies | Complete |
| Portability assessment | Three-level verdict `likely` / `unlikely` / `unknown` | Complete |
| Feasibility spike | Three states: `pass` / `fail` / `blocked` | Complete (this machine: environment not available) |
| Command-line program execution | Load and execute | Unverified (gate 1 `blocked`) |
| GUI program execution | AppKit window | Unverified (decisive gate 2 `blocked`) |

All tests pass. `assess` and `parse` are pure read operations that **run on any platform**; only `spike` requires a real Windows + WSL2 + Darling environment.

**Spike gates and verdict semantics**: all three gates must pass before proceeding. Gate 2 (loading a minimal AppKit window) is decisive—failing it demotes AppOnWin to a "compatibility assessment tool" (reporting whether something can run, without running it), removing it from the mainline. When the environment is unavailable the result is `blocked` rather than `pass`; **`blocked` is not `pass`**, and the data structure keeps them distinct.

**Measured sample**: `Calculator.app` assessed to 2 binaries, 21 framework dependencies and 3 frameworks explicitly unsupported by Darling. Frameworks absent from the list are always `unknown`; availability is never assumed.

**Feasibility verdict (measured 2026-11-19): environment not available.**

Falls in the third of the three possible verdicts — neither "holds" nor "does not hold". The basis is one complete `spike --app /System/Applications/Calculator.app --json` run, gate by gate:

| Gate | Status | Source |
|---|---|---|
| 1 Command-line Mach-O | `blocked` | `probeWsl()` returns `available:false`, `reason` = "host is darwin, not Windows; WSL2 is only available on Windows." |
| 2 AppKit window (decisive) | `blocked` | Same — the `darling` probe was never reached |
| 3 Info.plist parsing | `pass` | Real `.app` parsed, `Calculator` main binary located |

Overall `conclusion = unverified`, process exit code **5**. In the contract `5` means "missing external dependency", paired error code `AOW_2001` (`errorSegment: 2001/2002`), matching `exit-codes.json` item by item.

**Why not write "pending".** "Pending" carries no information: it does not distinguish "tried it and it failed" from "could not try". The two point in opposite directions for the next action — the first should be dropped or demoted, the second only needs a machine with Windows + WSL2. The verdict here is the latter, hence "environment not available". By the same token, **gate 3 passing must not be reported as "partially holds"**: gate 3 only proves the parsing capability works (which is what `assess` / `parse` already deliver), does not depend on Darling, and proves nothing about "can it run". All three gates must pass; missing one is unverified.

**What it takes to become "holds"**: a Windows 10+ machine, WSL2 enabled with a distribution installed, Darling built and installed inside that distribution, and an executable Mach-O sample (`--sample`). All four are required; see 5.1.2.

### 3.5 Shared Contract Layer

The single point of definition for consistent external behaviour across the four directions.

| File | Content | Who reads it |
| --- | --- | --- |
| `contracts/exit-codes.json` | Unified exit codes | All four CLIs, `console/` |
| `contracts/error-prefixes.json` | Error-code prefixes and segment allocation | Each direction's `errors` module |
| `contracts/run-report.schema.json` | `--json` / `--report` output structure | All four CLIs, `console/` |
| `contracts/validate.mjs` | Contract self-check + report validation | CI and local checks |

`console/` recognises only the format defined here; any direction changing a field name must change it here first.

### 3.6 console: Unified Entry Point for the Four Directions

| Capability | Description | Status |
|---|---|---|
| Status listing | `list` shows the availability of all four directions | Complete |
| Subcommand forwarding | `run <direction> <subcommand> [args]` | Complete |
| Aggregate self-check | `doctor` runs all four directions' `doctor` in parallel | Complete |
| Contract checking | `contract` really invokes each direction and validates report compliance | Complete |
| Web dashboard | Local service + SSE progress push + history persistence | Complete |
| Viewport measurement | `scripts/viewport-check.mjs` drives a real Chrome across three viewports (375 / 768 / 1440) in four stages: baseline / stress / touch targets / line-break quality | Complete |

All tests pass. The responsibility boundary covers exactly three things: locate a direction's CLI and spawn it as a subprocess, read back its `--report` JSON and render it, and check whether the four directions genuinely honour the contract. Seventeen of those tests guard that this module's contract checker and `contracts/validate.mjs` must reach the same verdict on the same report — two independent implementations will diverge, it is only a matter of time.

**No build logic is implemented here.** Rewriting the packaging flow in this layer would create a second source of truth, and the two would inevitably diverge over time.

### 3.7 ai: Handing the Four Directions to AI Callers

Four integration forms, all sharing the same dispatch layer (`console/src/directions.mjs`). No build logic is reimplemented.

| Form | Entry point | Audience | Status |
|---|---|---|---|
| MCP server | `ai/bin/wacmin-mcp.mjs` | Clients supporting MCP, e.g. Claude Desktop, WorkBuddy, Cline | Complete |
| Unified CLI | `ai/bin/wacmin.mjs` | Scripts and agent tool calls | Complete |
| Skill | `ai/skills/wacmin/SKILL.md` | Lets an agent decide *when* this repository applies | Complete |
| Expert package | `ai/experts/wacmin-expert.md` | When judgement criteria are needed rather than steps | Complete |

**MCP tool list** (six tools, grouped by intent rather than mapping one tool per subcommand):

| Tool | Purpose | Read-only |
|---|---|---|
| `wacmin_list_directions` | What each of the four directions supports, produces, and which host it needs | Yes |
| `wacmin_doctor` | Environment self-check with install commands for missing tools | Yes |
| `wacmin_build` | Produce artefacts (the only operation that writes to disk and may run for minutes) | No |
| `wacmin_verify` | Validate an existing artefact without rebuilding | Yes |
| `wacmin_assess` | Static compatibility assessment; executes no programs | Yes |
| `wacmin_run` | Escape hatch: exact subcommand and arguments, passed straight through | No |

All tests pass. The transport layer follows MCP 2025-06-18 stdio strictly: newline-delimited JSON-RPC, `stdout` carrying protocol messages only, all logging on `stderr`.

**Messages are strictly serialized.** A `tools/call` may be `build` or `package`, which write artifacts; two running in parallel contend for the same output directory, overwrite each other's intermediate files, and yield a half-finished product while both calls report success. Cancellation notifications are the sole exception — they must be able to interrupt an in-flight task immediately, and queueing them would make them pointless.

**Why not the official SDK**: this repository has zero third-party dependencies throughout. The stdio part of MCP is small (newline framing plus a handful of method names); `protocol.mjs` and `server.mjs` together are under 700 lines — readable, testable, dependency-free. Pulling in the SDK would turn "clone and run" into "npm i first".

**Why six tools instead of twenty-plus**: the four directions expose over twenty subcommands in total. Flattening all of them into tools leaves an agent unable to choose — the differences between tool names are not visible to it, so it can only guess. Grouping by intent gives every tool a clear moment of use, and unmodelled options go through `wacmin_run`.

---
## 4. Core Characteristics

This chapter is organised by direction. Every entry follows the same structure: **highlight name / value / implementation / differentiation / evidence**. All evidence is measured; nothing is optimistic without basis.

### 4.0 Cross-Cutting Highlights

#### Highlight 1: A complete 2×2 matrix with no missing cell

- **Name**: Directional completeness.
- **Value**: Solves the "unidirectional only" problem. Existing tools support either running Windows programs on a Mac or building Windows packages, never the reverse.
- **Implementation**: Host (macOS / Windows) × action (produce installer / run program) = 4 directions, each implemented.
- **Differentiation**: The four directions live in one repository and share one contract layer, rather than being scattered across four unrelated projects.
- **Evidence**: The directories `mac2win/`, `exeonmac/`, `win2mac/` and `apponwin/` all exist and are wired into the contract; `node console/bin/wacmin-console.mjs contract` passes the probes for all four.

#### Highlight 2: Contract first, so the four directions behave identically

- **Name**: Single-point contract definition.
- **Value**: Solves "four sets of exit codes means four sets of branching in the scripting layer".
- **Implementation**: Exit codes, error-code segments and report structure are defined once in `contracts/`; `validate.mjs` performs contract self-checks and report validation.
- **Differentiation**: Most multi-direction tools design their error formats independently, making uniform driving from above impossible.
- **Evidence**: Three iron rules (exit codes are append-only, error-code segments never cross boundaries, stdout carries only JSON when `--json` is set) are hard-coded in `contracts/` and each direction's errors module, and the `console` contract check genuinely invokes each direction to verify them.

#### Highlight 3: Development ordered by determinism, risk deferred to last

- **Name**: Determinism-first development ordering.
- **Value**: Solves "build the hardest thing first, then watch everything collapse when it fails".
- **Implementation**: Mac2Win (converged) → ExeOnMac (mature foundation, just a lot of work) → Win2Mac (pure assembly, highest determinism) → AppOnWin (experimental foundation).
- **Differentiation**: Most projects order by "feature importance", which front-loads unstable foundations and drags everything down when they fail.
- **Evidence**: Even if AppOnWin fails entirely, the first three still stand—the project has three legs.

#### Highlight 4: AppOnWin can be demoted; it is not all-or-nothing

- **Name**: Pre-defined fallback path.
- **Value**: Solves "what to do when an experimental direction fails".
- **Implementation**: Three spike gates, of which **gate 2 (loading a minimal AppKit window) is decisive**. Failing it demotes AppOnWin to a "compatibility assessment tool", removing it from the mainline.
- **Differentiation**: Most projects have only "do it" or "don't do it" for experimental features.
- **Evidence**: The fallback rule is stated in section 5.1.2; the three-state spike result (`pass` / `fail` / `blocked`) is distinct in the data structure, and `blocked` is never treated as `pass`.

### 4.1 Mac2Win

#### Highlight 5: Two hours forty-one minutes → fifty-six seconds; 110× from one fix

- **Value**: The Ondra project initially took **6241 seconds (1 h 44 min)** per build and produced **51,534 files**. This was not an environment problem but a design defect.
- **Implementation**: `copyTree` accepts `skipDirs` and skips `node_modules` at any depth when copying dependency packages—dependencies are already collected centrally and flattened at the **same level**, so the nested copy is redundant.
- **Differentiation**: The common approach adds `dereference: true` to `fs.cp` to expand symlinks, but under pnpm layout every package symlinks its dependencies into its own `node_modules`, so expansion turns a symlink farm into real files.
- **Evidence**:

| Metric | Before | After |
| --- | --- | --- |
| Payload file count | 51,534 | **6,722** |
| Build duration | 6241 s | **56.5 s** |
| Dependency package files | 3777 (50k after expansion) | 3306 |

Measured: **80 of 83** dependency packages carried their own `node_modules`. That is the source of the bloat.

#### Highlight 6: Symlink cycles deduplicated by `(dev, inode)`

- **Value**: `fs.cp({dereference:true})` expands infinitely on a tree containing symlink cycles. The Ondra project had 316 symlinks including an `A → B → A` cycle; `fs.cp` ran for six minutes and was still growing at 374 MB with no sign of stopping.
- **Implementation**: Deduplicate by `(dev, inode)` so that one physical directory is copied exactly once and subsequent encounters are skipped. This solves bloat and infinite recursion at the same time.
- **Differentiation**: Imposing a recursion-depth limit truncates legitimate deep directories; comparing path strings misses the case where different symlinks resolve to the same inode.
- **Evidence**: The same project went from six minutes of no progress to 56.5 seconds, producing 6,722 files.

#### Highlight 7: Artefact verification is a hard gate, and it does not lie

- **Name**: Three-state artefact verification.
- **Value**: Solves "build succeeded but the artefact is unusable", and the more insidious "the verifier reported success but nothing was actually verified".
- **Implementation**: Eleven checks are decomposed into two orthogonal dimensions, `ok` and `complete`. `ok` answers "were problems found"; `complete` answers "was everything verified". When verification is incomplete the exit code is 5 with an explicit "incomplete" report; the word "passed" is never printed.
- **Differentiation**: Most packaging tools report only "build succeeded" without verifying the artefact; a few verify but degrade missing dependencies into warnings instead of explicit failure—the user receives a report that lied.
- **Evidence**: Per-file SHA-256 comparison of 4060 files completes in the order of two seconds. When 7-Zip is missing the CLI prints "verification incomplete: N items were not verified" with an itemised list, and exits with code 5.

#### Highlight 8: arm64 macOS can indeed produce Windows x86 native GUI programs

- **Value**: The Tauri Rust shell was judged "impossible to compile on a Mac" for lack of an `i686-pc-windows-msvc` toolchain. That judgement was wrong.
- **Implementation**: `i686-pc-windows-msvc` is a Rust tier-2 target and can be compiled on non-Windows hosts. What is missing is not the compiler but **MSVC CRT headers and import libraries**, obtainable from Microsoft's official CDN—exactly what `cargo-xwin` does.
- **Differentiation**: Most approaches stop here and take the "browser UI + Node runtime" fallback. This project implements both: the fallback route is the default, and `buildRustShell: true` selects the native shell.
- **Evidence** (2026-11, M-series Mac / arm64):

```
rustc 1.100.0 · cargo-xwin 0.23.1
cargo xwin build --target i686-pc-windows-msvc --release
→ rsprobe.exe  92 KB  PE32 / i386 / windows-gui  entrypoint 69304  verify ok
```

**One trap worth knowing**: `cargo xwin cache xwin` downloads only `x86_64` and `aarch64` CRT/SDK components, not x86. A direct build then fails with `could not open 'user32.lib'`.

Setting `XWIN_ARCH=x86` **is not enough**. That variable only decides *what to download*, while cargo-xwin's cache check reads the first line of `xwin/DONE` and never verifies the files are on disk — so a state can exist where `DONE` says `x86` while `crt/lib/` holds only `x86_64`, and re-running the identical command reproduces the identical error. mac2win therefore does both: it sets `XWIN_ARCH=x86` for the build, and its preflight `x86-libs` item inspects the directories on disk (`crt/lib/x86`, `sdk/lib/um/x86`), reporting the mismatch **before** compilation starts. See 15.10.4.

#### Highlight 9: Electron's x86 ceiling determined by measurement, not guesswork

- **Value**: Electron stopped publishing `win32-ia32` from v44 onwards. Without a preflight gate the user waits twenty minutes and then gets a 404.
- **Implementation**: During preflight, probe upstream for whether a build for that architecture still exists (`curl -r 0-500` to read the HTTP status) and gate on known boundaries.
- **Differentiation**: Most tools document a version boundary in prose and only fail at the download stage. This project turns it into a hard preflight predicate.
- **Evidence**:

| Version | `electron-vX-win32-ia32.zip` | Conclusion |
| --- | --- | --- |
| v43.0.0 | 206 | Available |
| v44.0.0 | 404 | Removed |
| v45.0.0 | 404 | Removed |

#### Highlight 10: Dependency collection must be two-phase, or the artefact crashes on launch

- **Value**: Collecting packages from the import graph alone misses transitive dependencies. The measured failure was `Cannot find package 'cosmokit'`—the artefact packaged fine, verified fine, and crashed on launch.
- **Implementation**: Two-phase collection: first scan the import graph for direct dependencies, then expand the closure via each package's `package.json` `dependencies`; afterwards **rebuild a flattened `node_modules`** from the collection, because under pnpm's symlink layout the real location of a dependency is one level up.
- **Differentiation**: The common approaches are copying the entire `node_modules` (bloated, and drags in devDependencies) or copying only direct dependencies (missing transitive ones at runtime).
- **Evidence**: The Ondra dependency chain hit five consecutive traps (`cosmokit` missing, symlinks pointing into `.pnpm`, alias installation, workspace package paths, the host locating its kernel by relative path). Each was fixed, after which the host log reported "host ready http://127.0.0.1:9061".

### 4.2 ExeOnMac

#### Highlight 11: Layer reuse via clonefile—a 382 MB skeleton consumes only metadata space

- **Value**: Every application bundle needs a complete Windows skeleton (`drive_c/windows`, `system32`, initial registry state), measured at 382 MB across 1858 files. Copying it for real would add 3.8 GB for ten applications.
- **Implementation**: `cp -c` invokes APFS `clonefile(2)` for a copy-on-write copy. Layer contents are copied once at prefix initialisation, and all subsequent writes land on the private copy.
- **Differentiation**: The common shared-prefix approach (one `WINEPREFIX` for all applications) needs no copying at all but lets applications contaminate one another. This project wants isolation without paying the disk cost of isolation, and clonefile sits exactly at that intersection. Hard links are not used either—they would defeat "writing to Private never pollutes the shared layer", since writing to any copy mutates the shared inode.
- **Evidence**: After copying a 64 MB file, volume free space decreases by **less than 1 MB** (metadata level). Measurement is by free-space delta, not `du` (reason in section 5.5.1).

#### Highlight 12: Installation completion is judged by file growth, not exit code

- **Value**: Many NSIS and Electron/Squirrel installers do not exit after installing; they launch the freshly installed application, leaving the parent process hanging. Waiting for exit means waiting until timeout. Measured: a 34 MB Electron installer needed only 132 seconds to install but never exited, so waiting produced a return only after the 1200-second timeout.
- **Implementation**: Sample the prefix's file count and total bytes every 5 seconds; six consecutive unchanged samples mark installation complete, triggering an active wind-down and setting `settled_by_progress`.
- **Differentiation**: Most wrapping tools call `subprocess.run(timeout=N)` directly; with such installers the only recourse is to lower the timeout manually, and a timeout is then judged as failure.
- **Evidence**: The same installer went from 1215 seconds to 132 seconds, and was correctly judged successful.

#### Highlight 13: MSI table parsing bypasses private encoding to restore real filenames

- **Value**: Filenames inside MSI cabinets are `fil<32-hex>` hashes. Extracting them directly makes it impossible to identify the main program or restore the directory structure.
- **Implementation**: Parse MSI `_StringPool`, `_Tables`, `_Columns`, `File`, `Directory`, `Component` and `Shortcut` tables directly. Because stream names inside the CFB container are privately encoded and cannot be looked up by name, content features are used instead: the stream whose length equals the sum of all string-pool entry lengths is `_StringData`.
- **Differentiation**: Depending on `msitools` would be simpler, but it is not available by default on macOS and would add an external dependency. Self-parsing delivers MSI support with zero dependencies.
- **Evidence**: The 104 MB PowerShell 7.4.6 MSI yielded 913 real filenames and the main program was correctly identified as `pwsh.exe`.

#### Highlight 14: Runtime components excluded explicitly, not penalised

- **Value**: Installing an Electron application also installs WebView2, which contains an `msedge.exe` that matches every "main program" signal: GUI subsystem, size, icon resources. It was once selected as the entry point, so double-clicking the `.app` opened a blank Edge-kernel window.
- **Implementation**: Maintain a runtime-component list (`msedgewebview2`, `edgecore`, `msedge`, `dotnet`, …) and path markers (`/edgecore/`, `/webview2/`, `/dotnet/`); a match removes the candidate from consideration entirely rather than letting it compete.
- **Differentiation**: Penalising such files within the scoring model is the common approach, but penalising is not enough—when the genuine entry point scores low due to deep nesting or small size, a merely penalised `msedge.exe` can still rank first. **Exclusion is deterministic; penalisation is probabilistic.**
- **Evidence**: The entry point for the same installer was corrected from `Program Files (x86)/Microsoft/EdgeCore/.../msedge.exe` to `AppData/Local/空谷 Ondra/ondra.exe`.

#### Highlight 15: Installer filenames must be sanitised, never used directly as the product name

- **Value**: Taking `Ondra-1.1.7-alpha-windows-x64-setup.exe` directly as the product name yields `drive_c/Wacmin/Ondra-1.1.7-alpha-windows-x64-setup`. The path is unreadable and close to NSIS's 260-character path limit.
- **Implementation**: Split on separators, strip noise words such as architecture, version and stage markers (`setup`, `windows`, `x64`, `alpha`), then combine by rule: merge the first two segments when the first is very short and the second is not purely numeric (`MS Office`), otherwise take the first segment only (`npp` rather than `npp 8`).
- **Differentiation**: Most tools take the filename directly or take the version resource directly; the former produces unreadable paths, the latter has no fallback when the version resource is absent.
- **Evidence**: `Ondra-1.1.7-alpha-windows-x64-setup` → `Ondra`; `npp.8.6.9.Installer.x64` → `npp`; `MS-Office-setup` → `MS Office`.

#### Highlight 15b: Exactly one entry-point rule—`install` and `package` must name the same exe

- **Value**: `install` located the right entry, `package` located it again with a different rule—so **whatever you installed, the bundle pointed at the same system-supplied program**. Such a defect never raises an error: the `.app` double-clicks, launches, shows a Dock icon, and simply opens something the user never asked for.
- **Implementation**: The rule lives in a single module, `wepack/entry.py`; `cli._find_installed_entry` and `package._guess_entry` are aliases or callers of it. Search order is "most likely this install's own product" first: `C:\Wacmin\<product dir>` → `Program Files\<product dir>` → `Program Files (x86)\<product dir>` → `AppData\Local\<product dir>` → a whole-layer fallback over all four, and the fallback must pass a filename-relevance gate.
- **Differentiation**: `package` used to take the highest-scoring exe under `Program Files*` and return it. The scorer awards +25 for "under Program Files", +20 for GUI subsystem and +10 for an icon, so the base layer's own `wordpad.exe` reliably scores 55 and always wins—while the user's program is not in those directories at all and never enters the race.
- **Evidence**: Same prefix (W02Probe installed to `C:\Wacmin\w02\`), measured: before the fix `install` yielded `drive_c/Wacmin/w02/W02Probe.exe` and `package` yielded `drive_c/Program Files/Windows NT/Accessories/wordpad.exe`; after the fix both agree on the former, all 6 regression guards pass, and reinstating the old implementation turns 2 of them red immediately.

#### Highlight 15c: `build --json` writes one JSON document, merging both halves

- **Value**: `build` chains `install` and `package`, each with its own payload. `--json` used to be passed straight through, so stdout carried **two** concatenated documents and `json.load` raised `Extra data: line 50 column 1`—the reader got nothing usable at all.
- **Implementation**: Sub-commands are always invoked with `json=False` and their human-readable output is redirected to stderr via `_StdoutToStderr`; `build` emits one summary whose top level carries `entry` / `layers` / `bundle_id`, with `install` and `package` sub-objects for their respective fields.
- **Differentiation**: The usual approach is "every sub-command emits, the caller concatenates". That barely works in a shell (`jq -s`) but breaks the README 10.1 contract that stdout carries only JSON, and it muddies what `--report` means.
- **Evidence**: `wepack build setup.exe -o out --json | jq -r .entry` returns the entry path directly; single-document-ness is guarded by a test that counts segments with `raw_decode` and fails on a second one.

#### 4.2.1 Automatic layer builds: three of five are automatable, two are not

**Verdict table** (measured on wine 11.21 / macOS arm64, 2026-11-19):

| Layer | Automatable | Source | Blocker or note |
|---|---|---|---|
| `base` | ✅ | One `wineboot -u` run | — |
| `dotnet` | ✅ | The bundled `wine-mono-*/support/winemono-support.msi` | Installs wine-mono, **not** Microsoft's .NET Framework |
| `fonts-cn` | ✅ | User-supplied local font files | See "An overturned conclusion" below |
| `mfc` | ❌ | — | Wine does not implement MFC; no MFC binary ships with the runtime and there is no lawful source |
| `vcpp` | ❌ | — | The base `system32` already carries all 28 VC++ runtime DLLs; normally unnecessary |

**Measured dotnet layer**: `wepack layers build dotnet` → 1851 files / 332.6 MB / 36 seconds, `inspect_layer` returns `ok=True, problems=[]`. The result contains `Microsoft.NET/Framework/{v1.1.4322,v2.0.50727,v4.0.30319}/mscorlib.dll` plus the matching `Framework64` versions. The delta against base is **61 unique files, 60 of them under `Microsoft.NET/` (5.4 MB)**.

**An easy detail to get wrong**: after the MSI installs, `mscoree.dll` is **byte-identical** to base (md5 `3f9d890657e3829cecf67735d9dade16`, 196608 bytes in both). The MSI does **not** replace wine's stub; the only real addition is the `Microsoft.NET/` directory. Describing the dotnet layer as "upgrades mscoree" would be false.

**Two guard rails against the same class of false success**:

1. After `msiexec` returns 0, the code **must verify** that `Microsoft.NET/Framework` exists and contains `*/mscorlib.dll`, otherwise it raises `VerifyFailed`. Exit code 0 with nothing installed has happened repeatedly in this project.
2. An existing layer **refuses to rebuild** (`UsageError`) rather than deleting itself. A user may have hand-copied files into it; silently overwriting destroys their work.

**An overturned conclusion: Chinese fonts were never the gap**

The code used to say "Chinese fonts are a real gap: base's `Fonts/` is an empty directory". The directory *is* empty (0 files measured), but **the inference was wrong**—wine does not only look there:

- `wineboot` **auto-registers** host system fonts into the Fonts section of `system.reg` as `Z:\System\Library\Fonts\...`. Measured: base carries **883 entries** there (882 excluding the `#time` metadata), 878 of them pointing at Z: drive host paths; counting the single section, the Chinese families are **PingFang 48 / Hiragino 22 / Songti 16 / Kaiti 14 / Heiti 10**. So "Chinese does not render" is simply false.
- **One counting trap must be called out here**: `system.reg` contains both `[Software\Microsoft\Windows\CurrentVersion\Fonts]` and `[Software\Microsoft\Windows NT\CurrentVersion\Fonts]`, and **the two sections have identical key sets** (883 each, with no keys unique to either). They are two spellings of the same data, **not two sets of fonts**. Adding the two sections yields a number that is exactly double the truth — the earlier text stating "PingFang 96 entries, 254 Chinese fonts in total" was precisely that arithmetic, twice the real value. Use the `Windows NT` section only.
- The real gap is **lookup by Windows font name**: the exact names `SimSun`, `Microsoft YaHei`, `SimHei`, `DengXian`, `MingLiU` are **entirely absent** from base (measured 0 each), and none of the 21 `FontSubstitutes` entries (21 after excluding `#time`) maps a Chinese font.
- `FontLink\SystemLink` gives `Tahoma` (the stand-in for `MS Shell Dlg`) a fallback chain of `SIMSUN.TTC` / `MSYH.TTC` and similar Windows filenames that do not exist inside the layer—so that chain is broken on base.

**The `fonts-cn` layer therefore exists to pin fonts down and remove the host dependency, not to add missing Chinese glyph coverage.** It drops user-supplied font files into `Fonts/` so they ship with the artefact and still work on another Mac. Fonts installed that way are recognised under their own family names and do **not** become SimSun automatically—mapping names like `SimSun` across is a separate link in the chain (below).

**Addendum: the "lookup by Windows name" problem already has a solution, just not in this layer**

The missing `SimSun` described above is handled on the launcher side, independently of the `fonts-cn` layer:

| Stage | Mechanism | Location |
|---|---|---|
| Declare the mapping | `font_map` in `compat.yaml`: `微软雅黑: PingFang SC`, `宋体: Songti SC` | Recipe |
| Generate the registry file | Writes `Contents/Resources/Private/fontsub.reg` with entries under **both** `HKLM`'s `FontSubstitutes` and `HKCU`'s `Wine\Fonts\Replacements` | `FontSubstitution` in `launcher/Sources/main.swift` |
| Apply it | Runs `wine regedit /S fontsub.reg` before launch, then `reg query` reads back this run's UUID stamp; failure logs a WARN without blocking startup | Same |

**Both keys have to be written, because GDI and DirectWrite each read their own** (measured 2026-11-21): GDI reads only `HKLM`'s `FontSubstitutes`, while `dwrite.dll` contains no `FontSubstitutes` string at all and reads only **`HKCU\Software\Wine\Fonts\Replacements`**. The root keys are exact opposites — get one wrong and it has no effect. Six-group comparison and the PE probe are in 15.25; the GDI half is in 15.24.

In other words: `font_map` fixes the display problem when software hard-codes Microsoft YaHei, while the `fonts-cn` layer fixes whether an artefact's fonts depend on the host. They are not substitutes for each other—do not expect installing a layer to give you name mapping for free.

**Correcting a mistake I made last round**: an earlier note claimed "`fontreg` registered 4 entries". That was a misreading. `fontreg` **does not exist** in wine 11.21:

```
$ wine fontreg
Application could not be started, or no application associated with the specified file.
ShellExecuteEx failed: File not found.        # exit code 1
```

Wine **scans the directory** at startup instead, which `WINEDEBUG=+font` shows directly:

```
trace:font:unix_face_create unix_name .../drive_c/windows/fonts/WacminProbeCN.ttc, face_index 0..7
trace:font:insert_face_in_family_list Original font L"\\??\\C:\\windows\\fonts\\Songti.ttc" is newer ...
```

All 8 faces inside a single ttc get enumerated, and `is newer so skipping` proves the in-layer font really was loaded. The implementation therefore **runs no registration command at all**—it only guarantees the files land and are readable. One fewer external tool dependency, and one fewer place where exit code 0 could mean nothing happened.

**Error semantics for mfc / vcpp** (exit codes per `contracts/exit-codes.json`):

| Command | Exception | Exit code |
|---|---|---|
| `layers build mfc` | `MissingDependency`, with the manual copy path | 5 |
| `layers build vcpp` | `UsageError`, noting base already has 28 | 2 |
| `layers build <unknown>` | `UsageError` | 2 |
| `layers build fonts-cn` (no `--font`) | `UsageError` | 2 |

**Tests**: `tests/test_phase7_layers.py` has **31 cases**, 4 of which run real wine (2 end-to-end builds: dotnet MSI install and fonts-cn file placement with 0644 permission checks; 2 match runs against real layers); the rest need no wine. Four cases were verified to go red when the defect is re-injected: turning `host_to_wine_path` from an alias into a wrapper breaks the identity test; reverting version sorting from tuples to strings breaks the `11.3.0` vs `9.10.0` ordering test (`'9' > '1'`, so string sort picks the wrong version); making the Fonts-section parser accept any Fonts section makes `TestFontsSectionCounting` fail with `888 != 883`; reverting the layer DLL index to "system32 only" turns **5 cases** red across `TestLayerDllIndexCoverage` and `TestMatchAgainstRealLayers` with `['commdlg', 'd3d8'] != []`.

**A pre-existing defect fixed along the way: the layer DLL index missed `syswow64` and `Microsoft.NET/`**

`match_layers` decides whether some layer can supply a dependency by scanning which DLLs actually exist in the layer directories. The original implementation scanned only `drive_c/windows/system32` and `drive_c/windows`, non-recursively, so it missed two kinds of files that really exist:

| Missed directory | Measured size | Consequence |
|---|---|---|
| `drive_c/windows/syswow64` | 636 DLLs, **64 of which exist only in `syswow64`** (`d3d8` / `commdlg` / `avifile` / `ctl3d` …) | 32-bit apps importing these get `unsolved` "no layer can supply it", although they sit in base |
| `drive_c/windows/Microsoft.NET/Framework/v*/` | `mscorlib.dll` and 4 others | dotnet layer installed, yet `mscorlib` is still reported as unsolved |

The consequence is not a crash but **misleading output**: `unsolved` is a signal to switch approach or find a substitute, yet nothing is actually missing. Measured before the fix: importing `d3d8`+`commdlg` → `unsolved=['commdlg','d3d8']`; importing `mscorlib` → `unsolved=['mscorlib']`. After the fix both are `[]`, and `mscorlib` additionally moves `layers` from `['base']` to `['base','dotnet']`.

The judgement now lives in a single `_windows_dll_stems(root)` that both `base_dll_index()` and `_layer_dll_index()` call — no second copy (README 5.3 red line). Recursively scanning the whole `windows/` tree costs **23 ms** measured (dotnet layer, 1294 DLLs), which is negligible.

One boundary that must be stated honestly: `system.dll` exists in **neither** base nor dotnet (measured `rglob('system.dll')` returns 0 in both), so programs importing it are still reported `unsolved` — that is an honest conclusion, not a defect. wine-mono packs most of the BCL into a single `mscorlib`; a standalone `System.dll` is the Microsoft-original layout.

**A documentation error caught during the 2026-11-19 review (fixed; recorded here to prevent recurrence)**: this section previously claimed "254 Chinese fonts in total (PingFang 96 / Songti 28 / Kaiti 28 / Heiti 20 / Hiragino 44)". Measuring each one showed **every figure was exactly twice the real value**. The cause was not a transcription slip: the two Fonts sections in `system.reg` have identical key sets, and both were added together. The real single-section values are PingFang 48 / Hiragino 22 / Songti 16 / Kaiti 14 / Heiti 10. What makes this class of error dangerous is that a larger, more finely broken-down number *looks* more credible than an obvious mistake. Three structural-invariant tests now guard it (the two sections must share a key set, the parser must take one section, the Chinese count must not equal the sum of all sections), deliberately asserting structure rather than specific counts—host fonts change with the OS version, so hard-coded numbers would drift again.

### 4.3 Win2Mac

#### Highlight 16: A custom zip writer so Unix permission bits survive Windows

- **Value**: Building a `.app` on Windows, the real obstacle is not the plist but the **executable permission bit**. Windows has no concept of Unix mode; a zip produced by conventional tools extracts on macOS with the main executable at `0644`, and double-clicking does nothing.
- **Implementation**: A custom zip writer stores `external_attr = (mode << 16) | dosAttrs` in the central directory and sets `create_system` to `3` (Unix)—only when marked Unix will the extractor read the mode from the high 16 bits.
- **Differentiation**: Most cross-platform zip libraries write zero or only DOS attributes for external attributes; GNU zip writes Unix bits but requires a Unix host. A custom writer depends on no host and makes the rules explicit.
- **Evidence**: Three rules are guarded by tests: directory names must end with `/` and carry `S_IFDIR`, symlinks carry `S_IFLNK`, and `Contents/MacOS/*` is defaulted to `0755` by role. After extraction, `ls -l` and `plutil -lint` both pass.

#### Highlight 17: Chinese application names no longer collide on bundle id

- **Value**: The bundle id is the sole basis on which LaunchServices distinguishes applications. Yet the character class `[^a-z0-9-.]` swallows an entire Chinese segment: `app.记事本` → `app` and `app.我的应用` → `app` collide into the same id. Once collided, the Dock shows one icon, default-open-with overwrites each other, and `lsregister -u` removing one also deregisters the other.
- **Implementation**: When non-ASCII characters are present, append the first 8 hex digits of SHA-256 after the readable fragment; pure-ASCII input is returned unchanged so existing artefacts keep their ids (otherwise an upgrade would turn one application into two for existing users).
- **Differentiation**: The common approaches are "strip all non-ASCII" or "always error out". The former produces inevitably colliding ids; the latter makes it impossible for Chinese users to package at all. The original comment claimed "better to error than to emit an inevitably colliding id", but that never took effect—a purely Chinese domain normalises to `app`, which looks legitimate while silently producing a colliding id.
- **Evidence**:

| Input | Before | After |
|---|---|---|
| `app.记事本` | `com.wexe.win.app` | `com.wexe.win.app-7ea4b95c` |
| `app.我的应用` | `com.wexe.win.app` | `com.wexe.win.app-59362fed` |
| `app.空谷-ondra` | `com.wexe.win.app.ondra` | `com.wexe.win.app.ondra-c0c33160` |
| `tencent.wechat` | `com.wexe.win.tencent.wechat` | unchanged |

Measured across 11 common Chinese application names: before the fix only **one** distinct id was produced; after, all 11 differ. Three details matter equally: the `seed` (application name) must be mixed into the hash (two Chinese applications from the same vendor share a reverse domain); "partially lost" must also be caught (`cn.星玖.测试` → `cn` still has one segment, looks non-empty, and has lost all discriminating power); and the case where the domain is clean but the seed is Chinese must be caught too.

### 4.4 console

#### Highlight 18: Killing by process group is the only clean kill

- **Value**: Killing only the parent leaves orphans. `python3 -m wepack` spawns wine, 7z and swiftc; after the python process dies those children keep holding the prefix and ports, causing conflicts on the next run.
- **Implementation**: Children start in their own process group; on timeout `process.kill(-pid)` signals the whole group, `SIGTERM` → wait 2 s → `SIGKILL`.
- **Differentiation**: Node's `child.kill()` targets only the direct child. Cross-language process trees (Node → Python → Wine → Windows program) require process groups.
- **Evidence**: `WACMIN_TIMEOUT_MS` defaults to 30 minutes (60 seconds for `doctor`); after a timeout both port and prefix are immediately reusable.

#### Highlight 19: Parallel doctor, 555 ms down to 486 ms

- **Value**: `console doctor` used to invoke the four directions' `doctor` serially, with exeonmac alone accounting for 415 ms; users perceived it as frozen.
- **Implementation**: Run the four `doctor` calls concurrently, then backfill results by fixed index so output order stays stable.
- **Differentiation**: Concurrency easily introduces the new problem of random output ordering; this project backfills by index rather than by `Promise.all` completion order.
- **Evidence**: 555 ms serial → 486 ms parallel.

#### Highlight 20: Three bugs in the contract checker itself

This entry is not "what we got right" but "the checker itself can lie"—recorded because it is the class of defect most easily overlooked in projects of this kind.

- **Value**: The `contract` command verifies that the four directions genuinely honour the contract. When the checker itself is buggy, all four directions show green while the contract has long been violated.
- **Implementation**: The whitelist is no longer hand-written; it is read live from `run-report.schema.json`.
- **Differentiation and lesson**: All three bugs share one root cause—**the same information stored in two places**.
- **Evidence**:

| Defect | Symptom | Root cause |
|---|---|---|
| Prefix regex written as `[A-Z]{2,4}` | Did not accept the digit 2 in `M2W` / `W2M` | Hand-written regex instead of reading the contract |
| Whitelist missing `checks` | Compliant reports judged as containing unknown fields | Hand-written whitelist out of sync with the schema |
| Whitelist extra `config` / `nextSteps` | Non-compliant reports judged compliant | Same |

#### Viewport measurement: a check script that used to run on empty

A comment in `style.css` claimed that "after injecting a 139-character path, the three viewports showed N overflows each; adding these two rules brought them to zero". That claim originally had **no reproduction path**—the script that measured it never entered the repository, which amounts to no evidence. Adding `console/scripts/viewport-check.mjs` exposed two deeper problems.

**The script will not announce that it measured nothing.** It launches a real Chrome, renders the real page, injects a long string, measures rectangles, then exits 0. The first version reported "zero overflow across all three viewports"—which looked perfect. Only a negative check (removing the whole `overflow-wrap` group and re-running) revealed it **still reported zero**: the stress injection rewrote the text of existing `.stage-msg` elements, and those containers are **entirely empty** on page load—stage rows are only built by `app.js` after the user triggers a build once. Assigning to an empty set does nothing at all.

The fix is to stop rewriting text and instead create nodes matching `app.js`'s real DOM structure inside the real containers.

**Measuring only element boxes misses half the cases.** After fixing the injection the negative check reacted, but only the 375 viewport reported overflow; 768 and 1440 both reported zero—while wider viewports have more fixed columns and should be worse. The cause is `.check`'s pinned column widths, `grid-template-columns: 16px 200px 1fr`: pushing a 139-character path in leaves **the column width untouched and lets the text overlap the adjacent column**, while the element box measures perfectly normal. So every text node is additionally measured with `Range.getClientRects()`—the glyph boxes actually rendered, which is the boundary the user's eye sees.

| Viewport | Baseline | Stress (rules in place) | Stress (rules removed) |
|---|---|---|---|
| 375 | 0 | 0 | 10 |
| 768 | 0 | 0 | 1 |
| 1440 | 0 | 0 | 1 |

Reproduce with `node console/scripts/viewport-check.mjs` (human-readable table) or `--json` (JSON only on stdout). Exit codes: `0` no overflow / `1` overflow / `2` no Chrome found—separated because the two situations call for completely different responses, and merging them makes people investigate an environment problem as a code defect.

This script takes a dozen seconds and depends on a locally installed browser, so it does not belong in `npm test`. Instead `console/test/viewport-check.test.mjs` statically guards the things most likely to rot: the stress string is still 139 characters, the measurement still covers both boxes and glyph rects, the `style.css` group still carries `min-width: 0` and `overflow-wrap: anywhere`, and the stress injector must `import` the product's `writeText` rather than reimplementing line breaking. The third and fourth are the real value—delete those two CSS lines in passing, or let `el()` bypass `writeText`, and `npm test` goes red immediately rather than waiting for a user on a narrow screen to find the paths clipped or split mid-word.

### 4.5 ai

#### Highlight 21: One extra newline on `stdout` and the MCP client drops the stream

- **Highlight name**: Separating the entry point from the capability, and fixing a dormant defect along the way.
- **Value**: Solves "one capability must serve both humans and AI". Both humans and agents need to dispatch the four directions; the cleanliness requirements on `stdout` differ completely between the two.
- **Implementation**: Dispatch logic moved out of `bin/wacmin-console.mjs` into `console/src/directions.mjs`, leaving only argv parsing and printing in the entry file, plus an `isDirectRun()` guard (comparing via `realpathSync`—string equality would miss symlinks and `./` prefixes).
- **Differentiation**: This was not cleanup written for MCP; it exposed a **pre-existing real defect**. `console/src/server.mjs` previously imported `../bin/wacmin-console.mjs` to obtain the direction list for `/api/status`—so every HTTP request wrote 21 lines of Chinese usage text to `stdout` and set `process.exitCode` to 2. `console` never reads its own `stdout`, so the defect stayed invisible; the MCP specification requires `stdout` to carry protocol messages only, making the same pattern fatal.
- **Evidence**: Measured `stdout bytes: 0` after the fix, versus 21 lines per request and `exitCode after import: 2` before. Removing the guard makes the new test fail immediately (9 pass / 1 fail), confirming the test genuinely guards this.

#### Highlight 22: Six tools, not twenty-six

- **Highlight name**: Group by intent, not one tool per subcommand.
- **Value**: Solves "give an agent a pile of tools and it no longer knows which to use". The four directions expose over twenty subcommands; flattening them all into tools leaves the differences between tool names invisible to the agent, which can only guess—and a wrong guess costs a real build.
- **Implementation**: Six tools grouped by intent (list, self-check, build, verify, assess, passthrough), with unmodelled options going through the `wacmin_run` escape hatch.
- **Differentiation**: Most MCP servers use a mechanical one-tool-per-subcommand mapping; the tool count inflates with the CLI while the agent's selection quality degrades.
- **Evidence**: `wacmin_build`'s schema lists only `direction` as required—whether the origin field is `project` or `installer` depends on the direction, and JSON Schema's `required` cannot express "A or B, at least one". Hard-coding `required: ['direction','project']` would reject every legitimate `exeonmac` call.

#### Highlight 23: A failed build is not a protocol error

- **Highlight name**: Two error layers kept separate, business failures preserved verbatim.
- **Value**: Solves "the agent knows something failed but not why". Wrapping a build failure as JSON-RPC `-32603` leaves the agent with "internal error", no `M2W_1002`, and no way to tell the user "what is missing is not your project but 7-Zip".
- **Implementation**: Protocol-layer errors use the top-level `error` field (`-32700` / `-32600` / `-32601` / `-32602` / `-32603`); a command that genuinely ran and failed returns `result.isError = true` with a readable reason and the tail of `stderr` in `content`.
- **Differentiation**: Many implementations take the shortcut of translating every non-zero exit code into a protocol error, discarding the most valuable information.
- **Evidence**: Measured, the failure path returns `isError: true`, `exitCode: 2`, `error.code: M2W_1002` with a `hint`, while the success path omits `isError`; `wacmin` returns 5 when `wacmin run exeonmac doctor` returns 5, so exit codes pass through strictly.

---
## 5. Design Details and Engineering Trade-offs

This chapter records every non-obvious detail. Each entry corresponds to a real trap encountered or a deliberate trade-off, grouped by theme.

### 5.1 Development Ordering and Risk Control

#### 5.1.1 Why the ordering is what it is

```
Mac2Win  →  ExeOnMac  →  Win2Mac  →  AppOnWin
 complete     complete     complete    assessment-capable
```

| Direction | Determinism | Reasoning |
|---|---|---|
| Mac2Win | High | NSIS + prebuilt runtimes, already converged |
| ExeOnMac | Medium-high | Wine + Rosetta 2; the foundation is mature, leaving packaging, layers and recipes as engineering volume |
| Win2Mac | High | Pure assembly (zip + plist), isomorphic to Mac2Win, largely transplantable |
| AppOnWin | Low | The Darling foundation requires WSL2 on Windows, and GUI support is labelled experimental |

**Why Win2Mac comes after ExeOnMac**: its determinism is in fact the highest, but everything it reuses (eight-phase orchestration, error-code segments, report structure) comes from Mac2Win, so third position lets it transplant directly. The genuinely hard item is ExeOnMac, and deferring it would create a backlog.

**Placing AppOnWin last is not neglect**: by the time it is reached, the first three are done, so even total failure leaves Wacmin standing on three legs. Doing it first would drag the whole schedule down if it failed.

#### 5.1.2 AppOnWin's three spike gates

**The spike may jump the queue at any time**—the feasibility check only needs a WSL2 environment and does not occupy mainline effort.

1. Install Darling inside WSL2 and run a minimal command-line Mach-O;
2. **Load a minimal AppKit window** (even a single white rectangle)—the decisive gate;
3. Read `Info.plist` and locate the main binary.

Failing gate 2 demotes AppOnWin to a "compatibility assessment tool" and removes it from the mainline.

**Three states, not two**: the spike result is `pass` (measured success) / `fail` (measured failure) / `blocked` (environment unavailable, could not execute). `blocked` **is not** `pass`—writing "not verified" as "passed" is precisely the class of error this project most wants to avoid.

**`blocked` splits one level further** (added 2026-11-19): it has two causes that mean completely different things to the user, so the spike emits `inputErrors` to keep them apart.

| Cause | Example | Overall conclusion | Exit code |
|---|---|---|---|
| Environment unavailable | Host is not Windows / no WSL2 / no Darling | `unverified` | 5 |
| Wrong argument | `--app /nope.app` does not exist, `--sample` points at a missing file | `unverified` + non-empty `inputErrors` | **2** |

The dividing line is "was this gate ever executed": a non-existent path never reached parsing, so it cannot have failed; `fail` must be reserved for "ran once and failed". This previously recorded path errors as `fail`, which turned the overall conclusion into `rejected` with the wording "the direction is demoted to a compatibility assessment tool by design" — **the user had merely mistyped one letter, yet was told the direction was disproven**; the same path handed to `assess` produced exit code 2. The same input yielding two meanings across two subcommands leaves scripts unable to branch on the exit code. Any "invalid input path" now maps to exit code 2 (paired with `AOW_1002`), consistent with `assess` / `parse`.

### 5.2 Design of the Contract Layer

#### 5.2.1 The nine exit-code semantics

| Code | Meaning | When used |
|---|---|---|
| 0 | Success | Flow completed and artefact verification passed |
| 1 | Unclassified failure | Internal error or a failure not covered elsewhere (`9999`) |
| 2 | Parameter error | Missing, misspelled or mutually exclusive CLI arguments (`1002` / `1003` / `1004`) |
| 3 | Capability not implemented | The feature belongs to a later stage and is explicitly not done yet (`7001`) |
| 4 | Explicitly unsupported | The input's type or category falls inside a hard boundary; no bypass attempted (`1005`) |
| 5 | Missing external dependency | makensis / wine / 7z / innoextract etc. absent (`2001` / `2002`) |
| 6 | Build or installation failure | Project build, dependency collection, staging or compilation error (`4001`–`5002`) |
| 7 | Artefact verification failure | The artefact exists but violates the spec: wrong architecture, missing files, hash mismatch (`6001`–`6003`) |
| 130 | User interruption | SIGINT / SIGTERM received (`9001`) |

**The distinction between 3 and 4 is deliberate**: 3 means "not done now, will be done later"; 4 means "never will be done". Callers use it to decide between retrying and abandoning.

#### 5.2.2 Error-code segments never cross boundaries

| Segment | Range | Meaning |
|---|---|---|
| 1000 | 1001–1999 | Environment and input |
| 2000 | 2001–2999 | External tools |
| 3000 | 3001–3999 | Runtime |
| 4000 | 4001–4999 | Input-artefact handling |
| 5000 | 5001–5999 | Artefact generation |
| 6000 | 6001–6999 | Artefact verification |
| 7000 | 7001–7999 | Capability not implemented |
| 9000 | 9001–9998 | Flow control |
| 9999 | 9999 | Internal errors |

**Nine segments, not eight.** This table must match `segments` in `contracts/error-prefixes.json` item by item—`9000`'s `range` stops at `9998`, and `9999` is a segment of its own. This document previously merged the two into "`9000` / `9001–9999` flow control and internal errors" while the code keeps `9999` separate: `segmentOf()` in `validate.mjs` routes by the actual `range`, so a reader following the old text would expect `9999` to belong to segment `9000` and find the validator behaving differently.

Each direction defines concrete codes in its own errors module, but **segments never cross boundaries**. `4xxx` always means input-artefact handling and never acquires a different meaning for some direction's convenience.

`7xxx` gets its own segment because it **is not an error** but "not done yet". Mixing it into `1xxx` would make it impossible for a front end to distinguish "the user configured something wrong" from "the feature is not written".

#### 5.2.3 Exit codes and error-code segments must be checked in pairs

The `errorSegment` field in `exit-codes.json` is not merely a comment—it declares "which error code pairs with which exit code", and `validate.mjs` uses it to cross-check every report.

| Exit code | Meaning | Paired error codes |
|---|---|---|
| 2 | Parameter and input error | `1002` `1003` `1004` |
| 4 | Explicitly unsupported | `1005` |
| 5 | Missing external dependency | `2001` `2002` |
| 6 | Build or installation failure | `4001`–`5002` |
| 7 | Artefact verification failure | `6001`–`6003` |
| 3 | Capability not implemented | `7001` |

**`1005` is the only exception in the `1xxx` segment paired with exit code 4**: `1002` means "the path is wrong", `1005` means "this thing itself cannot be done". Their implications for automation are opposite—the former should retry, the latter should stop. In the implementation `exitCodeFor()` must test `1005` before routing by segment; reversing the order files it under exit code 2.

**This check was added later.** Early on it validated only "is the error-code format correct", which allowed a **cross-segment mismatch** such as "`verify` fails with exit code 7 but the error code is `M2W_1004` (input missing, segment 1xxx)"—format legal, semantics displaced; the caller looks up the artefact by exit code 7 when the real problem is a parameter. Even earlier, the contract marked `exit 4` with `errorSegment: "1002"` while all four implementations mapped `1002` to exit 2, and contract and implementation silently diverged for a long time. Both are the same class of problem: **validation checked existence, not self-consistency.**

#### 5.2.4 Division of labour between stdout and stderr

When `--json` / `--report` is set, **stdout carries only JSON and logs go to stderr**. A pipe can then hand stdout to `jq` without filtering log lines.

**This is the rule most easily broken**, and three directions broke it:

- mac2win's `verify` wrote logs to stdout;
- exeonmac's `version` printed human-readable text directly;
- exeonmac's `--report` conflicted with the `_StdoutToStderr` redirection mechanism—during redirection `sys.stdout` *is* stderr, so a subcommand writing its report to `sys.stdout` put JSON into stderr and `wepack ... --report | jq` received empty input. The fix is to use `_out()` uniformly.

The principle is consistent: **structured output and human output must go to different streams**.

### 5.3 Decision Logic: One Predicate, One Implementation

#### 5.3.1 doctor and verify once judged "is 7-Zip present" two different ways

- `doctor` only checked whether `7z` was on PATH;
- `verify` checked environment variables, the project directory, Homebrew, MacPorts, PATH, and finally scanned `/Applications/*.app`.

On the measured machine this produced a direct contradiction: `doctor` reported "[FAIL] 7z not installed" while at the same moment `verify` was successfully extracting and verifying with the 7-Zip bundled inside BlueStacks.

Worse, the FAIL from `doctor` made the aggregate self-check `allOk = false` with exit code 5—a perfectly usable environment judged unusable. The user would install the Homebrew version, re-run, and only then see green, having needed to do nothing at all.

**Rule**: the logic for one decision must exist in exactly one place. `doctor` now reports the same binary path that `verify` actually uses.

**"Not installed" and "installed but you cannot find it" are different things.** The former requires user action; the latter is tool failure. Measured environment: the `7zz` on PATH was a build-sandbox wrapper script (failing with `spawnSync 7zz ENOENT`), Homebrew was absent, yet BlueStacks and Parallels each bundled a **working** 7-Zip at `/Applications/*.app/Contents/MacOS/`.

#### 5.3.2 Tool probing cannot rely on exit codes alone

`/bin/echo i` also exits with 0. Judging by exit code alone accepts it as 7-Zip.

The consequence is insidious: the subsequent `7zz l -slt` receives unrelated text, no file list can be parsed, and the final report says "payload file count 0"—which looks like a corrupt installer but is actually a mis-selected tool.

**The criterion is now output features**: the output of `i` must contain both `7-Zip` (the program naming itself) and `Formats:` (the format-list header). Both must be present.

The same problem takes another form on the ExeOnMac side: PATH may contain a "forwarding shim"—the file exists and `os.access` passes, but the actual invocation returns 127. Tool probing therefore performs a smoke invocation in addition to the existence check, judges by exit code, skips shims that do not run, and suggests `WEXE_7Z` for specifying the real binary.

#### 5.3.3 Explicit configuration must not fall back silently

`MAC2WIN_7ZIP` is how a user explicitly says "use this one". An early implementation, when that path did not exist, would **quietly continue searching** and eventually use another copy on the system.

A user investigating "why did nothing change after I swapped the 7-Zip version" is sent entirely the wrong way: `doctor` reports the other copy's path while the user believes their own setting is in effect.

**The semantics are now "use it or fail explicitly"**: a missing path reports `M2W_1003` / exit code 2, and a path that exists but is not 7-Zip also explains why. There is no fallback.

Likewise, the `catch { return null }` in `verify` used to swallow configuration errors into "cannot infer target architecture", then verify against the default architecture and deliver a completely unrelated conclusion. Errors are now distinguished by message: configuration errors propagate, and only extraction failures return `null`.

#### 5.3.4 `undefined` and `null` are not interchangeable

`successReport` used to test `result.zipArtifact !== null`. When the caller omits the field it is `undefined`, and `undefined !== null` is true—so the report gained a spurious `{kind: 'zip', target: 'x86'}` entry with `path` and `bytes` missing.

Two consequences: the contract requires `artifacts[].path` to be a non-empty string, making the whole report non-compliant; and downstream code deciding "there is a downloadable artefact" by `artifacts.length > 0` renders a dead download link.

**The criterion is now `typeof value === 'string' && value !== ''`.** The empty string is more insidious than `undefined`—`typeof '' === 'string'` holds, so a type-only check lets it through.

### 5.4 Failure Paths: Timeouts, Retries, Degradation, Fault Tolerance

#### 5.4.1 Verification has three outcomes, not two

Artefact verification has three possible outcomes. The early implementation distinguished only the first two and misfiled the third as the first.

| `ok` | `complete` | Conclusion | Exit code | Error code |
|---|---|---|---|---|
| ✓ | ✓ | Verification passed | 0 | — |
| ✗ | any | Verification failed (the artefact is bad) | 7 | `M2W_6001` |
| ✓ | ✗ | Verification incomplete (tooling missing) | 5 | `M2W_2001` |

**Why they must be separate**: `ok` answers "were problems found"; `complete` answers "was everything verified". They are orthogonal.

The third row was added later. "7-Zip not found, skipping payload verification" used to be recorded as a `warn`, and since `ok` only looked for `fail` entries, `ok === true` resulted, the CLI printed "verification passed", and the exit code was 0—**while not a single one of the 4,000+ payload files had been compared**.

**Why this is more dangerous than a crash**: a verification failure prompts investigation; a false pass does not. The user takes an installer whose header alone was checked, together with a "verification passed" conclusion, and distributes it.

**Why 5 and 7 must be separate paths**: 5 means "I did not verify; install the tool and re-run", 7 means "I verified; the artefact is broken and must be rebuilt". Merging them sends the user investigating in the wrong direction.

#### 5.4.2 The second harvest after a timeout must tolerate failure

After a timeout, `process.communicate(timeout=15)` harvests the output, and this step can itself time out—the child inherited the pipe, so even after the parent dies the pipe stays open.

The implementation tolerates this fully: on a second timeout it force-closes the pipe handle and falls back to `wait(5)`, never raising again during wind-down. The original implementation lacked this protection, so a timeout raised an uncaught `TimeoutExpired`, leaving the process uncleaned and the log unwritten.

#### 5.4.3 Three-step process-group cleanup

`process.terminate()` alone is not enough: wine spawns `wineboot`, `services.exe` and `explorer.exe`, and after the parent is killed those children keep the prefix occupied, causing conflicts on the next installation.

Cleanup has three steps: `SIGTERM` the whole process group, wait 5 seconds for wine to finish writing the registry, then `SIGKILL` the group. `wineserver -k` is implemented as a cleaner alternative for interactive mode.

The same problem on the `console` side is solved with `process.kill(-pid)`—children start in their own process group, and a negative pid addresses the whole group. The default timeout is 30 minutes, 60 seconds for `doctor`, overridable via `WACMIN_TIMEOUT_MS`, with `0` meaning unlimited.

#### 5.4.4 Failed extraction clears half-products

When every extraction method fails, half-products created in the output directory during this run are removed so the directory stays clean. Otherwise a subsequent attempt with the same directory is rejected as "not empty" and the user must clean up manually.

#### 5.4.5 Installation failure does not auto-fallback to interactive

A silent installation failure does not automatically pop up an interactive window. The reasoning: automatic fallback interrupts batch runs, and the user may not be at the machine, so the window would hang indefinitely.

`--interactive` is explicitly specified by the user. This is a deliberate trade-off: **a little less "intelligence", a little more predictability**.

#### 5.4.6 Non-empty directories are refused, not deleted

`create_prefix` and `extract` error out when the target directory is non-empty; they neither overwrite nor delete. The directory may contain user data, and the tool has no authority to decide what may be removed.

A `--force` flag exists, but it changes only the error message, not the behaviour—deletion is the user's decision, not the tool's.

#### 5.4.7 Exit codes are insufficient to judge installation success

There are both "exit code 1 with nothing installed" and "exit code 0 having released only a few temporary files". `run_install` therefore snapshots `drive_c`'s (file count, total bytes) before and after and judges by **net increment**: at least 8 files and at least 1 MiB.

The threshold is not 1 because real installers leave a bootstrap loader and logs behind even when the user cancels midway; file count alone is also insufficient because some installers create many empty directories and zero-byte placeholders.

Two concepts are expressed separately in code: `InstallRun.exit_ok` answers "does the installer consider itself successful" (including MSI's 3010 = reboot required but succeeded), while `InstallRun.ok` answers "did this installation actually produce usable files". When the former passes and the latter does not, the log states "the installer reported success but no files landed in the prefix" and suggests `--interactive` / `--silent-args` for investigation.

#### 5.4.8 Missing layers do not block installation

The application may never reach that code path, and failing hard would make a package that "installs but lacks MFC" completely uninstallable. What is missing is reported explicitly through `warnings` and written to `install.log`.

#### 5.4.9 A broken recipe is equivalent to no recipe

When YAML is corrupt or fields are missing, `load()` returns `None` and probing takes over, so one bad cache entry does not block packaging. But **a recipe hit still verifies the file**: if the recipe's `entry` no longer exists (installer version changed, path moved), the code falls back to re-scanning and logs a WARN rather than trusting it blindly—blind trust in a cache produces a bundle that cannot be opened by double-clicking.

#### 5.4.10 Browser-launch failure must not terminate the application

Without an `error` listener, `spawn`'s error event escalates to `uncaughtException`; the log shows `spawn cmd ENOENT` and then the process dies. The fix is to attach an `error` listener and degrade to logging.

### 5.5 Files and Disk

#### 5.5.1 Measuring clonefile space

`st_blocks` or `du` cannot determine whether clonefile saves space. APFS counts shared blocks repeatedly for each copy, so `du` cannot tell that blocks are shared.

The correct measurement is volume free-space delta:

```python
before = free_space(path)
clone_tree(src, dst)
consumed = before - free_space(path)   # real consumption
```

This detail caused a misjudgement once: asserting with `du -sk` reported 20 MB both before and after clonefile, leading to the conclusion that "clonefile did not take effect".

**The other face of the same trap**: `disk.allocated` in `install --json` is the sum of `st_blocks`, which **in the clonefile case is an upper bound rather than real consumption**. The report states this explicitly rather than pretending it is precise.

#### 5.5.2 zip Unix permission bits must be written explicitly

`external_attr = (mode << 16) | dosAttrs`, with `create_system` set to `3` (Unix)—only when marked Unix will the extractor read the mode from the high 16 bits.

Three accompanying rules:

| Rule | Reason |
|---|---|
| Directory names must end with `/` and carry `S_IFDIR` | Otherwise the extractor treats them as ordinary files and the directory structure is mangled |
| Symlinks carry `S_IFLNK` | Otherwise the link is written as an ordinary file, becoming a content copy |
| `Contents/MacOS/*` defaults to `0755` by role on Windows | Windows has no mode, so permission can only be inferred from the path's role |

**Why not rely on the host**: GNU zip writes Unix bits but requires a Unix host; most cross-platform libraries write zero or only DOS attributes for external attributes. A custom writer depends on no host, and its rules are explicit and guarded by tests.

#### 5.5.3 dosdevices links must be relative

`c:` points to `../drive_c` as a relative link. With an absolute path, copying the `.app` to another machine or restoring from backup invalidates every link and the application cannot start.

`z:` pointing to `/` is standard Wine practice, letting installers reach the original installer at `Z:\Users\...\setup.exe`—without copying the installer into the prefix, which saves space and guarantees the original remains unmodified.

#### 5.5.4 Two download-to-disk strategies

| Scenario | Strategy | Direction |
|---|---|---|
| With `.part` staging | Write a temporary file first, `rename` after length verification. A mid-way failure never leaves a complete-looking bad file | ExeOnMac |
| Without `.part` staging | Write the target file directly; an interruption leaves a truncated file, but the next run discards it when the architecture assertion fails and re-downloads | Mac2Win |

**Mac2Win's downloads have no `.part` staging**—a known implementation difference whose behaviour is equivalent to "detect a bad cache and re-download"; it does not affect correctness. Stating this plainly is more important than presenting a uniform story.

#### 5.5.5 Overwrite by removing first

The target directory is removed before the upstream operation, avoiding a half-new, half-old artefact produced by "old files remaining plus new file writes failing".

#### 5.5.6 Packaging must exclude Apple junk files

macOS leaves three classes of files in directories: `.DS_Store`, `._*` (AppleDouble) and `__MACOSX`. Inside a Windows installer they are meaningless and show up as odd files to users. The exclusion rules **match exactly these three leaf names**, never by wildcard, to avoid deleting user data.

### 5.6 Invoking External Processes

#### 5.6.1 Silent parameters as argv, not strings

Parameters are passed as lists, never concatenated into strings. A path containing spaces would otherwise be split again.

**NSIS's `/D=` and wine's quoting rules are irreconcilable on paths containing spaces.** NSIS documentation requires `/D=` to be the last parameter and its path to be unquoted (even with spaces); wine, when assembling POSIX argv into a Windows command line, **automatically adds a pair of double quotes** around any argument containing spaces.

With both rules in force, the installer receives `"/D=C:\Program Files\App"`—NSIS only recognises `/D=` at the start of the line, discards the whole thing once quoted, and falls back to its own default directory.

Measured evidence (Ondra 1.3.0, same prefix, same installer):

| `/D=` value | Net file increase | Landing point |
|---|---|---|
| `C:\Program Files\DirTestA` | **0** | Nothing installed (exit code still 0) |
| `C:\DirTestNoSpace` | 6424 | `C:\DirTestNoSpace` |

The only variable is whether the path contains a space. Wine also does not support 8.3 short names (measured: `C:\PROGRA~1` does not exist), so there is no workaround.

The default installation directory is therefore `C:\Wacmin\<AppName>`, **containing no spaces**. When the application name itself contains a space (e.g. 空谷 Ondra) it is sanitised to underscores. This is not a sacrifice of fidelity—a program running under wine is not on real Windows anyway, and installing to `C:\Wacmin\App` versus `C:\Program Files\App` makes no visible difference to the user, whereas one installs and the other does not.

If `--install-dir` specifies a path containing spaces and the installer is NSIS, `/D=` will still fail silently; the net-increment check then judges "not installed" and reports honestly rather than pretending success.

**Inno's `/DIR=` rule is the opposite, yet the code likewise does not quote it.** Inno requires quotes when the value contains spaces, but wine adds them for us—adding our own results in escaping to `\"`. Measured:

| argv value | What Inno sees | Result |
|---|---|---|
| `/DIR=C:\Program Files\Ondra` | `"/DIR=C:\Program Files\Ondra"` | Correct |
| `/DIR="C:\Program Files\Ondra"` | `"/DIR=\"C:\Program` + `Files\Ondra\""` | Split into two arguments |

**InstallShield's `/v` must not carry literal quotes.** The official documentation writes `/v"/qn"`, but under wine the inner quotes are escaped to `\"` and the installer receives a deformed argument list. The compact form `/v/qn` is used instead (accepted by both InstallShield and msiexec).

#### 5.6.2 Subprocess output decoding must tolerate errors

`subprocess.run(..., text=True)` decodes with the locale encoding and `errors='strict'`. A single non-UTF-8 byte raises `UnicodeDecodeError`, and the outer layer treats that as "tool execution failed", reporting "7z cannot extract"—a completely wrong conclusion that sends people to investigate their 7z installation.

Bad bytes are normal: wine prints Windows paths containing Chinese in cp1252/cp936, some localised 7z builds output filenames in the system code page, and installers write control characters straight into stderr. This project has 19 `subprocess.run` call sites, all previously bare `text=True`.

They now use a shared constant `wepack.tools.TEXT_MODE` (`text=True` + `encoding='utf-8'` + `errors='replace'`). Judgements rely on exit codes and on-disk artefacts, not on output text, so replacing a few characters affects no conclusion. A static-scanning test guards this: bare `text=True` may not reappear in the source.

#### 5.6.3 Verification hashing does not land on disk

For 4086 files inside a 200 MB exe, calling `7zz x -so` once per file means 4086 process creations—measured at over ten minutes without completing. The approach is **one extraction plus local hashing**: stream the extract into memory with `7zz x -so` and hash there; 4086 files took **0.87 seconds**.

#### 5.6.4 Cancellation must actually kill the process tree, or "cancelled" is a lie

An MCP client can send `notifications/cancelled` to cancel an in-flight tool call. There is one easy mistake here: **rejecting a Promise does not mean the task stopped**.

If you only stop waiting and leave the subprocess alone, you get the hardest class of symptom to diagnose—the agent reports "cancelled", yet half an artefact sits on disk, a half-downloaded runtime sits in `~/.wacmin/mac2win/cache/`, and the next build reads it, fails its assertion, and reports an error with no relation to the cancellation at all.

`runDirection` in `console/src/directions.mjs` therefore accepts a `signal`, and on abort behaves as in Highlight 18: send `SIGTERM` to the **entire process group**, wait two seconds, then `SIGKILL` if still alive. The result carries `aborted: true` so callers can label the run "cancelled" rather than "failed".

**Why two seconds rather than an immediate `SIGKILL`**: `SIGKILL` gives the process no chance to clean up, leaving lock files in the Wine prefix so the next run reports "prefix is in use". Two seconds is enough for most processes to honour `SIGTERM`; a timeout means it is wedged, and a hard kill is then the only option.

**Unknown `requestId` values are ignored silently.** The specification requires it, and a client may send a cancellation after the response already arrived—that is not an error, only ordering.

### 5.7 Encoding and Chinese Text

#### 5.7.1 The real offset of the NSIS signature

NSIS's `firstheader` layout is `+0 flags`, `+4 siginfo (0xDEADBEEF)`, `+8 signature ("NullsoftInst")`, `+20 length`. The signature lives at `+4` and `+8`, **not at the overlay start**.

Testing `DEADBEEF` at `overlay+0` misses it. This was hit during implementation: a real sample was judged `unknown` until the first 24 bytes of the overlay were dumped and the offset error became apparent.

#### 5.7.2 MSI table data is column-major, not row-major

Column c starts at index `c * rows` and occupies `rows` u16 values.

`_Columns` is **four parallel column-major arrays**, not (table, column, name) triples:

```
[0n, 1n)  string number of the table name (not its position in _Tables)
[1n, 2n)  column ordinal (low 15 bits meaningful; 0x8000 = temporary column)
[2n, 3n)  string number of the column name
[3n, 4n)  column type (measured values do not match the msidbColumnType enum; this tool does not rely on it)
```

`_StringPool` begins with a 4-byte total character count, followed by 4-byte entries of `(cch:u16, refs:u16)`; strings are packed tightly in `_StringData` with no separators.

**Row count is not necessarily total u16 count ÷ column count**: measured, PowerShell's File stream is 18260 bytes = 9130 u16, while 8 columns × 913 rows occupies only 7304, leaving 1826 trailing values belonging to other data (that MSI packs multiple tables into one stream). Row count is therefore determined by content: the length of the leading run of `fil`+32 hex values is the row count, after which columns are read in column-major order.

#### 5.7.3 Four stages on the Chinese path

Chinese is not an edge case—ExeOnMac's target users install Chinese software. Four stages on this path each have distinct traps.

1. **Compose the path: keep Chinese, remove spaces.** The default directory is `C:\Wacmin\<application name>`, with whitespace in the name converted to underscores (`空谷 Ondra` → `空谷_Ondra`). Chinese must be retained (users need to recognise `C:\Wacmin\记事本`) and spaces removed (the NSIS `/D=` hard constraint). Both requirements must hold simultaneously without conflicting. Note that this rule constrains only **ExeOnMac (silent installation inside a Wine prefix)**; installers produced by Mac2Win are run interactively by users on real Windows and are not subject to `/D=`'s space constraint.
2. **Convert to Windows form: `drive_c/A/B` → `C:\A\B`.** This step must not introduce new spaces, or all previous effort is void. The test `test_windows_form_has_no_space_for_nsis` guards this gate.
3. **Into argv: Chinese passes through wine without mojibake.** Measured: `wine cmd /c "mkdir C:\Wacmin\记事本"` creates a directory whose on-disk name is UTF-8 bytes `e8 ae b0 e4 ba 8b e6 9c ac`, and `if exist` matches it correctly.
4. **Into the bundle id: Chinese must be stripped, but not to the point of losing all discriminating power.** See highlight 17.

#### 5.7.4 Encoding of the placeholder registry

If the base layer does not ship registry files, placeholders must be written. Wine's `.reg` must be UTF-16LE with a BOM and begin with `WINE REGISTRY Version 2`. Writing UTF-8 makes wine error out.

#### 5.7.5 Restart suppression goes through a .reg file

When an installer calls `ExitWindowsEx` the system must not actually reboot. The approach writes `wepack-suppress-restart.reg` into the prefix and imports it with `wine regedit /S`.

The registry binary is never edited directly—only a `.reg` file is written. The file stays in the prefix for auditability and rollback.

#### 5.7.6 3010 must count as success

MSI exit code 3010 means "success but reboot required". This is MSI convention, not an error. Without special handling, a large number of MSIs would be misjudged as failed installations.

#### 5.7.7 Code-point truncation in Info.plist

`CFBundleName` is truncated by **code point** (≤15 characters), never mid-character—one Chinese character occupies 3 bytes in UTF-8, and byte truncation produces an illegal sequence that `plutil` rejects outright. `CFBundleVersion` is normalised to dotted numerals with non-numeric segments replaced by 0.

#### 5.7.8 Streaming decoders need `stream` mode or Chinese text shatters into U+FFFD

MCP's stdio transport is a byte stream, and the kernel decides where `data` events split—independent of character boundaries. A Chinese character occupies 3 bytes and can easily be split after its first two:

```javascript
// Wrong: decode each chunk independently; a multi-byte character spanning chunks becomes U+FFFD
buffer += chunk.toString('utf8')

// Right: TextDecoder's stream mode retains the incomplete bytes internally
this.#buffer += this.#decoder.decode(chunk, { stream: true })
```

**This error is unrecoverable**: once `U+FFFD` enters the string, no amount of later concatenation restores the original bytes. It manifests as "Chinese occasionally turns into question marks in some tool result"—only the one splitting that actually happened goes wrong, so it is hard to reproduce reliably in tests.

`ai/src/protocol.mjs`'s `LineDecoder` therefore accumulates with `TextDecoder` in `stream: true` mode and **decodes first, then splits on `\n`** rather than splitting bytes and decoding line by line: one message may span several chunks and one line of text may itself be split, so both dimensions need handling.

### 5.8 Interfaces and Streaming Output

#### 5.8.1 UI wording must match the backend's verdict

Once the backend stops lying, a lying UI still defeats the purpose. Mac2Win's web console used to render "`${result.verify.length}` items passed"—that is **all items**, including `warn` and unverified ones. With 5 of 10 items unverified, the UI still said "10 items passed".

**There are now four phrasings**:

| Situation | Wording | Colour |
|---|---|---|
| Any `fail` | `N items failed` | Red |
| Any unverified item | `N passed, M unverified` | Amber |
| `warn` present but all verified | `N passed, M with warnings` | Amber |
| All green | `N passed` | Green |

Amber rather than green for unverified, because green tells the user "safe to distribute". Not red either—the artefact has no detected defect, and red would push the user toward the wrong action of rebuilding.

#### 5.8.2 ANSI escape handling in terminal output

The `console` dashboard converts subprocess stderr into SSE events pushed to the browser. Real stderr carries ANSI colour codes, and two traps were hit:

1. **A colour code sits between `▸` and `[`.** Stripping must handle all three sequence classes (CSI `\x1b[...`, OSC `\x1b]...`, two-character sequences); an incomplete regex fails to match.
2. **Chunk boundaries can split a sequence.** Accumulating before stripping is wrong—`incompleteEscapeTail()` must first hold back a possibly-split tail, then strip, then accumulate.

Without the second, occasional half-sequences leak into the UI as garbage such as `[36m`.

#### 5.8.3 Three consistency points in SSE

Server-Sent Events is a one-way stream with three boundary conditions:

1. **The stream must close after `done`.** Otherwise non-browser clients (`curl`, or a test helper using `request`) wait for `end` indefinitely and appear to time out.
2. **Late subscribers must receive earlier events.** A browser connecting after the task started would otherwise see a blank pane. A 256 KB event buffer is used, evicting the earliest `log` events first when it overflows so structural events (`stage` / `done`) are retained.
3. **Wind-down must flush.** A final log line without a trailing newline would be left in the buffer by the line-splitting logic and lost.

#### 5.8.4 Why SSE instead of WebSocket

Progress is one-way (server → browser), for which SSE suffices: native `EventSource` support, ordinary HTTP transport, automatic reconnection. WebSocket would add handshake and heartbeat complexity for no benefit here.

#### 5.8.5 Progress weights must follow elapsed time

If averaged across phases, packaging (over half the total duration) would occupy only 1/8, and users would watch the bar stall at 87%. Weighted by expected duration, the progress curve roughly matches actual elapsed time. The weight table is in section 10.3.

### 5.9 Default Parameters and Why They Were Chosen

| Default | Why |
|---|---|
| `target: "x86"` | The project's positioning is "build x86 Windows packages on ARM macOS". x86 runs on both 32-bit and 64-bit Windows, covering the most ground |
| `electronVersion: "43.0.0"` | Official `win32-ia32` builds stopped at v44. This is the **highest usable version**, not an arbitrary pick |
| `compression: "lzma"` | The smallest of NSIS's supported compressions. The cost is compile time, but packaging compiles once |
| `desktopShortcut: true` | Windows users expect to launch from the desktop. Setting false forces them to hunt through the Start menu |
| `requireAdmin: false` | Per-user installation avoids UAC prompts. Enabled only when writing to `Program Files` is genuinely needed |
| `verify: true` | Verification is the only guarantee of artefact trustworthiness. Turning it off skips verification, **not safety checks** |
| `outDir: "dist-mac2win"` | The `dist-` prefix makes it coverable by a single `.gitignore` rule; the suffix names the source direction |
| `WACMIN_TIMEOUT_MS: 1800000` | 30 minutes. The slowest measured real build (including downloads) is under 20 minutes, leaving margin without hanging forever |
| macOS minimum `13.0` | Requires `iconutil`, `sips` and APFS clonefile. 13 is where all three conditions stabilise together |
| `--min-macos` default `13.0` | Consistent with ExeOnMac's `LSMinimumSystemVersion`, so one user's two directions do not demand different systems |
| `requireAdmin: false` → installs to `%LOCALAPPDATA%\Programs\<App>` | The standard per-user location on Windows: no UAC elevation, and uninstallation leaves nothing that needs administrator rights to remove |

**Configuration validation reports everything at once, not the first problem found.** A configuration file can only be edited one place at a time; reporting one problem per run forces five or six rounds. After merging, validation runs once and covers everything. The eight checks are in section 9.2.

### 5.10 Abnormal Input and Malformed Data

#### 5.10.1 Malformed reports must not crash the dashboard

`console` reads report JSON produced by four directions. That JSON may be malformed because of version skew, an interrupted write, or a third-party generator. Nine crash inputs are covered:

| Input | Consequence without handling |
|---|---|
| `stages: [null]` | Accessing `null.status` throws `TypeError` |
| `checks: {}` | Calling `.map` on an object throws `TypeError` |
| `ok: "true"` (a string) | String truthiness passes and the logic takes the wrong branch |
| `artifacts: [{path: null}]` | Renders an empty link |
| `error.code` as a number | Regex validation throws instead of returning no-match |
| `stages[].status` with an unknown value | Progress bar width computes to `NaN` |
| Artefact name containing an unpaired surrogate | JSON serialisation throws `URIError` |
| `durationMs` negative | Formats as `-1ms` |
| `input.path` empty string | Displays an empty path |

The uniform strategy: **validate at the boundary, do not add defensive null checks internally**. The boundary layer converts malformed input into errors with explicit reasons; internals rely on the type contract.

#### 5.10.2 Path traversal in zip entries

Entry names are first normalised to a single separator, then rejected if they start with `/` or contain `..`. Entries such as `../../etc/passwd` in a zip are a common attack technique.

#### 5.10.3 Four illegal forms of Windows filenames

| Form | Handling |
|---|---|
| Reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`) | Check after stripping the extension, since `con.txt` is equally illegal |
| Disallowed characters (`\ / : * ? " < > \|` and control characters) | Checked before packaging, reported as an error |
| Segments ending in a dot or space | Such names are **silently discarded** on Windows, producing "packaged successfully but the filename does not match"; must be an error |
| Paths longer than 260 characters | A hard NSIS boundary; error out and identify which segment is too long |

#### 5.10.4 Help text and parser must agree in both directions

Three things must hold: every option in help is accepted by the parser, every option accepted by the parser is documented in help, and a misspelt subcommand reports an explicit error rather than being treated as a path.

Each is guarded by tests (in the three Node directions `test/help.test.mjs`; for ExeOnMac, `TestCLIContract` in `tests/test_phase0.py` plus `test_phase6.py`), because such divergence does not crash—it merely wastes the user's time. Concrete instances are in section 15.3.

**One behavioural defect fixed in passing**: `win2mac biuld ./proj` and `apponwin asseess` were previously not recognised as "unknown subcommand"—the former reported "project directory does not exist", sending the user to inspect paths, and the latter was worse, printing a long help text and exiting with **code 0**, so `|| exit 1` in scripts never caught it.

### 5.11 Cross-Platform and Backward Compatibility

#### 5.11.1 Path separators

Internally `/` is used uniformly; conversion happens only when writing NSIS scripts. Mixing separators in `File` paths makes makensis fail to find files—a path once assembled as `"/tmp/app\*.*"` caused exactly that.

#### 5.11.2 Line endings

Generated text files always use LF: NSIS scripts are compiled by `makensis` on macOS, where LF works; `Info.plist` is XML, for which LF is the spec-recommended value.

#### 5.11.3 Executability determination

macOS looks at the `x` bit; Windows looks at the extension. The main executable inside a `.app` is located via `Info.plist`'s `CFBundleExecutable`, independent of the `x` bit—but files under `Contents/MacOS/` must still be `0755`, or the system refuses to execute them.

#### 5.11.4 Backward compatibility of artefacts

The bundle-id hash suffix is added **only when non-ASCII characters are present**. Pure-ASCII input is returned unchanged so existing artefacts keep their ids—otherwise an upgrade would turn one application into two for existing users.

#### 5.11.5 Published code values are immutable

Exit codes and error codes are an external contract once published. New ones may only be appended. A breaking change to `schemaVersion` must increment it, and `console` branches accordingly.

---

## 6. Technology Stack and Dependencies

### 6.1 Technology Stack by Direction

| Module | Language / runtime | Third-party packages |
|---|---|---|
| Mac2Win | Node.js ≥ 20 (ESM) | None; zero runtime dependencies |
| ExeOnMac | Python ≥ 3.11 + Swift 6 (launcher) | None; standard library and system frameworks only |
| Win2Mac | Node.js ≥ 20 (ESM) | None; custom zip writer |
| AppOnWin | Node.js ≥ 20 (ESM) | None; custom plist and Mach-O parsers |
| console | Node.js ≥ 20 (ESM) | None |
| ai | Node.js ≥ 18.17 (ESM) | None; MCP transport layer written from scratch |
| contracts | Node.js ≥ 20 (ESM) | None; validation scripts shared by all four directions |

**This point deserves emphasis**: all five subprojects introduce **not a single npm or PyPI third-party package**. PE header parsing, zip read/write, plist parsing, Mach-O parsing, CFB compound document parsing, MSI table parsing, MIME tables, the HTTP server, SSE push, YAML-subset read/write and the test framework are all either custom-built or use language built-ins (Node's `node:test`, Python's `unittest`).

**Specifically on the Python side**, every implementation uses only the standard library: `argparse`, `struct`, `subprocess`, `pathlib`, `hashlib`, `urllib`, `tarfile`, `tempfile`, `shutil`, `signal`, `json`, `re`, `logging`, `dataclasses`, `enum`, `typing`, `datetime`, `time`, `os`, `sys`, `platform`, `tomllib`.

**The Swift side** uses only the system frameworks `AppKit` and `Foundation`.

The cost is writing several low-level parsers ourselves; the benefit is zero transitive dependencies, zero supply-chain risk, and the ability to run immediately after `git clone` without `npm install`.

### 6.2 External Tool Dependencies

The following tools are not distributed with this project. Users install them on the host; this project invokes them as separate processes.

**The complete inventory lives in chapter 3 of [`NOTICE`](./NOTICE), which is the single source of truth**, recording name, version, copyright holder, licence, official address, purpose and modification status for every entry. This section lists only the tool name, licence type and purpose, so readers can quickly judge what to install and what licensing obligations follow. Volatile details such as version numbers are not maintained in two places.

| Tool | Licence | Purpose |
|---|---|---|
| **NSIS** (`makensis`) | zlib/libpng License | Mac2Win compiles install scripts into `.exe` |
| **7-Zip** (`7zz`) | LGPL-2.1-or-later + unRAR restriction | Extracts NSIS / Inno / MSI containers; artefact verification |
| **Wine** (`wine64`) | LGPL-2.1-or-later | ExeOnMac runs Windows PE binaries |
| **Gcenx macOS_Wine_builds** | LGPL-2.1-or-later | Runnable x86_64 Wine prebuild for macOS |
| **Rosetta 2** | System component, not open source | Translates x86_64 instructions on Apple Silicon |
| **innoextract** (optional) | zlib License | Unpacks Inno Setup installers |
| **msitools** (optional) | LGPL-2.1-or-later | Unpacks MSI; falls back to the custom MSI table parser |
| **Darling** (under evaluation) | LGPL-2.1-or-later (some components GPL) | Runtime foundation for AppOnWin, via WSL2 |
| **WSL2** | System component | Provides a Linux environment for Darling |
| **plutil** | System component | Win2Mac uses it as the authority for validating `Info.plist` |
| **sips / iconutil** | System component | ExeOnMac icon scaling and `.icns` packaging |
| **swiftc** | System component | ExeOnMac compiles the Swift launcher and the badge compositor |
| **git** | GPL-2.0 | Fetching the source |
| **Homebrew** (optional) | BSD-2-Clause | Recommended way to install the above tools on macOS |
| **cargo-xwin** (optional) | Apache-2.0 / MIT | Mac2Win cross-compiles the Tauri Rust shell |
| **Rust toolchain** (optional) | Apache-2.0 / MIT | Mac2Win compiles the Rust shell when `buildRustShell: true` |
| **LLVM / clang-cl** (optional) | Apache-2.0 with LLVM Exceptions | Linker when Mac2Win compiles the Rust shell |
| **MSVC CRT headers and libraries** (optional) | Permits this use by cargo-xwin but **forbids redistribution** | Mac2Win links the MSVC target; neither cached nor redistributed |


### 6.3 Framework Runtimes Bundled into Artefacts

During packaging, Mac2Win includes the target framework's **Windows x86 prebuilt runtime** in the artefact. These runtimes are not distributed with the repository; the build process downloads them from official upstream addresses. Copyright holders, licences and official addresses are listed in chapter 4 of [`NOTICE`](./NOTICE).

| Runtime | Version range | Licence | Purpose |
|---|---|---|---|
| **Node.js** (win-x86) | 20 / 22 LTS (default 22.23.5) | MIT | Application host for plain Node and most frameworks |
| **Electron** (win32-ia32) | ≤ 43.0.0 | MIT | Electron application host |
| **NW.js** (win-ia32) | Per project (default 0.90.0) | MIT | NW.js application host |
| **Tauri** | No runtime bundled | MIT / Apache-2.0 | Rust-compiled native exe requiring no JS runtime |


**Why Electron's ceiling is 43**: Electron stopped publishing `win32-ia32` prebuilt packages from v44. mac2win gates higher versions during preflight so users do not fail at the download stage. Measured evidence is in highlight 9.

**Redistribution obligations**: Node.js, Electron and NW.js are MIT-licensed and require retaining the original copyright notice and licence text when redistributing. Installers produced should include these runtimes' `LICENSE` files, or provide accessible licence text in the installer wizard or an about page.

**Network-dependent sizes** (downloaded on first build, then reused from `~/.wacmin/mac2win/cache/`):

| Runtime | Compressed size | Unpacked payload |
|---|---|---|
| Node.js 22.23.5 win-x86 | about 32 MB | about 80 MB |
| Electron 43.0.0 win32-ia32 | about 100 MB | about 220 MB |
| NW.js 0.90.0 win-ia32 | about 90 MB | about 200 MB |
| Wine 11.21 osx64 (ExeOnMac) | about 225 MB | about 600 MB |

### 6.4 Indirect and Transitive Dependencies

**This project has no transitive dependencies of its own**—none of the seven modules in the repository (four directions, `console`, `ai`, `contracts`) introduces npm or PyPI packages, so there is no "A depends on B, B depends on C" chain.

**Indirect dependencies exist at the runtime level**, bundled by the upstream builders; this project neither splits nor modifies them. The itemised account is in chapter 6 of [`NOTICE`](./NOTICE) and is not repeated here. One point worth knowing in advance: Electron / NW.js / Node.js embed Chromium / V8 / libuv, and Wine embeds FreeType / libpng / MoltenVK; those components' licences ship with the upstream packages and this project does not modify them.

### 6.5 Technology This Project Does Not Use

**The complete list lives in [`NOTICE`](./NOTICE) chapter 8 as the single source of truth** — 17 entries, including items that are frequently misattributed to this project: no MCP official SDK, no LLM API calls, no third-party code-signing service.

The four questions readers ask most often are answered directly here:

| Often assumed to be used | Actual situation |
|---|---|
| **npm / PyPI third-party packages** | All seven modules have zero dependencies. PE header parsing, zip I/O, plist / Mach-O / CFB / MSI parsing, the MIME table, the HTTP server, SSE push, YAML-subset I/O and the test harness are all written in-house or use built-in language capability. |
| **YAML libraries** (PyYAML / Yams) | Recipes and `compat.yaml` go through a hand-written restricted-subset serialiser; the Swift launcher ships its own ~130-line restricted parser. Only the syntax subset this project actually uses is supported — generality is not a goal. |
| **WebSocket** | Progress is one-way (server → browser), so SSE suffices. See [5.8.4](#584-why-sse-instead-of-websocket). |
| **x86 emulators / filesystem drivers / kexts** | None are used. ExeOnMac relies on the Wine runtime; AppOnWin plans to use Darling through WSL2. Both run entirely in user space. |

### 6.6 Fonts and Icons

**Bottom line: this repository contains no font files and no icon assets.** Per-item attribution of responsibility is in [`NOTICE`](./NOTICE) chapter 9; what follows covers only the three things most often misunderstood:

- **ExeOnMac extracts icons, but they never enter the repository.** Extraction operates on the installer supplied by the user, and the result is written only into that user's local `.app`, never distributed with this project.
- **Chinese fonts must be supplied by the user.** This project bundles no commercial fonts and offers no font downloads. If a user places fonts such as Microsoft YaHei or SimSun into the shared layer, the licensing responsibility rests with that user. Note this is only about making the artefact independent of host fonts—Chinese already renders on base, because `wineboot` registers the host's Chinese font families (PingFang / Hiragino / Songti / Kaiti / Heiti and others, 110 entries in the single section) into the registry (see [4.2.1](#421-automatic-layer-builds-three-of-five-are-automatable-two-are-not)). Making software's hard-coded "Microsoft YaHei" display correctly relies on `font_map`, not on font files.
- **Win2Mac generating no icon is a legitimate state.** `--icon` accepts a user-supplied `.icns`; without one no icon is generated and the artefact remains legitimately distributable.

Every visual element of the console and the dashboard is drawn with CSS — no bitmaps, no SVG assets, no icon font.

---

## 7. Installation and Deployment

### 7.1 Prerequisites

| Item | Requirement |
|---|---|
| Node.js | ≥ 20 (Mac2Win / Win2Mac / AppOnWin / console) |
| Python | ≥ 3.11 (ExeOnMac) |
| Swift | 6.0+, requires Xcode Command Line Tools (ExeOnMac compiles the launcher) |
| Operating system | Per direction, see chapter 14 |

This project **requires no** `npm install` or `pip install`—there are no third-party package dependencies.

**Node.js's `≥ 20` is a hard requirement**, not a conservative choice: `node:test`'s `--test` concurrency model, the stable `fetch` implementation and ESM top-level await all become complete at 20. **Python's `≥ 3.11`** is required for `tomllib` and `X | Y` type syntax.

### 7.2 Obtaining External Tools

```bash
# macOS: Homebrew
brew install makensis sevenzip

# Optional: improves Inno and MSI extraction fidelity
brew install innoextract msitools

# Required on Apple Silicon: Rosetta 2
softwareupdate --install-rosetta --agree-to-license

# If a Wine runtime is needed on macOS (ExeOnMac)
cd exeonmac && python3 -m wepack.cli runtime install
```

The Windows side has no hard external-tool dependency; Win2Mac artefacts are best verified once on macOS.

**Alternative 7-Zip sources**: if the Homebrew build cannot be installed, mac2win also searches `~/.wacmin/mac2win/bin/7zz`, MacPorts, PATH, and any 7-Zip embedded under `/Applications/*.app/Contents/MacOS/`. The `MAC2WIN_7ZIP` environment variable specifies a path explicitly; if that path is unusable it reports an explicit error rather than falling back silently.

### 7.3 Contract Self-Check

```bash
node contracts/validate.mjs
```

### 7.4 Installing Each Direction

No installation step is required; run directly from source. To use them as commands, each subproject's `package.json` declares a `bin` field so `npm link` exposes them globally; ExeOnMac's `wepack` can be installed into the current Python environment via `pip install -e .`.

| Direction | Run directly | Global install (optional) |
|---|---|---|
| Mac2Win | `node mac2win/bin/mac2win.mjs` | `cd mac2win && npm link` |
| ExeOnMac | `python3 -m wepack.cli` (inside `exeonmac/`) | `cd exeonmac && pip install -e .` |
| Win2Mac | `node win2mac/bin/win2mac.mjs` | `cd win2mac && npm link` |
| AppOnWin | `node apponwin/bin/apponwin.mjs` | `cd apponwin && npm link` |
| console | `node console/bin/wacmin-console.mjs` | `cd console && npm link` |

### 7.5 Unified Entry Point

```bash
node console/bin/wacmin-console.mjs list
```

### 7.6 Uninstallation

| Item | How to uninstall |
|---|---|
| All code | Delete the repository directory; nothing is left anywhere on the system |
| ExeOnMac artefacts | Drag the `.app` to the Trash; that completes uninstallation |
| ExeOnMac shared layer | `~/Library/Application Support/wexe/` is retained for reuse by other bundles; thorough cleanup requires manual deletion, which is irreversible |
| Mac2Win cache | `~/.wacmin/mac2win/cache/`; deleting it causes a re-download on the next build |
| console history | `~/.wacmin/history.json` |
| ai layer | Nothing to uninstall; it writes no state. If you registered the MCP server with a client, remove the entry from that client's configuration |

`wepack` provides no `uninstall` subcommand and never deletes files outside a bundle on its own. Cleaning the `wexe` root directory is left to the user.

---

## 8. Quick Start

This project has zero third-party package dependencies, so it runs immediately after `git clone` with no `npm install` or `pip install`.

```bash
git clone https://github.com/ntars/Wacmin.git
cd Wacmin

# 1. Contract self-check (verifies exit codes, error-code segments and report structure)
node contracts/validate.mjs

# 2. Show the status of all four directions
node console/bin/wacmin-console.mjs list

# 3. Aggregate environment self-check across directions (runs in parallel)
node console/bin/wacmin-console.mjs doctor

# 4. Check whether the four directions honour the contract (really invokes each)
node console/bin/wacmin-console.mjs contract
```

### 8.1 Building a Windows Installer on macOS

```bash
cd mac2win

# Check the environment first
node bin/mac2win.mjs doctor

# Preflight and print the plan only; no download, no build, no disk writes
node bin/mac2win.mjs build /path/to/your-app --dry-run

# Real build
node bin/mac2win.mjs build /path/to/your-app

# Or open the graphical interface
node bin/mac2win.mjs ui /path/to/your-app
```

The artefact lands in `<project>/dist-mac2win/`, named like `your-app-1.0.0-x86-setup.exe`.

**How to build each project type** (framework detection is automatic; `--framework` forces a choice):

| Project type | Command | Artefact shape |
|---|---|---|
| Electron | `node bin/mac2win.mjs build ./my-electron-app` | A genuine native window, with the main executable renamed to your product name |
| NW.js | `node bin/mac2win.mjs build ./my-nwjs-app` | Native window |
| Tauri | `node bin/mac2win.mjs build ./my-tauri-app` | Browser UI by default; native window requires `buildRustShell: true` |
| Plain Node service / static site | `node bin/mac2win.mjs build ./my-server` | Built-in static server plus launcher; UI in the browser |

Tauri needs extra preparation (about 1.5 GB) for a native window:

```bash
rustup target add i686-pc-windows-msvc
cargo install cargo-xwin
```

Then set `"buildRustShell": true` in `mac2win.config.json`.

**Common commands**:

```bash
# Verify an existing artefact only
node bin/mac2win.mjs verify ./dist-mac2win/my-app-1.0.0-x86-setup.exe

# Graphical interface
node bin/mac2win.mjs ui

# Keep intermediate artefacts for investigation
node bin/mac2win.mjs build ./app --keep-staging

# Specify the output directory
node bin/mac2win.mjs build ./app --out ./release

# Force a framework
node bin/mac2win.mjs build ./app --framework electron

# Skip verification (not recommended)
node bin/mac2win.mjs build ./app --no-verify
```

**What preflight output looks like**:

```
✓ Host OS: macOS 27.0.0 (arm64)
✓ Host CPU architecture: arm64 (Apple Silicon)
✓ Node version: v22.22.2
✓ NSIS compiler: v3.13 (/opt/homebrew/bin/makensis)
✓ Project directory: /path/to/project
✓ Project framework: Tauri (high confidence): src-tauri/ directory present
✓ Framework and architecture combination: Tauri + x86 feasible
! Native window: no Rust shell, the UI will open in the system default browser
✓ Host entry: /path/to/cordis-host/lib/index.js
✓ Front-end output: /path/to/dist
✓ Target architecture: x86 (32-bit, runs on both 32-bit and 64-bit Windows)
```

`!` marks a warning (can continue, with degradation); `✗` marks an error (halts).

**Offline environments**: the first build downloads runtimes. Pre-download and specify them:

```json
{
  "runtimeArchive": "/path/to/node-v22.23.5-win-x86.zip",
  "runtimeChecksum": "9c01245683c87e3f81eedfbad82c1665611749627cd1b0b5a42921db9361b4a6",
  "electronArchive": "/path/to/electron-v43.0.0-win32-ia32.zip"
}
```

Once downloaded, the cache at `~/.wacmin/mac2win/cache/` prevents further downloads.

**Common error codes at a glance**:

| Code | One-line meaning | What to do |
|---|---|---|
| `M2W_2001` | makensis missing | `brew install makensis` |
| `M2W_3001` | Runtime download failed | Check the network; or point `runtimeArchive` at a local file |
| `M2W_4001` | Project build command failed | Run `npm run build` manually in a terminal first |
| `M2W_4003` | Native module present | Switch to a pure-JS alternative (the error names the package) |
| `M2W_5002` | NSIS compilation failed | Use `--keep-staging`, then run makensis manually |
| `M2W_6001` | Artefact verification failed | **Do not distribute.** The log lists item-by-item results |

### 8.2 Wrapping a Windows Installer as a .app on macOS

```bash
cd exeonmac

# 1. Environment self-check
python3 -m wepack.cli doctor

# 2. Identify the installer
python3 -m wepack.cli detect ~/Downloads/setup.exe

# 3. Static extraction (optional, to confirm the main program)
python3 -m wepack.cli extract ~/Downloads/setup.exe -o /tmp/out

# 4. Install and produce the .app
python3 -m wepack.cli install ~/Downloads/setup.exe -o "~/Applications/MyApp (Win).app"

# 5. Open the result (~ inside quotes is not expanded by the shell, so use $HOME here)
open "$HOME/Applications/MyApp (Win).app"
```

`install`'s `-o` is passed through wepack's own `expanduser()`, so `"~/Applications/..."` in step 4 resolves correctly; `open` is a separate process, so a `~` inside quotes reaches it verbatim and reports `~/Applications/... does not exist`.

After `install` completes it prints:

```
App bundle   /Users/u/Applications/MyApp (Win).app
Type         nsis
Install dir  drive_c/Wacmin/MyApp
Exit code    0 (duration 131.7s)
Disk usage   logical 2.4 GB / actual 2.4 GB
Entry point  drive_c/Wacmin/MyApp/MyApp.exe
Install log  .../Contents/Recipes/install.log
```

**Install a Wine runtime first on first use** (choose one of three):

```bash
# Download from GitHub (about 225 MB)
python3 -m wepack.cli runtime install

# Copy from an installed CrossOver / Whisky, no network
python3 -m wepack.cli runtime install --from-vendor

# Use a local archive
python3 -m wepack.cli runtime install --archive /path/to/wine-devel-11.21-osx64.tar.xz

# Check status
python3 -m wepack.cli runtime status
```

The base layer and the launcher need to be built only once:

```bash
python3 -m wepack.cli layers build base   # reused by all subsequent bundles
sh launcher/build.sh                      # compile the launcher
```

### 8.3 Building a macOS App Bundle on Windows

```powershell
cd win2mac
node bin\win2mac.mjs build C:\path\to\app --executable .\MyApp --out .\dist
```

Common parameters:

```powershell
node bin\win2mac.mjs build .\app `
  --name "My App" `
  --version 1.0.0 `
  --bundle-id com.example.myapp `
  --executable .\MyApp `
  --icon .\icon.icns `
  --associate .myext `
  --min-macos 13.0
```

Running on a non-Windows host prints a warning without halting; add `--strict-host` to refuse.

### 8.4 Assessing Whether a macOS App Can Run on Windows

```bash
# Structure and framework parsing (runs on any platform)
node apponwin/bin/apponwin.mjs assess /path/to/MyApp.app
node apponwin/bin/apponwin.mjs parse /path/to/MyApp.app

# Feasibility spike (requires Windows + WSL2 + Darling; reports blocked otherwise)
node apponwin/bin/apponwin.mjs spike
```

### 8.5 Driving Any Direction Through the Unified Entry Point

```bash
node console/bin/wacmin-console.mjs run mac2win build ../myapp --dry-run
node console/bin/wacmin-console.mjs run exeonmac version
node console/bin/wacmin-console.mjs web 7777   # start the web dashboard, bound to 127.0.0.1 only
```

### 8.6 Handing It to an AI

Three ways in; pick the one matching where you are.

**In a terminal** (`wacmin` emits JSON by default so scripts and agents can parse it; `--human` gives readable output):

```bash
node ai/bin/wacmin.mjs list                          # what each direction supports
node ai/bin/wacmin.mjs status --human                # what is installed, what is missing
node ai/bin/wacmin.mjs doctor mac2win                # missing tools and how to install them
node ai/bin/wacmin.mjs run apponwin assess /Applications/X.app
node ai/bin/wacmin.mjs contract                      # contract compliance across four directions
```

Exit codes pass through unchanged: if `wacmin run exeonmac doctor` returns 5, `wacmin` returns 5. Scripts can judge success without parsing JSON.

**In an MCP-capable client** (Claude Desktop, WorkBuddy, Cline, etc.), register `ai/bin/wacmin-mcp.mjs` as a stdio server:

```json
{
  "mcpServers": {
    "wacmin": {
      "command": "node",
      "args": ["/absolute/path/Wacmin/ai/bin/wacmin-mcp.mjs"]
    }
  }
}
```

`node ai/bin/wacmin.mjs mcp` prints a ready-to-paste snippet with the local path filled in. If the client cannot find `node`, set `command` to the output of `which node`. Once registered, the client sees six tools and the agent decides when to call them.

**In an agent's prompt**: `ai/skills/wacmin/SKILL.md` is the discriminator an agent reads (when this repository applies, how to choose among the four directions), while `ai/experts/wacmin-expert.md` is the expert profile for when judgement criteria matter more than step-by-step operations.

---

## 9. Configuration

Configuration has three layers: **contract files** (shared by all four directions, not overridable per direction), **direction configuration files** (per-project configuration for each direction), and **environment variables** (deployment-time overrides).

### 9.1 Contract Files

These three files are the common language of the four directions. Changing them changes the external behaviour of every direction.

| File | Content | Change rule |
|---|---|---|
| `contracts/exit-codes.json` | The semantics of the nine exit codes and the permitted error-code segments per code | **Append only; never change meanings.** Once published, changing a code value breaks every script that depends on it |
| `contracts/error-prefixes.json` | The four directions' error-code prefixes (`M2W` / `EOM` / `AOW` / `W2M`) and the nine-segment allocation | Segments may not cross boundaries; a new direction must register its prefix here first. `WAC` and `CNT` are reserved |
| `contracts/run-report.schema.json` | The structure of `--report` / `--json` output | A breaking change must increment `schemaVersion`; `console` branches on it |

`contracts/validate.mjs` is the self-checker for these three files, and it also validates individual reports:

| Category | Content |
|---|---|
| Contract self-consistency | Exit codes cover the mandatory values (0/1/2/130), no two meanings collide, every referenced error code falls in a defined segment; all four prefixes present, no duplicates, no reserved prefix; each segment's `range` resolves back to that segment |
| Report structure | **Recursive** validation against `run-report.schema.json`: required fields, types, enums, patterns, ranges, and `additionalProperties: false` at **every level** |
| Cross-field invariants | `ok === (exitCode === 0)`; `ok=false` requires `error` while `ok=true` requires `error: null`; no `ok` stage may follow a `failed` one; error-code prefix belongs to the direction, its segment exists, and it **pairs with the exit code** |

**Tests for the checker itself**: `contracts/validate.test.mjs`. This script is the single authority in CI for "is the contract obeyed", yet it had no tests for a long time — so two blind spots persisted:

1. **`additionalProperties: false` was never enforced** — the schema declares it on every level, but the script only compared top-level `required`. A report with `{"thisFieldShouldNotExist": 123}` still printed "✓ contract self-consistent".
2. **Segments were inferred from the first digit** — `9999` (internal error, an independent segment) and `9998` (part of segment `9000`, range `9001-9998`) both start with 9 and were both mapped to `9000`. The consequence: the `9999` segment could **never be matched**. Delete it from `error-prefixes.json` entirely and validation stays green.

Segment membership is now decided by the actual `range` in `error-prefixes.json` (`segmentOf()`), shared by both call sites.

**Division of labour and consistency between the two checkers**: `contracts/validate.mjs` runs offline on a single report; `console/src/contract-check.mjs` actually spawns all four directions and reads their runtime output. Both **must reach the same verdict** on the same report — guarded by `console/test/contract-consistency.test.mjs` (17 samples). That guard is what first exposed three divergences: extra fields on nested levels, `ok=true` carrying an `error`, and a `direction` outside the enum (previously only "matches the caller" existed, so a caller and implementation that were wrong together both passed).

```bash
# Contract self-check
node contracts/validate.mjs

# Validate one report; --exit-code also compares against the real process exit code
node contracts/validate.mjs --report /tmp/report.json --exit-code 0
```

### 9.2 Mac2Win Configuration File

Place `mac2win.config.json` at the project root (or `mac2win.json`; the first one that exists is used). The two filenames are equivalent, and `mac2win.config.json` takes precedence when both exist.

```json
{
  "productName": "Example App",
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

**All 32 configurable keys**:

| Key | Default | Description |
|---|---|---|
| `framework` | `"auto"` | `auto` / `electron` / `nwjs` / `tauri` / `node` / `static`. `auto` decides from `package.json` dependencies and directory structure |
| `target` | `"x86"` | `x86` / `x64`. `x86` is the project's primary target; `x64` is also supported |
| `format` | `"nsis"` | `nsis` / `zip` |
| `productName` | Inferred from `package.json` | Installer display name and artefact filename |
| `version` | Inferred from `package.json` | Three-part version number |
| `publisher` | Inferred from `package.json`'s `author` | Publisher, written into the installation wizard |
| `identifier` | `null` | Application identifier, used for the registry uninstall entry |
| `frontendDist` | Auto-detects `dist` / `build` / `out` / `.output/public` | Front-end output directory (relative to the project root). Adopted only if it contains `index.html` |
| `entry` | Inferred from `package.json`'s `bin` / `main` | Host entry script (relative to the project root) |
| `resources` | `[]` | Extra files or directories shipped with the artefact |
| `buildCommand` | Inferred as `npm run build` when `scripts.build` exists | Project build command run before packaging |
| `preflightCommands` | `[]` | Commands run during preflight to surface environment problems early |
| `launcherExe` | `"node.exe"` | Launcher filename, must be `.exe` |
| `launcherArgs` | `["{entry}"]` | Launch arguments; `{entry}` is replaced with the entry path |
| `env` | `{}` | Environment variables injected into the target application |
| `dataEnv` | `null` | Names an environment variable whose value is the application data directory |
| `runtimeVersion` | `"22.23.5"` | Node.js runtime version |
| `runtimeArchive` | `null` | Local runtime file (`node.exe` or a `win-x86` zip), for offline environments |
| `runtimeChecksum` | `null` | Expected SHA-256 paired with `runtimeArchive` |
| `electronVersion` | `"43.0.0"` | Electron version; **must be ≤ 43 for the x86 target** |
| `electronArchive` | `null` | Local Electron zip, for offline environments |
| `nwjsVersion` | `"0.90.0"` | NW.js version |
| `nwjsFlavor` | `"normal"` | NW.js distribution flavour |
| `nwjsArchive` | `null` | Local NW.js zip |
| `buildRustShell` | `false` | Whether to cross-compile the Rust shell for a Tauri project |
| `tauriDir` | `null` | Path to Tauri's `src-tauri` directory |
| `rustProfile` | `"release"` | Rust compilation profile |
| `iconFile` | `null` | Installer icon, must be `.ico` |
| `licenseFile` | `null` | Licence file shown in the installation wizard |
| `outDir` | `"dist-mac2win"` | Output directory (relative to the project root, or absolute) |
| `artifactName` | `null` | Artefact filename. Left empty, it is generated from product name and version |
| `verify` | `true` | Whether to run full verification after the build. **Turning it off skips verification only, not safety checks** |
| `alsoZip` | `false` | Additionally produce a portable zip alongside the installer |
| `compression` | `"lzma"` | `lzma` / `zlib` / `bzip2` / `none` |
| `desktopShortcut` | `true` | Whether to create a desktop shortcut |
| `requireAdmin` | `false` | Whether installation requires administrator rights |
| `keepStaging` | `false` | Retain the intermediate staging directory for troubleshooting |

**Configuration merge order** (later overrides earlier):

```
built-in defaults → package.json inference → framework inference → configuration file → command-line arguments
```

**Framework detection must precede configuration merging**, because it determines where the defaults for `entry` and `frontendDist` come from, and those defaults must in turn be overridable by user configuration. A reversed order produces either user settings silently overwritten by framework inference, or framework inference that never takes effect.

**Configuration validation runs after step 4 as a single pass**, reporting all problems at once rather than exiting at the first:

| Check | Behaviour on failure |
|---|---|
| `target` outside the allowed set | Error, listing the valid values |
| `format` outside the allowed set | Same |
| `compression` outside the allowed set | Same |
| `verify` / `alsoZip` not boolean | Error |
| `format` already `zip` while `alsoZip: true` | Report "meaningless" and give the two correct forms |
| `version` not three-part | Error, suggesting at least `1.0.0` |
| Both `entry` and `frontendDist` empty | Report "nothing to package" |
| `launcherExe` not `.exe` | Report "a Windows launcher can only be a PE-format .exe" |

**Why validation reports everything at once**: a configuration file can only be edited in one place at a time; reporting one problem per run forces five or six rounds. After merging, validation runs once and covers everything.

### 9.3 Environment Variables

| Variable | Direction | Default | Purpose |
|---|---|---|---|
| `MAC2WIN_CACHE` | Mac2Win | `~/.wacmin/mac2win/cache` | Runtime cache directory. Reused across projects, avoiding re-downloads |
| `MAC2WIN_7ZIP` | Mac2Win | Auto-detected | Explicit 7-Zip path. **An unusable path reports an explicit error with no silent fallback** (see 5.3.3) |
| `MAC2WIN_NO_7ZIP` | Mac2Win | Unset | Setting `1` forces "no 7-Zip present", used to exercise the "verification incomplete" branch |
| `MAC2WIN_MAKENSIS` | Mac2Win | Auto-detected | Explicit `makensis` path |
| `MAC2WIN_NODE_BASE` | Mac2Win | `https://nodejs.org/dist` | Node.js runtime download base URL; point at an internal mirror when the network is restricted |
| `WACMIN_HOME` | console | `~/.wacmin` | Dashboard history directory. Used for tests and multi-instance isolation, avoiding pollution of real history |
| `WACMIN_PORT` | console | `0` (random) | Default port for the web dashboard |
| `WACMIN_TIMEOUT_MS` | console | `1800000` (30 minutes) | Per-call subprocess timeout. `0` means unlimited |
| `WEXE_HOME` | ExeOnMac | `~/Library/Application Support/wexe` | Root of runtime, prefix, shared layers and recipe library |
| `WEXE_RECIPES` | ExeOnMac | `~/.wexe/recipes` | Recipe library directory |
| `WEXE_7Z` | ExeOnMac | Probed from PATH | Explicit 7-Zip binary path |
| `WEXE_INNOEXTRACT` | ExeOnMac | Probed from PATH | Explicit innoextract path |
| `WEXE_MSIEXTRACT` | ExeOnMac | Probed from PATH | Explicit msiextract path |

**Why `MAC2WIN_CACHE` is partitioned by architecture**: `x86` and `x64` `node.exe` are two different files. Sharing one directory lets them overwrite each other and yields an artefact that claims x64 but is actually x86—an error that only surfaces during artefact verification. Cache directory names carry an architecture tag (`node-22.23.5-win-x86` / `node-22.23.5-win-x64`), eliminating the problem at its root.

**`WEXE_HOME` is used extensively in tests**—pointing the shared layer at a temporary directory gives full isolation without touching the real user directory.

**`MAC2WIN_NO_7ZIP=1` is an escape hatch for the "verification incomplete" branch.** It is not for coverage padding: the decisive branch for a missing 7-Zip is only reached when **the user's machine happens to lack it**. A developer machine almost certainly has it, so the branch may go unexercised for a year—and when it is finally reached, the user receives a report that lied.

### 9.4 ExeOnMac Directories and Configuration

**Shared layer directory** (`WEXE_HOME` redirects it wholesale):

```
~/Library/Application Support/wexe/
├── layers/
│   ├── base/            # Windows skeleton (already contains the full VC++ / ATL set)
│   ├── vcpp/            # VC++ runtime (optional; only to overwrite with Microsoft originals)
│   ├── mfc/             # MFC runtime (absent from base; user-supplied)
│   ├── dotnet/          # .NET Framework (user-supplied)
│   └── fonts-cn/        # Pins user fonts down, removing host dependency (Chinese never was the gap)
├── runtime/
│   └── wine/            # Wine runtime (x86_64)
└── logs/
```

**In-bundle configuration** (`compat.yaml`): located at `{App} (Win).app/Contents/Recipes/compat.yaml`, the single source of truth for that bundle. The full field definition is in `exeonmac/schema/compat.schema.json`.

```yaml
app: WeChat
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

Additional field conventions:

1. **`entry` must be relative to `Contents/Resources/Private/`**, starting with `drive_c/` and using forward slashes. Not `C:\` form, not an absolute path.
2. **`layers[0]` must be `base`**. Order is mount order; later layers overwrite same-named files from earlier ones. Enforced by a hard check in code.
3. **`silent_args` preserves any leading space** (e.g. `" /S"`). NSIS's `/S` relies on that space to separate it from a path argument.
4. **`font_map` keys are Windows font names** and values are macOS font names. The launcher generates `fontsub.reg` and imports it with `wine regedit /S` before starting.
5. **`file_associations` is empty by default**. When non-empty, elements look like `.7z`, and wepack generates `CFBundleDocumentTypes` accordingly.
6. **`known_issues` holds human-readable sentences**, not error codes. The UI displays them verbatim.

**Recipe library** (`~/.wexe/recipes/<key>.yaml`) caches "what this installer produces".

**The key is the first 16 hex digits of the installer's SHA-256.** Content rather than filename, because re-downloading often yields `setup (1).exe`; a content-derived key hits regardless of the name.

Recipes store **the entry program and dependency layers**—both discovered after installation, and discovery itself is heuristic (scoring to pick the main program, scanning the import table to match layers). Caching them buys two things:

| Benefit | Explanation |
|---|---|
| Speed | Skips entry scanning (about 10 ms) and layer matching (about 24 ms); hashing a 33 MB installer takes only 20 ms |
| Stability | In directories with multiple main programs, a re-scan could in theory pick a different exe; the recipe locks in the previous result |

Management commands:

```bash
wepack recipe list                    # list local recipes
wepack recipe show <key|installer>    # inspect a recipe
wepack recipe save <app>              # export a recipe from a built .app
wepack recipe rm <key>                # delete a recipe (moved to the Trash, recoverable)
```

`--no-recipe` bypasses the library entirely (neither reading nor writing), useful for investigating "is the cache causing this odd behaviour".

**Silent parameter table**:

| Installer | Parameters | Note |
|---|---|---|
| NSIS | `/S /D=C:\Wacmin\AppName` | `/D` must be last and **unquoted**; the path must not contain spaces (see 5.6.1) |
| Inno Setup | `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR=C:\...` | `/DIR=` is **also unquoted**—wine adds the quotes; adding them ourselves causes escaping |
| InstallShield | `/s /v/qn` | Must not be written `/v" /qn"`; literal quotes get escaped by wine |
| MSI | `msiexec /i pkg.msi /qn /norestart` | |
| WiX Burn | `/quiet /install /norestart` | |
| Squirrel | `--silent` | Accepts no directory parameter; installs to `%LOCALAPPDATA%\<AppName>` |

`--silent-args` overrides the built-in parameters.

### 9.5 Win2Mac / AppOnWin Configuration

These two directions currently accept command-line parameters only and read no configuration file.

- **Win2Mac**: `--name` / `--version` / `--executable` / `--payload` / `--icon` / `--bundle-id` / `--vendor` / `--associate` / `--min-macos` / `--category` / `--strict-host` and others; the complete list is in `node win2mac/bin/win2mac.mjs build --help`.
- **AppOnWin**: `--sample` / `--app` for `spike`; `assess` and `parse` accept a single `.app` path.

**Why these two directions have no configuration file**: their parameter sets are too small to justify one, and a configuration file would only add the interpretive cost of "which takes precedence, the file or the command line".

---

## 10. API and Module Reference

This project offers three external interfaces: **the command line** (one per direction, unified through the contract), **local HTTP interfaces** (each direction's graphical interface), and **MCP tools** (for AI clients). There is no SDK; module-level APIs are internal implementation details, listed here by responsibility so problems can be located.

All three interfaces are shells over the same layer: each ultimately calls `console/src/directions.mjs` to spawn a subprocess, and no path bypasses the contract.

### 10.1 Command-Line Interface

The subcommands and exit codes of the four directions follow the same contract.

| Direction | Command | Subcommands |
|---|---|---|
| Mac2Win | `mac2win` | `build` / `verify` / `ui` / `doctor` |
| ExeOnMac | `wepack` | `detect` / `extract` / `install` / `package` / `build` / `layers` / `recipe` / `runtime` / `doctor` / `version` |
| Win2Mac | `win2mac` | `build` / `verify` / `doctor` |
| AppOnWin | `apponwin` | `assess` / `parse` / `spike` / `doctor` |
| Unified entry | `wacmin-console` | `list` / `run` / `doctor` / `contract` / `web` |
| AI unified entry | `wacmin` | `list` / `status` / `run` / `doctor` / `contract` / `mcp` / `skill` |

**Common options** (identical across directions): `--json` outputs machine-readable results, `--report` outputs the unified run report, `--verbose` enables debug-level logs, `-h/--help`, `--version` prints the version.

**`-v` does not have the same meaning across all four directions, so it is not a common option.** In `mac2win` / `win2mac` / `apponwin`, `-v` is short for `--version`; in `wepack` it is short for `--verbose` (`--version` has only the long form and is a top-level argument, not accepted after a subcommand). Scripts that need the version should use `--version` everywhere; `-v` turns on debug logging under `wepack` and prints a version number under the other three. The difference comes from the two parsers (hand-written argv on the Node side, `argparse` on the Python side); this document does not force them together, it only asks that **`-v` is never used to fetch the version**.

**Relationship between `--json` and `--report`**: `--report` emits exactly the structure defined by `contracts/run-report.schema.json`; `--json` is an alias or subset in some directions. Both share the same constraint: **stdout carries only JSON and logs go to stderr**, so a pipe can hand stdout directly to `jq`.

**`apponwin spike` has four exit codes, one more than the generic set — the input-error branch on exit code 2**:

| Exit code | Trigger | Paired error code |
|---|---|---|
| 0 | All three gates `pass` (`accepted`) | — |
| 1 | At least one gate `fail` (`rejected`, direction does not hold) | `AOW_9999` |
| 2 | `--sample` / `--app` points at a non-existent path (gate never executed, `inputErrors` non-empty) | `AOW_1002` |
| 5 | Environment unavailable causing `blocked` (`unverified`) | `AOW_2001` |

`2` and `5` must stay separate: the first only needs a corrected path, the second needs a different machine. Collapsing them makes CI record "mistyped path" as "missing dependency", triggering a pointless WSL2 installation.

**ExeOnMac failure output format**:

```json
{
  "ok": false,
  "error": "File not found: /tmp/x.exe",
  "hint": null,
  "exit_code": 2
}
```

`ok` is equivalent to `supported`. A non-null `unsupported_reason` implies exit code 4.

### 10.2 Unified Run Report

The structure emitted by `--report` is defined by `contracts/run-report.schema.json` with `additionalProperties: false`.

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | integer, fixed `1` | Format version. Incremented on breaking changes; `console` branches on it |
| `direction` | enum | `mac2win` / `exeonmac` / `apponwin` / `win2mac` |
| `ok` | boolean | Overall success, equivalent to `exitCode === 0` |
| `exitCode` | integer | Process exit code, see `exit-codes.json` |
| `command` | string | The subcommand actually executed |
| `startedAt` / `finishedAt` | date-time | Start and end times |
| `durationMs` | integer | Elapsed time |
| `host` | object | Host snapshot: `platform`, `arch` (required), `osVersion`, `toolVersion` (optional) |
| `input` | object | Input identification: `path`, `kind`, `confidence`, `evidence[]`, `supported`, `unsupportedReason` |
| `stages[]` | array | Per-phase records, each with `id`, `name`, `status` (`pending`/`running`/`ok`/`failed`/`skipped`), `durationMs`, `message`, `errorCode` |
| `artifacts[]` | array | Artefact list, each with `path`, `kind`, `bytes` (required), `sha256`, `target` (optional) |
| `checks[]` | array | Artefact verification items, each with `name`, `passed` (required), `detail`, `severity` (optional, enum `required` / `advisory`) |
| `warnings[]` | string[] | Non-blocking facts the user should know, such as degradation or precision loss |
| `error` | object \| null | Failure details: `code` (must match `^[A-Z0-9]{2,4}_[0-9]{4}$`), `message` (required), `hint`, `details[]` (optional). `null` on success |

**`checks[].passed` is a boolean, not `ok`**. This was a real trap: internal objects expressed the field as `{name, ok, detail}`, and direct serialisation produced a contract error reading "missing boolean field `passed` (actual keys: name, ok, detail)". Because `additionalProperties: false`, the extra `ok` was also invalid. **The fix added a field-mapping layer rather than changing internal naming**—internal code keeps the more natural semantics, the external contract stays stable, and each side honours its own concerns.

**`artifacts[].path` must be a non-empty string.** This requirement exposed an `undefined !== null` defect; see 5.3.4.

**`stages` stop on failure.** No subsequent phases should appear after a failure, so seeing `running` after `failed` in a report is itself evidence of an implementation bug.

### 10.3 Phase Breakdown by Direction

Using Mac2Win as the example, `build` has eight phases with weights (weights drive the overall progress percentage):

| # | `id` | Name | Weight |
|---|---|---|---|
| 1 | `preflight` | Preflight | 1 |
| 2 | `project-build` | Project build | 3 |
| 3 | `runtime` | Prepare runtime | 4 |
| 4 | `collect` | Collect dependencies | 2 |
| 5 | `stage` | Stage files | 4 |
| 6 | `manifest` | Generate manifest | 2 |
| 7 | `package` | Package installer | 5 |
| 8 | `verify` | Verify artefact | 3 |

**Why weights are not uniform**: averaged across phases, packaging (over half the total duration) would occupy only 1/8 and users would watch the bar stall at 87%. Weighted by expected duration, the progress curve roughly matches actual elapsed time.

**ExeOnMac's eight phases** (matching `wepack/report.py`'s `STAGES` one-to-one): `preflight` → `detect` → `extract` → `prefix` → `install` → `scan` → `package` → `verify`. Isomorphic to Mac2Win's eight phases, differing in that step 2 identifies an installer rather than a project and step 4 creates a Wine prefix rather than preparing a Node runtime.

**A single sub-command does not run all eight; the rest are marked `skipped`**. `detect` runs only `preflight` and `detect`; `extract` stops after `extract` (everything past install is irrelevant to it); `install` skips `extract` (installing needs no prior unpacking) plus `package` / `verify`; `package` skips the first six and runs only `package` and `verify`. Reports therefore show no false "all grey" and do not count unrun stages toward duration.

### 10.4 Local HTTP Interfaces

Two graphical interfaces each start a local service, **bound to `127.0.0.1` only**.

**Mac2Win console** (`mac2win ui`):

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/state` | GET | Current state snapshot |
| `/api/preflight` | POST | Run preflight without building |
| `/api/build` | POST | Start a build |
| `/api/cancel` | POST | Cancel the running build |
| `/api/verify` | POST | Verify a specified artefact |
| `/api/probe` | POST | Probe a project directory for framework and entry |
| `/api/reveal` | POST | Reveal the artefact in the file manager |
| `/api/events` | GET | SSE event stream: progress, logs, completion |

**Console dashboard** (`wacmin-console web`):

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/history` | GET | The last 20 run records |
| `/api/status` | GET | Availability of the four directions |
| `/api/contract` | GET | Contract check results |
| `/api/run` | POST | Trigger a subcommand in some direction |

**Why SSE instead of WebSocket**: progress is one-way (server → browser), for which SSE suffices: native `EventSource` support, ordinary HTTP transport, automatic reconnection. WebSocket would add handshake and heartbeat complexity for no benefit.

### 10.5 Internal Module Boundaries

Module APIs are not an external commitment, but knowing the division of responsibilities helps locate problems.

**Mac2Win** (`mac2win/src/`):

| Module | Responsibility |
|---|---|
| `core/config.mjs` | Configuration reading, framework inference, validation, normalisation |
| `core/preflight.mjs` | Host, architecture and external-tool preflight |
| `core/frameworks.mjs` | Framework detection (Electron / NW.js / Tauri / Node / static) |
| `core/runtime.mjs` | Node runtime download, caching, architecture assertion |
| `core/electron.mjs`, `core/nwjs.mjs` | Runtime acquisition and assembly per framework |
| `core/rust-shell.mjs` | cargo-xwin compilation of the Tauri Rust shell |
| `core/collector.mjs` | Walk the require graph from the entry, intercept native modules |
| `core/stager.mjs` | Lay out directories per framework, inject compatibility shims |
| `core/nsis.mjs` | Generate the NSIS script and compile it |
| `core/zip.mjs`, `core/zipwriter.mjs` | zip reading (with path traversal protection) and writing (with Unix permission bits) |
| `core/builder.mjs` | Orchestrate the eight phases, chaining the whole flow |
| `core/report.mjs` | Phase tracking and report generation |
| `core/errors.mjs` | Error code definitions and exit-code mapping |
| `verify/pe.mjs` | PE/COFF header parsing |
| `verify/artifact.mjs` | Three-state artefact verification |
| `server/app.mjs` | Console HTTP service |
| `launcher/bootstrap.mjs` | The in-artefact launcher (static server + path traversal protection) |

**Win2Mac** (`win2mac/src/`): `core/bundle.mjs` (`.app` directory assembly), `core/plist.mjs` (`Info.plist` generation), `core/wexezip.mjs` (zip writer preserving Unix mode), `core/verify.mjs` (artefact verification), `core/builder.mjs` (orchestration), `core/report.mjs`, `core/errors.mjs`.

**AppOnWin** (`apponwin/src/core/`): `macho.mjs` (Mach-O header parsing), `plist.mjs` (`Info.plist` parsing), `assess.mjs` (framework determination and portability assessment), `spike.mjs` (three-gate verification), `report.mjs`, `errors.mjs`.

**ExeOnMac** (`exeonmac/wepack/`):

| Package | Responsibility |
|---|---|
| `cli.py` | All subcommand entry points, argument parsing, doctor |
| `pe.py` | PE parsing: headers, sections, resource tree, import table, version resource |
| `tools.py` | External tool location and smoke testing |
| `runtime.py` | Wine runtime download, extraction, architecture validation |
| `detect/` | Installer detection, including `cfb.py` (compound document) and `msi_tables.py` (MSI table parsing) |
| `extract/` | Static extraction and main-exe candidate ranking (`candidates.py`) |
| `prefix/` | Wine prefix creation, clonefile, validation, space accounting |
| `install/` | Silent installation orchestration, restart suppression, process cleanup |
| `layers/` | Layer build, validation, mounting, import-table matching (`match.py`) |
| `package/` | `.app` assembly, `Info.plist`, icon composition, Swift launcher compilation, artefact verification |
| `recipes/` | compat.yaml read/write plus the recipe library |
| `models.py` | Cross-stage data models |
| `errors.py` | Error types and exit codes |
| `paths.py` | Global path resolution (the only place permitted to write state) |
| `log.py` | Logging (stderr plus optional file) |

**Module divisions follow process phases, not technical layers.** `detect/` only detects and `extract/` only extracts; neither calls the other's internal functions, communicating solely through `models.Detection` / `models.ExtractResult`.

**Console** (`console/src/`): `directions.mjs` (dispatch capability for the four directions: entry point, subcommands, produces, and `runDirection`'s process management and cancellation), `server.mjs` (local service, SSE, history persistence), `contract-check.mjs` (four-direction contract compliance checking, including reverse probes).

**`directions.mjs` is the capability; `bin/wacmin-console.mjs` is the entry point.** The direct reason for splitting them is that the AI layer also needs to dispatch the four directions, while the entry file parses argv, prints usage, and sets `process.exitCode` when imported — `console` never reads its own stdout, so this stayed hidden for a long time, but the MCP specification requires `stdout` to carry protocol messages only, making the same pattern fatal in an MCP server. After the split the entry file carries an `isDirectRun()` guard (comparing via `realpathSync` rather than string equality, since symlinks and `./` prefixes would otherwise slip through), so importing it has zero side effects.

**AI integration layer** (`ai/src/`):

| Module | Responsibility |
|---|---|
| `protocol.mjs` | JSON-RPC encoding/decoding, newline framing, error code constants. Pure functions, touches no process |
| `tools.mjs` | Definitions of the six tools (name, description, JSON Schema, annotations) and parameter-to-argv translation |
| `server.mjs` | Handshake and version negotiation, `tools/list`, `tools/call` dispatch, `notifications/cancelled` cancellation |

**The boundary between the three is "does it have side effects"**: `protocol.mjs` runs in any context; `tools.mjs` performs pure transformation and issues no commands; only `server.mjs` touches stdin/stdout and subprocesses. Consequently protocol-layer tests need no process, and tool-layer tests need no real build.

**Why a translation layer exists instead of exposing argv straight to the agent**: field names do not map one-to-one onto positional command-line arguments — the origin field is called `project` in `mac2win` / `win2mac` but `installer` in `exeonmac` (which has no notion of a "project", only an installer). An agent assembling the command line itself would copy `project` across to `exeonmac`, producing `wepack build -o /tmp/o` and an argparse error about a missing `installer` — **the error points at a missing argument while the real cause is a dropped field in the translation layer**. Keeping that mapping in one place means the agent only has to state which direction, what the origin is, and where the artefacts go.

### 10.6 MCP Tool Contract

The transport layer follows MCP 2025-06-18 stdio: **newline-delimited JSON-RPC**, not LSP's `Content-Length:` framing. `stdout` may carry protocol messages only; any logging must go to `stderr`. This is not fastidiousness — one extra non-protocol line on `stdout` and the client's parser drops the stream immediately.

**Handshake**: the client sends `initialize` (with `protocolVersion` / `capabilities` / `clientInfo`); the server replies with `protocolVersion` / `capabilities` / `serverInfo` / `instructions`. Version negotiation is "echo the requested version if supported, otherwise reply with our latest" — **never reject outright**, since rejection makes the client treat the server as unavailable when only the version number differs.

**Tool results carry two distinct error layers**:

| Layer | Expression | When |
|---|---|---|
| Protocol error | Top-level `error` field (`-32700` / `-32600` / `-32601` / `-32602` / `-32603`) | The request itself is invalid: malformed JSON, unknown method, wrong argument type |
| Tool execution error | `result.isError = true`, with a readable reason in `content` | The command genuinely ran and failed: missing file, missing 7-Zip, failed verification |

**A failed build is valid information and must not be swallowed as a protocol error.** Wrapping it as `-32603` leaves the agent with only "internal error", no `M2W_1002` code, and therefore no way to tell the user "what is missing is not your project but 7-Zip".

**Parameters of the six tools** (fields other than `required` may be omitted):

| Tool | Main parameters | Returns |
|---|---|---|
| `wacmin_list_directions` | none | Per direction: `host`, `installed`, `produces`, `subcommands` |
| `wacmin_doctor` | `direction` | Presence of each external tool plus install commands |
| `wacmin_build` | `direction` (required), `project` / `installer` (one per direction), `outDir`, `arch`, `extraArgs[]` | Artefact paths, byte sizes, `ok` / `complete`, `checks[]` |
| `wacmin_verify` | `direction`, artefact path | Three-state verification result, no rebuild |
| `wacmin_assess` | `appPath` | Framework verdict, portability score, blockers |
| `wacmin_run` | `direction` (required), `command` (required), `args[]` | Passthrough stdout and exit code |

**`wacmin_build` declares only `direction` as required, and not out of laziness**: the origin field is one of two depending on direction (`project` or `installer`), and JSON Schema's `required` cannot express "A or B, at least one". Hard-coding `required: ['direction', 'project']` would reject legitimate `exeonmac` calls. Validation lives in the translation layer, where the error message is also more useful than a schema violation.

**Cancellation**: the client sends `notifications/cancelled` with `params.requestId`; the server looks up the table and aborts the matching request. Unknown IDs are ignored silently — the specification requires it, and a client may send a cancellation after the response has already arrived. Aborting must genuinely kill the subprocess **tree** (`SIGTERM` → 2 seconds → `SIGKILL`), otherwise the tool reports "cancelled" while half an artefact sits on disk.

**Tool annotations change client behaviour**: clients mostly skip the confirmation prompt for tools with `readOnlyHint: true`. So `wacmin_build` / `wacmin_run` must be marked non-read-only — marking build read-only would let an agent write to disk and run for minutes without the user knowing.

---
## 11. Repository Layout

### 11.1 Repository Structure

```
Wacmin/
├── contracts/                 Shared contract (single source of truth)
│   ├── exit-codes.json        Unified exit codes
│   ├── exit-codes.schema.json Schema for the exit-code file
│   ├── error-prefixes.json    Error-code prefixes and segment allocation
│   ├── run-report.schema.json --report / --json output structure
│   ├── validate.mjs           Contract self-check + report validation
│   ├── validate.test.mjs      Tests for the checker itself
│   ├── doc-counts.mjs         Single check entry for the 12.1 table and Appendix C (--check / --min / --list)
│   ├── doc-counts.test.mjs    Guard keeping the table and both READMEs consistent
│   ├── appendix-guard.mjs     Machine guard for the 8 numbers in Appendix C (read from code constants and document structure)
│   └── appendix-guard.test.mjs Regression lock tampering with each of the 8 numbers one at a time
├── mac2win/                   Direction 1 · Produce Windows installers on macOS
│   ├── bin/mac2win.mjs        Single command entry
│   ├── src/                   Core implementation
│   │   ├── core/              config, preflight, frameworks, runtime, collector, stager, packaging, orchestration, reporting
│   │   ├── verify/            PE parsing and artefact verification
│   │   └── server/            Local console HTTP service
│   ├── web/                   Console front-end static assets
│   ├── test/
│   └── package.json
├── exeonmac/                  Direction 2 · Run Windows programs on macOS
│   ├── bin/wepack             Development entry (PYTHONPATH injection, no install)
│   ├── wepack/                Python package
│   │   ├── cli.py             Subcommand entry and doctor
│   │   ├── pe.py              PE parsing
│   │   ├── tools.py           External tool location and smoke testing
│   │   ├── runtime.py         Wine runtime management
│   │   ├── detect/            Installer detection (incl. CFB, MSI tables)
│   │   ├── extract/           Static extraction and main-program scoring
│   │   ├── prefix/            Prefix creation and clonefile
│   │   ├── install/           Silent installation orchestration
│   │   ├── layers/            Layer building and import-table matching
│   │   ├── package/           .app assembly, icons, launcher build, verification
│   │   ├── recipes/           compat.yaml read/write and recipe library
│   │   ├── entry.py           Entry-point rule (the single copy install and package share)
│   │   ├── report.py          Unified run report and the eight stage records
│   │   └── models.py / errors.py / paths.py / log.py
│   ├── launcher/              Swift launcher (AppKit + Foundation)
│   ├── tools/badge.swift      Icon badge composition
│   ├── runtime/fetch.sh       Wine runtime download script (entry point without installing the Python package)
│   ├── schema/compat.schema.json
│   ├── tests/
│   └── pyproject.toml
├── win2mac/                   Direction 3 · Produce macOS app bundles on Windows
│   ├── bin/win2mac.mjs
│   ├── src/core/              bundle / plist / wexezip / verify / builder / report / errors
│   ├── test/
│   └── package.json
├── apponwin/                  Direction 4 · Run macOS programs on Windows
│   ├── bin/apponwin.mjs
│   ├── src/core/              macho / plist / assess / spike / report / errors
│   ├── test/
│   └── package.json
├── console/                   Unified entry for the four directions (CLI + web dashboard)
│   ├── bin/wacmin-console.mjs Executable entry (thin shell: parses argv and prints only)
│   ├── scripts/               viewport-check.mjs (three-viewport measurement, four-stage verdict)
│   ├── src/                   directions.mjs / server.mjs / contract-check.mjs
│   ├── web/
│   ├── test/
│   └── package.json
├── ai/                        AI integration layer (MCP / CLI / Skill / expert package)
│   ├── bin/
│   │   ├── wacmin.mjs         Unified command-line entry
│   │   └── wacmin-mcp.mjs     MCP server entry (stdio)
│   ├── src/
│   │   ├── protocol.mjs       JSON-RPC codec and newline framing
│   │   ├── tools.mjs          Six MCP tool definitions and parameter translation
│   │   └── server.mjs         Handshake, tool dispatch, cancellation
│   ├── skills/wacmin/SKILL.md         Lets an agent decide when to call
│   ├── experts/wacmin-expert.md       Expert package: criteria and methodology
│   ├── test/
│   └── package.json
├── .github/                   CI workflows
├── LICENSE                    Layered licence map
├── LICENSE                    Apache-2.0 full text (for GitHub detection)
├── LICENSE-MIT                MIT full text
├── LICENSING.md          Layer routing table
├── NOTICE                     Third-party components and licence statements (the only copy)
├── README.md                  Chinese documentation (this file)
└── README_EN.md               English documentation
```

The four directions are **mutually independent**: each direction's dependencies, tests and releases do not affect the others. Yet they are **mutually complementary**: they share one contract layer, which is what allows `console/` to drive all four with a single codebase.

**No subdirectory retains any standalone document.** All explanatory material is consolidated in this file, and licensing plus compliance statements are consolidated in `LICENSE` and `NOTICE` at the root. The reasoning is in section 1.1.

### 11.2 Artefact Structure: ExeOnMac's `.app`

```
{App Name} (Win).app/
└── Contents/
    ├── Info.plist                       # Required
    ├── PkgInfo                          # Optional, content APPL????
    ├── MacOS/
    │   └── launcher                     # Required, Swift executable, native arm64
    ├── Resources/
    │   ├── AppIcon.icns                 # Required
    │   ├── original.ico                 # Optional, original icon backup
    │   └── Private/                     # Required, the only writable area
    │       ├── drive_c/                 # Installation output lands here
    │       ├── dosdevices/
    │       │   ├── c -> ../drive_c      # Relative link, valid after the bundle moves
    │       │   └── z -> /
    │       ├── system.reg
    │       ├── user.reg
    │       └── userdef.reg
    ├── Recipes/
    │   ├── compat.yaml                  # Required, the bundle's single source of truth
    │   └── install.log                  # Required (may be an empty file)
    └── Shared -> ../../wexe/layers       # Optional symlink, for manual inspection only
```

`Shared` is an optional symlink that the runtime does **not** depend on: the launcher locates the shared layer via `WEXE_HOME` or `~/Library/Application Support/wexe`, with no path hard-coded into the bundle, so bundles are movable, back-up-able and distributable.

**Required `Info.plist` fields**:

| Key | Value | Note |
|---|---|---|
| `CFBundleName` | `{App Name}`, ≤15 characters | Truncated by code point from the end, never mid-character |
| `CFBundleDisplayName` | `{App Name} (Win)` | Shown in Finder and the Dock |
| `CFBundleIdentifier` | `com.wexe.win.{reverse domain}` | Must be unique; on collision a suffix is appended and a `known_issues` entry recorded |
| `CFBundleExecutable` | `launcher` | |
| `CFBundlePackageType` | `APPL` | |
| `CFBundleIconFile` | `AppIcon` | Without the `.icns` extension |
| `CFBundleShortVersionString` | `{version}` | `1.0` when unavailable |
| `CFBundleVersion` | Numeric normalisation of `{version}` | Non-numeric segments replaced by 0 |
| `CFBundleInfoDictionaryVersion` | `6.0` | |
| `LSMinimumSystemVersion` | `13.0` | |
| `NSHighResolutionCapable` | `true` (boolean) | |
| `LSApplicationCategoryType` | `public.app-category.utilities` | Overridable via `compat.yaml` |
| `NSSupportsAutomaticGraphicsSwitching` | `true` (boolean) | Dual-GPU switching |

Keys explicitly **not** set: `LSUIElement` (setting it removes the Dock icon), `LSBackgroundOnly` (same), `NSPrincipalClass` (the launcher does not use `NSApplicationMain` and manages its own lifecycle). `CFBundleDocumentTypes` is generated only when `compat.yaml`'s `file_associations` is non-empty; by default no associations are claimed.

**`install.log` format**: plain text, UTF-8, one event per line:

```
[YYYY-MM-DDTHH:MM:SSZ] <level> <event> <detail>
```

Required events:

| event | Meaning |
|---|---|
| `detect` | Installer type and confidence |
| `prefix.create` | Prefix path, clonefile source layers |
| `install.start` | The actual command line and arguments executed |
| `install.exit` | Installer exit code, elapsed time |
| `install.settled` | Active wind-down because file count stopped growing (installer never exits) |
| `install.fallback` | Reason for falling back to interactive after silent failure |
| `reboot.suppressed` | `ExitWindowsEx` intercepted, recording "pretended the reboot succeeded" |
| `scan.entry` | The selected main exe and its score |
| `package.done` | Artefact path and final verification result |

The log contains no user file contents and no full environment dumps.

**Icon generation pipeline**:

```
.ico / .exe resources
  → parse ICONDIR, take the largest frame (PNG frames written directly, BMP frames get a file header)
  → sips converts to PNG, scaled to 1024
  → compose the badge (CoreGraphics, tools/badge.swift)
  → generate AppIcon.iconset (16/32/64/128/256/512 at @1x and @2x)
  → iconutil -c icns
```

Badge specification: one quarter of the main icon's size, content a white `W` or the four-pane Windows logo, background `#0078D4` (Windows blue) or `#8E8E93` (system grey), bottom-right with a 4 px margin, opacity 0.9. Plain `sips` cannot composite layers, so that step uses the in-repository `tools/badge.swift` (CoreGraphics, a system framework), still introducing no third-party imaging library.

**Without icon resources a placeholder is used** (blue background, white W). The artefact is legitimately distributable, but its appearance is not faithful.

### 11.3 Artefact Structure: Mac2Win Output

```
<project>/
└── dist-mac2win/
    ├── your-app-1.0.0-x86-setup.exe      # NSIS installer (default)
    ├── your-app-1.0.0-x86.zip            # Portable zip (when alsoZip: true)
    └── staging/                          # Intermediate artefacts, cleaned by default
```

`staging/` is deleted after a successful build; `--keep-staging` retains it for investigation, in which case `staging/installer.nsi` can be compiled manually with `makensis`.

**Installer internal layout** (NSIS payload):

```
$INSTDIR/
├── node.exe              # Or renamed to the launcher name
├── bootstrap.mjs         # Launcher
├── launch.json           # Launch arguments
├── app/                  # The application itself
│   ├── main.js
│   └── node_modules/     # Flattened dependencies
└── LICENSE-*             # Licence texts of the bundled runtimes
```

**Why the payload has an extra `app/` level**: NSIS's `File /r` does not include the source directory name when expanding. A direct `File /r "src\*.*"` into `$INSTDIR` would lose the `app/` level, and verification would report "required file not found". The fix is for `SetOutPath` to add the `app` level first.

### 11.4 Artefact Structure: Win2Mac Output

```
<out>/
└── My App.app/
    └── Contents/
        ├── Info.plist
        ├── PkgInfo
        ├── MacOS/
        │   └── MyApp            # User-supplied executable, permission 0755
        └── Resources/
            ├── icon.icns        # Only when --icon is provided
            └── payload/         # Additional files from --payload
```

A same-named `.zip` is produced alongside, with Unix permission bits written explicitly by the custom zip writer.

---

## 12. Performance

Performance in each direction is determined by its foundation; this project only wires things together and makes no performance promises. The table below contains measured values for horizontal reference only.

### 12.1 Key Metrics

| Direction | Metric | Measured |
|---|---|---|
| Mac2Win | Full build (with verification, warm cache) | about 19 seconds |
| Mac2Win | Full build (with verification, cold cache) | Network-dependent; runtimes are 32–100 MB |
| Mac2Win | Artefact verification (per-file SHA-256 over 4060 files) | order of 2 seconds |
| Mac2Win | Project build (real project) | Determined by the project itself |
| ExeOnMac | Installer detection | milliseconds |
| ExeOnMac | Static extraction (34 MB NSIS sample, 4898 files) | seconds |
| ExeOnMac | Prefix creation (clonefile of a 382 MB base layer) | sub-second, metadata space only |
| ExeOnMac | Silent installation (34 MB installer) | about 132 seconds |
| ExeOnMac | `.app` assembly (plist + icon + launcher) | seconds; launcher compile about 4 ms on cache hit |
| Win2Mac | `.app` assembly + zip | about 1 second for a 2 KB sample; pure I/O |
| AppOnWin | Structure parsing and framework determination | milliseconds (reads plist and Mach-O headers) |
| console | Four-direction `doctor` (serial) | 555 ms |
| console | Four-direction `doctor` (parallel) | 486 ms |

**Why Mac2Win's duration has a range**: it includes downloading the framework's Windows runtime. Runtimes are cached in `~/.wacmin/mac2win/cache/`; a hit means assembly and compression only, a miss means network. Quoting a fixed number of seconds would mislead users.

**Test scale and duration** (measured on this machine; hardware-dependent).

**This table is the single source of truth for test counts in this repository.** The rest of the README only states that tests pass and does not repeat the numbers — the same figure stored in several places inevitably drifts, and this repository previously saw two such divergences: a total written as 978 (actually 1150), and the English edition recording mac2win as 131.

| Subproject | Tests | Duration | Notes |
|---|---|---|---|
| mac2win | 167 | about 28 seconds | |
| exeonmac | 490 | about 2m57s | Includes on-the-spot NSIS / Inno compilation, 3 real wine installs, 2 real layer builds, 2 matches against real layers, 3 import-time side-effect guards (static repo-wide scan, dynamic sentinel, scan-scope guard), 2 in-window signal tests (SIGTERM / SIGINT, window widened by a fake wine) and 10 font-substitution format/root-key/check guards (2 of which scan the real binaries for both font paths) |
| win2mac | 130 | about 2 seconds | |
| apponwin | 96 | about 0.5 seconds | |
| console | 254 | about 23 seconds | Includes 8 line-break quality guards + 11 keyboard-focus guards |
| ai | 132 | about 9 seconds | |
| contracts | 113 | about 3 seconds | Includes documentation-count, Appendix C guard and table-scope guard self-checks |
| **Total** | **1382** | — | See "0 skipped repository-wide" below |

**Zero skips repository-wide.** This is not a nice-looking number but a hard constraint: both `OK (skipped=N)` and `# skipped N` exit with status 0, so a skipped test looks exactly like a passing one in the report. Two cases of "CI green while the guard was off duty" were measured:

- **exeonmac**: `Ran 333 tests / OK (skipped=10)` on CI — 10 tests covering MSI table parsing, Inno version detection and NSIS unpacking had never run on CI;
- **mac2win**: `# tests 131 / # pass 128 / # skipped 3` on CI — the skipped assertions were core rejection paths such as "a console program must be rejected when validated as a GUI".

Both were fixed by **generating fixtures on the spot** (MSI built as raw CFB in pure Python, NSIS via `makensis`, Inno via ISCC compiled for real under wine) instead of relying on files left over on the local machine, and by adding `check_no_skips.py` / `check-no-skips.mjs` to CI: a non-zero skip count fails immediately, and a total below the baseline also fails (so a deleted fixture shows up as *fewer* tests rather than as *red*).

mac2win additionally had three tests that skipped "when no usable 7-Zip is present locally". They defend "an explicit path wins over the system one" and "doctor and verify use the same criterion" — a reasonable-sounding skip condition (if it isn't installed, don't test it), but a clean CI runner never has it installed, so those three were green yet never executed, and verifying those two things is their only reason to exist. They now use `fixtures.mjs`'s `fake7zip()` to produce a script that satisfies the detection criterion: `probeCandidates()` only requires "is a file / can run `i` / output contains `7-Zip` and `Formats:`", which has nothing to do with being a *real* 7-Zip — it decides whether **this candidate would be selected by verify**, while unpacking capability is covered by the tests against real artefacts.

**The baseline itself is also read from this table, not stored elsewhere.** `contracts/doc-counts.mjs --min <module>` prints the figure from the table for CI's `--min` to consume; `--check` verifies that the total equals the sum of the rows and that both language editions agree item by item. The `contracts` job in CI runs it.

This is not gratuitous caution. Those three baselines used to be hard-coded in `ci.yml` (then `--min 132`, `--min 416`, `--min 43`), forming a second copy of the same numbers as the table — update the table but forget the workflow and the guard waves things through against a stale baseline. This repository has already diverged three times for this reason: a total written as 978 (actually 1150), the English edition recording mac2win as 131, and section 6.5 versus `NOTICE` chapter 8 each holding a different list of "technology not used". **Preventing drift does not rely on "remembering to update both places"; it relies on giving each number exactly one write site that everything else reads.**

### 12.2 A Real Two Hours → One Minute

The Ondra project initially took **6241 seconds (1 h 44 min)** per build and produced **51,534 files**. The root cause was not the environment but a design defect.

pnpm symlinks each package's dependencies into its own `node_modules`—measured, **80 of 83** packages did so. `copyTree` did not skip the nested `node_modules` when copying packages, turning the symlink farm into real files.

| Metric | Before | After |
|---|---|---|
| Payload file count | 51,534 | **6,722** |
| Build duration | 6241 s | **56.5 s** |
| Dependency package files | 3777 (50k after expansion) | 3306 |

The fix: `copyTree` accepts `skipDirs` and skips `node_modules` at any depth when copying dependency packages—dependencies are already collected centrally and flattened at the **same level**, so the nested copy is redundant.

The **110×** improvement came entirely from this one change.

### 12.3 I/O Overhead in Managed Environments

In sandboxed, EDR-scanned or network-drive environments, a single file copy can carry a fixed overhead of 25–40 ms, and **concurrency does not bypass it**:

| Operation | Normal SSD | Managed environment |
|---|---|---|
| Single `copyFile` | < 1 ms | 25–40 ms |
| 20 concurrent copies within `/tmp` | 4 ms | 4 ms (concurrency effective) |
| 20 concurrent copies **across directories** | ~5 ms | 762 ms (concurrency ineffective) |

This is caused by the environment's I/O interception layer. After fixing the design defect above, even a managed environment completes in 56 seconds.

**Two approaches ruled out along the way**: `tar -cf - | tar -xf -` is blocked by the sandbox's stdout redirection (`Unrecognized archive format`); hard links carry the same fixed overhead in a managed environment and fail with `EXDEV` across volumes.

### 12.4 clonefile Space and Time

After copying a 64 MB file, volume free space decreases by **less than 1 MB** (metadata level).

**Measurement method**: `st_blocks` or `du` cannot be used—APFS counts shared blocks repeatedly for each copy. Only the volume free-space delta works:

```python
before = free_space(path)
clone_tree(src, dst)
consumed = before - free_space(path)   # the real consumption
```

This detail caused a misjudgement once: asserting with `du -sk` reported 20 MB both before and after clonefile, leading to the conclusion that "clonefile did not take effect".

**Degradation**: clonefile fails across volumes or on non-APFS filesystems and falls back to `cp -R`, with `method="copy"` in the result and a WARNING logged. In that case space really is consumed.

### 12.5 Why Verification Is Measured in Seconds, Not Minutes

For 4086 files inside a 200 MB exe, calling `7zz x -so` once per file means 4086 process creations—measured at over ten minutes without completing.

The approach is **one extraction plus local hashing**: streaming the extract into memory with `7zz x -so` and hashing there; 4086 files took **0.87 seconds**.

### 12.6 Why No Performance Promises

Compatibility-layer performance is determined by the layer beneath: Wine's graphics performance depends on MoltenVK / D3DMetal translation, and Electron artefact startup depends on Chromium cold start. This project only wires things together and does not modify those layers. Promising specific frame rates or startup times would be irresponsible.

The numbers in the table are all **overheads this project itself produces** (packaging, verification, assembly, parsing), for which measured values can be given.

---

## 13. Security and Privacy

This chapter states only what is actually done, and **what is not**. Claiming undone work as done is more dangerous than leaving it undone.

### 13.1 Network Behaviour

The program accesses the network in exactly two situations, both explicitly triggered by user action:

| Direction | When | Target |
|---|---|---|
| Mac2Win | The build needs to download a runtime and the cache misses | `nodejs.org`, GitHub Releases (Electron), `dl.nwjs.io` (NW.js) and their mirrors |
| ExeOnMac | The user explicitly runs `wepack runtime install` | GitHub Releases (Gcenx `macOS_Wine_builds`) |

`mac2win build --dry-run`, `mac2win verify`, `apponwin assess`, `apponwin parse` and `win2mac build` (assembly phase) make **no network calls at all**. ExeOnMac's `detect` / `extract` / `package` also stay offline—only `runtime install` and the Wine-dependent `install` / `build` trigger runtime acquisition.

**Mirror trade-off**: direct connections to `nodejs.org` from mainland China often run at tens of KB/s, making a 33 MB package take over ten minutes. A mirror list is therefore maintained, ordered by priority: official first, mirror on failure. **Checksums always come from the official source**—a mirror's `SHASUMS256.txt` may lag, so mirrors only accelerate the payload download.

**The `ai/` layer makes no network calls at all.** The MCP server only talks to a local client over stdin/stdout, and `wacmin` only spawns local subprocesses. If an AI client uploads tool results to a model service that is the client's behaviour and outside this repository's control—see 13.5.

### 13.2 Integrity Verification: How Far It Goes

**This must be stated per source, because the four sources provide different levels of assurance.**

| Runtime source | Integrity verification | Strength |
|---|---|---|
| Node.js (Mac2Win) | Downloads the official `SHASUMS256.txt` and compares SHA-256 per file; mismatch fails with `M2W_3002` | **Strong**: an officially published cryptographic checksum |
| Electron (Mac2Win) | No hash verification; after extraction, asserts that `electron.exe`'s PE architecture matches the target | Weak: guarantees only "the right architecture was extracted", not "the bytes were untampered" |
| NW.js (Mac2Win) | Same, asserting `nw.exe`'s architecture | Weak: same |
| Wine (ExeOnMac) | Verifies only HTTP status and that `Content-Length` matches (download completeness); **no GPG signature verification** | Weak: detects truncated transfers, not source substitution |

**Why Electron and NW.js have no hash verification**: neither upstream provides a stable, programmatically obtainable checksum list (Electron's `SHASUMS256.txt` appears only in some releases' assets, with inconsistent formatting; NW.js publishes no official checksums at all). Hard-coding a hash table would mean editing code on every version bump, and would fail wholesale whenever upstream re-uploads a file under the same version number.

**Wine's signing gap is recorded with equal candour**: Gcenx provides no stable GPG signing flow. The same risk is recorded in `NOTICE` section 3.5; nothing is concealed.

**What to do in security-sensitive settings**: use the offline paths. Mac2Win accepts `runtimeArchive` + `runtimeChecksum` pointing at a locally verified file; ExeOnMac accepts `wepack runtime install --archive <path>` pointing at a locally verified `tar.xz`. Both skip the download and perform only local verification.

### 13.3 Security Boundary of Local Services

`mac2win ui` and `wacmin-console web` each start a local HTTP service. **Both can spawn subprocesses**, making them an entry point equivalent to arbitrary local code execution, so the boundary must be tight.

| Measure | Implementation | Threat addressed |
|---|---|---|
| Bind loopback only | `server.listen(port, '127.0.0.1')`, **never `0.0.0.0`** | Anyone on the same LAN executing commands through it |
| Validate `Origin` / `Host` | Accept only `127.0.0.1` / `localhost` / `[::1]`, any port | **DNS rebinding**: a malicious page resolving its own domain to `127.0.0.1` and hitting this API from the browser |
| Subcommand whitelist | The `ALLOWED_COMMANDS` set, 16 permitted values | Arbitrary command injection via the request body |
| Static file path traversal protection | `normalize` the path, then confirm it is still inside the static root (`startsWith(root + sep)`) | `GET /../../node.exe` exfiltrating the runtime |
| Reject failed URL decoding | `decodeURIComponent` throwing returns 400 | Malformed encoding bypassing path checks |

**Mac2Win's in-artefact launcher carries the same protections.** It serves static files under `ui/` and checks identically: normalize, then confirm it remains inside the root. This is not a theoretical risk—artefacts are distributed to users' machines, where the environment is uncontrolled.

### 13.4 Extraction and File Writing

| Scenario | Protection | Direction |
|---|---|---|
| zip extraction | Entry names are normalised to a single separator, then rejected if they start with `/` or contain `..`. Entries such as `../../etc/passwd` in a zip are a common attack technique | Mac2Win |
| Windows paths | Reject reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`), checked after stripping the extension since `con.txt` is equally illegal | Mac2Win |
| Windows paths | Reject characters Windows disallows (`\ / : * ? " < > \|` and control characters) | Mac2Win |
| Windows paths | Reject segments ending in a dot or space. Such names are **silently discarded** on Windows, producing "packaged successfully but the filename does not match" | Mac2Win |
| Download to disk | Write a `.part` temporary file, `rename` after length verification. A mid-way failure never leaves a complete-looking bad file | ExeOnMac |
| Overwrite | Remove the target directory before the upstream operation, avoiding a half-new, half-old artefact | Mac2Win |
| Architecture assertion | Re-assert the PE architecture after extraction, preventing a corrupted runtime from a previous run lying in the cache | Mac2Win |
| Non-empty directory | Error out; never overwrite or delete. `--force` changes only the error message, not the behaviour | ExeOnMac |
| Registry modification | Never edit the prefix's registry binary; write a `.reg` text file and let `wine regedit /S` import it, retaining the file for audit and rollback | ExeOnMac |
| Writable scope | Only `Private/` and `Recipes/` inside the bundle plus `~/Library/Application Support/wexe/`. Never `/Library`, `/usr` or `~/.wine` | ExeOnMac |

**Mac2Win's downloads have no `.part` staging**; they write the target file directly, and an interruption leaves a truncated file that the next run discards when the architecture assertion fails—equivalent to "detect a bad cache". This is a known implementation difference that does not affect correctness.

### 13.5 Privacy

**No telemetry, analytics, crash reporting or usage statistics of any kind.** No request to any statistics service exists anywhere in the code. This can be verified independently:

```bash
grep -rn "telemetry\|analytics\|sentry\|google-analytics" \
  --include="*.mjs" --include="*.js" --include="*.py" \
  mac2win console win2mac apponwin exeonmac ai
```

**Data left locally** (all under the user's home directory; deleting it clears everything):

| Path | Content |
|---|---|
| `~/.wacmin/mac2win/cache/` | Downloaded Node / Electron / NW.js runtimes |
| `~/.wacmin/history.json` | The dashboard's last 20 run records |
| `~/Library/Application Support/wexe/` | Wine runtime, prefixes, shared layers, recipe library, install logs |
| `~/.wexe/recipes/` | Recipe library (`WEXE_RECIPES` overrides) |

**Why dashboard history lives there**: it is runtime data that should not enter version control, nor vanish because the repository was deleted. `WACMIN_HOME` overrides it for tests and multi-instance isolation—tests writing directly to the user's real directory would be a disaster, polluting the developer's dashboard history.

**The AI layer adds no local data.** `ai/` keeps no state file, no conversation log, no tool-result cache. Its only output is the tool return value, handed back to the client over the stdio pipe.

**The MCP privacy boundary deserves precision**: what this repository can promise is that it does not transmit anything on its own initiative. But tool results—artefact paths, error messages, and the usernames and tool versions that `doctor` observes—travel through the client to a model, and **that step is decided by the client the user chose, outside this repository's control**. Accordingly, `doctor` output contains only tool names, versions and paths, never environment-variable values or user identity. In privacy-sensitive settings, check the client's retention policy first.

### 13.6 What Is Not Done

| Item | Status | Reason |
|---|---|---|
| Artefact code signing | Not implemented | Certificate missing, not tooling. The bottleneck is CA/B Forum requiring the private key on FIPS 140-2 L2+ hardware, non-exportable—OS-independent, so a Windows machine changes nothing. `osslsigncode` signs `.exe` locally on macOS. See 15.11 |
| Artefact notarisation | Not implemented | Needs an Apple Developer ID ($99/yr) and `notarytool`, the latter genuinely macOS-only. **ExeOnMac has an additional architectural blocker**: the wine prefix lives inside the bundle and is written in place, so signing breaks the resource seal. See 15.11.3 |
| Local service authentication | Not implemented | Loopback binding plus `Origin` validation already covers the threat model; adding auth complicates CLI triggering with no real gain |
| Transport encryption | Not implemented | Loopback communication; encryption would be meaningless |
| Supply-chain signature verification | Only for Node.js | See 13.2; other upstreams offer no usable list |
| Sandbox isolation | Not implemented | The wrapped program shares the user's macOS session and can read and write any file the user can reach |
| Malicious installer detection | Not implemented | This project does not judge whether an installer contains malicious code, only whether it can be wrapped |

**The last point deserves emphasis**: ExeOnMac **really executes** the user-supplied installer inside Wine (silently). This differs fundamentally from "extracting it to look"—the installer's code actually runs with the current user's file access rights. Use `install` / `build` only on installers from trusted sources.

---

## 14. Compatibility

### 14.1 Host and Target

| Direction | Host requirement | Target | Actually verified |
|---|---|---|---|
| Mac2Win | macOS 11+ / Apple Silicon (recommended) | Windows x86 (i386 PE) and x64 | Verified: real build + three-state verification |
| ExeOnMac | macOS 13+ / Apple Silicon | Windows programs (via Wine) | Verified: detection, extraction, prefix, `.app` wrapping, launch |
| Win2Mac | Windows 10+ | macOS `.app` | Verified: real `.app` and zip produced |
| AppOnWin | Windows 10+ / WSL2 | macOS programs (via Darling) | Not verified: no Windows + WSL2 + Darling environment |

**Why Mac2Win targets Apple Silicon**: the project's positioning is "build x86 Windows packages on ARM macOS". Running on an Intel Mac works but loses that meaning, so preflight warns. Platform detection uses `process.platform !== 'darwin'`; architecture is not a hard rejection.

**Why ExeOnMac requires macOS 13+**: it needs `iconutil`, `sips` and APFS clonefile, and 13 is where all three conditions stabilise together. The artefact's `LSMinimumSystemVersion` is likewise `13.0`.

**Win2Mac also runs on non-Windows**: by default it only warns "host is not Windows"; `--strict-host` refuses instead. This is because packaging on macOS and immediately validating with `plutil` is a valid development flow—`plutil` is Apple's official tool and more authoritative than a custom parser. `--strict-host` is for release pipelines that must produce on the target platform.

**AppOnWin's host detection**: `assess` and `parse` are pure read operations that **run on any platform**. Only `spike` requires a real Windows + WSL2 + Darling environment; when unavailable it reports "unverified" (exit code 5) rather than "passed".

### 14.2 Runtime Version Requirements

| Dependency | Minimum | Measured | Note |
|---|---|---|---|
| Node.js (host) | 20 | 22.x | Requires `node --test`, `fetch` and ESM top-level await |
| Python (host) | 3.11 | 3.11+ | Requires `tomllib` and `X \| Y` type syntax |
| Swift (host) | 6.0 | 6.0+ | ExeOnMac compiles the launcher; needs Xcode CLT |
| NSIS | 3.x | 3.13 | The `MUI2` interface and `File /r` behaviour are stable in 3.x |
| 7-Zip | 22.00 | 25.01 | The `7zz i` output format is stable from this version |
| Wine | Unpinned | 11.21 | Gcenx devel build; other versions unverified |
| Rosetta 2 | System-provided | — | Required on Apple Silicon |
| `plutil` | System-provided | — | Optional, for Win2Mac's `Info.plist` validation |
| `innoextract` | Any | 1.9 | Optional; the only viable Inno Setup extractor |
| `msitools` | Any | — | Optional; preferred MSI extractor |

**Node.js's `≥ 20` is a hard requirement**, not a conservative choice: `node:test`'s `--test` concurrency model, the stable `fetch` implementation and ESM top-level await all become complete at 20.

### 14.3 Target Runtime Versions

| Runtime | Supported range | Hard ceiling |
|---|---|---|
| Node.js (bundled into artefacts) | 20 / 22 LTS | None |
| Electron (bundled into artefacts) | ≤ 43.0.0 | **v44 onwards no `win32-ia32` is published** |
| NW.js (bundled into artefacts) | Per project (default 0.90.0) | None |
| Tauri | No runtime bundled | The artefact is a Rust-compiled native exe |

**Electron's 43 ceiling cannot be bypassed.** It is an upstream release policy, not something this project can solve. mac2win gates higher versions during **preflight** so users do not fail after downloading 100 MB.

### 14.4 Hard Boundaries

| Limitation | Reason | Workaround |
|---|---|---|
| Mac2Win's Electron x86 stops at v43 | No `win32-ia32` prebuilds from v44 onwards | None. Higher versions require abandoning the x86 target |
| Mac2Win artefacts are unsigned | Certificate missing (private key must sit on FIPS 140-2 L2+ hardware, OS-independent), not tooling | Sign with `osslsigncode` locally on macOS, or via `signtool` on a Windows CI runner. See 15.11 |
| Mac2Win does not support native modules (`.node`) | Compiled machine code is bound to OS/CPU | Switch to a pure-JS alternative; mac2win intercepts during collection and names the package |
| Mac2Win cannot build macOS packages on a Mac for Windows | Platform binary formats differ (Mach-O vs PE) and the matching SDK is required | None. Build on the corresponding platform |
| Mac2Win cannot build Linux packages on a Mac | Requires Linux glibc and an ELF toolchain | Docker is possible but out of scope |
| Wails / Flutter desktop across architectures | Their Windows targets require the full MSVC toolchain | No equivalent path |
| .NET / WPF across architectures | Requires the Windows SDK and MSBuild | No equivalent path |
| ExeOnMac requires a self-supplied Wine x86_64 | Wine has never published an arm64 macOS build | None. Only via Rosetta 2 |
| ExeOnMac cannot cover every Windows program | Wine compatibility is determined by the layer beneath; this project does not modify Wine | None. Per-program adaptation through the recipe library |
| ExeOnMac does not support kernel drivers / anti-cheat / hardware dongles | Technically infeasible, and may risk account bans | None, and not intended |
| Win2Mac cannot produce dmg / cannot sign / cannot notarise | `hdiutil` / `codesign` / `notarytool` are macOS-exclusive | Sign and notarise on macOS |
| AppOnWin may not hold | Darling officially supports Linux only; on Windows it requires WSL2 and GUI support is labelled experimental upstream | Demote to a compatibility assessment tool |

### 14.5 Software Categories ExeOnMac Explicitly Does Not Support

On detecting the following characteristics it halts immediately with exit code 4, **attempting no bypass, no degradation, and offering no hint that it "might work"**.

**Kernel and driver classes**: `.sys` drivers, kernel service registration (INF containing `AddService` + `ServiceType=1`), filesystem filter drivers (`minifilter` / `FltRegisterFilter`), virtual network adapters / TAP drivers, printer drivers. Reason: Wine has no kernel mode, so drivers cannot load.

**Anti-cheat and protectors**: EasyAntiCheat, BattlEye, Riot Vanguard, nProtect GameGuard, XignCode3, Themida / VMProtect / Enigma. Reason: anti-cheat relies on kernel-level integrity checks and hypervisor-level detection, which Wine necessarily fails, and the software will be flagged as tampered; even if forced to start, the account would be kicked or banned, which harms the user.

**Protectors are handled separately**: VMProtect-class protection only reports "may not run" without halting, because some single-player programs still work when packed. This is the only soft judgement in the list.

**Hardware dependencies**: hardware dongles (`hasp` / `sentinel` / `rockey` / `aladdin`), TPM requirements, Secure Boot requirements, dedicated capture cards, biometric devices. Reason: macOS has no corresponding hardware abstraction layer, and this project installs no kext.

**System-level components**: standalone Windows Update packages (`.msu`, requiring the full CBS stack), persistent system services (a service inside a prefix has no host after the bundle exits), global shell extensions (requiring an Explorer process; Wine's explorer does not support third-party extensions), input methods (Wine's IME bridge is incomplete), and driver installations requiring administrator elevation.

**Installer types**:

| Type | Status | Note |
|---|---|---|
| NSIS | Supported | 7-Zip extracts directly; a 4898-file sample verified |
| Inno Setup | Supported (requires innoextract) | Without innoextract it reports honestly rather than faking success via 7z |
| MSI | Supported | msiextract preferred; the custom table parser restores real filenames as a fallback |
| InstallShield | Detection only | Newer versions use CAB plus custom scripts, where static extraction usually fails; goes through the silent-install path |
| WiX Burn | Detection only | The bundle embeds multiple MSIs and must be unwrapped first |
| Squirrel | Detection only | `--silent` suffices; it essentially extracts a nupkg |
| Self-extracting RAR/SFX | Unsupported | Requires unrar, and most are password-protected |
| Stub installers that download the payload | Unsupported | Fully offline; no proxy downloading |
| Encrypted installers (password-protected) | Unsupported | 7-Zip would prompt interactively for a password, and this tool is non-interactive |

Any type not listed is `unknown`, exit code 4.

**Runtime behaviour limitations**: no window merging (Wine windows display independently, not integrated with the macOS menu bar), no guaranteed bidirectional clipboard sync (rich text and images do not pass), no global hotkeys, no precise Retina scaling (mixed-DPI multi-monitor setups may misalign), no GPU passthrough (MoltenVK / D3DMetal, performance limited by the translation layer), no exclusive audio (CoreAudio shared mode), no USB passthrough beyond HID.

**The unsupported list only grows.** If an entry becomes supported in a later version, this section's boundary description must be amended before the code is changed.

### 14.6 Cross-Platform Behaviour Differences

Every place where the same code behaves differently across hosts:

| Scenario | On macOS | On Windows | Handling |
|---|---|---|---|
| Path separator | `/` | `\` | `/` used internally; converted only when writing NSIS scripts |
| Permission bits | Unix mode preserved | No such concept | Win2Mac's custom zip writer stores the mode in the central directory's external attributes, so `0755` survives extraction |
| Filename case sensitivity | Case-insensitive by default (APFS is configurable) | Case-insensitive | Case-sensitive behaviour is never relied upon |
| Trailing dots and spaces | Legal | Silently discarded | Checked before packaging and reported as an error, never silently rewritten |
| Reserved device names | Legal | Illegal | Checked before packaging and reported as an error |
| Line endings | LF | CRLF | Generated text files always use LF: NSIS scripts are compiled by `makensis` on macOS where LF works; `Info.plist` is XML for which LF is the spec-recommended value |
| Executability determination | `x` bit | Extension | The main executable inside a `.app` is located via `CFBundleExecutable`, independent of the `x` bit |
| Verdict casing | Insensitive | Insensitive | Enum values in the contract are always lowercase, avoiding platform differences |

---
## 15. Known Issues and Limitations

### 15.1 Known Limitations by Direction

**Mac2Win**

1. **Electron's ceiling is version 43.** An upstream release policy, not something this project can bypass.
2. **Artefacts are unsigned.** The `.exe` triggers a SmartScreen warning, and the only advice is to click "More info → Run anyway". What is missing is a certificate, not a tool—`osslsigncode` signs PE directly on macOS via `brew install osslsigncode`. The certificate side is bound by the CA/B Forum hardware-key requirement (OS-independent). See 15.11.
3. **Native modules are unsupported.** `.node` files are compiled machine code bound to OS/CPU. Collection intercepts them and names the offending package.
4. **The Tauri Rust shell is verified up to "the dependency tree links into a PE", but a complete project still blocks on `llvm-rc`.** The code exists (`src/core/rust-shell.mjs`) and preflight plus configuration are wired up. Measurement on 2026-11-19 corrected two earlier misattributions: the blocker is **not** "sandbox limits prevent installing LLVM", and **not** "arm64 macs cannot build for i686". The real picture: both the Rust chain and tauri 2.12.7's entire dependency tree compile to `PE32/i386` on arm64 macOS (measured `linkprobe.exe`, 1096192 bytes); a complete project blocks because `tauri-winres` needs `llvm-rc` for the resource section and **it is not installed here** (modifying the user's toolchain was not performed automatically). See 15.10.
5. **The x64 target was added later.** The three places that hard-coded x86 (runtime filename, cache directory, architecture assertion) are fixed, but x64's measured coverage is smaller than x86's.
6. **`--target x64` artefacts still have an i386 stub shell.** This is not a defect: NSIS always compiles a 32-bit installer, which runs on all Windows versions. The verification rules distinguish "shell" from "payload" accordingly.

**ExeOnMac**

1. **A self-supplied Wine x86_64 runtime is mandatory.** The repository ships no binaries; use `wepack runtime install`.
2. **Compatibility is determined by Wine.** This project identifies, extracts, builds prefixes and packages; it does not modify Wine and does not promise that any specific Windows program will run.
3. **Without innoextract, Inno Setup yields only the stub section**, and main-exe location fails. This is now reported honestly rather than as a false success.
4. **The MSI 7z fallback restores files and directories only**, not component installation order or custom actions. The custom table parser covers only `File`, `Directory`, `Component` and `Shortcut`.
5. **InstallShield and Burn are detection-only**, going through the silent-install path.
6. **A silent installation failure does not auto-fallback to interactive.** `--interactive` must be specified explicitly. Reason: automatic fallback pops a window that interrupts batch runs, and the user may not be at the machine.
7. **Restart suppression is "pretending success".** Installations that genuinely require a reboot (rare) manifest as "installed but will not start" and require manual investigation.
8. **Runtime downloads verify no signatures**, only download completeness. Use `--archive` in security-sensitive settings.
9. **base / dotnet / fonts-cn can all be built automatically.** mfc and vcpp still cannot (no lawful source for the former; base already bundles the latter). See [4.2.1](#421-automatic-layer-builds-three-of-five-are-automatable-two-are-not).
10. **Layer matching only inspects the static import table.** DLLs loaded via `LoadLibrary` (plugin architectures, delay loading) are invisible, and such programs need manual layer addition.
11. **Wine window coordinate mapping under multi-monitor / HiDPI is not handled.**
12. **Without icon resources a placeholder is used** (blue background, white W). The artefact is legitimately distributable, but its appearance is not faithful.
13. **After a timeout the process group is force-killed, but Wine may leave lock files in the prefix.** Deleting `Private/.wine-*` manually before retrying is recommended (not automated).
14. **MSI table parsing does not cover every MSI variant.** Some MSIs pack multiple tables into one stream, and row counts are inferred from content features, which can misjudge in extreme cases.

**Win2Mac**

1. **Artefacts are unsigned and not notarised.** First launch triggers a Gatekeeper prompt that the user must clear manually.
2. **Cannot produce dmg.** `hdiutil` is a macOS-exclusive tool.
3. **Does not compile Mach-O.** The file pointed to by `--executable` must be supplied by the user and must be a genuine Mach-O; otherwise the command warns rather than silently proceeding.
4. **bundle id collision detection depends on `lsregister`**, which is macOS-only. Building on Windows cannot pre-check collisions, so verify once on macOS.

**AppOnWin**

1. **The largest uncertainty in the project.** Darling officially supports Linux only; on Windows it requires WSL2, and GUI support is labelled experimental upstream. Failing spike gate 2 demotes it to a compatibility assessment tool.
2. **The verdict on this machine is "environment not available", not "does not hold"** (measured 2026-11-19, see 3.4). Gates 1 and 2 are `blocked` because the host is not Windows; gate 3 passes. Overall `unverified`, exit code 5. This verdict is neither a pass nor a refutation — it only says the machine cannot verify it.
3. **The framework list is incomplete.** Frameworks absent from the list are always `unknown`; availability is never assumed.
4. **`blocked` in `spike` has two causes**: environment unavailable (exit code 5) and invalid input path (exit code 2, non-empty `inputErrors`). They must not be conflated; conflating them escalates "mistyped path" into "direction disproven".

**console**

1. **The web dashboard binds `127.0.0.1` only** and offers no remote access. This is a deliberate security trade-off.
2. **History retains only the last 20 runs**, with no archiving or export.

### 15.2 Measured Results for the Real-Run Chain (2026-11-19)

This section answers a question only running can answer: **what happens with no Wine, and with Wine, can a Windows program actually be launched**. Both need measurement, not inference.

**Environment facts**: this machine has `wine-11.21` (x86_64, via Rosetta 2), installed by `wepack runtime install --archive`. `which wine wine64` finds nothing on the system PATH — that is not a defect: the runtime is managed by `wepack` under `~/Library/Application Support/wexe/runtime/wine/` and deliberately does not pollute PATH.

**① The no-Wine branch (degraded path)**

`wine_binary()` looks at the managed runtime first, then PATH, and raises `MissingDependency` only when both are empty. The CLI maps that to exit code 5 ("missing external dependency" in `contracts/exit-codes.json`) with error segment `EOM_2001` (2xxx, "external tools"). Coverage lives in `tests/test_phase2.py::test_install_without_wine_fails_clearly` (asserts exactly 5 and that the payload's `error` mentions `wine`) and `test_phase0.py::test_install_requires_wine_runtime`. All three paths (install / build / layers match) share this one rule rather than each writing their own.

**② One end-to-end encapsulation with Wine present (measured on this machine, not inferred)**

Sample compiled on the spot: `makensis` builds an NSIS installer with 15 files / 2.2 MB including a genuine `PE32+ GUI x86-64` main executable. Run through `wepack build`:

| Stage | Measured result |
|---|---|
| Detect | `kind=nsis`, confidence on the NSIS branch |
| Prefix creation | clonefile of 1858 base-layer files, sub-second |
| wineboot | `code=0`, 11.5 s |
| Silent install | `code=0`, 6.6 s, net +12 files / 2.1 MB |
| Entry detection | `drive_c/Wacmin/<app>/<App>.exe` |
| Assembly verification | 10 / 10 passed, `lsregister` succeeded |
| **Launch** | launcher → wine → main exe process alive (`pgrep` shows the pid); `wine-<app>.log` contains only MoltenVK graphics-layer lines, no `ShellExecuteEx failed` |

The launch step is the only **new evidence** this round: earlier the verification stopped at "the artefact is structurally valid" and never confirmed "double-clicking starts a process". The first attempt used a hand-made minimal PE (DOS header + optional header only, no section table) and Wine reported `Application could not be started / ShellExecuteEx failed: Bad format` — **a sample problem, not a tool problem**: that PE has no section table, and the Windows loader would refuse it just the same. Switching the payload to a real `notepad.exe` shipped with Wine passed on the first try. The lesson worth recording: **verify the run chain with a genuinely executable PE; a minimal PE header only proves "the format is recognised", not "it runs"**.

**③ Two real defects fixed**

The measurement surfaced two defects that no prior test had caught, neither introduced this round:

| # | Defect | Consequence | Fix |
|---|---|---|---|
| 1 | `package`'s `_guess_entry` and `install`'s `_find_installed_entry` were **two different rules** | Whatever you installed, the bundle pointed at the base layer's own `wordpad.exe` — the `.app` double-clicked and started a process, just not the software the user installed | Rule consolidated into `wepack/entry.py`; both call it (the README 5.3 red line) |
| 2 | `build --json` passed `--json` through to `install` and `package`, each emitting its own payload | stdout carried two concatenated JSON documents and `json.load` raised `Extra data` — the caller got nothing usable | Sub-commands always run with `json=False`; human-readable output redirected to stderr; `build` emits one summary itself |

What the two share is worth recording: **neither raises an error**. Defect 1's artefact launches; defect 2 looks like normal output in a terminal. This class of "silently doing the wrong thing" can only be caught end-to-end — unit tests stay green because each piece is correct in isolation.

**④ Still unverified**

- **The wording of `runtime status` when Wine is off PATH**: covered by tests, but no human has read it for actionability.
- **Behaviour across Wine versions**: only 11.21 measured. The version requirement in 14.2 comes from upstream documentation, not from a matrix measured here.
- **Actual rendering of the GUI window**: this was an unattended run, so only process liveness and a clean log were verified; the window contents were not confirmed by eye. That is this round's honest boundary, and it is not written up as "verified".

### 15.2.1 Measured Record Behind the AppOnWin Verdict (2026-11-19)

Section 3.4 gives the verdict; this gives **the run that produced it**, plus a defect that run exposed.

**Commands and outputs** (host is macOS arm64, no WSL2):

| Command | Conclusion | Exit code |
|---|---|---|
| `node apponwin/bin/apponwin.mjs spike --json` (no samples) | `unverified`, all 3 gates `blocked` | 5 |
| `node apponwin/bin/apponwin.mjs spike --app /System/Applications/Calculator.app --json` | `unverified`, gates 1/2 `blocked`, gate 3 `pass` | 5 |
| `node apponwin/bin/apponwin.mjs assess /System/Applications/Calculator.app` | `unlikely`: 2 binaries / 21 frameworks / 3 explicitly unsupported by Darling / 12 `unknown` | 0 |

Gate 3 passing deserves its own note: it proves the **parsing capability** (which `assess` / `parse` already deliver), and since it does not depend on Darling it proves nothing about "can it run". **All three gates must pass to count as holding; missing one means unverified** — "one out of three passed" is not "partially holds", that intermediate state does not exist.

**The defect caught along the way: `spike` treated "mistyped path" as "direction disproven"**

| | Before | After |
|---|---|---|
| `spike --app /nope.app` conclusion | `rejected` | `unverified` + non-empty `inputErrors` |
| That gate's status | `fail` | `blocked` + `invalidInput: true` |
| Exit code | **1** | **2** |
| What the user sees | "the direction is demoted to a compatibility assessment tool by design" | "1 gate was not executed because the input path is invalid (the direction does not fail). Fix the path and re-run." |
| Same path handed to `assess` | exit code 2 (`AOW_1002`) | exit code 2 (unchanged) |

The root cause was gate 3's `catch` recording `BuildError(INPUT_NOT_FOUND)` alongside genuine parse failures as `fail` — and any `fail` forces the overall conclusion to `rejected`. **`fail` must be reserved for "ran once and failed"**; a non-existent path never entered parsing, so it is "I do not know", which is `blocked`.

Fixing it revealed a second layer: gate 1 probed the environment before validating the sample path, so whenever the environment was missing (as here) the user never saw "your `--sample` is wrong" — the message worth seeing first. Path validation now runs before environment probing: **an argument error must surface on any machine, regardless of whether WSL2 is installed here**.

Regression locks live in `apponwin/test/spike.test.mjs`: three new cases ("invalid input path yields unverified with inputErrors", "non-existent Mach-O sample makes that gate blocked, not fail", "correct path with a missing environment is not counted as inputError"), plus the previously **wrong assertion** "non-existent path yields fail" corrected to assert `blocked`. Negative check: injecting the old implementation back into `spike.mjs` turns 2 tests red immediately (`not ok 26` / `not ok 27`); restoring gives 94/94 green.

### 15.3 Three Divergences Between Documentation and Implementation

This section records three real instances where "the documentation said one thing and the code did another". They are recorded not to assign blame but because all three belong to the class of problem that **does not crash, only wastes the reader's time**, and is therefore most easily waved through again and again.

**① `mac2win ui --port` / `--no-open` were entirely absent from help**

The feature worked and the code was correct, but help did not mention it at all. Users wanting to specify a port could only guess, and failing to guess, assumed it was unsupported. The fix writes both options into the help's "graphical interface options" section.

**② `mac2win doctor` was missing from help's "usage" section**

The command was supported—even the "unknown subcommand" error message listed it—yet the top of help omitted it. It appeared not to exist.

**③ `--report` was undocumented in mac2win's help alone**

The other three directions' help all mentioned "`--report` outputs the unified run report". The unified report contract is a core mechanism shared by all four directions, yet exactly one direction failed to surface it.

Beyond "missing documentation" there is the reverse problem—**help promising what the code does not implement** (early on, `--no-package` was exactly that). Both directions must be guarded, which is why each direction's help tests assert in both directions (`test/help.test.mjs` on the Node side, `tests/test_phase0.py` and `test_phase6.py` for `wepack`).

#### 15.3.1 A Systematic Audit of the Documentation Side (2026-11-19)

The three cases above were found by accident. On 2026-11-19 a **mechanical** audit was run: the 267 command lines inside the README's 42 shell blocks were extracted, yielding 31 unique executable commands. The **read-only and self-check** ones were run one by one; the ones **requiring a real artefact or a Windows host** were only reconciled against help text and code paths (both lists appear at the end of this subsection and are not conflated); every number in the tables was reconciled against the constants in the code.

**Result: 9 divergences between documentation and implementation, all now fixed.** Every one belongs to the class where a reader following the document either cannot complete the step or sees something different from what is described. In addition, 4 missing directory-tree entries and 1 broken anchor were corrected, noted at the end of this subsection.

| # | Location | Stated | Measured | Nature |
|---|---|---|---|---|
| 1 | 5.2.2 segment table | 8 rows, `9000` given as `9001–9999` meaning "flow control and internal errors" | `error-prefixes.json` defines **9 segments**: `9000` is `9001–9998` (flow control) and `9999` is a separate `9999` (internal errors) | Both the count and the range were wrong. `segmentOf()` in `validate.mjs` routes by the actual `range`, so a reader trusting the old table cannot reconcile the validator's behaviour |
| 2 | 9.1 contract-file table | "seven-segment allocation" | 9, as above | Same root as #1 |
| 3 | 8.2 quick start | `open "~/Applications/MyApp (Win).app"` | A `~` inside quotes is not expanded by the shell; `open` reports `~/Applications/... does not exist`. **Copying this line always fails** | Non-executable command. Note the preceding `install -o "~/..."` is correct—`wepack` calls `expanduser()` itself; the difference is that `open` is an external process |
| 4 | 6.4 transitive dependencies | "seven modules (**five** directions, `console`, `ai`, `contracts`)" | There are only 4 directions (`mac2win`/`exeonmac`/`win2mac`/`apponwin`), and 7 = 4 + 3 | The arithmetic inside the parentheses does not hold |
| 5 | Appendix C item 2 | 32 configuration keys / 14 external tools / 10 subcommand families | 9.2 has **37** rows (matching `DEFAULTS` in `config.mjs`, 37 keys), 6.2 has **18** rows (`NOTICE` chapter 3 also has 18), 10.1 has **6** rows | All three numbers stale |
| 6 | Appendix C item 3 | twenty highlights | Actually **25** (including "Highlight 15b" and "15c") | Undercounted |
| 7 | 5.10.4 and 18.1 | "instances are in 18.5" / "in 15.2" | The instances are in **15.3** (*Three Divergences Between Documentation and Implementation*); 15.2 is the ExeOnMac real-run measurement and 18.5 is the documentation-sync requirement | Two cross-references pointing at the wrong section |
| 8 | Appendix C item 6 | test sizes (**16**), check counts (**15.5**) | The test-count table is **12.1** (16 is the changelog); the check counts are in **15.6** | Two more wrong references |
| 9 | 10.1 common options | "`-v/--version`" identical across all four directions | In `mac2win`/`win2mac`/`apponwin`, `-v` is short for version; in `wepack`, `-v` is short for **verbose** and `--version` has only the long form as a top-level argument | Divergent semantics; a script using `-v` for the version gets logs |

**Four missing entries in the directory tree were added at the same time**: `contracts/doc-counts.mjs` and `doc-counts.test.mjs`, cited in the body (12.1 states the baselines are read from that table) but absent from the 11.1 tree; likewise `wepack/entry.py` and `wepack/report.py`, both named in 5.3 and 10.3.

**One broken link was fixed as well**: the "Dependencies" badge at the top of the English README pointed at `#6-technology-stack-and-dependency-inventory` while the actual heading is `## 6. Technology Stack and Dependencies`, so the anchor is `#6-technology-stack-and-dependencies`. Clicking it landed on a dead anchor rather than the chapter. All internal anchors in both files now validate with 0 invalid.

**What passed is recorded too**, so the next round does not repeat the work. **Note the split between "actually run this round" and "not run this round"**—nothing unverified is written up as passing:

**Commands actually run this round** (read-only and self-check only; listed individually rather than as a total, because this round already produced one miscount of its own command list). `--help` was also invoked for every direction to reconcile option lists:

- `node contracts/validate.mjs` → `✓ contract self-consistent` (13 exit codes, 9 segments, 4 prefixes)
- `node contracts/doc-counts.mjs --check` → total matches the 12.1 table, both versions identical item by item (1177 at the time; 12.1 is authoritative)
- `node console/bin/wacmin-console.mjs list` / `doctor` / `contract` → 4 / 4 / 10-10
- `node ai/bin/wacmin.mjs list` / `status --human` / `mcp` / `skill` → matches section 8.6
- `node mac2win/bin/mac2win.mjs doctor` → 5 items all OK
- `python3 -m wepack.cli doctor` / `version` / `recipe list` / `layers list` / `runtime status`
- `node apponwin/bin/apponwin.mjs spike` (including `--json`) → exit code 5, conclusion `unverified`
- `node console/bin/wacmin-console.mjs run exeonmac version` → normalised report, all eight stages `skipped`
- `node mac2win/bin/mac2win.mjs build /tmp/w03proj --dry-run` → all 14 preflight items pass, eight-step plan printed, exit code 0 (**measured against a temporary minimal Node project, not a real build**)
- `node console/bin/wacmin-console.mjs run mac2win build /tmp/w03proj --dry-run` → same via the unified entry, exit code 0
- `node contracts/validate.mjs --report <report> --exit-code 0` → validates a real report produced by `console run mac2win doctor`, `✓ contract self-consistent`
- `node ai/bin/wacmin.mjs doctor mac2win --report` → unified report structure
- `node console/scripts/viewport-check.mjs` → 0 overflows across all three viewports

**Not run this round, only statically checked** (must not be treated as verified):

- `mac2win build` **without `--dry-run`**, and `verify` (both need a complete build artefact; not done this round. The `--dry-run` branch was run)
- `wepack install` / `build` / `extract` (needs installer samples; the end-to-end `install`/`build` run was verified in run-20261119-0753 but not re-run here)
- `win2mac build` / `verify`, `apponwin assess` / `parse` (need a Windows host or a `.app` sample)
- `console web` (listens on a port indefinitely—unsuitable for unattended runs)
- Sample flags in the README (`--dry-run`, `--keep-staging`, `--framework`) were **only confirmed to exist in help**, not each run end to end

**Statically checked and passing**:

- HTTP endpoints: 8 in `mac2win` (`state`/`preflight`/`build`/`cancel`/`verify`/`probe`/`reveal`/`events`) and 4 in `console` (`history`/`status`/`contract`/`run`), matching the 10.4 table item by item;
- Stage breakdown: Mac2Win's eight stages match `STAGES` in `builder.mjs` including weights (1/3/4/2/4/2/5/3); ExeOnMac's eight stages match `STAGES` in `report.py`;
- Test counts: all seven suites with 0 skipped; **the actual numbers live in 12.1 and are not duplicated here** (an earlier draft hard-coded a total on this line, and it went stale the moment apponwin gained 3 tests — exactly the "one number stored in many places inevitably drifts" problem this section criticises);
- All 13 environment variables are genuinely read (each grep-confirmed in non-test source);
- 6 MCP tools, matching `ai/src/tools.mjs`.

**The lesson from this audit itself**: 4 of the 9 (#5 #6 #7 #8) were **numbers and references**, not prose. A stale number is invisible because it reads perfectly well—which is the same issue as 12.1's "one write point per number", seen from the other side. Appendix C's self-check list has no machine guard, so it drifts. **The next step should fold it into the checks in `contracts/doc-counts.mjs`**, so these numbers are read out by a script instead of being counted by a human.

#### 15.3.2 Appendix C Gets a Machine Guard (2026-11-20, optimisation round 1)

The to-do left by the previous section is now closed. Appendix C contains eight hand-counted numbers, and **nothing was checking any of them**.

**The blindness was measured, not assumed**: change the Chinese version's "37 个配置项全表（9.2）" to `32` and "二十五条亮点" to "二十条亮点", then run `node contracts/doc-counts.mjs --check` — the output was still `✓ 12.1 计数一致：7 个模块合计 1287 项`, exit code 0. The guard did not exist in any meaningful sense.

**The fix**: a new `contracts/appendix-guard.mjs` reads all eight numbers **from their real sources at check time**, memorising none of them:

| What Appendix C claims | Real source | How it is read |
|---|---|---|
| 37 configuration keys (9.2) | `DEFAULTS` in `mac2win/src/core/config.mjs` | `import` and count keys, **cross-checked** against the row count of the first 9.2 table |
| 13 environment variables (9.3) | the 9.3 table | count data rows |
| 18 external tools (6.2) | the 6.2 table | count data rows, **cross-checked** against `NOTICE` chapter 3 |
| 6 subcommand families (10.1) | the first 10.1 table | count data rows |
| twenty-five highlights | `#### 亮点` headings | count headings |
| 11 sections in chapter 5 | `### 5.` headings | count headings |
| 13 `NOTICE` chapters | top-level numbered chapters | count `## 一、`… and verify numbering is contiguous from 1 |
| 11 artifact checks (15.6) | the 15.6 table | count data rows |

**Why cross-checking is mandatory**: configuration keys live in two places (37 keys in `DEFAULTS`, 37 rows in the 9.2 table) and external tools in two (`6.2` and `NOTICE` chapter 3). Comparing Appendix C against only one side leaves the other free to drift. Measured: with the cross-check disabled, adding a key to `DEFAULTS` while leaving the 9.2 table untouched reports only "Appendix C says 37, actual 38" — it **never tells you the 9.2 table is stale too**.

**One entry point only**: `contracts/doc-counts.mjs --check` now runs both 12.1 and Appendix C. `ci.yml` and the 18.2 check block already invoke that command, so no workflow change is needed and no new command can be forgotten. Two half-entry points, `--check-counts` and `--check-appendix`, exist purely for test fixtures — the 12.1 fixtures build two READMEs, while the Appendix C fixtures also need `NOTICE` and `config.mjs`; merging them would force both sets to construct unrelated files.

**Negative verification (9 cases, all effective)**: each of the eight numbers was corrupted once, and each was named with a uniform message — `附录 C 写 32 配置项数，实际 37（config.mjs 的 DEFAULTS 键数）`. A further group changes the **source** while leaving Appendix C untouched: one extra row in 9.3, one extra key in `DEFAULTS`, one extra row in `NOTICE` chapter 3, one deleted highlight heading — all four caught. **Re-injecting the old implementation** (dropping the `checkAppendix` call) turns **9 cases red immediately** in `appendix-guard.test.mjs`; restoring it gives 32/32 green.

**This and 12.1 are two symptoms of one disease**: 12.1 guards test counts, Appendix C guards document facts, and both shared the same root cause — **a number counted by a human with no path to recompute it**. Any number stored in two places without a script to reconcile them will diverge eventually; the only question is whether a maintainer or a user notices first.

**A longer-latent defect surfaced along the way (in `doc-counts.mjs`, not in the new code)**: `parseCountTable` claimed to read "the 12.1 table" but actually scanned **every** table row in the whole README, with later rows overwriting earlier ones. Ordinarily harmless, because 12.1 is the only such table; but 15.13's delivery-audit section added a historical comparison table containing `| contracts | 79 | 58 (with 1 red) |` — it sits after 12.1, so `--check` read contracts as **79** while 12.1 plainly said 111.

How it was found is worth recording: this round changed 12.1's contracts from 79 to 111 and the total from 1287 to 1319, and `--check` reported "total says 1319 but the parts sum to 1287". An arithmetic mistake is the natural first suspect, but 167+453+130+96+230+132+111=1319 is correct. The real cause was that the calculation read a historical table 300 lines away. **This defect never produces a false alarm** — total and parts come from the same misread, so the sum stays self-consistent — which is exactly why it can hide for so long: it only shows up when a real value changes.

The fix: crop to the `### 12.1` section before parsing (falling back to the whole document when the heading is missing rather than returning an empty table, which would turn the error into "the table is missing 7 modules" and hide the real cause). Two guards were added: a corroborating table placed after 12.1 with a same-named `contracts` row must not affect the reading, and a missing heading must fall back rather than yield an empty table. **Negative verification**: re-injecting the whole-document scan turns 2 cases red; restoring gives 17/17 green.

The historical table in 15.13 also gained a note marking it as a snapshot that does not track the code and is never read by `doc-counts.mjs` — otherwise the next person to see `contracts | 79` there would conclude 12.1 was out of date.

### 15.4 The Time the Verifier Lied

This section stands alone because it is the **most dangerous** class of defect encountered so far: the program did not crash, the tests were all green, the conclusion was explicit, and the conclusion was false.

**Symptom**: on a machine without 7-Zip, `mac2win verify xxx-setup.exe` ended with "✓ verification passed" and exit code 0.

**What was actually verified**: only the PE header. What the payload contained, whether `node.exe` was 32-bit or 64-bit, whether required files were present, whether the hashes of 4000+ files matched—**not one of these was checked**.

**Why**: `VerifyReport.ok` only looked for `fail` entries, and "7-Zip not found, skipping payload verification" was recorded as a `warn`. `warn` does not affect `ok`, so the report had `ok === true` and the CLI faithfully printed "passed".

**Why this is worse than a crash**: a verification failure prompts investigation; a false pass does not. The user takes an installer whose header alone was checked, together with a "verification passed" conclusion, and distributes it.

**Fix**: split the verdict into two orthogonal dimensions, as in section 5.4.1. Two accompanying fixes were also made:

- **The scope of `find7zip()`.** It used to check a few fixed absolute paths plus PATH. On the measured machine the `7zz` on PATH was a build-sandbox wrapper script (failing with `spawnSync 7zz ENOENT`) and Homebrew was absent—yet BlueStacks and Parallels each bundled a **working** 7-Zip at `/Applications/*.app/Contents/MacOS/`. "Not installed" and "installed but you cannot find it" are two different things: the former requires user action, the latter is tool failure.
- **Probing must not rely on exit codes alone.** `/bin/echo i` also exits with 0, and the early implementation accepted it as 7-Zip. The consequence is insidious: the subsequent `l -slt` receives unrelated text, no file list can be parsed, and the final report says "payload file count 0"—which looks like a corrupt installer. The criterion is now output features (both `7-Zip` and `Formats:` present).

The UI was corrected in the same place: it used to render "`result.verify.length` items passed"—that is **all items**, including `warn` and unverified ones. With 5 of 10 unverified, the UI still said "10 items passed". There are now four phrasings, with amber rather than green for unverified.

`MAC2WIN_NO_7ZIP=1` is the escape hatch for this branch. It is not for coverage padding: the decisive branch for a missing 7-Zip is only reached when **the user's machine happens to lack it**. A developer machine almost certainly has it, so the branch may go unexercised for a year—and when finally reached, the user receives a report that lied.

### 15.5 The Second Form of "the Verifier Is Lying"

`target: "x64"` was selectable in the configuration and preflight said "feasible", but three places in the implementation hard-coded x86:

| Layer | Hard-coded value | Consequence |
|---|---|---|
| Runtime download | Filename `node-v22.23.5-win-x86.zip` | A 32-bit runtime was downloaded |
| Cache directory | `node-22.23.5-win-x86/` | The two architectures overwrote each other |
| Architecture assertion | Required `isX86 === true` | A 32-bit payload was judged passing |
| Verifier | `'target architecture x86'` | The report read "x86 passed" |

Combined effect: `--target x64` produced a package claiming 64-bit but actually 32-bit, **with every check stamped as passed**. That is far more dangerous than an outright error.

**Fix**: derive the platform identifier from the target (Node uses `win-x86` / `win-x64`, not Electron's `win32-ia32`); separate cache directories by architecture; change the assertion to "PE machine type === expected target"; have the verifier assert against `expectTarget` and title the check "target architecture x64".

**One semantic that must be clarified**: after the fix, the first x64 run fails:

```
✗ Target architecture x64: actual is i386, not x86-64
```

Yet extracting the payload reveals `node.exe` is `PE32+ / x86-64`—**the application itself is correct**. The reason: an exe compiled by NSIS is always an i386 stub, merely an installer. The verification rules therefore distinguish two objects:

| Object | Expectation |
|---|---|
| Installer shell | `PE32 / i386 / GUI` (NSIS's fixed form) |
| Payload `node.exe` | Determined by `target`: `i386` or `x86-64` |

Measured across both targets: `--target x86` → shell `PE32/i386` + payload `PE32/i386`; `--target x64` → shell `PE32/i386` + payload `PE32+/x86-64`. Reverse verification: validating a 32-bit artefact against the x64 target is correctly rejected.

### 15.6 The "Nine Checks" Divergence from the Actual Eleven

The documentation long stated "nine artefact checks" while measurement showed 11. The root cause was that checks had been added over time (required files split out, installer shell format added) without the documentation being updated.

**The measured 11 checks**:

| Check | Criterion | What a failure indicates |
|---|---|---|
| Artefact exists | File readable | Packaging failed |
| Installer shell format | `MZ` + `PE\0\0` signature | Not a Windows executable |
| Application body architecture | For target `x86`, assert the payload runtime is i386; the installer shell is always 32-bit NSIS and does not count toward the body criterion | Architecture mismatch on the target machine |
| GUI subsystem | Optional header subsystem = `2` | Double-clicking pops a console window |
| Installer format | 7-Zip identifies it as NSIS | Payload structure corrupted |
| Payload file count | > 0 | Empty package |
| Required file `node.exe` | Present in the payload | Will not start after installation |
| Required file `bootstrap.mjs` | Present in the payload | Will not start after installation |
| Required file `launch.json` | Present in the payload | Launch parameters missing |
| Payload `node.exe` architecture | PE32 / i386 | Wrong runtime architecture |
| File hashes | Per-file SHA-256 compared against the build manifest | Files corrupted during compression or extraction |

**All 11 appear only during "post-build verification".** `mac2win verify <existing installer>` has no build manifest and cannot compare hashes, so it performs **10 checks**—the missing one being "file hashes". This is by design, not a defect: hashes prove "the artefact is byte-identical to what was just built", which cannot be proven for an installer of unknown provenance. Reporting 10 honestly is more important than falsely claiming 11 green.

### 15.7 Other Fixed Defects

| Defect | Symptom | Root cause | Fix |
|---|---|---|---|
| Symlink cycles hung packaging | Six minutes of no progress, directory growing to 374 MB | `fs.cp({dereference:true})` expanded cyclic symlinks | Deduplicate by `(dev, inode)` |
| Symlinks copied as files | A single directory copy produced 44,346 files / 410 MB | `Dirent.isDirectory()` returns false for symlinks, so they were `copyFile`d, effectively expanding the whole `.pnpm` | `stat` symlinks separately and handle by target type |
| Payload gained an extra `app/` level | Verification reported "required file not found" | `File /r` expansion does not include the source directory name | `SetOutPath` adds the `app` level |
| `WriteRegStr` argument count wrong | makensis reported `expects 4 parameters` | `HKCU\Software\...` was merged into one argument | Separate the root key from the subkey |
| Mixed separators in `File` paths | makensis could not find files | Assembled as `"/tmp/app\*.*"` | Normalise to `/` |
| Launcher could not find the shell after renaming | Double-click flashed and exited | `launch.json` named `nw.exe` while the file had been renamed | Record the real name returned by repackaging, plus a fallback scan |
| Browser-launch failure killed the app | Log showed `spawn cmd ENOENT`, then the process died | `spawn`'s error event had no listener and escalated to `uncaughtException` | Attach an `error` listener and degrade to logging |
| Verification blocked by security policy | Build succeeded but reported `SAFE_DELETE_BULK_CONFIRM_REQUIRED` | Bulk deletion after extracting 4088 files | Delete the single directory immediately after extraction instead of batching |
| Verification took over ten minutes | Stuck at "streaming hash comparison" | One `7zz x -so` call per file, 4086 process creations | One extraction plus local hashing |
| Extraction added a top-level directory | `node.exe` was under `node-v22.23.5-win-x86/` | The official zip contains a prefix directory | Flatten the single root level after extraction |
| `which 7zz` found a wrapper script | Verification reported "installer corrupted" | A same-named shim on PATH | Run `7zz i` once per candidate to validate |
| Dependency collection missed transitive dependencies | Artefact failed on launch with `Cannot find package 'cosmokit'` | Collected only from the import graph, without expanding each package's declared `dependencies` | Two-phase collection: scan imports, then expand via `package.json` |
| pnpm layout caused incomplete dependency copies | Same as above | `cordis-host/node_modules/@ntars/cordis` is a symlink whose dependencies live in the `node_modules` one level up | Rebuild a flattened `node_modules` from the collection |
| Dependencies over-collected | Picked up `@napi-rs/canvas-darwin-arm64`, `node-gyp-build`, etc. | Scanned the whole `.pnpm` sibling directory, including devDependencies | Read only each package's own `package.json` `dependencies` |
| `cfb` parsing treated `_StringPool` as mojibake | All MSI stream names failed to parse | Stream names are privately encoded | Use the root storage CLSID plus content-feature stream identification |
| NSIS detection missed real samples | A real sample was judged `unknown` | Tested `DEADBEEF` at `overlay+0` while the signature sits at `+4` | Correct the offset |
| `File` table row count misjudged | Trailing data treated as row content | Assumed rows = total u16 count ÷ column count | Determine row count from content features (a run of `fil`+32hex) |
| Chinese application names collided on bundle id | 11 names produced only 1 id | `[^a-z0-9-.]` swallowed entire Chinese segments | Append an 8-hex SHA-256 prefix for non-ASCII input |
| Wrong key names in the preflight error-code map | Building on Linux / Windows reports "project directory does not exist"; the user chases a path typo while the real cause is an unsupported host | `CHECK_ERROR_CODES` listed `host-os` / `native-window` while the source actually uses `host-platform` / `framework-shell`. A mismatched key raises nothing—it silently falls into the `?? PROJECT_NOT_FOUND` default | Use the real ids, plus a source-scanning test: every key must appear in a `new Check()` call, and every check that can fail must be explicitly mapped |
| `apponwin spike` treats "mistyped path" as "direction disproven" | `spike --app /nope.app` prints "the direction is demoted to a compatibility assessment tool by design" with exit code 1, while the same path handed to `assess` yields exit code 2 | Gate 3's `catch` recorded `BuildError(INPUT_NOT_FOUND)` as `fail`, but `fail` means "executed and failed"—a non-existent path was never executed. Any `fail` turns the overall conclusion into `rejected` | Invalid input maps to `blocked` with an `invalidInput` flag; `runSpike` aggregates them into `inputErrors`, and the CLI branches to exit code 2 / `AOW_1002`. Gate 1 now validates the sample path before probing the environment, otherwise the one message worth seeing first ("your path is wrong") never surfaces when the environment is missing |
| `contracts/validate.mjs` splits a range into two endpoints | A report with `exitCode: 6` and `M2W_4002` is rejected as "exit code and error code disagree", yet 4002 is perfectly legal | `errorSegment` was parsed with `split(/[/-]/)`: `"4001-5002"` becomes `['4001','5002']`, so a mid-range code equals neither bound. It went unnoticed because real reports mostly hit the endpoints (4001 / 5002), which are exactly the split results | Extracted `segmentAllows()` to handle `-` and `/` separately. Tests do not just cover 4002: `4001/4002/4003/5001/5002` and `6001/6002/6003` are all exercised—testing only the endpoints tests nothing |
| `win2mac --strict-host` produces a self-contradictory report | `--strict-host` exits 2 with `W2M_1001`, but none of the contract's 13 exit codes declares 1001 | It threw `HOST_UNSUPPORTED` (1001) and `exitCodeFor` fell back to 2 by segment. The user reads "bad argument" and hunts for a path typo, while the real cause is "this machine cannot do this" | Throw `UNSUPPORTED` (1005 → exit code 4, explicitly unsupported). `doctor`'s failure code changed for the same reason to `TOOL_OUTDATED` (2002 → exit code 5; the only way doctor fails is an old Node). The same defect in `apponwin doctor` was fixed too |
| Contract lacks an exit-code declaration for segment `3000` (runtime) | `M2W_3001/3002/3003` map to exit code 5 in code while contract `exit 5` only declares `2001/2002` | The contract file lags behind the implementation: all three directions reserve runtime codes and mac2win genuinely uses them (Electron/NW.js download and architecture checks), but nobody came back to update the contract | The contract was **not** changed this round (changing it alters an external promise and needs human sign-off); tracked in 15.9 |
| launcher never receives SIGTERM, `kill -9` is the only way out | Closing an ExeOnMac bundle leaves the process running: 90 seconds after SIGTERM it was still alive and `launcher.log` did not even contain "signal received" | `DispatchSource.makeSignalSource(queue: .main)`: handlers on the `.main` queue are dispatched by the **main run loop**, while `WineRunner.run` polls the child with `Thread.sleep(0.2)` and never runs a run loop. `signal(sig, SIG_IGN)` also swallowed the default disposition, so the signal neither fired the handler nor terminated the process. **Every test case therefore burned 60 seconds in a fallback timeout while staying green** | Signal sources moved to a dedicated serial queue (`DispatchQueue(label: "com.wexe.launcher.signal")`). Measured: exit **0.19 s** after SIGTERM, with "received signal 15" and "wine exit status=15" in the log; the case dropped from 63.3 s to 3.1 s. Two guards added: `test_phase0` statically asserts the queue is not `.main` (blocks a code-level regression), `test_phase3` asserts both "signal received is logged" and "exits within 20 s" (blocks a behaviour-level regression) |
| Packaging reports success on a half-broken prefix | After deleting `system.reg` / `user.reg` / `userdef.reg`, or emptying `system32`, or replacing `dosdevices/c:` with a regular file, `wepack package` still returns `EXIT=0`, `ok=true` and 10/10 green; the same prefix handed to wine dies with `could not load kernel32.dll, status c0000135` (rc=53) | Item 7 of the packaging verifier only asserted that `Private/drive_c` **is a directory**. The install side has always judged prefix usability with `prefix.validate_prefix()` (five conditions); the packaging side wrote a second, looser predicate — one business rule with two implementations, and the loose one sat on the last gate (§5.3 red line). The test fixture also only created `drive_c/App/`, so its own prefix could not boot; both sides loose kept it green forever | Item 7 now calls `prefix.validate_prefix()`; the check was renamed `prefix.drive_c` → `prefix.valid` and names every missing item. 7 regression locks added (5 predicate + 2 stdout contract); injecting the old predicate turns 5 red. The "healthy prefix must pass" case guards against over-correction. The fixture now meets `validate_prefix`'s minimum (non-empty system32, relative-symlink `dosdevices/c:`, three non-empty `.reg`) |
| `package --json` emits two JSON documents on failure | `wepack package <bad app> --json` writes "full payload + main's error document" to stdout; `json.load` throws `Extra data: line 79` and piping to `jq` fails outright | `cmd_package` always `_emit(payload)` before `raise VerifyFailed`. Same cause as the `build --json` two-document defect fixed in W-02, but inside a single subcommand instead of between parent and child | Now checks `report.ok` first: on failure only `main()` emits one error document (with `message` and `exit_code`); detailed checks go to stderr and `--report`. `raw_decode` measured 2 documents before, 1 after; 2 regression locks, red when the old order is injected |
| A test module compiles an installer at import, and a whole class vanishes silently | Running one test class (`python3 -m unittest tests.test_phase2.TestCliPhase2`) gives `FAILED (errors=2)` and `RuntimeError: ISCC 编译失败（退出码 0）：` with an **empty** detail; a full `discover` run in alphabetical order stayed green | `test_phase1.py` evaluates `REAL_INNO = str(fixtures.demo_inno_real() or "")` at **module top level**, so importing compiles an installer; `test_phase2` imports `tests.test_phase1` merely to borrow two pure byte builders, and its `setUp` has already pointed `WEXE_HOME` at a temp dir containing a fake wine that only does `exit 0` → ISCC is "run" by the fake wine, compiles nothing, exits cleanly | The four sample constants became lazy functions (cached per process) and the four classes use `setUpClass` + `require_sample()`, raising `SkipTest` when unavailable. Decorators evaluate at import time; `setUpClass` only when the test really runs — that is the dividing line. The "exit 0 but no artifact" message is now separate from "compilation failed", so the failure states which kind it is. Two guards added (subprocess sentinel + `ast` scan of the module body); negative check: inject the constant back → both turn red |
| Font substitution never worked, not once | Log reads "fontsub 已导入 2 条替换" while the registry holds not a single key; Chinese text renders as tofu. `regedit /S` reports **exit code 0 with empty stderr**, so nothing looks wrong | `fontsub.reg` used wine's **internal** format (`WINE REGISTRY Version 2` plus double-backslash keys). Measured on the same content: internal format writes zero keys, export format writes both. Same root cause as `install.suppress_restart` fixed in round 7 (export format mistaken for storage format) — that round only changed the Python side, and this Swift copy was never covered by the same check | Rewritten in export format (`Windows Registry Editor Version 5.00` with a fully qualified root and single backslashes); success is no longer inferred from the exit code but from a **UUID stamp written into the same `.reg`** and queried back. 5 static guards added, four negative verifications all effective. **Note: that round used the `HKEY_CURRENT_USER` root, which round 12 proved ineffective — see 15.24**. Details in 15.23 |
| Long paths break mid-word | No overflow, all tests green, yet a 139-character path is split into 4–5 lines at 375px with breaks landing inside words (`Framewo\|rks`, `dir\|ectory`); **15** occurrences across three viewports (criterion: both sides of the break belong to `[A-Za-z0-9._]`) | `overflow-wrap: anywhere` fixed the overflow but only looks for breaks **between arbitrary characters**, never using the natural `/` `\` `-` boundaries; `.result-val` additionally carried `word-break: break-all`, which **ignores** `<wbr>` | New pure function `pathSegments()` slices on separators, `app.js`'s `writeText()` appends `Text` per slice and inserts `<wbr>` after each separator, and `el()` routes everything through it; `.result-val`'s `break-all` became `overflow-wrap: anywhere`. Zero occurrences after the fix. The stress injector now `import('./app.js')` and calls the product function — otherwise it measures itself |
| A registry file that merely "exists and is non-empty" is judged healthy | Replacing `system.reg` with 35 bytes of plain text leaves `validate_prefix` returning `[]` and packaging verification at 10/10 green; the same prefix handed to wine produces `system.reg is not a valid registry file` plus "32-bit installation", `rc=1`. A broken `user.reg` is subtler: `reg add` returns 0 but the key never lands | The check only looked at `is_file()` and `st_size > 0`, never at content. The test fixture wrote the same broken format (UTF-16LE + BOM, no `#arch`), so **the fixture could not produce a prefix that even boots** — check and fixture were loose together, which is why the defect stayed green forever | Added `_check_reg_file()`: the first line must be `WINE REGISTRY Version 2` (all three files), and `system.reg` must also carry `#arch=win64`. The three files were measured to have different fatality levels; `user.reg` / `userdef.reg` are deliberately not required to carry arch (that would be a false positive). Both fixtures fixed, constants imported from `wepack.prefix` |
| The placeholder registry is written in a format wine rejects | `prefix._write_placeholder_regs` produced a placeholder that made wine report `not a valid registry file` plus "32-bit installation", `rc=1` — yet the whole point of the placeholder is to let wine boot | It claimed "wine's .reg is UTF-16LE + BOM", which is only true for files **exported** by `regedit /E`; the on-disk format inside a prefix is plain ASCII and must carry `#arch=win64` | Switched to plain ASCII plus `#arch=win64`. Measured `rc=0`, after which wine expands the placeholder itself into a complete 200 KB registry |
| The restart-suppression `.reg` never took effect | `suppress_restart` logged `reboot.suppressed` while writing zero keys; `reg query` after import finds no `NoClose` | It fed wine's **internal** storage format (`WINE REGISTRY Version 2` with relative `[Software\\...]` paths) to `regedit /S`, which only accepts the **Windows export** format. Measured: wrong format yields **exit code 0, empty stderr, zero writes** — it took a three-way comparison to pin down | Switched to `Windows Registry Editor Version 5.00` with absolute key paths; the import is now followed by a query of the target key, logging `WARN reboot.suppress_ineffective` instead of INFO when it is absent. `regedit /S` fails silently, so "no exception thrown" proves nothing |
| The contract-check button sets `disabled` inside its click handler, so a keyboard Enter drops focus instantly | Clicking with a mouse works fine; pressing Enter on a keyboard sends focus to `<body>`, a screen reader restarts from the top, reaching the panel's "close" button takes 12 more Tabs, and closing the panel drops focus to `body` again. The first three viewport stages stay fully green | `Enter` is keydown → click → keyup. Setting `disabled` inside click makes the element stop being a focus target, so the browser returns focus to the document root and the trailing keyup has no receiver. A programmatic `.click()` has no trailing keyup, so the defect never reproduced and every existing test was green | Re-entry is guarded by a boolean plus `aria-disabled` (semantics only, focusability intact); the panel gains `tabindex="-1"` and gets `panel.focus()` after the check completes; closing hands focus back to the trigger. The criterion became stage 5 of `viewport-check.mjs`, using real key events plus a full `focusin`/`focusout` trace |

| A criterion at module level: concluded at import, skip becomes permanent | `test_phase2` / `test_phase3` had `SAMPLE_NSIS = ... demo_nsis()` at module level, so **importing either module ran `makensis`**; measured with a sentinel fake `makensis`, the marker appeared and the failure was exactly `makensis 编译失败（退出码 0）：`. The two `@skipUnless(fixtures.wine_available())` decorators in `test_phase7_layers` were fixed at import time: importing under `WEXE_HOME=/nonexistent` left `__unittest_skip__` permanently `True` | Same shape as 15.20 but with three entrances: ① the same `SAMPLE_NSIS` written three times (a 5.3 violation); ② `REAL_WINE = fixtures.wine_available()` looks side-effect free but pins the conclusion at import; ③ decorator arguments are also evaluated at import and live in `decorator_list`, invisible to a module-body scan | The criterion moved into `fixtures` (`sample_*()` / `require_sample()` / `wine_ready()`); `test_phase1` now re-exports it, the other three files drop their module-level constants for `setUpClass`; cache keys include the current environment value. The guard widened from one module to all 6 files, now scanning `decorator_list` and asserting its own scan scope (so an empty glob cannot pass green). Negative verification: re-inject module-level evaluation → 2 static findings + sentinel → 2 red; restore the decorator → 1 red |
| The launcher cannot be closed inside its startup window: the signal is "received" but nobody executes it | Sending SIGTERM after `runtime ready` and before `wine 已启动` (fixed delays 0.8 / 1.0 / 1.2 s, twice each, **6/6 reproduced**): the log says "收到信号 15，正在停止 wine", then `fontsub 已导入` and `wine 已启动` appear as usual, and 25 seconds later the process is still alive — SIGKILL is the only way out. The log itself is complete and error-free | ① `signal(sig, SIG_IGN)` already removed the default disposition; ② the handler body is `current?.terminate()`; ③ `current` is only registered by the main program, while the `wine regedit /S` inside `FontSubstitution.apply` (measured ~3 s) creates its own `Process` and calls `waitUntilExit()` — **never registered** → no-op. The first fix ("record `pending`") still failed: the main thread is blocked inside `waitUntilExit()` and never reaches any checkpoint | Added `WineRunner.runChild` as the only `Process()` in the file; `current` now means "the current wine child" instead of "the main program", and apply's regedit goes through it too; the handler only calls `noteSignal(sig)` (record, then deliver) and no longer branches on nil. `runChild` returns an `Outcome` enum separating `.stoppedBySignal` from `.finished(15)`, so "interrupted" is not mistaken for "import failed" and the main program is not started afterwards. Exit codes fixed too: SIGINT/2, SIGTERM/15, SIGHUP/1 are now distinct (all were 15 before). 5 regression locks (fake wine widens the window); two injections, 3 red each |

| Font substitution written into a registry root nobody reads | After 15.23 fixed the format, the keys really land, the stamp is queryable and the log reads "fontsub 已导入 2 条替换" — yet with `lfFaceName` set to `Microsoft YaHei`, `WINEDEBUG=+font` shows **no such mapping** in `dump_gdi_font_subst`, `substituting` fires **0 times**, and `select_font` picks `Courier New`. The text stays tofu | The launcher writes `HKCU\...\FontSubstitutes`. Scanning `win32u.so` for UTF-16 strings yields only `\Registry\Machine\...\FontSubstitutes`, with no `\Registry\User\` counterpart — **the HKCU copy is valid registry data that no code reads**. This is a second, independent defect from 15.23: that one made the data land, this one makes it be read | Root key changed to `HKEY_LOCAL_MACHINE` (measured: `substituting` fires, `select_font` picks `PingFang SC Regular`); the stamp moved to HKLM as well (otherwise "stamp found" only proves the write landed, not that it is in the tree GDI reads — the criterion degrades back to testing existence). Three-way comparison settles it (HKCU ineffective / HKLM effective / `Wine\Fonts\Replacements` effective but rejected as alias semantics). Guards 6 → 7; the old one asserted HKCU — **baking the wrong conclusion into the assertion** — and went red the moment the code changed. Details in 15.24 |
| Both keys written, yet DirectWrite software is still tofu | After 15.24 fixed GDI, setting `lfFaceName` to `Microsoft YaHei` shows `select_font` picking `PingFang SC Regular` and `substituting` firing; but a DirectWrite program on the same prefix with the same fonts still renders Chinese as tofu, with not a single `+font` line | `FontSubstitutes` is GDI-only: scanning every ELF/PE under `lib/wine` for both UTF-16 and ASCII, the literal appears once, in `x86_64-unix/win32u.so`, and not at all in `x86_64-windows/dwrite.dll`; the latter reads only `HKCU\Software\Wine\Fonts\Replacements` (single-byte ANSI), and in the disassembly at `0x18000b8a5` the string is loaded before `RegOpenKeyA` is called with root `0x80000001`, i.e. HKEY_CURRENT_USER | Write both keys into the same .reg (the roots are exact opposites: GDI wants HKLM, DirectWrite wants HKCU); the stamp moves to `HKCU\Software\Wine\ExeOnMac`, sharing `replacePath`'s root. Six PE-probe groups settle it: HKLM only → `familyCount` 292 and `Microsoft YaHei` not found; HKCU only → 293 and found; both → still 293; HKLM with `Wine\Fonts\Replacements` → 292 — the root matters more than the key name. Guards 7 → 10 (2 scan the real binaries in both encodings, 1 asserts both keys land in one file); the end-to-end assertion now runs `wineserver -k` after SIGTERM before reading from disk (`-w` does not write back — measured 0 hits). Details in 15.25 |

### 15.8 Cross-Platform Runnability Audit (2026-11-19)

This section answers a question only an inventory can answer: **have the branches that only execute on Windows ever actually run?**

This machine is darwin + arm64. All three directions target Windows, so their platform branches have long been in a "written down, never executed" state. Green tests do not mean those branches are correct—on the contrary, **a branch that has never run can also fail silently**.

**Method**: mechanical extraction, not eyeballing. Five regular expressions for platform checks (`process.platform ===/!==`, `platform() ===/!==`, `sys.platform`, `platform.system()`, `platform.machine()`) were run over every `.mjs` / `.py` source, yielding 30 hits.

**Inventory and coverage**:

| Location | Branch | Previously tested | Action |
|---|---|---|---|
| `mac2win/src/core/preflight.mjs:88` | Not darwin → `host-platform` fails | Only the error-code mapping; the branch never ran | Platform and arch made injectable, 7 new tests |
| `win2mac/bin/win2mac.mjs:162` | Not win32 → warn or refuse with `--strict-host` | No | See the defect record below; `--strict-host`'s error code fixed |
| `win2mac/bin/win2mac.mjs:436` | Not darwin → skip probing `plutil` | No | Covered indirectly via `verifyBundle` injection |
| `win2mac/src/core/verify.mjs:125` | Not darwin → `plutilLint` returns unavailable | No | Platform injectable, 3 new tests |
| `win2mac/src/core/verify.mjs:332` | Emit a different "unverified" warning by platform | No | Same as above |
| `win2mac/src/core/wexezip.mjs:140/167` | Windows `stat().mode` is untrustworthy | **Yes** (5 tests, injected platform) | Already the correct pattern; untouched |
| `apponwin/src/core/spike.mjs:83` | Not win32 → WSL2 probe reports unavailable | **Yes** | Covered |
| `apponwin/bin/apponwin.mjs:99/511` | Not win32 → warn, do not block | **Yes** (real doctor run) | Covered |
| `console/src/directions.mjs:199` | No detach on Windows | No (affects a spawn option only) | Covered together with the next row |
| `console/src/directions.mjs:344` | Windows → `taskkill /t /f` | **No—and it is the only fallback for timeouts and cancellation** | Platform and spawn injectable, 5 new tests |
| `exeonmac/wepack/cli.py:1817` | Not arm64 → Rosetta not needed | **Yes** (doctor run asserts name and result) | Covered |
| `exeonmac/wepack/report.py:146` | Platform field normalisation | No (output field only) | No behavioural branch; not added |

**Why the two highest-priority branches matter**:

1. **`console`'s `taskkill`** — it is the **only** fallback for timeouts and cancellation. Get it wrong and the symptom is "the user cancels, the parent process reports cancelled, but wine keeps installing in the background"—while every test stays green, because the parent process really did exit cleanly.
2. **`mac2win`'s host check** — get it wrong and the symptom is "running on Linux reports 'project directory does not exist'"; the user chases path spelling, permissions and symlinks when the real answer is to use another machine.

**Three defects**, all found by measurement rather than inference:

1. `win2mac --strict-host` exits 2 with `W2M_1001`, while none of the contract's 13 exit codes declares 1001. Fix in 15.7.
2. `apponwin doctor` and `win2mac doctor` fail with the same class of code; fixed together.
3. `contracts/validate.mjs` **range parsing** splits `"4001-5002"` into two endpoints, so 4002 / 4003 / 5001 are judged out of range. This one is not a platform problem—it surfaced because this round used the contract validator to inspect reports.

**What still cannot be verified here** (stated plainly, not written up as verified):

- Real Windows-host behaviour: whether `taskkill` actually works, how process groups behave under `detach: false`, and the semantics of `wine` paths on Windows.
- WSL2 + Darling: needs a Windows machine; see 15.2.1.
- The non-arm64 `wepack` doctor branch: this machine runs the arm64 path; the Intel path is judged by code reading only (a straight passthrough) and was not measured.

Injected tests prove the **decision logic**, not the **platform behaviour**. The distinction matters: the five `killTree` tests prove "on win32 it calls `taskkill` with `/t`", not "`taskkill /t` really kills wine's whole process tree". The latter needs a Windows machine.

### 15.10 End-to-End Findings on the Tauri Rust Shell (2026-11-19)

This section answers one question: **on arm64 macOS, can `cargo xwin` actually turn a real Tauri v2 project into a native Windows window binary?**

The answer has three layers. Each has measurement behind it, and each has a clear boundary.

#### 15.10.1 Summary

| Layer | Verdict | Evidence |
|---|---|---|
| The Rust cross-compile chain itself | **Holds.** Produces `PE32 / i386 / windows-GUI` | Bespoke probe `rsprobe`: 92160 bytes, `file` reports `PE32 executable (GUI) Intel 80386, for MS Windows` |
| Tauri's **whole dependency tree** compiled and linked | **Holds.** `tauri 2.12.7` + `wry 0.57.3` + `tao 0.37.3` + `webview2-com 0.39.1` all link into a PE | Probe `linkprobe`: 1096192 bytes, `PE32 executable (GUI) Intel 80386` |
| A **complete** Tauri project (with the `build.rs` resource section) | **Does not hold.** Blocked on `llvm-rc`, and `brew install llvm` does not fix it | `tauri-winres 0.3.7` panics: `NotAttempted("llvm-rc")` |

**So "arm64 macs cannot build Windows x86 binaries" is false** (the first two layers disprove it), but "a complete Tauri project compiles in one shot into a native window exe with icon and version info" **also does not hold today** (the third layer blocks it). Neither statement may be written as settled fact — their truth depends on which layer "build" refers to.

#### 15.10.2 Layers one and two: Rust and the whole Tauri dependency tree

The `linkprobe` probe deliberately **avoids** `generate_context!()` and has no `build.rs`, keeping resource compilation entirely out of the experiment. It tests one thing only: whether tauri's dependency tree compiles and links to a PE for `i686-pc-windows-msvc`:

```rust
#![windows_subsystem = "windows"]

fn main() {
    let builder: tauri::Builder<tauri::Wry> = tauri::Builder::default();
    std::hint::black_box(&builder);
}
```

Measured command and result:

```
CC_i686_pc_windows_msvc=clang-cl AR_i686_pc_windows_msvc=llvm-lib \
XWIN_ARCH=x86 XWIN_CACHE_DIR=<clean dir> \
cargo xwin build --target i686-pc-windows-msvc --release

→ Finished `release` profile [optimized] target(s) in 33.07s
→ linkprobe.exe  1096192 bytes
→ file: PE32 executable (GUI) Intel 80386, for MS Windows
```

#### 15.10.3 Layer three: the real blocker is `llvm-rc`, and it blocks twice

A complete project (`build.rs` + `tauri.conf.json` + `icons/icon.ico`) in the same environment:

```
thread 'main' panicked at tauri-winres-0.3.7/src/lib.rs:543:14:
called `Result::unwrap()` on an `Err` value: NotAttempted("llvm-rc")
```

The chain is `tauri-build` → `tauri-winres` → `embed-resource`. **First blocker**: `llvm-rc` ships with nothing you already have — Xcode's LLVM lacks it (`Toolchains/XcodeDefault.xctoolchain/usr/bin/` carries about ten tools such as `llvm-cov` / `llvm-nm` / `llvm-objdump`, none of them `llvm-rc`), and cargo-xwin only creates the `clang-cl` and `lld-link` shims.

**The second blocker is subtler**: `brew install llvm` does provide `llvm-rc` (it is listed in Homebrew's official Binaries list), yet installing it still changes nothing. The reason is how `embed-resource` identifies its compiler (`src/lib.rs:692`, `Compiler::llvm_rc`):

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

It **executes** `llvm-rc /?` and looks for the string `no-preprocess` in stdout. Pointing `RC` at a stub script that merely `exit 0`s yields:

```
NotAttempted("Unknown RC compiler variant: /tmp/w06/fake-rc.sh")
```

Being on the path is not enough; the reply has to match the expected shape. Putting a real `llvm-rc` on `PATH` works, but no wrapper that pretends to be one gets through this probe.

#### 15.10.4 Two real defects fixed along the way

Neither was introduced this round, and **neither reports an error**, which is why every test suite was green before.

**Defect A: `checkRustEnv` misjudged what `XWIN_ARCH` achieves.**

`XWIN_ARCH=x86` only tells cargo-xwin **what to download**; it does not guarantee **it was downloaded**. `setup_msvc_crt` in `cargo-xwin-0.23.1/src/compiler/clang_cl.rs` returns early:

```rust
let done_mark_file_content = fs::read_to_string(&done_mark_file);
if let Ok(content) = &done_mark_file_content {
    let mut lines = content.lines();
    if let Some(archs) = lines.next() { /* reads the first line only */ }
}
if !update && xwin_arches.difference(&downloaded_arches).next().is_none() {
    return Ok(());   // ← returns, never checking the files exist
}
```

The criterion is **the text on the first line of `DONE`**, not the files on disk. The actual mismatch on this machine:

| Fact | Value |
|---|---|
| `xwin/DONE` first line | `x86` (claims downloaded) |
| `xwin/crt/lib/` actually contains | only `x86_64` |
| `xwin/sdk/lib/um/` actually contains | `aarch64`, `x86_64` |

Consequence: `cargo xwin build --target i686-pc-windows-msvc` compiles 130+ crates and only at the **link** step emits ten `could not open 'user32.lib'` errors, and re-running the identical command reproduces them (because `DONE` says it is there). The same code with `XWIN_CACHE_DIR` pointed at a clean directory passes first time — that directory holds 63 and 482 files under `crt/lib/x86` and `sdk/lib/um/x86` respectively.

Fix: `checkRustEnv` gained an `x86-libs` item that inspects the **directories on disk** (`crt/lib/x86`, `sdk/lib/um/x86`) and honours `XWIN_CACHE_DIR`. The user is now told **before** compiling, rather than a dozen minutes in.

**Defect B: `buildRustShell` called `cargo xwin` without `TAURI_ENV_TARGET_TRIPLE`.**

`tauri`'s `generate_context!()` expands **on the host**, and `tauri-codegen-2.7.6/src/context.rs:148` reads `TAURI_ENV_TARGET_TRIPLE`, not `TARGET`. Without it the macro decides it is on macOS and emits `tauri::embed_plist::...` — but `embed_plist` in `tauri-2.12.7/src/lib.rs:75` is gated by `#[cfg(target_os = "macos")]`, so cross-compiling to Windows fails with:

```
error[E0433]: cannot find `embed_plist` in `tauri`
```

Measured comparison (same project, same cache):

| `TAURI_ENV_TARGET_TRIPLE` | Result |
|---|---|
| unset | `error[E0433]`, `generate_context!()` expansion fails |
| set to `i686-pc-windows-msvc` | Compiles (and only then reaches the `llvm-rc` gate) |

Fix: `buildRustShell` now passes `TAURI_ENV_TARGET_TRIPLE` explicitly, derived from the target triple constant rather than hard-coded.

#### 15.10.5 On "skipping `tauri_build` still produces an exe"

One tempting trick showed up during measurement: have `build.rs` skip `tauri_build` when `llvm-rc` is unavailable. Compilation then "succeeds" and an `.exe` really is produced.

**That is a false success.** The section table of that exe:

```
sections: [('.text', 5069064), ('.rdata', 989732), ('.data', 6888),
           ('.tls', 273), ('.reloc', 151920)]
has .rsrc: False
```

No `.rsrc` section means **no icon, no version info, no application manifest**. On Windows such a binary is treated by SmartScreen as unsigned/unknown, has no version tab in its properties, and shows a blank taskbar icon. It launches, but it is not a shippable Windows program.

Therefore this section states plainly: **skipping `tauri_build` is not an acceptable fallback for the Tauri shell.** Either supply `llvm-rc`, or fail honestly and fall back to the "package the Node/frontend layer" route — that route's output is complete, and the baseline tests in chapter 12 guard it.

#### 15.10.6 Still unverified

- **A full build with a real `llvm-rc` installed.** Not installed here (`brew install llvm` downloads a 457 MB bottle and occupies 1.9 GB; modifying the user's toolchain is not something a scheduled task does on its own). So "layer three holds" **cannot** be written this round.
- **Running the output**: the produced PE has never been launched on Windows. Whether the window appears and whether WebView2 loads are both unverified.
- **The `.ico` format requirement**: `tauri-build` requires `icons/icon.ico` to exist or it errors out. This round's project used `icon: []`, so a real `.ico` was never exercised.


### 15.9 Pending Human Sign-Off: the Contract Needs a `3000` Segment

**Problem**: `contracts/exit-codes.json` gives `exit 5` only `errorSegment: "2001/2002"`, yet all three directions' `exitCodeFor` map `3xxx` to exit code 5, and mac2win genuinely uses them:

| Code | Purpose | Call sites |
|---|---|---|
| `M2W_3001` | Runtime download failed | `electron.mjs:97/123`, `nwjs.mjs:89/115` |
| `M2W_3002` | Runtime checksum mismatch | Runtime cache verification |
| `M2W_3003` | Wrong runtime architecture | `runtime.mjs:315/323/331`, `electron.mjs:66` |

**Why not change it this round**: `exit-codes.json` is an **external promise** (its first line reads "released code values never change, only append"). Adding a segment declaration tells every caller "exit code 5 may also come from a runtime problem"—that is an expansion of the behavioural contract, not a bug fix. By this repository's rules, such a change is listed and waits for human approval.

**Two candidate options** (for decision, not executed this round):

| Option | Change | Cost |
|---|---|---|
| A. Extend the contract | Set `exit 5`'s `errorSegment` to `"2001/2002/3001-3003"` | Exit code 5 widens from "missing external tool" to "something is missing (runtime included)". Semantically defensible—all three mean "the environment lacks something"—but a downstream that special-cases 2001 as "just install a tool" would miss the runtime class |
| B. Change the implementation | Re-map the three `3xxx` codes to `2001` / `5002` | No contract change, but **the runtime layer disappears**. Seeing 2001, the user runs `brew install`, when the real cause is a blocked download or a corrupt cache—a completely different remedy |

**Preference: A.** The segment table already defines `3000` ("Runtime: download failure, checksum mismatch, wrong architecture"); only the exit-code line is missing the reference. B would turn a defined segment into dead code.

**The one question needing sign-off**: whether `exit 5` should accept `3001-3003`. Once confirmed, the change is one line in `contracts/exit-codes.json` plus one test case in `validate.test.mjs`.

### 15.11 Code Signing and Notarization Assessment (2026-11-19, Not Executed)

This section answers "should we sign, can we sign, what does it cost". It contains **no signing implementation**—without a certificate there is nothing testable, and code that cannot be tested should not be written.

#### 15.11.1 First, Retract an Old Claim

The README previously stated in four places that "signing cannot be done on macOS" (13.6, 14.4, 15.1, roadmap item 7). **That is only half true and has to be split**:

| Claim | Measured | Verdict |
|---|---|---|
| `codesign` / `notarytool` / `stapler` / `spctl` exist on macOS | All four present: `codesign` in `/usr/bin`, `notarytool 1.1.4 (43)` and `stapler` inside Xcode, `spctl --status` → `assessments enabled` | ✅ Fact |
| Authenticode signing of Windows exe must happen on Windows | `osslsigncode` has a Homebrew bottle (`stable 2.16`, depends on `openssl@4`), builds and runs on macOS per upstream README, and supports PKCS#11 hardware tokens and cloud PKCS#11 modules | ❌ **False** |
| Notarization of macOS artefacts must happen on macOS | `notarytool` is macOS/Xcode-only | ✅ True |

**The real obstacle is not the tooling, it is the certificate.** Since 2023-06-01 the CA/Browser Forum plus Microsoft and Apple require OV/EV code-signing private keys to live on FIPS 140-2 Level 2+ certified hardware and be non-exportable (sources: fairssl.com/en/code-signing-hsm-key-storage, sslmarket.com). That requirement is OS-independent—**buying a Windows machine would not remove it**. "Impossible on macOS" is a misdiagnosis that sends people shopping for a Windows box they do not need.

#### 15.11.2 Measured Here: Current Artefacts Carry an Inconsistent Signature

This is the only part verifiable without a certificate. The method was to replicate `wepack`'s real assembly structure and run four checks.

**Toolchain facts**: `security find-identity -v -p codesigning` → `0 valid identities found`. Xcode is at `/Applications/Xcode.app`, `xcode-select -p` resolves. In short: **tools complete, certificate absent**.

**Controlled experiment** (identical Mach-O, two signature states):

| Object | `codesign -v` | `spctl -a -t exec` | `--verify --deep --strict` |
|---|---|---|---|
| **A: status quo (binary dropped into bundle, not re-signed)** | **exit 1**<br>`code has no resources but signature indicates they must be present` | **exit 1**<br>same message | **exit 1** |
| **B: whole bundle consistently re-signed (ad-hoc)** | exit 0 | exit 3<br>`rejected` (not notarized, expected) | exit 0 |

**Why A happens**: `clang` / `swiftc` output for arm64 carries a **linker-applied ad-hoc signature** (`flags=0x20002(adhoc,linker-signed)`, `Signature=adhoc`). That signature covers only that one executable. `wepack` then assembles `Info.plist`, `PkgInfo` and `Resources/` into the bundle **without signing again**, so the signature claims a resource seal that does not exist.

**This is not theoretical.** The replicated artefact (a real 137464-byte compiled `launcher` plus Info.plist) fails `codesign -v` with exit 1. A user dragging it into `/Applications` sees a validation failure in System Settings, not the at-least-explicable "not notarized".

**Reproduction** (compiling the repository's real launcher source, assembled the way `wepack` does it):

```bash
cd exeonmac && python3 -c "
from pathlib import Path
from wepack.package.launcher_build import compile_launcher
print(compile_launcher(Path('/tmp/r/launcher'), use_cache=False))"
mkdir -p /tmp/r/R.app/Contents/MacOS && cp /tmp/r/launcher /tmp/r/R.app/Contents/MacOS/
/usr/libexec/PlistBuddy -c "Add :CFBundleExecutable string launcher" \
  -c "Add :CFBundleIdentifier string com.wacmin.repro" \
  -c "Add :CFBundlePackageType string APPL" /tmp/r/R.app/Contents/Info.plist
codesign -v /tmp/r/R.app ; echo "exit=$?"    # → exit=1, code has no resources…
codesign -s - --force /tmp/r/R.app
codesign -v /tmp/r/R.app ; echo "exit=$?"    # → exit=0
```

All three commands were run this round; output matches the table above.

#### 15.11.3 But It Cannot Be Fixed: the Resource Seal Conflicts with WINEPREFIX

Fixing A looks simple—re-sign every inner executable from the inside out, then the outer bundle. **This round measured that fix and it works** (`codesign -v` goes 1 → 0, `--strict` also 0). On ExeOnMac, however, it hits a wall:

`launcher/Sources/main.swift:234` sets `env["WINEPREFIX"] = layout.privateDir.path`, and `privateDir` points at `Contents/Resources/Private` (`:66` of the same file). **Wine's entire prefix lives inside the bundle's `Resources/` and is read and written in place.**

`codesign` seals every file under `Contents/Resources`. One wine write breaks the seal:

```
after signing   → codesign -v exit=0
prefix written  → S.app: a sealed resource is missing or invalid   exit=1
```

**Control**: move `Private/` outside the bundle, re-sign, then write the prefix → `codesign -v` stays exit 0.

**Decisive conclusion**: ExeOnMac either ships unsigned, or the prefix must move out of the bundle. The latter is a breaking architectural change touching layering, `clonefile` prefix cloning, uninstall cleanup and `recipe` path conventions—not something an assessment round does. **This is the most important takeaway**: signing is not "add a command"; it constrains directory layout.

Scope note: this conflict is ExeOnMac-only. Mac2Win produces a `.exe` (single-file Authenticode, no resource-seal concept); Win2Mac produces a static directory tree with no in-place runtime state.

#### 15.11.4 Per-Direction Verdict

| Direction | Artefact | Signing path | Feasible | Blocker |
|---|---|---|---|---|
| Mac2Win | `.exe` / `.zip` | `osslsigncode` + PKCS#11 token, or `signtool` on a `windows-latest` CI runner | **Yes** | Certificate only, no technical obstacle |
| Win2Mac | `.app` (static) | `codesign` → `notarytool submit` → `stapler staple` | **Yes** | Needs an Apple Developer ID ($99/yr) |
| ExeOnMac | `.app` (writable prefix) | Same as above | **Not with the current layout** | See 15.11.3; layout must change first |
| AppOnWin | none | — | N/A | The direction itself concluded "environment unavailable" |

**Win2Mac notarization prerequisites** (sources: Apple notarization requirements and third-party measured reports): every executable inside the bundle must carry a Developer ID signature, hardened runtime must be on, a secure timestamp must be present, and `com.apple.security.get-task-allow` must be absent. Miss one and it is rejected.

#### 15.11.5 Cost (retrieved 2026-11-19, not a quote)

| Option | Cost | Availability for an individual developer in mainland China |
|---|---|---|
| Apple Developer Program | **$99/yr** (source: Apple's official enroll page) | Available with an individual identity |
| Windows OV certificate | **$150–300/yr**, SafeNet USB token included | Available (source: Microsoft Learn code-signing options) |
| Windows EV certificate | **$400+/yr** | Available, but **no longer bypasses SmartScreen**—Microsoft levelled EV and OV behaviour in 2024 |
| Azure Artifact Signing (ex Trusted Signing) | **$9.99/month** | **Individuals limited to the US and Canada**; mainland China individuals ineligible (same Microsoft page, geographic limitation) |
| Self-signed certificate | Free | Local testing only; blocked for public distribution |

**One common misconception to correct**: signing does **not** guarantee a clean first download. Microsoft's own page states new signed files still warn until enough reputation accrues, identically for OV and EV. The real benefit is a verifiable publisher identity, a milder warning, and reputation inherited across releases—not a warning-free download.

**An honest cost caveat**: Windows tokens are USB hardware and **standard RDP cannot forward them** (documented by CAs; TeamViewer-class tools work). If the signing machine is a cloud Windows box this changes the operating model; Azure Key Vault or DigiCert KeyLocker avoid it, but KeyLocker is roughly $300/yr capped at 1000 signatures.

#### 15.11.6 CI Feasibility

The repository's `.github/workflows/ci.yml` already uses `ubuntu-latest`, `macos-latest` and `windows-latest` (7 `runs-on` entries measured). Therefore:

- Windows signing: `signtool` ships with the Windows SDK on `windows-latest`, nothing to install. Credentials via GitHub Secrets (base64 pfx or cloud-HSM credentials).
- macOS signing and notarization: `codesign` / `notarytool` ship with `macos-latest`. Apple credentials via `notarytool store-credentials` plus Secrets.
- **But this belongs to a release pipeline, not a test pipeline.** CI currently only runs tests and contract checks, with no push or publish step; adding signing also adds publishing authority, which is an external-facing behaviour change.

#### 15.11.7 What This Round Does Not Do (Explicit)

1. **No signing code.** Without a certificate it cannot be verified; untestable code contradicts this repository's rule against writing unverified results as passing.
2. **No change to ExeOnMac's prefix layout.** A breaking architectural change requiring a human decision and separate scheduling.
3. **No change to `exit-codes.json`.** Which exit code signing failure should map to is a new external promise, same class as 15.9, awaiting sign-off.
4. **No certificate purchase, no CI secrets.** Both involve money and external accounts.

#### 15.11.8 Suggested Decision Path (for a human to choose)

| Priority | Action | Rationale |
|---|---|---|
| 1 | Fix the inconsistent signature in 15.11.2—either **ship explicitly unsigned artefacts, or re-sign the whole bundle** | Needs no certificate. The former costs nothing; the latter needs one `codesign -s -` at the end of assembly (local ad-hoc does not satisfy Gatekeeper, but at least `codesign -v` becomes self-consistent). **The choice must be made first, because "inconsistent" is worse than "explicitly unsigned"**: it shows the user "corrupt" instead of "unsigned" |
| 2 | To actually distribute macOS artefacts: buy the $99 Apple membership **and** decide whether ExeOnMac's prefix moves out of the bundle | The two are coupled; half-measures do not work |
| 3 | Windows signing: scale to release volume. Below ~10 releases a year, an OV certificate plus `osslsigncode` (signable locally on macOS) is less work than standing up Windows CI | The technical path is verified |

---

### 15.12 The viewport-check script's silent hang (fixed 2026-11-19)

**Symptom**: `node console/scripts/viewport-check.mjs` would not run on this machine—not by erroring, but by **never returning**. It neither printed the table nor exited, hanging for six minutes or more until killed by hand. This class of failure is far harder to diagnose than an error: an error points at a location, a hang leaves a blank.

**Layer-by-layer isolation (every layer measured, none guessed)**:

| Layer | Measured result |
|---|---|
| Local server | Fine, `fetch` returns 200 / 2470 bytes |
| Chrome process | Starts, `DevToolsActivePort` written normally |
| WebSocket | Opens |
| `Target.createTarget` | Returns in 49 ms |
| `Target.attachToTarget` | Returns in 15 ms |
| `Page.enable` | **Never replies** |

The root cause is that Chrome **fails to create its own sandbox** in this sandboxed environment (`sandbox initialization failed: Operation not permitted`), so the renderer never comes up and every page-level command goes unanswered. Adding `--no-sandbox` made `Page.enable` / `Runtime.enable` / `evaluate 1+1=2` pass immediately.

**The real defect in the code was not the missing `--no-sandbox`, it was that `CdpClient.send()` had no timeout**:

```js
// Before: the Promise never settles; neither timeout nor error branch exists
send(method, params = {}, sessionId) {
  return new Promise((resolve_, reject) => {
    this.pending.set(id, { resolve: resolve_, reject })
    this.socket.send(JSON.stringify(frame))
  })
}
```

`once()` had a 15-second timeout and `send()` had none—an asymmetry that left the most-used path as the only one that could hang. Two layers of fix:

1. **`send()` carries a 20-second timeout**; on expiry it calls `pending.delete(id)`, tags the error with `cdpTimeout = true`, and clears the timer so the process is not held open.
2. **Retry once with `--no-sandbox` only when `cdpTimeout` appears.** Not an unconditional retry: a missing Chrome, an unstarted server, or a page-script exception have nothing to do with sandboxing, and retrying would repeat the same failure while masking the real cause. The fallback is reported through `fallbackReason` in both the human-readable output and `--json`, so nobody mistakes it for default behaviour.

**Measured after the fix**: the same command on the same machine went from "hangs for over six minutes" to **finishing in 26 seconds**, with 375 / 768 / 1440 all showing 0 overflow offenders and 0 px page overflow in both baseline and stress runs, exit code 0, plus an explicit line: "first launch with default flags timed out on Page.enable; re-ran once with --no-sandbox".

**Regression locks**: four new cases in `console/test/viewport-check.test.mjs` (10 total) guard "a timeout exists", "fall back only on cdpTimeout", "`--no-sandbox` is not in the base argument list", and "the fallback must be visible". Each of three negative checks turns the suite red: dropping the `timeoutMs` default → 1 red; making `sandboxSuspected` always `true` → 1 red; writing `--no-sandbox` into the base argument array → 1 red. All restored to 10/10 green.

**Why this one is worth remembering**: it had been there since W-01 and `npm test` stayed green throughout—because the viewport script is **not** part of `npm test` (it launches real Chrome, too slow). It became a script nobody runs and nobody knows about. The W-07 task found it but did not fix it (that round's scope was signature evaluation). **Any script outside the test suite needs a guard proving it actually finishes**, otherwise a green suite is vouching for something it never ran.

### 15.13 Delivery check on a clean clone (measured 2026-11-20)

Method: `git clone` the repository into a brand-new directory under `/tmp` and run section 18.2 **there**, borrowing nothing from the original working tree. This is the only way to catch "everything works locally, nothing works for anyone else"—the working tree holds caches and compiled artefacts that `.gitignore` hides, and their presence makes missing files look present.

**Result: the first pass failed, and not because of the code.** Details below.

**① An entire batch of work existed only in the working tree and had never been committed.** The W-01 to W-08 changes were uncommitted, so a clone produced a snapshot nine rounds old:

| | Working tree | The clone then |
|---|---|---|
| Files | 186 | 167 |
| mac2win / win2mac / apponwin | 167 / 130 / 96 | 132 / 121 / 91 |
| console | 230 | 215 |
| contracts | 79 | 58 (with 1 **red**) |
| exeonmac | 453 | 422 |

(This is a **historical snapshot**: it records the numbers at the time and is not kept in sync with the code; current values live in 12.1. Both `contracts` figures, 79 and 58, are old — after the Appendix C guard landed on 2026-11-20 it is 111. `doc-counts.mjs` reads only the 12.1 section and never this table.)

That one red was the hard-coded `total 1150` in `contracts/doc-counts.test.mjs` disagreeing with the actual 1165—a defect fixed in W-01, but the fix never landed, so the old snapshot brought it back. **"Green on my machine" and "shippable" are separated by a `git commit`.** That is the lesson of this round.

**② The section 18.2 block could not be run verbatim.** The old form was:

```bash
cd mac2win  && npm test
cd exeonmac && python3 -m unittest discover -s tests
```

After the first `cd` the working directory is already inside `mac2win/`, so the second line resolves `exeonmac` against `mac2win/exeonmac`, fails with `No such file or directory`, and the whole block exits 1. In other words, "follow the README exactly" did not work. Each line is now wrapped in a subshell (`(cd mac2win && npm test)`) which returns to the repository root; after the change the block was run verbatim and all six suites plus both contract commands passed.

**③ Appendix B.2's checklist had two closed claims that disagreed with reality.** Item 3 said "only `README.md` and `README_EN.md`" while the index holds five Markdown files; item 4 said "only `LICENSE` and `NOTICE`" while there are three licence files (including `LICENSE-MIT`). The three extra Markdown files are `LICENSING.md`, `ai/experts/wacmin-expert.md` and `ai/skills/wacmin/SKILL.md`—**product content, not documentation clutter**. Anyone following the old checklist would delete them as "documents that should not be committed". The items now name the files and their purpose.

**④ What passed (measured individually, all reproducible)**:

| Check | Command | Result |
|---|---|---|
| Junk files | `find . -name '.DS_Store' -o -name '._*' -o -name '__MACOSX'` | **0** in both the working tree and the clone |
| Junk in index | `git ls-files \| grep -E '\.DS_Store$\|/\._\|__MACOSX/'` | no output |
| Large files | `git ls-files` then `stat` each, 5 MB threshold | largest is 311725 bytes (`README_EN.md`); none over |
| Clone stays clean | full test run, then `git status --porcelain` | **0 entries** — tests do not dirty the tree |
| `.gitignore` coverage | `git check-ignore` against 12 real artefact paths | all covered (`dist-*/`, `*.app`, `node_modules/`, `.staging-*/`, `runtime/wine/`, `layers/*/root/`, `__pycache__/`, `*.log`, `.workbuddy/`) |
| Three viewports | `node console/scripts/viewport-check.mjs` | 375 / 768 / 1440, baseline and stress, 0 offenders, exit 0 |

**⑤ One phenomenon that must be told apart from a product defect.** Running the 18.2 block end to end, the final `console ... contract` reported `9 / 10` twice; the missing one was `exeonmac doctor` — "no parseable JSON report (exit code 1)". Yet running that same command alone was a stable `10 / 10` (five consecutive runs), and `wepack doctor --report` alone exited 0 twelve times in a row. Only stderr revealed the cause:

```
[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":10,"threshold":10,
 "targets":["/Users/.../Application Support/wexe/.doctor-probe"]}
```

The **execution environment's delete guard** blocked doctor's probe-file cleanup once the turn's cumulative deletes reached ten. It is not a `wepack` defect—writing and deleting the same path manually worked fine. **The test for "environment interception masquerading as a product defect" is whether the command alone reproduces it**: twelve green alone, two red end to end, with the only difference being the surrounding environment. This is recorded here so a later round does not go and "fix" `wepack`.

### 15.14 The launcher's signal handling: a "tests green, product broken" case (measured 2026-11-20)

**This section records a defect where every test passed, the logs looked healthy, and the artefact could not actually be closed.** It was found by entering the optimisation loop through the *performance* dimension: `exeonmac`'s 454 tests take over two minutes, so the duration distribution was measured first. The slowest was `test_launcher_starts_wine` at **63.3 s** when run alone, of which only about 3 s was actual verification.

**① First separate "the product is slow" from "the test is waiting for nothing".** Roughly 60 of the 63 seconds came from the test's fallback timeout: `process.terminate()` followed by `wait(timeout=60)`, falling back to `kill()`. So the question became how long the gap was between `terminate` and `kill`, which points at the launcher itself. Reproduced with a probe (real base layer + real wine + the real launcher): `wine 已启动` appeared at 2.28 s, then **the process was still alive 90 seconds after SIGTERM** and needed SIGKILL. `launcher.log` contained **no** "signal received" line at all, so this was not "slow to exit" but "the handler never ran".

**② The root cause is a scheduling-model conflict, not a timeout setting.** Three pieces have to line up to be fatal:

| Piece | Behaviour |
|---|---|
| `signal(sig, SIG_IGN)` | Turns off SIGTERM's default disposition (immediate termination) |
| `DispatchSource.makeSignalSource(signal: sig, queue: .main)` | Queues the handler on `.main`, which is dispatched by the **main run loop** |
| `WineRunner.run`'s wait loop | `while process.isRunning { Thread.sleep(0.2) }` — occupies the main thread end to end and **never runs the run loop** |

Net effect: the default disposition is disabled and the handler is never scheduled, so SIGTERM becomes a signal that is "received but does nothing".

**③ Isolate the "queue" variable with a minimal reproduction.** A 60-line Swift program reproduces the same structure (`SIG_IGN` + `DispatchSource` + a `Thread.sleep` loop), changing only the queue:

| Queue | Handler ran within 8 s | Marker file |
|---|---|---|
| `DispatchQueue.main` | No | Not written |
| Dedicated serial queue | Yes | `收到 SIGTERM via custom` |

This step matters: reading the code only yields a hypothesis, and "suspected `.main` is the cause" must be recorded separately from "measured `.main` is the cause".

**④ Fix and measurements.** The signal sources moved to `DispatchQueue(label: "com.wexe.launcher.signal")`; nothing else changed. Re-running the same probe:

| | Before | After |
|---|---|---|
| Exit after SIGTERM | Still alive at 90 s, needed SIGKILL | **0.19 s**, `rc=15` |
| Log | No "signal received" | `收到信号 15，正在停止 wine` → `wine 退出 status=15` |
| That test case | 63.3 s | **3.1 s** |
| `exeonmac` full suite | 193.5 s | **137.5 s** |

**⑤ Why this stayed hidden so long — the fallback swallowed the defect.** The original test was:

```python
process.terminate()
try:
    process.wait(timeout=60)
except subprocess.TimeoutExpired:
    process.kill()          # ← the defect is eaten here
```

`kill()` guarantees the case can always finish, so "SIGKILL is the only way out" never turned red — it only cost 60 seconds of waiting. This is the classic **fallback masking a defect** shape: the fallback itself is reasonable (the suite must not hang), but it must also **treat "the fallback was taken" as a failure**, otherwise the fallback becomes a silencer.

**⑥ Two guards, one for each half, both negatively verified.**

| Guard | Location | What it protects | Negative verification (re-inject `.main`) |
|---|---|---|---|
| Static | `tests/test_phase0.py::test_signal_source_not_on_main_queue` | The registered queue is not `.main` | **1 case red**, 5/5 green after restore |
| Behavioural | `tests/test_phase3.py::TestRealLaunch` | The log contains "signal received" **and** the process exits within 20 s | **1 case red** (`'收到信号' not found`), 6/6 green after restore |

The behavioural test alone would catch it too, but only after waiting out the 20-second timeout; the static test alone would not stop some other spelling that is equally broken. Both together are fast and complete.

**⑦ Still unverified**: this section proves only that "SIGTERM is forwarded to wine and the launcher exits". All three signals share the same code path but only SIGTERM was exercised. **Whether wine writes every window's state back into the prefix on SIGTERM** (`wineserver`'s shutdown completeness) is unverified — the local probe used `notepad.exe`, which has no state to save; stateful commercial software needs a real-machine check.

> **Follow-up (2026-11-21)**: all three signals were then exercised individually and each stops in 0.18 s — but this very path is broken in another window (a signal arriving during `FontSubstitution.apply` is silently swallowed), and all three used to exit with 15, indistinguishable from each other. See **15.22**.

### 15.15 Packaging "succeeds" on a half-broken prefix (measured 2026-11-20, fixed)

**This defect is the same family as 15.14: the packaging flow is all green, exit code 0, verification 10/10 — and the product is a `.app` that does nothing when double-clicked.**

**① How it was found.** The optimization loop entered from the "usability" dimension and asked: "when a prefix already exists but is broken, how do `install` / `build` report it?" Digging in showed the wording was not the problem — `package` had no idea the prefix was broken.

**② The predicate only checked whether a directory exists.** Item 7 of `package/verify.py` used to be a single assertion: `Private/drive_c` is a directory. All three kinds of damage below therefore passed:

| Damage | Old verdict | Real consequence (same prefix, handed to wine) |
|---|---|---|
| `system.reg` / `user.reg` / `userdef.reg` deleted | 10/10 pass, exit 0 | `wine: could not load kernel32.dll, status c0000135` (rc=53) |
| `system32` still present but emptied | 10/10 pass, exit 0 | `could not open working directory L"C:\\windows\\system32\\"` |
| `dosdevices/c:` replaced by a regular file | 10/10 pass, exit 0 | drive C: does not exist; every install path fails |

Method: build a bundle that genuinely passes verification with `build_bundle`, then damage it row by row and run `wepack package <app> --no-register --json`. All three returned `EXIT=0`, `ok=true`, `failures=[]`.

**③ Why "the directory exists" is structurally insufficient.** The install side has always judged prefix usability with `prefix.validate_prefix()` (five conditions: `drive_c`, non-empty `system32`, `dosdevices/c:` is a relative symlink, three non-empty `.reg` files). The packaging side did not call it — the same business rule with two implementations, and the looser one sat on the last gate. Exactly what the §5.3 red line forbids.

**④ Fix: one implementation of the predicate, no second copy.**

```python
# wepack/package/verify.py
from ..prefix import validate_prefix          # reuse, do not copy
prefix_problems = validate_prefix(private)
report.checks.append(Check("prefix.valid", not prefix_problems,
                           "；".join(prefix_problems)))
```

The check was renamed from `prefix.drive_c` to `prefix.valid`, and on failure every missing item is named (not just "verification failed").

**⑤ After the fix (four prefix states, process exit codes measured individually).**

| Prefix state | Process EXIT | `ok` | Failing check |
|---|---|---|---|
| Healthy | 0 | `true` | none |
| Three `.reg` files missing | **7** | `false` | `prefix.valid` (names all three) |
| `system32` emptied | **7** | `false` | `prefix.valid` (`system32 为空`) |
| `dosdevices/c:` not a symlink | **7** | `false` | `prefix.valid` (`dosdevices/c: 不是符号链接`) |

Exit code 7 = `VERIFY_FAILED`, matching `contracts/exit-codes.json`.

**⑥ The fixture was as weak as the predicate — that is why it hid.** Most important point here. The test fixture `make_app()` used to create only `drive_c/App/`, with no `system32`, no `.reg` files and no `dosdevices/c:` — in other words, **the fixture's own prefix could not boot**. The predicate only checked for a directory, so the fixture passed; both sides being loose kept the defect green forever. The fix makes the fixture meet `validate_prefix`'s minimum requirements, so "tighten the predicate" and "make the fixture real" become the same change.

**⑦ A second instance of the same shape, fixed alongside: `package --json` wrote two JSON documents on failure.** `cmd_package` used to `_emit(payload)` unconditionally and only then `raise VerifyFailed`, so on failure stdout carried "full payload + main's error document" glued together. Same cause as the `build --json` defect fixed in W-02, just inside a single subcommand. Measured with `raw_decode`: before the fix `documents=2` and `json.load` throws `Extra data`; after the fix `documents=1`, with `ok=false` and `exit_code=7` in the same document. **This defect already existed on HEAD** (reproduced with the old implementation plus a deleted entry); it was not introduced here.

**⑧ Regression locks: 7 items, both directions negatively verified.**

| Guard | Location | Guards | Negative verification |
|---|---|---|---|
| Healthy prefix must pass | `test_phase3.TestPrefixHealthGuard` | against over-correction | — |
| Missing `.reg` / empty `system32` / broken `dosdevices`, one each | same | names each item | old predicate injected → **5 red**, 5/5 green after restore |
| Predicate must come from the `prefix` module | same | no second copy | source assertions: `from ..prefix import validate_prefix` present, `(private / "drive_c").is_dir()` absent |
| `package --json` single document on failure | `test_phase6.TestPackageJsonFailureContract` | stdout contract | "emit then raise" injected → **2 red**, 8/8 green after restore |

**⑨ Still unverified**: this section proves structural damage is blocked. **Software-level corruption where the prefix structure is intact but registry contents are half-written (e.g. an installer killed midway) can still only be found by actually running wine** — `validate_prefix` checks existence and non-emptiness, not content validity. Not over-engineered here; recorded as-is.

### 15.16 Touch targets are only 24px: a mouse can hit them, a finger cannot (measured 2026-11-20, fixed)

**The defect recorded here is not functional: every button works, the whole automated suite is green, and a mouse user sees nothing wrong.**

**① How it surfaced.** The optimisation loop entered from the "multi-device adaptation" angle, with the question narrowed to "the three viewports only verify no-overflow, not touch-target size". Using CDP's `Emulation.setTouchEmulationEnabled` to emulate a coarse-pointer device, the hit area of every clickable element was measured at all three viewports:

| Viewport | Clickable elements | Measured heights | Reaching 44px |
|---|---|---|---|
| 375 | 12 | 24 / 29px (only two values) | **0** |
| 768 | 12 | 24 / 29px | **0** |
| 1440 | 12 | 24 / 29px | **0** |

The narrowest is `exeonmac`'s "层" (layers) button at **29×24px**. The four direction cards' buttons sit side by side, with "自检" (doctor) and "构建" (build) less than 30px apart — aiming for doctor and hitting build actually **starts a build**. This is not "slightly awkward"; it **triggers a real action by accident**.

**② Why not just enlarge everything.** This tool's users work in a terminal all day; the dashboard's density is exactly why it was designed that way. On desktop, growing buttons from 24px to 44px makes four buttons in one direction card take an entire screen. Mouse pointing precision is far higher than a finger's, so it does not need this.

**③ Nor can it be decided by viewport width.** "375px = phone = finger" is wrong: a 1440px touch laptop, or a 375px responsive preview opened in a desktop browser, both make a width-based test give the opposite answer to the actual input method. The CSS side uses `@media (pointer: coarse)` — it describes **the input device itself**.

**④ The fix (`console/web/style.css`, 62 lines added).**

```css
@media (pointer: coarse) {
  .btn { min-width: 44px; min-height: 44px; }
  .dir-actions .btn { min-width: 44px; min-height: 44px; padding: 6px 10px; }
  .checks-wrap > summary, .log-wrap > summary { min-height: 44px; display: flex; align-items: center; }
  .history-row { min-height: 44px; align-items: center; }
}
```

44px comes from Apple HIG's minimum hit target (44×44pt); Material specifies 48dp, so 44 aligns with HIG. `min-*` is used rather than changing `padding`: `min-*` only declares a lower bound, so elements already taller are not squashed while short ones are raised to 44px — both hold.

**⑤ Measured after the fix (same machine, same script).**

| Pointer type | Height of the 12 clickable elements | Below 44px |
|---|---|---|
| Coarse (finger, emulated) | all 44px | **0** |
| Fine (mouse, default) | still 24 / 29px | 12 (**intentional**) |

**⑥ The verdict lives in the script, not in someone's eyes.** `console/scripts/viewport-check.mjs` went from two measurement passes to three: baseline, stress, and **touch**. The third activates `setTouchEmulationEnabled` first, then measures overflow and hit areas together — the order matters: if the widened buttons burst their container, that must be caught in the same pass, otherwise "fixed touch targets, broke the layout" becomes the next regression.

**⑦ Four negative verifications, all effective.**

| Breakage | Result |
|---|---|
| Remove the whole `@media (pointer: coarse)` block | 15/15 undersized at each viewport, exit code **1**; 1 static guard red |
| Keep `min-height`, drop `min-width` | The "层" button at 33×44px is caught; exit code **1** |
| Put `44px` into the base `.btn` rule (global enlargement) | Static guard "base rule must not contain 44px" goes red |
| Swap `setTouchEmulationEnabled` for `setEmulatedMedia` | 1 static guard red (see ⑧) |

**⑧ A trap this round set for itself (worth recording): the static guard was satisfied by a comment.** The first version read `assert.match(script, /Emulation\.setTouchEmulationEnabled/u)`. After **replacing that line in the code with the ineffective `setEmulatedMedia`**, the suite stayed green at 234/234 — because the script's own comments happen to explain that very API name. The assertion scanned the whole file, and comments count as content. Fix: strip comments before asserting, plus a reverse assertion `doesNotMatch(scriptCode, /setEmulatedMedia/)`. Same shape as the Appendix C trap in round 1: **the check must land on the segment that actually takes effect**.

**⑨ A silent hole was also plugged.** If coarse pointer were not active, buttons stay 24px and `undersized` would theoretically be non-empty, failing the run — but that is an **indirect** failure: shrink `MIN_TOUCH_TARGET` or have one large button on the page and the section passes silently. A direct assertion `row.touch.pointerCoarse === true` now blocks the no-op at the entrance.

**⑩ Still unverified**: (a) **the targets only meet a size threshold; real-finger accuracy on a physical device is untested** — this is headless Chrome emulation, and physical DPI, anti-mistouch policies and system gesture zones all affect the actual experience; (b) **long paths wrap to 4 lines at 375px and break mid-word** (`very-/long-/directo/ry-...`) — this was fixed in optimisation round 5, see **15.17**; (c) `pointer: coarse` is unrecognised by very old browsers (Safari < 9), which fall back to the original size — an expected degradation, with no feature-detection shim.

### 15.17 Long paths break mid-word: no overflow, no error, but unreadable (measured 2026-11-21, fixed)

**This section shares its origin with 15.16: the page is perfectly healthy, the tests are green, and only the person actually reading that path is affected.** The entry point was specified by 15.16 ⑩(b).

**① The shape of the problem.** `overflow-wrap: anywhere` solved "a long string bursts the container", at the cost of **breaking between arbitrary characters**. At 375px, a 139-character deep directory path was split into 4–5 lines, with break points landing inside words:

```
/very-long-directory-name/.../Framewo|rks/Electron/run|time.tar.zst
把 macOS 应用打包成 Windows 可执行文件：…/Electr|on/runtime.tar.zst
```

The reader has to stitch a word back together across two lines. The natural boundaries — `/` `\` `-` — were all left unused.

**② Measure first, then change.** Building a `Range` per character, grouping by `top`, and reassembling each line into a string yields a readable conclusion: *which character* the break landed on. The criterion is exactly one rule: **a break counts as mid-word only when both the preceding and following characters belong to `[A-Za-z0-9._]`** — CJK wrapping between characters is normal typesetting, and breaking right after `/` or `-` is a natural boundary, so neither counts.

Baseline across three viewports (reproduced by reverting `writeText` to `textContent` under this section's checker, same stress string):

| Viewport | Containers checked | Total lines | Mid-word breaks |
|---|---|---|---|
| 375 | 9 | 38 | **9** |
| 768 | 9 | 24 | **3** |
| 1440 | 9 | 19 | **3** |
| Total | — | 81 | **15** |

**③ Three key facts, all measured, that decided the fix.**

| Fact | How it was verified | Conclusion |
|---|---|---|
| `<wbr>` adds no width and **never enters the clipboard** | Built `/a/b<wbr>c/d`, then `getSelection().toString()` | Returns `"/a/bc/d"` — copying a path still works |
| `word-break: break-all` **ignores** `<wbr>` | Same string with and without `<wbr>`, 223px container | 5 lines, 4 hard breaks — byte-for-byte identical |
| `overflow-wrap: anywhere` **prefers** `<wbr>` | Four configurations × four widths | Hard breaks 1→0, 3→0, 2→0 — all cleared |

The second fact is the easy one to miss: `.result-val` carried `word-break: break-all`, and inserting `<wbr>` alone did nothing at all. **The CSS had to change with it.**

**④ The fix (two places, each covering one end).**

- `console/web/report-view.mjs` gains `pathSegments(text)`: a pure function splitting on `/` `\` `-` into `{text, breakAfter}` slices. Pure so it is testable in Node and reusable by the stress injector.
- `console/web/app.js` gains `export function writeText(node, text)`: the **single** entry point for writing long text into the DOM, appending `Text` plus a `<wbr>` after each separator, never touching `innerHTML`. `el()` now routes through it.
- `console/web/style.css`: `.result-val`'s `word-break: break-all` → `overflow-wrap: anywhere` plus `min-width: 0`.

**⑤ After the fix (same script, same stress string).** Nine containers across three viewports, **82 lines, 0 mid-word breaks**; horizontal overflow still 0px and touch targets still 12/12 at 44px — readability was bought without a layout regression.

**⑥ The criterion moved into the script as a fourth stage.** `viewport-check.mjs` grows from "baseline + stress + touch" to "baseline + stress + touch + **line-break quality**". The fourth stage runs after the touch stage, with the pointer reset to fine: coarse pointer widens buttons and squeezes the text column, so the break pattern it produces is not the one a mouse user sees.

**⑦ A trap this round set for itself (must be recorded): the stress injector wrote its own line-breaking logic, so it measured nothing.** Injected nodes bypass the `app.js` render path by design. The first version had the injector insert `<wbr>` **itself** in the page; reverting the product's `writeText` to `textContent` then still reported "0 mid-word breaks" with exit code **0** — the check was measuring its own implementation. Switching to `import('./app.js')` (the already-loaded module instance on the page) made the identical negative test report **15 breaks**, exit **1**.

This is the third recurrence of the 15.16⑧ shape: **the check must land on the code that actually takes effect.** The difference is that this time it was not "a comment satisfied the assertion" but "the stress harness duplicated the logic under test".

**⑧ Six negative tests, all effective.**

| Sabotage | Result |
|---|---|
| Revert `writeText` to `textContent` | **15** mid-word breaks across three viewports, each named; exit **1** |
| Put `word-break: break-all` back on `.result-val` | **4** breaks, all in `.result-val`; exit **1** |
| Put a non-existent class in the selector list | Reports "element missing, this section is a no-op for it"; exit **1** |
| Have `el()` bypass `writeText` | 1 static guard red (1 of 23 failing) |
| Revert the injector to its own logic | 1 static guard red |
| Restore `break-all` in CSS | 1 static guard red |

**⑨ Eight new guards** (`console/test/viewport-check.test.mjs`, 15 → 23): `pathSegments` break positions and "rejoining yields the original byte for byte", empty/non-string inputs never throw, a separator-free string yields one slice, the injector must `import('./app.js')`, `el()` must use `writeText` and must not assign `textContent`, `.result-val` must not use `break-all`, every selector in the list has a matching render site in `app.js`, and the verdict includes `dirty === 0` plus `missing !== true`.

**⑩ Still unverified / not handled**: (a) only *break positions* were measured — **whether `<wbr>` makes very long strings wrap to an extra line** was not measured in general; `.result-val` does go from 5 to 6 lines at 375px, a normal cost of finer break points, but extreme widths (< 300px) were not tested; (b) a horizontal scroll container or head/tail truncation (`…/last/two/segments`) is a different trade-off, not done here — the former introduces two-axis scrolling, the latter hides the middle segment users most need to verify; (c) Windows paths `C:\Users\...` are covered by the separator set, but prefixes like `\\?\C:\` were not separately tested.


### 15.18 Keyboard users lose focus the moment they press Enter: clickable with a mouse, unreachable by keyboard (measured 2026-11-21, fixed)

**This is the third shape of the 15.16 / 15.17 family: nothing overflows, no word is split, every button is big enough, and the first three stages are fully green — only keyboard users cannot complete the task.**

**① The shape.** The "contract check" button in the top bar is an ordinary `<button>`; clicking it with a mouse runs a check and looks flawless. Pressing Enter on a real keyboard:

- focus **drops to `<body>` immediately**, with no position marker anywhere on screen;
- a screen reader restarts from the top of the document;
- reaching the "close" button inside the panel that just appeared takes **12 more Tabs** (the panel sits after the direction grid in the DOM, and that matches the visual order).

Closing the panel also drops focus to `<body>`. Three separate losses of position along one chain.

**② Root cause: setting `disabled` inside the click handler.** The original code used `button.disabled = true` / `finally disabled = false` to prevent re-entry. Four control groups separate cause from correlation (same page, same button, same machine):

| Scenario | Trigger | Focus ends up on |
|---|---|---|
| Product as it was (handler sets `disabled`) | real `Enter` | **`<body>`** |
| Same handler | programmatic `.click()` | the button |
| Click intercepted, handler never runs | real `Enter` | the button |
| Click intercepted, `disabled` set manually | real `Enter` | **`<body>`** |

The difference is the event sequence: **`Enter` is keydown → click → keyup**. Setting `disabled` inside click makes the element stop being a focus target, so the browser returns focus to the document root, and the keyup that follows has no receiver. A programmatic `.click()` has no trailing keyup, which is why this never reproduced — **and why every existing test was green**. A full focus trace (`focusin` / `focusout`) shows it directly:

```
Fixed:   in:section#contract-panel  →  out→:section#contract-panel
Before:  out→:body                 →  in:section#contract-panel
```

**③ The fix (four places, each covering one gap).**

- `console/web/app.js`: re-entry is guarded by a boolean `contractBusy`, and the busy state is expressed with `aria-disabled` / `aria-busy`. `aria-disabled` changes semantics only (a screen reader reads "unavailable") and **does not affect focusability**, so focus survives. `runContractCheck` ends with `panel.focus()` so focus moves to the result panel — the results render below the fold (top = 601px at 375px), and without moving focus the user knows neither that the check started nor where the output is.
- A new `closeContractPanel()`: hides the panel, then `$('btn-contract').focus()`. Once the panel is hidden, the "close" button leaves the accessibility tree with it; without handing focus back explicitly it necessarily lands on `<body>`.
- `console/web/index.html`: the panel gains `tabindex="-1"`, `role="region"` and `aria-label`. `-1` lets it receive programmatic focus without entering the Tab order; `role="region"` lets a screen reader announce "Contract consistency, region" rather than just "region".
- `console/web/style.css`: styling for the `aria-disabled` busy state (`opacity: .45`, `cursor: progress`) and `.panel:focus { outline: none; box-shadow: inset 3px 0 0 var(--info) }`.

**④ A trap this round set for itself (must be recorded): the first fix was flagged red, and it deserved to be.** It said `.panel:focus { outline: none }` — moving focus while **giving no visible marker at all**, which turns "focus is on the panel" into an invisible fact. The check failed immediately: one problem per viewport, "focus is on section#contract-panel but there is no visible focus ring". That is the same shape as the defect being fixed (**focus in an invisible place is no focus at all**), merely changed from "focus lost" to "focus invisible". It passes after switching to an inset bar on the left edge.

**⑤ A second trap: the first version of the criterion was too soft for a negative test to catch.** The verdict originally read end-state snapshots only ("where is focus after Enter", "where after the check"). Reverting the product to `disabled` for a negative test left **all three viewports green in the browser** — because the trailing `panel.focus()` inside `runContractCheck` moved focus back, hiding the instant it had dropped to `<body>`. Adding "the `focusin`/`focusout` trace must never contain `body`" turned the same sabotage red on all three viewports, exit **1**.

This is the fourth recurrence of the 15.16⑧ / 15.17⑦ shape: **the check must land on the code that actually takes effect.** This time the form was "the end state concealed the process".

**⑥ Another correction: the Tab-distance criterion was simply wrong and has been replaced.** The first version asserted "at most 3 Tabs from the trigger into the panel", and the measurement was a constant 12 — but that is **not a defect**: the contract panel sits after the direction grid in the DOM and visually, so 12 is exactly "the Tab order matches what the eye sees". Moving the panel earlier in the DOM to shorten it would make the keyboard walk and the visual layout disagree. The assertion is now "**once focus has been handed into the panel by stage one**, at most 2 Tabs to reach close" — measured 1.

**⑦ Post-fix measurement (real Chrome, three viewports).**

| Viewport | Focus after Enter | Focus ring | Tabs to close inside panel | Focus after close | Trace contains body |
|---|---|---|---|---|---|
| 375 | `section#contract-panel` | yes | 1 | `button#btn-contract` | no |
| 768 | `section#contract-panel` | yes | 1 | `button#btn-contract` | no |
| 1440 | `section#contract-panel` | yes | 1 | `button#btn-contract` | no |

The first three stages did not regress in the same run: horizontal overflow 0px in baseline / stress / touch on all three viewports, 0 offending elements, 0 mid-word breaks, and 0 of 15 touch targets under 44px.

**⑧ Four negative tests, all effective.**

| Sabotage | Browser measurement | Static guard |
|---|---|---|
| `aria-disabled` reverted to `disabled` | trace contains `out→:body` on all three viewports, exit **1** | 1 red |
| The post-close `focus()` removed | focus after close is `body#` on all three, exit **1** | 1 red |
| `.panel:focus` loses `box-shadow` (only `outline: none` remains) | `ring=false` on all three, exit **1** | — |
| The panel loses `tabindex="-1"` | focus stays on the trigger after Enter on all three, exit **1** | 1 red |

**⑨ Eleven new guards** (`console/test/viewport-check.test.mjs`, 23 → 34): `judgeKeyboardFocus` passes on healthy data; each of the two `body` moments is named separately; a hidden region and a missing focus ring both fail; the post-close landing spot must be the trigger button; a panel with 0 nodes fails as "no-op"; more than 2 Tabs inside the panel fails; the verdict must feed the `ok` result of `runViewportCheck`; the product must not use `button.disabled =`; `closeContractPanel` must hand focus back; the panel must carry `tabindex="-1"` plus `role`/`aria-label`; `.panel:focus` must have a visible substitute marker.

**⑩ Still unverified / not handled**: (a) **Chrome only** — whether Safari / Firefox implement "a disabled element loses focus" identically is untested; (b) the history-row "replay" focus chain was not measured separately this round — it also resets the panel, but goes through SSE rather than fetch; (c) the actual announcement order of a screen reader was not listened to by a human, only the presence of `role` / `aria-label` / `aria-busy` was checked statically; (d) putting `aria-busy` on a button is debatable — the spec prefers the **container being updated**; this round treats it as "the button itself is busy".


### 15.19 "Exists and is non-empty" does not mean "wine can read it" (measured 2026-11-21, fixed)

**This section is the layer below 15.15.** 15.15 established that a structurally half-broken prefix must fail at packaging time, and the fix was to make the packaging check reuse `validate_prefix()`. But that check itself only looked at whether the `.reg` files **exist and are non-empty** — so as long as the bytes were there and the size was not zero, the content could be anything. This section extends the criterion to content, and in doing so found that two pieces of code had been writing registry data in a format wine does not accept.

**① The defect: 35 bytes of plain text passed as healthy.** Building a healthy prefix and replacing `system.reg` with a single line, `this is not a registry` (35 bytes):

```
validate_prefix(...)     ->  []                          # judged healthy
wine64 cmd /c "echo hi"  ->  rc=1
    system.reg is not a valid registry file
    wine: '...' is a 32-bit installation, it cannot support 64-bit applications.
```

Check 7 on the packaging side, `prefix.valid`, calls exactly this function, so such a prefix gets packed into a `.app` and shipped — the user receives "packaging succeeded, double-click does nothing", the same shape as 15.15, with the entry point moved from structure to content.

**② The three files differ in fatality and must be judged separately.** Nine malformed files were run against real wine (wine-11.21), recorded on two axes — whether the process boots and whether writes persist:

| File | Wrong first line | Missing `#arch=win64` |
|---|---|---|
| `system.reg` | `rc=1`, will not boot | **`rc=1`**, reports "32-bit installation", while the file is syntactically valid |
| `user.reg` | **`rc=0`, but HKCU writes are silently lost** | `rc=0`, no effect |
| `userdef.reg` | `rc=0`, only new-user defaults are lost | `rc=0`, no effect |

The middle row is the nastiest: with `user.reg` replaced by `garbage`, `reg add HKCU\...` **returns 0**, the immediately following `reg query` cannot find the key just written, and `user.reg` shrinks from 119640 bytes to 8. The installer therefore "succeeds", the registered paths and serial numbers never reach disk, and the second launch fails — **with a clean exit code and clean stderr**.

So the first-line check runs on all three files, while `#arch` applies only to `system.reg`. Requiring arch on the other two would be a false positive (measured: they work fine without it).

**③ Measured boundaries for the first line and arch** (all measured, not copied from documentation):

| Form | Result |
|---|---|
| `REGEDIT4` / `Version 1` / `Version 3` / a leading blank line | all `not a valid registry file`, `rc=1` |
| `Windows Registry Editor Version 5.00` | also `rc=1` — that is the **export** format of `regedit /E`, not the on-disk format inside a prefix |
| Missing `#arch=win64` | `rc=1`, reports "32-bit installation" |
| `#arch=win32` / `#ARCH=win64` | the same error → exact match, wrong case is equivalent to absent |
| arch on line 3 / line 6 / after a blank line / CRLF / no trailing newline | all `rc=0` → position does not matter |
| A half-written `"a"="b` inside a section (`Malformed value`) | **`rc=0`**, the program runs normally → one value lost, not a reason to call the prefix unhealthy |

That last row is why the check must **not** validate full syntax: doing so would turn "one value lost" into "the prefix is broken".

**④ Two pieces of code had been writing a format wine rejects.** Both asserted "wine's .reg is UTF-16LE + BOM", a claim that only holds for files **exported** by `regedit /E`:

- `prefix._write_placeholder_regs`: the placeholder written when a base layer ships no `.reg` files was UTF-16LE+BOM and had **no `#arch`**. Measured `rc=1` with `system.reg is not a valid registry file` — **the placeholder itself was broken**, and its entire purpose is to let wine boot. After switching to plain ASCII plus `#arch=win64` it returned `rc=0` and wine expanded the placeholder into a complete 200 KB registry on its own.
- `install.RESTART_SUPPRESS_REG`: it used wine's **internal** storage format (`WINE REGISTRY Version 2` with relative key paths `[Software\\...]`), while `regedit /S` only accepts the **Windows export** format. Measured: feeding it the internal format yields **exit code 0, empty stderr, zero keys written**. Three variants against the same prefix and the same command:

| File content | `reg query` after import |
|---|---|
| `Windows Registry Editor Version 5.00` + `[HKEY_CURRENT_USER\...]` | key present, all three dwords in place |
| `WINE REGISTRY Version 2` + relative `[Software\...]` | key absent |
| `WINE REGISTRY Version 2` + `[HKEY_CURRENT_USER\...]` | key absent |

In other words, "restart suppression" had never taken effect, while the log kept saying `reboot.suppressed`. After switching to the export format all three values were measured to land.

**⑤ Four fixes, each covering one aspect.**

- `prefix/__init__.py` gains the constants `REG_HEADER` / `REG_ARCH_64` and `_check_reg_file()`: it reads the first 64 KB and checks the first line plus (for `system.reg` only) arch. `validate_prefix` calls it after the non-empty check.
- `prefix._write_placeholder_regs`: plain ASCII plus the arch line.
- `install.RESTART_SUPPRESS_REG`: the Windows export format with absolute key paths.
- `install.suppress_restart`: after the import it queries `RESTART_POLICY_KEY` and logs `WARN reboot.suppress_ineffective` when absent. **`regedit /S` does not fail on a malformed file, so "no exception thrown" proves nothing** — at the very least the log should tell the truth.

**⑥ The test fixtures were loose in the same way (the other half of why the defect stayed hidden).** Both `make_fake_layer()` and `test_phase3.make_app()` wrote UTF-16LE+BOM without arch, so **the fixtures could not produce a prefix that even boots**. The check only looked at "exists and non-empty", the fixtures happened to pass, and both sides were loose together — hence permanently green. Both fixtures now build according to the new criterion, importing the constants from `wepack.prefix` rather than each carrying its own literal.

**⑦ Eleven new tests** (`test_phase2.py`): `TestValidatePrefixRegContent` with 9 (plain-text system.reg / missing arch / `#arch=win32` / UTF-16 BOM / broken user.reg / broken userdef.reg are all flagged; the two user files without arch are **not** flagged, four arch positions are **not** false-flagged, and `Malformed value` is **not** false-flagged — the last three guard against over-correction); `TestRestartSuppressionTakesEffect` with 2 (a fake wine whose `reg query` reports not-found must produce WARN rather than INFO; a query returning `NoClose` must produce INFO, guarding the other direction). In addition, `test_placeholder_regs_written_when_missing` and `test_reg_file_is_utf16` — two old tests that had **baked the wrong format into their assertions** — were corrected.

**⑧ Negative verification (old implementations re-injected).**

| Break | Result |
|---|---|
| Remove the `_check_reg_file` call from `validate_prefix` | 6 tests turn red (plain text / missing arch / win32 / BOM / user / userdef) |
| Revert `_write_placeholder_regs` to UTF-16LE+BOM without arch | the placeholder test turns red |
| Revert `RESTART_SUPPRESS_REG` to `WINE REGISTRY Version 2` | the format assertion turns red |
| Drop the post-import query and always log INFO | "ineffective must log WARN" turns red |

**⑨ Still unverified / not handled**: (a) **wine-11.21 only** — how other versions tolerate the first line and arch is untested; (b) the criterion covers "wine can read it in", **not "the registry content is semantically correct"** — a key whose value was replaced with garbage still boots wine, and only running the actual application would surface it; (c) 32-bit prefixes (`WINEARCH=win32`) are unsupported in this repository, so `#arch=win32` is always an error; supporting them would require changing that rule; (d) whether `regedit /S`'s silent failure affects other `.reg` import paths was not surveyed systematically — only `suppress_restart` was examined.


### 15.20 Compiling an installer at module import: how "borrowing one pure function" made a whole test class vanish (measured 2026-11-21, fixed)

**This section handles leftover (a) from 15.19.** 15.19 recorded "`ISCC 编译失败（退出码 0）` is a pre-existing error on HEAD" and pinned down its root cause; this section fixes it, and also removes the structure that let such a defect survive so long.

**① Symptom: running one test class crashes, while a full run in alphabetical order is fine.** `cd exeonmac && python3 -m unittest tests.test_phase2.TestCliPhase2` gives:

```
Ran 7 tests in 1.285s
FAILED (errors=2)
RuntimeError: ISCC 编译失败（退出码 0）：
```

`detail` is **empty**. Exit code 0, empty stderr, no artifact — three mutually contradictory facts that read as "ISCC itself is broken". And under `discover`'s alphabetical order (`test_phase0` → `test_phase1` → `test_phase2`) it stayed green, which is why the defect hid for so long.

**② The root cause is a four-link chain; break any link and it does not reproduce.**

1. `tests/test_phase1.py:53` evaluates `REAL_INNO = ... str(fixtures.demo_inno_real() or "")` at **module top level** — importing the module compiles an Inno installer on the spot.
2. `tests/test_phase2.py` has four `from tests.test_phase1 import build_min_pe, build_nsis_overlay` lines, only to borrow two **pure byte builders**.
3. `test_phase2`'s `IsolatedWexe.setUp` points `WEXE_HOME` at a temporary directory and drops a fake wine that just does `exit 0` (`make_fake_wine`).
4. So the import in step 2 (which happens after step 3) resolves `wine_binary()` to the fake wine; ISCC is "run" by it, compiles nothing, exits cleanly, `demo-setup.exe` is absent → `RuntimeError`.

**This is an order-dependent defect**: the same code is fine in alphabetical order and explodes when a single class is run. `check_no_skips.py` cannot catch it (that script only looks at `Ran N tests` and skipped counts), and neither can "the full suite is green".

**③ The fix is not a `try` — it is removing the import-time side effect.** The four sample constants became **lazy functions** (`sample_nsis()` / `sample_inno()` / `sample_msi()` / `real_inno()`), cached per process; the four classes that used `@unittest.skipUnless(constant and ...)` now use `setUpClass` + `require_sample()`, raising `unittest.SkipTest(...)` when the fixture is unavailable. **Decorators are evaluated at import time; `setUpClass` only when the test is actually about to run** — that is exactly the dividing line.

**④ The error message now says which failure it is.** `fixtures.demo_inno_real()` used one sentence for both "compilation failed" and "wine did nothing". Now they are separated:

```
ISCC exited 0 but produced no artifact — this wine did nothing:
  wine = /tmp/.../wexe/runtime/wine/bin/wine64
  WEXE_HOME = /tmp/...
Most likely a test pointed WEXE_HOME at a temporary directory containing only a
fake wine that just does `exit 0`; wine itself may also be damaged.
```

Same family as 15.19 — "exit code 0, fake success". Same principle: **let the failure state which kind it is**, so the next person does not go hunting in the compiler.

**⑤ Two new guards, both negatively verified.**

| Guard | Criterion | Negative check (constant injected back at module level) |
|---|---|---|
| `test_importing_module_runs_no_external_tool` | In a subprocess, plant a fake wine that leaves a trace when called plus an existing `WEXE_ISCC`; after import the sentinel file **must not exist** | Sentinel appears → the test turns red |
| `test_no_fixture_call_at_module_level` | `ast`-scan the module body; **no** `fixtures.demo_*` call may appear there (calls inside function bodies do not count) | Reports "line 63: fixtures.demo_inno_real()" → turns red |

The first version of the guard **was a soft criterion**: it only asserted "import does not fail, and the synthetic fixture can be built". Under negative verification it stayed green — because with an empty `WEXE_HOME`, `demo_inno_real()` merely returns `None` instead of raising. After planting the sentinel, the very same negative code turns both tests red. **Once again: a criterion that has not survived negative verification is a criterion that was never written.**

**⑥ Why this deserves its own section.** It is not "some function is wrong"; it is **implicit coupling between test suites**: `test_phase2` depends on `test_phase1` having already finished (at which point `WEXE_HOME` has been restored). That precondition was never written down and never checked. **Any module-level code that "runs on import" manufactures such undeclared preconditions.**

**⑦ Systematically scanned: three more instances of the same shape exist; not touched this round.** An `ast` scan of every statement that executes on import in `tests/test_*.py` (skipping function bodies, walking class bodies) found:

| Location | Import-time call | Nature |
|---|---|---|
| `test_phase2.py:53/54` | `fixtures.demo_nsis()`, `fixtures.wine_available()` | The first runs `makensis` (external tool); the second only probes for a file |
| `test_phase3.py:56/57` | same | same |
| `test_phase7_layers.py:341/394` | `fixtures.wine_available()` | Only probes for a file; no side effect |

None of them currently manifests as a failure: `discover` imports these modules before running any test, at which point `WEXE_HOME` is still the real one. But the shape is identical to `test_phase1` — if anyone imports them while `WEXE_HOME` is redirected, `REAL_WINE` / `SAMPLE_NSIS` get pinned to the fake environment **and are never corrected** (module-level constants are evaluated once). Following "change one variable per round", only the one that actually blew up is fixed here; these three are left for the next round.

**⑧ Still unhandled**: (a) `test_phase2` still does `from tests.test_phase1 import build_min_pe` — harmless now that it is lazy, but the cleaner move is to sink those two pure builders into `fixtures.py` so test modules stop importing each other; (b) the three import-time calls in table ⑦ should become lazy; (c) CI only runs `discover` (alphabetical), never single classes, so this class of order dependency stays green on CI forever — a job that runs each test class on its own would be worth adding.


---

### 15.21 "Concluded at import time": a criterion at module level makes a skip permanent (measured 2026-11-21, fixed)

**This section disposes of 15.20 ⑦.** 15.20 scanned out three import-time calls and left them for the next round; this section fixes all of them, and in doing so finds that 15.20 did not go far enough — it turned "compiling at import" into "concluding at import", which is harder to see.

#### ① Symptom: the second face of the same shape

After 15.20, what remained in `test_phase2` was this line:

```python
REAL_WINE = fixtures.wine_available()      # looks side-effect free
```

It genuinely does not run an external tool, but it pins the answer to "does this machine have wine" at the moment of import. Measured (importing with `WEXE_HOME=/nonexistent`):

| | `TestRealWine.__unittest_skip__` | `TestRealInstall.__unittest_skip__` |
|---|---|---|
| Before (`= fixtures.wine_available()`) | **True** | **True** |
| After (decided in `setUpClass`) | False | False |

After the change `__unittest_skip__` is False, and `setUpClass` skips according to the actual environment when the test really runs — which is the correct place. **Skipping is not the problem; pinning the skip at import time is**: once pinned it is never corrected, because a module-level constant is evaluated exactly once.

#### ② The third face: decorator arguments

The two spots in `test_phase7_layers.py` were `@unittest.skipUnless(fixtures.wine_available(), ...)`. This is even more hidden — there is no "constant" visible in the code, just a decorator line, yet `skipUnless` evaluates its argument **at import time**, with exactly the same effect as ①.

Static scanning missed it (it lives in `decorator_list`, not in module-body statements), so the first `ast` guard skipped this spot. After adding `decorator_list` to the scan it reported 2 findings at once.

#### ③ The real defect in `test_phase2` / `test_phase3`: import means compile

15.20 ③ was about `test_phase1`, but a stronger version of the same shape lives in these two files — they each copied it:

```python
SAMPLE_NSIS = os.environ.get("WEXE_SAMPLE_NSIS") or str(fixtures.demo_nsis() or "")
```

`demo_nsis()` runs `makensis`. Measured with a sentinel script (a fake `makensis` prepended to PATH that leaves a mark when called):

```
$ python3 -c "import tests.test_phase3"     → marker present
$ python3 -c "import tests.test_phase2"     → marker present
RuntimeError: makensis 编译失败（退出码 0）：
```

Exactly the same sentence, shape and cause as the ISCC case in 15.20 (the `makensis` is fake, exits 0, produces nothing). **15.20 fixed "the ISCC path" but not "this path has two more entrances".**

#### ④ Fix: move the criterion into `fixtures`, keep exactly one copy

The four `SAMPLE_NSIS` definitions were byte-for-byte identical, which is the signature of **one criterion written three times** (a violation of 5.3). Disposition:

- `tests/fixtures.py` gains `sample_nsis()` / `sample_inno()` / `sample_msi()` / `real_inno()` / `require_sample()` / `wine_ready()` / `reset_sample_cache()`;
- `test_phase1`'s local definitions become **same-name references** (`sample_nsis = fixtures.sample_nsis`), so callers need no change;
- `test_phase2` / `test_phase3` drop the module-level constants and use `setUpClass` + `fixtures.require_sample(...)`;
- `test_phase7_layers`' two decorators become a check inside `setUpClass`.

**The cache key includes the current value of the environment variable** (`(key, os.environ.get(env_name, ""))`). A name-only cache would mask whether the environment variable takes effect — and tests do change environment variables and then assert on the branch, so a stale cache hit would make the new branch permanently untestable.

#### ⑤ The guard goes from "one module" to "the whole repository"

15.20's two guards only scanned `test_phase1.py`, which is exactly why the other three spots were missed. Now:

| Guard | Criterion | Scope |
|---|---|---|
| `test_scan_covers_all_test_modules` | the glob result must contain all 6 known modules; one missing is red | — |
| `test_no_fixture_call_at_module_level` | `ast` scans **every** `test_*.py` for import-time statements plus `decorator_list`; not one `fixtures.*` call is allowed | 6 files |
| `test_importing_modules_runs_no_external_tool` | a subprocess imports every module; neither the `makensis` nor the `wine` sentinel may appear | 6 files |

The third guard needed a companion "scan-scope guard": if `glob` returns an empty set because the path is wrong, the first two would **pass green** (no files, no violations) — exactly the "criterion satisfied by an empty set" shape recorded in 15.16 ⑧.

#### ⑥ Negative verification (two injections, both effective)

| Injection | Result |
|---|---|
| add `LEGACY_SAMPLE = fixtures.sample_nsis()` + `LEGACY_WINE = fixtures.wine_available()` at `test_phase2` module level | static guard reports 2 findings with exact line numbers, dynamic guard's sentinel appears → **2 tests red** |
| restore `@unittest.skipUnless(fixtures.wine_available(), ...)` on `test_phase7_layers` | static guard reports `装饰器 fixtures.wine_available()` → **red** |

Restored afterwards: 3/3 green.

#### ⑦ Still open

(a) `test_phase2` still does `from tests.test_phase1 import build_min_pe` — side-effect free now, but the cleaner move is to sink those two pure byte builders into `fixtures.py` so test modules no longer import each other; (b) CI only runs `discover` (alphabetical), never a single class, so ordering dependencies stay green on CI — worth adding a "run every test class on its own" job; (c) `fixtures._SAMPLE_CACHE` is process-wide, so constructing first and clearing via `reset_sample_cache()` afterwards in the wrong order will still hand back a stale value.

### 15.22 A signal that was "received" but never executed: the launcher cannot be closed during its startup window (measured 2026-11-21, fixed)

**This section disposes of 15.14 ⑦.** 15.14 fixed the root cause "the signal source is attached to the `.main` queue" but explicitly left one thing unverified: three signals share one code path, yet only SIGTERM was ever sent. This round tried exactly that first — and all three behaved fine (each exited in 0.18 s). **The real problem was elsewhere.** Every 15.14 test waits for "wine 已启动" before signalling, which happens to step over a much wider window.

#### ① Symptom: the log says "signal received", then wine starts anyway

Same probe as 15.14 (real base layer + real wine + real launcher), only the timing changes — instead of waiting for "wine 已启动", signal after a fixed delay of 0.8 / 1.0 / 1.2 seconds, twice each:

| Delay | Stopped | Elapsed | Log has "signal received" | Log has "wine started" |
|---|---|---|---|---|
| 0.8s | no | 25.0s | yes | no |
| 0.8s | no | 25.0s | yes | no |
| 1.0s | no | 25.0s | yes | no |
| 1.0s | no | 25.0s | yes | no |
| 1.2s | no | 25.0s | yes | no |
| 1.2s | no | 25.0s | yes | no |

**6/6 reproduced.** The log tail looks like this (complete, no errors):

```
[04:59:18Z] launch start: .../Note (Win).app
[04:59:18Z] app=Note entry=drive_c/windows/notepad.exe
[04:59:18Z] runtime ready: .../runtime/wine/bin/wine64
[04:59:18Z] 收到信号 15，正在停止 wine
[04:59:21Z] fontsub 已导入 1 条替换        ← note the timestamp: 3 seconds later
[04:59:21Z] wine 已启动 pid=17638 → ...
```

The user pressed Ctrl-C, the log says "stopping wine", and then wine starts anyway and **not one further line appears**. The shape differs from 15.14: not "the signal was never received" but "**received, acknowledged, and executed by nobody**".

#### ② Root cause: the 3 seconds during which `current` is nil

The signal sources are registered **before** `FontSubstitution.apply`, and apply runs `wine regedit /S` to import font substitutions. During that window:

| Step | State |
|---|---|
| `signal(sig, SIG_IGN)` | already executed — SIGTERM's default disposition is **already gone** |
| handler | does run, but its body is `WineRunner.current?.terminate()` |
| `WineRunner.current` | **nil** — the main program hasn't started, and apply's regedit creates its own `Process` and calls `waitUntilExit()`, so it is **never registered** |

So `current?.terminate()` is a no-op. The "signal received" line is genuinely written, then nothing happens. The 3-second gap before "wine 已启动" in the log above is exactly apply's regedit.

#### ③ Second problem: recording `pending` was not enough

The first fix was "when the handler sees `current == nil`, record it into `pending`, and have the main flow check once before starting wine". The regression lock **turned red immediately**, correctly: the main thread is blocked inside apply's `waitUntilExit()`, so it **never reaches that checkpoint**. The signal was recorded and nobody executed it — the defect went from "signal dropped" to "signal stored, then dropped".

Which says something larger: **fixing the handler is not enough, because the problem isn't the handler — it's that one code path bypasses the shared registration.** The real defect is the design assumption that `current` only covers the main program.

#### ④ Fix: every wine child goes through one entry point

| Change | Detail |
|---|---|
| New `WineRunner.runChild` | The only `Process()` in the file. Registers `current` → run → poll → clear `current` |
| `FontSubstitution.apply` now uses `runChild` | That regedit now also has a `current`, so the signal has something to stop. Poll interval 50 ms (it runs one or two seconds, so it must react fast) |
| Handler does one thing: `noteSignal(sig)` | Record `pending`, then try to deliver. It does **not** branch on `current == nil` itself |
| `runChild` returns an `Outcome` enum | `.finished(code)` / `.stoppedBySignal(sig)` / `.late` / `.failedToStart` |

`Outcome` is not decoration. It used to return a bare `Int32`, and "wine exited with 15 on its own" and "we signalled it" are the same 15 — the caller cannot tell whether to continue. That divergence happened for real once: after the first fix, regedit was stopped by the signal and the log read `WARN fontsub 导入退出码 15，界面字体可能显示为方块` (treating "interrupted" as "font import failed"), and then **the main program was started anyway**. The user had already asked it to close; the window appeared again.

`apply` now returns `Bool` (aborted by signal) and `main` exits with that signal directly instead of starting the main program.

#### ⑤ Also fixed: one user action, three different exit codes

Before the fix, closing the app produced a different code depending on which path the signal took:

| Scenario | Before | After |
|---|---|---|
| SIGINT in the window | 2 (default disposition, handler not yet registered) | **2** |
| SIGINT stopping the main program | **15** (wine terminated, reported as 15) | **2** |
| SIGTERM stopping the main program | 15 | 15 |
| SIGHUP stopping the main program | **15** | **1** |

The middle rows are the point: three signals share one code path, but `terminate()` sends SIGTERM, so wine always exits 15 — **Ctrl-C and kill -HUP were indistinguishable from SIGTERM**. After the fix each signal returns its own value. Measured: `SIGINT → 2 / SIGTERM → 15 / SIGHUP → 1`, each exiting in 0.02–0.04 s.

#### ⑥ Regression locks: 5 tests, no real wine needed

The defect is about the **timing** of "the handler arrived, the child does not exist yet" and has nothing to do with what wine is. A fake wine that "logs its invocation, then sleeps 120 s" is actually better: the window becomes controllable, it does not depend on apply happening to take a few seconds on a real machine, and it cannot pass by luck on a fast machine.

New `test_phase3.TestSignalDuringStartupWindow` (5 tests):

| Test | Criterion |
|---|---|
| `test_sigterm_in_startup_window_stops_launcher` | Wait for `runtime ready` (sources registered, wine not started), send SIGTERM: exits within 15 s, exit code == 15, and **the sentinel has no main-program invocation** |
| `test_sigint_in_startup_window_stops_launcher` | Same, exit code == 2 |
| `test_pending_is_consumed_not_replayed` | `drainPending` must clear `pending`; no repeated delivery every poll |
| `test_handler_records_pending_when_no_child` | The handler must call `noteSignal`, and `noteSignal` must actually write `pending` |
| `test_every_wine_child_goes_through_one_runner` | Exactly **one** `Process()` in the whole file |

The last one is structural: fixing only "record pending" without unifying the entry point means the next wine call reproduces this verbatim. It is also the defect's own cause — one job with two implementations, and the looser one (no registration) landed squarely on the big window (rule 5.3).

The sentinel assertion is harder than the exit code: before the fix the launcher started the main program anyway, so the sentinel contained `drive_c/App/app.exe`; after the fix `pending` is seen before startup and the main program **must never be invoked**. Only the regedit invocation may appear, since it happens before the window.

#### ⑦ Negative verification (two injections, both effective)

| Injection | Result |
|---|---|
| Handler reverted to `WineRunner.current?.terminate()` (i.e. only direct terminate, no pending) | **3 red**: both behavioural tests report "still running after 15 s" with the log tail; the static test reports the handler does not call `noteSignal` |
| `apply` reverted to its own `Process` + `waitUntilExit()` | **3 red**: both behavioural tests report "still running after 15 s" (the log shows "已记下信号 15", i.e. recorded but executed by nobody); the static test reports 2 occurrences of `Process()` |

Restored afterwards: 5/5 green.

#### ⑧ Still open

(a) Only the in-window paths for SIGTERM and SIGINT are tested; SIGHUP sits in the same `signals` array but is not tested separately (all three share one code path — low risk, but "one code path" was already proven unreliable in 15.14); (b) stopping regedit means the font substitution never took effect, so Chinese text may render as boxes — a deliberate trade-off (the user is already closing it; spawning another process for fonts is wrong), but **the product gives no hint**; (c) whether wine writes all window state back to the prefix on SIGTERM remains unverified (same as 15.14 ⑦).

### 15.23 Font substitution never worked, not once since release: `regedit /S` returns 0 and writes nothing (measured 2026-11-21, fixed)

**This section disposes of 15.22 ⑧(b).** That item noted that when `regedit` is stopped by a signal, font substitution does not take effect and the product says nothing. Following that thread raised a sharper question: does it take effect when nothing interrupts it? The answer is no — **it has nothing to do with signals, it never worked at all.**

#### ① Symptom: the log says "imported 2 substitutions", the registry has none

`FontSubstitution.apply` wrote `fontsub.reg` in wine's **internal** format:

```
WINE REGISTRY Version 2
[Software\\Microsoft\\Windows NT\\CurrentVersion\\FontSubstitutes]
"Microsoft YaHei"="PingFang SC"
```

Measured against a real base layer (382 MB) and real wine-11.21:

| Step | Command | Result |
|---|---|---|
| import | `wine64 regedit /S fontsub.reg` | **exit code 0**, empty stderr |
| read back | `wine64 reg query "HKCU\Software\Microsoft\Windows NT\CurrentVersion\FontSubstitutes"` | **`reg: Unable to find the specified registry key`** |

Clean exit code, clean stderr, zero keys written. The launcher log still said "fontsub 已导入 2 条替换" — the user sees tofu, the log reports success.

#### ② The same content in export format lands every key

Changing the first line to `Windows Registry Editor Version 5.00`, the key path to single backslashes with the full `HKEY_CURRENT_USER\` root, and re-running the same command:

```
HKEY_CURRENT_USER\Software\Microsoft\Windows NT\CurrentVersion\FontSubstitutes
    Microsoft YaHei    REG_SZ    PingFang SC
    SimSun    REG_SZ    Songti SC
```

**This is the same root cause as `install.suppress_restart`, fixed in round 7**: export format mistaken for storage format. That round only fixed the Python side and added a read-back there; this Swift copy was never covered by the same check. Fixing one instance is not fixing the class.

#### ③ End to end: a real launcher, a real registry

A real launcher built by `launcher/build.sh`, assembled into an `.app` (base layer + `notepad.exe` + two `font_map` entries), `WEXE_HOME` pointed at a temp dir:

```
runtime ready: .../runtime/wine/bin/wine64
fontsub 已导入 2 条替换
wine 已启动 pid=88702
```

A direct `reg query` against that prefix afterwards shows both `REG_SZ` values. **Before the fix, the same `.app` produced zero keys.**

#### ④ How the check evolved: why a one-shot stamp instead of "delete the key first"

This is the part worth remembering — **the first version of the check was failed by its own negative verification, and correctly so.**

| Version | Check | Negative verification (inject internal format) |
|---|---|---|
| v1 | after import, `reg query` returns the font name → success | **still green** — the key came from a **previous** successful run; this run wrote nothing, yet the check passed |
| v2 (rejected) | `reg delete` the old key first, then import, then query | catches it, but **destructive**: if this import fails, the user's previously working substitutions are wiped — "old value works" degrades to "nothing at all" |
| v3 (adopted) | write `ExeOnMac\FontSubstitutionStamp = <UUID>` into the **same** `.reg`, then query for that stamp | **correctly red**: `fontsub 回查退出码 1` + `WARN …本次的戳查不到：字体替换未生效` |

v1 measured "is it in the registry", not "did this run write it" — the same family as 15.18's "final state masks the process" and 15.16's "check satisfied by the empty set". v3's stamp is regenerated every run, so an old value can never match by luck; if the write fails the old value survives, so nothing regresses.

The stamp lives under `HKCU\Software\Wine\ExeOnMac` (launcher's own namespace), never touching Microsoft's key and never in a location any Windows application reads.

#### ⑤ Second real defect fixed: once a signal is delivered, the next child can no longer be stopped

Adding the read-back (one more `reg query`) turned 15.22's `TestSignalDuringStartupWindow` SIGTERM / SIGINT cases **red immediately**. The cause was not the read-back but the fact that "signal already delivered" was not part of the decision:

- `drainPending` clears `pending` on delivery and leaves only `deliveredSignal`;
- `runChild`'s pre-start guard only looked at `pending`, so after "delivered and stopped the previous child" it **let a new child start**;
- that signal was already spent and `signal(sig, SIG_IGN)` had swallowed the default disposition — nothing could ever stop the new child.

Fix: the guard in `runChild` and `run` became `pending != nil || deliveredSignal != nil`, and `late` now goes through `consumePendingSignal()` (which prefers `deliveredSignal`). **Another recurrence of "the same check only read half of its state"**: once the field was split in two, every reader had to change with it.

#### ⑥ Third: log noise I created myself, and found myself

`runChild` used `output != nil` to decide whether to write "wine 已启动". The new steps pass `FileHandle.nullDevice` (non-nil), so the log gained **three** such lines — a line that should appear exactly once, when the main program starts, appeared three times. `grep -c` gave 3 before and 1 after.

Replaced with an explicit `announce: Bool = false` parameter that only `WineRunner.run` sets to `true`. **The log is the only debugging trail; better an extra parameter than a log that lies.**

#### ⑦ Regression locks: 6 static guards, no wine needed

| Case | Criterion |
|---|---|
| `test_writes_export_format_header` | first line must be `Windows Registry Editor Version 5.00`; `WINE REGISTRY Version 2` only inside comments |
| `test_key_path_is_fully_qualified_and_single_escaped` | key must be fully qualified with single backslashes, sourced from the `keyPath` constant. **That round asserted `HKEY_CURRENT_USER`, which round 12 proved ineffective and changed to `HKEY_LOCAL_MACHINE`** (see 15.24 ⑦) |
| `test_single_source_for_key_path` | the key path literal appears exactly **once** in the file (§5.3 red line) |
| `test_import_is_verified_not_assumed` | after exit code 0 a read-back is mandatory, and it really runs `reg query` |
| `test_query_judged_on_this_run_not_leftovers` | a `UUID()` stamp must exist, stamp and font map must be in the **same** `.reg`, `stampPresent` must compare the stamp itself, and `reg delete` is forbidden |
| `test_announce_is_explicit_not_inferred_from_output` | an `announce` parameter must exist and `output != nil` must no longer decide logging |

#### ⑧ Negative verification (four injections, all effective)

| Injection | Result |
|---|---|
| first line back to `WINE REGISTRY Version 2` + double-backslash key | **2 red** (header + key path) |
| read-back removed (`else if false`) | **1 red** |
| the `clearSubstitutes(...)` call removed (v2-era guard) | **1 red** |
| "wine 已启动" back to `output != nil && !capture` | **1 red** |

6/6 green after restore. Behaviour was also verified end to end twice: injecting the internal format produced `fontsub 回查退出码 1` plus the WARN in the log; without injection the log read "fontsub 已导入 2 条替换" and a direct registry query showed the values.

#### ⑨ Still open

(a) Only the `HKCU` substitution path was tested; `HKLM` (system-wide substitution) was not — the launcher deliberately writes `HKCU` only (no admin rights needed), but "some software reads only HKLM" is unverified; (b) the actual on-screen rendering after substitution was never inspected by eye — this round proves the keys are written, not that Chinese text stops rendering as tofu; (c) the same pattern (export format mistaken for internal) was not swept across every other `.reg` write path in `exeonmac`; only `install.suppress_restart` (round 7) and this section were confirmed.

### 15.24 The `HKCU` copy of the font substitution has no reader at all: the keys land, the text stays tofu (measured 2026-11-21, fixed)

**This section handles 15.23 ⑨(b).** Section 15.23 fixed the format — the keys really do land and the stamp really is queryable — but it explicitly left one item open: "this proves the keys are written, not that Chinese text stops rendering as tofu." Following that thread led to a wrong **registry root**: 15.23 asked "does the write land?", this round asks "once it lands, does anything read it?"

#### ① Symptom: the log still says success, the font still does not change

The launcher fixed in 15.23, run against a real `.app`, logs cleanly:

```
fontsub 已导入 2 条替换
wine 已启动 pid=18519
```

Querying the same prefix directly, both `REG_SZ` values are present under `HKCU\Software\Microsoft\Windows NT\CurrentVersion\FontSubstitutes`. Every 15.23 criterion holds up to this point. But set `notepad.exe`'s `lfFaceName` to `Microsoft YaHei` and run with `WINEDEBUG=+font`:

| Observation point | Result |
|---|---|
| Is the mapping in the `dump_gdi_font_subst` list | **No** |
| Did `find_matching_face substituting` fire | **0 times** |
| What did `select_font Chosen` end up picking | **`Courier New`** (a font with no Chinese glyphs) |

The data is in the registry, it is not in GDI's substitution table, and the final face selection is unchanged. **That is the gap between "the key was written" and "the font took effect".**

#### ② Three-way comparison: only HKLM and wine's own key change the actual selection

Same base layer (382 MB), same wine-11.21, changing only the root key and the write location, each run using the real `notepad.exe` with `lfFaceName=Microsoft YaHei` preset:

| Group | Write location | Mapping in `dump_gdi_font_subst` | `substituting` | `select_font` picked |
|---|---|---|---|---|
| G | `HKCU\...\FontSubstitutes` | **No** | 0 times | `Courier New` (not substituted) |
| E | `HKLM\...\FontSubstitutes` | Yes | 1 time | **`PingFang SC Regular`** |
| F | `HKCU\Software\Wine\Fonts\Replacements` | Yes (via the alias path) | 0 times | **`PingFang SC Regular`** |

The `substituting` lines from the HKLM group:

```
00f8:trace:font:find_matching_face substituting L"Microsoft YaHei",1 -> L"PingFang SC",1
00f8:trace:font:select_font Chosen: L"PingFang SC Regular" (L"\\??\\Z:\\System\\Library\...\\PingFang.ttc"/0x0:3)
```

#### ③ Root cause: wine's font backend has exactly one registry path

It is not "HKCU has lower priority" — **no code reads it**. Scanning `lib/wine/x86_64-unix/win32u.so` for UTF-16 strings turns up only:

```
\Registry\Machine\Software\Microsoft\Windows NT\CurrentVersion\FontSubstitutes
```

`\Registry\User\` appears, but never combined with a `FontSubstitutes` entry. The HKCU copy is written and is genuinely registry data, but the consumer reads the Machine tree only. This is a **second, independent defect** from 15.23: 15.23 made the data land, this round makes it be read.

#### ④ Why not `HKCU\Software\Wine\Fonts\Replacements`

It works too (group F) and is the very key winecfg's own dialog writes. `FontSubstitutes` was still chosen, for semantic reasons:

- `FontSubstitutes` is Windows' own substitution semantics (when GDI cannot find a font, use the named one instead);
- `Wine\Fonts\Replacements` is an **alias** relation — the log shows `add_family_replacement mapping L"PingFang SC" to L"Microsoft YaHei"`, registering the macOS font under a Windows name in reverse. Any program that enumerates fonts sees an extra "Microsoft YaHei" that is actually PingFang.

The fewer places the compatibility layer lies to Windows programs, the better, so the former was taken. This is a **trade-off, not a measurement** — recorded here so a later round does not mistake it for a defect to "optimise".

#### ⑤ The stamp moved to HKLM too — otherwise the criterion degrades to "exists"

In 15.23 the stamp lives in `HKCU\Software\Wine\ExeOnMac`. After moving the mappings to HKLM this round, the gap showed immediately: the stamp stays in HKCU and the read-back still passes, but it only proves "regedit wrote this entry", not "it is in the tree GDI reads" — the same shape as 15.23 ④'s "tests existence, not effect", one layer down.

Fix: `stampKeyPath` becomes `HKEY_LOCAL_MACHINE\Software\Wine\ExeOnMac`, so mappings and stamp share **one `.reg` file, one root key, one consumer**. Microsoft's own key is still untouched, and no admin rights are needed (the write targets this prefix's `system.reg`, already a private clonefile copy).

Measured (fixed launcher + real `.app`, reading the files after `wineserver -w` flushes):

| File | YaHei | SimSun | Stamp |
|---|---|---|---|
| `system.reg` | **present** | **present** | **present** |
| `user.reg` | absent | absent | absent |

#### ⑥ The rendering layer finally has a machine criterion

15.23 ⑨(b)'s gap was "nobody looked at it with their own eyes", and eyeballing cannot go into CI. This round uses the `WINEDEBUG=+font` channel as a machine criterion — no screenshots, no human, and it reads GDI's actual decision:

| Criterion | Before (HKCU) | After (HKLM) |
|---|---|---|
| `dump_gdi_font_subst` contains this mapping | 0 entries | present |
| `find_matching_face substituting` fires | 0 | ≥1 |
| `select_font Chosen` is the target font | No (`Courier New`) | **Yes (`PingFang SC Regular`)** |

All three run headless (`notepad.exe` starts a process, but every criterion lives in the log). **Still not eyeballed**: whether individual strokes look right and whether any glyph is missing is the last mile of rendering quality, and a log cannot prove it.

#### ⑦ Regression guards: 6 → 7, and the old assertion itself was wrong

15.23's `test_key_path_is_fully_qualified_and_single_escaped` asserted `HKEY_CURRENT_USER` — **it baked the wrong conclusion into the assertion**, and it went red the moment this round changed the code. This is a recurring shape in this repository: the guard protects whatever the implementation happened to do, so when the implementation is wrong the guard is wrong with it.

| Case | Criterion | Change |
|---|---|---|
| `test_key_path_is_fully_qualified_and_single_escaped` | Key must be `HKEY_LOCAL_MACHINE\...` fully qualified with single backslashes | Expected value changed HKCU → HKLM, with the three-way table as rationale |
| `test_stamp_shares_the_root_the_consumer_reads` | Mappings and stamp must start with the **same root key**; the stamp must be its own subkey, never inside `FontSubstitutes` | **New** |

The new guard asserts "the two constants share a prefix" rather than repeating `HKLM`, so that if the whole tree ever moves, it moves with both constants instead of leaving half an old conclusion behind.

#### ⑧ Negative verification (two injections, both effective)

| Injection | Result |
|---|---|
| `keyPath` back to `HKEY_CURRENT_USER` | **2 red** (root-key assertion + same-root assertion) |
| Only `stampKeyPath` back to `HKEY_CURRENT_USER` | **1 red** (same-root assertion) |

7/7 green after restore.

#### ⑨ Still open

(a) Glyph quality never eyeballed — the evidence stops at "PingFang SC is selected", not "the strokes look right and nothing is missing"; (b) only `notepad.exe` was tested, and only with `lfFaceName` pointing at a substituted font — real software using DirectWrite instead of GDI may take another path (`dwrite.dll` contains no `FontSubstitutes` literal). **Settled by 15.25: it is indeed another path, and it only reads `HKCU\Software\Wine\Fonts\Replacements`, so the old fix had zero effect on it**; (c) whether an HKLM-level substitution still applies to software that keeps its own HKCU overrides is untested — this round verified "GDI reads HKLM", nothing about an application's own preferences; (d) 15.23 ⑨(c), a repo-wide sweep of the same `.reg` write pattern, remains undone.

### 15.25 DirectWrite does not read `FontSubstitutes` at all: GDI is fixed, modern software is still tofu (measured 2026-11-21, fixed)

**This section disposes of 15.24 ⑨(b).** 15.24 got the GDI path working (`select_font` really does pick PingFang), but left one sentence open: "real software using DirectWrite may take another path." This round settles it: **not "may" — it definitely takes another path, and the old one has no effect on it whatsoever.**

#### ① First, pin down who reads which key with a static scan

No guessing, no docs — scan the entire wine runtime (every ELF and PE under `lib/wine/`) and count which modules each key name appears in:

| Key name | Appears in | Encoding |
|---|---|---|
| `FontSubstitutes` | only `x86_64-unix/win32u.so` (GDI) | UTF-16 |
| `Software\Wine\Fonts\Replacements` | only `x86_64-windows/dwrite.dll` | **single-byte ANSI** |

`dwrite.dll` contains `FontSubstitutes` **not once**. The encoding difference is not a coincidence either: `win32u.so` goes through the wide-character API, while `dwrite.dll` goes through `RegOpenKeyA` (the ANSI version) — in the disassembly that call's root-key argument is `0x80000001`, i.e. `HKEY_CURRENT_USER`, with the key name pointing at `Software\Wine\Fonts\Replacements` in `.rdata`.

> The encoding difference tripped us up once this round: the first version of the guard scanned UTF-16 only, so `Replacements` — plainly present in the file — counted as zero hits. A criterion has to accept both encodings: the same key name is stored as ANSI by modules using the ANSI API and as UTF-16 by modules using the wide API, and both are real.

#### ② Runtime proof: hand-build a PE probe that uses DirectWrite only

A static scan proves "the string is in there", not "it actually decides the outcome". So we wrote a 4 KB probe: hand-rolled COM vtable calling `DWriteCreateFactory` → `GetSystemFontCollection` → `FindFamilyName`, **never touching GDI**. Cross-compiled to PE32+ with `clang-cl` + `lld-link`, run against real wine-11.21 plus the 382 MB base layer.

Same prefix, only the registry changes, six groups:

| Group | Written where | `familyCount` | Finds `Microsoft YaHei` |
|---|---|---|---|
| A | nothing written | 292 | **No** |
| B | `HKLM\...\FontSubstitutes` (15.24's fix) | 292 | **No** |
| C | `HKCU\Software\Wine\Fonts\Replacements` | **293** | **Yes** |
| D | `HKLM\Software\Wine\Fonts\Replacements` | 292 | **No** |
| E | `HKCU\...\Replacements`, key name in Chinese (`微软雅黑`) | **293** | Yes (Chinese names work too) |
| F | B + C both written | **293** | **Yes** |

Four conclusions, each from a separate measurement:

1. **`FontSubstitutes` has zero effect on DirectWrite** (group B, still 292). 15.24's fix only repaired half the picture.
2. **The root key must be `HKCU`** (C works / D does not). Exactly the opposite of GDI's requirement — the two paths use different roots, and this is the easiest thing to get wrong this round.
3. **The two keys coexist without interfering** (group F). So the correct move is to write both, not pick one.
4. **Chinese key names work too** (group E). `font_map` does not need to translate 微软雅黑 into an English name.

#### ③ Why 15.24 explicitly rejected `Replacements`, and why this round uses it anyway

15.24 ④'s reasoning was: "`Replacements` has alias semantics (it registers PingFang backwards as Microsoft YaHei), so programs that enumerate fonts see an extra 'Microsoft YaHei'. The less the compatibility layer lies to Windows programs, the better."

**That trade-off assumed "both paths work; pick the one with cleaner semantics."** This round's measurements overturn the premise: for DirectWrite, `FontSubstitutes` is not a path at all. The cost of skipping `Replacements` is not "slightly worse semantics" but **every DirectWrite program rendering Chinese as tofu, permanently**.

So now we write both: GDI gets real substitution semantics (`FontSubstitutes`), DirectWrite gets the only key it recognises (`Replacements`). The alias side effect (`add_family_replacement mapping L"PingFang SC" to L"Microsoft YaHei"`) has to be accepted — the alternative is no substitution at all.

#### ④ The stamp moves back to HKCU, and the criterion's wording changes with it

15.24 moved the stamp to HKLM, reasoning "same root as the consumer". This round adds a second consumer (DirectWrite reads HKCU only), and the stamp can live in one place. We chose `HKCU`: same root as `replacePath`, and `HKCU\Software\Wine` is wine's own namespace, entirely invisible to Windows software.

The guard `test_stamp_shares_the_root_the_consumer_reads` now asserts "the stamp shares the root with `replacePath`", plus a new assertion that "the two font paths must have different roots". **The criterion itself did not change** (the stamp must live in a tree some real consumer reads); what changed is *which* consumer — which is precisely why `HKLM`/`HKCU` must not be hard-coded into the assertion: the moment it is, the next person moves the constant to make the test green instead of asking who is actually reading.

#### ⑤ End to end: both keys must really land on disk

A static guard only ensures "these two lines exist in the code". So `TestRealLaunch` gained a segment: after SIGTERM, read the prefix's `system.reg` and `user.reg` and assert both keys and both mapping values are present.

**That assertion went red twice this round, and neither was a product defect:**

| Version | Approach | Result |
|---|---|---|
| v1 | read the file right after "wine started" | red — the registry is still in memory, not on disk |
| v2 | `wineserver -w` first, then read | **still red** — `-w` only means "wait for wineserver to exit", and it stays alive as a service after the launcher exits, waiting out the timeout; only `-k` triggers the write-back |
| v3 | `wineserver -k` + poll until `Replacements` appears | green |

Comparative measurement: after `-w`, `Replacements` hits **0** times in `user.reg`; after `-k`, **1** time. Worth recording: **between "the log says success" and "the disk says so" lies a write-back, and reading the file at any point in between is not evidence.**

#### ⑥ Regression locks: +3, two of which guard runtime facts

| Test | What it guards |
|---|---|
| `test_both_font_paths_written_in_one_file` | both keys must be in the same `.reg`; exactly one text is generated; both share the same fonts mapping |
| `test_font_substitutes_is_read_by_gdi_only` | **scans the real runtime**: `FontSubstitutes` must hit `win32u.so` and must hit no dwrite module |
| `test_replacements_is_read_by_dwrite` | **scans the real runtime**: `Replacements` must hit dwrite |

The last two guard not code but **facts about the runtime**. The day wine is upgraded and upstream wires `FontSubstitutes` into DirectWrite as well, they go red on their own — instead of leaving a stale conclusion behind to keep misleading people. Tests of this "guarding an environment fact" shape appear here for the first time in this repository.

#### ⑦ Negative verification (four injections, all effective)

| Injection | Result |
|---|---|
| Delete the `Replacements` write block | **1 red** (two-keys guard) |
| Change `replacePath`'s root back to `HKLM` | **1 red** (same-root guard) |
| Merge both keys into one loop (writing only one) | **1 red** (two-keys guard) |
| Delete the `Replacements` write, then run end to end | **1 red** (`Replacements` missing from `user.reg`) |

All green after restore.

#### ⑧ Still open

(a) **Glyph quality still not eyeballed** — 15.24 got to "PingFang is selected", this round to "DirectWrite recognises that name too", but "the strokes look right and nothing is missing" remains a human judgement; (b) DirectWrite's actual rendering result (which face it falls back to) is unverified — this round only verified that the family name resolves; (c) only `Microsoft YaHei` was tested, other families (SimSun, SimHei) were not checked one by one; (d) the probe page-faults when reading `GetFamilyNames` (the family name strings), so only the `FindFamilyName` layer was taken — a fragile spot in hand-rolled COM vtables, which does not affect the conclusion (`exists` and `familyCount` are both decisive), but the "which family name did it resolve to" layer was not captured.


---

## 16. Changelog

The changelog is maintained on the **GitHub Releases** page: <https://github.com/ntars/Wacmin/releases>

The README describes the project's current state; releases record what changed each time. The two are not mixed.

**Current state**: all four directions are established and wired into the contract. Mac2Win, ExeOnMac and Win2Mac are complete and can genuinely produce artefacts; AppOnWin is at the compatibility-assessment stage, with execution capability pending the spike verdict. All four AI integration forms (MCP server / unified CLI / Skill / expert package) are in place. Per-module test counts and durations are consolidated in section 12.1 and are not repeated here.

---

## 17. Roadmap

Ordered by determinism; each item presupposes the one before it.

| Order | Item | Status | Note |
|---|---|---|---|
| 1 | Mac2Win wrap-up | Complete | Packaging, verification and the graphical interface all landed; now in maintenance |
| 2 | ExeOnMac's five phases | Complete | Detection, extraction, prefix, silent installation, `.app` wrapping, layering and the recipe library all landed |
| 3 | Win2Mac assembly packaging | Complete | Permission-preserving zip writer, plist generation and verification |
| 4 | AppOnWin execution capability | **Environment unavailable** | Measured 2026-11-19: gates 1 and 2 `blocked` because the host is not Windows, gate 3 passes, overall `unverified` / exit code 5. Neither a pass nor a refutation; needs a re-run on Windows + WSL2 + Darling — see 3.4 and 5.1.2 |
| 5 | console's full dashboard | Done | Unified entry (CLI + web), history persistence and progress push are all in place; across three viewports (375 / 768 / 1440) `console/scripts/viewport-check.mjs` measures no overflow, with a reproducible negative check |
| 6 | Tauri Rust shell end-to-end verification | **Partially holds** | Measured 2026-11-19: both the Rust chain and tauri 2.12.7's entire dependency tree compile to `PE32/i386` on arm64 macOS (`linkprobe.exe`, 1096192 bytes). A complete project blocks on `llvm-rc`, which `tauri-winres` needs for the resource section and which is not installed here; `brew install llvm` provides it. This is **not** an architecture limit, and **not** a "must switch to a Windows machine" situation. See 15.10 |
| 7 | Code signing support | **Assessed (2026-11-19)** | Verdict: feasible, and no Windows machine required—`osslsigncode` signs PE locally. The bottleneck is the certificate and hardware token. **Also found the current ExeOnMac artefacts carry an inconsistent signature** (`codesign -v` exits 1), unfixable by signing because the prefix lives inside the bundle. See 15.11; decision pending human input |
| 8 | macOS-side signing and notarisation | **Assessed (2026-11-19)** | Verdict: Win2Mac feasible, needs an Apple Developer ID ($99/yr) plus four notarisation prerequisites; **ExeOnMac infeasible under the current layout**—the prefix is written in place inside the bundle, so any signature is broken. See 15.11; decision pending human input |
| 9 | Extended automatic layer builds | Done (2026-11-19) | base / dotnet / fonts-cn build automatically; mfc has no lawful source and vcpp is already in base |
| 10 | AI integration layer | Complete | All four forms landed—MCP server, unified CLI, Skill and expert package; the protocol layer is dependency-free and self-implemented |

**Not on the roadmap** (explicitly excluded): a self-developed PE loader, FEX integration, an API semantic mapping layer, macFUSE / kext / system extensions, game-launcher business logic, cloud desktops, and **a built-in LLM or any wrapped model call**. The purpose of `ai/` is to hand this repository's capabilities to external AI, not to turn the project into an AI tool itself.

---

## 18. Contributing

### 18.1 Four Rules of Discipline

1. **Exit codes are append-only; meanings never change.** Once published, changing a code value breaks every dependent script.
2. **Error-code segments never cross boundaries.** `4xxx` always means input-artefact handling and does not change meaning for any direction's convenience.
3. **stdout carries only JSON when `--json` / `--report` is set.** Logs always go to stderr.
4. **Help text must match the parser.** Three things must hold: every option in help is accepted by the parser, every option accepted by the parser is documented in help, and a misspelt subcommand reports an explicit error rather than being treated as a path. Each is guarded by tests (in the three Node directions `test/help.test.mjs`; for ExeOnMac, `TestCLIContract` in `tests/test_phase0.py` plus `test_phase6.py`), because such divergence does not crash—it only wastes time. Concrete instances are in section 15.3.

### 18.2 Pre-Commit Checks

```bash
# Contract self-check (mandatory)
node contracts/validate.mjs

# Documentation-number self-check (mandatory). One command guards two things:
# the 12.1 test counts, and the eight hand-counted numbers in Appendix C
# (37 configuration keys, 13 environment variables, 18 external tools,
# 6 subcommand families, 25 highlights, 11 sections in chapter 5, 13 NOTICE
# chapters, 11 artifact checks). The latter had no guard at all before
# 2026-11-20 — changing "37 configuration keys" to 32 still printed
# "✓ counts consistent" under the old version.
node contracts/doc-counts.mjs --check

# Each direction's own tests. Every line is wrapped in a subshell so the working
# directory returns to the repository root afterwards — otherwise, after the
# first line cds into mac2win/, the next `cd exeonmac` resolves against
# mac2win/exeonmac and fails with No such file or directory (reproduced in a
# clean clone on 2026-11-20).
(cd mac2win  && npm test)
(cd exeonmac && python3 -m unittest discover -s tests)
(cd win2mac  && npm test)
(cd apponwin && npm test)
(cd console  && npm test)
(cd ai       && npm test)

# Real-invocation contract compliance check (must still run from the repo root)
node console/bin/wacmin-console.mjs contract
```

Under `set -e` the subshell failures propagate normally, so no extra handling is needed. To run a single direction, `cd <direction> && npm test` works as before.

**The `ai` tests must also pass on ubuntu** (that is how CI runs them). If a new case depends on `darwin` or on an external tool, skip it conditionally rather than letting it turn red—the `ai` layer tests the dispatch path and protocol correctness, not any platform's packaging capability.

### 18.3 Requirements for Adding Third-Party Components

Any newly added third-party library, framework, font, icon or algorithm source must be registered first: **name, version, copyright holder, licence type, official address, purpose in this project, and whether and how it was modified**, with chapter 6 of `README.md` and `NOTICE` updated accordingly.

**Components whose licence cannot be determined must be marked "to be confirmed" and withheld from merging. Defaults and fabrications are not acceptable.**

The project currently has zero third-party package dependencies; this requirement exists to keep it that way, and is not a formality.

### 18.4 How Tests Are Organised

Tests live alongside the implementation; there is no separate `test` branch or standalone test project.

| Direction | Framework | Location |
|---|---|---|
| Mac2Win / Win2Mac / AppOnWin / console | `node:test` (Node built-in) | `<direction>/test/*.test.mjs` |
| ExeOnMac | `unittest` (Python standard library) | `exeonmac/tests/test_*.py` |

**No test-framework dependency is introduced**, consistent with the zero-third-party-dependency principle. `node --test` and `python3 -m unittest discover` are sufficient.

**Skip rather than fake**: tests requiring real Wine / 7z / innoextract / swiftc explicitly `skip` when the environment lacks them, and the test name states what is missing. Assertions never contain conditional passes such as "if the environment supports this then…"—that is not a test, it is documentation.

### 18.5 Keeping Documentation in Sync with Code

Changing code means changing documentation, in the same commit. Specific requirements:

| Change type | Locations that must be updated |
|---|---|
| Adding/removing an exit code | `contracts/exit-codes.json`, section 5.2.1 of this file |
| Adding/removing an error code | The direction's `errors` module, `contracts/error-prefixes.json`, section 5.2.2 |
| Changing the report structure | `contracts/run-report.schema.json`, section 10.2, and increment `schemaVersion` |
| Adding a configuration key | That direction's configuration validation, section 9.2 |
| Adding an environment variable | Section 9.3 |
| Adding a subcommand or option | That direction's help, `test/help.test.mjs`, section 10.1 |
| Changing verification checks | That direction's implementation, sections 3.1 and 15.5 |
| Adding an external dependency | Chapter 6 and `NOTICE` |

### 18.6 How to Write Commit Messages

Following the existing history style: **one sentence stating what changed, never "fixed some issues"**.

```
Drive the incomplete-verification message from report.blockers
7-Zip: an explicitly specified path is no longer silently skipped
doctor: no longer reports a working 7-Zip as missing, and puts per-item results into JSON
```

Format: `scope: what changed`. The scope may be a subproject (`mac2win` / `wepack` / `console`), a module (`doctor` / `verify`) or a component (`7-Zip` / `NSIS`). A colon separates scope from description.

### 18.7 Viewing History

Each subproject's full commit history is preserved in its subdirectory:

```bash
git log --oneline -- mac2win/
git log --oneline -- exeonmac/
git log --oneline -- console/
```

### 18.8 Contact

| Channel | Address |
|---|---|
| Repository | <https://github.com/ntars/Wacmin> |
| Issue tracker | <https://github.com/ntars/Wacmin/issues> |
| Email | <ntars@qq.com> · <ntarsx@163.com> |

---

## 19. Copyright and License

Copyright (c) 2026 Ntarstudio (Xingjiu Studio)

This project is licensed per directory, using **only Apache License 2.0 and MIT** — both permissive. Full texts live in [LICENSE](./LICENSE) (Apache-2.0) and [LICENSE-MIT](./LICENSE-MIT) (MIT); the layer map is in [LICENSING.md](./LICENSING.md).

| Scope | Licence |
|---|---|
| `contracts/` (shared contract layer) | **Apache-2.0** |
| `console/` `mac2win/` `exeonmac/` `win2mac/` `apponwin/` `ai/` `docs/` | MIT |
| Brand name, logo, interface design | All rights reserved |

**Why the contract layer alone is Apache-2.0.** The readers of `contracts/` are not users of this project but third parties implementing against the contract. Apache-2.0 adds two things MIT does not: an express patent grant (Section 3) and the NOTICE retention obligation (Section 4d) — the latter matters most for files that get passed around.

Redistribution requires only retaining the copyright notice, the licence texts and the [NOTICE](./NOTICE).

**Names and trademarks.** Names and marks such as "Ntarstudio", "星玖工作室" and "Wacmin" belong to 星玖工作室. The code licences grant rights to code, not to trademarks.

**Third-party names.** Names appearing in this documentation—Wine, Darling, Rosetta 2, NSIS, 7-Zip, Electron, NW.js, Tauri, Node.js, Gcenx, Darling and others—belong to their respective owners and are used only to describe dependencies and compatibility targets.

**No warranty.** This program is provided "as is" under the Apache-2.0 and MIT terms, without any express or implied warranty.

---

## 20. NOTICE and Open-Source Compliance

### 20.1 Where Statements Live

The project uses a **single statement**: all third-party components, licence obligations and warranty disclaimers are consolidated in [`NOTICE`](./NOTICE) at the repository root. No subdirectory retains a separate NOTICE file.

| File | Coverage |
|---|---|
| [`NOTICE`](./NOTICE) | Whole repository: the project's own licence, external tools, bundled runtimes, indirect dependencies, referenced projects, technology explicitly not used, fonts and icons, full warranty disclaimer, licence-text index, process for adding components |

The reasoning is in section 1.1: the three NOTICE files overlapped heavily, writing the same 7-Zip entry five times, and once maintained separately there is a persistent risk that one copy is left unamended.

### 20.2 Global Dependency Quick Reference

Complete information (version, copyright holder, licence, official address, purpose, whether modified) appears in sections 6.2 and 6.3 of this file and in the itemised entries of `NOTICE`.

| Component | Licence | Role in this project |
|---|---|---|
| NSIS | zlib/libpng | Build-time invocation, compiles install scripts |
| 7-Zip | LGPL-2.1-or-later + unRAR restriction | Build-time and verification-time invocation |
| Wine | LGPL-2.1-or-later | ExeOnMac runtime invocation |
| Gcenx macOS_Wine_builds | LGPL-2.1-or-later | Source of the Wine prebuilt |
| Rosetta 2 | System component (not open source) | Instruction translation on Apple Silicon |
| innoextract | zlib License | Optional, extracts Inno Setup |
| msitools | LGPL-2.1-or-later | Optional, extracts MSI |
| Darling | LGPL-2.1-or-later (includes GPL components) | AppOnWin assessment target |
| Node.js / Electron / NW.js | MIT | Framework runtimes bundled into artefacts |
| Tauri | MIT / Apache-2.0 | Used by target projects; this project bundles no runtime for it |

### 20.3 Obtaining Licence Texts

| Licence | Address |
|---|---|
| Apache-2.0 / MIT | See [LICENSE](./LICENSE) |
| LGPL-2.1-or-later | <https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html> |
| zlib License | <https://opensource.org/license/zlib> |
| unRAR license | <https://www.rarlab.com/license.htm> |
| Apache-2.0 | <https://www.apache.org/licenses/LICENSE-2.0> |

If any of these links becomes unavailable, consult <https://www.gnu.org/licenses/> or the respective project's official repository.

### 20.4 Redistribution Obligations Summary

This project **does not distribute** the binaries of 7-Zip, Wine, NSIS, innoextract, msitools, Rosetta 2 or Darling. It only invokes versions installed by the user as separate processes, and therefore **does not trigger** LGPL source-provision obligations.

This project **does distribute** the Node.js, Electron and NW.js runtimes (bundled into artefacts). All three are MIT, so the obligation is limited to retaining the original copyright notice and licence text; installers produced should include the corresponding `LICENSE` files, or provide accessible licence text in the installer wizard or an about page.

If a user or third party bundles the non-distributed tools above together with this project's artefacts into a single installer and redistributes it, the LGPL source-provision obligation is triggered: the complete source of the affected components must be supplied, or a written offer of source availability valid for no less than three years must be provided, together with all copyright notices and licence texts.

### 20.5 Requirements for Registering Third-Party Components

Any newly added third-party library, framework, font, icon or algorithm source must be registered first: **name, version, copyright holder, licence type, official address, purpose in this project, and whether and how it was modified**, with chapter 6 of this document and `NOTICE` updated accordingly.

**Components whose licence cannot be determined must be marked "to be confirmed" and withheld from merging. Defaults and fabrications are not acceptable.**

---

## Appendix A: Exit Code and Error Code Reference

Arranged by segment. Prefixes: `M2W` (Mac2Win), `EOM` (ExeOnMac), `AOW` (AppOnWin), `W2M` (Win2Mac).

### A.1 Segment-to-Exit-Code Pairing

| Exit code | Meaning | Paired error-code segment |
|---|---|---|
| 1 | Unclassified failure | `9999` |
| 2 | Parameter and input error | `1002` / `1003` / `1004` |
| 3 | Capability not implemented | `7001` |
| 4 | Explicitly unsupported | `1005` |
| 5 | Missing external dependency | `2001` / `2002` |
| 6 | Build or installation failure | `4001`–`5002` |
| 7 | Artefact verification failure | `6001`–`6003` |
| 130 | User interruption | `9001` |

### A.2 Common Error Codes

| Code | Meaning | Suggested action |
|---|---|---|
| `M2W_1002` | Project directory does not exist | Check the path |
| `M2W_1003` | Invalid configuration value | Fix per the message; note that an unusable `MAC2WIN_7ZIP` path also reports this code |
| `M2W_1004` | Input artefact unusable | Check that the file is intact |
| `M2W_1005` | Explicitly unsupported (e.g. native modules, Electron ≥ 44) | Change the input; retrying is pointless |
| `M2W_2001` | makensis / 7-Zip missing | `brew install makensis sevenzip` |
| `M2W_2002` | External tool unusable | Check the path reported by `doctor` |
| `M2W_3001` | Runtime download failed | Check the network; or point `runtimeArchive` at a local file |
| `M2W_3002` | Runtime checksum mismatch | Delete the cache and re-download, or check `runtimeChecksum` |
| `M2W_4001` | Project build command failed | Run `npm run build` manually in a terminal first |
| `M2W_4003` | Native module present | Switch to a pure-JS alternative (the error names the package) |
| `M2W_5002` | NSIS compilation failed | Use `--keep-staging`, then run `makensis` manually |
| `M2W_6001` | Artefact verification failed | **Do not distribute.** The log lists item-by-item results |
| `M2W_6002` | Required file missing when verifying an existing installer | The artefact is incomplete |
| `M2W_6003` | Per-file hash mismatch | Corruption during compression or extraction |
| `EOM_1005` | Explicitly unsupported software category | See 14.5; no bypass attempted |
| `EOM_2001` | Wine runtime missing | `wepack runtime install` |
| `EOM_6001` | `.app` artefact verification failed | See the verification rules in 11.2 |
| `W2M_1005` | Input artefact unusable | Check the `.app` structure and executable |
| `AOW_1005` | Explicitly unsupported framework | See the framework list in 3.4 |
| `9999` | Internal error | File an issue with the complete log |

**The complete list is authoritative in `contracts/error-prefixes.json` and each direction's `errors` module.** The table above covers common entries only.

---

## Appendix B: GitHub Push Guide

This appendix provides the complete executable commands, checklists and failure fallbacks required by chapter 6 of `README提示词.md`. **Back up before executing anything.**

### B.1 Backup (Step One, Not Optional)

```bash
# Full repository backup (including .git); the empty-directory argument prevents nesting
BK=~/Wacmin-backup-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BK"
ditto /Users/ntars/Github/Wacmin "$BK/Wacmin"

# Confirm the backup is complete
du -sh "$BK/Wacmin"
ls -a "$BK/Wacmin"
```

`ditto` is used rather than `cp -R` because it preserves extended attributes and resource forks completely; `cp -R` on macOS can lose some metadata.

**To back up only the working tree without history**:

```bash
cd /Users/ntars/Github/Wacmin
git archive --format=tar.gz -o "$BK/wacmin-worktree.tar.gz" HEAD
```

### B.2 Cleanup and Verification (Mandatory Before Pushing)

```bash
cd /Users/ntars/Github/Wacmin

# 1. Confirm the current branch and remote
git branch --show-current          # expect main
git remote -v                      # expect origin pointing at ntars/Wacmin

# 2. Working tree status: there should be no untracked temporary files
git status --short

# 3. Change list relative to HEAD: confirm every entry is intentional
git diff --name-status HEAD

# 4. File count and list that will enter the commit
git ls-files | wc -l
git ls-files

# 5. Confirm there are no large files (threshold 5 MB)
git ls-files -z | xargs -0 -I{} sh -c 'test -f "{}" && sz=$(stat -f%z "{}") && [ "$sz" -gt 5242880 ] && echo "$sz {}"' 2>/dev/null | sort -rn

# 6. Confirm no macOS junk files entered the index
git ls-files | grep -E '(^|/)\.DS_Store$|(^|/)\._[^/]*$|(^|/)__MACOSX/' || echo "no junk files"
```

**Verification checklist** (confirm each item):

| # | Check | Expected result |
|---|---|---|
| 1 | `git status --short` | Only this change's intentional files, nothing else |
| 2 | `git diff --name-status HEAD` | Every `D` entry is a document this change deletes; every `A` entry is a file this change adds |
| 3 | `git ls-files '*.md'` | Exactly 5: root `README.md` / `README_EN.md`, the layered-licensing note `LICENSING.md`, and two Skill / expert-pack definitions at `ai/experts/wacmin-expert.md` and `ai/skills/wacmin/SKILL.md`. **The last three are product content, not documentation clutter** |
| 4 | Licence files in `git ls-files` | Exactly 3: `LICENSE` (Apache-2.0), `LICENSE-MIT`, `NOTICE` |
| 5 | Large-file scan | No output, or only explainable test fixtures |
| 6 | macOS junk files | "no junk files" |
| 7 | `.gitignore` coverage | `.DS_Store`, `node_modules/`, `dist*/`, `*.log` all present |

Items 3 and 4 previously said "only `README.md` and `README_EN.md`" and "only `LICENSE` and `NOTICE`" — both disagreed with the actual index (measured 2026-11-20: 5 Markdown files, 3 licence files). Anyone following the old checklist would have deleted three legitimate files as "documents that should not be committed". Whenever a checklist states a closed claim like "only N files", count it with `git ls-files` first and then write the number.

### B.3 Commit and Push

```bash
cd /Users/ntars/Github/Wacmin

# 1. Stage everything (-A records deletions)
git add -A

# 2. Confirm the staged content once more
git status --short
git diff --cached --stat

# 3. Commit
git commit -m "Consolidate documentation at the repository root; remove subdirectory README / LICENSE / NOTICE, correct check counts and test sizes"

# 4. Push
git push origin main
```

**If the remote has history the local copy lacks** (for example someone else committed), rebase first:

```bash
git pull --rebase origin main
git push origin main
```

**If the remote content is entirely obsolete and needs a full refresh** (only for personal repositories with no collaborators):

```bash
# Risk warning: this discards all remote commits and is unrecoverable
# The backup in B.1 must already be complete before executing
git push --force-with-lease origin main
```

`--force-with-lease` rather than `--force`: the former refuses to push when the remote has been updated by someone else, avoiding overwriting their work.

### B.4 Post-Push Verification

```bash
# The remote branch matches the local one
git ls-remote origin main
git rev-parse HEAD

# Remote file list (requires an authenticated gh)
gh api "repos/ntars/Wacmin/git/trees/main?recursive=1" --jq '.tree[].path' | grep -E '\.(md)$'

# Expect only README.md and README_EN.md
```

Browser-side check: open <https://github.com/ntars/Wacmin> and confirm the root holds only the four expected documents and that no subdirectory still contains `README.md` / `LICENSE` / `NOTICE`.

### B.5 Failure Fallbacks

| Error | Cause | Alternative |
|---|---|---|
| `remote: Permission to ntars/Wacmin.git denied` | Expired HTTPS credentials or insufficient rights | ① `gh auth login` then retry; ② switch to SSH: `git remote set-url origin git@github.com:ntars/Wacmin.git`; ③ check that `git config user.email` belongs to an account with access |
| `fatal: unable to access ... Could not resolve host` | Network or proxy | ① Check the proxy: `git config --get http.proxy`; ② temporarily set `git config --global http.proxy http://127.0.0.1:PORT`; ③ change networks |
| `RPC failed; curl 56 ... unexpected disconnect` | Transfer too large in one go | `git config --global http.postBuffer 524288000`; or `git config --global http.version HTTP/1.1`; or push in smaller batches |
| `remote: error: GH001: Large files detected` | A file exceeds 100 MB | ① Remove it from the commit: `git rm --cached <file>` then `git commit --amend`; ② if already in history, `git filter-repo --path <file> --invert-paths`; ③ if it must be kept, enable Git LFS |
| `error: src refspec main does not match any` | The local branch is not named `main` | `git branch -M main` then push again |
| Filename case change has no effect | Git is case-insensitive | `git mv Readme.md README.md` (two steps: rename to a temporary name first), or set `git config core.ignorecase false` and rename |
| `! [rejected] main -> main (non-fast-forward)` | The remote has new commits | ① `git pull --rebase origin main` then push; ② when the remote content is confirmed obsolete, `git push --force-with-lease` |
| `fatal: refusing to merge unrelated histories` | Local and remote histories are unrelated | `git pull --allow-unrelated-histories origin main`, resolve conflicts, then push |
| `Updates were rejected because the tag already exists` | Tag conflict | `git tag -d <tag>` and re-tag, or `git push --force origin <tag>` (only when the old tag is confirmed obsolete) |
| Push succeeds but the web page shows no change | CDN cache or wrong branch | ① Confirm the branch: `git branch --show-current`; ② hard-refresh the page; ③ `gh api repos/ntars/Wacmin --jq .default_branch` to confirm the default branch |
| `gh: command not found` | GitHub CLI not installed | `brew install gh`, then `gh auth login` |
| SSH reports `Permission denied (publickey)` | No key configured | `ssh-keygen -t ed25519 -C "your@email"` → `gh ssh-key add ~/.ssh/id_ed25519.pub` → verify with `ssh -T git@github.com` |

### B.6 Recreating the Remote Repository (Last Resort)

Use only when pushes fail repeatedly and the remote content is confirmed fully disposable.

```bash
# Risk: deleting the remote also deletes Issues, PRs, Releases, Wiki and Actions records
# The backup in B.1 must be complete, and Issues and Releases exported

# Option 1: GitHub CLI
gh repo delete ntars/Wacmin --yes
gh repo create ntars/Wacmin --public --description "Bidirectional application interoperability suite for macOS and Windows"
git remote set-url origin git@github.com:ntars/Wacmin.git
git push -u origin main

# Option 2: the web UI
# 1. Open https://github.com/ntars/Wacmin/settings
# 2. Scroll to the bottom, Danger Zone → Delete this repository
# 3. Create a new repository, still named Wacmin, with no initialisation files
# 4. Return to the local repository and run the set-url and push commands above
```

**This step destroys all collaboration records.** Use it only for a personal repository with no collaborators, after backing up.

---

## Appendix C: Self-Check Checklist

Responding item by item to the ten requirements in chapter 5 of `README提示词.md`.

| # | Check | Conclusion |
|---|---|---|
| 1 | Any colloquialisms or ambiguous sentences | Checked. The whole document is written in formal prose, free of exclamation marks and ellipsis-driven casualness; terms are defined at first use |
| 2 | Core features, configuration keys or dependencies omitted | Completed. Full table of 37 configuration keys (9.2), 13 environment variables (9.3), 18 external tools with all seven attributes (6.2), 6 subcommand families (10.1). Counts verified against `DEFAULTS` in `mac2win/src/core/config.mjs` (37 keys), `NOTICE` chapter 3 (18 rows) and the 10.1 table (6 rows) |
| 3 | Every highlight has concrete evidence | All twenty-five highlights follow the five-part structure (name / value / implementation / differentiation / evidence), with evidence drawn from measurement or reproducible commands |
| 4 | All design details recorded | Chapter 5, eleven sections, covering abnormal input and boundaries, timeout/retry/degradation/fault tolerance, caching and performance, concurrency and consistency, storage optimisation, security measures, micro UX decisions, default-value rationale, cross-platform strategy |
| 5 | Third-party projects, copyright and licences fully present in README and NOTICE | Chapter 6 plus the thirteen sections of `NOTICE`, consistent between the two |
| 6 | Description consistent with actual features and directory structure | Directory structure (11.1) written from the actual `ls` output; test sizes (12.1) match measured output; check counts (15.6) distinguish the measured 11 from 10 |
| 7 | Any text, code or assets of unknown or unauthorised origin | None. All code is original; referenced projects are itemised in `NOTICE` section 7 with an explicit statement that no code was copied |
| 8 | Both own copyright protected and others' respected | Chapter 19 states own copyright and trademarks; `NOTICE` states others' copyright and redistribution obligations |
| 9 | `README_EN.md` synchronised with the Chinese version, language links at the top of both | Yes. Section headings correspond one-to-one; both link to each other at the top |
| 10 | Legal text in `NOTICE` retains the English original and matches the README | Yes. The MIT warranty disclaimer is retained verbatim in English; the dependency list matches chapter 6 |

---

**Last updated**: 2026-11-15 · reflecting the repository's current `main` branch
