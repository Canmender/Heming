"""LangGraph 状态机编排：Plan → Execute → Reflect → Critic → (Adversarial) → Summarize。

设计要点：
- **路由函数只读 state**，不做副作用：这样断点重放、单测都容易；
- 每个节点返回的是「新的完整 state」，不用靠 reducer 猜合并语义；
- 循环上限（max_steps / max_replans / max_adversarial_rounds）都在路由里兜底，
  保证任何模型输出都不会让图转不停。
"""

from __future__ import annotations

import time
from typing import Any, Callable, TypedDict

from langgraph.errors import GraphRecursionError
from langgraph.graph import END, START, StateGraph

from .nodes import NODE_IMPLS, Runtime
from .protocol import TaskSpec


class PipelineState(TypedDict, total=False):
    run_id: str
    task: dict[str, Any]
    plan: list[dict[str, Any]]
    step_index: int
    step_tool_calls: int
    observations: list[dict[str, Any]]
    reflections: list[dict[str, Any]]
    critiques: list[dict[str, Any]]
    adversarial_round: int
    adversarial_passed: bool
    replans: int
    steps_executed: int
    llm_calls: int
    tokens: int
    status: str
    answer: str
    citations: list[dict[str, Any]]
    coverage: float | None
    stop_reason: str | None
    config_version: int
    started_at: float
    last_had_tool_calls: bool
    blocking_issues: list[str]
    last_test_output: str
    coverage_failures: int
    dropped_context: list[str]


def _critic_passed(state: dict[str, Any], runtime: Runtime) -> bool:
    critiques = state.get("critiques") or []
    if not critiques:
        return False
    last = critiques[-1]
    blocking = bool(last.get("blocking_issues"))
    return float(last.get("score", 0.0)) >= runtime.settings.critic_threshold and not blocking


def _coverage_ok(state: dict[str, Any], runtime: Runtime) -> bool:
    coverage = state.get("coverage")
    if not isinstance(coverage, (int, float)):
        return False
    task = TaskSpec(**state["task"])
    target = runtime.settings.coverage_target if task.coverage_target is None else task.coverage_target
    return float(coverage) >= target


def route_after_execute(state: dict[str, Any], runtime: Runtime) -> str:
    if state.get("status") in ("aborted", "budget") or state.get("stop_reason"):
        return "summarize"
    if int(state.get("steps_executed", 0)) >= runtime.settings.budget.max_steps:
        state["stop_reason"] = "max_steps"
        return "summarize"
    if state.get("last_had_tool_calls") and int(state.get("step_tool_calls", 0)) < runtime.settings.budget.step_tool_budget:
        return "execute"
    return "reflect"


def route_after_reflect(state: dict[str, Any], runtime: Runtime) -> str:
    if state.get("status") in ("aborted", "budget") or state.get("stop_reason"):
        return "summarize"
    if not state.get("plan"):
        if int(state.get("replans", 0)) > runtime.settings.budget.max_replans:
            state["stop_reason"] = "max_replans"
            return "summarize"
        return "plan"
    if int(state.get("step_index", 0)) >= len(state.get("plan") or []):
        return "critic"
    return "execute"


def route_after_critic(state: dict[str, Any], runtime: Runtime) -> str:
    if state.get("status") in ("aborted", "budget") or state.get("stop_reason"):
        return "summarize"
    task = TaskSpec(**state["task"])
    passed = _critic_passed(state, runtime)
    wants_adversarial = task.mode == "adversarial" and not _coverage_ok(state, runtime)
    if passed and not wants_adversarial:
        return "summarize"
    if wants_adversarial:
        # 轮次用完时 adversarial_node 会自己写 stop_reason，再走一次也能立刻收口。
        return "adversarial"
    # critic_node 已经决定「重置计划重做」还是「收口」，这里只负责走向。
    if state.get("stop_reason"):
        return "summarize"
    return "plan"


def route_after_adversarial(state: dict[str, Any], runtime: Runtime) -> str:
    if state.get("status") in ("aborted", "budget") or state.get("stop_reason"):
        return "summarize"
    if state.get("adversarial_passed"):
        return "critic"
    if int(state.get("adversarial_round", 0)) >= runtime.settings.budget.max_adversarial_rounds:
        state["stop_reason"] = "coverage_gap"
        return "summarize"
    return "adversarial"


ROUTES: dict[str, Callable[[dict[str, Any], Runtime], str]] = {
    "route_after_execute": route_after_execute,
    "route_after_reflect": route_after_reflect,
    "route_after_critic": route_after_critic,
    "route_after_adversarial": route_after_adversarial,
}


