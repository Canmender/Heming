"""跨语言契约：桌面端客户端读的字段名，服务端必须真的给。

`packages/web/src/lib/pipeline/client.ts` 只认这几个键（写了 ts 类型，但类型是编译期的）：
- `POST /v1/runs` → `run_id`、`status`
- `GET  /v1/runs/{id}` → `run_id`、`status`、`pending_approvals`，终态时 `result`
- `result` 里 → `run_id`、`status`、`answer`、`citations[{doc_id, chunk, quote}]`、
  `coverage`、`stop_reason`、`llm_calls`、`tokens`、`config_version`、`error`
- `GET /health` → `ok`、`tools`、`running`
- `POST /v1/runs/{id}/approve` → 接受 `{call_id, approved}`

服务端是 pydantic/`asdict()` 生成的，改一个字（比如 `stopReason`、`runId`）TS 那边
不会报错——它只会静默拿到 `undefined`，界面显示空答案。这个测试就是那道闸：
**改字段名必须同时改两处**，否则这里红。
"""

from __future__ import annotations

import json
import time

from fastapi.testclient import TestClient

from agent_pipeline.config import Settings
from agent_pipeline.service import create_app

RESULT_KEYS = {
    "run_id",
    "status",
    "answer",
    "citations",
    "coverage",
    "stop_reason",
    "llm_calls",
    "tokens",
    "config_version",
    "error",
}


def _reply(messages, _tools):
    system = "\n".join(str(m.get("content", "")) for m in messages if m.get("role") == "system")
    if "规划者" in system:
        payload = {"steps": [{"goal": "查一下知识库", "done_when": "拿到结论"}]}
    elif "评审者" in system:
        payload = {"score": 0.95, "blocking_issues": [], "suggestions": []}
    elif "总结者" in system or "汇总" in system:
        payload = {
            "answer": "做完了",
            "citations": [{"doc_id": "doc-1", "chunk": 0, "quote": "通用外壳"}],
        }
    elif "反思" in system:
        payload = {"verdict": "done", "reasons": ["能跑"]}
    else:
        payload = {"text": "做完了"}
    return {"text": json.dumps(payload, ensure_ascii=False)}


def _client(runtime_factory) -> TestClient:
    settings = Settings(log_path=":memory:", db_path=":memory:", approval_mode="write", approval_timeout_s=5)
    runtime = runtime_factory([_reply] * 32, settings=settings)
    return TestClient(create_app(runtime=runtime))


def _wait(client: TestClient, run_id: str, timeout: float = 10.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        payload = client.get(f"/v1/runs/{run_id}").json()
        if payload["status"] != "running":
            return payload
        time.sleep(0.02)
    raise AssertionError(f"run 没结束：{payload}")


def test_health_fields_the_client_reads(runtime_factory) -> None:
    with _client(runtime_factory) as client:
        health = client.get("/health").json()
    assert health["ok"] is True
    assert isinstance(health["tools"], list) and "http_get" in health["tools"]
    assert isinstance(health["running"], int)


def test_run_submission_and_result_contract(runtime_factory) -> None:
    with _client(runtime_factory) as client:
        created = client.post("/v1/runs", json={"goal": "把它做完", "run_id": "contract"})
        assert created.status_code == 202, created.text
        body = created.json()
        assert body["run_id"] == "contract"
        assert body["status"] in {"running", "queued", "ok"}

        payload = _wait(client, "contract")

    assert payload["run_id"] == "contract"
    assert payload["status"] in {"ok", "error", "aborted"}
    assert isinstance(payload["pending_approvals"], list), "客户端靠这个字段决定要不要弹审批"
    result = payload["result"]
    missing = RESULT_KEYS - set(result)
    assert not missing, f"客户端会读的字段缺了：{sorted(missing)}（改字段名要同时改 client.ts）"
    assert isinstance(result["answer"], str)
    assert isinstance(result["citations"], list)
    if result["citations"]:
        citation = result["citations"][0]
        assert set(citation) >= {"doc_id", "chunk", "quote"}, citation
        assert isinstance(citation["chunk"], int)


def test_approve_accepts_call_id_and_approved(runtime_factory) -> None:
    """客户端提交的是 `{call_id, approved}`；服务端只接受这个形状（多余字段会被 pydantic 忽略）。"""
    with _client(runtime_factory) as client:
        # 没有待审批时 approve 是 409，但先证明请求体被接受（不是 422 校验错误）
        response = client.post("/v1/runs/whatever/approve", json={"call_id": "c1", "approved": False})
    assert response.status_code == 404, "run 不存在应先 404，而不是 422（说明请求体形状对）"