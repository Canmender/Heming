from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Conversation:
    source: str
    account: str
    external_id: str
    name: str
    kind: str = "private"
    avatar: str = ""
    last_ts: int = 0
    meta: dict = field(default_factory=dict)


@dataclass
class Message:
    external_id: str
    ts: int
    sender_id: str = ""
    sender_name: str = ""
    is_self: bool | None = None
    type_code: int | None = None
    type_label: str = "文本"
    content: str = ""
    media: object | None = None


@dataclass
class SyncReport:
    source: str
    conversations: int = 0
    added: int = 0
    updated: int = 0
    scanned_files: int = 0
    skipped: int = 0
    errors: list[str] = field(default_factory=list)
    elapsed: float = 0.0

    def summary(self) -> str:
        parts = []
        if self.conversations:
            parts.append(f"{self.conversations} 个会话")
        parts.append(f"新增 {self.added} 条")
        if self.scanned_files:
            parts.append(f"扫描 {self.scanned_files} 个文件")
        if self.skipped:
            parts.append(f"跳过 {self.skipped} 个未变化")
        if self.errors:
            parts.append(f"{len(self.errors)} 个错误")
        return "，".join(parts)
