"""图递归上限真被撞到时，run 不能以异常收场。

`recursion_limit_for()` 按预算算上限，正常情况下不该撞到；但预算调得极紧、
或以后有人把 `step_tool_budget` 换算改错时仍然可能撞上。真撞上时
`run_pipeline` 必须把 `GraphRecursionError` 收成「预算用尽」的答复，而不是
让调用方看到实现层的异常。
"""

from __future__ import annotations

import agent_pipeline.graph as graph_module
from agent_pipeline.graph import run_pipeline
from agent_pipeline.protocol import TaskSpec


def _llm(_messages, _tools):
    """按 system 提示词答复各节点，保证格式合法（否则先撞 ProtocolError）。"""
    system = str(_messages[0].get("content", "")) if _messages else ""
    if "规划者" in system:
        return {
            "text": '{"steps":[{"goal":"第一步","done_when":"有结果"},{"goal":"第二步","done_when":"有结果"}]}'
        }
    if "执行者" in system:
        return {"text": "这一步先做点准备。"}
    if "反思者" in system:
        return {"text": '{"verdict":"continue","reasons":["继续"]}'}
    if "评审者" in system:
        return {"text": '{"score":0.9}'}
    return {"text": '{"answer":"好了"}'}


def test_recursion_error_is_reported_as_budget_not_crash(runtime_factory, monkeypatch):
    runtime = runtime_factory([_llm] * 30)
    # 把预算算出来的上限压到很小，让第二次/第三次 superstep 就撞上限。
    monkeypatch.setattr(graph_module, "recursion_limit_for", lambda _runtime: 2)

    state = run_pipeline(
        runtime,
        TaskSpec(goal="随便做点什么", mode="react"),
        run_id="r-recursion",
        config_version=0,
    )

    assert state["status"] == "budget"
    assert state["stop_reason"] == "recursion_limit"
    assert "图执行步数到达上限" in state["answer"]
    assert state["observations"] == []
    # 兜底答复里要告诉人怎么调小预算，否则只能去翻实现。
    assert "max_steps" in state["answer"]