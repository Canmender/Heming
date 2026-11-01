import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from infohub import kb
from infohub.models import Conversation, Message
from infohub.store import Store


def ts(text: str) -> int:
    return int(datetime.strptime(text, "%Y-%m-%d %H:%M").timestamp())


class FakeAgendaStore:
    def __init__(self, events):
        self.events = events

    def agenda(self, since_ts, until_ts):
        return [e for e in self.events if since_ts <= e["due_ts"] < until_ts]


def event(title, due, conv="金融2601班群", sender="叶老师", msg_ts=0, all_day=0):
    return {
        "title": title,
        "due_ts": due,
        "conv_name": conv,
        "sender_name": sender,
        "msg_ts": msg_ts or due - 3600,
        "source": "qq",
        "all_day": all_day,
    }


class AgendaBlockTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.vault = Path(self.tmp.name)
        self.path = self.vault / kb.SCHEDULE_REL
        self.path.parent.mkdir(parents=True)
        self.manual = (
            "---\ntitle: 日程安排\ntags: [院务]\n---\n\n# 日程安排\n\n"
            "## 一、固定节律\n\n| 时间 | 事项 |\n|---|---|\n| 18:15 | 晚自习 |\n\n"
            "## 四、时间冲突与排布提示\n\n1. 手写内容不能动。\n\n"
            "## 相关\n\n- [[学院事务/00-总览|学院事务总览]]\n"
        )
        self.path.write_text(self.manual, encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, rows, now):
        return kb.export_agenda(FakeAgendaStore(rows), self.vault, now, days=30, overdue_days=3)

    def test_block_is_idempotent_and_keeps_manual_text(self):
        now = ts("2026-10-29 19:00")
        rows = [
            event("提交助学金申请表", ts("2026-10-30 08:00")),
            event("运动会观众报名", ts("2026-11-05 00:00"), all_day=1),
        ]
        first = self.write(rows, now)
        self.assertTrue(first["changed"])
        text = self.path.read_text(encoding="utf-8")
        self.assertEqual(text.count(kb.AGENDA_START), 1)
        self.assertEqual(text.count(kb.AGENDA_END), 1)
        self.assertIn("## 一、固定节律", text)
        self.assertIn("1. 手写内容不能动。", text)
        self.assertTrue(text.index(kb.AGENDA_START) < text.index("## 相关"))
        self.assertIn("提交助学金申请表", text)

        second = self.write(rows, now + 60)
        self.assertFalse(second["changed"])
        self.assertEqual(text, self.path.read_text(encoding="utf-8"))

    def test_block_replaced_in_place(self):
        now = ts("2026-10-29 19:00")
        self.write([event("旧事项", ts("2026-10-30 08:00"))], now)
        self.write([event("新事项", ts("2026-10-31 08:00"))], now)
        text = self.path.read_text(encoding="utf-8")
        self.assertNotIn("旧事项", text)
        self.assertIn("新事项", text)
        self.assertIn("## 一、固定节律", text)

    def test_block_appended_when_no_markers(self):
        self.manual = "# 日程安排\n\n只有正文。\n"
        self.path.write_text(self.manual, encoding="utf-8")
        self.write([event("待办", ts("2026-10-30 08:00"))], ts("2026-10-29 19:00"))
        text = self.path.read_text(encoding="utf-8")
        self.assertIn("只有正文。", text)
        self.assertEqual(text.count(kb.AGENDA_START), 1)


class NoticeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.vault = Path(self.tmp.name)
        self.store = Store(Path(self.tmp.name) / "a.db")
        self.now = ts("2026-10-29 20:00")
        self.class_id = self.store.upsert_conversation(
            Conversation(source="qq", account="3650703301", external_id="g1", name="金融2601班群", kind="group")
        )
        self.friend_id = self.store.upsert_conversation(
            Conversation(source="wechat", account="wxid", external_id="p1", name="黄梦怡", kind="private")
        )
        self._add(self.class_id, "c1", "同学们哈哈哈哈哈今天好热")
        self._add(self.class_id, "q1", "你明天去不去开会？")
        self._add(self.class_id, "s1", "请大家明天交材料到班长处", is_self=True)
        self._add(self.class_id, "n1", "请各位同学10月30日前提交助学金申请表到班长处，逾期视为放弃")
        self._add(self.friend_id, "w1", "请你明天把报名表交给我，截止10月30日18点")
        self._add(self.class_id, "n2", "明天上课时间有调整")

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def _add(self, conv_id, ext, content, is_self=False):
        self.store.add_messages(
            conv_id,
            [Message(external_id=ext, ts=self.now - 3600, sender_name="叶老师", content=content, is_self=is_self)],
        )

    def export(self):
        return kb.export_notices(self.store, self.vault, self.now, days=7)

    def test_filters_and_channel(self):
        result = self.export()
        self.assertEqual(result["candidates"], 1)
        text = (self.vault / kb.NOTICE_REL).read_text(encoding="utf-8")
        self.assertIn("助学金申请表", text)
        self.assertIn("建议私发", text)
        self.assertNotIn("哈哈", text)
        self.assertNotIn("去不去开会", text)
        self.assertNotIn("上课时间有调整", text)

    def test_checked_state_survives_reexport(self):
        self.export()
        path = self.vault / kb.NOTICE_REL
        text = path.read_text(encoding="utf-8")
        path.write_text(text.replace("- [ ]", "- [x]", 1), encoding="utf-8")
        result = self.export()
        self.assertEqual(result["checked"], 1)
        self.assertFalse(result["changed"])
        self.assertIn("- [x]", path.read_text(encoding="utf-8"))


class MediaTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.vault = self.root / "vault"
        self.vault.mkdir()
        self.store = Store(self.root / "a.db")
        self.conv_id = self.store.upsert_conversation(
            Conversation(source="qq", account="3650703301", external_id="g", name="金融2601班群", kind="group")
        )
        self.source = self.root / "src"
        self.source.mkdir()
        self.now = ts("2026-10-29 20:00")

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def add_file(self, ext, name, data: bytes, when: int):
        path = self.source / name
        path.write_bytes(data)
        self.store.add_messages(
            self.conv_id,
            [Message(external_id=ext, ts=when, sender_name="叶老师", content=f"[文件] {name}", type_label="文件")],
        )
        self.store.attach_media(
            self.conv_id,
            [(ext, "file", str(path), name, "", 0, 0, len(data), 0.0)],
        )

    def test_hash_dedupe_and_index(self):
        self.add_file("a1", "助学金申请表.doc", b"same-bytes", self.now - 7200)
        self.add_file("a2", "助学金申请表-转发.doc", b"same-bytes", self.now - 3600)
        manifest = self.root / "manifest.json"
        first = kb.export_media(self.store, self.vault, manifest, self.now)
        self.assertEqual(first["scanned"], 2)
        self.assertEqual(first["new"], 1)
        self.assertEqual(first["reused"], 0)
        copied = list((self.vault / kb.MEDIA_DIR_REL).rglob("*.doc"))
        self.assertEqual(len(copied), 1)
        index = (self.vault / kb.MEDIA_INDEX_REL).read_text(encoding="utf-8")
        self.assertIn("助学金申请表", index)
        self.assertIn("×2", index)
        link = copied[0].relative_to(self.vault).as_posix()
        self.assertIn(f"[[{link}|", index)

        second = kb.export_media(self.store, self.vault, manifest, self.now + 60)
        self.assertEqual(second["new"], 0)
        self.assertEqual(second["reused"], 1)
        self.assertFalse(second["changed"])

    def add_image(self, ext, name, path: Path, when: int):
        self.store.add_messages(
            self.conv_id,
            [Message(external_id=ext, ts=when, sender_name="叶老师", content="[图片]", type_label="图片")],
        )
        self.store.attach_media(
            self.conv_id,
            [(ext, "image", str(path), name, "", 1800, 1200, path.stat().st_size, 0.0)],
        )

    def make_noisy_png(self, name: str = "现场照片.png") -> Path:
        from PIL import Image

        path = self.source / name
        image = Image.effect_noise((1800, 1200), 48).convert("RGB")
        image.save(path, "PNG")
        return path

    def test_image_archived_as_compressed_preview(self):
        source = self.make_noisy_png()
        self.add_image("i1", "现场照片.png", source, self.now - 900)
        preview_dir = self.root / "preview"
        manifest = self.root / "manifest.json"
        first = kb.export_media(
            self.store, self.vault, manifest, self.now, preview_dir=preview_dir
        )
        self.assertEqual(first["new"], 1)
        archived = list((self.vault / kb.MEDIA_DIR_REL).rglob("*.jpg"))
        self.assertEqual(len(archived), 1)
        self.assertLess(archived[0].stat().st_size, source.stat().st_size)
        self.assertFalse(list((self.vault / kb.MEDIA_DIR_REL).rglob("*.png")))
        index = (self.vault / kb.MEDIA_INDEX_REL).read_text(encoding="utf-8")
        self.assertIn("JPEG", index)
        self.assertTrue(any(e.get("variant") == "preview" for e in kb._load_manifest(manifest)["files"].values()))

        second = kb.export_media(
            self.store, self.vault, manifest, self.now + 60, preview_dir=preview_dir
        )
        self.assertEqual((second["new"], second["reused"]), (0, 1))
        self.assertFalse(second["changed"])

    def test_legacy_archive_images_are_compressed_in_place(self):
        source = self.make_noisy_png("旧图.png")
        self.add_image("old1", "旧图.png", source, self.now - 900)
        manifest = self.root / "manifest.json"
        kb.export_media(self.store, self.vault, manifest, self.now)
        legacy = list((self.vault / kb.MEDIA_DIR_REL).rglob("*.png"))
        self.assertEqual(len(legacy), 1)
        legacy_size = legacy[0].stat().st_size

        result = kb.export_media(
            self.store, self.vault, manifest, self.now + 60, preview_dir=self.root / "preview"
        )
        self.assertEqual(result["compressed"], 1)
        self.assertGreater(result["saved"], 0)
        self.assertFalse(legacy[0].exists())
        converted = list((self.vault / kb.MEDIA_DIR_REL).rglob("*.jpg"))
        self.assertEqual(len(converted), 1)
        self.assertLess(converted[0].stat().st_size, legacy_size)
        index = (self.vault / kb.MEDIA_INDEX_REL).read_text(encoding="utf-8")
        self.assertIn(converted[0].name, index)

        again = kb.export_media(
            self.store, self.vault, manifest, self.now + 120, preview_dir=self.root / "preview"
        )
        self.assertEqual((again["compressed"], again["new"]), (0, 0))
        self.assertEqual(again["reused"], 1)
        self.assertFalse(again["changed"])

    def test_second_run_reuses_hash_cache(self):
        self.add_file("b1", "会议纪要.docx", b"meeting", self.now - 600)
        manifest = self.root / "manifest.json"
        kb.export_media(self.store, self.vault, manifest, self.now)
        original = kb._sha1_file
        kb._sha1_file = lambda path: self.fail("未变化文件不应重新计算 SHA-1")
        try:
            again = kb.export_media(self.store, self.vault, manifest, self.now + 60)
        finally:
            kb._sha1_file = original
        self.assertEqual(again["reused"], 1)
        self.assertFalse(again["changed"])


class NoticeTextTest(unittest.TestCase):
    def test_short_notice(self):
        self.assertTrue(kb.is_notice_text("请各位同学明天18:00前把报名表交到班长处"))

    def test_scan_count_line_is_volatile(self):
        old = "# InfoHub 通知候选（2026-10-29）\n> 由 InfoHub 从工作类会话自动抽取近 7 天消息（扫描 5079 条），命中 **61** 条。\n正文\n"
        new = old.replace("5079", "5078")
        self.assertEqual(kb._stable(old), kb._stable(new))

    def test_question_is_rejected(self):
        self.assertFalse(kb.is_notice_text("你明天去不去开会？"))

    def test_emoji_placeholder_is_rejected(self):
        self.assertFalse(kb.is_notice_text("[图片]"))

    def test_channel(self):
        self.assertEqual(kb.suggest_channel("请核对名单和身份证号"), "私发")
        self.assertEqual(kb.suggest_channel("周四晚自习照常"), "群发")


if __name__ == "__main__":
    unittest.main()
