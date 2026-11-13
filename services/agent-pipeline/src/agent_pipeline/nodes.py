"""各节点实现：纯函数 + 依赖注入（``Runtime``），不直接读环境、不直接建连接。

节点只做三件事：组装上下文 → 调一次模型 → 把结果写成协议结构。
所有副作用（工具、记忆、指标、日志）都走 ``Runtime``，测试里替换即可。
"""

from __future__ import annotations

import hashlib
import json
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
    # 取消标记：返回 True 表示这个 run 已被要求停止。节点之间会检查一次，
    # 命中就写 stop_reason="cancelled" 收口——长任务不能只能靠杀进程来停。
    cancel: Callable[[str], bool] | None = None
    # 日志落盘失败次数：写日志不能把 run 弄崩，但也不能静默——否则「日志驱动调优」
    # 会拿着一份空文件出报告，看起来一切正常。
    log_failures: int = 0
    log_last_error: str | None = None

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
    """把状态里的观测还原成对象。

    ``Observation.to_dict()`` 会把 ``citations`` 也摊成 dict，直接 ``Observation(**o)``
    会留下 dict 形式的引用，后面 ``c.doc_id`` 就会炸——这里一并还原。
    """
    out: list[Observation] = []
    for item in state.get("observations", []):
        if not isinstance(item, dict):
            out.append(item)
            continue
        data = dict(item)
        data["citations"] = [
            Citation(**c) if isinstance(c, dict) else c for c in data.get("citations") or []
        ]
        out.append(Observation(**data))
    return out


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
    # 评审不过 → 重规划时，必须让规划者看到「上一版为什么不过」。
    # 以前只把计划清空重排，critic 的 blocking_issues/suggestions 只进了旁路记录，
    # 规划者看到的上下文和第一次一模一样 → 重排出来的计划也基本一样，白烧一轮。
    critiques = state.get("critiques") or []
    last_critique = critiques[-1] if critiques and isinstance(critiques[-1], dict) else {}
    replan_brief = ""
    if last_critique:
        issues = [str(item) for item in (last_critique.get("blocking_issues") or [])][:5]
        suggestions = [str(item) for item in (last_critique.get("suggestions") or [])][:5]
        if issues or suggestions:
            replan_brief = "上一版计划没通过评审，重排时请针对性修正："
            if issues:
                replan_brief += "\n阻断问题：\n" + "\n".join(f"- {item}" for item in issues)
            if suggestions:
                replan_brief += "\n评审建议：\n" + "\n".join(f"- {item}" for item in suggestions)
            replan_brief += "\n"
    # 计划步数上限要说出来：提示词里写死「3-7 步」，但 max_steps 可能被调小（比如预算测试用 2），
    # 多出来的步骤会被静默截掉，规划者以为自己的后几步会被执行。
    step_limit = runtime.settings.budget.max_steps
    context = _context(
        runtime,
        state,
        extra=(
            f"{replan_brief}本次最多 {step_limit} 个步骤（超出会被丢弃），每步都要能独立验证。"
            "请只输出 JSON 计划。"
        ),
        memories=recalled,
    )
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


def _cancel_requested(runtime: Runtime, state: dict[str, Any]) -> bool:
    """用户是否已经取消了这个 run（协作式标记，只读不阻塞）。"""
    if runtime.cancel is None:
        return False
    try:
        return bool(runtime.cancel(str(state.get("run_id", ""))))
    except Exception:  # noqa: BLE001 - 取消标记读失败不能把 run 弄崩
        return False


