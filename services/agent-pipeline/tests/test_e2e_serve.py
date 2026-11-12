"""端到端部署冒烟：真的用 uvicorn 起服务，真的用 HTTP 跑完一个 run。

本机没有 docker，镜像构建这一步只能用「uv build 出 wheel + 这个子进程冒烟」来替代：
`python -m agent_pipeline.runner serve` 起进程（和 Dockerfile 的 CMD 同一条路），
上游模型换成本地桩 HTTP 服务，再从外部打 /health、POST /v1/runs、轮询结果、看 /metrics。
只要这条链路通，就说明容器里的入口、配置读取、并发闸、日志落盘都是活的。
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _stub_reply(system_prompt: str) -> dict:
    """按节点提示词回一份合法 JSON（与 scripts/soak.py 的 CycleLLM 同一口径）。"""
    if "规划者" in system_prompt or "规划" in system_prompt:
        payload = {
            "steps": [
                {"id": "s1", "goal": "写一句结论", "done_when": "回答里有一句话"},
            ]
        }
    elif "评审" in system_prompt or "critic" in system_prompt.lower():
        payload = {"score": 0.9, "blocking_issues": [], "suggestions": []}
    elif "反思" in system_prompt or "reflect" in system_prompt.lower():
        payload = {"verdict": "done", "reasons": ["已经够用了"], "next_step": "", "lessons": []}
    elif "总结" in system_prompt or "summar" in system_prompt.lower():
        payload = {"answer": "端到端冒烟：结论只有一句。", "citations": []}
    else:
        payload = {"answer": "端到端冒烟：结论只有一句。"}
    return {
        "id": "chatcmpl-e2e",
        "object": "chat.completion",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": json.dumps(payload, ensure_ascii=False)},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 7, "completion_tokens": 5, "total_tokens": 12},
    }


class _StubHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:  # noqa: N802 - http.server 的命名
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        body = json.loads(raw or b"{}")
        system_prompt = "\n".join(
            str(message.get("content") or "")
            for message in body.get("messages", [])
            if message.get("role") == "system"
        )
        data = json.dumps(_stub_reply(system_prompt), ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args) -> None:  # 安静：不要把桩服务的访问日志刷到测试输出里
        return


@pytest.fixture()
def stub_llm():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _StubHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/v1"
    finally:
        server.shutdown()
        server.server_close()


def _http(method: str, url: str, payload: dict | None = None) -> tuple[int, dict]:
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw) if raw.strip().startswith("{") else {"raw": raw}
    except urllib.error.HTTPError as exc:  # 4xx/5xx 也要能断言
        raw = exc.read().decode("utf-8")
        return exc.code, json.loads(raw) if raw.strip().startswith("{") else {"raw": raw}


def _wait_health(base: str, timeout_s: float = 40.0) -> dict:
    deadline = time.time() + timeout_s
    last: Exception | None = None
    while time.time() < deadline:
        try:
            status, payload = _http("GET", f"{base}/health")
            if status == 200:
                return payload
        except Exception as exc:  # 进程还没起监听
            last = exc
        time.sleep(0.1)
    raise AssertionError(f"服务没在 {timeout_s}s 内起来：{last}")


def test_service_runs_end_to_end_in_subprocess(tmp_path, stub_llm) -> None:
    port = _free_port()
    base = f"http://127.0.0.1:{port}"
    env = dict(os.environ)
    env.update(
        {
            "PYTHONPATH": str(ROOT / "src") + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else ""),
            "AGENT_PIPELINE_BASE_URL": stub_llm,
            "AGENT_PIPELINE_API_KEY": "e2e-key",
            "AGENT_PIPELINE_MODEL": "e2e-stub",
            "AGENT_LOG_PATH": str(tmp_path / "runs.jsonl"),
            "AGENT_PIPELINE_DB": str(tmp_path / "e2e.db"),
            "AGENT_MAX_CONCURRENCY": "2",
        }
    )
    proc = subprocess.Popen(
        [sys.executable, "-m", "agent_pipeline.runner", "serve", "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        health = _wait_health(base)
        assert health["ok"] is True
        assert health["runs_retained"] >= 0

        status, created = _http("POST", f"{base}/v1/runs", {"goal": "端到端冒烟：验证服务能起来并跑完", "mode": "react"})
        assert status == 202, created
        run_id = created["run_id"]

        deadline = time.time() + 40
        final: dict = {}
        while time.time() < deadline:
            status, payload = _http("GET", f"{base}/v1/runs/{run_id}")
            if status == 200 and payload.get("status") in {"ok", "error", "aborted"}:
                final = payload
                break
            time.sleep(0.1)
        assert final, "run 没在 40s 内结束"
        assert final["status"] == "ok", final
        assert final["result"]["answer"]

        with urllib.request.urlopen(f"{base}/metrics", timeout=10) as response:
            metrics = response.read().decode("utf-8")
        assert 'pipeline_runs_total{status="ok"}' in metrics
        assert "pipeline_llm_tokens_total" in metrics

        # 日志真的落在 AGENT_LOG_PATH 指定的地方（这条就是 fcaf81b9 修的那个 bug）
        log_lines = (tmp_path / "runs.jsonl").read_text(encoding="utf-8").strip().splitlines()
        assert len(log_lines) == 1
        row = json.loads(log_lines[0])
        assert row["status"] == "ok" and row["run_id"] == run_id
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:  # pragma: no cover - 收不掉就强杀，别拖住测试
            proc.kill()
            proc.wait(timeout=10)
        output = proc.stdout.read() if proc.stdout else ""
        if proc.returncode not in (0, -15, 1) and "KeyboardInterrupt" not in output:
            print(output)