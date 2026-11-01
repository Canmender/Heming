import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from infohub.sources.qq_qce import import_dir, parse_html, parse_txt
from infohub.store import Store

MANIFEST = {
    "format": "qce-modern-html-chunked",
    "chat": {
        "name": "叶老师",
        "type": "private",
        "peerUid": "u_peer",
        "peerUin": "123456",
        "selfUid": "u_self",
        "selfUin": "999",
        "selfName": "客服",
    },
    "chunks": [{"id": "c000001", "count": 2}],
}

TS = int(datetime(2026, 10, 26, 11, 52, 0).timestamp())


def build_html(messages=None) -> str:
    if messages is None:
        messages = [
            {"id": "msg-1", "ts": TS * 1000, "uid": "u_peer", "name": "叶老师", "text": "收到，谢谢", "html": ""},
            {"id": "msg-2", "ts": (TS + 60) * 1000, "uid": "u_self", "name": "客服", "text": "[图片:abc.jpg]", "html": ""},
        ]
    payload = json.dumps(messages, ensure_ascii=False)
    meta = {
        "messageCount": 2,
        "chatName": "叶老师",
        "chatType": "private",
        "peerUid": "u_peer",
        "peerUin": "123456",
    }
    return (
        "<!DOCTYPE html><html><head>"
        f"<!-- QCE_METADATA: {json.dumps(meta, ensure_ascii=False)} -->"
        "<script>window.__QCE_MANIFEST__ && window.__QCE_MANIFEST__("
        f"{json.dumps(MANIFEST, ensure_ascii=False)})</script>"
        "<script>window.__QCE_CHUNK__ && window.__QCE_CHUNK__({id:\"c000001\",messages:"
        f"{payload}}})</script>"
        "</head></html>"
    )


TXT = """==== QQ 聊天记录 ====
聊天名称: 叶老师
聊天类型: 私聊
导出时间: 2026-10-28 13:09:40
消息总数: 2
时间范围: 2026-10-26 至 2026-10-28

叶老师:
时间: 2026-10-26 11:52:00
内容: 收到，谢谢

客服:
时间: 2026-10-26 11:53:00
内容: [图片:abc.jpg]
"""


class QqParserTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_parse_html(self):
        path = self.root / "friend_叶老师_123456_20261028_130940377.html"
        path.write_text(build_html(), encoding="utf-8")
        parsed = parse_html(path)
        self.assertEqual(parsed.conversation.external_id, "qq:private:123456")
        self.assertEqual(len(parsed.messages), 2)
        self.assertEqual(parsed.messages[0].content, "收到，谢谢")
        self.assertFalse(parsed.messages[0].is_self)
        self.assertTrue(parsed.messages[1].is_self)
        self.assertEqual(parsed.messages[1].type_label, "图片")
        self.assertEqual(parsed.conversation.meta["self_uin"], "999")

    def test_parse_txt(self):
        path = self.root / "friend_叶老师_123456_20261026_220025503.txt"
        path.write_text(TXT, encoding="utf-8")
        parsed = parse_txt(path)
        self.assertEqual(parsed.conversation.external_id, "qq:private:123456")
        self.assertEqual(parsed.messages[0].ts, TS)
        self.assertEqual(len(parsed.messages), 2)

    def test_parse_txt_strips_export_footer(self):
        path = self.root / "friend_叶老师_123456_20261026_220025503.txt"
        path.write_text(
            TXT
            + "\n===============================================\n"
            "              导出完成\n"
            "===============================================\n"
            "总计导出 2 条消息\n导出时间: 2026-10-26 22:00:20\n",
            encoding="utf-8",
        )
        parsed = parse_txt(path)
        self.assertEqual(parsed.messages[1].content, "[图片:abc.jpg]")

    def test_reply_txt_is_deduped_against_html(self):
        html_path = self.root / "friend_叶老师_123456_20261028_130940377.html"
        html_path.write_text(
            build_html(
                [
                    {"id": "m1", "ts": TS * 1000, "uid": "u_peer", "name": "叶老师", "text": "收到，谢谢", "html": ""},
                    {"id": "m2", "ts": (TS + 60) * 1000, "uid": "u_self", "name": "客服",
                     "text": "收到，谢谢 不客气", "html": ""},
                ]
            ),
            encoding="utf-8",
        )
        txt_path = self.root / "friend_叶老师_123456_20261027_220025503.txt"
        txt_path.write_text(
            "聊天名称: 叶老师\n聊天类型: 私聊\n\n"
            "客服:\n时间: 2026-10-26 11:53:00\n"
            "内容: [回复消息]不客气\n回复: 10-26 11:52 叶老师 - 收到，谢谢\n",
            encoding="utf-8",
        )
        store = Store(self.root / "archive.db")
        try:
            report = import_dir(store, self.root)
            self.assertEqual(report.added, 2, report.errors)
        finally:
            store.close()

    def test_empty_text_falls_back_to_bubble_content_only(self):
        html_path = self.root / "friend_叶老师_123456_20261028_130940377.html"
        html_path.write_text(
            build_html(
                [
                    {"id": "m1", "ts": TS * 1000, "uid": "u_peer", "name": "叶老师",
                     "text": "", "html": (
                         '<div class="message-block"><div class="avatar">'
                         '<img src="http://q.qlogo.cn/g?b=qq&nk=123456&s=100" alt="叶老师" />'
                         '<span class="avatar-fallback">金</span></div>'
                         '<div class="message-bubble"><div class="content">'
                         '<span class="at-mention">@全体成员</span></div></div></div>'
                     )},
                ]
            ),
            encoding="utf-8",
        )
        parsed = parse_html(html_path)
        self.assertEqual(parsed.messages[0].content, "@全体成员")
        self.assertEqual(parsed.messages[0].type_code, 1)

    def test_empty_text_image_keeps_resource_name(self):
        html_path = self.root / "friend_叶老师_123456_20261028_130940377.html"
        html_path.write_text(
            build_html(
                [
                    {"id": "m1", "ts": TS * 1000, "uid": "u_peer", "name": "叶老师",
                     "text": "", "html": (
                         '<div class="message-block"><div class="avatar">'
                         '<img src="http://q.qlogo.cn/g?b=qq&nk=123456&s=100" alt="叶老师" /></div>'
                         '<div class="message-bubble"><div class="content">'
                         '<img class="message-image" src="resources/images/ab12_AB12.jpg"></div></div></div>'
                     )},
                ]
            ),
            encoding="utf-8",
        )
        parsed = parse_html(html_path)
        self.assertEqual(parsed.messages[0].content, "[图片:ab12_AB12.jpg]")
        self.assertEqual(parsed.messages[0].type_label, "图片")

    def test_import_dedupes_across_formats(self):
        html_path = self.root / "friend_叶老师_123456_20261028_130940377.html"
        html_path.write_text(build_html(), encoding="utf-8")
        txt_path = self.root / "friend_叶老师_123456_20261026_220025503.txt"
        txt_path.write_text(TXT, encoding="utf-8")

        store = Store(self.root / "archive.db")
        try:
            report = import_dir(store, self.root)
            self.assertEqual(report.added, 2, report.errors)
            convs = store.list_conversations()
            self.assertEqual(len(convs), 1)
            self.assertEqual(convs[0]["message_count"], 2)
            again = import_dir(store, self.root, force=True)
            self.assertEqual(again.added, 0)
        finally:
            store.close()


if __name__ == "__main__":
    unittest.main()
