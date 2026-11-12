"""对抗环（Coder ↔ Tester）的行为测试：上下文要带上一轮证据，覆盖率命令坏掉要早收口。"""

from __future__ import annotations

import json

from agent_pipeline.protocol import TaskSpec
from agent_pipeline.runtime import run_once


def _json(payload: dict) -> dict:
    return {"text": json.dumps(payload, ensure_ascii=False)}


def _coder_prompt(runtime, index: int) -> str:
    """取第 index 次模型调用的用户内容拼接（coder 轮的 brief 在这里）。"""
    call = runtime.llm.calls[index]
    return "\n".join(str(message.get("content", "")) for message in call["messages"])


def test_coder_sees_previous_coverage_and_test_output(runtime_factory) -> None:
    reports = [
        {"coverage": 0.4, "output": "TOTAL 40%\nFAILED test_edge_case", "ok": True},
        {"coverage": 0.45, "output": "TOTAL 45%", "ok": True},
    ]

    def coverage_runner() -> dict:
        return reports.pop(0)

    script = [
        _json({"steps": [{"goal": "补齐测试", "done_when": "覆盖率 >= 90%"}]}),
        {"text": "实现完成"},
        _json({"verdict": "done", "reasons": ["功能可用"]}),
        _json({"score": 0.5, "blocking_issues": ["覆盖率不足"]}),
        _json({"summary": "补边界用例"}),
        _json({"bugs": [{"case": "test_edge_case 没有断言异常分支", "detail": "assert 缺失"}]}),
        _json({"summary": "按上一轮反馈再补"}),
        _json({"bugs": []}),
        _json({"answer": "尽力了", "citations": []}),
    ]
    runtime = runtime_factory(script, coverage_runner=coverage_runner)

    result, row = run_once(
        runtime,
        TaskSpec(goal="覆盖率尽量拉满", cwd=".", mode="adversarial", coverage_target=0.9),
    )

    # 第二轮 Coder 的上下文必须包含上一轮的覆盖率、测试输出尾部与缺陷描述，
    # 否则它只能凭空猜「哪里还没测到」。
    second_coder = _coder_prompt(runtime, 6)
    assert "上一轮覆盖率：0.4" in second_coder
    assert "TOTAL 40%" in second_coder
    assert "test_edge_case 没有断言异常分支" in second_coder

    assert row["adversarial_round"] == 2
    assert row["coverage"] == 0.45
    assert row["stop_reason"] == "coverage_gap", "两轮没达标应按翻轮上限收口"
    assert result.status == "ok"


def test_broken_coverage_command_stops_after_two_rounds(runtime_factory) -> None:
    def coverage_runner() -> dict:
        return {"coverage": None, "output": "pytest: command not found", "ok": False}

    script = [
        _json({"steps": [{"goal": "跑覆盖率", "done_when": "有覆盖率数字"}]}),
        {"text": "写完了"},
        _json({"verdict": "done", "reasons": ["代码就绪"]}),
        _json({"score": 0.5, "blocking_issues": ["还没覆盖率"]}),
        _json({"summary": "第一轮"}),
        _json({"bugs": []}),
        _json({"summary": "第二轮"}),
        _json({"bugs": []}),
        _json({"answer": "覆盖率命令不可用", "citations": []}),
    ]
    runtime = runtime_factory(script, coverage_runner=coverage_runner)

    result, row = run_once(
        runtime,
        TaskSpec(goal="覆盖率统计", cwd=".", mode="adversarial"),
    )

    # 命令本身坏掉时不能硬耗满 max_adversarial_rounds（默认 2 轮是够的，但配大就会白烧钱）。
    assert row["adversarial_round"] == 2
    assert row["stop_reason"] == "coverage_command_failed"
    assert row["coverage"] is None
    assert result.status == "ok"
    # 池子里的模型调用没有被拉空：脚本共 9 条，实际只用到 9 条（含收尾 summarize）
    assert len(runtime.llm.calls) == 9


def test_custom_max_rounds_still_bounded(runtime_factory) -> None:
    """把轮数上限调大也不能无限转：坏命令两轮就收口。"""
    from dataclasses import replace

    def coverage_runner() -> dict:
        return {"coverage": None, "output": "boom", "ok": False}

    script = [
        _json({"steps": [{"goal": "跑覆盖率", "done_when": "有数字"}]}),
        {"text": "写完了"},
        _json({"verdict": "done", "reasons": ["就绪"]}),
        _json({"score": 0.5, "blocking_issues": ["缺覆盖率"]}),
        _json({"summary": "一"}),
        _json({"bugs": []}),
        _json({"summary": "二"}),
        _json({"bugs": []}),
        _json({"answer": "命令坏了", "citations": []}),
    ]
    runtime = runtime_factory(script, coverage_runner=coverage_runner)
    runtime.settings = replace(
        runtime.settings,
        budget=replace(runtime.settings.budget, max_adversarial_rounds=8),
    )

    _result, row = run_once(runtime, TaskSpec(goal="覆盖率", cwd=".", mode="adversarial"))

    assert row["adversarial_round"] == 2
    assert row["stop_reason"] == "coverage_command_failed"