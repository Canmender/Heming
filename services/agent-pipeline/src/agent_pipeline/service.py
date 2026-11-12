"""HTTP 服务：一进（POST /v1/runs）一出（GET /v1/runs/{id}）+ Prometheus + 配置管理。

并发模型刻意保持简单：``threading.BoundedSemaphore`` 控制同时在跑的 run，
超过上限直接 429（带 Retry-After），不做排队——排队会让客户端超时掩盖背压。
"""

from __future__ import annotations

import hmac
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

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
    # cwd 会进日志和工具调用；不封顶的话一个超长字符串就能把日志行撑大。
    cwd: str = Field(default=".", max_length=1000)
    # 约束条数与单条长度都要有上限：它会被拼进提示词，条数不封顶等于让调用方决定 token 花多少。
    constraints: list[Annotated[str, Field(max_length=2000)]] = Field(default_factory=list, max_length=20)
    mode: str = "react"
    # 覆盖率是 0-1 的比值；不夹住的话 `coverage_target=5` 会让对抗环永远不达标。
    coverage_target: float | None = Field(default=None, ge=0.0, le=1.0)
    tools_allowed: list[Annotated[str, Field(max_length=200)]] = Field(default_factory=list, max_length=64)
    # run_id 由调用方给（幂等重试用），但它是字典键、日志字段、线程名的一部分。
    run_id: str | None = Field(default=None, min_length=1, max_length=200)


class TuneRequest(BaseModel):
    # 负数/0 会算出「未来」的窗口 → 读到 0 行、报告 0 个失败样本，看起来像「系统很健康」；
    # 上限 30 天是为了不让一次调用扫完全部历史日志（读放大）。
    since_hours: int = Field(default=24, ge=1, le=720)


class ApproveRequest(BaseModel):
    """一次工具审批的裁决。``call_id`` 省略时，只有唯一一条待审批才允许省略。"""

    call_id: str | None = None
    approved: bool = True


class RollbackRequest(BaseModel):
    """人工回滚：给 ``version_id`` 就切到那个历史版本；不给就只归档当前灰度。"""

    version_id: int | None = None


def _tuner_summary(report: Any) -> dict[str, Any] | None:
    """`/health` 里只放摘要：调优报告可能很长，运维要看的是「这几天有没有在跑、有没有落地」。"""
    if report is None:
        return None
    return {
        "window_hours": report.window_hours,
        "total_runs": report.total_runs,
        "failed_runs": report.failed_runs,
        "failure_modes": report.failure_modes,
        "candidates": len(report.candidates),
        "applied_version": report.applied_version,
    }


