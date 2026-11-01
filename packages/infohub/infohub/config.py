from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent


def resolve_home() -> Path:
    """运行目录：配置与 data/ 都放在这里。

    和鸣桌面端用 `INFOHUB_HOME` 指向用户已有的 InfoHub 归档目录；
    不设时退回源码目录（独立 CLI/旧 GUI 的用法）。
    """
    env = os.environ.get("INFOHUB_HOME", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    return ROOT


HOME = resolve_home()
CONFIG_PATH = HOME / "config.json"


def _drive_candidates() -> list[Path]:
    roots = []
    for letter in "CDEFG":
        root = Path(f"{letter}:/")
        if root.exists():
            roots.append(root)
    return roots


def detect_wechat_dir() -> str:
    """返回账号目录的父目录（含 xwechat_files 的那一层）。"""
    candidates: list[Path] = []
    profile = os.environ.get("USERPROFILE")
    if profile:
        candidates.append(Path(profile) / "Documents" / "xwechat_files")
        candidates.append(Path(profile) / "Documents" / "WeChat Files")
    for root in _drive_candidates():
        candidates.append(root / "xwechat_files")
        candidates.append(root / "WeChatData" / "xwechat_files")
        candidates.append(root / "WeChat Files")

    for path in candidates:
        try:
            if not path.is_dir():
                continue
            for child in path.iterdir():
                if (child / "db_storage").is_dir():
                    return str(path)
        except OSError:
            continue
    return ""


def detect_qq_export_dir() -> str:
    candidates = [
        HOME / "qq_exports",
        Path("D:/自动化/聊天原始数据"),
        Path.home() / "Documents" / "QQChatExporter",
    ]
    env = os.environ.get("INFOHUB_QQ_EXPORT_DIR")
    if env:
        candidates.insert(0, Path(env))
    for path in candidates:
        if path.is_dir() and any(path.glob("*.html")) or path.is_dir() and any(path.glob("*.txt")):
            return str(path)
    return str(candidates[0]) if candidates else ""


DEFAULTS: dict[str, Any] = {
    "data_dir": "data",
    "auto_sync_on_start": True,
    "wechat": {
        "enabled": True,
        "db_dir": "",
        "sync_interval_min": 30,
        "blocked_prefixes": ["gh_", "@openim", "fmessage", "medianote", "newsapp", "weixin", "notifymessage", "brandsessionholder", "floatbottle", "qqmail", "tmessage", "qmessage", "officialaccounts", "filehelper"],
    },
    "qq": {
        "enabled": True,
        "mode": "nt",
        "nt_account": "",
        "nt_db": "",
        "key_timeout": 20,
        "export_dir": "",
        "scan_interval_sec": 60,
    },
    "ui": {
        "page_size": 800,
    },
    "voice": {
        "enabled": True,
        "model_dir": "",
        "ffmpeg": "",
        "threads": 2,
        "language": "",
    },
    "kb": {
        "vault": "",
        "auto_export": True,
        "agenda_days": 30,
        "agenda_overdue_days": 3,
        "notice_days": 7,
        "notice_limit": 150,
        "media_days": 0,
        "media_skip_mb": 0,
        "notice_conv_keywords": [],
        "notice_conv_exclude": [],
        "agenda_conv_exclude": [],
    },
    "digest": {
        "enabled": True,
        "interval_min": 60,
        "hours": 1,
        "self_names": [],
        "exclude_convs": [],
        "toast": True,
        "obsidian": True,
        "top_convs": 8,
    },
    "notice": {
        "enabled": True,
        "time": "17:00",
        "class_name": "金融2601",
        "days_ahead": 14,
        "lookback_days": 3,
        "max_items": 10,
        "ai": True,
        "conv_keywords": [],
        "exclude_convs": [],
    },
    "agent": {
        "enabled": True,
        "sync_interval_min": 5,
        "agenda_ai": True,
        "plan": ["sync", "analyze", "archive", "agenda", "push"],
        "archive": True,
        "push": True,
    },
    "push": {
        "enabled": False,
        "channel": "smtp",
        "send_empty": False,
        "wecom_bot_id": "",
        "wecom_bot_secret": "",
        "wecom_bot_port": 8765,
        "wecom_webhook": "",
        "smtp_host": "smtp.qq.com",
        "smtp_port": 465,
        "smtp_user": "",
        "smtp_pass": "",
        "mail_to": "",
    },
    "llm": {
        "enabled": False,
        "base_url": "http://127.0.0.1:11434/v1",
        "model": "qwen2.5:7b",
        "api_key": "",
        "timeout": 60,
        "max_chars": 6000,
        "allow_remote": False,
        "prompt": "",
        "agent_prompt": "",
    },
}


def _merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = value
    return out


@dataclass
class Config:
    raw: dict = field(default_factory=dict)
    path: Path = CONFIG_PATH

    @property
    def data_dir(self) -> Path:
        value = Path(self.raw.get("data_dir") or "data")
        return value if value.is_absolute() else HOME / value

    @property
    def archive_db(self) -> Path:
        return self.data_dir / "archive.db"

    @property
    def wechat(self) -> dict:
        return self.raw.get("wechat", {})

    @property
    def qq(self) -> dict:
        return self.raw.get("qq", {})

    @property
    def ui(self) -> dict:
        return self.raw.get("ui", {})

    @property
    def kb(self) -> dict:
        return self.raw.get("kb", {})

    @property
    def voice(self) -> dict:
        return self.raw.get("voice", {})

    @property
    def digest(self) -> dict:
        return self.raw.get("digest", {})

    @property
    def notice(self) -> dict:
        return self.raw.get("notice", {})

    @property
    def push(self) -> dict:
        return self.raw.get("push", {})

    @property
    def agent(self) -> dict:
        return self.raw.get("agent", {})

    def save(self) -> None:
        self.path.write_text(json.dumps(self.raw, ensure_ascii=False, indent=2), encoding="utf-8")


def _initial_raw() -> dict:
    from .kb import DEFAULT_AGENDA_EXCLUDE, DEFAULT_NOTICE_KEYWORDS, detect_vault

    raw = json.loads(json.dumps(DEFAULTS))
    raw["wechat"]["db_dir"] = detect_wechat_dir()
    raw["qq"]["export_dir"] = detect_qq_export_dir()
    raw["kb"]["vault"] = detect_vault()
    raw["kb"]["notice_conv_keywords"] = list(DEFAULT_NOTICE_KEYWORDS)
    raw["kb"]["agenda_conv_exclude"] = list(DEFAULT_AGENDA_EXCLUDE)
    return raw


def load_config(create: bool = True) -> Config:
    raw: dict = {}
    if CONFIG_PATH.exists():
        try:
            raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raw = {}
    merged = _merge(DEFAULTS, raw)
    if create and not CONFIG_PATH.exists():
        merged = _initial_raw()
        cfg = Config(raw=merged)
        cfg.path.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
        return cfg
    return Config(raw=merged)


def save_config(raw: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
