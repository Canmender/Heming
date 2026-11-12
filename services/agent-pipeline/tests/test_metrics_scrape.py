"""Prometheus 真的能抓：用官方 exposition 解析器验 `/metrics` 文本。

之前只断言「指标名出现在文本里」，但抓取端最怕格式问题（HELP/TYPE 行、标签转义、
重复样本），字符串包含检查看不出来。这里用 `prometheus_client.parser` 真解析一遍，
再核对样本值——解析器报错就等于 Prometheus 抓不动。

顺带钉住一个容易误会的口径：带标签的 counter 第一次自增之前不会出现在 `/metrics`
里（Prometheus 侧同理会看到「no data」）。所以「工具失败率」这类告警只能用
`rate(...)` + `or vector(0)`，不能指望零流量时也有样本。
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient
from prometheus_client.parser import text_string_to_metric_families

from agent_pipeline.config import Settings
from agent_pipeline.llm import FakeLLM

ROOT = Path(__file__).resolve().parents[1]
from agent_pipeline.metrics import Metrics
from agent_pipeline.protocol import TaskSpec
from agent_pipeline.runtime import build_runtime, run_once
from agent_pipeline.service import create_app
from agent_pipeline.tools import ToolSpec

PLAN = json.dumps({"steps": [{"goal": "查一下安装器", "done_when": "拿到结论"}]}, ensure_ascii=False)
REFLECT = json.dumps({"verdict": "done", "reasons": ["做完了"], "next_step": "", "lessons": []}, ensure_ascii=False)
CRITIC = json.dumps({"score": 0.9, "blocking_issues": [], "suggestions": []}, ensure_ascii=False)
SUMMARIZE = json.dumps({"answer": "安装器支持通用外壳。", "citations": []}, ensure_ascii=False)


def _echo() -> ToolSpec:
    return ToolSpec(
        name="echo",
        description="回显文本",
        schema={
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
            "additionalProperties": False,
        },
        risk="read",
        handler=lambda args: f"echo:{args['text']}",
    )


def _setup(tmp_path):
    settings = Settings(log_path=str(tmp_path / "runs.jsonl"), db_path=":memory:")
    metrics = Metrics()
    llm = FakeLLM(
        [
            PLAN,
            {"text": "先查一下", "tool_calls": [{"id": "c1", "name": "echo", "arguments": {"text": "hi"}}]},
            {"text": "查完了"},
            REFLECT,
            CRITIC,
            SUMMARIZE,
        ]
    )
    runtime = build_runtime(settings, llm=llm, metrics=metrics)
    runtime.tools.registry.register(_echo())
    app = create_app(settings=settings, runtime=runtime)
    return app, runtime, metrics


def test_metrics_text_parses_as_prometheus_exposition(tmp_path) -> None:
    app, runtime, _metrics = _setup(tmp_path)
    task = TaskSpec(goal="确认安装器是否有通用外壳", cwd=".", constraints=[], mode="react")

    result, _row = run_once(runtime, task, run_id="run-metrics")
    assert result.status == "ok"

    client = TestClient(app)
    response = client.get("/metrics")
    assert response.status_code == 200
    body = response.text

    families = list(text_string_to_metric_families(body))
    samples = [sample for family in families for sample in family.samples]
    sample_names = {sample.name for sample in samples}
    for expected in (
        "pipeline_runs_total",
        "pipeline_run_duration_seconds",  # histogram → _bucket/_sum/_count
        "pipeline_node_duration_seconds",
        "pipeline_llm_tokens_total",
        "pipeline_tool_calls_total",
        "pipeline_config_version",
    ):
        assert any(name.startswith(expected) for name in sample_names), (
            f"{expected} 没有被导出，告警会永远不触发"
        )

    by_key = {(sample.name, tuple(sorted(sample.labels.items()))): sample.value for sample in samples}
    assert by_key[("pipeline_runs_total", (("status", "ok"),))] >= 1
    # 这次跑真的调了 echo，工具计数要按 tool/status 分得开
    assert ("pipeline_tool_calls_total", (("status", "ok"), ("tool", "echo"))) in by_key
    assert ("pipeline_config_version", ()) in by_key


def test_metrics_scrape_is_repeatable(tmp_path) -> None:
    """反复抓取不能抛「duplicated timeseries」之类（多线程写日志时同理）。"""
    app, _runtime, _metrics = _setup(tmp_path)
    client = TestClient(app)
    for _ in range(3):
        response = client.get("/metrics")
        assert response.status_code == 200
        list(text_string_to_metric_families(response.text))


def test_tool_metric_absent_before_first_tool_call(tmp_path) -> None:
    """零工具流量的进程里没有 tool 样本——告警要用 rate()+or vector(0) 兜底。"""
    settings = Settings(log_path=str(tmp_path / "runs.jsonl"), db_path=":memory:")
    metrics = Metrics()
    runtime = build_runtime(settings, llm=FakeLLM([PLAN, {"text": "查完了"}, REFLECT, CRITIC, SUMMARIZE]), metrics=metrics)
    app = create_app(settings=settings, runtime=runtime)
    run_once(runtime, TaskSpec(goal="只用模型回答", cwd="."), run_id="run-no-tools")

    text = TestClient(app).get("/metrics").text
    samples = [s for family in text_string_to_metric_families(text) for s in family.samples]
    assert not any(sample.name.startswith("pipeline_tool_calls_total") for sample in samples)

    # 告警文件里必须给零样本兜底，否则第一个工具调用之前告警是哑的
    alert_file = __import__("pathlib").Path(__file__).resolve().parents[1] / "prometheus" / "alerts.yml"
    content = alert_file.read_text(encoding="utf-8")
    tool_alert = content.split("ToolFailureRateHigh", 1)[1].split("annotations", 1)[0]
    assert "or vector(0)" in tool_alert, "工具失败率告警缺零样本兜底"

def test_tool_failure_alert_excludes_cache_hits_from_denominator() -> None:
    """分母只算真实执行的调用（ok/error）：cached 是零风险的缓存命中。

    否则「每次真跑都失败、但经常命中缓存」的工具，失败率会被缓存命中稀释掉，
    告警永远不触发——这比没告警更糟，因为它看起来有覆盖。
    """
    text = (ROOT / "prometheus" / "alerts.yml").read_text(encoding="utf-8")
    assert 'pipeline_tool_calls_total{status=~"ok|error"}' in text
    assert "rate(pipeline_tool_calls_total[5m])" not in text
