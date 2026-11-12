"""取消一个卡在「等审批」的 run：必须立刻收口，而不是等审批超时。

线上最容易出现的「点了取消没反应」就是这种：写工具挂在 HITL 闸上等 300 秒，
取消只置了协作标记，执行线程还在 wait 里。
"""

from __future__ import annotations

import json
import time

from fastapi.testclient import TestClient

from agent_pipeline.config import Settings
from agent_pipeline.service import create_app


def _json(payload: dict) -> dict:
    return {"text": json.dumps(payload, ensure_ascii=False)}


def _wait_for_pending(client: TestClient, run_id: str, timeout: float = 5.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get(f"/v1/runs/{run_id}").json()
        if body.get("pending_approvals"):
            return body
        time.sleep(0.02)
    raise AssertionError(f"{timeout}s 内没有出现待审批：{body}")


def _wait_status(client: TestClient, run_id: str, timeout: float = 5.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get(f"/v1/runs/{run_id}").json()
        if body.get("status") not in ("running", "cancelling", None):
            return body
        time.sleep(0.02)
    raise AssertionError(f"{timeout}s 内没有结束：{body}")


def test_cancel_unblocks_pending_approval_immediately(runtime_factory) -> None:
    script = [
        _json({"steps": [{"goal": "写一下文件", "done_when": "文件写好"}]}),
        {
            "text": "准备执行写操作",
            "tool_calls": [{"id": "w1", "name": "run_command", "arguments": {"command": "echo hi"}}],
        },
    ]
    # 审批超时故意设得很大：只有「取消」这条路径能把它放出来
    settings = Settings(log_path=":memory:", db_path=":memory:", approval_mode="write", approval_timeout_s=300.0)
    runtime = runtime_factory(script, settings=settings)
    client = TestClient(create_app(settings=settings, runtime=runtime))

    assert client.post("/v1/runs", json={"goal": "写文件", "run_id": "run-wait"}).status_code == 202
    pending = _wait_for_pending(client, "run-wait")
    assert pending["pending_approvals"][0]["tool"] == "run_command"

    started = time.time()
    assert client.post("/v1/runs/run-wait/cancel").status_code == 202
    body = _wait_status(client, "run-wait", timeout=5.0)
    elapsed = time.time() - started

    assert body["status"] == "aborted", f"取消后应收口为 aborted，实际 {body['status']}"
    assert body["pending_approvals"] == [], "待审批要一起收口，不能挂在那里"
    assert elapsed < 5.0, f"取消后等了 {elapsed:.1f}s，说明还卡在审批等待里"


def test_finished_run_leaves_no_pending_approvals(runtime_factory) -> None:
    script = [
        _json({"steps": [{"goal": "回答问题", "done_when": "有答复"}]}),
        {"text": "不需要工具"},
        _json({"verdict": "done", "reasons": ["完成"]}),
        _json({"score": 0.9, "blocking_issues": []}),
        _json({"answer": "好了", "citations": []}),
    ]
    settings = Settings(log_path=":memory:", db_path=":memory:", approval_mode="write")
    runtime = runtime_factory(script, settings=settings)
    client = TestClient(create_app(settings=settings, runtime=runtime))

    assert client.post("/v1/runs", json={"goal": "回答", "run_id": "run-clean"}).status_code == 202
    body = _wait_status(client, "run-clean")
    assert body["status"] == "ok"
    assert body["pending_approvals"] == []
    assert client.get("/health").json()["pending_approvals"] == 0