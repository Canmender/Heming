"""图执行上限：按预算算，不能用 LangGraph 默认的 25。

「每步最多 step_tool_budget 轮工具 + 每一步一次 reflect」的时候，8 步 × 3 轮就能超过
默认上限——一个正常的长任务会在中途抛 GraphRecursionError，而错误信息看起来像图写错了。
"""

from __future__ import annotations

import json

from agent_pipeline.config import Budget, Settings
from agent_pipeline.graph import recursion_limit_for, run_pipeline
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


def _executor(messages, _tools):
    """执行者永远叫工具 → 路由一直回到 execute，把图推得尽可能远。"""
    system = "\n".join(str(m.get("content", "")) for m in messages if m.get("role") == "system")
    if "规划者" in system:
        steps = [{"goal": f"第{i}步查", "done_when": "查到"} for i in range(1, 6)]
        return {"text": json.dumps({"steps": steps}, ensure_ascii=False)}
    if "执行者" in system:
        return {"tool_calls": [{"id": f"c{len(messages)}", "name": "echo", "arguments": {"text": "x"}}]}
    if "反思" in system:
        return {"text": json.dumps({"verdict": "continue", "reasons": ["还没完"]}, ensure_ascii=False)}
    if "评审者" in system:
        return {"text": json.dumps({"score": 0.1, "blocking_issues": ["不够"], "suggestions": []}, ensure_ascii=False)}
    return {"text": json.dumps({"answer": "兜底", "citations": []}, ensure_ascii=False)}


def test_recursion_limit_grows_with_budget():
    settings = Settings(log_path=":memory:", db_path=":memory:")
    base = recursion_limit_for(type("R", (), {"settings": settings})())  # type: ignore[arg-type]
    # 默认预算（8 步 × 6 轮工具）远大于 LangGraph 默认 25
    assert base >= 30
    assert base > settings.budget.max_steps

    small = settings.with_budget(max_steps=2, step_tool_budget=1)
    tiny = recursion_limit_for(type("R", (), {"settings": small})())  # type: ignore[arg-type]
    assert tiny >= 30  # 兜底下限，不会因为预算调小反而更小
    assert tiny <= base


def test_long_tool_loop_does_not_hit_default_recursion_limit(runtime_factory):
    """5 步 × 每步 6 轮工具 = 30+ 个 superstep：默认上限 25 会中途炸，按预算算的上限不会。"""
    settings = Settings(
        log_path=":memory:",
        db_path=":memory:",
        budget=Budget(max_steps=5, max_llm_calls=80, max_tokens=1_000_000, step_tool_budget=6),
    )
    runtime = runtime_factory([_executor] * 300, settings=settings, tools=[ECHO])

    result = run_pipeline(runtime, TaskSpec(goal="反复查", mode="react"), run_id="r-limit")

    # 撞「图执行上限」实现兜底不算通过：这条路径应该是预算正常收口。
    assert result.get("stop_reason") != "recursion_limit", result.get("answer")
    assert result.get("status") in ("ok", "budget")
    # 真的跑了很多步（超过默认 25 个 superstep），且预算封顶生效了。
    assert result.get("stop_reason") == "max_steps"
    assert len(result.get("observations") or []) >= 25