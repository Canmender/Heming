"""关停口径：容器滚动更新/重启时，正在跑的 run 要自己收口，不能凭空消失。

SIGTERM 直接把进程砍掉的话：客户端看到的是「连不上」，日志里只剩半截 run，
既没 `aborted` 也没 `error`——事后查不出到底发生过什么。所以 lifespan 退出时：
1. 给所有在跑的 run 置取消标记（走用户点「取消」同一条协作式收口路径）；
2. 最多等 `AGENT_SHUTDOWN_GRACE_S` 秒让它们跑完节点边界；
3. 宽限期用完还不收口的，落成 `error` 并写明「服务关停」；
4. 释放工具线程池与 SQLite 连接。
"""

from __future__ import annotations

import json
import threading
import time
from dataclasses import replace

from fastapi.testclient import TestClient

from agent_pipeline.config import Settings
from agent_pipeline.service import create_app


def _slow_reply(messages, _tools):
    """每个节点慢 150ms，给关停留出「正在跑」的窗口。"""
    time.sleep(0.15)
    system = "\n".join(str(m.get("content", "")) for m in messages if m.get("role") == "system")
    if "规划者" in system:
        payload = {"steps": [{"goal": "慢一点", "done_when": "跑完"}]}
    elif "评审者" in system:
        payload = {"score": 0.95, "blocking_issues": [], "suggestions": []}
    elif "总结者" in system or "汇总" in system:
        payload = {"answer": "差点跑完", "citations": []}
    elif "反思" in system:
        payload = {"verdict": "done", "reasons": ["ok"]}
    else:
        payload = {"text": "ok"}
    return {"text": json.dumps(payload, ensure_ascii=False)}


def _settings(log_dir, **overrides) -> Settings:
    base = Settings(db_path=":memory:", log_path=str(log_dir / "runs.jsonl"))
    return replace(base, **overrides)


def test_shutdown_cancels_inflight_runs_and_closes_resources(runtime_factory, tmp_path) -> None:
    settings = _settings(tmp_path, shutdown_grace_s=5.0)
    runtime = runtime_factory([_slow_reply] * 32, settings=settings)
    app = create_app(runtime=runtime)

    with TestClient(app) as client:
        created = client.post("/v1/runs", json={"goal": "慢慢跑"})
        assert created.status_code == 202
        run_id = created.json()["run_id"]

        # 等它真的开始跑（否则关停时可能还没进图）
        deadline = time.time() + 5
        while time.time() < deadline and not len(runtime.llm.calls):
            time.sleep(0.01)
        assert len(runtime.llm.calls) > 0, "run 应该已经开跑"

    # 退出 with = 触发 lifespan 关停
    assert app.state.cancels == {} or all(event.is_set() for event in app.state.cancels.values()), (
        "关停时应该给在跑的 run 置取消标记"
    )
    entry = app.state.runs[run_id]
    assert entry["status"] in {"aborted", "ok", "error"}, f"关停后不该还停在 running：{entry}"
    if entry["status"] == "error":
        assert "服务关停" in str(entry.get("error")), "宽限期兜底要把原因写清楚"

    # 线程池已释放：再调工具会立刻失败，而不是把请求挂在已经不存在的线程池上
    from agent_pipeline.protocol import ToolRequest

    observation = runtime.tools.execute(ToolRequest(call_id="after", name="http_get", arguments={"url": "http://127.0.0.1:9"}))
    assert observation.ok is False
    assert "shutdown" in (observation.error or "").lower() or "closed" in (observation.error or "").lower()


def test_shutdown_without_runs_is_quick_and_idempotent(runtime_factory, tmp_path) -> None:
    """没有在跑的 run 时不该等满宽限期（否则每次重启都白等 5 秒）。"""
    settings = _settings(tmp_path, shutdown_grace_s=5.0)
    runtime = runtime_factory([_slow_reply] * 8, settings=settings)
    app = create_app(runtime=runtime)

    started = time.monotonic()
    with TestClient(app) as client:
        assert client.get("/health").json()["ok"] is True
    assert time.monotonic() - started < 3.0, "没有 in-flight run 时关停应当立刻返回"


def test_threads_are_cleaned_up_after_run_finishes(runtime_factory, tmp_path) -> None:
    """线程表要随 run 结束清掉，否则长跑进程里 per-run 引用会越积越多。"""
    settings = _settings(tmp_path)
    runtime = runtime_factory([_slow_reply] * 8, settings=settings)
    app = create_app(runtime=runtime)

    with TestClient(app) as client:
        run_id = client.post("/v1/runs", json={"goal": "跑完"}).json()["run_id"]
        deadline = time.time() + 5
        while time.time() < deadline:
            payload = client.get(f"/v1/runs/{run_id}").json()
            if payload["status"] != "running":
                break
            time.sleep(0.02)
        assert payload["status"] == "ok", payload
        assert run_id not in app.state.threads, f"run 结束后线程表应该清空，实际还留着 {run_id}"
        assert run_id not in app.state.cancels

    # 关停时也不能因为残留线程而卡住
    assert all(not thread.is_alive() for thread in app.state.threads.values())


def test_resources_are_not_closed_while_a_run_thread_is_still_alive(runtime_factory, tmp_path) -> None:
    """宽限期用完线程还没退，就别关 SQLite/线程池。

    否则那个线程下一次读写会抛「Cannot operate on a closed database」之类的错误，
    日志里出现一堆像是故障的东西——实际是关停顺序问题，进程退出本来就会回收这些资源。
    """
    settings = _settings(tmp_path, shutdown_grace_s=0.0)
    runtime = runtime_factory([_slow_reply] * 32, settings=settings)
    closed: list[str] = []
    runtime.tools.close = lambda: closed.append("tools")  # type: ignore[method-assign]
    runtime.memory.close = lambda: closed.append("memory")  # type: ignore[method-assign]
    runtime.config_store.close = lambda: closed.append("config_store")  # type: ignore[method-assign]

    app = create_app(runtime=runtime)
    with TestClient(app) as client:
        run_id = client.post("/v1/runs", json={"goal": "慢慢跑"}).json()["run_id"]
        deadline = time.time() + 5
        while time.time() < deadline and not len(runtime.llm.calls):
            time.sleep(0.01)
        assert len(runtime.llm.calls) > 0, "run 应该已经开跑"

    # 宽限期 0：线程一定还在跑，所以不该释放共享资源
    assert closed == [], f"还有活线程时不应该关资源，实际关了：{closed}"
    assert "服务关停" in str(app.state.runs[run_id].get("error") or ""), "兜底仍要把状态与原因落下"


def test_resources_are_closed_when_nothing_is_running(runtime_factory, tmp_path, capsys) -> None:
    settings = _settings(tmp_path, shutdown_grace_s=5.0)
    runtime = runtime_factory([_slow_reply] * 8, settings=settings)
    closed: list[str] = []
    runtime.tools.close = lambda: closed.append("tools")  # type: ignore[method-assign]
    runtime.memory.close = lambda: closed.append("memory")  # type: ignore[method-assign]
    runtime.config_store.close = lambda: closed.append("config_store")  # type: ignore[method-assign]

    app = create_app(runtime=runtime)
    with TestClient(app) as client:
        assert client.get("/health").json()["ok"] is True

    assert closed == ["tools", "memory", "config_store"], f"没有在跑的 run 时应当释放资源：{closed}"
    assert "跳过资源释放" not in capsys.readouterr().err