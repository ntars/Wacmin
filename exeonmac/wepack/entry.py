"""在 prefix 里定位主程序入口。

## 为什么单独成一个模块

这套判据原本只活在 `cli._find_installed_entry` 里，`package` 阶段为了
「没有 compat.yaml 时也能装配」又写了一份 `_guess_entry`。两份判据长得
不一样，结论也就不一样：

    install   → drive_c/Wacmin/w02/W02Probe.exe   （对）
    package   → drive_c/Program Files/Windows NT/Accessories/wordpad.exe

`install` 那侧有 Wacmin 优先、按产品名认领子目录、兜底要过名字相关性
三道闸；`package` 那侧只有「在 Program Files 下挑打分最高的 exe」。
base 层自带 `wordpad.exe`（55 分），而用户程序在 `C:\\Wacmin\\` 下根本
不在它的搜索范围内 —— 于是装什么软件，打包出来都指向写字板。

仓库根 README.md 第 5.3 节把这事定成红线：同一件事的判断逻辑只能有
一处实现。所以判据搬到这里，`cli` 与 `package` 都调这一份。

## 搜索顺序（按「最可能是本次安装产物」排序）

    0. C:\\Wacmin\\<产品目录>      本工具的默认安装位置
    1. Program Files\\<产品目录>
    2. Program Files (x86)\\<产品目录>
    3. AppData\\Local\\<产品目录>   Electron/Squirrel 类安装器会忽略 /D=
    4. 以上各根的全盘兜底（必须过文件名相关性闸门）

找不到返回 None，由调用方提示用户用 `--entry` 手工指定 —— 不猜。
"""

from __future__ import annotations

import re
from pathlib import Path


def name_tokens(name: str) -> list[str]:
    """把名字切成小写词序列，只保留字母数字。

    `7-Zip 24.08` → `['7', 'zip', '24', '08']`，`Notepad++` → `['notepad']`，
    `Node.js` → `['node', 'js']`。用于按**词**而不是按字符比对名字。
    """
    return [t for t in re.split(r"[^0-9a-z]+", name.lower()) if t]


def contains_token_run(haystack: list[str], needle: list[str]) -> bool:
    """needle 是否作为**连续子序列**出现在 haystack 里。

    不是字符串子串 —— `['mode']` 不出现在 `['modem']` 里，因为词已经切
    开了。这正是要的效果：`Modem` 这个目录名不该被产品名 `mode` 认领。
    """
    span = len(needle)
    if span == 0 or span > len(haystack):
        return False
    return any(haystack[i:i + span] == needle
               for i in range(len(haystack) - span + 1))


def names_relate(name: str, keywords: set[str]) -> bool:
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
    dir_tokens = name_tokens(name)
    if not dir_tokens:
        return False
    for keyword in keywords:
        key_tokens = name_tokens(keyword)
        if not key_tokens:
            continue
        if (contains_token_run(dir_tokens, key_tokens)
                or contains_token_run(key_tokens, dir_tokens)):
            return True
    return False


def filename_relates_to_product(relpath: str, product: str) -> bool:
    """文件名（去后缀）是否与产品名有关。无关时兜底不该认它。

    ## 为什么兜底需要这道闸

    `rank_candidates` 的产品名匹配只值 +35 分。整层扫描时「在 Program
    Files 下 +25」「GUI +20」「有图标 +10」加起来就 55 分，足以让一个
    毫不相关的残留程序排到第一。实测在 base 层的 `Program Files/` 下分别
    搜 `Notepad`、`TotallyDifferentApp`、`Zzzz`，三次返回的都是同一个
    `Windows NT/Accessories/wordpad.exe` —— 产品名对兜底结果毫无影响。

    这条在端到端流程里真实发生过：装 `W02Probe` 到 `C:\\Wacmin\\w02\\`，
    `package` 阶段的裸打分把入口定成了 wordpad.exe。

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

    相等永远接受，不受此限。

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


def find_installed_entry(private_dir: Path, detection, app_name: str) -> str | None:
    """在安装后的 prefix 里找主 exe，返回相对 private_dir 的路径。

    搜索顺序见模块文档。`detection` 只需要有 `product_name` 属性
    （`Detection` 或任何鸭子类型对象）。

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

    product = (getattr(detection, "product_name", None) or app_name or "").strip()
    keywords = {app_name.lower()} if app_name else set()
    if product:
        keywords.add(product.lower())
    keywords = {k for k in keywords if k}

    def matches(name: str) -> bool:
        return names_relate(name, keywords)

    # 候选搜索根，按优先级排列。
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
            if not filename_relates_to_product(candidate.relpath, product):
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


__all__ = [
    "contains_token_run", "filename_relates_to_product", "find_installed_entry",
    "name_tokens", "names_relate",
]
