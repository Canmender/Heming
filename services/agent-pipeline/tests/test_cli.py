"""命令行入口：doctor 不碰模型、run 出错给非零退出、tune 能读日志。"""

from __future__ import annotations

import json
import time

from agent_pipeline.runner import main


def test_doctor_reports_tools_and_paths(tmp_path, monkeypatch, capsys) -> None:
    monkeypatch.setenv("AGENT_LOG_PATH", str(tmp_path / "runs.jsonl"))
    monkeypatch.setenv("AGENT_PIPELINE_DB", ":memory:")

    assert main(["doctor"]) == 0
    info = json.loads(capsys.readouterr().out)
    assert info["tools"] == ["http_get", "knowledge_search", "run_command"]
    assert info["memory"] == {"documents": 0, "chunks": 0, "episodes": 0}
    assert info["budget"]["max_steps"] >= 1
    assert info["log_path"].endswith("runs.jsonl")


def test_run_fails_fast_when_upstream_unreachable(tmp_path, monkeypatch, capsys) -> None:
    """上游连不上时必须落到 status=error（不是抛栈），退出码非零。"""
    monkeypatch.setenv("AGENT_LOG_PATH", str(tmp_path / "runs.jsonl"))
    monkeypatch.setenv("AGENT_PIPELINE_DB", ":memory:")
    monkeypatch.setenv("AGENT_PIPELINE_BASE_URL", "http://127.0.0.1:9/v1")
    monkeypatch.setenv("AGENT_PIPELINE_API_KEY", "test-key")

    code = main(["run", "--goal", "自检", "--json"])
    assert code == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["result"]["status"] == "error"
    assert payload["result"]["error"]
    assert payload["log"]["status"] == "error"


def test_tune_reads_log_and_reports(tmp_path, capsys) -> None:
    log = tmp_path / "runs.jsonl"
    now = time.time()
    rows = [
        {"finished_at": now - 10, "status": "error", "stop_reason": "max_steps", "task": {"goal": "a", "cwd": ".", "constraints": [], "mode": "react"}},
        {"finished_at": now - 20, "status": "error", "stop_reason": "max_steps", "task": {"goal": "b", "cwd": ".", "constraints": [], "mode": "react"}},
        {"finished_at": now - 30, "status": "ok", "stop_reason": None, "task": {"goal": "c", "cwd": ".", "constraints": [], "mode": "react"}},
    ]
    log.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")

    code = main(
        [
            "tune",
            "--log",
            str(log),
            "--out",
            str(tmp_path / "report.json"),
            "--since-hours",
            "24",
        ]
    )
    assert code == 0
    report = json.loads(capsys.readouterr().out)
    assert report["total_runs"] == 3
    assert report["failure_modes"] == {"max_steps": 2}
