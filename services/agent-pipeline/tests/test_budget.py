"""预算收口：墙钟/Token/步数三条线必须真的能停住，而不是"文档里写着能停"。

跑长任务最怕的是预算形同虚设——一个死循环把 token 烧光才知道。这里直接构造
极端预算（0 秒、1 token、3 步），要求流水线立刻收口并如实写 stop_reason。
"""

from __future__ import annotations

import json

from agent_pipeline.config import Settings
from agent_pipeline.protocol import TaskSpec
from agent_pipeline.runtime import run_once


def _json(payload: dict) -> dict:
    return {"text": json.dumps(payload, ensure_ascii=False)}


PLAN = _json({"steps": [{"goal": "查一下", "done_when": "有结论"}]})
EXECUTE = {"text": "查完了"}
REFLECT = _json({"verdict": "done", "reasons": ["完成"]})
CRITIC = _json({"score": 0.9, "blocking_issues": []})
SUMMARIZE = _json({"answer": "结论", "citations": []})


def test_wall_clock_zero_stops_before_calling_the_model(runtime_factory) -> None:
    settings = Settings(log_path=":memory:", db_path=":memory:").with_budget(max_wall_clock_s=0)
    runtime = runtime_factory([PLAN], settings=settings)

    result, row = run_once(runtime, TaskSpec(goal="随便一个任务", cwd="."), run_id="run-clock")

    assert result.status == "budget"
    assert result.llm_calls == 0, "墙钟为 0 时连规划都不该调模型"
    assert row["stop_reason"] == "wall_clock"


def test_token_budget_stops_after_the_first_call(runtime_factory) -> None:
    settings = Settings(log_path=":memory:", db_path=":memory:").with_budget(max_tokens=1)
    runtime = runtime_factory([PLAN], settings=settings)

    result, row = run_once(runtime, TaskSpec(goal="随便一个任务", cwd="."), run_id="run-tokens")

    assert result.status == "budget"
    assert result.llm_calls == 1, "只允许一次规划调用，之后必须收口"
    assert row["stop_reason"] == "tokens"


def test_llm_call_budget_stops_the_loop(runtime_factory) -> None:
    settings = Settings(log_path=":memory:", db_path=":memory:").with_budget(max_llm_calls=2)
    runtime = runtime_factory([PLAN, EXECUTE], settings=settings)

    result, row = run_once(runtime, TaskSpec(goal="随便一个任务", cwd="."), run_id="run-calls")

    assert result.status == "budget"
    assert result.llm_calls == 2
    assert row["stop_reason"] == "llm_calls"


def test_plan_is_truncated_to_max_steps(runtime_factory) -> None:
    steps = [{"goal": f"第{i}步", "done_when": "做完"} for i in range(12)]
    settings = Settings(log_path=":memory:", db_path=":memory:").with_budget(max_steps=3)
    runtime = runtime_factory([_json({"steps": steps}), EXECUTE, REFLECT, CRITIC, SUMMARIZE], settings=settings)

    result, _row = run_once(runtime, TaskSpec(goal="12 步的大任务", cwd="."), run_id="run-steps")

    assert result.status in {"ok", "budget"}
    assert len(result.plan) == 3, "计划必须被裁到 max_steps，否则预算里的步数形同虚设"


def test_budget_exhausted_still_summarizes_without_calling_model(runtime_factory) -> None:
    """预算用尽时 summarize 不再调模型，直接给已完成内容（否则预算就是纸面数字）。"""
    settings = Settings(log_path=":memory:", db_path=":memory:").with_budget(max_tokens=1)
    runtime = runtime_factory([PLAN], settings=settings)

    result, _row = run_once(runtime, TaskSpec(goal="随便一个任务", cwd="."), run_id="run-sum")

    assert result.status == "budget"
    assert result.llm_calls == 1, "收尾不能偷偷再调一次模型"
    assert "预算" in result.answer