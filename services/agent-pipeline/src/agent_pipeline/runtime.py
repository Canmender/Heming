"""把配置、模型、工具、记忆、指标装成一个 ``Runtime``，并负责跑一次 run 的收尾。

``run_once`` 是唯一「有副作用」的入口：指标、日志、结果窗口、自动回滚都在这里收口，
HTTP 层与 CLI 都只调它，避免两套逻辑漂移。
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from .config import PROMPTS, Settings
from .graph import run_pipeline
from .llm import LLMClient, build_llm
from .memory import MemoryStore
from .metrics import Metrics
from .nodes import Runtime
from .protocol import Citation, Observation, PlanStep, RunResult, TaskSpec
from .rollback import ConfigStore
from .tools import ToolRuntime, build_default_registry, run_shell

_COVERAGE_PATTERNS = (
    # (?<!-) 是必须的：`TOTAL -5%` 这种输出里 "-5" 会被读成 5%，等于把负数当覆盖率。
    re.compile(r"(?i)\btotal\b[^\n%]*?(?<!-)(\d{1,3}(?:\.\d+)?)\s*%"),
    re.compile(r"(?i)coverage[^\n%]*?(?<!-)(\d{1,3}(?:\.\d+)?)\s*%"),
    re.compile(r"(?i)all files[^\n%]*?(?<!-)(\d{1,3}(?:\.\d+)?)\s*%"),
)


def parse_coverage(output: str) -> float | None:
    """从测试命令输出里解析覆盖率（0-1）；解析不到就返回 None，绝不猜。"""
    for pattern in _COVERAGE_PATTERNS:
        match = pattern.search(output or "")
        if match:
            try:
                value = float(match.group(1)) / 100.0
            except ValueError:
                continue
            if 0.0 <= value <= 1.0:
                return round(value, 4)
    return None


def make_coverage_runner(command: str, *, cwd: str | None = None, timeout_s: float = 180.0) -> Callable[[], dict[str, Any]]:
    """真实跑测试命令，把覆盖率从输出里解析出来。"""

    def runner() -> dict[str, Any]:
        result = run_shell(command, cwd=cwd, timeout_s=timeout_s)
        output = f"{result.get('stdout', '')}\n{result.get('stderr', '')}"
        coverage = parse_coverage(output)
        return {
            "coverage": coverage,
            "output": output,
            "ok": bool(result.get("code") == 0 and coverage is not None),
            "duration_ms": result.get("duration_ms", 0),
        }

    return runner


def build_runtime(
    settings: Settings,
    *,
    llm: LLMClient | None = None,
    memory: MemoryStore | None = None,
    metrics: Metrics | None = None,
    config_store: ConfigStore | None = None,
    coverage_runner: Callable[[], dict[str, Any]] | None = None,
    prompts: dict[str, str] | None = None,
    log_sink: Callable[[dict[str, Any]], None] | None = None,
) -> Runtime:
    metrics = metrics or Metrics()
    memory = memory or MemoryStore(
        settings.db_path,
        max_episodes=settings.max_episodes,
        max_documents=settings.max_documents,
        max_episode_age_days=settings.max_episode_age_days,
    )
    config_store = config_store or ConfigStore(settings.db_path, outcome_limit=settings.outcome_limit)
    registry = build_default_registry(
        allow_commands=os.environ.get("AGENT_PIPELINE_ALLOW_COMMANDS") == "1",
        memory=memory,
        allow_private_hosts=settings.allow_private_hosts,
    )
    tools = ToolRuntime(
        registry,
        circuit_threshold=settings.circuit_threshold,
        circuit_cooldown_s=settings.circuit_cooldown_s,
        idempotency_ttl_s=settings.idempotency_ttl_s,
        idempotency_max_entries=settings.idempotency_max_entries,
        default_timeout_s=settings.tool_timeout_s,
        metrics_hook=metrics.record_tool,
    )
    return Runtime(
        settings=settings,
        llm=llm or build_llm(settings),
        tools=tools,
        memory=memory,
        metrics=metrics,
        prompts={**PROMPTS, **(prompts or {})},
        config_store=config_store,
        coverage_runner=coverage_runner,
        log_sink=log_sink,
    )


def _normalize(run_id: str, state: dict[str, Any], configuration_version: int, error: str | None = None) -> RunResult:
    observations: list[Observation] = []
    for item in state.get("observations", []):
        if isinstance(item, dict):
            data = dict(item)
            data["citations"] = [Citation(**c) for c in data.get("citations") or []]
            observations.append(Observation(**data))
    plan = [PlanStep(**s) for s in state.get("plan", []) if isinstance(s, dict)]
    result = RunResult(
        run_id=run_id,
        status="error" if error else state.get("status", "ok"),
        answer=state.get("answer", ""),
        plan=plan,
        observations=observations,
        citations=[Citation(**c) for c in state.get("citations", []) if isinstance(c, dict)],
        coverage=state.get("coverage"),
        llm_calls=int(state.get("llm_calls", 0)),
        tokens=int(state.get("tokens", 0)),
        config_version=configuration_version,
        error=error,
        stop_reason=state.get("stop_reason"),
        dropped_context=list(state.get("dropped_context", [])),
    )
    for item in state.get("reflections", []):
        from .protocol import Reflection

        if isinstance(item, dict):
            result.reflections.append(Reflection(**item))
    for item in state.get("critiques", []):
        from .protocol import Critique

        if isinstance(item, dict):
            result.critiques.append(Critique(**item))
    return result


def resolve_config(runtime: Runtime, run_id: str) -> tuple[int, dict[str, Any]]:
    """选本次 run 的配置版本（canary 分流），返回 (版本号, 提示词表)。"""
    store = runtime.config_store
    if store is None:
        return 0, dict(runtime.prompts)
    version = store.select_for_run(run_id, runtime.settings.canary_ratio)
    if version is None:
        return 0, dict(runtime.prompts)
    prompts = dict(runtime.prompts)
    prompts.update({k: v for k, v in (version.payload.get("prompts") or {}).items() if isinstance(v, str)})
    return version.id, prompts


def run_once(
    runtime: Runtime,
    task: TaskSpec,
    *,
    run_id: str | None = None,
    config_version: int | None = None,
    prompts: dict[str, str] | None = None,
) -> tuple[RunResult, dict[str, Any]]:
    """跑一次流水线并收尾（指标 / 日志 / 结果窗口 / 自动回滚）。"""
    run_id = run_id or uuid.uuid4().hex
    if config_version is None:
        config_version, selected_prompts = resolve_config(runtime, run_id)
        runtime.prompts, old_prompts = {**runtime.prompts, **selected_prompts}, runtime.prompts
    else:
        old_prompts = runtime.prompts
    if prompts:
        runtime.prompts = {**runtime.prompts, **prompts}
    started = time.time()
    error: str | None = None
    state: dict[str, Any] = {}
    try:
        state = run_pipeline(runtime, task, run_id=run_id, config_version=config_version)
    except Exception as exc:  # noqa: BLE001 - 任何未预期异常都要落成 RunResult(error)
        error = f"{type(exc).__name__}: {exc}"
    finally:
        runtime.prompts = old_prompts
    duration_s = time.time() - started
    result = _normalize(run_id, state, config_version, error)
    runtime.metrics.record_run(result.status, duration_s)
    if result.status == "ok":
        runtime.metrics.set_config_version(config_version)

    if runtime.config_store is not None and config_version:
        runtime.config_store.record_outcome(config_version, ok=result.status == "ok", latency_s=duration_s)
        rolled_back = runtime.config_store.maybe_rollback(
            error_threshold=runtime.settings.error_threshold,
            latency_threshold_s=runtime.settings.latency_threshold_s,
            min_samples=runtime.settings.min_samples_for_rollback,
        )
        if rolled_back:
            runtime.metrics.record_rollback(rolled_back)

    row = {
        "run_id": run_id,
        "task": task.to_dict(),
        "status": result.status,
        "error": result.error,
        "stop_reason": state.get("stop_reason"),
        "duration_s": round(duration_s, 3),
        "llm_calls": result.llm_calls,
        "tokens": result.tokens,
        "coverage": result.coverage,
        "config_version": config_version,
        # 这三个是「过程是否健康」的一等指标，调优和回滚窗口都要读。
        "replans": int(state.get("replans", 0)),
        "steps_executed": int(state.get("steps_executed", 0)),
        "adversarial_round": int(state.get("adversarial_round", 0)),
        "adversarial_passed": bool(state.get("adversarial_passed", False)),
        "plan": [s.to_dict() for s in result.plan],
        "observations": [o.to_dict() for o in result.observations],
        "reflections": [r.to_dict() for r in result.reflections],
        "critiques": [c.to_dict() for c in result.critiques],
        "answer": result.answer[:2000],
        "citations": [c.to_dict() for c in result.citations],
        "dropped_context": result.dropped_context,
        "tool_stats": runtime.tools.stats(),
        "started_at": started,
        "finished_at": time.time(),
    }
    _write_log(runtime, row)
    return result, row


_log_lock = threading.Lock()


def _write_log(runtime: Runtime, row: dict[str, Any]) -> None:
    if runtime.log_sink is not None:
        runtime.log_sink(row)
        return
    path = Path(runtime.settings.log_path)
    limit = int(getattr(runtime.settings, "log_max_bytes", 0) or 0)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with _log_lock:
            # 10 万次调用 = 10 万行；不轮转的话单文件会涨到几百 MB，
            # 调优读日志、运维 tail 都会变慢。超过上限就整份改成 .1（保留一代）。
            if limit > 0 and path.exists() and path.stat().st_size >= limit:
                backup = path.with_suffix(path.suffix + ".1")
                try:
                    backup.unlink(missing_ok=True)
                    path.rename(backup)
                except OSError:
                    pass
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    except OSError as exc:
        # 日志写失败不能影响 run 结果，但必须留痕：`tune` 读的是这份文件，
        # 静默失败会让人拿着空日志出「0 个失败样本」的报告。
        runtime.log_failures += 1
        runtime.log_last_error = f"{type(exc).__name__}: {exc}"
        # 计数进指标，才能被 Prometheus 告警；只有 /health 的话，没人会去盯它。
        try:
            runtime.metrics.record_log_failure()
        except Exception:  # noqa: BLE001 - 埋点失败绝不能影响 run
            pass
        if runtime.log_failures == 1:
            print(f"[agent-pipeline] 警告：run 日志写不进去（{runtime.log_last_error}），调优会读不到数据", file=sys.stderr)