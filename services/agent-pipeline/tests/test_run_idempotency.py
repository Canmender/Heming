"""run_id 幂等的边界：同请求重提返回同一份状态，换了内容必须 409。

以前只要 run_id 撞上就回 202 + 旧状态：调用方把 id 复用到了另一个任务，
看到的是上一个任务的进度，怎么查都查不出「新任务根本没跑」。
"""

from __future__ import annotations

import json
import time

from fastapi.testclient import TestClient

from agent_pipeline.config import Settings
from agent_pipeline.service import create_app


def _reply(messages, _tools):
    system = "\n".join(str(m.get("content", "")) for m in messages if m.get("role") == "system")
    time.sleep(0.01)
    if "规划者" in system:
        payload = {"steps": [{"goal": "做一件事", "done_when": "能跑通"}]}
    elif "评审者" in system:
        payload = {"score": 0.95, "blocking_issues": [], "suggestions": []}
    elif "总结者" in system or "汇总" in system:
        payload = {"answer": "做完了", "citations": []}
    elif "反思" in system:
        payload = {"verdict": "done", "reasons": ["能跑"]}
    else:
        payload = {"text": "做完了"}
    return {"text": json.dumps(payload, ensure_ascii=False)}


def _wait_done(client: TestClient, run_id: str, timeout_s: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        body = client.get(f"/v1/runs/{run_id}").json()
        if body["status"] not in ("running", "cancelling"):
            return body
        time.sleep(0.02)
    raise AssertionError(f"run {run_id} 没在 {timeout_s}s 内结束")


def _client(runtime_factory) -> TestClient:
    settings = Settings(log_path=":memory:", db_path=":memory:", max_concurrent_runs=2)
    runtime = runtime_factory([_reply] * 64, settings=settings)
    return TestClient(create_app(runtime=runtime))


def test_identical_resubmission_is_idempotent(runtime_factory):
    client = _client(runtime_factory)
    payload = {"goal": "确认版本号", "run_id": "r-dup", "mode": "react"}

    with client:
        first = client.post("/v1/runs", json=payload)
        assert first.status_code == 202
        second = client.post("/v1/runs", json=payload)
        assert second.status_code == 202
        assert second.json()["run_id"] == "r-dup"
        done = _wait_done(client, "r-dup")
        # 第四次提交发生在结束之后：仍应幂等返回，而不是 409。
        third = client.post("/v1/runs", json=payload)
        assert third.status_code == 202
        assert third.json()["status"] == done["status"] == "ok"
        # 只开工一次：日志里只有一行。
        assert done["run_id"] == "r-dup"


def test_reused_run_id_with_different_task_is_rejected(runtime_factory):
    client = _client(runtime_factory)

    with client:
        assert (
            client.post("/v1/runs", json={"goal": "确认版本号", "run_id": "r-clash", "mode": "react"}).status_code
            == 202
        )
        clash = client.post("/v1/runs", json={"goal": "换一个完全不同的任务", "run_id": "r-clash", "mode": "react"})

        assert clash.status_code == 409, clash.text
        detail = clash.json()["detail"]
        # 错误必须指出是哪个字段变了，否则调用方仍不知道该不该换 id。
        assert "r-clash" in detail
        assert "goal" in detail
        # 原来的任务没有被这第二次提交改掉。
        done = _wait_done(client, "r-clash")
        assert done["status"] == "ok"


def test_reused_run_id_with_different_mode_is_rejected(runtime_factory):
    client = _client(runtime_factory)

    with client:
        assert client.post("/v1/runs", json={"goal": "确认版本号", "run_id": "r-mode", "mode": "react"}).status_code == 202
        clash = client.post("/v1/runs", json={"goal": "确认版本号", "run_id": "r-mode", "mode": "adversarial"})

        assert clash.status_code == 409, clash.text
        assert "mode" in clash.json()["detail"]