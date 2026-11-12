"""CLI 的人类输出路径（之前只测了 --json 与 doctor）。

命令行是运维真正用的入口：`run` 的纯文本摘要、`ingest` 的中文汇报、`tune`
在没有日志时的提示，都属于「出错时看不见」的高风险分支。
"""

from __future__ import annotations

import json

from agent_pipeline import runner
from agent_pipeline.config import Settings

PLAN = json.dumps({"steps": [{"goal": "查一下", "done_when": "有结论"}]}, ensure_ascii=False)
REFLECT = json.dumps({"verdict": "done", "reasons": ["完成"]}, ensure_ascii=False)
CRITIC = json.dumps({"score": 0.9, "blocking_issues": []}, ensure_ascii=False)
SUMMARIZE = json.dumps({"answer": "结论：可以", "citations": []}, ensure_ascii=False)


def test_run_prints_human_summary(runtime_factory, monkeypatch, capsys, tmp_path) -> None:
    runtime = runtime_factory([PLAN, {"text": "查完了"}, REFLECT, CRITIC, SUMMARIZE], settings=Settings(log_path=str(tmp_path / "runs.jsonl"), db_path=":memory:"))
    monkeypatch.setattr(runner, "build_runtime", lambda *args, **kwargs: runtime)

    code = runner.main(["run", "--goal", "确认安装器能不能用", "--max-steps", "3"])

    assert code == 0
    out = capsys.readouterr().out
    assert "状态：ok" in out
    assert "模型调用" in out
    assert "结论：可以" in out


def test_run_json_includes_log_row(runtime_factory, monkeypatch, capsys, tmp_path) -> None:
    runtime = runtime_factory([PLAN, {"text": "查完了"}, REFLECT, CRITIC, SUMMARIZE], settings=Settings(log_path=str(tmp_path / "runs.jsonl"), db_path=":memory:"))
    monkeypatch.setattr(runner, "build_runtime", lambda *args, **kwargs: runtime)

    assert runner.main(["run", "--goal", "确认安装器能不能用", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["result"]["status"] == "ok"
    assert payload["log"]["stop_reason"] is None
    assert "llm_calls" in payload["log"]


def test_ingest_reports_in_chinese(monkeypatch, capsys, tmp_path) -> None:
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "installer.md").write_text("和鸣安装器支持通用外壳，跨版本复用。", encoding="utf-8")
    (docs / "empty.md").write_text("   \n", encoding="utf-8")
    monkeypatch.setenv("AGENT_PIPELINE_DB", str(tmp_path / "kb.db"))

    assert runner.main(["ingest", str(docs)]) == 0
    out = capsys.readouterr().out
    assert "知识库写入：1/2 个文件" in out
    assert "跳过" in out, "空文件要被明确告知，不能静默丢"
    assert "当前规模" in out


def test_ingest_json_summary(monkeypatch, capsys, tmp_path) -> None:
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "a.md").write_text("安装器的通用外壳。", encoding="utf-8")
    monkeypatch.setenv("AGENT_PIPELINE_DB", str(tmp_path / "kb.db"))

    assert runner.main(["ingest", str(docs), "--prefix", "repo/", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["files"] == 1
    assert payload["ingested"] == 1
    assert payload["skipped"] == []
    assert payload["stats"]["documents"] == 1