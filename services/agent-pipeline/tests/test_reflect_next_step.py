"""Reflect 的 next_step 要真的改变「下一步做哪个」。

协议里有 ``Reflection.next_step``，提示词也要求模型输出它；但实现里只把它存进反思记录，
执行者仍按 step_index 顺序往下走。结果是计划里写「先查证再做决定」时，模型明确说
「先去第 3 步」也不会有任何效果——ReAct 的 Reflect 只当了个记分牌。
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


def test_reflect_can_jump_to_a_later_step(tmp_path) -> None:
    execute_prompts: list[str] = []
    rounds = {"execute": 0, "reflect": 0}

    def script(messages, tools):
        node = _node(messages)
        if node == "plan":
            return {
                "text": json.dumps(
                    {
                        "steps": [
                            {"goal": "步骤甲", "done_when": "甲完成"},
                            {"goal": "步骤乙", "done_when": "乙完成"},
                            {"goal": "步骤丙", "done_when": "丙完成"},
                        ]
                    }
                )
            }
        if node == "execute":
            rounds["execute"] += 1
            if rounds["execute"] == 1:
                execute_prompts.append("\n".join(str(m.get("content", "")) for m in messages))
                return {"text": "这一步不需要工具"}
            # 第二轮执行：只记录它当前被告知做哪一步
            execute_prompts.append("\n".join(str(m.get("content", "")) for m in messages))
            return {"text": "完成"}
        if node == "reflect":
            rounds["reflect"] += 1
            if rounds["reflect"] == 1:
                # 第一次反思：跳过「步骤乙」，直接去第 3 步（下标 2）
                return {"text": json.dumps({"verdict": "continue", "reasons": ["乙可以晚点做"], "next_step": 2})}
            return {"text": json.dumps({"verdict": "done", "reasons": ["收口"]})}
        if node == "critic":
            return {"text": json.dumps({"score": 0.9, "blocking_issues": [], "suggestions": []})}
        return {"text": json.dumps({"answer": "做完了", "citations": []})}

    runtime = build_runtime(_settings(tmp_path), llm=FakeLLM(script=[script] * 12))
    result, _row = run_once(runtime, TaskSpec(goal="三步任务"), run_id="run-next-step")

    assert len(execute_prompts) >= 2, execute_prompts
    # 第一次执行做的是步骤甲
    assert "步骤甲" in execute_prompts[0]
    # 跳转后第二次执行必须落在步骤丙，而不是按顺序的步骤乙
    # （计划清单里仍会列出「步骤乙」的 pending 状态，所以只看「当前步骤」那一行）
    current = [line for line in execute_prompts[1].splitlines() if line.startswith("当前步骤")]
    assert current and "步骤丙" in current[0], current or execute_prompts[1]
    assert "步骤乙" not in current[0], current
    assert result.status == "ok"


def test_next_step_to_a_done_step_is_ignored(tmp_path) -> None:
    """反思指回一个已完成的步骤不能造成原地打转：跳过它，按当前进度继续。"""
    execute_prompts: list[str] = []
    rounds = {"execute": 0, "reflect": 0}

    def script(messages, tools):
        node = _node(messages)
        if node == "plan":
            return {
                "text": json.dumps(
                    {
                        "steps": [
                            {"goal": "步骤甲", "done_when": "甲完成"},
                            {"goal": "步骤乙", "done_when": "乙完成"},
                        ]
                    }
                )
            }
        if node == "execute":
            rounds["execute"] += 1
            execute_prompts.append("\n".join(str(m.get("content", "")) for m in messages))
            return {"text": "这一步不需要工具"}
        if node == "reflect":
            rounds["reflect"] += 1
            if rounds["reflect"] <= 2:
                # 死盯已完成的第 1 步（下标 0）
                return {"text": json.dumps({"verdict": "continue", "reasons": ["再确认下"], "next_step": 0})}
            return {"text": json.dumps({"verdict": "done", "reasons": ["收口"]})}
        if node == "critic":
            return {"text": json.dumps({"score": 0.9, "blocking_issues": [], "suggestions": []})}
        return {"text": json.dumps({"answer": "做完了", "citations": []})}

    runtime = build_runtime(_settings(tmp_path), llm=FakeLLM(script=[script] * 12))
    result, _row = run_once(runtime, TaskSpec(goal="两步任务"), run_id="run-next-step-done")

    # 不能因为「指向已完成的步骤」就不推进：至少走到过步骤乙
    assert any("步骤乙" in prompt for prompt in execute_prompts), execute_prompts
    assert result.status == "ok"