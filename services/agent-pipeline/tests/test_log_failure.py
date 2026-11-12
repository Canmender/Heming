"""日志写不进去时必须留痕：否则调优和回滚窗口会静默拿到空数据。

`_write_log` 以前 `except OSError: pass`——日志目录没权限/被占满时，每个 run 都
"成功"、`/health` 一切正常，而 `tune` 读到的是一份不存在的文件（或空文件），
最后给出「0 个失败样本，系统健康」的结论。这条测试就是钉住这个静默失败。
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from agent_pipeline.config import Settings
from agent_pipeline.protocol import TaskSpec
from agent_pipeline.runtime import run_once
from agent_pipeline.service import create_app

PLAN = json.dumps({"steps": [{"goal": "查一下", "done_when": "有结论"}]}, ensure_ascii=False)
REFLECT = json.dumps({"verdict": "done", "reasons": ["完成"]}, ensure_ascii=False)
CRITIC = json.dumps({"score": 0.9, "blocking_issues": []}, ensure_ascii=False)
SUMMARIZE = json.dumps({"answer": "结论", "citations": []}, ensure_ascii=False)
SCRIPT = [PLAN, {"text": "查完了"}, REFLECT, CRITIC, SUMMARIZE]


def test_log_failure_is_counted_and_exposed(runtime_factory, tmp_path) -> None:
    # 把 log_path 指到一个目录：open(..., "a") 会抛 IsADirectoryError（OSError 子类）
    settings = Settings(log_path=str(tmp_path), db_path=":memory:")
    runtime = runtime_factory(SCRIPT, settings=settings)

    result, _row = run_once(runtime, TaskSpec(goal="确认日志失败会被记录", cwd="."), run_id="run-logfail")

    assert result.status == "ok", "写日志失败不能把 run 弄崩"
    assert runtime.log_failures >= 1
    # Windows 上是 PermissionError、类 Unix 上是 IsADirectoryError：都算 OSError，
    # 断言「有具体错误类型」而不是钉死某一个平台
    assert runtime.log_last_error and "Error:" in runtime.log_last_error

    health = TestClient(create_app(settings=settings, runtime=runtime)).get("/health").json()
    assert health["log_failures"] >= 1
    assert health["log_last_error"]

    # 光有 /health 字段没人盯；必须进 Prometheus 指标才能告警（PipelineLogWriteFailing）。
    exposed = runtime.metrics.expose().decode("utf-8")
    assert "pipeline_log_failures_total" in exposed


def test_healthy_log_path_reports_zero_failures(runtime_factory, tmp_path) -> None:
    log = tmp_path / "runs.jsonl"
    runtime = runtime_factory(SCRIPT, settings=Settings(log_path=str(log), db_path=":memory:"))

    run_once(runtime, TaskSpec(goal="正常写日志", cwd="."), run_id="run-logok")

    assert runtime.log_failures == 0
    assert log.exists() and log.read_text(encoding="utf-8").strip(), "日志文件必须真的写出来"