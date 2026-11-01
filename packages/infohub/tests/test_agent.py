import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from infohub import agent
from infohub.config import Config
from infohub.models import Conversation, Message
from infohub.push import PushResult
from infohub.store import Store


class AgentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.vault = self.root / "vault"
        self.vault.mkdir()
        self.store = Store(self.root / "archive.db")
        self.cfg = Config(
            raw={
                "data_dir": str(self.root / "data"),
                "qq": {"enabled": False},
                "wechat": {"enabled": False},
                "voice": {"enabled": False},
                "kb": {"vault": str(self.vault)},
                "digest": {"hours": 1, "self_names": [], "exclude_convs": []},
                "llm": {"enabled": False},
                "push": {"enabled": False, "channel": "none"},
                "agent": {"enabled": True},
            },
            path=self.root / "config.json",
        )
        self.now = int(time.time())
        self.work = self.store.upsert_conversation(
            Conversation(source="qq", account="1", external_id="qq:1", name="金融2601班群", kind="group")
        )
        self.life = self.store.upsert_conversation(
            Conversation(source="wechat", account="2", external_id="wx:1", name="家里人")
        )
        self.store.add_messages(
            self.work,
            [
                Message(external_id="w1", ts=self.now - 120, sender_name="叶老师", content="明早 8:00 交材料"),
                Message(external_id="w2", ts=self.now - 110, sender_name="林寸", is_self=True, content="收到"),
            ],
        )
        self.store.add_messages(
            self.life,
            [Message(external_id="l1", ts=self.now - 100, sender_name="妈妈", content="周日来学校看你")],
        )

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def _run(self, **kwargs):
        return agent.run(
            self.cfg,
            self.store,
            hours=1,
            plan=kwargs.pop("plan", ["analyze", "archive", "agenda", "push"]),
            **kwargs,
        )

    def test_pipeline_archives_work_and_life(self):
        run = self._run()
        self.assertEqual([s.name for s in run.steps], ["analyze", "archive", "agenda", "push"])
        self.assertEqual(run.steps[0].status, "ok", run.steps[0].detail)
        self.assertEqual(run.steps[1].status, "ok", run.steps[1].detail)
        self.assertEqual(run.steps[3].status, "skip")
        self.assertGreater(self.store.digest_cursor(), 0)

        work_files = [
            p for p in (self.vault / agent.WORK_SUBDIR).rglob("*.md") if p.name != "index.md"
        ]
        life_files = [
            p for p in (self.vault / agent.LIFE_SUBDIR).rglob("*.md") if p.name != "index.md"
        ]
        self.assertEqual(len(work_files), 1)
        self.assertEqual(len(life_files), 1)
        self.assertTrue((self.vault / agent.WORK_SUBDIR / "index.md").is_file())
        self.assertTrue((self.vault / agent.LIFE_SUBDIR / "index.md").is_file())
        work = work_files[0].read_text(encoding="utf-8")
        life = life_files[0].read_text(encoding="utf-8")
        self.assertIn("明早 8:00 交材料", work)
        self.assertIn("收到", work)
        self.assertNotIn("妈妈", work)
        self.assertIn("周日来学校看你", life)
        self.assertNotIn("叶老师", life)
        self.assertIn("type: infohub-message-archive", work)
        self.assertIn("## 会话", work)
        self.assertTrue((self.vault / "学院事务/班级管理/InfoHub-小时简报.md").is_file())
        self.assertTrue((self.vault / "学院事务/日程安排.md").is_file())
        self.assertTrue(Path(run.path).is_file())
        self.assertIn("新消息 3", run.headline)

    def test_latest_run_roundtrip(self):
        run = self._run()
        latest = agent.latest_run(self.cfg)
        self.assertIsNotNone(latest)
        self.assertEqual(latest["steps"][0]["name"], "analyze")
        self.assertEqual(latest["started"], run.started)
        self.assertIn("summary", latest)

    def test_push_step_calls_push(self):
        self.cfg.raw["push"] = {
            "enabled": True,
            "channel": "wecom_bot",
            "wecom_bot_id": "bot-id",
            "wecom_bot_secret": "bot-secret",
        }
        with mock.patch(
            "infohub.agent.push_mod.push",
            return_value=PushResult(True, "wecom_bot", "已发送"),
        ) as fake:
            run = agent.run(
                self.cfg,
                self.store,
                hours=1,
                archive=False,
                plan=["analyze", "push"],
            )
        self.assertTrue(fake.called)
        self.assertEqual(run.steps[-1].status, "ok")
        self.assertIn("已发送", run.steps[-1].detail)

    def test_quick_sync_is_unlogged_and_side_effect_free(self):
        run = self._run(plan=["sync"], log=False)
        self.assertEqual([s.name for s in run.steps], ["sync"])
        self.assertEqual(run.steps[0].status, "ok", run.steps[0].detail)
        self.assertEqual(run.path, "")
        self.assertFalse(agent.runs_dir(self.cfg).exists())
        self.assertFalse((self.vault / agent.WORK_SUBDIR).exists())
        self.assertFalse((self.vault / agent.LIFE_SUBDIR).exists())

    def test_skips_archive_and_push(self):
        run = agent.run(
            self.cfg,
            self.store,
            hours=1,
            archive=False,
            push=False,
            plan=["analyze", "archive", "agenda", "push"],
        )
        self.assertEqual(run.steps[1].status, "skip")
        self.assertEqual(run.steps[2].status, "skip")
        self.assertEqual(run.steps[3].status, "skip")
        self.assertFalse((self.vault / agent.WORK_SUBDIR).exists())

    def test_unknown_tool_is_reported(self):
        run = agent.run(
            self.cfg, self.store, hours=1, plan=["analyze", "fly"]
        )
        self.assertEqual(run.steps[-1].name, "fly")
        self.assertEqual(run.steps[-1].status, "skip")


if __name__ == "__main__":
    unittest.main()
