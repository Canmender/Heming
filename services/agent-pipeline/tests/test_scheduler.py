"""每日调优调度器：把 tune() 变成周期任务后，行为是否仍然可解释、可观测。"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from agent_pipeline.config import PROMPTS, Settings
from agent_pipeline.llm import LLMError, LLMResponse
from agent_pipeline.metrics import Metrics
from agent_pipeline.rollback import ConfigStore
from agent_pipeline.runtime import build_runtime
from agent_pipeline.scheduler import DailyTuner, _prompts_with_proposal, build_replay_evaluator


def _row(*, stop_reason: str | None = None, status: str = "ok", run_id: str = "r1", ago_s: float = 0.0) -> dict:
    return {
        "run_id": run_id,
        "status": status,
        "stop_reason": stop_reason,
        "finished_at": time.time() - ago_s,
        "task": {"goal": "把 README 里的命令跑通并给出结论"},
        "answer": "已经跑通，输出如下：ok。",
        "critiques": [],
        "observations": [],
    }


def _write_log(path: Path, rows: list[dict]) -> Path:
    path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n", encoding="utf-8")
    return path


@pytest.fixture()
def store() -> ConfigStore:
    return ConfigStore(":memory:")


def test_run_once_without_evaluator_only_reports(tmp_path: Path, store: ConfigStore) -> None:
    log = _write_log(tmp_path / "runs.jsonl", [_row(stop_reason="max_steps"), _row(run_id="r2")])
    metrics = Metrics()
    tuner = DailyTuner(
        settings=Settings(log_path=str(log), db_path=":memory:"),
        config_store=store,
        metrics=metrics,
    )

    result = tuner.run_once()

    assert result.error is None
    assert result.report is not None
    assert result.report.failed_runs == 1
    assert result.report.failure_modes == {"max_steps": 1}
    assert result.report.applied_version is None
    # 没有评测器 → 绝不注册新版本（红线：不自动改线上）
    assert store.canary() is None
    assert b'pipeline_tune_runs_total{status="ok"} 1.0' in metrics.expose()


def test_run_once_with_improving_evaluator_registers_canary(tmp_path: Path, store: ConfigStore) -> None:
    log = _write_log(tmp_path / "runs.jsonl", [_row(stop_reason="coverage_gap")])
    scores = {"baseline": 0.7, "candidate": 0.79}

    def evaluator(proposal: dict) -> float:
        return scores["baseline"] if proposal.get("kind") == "baseline" else scores["candidate"]

    tuner = DailyTuner(
        settings=Settings(log_path=str(log), db_path=":memory:"),
        config_store=store,
        evaluator=evaluator,
    )
    result = tuner.run_once()

    assert result.report is not None
    assert result.report.applied_version is not None
    canary = store.canary()
    assert canary is not None and canary.id == result.report.applied_version
    assert canary.payload["tuning"]["score"] == 0.79
    # 提示词本体没被动，只多了一个 tuning 段
    assert canary.payload["prompts"] == dict(PROMPTS)


def test_run_once_without_improvement_does_not_register(tmp_path: Path, store: ConfigStore) -> None:
    log = _write_log(tmp_path / "runs.jsonl", [_row(stop_reason="coverage_gap")])
    tuner = DailyTuner(
        settings=Settings(log_path=str(log), db_path=":memory:"),
        config_store=store,
        evaluator=lambda proposal: 0.7,  # 候选与基线同分
    )

    result = tuner.run_once()

    assert result.report is not None
    assert result.report.applied_version is None
    assert store.canary() is None


def test_error_is_captured_not_raised(tmp_path: Path, store: ConfigStore) -> None:
    log = _write_log(tmp_path / "runs.jsonl", [_row(stop_reason="max_steps")])

    def boom(proposal: dict) -> float:
        raise RuntimeError("评测器挂了")

    metrics = Metrics()
    tuner = DailyTuner(
        settings=Settings(log_path=str(log), db_path=":memory:"),
        config_store=store,
        evaluator=boom,
        metrics=metrics,
    )
    result = tuner.run_once()

    assert result.report is None
    assert result.error is not None and "评测器挂了" in result.error
    assert b'pipeline_tune_runs_total{status="error"} 1.0' in metrics.expose()


def test_metrics_track_candidates_and_applied_version(tmp_path: Path, store: ConfigStore) -> None:
    log = _write_log(tmp_path / "runs.jsonl", [_row(stop_reason="max_steps"), _row(stop_reason="coverage_gap")])
    metrics = Metrics()
    tuner = DailyTuner(
        settings=Settings(log_path=str(log), db_path=":memory:"),
        config_store=store,
        evaluator=lambda proposal: 0.1 if proposal.get("kind") == "baseline" else 0.5,
        metrics=metrics,
    )
    tuner.run_once()

    text = metrics.expose().decode()
    assert "pipeline_tune_candidates 2.0" in text
    assert "pipeline_tune_applied_version 1.0" in text


def test_start_stop_runs_periodically(tmp_path: Path, store: ConfigStore) -> None:
    log = _write_log(tmp_path / "runs.jsonl", [_row(stop_reason="max_steps")])
    metrics = Metrics()
    tuner = DailyTuner(
        settings=Settings(log_path=str(log), db_path=":memory:", tune_interval_s=0.05),
        config_store=store,
        metrics=metrics,
    )

    tuner.start()
    try:
        deadline = time.time() + 5
        while time.time() < deadline:
            if b'pipeline_tune_runs_total{status="ok"}' in metrics.expose():
                break
            time.sleep(0.02)
        assert tuner.running
    finally:
        tuner.stop()

    # 首次是「起来就跑」，不需要等满一个周期
    assert b'pipeline_tune_runs_total{status="ok"} ' in metrics.expose()
    assert not tuner.running


def test_interval_has_floor_of_one_second() -> None:
    tuner = DailyTuner(settings=Settings(tune_interval_s=0.0001), config_store=None)
    assert tuner.interval_s == 1.0


# ---- 回放评测器 -----------------------------------------------------------


class _NodeLLM:
    """按 system 提示词认出节点，永远返回合法 JSON。

    `needs_marker=True` 时：只有提示词里带「这次特别注意」（候选才加）才正常回答，
    否则报错——这样 baseline 全失败、candidate 全成功，直接验证「评测 → 注册灰度」闭环。
    """

    def __init__(self, *, needs_marker: bool = False) -> None:
        self.needs_marker = needs_marker
        self.calls = 0

    def chat(self, messages, *, tools=None, temperature=0.2, max_tokens=2000) -> LLMResponse:
        self.calls += 1
        system = " ".join(str(m.get("content") or "") for m in messages if m.get("role") == "system")
        # 只在规划节点上模拟「现状提示词不够好」：候选会在 plan 提示词末尾追加建议，
        # 所以这条线正好能区分 baseline（0.0）与 candidate（1.0）。
        if self.needs_marker and "规划者" in system and "这次特别注意" not in system:
            raise LLMError("模拟「现状提示词不够好」")
        if "规划者" in system:
            text = json.dumps({"steps": [{"goal": "回答问题", "done_when": "有答复"}]}, ensure_ascii=False)
        elif "反思者" in system:
            text = json.dumps({"verdict": "done", "reasons": ["可以直接回答"]}, ensure_ascii=False)
        elif "评审者" in system:
            text = json.dumps({"score": 0.9, "blocking_issues": []}, ensure_ascii=False)
        elif "摘要者" in system:
            text = json.dumps({"answer": "结论：可以直接回答。"}, ensure_ascii=False)
        elif "实现者" in system:
            text = json.dumps({"summary": "改好了", "changes": ["a.py"]}, ensure_ascii=False)
        elif "测试者" in system:
            text = json.dumps({"bugs": [], "coverage": 0.95}, ensure_ascii=False)
        else:
            text = "不需要工具"
        return LLMResponse(text=text, prompt_tokens=10, completion_tokens=5)


def _runtime_with_llm(tmp_path: Path, llm) -> object:
    settings = Settings(log_path=str(tmp_path / "runs.jsonl"), db_path=":memory:", tune_eval_budget=2)
    return build_runtime(settings, llm=llm)


def test_prompts_with_proposal_appends_few_shots_and_actions() -> None:
    baseline = _prompts_with_proposal({"kind": "baseline"})
    assert baseline == dict(PROMPTS)

    candidate = _prompts_with_proposal(
        {
            "kind": "candidate",
            "few_shots": [{"input": "给 utils.py 补测试", "output": "先跑 pytest --cov，再补缺失分支。"}],
            "candidates": [{"suggestion": "每一步都要可验证"}],
        }
    )
    assert "参考示例" in candidate["execute"] and "pytest --cov" in candidate["execute"]
    assert "这次特别注意" in candidate["plan"] and "可验证" in candidate["plan"]
    # 其它节点提示词不动
    assert candidate["critic"] == PROMPTS["critic"]


def test_replay_evaluator_returns_none_without_failed_rows(tmp_path: Path) -> None:
    runtime = _runtime_with_llm(tmp_path, _NodeLLM())
    _write_log(tmp_path / "runs.jsonl", [_row()])  # 只有成功样本
    evaluate = build_replay_evaluator(runtime, log_path=runtime.settings.log_path)
    assert evaluate({"kind": "baseline"}) is None


def test_replay_evaluator_scores_both_arms_without_touching_real_state(tmp_path: Path) -> None:
    runtime = _runtime_with_llm(tmp_path, _NodeLLM())
    log = _write_log(tmp_path / "runs.jsonl", [_row(stop_reason="max_steps", run_id="bad-1")])

    evaluate = build_replay_evaluator(runtime, log_path=str(log))
    assert evaluate({"kind": "baseline"}) == 1.0
    assert evaluate({"kind": "candidate", "few_shots": [], "candidates": []}) == 1.0

    # 隔离：评测不写线上的日志、不注册版本、不改线上指标
    assert len(log.read_text(encoding="utf-8").strip().splitlines()) == 1
    assert runtime.config_store.canary() is None and runtime.config_store.active() is None


def test_daily_tuner_with_replay_evaluator_registers_canary(tmp_path: Path, store: ConfigStore) -> None:
    runtime = _runtime_with_llm(tmp_path, _NodeLLM(needs_marker=True))
    log = _write_log(tmp_path / "runs.jsonl", [_row(stop_reason="max_steps", run_id="bad-1")])
    evaluate = build_replay_evaluator(runtime, log_path=str(log))
    tuner = DailyTuner(
        settings=runtime.settings,
        config_store=store,
        log_path=str(log),
        evaluator=evaluate,
        metrics=runtime.metrics,
    )

    result = tuner.run_once()

    assert result.report is not None
    # baseline 全失败（0.0）、candidate 全成功（1.0）→ 提升明显，注册灰度
    assert result.report.baseline_score == 0.0
    assert result.report.candidate_score == 1.0
    assert result.report.applied_version is not None
    canary = store.canary()
    assert canary is not None and canary.payload["tuning"]["score"] == 1.0
    assert b"pipeline_tune_applied_version" in runtime.metrics.expose()
