"""协议层测试：JSON 解析、观测渲染、上下文预算、结构校验。"""

from __future__ import annotations

import pytest

from agent_pipeline.protocol import (
    Citation,
    Critique,
    MemoryRecord,
    Observation,
    PlanStep,
    ProtocolError,
    TaskSpec,
    build_context,
    idempotency_key,
    parse_json_object,
)


def test_parse_json_object_accepts_plain_fence_and_chatter() -> None:
    assert parse_json_object('{"a": 1}') == {"a": 1}
    assert parse_json_object('```json\n{"a": 2}\n```') == {"a": 2}
    assert parse_json_object('好的，结果如下：{"a": 3} 完毕') == {"a": 3}


@pytest.mark.parametrize("text", ["", "没有 json", "[1,2,3]", "{坏掉的"])
def test_parse_json_object_rejects_bad_input(text: str) -> None:
    with pytest.raises(ProtocolError):
        parse_json_object(text)


def test_observation_render_marks_truncation() -> None:
    observation = Observation(call_id="c1", tool="echo", ok=True, result="x" * 100)
    rendered = observation.render(max_chars=10)
    assert "observation(echo, ok" in rendered
    assert "截断 90 字符" in rendered
    assert observation.dropped_chars == 90


def test_observation_render_marks_error_and_citations() -> None:
    observation = Observation(
        call_id="c1",
        tool="search",
        ok=False,
        error="boom",
        citations=[Citation(doc_id="doc", chunk=2)],
    )
    rendered = observation.render()
    assert "ERROR: boom" in rendered
    assert "[doc#2]" in rendered


def test_plan_step_requires_done_when() -> None:
    with pytest.raises(ProtocolError):
        PlanStep(id=1, goal="做点什么", done_when="")


def test_task_spec_validates_goal_and_coverage() -> None:
    with pytest.raises(ProtocolError):
        TaskSpec(goal="   ")
    with pytest.raises(ProtocolError):
        TaskSpec(goal="x", coverage_target=1.5)


def test_critique_blocking_semantics() -> None:
    assert Critique(score=0.9, blocking_issues=[]).blocking is False
    assert Critique(score=0.4).blocking is True
    assert Critique(score=0.8, blocking_issues=["编译不过"]).blocking is True


def test_memory_record_requires_run_id_and_text() -> None:
    with pytest.raises(ProtocolError):
        MemoryRecord(kind="lesson", text="", run_id="r1")
    with pytest.raises(ProtocolError):
        MemoryRecord(kind="lesson", text="ok", run_id="")


def test_idempotency_key_is_stable_and_order_insensitive() -> None:
    a = idempotency_key("echo", {"x": 1, "y": [1, 2]})
    b = idempotency_key("echo", {"y": [1, 2], "x": 1})
    assert a == b
    assert a != idempotency_key("other", {"x": 1, "y": [1, 2]})


def test_build_context_keeps_system_and_drops_low_priority() -> None:
    task = TaskSpec(goal="修复登录 bug", constraints=["不要改数据库"])
    plan = [PlanStep(id=1, goal="定位", done_when="找到报错行")]
    observations = [Observation(call_id=f"c{i}", tool="echo", ok=True, result="y" * 400) for i in range(6)]
    memories = [MemoryRecord(kind="lesson", text="上次是缓存问题", run_id="r0", importance=0.9, score=0.9)]
    pack = build_context(
        system="你是助手",
        task=task,
        plan=plan,
        observations=observations,
        memories=memories,
        max_chars=800,
    )
    assert "system" in pack.included
    assert "修复登录 bug" in pack.text
    assert pack.dropped, "预算不够时必须显式记录丢弃项"
    assert "system" not in pack.dropped


def test_build_context_drops_old_observations_first() -> None:
    task = TaskSpec(goal="x")
    observations = [Observation(call_id=f"c{i}", tool="echo", ok=True, result="z" * 300) for i in range(8)]
    pack = build_context(system="s", task=task, plan=[], observations=observations, memories=[], max_chars=1000, max_observations=8)
    # 最近一条一定在，较早的会被丢弃
    assert "obs:c7" in pack.included
    assert "obs:c0" in pack.dropped