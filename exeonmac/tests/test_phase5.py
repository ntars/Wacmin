"""阶段 5 验收测试：配方库。

跑法：
    cd exeonmac && python3 -m unittest tests.test_phase5 -v

全部测试把 `WEXE_HOME` 与 `WEXE_RECIPES` 指向临时目录，不碰真实配方库。

三条核心契约：

1. **配方键由文件内容决定**。同一份安装包改名、换目录后键不变 ——
   这是「二次打包跳过探测」能成立的前提。
2. **内容变了键就变**。版本升级后不能误用旧配方。
3. **坏配方等同没有配方**。缓存损坏时回退到重新探测，不让一个坏
   文件彻底阻断打包。
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from wepack.models import CompatConfig, InstallerKind, InstallerRecord  # noqa: E402
from wepack.recipes import (  # noqa: E402
    dump_compat, list_recipes, load, parse_compat, recipe_key, save,
)


def sample_config(**overrides) -> CompatConfig:
    base = dict(
        app="微信", version="3.9.10",
        entry="drive_c/Program Files/Tencent/WeChat/WeChat.exe",
        installer=InstallerRecord(kind=InstallerKind.NSIS,
                                  silent_args=" /S", completed=True),
        layers=["base", "mfc"],
        font_map={"微软雅黑": "PingFang SC"},
        bundle_id="com.wexe.win.tencent.wechat",
        icon_source="exe:drive_c/Program Files/Tencent/WeChat/WeChat.exe#0",
    )
    base.update(overrides)
    return CompatConfig(**base)


class RecipeHomeMixin:
    """把配方库指向临时目录。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.recipes = self.tmp / "recipes"
        self._old = {k: os.environ.get(k) for k in ("WEXE_HOME", "WEXE_RECIPES")}
        os.environ["WEXE_HOME"] = str(self.tmp / "home")
        os.environ["WEXE_RECIPES"] = str(self.recipes)

    def tearDown(self) -> None:
        for key, value in self._old.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self._tmp.cleanup()


# --------------------------------------------------------------------------
# 配方键
# --------------------------------------------------------------------------


class TestRecipeKey(RecipeHomeMixin, unittest.TestCase):
    def _installer(self, name: str, content: bytes) -> Path:
        path = self.tmp / name
        path.write_bytes(content)
        return path

    def test_deterministic(self):
        """同一份文件算两次，键必须一致。"""
        path = self._installer("a.exe", b"payload" * 100)
        self.assertEqual(recipe_key(path), recipe_key(path))

    def test_content_based_not_name_based(self):
        """**核心契约**：改名、换目录都不影响键。

        用户重新下载安装包常会得到 `setup (1).exe` 这样的名字，
        若按键名算键，配方永远命中不了。
        """
        original = self._installer("setup.exe", b"same-content")
        renamed = self._installer("setup (1).exe", b"same-content")
        self.assertEqual(recipe_key(original), recipe_key(renamed))

    def test_different_content_different_key(self):
        """内容变了键必须变 —— 否则版本升级后会误用旧配方。"""
        v1 = self._installer("v1.exe", b"version-one")
        v2 = self._installer("v2.exe", b"version-two")
        self.assertNotEqual(recipe_key(v1), recipe_key(v2))

    def test_key_length(self):
        path = self._installer("a.exe", b"x")
        self.assertEqual(len(recipe_key(path)), 16)

    def test_key_is_hex(self):
        path = self._installer("a.exe", b"x")
        self.assertRegex(recipe_key(path), r"^[0-9a-f]{16}$")

    def test_missing_file_raises(self):
        from wepack.errors import UsageError
        with self.assertRaises(UsageError):
            recipe_key(self.tmp / "nope.exe")

    def test_large_file_streamed(self):
        """大文件要流式读，不能整个读进内存。

        这里只验证正确性：2 MB 分块哈希的结果应与一次性哈希一致。
        """
        import hashlib
        content = os.urandom(2 * 1024 * 1024)
        path = self._installer("big.exe", content)
        expected = hashlib.sha256(content).hexdigest()[:16]
        self.assertEqual(recipe_key(path), expected)


# --------------------------------------------------------------------------
# 存取往返
# --------------------------------------------------------------------------


