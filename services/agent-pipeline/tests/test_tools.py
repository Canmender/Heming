"""工具层测试：校验、幂等、断路器、超时、未知工具。"""

from __future__ import annotations

import time
from typing import Any

import pytest

from agent_pipeline.protocol import ToolRequest
from agent_pipeline.tools import (
    SchemaError,
    ToolError,
    ToolRegistry,
    ToolRuntime,
    ToolSpec,
    run_shell,
    validate_schema,
)


def _registry(handler, *, risk: str = "read", timeout_s: float = 5.0, idempotent: bool = True) -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(
        ToolSpec(
            name="echo",
            description="回显",
            schema={
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
                "additionalProperties": False,
            },
            risk=risk,  # type: ignore[arg-type]
            handler=handler,
            timeout_s=timeout_s,
            idempotent=idempotent,
        )
    )
    return registry


def test_validate_schema_strict() -> None:
    schema = {
        "type": "object",
        "properties": {"n": {"type": "integer"}, "tags": {"type": "array", "items": {"type": "string"}}},
        "required": ["n"],
        "additionalProperties": False,
    }
    validate_schema({"n": 1, "tags": ["a"]}, schema)
    with pytest.raises(SchemaError):
        validate_schema({"n": 1, "extra": True}, schema)
    with pytest.raises(SchemaError):
        validate_schema({}, schema)
    with pytest.raises(SchemaError):
        validate_schema({"n": 1, "tags": [1]}, schema)
    with pytest.raises(SchemaError):
        validate_schema({"n": True}, schema)  # bool 不是 integer


def test_execute_success_and_idempotency() -> None:
    calls: list[dict[str, Any]] = []

    def handler(args: dict[str, Any]) -> str:
        calls.append(args)
        return f"echo:{args['text']}"

    runtime = ToolRuntime(_registry(handler))
    first = runtime.execute(ToolRequest(call_id="c1", name="echo", arguments={"text": "hi"}))
    second = runtime.execute(ToolRequest(call_id="c2", name="echo", arguments={"text": "hi"}))
    assert first.ok and first.result == "echo:hi"
    assert second.ok and second.result == "echo:hi"
    assert len(calls) == 1, "同参数应命中幂等缓存，不重复执行"
    assert runtime.stats()["echo"]["cache_hits"] == 1


def test_non_idempotent_tool_runs_every_time() -> None:
    calls: list[int] = []

    def handler(args: dict[str, Any]) -> str:
        calls.append(1)
        return "ok"

    runtime = ToolRuntime(_registry(handler, idempotent=False))
    runtime.execute(ToolRequest(call_id="c1", name="echo", arguments={"text": "x"}))
    runtime.execute(ToolRequest(call_id="c2", name="echo", arguments={"text": "x"}))
    assert len(calls) == 2


def test_schema_error_becomes_observation() -> None:
    runtime = ToolRuntime(_registry(lambda args: "never"))
    observation = runtime.execute(ToolRequest(call_id="c1", name="echo", arguments={"wrong": 1}))
    assert observation.ok is False
    assert "参数不合法" in (observation.error or "")


def test_unknown_tool_becomes_observation() -> None:
    runtime = ToolRuntime(_registry(lambda args: "never"))
    observation = runtime.execute(ToolRequest(call_id="c1", name="nope", arguments={}))
    assert observation.ok is False
    assert "没有这个工具" in (observation.error or "")


def test_circuit_breaker_opens_after_threshold() -> None:
    attempts: list[int] = []

    def handler(args: dict[str, Any]) -> str:
        attempts.append(1)
        raise ToolError("上游挂了")

    runtime = ToolRuntime(_registry(handler, idempotent=False), circuit_threshold=3, circuit_cooldown_s=60)
    for index in range(3):
        observation = runtime.execute(ToolRequest(call_id=f"c{index}", name="echo", arguments={"text": "x"}))
        assert observation.ok is False
    shorted = runtime.execute(ToolRequest(call_id="c9", name="echo", arguments={"text": "x"}))
    assert "熔断" in (shorted.error or "")
    assert len(attempts) == 3, "熔断后不应再真正执行"


def test_timeout_becomes_observation() -> None:
    def slow(args: dict[str, Any]) -> str:
        time.sleep(0.5)
        return "late"

    runtime = ToolRuntime(_registry(slow, timeout_s=0.05))
    started = time.monotonic()
    observation = runtime.execute(ToolRequest(call_id="c1", name="echo", arguments={"text": "x"}))
    assert observation.ok is False
    assert "超时" in (observation.error or "")
    assert time.monotonic() - started < 1.0


def test_risk_is_carried_on_request() -> None:
    request = ToolRequest(call_id="c1", name="echo", arguments={"text": "x"}, risk="write")
    assert request.to_dict()["risk"] == "write"


def test_run_shell_returns_structured_result() -> None:
    result = run_shell("echo hello")
    assert result["code"] == 0
    assert "hello" in result["stdout"]


def test_default_registry_blocks_command_by_default() -> None:
    from agent_pipeline.tools import build_default_registry

    registry = build_default_registry(allow_commands=False)
    runtime = ToolRuntime(registry)
    observation = runtime.execute(ToolRequest(call_id="c1", name="run_command", arguments={"command": "echo hi"}))
    assert observation.ok is False
    assert "未启用" in (observation.error or "")