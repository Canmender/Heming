"""版本化配置 + 灰度 + 自动回滚。

Prompt、阈值、few-shot 都是**版本化对象**：线上永远只认「当前 active（或 canary）版本」，
改配置 = 注册新版本，回滚 = 把指针挪回去。这样任何一次「微调」都不会不可逆。
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS config_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'archived',
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    latency_s REAL NOT NULL,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS outcomes_version ON outcomes(version_id);
"""

STAGE_ARCHIVED = "archived"
STAGE_ACTIVE = "active"
STAGE_CANARY = "canary"


@dataclass
class Version:
    id: int
    payload: dict[str, Any]
    stage: str


class ConfigStore:
    def __init__(self, path: str | Path = ":memory:", outcome_limit: int = 5_000) -> None:
        # 每个 run 都会落一条 outcome，10 万次调用就是 10 万行：不封顶的话
        # 这个库只增不减，磁盘和 window() 的读放大都跟着涨。窗口只看最近 50 条，
        # 留 5000 条已经足够回滚判定，其余按 id 裁掉。
        self.outcome_limit = max(0, int(outcome_limit))
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    # ---- 版本 -------------------------------------------------------------

    def register(self, payload: dict[str, Any], *, promote: bool = True) -> Version:
        with self._lock:
            cursor = self._conn.execute(
                "INSERT INTO config_versions (payload, stage, created_at) VALUES (?,?,?)",
                (json.dumps(payload, ensure_ascii=False, sort_keys=True), STAGE_ARCHIVED, time.time()),
            )
            version_id = int(cursor.lastrowid)
            if promote:
                self._set_stage(version_id, STAGE_ACTIVE)
            self._conn.commit()
        return Version(version_id, payload, STAGE_ACTIVE if promote else STAGE_ARCHIVED)

    def _set_stage(self, version_id: int, stage: str) -> None:
        if stage == STAGE_ACTIVE:
            self._conn.execute("UPDATE config_versions SET stage = ? WHERE stage = ?", (STAGE_ARCHIVED, STAGE_ACTIVE))
        if stage == STAGE_CANARY:
            self._conn.execute("UPDATE config_versions SET stage = ? WHERE stage = ?", (STAGE_ARCHIVED, STAGE_CANARY))
        self._conn.execute("UPDATE config_versions SET stage = ? WHERE id = ?", (stage, version_id))

    def active(self) -> Version | None:
        return self._one(STAGE_ACTIVE)

    def canary(self) -> Version | None:
        return self._one(STAGE_CANARY)

    def _one(self, stage: str) -> Version | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT id, payload, stage FROM config_versions WHERE stage = ? ORDER BY id DESC LIMIT 1",
                (stage,),
            ).fetchone()
        if row is None:
            return None
        return Version(int(row["id"]), json.loads(row["payload"]), row["stage"])

    def get(self, version_id: int) -> Version | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT id, payload, stage FROM config_versions WHERE id = ?", (version_id,)
            ).fetchone()
        if row is None:
            return None
        return Version(int(row["id"]), json.loads(row["payload"]), row["stage"])

    def history(self, limit: int = 20) -> list[Version]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, payload, stage FROM config_versions ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [Version(int(r["id"]), json.loads(r["payload"]), r["stage"]) for r in rows]

    def promote_canary(self) -> Version | None:
        """灰度验证通过：canary 转正，旧 active 归档。"""
        with self._lock:
            canary = self.canary()
            if canary is None:
                return None
            self._set_stage(canary.id, STAGE_ACTIVE)
            self._conn.commit()
        return self.active()

    def rollback(self, reason: str = "manual") -> Version | None:
        """把 canary 归档，active 保持不变（幂等：没有 canary 时什么都不做）。

        需要「退回某个具体历史版本」时用 :meth:`activate`——因为单凭 rollback 无法
        区分「回滚灰度」与「人工后悔上一次 promote」，来回点会把 active 弹回去。
        """
        with self._lock:
            canary = self.canary()
            if canary is None:
                return self.active()
            self._set_stage(canary.id, STAGE_ARCHIVED)
            self._conn.commit()
        return self.active()

    def activate(self, version_id: int) -> Version | None:
        """把指定历史版本重新设为 active（其余 active/canary 归档）；不存在返回 None。"""
        with self._lock:
            version = self.get(version_id)
            if version is None:
                return None
            canary = self.canary()
            if canary is not None and canary.id != version.id:
                # 人工切版本时灰度必须一起收掉：否则同一时刻有两套配置在跑，
                # 「我明明切回去了怎么还是新提示词」就是这种状态。
                self._set_stage(canary.id, STAGE_ARCHIVED)
            self._set_stage(version.id, STAGE_ACTIVE)
            self._conn.commit()
        return self.active()

    def select_for_run(self, run_id: str, canary_ratio: float) -> Version | None:
        """按 run_id 稳定分桶：同一个 run 重试仍落在同一版本。"""
        canary = self.canary()
        if canary is not None and canary_ratio > 0:
            digest = hashlib.sha256(run_id.encode("utf-8")).digest()
            bucket = int.from_bytes(digest[:4], "big") / 0xFFFFFFFF
            if bucket < canary_ratio:
                return canary
        return self.active()

    # ---- 结果与回滚 -------------------------------------------------------

    def record_outcome(self, version_id: int, *, ok: bool, latency_s: float) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO outcomes (version_id, ok, latency_s, created_at) VALUES (?,?,?,?)",
                (version_id, 1 if ok else 0, float(latency_s), time.time()),
            )
            if self.outcome_limit:
                self._conn.execute(
                    "DELETE FROM outcomes WHERE id NOT IN (SELECT id FROM outcomes ORDER BY id DESC LIMIT ?)",
                    (self.outcome_limit,),
                )
            self._conn.commit()

    def outcome_count(self) -> int:
        with self._lock:
            row = self._conn.execute("SELECT COUNT(*) AS n FROM outcomes").fetchone()
        return int(row["n"] if isinstance(row, sqlite3.Row) else row[0])

    def window(self, version_id: int, limit: int = 50) -> dict[str, Any]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT ok, latency_s FROM outcomes WHERE version_id = ? ORDER BY id DESC LIMIT ?",
                (version_id, limit),
            ).fetchall()
        latencies = sorted(float(r["latency_s"]) for r in rows)
        total = len(rows)
        errors = sum(1 for r in rows if not r["ok"])
        p95 = latencies[min(total - 1, int(round(0.95 * (total - 1))))] if total else 0.0
        return {
            "samples": total,
            "errors": errors,
            "error_rate": (errors / total) if total else 0.0,
            "p95_latency_s": p95,
        }

    def maybe_rollback(self, *, error_threshold: float, latency_threshold_s: float, min_samples: int) -> str | None:
        """只看 canary 的窗口；超阈值就回滚。返回回滚原因（没回滚返回 None）。"""
        canary = self.canary()
        if canary is None:
            return None
        stats = self.window(canary.id)
        if stats["samples"] < min_samples:
            return None
        if stats["error_rate"] > error_threshold:
            self.rollback("error_rate")
            return "error_rate"
        if stats["p95_latency_s"] > latency_threshold_s:
            self.rollback("latency")
            return "latency"
        return None

    def close(self) -> None:
        with self._lock:
            self._conn.close()