import unittest

import zstandard as zstd

from infohub.sources.wechat import decode_blob, parse_content


class WeChatParseTest(unittest.TestCase):
    def test_decode_zstd(self):
        raw = "长文本内容" * 20
        packed = zstd.compress(raw.encode("utf-8"))
        self.assertEqual(decode_blob(packed), raw)

    def test_plain_text(self):
        content, code = parse_content(1, "收到，谢谢")
        self.assertEqual(content, "收到，谢谢")
        self.assertEqual(code, 1)

    def test_group_prefix_strip(self):
        content, _ = parse_content(1, "wxid_abc123:\n今天开会", group_prefix_sender="wxid_abc123")
        self.assertEqual(content, "今天开会")

    def test_link_card(self):
        xml = (
            "<msg><appmsg><title>市调赛通知</title><des>报名截止 10 月 31 日</des>"
            "<url>https://example.com/a</url><type>5</type></appmsg></msg>"
        )
        content, _ = parse_content(49, xml)
        self.assertIn("市调赛通知", content)
        self.assertIn("https://example.com/a", content)

    def test_file_card(self):
        xml = "<msg><appmsg><title>申请表.docx</title><type>6</type></appmsg></msg>"
        content, _ = parse_content(49, xml)
        self.assertEqual(content, "[文件] 申请表.docx")

    def test_quote(self):
        xml = (
            "<msg><appmsg><title>好的</title><type>57</type>"
            "<refermsg><content>明天交材料</content></refermsg></appmsg></msg>"
        )
        content, _ = parse_content(49, xml)
        self.assertIn("明天交材料", content)
        self.assertIn("好的", content)

    def test_media_labels(self):
        self.assertEqual(parse_content(3, "")[0], "[图片]")
        self.assertEqual(parse_content(34, "")[0], "[语音]")
        self.assertEqual(parse_content(43, "")[0], "[视频]")

    def test_composite_local_type_is_appmsg(self):
        xml = (
            '<?xml version="1.0"?><msg><appmsg><title>市调赛通知</title>'
            "<url>https://example.com/a</url><type>5</type></appmsg></msg>"
        )
        content, code = parse_content(5 * (2**32) + 49, xml)
        self.assertEqual(code, 49)
        self.assertIn("市调赛通知", content)
        self.assertNotIn("<msg>", content)

    def test_sysmsg_revoke(self):
        xml = (
            '<?xml version="1.0"?><sysmsg type="revokemsg"><revokemsg>'
            "<content>你撤回了一条消息</content></revokemsg></sysmsg>"
        )
        content, _ = parse_content(10000, xml)
        self.assertEqual(content, "你撤回了一条消息")


if __name__ == "__main__":
    unittest.main()
