"""HTTP 服务：一进（POST /v1/runs）一出（GET /v1/runs/{id}）+ Prometheus + 配置管理。

并发模型刻意保持简单：``threading.BoundedSemaphore`` 控制同时在跑的 run，
超过上限直接 429（带 Retry-After），不做排队——排队会让客户端超时掩盖背压。
"""

from __future__ import annotations

import threading
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST
from pydantic import BaseModel, Field

from .config import Settings
from .nodes import Runtime
from .protocol import TaskSpec
from .runtime import build_runtime, make_coverage_runner, run_once
from .tune import tune


class RunRequest(BaseModel):
    goal: str = Field(min_length=1, max_length=4000)
    cwd: str = "."
    constraints: list[str] = Field(default_factory=list)
    mode: str = "react"
    coverage_target: float | None = None
    tools_allowed: list[str] = Field(default_factory=list)
    run_id: str | None = None


class TuneRequest(BaseModel):
    since_hours: int = 24


def create_app(settings: Settings | None = None, runtime: Runtime | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    runtime = runtime or build_runtime(settings)
    app = FastAPI(title="agent-pipeline", version="0.1.0")
    runs: dict[str, dict[str, Any]] = {}
    lock = threading.Lock()
    semaphore = threading.BoundedSemaphore(settings.max_concurrent_runs)
    app.state.runtime = runtime
    app.state.runs = runs

    def _execute(run_id: str, task: TaskSpec) -> None:
        try:
            result, row = run_once(runtime, task, run_id=run_id)
            with lock:
                runs[run_id] = {
                    "run_id": run_id,
                    "status": result.status,
                    "result": result.to_dict(),
                    "log": row,
                    "finished_at": time.time(),
                }
        except Exception as exc:  # noqa: BLE001 - 后台线程绝不能把异常抛出去
            with lock:
                runs[run_id] = {
                    "run_id": run_id,
                    "status": "error",
                    "error": f"{type(exc).__name__}: {exc}",
                    "finished_at": time.time(),
                }
        finally:
            semaphore.release()

    @app.get("/health")
    def health() -> dict[str, Any]:
        active = runtime.config_store.active() if runtime.config_store else None
        return {
            "ok": True,
            "config_version": active.id if active else 0,
            "memory": runtime.memory.count(),
            "tools": runtime.tools.registry.names(),
            "running": sum(1 for item in runs.values() if item.get("status") == "running"),
        }

    @app.get("/metrics")
    def metrics() -> Response:
        return Response(content=runtime.metrics.expose(), media_type=CONTENT_TYPE_LATEST)

    @app.post("/v1/runs", status_code=202)
    def create_run(body: RunRequest) -> JSONResponse:
        if body.mode not in ("react", "adversarial"):
            raise HTTPException(status_code=422, detail="mode 只能是 react 或 adversarial")
        run_id = body.run_id or uuid.uuid4().hex
        with lock:
            existing = runs.get(run_id)
            if existing is not None:
                # 幂等提交：同一个 run_id 重复 POST 返回同一份状态。
                return JSONResponse(status_code=202, content={"run_id": run_id, "status": existing["status"]})
            if not semaphore.acquire(blocking=False):
                raise HTTPException(status_code=429, detail="并发已满，请稍后重试", headers={"Retry-After": "5"})
            runs[run_id] = {"run_id": run_id, "status": "running", "started_at": time.time()}
        task = TaskSpec(
            goal=body.goal,
            cwd=body.cwd,
            constraints=body.constraints,
            mode=body.mode,  # type: ignore[arg-type]
            coverage_target=body.coverage_target,
            tools_allowed=body.tools_allowed,
        )
        thread = threading.Thread(target=_execute, args=(run_id, task), daemon=True, name=f"run-{run_id[:8]}")
        thread.start()
        return JSONResponse(status_code=202, content={"run_id": run_id, "status": "running", "poll": f"/v1/runs/{run_id}"})

    @app.get("/v1/runs/{run_id}")
    def get_run(run_id: str) -> dict[str, Any]:
        with lock:
            entry = runs.get(run_id)
        if entry is None:
            raise HTTPException(status_code=404, detail="没有这个 run")
        return dict(entry)

    @app.post("/v1/runs/{run_id}/approve")
    def approve_run(run_id: str) -> dict[str, Any]:
        with lock:
            entry = runs.get(run_id)
        if entry is None:
            raise HTTPException(status_code=404, detail="没有这个 run")
        if entry.get("status") != "awaiting_approval":
            raise HTTPException(status_code=409, detail="该 run 不在等待审批状态（interrupt 未启用或已结束）")
        # 中断式审批需要 graph.compile(interrupt_before=[...]) + checkpointer；
        # 本服务默认关闭中断，故此处只保证协议一致，不假装继续执行。
        raise HTTPException(status_code=501, detail="当前部署未启用中断式审批")

    @app.get("/v1/config")
    def get_config() -> dict[str, Any]:
        store = runtime.config_store
        if store is None:
            return {"active": None, "canary": None, "history": []}
        active = store.active()
        canary = store.canary()
        return {
            "active": {"id": active.id, "payload": active.payload} if active else None,
            "canary": {"id": canary.id, "payload": canary.payload} if canary else None,
            "history": [{"id": v.id, "stage": v.stage, "created_at": v.id} for v in store.history(10)],
        }

    @app.post("/v1/config/rollback")
    def rollback() -> dict[str, Any]:
        store = runtime.config_store
        if store is None:
            raise HTTPException(status_code=409, detail="没有配置存储")
        active = store.rollback("manual")
        runtime.metrics.record_rollback("manual")
        return {"ok": True, "active": active.id if active else None}

    @app.post("/v1/config/promote")
    def promote() -> dict[str, Any]:
        store = runtime.config_store
        if store is None:
            raise HTTPException(status_code=409, detail="没有配置存储")
        active = store.promote_canary()
        return {"ok": True, "active": active.id if active else None}

    @app.post("/v1/tune")
    def run_tune(body: TuneRequest) -> dict[str, Any]:
        report = tune(log_path=runtime.settings.log_path, since_hours=body.since_hours, out_path=None)
        return report.to_dict()

    @app.get("/v1/tools")
    def list_tools() -> dict[str, Any]:
        return {"tools": runtime.tools.registry.describe()}

    return app


def main() -> None:  # pragma: no cover - 入口由 uvicorn 调起
    import uvicorn

    settings = Settings.from_env()
    app = create_app(settings)
    uvicorn.run(app, host="0.0.0.0", port=8000)