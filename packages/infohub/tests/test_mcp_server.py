"""和鸣随包 MCP 采集桥（`infohub.mcp_server`）的协议层与工具层测试。

跑法（在 packages/infohub 下）：

    python -m unittest tests.test_mcp_server -v

两条原则：
1. **协议层起真实 HTTP**：真起一个 `ThreadingHTTPServer(("127.0.0.1", 0), McpHandler)`，
   用 `http.client` 打真实的 Host / CORS / 请求体上限 / JSON-RPC 错误码——这些边界
   只有真跑一遍才靠得住。端口用 0 让系统分配，用完 shutdown + server_close（不留服务）。
2. **工具层用临时 sqlite**：每个用例自己建一个临时归档库（`Store` 建库 + `infohub.models`
   插数据），并把 `mcp_server._config` 与 `INFOHUB_HOME` 一起 mock 掉，
   绝不读到用户真实归档（`D:\\wohaolei` 那一份）。
"""

from __future__ import annotations

import ast
import contextlib
import http.client
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from infohub import cli, mcp_server
from infohub.models import Conversation, Message
from infohub.store import Store

EXPECTED_TOOL_ORDER = [
    "infohub_status",
    "infohub_sync",
    "infohub_archive_search",
    "infohub_archive_read",
    "infohub_archive_agenda",
    "infohub_conversations",
    "infohub_agenda_rebuild",
]


def _rpc(method: str, params: dict | None = None, request_id: int | None = 1) -> dict:
    payload: dict = {"jsonrpc": "2.0", "method": method, "params": params or {}}
    if request_id is not None:
        payload["id"] = request_id
    return payload


# ---------------------------------------------------------------- 协议层


