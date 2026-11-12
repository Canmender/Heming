"""自动回滚的 HTTP 闭环：灰度版本连续失败，服务自己把 active 换回来。

`test_rollback.py` 测的是 store 层，`soak.py --canary` 测的是压测路径，但没有
「通过真实服务提交 run → 落 outcome → 自动回滚 → `/v1/config` 读到换回」这条线。
这条线断掉的表现很隐蔽：灰度一直在跑、错误率一直在报警，配置却永远不回来。

需求口径（README「可观测与回滚」）：canary 承接流量；错误率超过
`AGENT_ERROR_THRESHOLD` 且样本数达到 `AGENT_MIN_SAMPLES` 时自动归档 canary，
active 继续服务。
"""

from __future__ import annotations

import time

from fastapi.testclient import TestClient

from agent_pipeline.config import Settings
from agent_pipeline.llm import FakeLLM
from agent_pipeline.metrics import Metrics
from agent_pipeline.runtime import build_runtime
from agent_pipeline.service import create_app

TERMINAL = {"ok", "error", "aborted", "budget"}


def _client(tmp_path) -> tuple[TestClient, object, Metrics]:
    settings = Settings(
        log_path=str(tmp_path / "runs.jsonl"),
        db_path=":memory:",
        # 全量走灰度，两个样本就够判定，错误率阈值 0.5 → 2 次全失败必滚。
        canary_ratio=1.0,
        error_threshold=0.5,
        min_samples_for_rollback=2,
        max_concurrent_runs=2,
    )
    metrics = Metrics()
    # 空脚本的 FakeLLM 每次调用都抛错：站在服务外面看就是「上游全挂」。
    runtime = build_runtime(settings, llm=FakeLLM([]), metrics=metrics)
    return TestClient(create_app(settings=settings, runtime=runtime)), runtime, metrics


def _wait(client: TestClient, run_id: str, timeout_s: float = 10.0) -> dict:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        payload = client.get(f"/v1/runs/{run_id}").json()
        if payload["status"] in TERMINAL:
            return payload
        time.sleep(0.02)
    raise AssertionError(f"run {run_id} 在 {timeout_s}s 内没有收口")


def test_canary_failures_trigger_auto_rollback_and_active_comes_back(tmp_path) -> None:
    client, runtime, metrics = _client(tmp_path)
    store = runtime.config_store
    active = store.register({"prompts": {"plan": "稳定版提示词"}}, promote=True)
    canary = store.register({"prompts": {"plan": "灰度版提示词"}}, promote=False)
    store._set_stage(canary.id, "canary")

    with client:
        # 两次都失败：outcome 记到 canary 名下，错满 2 个样本就触发自动回滚。
        for _ in range(2):
            submitted = client.post("/v1/runs", json={"goal": "做个不可能完成的任务"})
            assert submitted.status_code == 202, submitted.text
            _wait(client, submitted.json()["run_id"])

        config = client.get("/v1/config").json()
        health = client.get("/health").json()
        body = client.get("/metrics").text
        # 灰度期间的失败确实记在了 canary 名下（不是记在 active 上白滚一场）。
        # 必须在 with 里读：退出上下文时 lifespan 会 close 掉 ConfigStore。
        window = store.window(canary.id)

    assert config["active"]["id"] == active.id, "自动回滚后 active 必须回到稳定版"
    assert config["canary"] is None, "回滚会归档 canary，不能留下第二个候选在跑"
    archived = {item["id"]: item["stage"] for item in config["history"]}
    assert archived[canary.id] == "archived"
    assert 'pipeline_rollback_total{reason="error_rate"} 1.0' in body
    assert window["samples"] == 2 and window["errors"] == 2
    assert health["ok"] is True, "回滚之后服务本身仍然健康"
    assert metrics  # 保留引用，方便手工调试


def test_no_rollback_before_enough_samples(tmp_path) -> None:
    """样本不够就不滚：一个新提示词第一次就赶上上游抖动，不该立刻判死刑。"""
    client, runtime, _metrics = _client(tmp_path)
    store = runtime.config_store
    active = store.register({"prompts": {"plan": "稳定版提示词"}}, promote=True)
    canary = store.register({"prompts": {"plan": "灰度版提示词"}}, promote=False)
    store._set_stage(canary.id, "canary")

    with client:
        client.post("/v1/runs", json={"goal": "一次失败还不算数"})
        # 只跑一次（min_samples=2），等这一个 run 收口即可
        deadline = time.time() + 10
        while time.time() < deadline and not store.window(canary.id)["samples"]:
            time.sleep(0.02)
        config = client.get("/v1/config").json()

    assert config["active"]["id"] == active.id
    assert config["canary"]["id"] == canary.id, "样本不够时灰度保留"