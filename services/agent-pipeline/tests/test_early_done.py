"""Reflect 提前宣布完成时，没执行的步骤不能写成 done（否则是假成功）。"""

from __future__ import annotations

import json

from agent_pipeline.graph import build_graph
from agent_pipeline.nodes import new_state
from agent_pipeline.protocol import TaskSpec


def _llm_with_early_done():
    """plan(3 步) → execute(第 1 步不调工具) → reflect done → critic 0.9 → summarize。"""

    def call(messages, tools):  # noqa: ANN001
        system = str(messages[0].get("content", ""))
        if "规划者" in system:
            return json.dumps(
                {
                    "steps": [
                        {"goal": "第一步", "done_when": "有结论"},
                        {"goal": "第二步", "done_when": "有结论"},
                        {"goal": "第三步", "done_when": "有结论"},
                    ]
                }
            )
        if "执行者" in system:
            return "第一步做完了"
        if "反思者" in system:
            return json.dumps({"verdict": "done", "reasons": ["已经够了"]})
        if "评审者" in system:
            return json.dumps({"score": 0.9, "blocking_issues": [], "suggestions": []})
        return json.dumps({"answer": "做完了", "citations": []})

    return call


def test_unexecuted_steps_are_skipped_not_done(runtime_factory):
    runtime = runtime_factory([_llm_with_early_done()] * 20)
    task = TaskSpec(goal="做三件事", mode="react")
    state = new_state("run-early", task)
    graph = build_graph(runtime)
    result = graph.invoke(state, config={"recursion_limit": 40})

    statuses = [step["status"] for step in result["plan"]]
    # 第一步真的做了；后面两步没跑过，标 skipped 而不是 done
    assert statuses == ["done", "skipped", "skipped"]
    assert result["skipped_steps"] == 2
    # 台账不能被提前写成 3
    assert result["steps_executed"] == 1
    assert result["status"] == "ok"

    # 评审要看到「有几步没做」，否则只看最终答复就会判高分
    critic_prompts = [
        # 提示词在 system 那条，任务/计划/观测拼在最后一条 user 里
        str(entry["messages"][-1].get("content", ""))
        for entry in runtime.llm.calls
        if "评审者" in str(entry["messages"][0].get("content", ""))
    ]
    assert critic_prompts, "应当有一次评审调用"
    assert "2 个计划步骤没有执行" in critic_prompts[-1]
