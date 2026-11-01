import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from infohub import llm
from infohub.config import Config


class _Stub(BaseHTTPRequestHandler):
    requests: list = []
    reply = "ok"
    status = 200
    error_body = ""

    def do_POST(self):  # noqa: N802
        size = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(size).decode("utf-8"))
        type(self).requests.append(
            {
                "path": self.path,
                "body": body,
                "auth": self.headers.get("Authorization"),
                "ua": self.headers.get("User-Agent"),
            }
        )
        if type(self).status != 200:
            raw = type(self).error_body.encode("utf-8")
            self.send_response(type(self).status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        payload = json.dumps(
            {"choices": [{"message": {"content": type(self).reply}}]}, ensure_ascii=False
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):  # noqa: D401
        return


class LlmTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Stub)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}/v1"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        _Stub.requests.clear()
        _Stub.reply = "ok"
        _Stub.status = 200
        _Stub.error_body = ""
        env = mock.patch.dict(
            os.environ,
            {"INFOHUB_LLM_BASE_URL": "", "INFOHUB_LLM_MODEL": "", "INFOHUB_LLM_API_KEY": ""},
        )
        env.start()
        self.addCleanup(env.stop)

    def _cfg(self, **overrides) -> Config:
        opts = {
            "enabled": True,
            "base_url": self.base,
            "model": "test-model",
            "api_key": "sk-test",
            "timeout": 5,
            "allow_remote": False,
        }
        opts.update(overrides)
        return Config(raw={"llm": opts})

    def test_settings_merges_defaults_and_env(self):
        cfg = Config(raw={"llm": {"model": "from-file"}})
        opts = llm.settings(cfg)
        self.assertEqual(opts["model"], "from-file")
        self.assertEqual(opts["base_url"], llm.DEFAULTS["base_url"])
        with mock.patch.dict(os.environ, {"INFOHUB_LLM_MODEL": "from-env"}):
            self.assertEqual(llm.settings(cfg)["model"], "from-env")

    def test_is_local(self):
        self.assertTrue(llm.is_local("http://127.0.0.1:11434/v1"))
        self.assertTrue(llm.is_local("http://localhost:8080/v1"))
        self.assertTrue(llm.is_local("http://192.168.1.9/v1"))
        self.assertTrue(llm.is_local("http://10.0.0.5/v1"))
        self.assertFalse(llm.is_local("https://api.openai.com/v1"))
        self.assertFalse(llm.is_local("http://8.8.8.8/v1"))
        self.assertFalse(llm.is_local(""))

    def test_available_requires_remote_acknowledgement(self):
        remote = self._cfg(base_url="https://api.example.com/v1")
        self.assertFalse(llm.available(remote))
        self.assertTrue(llm.available(self._cfg(base_url="https://api.example.com/v1", allow_remote=True)))
        self.assertTrue(llm.available(self._cfg()))
        self.assertFalse(llm.available(self._cfg(enabled=False)))
        self.assertFalse(llm.available(self._cfg(model="")))

    def test_chat_posts_openai_payload(self):
        ok, text = llm.chat(self._cfg(model="qwen-test"), "你好")
        self.assertTrue(ok, text)
        self.assertEqual(text, "ok")
        sent = _Stub.requests[-1]
        self.assertEqual(sent["path"], "/v1/chat/completions")
        self.assertEqual(sent["body"]["model"], "qwen-test")
        self.assertEqual(sent["body"]["messages"][-1]["content"], "你好")
        self.assertEqual(sent["auth"], "Bearer sk-test")
        self.assertTrue(sent["ua"])
        self.assertNotIn("Python-urllib", sent["ua"])

    def test_opencode_hosts_get_session_header(self):
        opts = llm.settings(self._cfg())
        go = llm._headers(opts, "https://opencode.ai/zen/go/v1/chat/completions")
        self.assertEqual(go["x-opencode-session"], llm.SESSION_ID)
        self.assertTrue(go["User-Agent"].startswith("InfoHub/"))
        other = llm._headers(opts, "https://api.example.com/v1/chat/completions")
        self.assertNotIn("x-opencode-session", other)

    def test_base_url_strips_chat_completions_suffix(self):
        cfg = self._cfg(base_url=self.base + "/chat/completions/")
        self.assertEqual(llm.settings(cfg)["base_url"], self.base)
        ok, detail = llm.chat(cfg, "你好")
        self.assertTrue(ok, detail)
        self.assertEqual(_Stub.requests[-1]["path"], "/v1/chat/completions")

    def test_remote_without_ack_refuses_to_send(self):
        ok, detail = llm.chat(self._cfg(base_url="https://api.example.com/v1"), "你好")
        self.assertFalse(ok)
        self.assertIn("允许上传", detail)
        self.assertEqual(_Stub.requests, [])

    def test_disabled_refuses(self):
        ok, detail = llm.chat(self._cfg(enabled=False), "你好")
        self.assertFalse(ok)
        self.assertIn("未启用", detail)

    def test_report_parses_source_sections(self):
        _Stub.reply = (
            "好的，下面是报告：\n"
            "## 工作 · 结论\n"
            "今天主要是班费收缴和材料提交，其它无异常。\n"
            "## 工作 · 待办与截止\n"
            "- 10-31 18:00 交报名表\n"
            "- **10-31 20:00** 收班费\n"
            "## 工作 · 通知与风险\n"
            "无\n"
            "## 生活 · 动态\n"
            "- 妈妈周日来学校\n"
            "## 生活 · 待办与提醒\n"
            "- 周六下午取快递\n"
        )
        ok, sections = llm.report(self._cfg(), "简报正文")
        self.assertTrue(ok, sections)
        names = [s["title"] for s in sections]
        self.assertEqual(names, list(llm.SECTIONS))
        by_name = {s["title"]: s["items"] for s in sections}
        self.assertIn("班费", by_name["工作 · 结论"][0])
        self.assertEqual(
            by_name["工作 · 待办与截止"], ["10-31 18:00 交报名表", "10-31 20:00 收班费"]
        )
        self.assertEqual(by_name["工作 · 通知与风险"], [])
        self.assertIn("妈妈", by_name["生活 · 动态"][0])
        self.assertIn("快递", by_name["生活 · 待办与提醒"][0])
        self.assertNotIn("*", "\n".join(str(x) for s in sections for x in s["items"]))

    def test_report_accepts_legacy_sections(self):
        _Stub.reply = (
            "## 结论\n无\n"
            "## 待办与截止\n- 10-31 18:00 交报名表\n"
            "## 重要通知\n无\n"
            "## 风险提醒\n- @我 未回\n"
        )
        ok, sections = llm.report(self._cfg(), "简报正本")
        self.assertTrue(ok, sections)
        self.assertEqual([s["title"] for s in sections], list(llm.LEGACY_SECTIONS))

    def test_report_keeps_unformatted_output(self):
        _Stub.reply = "明早要交表\n今天没有别的安排"
        ok, sections = llm.report(self._cfg(), "简报")
        self.assertTrue(ok, sections)
        self.assertEqual(sections[0]["title"], "要点")
        self.assertIn("明早要交表", sections[0]["items"][0])

    def test_report_caps_items_and_strips_empty_words(self):
        _Stub.reply = "## 待办与截止\n" + "\n".join(f"- 第{i}件事" for i in range(9))
        ok, sections = llm.report(self._cfg(), "简报")
        self.assertTrue(ok, sections)
        todo = [s for s in sections if s["title"] == "待办与截止"][0]
        self.assertEqual(len(todo["items"]), 4)

    def test_chat_defaults_to_profile_system(self):
        ok, _ = llm.chat(self._cfg(), "你好")
        self.assertTrue(ok)
        system = _Stub.requests[-1]["body"]["messages"][0]["content"]
        self.assertIn("付梓杨", system)
        self.assertIn("叶老师", system)

    def test_chat_none_system_is_never_null(self):
        cfg = self._cfg(agent_prompt="自定义身份")
        ok, _ = llm.chat(cfg, "你好", system=None)
        self.assertTrue(ok)
        system = _Stub.requests[-1]["body"]["messages"][0]["content"]
        self.assertIn("自定义身份", system)

    def test_report_includes_default_profile(self):
        _Stub.reply = "## 结论\n无"
        ok, _ = llm.report(self._cfg(), "简报正文")
        self.assertTrue(ok)
        system = _Stub.requests[-1]["body"]["messages"][0]["content"]
        self.assertIn("付梓杨", system)
        self.assertIn("叶老师", system)
        self.assertIn("待办与截止", system)

    def test_report_uses_custom_agent_prompt(self):
        _Stub.reply = "## 结论\n无"
        ok, _ = llm.report(self._cfg(agent_prompt="我是测试身份，只认这句话"), "简报正文")
        self.assertTrue(ok)
        system = _Stub.requests[-1]["body"]["messages"][0]["content"]
        self.assertIn("我是测试身份", system)
        self.assertNotIn("叶老师", system)
        self.assertIn("待办与截止", system)

    def test_report_failure_keeps_chinese_hint(self):
        _Stub.status = 429
        _Stub.error_body = '{"error":{"message":"Free usage limit reached"}}'
        ok, detail = llm.report(self._cfg(), "简报")
        self.assertFalse(ok)
        self.assertIn("限流", detail)

    def test_http_error_hints(self):
        cases = [
            (402, '{"error":"Insufficient account funds"}', "余额"),
            (403, "error code: 1010", "Cloudflare"),
            (401, '{"error":"invalid api key"}', "API Key"),
            (404, "not found", "地址不对"),
            (500, "boom", "服务端"),
        ]
        for code, body, hint in cases:
            _Stub.status = code
            _Stub.error_body = body
            ok, detail = llm.test(self._cfg())
            self.assertFalse(ok)
            self.assertIn(hint, detail, detail)
            self.assertIn(str(code), detail)

    def test_test_reports_model(self):
        ok, detail = llm.test(self._cfg(model="qwen-test"))
        self.assertTrue(ok, detail)
        self.assertIn("qwen-test", detail)
        self.assertIn("ok", detail)

    def test_unreachable_gives_chinese_hint(self):
        cfg = self._cfg(base_url="http://127.0.0.1:9/v1", timeout=5)
        ok, detail = llm.test(cfg)
        self.assertFalse(ok)
        self.assertIn("连不上", detail)


    def test_parse_agenda_items(self):
        text = (
            "```json\n"
            '[{"id": 3, "title": "交材料", "due": "2026-11-05 18:00", "all_day": false, '
            '"kind": "signup", "detail": "截止前提交"}, {"id": "bad"}]\n'
            "```"
        )
        items = llm.parse_agenda_items(text)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], 3)
        self.assertEqual(items[0]["kind"], "signup")
        self.assertIsNone(llm.parse_agenda_items("模型没按格式输出"))
        self.assertEqual(llm.parse_agenda_items("[]"), [])
        fallback = llm.parse_agenda_items(
            '[{"id": 1, "title": "开会", "due": "2026-11-05", "kind": "unknown"}]'
        )
        self.assertEqual(fallback[0]["kind"], "task")


if __name__ == "__main__":
    unittest.main()