def _install_auth(app: FastAPI, settings: Settings) -> None:
    """入站鉴权：设了 `AGENT_SERVICE_TOKEN` 就校验 `Authorization: Bearer <token>`。

    `/health`（存活探针）与 `/metrics`（Prometheus 抓取，只有计数没有对话内容）
    放行；`/v1/**` 一律要令牌。空 token 视为本机调试形态，不校验——但要让它
    可见：`/health` 会报 `auth: "off"`。
    """
    token = settings.service_token.strip()
    if not token:
        return
    exempt = {"/health", "/metrics"}

    @app.middleware("http")
    async def _guard(request, call_next):  # noqa: ANN001 - Starlette 中间件签名
        if request.url.path in exempt:
            return await call_next(request)
        header = request.headers.get("authorization", "")
        presented = header[7:].strip() if header.lower().startswith("bearer ") else ""
        if not hmac.compare_digest(presented, token):
            return JSONResponse(
                {
                    "detail": (
                        "缺少或错误的 Authorization。这个服务要求 "
                        "`Authorization: Bearer <AGENT_SERVICE_TOKEN>`（与上游模型的 "
                        "AGENT_PIPELINE_API_KEY 不是同一个东西）。"
                    )
                },
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )
        return await call_next(request)


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

    runs: dict[str, dict[str, Any]] = {}
    # 取消标记：run_id → Event。run 结束后立刻丢弃，避免长期占用。
    cancels: dict[str, threading.Event] = {}
    # run_id → 执行线程。关停时要能把它们 join 掉，否则容器 SIGTERM 会直接从中间砍断。
    threads: dict[str, threading.Thread] = {}

    def _drain_runs() -> None:
        """关停前先让正在跑的 run 自己收口：置取消标记，再等最多 ``shutdown_grace_s``。

        不这么做，容器滚动更新时 SIGTERM 会直接杀掉进程：客户端看到的是「连不上」，
        而且这些 run 既没落 ``aborted`` 也没落 ``error``，日志里只剩半截——事后查不出发生过什么。
        节点边界看到取消标记会走正常收口（answer 里说明是取消前完成的），和用户点「取消」同一条路。
        """
        with lock:
            pending = [rid for rid, entry in runs.items() if entry.get("status") in {"running", "cancelling"}]
            events = [cancels[rid] for rid in pending if rid in cancels]
            joining = [threads[rid] for rid in pending if rid in threads]
        for event in events:
            event.set()
        if not joining:
            return
        deadline = time.monotonic() + max(0.0, settings.shutdown_grace_s)
        for thread in joining:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            thread.join(timeout=remaining)
        with lock:
            still_running = [rid for rid in pending if runs.get(rid, {}).get("status") in {"running", "cancelling"}]
        if still_running:
            # 宽限期用完还没收口的，至少把状态落成 error 并留一句话，别让客户端永远等到超时。
            with lock:
                for rid in still_running:
                    entry = runs.get(rid) or {"run_id": rid}
                    entry.update(
                        status="error",
                        error="服务关停：宽限期内没跑完，已中止",
                        finished_at=time.time(),
                    )
                    runs[rid] = entry

    def _close_runtime() -> None:
        """释放进程外资源：工具线程池、SQLite 连接。

        少了这一步，uvicorn 退出时线程池里还有活线程会让进程退得慢，
        SQLite 的 WAL 也可能留到下次启动才合并。
        """
        closer = getattr(runtime.tools, "close", None)
        if callable(closer):
            closer()
        for target in (runtime.memory, runtime.config_store):
            close = getattr(target, "close", None)
            if callable(close):
                close()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # 只有显式开启才起后台线程：默认关闭，免得容器一跑起来就在没人看的情况下改配置。
        if settings.tune_enabled:
            tuner.start()
        try:
            yield
        finally:
            tuner.stop()
            _drain_runs()
            _close_runtime()

    app = FastAPI(title="agent-pipeline", version="0.1.0", lifespan=lifespan)

    # 鉴权中间件要在路由注册之前挂上（中间件对之后注册的路由同样生效，但顺序更清楚）。
    _install_auth(app, settings)
    runtime.cancel = lambda run_id: cancels.get(run_id) is not None and cancels[run_id].is_set()
    lock = threading.Lock()
    semaphore = threading.BoundedSemaphore(settings.max_concurrent_runs)
    app.state.runtime = runtime
    app.state.runs = runs
    app.state.cancels = cancels
    app.state.threads = threads
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
            with lock:
                cancels.pop(run_id, None)
                threads.pop(run_id, None)
            if gate is not None:
                # run 已经结束（正常/异常都算）：残留的待审批没人会来点了，
                # 不收口的话这些 entry 会一直挂在 gate 里，pending 计数只增不减。
                gate.cancel_run(run_id)
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
            # 入站鉴权是否开启：空 token 时不校验，但必须让人一眼看见，而不是以为已经保护了。
            "auth": "on" if settings.service_token.strip() else "off",
            "pending_approvals": len(gate.pending()) if gate is not None else 0,
            "running": sum(1 for item in runs.values() if item.get("status") == "running"),
            "runs_retained": len(runs),
            # 日志写不进去时 tune/回滚窗口都会静默拿到空数据，这里给出可见信号。
            "log_failures": getattr(runtime, "log_failures", 0),
            "log_last_error": getattr(runtime, "log_last_error", None),
            "tuner": {
                "enabled": settings.tune_enabled,
                "running": tuner.running,
                "last_error": tuner.last.error if tuner.last else None,
                "last_ran_at": tuner.last.ran_at if tuner.last else None,
                "last_report": _tuner_summary(tuner.last.report) if tuner.last else None,
                # 定时调优默认一天一次；没有这个字段，运维只能靠翻日志猜「下次什么时候跑」。
                "next_run_at": (
                    tuner.last.ran_at + settings.tune_interval_s
                    if tuner.running and tuner.last
                    else None
                ),
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
            cancels[run_id] = threading.Event()
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
        with lock:
            threads[run_id] = thread
        thread.start()
        return JSONResponse(status_code=202, content={"run_id": run_id, "status": "running", "poll": f"/v1/runs/{run_id}"})

    @app.post("/v1/runs/{run_id}/cancel", status_code=202)
    def cancel_run(run_id: str) -> dict[str, Any]:
        """请求停止一个 run：节点边界会看到标记并收口为 aborted（不是硬杀线程）。"""
        with lock:
            entry = runs.get(run_id)
            if entry is None:
                raise HTTPException(status_code=404, detail="没有这个 run")
            if entry.get("status") != "running":
                raise HTTPException(status_code=409, detail=f"这个 run 已经结束（{entry.get('status')}）")
            cancels.setdefault(run_id, threading.Event()).set()
            entry["status"] = "cancelling"
        if gate is not None:
            # 取消必须能把「正卡在等审批」的执行线程放出来：否则用户点了取消，
            # 还要等 approval_timeout_s（默认 300s）才动，看起来就是「取消没反应」。
            gate.cancel_run(run_id)
        return {"run_id": run_id, "status": "cancelling", "poll": f"/v1/runs/{run_id}"}

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
    def rollback(body: RollbackRequest | None = None) -> dict[str, Any]:
        store = runtime.config_store
        if store is None:
            raise HTTPException(status_code=409, detail="没有配置存储")
        if body is not None and body.version_id is not None:
            activated = store.activate(body.version_id)
            if activated is None:
                raise HTTPException(status_code=404, detail=f"没有这个配置版本：{body.version_id}")
            runtime.metrics.record_rollback("manual")
            return {"ok": True, "active": activated.id, "reason": "activate"}
        active = store.rollback("manual")
        runtime.metrics.record_rollback("manual")
        return {"ok": True, "active": active.id if active else None, "reason": "canary"}

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