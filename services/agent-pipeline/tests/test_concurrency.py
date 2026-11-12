"""服务的并发口径：超出上限直接 429、跑完放行、幂等 run_id 不会重复开工。"""

from __future__ import annotations

import json
import re
import time
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

from agent_pipeline.config import Settings
from agent_pipeline.service import create_app


def _reply(messages, _tools):
    """按节点 system 提示词回合法 JSON——并发时调用顺序不可预测，只能按提示词分支。"""
    system = "\n".join(str(m.get("content", "")) for m in messages if m.get("role") == "system")
    time.sleep(0.02)  # 让后台线程真的处在「running」，并发才有意义
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


def _client(runtime_factory, *, max_concurrent: int) -> TestClient:
    settings = Settings(
        log_path=":memory:",
        db_path=":memory:",
        max_concurrent_runs=max_concurrent,
    )
    runtime = runtime_factory([_reply] * 64, settings=settings)
    app = create_app(runtime=runtime)
    return TestClient(app)


def _wait_done(client: TestClient, run_id: str, timeout: float = 10.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        payload = client.get(f"/v1/runs/{run_id}").json()
        if payload["status"] != "running":
            return payload
        time.sleep(0.02)
    raise AssertionError(f"run {run_id} 没有在 {timeout}s 内结束：{payload}")


def _runs_ok(metrics_text: str) -> int:
    match = re.search(r'pipeline_runs_total\{status="ok"\} ([0-9.]+)', metrics_text)
    return int(float(match.group(1))) if match else 0


def test_sixth_concurrent_run_is_rejected_with_retry_after(runtime_factory) -> None:
    with _client(runtime_factory, max_concurrent=1) as client:
        first = client.post("/v1/runs", json={"goal": "第一个"})
        assert first.status_code == 202
        second = client.post("/v1/runs", json={"goal": "第二个"})
        assert second.status_code == 429
        assert second.headers["Retry-After"] == "5"

        run_id = first.json()["run_id"]
        assert _wait_done(client, run_id)["status"] == "ok"

        # 名额释放后能继续接活：背压是「拒绝」而不是「永久卡死」。
        third = client.post("/v1/runs", json={"goal": "第三个"})
        assert third.status_code == 202
        assert _wait_done(client, third.json()["run_id"])["status"] == "ok"


def test_burst_keeps_accepted_count_and_metrics_consistent(runtime_factory) -> None:
    with _client(runtime_factory, max_concurrent=4) as client:
        with ThreadPoolExecutor(max_workers=12) as pool:
            responses = list(
                pool.map(lambda i: client.post("/v1/runs", json={"goal": f"任务 {i}"}), range(12))
            )

        accepted = [r.json()["run_id"] for r in responses if r.status_code == 202]
        rejected = [r for r in responses if r.status_code == 429]
        assert len(accepted) + len(rejected) == 12
        assert accepted, "至少要有被接收的 run"
        assert len(accepted) <= 4, "一帧并发不该超过信号量上限"

        for run_id in accepted:
            assert _wait_done(client, run_id)["status"] == "ok"

        # 指标是「真跑完」的证据：计数必须等于被接收的数量，不能少也不能翻倍。
        assert _runs_ok(client.get("/metrics").text) == len(accepted)


def test_same_run_id_submitted_twice_runs_once(runtime_factory) -> None:
    with _client(runtime_factory, max_concurrent=4) as client:
        body = {"goal": "只跑一次", "run_id": "fixed-run-id"}
        first = client.post("/v1/runs", json=body)
        second = client.post("/v1/runs", json=body)
        assert first.status_code == 202
        assert second.status_code == 202
        assert second.json()["run_id"] == "fixed-run-id"

        done = _wait_done(client, "fixed-run-id")
        assert done["status"] == "ok"
        assert _runs_ok(client.get("/metrics").text) == 1, "幂等提交不能把同一个 run 跑两遍"

def test_same_run_id_submitted_concurrently_runs_once(runtime_factory) -> None:
    """幂等必须在**并发**下也成立：8 个线程同时用同一个 run_id 提交，只能真跑一次。

    串行提交的幂等靠「先查字典再写」就能过；并发时若没把「查+占位」放进同一把锁，
    会出现两个线程都判定「还没有这个 run」→ 两条执行线程、两次计费、结果互相覆盖。
    """
    with _client(runtime_factory, max_concurrent=8) as client:
        body = {"goal": "并发同 id", "run_id": "race-run-id"}
        with ThreadPoolExecutor(max_workers=8) as pool:
            responses = list(pool.map(lambda _: client.post("/v1/runs", json=body), range(8)))

        assert all(r.status_code == 202 for r in responses), [r.status_code for r in responses]
        assert {r.json()["run_id"] for r in responses} == {"race-run-id"}

        assert _wait_done(client, "race-run-id")["status"] == "ok"
        assert _runs_ok(client.get("/metrics").text) == 1, "同一个 run_id 只能真正跑一次"
