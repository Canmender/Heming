"""各节点实现：纯函数 + 依赖注入（``Runtime``），不直接读环境、不直接建连接。

节点只做三件事：组装上下文 → 调一次模型 → 把结果写成协议结构。
所有副作用（工具、记忆、指标、日志）都走 ``Runtime``，测试里替换即可。
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from .config import Settings
from .llm import LLMClient, LLMResponse
from .memory import MemoryStore
from .metrics import Metrics
from .approval import ApprovalGate
from .protocol import (
    Citation,
    Critique,
    MemoryRecord,
    Observation,
    PlanStep,
    ProtocolError,
    Reflection,
    TaskSpec,
    ToolRequest,
    build_context,
    parse_json_object,
)
from .rollback import ConfigStore
from .tools import ToolError, ToolRuntime, run_shell


@dataclass
class Runtime:
    """一次 run 的全部外部依赖。"""

    settings: Settings
    llm: LLMClient
    tools: ToolRuntime
    memory: MemoryStore
    metrics: Metrics
    prompts: dict[str, str] = field(default_factory=dict)
    config_store: ConfigStore | None = None
    # 返回 {"coverage": float|None, "output": str, "ok": bool}；None 表示没接测试
    coverage_runner: Callable[[], dict[str, Any]] | None = None
    log_sink: Callable[[dict[str, Any]], None] | None = None
    clock: Callable[[], float] = time.monotonic
    # 工具审批闸：None = 不拦（默认）。开了以后 execute 在跑非只读工具前会阻塞等待裁决。
    approval: ApprovalGate | None = None

    def prompt(self, key: str) -> str:
        return self.prompts.get(key) or DEFAULT_PROMPTS.get(key, "")


# 与 config.py 的默认提示词解耦：这里只是兜底，避免 Runtime 造出来却少了某条提示词。
from .config import PROMPTS as DEFAULT_PROMPTS  # noqa: E402  (放在类后面，避免循环导入困扰)


def new_state(run_id: str, task: TaskSpec, *, config_version: int = 0) -> dict[str, Any]:
    return {
        "run_id": run_id,
        "task": task.to_dict(),
        "plan": [],
        "step_index": 0,
        "step_tool_calls": 0,
        "observations": [],
        "reflections": [],
        "critiques": [],
        "adversarial_round": 0,
        "replans": 0,
        "steps_executed": 0,
        "llm_calls": 0,
        "tokens": 0,
        "status": "running",
        "answer": "",
        "citations": [],
        "coverage": None,
        "stop_reason": None,
        "config_version": config_version,
        "started_at": time.time(),
        "last_had_tool_calls": False,
        "blocking_issues": [],
        "last_test_output": "",
        "coverage_failures": 0,
    }


# ---------------------------------------------------------------------------
# 通用：调一次模型并把 JSON 结果带回来（失败重试一次，仍失败则抛 ProtocolError）
# ---------------------------------------------------------------------------


def _call_raw(
    runtime: Runtime,
    state: dict[str, Any],
    *,
    prompt_key: str,
    user_text: str,
    tools: list[dict[str, Any]] | None = None,
) -> LLMResponse:
    """调一次模型并记账；不要求 JSON 输出（Execute 轮经常只说人话）。"""
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": runtime.prompt(prompt_key)},
        {"role": "user", "content": user_text},
    ]
    response = runtime.llm.chat(messages, tools=tools, max_tokens=2000)
    state["llm_calls"] = int(state.get("llm_calls", 0)) + 1
    state["tokens"] = int(state.get("tokens", 0)) + response.total_tokens
    runtime.metrics.record_tokens(response.prompt_tokens, response.completion_tokens)
    return response


def _call_json(
    runtime: Runtime,
    state: dict[str, Any],
    *,
    prompt_key: str,
    user_text: str,
    tools: list[dict[str, Any]] | None = None,
    retries: int = 1,
) -> tuple[dict[str, Any], LLMResponse]:
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": runtime.prompt(prompt_key)},
        {"role": "user", "content": user_text},
    ]
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        if attempt > 0:
            messages = messages[:2]
            messages.append({"role": "user", "content": "上一次输出不是合法 JSON。请只输出 JSON 对象，不要任何解释。"})
        response = runtime.llm.chat(messages, tools=tools, max_tokens=2000)
        state["llm_calls"] = int(state.get("llm_calls", 0)) + 1
        state["tokens"] = int(state.get("tokens", 0)) + response.total_tokens
        runtime.metrics.record_tokens(response.prompt_tokens, response.completion_tokens)
        try:
            return parse_json_object(response.text), response
        except ProtocolError as exc:
            last_error = exc
    raise ProtocolError(str(last_error))


def _task(state: dict[str, Any]) -> dict[str, Any]:
    return state["task"]


def _plan_of(state: dict[str, Any]) -> list[PlanStep]:
    return [PlanStep(**step) if isinstance(step, dict) else step for step in state.get("plan", [])]


def _observations_of(state: dict[str, Any]) -> list[Observation]:
    return [Observation(**o) if isinstance(o, dict) else o for o in state.get("observations", [])]


def _budget_left(state: dict[str, Any], runtime: Runtime) -> bool:
    budget = runtime.settings.budget
    if int(state.get("llm_calls", 0)) >= budget.max_llm_calls:
        state["stop_reason"] = "llm_calls"
        return False
    if int(state.get("tokens", 0)) >= budget.max_tokens:
        state["stop_reason"] = "tokens"
        return False
    elapsed = time.time() - float(state.get("started_at", time.time()))
    if elapsed >= budget.max_wall_clock_s:
        state["stop_reason"] = "wall_clock"
        return False
    return True


def _context(runtime: Runtime, state: dict[str, Any], *, extra: str = "", memories: list[MemoryRecord] | None = None) -> str:
    task = TaskSpec(**_task(state))
    pack = build_context(
        system=runtime.prompt("plan")[:0],  # 占位，真正的 system 由 _call_json 传
        task=task,
        plan=_plan_of(state),
        observations=_observations_of(state)[-6:],
        memories=memories if memories is not None else [],
        max_chars=runtime.settings.max_observation_chars * 3,
    )
    if pack.dropped:
        state["dropped_context"] = list(dict.fromkeys(list(state.get("dropped_context", [])) + pack.dropped))
    text = pack.text
    if extra:
        text = f"{text}\n\n{extra}"
    return text


def _remember(runtime: Runtime, state: dict[str, Any], kind: str, text: str, *, citations: list[Citation] | None = None, importance: float = 0.5) -> None:
    record = MemoryRecord(
        kind=kind,  # type: ignore[arg-type]
        text=text[:2000],
        run_id=state["run_id"],
        citations=list(citations or []),
        importance=importance,
    )
    runtime.memory.add_episodic(record)


# ---------------------------------------------------------------------------
# 节点
# ---------------------------------------------------------------------------


def plan_node(runtime: Runtime, state: dict[str, Any]) -> dict[str, Any]:
    if not _budget_left(state, runtime):
        return {**state, "status": "budget"}
    task = TaskSpec(**_task(state))
    recalled = runtime.memory.search(task.goal, limit=runtime.settings.max_memory_items)
    context = _context(runtime, state, extra="请只输出 JSON 计划。", memories=recalled)
    data, _ = _call_json(runtime, state, prompt_key="plan", user_text=context)
    raw_steps = data.get("steps") or []
    if not isinstance(raw_steps, list) or not raw_steps:
        raise ProtocolError("Planner 没有给出任何步骤")
    steps: list[PlanStep] = []
    for index, item in enumerate(raw_steps[: runtime.settings.budget.max_steps]):
        if not isinstance(item, dict):
            continue
        steps.append(
            PlanStep(
                id=index + 1,
                goal=str(item.get("goal") or "").strip(),
                done_when=str(item.get("done_when") or "").strip(),
                tools_hint=[str(t) for t in (item.get("tools_hint") or []) if str(t).strip()],
            )
        )
    if not steps:
        raise ProtocolError("Planner 给出的步骤都不合法")
    _remember(runtime, state, "lesson", f"计划：{task.goal} → " + "；".join(s.goal for s in steps), importance=0.4)
    return {
        **state,
        "plan": [s.to_dict() for s in steps],
        "step_index": 0,
        "step_tool_calls": 0,
    }


def execute_node(runtime: Runtime, state: dict[str, Any]) -> dict[str, Any]:
    if not _budget_left(state, runtime):
        return {**state, "status": "budget"}
    plan = _plan_of(state)
    index = int(state.get("step_index", 0))
    if index >= len(plan):
        return {**state, "steps_executed": int(state.get("steps_executed", 0)) + 1}
    step = plan[index]
    step.status = "running"
    plan[index] = step
    task = TaskSpec(**_task(state))
    allowed = task.tools_allowed or runtime.tools.registry.names()
    schemas = runtime.tools.registry.openai_tools(allowed)
    context = _context(
        runtime,
        state,
        extra=(
            f"当前步骤 {step.id}/{len(plan)}：{step.goal}\n完成条件：{step.done_when}\n"
            f"本步骤剩余工具调用预算：{max(0, runtime.settings.budget.step_tool_budget - int(state.get('step_tool_calls', 0)))}"
        ),
    )
    # Execute 轮不强制 JSON：模型可以只说话（不调工具）或只发 tool_calls。
    response = _call_raw(runtime, state, prompt_key="execute", user_text=context, tools=schemas)
    calls = response.tool_calls
    if not calls:
        # 模型认为这一步不需要工具：把它标记为完成，交给 Reflect 判断。
        step.status = "done"
        plan[index] = step
        return {
            **state,
            "plan": [s.to_dict() for s in plan],
            "step_index": index + 1,
            "step_tool_calls": 0,
            "steps_executed": int(state.get("steps_executed", 0)) + 1,
            "last_had_tool_calls": False,
        }

    remaining = runtime.settings.budget.step_tool_budget - int(state.get("step_tool_calls", 0))
    calls = calls[: max(0, remaining)]
    observations = _observations_of(state)
    new_observations: list[Observation] = []
    # 只读工具一起跑（顺序执行但互不依赖），写工具天然串行——这里统一顺序执行，行为确定。
    known = set(runtime.tools.registry.names())
    for call in calls:
        name = str(call.get("name") or "")
        arguments = call.get("arguments") if isinstance(call.get("arguments"), dict) else {}
        call_id = str(call.get("id") or f"call_{hashlib.sha1((name + str(arguments)).encode()).hexdigest()[:8]}")
        if name not in known:
            observation = Observation(call_id=call_id, tool=name, ok=False, error=f"未注册的工具：{name}")
        else:
            spec = runtime.tools.registry.get(name)
            if runtime.approval is not None and spec.risk != "read":
                # 只读工具不拦：拦了只会让用户点烦了把闸关掉，反而没了防护。
                approved, denial = runtime.approval.request(
                    str(state.get("run_id", "")),
                    call_id,
                    tool=name,
                    arguments=arguments,
                )
                if not approved:
                    observation = Observation(
                        call_id=call_id,
                        tool=name,
                        ok=False,
                        error=denial,
                    )
                    observations.append(observation)
                    new_observations.append(observation)
                    continue
            request = ToolRequest(call_id=call_id, name=name, arguments=arguments, risk=spec.risk)
            observation = runtime.tools.execute(request)
        observations.append(observation)
        new_observations.append(observation)

    step.status = "running"
    plan[index] = step
    return {
        **state,
        "plan": [s.to_dict() for s in plan],
        "observations": [o.to_dict() for o in observations],
        "step_tool_calls": int(state.get("step_tool_calls", 0)) + len(new_observations),
        "last_had_tool_calls": bool(new_observations),
    }


def reflect_node(runtime: Runtime, state: dict[str, Any]) -> dict[str, Any]:
    if not _budget_left(state, runtime):
        return {**state, "status": "budget"}
    task = TaskSpec(**_task(state))
    context = _context(
        runtime,
        state,
        extra=(
            "请判断：当前计划是否已经由观测值证明完成？若未完成，下一步该做什么？"
            "只输出 JSON。"
        ),
    )
    data, _ = _call_json(runtime, state, prompt_key="reflect", user_text=context)
    verdict = str(data.get("verdict") or "continue")
    if verdict not in ("continue", "done", "replan", "abort"):
        verdict = "continue"
    reflection = Reflection(
        verdict=verdict,  # type: ignore[arg-type]
        reasons=[str(r) for r in (data.get("reasons") or [])],
        next_step=data.get("next_step") if isinstance(data.get("next_step"), int) else None,
    )
    plan = _plan_of(state)
    prior_reflections = [
        item if isinstance(item, dict) else item.to_dict() for item in state.get("reflections", [])
    ]
    updates: dict[str, Any] = {"reflections": [*prior_reflections, reflection.to_dict()]}
    if verdict == "done":
        # 只有 Reflect 认为完成时才把剩余步骤标记为完成（不覆盖已经 done 的）。
        for index, step in enumerate(plan):
            if step.status != "done":
                step.status = "done"
                plan[index] = step
        updates["plan"] = [s.to_dict() for s in plan]
        updates["step_index"] = len(plan)
    elif verdict == "replan":
        updates["replans"] = int(state.get("replans", 0)) + 1
        updates["plan"] = []
        updates["step_index"] = 0
        updates["step_tool_calls"] = 0
    elif verdict == "abort":
        updates["status"] = "aborted"
        updates["stop_reason"] = "reflect_abort"
    else:  # continue
        index = int(state.get("step_index", 0))
        step = plan[min(index, len(plan) - 1)] if plan else None
        updates["step_tool_calls"] = 0
        # 模型偶发只执行一半：本轮观测里有失败就把该步骤留着重试，但最多重试一次（受 max_steps 限制）。
        if step is not None and step.status not in ("done", "failed"):
            step.status = "running"
            plan[state.get("step_index", 0)] = step if state.get("step_index", 0) < len(plan) else step
            if int(state.get("step_index", 0)) >= len(plan):
                updates["step_index"] = max(0, len(plan) - 1)
            updates["plan"] = [s.to_dict() for s in plan]
    _remember(runtime, state, "lesson", f"反思（{verdict}）：" + "；".join(reflection.reasons)[:200], importance=0.5)
    return {**state, **updates}


def critic_node(runtime: Runtime, state: dict[str, Any]) -> dict[str, Any]:
    if not _budget_left(state, runtime):
        return {**state, "status": "budget"}
    task = TaskSpec(**_task(state))
    context = _context(runtime, state, extra="请评审当前产物，只输出 JSON。")
    data, _ = _call_json(runtime, state, prompt_key="critic", user_text=context)
    try:
        score = float(data.get("score", 0.0))
    except (TypeError, ValueError):
        score = 0.0
    critique = Critique(
        score=max(0.0, min(1.0, score)),
        blocking_issues=[str(i) for i in (data.get("blocking_issues") or [])],
        suggestions=[str(i) for i in (data.get("suggestions") or [])],
    )
    critiques = [*(state.get("critiques", [])), critique.to_dict()]
    updates: dict[str, Any] = {"critiques": critiques, "blocking_issues": critique.blocking_issues}
    # 「评审不过 → 重规划」的决定必须落在节点里：条件边里改 state 不保证进图状态，
    # 以前 replans 与 plan 重置都写在边里，等于每次都从同一个没变的计划重来。
    passed = critique.score >= runtime.settings.critic_threshold and not critique.blocking_issues
    coverage = state.get("coverage")
    target = task.coverage_target if task.coverage_target is not None else runtime.settings.coverage_target
    coverage_ok = isinstance(coverage, (int, float)) and float(coverage) >= target
    wants_adversarial = task.mode == "adversarial" and not coverage_ok
    if not passed and not wants_adversarial:
        replans = int(state.get("replans", 0))
        if replans < runtime.settings.budget.max_replans:
            updates.update(
                {
                    "replans": replans + 1,
                    "plan": [],
                    "step_index": 0,
                    "step_tool_calls": 0,
                }
            )
        else:
            updates["stop_reason"] = "critic_blocked"
    return {**state, **updates}


def adversarial_node(runtime: Runtime, state: dict[str, Any]) -> dict[str, Any]:
    """Coder 修 → Tester 跑真实命令找 Bug，直到覆盖率达标或轮数用尽。"""
    if not _budget_left(state, runtime):
        return {**state, "status": "budget"}
    round_no = int(state.get("adversarial_round", 0)) + 1
    issues = state.get("blocking_issues") or []
    # 实现者必须看到「上一轮到底哪条测试红了、覆盖率怎么变的」——只给评审意见
    # 会让它反复改同一处、或改一个早已通过的用例。
    previous_coverage = state.get("coverage")
    previous_output = str(state.get("last_test_output", ""))[-1200:]
    coder_brief = [
        "上轮评审问题：",
        "\n".join(f"- {i}" for i in issues) if issues else "（无）",
        f"上一轮覆盖率：{previous_coverage if previous_coverage is not None else '（还没跑出数字）'}",
    ]
    if previous_output.strip():
        coder_brief += ["上一轮测试命令输出（尾部）：", previous_output]
    coder_brief.append("请只输出 JSON。")
    context = _context(runtime, state, extra="\n".join(coder_brief))
    coder, _ = _call_json(runtime, state, prompt_key="adversarial_coder", user_text=context)

    # 覆盖率必须来自真实命令输出；没有接测试命令就如实记 None。
    report: dict[str, Any] = {"coverage": None, "output": "", "ok": False}
    if runtime.coverage_runner is not None:
        try:
            report = runtime.coverage_runner()
        except Exception as exc:  # noqa: BLE001 - 测试命令失败不该让 run 崩掉
            report = {"coverage": None, "output": f"覆盖率命令执行失败：{exc}", "ok": False}
    coverage = report.get("coverage")
    if isinstance(coverage, (int, float)):
        runtime.metrics.set_coverage(float(coverage))
    # 覆盖率命令本身跑不起来（缺依赖、命令写错、测试直接崩）时，别硬耗满对抗轮数：
    # 连续两轮都拿不到数字就收口，并如实写 stop_reason，而不是假装在"迭代"。
    coverage_failures = int(state.get("coverage_failures", 0))
    coverage_failures = 0 if isinstance(coverage, (int, float)) else coverage_failures + 1

    tester_context = (
        f"实现者说明：{coder.get('summary', '')}\n"
        f"测试命令输出（截断）：\n{str(report.get('output', ''))[:2000]}\n"
        f"当前覆盖率：{coverage}\n请只输出 JSON。"
    )
    tester, _ = _call_json(runtime, state, prompt_key="adversarial_tester", user_text=tester_context)
    bugs = tester.get("bugs") or []
    if not isinstance(bugs, list):
        bugs = []
    _remember(
        runtime,
        state,
        "lesson",
        f"对抗第 {round_no} 轮：覆盖率 {coverage}，缺陷 {len(bugs)} 个：" + "；".join(str(b.get("case", b)) for b in bugs[:5] if isinstance(b, dict) or isinstance(b, str)),
        importance=0.6,
    )
    updates: dict[str, Any] = {
        "adversarial_round": round_no,
        "coverage": float(coverage) if isinstance(coverage, (int, float)) else None,
        "blocking_issues": [str(b.get("case", b)) if isinstance(b, dict) else str(b) for b in bugs],
        "last_test_output": str(report.get("output", ""))[-2000:],
        "coverage_failures": coverage_failures,
    }
    if coverage_failures >= 2:
        updates["stop_reason"] = "coverage_command_failed"
    target = TaskSpec(**_task(state)).coverage_target
    target = runtime.settings.coverage_target if target is None else target
    passed = (
        isinstance(coverage, (int, float))
        and float(coverage) >= target
        and not bugs
    )
    updates["adversarial_passed"] = passed
    # 「本轮是最后一轮但还没达标」要在节点里写 stop_reason：条件边的返回值只决定
    # 走向，边里对 state 的改动不保证进图状态，收口原因会丢。
    if not passed and round_no >= runtime.settings.budget.max_adversarial_rounds:
        updates.setdefault("stop_reason", "coverage_gap")
    return {**state, **updates}


def summarize_node(runtime: Runtime, state: dict[str, Any]) -> dict[str, Any]:
    task = TaskSpec(**_task(state))
    observations = _observations_of(state)
    citations = [c.to_dict() for obs in observations for c in obs.citations]
    if not _budget_left(state, runtime):
        # 预算已耗尽时不能再调模型：用已有观测拼答复，状态标 budget 交给上层展示。
        digest = "\n".join(obs.render(400) for obs in observations[-4:]) or "（没有可汇总的工具结果）"
        return {
            **state,
            "answer": f"（本轮预算已用尽，以下是已完成的内容）\n{digest}",
            "citations": citations,
            "status": "budget",
        }
    context = _context(
        runtime,
        state,
        extra="请汇总给用户的答复，只输出 JSON。",
    )
    data, _ = _call_json(runtime, state, prompt_key="summarize", user_text=context)
    answer = str(data.get("answer") or "").strip()
    # 引用只保留真实出现过的来源，防止模型编造。
    known = {(item["doc_id"], item["chunk"]) for item in citations}
    final_citations: list[dict[str, Any]] = []
    for item in data.get("citations") or []:
        if not isinstance(item, dict):
            continue
        key = (item.get("doc_id"), item.get("chunk"))
        if key in known:
            final_citations.append(item)
    status = "ok"
    if state.get("status") in ("aborted", "budget"):
        status = state["status"]
    elif not answer:
        status = "error"
    return {
        **state,
        "answer": answer,
        "citations": final_citations or citations,
        "status": status,
    }


NODE_IMPLS: dict[str, Callable[[Runtime, dict[str, Any]], dict[str, Any]]] = {
    "plan": plan_node,
    "execute": execute_node,
    "reflect": reflect_node,
    "critic": critic_node,
    "adversarial": adversarial_node,
    "summarize": summarize_node,
}