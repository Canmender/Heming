"""浸泡日志直接喂给调优：`soak --log` → `tune` 这条链路以前是断的。

`soak.py` 原来把 `log_sink` 写成丢弃，跑完一点日志都不留，于是「根据日志每天自动
微调」只能靠手写 fixture 测。这里真的跑一轮会失败的浸泡、再用 tune 读它，
确认两边的字段口径（`finished_at`/`stop_reason`/`status`）对得上。
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from agent_pipeline.config import Settings
from agent_pipeline.metrics import Metrics
from agent_pipeline.scheduler import DailyTuner
from agent_pipeline.tune import read_logs, tune

SOAK = Path(__file__).resolve().parents[1] / "scripts" / "soak.py"


def _load_soak():
    spec = importlib.util.spec_from_file_location("soak_script", SOAK)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def soak_log(tmp_path_factory) -> Path:
    log = tmp_path_factory.mktemp("soak") / "runs.jsonl"
    soak = _load_soak()
    # 每 2 次模型调用注入 1 次失败 → 规划节点直接报错，日志里全是可分类的失败样本
    code = soak.main(["--runs", "20", "--fail-rate", "0.5", "--max-failures", "999", "--log", str(log)])
    assert code == 0, "浸泡在允许失败的情况下应正常退出"
    assert log.exists(), "--log 没有真的写出文件"
    return log


def test_soak_log_is_one_json_object_per_line(soak_log: Path) -> None:
    lines = [line for line in soak_log.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert len(lines) == 20, "每个 run 必须恰好一行"
    for line in lines:
        row = json.loads(line)
        assert {"run_id", "status", "finished_at"} <= set(row), f"缺字段：{sorted(row)}"
        assert isinstance(row["finished_at"], (int, float))


def test_tune_reads_real_soak_log(soak_log: Path, tmp_path) -> None:
    out = tmp_path / "tune.json"
    report = tune(log_path=soak_log, out_path=out, since_hours=1)

    assert report.total_runs == 20
    assert report.failed_runs > 0, "注入了上游失败，调优应该能识别出失败样本"
    assert report.failure_modes, "失败样本必须聚类出至少一种模式"
    assert report.candidates, "有失败模式就应该产出候选（哪怕没有评测器）"
    assert out.exists()
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["total_runs"] == 20
    assert payload["failure_modes"]


def test_read_logs_ignores_rows_outside_the_window(soak_log: Path) -> None:
    """按时间窗过滤：昨天的日志不该被算进今天的调优输入。"""
    rows = read_logs(soak_log, since_hours=24)
    assert len(rows) == 20
    assert read_logs(soak_log, since_hours=24, now=rows[-1]["finished_at"] + 25 * 3600) == []

def test_daily_tuner_consumes_real_soak_log(soak_log: Path, tmp_path) -> None:
    """服务里那条自动调优路径：日志来源就是 runtime 落盘的同一个 JSONL。"""
    settings = Settings(log_path=str(soak_log), db_path=":memory:", tune_window_hours=1)
    metrics = Metrics()
    tuner = DailyTuner(
        settings=settings,
        log_path=str(soak_log),
        out_path=str(tmp_path / "daily.json"),
        metrics=metrics,
    )

    result = tuner.run_once(since_hours=1)

    assert result.error is None, result.error
    assert result.report is not None
    assert result.report.total_runs == 20
    assert result.report.failed_runs > 0
    body = metrics.expose().decode()
    assert 'pipeline_tune_runs_total{status="ok"} 1.0' in body


def test_soak_fails_loudly_when_log_cannot_be_written(tmp_path) -> None:
    """--log 指向一个目录：日志写不进去必须退出码 1 + stderr 说明，不能假装成功。"""
    soak = _load_soak()
    code = soak.main(["--runs", "2", "--log", str(tmp_path)])
    assert code == 1


def test_tune_cli_refuses_missing_log(tmp_path, capsys) -> None:
    from agent_pipeline import runner

    code = runner.main(["tune", "--log", str(tmp_path / "nope.jsonl")])
    assert code == 1
    assert "找不到日志文件" in capsys.readouterr().err
