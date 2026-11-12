"""tools_allowed 是硬约束：模型发出的工具不在允许范围里就不能执行。

为什么单独测：`execute_node` 下发 schema 时会按 `tools_allowed` 过滤，但模型仍可能凭上下文
（尤其是上一轮对话里见过的写工具）发出别的名字。以前执行侧只校验「工具注册过没有」，
于是限制成只读工具的一次 run 依然能真的跑 `run_command` —— 协议承诺和实际行为不一致。
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


def test_disallowed_tool_is_not_executed(tmp_path) -> None:
    seen_schema: list[list[str]] = []
    execute_rounds = {"n": 0}

    def script(messages, tools):
        node = _node(messages)
        if node == "plan":
            return {"text": json.dumps({"steps": [{"goal": "跑个命令", "done_when": "看到输出"}]})}
        if node == "execute":
            seen_schema.append([str(t.get("function", {}).get("name")) for t in (tools or [])])
            execute_rounds["n"] += 1
            if execute_rounds["n"] == 1:
                # 模型越过 tools_allowed 直接点写工具
                return {"text": "", "tool_calls": [{"id": "call_1", "name": "run_command", "arguments": json.dumps({"command": "echo 已执行"})}]}
            return {"text": "这一步不需要更多工具了"}
        if node == "reflect":
            return {"text": json.dumps({"verdict": "done", "reasons": ["够了"]})}
        if node == "critic":
            return {"text": json.dumps({"score": 0.9, "blocking_issues": [], "suggestions": []})}
        return {"text": json.dumps({"answer": "没跑成", "citations": []})}

    runtime = build_runtime(_settings(tmp_path), llm=FakeLLM(script=[script] * 12))
    task = TaskSpec(goal="只允许只读工具", tools_allowed=["http_get"])
    result, _row = run_once(runtime, task, run_id="run-tools-allowed")

    # schema 只下发了被允许的那个
    assert seen_schema and seen_schema[0] == ["http_get"], f"下发给模型的工具应当被过滤：{seen_schema}"

    # 执行侧也必须拒绝，并在观测里说清原因（模型下一轮能看到）
    disallowed = [obs for obs in result.observations if obs.tool == "run_command"]
    assert disallowed, f"应当留下一条拒绝观测：{[obs.to_dict() for obs in result.observations]}"
    assert disallowed[0].ok is False
    assert "不在本次允许的范围" in (disallowed[0].error or "")
    assert "http_get" in (disallowed[0].error or "")


def test_allowed_tool_still_runs(tmp_path) -> None:
    """收紧之后不能把正常路径也堵死：允许的只读工具照常执行。"""
    execute_rounds = {"n": 0}

    def script(messages, tools):
        node = _node(messages)
        if node == "plan":
            return {"text": json.dumps({"steps": [{"goal": "查一下", "done_when": "有结果"}]})}
        if node == "execute":
            execute_rounds["n"] += 1
            if execute_rounds["n"] == 1:
                return {"text": "", "tool_calls": [{"id": "call_1", "name": "http_get", "arguments": json.dumps({"url": "http://127.0.0.1:9"})}]}
            return {"text": "查完了"}
        if node == "reflect":
            return {"text": json.dumps({"verdict": "done", "reasons": ["ok"]})}
        if node == "critic":
            return {"text": json.dumps({"score": 0.9, "blocking_issues": [], "suggestions": []})}
        return {"text": json.dumps({"answer": "查过了", "citations": []})}

    runtime = build_runtime(_settings(tmp_path), llm=FakeLLM(script=[script] * 12))
    task = TaskSpec(goal="只允许只读工具", tools_allowed=["http_get"])
    result, _row = run_once(runtime, task, run_id="run-allowed")

    observations = [obs for obs in result.observations if obs.tool == "http_get"]
    assert observations, "允许的工具应当被执行（哪怕目标地址连不上，也是 ok=False 的真实观测）"
    assert "不在本次允许的范围" not in (observations[0].error or "")