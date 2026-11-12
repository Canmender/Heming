"""命令行入口：doctor 不碰模型、run 出错给非零退出、tune 能读日志。"""

from __future__ import annotations

import json
import time

import pytest

from agent_pipeline.memory import MemoryStore
from agent_pipeline.runner import ingest_paths, iter_knowledge_files, main


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

def test_ingest_walks_directory_and_filters_extensions(tmp_path, monkeypatch, capsys) -> None:
    """目录递归 + 扩展名过滤 + doc_id 用相对路径（同一份输入永远喂出同一批 doc_id）。"""
    docs = tmp_path / "docs"
    (docs / "sub").mkdir(parents=True)
    (docs / "a.md").write_text("# 安装器\n通用外壳读 latest.yml。", encoding="utf-8")
    (docs / "sub" / "b.md").write_text("# 记忆\n容量有上限。", encoding="utf-8")
    (docs / "skip.bin").write_bytes(b"\x00\x01binary")
    monkeypatch.setenv("AGENT_PIPELINE_DB", str(tmp_path / "kb.db"))

    assert main(["ingest", str(docs), "--prefix", "docs/", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["files"] == 2, "只认 .md 这类文本扩展名"
    assert payload["ingested"] == 2
    assert payload["chunks"] >= 2
    assert payload["stats"]["documents"] == 2

    memory = MemoryStore(str(tmp_path / "kb.db"))
    try:
        hits = memory.search("通用外壳 latest.yml", limit=3)
        assert [hit.citations[0].doc_id for hit in hits][:1] == ["docs/a.md"]
    finally:
        memory.close()


def test_ingest_skips_empty_and_binary_and_flags_truncated(tmp_path, monkeypatch, capsys) -> None:
    (tmp_path / "empty.md").write_text("   \n", encoding="utf-8")
    (tmp_path / "large.md").write_text("字" * 50, encoding="utf-8")
    monkeypatch.setenv("AGENT_PIPELINE_DB", ":memory:")

    memory = MemoryStore(":memory:")
    try:
        results = ingest_paths(memory, [str(tmp_path / "empty.md"), str(tmp_path / "large.md")], max_chars=20)
    finally:
        memory.close()
    assert results[0]["skipped"] == "空文件"
    assert results[1]["trimmed"] is True
    assert results[1]["chars"] == 20


def test_ingest_missing_path_raises(tmp_path) -> None:
    with pytest.raises(FileNotFoundError):
        list(iter_knowledge_files([str(tmp_path / "nope")]))
