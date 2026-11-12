"""评审不过之后，重排计划必须看得到「上一版为什么不过」。

以前 `critic_node` 只把 `blocking_issues` / `suggestions` 存进旁路记录，`plan_node` 把它清空重排，
规划者拿到的上下文和第一次一模一样 → 重排出来的计划也基本一样，白烧一轮模型与工具。
"""

from __future__ import annotations

import json
from dataclasses import replace

from agent_pipeline.config import Settings
from agent_pipeline.llm import FakeLLM
from agent_pipeline.protocol import TaskSpec
from agent_pipeline.runtime import build_runtime, run_once


def _settings(tmp_path) -> Settings:
    return replace(Settings(db_path=":memory:", log_path=str(tmp_path / "runs.jsonl")))


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


def test_replan_sees_previous_blocking_issues(tmp_path) -> None:
    plan_prompts: list[str] = []
    rounds = {"plan": 0, "critic": 0}

    def script(messages, tools):
        node = _node(messages)
        text = "\n".join(str(m.get("content", "")) for m in messages)
        if node == "plan":
            rounds["plan"] += 1
            plan_prompts.append(text)
            if rounds["plan"] == 1:
                return {"text": json.dumps({"steps": [{"goal": "步骤甲", "done_when": "甲完成"}]})}
            return {"text": json.dumps({"steps": [{"goal": "补上异常分支", "done_when": "异常路径有测试"}]})}
        if node == "execute":
            return {"text": "这一步不需要工具"}
        if node == "reflect":
            return {"text": json.dumps({"verdict": "done", "reasons": ["做完了"]})}
        if node == "critic":
            rounds["critic"] += 1
            if rounds["critic"] == 1:
                return {
                    "text": json.dumps(
                        {
                            "score": 0.3,
                            "blocking_issues": ["没有覆盖异常分支"],
                            "suggestions": ["先写一个抛异常再捕获的用例"],
                        }
                    )
                }
            return {"text": json.dumps({"score": 0.95, "blocking_issues": [], "suggestions": []})}
        return {"text": json.dumps({"answer": "补好了", "citations": []})}

    runtime = build_runtime(_settings(tmp_path), llm=FakeLLM(script=[script] * 20))
    result, _row = run_once(runtime, TaskSpec(goal="带异常分支的任务"), run_id="run-replan-brief")

    assert len(plan_prompts) >= 2, "评审不过之后应当重排一次计划"
    # 第一次计划看不到评审意见（还没有）
    assert "阻断问题" not in plan_prompts[0]
    # 重排那次必须带上具体问题与建议
    assert "没有覆盖异常分支" in plan_prompts[1], plan_prompts[1]
    assert "先写一个抛异常再捕获的用例" in plan_prompts[1], plan_prompts[1]
    assert result.status == "ok"