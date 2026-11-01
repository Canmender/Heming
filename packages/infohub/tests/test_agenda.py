import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

from infohub.agenda import extract, rebuild, update_agenda
from infohub.config import Config
from infohub.models import Conversation, Message
from infohub.store import Store


def ts(text: str) -> int:
    return int(datetime.strptime(text, "%Y-%m-%d %H:%M").timestamp())


class AgendaExtractTest(unittest.TestCase):
    def test_month_day_deadline(self):
        events = extract("11月5日前需提交支部材料", ts("2026-10-26 11:52"))
        self.assertEqual(len(events), 1)
        self.assertIn("11月5日", events[0].title)
        self.assertIn("提交支部材料", events[0].title)
        self.assertTrue(events[0].all_day)
        self.assertEqual(
            datetime.fromtimestamp(events[0].due_ts).date().isoformat(), "2026-11-05"
        )

    def test_deadline_with_time_and_paren_weekday(self):
        events = extract("10月28日（周三）23:00 前缴费（25 元）", ts("2026-10-26 11:52"))
        self.assertEqual(len(events), 1)
        due = datetime.fromtimestamp(events[0].due_ts)
        self.assertEqual(due.strftime("%Y-%m-%d %H:%M"), "2026-10-28 23:00")
        self.assertFalse(events[0].all_day)
        self.assertEqual(events[0].kind, "payment")
        self.assertIn("缴费", events[0].title)

    def test_next_week_weekday(self):
        events = extract("下周四 15:00 例会", ts("2026-10-26 09:00"))
        self.assertEqual(len(events), 1)
        self.assertEqual(
            datetime.fromtimestamp(events[0].due_ts).strftime("%Y-%m-%d %H:%M"),
            "2026-11-05 15:00",
        )
        self.assertEqual(events[0].kind, "meeting")

    def test_plain_weekday_is_upcoming(self):
        events = extract("周四 15:00 例会", ts("2026-10-26 09:00"))
        self.assertEqual(len(events), 1)
        self.assertEqual(
            datetime.fromtimestamp(events[0].due_ts).strftime("%Y-%m-%d %H:%M"),
            "2026-10-29 15:00",
        )

    def test_relative_day_noon(self):
        events = extract("明天中午12点集合", ts("2026-10-26 09:00"))
        self.assertEqual(len(events), 1)
        self.assertEqual(
            datetime.fromtimestamp(events[0].due_ts).strftime("%Y-%m-%d %H:%M"),
            "2026-10-27 12:00",
        )

    def test_year_rollover(self):
        events = extract("1月5日前交材料", ts("2026-12-28 10:00"))
        self.assertEqual(len(events), 1)
        self.assertEqual(
            datetime.fromtimestamp(events[0].due_ts).date().isoformat(), "2027-01-05"
        )

    def test_past_date_without_deadline_is_ignored(self):
        events = extract("10月20日提交材料", ts("2026-10-29 10:00"))
        self.assertEqual(events, [])

    def test_past_deadline_is_kept_as_overdue(self):
        events = extract("10月20日前提交材料", ts("2026-10-29 10:00"))
        self.assertEqual(len(events), 1)
        self.assertEqual(
            datetime.fromtimestamp(events[0].due_ts).date().isoformat(), "2026-10-20"
        )

    def test_plain_chat_is_ignored(self):
        self.assertEqual(extract("收到，谢谢", ts("2026-10-26 11:52")), [])
        self.assertEqual(extract("目前还没有收到回复", ts("2026-10-26 11:52")), [])

    def test_requirement_prefix_is_kept(self):
        events = extract(
            "要求：请各位团支书在❗截止日期11月5日之前❗提交材料", ts("2026-10-20 09:00")
        )
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0].title.startswith("要求"))

    def test_duplicate_dates_in_one_message_are_merged(self):
        text = "10月31日前报名。10月31日前报名，记得填表。"
        events = extract(text, ts("2026-10-26 11:52"))
        self.assertEqual(len(events), 1)

    def test_long_title_is_cut_without_splitting_time(self):
        text = "信息收集表填写截止时间下周一10月26日晚上18:00请大家务必按时完成并提交到班长处谢谢配合"
        events = extract(text, ts("2026-10-20 09:00"))
        self.assertEqual(len(events), 1)
        title = events[0].title
        self.assertLessEqual(len(title), 48)
        self.assertTrue(title.endswith("…"))
        self.assertIn("18:00", title)


class AgendaRebuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = Store(self.root / "archive.db")
        conv_id = self.store.upsert_conversation(
            Conversation(source="qq", account="1", external_id="qq:group:1", name="班群", kind="group")
        )
        base = ts("2026-10-26 11:00")
        self.store.add_messages(
            conv_id,
            [
                Message(external_id="m1", ts=base, content="11月5日前提交材料", sender_name="班长"),
                Message(external_id="m2", ts=base + 60, content="11月5日前提交材料", sender_name="班长"),
                Message(external_id="m3", ts=base + 120, content="收到", sender_name="同学"),
            ],
        )

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_rebuild_dedupes_repeated_notice(self):
        report = rebuild(self.store, now_ts=ts("2026-10-29 08:00"))
        self.assertEqual(report["matched"], 1)
        self.assertEqual(report["total"], 1)
        rows = self.store.agenda(ts("2026-10-01 00:00"), ts("2026-12-01 00:00"))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["conv_name"], "班群")

    def test_rebuild_is_idempotent(self):
        first = rebuild(self.store, now_ts=ts("2026-10-29 08:00"))
        again = rebuild(self.store, now_ts=ts("2026-10-29 09:00"))
        self.assertEqual(first["total"], 1)
        self.assertEqual(again["total"], 1)

    def test_rebuild_keeps_done_state(self):
        rebuild(self.store, now_ts=ts("2026-10-29 08:00"))
        self.store.conn.execute("UPDATE events SET status = 'done'")
        self.store.conn.commit()
        rebuild(self.store, now_ts=ts("2026-10-29 09:00"))
        self.assertEqual(self.store.agenda(ts("2026-10-01 00:00"), ts("2026-12-01 00:00")), [])
        row = self.store.conn.execute("SELECT status FROM events").fetchone()
        self.assertEqual(row["status"], "done")


class AgendaIncrementalTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = Store(self.root / "archive.db")
        self.cfg = Config(
            raw={
                "data_dir": str(self.root / "data"),
                "qq": {"enabled": False},
                "wechat": {"enabled": False},
                "voice": {"enabled": False},
                "llm": {"enabled": False},
                "agent": {"agenda_ai": True},
            },
            path=self.root / "config.json",
        )
        self.llm_cfg = Config(
            raw={
                **self.cfg.raw,
                "llm": {
                    "enabled": True,
                    "base_url": "http://127.0.0.1:11434/v1",
                    "model": "stub",
                },
            },
            path=self.cfg.path,
        )
        self.conv = self.store.upsert_conversation(
            Conversation(
                source="qq", account="1", external_id="qq:g:1", name="班群", kind="group"
            )
        )
        self.store.add_messages(
            self.conv,
            [
                Message(
                    external_id="a1",
                    ts=ts("2026-10-26 11:00"),
                    content="11月5日前提交材料",
                    sender_name="班长",
                )
            ],
        )

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def _add(self, external_id: str, content: str, when: str = "2026-10-26 12:00") -> None:
        self.store.add_messages(
            self.conv,
            [Message(external_id=external_id, ts=ts(when), content=content, sender_name="团支书")],
        )

    def test_scans_only_new_messages(self):
        first = update_agenda(self.store, self.cfg)
        self.assertEqual(first["mode"], "rebuild")
        self.assertEqual(first["total"], 1)
        self.assertEqual(self.store.agenda_cursor(), self.store.max_message_id())
        self.assertIsNone(update_agenda(self.store, self.cfg))

        self._add("a2", "11月6日前交报名表")
        second = update_agenda(self.store, self.cfg)
        self.assertEqual(second["scanned"], 1)
        self.assertEqual(second["inserted"], 1)
        self.assertEqual(second["total"], 2)
        self.assertEqual(second["mode"], "rules")

    def test_merges_duplicate_notice_from_new_message(self):
        update_agenda(self.store, self.cfg)
        self._add("a2", "11月5日前提交材料")
        stats = update_agenda(self.store, self.cfg)
        self.assertEqual(stats["scanned"], 1)
        self.assertEqual(stats["inserted"], 0)
        self.assertEqual(stats["total"], 1)

    def test_ai_items_are_inserted(self):
        update_agenda(self.store, self.cfg)
        self._add("a2", "周五下午3点在学院楼开班会", "2026-10-26 13:00")
        message_id = self.store.max_message_id()
        reply = (
            True,
            [
                {
                    "id": message_id,
                    "title": "学院楼开班会",
                    "due": "2026-10-30 15:00",
                    "all_day": False,
                    "kind": "meeting",
                    "detail": "周五下午3点",
                }
            ],
        )
        with mock.patch("infohub.agenda.llm_mod.agenda_events", return_value=reply):
            stats = update_agenda(self.store, self.llm_cfg)
        self.assertEqual(stats["mode"], "ai")
        self.assertEqual(stats["inserted"], 1)
        rows = self.store.agenda(ts("2026-10-29 00:00"), ts("2026-10-31 00:00"))
        self.assertEqual(rows[0]["title"], "学院楼开班会")
        self.assertEqual(rows[0]["kind"], "meeting")

    def test_ai_failure_falls_back_to_rules(self):
        update_agenda(self.store, self.cfg)
        self._add("a2", "11月7日前交材料")
        with mock.patch(
            "infohub.agenda.llm_mod.agenda_events",
            return_value=(False, "HTTP 402 · 余额不足"),
        ):
            stats = update_agenda(self.store, self.llm_cfg)
        self.assertEqual(stats["mode"], "rules")
        self.assertIn("402", stats["ai_error"])
        self.assertEqual(stats["inserted"], 1)

    def test_first_run_covers_existing_messages(self):
        self._add("a2", "11月6日前交报名表")
        first = update_agenda(self.store, self.cfg)
        self.assertEqual(first["mode"], "rebuild")
        self.assertEqual(first["scanned"], 2)
        self.assertEqual(first["total"], 2)
        self.assertEqual(self.store.agenda_cursor(), self.store.max_message_id())
        self.assertIsNone(update_agenda(self.store, self.cfg))


if __name__ == "__main__":
    unittest.main()
