"""OpenAI 兼容客户端：真的走 HTTP（本地桩服务），覆盖重试/解析/错误口径。"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from agent_pipeline.llm import FakeLLM, LLMError, LLMResponse, OpenAICompatClient, _parse_args


class _Stub:
    """按脚本依次回 (status, body)，并把收到的请求体记下来。"""

    def __init__(self, script: list[tuple[int, Any]]) -> None:
        self.script = list(script)
        self.requests: list[dict[str, Any]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - http.server 约定
                length = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                outer.requests.append(
                    {"path": self.path, "auth": self.headers.get("authorization"), "body": body}
                )
                status, payload = outer.script.pop(0) if outer.script else (200, {"choices": []})
                data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args: Any) -> None:  # 静音
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> "_Stub":
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.server.shutdown()
        self.server.server_close()

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}/v1"


def _ok(content: str = "好的", tool_calls: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls is not None:
        message["tool_calls"] = tool_calls
    return {
        "model": "stub-model",
        "choices": [{"index": 0, "message": message, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 11, "completion_tokens": 7},
    }


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("agent_pipeline.llm.time.sleep", lambda _s: None)


def test_chat_parses_text_tools_and_usage() -> None:
    calls = [
        {"id": "call_1", "type": "function", "function": {"name": "knowledge_search", "arguments": '{"query":"外壳"}'}},
        {"type": "function", "function": {"name": "http_get", "arguments": {"url": "http://x"}}},
    ]
    with _Stub([(200, _ok("先查一下", calls))]) as stub:
        client = OpenAICompatClient(base_url=stub.base_url, api_key="k", model="stub-model")
        tools = [{"type": "function", "function": {"name": "knowledge_search", "parameters": {}}}]
        response = client.chat([{"role": "user", "content": "hi"}], tools=tools)

        assert isinstance(response, LLMResponse)
        assert response.text == "先查一下"
        assert response.tool_calls[0] == {"id": "call_1", "name": "knowledge_search", "arguments": {"query": "外壳"}}
        assert response.tool_calls[1]["id"] == "call_1" or response.tool_calls[1]["id"].startswith("call_")
        assert response.prompt_tokens == 11 and response.completion_tokens == 7
        assert response.total_tokens == 18

        sent = stub.requests[0]
        assert sent["path"].endswith("/chat/completions")
        assert sent["auth"] == "Bearer k"
        assert sent["body"]["model"] == "stub-model"
        assert sent["body"]["tools"] == tools
        assert sent["body"]["tool_choice"] == "auto"


def test_retries_on_5xx_then_succeeds() -> None:
    with _Stub([(500, {"error": "boom"}), (429, {"error": "slow down"}), (200, _ok("重试成功"))]) as stub:
        client = OpenAICompatClient(base_url=stub.base_url, api_key="k", max_retries=2)
        assert client.chat([{"role": "user", "content": "hi"}]).text == "重试成功"
        assert len(stub.requests) == 3


def test_gives_up_after_retries() -> None:
    with _Stub([(503, {"error": "down"}), (503, {"error": "down"}), (503, {"error": "down"})]) as stub:
        client = OpenAICompatClient(base_url=stub.base_url, api_key="k", max_retries=2)
        with pytest.raises(LLMError) as info:
            client.chat([{"role": "user", "content": "hi"}])
        assert "模型调用失败" in str(info.value)
        assert len(stub.requests) == 3


def test_400_is_not_retried() -> None:
    with _Stub([(400, {"error": "bad request"})]) as stub:
        client = OpenAICompatClient(base_url=stub.base_url, api_key="k", max_retries=3)
        with pytest.raises(LLMError) as info:
            client.chat([{"role": "user", "content": "hi"}])
        assert "HTTP 400" in str(info.value)
        assert len(stub.requests) == 1, "4xx 是请求本身有问题，重试没有意义"


def test_missing_api_key_fails_loudly(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AGENT_PIPELINE_API_KEY", raising=False)
    client = OpenAICompatClient(base_url="http://127.0.0.1:9/v1")
    with pytest.raises(LLMError) as info:
        client.chat([{"role": "user", "content": "hi"}])
    assert "API Key" in str(info.value)


def test_connection_error_is_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    client = OpenAICompatClient(base_url="http://127.0.0.1:9/v1", api_key="k", max_retries=1)
    with pytest.raises(LLMError) as info:
        client.chat([{"role": "user", "content": "hi"}])
    assert "模型调用失败" in str(info.value)


def test_bad_tool_arguments_reported() -> None:
    calls = [{"id": "c1", "function": {"name": "x", "arguments": "not-json"}}]
    with _Stub([(200, _ok("", calls))]) as stub:
        client = OpenAICompatClient(base_url=stub.base_url, api_key="k")
        with pytest.raises(LLMError) as info:
            client.chat([{"role": "user", "content": "hi"}])
        assert "不是合法 JSON" in str(info.value)
    with pytest.raises(LLMError):
        _parse_args("[1,2]")


def test_fake_llm_script_and_exhaustion() -> None:
    fake = FakeLLM([{"text": "一"}, "二", lambda _messages, _tools: "三"])
    assert fake.chat([]).text == "一"
    assert fake.chat([]).text == "二"
    assert fake.chat([]).text == "三"
    assert len(fake.calls) == 3
    with pytest.raises(LLMError):
        fake.chat([])
