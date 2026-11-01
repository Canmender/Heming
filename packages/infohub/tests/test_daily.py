import tempfile
import unittest
from datetime import datetime, time as clock_time
from pathlib import Path
from unittest import mock

from infohub import daily
from infohub.config import Config


def _cfg(root: Path, **notice) -> Config:
    opts = {
        "enabled": True,
        "time": "17:00",
        "class_name": "金融2601",
        "max_items": 10,
        "ai": True,
        "conv_keywords": ["2601"],
        "exclude_convs": [],
    }
    opts.update(notice)
    return Config(
        raw={
            "data_dir": str(root),
            "notice": opts,
            "llm": {"max_chars": 6000},
            "kb": {"notice_conv_keywords": ["2601"], "agenda_conv_exclude": []},
            "digest": {"exclude_convs": []},
        }
    )


def _event(title, due_ts, conv="金融2601班群", all_day=0, detail="", content=""):
    return {
        "title": title,
        "due_ts": due_ts,
        "conv_name": conv,
        "all_day": all_day,
        "source": "qq",
        "detail": detail,
        "content": content or detail or title,
    }


def _notice(content, ts, conv="金融2601班群"):
    return {
        "id": ts,
        "ts": ts,
        "conv": conv,
        "conv_name": conv,
        "sender_name": "团支书",
        "is_self": 0,
        "type_label": "文本",
        "source": "qq",
        "content": content,
    }


class FakeStore:
    def __init__(self, events=(), notices=()):
        self.events = list(events)
        self.notices = list(notices)

    def agenda(self, since_ts, until_ts):
        return [e for e in self.events if since_ts <= e["due_ts"] < until_ts]

    def notice_messages(self, since_ts, until_ts):
        return [n for n in self.notices if since_ts <= n["ts"] < until_ts]


class TitleTest(unittest.TestCase):
    def test_title_format(self):
        cfg = _cfg(Path("."))
        self.assertEqual(
            daily.title_line(cfg, datetime(2026, 10, 26)),
            "金融2601 每日通知（10 月 26 日）",
        )

    def test_target_time(self):
        cfg = _cfg(Path("."), time="07:30")
        self.assertEqual(daily.target_time(cfg), clock_time(7, 30))
        self.assertEqual(daily.target_time(_cfg(Path("."), time="bad")), clock_time(17, 0))


class CollectTest(unittest.TestCase):
    def setUp(self):
        self.now = int(datetime(2026, 10, 31, 17, 0).timestamp())
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = _cfg(Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def test_event_filters_and_formats(self):
        store = FakeStore(
            events=[
                _event("提交材料", self.now + 86400, detail="11月1日前交"),
                _event("外卖秒杀", self.now + 3600, conv="塔斯汀福利群"),
                _event("宿舍闲聊", self.now + 3600, conv="我的设备"),
            ]
        )
        items = daily._event_items(store, self.cfg, self.now)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["title"], "提交材料")
        self.assertEqual(items[0]["due"], "11-01 17:00")

    def test_all_day_due(self):
        store = FakeStore(events=[_event("体测", self.now + 86400, all_day=1)])
        items = daily._event_items(store, self.cfg, self.now)
        self.assertEqual(items[0]["due"], "11-01 全天")

    def test_notice_overlapping_event_is_dropped(self):
        text = "请各班务必在11月1日17:00前提交主题班会材料到学院办公室"
        store = FakeStore(
            events=[_event("主题班会材料", self.now + 86400, content=text)],
            notices=[_notice(text, self.now - 600)],
        )
        events, notices = daily.collect(store, self.cfg, self.now)
        self.assertEqual(len(events), 1)
        self.assertEqual(notices, [])

    def test_unrelated_notice_is_kept(self):
        store = FakeStore(
            events=[_event("主题班会材料", self.now + 86400, content="11月1日前交材料")],
            notices=[_notice("通知：本周四晚自习调整到 302 教室，请各班注意并提前安排互相转告", self.now - 600)],
        )
        _, notices = daily.collect(store, self.cfg, self.now)
        self.assertEqual(len(notices), 1)


class ParseAiTest(unittest.TestCase):
    def test_parses_numbered_blocks(self):
        text = (
            "金融2601 每日通知（10 月 26 日）\n\n"
            "1、团风采大赛\n请各班在 11 月 5 日前提交材料。\n\n"
            "2、**助学金**（重要）\n10 月 28 日前交给班长。"
        )
        items = daily.parse_ai_items(text, 10)
        self.assertEqual([i["title"] for i in items], ["团风采大赛", "助学金（重要）"])
        self.assertIn("11 月 5 日", items[0]["body"])
        self.assertEqual(items[1]["body"], "10 月 28 日前交给班长。")

    def test_respects_max_items(self):
        text = "\n".join(f"{i}、事项{i}\n正文{i}" for i in range(1, 6))
        self.assertEqual(len(daily.parse_ai_items(text, 3)), 3)

    def test_rejects_plain_text(self):
        self.assertIsNone(daily.parse_ai_items("今天没有新通知。", 10))


