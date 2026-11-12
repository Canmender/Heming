"""配置版本 / 灰度 / 自动回滚测试。"""

from __future__ import annotations

import pytest

from agent_pipeline.rollback import STAGE_ACTIVE, STAGE_CANARY, ConfigStore


def test_register_promotes_to_active() -> None:
    store = ConfigStore(":memory:")
    version = store.register({"prompts": {"plan": "v1"}})
    assert version.stage == STAGE_ACTIVE
    assert store.active().id == version.id
    assert store.canary() is None
    store.close()


def test_register_without_promote_keeps_previous_active() -> None:
    store = ConfigStore(":memory:")
    first = store.register({"prompts": {"plan": "v1"}})
    second = store.register({"prompts": {"plan": "v2"}}, promote=False)
    assert store.active().id == first.id
    assert store.get(second.id).stage != STAGE_ACTIVE
    store.close()


def test_canary_selection_is_stable_per_run_id() -> None:
    store = ConfigStore(":memory:")
    store.register({"prompts": {"plan": "base"}})
    canary = store.register({"prompts": {"plan": "canary"}}, promote=False)
    store._set_stage(canary.id, STAGE_CANARY)  # noqa: SLF001 - 测试里直接摆状态

    assert store.select_for_run("run-x", 0.0).payload["prompts"]["plan"] == "base"
    assert store.select_for_run("run-x", 1.0).payload["prompts"]["plan"] == "canary"
    # 同一 run 重复调用必须落到同一版本（重试/重放安全）
    picks = {store.select_for_run("run-abc", 0.5).id for _ in range(20)}
    assert len(picks) == 1
    store.close()


def test_promote_canary_moves_pointer() -> None:
    store = ConfigStore(":memory:")
    store.register({"prompts": {"plan": "base"}})
    canary = store.register({"prompts": {"plan": "canary"}}, promote=False)
    store._set_stage(canary.id, STAGE_CANARY)  # noqa: SLF001

    promoted = store.promote_canary()
    assert promoted is not None and promoted.id == canary.id
    assert store.canary() is None
    assert store.active().id == canary.id
    store.close()


def test_rollback_archives_canary_and_is_idempotent() -> None:
    store = ConfigStore(":memory:")
    base = store.register({"prompts": {"plan": "base"}})
    canary = store.register({"prompts": {"plan": "canary"}}, promote=False)
    store._set_stage(canary.id, STAGE_CANARY)  # noqa: SLF001

    active = store.rollback("manual")
    assert active is not None and active.id == base.id
    assert store.canary() is None
    assert store.get(canary.id).stage != STAGE_CANARY
    assert store.rollback("again").id == base.id  # 幂等
    store.close()


def test_window_statistics() -> None:
    store = ConfigStore(":memory:")
    version = store.register({"prompts": {}})
    for index in range(10):
        store.record_outcome(version.id, ok=index % 2 == 0, latency_s=1.0 + index)
    stats = store.window(version.id)
    assert stats["samples"] == 10
    assert stats["errors"] == 5
    assert stats["error_rate"] == pytest.approx(0.5)
    assert stats["p95_latency_s"] >= 5.0
    store.close()


def test_maybe_rollback_triggers_on_error_rate() -> None:
    store = ConfigStore(":memory:")
    store.register({"prompts": {"plan": "base"}})
    canary = store.register({"prompts": {"plan": "canary"}}, promote=False)
    store._set_stage(canary.id, STAGE_CANARY)  # noqa: SLF001
    for _ in range(5):
        store.record_outcome(canary.id, ok=False, latency_s=1.0)

    reason = store.maybe_rollback(error_threshold=0.2, latency_threshold_s=60, min_samples=5)
    assert reason == "error_rate"
    assert store.canary() is None
    assert store.maybe_rollback(error_threshold=0.2, latency_threshold_s=60, min_samples=5) is None
    store.close()


def test_maybe_rollback_triggers_on_latency() -> None:
    store = ConfigStore(":memory:")
    store.register({"prompts": {"plan": "base"}})
    canary = store.register({"prompts": {"plan": "canary"}}, promote=False)
    store._set_stage(canary.id, STAGE_CANARY)  # noqa: SLF001
    for _ in range(5):
        store.record_outcome(canary.id, ok=True, latency_s=600.0)

    reason = store.maybe_rollback(error_threshold=0.2, latency_threshold_s=120, min_samples=5)
    assert reason == "latency"
    store.close()


def test_maybe_rollback_needs_enough_samples() -> None:
    store = ConfigStore(":memory:")
    store.register({"prompts": {}})
    canary = store.register({"prompts": {"plan": "canary"}}, promote=False)
    store._set_stage(canary.id, STAGE_CANARY)  # noqa: SLF001
    store.record_outcome(canary.id, ok=False, latency_s=1.0)

    assert store.maybe_rollback(error_threshold=0.2, latency_threshold_s=60, min_samples=5) is None
    assert store.canary() is not None, "样本不足时不能擅自回滚"
    store.close()

def test_outcomes_are_capped(tmp_path):
    """outcome 行按上限裁剪：10 万次调用不会让回滚库单调变大，窗口仍只看最近 50 条。"""
    from agent_pipeline.rollback import ConfigStore

    store = ConfigStore(tmp_path / "o.db", outcome_limit=5)
    version = store.register({"prompts": {"plan": "x"}})
    for i in range(12):
        store.record_outcome(version.id, ok=(i % 2 == 0), latency_s=0.1 * i)
    assert store.outcome_count() == 5
    window = store.window(version.id)
    assert window["samples"] == 5
    assert window["errors"] >= 1
    store.close()


def test_outcome_limit_zero_means_no_prune(tmp_path):
    from agent_pipeline.rollback import ConfigStore

    store = ConfigStore(tmp_path / "o.db", outcome_limit=0)
    version = store.register({"prompts": {"plan": "x"}})
    for _ in range(7):
        store.record_outcome(version.id, ok=True, latency_s=0.2)
    assert store.outcome_count() == 7
    store.close()
