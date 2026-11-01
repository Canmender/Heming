import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from infohub import push
from infohub.config import Config


class _Hook(BaseHTTPRequestHandler):
    received: list = []
    reply = {"errcode": 0, "errmsg": "ok"}

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8")
        type(self).received.append(json.loads(body))
        data = json.dumps(self.reply).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):  # 静音
        pass


class WecomTest(unittest.TestCase):
    def setUp(self):
        _Hook.received = []
        _Hook.reply = {"errcode": 0, "errmsg": "ok"}
        self.server = HTTPServer(("127.0.0.1", 0), _Hook)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/cgi-bin/webhook/send?key=test"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_payload(self):
        result = push.send_wecom(self.url, "**标题**\n内容")
        self.assertTrue(result.ok, result.detail)
        payload = _Hook.received[0]
        self.assertEqual(payload["msgtype"], "markdown")
        self.assertEqual(payload["markdown"]["content"], "**标题**\n内容")

    def test_error_code(self):
        _Hook.reply = {"errcode": 93000, "errmsg": "invalid webhook url"}
        result = push.send_wecom(self.url, "x")
        self.assertFalse(result.ok)
        self.assertIn("93000", result.detail)
        self.assertIn("webhook 地址无效", result.detail)

    def test_rate_limit_hint(self):
        _Hook.reply = {"errcode": 45009, "errmsg": "api freq out of limit"}
        result = push.send_wecom(self.url, "x")
        self.assertIn("每分钟最多 20 条", result.detail)

    def test_long_markdown_clipped_by_bytes(self):
        result = push.send_wecom(self.url, "简报" * 2000)
        self.assertTrue(result.ok, result.detail)
        content = _Hook.received[0]["markdown"]["content"]
        self.assertLessEqual(len(content.encode("utf-8")), push.WECOM_LIMIT)
        self.assertTrue(content.endswith("…"))

    def test_unreachable(self):
        result = push.send_wecom("http://127.0.0.1:9/hook", "x", timeout=2)
        self.assertFalse(result.ok)

    def test_config_gate(self):
        cfg = Config(raw={"push": {"enabled": False, "channel": "wecom", "wecom_webhook": self.url}})
        self.assertTrue(push.configured(cfg))
        result = push.push(cfg, "s", "t")
        self.assertFalse(result.ok)
        self.assertIn("未启用", result.detail)
        cfg.raw["push"]["enabled"] = True
        self.assertTrue(push.push(cfg, "s", "t").ok)
        self.assertEqual(len(_Hook.received), 1)

    def test_bare_key_becomes_webhook(self):
        cfg = Config(raw={"push": {"channel": "wecom", "wecom_webhook": "abc-123"}})
        opts = push.settings(cfg)
        self.assertEqual(
            opts["wecom_webhook"],
            "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123",
        )
        self.assertTrue(push.configured(cfg))

    def test_missing_lists_fields(self):
        cfg = Config(raw={"push": {"channel": "smtp", "smtp_host": "smtp.qq.com", "smtp_user": "a@qq.com"}})
        self.assertEqual(push.missing(cfg), ["smtp_pass"])  # mail_to 缺省回落到 smtp_user
        cfg = Config(raw={"push": {"channel": "none"}})
        self.assertEqual(push.missing(cfg), ["channel"])
        self.assertFalse(push.configured(cfg))

    def test_env_override(self):
        cfg = Config(raw={"push": {"channel": "wecom", "wecom_webhook": ""}})
        self.assertFalse(push.configured(cfg))
        import os

        os.environ["INFOHUB_WECOM_WEBHOOK"] = self.url
        try:
            self.assertTrue(push.configured(cfg))
        finally:
            del os.environ["INFOHUB_WECOM_WEBHOOK"]


class FakeSMTP:
    sent = []

    def __init__(self, host, port, timeout=0, context=None):
        self.host = host
        self.port = port
        self.logged = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def login(self, user, password):
        self.logged = (user, password)

    def send_message(self, msg):
        type(self).sent.append((self.logged, msg["Subject"], msg.get_payload()))


class SmtpTest(unittest.TestCase):
    def setUp(self):
        FakeSMTP.sent = []

    def test_ssl_send(self):
        import smtplib
        from unittest import mock

        opts = {
            "smtp_host": "smtp.example.com",
            "smtp_port": 465,
            "smtp_user": "me@example.com",
            "smtp_pass": "code",
            "mail_to": "me@example.com",
        }
        with mock.patch.object(smtplib, "SMTP_SSL", FakeSMTP):
            result = push.send_smtp(opts, "简报", "正文", "<p>正文</p>")
        self.assertTrue(result.ok, result.detail)
        self.assertEqual(FakeSMTP.sent[0][0], ("me@example.com", "code"))
        self.assertEqual(len(FakeSMTP.sent[0][2]), 2)  # text + html

    def test_missing_config(self):
        result = push.send_smtp({"smtp_host": "smtp.example.com"}, "s", "t")
        self.assertFalse(result.ok)
        self.assertIn("未配置完整", result.detail)


if __name__ == "__main__":
    unittest.main()
