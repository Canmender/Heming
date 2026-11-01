import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from infohub import wecom_bot
from infohub.config import Config
from infohub.ui import settings as settings_mod
from infohub.ui.settings import SettingsDialog

APP = QApplication.instance() or QApplication([])


def _cfg(root: Path, channel="smtp") -> Config:
    cfg = Config(
        raw={
            "data_dir": str(root),
            "push": {
                "enabled": False,
                "channel": channel,
                "wecom_bot_id": "",
                "wecom_bot_secret": "",
                "wecom_bot_port": 65531,
                "smtp_host": "smtp.qq.com",
                "smtp_port": 465,
            },
            "llm": {"enabled": False},
        },
        path=root / "config.json",
    )
    cfg.save()
    return cfg


def _wait(label, seconds=4.0) -> str:
    end = time.time() + seconds
    while time.time() < end:
        APP.processEvents()
        if label.text() and "测试中" not in label.text():
            return label.text()
        time.sleep(0.02)
    return label.text()


class SettingsDialogTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_loads_existing_values(self):
        cfg = _cfg(self.root, channel="wecom_bot")
        cfg.raw["push"].update(wecom_bot_id="aibX", wecom_bot_secret="sec", wecom_bot_port=65532)
        cfg.raw["llm"].update(
            enabled=True,
            base_url="https://api.example.com/v1",
            model="gpt-test",
            allow_remote=True,
            prompt="重点写截稿",
        )
        dlg = SettingsDialog(cfg)
        self.assertEqual(dlg.channel.currentData(), "wecom_bot")
        self.assertEqual(dlg.bot_id.text(), "aibX")
        self.assertEqual(dlg.bot_port.value(), 65532)
        self.assertTrue(dlg.llm_enabled.isChecked())
        self.assertEqual(dlg.llm_model.text(), "gpt-test")
        self.assertFalse(dlg.llm_remote.isEnabled() and dlg.llm_base.text() == "")
        self.assertEqual(dlg.bot_secret.echoMode().name, "Password")
        dlg.close()

    def test_remote_llm_requires_acknowledgement(self):
        cfg = _cfg(self.root)
        dlg = SettingsDialog(cfg)
        dlg.llm_enabled.setChecked(True)
        dlg.llm_base.setText("https://api.example.com/v1")
        self.assertTrue(dlg.llm_remote.isEnabled())
        self.assertIn("勾选", dlg.llm_warn.text())
        warned = []
        with mock.patch.object(
            settings_mod.QMessageBox, "warning", side_effect=lambda *a, **k: warned.append(a[2])
        ):
            self.assertFalse(dlg._validate())
        self.assertEqual(len(warned), 1)
        saved = json.loads(cfg.path.read_text(encoding="utf-8"))
        self.assertFalse(saved["llm"]["enabled"])
        dlg.llm_remote.setChecked(True)
        self.assertTrue(dlg._validate())
        dlg.close()

    def test_save_writes_config_and_reports_bot_change(self):
        cfg = _cfg(self.root)
        dlg = SettingsDialog(cfg)
        dlg.push_enabled.setChecked(True)
        dlg.channel.setCurrentIndex(dlg.channel.findData("wecom_bot"))
        dlg.bot_id.setText("aibTest")
        dlg.bot_secret.setText("secret-test")
        dlg.bot_port.setValue(65533)
        dlg.llm_enabled.setChecked(True)
        dlg.llm_base.setText("http://127.0.0.1:11434/v1")
        dlg.llm_model.setText("qwen2.5:7b")
        saved = []
        synced = []
        dlg.saved.connect(saved.append)
        dlg.synced.connect(lambda ok, detail: synced.append((ok, detail)))
        calls = []
        with mock.patch.object(wecom_bot, "status", return_value=None), mock.patch.object(
            wecom_bot, "ensure_daemon", side_effect=lambda c, wait=12.0: calls.append("ensure") or {"ok": True, "pid": 7}
        ), mock.patch.object(wecom_bot, "stop_daemon", return_value=(True, "已退出")):
            dlg._save()
            dlg.tasks_done(3000)
        data = json.loads(cfg.path.read_text(encoding="utf-8"))
        self.assertEqual(saved, [True])
        self.assertEqual(data["push"]["channel"], "wecom_bot")
        self.assertEqual(data["push"]["wecom_bot_secret"], "secret-test")
        self.assertEqual(data["push"]["wecom_bot_port"], 65533)
        self.assertTrue(data["llm"]["enabled"])
        self.assertEqual(data["llm"]["model"], "qwen2.5:7b")
        self.assertEqual(calls, ["ensure"])

    def test_switch_away_from_bot_stops_daemon(self):
        cfg = _cfg(self.root, channel="wecom_bot")
        with mock.patch.object(wecom_bot, "status", return_value={"ok": True}), mock.patch.object(
            wecom_bot, "stop_daemon", return_value=(True, "已退出")
        ) as stop:
            dlg = SettingsDialog(cfg)
            dlg.channel.setCurrentIndex(dlg.channel.findData("smtp"))
            ok, detail = dlg._sync_bot(False)
        self.assertTrue(ok)
        self.assertIn("已停止", detail)
        self.assertTrue(stop.called)
        dlg.close()

    def test_test_push_against_local_webhook(self):
        class Hook(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                body = b'{"errcode":0,"errmsg":"ok"}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Hook)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            cfg = _cfg(self.root, channel="wecom")
            cfg.raw["push"]["wecom_webhook"] = f"http://127.0.0.1:{httpd.server_address[1]}/hook"
            dlg = SettingsDialog(cfg)
            dlg.channel.setCurrentIndex(dlg.channel.findData("wecom"))
            dlg.webhook.setText(cfg.raw["push"]["wecom_webhook"])
            dlg._test_push()
            text = _wait(dlg.push_test_label)
            self.assertIn("成功", text)
            self.assertIn("已发送", text)
            dlg.close()
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
