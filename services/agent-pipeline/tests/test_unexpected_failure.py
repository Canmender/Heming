"""后台执行线程遇到「意料之外的异常」时也得把 run 收口。

`_execute` 里 `run_once` 抛的不是 `LLMError`（比如运行时 bug、依赖库抛
`RuntimeError`、SQLite 句柄失效）时，轮询方不能一直看到 `running` 等到超时：
后台线程把异常收成 `status="error"` + 原因写进 `error`，并且取消标记/线程表/
信号量都要回收，否则这个 run 会永远占一个并发位。
"""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from agent_pipeline import service as service_module
from agent_pipeline.service import create_app


def _wait(client: TestClient, run_id: str, timeout: float = 5.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        payload = client.get(f"/v1/runs/{run_id}").json()
        if payload.get("status") != "running":
            return payload
        time.sleep(0.01)
    raise AssertionError("run 一直没有收口")


def test_unexpected_exception_ends_the_run_with_error(runtime_factory, monkeypatch):
    runtime = runtime_factory([])

    def boom(*_args, **_kwargs):
        raise RuntimeError("运行时内部错误：线程池已关闭")

    monkeypatch.setattr(service_module, "run_once", boom)
    app = create_app(runtime=runtime)
    with TestClient(app) as client:
        res = client.post("/v1/runs", json={"goal": "随便做点什么"})
        assert res.status_code == 202
        run_id = res.json()["run_id"]

        payload = _wait(client, run_id)
        assert payload["status"] == "error"
        assert "RuntimeError" in payload["error"]
        assert "线程池已关闭" in payload["error"]
        assert payload["finished_at"] > 0
        assert "result" not in payload
        # 待审批、取消标记、执行线程都不能留残留。
        assert payload["pending_approvals"] == []
        assert run_id not in app.state.cancels
        assert run_id not in app.state.threads

        # 信号量必须释放：否则一次意外异常就永久少一个并发位。
        again = client.post("/v1/runs", json={"goal": "再来一次"})
        assert again.status_code == 202
        assert _wait(client, again.json()["run_id"])["status"] == "error"


def test_unexpected_exception_is_not_reported_as_success(runtime_factory, monkeypatch):
    """回归：以前异常路径没有 `result`，轮询方若按「有 answer」判成功会看错。"""
    runtime = runtime_factory([])
    monkeypatch.setattr(
        service_module,
        "run_once",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(KeyError("missing")),
    )
    app = create_app(runtime=runtime)
    with TestClient(app) as client:
        run_id = client.post("/v1/runs", json={"goal": "x"}).json()["run_id"]
        payload = _wait(client, run_id)
        assert payload["status"] == "error"
        assert "KeyError" in payload["error"]