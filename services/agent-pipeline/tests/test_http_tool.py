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
    # 测试桩跑在 127.0.0.1 上，所以要显式放开内网访问（生产默认是拒的）。
    instance = ToolRuntime(build_default_registry(allow_private_hosts=True))
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


def test_http_get_blocks_private_addresses_by_default(api: str) -> None:
    """SSRF 防护：模型给的 URL 来自不可信内容，默认不许打本机/内网。

    云元数据（169.254.169.254）与内网管理接口都在这一类：一条提示注入就能让
    模型把内部数据读进对话里。
    """
    instance = ToolRuntime(build_default_registry())
    try:
        for url in (
            api,  # 127.0.0.1
            "http://localhost:8000/health",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]:8000/",
            "http://10.0.0.1/",
        ):
            observation = _call(instance, url)
            assert observation.ok is False, url
            assert "内网" in observation.error, observation.error
    finally:
        instance.close()


def test_http_get_allows_private_when_explicitly_enabled(api: str) -> None:
    """确实需要访问内网时由服务端显式打开（AGENT_ALLOW_PRIVATE_HOSTS=1）。"""
    instance = ToolRuntime(build_default_registry(allow_private_hosts=True))
    try:
        observation = _call(instance, f"{api}/json")
        assert observation.ok is True
        assert observation.result["status"] == 200
    finally:
        instance.close()


def test_http_get_declares_net_risk() -> None:
    registry = build_default_registry()
    spec = registry.get("http_get")
    assert spec is not None
    assert spec.risk == "net", "net 风险要能进 HITL/审计口径，不能当成只读"
    schema = spec.openai_schema()
    assert schema["function"]["name"] == "http_get"
    assert schema["function"]["parameters"]["required"] == ["url"]

def test_http_get_rechecks_every_redirect_hop(monkeypatch) -> None:
    """重定向要逐跳过内网检查：只查首个 URL 会被一条 302 绕过。

    requests 默认自动跟随重定向；如果只对入口 URL 调一次 _host_is_private，
    一个公开地址 302 到 169.254.169.254 就能把云元数据读回来。
    """
    import requests

    seen: list[str] = []

    class _Redirect:
        status_code = 302
        text = ""
        headers = {"Location": "http://169.254.169.254/latest/meta-data/"}

    def fake_get(url, **_kwargs):
        seen.append(str(url))
        return _Redirect()

    monkeypatch.setattr(requests, "get", fake_get)
    instance = ToolRuntime(build_default_registry())
    try:
        observation = _call(instance, "http://example.com/redirect")
        assert observation.ok is False
        assert "内网" in observation.error
        assert seen == ["http://example.com/redirect"]  # 第二跳在发请求之前就被拦下
    finally:
        instance.close()


def test_http_get_follows_redirects_and_caps_them(monkeypatch) -> None:
    import requests

    from agent_pipeline.tools import MAX_REDIRECTS

    calls: list[str] = []

    class _Hop:
        status_code = 302
        text = ""
        headers = {"Location": "/step"}

    class _Final:
        status_code = 200
        text = "到达"
        headers: dict[str, str] = {}

    def fake_get(url, **_kwargs):
        calls.append(str(url))
        return _Final() if len(calls) > 1 else _Hop()

    monkeypatch.setattr(requests, "get", fake_get)
    instance = ToolRuntime(build_default_registry(allow_private_hosts=True))
    try:
        observation = _call(instance, "http://example.com/start")
        assert observation.ok is True
        assert observation.result["status"] == 200
        assert observation.result["body"] == "到达"
        assert calls[1] == "http://example.com/step"  # 相对 Location 按当前 URL 补全
    finally:
        instance.close()

    # 一直 302：不能无限跟，报「重定向次数过多」。
    class _Forever:
        status_code = 307
        text = ""
        headers = {"Location": "http://example.com/loop"}

    monkeypatch.setattr(requests, "get", lambda url, **_kwargs: _Forever())
    instance = ToolRuntime(build_default_registry(allow_private_hosts=True))
    try:
        observation = _call(instance, "http://example.com/loop")
        assert observation.ok is False
        assert f"超过 {MAX_REDIRECTS} 次" in observation.error
    finally:
        instance.close()
