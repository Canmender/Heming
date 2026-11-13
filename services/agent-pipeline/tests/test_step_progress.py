"""max_steps 必须真的封顶：一个步骤烧光工具预算后不能无限重试。

以前 steps_executed 只在一段「模型不再调工具」时 +1，所以「每一步都调工具、模型从不说
完成」的路径上它永远是 0，route_after_execute 的 max_steps 检查不触发——预算写 8 步，
实际跑了 14 步、28 次 execute，最后靠 max_llm_calls / 图递归上限兜底。这类静默超支在
10 万次调用里不是「慢一点」，而是账单和时延都按 2 倍算。
"""

from __future__ import annotations

import json

from agent_pipeline.config import Budget, Settings
from agent_pipeline.graph import run_pipeline
from agent_pipeline.protocol import TaskSpec
from agent_pipeline.tools import ToolSpec


def _echo(args):
    return {"text": f"回显 {args.get('text', '')}"}


ECHO = ToolSpec(
    name="echo",
    description="回显",
    schema={
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
        "additionalProperties": False,
    },
    risk="read",
    handler=_echo,
    idempotent=False,
)


def _always_tools(messages, _tools):
    system = "\n".join(str(m.get("content", "")) for m in messages if m.get("role") == "system")
    if "规划者" in system:
        # 5 步的计划：max_steps=3 时只应走到第 3 步
        steps = [{"goal": f"第{i}步查", "done_when": "查到"} for i in range(1, 6)]
        return {"text": json.dumps({"steps": steps}, ensure_ascii=False)}
    if "执行者" in system:
        return {"tool_calls": [{"id": f"c{len(messages)}", "name": "echo", "arguments": {"text": "x"}}]}
    if "反思" in system:
        return {"text": json.dumps({"verdict": "continue", "reasons": ["还没完"]}, ensure_ascii=False)}
    if "评审者" in system:
        return {"text": json.dumps({"score": 0.9, "blocking_issues": []}, ensure_ascii=False)}
    return {"text": json.dumps({"answer": "兜底", "citations": []}, ensure_ascii=False)}


def _run(runtime_factory, **budget_kwargs):
    settings = Settings(
        log_path=":memory:",
        db_path=":memory:",
        budget=Budget(max_llm_calls=80, max_tokens=1_000_000, **budget_kwargs),
    )
    runtime = runtime_factory([_always_tools] * 300, settings=settings, tools=[ECHO])
    return runtime, run_pipeline(runtime, TaskSpec(goal="反复查", mode="react"), run_id="r-steps")


def test_max_steps_caps_a_tool_only_loop(runtime_factory):
    """每一步都在调工具、从不说完成：到 max_steps 就停，不能靠 max_llm_calls 兜底。"""
    runtime, result = _run(runtime_factory, max_steps=3, step_tool_budget=2)

    assert result.get("stop_reason") == "max_steps", result.get("stop_reason")
    assert result.get("status") in ("ok", "budget")
    assert int(result.get("steps_executed") or 0) == 3
    # 3 步 × (2 轮工具 + 1 次反思) + 规划 + 收尾，明显低于 80 次模型调用的预算
    assert len(runtime.llm.calls) <= 4 * 3 + 3


def test_exhausted_step_is_marked_failed_and_left_behind(runtime_factory):
    """烧光工具预算的步骤要收口成 failed 并往后走，而不是永远停在 running。"""
    _runtime, result = _run(runtime_factory, max_steps=3, step_tool_budget=2)

    plan = result.get("plan") or []
    assert plan, "计划不应为空"
    done_or_failed = [step for step in plan if step.get("status") in ("done", "failed")]
    assert len(done_or_failed) >= 3
    assert any(step.get("status") == "failed" for step in plan)


def test_normal_step_that_stops_calling_tools_is_not_marked_failed(runtime_factory):
    """模型停手（这一步不需要工具）时按完成算，不能被判成 failed。"""

    def _one_shot(messages, _tools):
        system = "\n".join(str(m.get("content", "")) for m in messages if m.get("role") == "system")
        if "规划者" in system:
            return {"text": json.dumps({"steps": [{"goal": "看一眼", "done_when": "看过"}]}, ensure_ascii=False)}
        if "执行者" in system:
            return {"text": "这一步不需要工具。"}
        if "反思" in system:
            return {"text": json.dumps({"verdict": "done", "reasons": ["够了"]}, ensure_ascii=False)}
        if "评审者" in system:
            return {"text": json.dumps({"score": 0.9, "blocking_issues": []}, ensure_ascii=False)}
        return {"text": json.dumps({"answer": "完成", "citations": []}, ensure_ascii=False)}

    settings = Settings(log_path=":memory:", db_path=":memory:", budget=Budget(max_llm_calls=40))
    runtime = runtime_factory([_one_shot] * 40, settings=settings, tools=[ECHO])
    result = run_pipeline(runtime, TaskSpec(goal="看一眼", mode="react"), run_id="r-clean")

    plan = result.get("plan") or []
    assert [step.get("status") for step in plan] == ["done"]
    assert result.get("stop_reason") != "max_steps"