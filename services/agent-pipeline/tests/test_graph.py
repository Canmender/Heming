"""状态机端到端测试（FakeLLM，无网络）：react / replan / 对抗 / 预算。"""

from __future__ import annotations

import json
from pathlib import Path

from agent_pipeline.config import Settings
from agent_pipeline.protocol import TaskSpec
from agent_pipeline.runtime import run_once
from agent_pipeline.tools import ToolSpec


def _echo_spec() -> ToolSpec:
    return ToolSpec(
        name="echo",
        description="回显文本",
        schema={
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
            "additionalProperties": False,
        },
        risk="read",
        handler=lambda args: f"echo:{args['text']}",
    )


def _json(payload: dict) -> dict:
    return {"text": json.dumps(payload, ensure_ascii=False)}


def test_react_happy_path_runs_tool_then_answers(runtime_factory, tmp_path) -> None:
    script = [
        _json({"steps": [{"goal": "拿到工具输出", "done_when": "观测里出现 echo:hi"}]}),
        {"text": "先查一下", "tool_calls": [{"id": "c1", "name": "echo", "arguments": {"text": "hi"}}]},
        {"text": "已经拿到了"},
        _json({"verdict": "done", "reasons": ["观测里有 echo:hi"]}),
        _json({"score": 0.9, "blocking_issues": []}),
        _json({"answer": "结论：hi", "citations": []}),
    ]
    runtime = runtime_factory(script, tools=[_echo_spec()])

    result, row = run_once(runtime, TaskSpec(goal="验证工具链路", cwd="."))

    assert result.status == "ok"
    assert result.answer == "结论：hi"
    assert result.observations and result.observations[0].call_id == "c1"
    assert result.observations[0].ok is True
    assert result.observations[0].tool == "echo"
    assert result.llm_calls == 6
    assert row["status"] == "ok"
    assert row["task"]["goal"] == "验证工具链路"

    log_file = Path(runtime.settings.log_path)
    assert log_file.exists(), "每个 run 必须落一行日志（调优的数据来源）"
    assert len(log_file.read_text(encoding="utf-8").strip().splitlines()) == 1

    metrics = runtime.metrics.expose().decode("utf-8")
    assert 'pipeline_runs_total{status="ok"} 1.0' in metrics
    assert "pipeline_node_duration_seconds" in metrics
    assert len(runtime.llm.calls) == 6


def test_replan_resets_plan_and_keeps_going(runtime_factory) -> None:
    script = [
        _json({"steps": [{"goal": "旧计划", "done_when": "不可验证"}]}),
        {"text": "这一步不需要工具"},
        _json({"verdict": "replan", "reasons": ["完成条件不可验证"], "next_step": 0}),
        _json({"steps": [{"goal": "新计划", "done_when": "有可观测证据"}]}),
        {"text": "新计划也不需要工具"},
        _json({"verdict": "done", "reasons": ["证据充分"]}),
        _json({"score": 0.85, "blocking_issues": []}),
        _json({"answer": "按新计划完成", "citations": []}),
    ]
    runtime = runtime_factory(script)

    result, row = run_once(runtime, TaskSpec(goal="计划被打回后重规划", cwd="."))

    assert result.status == "ok"
    assert result.answer == "按新计划完成"
    assert row["replans"] == 1
    assert len(result.reflections) == 2
    assert result.reflections[0].verdict == "replan"


def test_adversarial_loop_uses_real_coverage(runtime_factory) -> None:
    reports = [
        {"coverage": 0.5, "output": "TOTAL 50%", "ok": True},
        {"coverage": 0.95, "output": "TOTAL 95%", "ok": True},
    ]

    def coverage_runner() -> dict:
        return reports.pop(0)

    script = [
        _json({"steps": [{"goal": "实现并测到位", "done_when": "覆盖率 >= 90%"}]}),
        {"text": "实现完成"},
        _json({"verdict": "done", "reasons": ["功能可用"]}),
        _json({"score": 0.5, "blocking_issues": ["覆盖率不足"]}),
        _json({"summary": "补齐分支测试"}),
        _json({"bugs": []}),
        _json({"summary": "再补边界用例"}),
        _json({"bugs": []}),
        _json({"score": 0.92, "blocking_issues": []}),
        _json({"answer": "覆盖率达标", "citations": []}),
    ]
    runtime = runtime_factory(script, coverage_runner=coverage_runner)

    result, row = run_once(
        runtime,
        TaskSpec(goal="把覆盖率拉到 90% 以上", cwd=".", mode="adversarial", coverage_target=0.9),
    )

    assert result.status == "ok"
    assert result.coverage == 0.95
    assert row["adversarial_round"] == 2
    assert row["adversarial_passed"] is True
    assert result.answer == "覆盖率达标"


def test_budget_exhaustion_does_not_call_model_again(runtime_factory, tmp_path) -> None:
    settings = Settings(log_path=str(tmp_path / "runs.jsonl"), db_path=":memory:").with_budget(max_llm_calls=2)
    script = [
        _json({"steps": [{"goal": "先做第一步", "done_when": "有观测"}]}),
        {"text": "第一步完成"},
    ]
    runtime = runtime_factory(script, settings=settings)

    result, row = run_once(runtime, TaskSpec(goal="预算很小的任务", cwd="."))

    assert result.status == "budget"
    assert "预算已用尽" in result.answer
    assert len(runtime.llm.calls) == 2, "预算耗尽后不能再调模型（否则预算形同虚设）"
    assert row["stop_reason"] == "llm_calls"