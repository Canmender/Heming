"""对抗模式的覆盖率命令要真的跑在任务目录里（HTTP 服务以前永远没有 runner）。"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from agent_pipeline.config import Settings
from agent_pipeline.protocol import TaskSpec
from agent_pipeline.runtime import run_once
from agent_pipeline.service import create_app


def _json(payload: dict) -> dict:
    return {"text": json.dumps(payload, ensure_ascii=False)}


def _adversarial_script(coverage_rounds: int, *, bugs_per_round: list[list[dict]]) -> list[dict]:
    """plan → execute → reflect done → critic 不过 → coverage 轮…→ 通过的 critic → summarize。"""
    script: list[dict] = [
        _json({"steps": [{"goal": "把测试补到目标覆盖率", "done_when": "覆盖率达标"}]}),
        {"text": "实现完成"},
        _json({"verdict": "done", "reasons": ["代码就绪"]}),
        _json({"score": 0.5, "blocking_issues": ["覆盖率不足"]}),
    ]
    for index in range(coverage_rounds):
        script.append(_json({"summary": f"第 {index + 1} 轮实现"}))
        script.append(_json({"bugs": bugs_per_round[index]}))
    # 达标后 route_after_adversarial 会回到 critic 再评一次，通过了才 summarize。
    script.append(_json({"score": 0.9, "blocking_issues": []}))
    script.append(_json({"answer": "完成", "citations": []}))
    return script


def test_factory_runner_is_bound_to_the_task_cwd(runtime_factory) -> None:
    """服务端按请求 cwd 现建 runner：它必须拿到 TaskSpec.cwd，而不是启动目录。"""
    seen: list[str | None] = []

    def factory(cwd: str | None):
        seen.append(cwd)

        def runner() -> dict:
            return {"coverage": 0.95, "output": "TOTAL 95%", "ok": True}

        return runner

    runtime = runtime_factory(_adversarial_script(1, bugs_per_round=[[]]))
    runtime.coverage_factory = factory

    result, row = run_once(
        runtime,
        TaskSpec(goal="覆盖率拉满", cwd="D:/repo", mode="adversarial", coverage_target=0.9),
    )

    assert seen == ["D:/repo"], f"runner 必须在任务目录里跑，实际拿到 {seen}"
    assert row["coverage"] == 0.95
    assert row["stop_reason"] is None, "达标且无缺陷应当正常收口"
    assert result.status == "ok"


def test_factory_runner_is_reused_for_the_same_cwd(runtime_factory) -> None:
    """同一个任务目录的对抗轮要复用同一份 runner（不能每轮重新起子进程）。"""
    builds: list[str | None] = []
    reports = [
        {"coverage": 0.5, "output": "TOTAL 50%", "ok": True},
        {"coverage": 0.95, "output": "TOTAL 95%", "ok": True},
    ]

    def factory(cwd: str | None):
        builds.append(cwd)
        queue = list(reports)

        def runner() -> dict:
            return queue.pop(0) if queue else {"coverage": 0.95, "output": "TOTAL 95%", "ok": True}

        return runner

    runtime = runtime_factory(
        _adversarial_script(
            2,
            bugs_per_round=[[{"case": "缺少边界用例"}], []],
        )
    )
    runtime.coverage_factory = factory

    _, row = run_once(
        runtime,
        TaskSpec(goal="补测试", cwd="D:/repo", mode="adversarial", coverage_target=0.9),
    )

    assert builds == ["D:/repo"], f"同一目录只该建一次 runner，实际 {builds}"
    assert row["adversarial_round"] == 2
    assert row["coverage"] == 0.95


def test_service_rejects_adversarial_without_coverage_command(runtime_factory) -> None:
    """没接覆盖率命令时，对抗模式在提交阶段就被拒——否则只会空耗两轮模型。"""
    runtime = runtime_factory(["ok"] * 8)
    with TestClient(create_app(runtime=runtime)) as client:
        health = client.get("/health").json()
        assert health["coverage_command"] == "off"

        response = client.post("/v1/runs", json={"goal": "做个功能", "mode": "adversarial"})
        assert response.status_code == 422, response.text
        assert "AGENT_COVERAGE_COMMAND" in response.json()["detail"]
        assert runtime.coverage_factory is None


def test_service_wires_coverage_command_from_settings(runtime_factory) -> None:
    """配了 AGENT_COVERAGE_COMMAND 之后，服务把它变成按目录现建的 runner。"""
    settings = Settings(coverage_command="pytest -q --cov=src")
    runtime = runtime_factory(["ok"] * 8, settings=settings)
    with TestClient(create_app(runtime=runtime)) as client:
        assert runtime.coverage_factory is not None
        assert client.get("/health").json()["coverage_command"] == "configured"

        response = client.post("/v1/runs", json={"goal": "做个功能", "mode": "adversarial"})
        assert response.status_code == 202, response.text