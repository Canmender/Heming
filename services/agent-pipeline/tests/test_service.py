"""HTTP 服务测试：提交、轮询、幂等、指标、配置回滚。"""

from __future__ import annotations

import json
import time
from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient

from agent_pipeline.protocol import TaskSpec  # noqa: F401  (契约参考)
from agent_pipeline.service import create_app
from agent_pipeline.tools import ToolSpec


def _json(payload: dict) -> dict:
    return {"text": json.dumps(payload, ensure_ascii=False)}


def _wait(client: TestClient, run_id: str, timeout: float = 8.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get(f"/v1/runs/{run_id}").json()
        if body.get("status") not in ("running", None):
            return body
        time.sleep(0.02)
    raise AssertionError(f"run {run_id} 在 {timeout}s 内没有结束")


def test_health_and_tools(runtime_factory) -> None:
    runtime = runtime_factory([])
    client = TestClient(create_app(runtime=runtime))

    health = client.get("/health").json()
    assert health["ok"] is True
    assert "echo" not in health["tools"]

    tools = client.get("/v1/tools").json()["tools"]
    assert isinstance(tools, list)


def test_create_run_and_poll(runtime_factory) -> None:
    script = [
        _json({"steps": [{"goal": "回答问题", "done_when": "有答复"}]}),
        {"text": "不需要工具"},
        _json({"verdict": "done", "reasons": ["可以直接回答"]}),
        _json({"score": 0.9, "blocking_issues": []}),
        _json({"answer": "这是最终答案", "citations": []}),
    ]
    runtime = runtime_factory(script)
    client = TestClient(create_app(runtime=runtime))

    response = client.post("/v1/runs", json={"goal": "给我一个答案", "run_id": "run-fixed"})
    assert response.status_code == 202
    assert response.json()["poll"] == "/v1/runs/run-fixed"

    body = _wait(client, "run-fixed")
    assert body["status"] == "ok"
    assert body["result"]["answer"] == "这是最终答案"

    # 幂等：同一 run_id 再提交不会新建
    again = client.post("/v1/runs", json={"goal": "给我一个答案", "run_id": "run-fixed"})
    assert again.status_code == 202
    assert again.json()["status"] == "ok"


def test_metrics_endpoint_exposes_counters(runtime_factory) -> None:
    script = [
        _json({"steps": [{"goal": "跑一下", "done_when": "有答复"}]}),
        {"text": "无工具"},
        _json({"verdict": "done", "reasons": []}),
        _json({"score": 0.9, "blocking_issues": []}),
        _json({"answer": "好", "citations": []}),
    ]
    runtime = runtime_factory(script)
    client = TestClient(create_app(runtime=runtime))
    client.post("/v1/runs", json={"goal": "指标", "run_id": "run-metrics"})
    _wait(client, "run-metrics")

    response = client.get("/metrics")
    assert response.status_code == 200
    assert "text/plain" in response.headers["content-type"]
    assert 'pipeline_runs_total{status="ok"} 1.0' in response.text
    assert "llm_tokens_total" in response.text


def test_invalid_mode_is_rejected(runtime_factory) -> None:
    runtime = runtime_factory([])
    client = TestClient(create_app(runtime=runtime))
    response = client.post("/v1/runs", json={"goal": "x", "mode": "debate"})
    assert response.status_code == 422


def test_missing_run_returns_404(runtime_factory) -> None:
    runtime = runtime_factory([])
    client = TestClient(create_app(runtime=runtime))
    assert client.get("/v1/runs/nope").status_code == 404


def test_config_rollback_endpoint_is_idempotent(runtime_factory) -> None:
    runtime = runtime_factory([])
    client = TestClient(create_app(runtime=runtime))

    first = client.post("/v1/config/rollback").json()
    assert first["ok"] is True
    second = client.post("/v1/config/rollback").json()
    assert second["ok"] is True
    assert client.get("/v1/config").json()["canary"] is None


def test_health_reports_tuner_state(runtime_factory) -> None:
    runtime = runtime_factory([])
    client = TestClient(create_app(runtime=runtime))

    tuner = client.get("/health").json()["tuner"]
    # 默认不开：容器启动不该在没人看的时候悄悄改配置
    assert tuner == {"enabled": False, "running": False, "last_error": None, "last_ran_at": None}


def test_tune_endpoint_reports_failures(runtime_factory) -> None:
    runtime = runtime_factory([])
    Path(runtime.settings.log_path).write_text(
        json.dumps(
            {
                "run_id": "r-tune",
                "status": "error",
                "stop_reason": "max_steps",
                "finished_at": time.time(),
                "task": {"goal": "把测试跑一遍"},
                "answer": "",
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    client = TestClient(create_app(runtime=runtime))

    body = client.post("/v1/tune", json={"since_hours": 24}).json()
    assert body["total_runs"] == 1
    assert body["failure_modes"] == {"max_steps": 1}
    assert body["applied_version"] is None


def test_tune_evaluator_only_wired_when_enabled(runtime_factory) -> None:
    runtime = runtime_factory([])
    assert create_app(runtime=runtime).state.tuner.evaluator is None

    enabled = runtime_factory([], settings=replace(runtime.settings, tune_eval_enabled=True))
    app = create_app(runtime=enabled)
    # 开启后才接「回放 A/B」评测器：默认只出报告，不注册任何版本
    assert app.state.tuner.evaluator is not None


def test_approve_endpoint_unblocks_write_tool(runtime_factory) -> None:
    """HTTP 侧的审批闭环：挂起 → 轮询看到 pending → 裁决 → run 继续跑完。"""
    executed: list[dict] = []

    def handler(args: dict) -> str:
        executed.append(args)
        return "written"

    spec = ToolSpec(
        name="write_file",
        description="写文件",
        schema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
            "additionalProperties": False,
        },
        risk="write",
        handler=handler,
        idempotent=False,
    )
    script = [
        _json({"steps": [{"goal": "写文件", "done_when": "观测里出现 written"}]}),
        {
            "text": "先写",
            "tool_calls": [{"id": "c1", "name": "write_file", "arguments": {"path": "a.txt"}}],
        },
        {"text": "写好了"},
        _json({"verdict": "done", "reasons": ["有 written"]}),
        _json({"score": 0.9, "blocking_issues": []}),
        _json({"answer": "完成", "citations": []}),
    ]
    runtime = runtime_factory(script, tools=[spec])
    runtime.settings = replace(runtime.settings, approval_mode="write", approval_timeout_s=5.0)
    client = TestClient(create_app(runtime=runtime))

    health = client.get("/health").json()
    assert health["approval_mode"] == "write"

    response = client.post("/v1/runs", json={"goal": "写文件", "run_id": "run-approve"})
    assert response.status_code == 202

    deadline = time.time() + 5
    pending: list[dict] = []
    while time.time() < deadline:
        body = client.get("/v1/runs/run-approve").json()
        pending = body.get("pending_approvals") or []
        if pending:
            break
        time.sleep(0.02)
    assert pending, "写工具执行时必须先挂起等审批"

    approved = client.post(
        "/v1/runs/run-approve/approve",
        json={"call_id": pending[0]["call_id"], "approved": True},
    )
    assert approved.status_code == 200
    assert approved.json()["approved"] is True

    body = _wait(client, "run-approve")
    assert body["status"] == "ok"
    assert executed == [{"path": "a.txt"}]

    # 已经裁决过的 call_id 再来一次：没有待审批 → 409（不假装成功）
    again = client.post("/v1/runs/run-approve/approve", json={"approved": True})
    assert again.status_code == 409


def test_approve_endpoint_rejects_when_mode_off(runtime_factory) -> None:
    runtime = runtime_factory([])
    client = TestClient(create_app(runtime=runtime))
    response = client.post("/v1/runs/nope/approve", json={"approved": True})
    assert response.status_code == 404
