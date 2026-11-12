"""/v1/config 三个入口的 HTTP 行为（读、promote、rollback）。

自动回滚是写死在调优链路里的，人工处置反而是线上最常用的路径（出事时点一下）。
之前只有 store 层单测与 409 幂等断言，没有「promote 后 active 真的换了、再 rollback
真的换回去」这条闭环。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from agent_pipeline.config import Settings
from agent_pipeline.llm import FakeLLM
from agent_pipeline.metrics import Metrics
from agent_pipeline.runtime import build_runtime
from agent_pipeline.service import create_app


def _client(tmp_path) -> tuple[TestClient, object, Metrics]:
    settings = Settings(log_path=str(tmp_path / "runs.jsonl"), db_path=":memory:")
    metrics = Metrics()
    runtime = build_runtime(settings, llm=FakeLLM([]), metrics=metrics)
    return TestClient(create_app(settings=settings, runtime=runtime)), runtime, metrics


def test_config_endpoint_shows_active_and_canary(tmp_path) -> None:
    client, runtime, _metrics = _client(tmp_path)
    store = runtime.config_store
    active = store.register({"prompts": {"plan": "旧提示词"}}, promote=True)
    canary = store.register({"prompts": {"plan": "候选提示词"}}, promote=False)
    store._set_stage(canary.id, "canary")

    payload = client.get("/v1/config").json()

    assert payload["active"]["id"] == active.id
    assert payload["active"]["payload"]["prompts"]["plan"] == "旧提示词"
    assert payload["canary"]["id"] == canary.id
    assert {item["id"] for item in payload["history"]} >= {active.id, canary.id}


def test_promote_then_rollback_roundtrip(tmp_path) -> None:
    client, runtime, metrics = _client(tmp_path)
    store = runtime.config_store
    first = store.register({"prompts": {"plan": "第一版"}}, promote=True)
    candidate = store.register({"prompts": {"plan": "第二版"}}, promote=False)
    store._set_stage(candidate.id, "canary")

    promoted = client.post("/v1/config/promote").json()
    assert promoted["ok"] is True
    assert promoted["active"] == candidate.id
    assert store.active().payload["prompts"]["plan"] == "第二版"

    # 只归档灰度（没有灰度时是空操作）——promote 之后要反悔得指明版本
    noop = client.post("/v1/config/rollback").json()
    assert noop["reason"] == "canary"
    assert store.active().id == candidate.id

    rolled_back = client.post("/v1/config/rollback", json={"version_id": first.id}).json()
    assert rolled_back["ok"] is True
    assert rolled_back["reason"] == "activate"
    assert rolled_back["active"] == first.id, "指了版本就必须真的切回去，而不是清空"
    assert store.active().payload["prompts"]["plan"] == "第一版"
    assert store.canary() is None

    # 指标里要能看见这次人工回滚（否则告警/看板不知道有人动过配置）
    body = client.get("/metrics").text
    assert 'pipeline_rollback_total{reason="manual"} 2.0' in body


def test_rollback_to_unknown_version_is_404(tmp_path) -> None:
    client, runtime, _metrics = _client(tmp_path)
    runtime.config_store.register({"prompts": {"plan": "唯一一版"}}, promote=True)

    response = client.post("/v1/config/rollback", json={"version_id": 999})

    assert response.status_code == 404
    assert "没有这个配置版本" in response.json()["detail"]


def test_config_endpoints_degrade_when_store_missing(tmp_path) -> None:
    client, runtime, _metrics = _client(tmp_path)
    runtime.config_store = None

    payload = client.get("/v1/config").json()
    assert payload == {"active": None, "canary": None, "history": []}
    assert client.post("/v1/config/promote").status_code == 409
    assert client.post("/v1/config/rollback").status_code == 409