"""用户取消不算「配置坏了」：不进错误率窗口，也不进调优的失败样本。

以前 `run_once` 把 `ok=result.status == "ok"` 无条件记进回滚窗口：灰度期间用户多按
几次取消，错误率就能越过阈值，把一份正常的候选配置自动回滚掉；`tune.classify`
也会把 `stop_reason="cancelled"` 当成一类失败样本，于是「每日自动微调」去改一堆
因为用户点了停止而「失败」的 run。这里钉住两边都不再把它当失败。
"""

from __future__ import annotations

import json

from agent_pipeline.config import Settings
from agent_pipeline.protocol import TaskSpec
from agent_pipeline.runtime import run_once
from agent_pipeline.tune import classify


PLAN = json.dumps({"steps": [{"goal": "跑工具", "done_when": "有结果"}]}, ensure_ascii=False)
SUMMARIZE = json.dumps({"answer": "取消前的结果", "citations": []}, ensure_ascii=False)


def test_cancelled_run_is_not_counted_as_config_failure(runtime_factory, tmp_path) -> None:
    executed: list[str] = []
    cancel_state = {"on": False}

    def echo(args: dict) -> dict:
        executed.append(str(args.get("text")))
        cancel_state["on"] = True
        return {"echo": args.get("text")}

    settings = Settings(log_path=str(tmp_path / "runs.jsonl"), db_path=":memory:")
    runtime = runtime_factory(
        [
            PLAN,
            {"text": "先跑工具", "tool_calls": [{"id": "c1", "name": "echo", "arguments": {"text": "一"}}]},
            {"text": "先跑工具", "tool_calls": [{"id": "c2", "name": "echo", "arguments": {"text": "二"}}]},
        ],
        settings=settings,
    )
    runtime.tools.registry.tool(
        name="echo",
        description="回显",
        risk="read",
        schema={"type": "object", "properties": {"text": {"type": "string"}}},
    )(echo)
    runtime.cancel = lambda _run_id: cancel_state["on"]

    version = runtime.config_store.register({"prompts": {}}, promote=True)
    assert version is not None

    result, row = run_once(
        runtime,
        TaskSpec(goal="取消一次", cwd="."),
        run_id="run-cancel-outcome",
        config_version=version.id,
    )

    assert result.status == "aborted"
    assert result.stop_reason == "cancelled"
    assert row["status"] == "aborted"
    # 取消没有进错误率窗口（否则灰度会被用户按几次取消顶掉）
    window = runtime.config_store.window(version.id)
    assert window["samples"] == 0, window
    assert window["errors"] == 0, window
    # 调优也不把它算失败样本
    assert classify(row) is None


def test_failed_run_still_counts_towards_rollback(runtime_factory, tmp_path) -> None:
    settings = Settings(
        log_path=str(tmp_path / "runs.jsonl"),
        db_path=":memory:",
        error_threshold=0.5,
        min_samples_for_rollback=1,
    )
    runtime = runtime_factory([], settings=settings)  # 脚本为空：第一次调用就抛错
    version = runtime.config_store.register({"prompts": {}}, promote=True)
    assert version is not None

    result, _row = run_once(
        runtime,
        TaskSpec(goal="正常失败要计数", cwd="."),
        run_id="run-error-outcome",
        config_version=version.id,
    )

    assert result.status != "ok"
    window = runtime.config_store.window(version.id)
    assert window["samples"] == 1, window
    assert window["errors"] == 1, window