class RenderTest(unittest.TestCase):
    def test_numbering_and_spacing(self):
        text = daily.render(
            "金融2601 每日通知（10 月 26 日）",
            [{"title": "甲", "body": "一"}, {"title": "乙", "body": "二"}],
        )
        self.assertTrue(text.startswith("金融2601 每日通知（10 月 26 日）\n\n1、甲\n一\n\n2、乙\n二"))
        self.assertTrue(text.endswith("\n"))

    def test_drops_items_over_byte_limit(self):
        items = [{"title": f"事项{i}", "body": "字" * 1200} for i in range(6)]
        text = daily.render("标题", items)
        self.assertLessEqual(len(text.encode("utf-8")), daily.NOTICE_LIMIT)
        self.assertIn("1、事项0", text)
        self.assertNotIn("6、事项5", text)

    def test_rule_items_mark_important(self):
        items = daily._rule_items(
            [_event("提交材料", 0, content="务必在 11 月 1 日前提交")],
            [{"text": "普通提醒", "date": "10-30", "conv": "金融2601班群"}],
            10,
        )
        self.assertIn("（重要）", items[0]["title"])


class StateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cfg = _cfg(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_save_and_done(self):
        daily.save_state(self.cfg, "2026-10-31", "sent", "已发送", 4)
        self.assertTrue(daily.done_today(self.cfg, "2026-10-31"))
        self.assertFalse(daily.done_today(self.cfg, "2026-11-01"))
        daily.save_state(self.cfg, "2026-10-31", "failed", "timeout")
        self.assertFalse(daily.done_today(self.cfg, "2026-10-31"))
        daily.save_state(self.cfg, "2026-10-31", "ready", "推送未配置")
        self.assertTrue(daily.done_today(self.cfg, "2026-10-31"))

    def test_text_file_written(self):
        path = daily.save_text(self.cfg, "2026-10-31", "正文\n")
        self.assertEqual(path, self.root / "daily" / "2026-10-31.txt")
        self.assertEqual(path.read_text(encoding="utf-8"), "正文\n")


class BuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cfg = _cfg(self.root)
        self.now = int(datetime(2026, 10, 31, 17, 0).timestamp())
        self.store = FakeStore(
            events=[_event("提交材料", self.now + 86400, detail="11 月 1 日前把材料交到办公室")]
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_build_uses_ai_output(self):
        reply = (
            "金融2601 每日通知（10 月 31 日）\n\n"
            "1、提交材料\n11 月 1 日前把材料交到办公室，请同学们抓紧准备。"
        )
        with mock.patch.object(daily.llm_mod, "available", return_value=True), mock.patch.object(
            daily.llm_mod, "daily_notice", return_value=(True, reply)
        ):
            notice = daily.build(self.store, self.cfg, self.now)
        self.assertEqual(notice.mode, "ai")
        self.assertEqual(notice.ai_error, "")
        self.assertEqual(notice.items, 1)
        self.assertTrue(Path(notice.path).exists())
        self.assertTrue(notice.text.startswith("金融2601 每日通知（10 月 31 日）"))

    def test_retries_once_when_first_attempt_fails(self):
        reply = (
            "金融2601 每日通知（10 月 31 日）\n\n"
            "1、提交材料\n11 月 1 日前把材料交到办公室。"
        )
        with mock.patch.object(daily.llm_mod, "available", return_value=True), mock.patch.object(
            daily.llm_mod, "daily_notice", side_effect=[(False, "模型只输出了推理"), (True, reply)]
        ) as call:
            notice = daily.build(self.store, self.cfg, self.now)
        self.assertEqual(notice.mode, "ai")
        self.assertEqual(notice.ai_error, "")
        self.assertEqual(call.call_count, 2)

    def test_build_falls_back_to_rules(self):
        with mock.patch.object(daily.llm_mod, "available", return_value=True), mock.patch.object(
            daily.llm_mod, "daily_notice", return_value=(False, "接口超时")
        ):
            notice = daily.build(self.store, self.cfg, self.now)
        self.assertEqual(notice.mode, "rules")
        self.assertEqual(notice.ai_error, "接口超时")
        self.assertIn("1、", notice.text)

    def test_empty_archive_returns_none(self):
        self.assertIsNone(daily.build(FakeStore(), self.cfg, self.now))


if __name__ == "__main__":
    unittest.main()
