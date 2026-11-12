"""环境变量解析与预算收口：容器里只靠 env 配置，解析错了就是「配了但没生效」。

这几条以前只在部署文档里写「支持 AGENT_*」，没有测试钉住非法值的行为——
非法值应该回落到默认，而不是抛异常把服务起不来。
"""

from __future__ import annotations

import pytest

from agent_pipeline.config import Budget, Settings


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("42", 42), (" 7 ", 7), ("", 5000), ("abc", 5000), ("3.5", 5000)],
)
def test_env_int_falls_back_on_garbage(monkeypatch, raw: str, expected: int) -> None:
    monkeypatch.setenv("AGENT_MAX_EPISODES", raw)
    assert Settings.from_env().max_episodes == expected


@pytest.mark.parametrize(("raw", "expected"), [("1", True), ("true", True), ("YES", True), ("on", True), ("0", False), ("no", False), ("", False)])
def test_env_bool_accepts_common_spellings(monkeypatch, raw: str, expected: bool) -> None:
    monkeypatch.setenv("AGENT_TUNE_ENABLED", raw)
    assert Settings.from_env().tune_enabled is expected


@pytest.mark.parametrize(("raw", "expected"), [("120.5", 120.5), ("", 300.0), ("abc", 300.0)])
def test_env_float_falls_back_on_garbage(monkeypatch, raw: str, expected: float) -> None:
    monkeypatch.setenv("AGENT_APPROVAL_TIMEOUT_S", raw)
    assert Settings.from_env().approval_timeout_s == expected


def test_from_env_reads_the_documented_names(monkeypatch) -> None:
    """名字必须与 Dockerfile/README 一致——上一轮就是这里对不上（AGENT_LOG_PATH）。"""
    monkeypatch.setenv("AGENT_LOG_PATH", "C:/data/runs.jsonl")
    monkeypatch.setenv("AGENT_PIPELINE_DB", "C:/data/pipeline.db")
    monkeypatch.setenv("AGENT_CANARY_RATIO", "0.25")
    monkeypatch.setenv("AGENT_MAX_CONCURRENCY", "2")
    monkeypatch.setenv("AGENT_APPROVAL_MODE", "write")
    settings = Settings.from_env()
    assert settings.log_path == "C:/data/runs.jsonl"
    assert settings.db_path == "C:/data/pipeline.db"
    assert settings.canary_ratio == 0.25
    assert settings.max_concurrent_runs == 2
    assert settings.approval_mode == "write"


def test_with_budget_overrides_only_given_fields() -> None:
    settings = Settings()
    tighter = settings.with_budget(max_llm_calls=3, max_wall_clock_s=30)
    assert tighter.budget.max_llm_calls == 3
    assert tighter.budget.max_wall_clock_s == 30
    assert tighter.budget.max_steps == settings.budget.max_steps
    assert settings.budget.max_llm_calls == Budget().max_llm_calls, "原设置不能被改动"


def test_approval_mode_defaults_to_off() -> None:
    assert Settings().approval_mode == "off"