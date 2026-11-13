"""计划里的「半成品步骤」不能把整条 run 弄成 error。

模型的计划 JSON 经常短一两个字段：漏 `done_when`、把一步的 goal 写成空串、
或者干脆给几项不是对象的垃圾。以前这些情况会：
- 漏 done_when → `PlanStep` 构造时拒绝 → 节点抛错 → 整条 run `status=error`（只差一个字段）；
- 空 goal → 塞进计划，执行提示变成「当前步骤 1/3：\n完成条件：…」，模型只能瞎猜；
- 全都不合法 → 直接 `raise ProtocolError("Planner 给出的步骤都不合法")`。
计划质量差是模型的问题，调用方该拿到的是一条尽力完成的答复 + 可观测的降级，而不是 error。
"""

from __future__ import annotations

import json

from agent_pipeline.graph import run_pipeline
from agent_pipeline.nodes import DEFAULT_DONE_WHEN
from agent_pipeline.protocol import TaskSpec


def _script(plan_payload, answer: str = "答复"):
    def call(messages, _tools):
        system = "\n".join(str(m.get("content", "")) for m in messages if m.get("role") == "system")
        if "规划者" in system:
            return {"text": json.dumps(plan_payload, ensure_ascii=False)}
        if "执行者" in system:
            return {"text": "这一步直接回答。"}
        if "反思" in system:
            return {"text": json.dumps({"verdict": "done", "reasons": ["够了"]}, ensure_ascii=False)}
        if "评审者" in system:
            return {"text": json.dumps({"score": 0.9, "blocking_issues": []}, ensure_ascii=False)}
        return {"text": json.dumps({"answer": answer, "citations": []}, ensure_ascii=False)}

    return [call] * 40


def test_step_without_done_when_gets_a_verifiable_default(runtime_factory):
    payload = {"steps": [{"goal": "查一下安装器版本"}]}  # 故意没写 done_when
    runtime = runtime_factory(_script(payload))

    result = run_pipeline(runtime, TaskSpec(goal="查版本", mode="react"), run_id="r-repair-1")

    assert result.get("status") != "error", result.get("error")
    plan = result.get("plan") or []
    assert len(plan) == 1
    assert plan[0]["goal"] == "查一下安装器版本"
    assert plan[0]["done_when"] == DEFAULT_DONE_WHEN


def test_empty_goal_step_is_dropped_and_ids_are_renumbered(runtime_factory):
    payload = {
        "steps": [
            {"goal": "   ", "done_when": "不可能达成"},
            {"goal": "第一步", "done_when": "第一步完成"},
            {"goal": "第二步", "done_when": "第二步完成"},
        ]
    }
    runtime = runtime_factory(_script(payload))

    result = run_pipeline(runtime, TaskSpec(goal="两步", mode="react"), run_id="r-repair-2")

    plan = result.get("plan") or []
    assert [step["id"] for step in plan] == [1, 2]
    assert [step["goal"] for step in plan] == ["第一步", "第二步"]
    assert result.get("status") != "error"


def test_entirely_broken_plan_falls_back_to_one_step(runtime_factory):
    payload = {"steps": [{"goal": ""}, "垃圾", 42, {}]}
    runtime = runtime_factory(_script(payload))

    result = run_pipeline(runtime, TaskSpec(goal="把文档整理一下", mode="react"), run_id="r-repair-3")

    assert result.get("status") != "error", result.get("error")
    plan = result.get("plan") or []
    assert len(plan) == 1
    # 计划退化成「把用户任务做完」一步，目标取自 TaskSpec
    assert plan[0]["goal"] == "把文档整理一下"
    assert plan[0]["done_when"] == DEFAULT_DONE_WHEN
    assert "答复" in str(result.get("answer") or "")


def test_non_object_steps_are_skipped_not_crashed(runtime_factory):
    payload = {"steps": ["先看看", {"goal": "真正的一步", "done_when": "有结论"}, None]}
    runtime = runtime_factory(_script(payload))

    result = run_pipeline(runtime, TaskSpec(goal="混合计划", mode="react"), run_id="r-repair-4")

    plan = result.get("plan") or []
    assert [step["goal"] for step in plan] == ["真正的一步"]
    assert result.get("status") != "error"