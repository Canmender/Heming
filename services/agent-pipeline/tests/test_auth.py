"""入站鉴权：服务端真的校验 `Authorization` 了吗？

以前只有桌面端在发这个头、服务端根本没看：把 `0.0.0.0:8000` 暴露出来（Dockerfile
默认如此）时，任何人都能提交 run —— 而 run 可以执行命令、读知识库。这组用例钉住：
设了令牌就必须带对，探针与指标端点不受影响。
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from agent_pipeline.config import Settings
from agent_pipeline.runtime import build_runtime
from agent_pipeline.service import create_app

TOKEN = "svc-token-123"


@pytest.fixture()
def client(tmp_path) -> Iterator[TestClient]:
    settings = Settings(
        service_token=TOKEN,
        log_path=str(tmp_path / "runs.jsonl"),
        db_path=":memory:",
        max_concurrent_runs=1,
    )
    app = create_app(settings=settings, runtime=build_runtime(settings))
    with TestClient(app) as instance:
        yield instance


def _payload() -> dict:
    return {"goal": "看一眼知识库", "mode": "react"}


def test_v1_endpoints_require_token(client: TestClient) -> None:
    response = client.post("/v1/runs", json=_payload())
    assert response.status_code == 401
    assert "AGENT_SERVICE_TOKEN" in response.json()["detail"]
    assert response.headers.get("www-authenticate") == "Bearer"

    assert client.get("/v1/knowledge").status_code == 401
    assert client.get("/v1/tools").status_code == 401


def test_wrong_token_is_rejected(client: TestClient) -> None:
    headers = {"Authorization": "Bearer not-the-token"}
    assert client.post("/v1/runs", json=_payload(), headers=headers).status_code == 401
    # 大小写与前缀都要宽容，但内容必须对得上
    assert (
        client.post(
            "/v1/runs", json=_payload(), headers={"Authorization": f"bearer {TOKEN}"}
        ).status_code
        in (202, 429)
    )


def test_health_and_metrics_stay_open(client: TestClient) -> None:
    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["auth"] == "on"
    assert client.get("/metrics").status_code == 200


def test_auth_off_when_token_missing(tmp_path) -> None:
    settings = Settings(log_path=str(tmp_path / "runs.jsonl"), db_path=":memory:")
    app = create_app(settings=settings, runtime=build_runtime(settings))
    with TestClient(app) as instance:
        assert instance.get("/health").json()["auth"] == "off"
        # 本机调试形态：不设令牌不拦（但 /health 明说了 auth=off）
        assert instance.get("/v1/tools").status_code == 200