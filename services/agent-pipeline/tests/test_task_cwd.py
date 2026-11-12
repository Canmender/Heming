"""`TaskSpec.cwd` 必须真的决定命令在哪个目录里跑。

以前提示里写着「工作目录：<cwd>」，但 `run_command` 总是在服务进程自己的目录里执行——
模型以为自己在项目目录里改文件，实际写到了服务的工作目录，而且日志里看不出异常。
"""

from __future__ import annotations

import json
import os
from dataclasses import replace

import pytest

from agent_pipeline.config import Settings
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


@pytest.mark.skipif(os.name != "nt" and False, reason="命令取当前目录在各平台都支持")
def test_run_command_uses_task_cwd(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("AGENT_PIPELINE_ALLOW_COMMANDS", "1")
    work = tmp_path / "proj"
    work.mkdir()
    execute_rounds = {"n": 0}

    def script(messages, tools):
        node = _node(messages)
        if node == "plan":
            return {"text": json.dumps({"steps": [{"goal": "看当前目录", "done_when": "看到路径"}]})}
        if node == "execute":
            execute_rounds["n"] += 1
            if execute_rounds["n"] == 1:
                # 模型不写 cwd，靠任务的 cwd 兜底
                return {"text": "", "tool_calls": [{"id": "call_1", "name": "run_command", "arguments": {"command": "cd"}}]}
            return {"text": "看完了"}
        if node == "reflect":
            return {"text": json.dumps({"verdict": "done", "reasons": ["够了"]})}
        if node == "critic":
            return {"text": json.dumps({"score": 0.9, "blocking_issues": [], "suggestions": []})}
        return {"text": json.dumps({"answer": "好", "citations": []})}

    settings = replace(Settings(db_path=":memory:", log_path=str(tmp_path / "runs.jsonl")))
    runtime = build_runtime(settings, llm=FakeLLM(script=[script] * 10))
    task = TaskSpec(goal="看当前目录", cwd=str(work))
    result, _row = run_once(runtime, task, run_id="run-cwd")

    obs = [item for item in result.observations if item.tool == "run_command"]
    assert obs, [item.to_dict() for item in result.observations]
    assert obs[0].ok is True, obs[0].error
    stdout = str(obs[0].result.get("stdout", ""))
    assert str(work).split("\\")[-1] in stdout, stdout


def test_run_command_keeps_explicit_cwd(tmp_path, monkeypatch) -> None:
    """模型自己给了 cwd 时不能被任务 cwd 覆盖。"""
    monkeypatch.setenv("AGENT_PIPELINE_ALLOW_COMMANDS", "1")
    task_dir = tmp_path / "task"
    explicit = tmp_path / "explicit"
    task_dir.mkdir()
    explicit.mkdir()
    execute_rounds = {"n": 0}

    def script(messages, tools):
        node = _node(messages)
        if node == "plan":
            return {"text": json.dumps({"steps": [{"goal": "看目录", "done_when": "看到"}]})}
        if node == "execute":
            execute_rounds["n"] += 1
            if execute_rounds["n"] == 1:
                return {
                    "text": "",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "name": "run_command",
                            "arguments": {"command": "cd", "cwd": str(explicit)},
                        }
                    ],
                }
            return {"text": "看完了"}
        if node == "reflect":
            return {"text": json.dumps({"verdict": "done", "reasons": ["够了"]})}
        if node == "critic":
            return {"text": json.dumps({"score": 0.9, "blocking_issues": [], "suggestions": []})}
        return {"text": json.dumps({"answer": "好", "citations": []})}

    settings = replace(Settings(db_path=":memory:", log_path=str(tmp_path / "runs.jsonl")))
    runtime = build_runtime(settings, llm=FakeLLM(script=[script] * 10))
    result, _row = run_once(runtime, TaskSpec(goal="看目录", cwd=str(task_dir)), run_id="run-cwd-explicit")

    obs = [item for item in result.observations if item.tool == "run_command"]
    stdout = str(obs[0].result.get("stdout", ""))
    assert explicit.name in stdout, stdout
    assert task_dir.name not in stdout, stdout

def test_string_arguments_are_parsed(tmp_path, monkeypatch) -> None:
    """有的客户端把 arguments 原样给成 JSON 字符串；以前会被当空 dict，报「$ 是必填字段」。"""
    monkeypatch.setenv("AGENT_PIPELINE_ALLOW_COMMANDS", "1")
    work = tmp_path / "proj2"
    work.mkdir()
    rounds = {"n": 0}

    def script(messages, tools):
        node = _node(messages)
        if node == "plan":
            return {"text": json.dumps({"steps": [{"goal": "看目录", "done_when": "看到"}]})}
        if node == "execute":
            rounds["n"] += 1
            if rounds["n"] == 1:
                return {"text": "", "tool_calls": [{"id": "call_1", "name": "run_command", "arguments": "{\"command\": \"cd\"}"}]}
            return {"text": "看完了"}
        if node == "reflect":
            return {"text": json.dumps({"verdict": "done", "reasons": ["够了"]})}
        if node == "critic":
            return {"text": json.dumps({"score": 0.9, "blocking_issues": [], "suggestions": []})}
        return {"text": json.dumps({"answer": "好", "citations": []})}

    settings = replace(Settings(db_path=":memory:", log_path=str(tmp_path / "runs.jsonl")))
    runtime = build_runtime(settings, llm=FakeLLM(script=[script] * 10))
    result, _row = run_once(runtime, TaskSpec(goal="看目录", cwd=str(work)), run_id="run-args-str")

    obs = [item for item in result.observations if item.tool == "run_command"]
    assert obs[0].ok is True, obs[0].error
    assert "proj2" in str(obs[0].result.get("stdout", ""))


def test_broken_arguments_report_a_clear_error(tmp_path) -> None:
    rounds = {"n": 0}

    def script(messages, tools):
        node = _node(messages)
        if node == "plan":
            return {"text": json.dumps({"steps": [{"goal": "调工具", "done_when": "有观测"}]})}
        if node == "execute":
            rounds["n"] += 1
            if rounds["n"] == 1:
                return {"text": "", "tool_calls": [{"id": "call_1", "name": "http_get", "arguments": "{不是 JSON"}]}
            return {"text": "算了"}
        if node == "reflect":
            return {"text": json.dumps({"verdict": "done", "reasons": ["够了"]})}
        if node == "critic":
            return {"text": json.dumps({"score": 0.9, "blocking_issues": [], "suggestions": []})}
        return {"text": json.dumps({"answer": "好", "citations": []})}

    settings = replace(Settings(db_path=":memory:", log_path=str(tmp_path / "runs.jsonl")))
    runtime = build_runtime(settings, llm=FakeLLM(script=[script] * 10))
    result, _row = run_once(runtime, TaskSpec(goal="调工具"), run_id="run-args-bad")

    obs = [item for item in result.observations if item.tool == "http_get"]
    assert obs and obs[0].ok is False
    assert "不是合法 JSON" in (obs[0].error or ""), obs[0].error
