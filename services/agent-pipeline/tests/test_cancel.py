"""取消 run：节点边界收口为 aborted，而不是硬杀线程/干等超时。"""

from __future__ import annotations

import json
import threading
import time

from fastapi.testclient import TestClient

from agent_pipeline.config import Settings
from agent_pipeline.llm import LLMResponse
from agent_pipeline.runtime import build_runtime
from agent_pipeline.service import create_app


def _json(payload: dict) -> LLMResponse:
    return LLMResponse(text=json.dumps(payload, ensure_ascii=False))


class SlowLLM:
    """每个节点都慢一点，好让客户端在「正在跑」的时候发取消。"""

    def __init__(self, delay: float = 0.15) -> None:
        self.delay = delay
        self.calls = 0

    def chat(self, messages, *, tools=None, temperature=0.2, max_tokens=2000):
        self.calls += 1
        time.sleep(self.delay)
        system = messages[0]["content"]
        if "规划者" in system:
            return _json({"steps": [{"goal": "做事", "done_when": "有结果"}]})
        if "评审者" in system:
            return _json({"score": 0.9, "blocking_issues": []})
        if "汇总" in system:
            return _json({"answer": "做完了", "citations": []})
        return LLMResponse(text="继续")


def _wait(client: TestClient, run_id: str, timeout: float = 10.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get(f"/v1/runs/{run_id}").json()
        if body.get("status") not in ("running", "cancelling"):
            return body
        time.sleep(0.02)
    raise AssertionError(f"run {run_id} 没有在 {timeout}s 内结束：{body}")


def test_cancel_running_run_ends_aborted(runtime_factory) -> None:
    llm = SlowLLM()
    settings = Settings(log_path=":memory:", db_path=":memory:")
    runtime = build_runtime(settings, llm=llm)
    client = TestClient(create_app(settings=settings, runtime=runtime))

    created = client.post("/v1/runs", json={"goal": "慢慢做", "mode": "react", "run_id": "r-cancel"})
    assert created.status_code == 202

    # 等它真的开始跑（第一个节点已进来），再取消。
    for _ in range(200):
        if llm.calls > 0:
            break
        time.sleep(0.01)

    accepted = client.post("/v1/runs/r-cancel/cancel")
    assert accepted.status_code == 202
    assert accepted.json()["status"] == "cancelling"

    body = _wait(client, "r-cancel")
    assert body["status"] == "aborted"
    assert body["result"]["status"] == "aborted"
    assert body["log"]["stop_reason"] == "cancelled"
    assert "取消" in body["result"]["answer"]
    # 取消后不该继续烧模型调用：承认停下来了，而不是把剩下节点跑完。
    assert llm.calls < 5


def test_cancel_unknown_run_is_404(runtime_factory) -> None:
    settings = Settings(log_path=":memory:", db_path=":memory:")
    runtime = build_runtime(settings, llm=SlowLLM(0.01))
    client = TestClient(create_app(settings=settings, runtime=runtime))
    assert client.post("/v1/runs/nope/cancel").status_code == 404


def test_cancel_finished_run_is_409(runtime_factory) -> None:
    settings = Settings(log_path=":memory:", db_path=":memory:")
    runtime = build_runtime(settings, llm=SlowLLM(0.0))
    client = TestClient(create_app(settings=settings, runtime=runtime))
    client.post("/v1/runs", json={"goal": "快跑完", "mode": "react", "run_id": "r-done"})
    _wait(client, "r-done")
    assert client.post("/v1/runs/r-done/cancel").status_code == 409


def test_cancel_is_idempotent_while_running(runtime_factory) -> None:
    settings = Settings(log_path=":memory:", db_path=":memory:")
    runtime = build_runtime(settings, llm=SlowLLM(0.2))
    client = TestClient(create_app(settings=settings, runtime=runtime))
    client.post("/v1/runs", json={"goal": "慢慢做", "mode": "react", "run_id": "r-twice"})
    for _ in range(200):
        if runtime.llm.calls > 0:
            break
        time.sleep(0.01)
    assert client.post("/v1/runs/r-twice/cancel").status_code == 202
    # 第二次取消：已经标成 cancelling，仍按「正在结束」处理，不报错。
    assert client.post("/v1/runs/r-twice/cancel").status_code in (202, 409)
    _wait(client, "r-twice")
