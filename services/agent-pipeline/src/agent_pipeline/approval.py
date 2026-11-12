"""Tool 审批闸：Memory↔Tool 协议里「谁有权按下执行」的那一环。

设计取舍：这里不做 LangGraph 的 ``interrupt``（那需要 checkpointer + 恢复语义，
服务重启后还得能续跑），而是在**执行线程里同步等待**——一个 run 本来就有自己的
线程，等待期间只阻塞这一个 run，其它 run 照常跑。代价是审批不跨进程重启，收益是
状态简单、失败模式明确（超时即按拒绝处理，绝不「悄悄放过」）。

风险口径：只拦 ``risk != "read"`` 的工具。只读工具（http_get 之类）审批无意义，
全拦只会让用户点烦了直接关闸。
"""

from __future__ import annotations

import threading
import time
from typing import Any


class ApprovalGate:
    """按 (run_id, call_id) 记录待审批的工具调用，并阻塞等待裁决。"""

    def __init__(self, timeout_s: float = 300.0) -> None:
        self.timeout_s = max(0.05, float(timeout_s))
        self._lock = threading.Lock()
        self._pending: dict[tuple[str, str], dict[str, Any]] = {}
        self._events: dict[tuple[str, str], threading.Event] = {}
        self._verdicts: dict[tuple[str, str], bool] = {}

    def request(
        self,
        run_id: str,
        call_id: str,
        *,
        tool: str,
        arguments: dict[str, Any] | None = None,
    ) -> tuple[bool, str]:
        """登记一次待审批并阻塞。返回 (是否批准, 拒绝原因)；超时按拒绝。"""
        key = (str(run_id), str(call_id))
        event = threading.Event()
        with self._lock:
            self._pending[key] = {
                "run_id": key[0],
                "call_id": key[1],
                "tool": str(tool),
                "arguments": dict(arguments or {}),
                "requested_at": time.time(),
                "timeout_s": self.timeout_s,
            }
            self._events[key] = event
        approved = event.wait(self.timeout_s)
        with self._lock:
            verdict = self._verdicts.pop(key, None)
            self._pending.pop(key, None)
            self._events.pop(key, None)
        if not approved or verdict is None:
            return False, f"工具 {tool} 等待用户批准超时（{int(self.timeout_s)} 秒），已按拒绝处理"
        if verdict:
            return True, ""
        return False, f"用户拒绝了这次工具调用：{tool}（未执行）"

    def resolve(self, run_id: str, call_id: str, approved: bool) -> bool:
        """给等待中的调用一个裁决。返回是否真的命中了一条待审批。"""
        key = (str(run_id), str(call_id))
        with self._lock:
            if key not in self._pending:
                return False
            self._verdicts[key] = bool(approved)
            event = self._events.get(key)
        if event is not None:
            event.set()
        return True

    def pending(self, run_id: str | None = None) -> list[dict[str, Any]]:
        """待审批清单（可按 run 过滤），给 HTTP 轮询用。"""
        with self._lock:
            items = [dict(item) for item in self._pending.values()]
        if run_id is None:
            return sorted(items, key=lambda item: item["requested_at"])
        wanted = str(run_id)
        return sorted(
            (item for item in items if item["run_id"] == wanted),
            key=lambda item: item["requested_at"],
        )

    def cancel_run(self, run_id: str, reason: str = "运行已结束") -> int:
        """把一个 run 剩下的待审批全部按拒绝收口（进程退出、run 被取消时用）。"""
        wanted = str(run_id)
        with self._lock:
            keys = [key for key in self._pending if key[0] == wanted]
        for key in keys:
            self.resolve(key[0], key[1], False)
        return len(keys)