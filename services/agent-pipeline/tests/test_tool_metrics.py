"""工具指标标签必须有界，否则 Prometheus 会被模型幻觉出来的工具名撑爆。

模型会调用不存在的工具（`fs__lisst_dir`、`shot__screnshot` …），每次都换个拼写。
如果直接拿它当 label，时序数随调用量无限涨——Prometheus 内存、抓取时间、TSDB 全跟着涨，
而且这类时序永远不会再有流量，纯垃圾。
"""

from __future__ import annotations

from agent_pipeline.metrics import Metrics
from agent_pipeline.protocol import ToolRequest
from agent_pipeline.tools import ToolRegistry, ToolRuntime


def _runtime() -> tuple[ToolRuntime, Metrics]:
    registry = ToolRegistry()

    @registry.tool(
        name="echo",
        description="回显",
        schema={"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
        risk="read",
    )
    def echo(args: dict) -> dict:
        return {"text": args["text"]}

    metrics = Metrics()
    return ToolRuntime(registry, metrics_hook=metrics.record_tool), metrics


def _labels(text: str) -> dict[tuple[str, str], float]:
    out: dict[tuple[str, str], float] = {}
    for line in text.splitlines():
        if not line.startswith("pipeline_tool_calls_total{"):
            continue
        label_part = line.split("{", 1)[1].split("}", 1)[0]
        labels = dict(item.split("=", 1) for item in label_part.split(","))
        tool = labels["tool"].strip('"')
        status = labels["status"].strip('"')
        out[(tool, status)] = float(line.rsplit(" ", 1)[1])
    return out


def test_unknown_hallucinated_tool_names_collapse_into_one_label() -> None:
    runtime, metrics = _runtime()

    for index in range(50):
        runtime.execute(ToolRequest(call_id=f"c{index}", name=f"ghost__tool_{index}", arguments={}))

    labels = _labels(metrics.expose().decode())
    assert set(labels) == {("unknown", "error")}, f"幻觉工具名应归到一个标签，实际 {sorted(labels)}"
    assert labels[("unknown", "error")] == 50


def test_registered_tools_still_have_their_own_label() -> None:
    runtime, metrics = _runtime()

    runtime.execute(ToolRequest(call_id="c1", name="echo", arguments={"text": "hi"}))
    runtime.execute(ToolRequest(call_id="c2", name="echo", arguments={"text": "hi"}))

    labels = _labels(metrics.expose().decode())
    assert labels[("echo", "ok")] == 1
    # 第二次同参命中幂等缓存：单独记 cached，不混进 ok
    assert labels[("echo", "cached")] == 1
    assert labels[("echo", "ok")] == 1


def test_too_many_distinct_registered_names_fall_back_to_other() -> None:
    runtime, metrics = _runtime()
    for index in range(ToolRuntime.MAX_TOOL_METRIC_LABELS + 5):
        runtime.registry.tool(
            name=f"dyn_{index}",
            description="动态注册",
            schema={"type": "object", "properties": {}},
            risk="read",
        )(lambda args: {"ok": True})

    for index in range(ToolRuntime.MAX_TOOL_METRIC_LABELS + 5):
        runtime.execute(ToolRequest(call_id=f"c{index}", name=f"dyn_{index}", arguments={}))

    labels = _labels(metrics.expose().decode())
    assert ("other", "ok") in labels, "超出上限的注册工具应归 other"
    assert len({tool for tool, _ in labels}) <= ToolRuntime.MAX_TOOL_METRIC_LABELS + 1


def test_label_cap_holds_under_concurrency() -> None:
    """上限检查必须是原子的：并发下「都看到没满 32」会各加一个，把上限顶穿。"""
    from concurrent.futures import ThreadPoolExecutor

    runtime, metrics = _runtime()
    total = ToolRuntime.MAX_TOOL_METRIC_LABELS + 12
    for index in range(total):
        runtime.registry.tool(
            name=f"conc_{index}",
            description="并发注册",
            schema={"type": "object", "properties": {}},
            risk="read",
        )(lambda args: {"ok": True})

    requests = [ToolRequest(call_id=f"c{index}", name=f"conc_{index}", arguments={}) for index in range(total)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(runtime.execute, requests))

    labels = _labels(metrics.expose().decode())
    assert ("other", "ok") in labels
    assert len({tool for tool, _ in labels}) <= ToolRuntime.MAX_TOOL_METRIC_LABELS + 1, (
        f"并发下标签数越过上限：{sorted({tool for tool, _ in labels})}"
    )