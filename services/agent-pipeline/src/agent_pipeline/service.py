"""HTTP 服务：一进（POST /v1/runs）一出（GET /v1/runs/{id}）+ Prometheus + 配置管理。

并发模型刻意保持简单：``threading.BoundedSemaphore`` 控制同时在跑的 run，
超过上限直接 429（带 Retry-After），不做排队——排队会让客户端超时掩盖背压。
"""

from __future__ import annotations

import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST
from pydantic import BaseModel, Field

from .approval import ApprovalGate
from .config import Settings
from .nodes import Runtime
from .protocol import TaskSpec
from .runtime import build_runtime, make_coverage_runner, run_once
from .scheduler import DailyTuner, build_replay_evaluator


class KnowledgeDoc(BaseModel):
    """往知识库里写一份文档（RAG 的入口）。同一个 ``doc_id`` 再写会整体替换。"""

    doc_id: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=200_000)
    title: str = Field(default="", max_length=300)


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


class ApproveRequest(BaseModel):
    """一次工具审批的裁决。``call_id`` 省略时，只有唯一一条待审批才允许省略。"""

    call_id: str | None = None
    approved: bool = True


def create_app(settings: Settings | None = None, runtime: Runtime | None = None) -> FastAPI:
    if runtime is not None:
        # 注入 runtime 时（测试、嵌入别处）必须沿用它自己的 Settings，
        # 否则服务用的并发/日志路径/调优开关会和 runtime 里那套不一致。
        settings = settings or runtime.settings
    else:
        settings = settings or Settings.from_env()
        runtime = build_runtime(settings)
    # 工具审批闸：只有显式打开 AGENT_APPROVAL_MODE=write 才拦非只读工具。
    gate = ApprovalGate(settings.approval_timeout_s) if settings.approval_mode != "off" else None
    runtime.approval = gate
    # 没有评测器时 tune 只会出报告、永不注册灰度；打开 AGENT_TUNE_EVAL=1 才用
    # 「回放 A/B」真评一次（2 × tune_eval_budget 次流水线，成本可控但非零）。
    evaluator = None
    if settings.tune_eval_enabled:
        evaluator = build_replay_evaluator(
            runtime,
            log_path=settings.log_path,
            window_hours=settings.tune_window_hours,
        )
    tuner = DailyTuner(
        settings=settings,
        config_store=runtime.config_store,
        log_path=settings.log_path,
        out_path=settings.tune_out_path or None,
        evaluator=evaluator,
        metrics=runtime.metrics,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # 只有显式开启才起后台线程：默认关闭，免得容器一跑起来就在没人看的情况下改配置。
        if settings.tune_enabled:
            tuner.start()
        yield
        tuner.stop()

    app = FastAPI(title="agent-pipeline", version="0.1.0", lifespan=lifespan)
    runs: dict[str, dict[str, Any]] = {}
    lock = threading.Lock()
    semaphore = threading.BoundedSemaphore(settings.max_concurrent_runs)
    app.state.runtime = runtime
    app.state.runs = runs
    app.state.tuner = tuner

    def _evict_locked() -> None:
        """只留最近 ``run_history_limit`` 个已结束的 run。

        没有这一步，长跑的服务每来一个请求就把完整结果（含整份日志行）留在内存里，
        10 万次调用之后进程会一直涨——这是「跑久了就飘」的典型来源。
        正在跑的 run 一律不动（客户端还要轮询它）。
        """
        limit = max(1, int(settings.run_history_limit or 1))
        overflow = len(runs) - limit
        if overflow <= 0:
            return
        for key in list(runs):
            if overflow <= 0:
                break
            if runs.get(key, {}).get("status") == "running":
                continue
            del runs[key]
            overflow -= 1

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
                _evict_locked()
        except Exception as exc:  # noqa: BLE001 - 后台线程绝不能把异常抛出去
            with lock:
                runs[run_id] = {
                    "run_id": run_id,
                    "status": "error",
                    "error": f"{type(exc).__name__}: {exc}",
                    "finished_at": time.time(),
                }
                _evict_locked()
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
            "approval_mode": settings.approval_mode,
            "pending_approvals": len(gate.pending()) if gate is not None else 0,
            "running": sum(1 for item in runs.values() if item.get("status") == "running"),
            "runs_retained": len(runs),
            "tuner": {
                "enabled": settings.tune_enabled,
                "running": tuner.running,
                "last_error": tuner.last.error if tuner.last else None,
                "last_ran_at": tuner.last.ran_at if tuner.last else None,
            },
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
        payload = dict(entry)
        # 轮询方靠这个字段知道「现在轮到我裁决了」，不用另开长连接。
        payload["pending_approvals"] = gate.pending(run_id) if gate is not None else []
        return payload

    @app.post("/v1/runs/{run_id}/approve")
    def approve_run(run_id: str, body: ApproveRequest) -> dict[str, Any]:
        with lock:
            entry = runs.get(run_id)
        if entry is None:
            raise HTTPException(status_code=404, detail="没有这个 run")
        if gate is None:
            raise HTTPException(status_code=409, detail="审批未启用（AGENT_APPROVAL_MODE=off）")
        waiting = gate.pending(run_id)
        if not waiting:
            raise HTTPException(status_code=409, detail="该 run 当前没有待审批的工具调用")
        call_id = body.call_id or (waiting[0]["call_id"] if len(waiting) == 1 else None)
        if call_id is None:
            raise HTTPException(status_code=400, detail="有多条待审批，必须显式给 call_id")
        if not gate.resolve(run_id, call_id, body.approved):
            raise HTTPException(status_code=409, detail=f"没有待审批的 call_id：{call_id}")
        return {"run_id": run_id, "call_id": call_id, "approved": body.approved}

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
        result = tuner.run_once(since_hours=body.since_hours)
        if result.report is None:
            raise HTTPException(status_code=500, detail=f"调优失败：{result.error}")
        return result.report.to_dict()

    @app.get("/v1/tools")
    def list_tools() -> dict[str, Any]:
        return {"tools": runtime.tools.registry.describe()}

    # ---- 知识库（RAG 的写入口；检索由 knowledge_search 工具在 run 里做）---------

    @app.post("/v1/knowledge")
    def add_knowledge(body: KnowledgeDoc) -> dict[str, Any]:
        chunks = runtime.memory.add_document(body.doc_id, body.text, title=body.title)
        return {"doc_id": body.doc_id, "chunks": len(chunks), "stats": runtime.memory.count()}

    @app.get("/v1/knowledge")
    def knowledge_stats() -> dict[str, Any]:
        return runtime.memory.count()

    @app.delete("/v1/knowledge/{doc_id}")
    def delete_knowledge(doc_id: str) -> dict[str, Any]:
        removed = runtime.memory.remove_document(doc_id)
        if not removed:
            raise HTTPException(status_code=404, detail=f"知识库里没有这份文档：{doc_id}")
        return {"doc_id": doc_id, "removed": removed, "stats": runtime.memory.count()}

    return app


def main() -> None:  # pragma: no cover - 入口由 uvicorn 调起
    import uvicorn

    settings = Settings.from_env()
    app = create_app(settings)
    uvicorn.run(app, host="0.0.0.0", port=8000)