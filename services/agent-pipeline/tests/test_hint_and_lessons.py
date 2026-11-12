"""两个「协议里有、实现里没人读」的字段，现在真的生效了。

1. `PlanStep.tools_hint`：规划者写「这一步用 http_get 查」，执行者以前看不到，只能自己猜。
2. `Reflection.lessons`：反思总结的经验以前根本没被解析（`Reflection` 有这个字段但从不赋值），
   于是「这次学到的」在下一轮就丢了——而 10 万次调用里最值钱的正是这些可复用的经验。
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


def test_tools_hint_reaches_the_executor(tmp_path) -> None:
    execute_prompts: list[str] = []

    def script(messages, tools):
        node = _node(messages)
        if node == "plan":
            return {
                "text": json.dumps(
                    {
                        "steps": [
                            {
                                "goal": "查一下接口",
                                "done_when": "看到响应",
                                "tools_hint": ["http_get", "run_command"],
                            }
                        ]
                    }
                )
            }
        if node == "execute":
            execute_prompts.append("\n".join(str(m.get("content", "")) for m in messages))
            return {"text": "这一步不需要工具"}
        if node == "reflect":
            return {"text": json.dumps({"verdict": "done", "reasons": ["够了"]})}
        if node == "critic":
            return {"text": json.dumps({"score": 0.9, "blocking_issues": [], "suggestions": []})}
        return {"text": json.dumps({"answer": "好了", "citations": []})}

    runtime = build_runtime(_settings(tmp_path), llm=FakeLLM(script=[script] * 10))
    # 只允许只读工具：提示里出现的建议工具也必须先过允许清单
    task = TaskSpec(goal="查接口", tools_allowed=["http_get"])
    run_once(runtime, task, run_id="run-hint")

    assert execute_prompts, "执行节点应当被调用"
    prompt = execute_prompts[0]
    assert "计划建议使用：http_get" in prompt, prompt
    assert "run_command" not in prompt, "越权的建议工具不能出现在提示里"


def test_reflection_lessons_are_remembered(tmp_path) -> None:
    def script(messages, tools):
        node = _node(messages)
        if node == "plan":
            return {"text": json.dumps({"steps": [{"goal": "改一处配置", "done_when": "生效"}]})}
        if node == "execute":
            return {"text": "这一步不需要工具"}
        if node == "reflect":
            return {
                "text": json.dumps(
                    {
                        "verdict": "done",
                        "reasons": ["改完了"],
                        "lessons": ["改配置前先备份原文件", "改完要跑一次自检"],
                    }
                )
            }
        if node == "critic":
            return {"text": json.dumps({"score": 0.9, "blocking_issues": [], "suggestions": []})}
        return {"text": json.dumps({"answer": "好了", "citations": []})}

    runtime = build_runtime(_settings(tmp_path), llm=FakeLLM(script=[script] * 10))
    run_once(runtime, TaskSpec(goal="改配置"), run_id="run-lessons")

    hits = runtime.memory.search("改配置前先备份原文件", limit=5)
    texts = [hit.text for hit in hits]
    assert any("备份原文件" in text for text in texts), texts
    # 经验要比普通「反思理由」更容易被检索到（importance 0.7 vs 0.5）
    best = max(hits, key=lambda hit: hit.score)
    assert "备份原文件" in best.text, [(hit.text, round(hit.score, 3)) for hit in hits]