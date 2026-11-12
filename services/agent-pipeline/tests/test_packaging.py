"""交付物一致性：Dockerfile / compose / Prometheus 与代码说同一件事。

这一层挡的是「文件写了但代码不读」——之前已经踩过两次：Dockerfile 里环境变量
名和 `Settings.from_env()` 读的完全对不上，compose 里的并发/灰度变量也是错的。
"""

from __future__ import annotations

import re
from pathlib import Path

from agent_pipeline.config import Settings
from agent_pipeline.metrics import Metrics
from agent_pipeline.runner import main as runner_main
from agent_pipeline.service import create_app

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "agent_pipeline"

AGENT_ENV_RE = re.compile(r"\bAGENT_[A-Z0-9_]+\b")


def _read(name: str) -> str:
    return (ROOT / name).read_text(encoding="utf-8")


def _code_env_names() -> set[str]:
    """代码真正会读的环境变量名。

    只从「读环境变量」的行里取（``os.environ.get(...)`` / ``_env_int(...)`` 之类），
    并且跳过注释——否则注释里出现的旧名字会把 bug 掩盖掉（这里真的踩过：
    config.py 读的是 ``AGENT_PIPELINE_LOG``，文档和容器里写的是 ``AGENT_LOG_PATH``）。
    """
    names: set[str] = set()
    for path in SRC.rglob("*.py"):
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            if "environ" in stripped or "_env" in stripped:
                names.update(AGENT_ENV_RE.findall(stripped))
    return names


def test_dockerfile_shape_matches_entry_point() -> None:
    dockerfile = _read("Dockerfile")
    assert "FROM python:3.12-slim" in dockerfile
    assert "WORKDIR /app" in dockerfile
    assert "USER pipeline" in dockerfile and "--uid 10001" in dockerfile
    assert "EXPOSE 8000" in dockerfile
    assert '"agent-pipeline", "serve", "--host", "0.0.0.0", "--port", "8000"' in dockerfile
    # HEALTHCHECK 打的路径必须真的存在
    assert "/health" in dockerfile
    routes = {getattr(route, "path", "") for route in create_app(Settings(log_path=":memory:", db_path=":memory:")).routes}
    assert "/health" in routes and "/metrics" in routes


def test_dockerfile_run_example_mentions_inbound_token() -> None:
    """照抄 Dockerfile 头部的 docker run 示例必须带上入站令牌。

    `-p 8000:8000` 把端口暴露到宿主机；示例里只有上游模型的 Key 的话，照抄部署就是
    一个无鉴权、能执行命令的服务。
    """
    dockerfile = _read("Dockerfile")
    header = dockerfile.split("FROM ", 1)[0]
    assert "docker run" in header
    assert "AGENT_SERVICE_TOKEN" in header, header
    assert "AGENT_PIPELINE_API_KEY" in header, header


def test_dockerfile_and_compose_env_names_are_read_by_code() -> None:
    code_names = _code_env_names()
    assert "AGENT_LOG_PATH" in code_names and "AGENT_PIPELINE_DB" in code_names

    declared: dict[str, set[str]] = {}
    for name in ("Dockerfile", "docker-compose.yml"):
        # 只看 ENV / environment 段里的赋值，注释不算（注释里恰好写了「以前写错的名字」）
        found: set[str] = set()
        for line in _read(name).splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            found.update(AGENT_ENV_RE.findall(stripped))
        declared[name] = found - {"AGENT_PIPELINE_API_KEY"}  # 密钥只由运行时提供

    for name, found in declared.items():
        unknown = found - code_names
        assert not unknown, f"{name} 里写了代码不读的变量：{sorted(unknown)}"

    assert "AGENT_LOG_PATH" in declared["Dockerfile"]
    assert "AGENT_CANARY_RATIO" in declared["docker-compose.yml"]
    assert "AGENT_APPROVAL_MODE" in declared["docker-compose.yml"]


def test_compose_wires_data_volume_and_prometheus() -> None:
    compose = _read("docker-compose.yml")
    assert "agent-pipeline:" in compose and "prometheus:" in compose
    assert '"8000:8000"' in compose
    assert "pipeline-data:/app/data" in compose
    assert "prom/prometheus:v2.54.1" in compose
    assert "./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro" in compose
    assert "./prometheus/alerts.yml:/etc/prometheus/alerts.yml:ro" in compose
    # compose 里引用的两个文件必须存在
    assert (ROOT / "prometheus" / "prometheus.yml").exists()
    assert (ROOT / "prometheus" / "alerts.yml").exists()
    # 卷必须在顶层声明，否则 compose 起不来
    assert "volumes:\n  pipeline-data:" in compose


def test_prometheus_scrapes_the_service_and_alerts_use_real_metrics() -> None:
    prometheus = _read("prometheus/prometheus.yml")
    assert 'targets: ["agent-pipeline:8000"]' in prometheus
    assert "metrics_path: /metrics" in prometheus
    assert "/etc/prometheus/alerts.yml" in prometheus

    # 指标名必须真的会被导出：先按代码路径都记一遍，再从 /metrics 文本里取名字。
    metrics = Metrics()
    metrics.record_run("ok", 1.0)
    metrics.record_node("plan", 0.1)
    metrics.record_tool("http_get", "error", 0.2)
    metrics.record_tokens(10, 5)
    metrics.set_coverage(0.9)
    metrics.record_rollback("error_rate")
    metrics.set_config_version(1)
    metrics.record_tune("ok")
    metrics.set_tune_candidates(2, 3)
    exported = set(re.findall(r"\bpipeline_[a-z0-9_]+\b", metrics.expose().decode("utf-8")))
    assert {"pipeline_runs_total", "pipeline_tool_calls_total", "pipeline_coverage_ratio"} <= exported

    alerts = _read("prometheus/alerts.yml")
    used = set(re.findall(r"\bpipeline_[a-z0-9_]+\b", alerts))
    assert used, "告警文件里没有引用任何指标，等于没写"
    missing = used - exported
    assert not missing, f"告警引用了代码不导出的指标：{sorted(missing)}"
    for alert in (
        "PipelineErrorRateHigh",
        "PipelineLatencyHigh",
        "ToolFailureRateHigh",
        "AgentPipelineDown",
        "CoverageBelowTarget",
    ):
        assert f"alert: {alert}" in alerts


def test_pyproject_exposes_console_script_used_by_docker() -> None:
    pyproject = _read("pyproject.toml")
    assert 'agent-pipeline = "agent_pipeline.runner:main"' in pyproject
    assert callable(runner_main)
    # 打包默认值要和 README/示例一致（不然容器里一跑就是空数据库路径）
    settings = Settings.from_env()
    assert settings.base_url.startswith("http")
    assert settings.max_concurrent_runs >= 1
