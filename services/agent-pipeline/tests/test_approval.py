"""工具审批闸（HITL）测试：只拦非只读工具，等待、裁决、超时、取消都要有确定结果。"""

from __future__ import annotations

import json
import threading
import time

from agent_pipeline.approval import ApprovalGate
from agent_pipeline.config import Settings
from agent_pipeline.protocol import TaskSpec
from agent_pipeline.runtime import run_once
from agent_pipeline.tools import ToolSpec


def _json(payload: dict) -> dict:
    return {"text": json.dumps(payload, ensure_ascii=False)}


def _write_spec(calls: list[dict]) -> ToolSpec:
    def handler(args: dict) -> str:
        calls.append(args)
        return "written"

    return ToolSpec(
        name="write_file",
        description="写文件（有副作用）",
        schema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
            "additionalProperties": False,
        },
        risk="write",
        handler=handler,
        idempotent=False,
    )


def _script() -> list[dict]:
    return [
        _json({"steps": [{"goal": "写一个文件", "done_when": "观测里出现 written"}]}),
        {
            "text": "先写文件",
            "tool_calls": [{"id": "c1", "name": "write_file", "arguments": {"path": "a.txt"}}],
        },
        {"text": "已经写好了"},
        _json({"verdict": "done", "reasons": ["观测里出现 written"]}),
        _json({"score": 0.9, "blocking_issues": []}),
        _json({"answer": "完成", "citations": []}),
    ]


def test_request_blocks_until_approved() -> None:
    gate = ApprovalGate(timeout_s=5.0)
    seen: list[tuple[bool, str]] = []

    def worker() -> None:
        seen.append(gate.request("run1", "c1", tool="write_file", arguments={"path": "a.txt"}))

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()

    deadline = time.time() + 3
    while not gate.pending("run1") and time.time() < deadline:
        time.sleep(0.01)
    pending = gate.pending("run1")
    assert len(pending) == 1
    assert pending[0]["tool"] == "write_file"
    assert pending[0]["arguments"] == {"path": "a.txt"}

    assert gate.resolve("run1", "c1", True) is True
    thread.join(2)
    assert seen == [(True, "")]
    assert gate.pending("run1") == []


def test_deny_carries_human_readable_reason() -> None:
    gate = ApprovalGate(timeout_s=5.0)
    seen: list[tuple[bool, str]] = []
    thread = threading.Thread(
        target=lambda: seen.append(gate.request("run2", "c9", tool="write_file")),
        daemon=True,
    )
    thread.start()

    deadline = time.time() + 3
    while not gate.pending("run2") and time.time() < deadline:
        time.sleep(0.01)
    assert gate.resolve("run2", "c9", False) is True
    thread.join(2)

    approved, reason = seen[0]
    assert approved is False
    assert "拒绝" in reason and "write_file" in reason


def test_timeout_is_treated_as_denied() -> None:
    gate = ApprovalGate(timeout_s=0.1)
    approved, reason = gate.request("run3", "c1", tool="write_file")
    assert approved is False
    assert "超时" in reason
    assert gate.pending("run3") == []


def test_resolve_unknown_call_id_returns_false() -> None:
    gate = ApprovalGate(timeout_s=1.0)
    assert gate.resolve("nope", "nope", True) is False


def test_cancel_run_denies_every_pending_call() -> None:
    gate = ApprovalGate(timeout_s=5.0)
    results: list[tuple[bool, str]] = []

    def worker(call_id: str) -> None:
        results.append(gate.request("run4", call_id, tool="write_file"))

    threads = [threading.Thread(target=worker, args=(cid,), daemon=True) for cid in ("c1", "c2")]
    for thread in threads:
        thread.start()

    deadline = time.time() + 3
    while len(gate.pending("run4")) < 2 and time.time() < deadline:
        time.sleep(0.01)

    assert gate.cancel_run("run4") == 2
    for thread in threads:
        thread.join(2)
    assert [ok for ok, _ in results] == [False, False]
    assert gate.pending() == []


def test_execute_waits_for_approval_and_runs_only_when_approved(runtime_factory) -> None:
    executed: list[dict] = []
    runtime = runtime_factory(_script(), tools=[_write_spec(executed)])
    gate = ApprovalGate(timeout_s=5.0)
    runtime.approval = gate

    box: dict = {}

    def run() -> None:
        box["result"] = run_once(runtime, TaskSpec(goal="审批后执行", cwd="."))

    thread = threading.Thread(target=run, daemon=True)
    thread.start()

    deadline = time.time() + 5
    while not gate.pending() and time.time() < deadline:
        time.sleep(0.01)
    pending = gate.pending()
    assert pending, "写工具执行前必须先挂起等审批"
    assert gate.resolve(pending[0]["run_id"], pending[0]["call_id"], True) is True
    thread.join(10)

    result, _row = box["result"]
    assert executed == [{"path": "a.txt"}]
    write_obs = [obs for obs in result.observations if obs.tool == "write_file"]
    assert write_obs and write_obs[0].ok is True


def test_execute_skips_tool_when_denied(runtime_factory) -> None:
    executed: list[dict] = []
    runtime = runtime_factory(_script(), tools=[_write_spec(executed)])
    gate = ApprovalGate(timeout_s=5.0)
    runtime.approval = gate

    box: dict = {}

    def run() -> None:
        box["result"] = run_once(runtime, TaskSpec(goal="拒绝后跳过", cwd="."))

    thread = threading.Thread(target=run, daemon=True)
    thread.start()

    deadline = time.time() + 5
    while not gate.pending() and time.time() < deadline:
        time.sleep(0.01)
    pending = gate.pending()
    assert pending
    gate.resolve(pending[0]["run_id"], pending[0]["call_id"], False)
    thread.join(10)

    result, _row = box["result"]
    assert executed == [], "被拒绝的工具绝不能真的执行"
    write_obs = [obs for obs in result.observations if obs.tool == "write_file"]
    assert write_obs and write_obs[0].ok is False
    assert "拒绝" in (write_obs[0].error or "")


def test_read_tools_are_not_gated(runtime_factory) -> None:
    """只读工具不审批：全拦只会让用户把闸关掉。"""
    script = [
        _json({"steps": [{"goal": "查一下", "done_when": "有观测"}]}),
        {"text": "查", "tool_calls": [{"id": "c1", "name": "peek", "arguments": {"q": "x"}}]},
        {"text": "查完了"},
        _json({"verdict": "done", "reasons": ["有观测"]}),
        _json({"score": 0.9, "blocking_issues": []}),
        _json({"answer": "查到了", "citations": []}),
    ]
    spec = ToolSpec(
        name="peek",
        description="只读查看",
        schema={
            "type": "object",
            "properties": {"q": {"type": "string"}},
            "required": ["q"],
            "additionalProperties": False,
        },
        risk="read",
        handler=lambda args: f"peek:{args['q']}",
    )
    runtime = runtime_factory(script, tools=[spec])
    runtime.approval = ApprovalGate(timeout_s=0.1)
    runtime.settings = Settings(log_path=runtime.settings.log_path, db_path=":memory:")

    result, _row = run_once(runtime, TaskSpec(goal="只读不拦", cwd="."))

    peek_obs = [obs for obs in result.observations if obs.tool == "peek"]
    assert peek_obs and peek_obs[0].ok is True, "只读工具不该等审批"