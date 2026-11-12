"""日志驱动调优测试：读日志、聚类失败模式、候选评估、灰度注册。"""

from __future__ import annotations

import json
import time
from pathlib import Path

from agent_pipeline.rollback import ConfigStore
from agent_pipeline.tune import build_candidates, read_logs, tune


def _row(*, run_id: str, status: str = "ok", stop_reason: str | None = None, goal: str = "", answer: str = "") -> dict:
    return {
        "run_id": run_id,
        "status": status,
        "stop_reason": stop_reason,
        "task": {"goal": goal},
        "answer": answer,
        "observations": [],
        "created_at": time.time(),
        "finished_at": time.time(),
    }


def _write_log(path: Path, rows: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n", encoding="utf-8")


def test_read_logs_filters_by_window(tmp_path: Path) -> None:
    path = tmp_path / "runs.jsonl"
    now = time.time()
    old = _row(run_id="old", goal="旧任务")
    old["created_at"] = now - 3 * 3600
    old["finished_at"] = now - 3 * 3600
    fresh = _row(run_id="fresh", goal="新任务")
    fresh["created_at"] = now - 60
    fresh["finished_at"] = now - 60
    _write_log(path, [old, fresh])

    rows = read_logs(path, since_hours=1, now=now)
    assert [row["run_id"] for row in rows] == ["fresh"]
    assert read_logs(tmp_path / "missing.jsonl") == []


def test_classify_and_candidates(tmp_path: Path) -> None:
    rows = [
        _row(run_id="r1", status="budget", stop_reason="max_steps"),
        _row(run_id="r2", status="ok", stop_reason="max_steps"),
        _row(run_id="r3", status="error", stop_reason=None),
        _row(run_id="r4", goal="修复登录 bug 并补测试"),
    ]
    rows[-1]["answer"] = "已修复登录问题，并补充了三个回归测试用例。"
    modes, candidates, few_shots = build_candidates(rows)
    assert modes["max_steps"] == 2
    assert modes["error"] == 1
    assert {c["mode"] for c in candidates} == {"max_steps", "error"}
    assert few_shots == [{"input": "修复登录 bug 并补测试", "output": "已修复登录问题，并补充了三个回归测试用例。"}]


def test_tune_without_evaluator_is_report_only(tmp_path: Path) -> None:
    path = tmp_path / "runs.jsonl"
    _write_log(path, [_row(run_id="r1", stop_reason="llm_calls"), _row(run_id="r2")])
    report = tune(log_path=path)
    assert report.total_runs == 2
    assert report.failed_runs == 1
    assert report.applied_version is None
    assert report.failure_modes["llm_calls"] == 1


def test_tune_registers_canary_when_evaluator_improves(tmp_path: Path) -> None:
    path = tmp_path / "runs.jsonl"
    out_path = tmp_path / "tune" / "report.json"
    _write_log(
        path,
        [
            _row(run_id="r1", stop_reason="max_steps"),
            _row(run_id="r2", goal="加一个 API 限流"),
            _row(run_id="r3", goal="补覆盖率"),
        ],
    )
    store = ConfigStore(":memory:")
    store.register({"prompts": {"plan": "base"}})

    def evaluator(payload: dict) -> float:
        return 0.58 if payload.get("kind") == "baseline" else 0.71

    report = tune(
        log_path=path,
        out_path=out_path,
        evaluator=evaluator,
        config_store=store,
        current_payload={"prompts": {"plan": "base"}},
    )
    assert report.baseline_score == 0.58
    assert report.candidate_score == 0.71
    assert report.applied_version is not None
    assert store.canary() is not None, "新配置先进灰度，不能直接顶掉线上"
    assert store.canary().id == report.applied_version
    assert out_path.exists()
    saved = json.loads(out_path.read_text(encoding="utf-8"))
    assert saved["applied_version"] == report.applied_version
    store.close()


def test_tune_skips_registration_when_no_improvement(tmp_path: Path) -> None:
    path = tmp_path / "runs.jsonl"
    _write_log(path, [_row(run_id="r1", stop_reason="max_steps")])
    store = ConfigStore(":memory:")
    store.register({"prompts": {"plan": "base"}})

    report = tune(
        log_path=path,
        evaluator=lambda payload: 0.5,
        config_store=store,
        current_payload={"prompts": {"plan": "base"}},
    )
    assert report.applied_version is None
    assert store.canary() is None
    store.close()


def test_tune_uses_deterministic_few_shot_candidates() -> None:
    rows = [
        {**_row(run_id="r1", goal="写一个 CSV 解析工具并补测试"), "answer": "已实现 csv 解析，覆盖引号与换行两种边界。"},
        {**_row(run_id="r2", goal="短"), "answer": "短"},
    ]
    _, _, few_shots = build_candidates(rows)
    assert len(few_shots) == 1
    assert few_shots[0]["input"].startswith("写一个 CSV")