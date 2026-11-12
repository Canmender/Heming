"""Function Calling 调外部 API 的真路径：http_get 打真实 HTTP 服务。

这条链路以前只有「注册表里有这个工具」的断言，没有真发过请求。这里用一个本地
ThreadingHTTPServer 当外部 API，把成功、正文截断、非 http 协议、连不上、schema
不合五种情况都走一遍——它们分别对应模型最容易踩的五种调用方式。
"""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from agent_pipeline.protocol import ToolRequest
from agent_pipeline.tools import ToolRuntime, build_default_registry


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler 的命名
        if self.path.startswith("/big"):
            body = ("x" * 12_000).encode()
        elif self.path.startswith("/json"):
            body = json.dumps({"ok": True, "value": 42}).encode()
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"not found")
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args) -> None:  # 测试里不需要访问日志
        return


@pytest.fixture(scope="module")
def api() -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture()
def runtime() -> Iterator[ToolRuntime]:
    instance = ToolRuntime(build_default_registry())
    try:
        yield instance
    finally:
        instance.close()


def _call(runtime: ToolRuntime, url: str, **extra) -> object:
    arguments = {"url": url, **extra}
    return runtime.execute(ToolRequest(call_id="c1", name="http_get", arguments=arguments, risk="net"))


def test_http_get_reads_json_from_real_server(runtime: ToolRuntime, api: str) -> None:
    observation = _call(runtime, f"{api}/json")
    assert observation.ok is True
    assert observation.result["status"] == 200
    assert json.loads(observation.result["body"]) == {"ok": True, "value": 42}
    assert observation.citations == []


def test_http_get_truncates_long_body(runtime: ToolRuntime, api: str) -> None:
    """正文截断到 8000 字符：模型上下文会被整页 HTML 撑爆，截断是刻意的。"""
    observation = _call(runtime, f"{api}/big")
    assert observation.ok is True
    assert len(observation.result["body"]) == 8_000


def test_http_get_keeps_error_status_as_data(runtime: ToolRuntime, api: str) -> None:
    """4xx 不抛异常：状态码本身是模型要判断的信息（比如「这个接口要鉴权」）。"""
    observation = _call(runtime, f"{api}/missing")
    assert observation.ok is True
    assert observation.result["status"] == 404
    assert "not found" in observation.result["body"]


def test_http_get_rejects_non_http_scheme(runtime: ToolRuntime) -> None:
    observation = _call(runtime, "file:///etc/passwd")
    assert observation.ok is False
    assert "只支持 http/https" in observation.error


def test_http_get_connection_failure_becomes_observation(runtime: ToolRuntime) -> None:
    """连不上不能把 run 弄崩：必须变成 ok=False 的观测，让模型自己换个思路。"""
    observation = _call(runtime, "http://127.0.0.1:9/nope", timeout_s=1.5)
    assert observation.ok is False
    assert observation.error


def test_http_get_schema_is_enforced(runtime: ToolRuntime) -> None:
    observation = runtime.execute(
        ToolRequest(call_id="c2", name="http_get", arguments={"url": 123}, risk="net")
    )
    assert observation.ok is False
    assert "参数" in observation.error or "schema" in observation.error.lower()


def test_http_get_declares_net_risk() -> None:
    registry = build_default_registry()
    spec = registry.get("http_get")
    assert spec is not None
    assert spec.risk == "net", "net 风险要能进 HITL/审计口径，不能当成只读"
    schema = spec.openai_schema()
    assert schema["function"]["name"] == "http_get"
    assert schema["function"]["parameters"]["required"] == ["url"]