def _wrap(name: str, runtime: Runtime) -> Callable[[PipelineState], PipelineState]:
    impl = NODE_IMPLS[name]

    def node(state: PipelineState) -> PipelineState:
        run_id = str(state.get("run_id") or "")
        # summarize 是收尾节点：取消也要让它跑完，否则用户拿不到「已取消」的答复。
        if name != "summarize" and runtime.cancel is not None and run_id and runtime.cancel(run_id):
            # 节点边界检查取消：不用等当前这次模型调用超时，也不会把半截结果当完工。
            return {**state, "stop_reason": "cancelled", "status": "aborted"}  # type: ignore[return-value]
        started = time.monotonic()
        result = impl(runtime, dict(state))  # type: ignore[arg-type]
        runtime.metrics.record_node(name, time.monotonic() - started)
        try:
            from .protocol import TaskSpec as _TaskSpec  # 局部引用，避免循环

            _TaskSpec(**result.get("task", {}))
        except Exception:  # noqa: BLE001 - 节点产出问题留给上层错误处理
            pass
        return result  # type: ignore[return-value]

    node.__name__ = f"{name}_node"
    return node


def build_graph(runtime: Runtime, *, checkpointer: Any = None) -> Any:
    """构建并编译状态机；``checkpointer`` 传入时启用断点/重放。"""
    graph = StateGraph(PipelineState)
    for name in ("plan", "execute", "reflect", "critic", "adversarial", "summarize"):
        graph.add_node(name, _wrap(name, runtime))

    graph.add_edge(START, "plan")
    graph.add_edge("plan", "execute")
    graph.add_conditional_edges(
        "execute",
        lambda state: route_after_execute(state, runtime),
        {"execute": "execute", "reflect": "reflect", "summarize": "summarize"},
    )
    graph.add_conditional_edges(
        "reflect",
        lambda state: route_after_reflect(state, runtime),
        {"plan": "plan", "execute": "execute", "critic": "critic", "summarize": "summarize"},
    )
    graph.add_conditional_edges(
        "critic",
        lambda state: route_after_critic(state, runtime),
        {"plan": "plan", "adversarial": "adversarial", "summarize": "summarize"},
    )
    graph.add_conditional_edges(
        "adversarial",
        lambda state: route_after_adversarial(state, runtime),
        {"adversarial": "adversarial", "critic": "critic", "summarize": "summarize"},
    )
    graph.add_edge("summarize", END)
    compile_kwargs: dict[str, Any] = {}
    if checkpointer is not None:
        compile_kwargs["checkpointer"] = checkpointer
    return graph.compile(**compile_kwargs)


def recursion_limit_for(runtime: Runtime) -> int:
    """图执行上限：按预算算，不能用 LangGraph 的默认 25。

    每一步都可能「execute 带工具调用 → 回到 execute 继续（最多 step_tool_budget 轮）
    → reflect」。8 步 × 3 轮就已经超过 25：默认值会让一个正常的长任务在中途抛
    GraphRecursionError，错误信息是「递归上限」，看起来像图写错了，实际是预算上限。
    """
    budget = runtime.settings.budget
    per_step = max(1, int(budget.step_tool_budget)) + 2  # execute（含工具轮）+ reflect
    limit = 3 + max(1, int(budget.max_steps)) * per_step
    limit += 2 * max(1, int(budget.max_adversarial_rounds)) + 4  # 对抗环 + critic/汇总
    return max(limit, 30)


def run_pipeline(runtime: Runtime, task: TaskSpec, *, run_id: str, config_version: int = 0, checkpointer: Any = None) -> dict[str, Any]:
    """跑一次完整流水线，返回最终 state（含 answer/status/observations）。"""
    from .nodes import new_state

    graph = build_graph(runtime, checkpointer=checkpointer)
    initial = new_state(run_id, task, config_version=config_version)
    config: dict[str, Any] = {
        "configurable": {"thread_id": run_id},
        "recursion_limit": recursion_limit_for(runtime),
    }
    try:
        return dict(graph.invoke(initial, config=config))
    except GraphRecursionError:
        # 预算算出来仍撞上限（比如工具轮把图推进得太远）：收口成「预算用尽」，
        # 不要把「递归上限」这种实现细节当运行错误抛给调用方。
        fallback = dict(initial)
        fallback.update(
            status="budget",
            stop_reason="recursion_limit",
            answer="（图执行步数到达上限，已停止；这是实现层的兜底，请调小 budget.max_steps 或 step_tool_budget。）",
        )
        return fallback