class TestSaveLoad(RecipeHomeMixin, unittest.TestCase):
    def test_roundtrip(self):
        config = sample_config()
        path = save(config, "abc123")
        self.assertTrue(path.is_file())
        self.assertEqual(path.name, "abc123.yaml")

        restored = load("abc123")
        self.assertIsNotNone(restored)
        self.assertEqual(restored.app, config.app)
        self.assertEqual(restored.entry, config.entry)
        self.assertEqual(restored.layers, config.layers)
        self.assertEqual(restored.font_map, config.font_map)

    def test_load_missing_returns_none(self):
        """不存在时返回 None，不抛异常 —— 调用方据此回退到探测。"""
        self.assertIsNone(load("does-not-exist"))

    def test_save_creates_directory(self):
        self.assertFalse(self.recipes.exists())
        save(sample_config(), "x")
        self.assertTrue(self.recipes.is_dir())

    def test_save_overwrites(self):
        """同键重存应覆盖，不产生第二份。"""
        save(sample_config(app="旧名"), "same-key")
        save(sample_config(app="新名"), "same-key")
        self.assertEqual(load("same-key").app, "新名")
        self.assertEqual(len(list(self.recipes.glob("*.yaml"))), 1)

    def test_corrupt_recipe_returns_none(self):
        """**核心契约**：坏配方等同没有配方。

        否则一个手改坏的文件会让所有打包彻底失败，用户完全无从下手。
        """
        self.recipes.mkdir(parents=True, exist_ok=True)
        (self.recipes / "broken.yaml").write_text("这不是 YAML: [unclosed",
                                                 encoding="utf-8")
        self.assertIsNone(load("broken"))

    def test_recipe_without_required_field_returns_none(self):
        self.recipes.mkdir(parents=True, exist_ok=True)
        (self.recipes / "partial.yaml").write_text("app: X\n", encoding="utf-8")
        self.assertIsNone(load("partial"))


# --------------------------------------------------------------------------
# 列表
# --------------------------------------------------------------------------


class TestList(RecipeHomeMixin, unittest.TestCase):
    def test_empty(self):
        self.assertEqual(list_recipes(), [])

    def test_lists_saved(self):
        save(sample_config(app="A", version="1.0"), "key-a")
        save(sample_config(app="B", version="2.0"), "key-b")
        items = list_recipes()
        self.assertEqual(len(items), 2)
        names = {i["key"]: i for i in items}
        self.assertEqual(names["key-a"]["app"], "A")
        self.assertEqual(names["key-b"]["version"], "2.0")

    def test_includes_updated(self):
        save(sample_config(), "k")
        item = list_recipes()[0]
        self.assertIsNotNone(item["updated"])
        self.assertTrue(item["ok"])

    def test_corrupt_marked_not_ok(self):
        """坏配方在列表里标 ok=False，而不是整个列表失败。"""
        self.recipes.mkdir(parents=True, exist_ok=True)
        (self.recipes / "bad.yaml").write_text(":::garbage:::", encoding="utf-8")
        save(sample_config(), "good")
        items = {i["key"]: i for i in list_recipes()}
        self.assertFalse(items["bad"]["ok"])
        self.assertTrue(items["good"]["ok"])

    def test_ignores_non_yaml(self):
        self.recipes.mkdir(parents=True, exist_ok=True)
        save(sample_config(), "real")
        (self.recipes / "readme.txt").write_text("hi", encoding="utf-8")
        self.assertEqual(len(list_recipes()), 1)


# --------------------------------------------------------------------------
# 与 compat.yaml 的一致性
# --------------------------------------------------------------------------


class TestRecipeShape(RecipeHomeMixin, unittest.TestCase):
    def test_recipe_uses_same_format(self):
        """配方与 compat.yaml 是同一套序列化 —— 一份代码，两处使用。"""
        config = sample_config()
        recipe_path = save(config, "k")
        self.assertEqual(recipe_path.read_text(encoding="utf-8"),
                         dump_compat(config))

    def test_recipe_parses_back(self):
        save(sample_config(), "k")
        text = (self.recipes / "k.yaml").read_text(encoding="utf-8")
        self.assertEqual(parse_compat(text).app, "微信")

    def test_roundtrip_preserves_layer_order(self):
        """层顺序影响覆盖顺序，配方必须原样保存。"""
        config = sample_config(layers=["base", "fonts-cn", "mfc"])
        save(config, "k")
        self.assertEqual(load("k").layers, ["base", "fonts-cn", "mfc"])

    def test_roundtrip_preserves_silent_args(self):
        """静默参数的前导空格是语义的一部分。"""
        save(sample_config(), "k")
        self.assertEqual(load("k").installer.silent_args, " /S")

    def test_roundtrip_preserves_installer_kind(self):
        save(sample_config(), "k")
        self.assertEqual(load("k").installer.kind, InstallerKind.NSIS)


if __name__ == "__main__":
    unittest.main()