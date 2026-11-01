"""stdio 桥的协议与只读语义测试。

跑法（在 packages/infohub 下）：
    python -m unittest tests.test_bridge
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from infohub.models import Conversation, Message
from infohub.store import Store

PACKAGE_ROOT = Path(__file__).resolve().parent.parent


class BridgeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.home = Path(self.tmp.name)
        (self.home / "data").mkdir(parents=True, exist_ok=True)
        db = self.home / "data" / "archive.db"
        store = Store(db)
        self.conv_id = store.upsert_conversation(
            Conversation(
                source="qq",
                account="",
                external_id="qq:private:1",
                name="叶老师",
                kind="private",
                last_ts=1_800_000_100,
            )
        )
        self.message_ids = []
        store.add_messages(
            self.conv_id,
            [
                Message(external_id="m1", ts=1_800_000_000, sender_name="叶老师", content="明天交免检单"),
                Message(external_id="m2", ts=1_800_000_100, sender_name="我", content="收到", is_self=True),
            ],
        )
        rows = store.conn.execute(
            "SELECT id FROM messages WHERE conversation_id = ? ORDER BY ts", (self.conv_id,)
        ).fetchall()
        self.message_ids = [int(row["id"]) for row in rows]
        store.insert_events(
            [
                (
                    self.message_ids[0],
                    self.conv_id,
                    "交免检单",
                    "明天交免检单",
                    int(time.time()) + 3600,
                    "明天",
                    1,
                    "task",
                )
            ]
        )
        self.db = db
        store.close()

        env = os.environ.copy()
        env["INFOHUB_HOME"] = str(self.home)
        env["PYTHONPATH"] = str(PACKAGE_ROOT)
        env["PYTHONIOENCODING"] = "utf-8"
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "infohub.bridge"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(PACKAGE_ROOT),
            env=env,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        hello = self._read_line()
        self.assertEqual(hello.get("event"), "hello")
        self.assertEqual(hello.get("app"), "infohub")

    def tearDown(self) -> None:
        try:
            if self.proc.poll() is None:
                self._send({"id": 9999, "method": "shutdown"})
                self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()
        finally:
            try:
                self.proc.wait(timeout=5)
            except Exception:
                self.proc.kill()
            for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
                try:
                    stream.close()
                except Exception:
                    pass
            time.sleep(0.2)
            self.tmp.cleanup()

    def _read_line(self) -> dict:
        line = self.proc.stdout.readline()
        self.assertTrue(line, "桥进程没有输出就退出了")
        return json.loads(line)

    def _send(self, payload: dict) -> None:
        self.proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()

    def _request(self, request_id: int, method: str, params: dict | None = None) -> dict:
        message = {"id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        self._send(message)
        for _ in range(50):
            line = self._read_line()
            if line.get("event"):
                continue
            if line.get("id") == request_id:
                return line
        self.fail(f"{method} 没有返回")

    def test_ping_and_status(self) -> None:
        ping = self._request(1, "ping")["result"]
        self.assertEqual(ping["home"], str(self.home))
        self.assertTrue(ping["hasDb"])
        self.assertEqual(ping["dbPath"], str(self.db))

        status = self._request(2, "status")["result"]
        self.assertEqual(status["stats"]["conversations"], 1)
        self.assertEqual(status["stats"]["messages"], 2)
        self.assertEqual(status["events"], 1)
        self.assertTrue(status["hasDb"])

    def test_conversations_messages_and_search(self) -> None:
        convs = self._request(3, "conversations", {"limit": 10})["result"]
        self.assertEqual(convs["total"], 1)
        self.assertEqual(convs["items"][0]["name"], "叶老师")

        payload = self._request(
            4, "messages", {"conversationId": self.conv_id, "limit": 10}
        )["result"]
        self.assertEqual(len(payload["items"]), 2)
        self.assertTrue(payload["items"][1]["is_self"])
        self.assertEqual(payload["items"][0]["content"], "明天交免检单")

        found = self._request(5, "search", {"query": "免检单"})["result"]
        self.assertEqual(len(found["items"]), 1)
        self.assertEqual(found["items"][0]["convName"], "叶老师")

    def test_agenda(self) -> None:
        payload = self._request(6, "agenda", {"days": 7, "overdue": 1})["result"]
        self.assertEqual(payload["summary"]["total"], 1)
        self.assertEqual(payload["items"][0]["title"], "交免检单")
        self.assertEqual(payload["items"][0]["convName"], "叶老师")

    def test_unknown_method_and_bad_params(self) -> None:
        missing = self._request(7, "messages", {})
        self.assertFalse(missing["ok"])
        self.assertIn("conversationId", missing["error"]["message"])
        unknown = self._request(8, "shell.exec")
        self.assertFalse(unknown["ok"])
        self.assertIn("未知方法", unknown["error"]["message"])

    def test_read_methods_do_not_modify_archive(self) -> None:
        before = hashlib.sha256(self.db.read_bytes()).hexdigest()
        self._request(10, "status")
        self._request(11, "conversations")
        self._request(12, "messages", {"conversationId": self.conv_id})
        self._request(13, "search", {"query": "免检单"})
        self._request(14, "agenda")
        after = hashlib.sha256(self.db.read_bytes()).hexdigest()
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