def execute_node(runtime: Runtime, state: dict[str, Any]) -> dict[str, Any]:
    if not _budget_left(state, runtime):
        return {**state, "status": "budget"}
    # max_steps 的封顶必须写在节点里：条件边对 state 的改动不保证进图状态（LangGraph
    # 只提交节点返回值），以前只在 route_after_execute 里写 stop_reason，最终结果里是 None。
    if int(state.get("steps_executed", 0)) >= runtime.settings.budget.max_steps:
        return {**state, "stop_reason": "max_steps"}
    plan = _plan_of(state)
    index = int(state.get("step_index", 0))
    if index >= len(plan):
        completed = int(state.get("steps_executed", 0)) + 1
        updates: dict[str, Any] = {**state, "steps_executed": completed}
        if completed >= runtime.settings.budget.max_steps:
            updates["stop_reason"] = "max_steps"
        return updates
    step = plan[index]
    step.status = "running"
    plan[index] = step
    task = TaskSpec(**_task(state))
    allowed = task.tools_allowed or runtime.tools.registry.names()
    schemas = runtime.tools.registry.openai_tools(allowed)
    # 计划里给的「建议工具」要真的告诉执行者：以前只解析进 PlanStep.tools_hint 就再没人读，
    # 规划者写「用 http_get 查一下」等于白写，执行者只能自己猜。
    allowed_set = set(allowed)
    hints = [name for name in step.tools_hint if name in allowed_set][:5]
    hint_line = f"\n计划建议使用：{'、'.join(hints)}（可以不用，但优先考虑）" if hints else ""
    context = _context(
        runtime,
        state,
        extra=(
            f"当前步骤 {step.id}/{len(plan)}：{step.goal}\n完成条件：{step.done_when}\n"
            f"本步骤剩余工具调用预算：{max(0, runtime.settings.budget.step_tool_budget - int(state.get('step_tool_calls', 0)))}"
            f"{hint_line}"
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
    keep = max(0, remaining)
    dropped_calls = list(calls[keep:])
    calls = calls[:keep]
    observations = _observations_of(state)
    new_observations: list[Observation] = []
    # 超出单步预算的调用不能悄悄丢掉：模型以为自己调过了，下一步就会基于「其实没发生」的前提推理。
    # 这里给每个被丢掉的调用留一条失败观测，模型下一轮能看到「这次没执行」。
    for index_dropped, dropped in enumerate(dropped_calls):
        dropped_name = str(dropped.get("name") or "（未命名工具）")
        dropped_id = str(
            dropped.get("id")
            or f"call_dropped_{hashlib.sha1((dropped_name + str(index_dropped)).encode()).hexdigest()[:8]}"
        )
        note = Observation(
            call_id=dropped_id,
            tool=dropped_name,
            ok=False,
            error=(
                f"这次调用没有执行：本步骤的工具调用预算已用尽"
                f"（每步最多 {runtime.settings.budget.step_tool_budget} 次）。"
                f"如果还需要，请下一步再试。"
            ),
        )
        observations.append(note)
        new_observations.append(note)
    # 只读工具一起跑（顺序执行但互不依赖），写工具天然串行——这里统一顺序执行，行为确定。
    known = set(runtime.tools.registry.names())
    # tools_allowed 是「本次允许用哪些工具」的硬约束：模型仍可能凭上下文发出别的名字
    # （尤其是上一次对话里见过的写工具），所以除了下发 schema 时过滤，这里再挡一次执行。
    allowed_names = set(task.tools_allowed) if task.tools_allowed else known
    cancelled = False
    for position, call in enumerate(calls):
        if _cancel_requested(runtime, state):
            # 用户在工具轮中途点了取消：每次工具调用可能要几十秒（http_get/run_command），
            # 以前要等整个节点跑完才在下一个节点边界收口。现在立刻停手，但把没跑的调用
            # 逐个记成观测，下一轮/日志里能看出「取消时做到哪一步」。
            for rest in calls[position:]:
                rest_name = str(rest.get("name") or "（未命名工具）")
                rest_id = str(
                    rest.get("id")
                    or f"call_cancelled_{hashlib.sha1((rest_name + str(position)).encode()).hexdigest()[:8]}"
                )
                note = Observation(
                    call_id=rest_id,
                    tool=rest_name,
                    ok=False,
                    error="这次调用没有执行：用户取消了本次运行。",
                )
                observations.append(note)
                new_observations.append(note)
            cancelled = True
            break
        name = str(call.get("name") or "")
        raw_arguments = call.get("arguments")
        bad_arguments: str | None = None
        if isinstance(raw_arguments, dict):
            arguments = raw_arguments
        elif isinstance(raw_arguments, str) and raw_arguments.strip():
            # 有的客户端/供应商把 arguments 原样给成 JSON 字符串（OpenAI 的线上格式就是这样）。
            # 以前这里直接当空 dict，模型明明写了参数却收到「$ 是必填字段」，很难查。
            try:
                parsed = json.loads(raw_arguments)
            except json.JSONDecodeError as exc:
                parsed = None
                bad_arguments = f"工具参数不是合法 JSON：{exc}"
            arguments = parsed if isinstance(parsed, dict) else {}
            if parsed is not None and not isinstance(parsed, dict):
                bad_arguments = f"工具参数必须是 JSON 对象，收到的是 {type(parsed).__name__}"
        else:
            arguments = {}
        # 任务的 cwd 要真的落到命令执行上：模型在提示里看到「工作目录：D:/proj」，
        # 但 run_command 以前总在服务进程自己的目录里跑，写出来的文件落在错的地方。
        if name == "run_command" and "cwd" not in arguments:
            task_cwd = str(task.cwd or "").strip()
            if task_cwd and task_cwd != ".":
                arguments = {**arguments, "cwd": task_cwd}
        call_id = str(call.get("id") or f"call_{hashlib.sha1((name + str(arguments)).encode()).hexdigest()[:8]}")
        if bad_arguments:
            observation = Observation(call_id=call_id, tool=name, ok=False, error=f"工具没有执行：{bad_arguments}")
        elif name not in known:
            observation = Observation(call_id=call_id, tool=name, ok=False, error=f"未注册的工具：{name}")
        elif name not in allowed_names:
            observation = Observation(
                call_id=call_id,
                tool=name,
                ok=False,
                error=(
                    f"工具不在本次允许的范围内：{name}"
                    f"（允许：{'、'.join(sorted(allowed_names)) or '无'}）"
                ),
            )
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
    updates: dict[str, Any] = {
        **state,
        "plan": [s.to_dict() for s in plan],
        "observations": [o.to_dict() for o in observations],
        "step_tool_calls": int(state.get("step_tool_calls", 0)) + len(new_observations),
        "last_had_tool_calls": bool(new_observations),
    }
    if cancelled:
        # 直接收口成 aborted：不必再等 route/下一个节点才发现取消，省掉一次模型调用。
        updates.update(status="aborted", stop_reason="cancelled")
    return updates


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
    lessons = [str(item) for item in (data.get("lessons") or []) if str(item).strip()][:3]
    reflection = Reflection(
        verdict=verdict,  # type: ignore[arg-type]
        reasons=[str(r) for r in (data.get("reasons") or [])],
        next_step=data.get("next_step") if isinstance(data.get("next_step"), int) else None,
        lessons=lessons,
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
        # 全部步骤都完成了，台账也要对齐（否则行里的 steps_executed 会停在半路）
        updates["steps_executed"] = max(int(state.get("steps_executed", 0)), len(plan))
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
        prior_calls = int(state.get("step_tool_calls", 0))
        # 反射者可以指定「下一步做哪个步骤」：协议里有 next_step、提示词也要求它输出，
        # 但以前没人读——反思说「先去第 3 步补验证」时，执行者仍按顺序往下走，
        # 于是计划里写着「先查证再做决定」也会被做成「按顺序做」。
        target = reflection.next_step
        jumped = (
            isinstance(target, int)
            and 0 <= target < len(plan)
            and target != index
            and plan[target].status != "done"
        )
        if jumped:
            index = target
            updates["step_index"] = target
        step = plan[min(index, len(plan) - 1)] if plan else None
        updates["step_tool_calls"] = 0
        # 一个步骤把工具预算烧光了、模型却仍不宣布完成，就是在原地打转：把它按失败收口并
        # 往后走一步。否则 execute/reflect 会在同一步上无限循环，而 max_steps 只按
        # 「完成的步骤数」计（以前只在该步不调工具时 +1）→ 预算形同废纸，只能靠
        # max_llm_calls 兜底（实测 8 步预算跑掉 14 步、28 次 execute）。
        exhausted = (
            step is not None
            and step.status == "running"
            and not jumped
            and prior_calls >= runtime.settings.budget.step_tool_budget
        )
        if exhausted:
            position = min(index, len(plan) - 1)
            step.status = "failed"
            plan[position] = step
            advanced = min(position + 1, len(plan))
            updates["step_index"] = advanced
            updates["steps_executed"] = max(int(state.get("steps_executed", 0)), advanced)
            updates["plan"] = [s.to_dict() for s in plan]
            if advanced >= len(plan):
                # 计划里已经没有「下一个」可试了：这是预算用尽，不是任务做完了。
                # 以前这里会一路走到 critic、以 status=ok 收场，看板分不出「全步失败」和「做成」。
                updates["stop_reason"] = "max_steps"
        elif step is not None and step.status not in ("done", "failed"):
            step.status = "running"
            position = min(index, len(plan) - 1)
            plan[position] = step
            if index >= len(plan):
                updates["step_index"] = max(0, len(plan) - 1)
            updates["plan"] = [s.to_dict() for s in plan]
            updates["steps_executed"] = max(int(state.get("steps_executed", 0)), index)
        elif jumped:
            updates["plan"] = [s.to_dict() for s in plan]
            updates["steps_executed"] = max(int(state.get("steps_executed", 0)), index)
        else:
            updates["steps_executed"] = max(int(state.get("steps_executed", 0)), index)
    _remember(runtime, state, "lesson", f"反思（{verdict}）：" + "；".join(reflection.reasons)[:200], importance=0.5)
    # 反思总结出的「经验」比「反思理由」更值得留：下次做同类任务要优先被检索到。
    for lesson in lessons:
        _remember(runtime, state, "lesson", lesson[:300], importance=0.7)
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
    if state.get("stop_reason") == "cancelled":
        # 被取消的 run 不再调模型：把已经做完的部分交回去，状态标 aborted。
        digest = "\n".join(obs.render(400) for obs in observations[-4:]) or "（取消前还没有工具结果）"
        return {
            **state,
            "answer": f"（这次运行被取消，以下是取消前已完成的内容）\n{digest}",
            "citations": citations,
            "status": "aborted",
        }
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