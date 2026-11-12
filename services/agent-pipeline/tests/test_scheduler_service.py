"""调度器在服务里的接线：开启后才起线程、关掉服务就停。

单元测试（test_scheduler.py）验的是 `DailyTuner` 自己的行为；这里验的是
`create_app` 的 lifespan 有没有真的把它挂上去——`AGENT_TUNE_ENABLED=1` 时
服务一起就该开始调优，配置关着时不该悄悄起线程（容器里没人看的那种改配置最危险）。
"""

from __future__ import annotations

import time

from fastapi.testclient import TestClient

from agent_pipeline.config import Settings
from agent_pipeline.service import create_app


def _settings(**overrides) -> Settings:
    # Settings 是 frozen dataclass：用 replace 而不是逐字段构造，免得漏掉新字段
    from dataclasses import replace

    return replace(Settings(db_path=":memory:", log_path=":memory:", tune_window_hours=24), **overrides)


def test_lifespan_starts_tuner_when_enabled(runtime_factory, tmp_path) -> None:
    settings = _settings(
        log_path=str(tmp_path / "runs.jsonl"),
        tune_enabled=True,
        tune_interval_s=1.0,
    )
    runtime = runtime_factory([], settings=settings)
    app = create_app(runtime=runtime)

    assert app.state.tuner.running is False, "没进 lifespan 之前不该有后台线程"

    with TestClient(app) as client:
        assert app.state.tuner.running is True, "tune_enabled 时服务起来就该调优"
        health = client.get("/health").json()
        assert health["tuner"]["enabled"] is True
        # 线程起来先跑一轮（不是先等一个 24 小时），所以这里应该很快看到 last
        deadline = time.time() + 5
        while time.time() < deadline and app.state.tuner.last is None:
            time.sleep(0.02)
        assert app.state.tuner.last is not None, "起来应先跑一轮，而不是等满间隔"
        assert app.state.tuner.last.error is None
        # 空日志不是失败：报告会写「0 个失败样本」，只是没有候选
        text = client.get("/metrics").text
        assert 'pipeline_tune_runs_total{status="ok"}' in text

        # 报告与「下次什么时候跑」必须能从 /health 读到：只看指标看不出调优读到了什么
        health = client.get("/health").json()["tuner"]
        assert health["last_report"] is not None
        assert health["last_report"]["total_runs"] == 0
        assert health["last_report"]["candidates"] == 0
        assert health["next_run_at"] is not None
        assert health["next_run_at"] > health["last_ran_at"]

    assert app.state.tuner.running is False, "退出 lifespan 必须停线程，否则测试进程不退出"


def test_lifespan_keeps_tuner_off_by_default(runtime_factory) -> None:
    runtime = runtime_factory([], settings=_settings())
    app = create_app(runtime=runtime)

    with TestClient(app) as client:
        assert app.state.tuner.running is False
        assert client.get("/health").json()["tuner"]["enabled"] is False