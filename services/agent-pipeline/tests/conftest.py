"""测试夹具：全部离线，不碰网络、不碰真实数据库文件。"""

from __future__ import annotations

from typing import Any, Callable

import pytest

from agent_pipeline.config import Settings
from agent_pipeline.llm import FakeLLM
from agent_pipeline.memory import MemoryStore
from agent_pipeline.metrics import Metrics
from agent_pipeline.nodes import Runtime
from agent_pipeline.rollback import ConfigStore
from agent_pipeline.runtime import build_runtime


@pytest.fixture
def runtime_factory(tmp_path) -> Callable[..., Runtime]:
    def make(
        script: list[Any],
        *,
        coverage_runner: Callable[[], dict[str, Any]] | None = None,
        settings: Settings | None = None,
        tools: list[Any] | None = None,
        log_sink: Callable[[dict[str, Any]], None] | None = None,
    ) -> Runtime:
        settings = settings or Settings(
            log_path=str(tmp_path / "runs.jsonl"),
            db_path=":memory:",
        )
        runtime = build_runtime(
            settings,
            llm=FakeLLM(list(script)),
            memory=MemoryStore(":memory:"),
            metrics=Metrics(),
            config_store=ConfigStore(":memory:"),
            coverage_runner=coverage_runner,
            log_sink=log_sink,
        )
        for spec in tools or []:
            runtime.tools.registry.register(spec)
        return runtime

    return make