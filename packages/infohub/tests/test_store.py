import tempfile
import unittest
from pathlib import Path

from infohub.models import Conversation, Message
from infohub.store import Store


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / "archive.db")
        self.conv_id = self.store.upsert_conversation(
            Conversation(source="wechat", account="wxid_self", external_id="wxid_peer", name="叶老师")
        )

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_dedupe_and_increment(self):
        msgs = [
            Message(external_id="a:1", ts=1000, sender_name="叶老师", content="第一条"),
            Message(external_id="a:2", ts=1001, sender_name="我", content="第二条", is_self=True),
        ]
        added, _ = self.store.add_messages(self.conv_id, msgs)
        self.assertEqual(added, 2)
        added, _ = self.store.add_messages(self.conv_id, msgs)
        self.assertEqual(added, 0)
        conv = self.store.get_conversation(self.conv_id)
        self.assertEqual(conv["message_count"], 2)
        self.assertEqual(conv["cursor_ts"], 1001)

    def test_search_chinese(self):
        self.store.add_messages(
            self.conv_id,
            [Message(external_id="x:1", ts=2000, sender_name="我", content="晚自习免检单已经提交给叶老师")],
        )
        rows = self.store.search("晚自习免检")
        self.assertEqual(len(rows), 1)
        self.assertIn("晚自习", rows[0]["content"])
        two_char = self.store.search("免检")
        self.assertGreaterEqual(len(two_char), 1)

    def test_content_keys(self):
        self.store.add_messages(
            self.conv_id, [Message(external_id="y:1", ts=3000, sender_name="我", content="收到")]
        )
        keys = self.store.content_keys(self.conv_id, 2999, 3001)
        self.assertIn((3000, __import__("hashlib").md5("收到".encode()).hexdigest()), keys)


if __name__ == "__main__":
    unittest.main()
