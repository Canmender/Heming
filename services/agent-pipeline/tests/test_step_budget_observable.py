"""超出单步工具预算的调用，不能悄悄消失。

以前 `calls = calls[: remaining]` 直接把多出来的调用切掉：模型以为自己调过了，
下一轮就基于「其实没发生」的前提推理（典型症状是它接着说「刚才那个查询结果显示…」
而观测里根本没有那次调用）。现在每个被丢掉的调用都留一条失败观测，模型能看见。
"""

from __future__ import annotations

import json
from dataclasses import replace

from agent_pipeline.config import Budget, Settings
from agent_pipeline.llm import FakeLLM
from agent_pipeline.protocol import TaskSpec
from agent_pipeline.runtime import build_runtime, run_once


def _node(messages) -> str:
    system = "\n".join(str(m.get("content", "")) for m in messages if m.get("role") == "system")
    if "规划者" in system:
        return "plan"
    if "执行者" in system:
        return "execute"
    if "反思者" in system:
        return "reflect"
    if "评审者" in system:
        return "critic"
    return "summarize"


def test_calls_over_step_budget_get_a_visible_observation(tmp_path) -> None:
    rounds = {"execute": 0}

    def script(messages, tools):
        node = _node(messages)
        if node == "plan":
            return {"text": json.dumps({"steps": [{"goal": "一口气查三样", "done_when": "都查到"}]})}
        if node == "execute":
            rounds["execute"] += 1
            if rounds["execute"] == 1:
                return {
                    "text": "",
                    "tool_calls": [
                        {"id": "c1", "name": "knowledge_search", "arguments": {"query": "甲"}},
                        {"id": "c2", "name": "knowledge_search", "arguments": {"query": "乙"}},
                        {"id": "c3", "name": "knowledge_search", "arguments": {"query": "丙"}},
                    ],
                }
            return {"text": "看完了"}
        if node == "reflect":
            return {"text": json.dumps({"verdict": "done", "reasons": ["够了"]})}
        if node == "critic":
            return {"text": json.dumps({"score": 0.9, "blocking_issues": [], "suggestions": []})}
        return {"text": json.dumps({"answer": "好", "citations": []})}

    settings = replace(
        Settings(db_path=":memory:", log_path=str(tmp_path / "runs.jsonl")),
        budget=Budget(step_tool_budget=2),
    )
    runtime = build_runtime(settings, llm=FakeLLM(script=[script] * 10))
    result, _row = run_once(runtime, TaskSpec(goal="一口气查三样"), run_id="run-step-budget")

    searches = [item for item in result.observations if item.tool == "knowledge_search"]
    assert len(searches) == 3, [item.to_dict() for item in result.observations]
    executed = [item for item in searches if item.ok]
    dropped = [item for item in searches if not item.ok]
    assert len(executed) == 2, [item.to_dict() for item in executed]
    assert len(dropped) == 1, [item.to_dict() for item in dropped]
    assert "预算已用尽" in (dropped[0].error or ""), dropped[0].error
    assert dropped[0].call_id == "c3", dropped[0].call_id