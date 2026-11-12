"""Prometheus 指标。

用一个独立的 ``CollectorRegistry``，这样测试里可以造多个实例互不干扰。
指标命名遵循 Prometheus 约定（``_total`` 计数、``_seconds`` 直方图）。
"""

from __future__ import annotations

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram, generate_latest

RUN_STATUS = ("ok", "error", "aborted", "budget")
TOOL_STATUS = ("ok", "error", "timeout", "short_circuit", "schema")


class Metrics:
    def __init__(self, registry: CollectorRegistry | None = None) -> None:
        self.registry = registry or CollectorRegistry()
        self.runs_total = Counter(
            "pipeline_runs_total", "run 数量（按结束状态）", ["status"], registry=self.registry
        )
        self.run_duration = Histogram(
            "pipeline_run_duration_seconds",
            "run 端到端耗时",
            buckets=(0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600),
            registry=self.registry,
        )
        self.node_duration = Histogram(
            "pipeline_node_duration_seconds",
            "节点耗时",
            ["node"],
            buckets=(0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60),
            registry=self.registry,
        )
        self.tool_calls = Counter(
            "pipeline_tool_calls_total", "工具调用次数", ["tool", "status"], registry=self.registry
        )
        self.llm_tokens = Counter(
            "pipeline_llm_tokens_total", "token 用量", ["kind"], registry=self.registry
        )
        self.coverage = Gauge(
            "pipeline_coverage_ratio", "最近一次对抗迭代的测试覆盖率", registry=self.registry
        )
        self.rollbacks = Counter(
            "pipeline_rollback_total", "自动回滚次数", ["reason"], registry=self.registry
        )
        self.config_version = Gauge(
            "pipeline_config_version", "当前生效配置版本号", registry=self.registry
        )

    # ---- 记录 -------------------------------------------------------------

    def record_run(self, status: str, seconds: float) -> None:
        self.runs_total.labels(status=status).inc()
        self.run_duration.observe(seconds)

    def record_node(self, node: str, seconds: float) -> None:
        self.node_duration.labels(node=node).observe(seconds)

    def record_tool(self, tool: str, status: str, seconds: float) -> None:
        self.tool_calls.labels(tool=tool, status=status).inc()

    def record_tokens(self, prompt: int, completion: int) -> None:
        self.llm_tokens.labels(kind="prompt").inc(prompt)
        self.llm_tokens.labels(kind="completion").inc(completion)

    def set_coverage(self, value: float) -> None:
        self.coverage.set(value)

    def record_rollback(self, reason: str) -> None:
        self.rollbacks.labels(reason=reason).inc()

    def set_config_version(self, version: int) -> None:
        self.config_version.set(version)

    def expose(self) -> bytes:
        return generate_latest(self.registry)