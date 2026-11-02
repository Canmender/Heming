import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

from infohub import digest
from infohub.config import Config
from infohub.models import Conversation, Message
from infohub.store import Store


def _cfg(vault: Path) -> Config:
    return Config(
        raw={
            "digest": {"hours": 1, "self_names": [], "exclude_convs": []},
            "kb": {"vault": str(vault), "agenda_conv_exclude": ["美团"]},
            "push": {"enabled": False, "channel": "none"},
        }
    )


class DigestTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = Store(self.root / "archive.db")
        self.group = self.store.upsert_conversation(
            Conversation(
                source="qq", account="1", external_id="qq:group:1", name="金融2601班群", kind="group"
            )
        )
        self.shop = self.store.upsert_conversation(
            Conversation(source="wechat", account="2", external_id="wx:1", name="塔斯汀福利群")
        )
        self.now = int(time.time())

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def _add(self, conv_id, items):
        self.store.add_messages(conv_id, items)

    def test_mentions_and_counts(self):
        self._add(
            self.group,
            [
                Message(external_id="s1", ts=self.now - 60, sender_name="林寸", is_self=True, content="收到"),
                Message(external_id="a1", ts=self.now - 50, sender_name="叶老师", content="@林寸 明天交材料"),
                Message(external_id="a2", ts=self.now - 40, sender_name="同学", content="好的"),
            ],
        )
        self._add(self.shop, [Message(external_id="m1", ts=self.now - 30, sender_name="客服", content="限时秒杀")])
        result = digest.build(self.store, _cfg(self.root), self.now - 3600, self.now + 1)
        self.assertEqual(result.total, 4)
        self.assertEqual(len(result.mentions), 1)
        self.assertIn("@林寸", result.mentions[0]["text"])
        self.assertIn("金融2601班群", [c["name"] for c in result.convs])

    def test_ai_input_splits_work_and_life(self):
        life = self.store.upsert_conversation(
            Conversation(source="wechat", account="2", external_id="wx:home", name="家里人")
        )
        self._add(
            self.group,
            [
                Message(external_id="w1", ts=self.now - 90, sender_name="叶老师", content="@林寸 明天交材料"),
                Message(external_id="w2", ts=self.now - 80, sender_name="林寸", is_self=True, content="收到"),
            ],
        )
        self._add(
            life,
            [Message(external_id="l1", ts=self.now - 70, sender_name="妈妈", content="周日来学校看你")],
        )
        result = digest.build(self.store, _cfg(self.root), self.now - 3600, self.now + 1)
        self.assertIn("## 工作（QQ）", result.ai_input)
        self.assertIn("## 生活（微信）", result.ai_input)
        self.assertIn("金融2601班群", result.ai_input)
        self.assertIn("我：收到", result.ai_input)
        self.assertIn("周日来学校", result.ai_input)
        self.assertLessEqual(len(result.ai_input), 6000)

    def test_renderers(self):
        self._add(
            self.group,
            [Message(external_id="b1", ts=self.now - 20, sender_name="叶老师", content="今晚 21:00 前提交报名表")],
        )
        result = digest.build(self.store, _cfg(self.root), self.now - 3600, self.now + 1)
        text = digest.to_text(result)
        markdown = digest.to_markdown(result)
        wecom = digest.to_wecom_markdown(result)
        page = digest.to_html(result)
        self.assertIn("新消息 1", text)
        self.assertIn("## ", markdown)
        self.assertIn("金融2601班群", page)
        self.assertLessEqual(len(wecom.encode("utf-8")), 4096)

    def test_wecom_layout_by_urgency(self):
        def event(eid, title, due_ts, due="全天"):
            return {
                "id": eid, "message_id": eid, "conv_id": 1, "title": title,
                "due_ts": due_ts, "due": due, "conv": "班群", "source": "qq",
                "sender": "叶老师", "status": "new",
            }

        today0 = int(datetime.fromtimestamp(self.now).replace(hour=0, minute=0, second=0).timestamp())
        until = today0 + 12 * 3600  # 固定在今天中午，避免测试受运行时刻影响
        result = digest.Digest(since=until - 3600, until=until, total=5)
        result.by_source = {"wechat": 5}
        result.convs = [{
            "id": 1, "name": "市调赛", "source": "wechat", "kind": "group", "count": 165,
            "last": "OK，睡了", "last_id": 1, "last_ts": until, "sender": "队友",
            "mention": True,
        }]
        result.mentions = [{
            "id": 2, "conv_id": 1, "ts": until, "conv": "市调赛",
            "sender": "陈羽熙", "source": "wechat", "text": "看群里的表",
        }]
        result.overdue = [event(1, "昨晚的旧截止", today0 - 3600, "18:00")]
        result.new_events = [event(2, "交报名表", until + 1800, "12:30")]
        result.upcoming = [
            event(3, "明早体检", until + 86400, "08:00"),
            event(4, "后天开会", until + 2 * 86400),
        ]
        result.ai_sections = [
            {"title": "工作 · 结论", "items": ["月报表 11-09 前交回。"]},
            {"title": "工作 · 待办与截止", "items": ["领表", "填表"]},
            {"title": "生活 · 动态", "items": ["周康在护肤"]},
        ]
        text = digest.to_wecom_markdown(result)
        self.assertIn("**已逾期（1）**", text)
        self.assertIn("**今天（1）**", text)
        self.assertIn("**明天（1）**", text)
        self.assertIn("**未来 7 天（1）**", text)
        self.assertIn("**@我**", text)
        self.assertIn("**工作**", text)
        self.assertIn("**生活**", text)
        self.assertNotIn("OK，睡了", text)  # 会话只报计数，不贴整段对话
        self.assertLess(text.index("**已逾期"), text.index("**今天（"))
        self.assertLess(text.index("**今天（"), text.index("**明天（"))
        self.assertLess(text.index("**明天（"), text.index("**未来 7 天"))
        self.assertLess(text.index("**未来 7 天"), text.index("**AI 分析报告**"))
        self.assertIn("\n\n", text)
        self.assertLessEqual(len(text.encode("utf-8")), 4096)

    def test_wecom_agenda_items_are_numbered_in_order(self):
        def event(eid, title, due_ts, due="全天"):
            return {
                "id": eid, "message_id": eid, "conv_id": 1, "title": title,
                "due_ts": due_ts, "due": due, "conv": "班群", "source": "qq",
                "sender": "叶老师", "status": "new",
            }

        today0 = int(datetime.fromtimestamp(self.now).replace(hour=0, minute=0, second=0).timestamp())
        until = today0 + 12 * 3600
        result = digest.Digest(since=until - 3600, until=until, total=1)
        result.overdue = [event(1, "逾期交表", today0 - 3600, "18:00")]
        result.new_events = [event(2, "今天开会", until + 600, "12:30")]
        result.upcoming = [
            event(3, "明天体检", until + 86400, "08:00"),
            event(4, "后天开会", until + 2 * 86400),
        ]
        text = digest.to_wecom_markdown(result)
        # 日期展示取真实时钟，断言必须按同一时刻推导；写死 "10-" / "11-02" 只在 10-31 当天成立。
        overdue = datetime.fromtimestamp(today0 - 3600)
        future = datetime.fromtimestamp(today0 + 2 * 86400)
        first = f"1. {overdue.month:02d}-{overdue.day:02d} "
        fourth = f"4. {future.month:02d}-{future.day:02d} "
        self.assertIn(first, text)
        self.assertIn("2. 12:10", text)
        self.assertIn("3. 12:00", text)
        self.assertIn(fourth, text)
        self.assertLess(text.index(first), text.index("2. 12:10"))
        self.assertLess(text.index("2. 12:10"), text.index("3. 12:00"))
        self.assertLess(text.index("3. 12:00"), text.index(fourth))

    def test_wecom_drops_stale_overdue(self):
        result = digest.Digest(since=self.now - 3600, until=self.now, total=1)
        result.overdue = [{
            "id": 9, "message_id": 9, "conv_id": 1, "title": "三天前的截止",
            "due_ts": self.now - 3 * 86400, "due": "18:00", "conv": "班群",
            "source": "qq", "sender": "x", "status": "new",
        }]
        self.assertNotIn("三天前的截止", digest.to_wecom_markdown(result))

    def test_empty_window(self):
        result = digest.build(self.store, _cfg(self.root), self.now - 60, self.now)
        self.assertTrue(result.empty)
        self.assertIn("没有新消息", digest.to_text(result))
        self.assertIn("没有新消息", digest.to_markdown(result))

    def test_obsidian_append_is_idempotent(self):
        self._add(
            self.group, [Message(external_id="c1", ts=self.now - 10, sender_name="叶老师", content="班会改到周五")]
        )
        cfg = _cfg(self.root)
        first = digest.build(self.store, cfg, self.now - 3600, self.now + 1)
        digest.export_obsidian(cfg, first)
        path = self.root / digest.BRIEF_REL
        self.assertTrue(path.is_file())
        before = path.read_text(encoding="utf-8")
        digest.export_obsidian(cfg, first)
        self.assertEqual(before, path.read_text(encoding="utf-8"))
        later = digest.build(self.store, cfg, self.now - 1800, self.now + 120)
        digest.export_obsidian(cfg, later)
        text = path.read_text(encoding="utf-8")
        self.assertEqual(text.count("<!-- infohub:hourly:start -->"), 1)
        self.assertEqual(text.count("## "), 2)

    def test_sections_are_capped(self):
        cfg = _cfg(self.root)
        path = self.root / digest.BRIEF_REL
        for i in range(digest.MAX_SECTIONS + 5):
            item = digest.Digest(since=self.now + i, until=self.now + i + 60, total=1)
            item.convs = [{"id": 1, "name": "班群", "source": "qq", "kind": "group", "count": 1,
                           "last": f"第 {i} 条", "last_id": 1, "last_ts": self.now, "sender": "x",
                           "mention": False}]
            digest.export_obsidian(cfg, item)
        text = path.read_text(encoding="utf-8")
        self.assertEqual(text.count("## "), digest.MAX_SECTIONS)

    def test_cursor_advances(self):
        cfg = _cfg(self.root)
        self.assertEqual(self.store.digest_cursor(), 0)
        digest.run(self.store, cfg, hours=1, obsidian=False)
        self.assertGreater(self.store.digest_cursor(), 0)

    def test_cursor_fills_gap(self):
        cfg = _cfg(self.root)
        started = int(time.time()) - 3 * 3600
        self._add(
            self.group,
            [Message(external_id="g1", ts=started + 300, sender_name="叶老师", content="三小时前的通知")],
        )
        self.store.set_digest_cursor(started)
        result = digest.run(self.store, cfg, hours=1, obsidian=False)
        self.assertLessEqual(result.since, started)
        self.assertEqual(result.total, 1)

    def test_ai_report_rendered_everywhere(self):
        result = digest.Digest(since=self.now - 3600, until=self.now, total=2)
        result.ai_sections = [
            {"title": "结论", "items": ["今晚要交报名表，其它无异常。"]},
            {"title": "待办与截止", "items": ["21:00 前交报名表", "明天 8:00 开班会"]},
            {"title": "重要通知", "items": []},
            {"title": "风险提醒", "items": ["@我 未回：叶老师问名单"]},
        ]
        result.ai = "【结论】今晚要交报名表，其它无异常。"
        for text in (
            digest.to_text(result),
            digest.to_markdown(result),
            digest.to_wecom_markdown(result),
            digest.to_html(result),
        ):
            self.assertIn("AI 分析报告", text)
            self.assertIn("21:00", text)
            self.assertIn("结论", text)
        self.assertNotIn("重要通知", digest.to_text(result))

    def test_ai_error_shown_in_html_only(self):
        result = digest.Digest(since=self.now - 3600, until=self.now, total=2)
        result.ai_error = "HTTP 402 · 账户余额/额度不足"
        self.assertIn("AI 报告生成失败", digest.to_html(result))
        self.assertNotIn("AI 报告生成失败", digest.to_wecom_markdown(result))

    def test_run_attaches_report_when_available(self):
        self._add(
            self.group,
            [Message(external_id="d1", ts=self.now - 15, sender_name="叶老师", content="明早交表")],
        )
        cfg = _cfg(self.root)
        cfg.raw["llm"] = {
            "enabled": True,
            "base_url": "http://127.0.0.1:11434/v1",
            "model": "qwen2.5:7b",
        }
        report = [{"title": "结论", "items": ["明早要交表"]}]
        with mock.patch("infohub.llm.available", return_value=True), mock.patch(
            "infohub.llm.report", return_value=(True, report)
        ) as fake:
            result = digest.run(self.store, cfg, hours=1, obsidian=False)
        self.assertEqual(result.ai_sections, report)
        self.assertIn("明早要交表", result.ai)
        self.assertTrue(fake.called)
        self.assertIn("## 工作（QQ）", fake.call_args[0][1])

    def test_run_records_ai_error(self):
        self._add(
            self.group,
            [Message(external_id="d2", ts=self.now - 14, sender_name="叶老师", content="开会")],
        )
        cfg = _cfg(self.root)
        with mock.patch("infohub.llm.available", return_value=True), mock.patch(
            "infohub.llm.report", return_value=(False, "HTTP 402 · 余额不足")
        ):
            result = digest.run(self.store, cfg, hours=1, obsidian=False)
        self.assertEqual(result.ai_sections, [])
        self.assertIn("余额不足", result.ai_error)

    def test_run_can_skip_ai(self):
        self._add(
            self.group,
            [Message(external_id="e1", ts=self.now - 12, sender_name="叶老师", content="开会")],
        )
        cfg = _cfg(self.root)
        with mock.patch("infohub.llm.report", return_value=(True, [{"title": "结论", "items": ["不该出现"]}])) as fake:
            result = digest.run(self.store, cfg, hours=1, obsidian=False, ai=False)
        self.assertEqual(result.ai, "")
        self.assertFalse(fake.called)


if __name__ == "__main__":
    unittest.main()