class _ServerCase(unittest.TestCase):
    """起一个真实的本机 HTTP 服务，用 http.client 打协议层。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), mcp_server.McpHandler)
        cls.server.daemon_threads = True
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def request(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        headers: dict | None = None,
    ) -> tuple[int, bytes, dict]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        merged = {"Content-Type": "application/json", **(headers or {})}
        conn.request(method, path, body=body, headers=merged)
        res = conn.getresponse()
        raw = res.read()
        result = (res.status, raw, dict(res.getheaders()))
        conn.close()
        return result

    def post(self, payload, headers: dict | None = None) -> tuple[int, dict | list | None, dict]:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        status, raw, response_headers = self.request("POST", "/mcp", body, headers)
        parsed = json.loads(raw.decode("utf-8")) if raw else None
        return status, parsed, response_headers


class ProtocolTest(_ServerCase):
    def test_initialize_returns_server_info(self) -> None:
        status, body, headers = self.post(
            _rpc("initialize", {"protocolVersion": "2025-06-18", "clientInfo": {"name": "t"}})
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["jsonrpc"], "2.0")
        self.assertEqual(body["id"], 1)
        self.assertEqual(body["result"]["serverInfo"]["name"], "infohub-mcp")
        self.assertEqual(body["result"]["protocolVersion"], "2025-06-18")
        self.assertFalse(body["result"]["capabilities"]["tools"]["listChanged"])
        self.assertIn("application/json", headers.get("Content-Type", ""))

    def test_tools_list_order_and_write_flags(self) -> None:
        status, body, _ = self.post(_rpc("tools/list"))
        self.assertEqual(status, 200)
        tools = body["result"]["tools"]
        names = [tool["name"] for tool in tools]
        # 顺序是契约：插件技能按这个顺序介绍工具，测试钉住，别随手重排。
        self.assertEqual(names, EXPECTED_TOOL_ORDER)
        by_name = {tool["name"]: tool for tool in tools}
        # 和鸣按工具名判风险：两个写工具的描述必须自己说清「写操作 + 先让用户确认」。
        for name in ("infohub_sync", "infohub_agenda_rebuild"):
            description = by_name[name]["description"]
            self.assertIn("写操作", description)
            self.assertIn("调用前应由用户确认", description)
        self.assertNotIn("写操作", by_name["infohub_status"]["description"])
        self.assertEqual(
            by_name["infohub_sync"]["inputSchema"]["properties"]["sources"]["items"]["enum"],
            ["qq", "wechat"],
        )

    def test_initialized_notification_gets_202(self) -> None:
        status, body, _ = self.post(_rpc("notifications/initialized", request_id=None))
        self.assertEqual(status, 202)
        self.assertIsNone(body)

    def test_ping(self) -> None:
        status, body, _ = self.post(_rpc("ping"))
        self.assertEqual(status, 200)
        self.assertEqual(body["result"], {})

    def test_health_endpoint(self) -> None:
        status, raw, headers = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw.decode("utf-8"))["name"], "infohub-mcp")
        self.assertIn("application/json", headers.get("Content-Type", ""))

    def test_unknown_path_is_404(self) -> None:
        status, body, _ = self.post(_rpc("ping"), headers=None)
        self.assertEqual(status, 200)
        status, raw, _ = self.request("POST", "/nope", b"{}")
        self.assertEqual(status, 404)
        self.assertIn("POST /mcp", json.loads(raw.decode("utf-8"))["error"])

    def test_get_on_mcp_is_405(self) -> None:
        status, raw, _ = self.request("GET", "/mcp")
        self.assertEqual(status, 405)
        self.assertIn("POST", json.loads(raw.decode("utf-8"))["error"])

    def test_cors_preflight(self) -> None:
        status, raw, headers = self.request("OPTIONS", "/mcp")
        self.assertEqual(status, 204)
        self.assertEqual(raw, b"")
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")
        self.assertIn("POST", headers.get("Access-Control-Allow-Methods", ""))
        self.assertIn("content-type", headers.get("Access-Control-Allow-Headers", ""))

    def test_foreign_host_is_refused(self) -> None:
        status, body, _ = self.post(_rpc("ping"), headers={"Host": "evil.example.com"})
        self.assertEqual(status, 403)
        self.assertIn("回环", body["error"])

    def test_loopback_host_variants_are_accepted(self) -> None:
        for host in ("127.0.0.1", "127.0.0.1:%d" % 1, "localhost", "localhost:8776", "[::1]:8776"):
            status, body, _ = self.post(_rpc("ping"), headers={"Host": host})
            self.assertEqual(status, 200, host)
            self.assertEqual(body["result"], {})

    def test_bad_json_is_400(self) -> None:
        status, raw, _ = self.request("POST", "/mcp", b"{not json")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(raw.decode("utf-8"))["error"]["code"], -32700)

    def test_empty_body_is_400(self) -> None:
        status, raw, _ = self.request("POST", "/mcp", b"", {"Content-Length": "0"})
        self.assertEqual(status, 400)

    def test_oversized_body_is_413(self) -> None:
        # 只发头不发体：服务端看到 Content-Length 超限就应直接拒绝，不该读完再判断。
        status, raw, _ = self.request(
            "POST", "/mcp", b"", {"Content-Length": str(mcp_server.MAX_BODY_BYTES + 1)}
        )
        self.assertEqual(status, 413)

    def test_unknown_method_is_32601(self) -> None:
        status, body, _ = self.post(_rpc("no/such-method"))
        self.assertEqual(status, 200)
        self.assertEqual(body["error"]["code"], -32601)
        self.assertIn("no/such-method", body["error"]["message"])

    def test_missing_method_is_32600(self) -> None:
        status, body, _ = self.post({"jsonrpc": "2.0", "id": 7})
        self.assertEqual(status, 200)
        self.assertEqual(body["error"]["code"], -32600)
        self.assertEqual(body["id"], 7)

    def test_non_object_request_is_32600(self) -> None:
        # JSON `null` 是合法 JSON 但不是 JSON-RPC 对象。
        status, raw, _ = self.request("POST", "/mcp", b"null")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw.decode("utf-8"))["error"]["code"], -32600)

    def test_unknown_tool_is_32602(self) -> None:
        status, body, _ = self.post(_rpc("tools/call", {"name": "nope", "arguments": {}}))
        self.assertEqual(status, 200)
        self.assertEqual(body["error"]["code"], -32602)
        self.assertIn("nope", body["error"]["message"])

    def test_tools_call_missing_name_is_32602(self) -> None:
        status, body, _ = self.post(_rpc("tools/call", {"arguments": {}}))
        self.assertEqual(body["error"]["code"], -32602)

    def test_tools_call_bad_arguments_become_is_error(self) -> None:
        # 参数错属于「调用失败」：回 isError 内容而不是 JSON-RPC error，模型能读到原因。
        status, body, _ = self.post(
            _rpc("tools/call", {"name": "infohub_archive_search", "arguments": {}})
        )
        self.assertEqual(status, 200)
        result = body["result"]
        self.assertTrue(result["isError"])
        self.assertEqual(result["content"][0]["type"], "text")
        self.assertIn("query", result["content"][0]["text"])

    def test_batch_request_returns_list(self) -> None:
        status, body, _ = self.post(
            [
                _rpc("ping", request_id=1),
                _rpc("notifications/initialized", request_id=None),
                _rpc("tools/list", request_id=2),
            ]
        )
        self.assertEqual(status, 200)
        self.assertIsInstance(body, list)
        self.assertEqual([item["id"] for item in body], [1, 2])
        self.assertIn("tools", body[1]["result"])


# ---------------------------------------------------------------- 工具层


class _ArchiveCase(unittest.TestCase):
    """工具层：临时 sqlite 当归档库，config 与 HOME 全部 mock 掉。"""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.home = Path(self.tmp.name)
        self.db_path = self.home / "data" / "archive.db"
        self.now = int(time.time())

        store = Store(self.db_path)
        self.qq_conv = store.upsert_conversation(
            Conversation(
                source="qq",
                account="10001",
                external_id="group-1",
                name="学院事务群",
                kind="group",
                last_ts=self.now - 60,
            )
        )
        store.add_messages(
            self.qq_conv,
            [
                Message(
                    external_id="m1",
                    ts=self.now - 60,
                    sender_name="叶老师",
                    content="明天下午3点前提交免检单",
                ),
                Message(
                    external_id="m2",
                    ts=self.now,
                    sender_name="我",
                    content="收到，已经在整理了",
                    is_self=True,
                ),
            ],
        )
        self.wx_conv = store.upsert_conversation(
            Conversation(
                source="wechat",
                account="wxid_self",
                external_id="wxid_peer",
                name="叶老师",
                last_ts=self.now + 5,
            )
        )
        store.add_messages(
            self.wx_conv,
            [
                Message(
                    external_id="w1",
                    ts=self.now + 5,
                    sender_name="叶老师",
                    content="晚自习免检单已经交了",
                )
            ],
        )
        row = store.conn.execute(
            "SELECT id FROM messages WHERE conversation_id = ? ORDER BY ts", (self.qq_conv,)
        ).fetchone()
        self.qq_msg_id = int(row["id"])
        store.close()

        # config / home 双保险：_config 被替换成临时库；INFOHUB_HOME 也指向临时目录，
        # 万一有代码路径绕过 _config 也读不到用户真实归档。
        self.patches = [
            mock.patch.dict(os.environ, {"INFOHUB_HOME": str(self.home)}),
            mock.patch.object(mcp_server, "_config", self._fake_config),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self) -> None:
        for patch in reversed(self.patches):
            patch.stop()
        self.tmp.cleanup()

    def _fake_config(self) -> SimpleNamespace:
        return SimpleNamespace(
            archive_db=str(self.db_path),
            data_dir=str(self.home / "data"),
            qq={"enabled": True},
            wechat={"enabled": True},
        )

    def writable_store(self) -> Store:
        return Store(self.db_path)

    def call(self, name: str, arguments: dict | None = None) -> dict:
        result = mcp_server.call_tool(name, arguments or {})
        self.assertFalse(result["isError"], result["content"][0]["text"])
        return json.loads(result["content"][0]["text"])

    def rpc_result(self, name: str, arguments: dict) -> dict:
        reply = mcp_server.handle_rpc(_rpc("tools/call", {"name": name, "arguments": arguments}))
        return reply["result"]


class StatusTest(_ArchiveCase):
    def test_status_counts_and_sources(self) -> None:
        data = self.call("infohub_status")
        self.assertEqual(data["conversations"], 2)
        self.assertEqual(data["messages"], 3)
        self.assertEqual(data["perSource"], {"qq": 1, "wechat": 1})
        self.assertEqual([item["source"] for item in data["sources"]], ["qq", "wechat"])
        self.assertTrue(all(item["enabled"] for item in data["sources"]))
        self.assertIn("只读", data["note"])

    def test_status_reports_source_state(self) -> None:
        store = self.writable_store()
        store.record_source("qq", "ok", "新增 2 条")
        store.close()
        data = self.call("infohub_status")
        qq = data["sources"][0]
        self.assertEqual(qq["status"], "ok")
        self.assertIn("新增 2 条", qq["detail"])
        self.assertTrue(qq["lastRunAt"])  # 有本地时间格式，不是空
        self.assertEqual(data["sources"][1]["status"], "idle")

    def test_status_marks_disabled_source(self) -> None:
        fake = SimpleNamespace(
            archive_db=str(self.db_path),
            data_dir=str(self.home / "data"),
            qq={"enabled": True},
            wechat={"enabled": False},
        )
        with mock.patch.object(mcp_server, "_config", lambda: fake):
            data = self.call("infohub_status")
        self.assertTrue(data["sources"][0]["enabled"])
        self.assertFalse(data["sources"][1]["enabled"])

    def test_missing_archive_is_friendly_error(self) -> None:
        # 归档还没建（全新用户先点了「采集桥」）：给一句能照做的话，且不顺手建库。
        missing = self.home / "data" / "nope.db"
        fake = SimpleNamespace(
            archive_db=str(missing),
            data_dir=str(self.home / "data"),
            qq={"enabled": True},
            wechat={"enabled": True},
        )
        with mock.patch.object(mcp_server, "_config", lambda: fake):
            result = self.rpc_result("infohub_status", {})
        self.assertTrue(result["isError"])
        self.assertIn("归档还不存在", result["content"][0]["text"])
        self.assertFalse(missing.exists())


class SearchReadTest(_ArchiveCase):
    def test_search_and_read(self) -> None:
        found = self.call("infohub_archive_search", {"query": "免检单", "limit": 5})
        self.assertEqual(found["count"], 2)
        self.assertEqual({hit["conversation"] for hit in found["hits"]}, {"学院事务群", "叶老师"})
        qq_hit = [hit for hit in found["hits"] if hit["conversationId"] == self.qq_conv][0]
        self.assertEqual(qq_hit["source"], "qq")
        self.assertEqual(qq_hit["from"], "叶老师")
        self.assertIn("免检单", qq_hit["excerpt"])
        self.assertTrue(qq_hit["at"])
        self.assertIn("本机归档", found["note"])

        read = self.call("infohub_archive_read", {"conversationId": self.qq_conv, "limit": 10})
        self.assertEqual(read["conversation"], "学院事务群")
        self.assertEqual(read["source"], "qq")
        # 时间正序
        self.assertEqual(
            [message["text"] for message in read["messages"]],
            ["明天下午3点前提交免检单", "收到，已经在整理了"],
        )

    def test_search_requires_query(self) -> None:
        for arguments in ({}, {"query": ""}, {"query": "   "}):
            result = self.rpc_result("infohub_archive_search", arguments)
            self.assertTrue(result["isError"], arguments)
            self.assertIn("query", result["content"][0]["text"])

    def test_search_limit_bounds(self) -> None:
        self.assertEqual(self.call("infohub_archive_search", {"query": "免检单", "limit": 1})["count"], 1)
        for limit in (0, 51, -1):
            result = self.rpc_result("infohub_archive_search", {"query": "免检单", "limit": limit})
            self.assertTrue(result["isError"], limit)
            self.assertIn("1–50", result["content"][0]["text"])

    def test_search_limit_must_be_integer(self) -> None:
        result = self.rpc_result("infohub_archive_search", {"query": "免检单", "limit": "abc"})
        self.assertTrue(result["isError"])
        self.assertIn("整数", result["content"][0]["text"])

    def test_read_unknown_conversation(self) -> None:
        result = self.rpc_result("infohub_archive_read", {"conversationId": 999})
        self.assertTrue(result["isError"])
        self.assertIn("会话", result["content"][0]["text"])

    def test_read_requires_conversation_id(self) -> None:
        for arguments in ({}, {"conversationId": 0}, {"conversationId": "x"}):
            result = self.rpc_result("infohub_archive_read", arguments)
            self.assertTrue(result["isError"], arguments)

    def test_read_limit_bounds(self) -> None:
        for limit in (0, 101):
            result = self.rpc_result(
                "infohub_archive_read", {"conversationId": self.qq_conv, "limit": limit}
            )
            self.assertTrue(result["isError"], limit)
            self.assertIn("1–100", result["content"][0]["text"])


class ConversationsTest(_ArchiveCase):
    def test_lists_conversations_with_fields(self) -> None:
        data = self.call("infohub_conversations")
        self.assertEqual(data["count"], 2)
        # 按最近消息时间倒序：微信那条更新
        self.assertEqual(
            [item["name"] for item in data["conversations"]], ["叶老师", "学院事务群"]
        )
        first = data["conversations"][0]
        self.assertEqual(
            set(first), {"conversationId", "name", "source", "lastAt", "messages"}
        )
        self.assertEqual(first["source"], "wechat")
        self.assertEqual(first["messages"], 1)
        self.assertEqual(data["conversations"][1]["messages"], 2)
        self.assertTrue(first["lastAt"])

    def test_filters_by_source_keyword_and_limit(self) -> None:
        qq_only = self.call("infohub_conversations", {"source": "qq"})
        self.assertEqual(qq_only["count"], 1)
        self.assertEqual(qq_only["conversations"][0]["conversationId"], self.qq_conv)

        by_keyword = self.call("infohub_conversations", {"keyword": "事务"})
        self.assertEqual(by_keyword["count"], 1)
        self.assertEqual(by_keyword["conversations"][0]["name"], "学院事务群")

        limited = self.call("infohub_conversations", {"limit": 1})
        self.assertEqual(limited["count"], 1)
        self.assertEqual(limited.get("truncated"), 1)

    def test_rejects_unknown_source(self) -> None:
        result = self.rpc_result("infohub_conversations", {"source": "telegram"})
        self.assertTrue(result["isError"])
        self.assertIn("未知来源", result["content"][0]["text"])

    def test_limit_bounds(self) -> None:
        self.assertEqual(self.call("infohub_conversations", {"limit": 200})["count"], 2)
        for limit in (0, 201):
            result = self.rpc_result("infohub_conversations", {"limit": limit})
            self.assertTrue(result["isError"], limit)
            self.assertIn("1–200", result["content"][0]["text"])


class AgendaTest(_ArchiveCase):
    def _insert_event(self, due_ts: int) -> None:
        store = self.writable_store()
        store.insert_events(
            [
                (
                    self.qq_msg_id,
                    self.qq_conv,
                    "交免检单",
                    "明天下午3点前提交免检单",
                    due_ts,
                    "明天",
                    0,
                    "task",
                )
            ]
        )
        store.close()

    def test_agenda_returns_counts_and_events(self) -> None:
        self._insert_event(self.now + 3600)
        data = self.call("infohub_archive_agenda", {"days": 7, "overdue": 7})
        self.assertEqual(data["window"], {"days": 7, "overdueDays": 7})
        self.assertEqual(set(data["counts"]), {"overdue", "today", "thisWeek"})
        self.assertEqual(sum(data["counts"].values()), 1)
        self.assertEqual(len(data["events"]), 1)
        event = data["events"][0]
        self.assertEqual(event["title"], "交免检单")
        self.assertEqual(event["conversation"], "学院事务群")
        self.assertEqual(event["source"], "qq")
        self.assertTrue(event["dueAt"])

    def test_agenda_bounds(self) -> None:
        for arguments, hint in (
            ({"days": 0}, "1–60"),
            ({"days": 61}, "1–60"),
            ({"overdue": 0}, "1–365"),
            ({"overdue": 366}, "1–365"),
        ):
            result = self.rpc_result("infohub_archive_agenda", arguments)
            self.assertTrue(result["isError"], arguments)
            self.assertIn(hint, result["content"][0]["text"])

    def test_agenda_rebuild_writes_events(self) -> None:
        # 采集之后必须能显式补日程：写工具真的落到 events 表。
        data = self.call("infohub_agenda_rebuild", {"days": 14})
        self.assertEqual(data["window"]["days"], 14)
        self.assertTrue(data["window"]["since"])
        self.assertGreaterEqual(data["scanned"], 3)
        self.assertGreaterEqual(data["matched"], 1)
        self.assertGreaterEqual(data["inserted"], 1)
        self.assertIn("写操作", data["note"])

        store = self.writable_store()
        try:
            self.assertGreaterEqual(store.event_count(), 1)
            rows = store.agenda(self.now - 86400, self.now + 14 * 86400)
        finally:
            store.close()
        self.assertGreaterEqual(len(rows), 1)
        self.assertIn("免检单", rows[0]["title"])

    def test_agenda_rebuild_days_default_and_bounds(self) -> None:
        for days in (0, 91):
            result = self.rpc_result("infohub_agenda_rebuild", {"days": days})
            self.assertTrue(result["isError"], days)
            self.assertIn("1–90", result["content"][0]["text"])


class StoreModeTest(_ArchiveCase):
    """只读 / 可写 Store 的分界：读工具绝不建表、写工具用可写库。"""

    def _recording_store(self, seen: list[bool]):
        real_store = Store

        def factory(path, readonly: bool = False) -> Store:
            seen.append(readonly)
            return real_store(path, readonly=readonly)

        return factory

    def test_read_only_tools_open_store_readonly(self) -> None:
        seen: list[bool] = []
        with mock.patch("infohub.store.Store", side_effect=self._recording_store(seen)):
            self.call("infohub_status")
            self.call("infohub_archive_search", {"query": "免检单"})
            self.call("infohub_archive_read", {"conversationId": self.qq_conv})
            self.call("infohub_archive_agenda")
            self.call("infohub_conversations")
        self.assertEqual(seen, [True, True, True, True, True])

    def test_agenda_rebuild_opens_writable_store(self) -> None:
        seen: list[bool] = []
        with mock.patch("infohub.store.Store", side_effect=self._recording_store(seen)):
            self.call("infohub_agenda_rebuild", {"days": 7})
        self.assertEqual(seen, [False])

    def test_readonly_store_does_not_create_schema(self) -> None:
        # 只读打开一个还没建表（0 字节）的库：不跑建表 DDL，也不写文件。
        empty = self.home / "data" / "empty.db"
        empty.parent.mkdir(parents=True, exist_ok=True)
        empty.write_bytes(b"")
        store = Store(empty, readonly=True)
        try:
            tables = store.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        finally:
            store.close()
        self.assertEqual(tables, [])
        self.assertEqual(empty.read_bytes(), b"")


class SyncTest(_ArchiveCase):
    def _report(self) -> SimpleNamespace:
        return SimpleNamespace(
            source="qq",
            conversations=1,
            added=2,
            updated=0,
            scanned_files=3,
            skipped=1,
            errors=[],
            elapsed=0.5,
        )

    def test_sync_only_calls_sync_all_with_defaults(self) -> None:
        fake_store = SimpleNamespace(close=mock.Mock())
        with mock.patch("infohub.sync.open_store", return_value=fake_store) as open_store, mock.patch(
            "infohub.sync.sync_all", return_value=[self._report()]
        ) as sync_all:
            result = mcp_server.call_tool("infohub_sync", {})
        self.assertFalse(result["isError"], result["content"][0]["text"])
        data = json.loads(result["content"][0]["text"])
        self.assertEqual(data["requestedSources"], ["qq", "wechat"])
        self.assertFalse(data["full"])
        self.assertEqual(data["reports"][0]["added"], 2)
        self.assertIn("未重扫日程", data["note"])
        # 只调采集：sources/full 传对，store 是同一个，且关了一次。
        self.assertEqual(sync_all.call_args.kwargs["sources"], ("qq", "wechat"))
        self.assertFalse(sync_all.call_args.kwargs["full"])
        self.assertIs(sync_all.call_args.kwargs["store"], fake_store)
        open_store.assert_called_once()
        fake_store.close.assert_called_once()

    def test_sync_passes_explicit_sources_and_full(self) -> None:
        fake_store = SimpleNamespace(close=mock.Mock())
        report = self._report()
        report.source = "wechat"
        with mock.patch("infohub.sync.open_store", return_value=fake_store), mock.patch(
            "infohub.sync.sync_all", return_value=[report]
        ) as sync_all:
            result = mcp_server.call_tool(
                "infohub_sync", {"sources": ["wechat"], "full": True}
            )
        data = json.loads(result["content"][0]["text"])
        self.assertEqual(data["requestedSources"], ["wechat"])
        self.assertTrue(data["full"])
        self.assertEqual(sync_all.call_args.kwargs["sources"], ("wechat",))
        self.assertTrue(sync_all.call_args.kwargs["full"])

    def test_sync_rejects_unknown_source(self) -> None:
        result = self.rpc_result("infohub_sync", {"sources": ["telegram"]})
        self.assertTrue(result["isError"])
        self.assertIn("未知来源", result["content"][0]["text"])

    def test_sync_rejects_empty_or_bad_sources(self) -> None:
        for arguments in ({"sources": []}, {"sources": "qq"}, {"sources": [1]}):
            result = self.rpc_result("infohub_sync", arguments)
            self.assertTrue(result["isError"], arguments)
            self.assertIn("sources", result["content"][0]["text"])

    def test_sync_rejects_non_boolean_full(self) -> None:
        result = self.rpc_result("infohub_sync", {"full": "yes"})
        self.assertTrue(result["isError"])
        self.assertIn("布尔", result["content"][0]["text"])


# ---------------------------------------------------------------- 契约 / CLI


class ToolSchemaTest(unittest.TestCase):
    def test_schema_limits_are_pinned(self) -> None:
        by_name = {tool["name"]: tool for tool in mcp_server.TOOLS}
        self.assertEqual(len(mcp_server.TOOLS), 7)
        self.assertEqual(mcp_server.TOOL_NAMES, set(EXPECTED_TOOL_ORDER))

        search = by_name["infohub_archive_search"]["inputSchema"]
        self.assertEqual(search["required"], ["query"])
        self.assertEqual(search["properties"]["limit"]["maximum"], 50)

        read = by_name["infohub_archive_read"]["inputSchema"]
        self.assertEqual(read["required"], ["conversationId"])
        self.assertEqual(read["properties"]["limit"]["maximum"], 100)

        agenda = by_name["infohub_archive_agenda"]["inputSchema"]["properties"]
        self.assertEqual((agenda["days"]["maximum"], agenda["overdue"]["maximum"]), (60, 365))

        conversations = by_name["infohub_conversations"]["inputSchema"]["properties"]
        self.assertEqual(conversations["limit"]["maximum"], 200)
        self.assertEqual(conversations["source"]["enum"], ["qq", "wechat"])

        rebuild = by_name["infohub_agenda_rebuild"]["inputSchema"]["properties"]
        self.assertEqual(rebuild["days"]["maximum"], 90)

        self.assertFalse(by_name["infohub_status"]["inputSchema"]["additionalProperties"])

    def test_call_tool_rejects_unknown_name(self) -> None:
        with self.assertRaises(mcp_server.McpError):
            mcp_server.call_tool("infohub_nope", {})


class BoundaryTest(unittest.TestCase):
    """边界契约：Host 白名单、协议层只依赖标准库（缺采集依赖也要起得来）。"""

    def test_host_header_whitelist(self) -> None:
        for host in ("127.0.0.1", "127.0.0.1:8776", "localhost", "[::1]:1"):
            self.assertTrue(mcp_server._is_loopback_host(host), host)
        for host in ("", "evil.example.com", "192.168.1.5:8776", "[::2]:1", "127.0.0.1.evil.com"):
            self.assertFalse(mcp_server._is_loopback_host(host), host)

    def test_module_level_imports_are_stdlib_only(self) -> None:
        """协议层顶层只 import 标准库；业务模块必须在函数内懒加载。

        缺 cryptography / zstandard 的环境里，采集桥仍要能起、能握手、能列工具。
        """
        source = Path(mcp_server.__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)
        roots: set[str] = set()
        for node in tree.body:
            if isinstance(node, ast.Import):
                roots.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                self.assertEqual(node.level, 0, "顶层不能出现相对导入（store/config/sync/agenda 必须懒加载）")
                if node.module:
                    roots.add(node.module.split(".")[0])
        allowed = set(sys.stdlib_module_names) | {"__future__"}
        self.assertTrue(roots, "没找到任何顶层 import，检查一下测试本身")
        self.assertEqual(sorted(roots - allowed), [], f"协议层出现了非标准库顶层依赖：{roots}")


class CliTest(unittest.TestCase):
    def test_mcp_subcommand_passes_loopback_defaults(self) -> None:
        with mock.patch("infohub.mcp_server.run") as run:
            code = cli.main(["mcp"])
        self.assertEqual(code, 0)
        run.assert_called_once_with(host="127.0.0.1", port=8776)

    def test_mcp_subcommand_accepts_port(self) -> None:
        with mock.patch("infohub.mcp_server.run") as run:
            code = cli.main(["mcp", "--port", "9000"])
        self.assertEqual(code, 0)
        run.assert_called_once_with(host="127.0.0.1", port=9000)

    def test_mcp_subcommand_rejects_non_loopback_host(self) -> None:
        stderr = io.StringIO()
        with mock.patch("infohub.mcp_server.run") as run, contextlib.redirect_stderr(stderr):
            code = cli.main(["mcp", "--host", "0.0.0.0"])
        self.assertEqual(code, 2)
        run.assert_not_called()
        self.assertIn("回环", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
