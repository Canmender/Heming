"""部署产物的 YAML 必须真的能解析。

`tests/test_packaging.py` 只用字符串断言「文件里写了什么」——YAML 缩进错一个空格，
字符串断言照样全过，但 Prometheus 起不来、compose 起不来。这里用真的 YAML 解析器读一遍，
再按结构校验：告警组/规则/表达式/`for`、compose 的服务/卷/依赖关系。
"""

from __future__ import annotations

import re
import pytest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def _load(rel: str):
    path = ROOT / rel
    assert path.is_file(), f"缺少文件：{path}"
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert data is not None, f"{rel} 解析出来是空的"
    return data


def test_prometheus_scrape_config_parses() -> None:
    data = _load("prometheus/prometheus.yml")
    jobs = data["scrape_configs"]
    assert isinstance(jobs, list) and jobs
    job = jobs[0]
    assert job["job_name"] == "agent-pipeline"
    assert job["metrics_path"] == "/metrics"
    targets = job["static_configs"][0]["targets"]
    assert any(":8000" in str(t) for t in targets), targets


def test_alert_rules_parse_and_are_well_formed() -> None:
    data = _load("prometheus/alerts.yml")
    groups = data["groups"]
    assert isinstance(groups, list) and groups
    rules = [rule for group in groups for rule in group["rules"]]
    assert len(rules) >= 9, len(rules)

    names = {rule["alert"] for rule in rules}
    for expected in (
        "PipelineErrorRateHigh",
        "PipelineLatencyHigh",
        "ToolFailureRateHigh",
        "PipelineRollbackSpike",
        "AgentPipelineDown",
        "CoverageBelowTarget",
        "PipelineLogWriteFailing",
        "PipelineTuneFailing",
        "PipelineNoCompletedRuns",
    ):
        assert expected in names, f"缺少告警 {expected}"

    for rule in rules:
        assert rule.get("expr"), f"{rule['alert']} 没有表达式"
        assert rule.get("labels", {}).get("severity"), f"{rule['alert']} 没有 severity"
        assert rule.get("annotations", {}).get("summary"), f"{rule['alert']} 没有 summary"
        # 表达式里引用的指标名必须是本服务真的会暴露的（拼错等于告警永不触发）
        assert "pipeline_" in rule["expr"] or "up{" in rule["expr"], rule["alert"]


def test_error_rate_alert_ignores_user_cancellations() -> None:
    """取消不是服务故障：分子分母都不能把 aborted 算成错误。"""
    data = _load("prometheus/alerts.yml")
    rules = {rule["alert"]: rule for group in data["groups"] for rule in group["rules"]}
    expr = rules["PipelineErrorRateHigh"]["expr"]
    assert 'status=~"error|budget"' in expr, expr
    assert 'status!="ok"' not in expr, expr


def test_alert_expressions_are_valid_promql() -> None:
    """YAML 合法不等于 PromQL 合法：缩进对了但表达式写错，Prometheus 加载规则时才报错。

    以前只有「字符串包含」断言：`rate(...)` 拼错一个括号、`by (le)` 写错位置都能过，
    但 `promtool check rules` 会直接拒绝。用 promql-parser 在单测里做同一层检查。
    """
    parser = pytest.importorskip("promql_parser")
    data = _load("prometheus/alerts.yml")
    for group in data["groups"]:
        for rule in group["rules"]:
            parser.parse(rule["expr"].strip())


def test_alert_expressions_use_bounded_labels() -> None:
    """工具失败率的分母必须排除 cached：缓存命中是零风险，算进分母会把失败率稀释掉。"""
    data = _load("prometheus/alerts.yml")
    rules = {rule["alert"]: rule for group in data["groups"] for rule in group["rules"]}
    expr = rules["ToolFailureRateHigh"]["expr"]
    # 不允许出现「不带 status 过滤」的全量计数（那会把 cached 混进分子/分母）
    assert not re.search(r"pipeline_tool_calls_total\s*\[", expr.replace("{", "").replace("}", "")), expr
    filtered = re.findall(r"pipeline_tool_calls_total\{([^}]*)\}", expr)
    assert len(filtered) == 2, filtered
    assert any('status="error"' in item for item in filtered), filtered
    assert any('status=~"ok|error"' in item for item in filtered), filtered


def test_docker_compose_parses_with_expected_wiring() -> None:
    data = _load("docker-compose.yml")
    services = data["services"]
    assert "agent-pipeline" in services and "prometheus" in services

    pipeline = services["agent-pipeline"]
    assert "8000" in str(pipeline.get("ports")), pipeline.get("ports")
    assert "pipeline-data:/app/data" in [str(v) for v in pipeline.get("volumes", [])]
    env = pipeline.get("environment")
    names = set(env if isinstance(env, dict) else [str(item).split("=")[0] for item in env])
    for key in ("AGENT_LOG_PATH", "AGENT_PIPELINE_DB", "AGENT_APPROVAL_MODE"):
        assert key in names, f"compose 没传 {key}"

    prom = services["prometheus"]
    mounts = [str(v) for v in prom.get("volumes", [])]
    assert any("prometheus.yml" in m for m in mounts), mounts
    assert any("alerts.yml" in m for m in mounts), mounts
    assert "prometheus-data:/prometheus" in mounts, mounts
    assert isinstance(data.get("volumes"), dict), "顶层要声明命名卷"

    # 依赖关系：prometheus 起来时 agent-pipeline 必须已经定义
    depends = prom.get("depends_on")
    assert depends, "prometheus 应当依赖 agent-pipeline"
    assert "agent-pipeline" in (depends if isinstance(depends, list) else depends.keys())


def test_dockerfile_healthcheck_points_at_health() -> None:
    text = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    assert "HEALTHCHECK" in text
    assert "/health" in text, "HEALTHCHECK 要打 /health（否则容器永远 healthy 或永远 unhealthy）"
    assert "8000" in text