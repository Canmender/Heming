"""长跑不飘的两条硬约束：进程内 run 有上限、JSONL 日志会轮转。"""

from __future__ import annotations

import json
import time

from fastapi.testclient import TestClient

from agent_pipeline.config import Settings
from agent_pipeline.protocol import TaskSpec
from agent_pipeline.runtime import run_once
from agent_pipeline.service import create_app


def _reply(messages, _tools):
    system = "\n".join(str(m.get("content", "")) for m in messages if m.get("role") == "system")
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


def _wait_done(client: TestClient, run_id: str, timeout: float = 10.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        payload = client.get(f"/v1/runs/{run_id}").json()
        if payload.get("status") != "running":
            return payload
        time.sleep(0.02)
    raise AssertionError(f"run {run_id} 没在 {timeout}s 内结束")


def _client(runtime_factory, **settings_kwargs) -> TestClient:
    settings = Settings(log_path=":memory:", db_path=":memory:", **settings_kwargs)
    runtime = runtime_factory([_reply] * 128, settings=settings)
    return TestClient(create_app(runtime=runtime))


def test_run_history_is_capped(runtime_factory) -> None:
    with _client(runtime_factory, run_history_limit=2, max_concurrent_runs=2) as client:
        run_ids = []
        for index in range(5):
            response = client.post("/v1/runs", json={"goal": f"任务 {index}"})
            assert response.status_code == 202
            run_id = response.json()["run_id"]
            assert _wait_done(client, run_id)["status"] == "ok"
            run_ids.append(run_id)

        # 只保留最近两个：更早的已经清掉（GET 404），进程内存不会随请求数单调上涨。
        for run_id in run_ids[:3]:
            assert client.get(f"/v1/runs/{run_id}").status_code == 404
        for run_id in run_ids[3:]:
            assert client.get(f"/v1/runs/{run_id}").status_code == 200


def test_jsonl_log_rotates_when_too_big(runtime_factory, tmp_path) -> None:
    log_path = tmp_path / "runs.jsonl"
    settings = Settings(
        log_path=str(log_path),
        db_path=":memory:",
        log_max_bytes=3000,  # 一行约 800 字节，攒到四行就会触发
    )
    runtime = runtime_factory([_reply] * 64, settings=settings)

    for index in range(8):
        run_once(runtime, TaskSpec(goal=f"任务 {index}"), run_id=f"rotate-{index}")

    assert log_path.exists()
    backup = tmp_path / "runs.jsonl.1"
    assert backup.exists(), "超过 log_max_bytes 后应轮转到 .1"

    def rows(path) -> list[str]:
        return [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    # 四行日志一条不少（轮转不丢数据），且当前文件确实重新开始写：
    # 单行本身就可能大于阈值，所以断言「当前文件只有最后一行」而不是「小于阈值」。
    assert len(rows(backup)) + len(rows(log_path)) == 8
    assert len(rows(log_path)) < 8
    for line in rows(backup) + rows(log_path):
        assert json.loads(line)["run_id"].startswith("rotate-")