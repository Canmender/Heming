from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

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


# ---------------------------------------------------------------- 目录自动识别
#
# 原则：只查「约定位置」的有限候选路径，绝不递归扫全盘（个人电脑上遍历磁盘
# 既慢又容易碰到无权限目录）。所有 detect_* 都接受可注入的候选路径，
# 测试可以完全脱离本机真实目录。

def _dedupe(paths: Iterable[Path]) -> list[Path]:
    seen: set[str] = set()
    out: list[Path] = []
    for path in paths:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        out.append(path)
    return out


def _env_path(name: str) -> Path | None:
    value = os.environ.get(name, "").strip()
    return Path(value) if value else None


def _user_homes() -> list[Path]:
    """Windows 用 USERPROFILE；类 Unix/精简环境退回 HOME 与 Path.home()。"""
    homes: list[Path] = []
    for key in ("USERPROFILE", "HOME"):
        value = os.environ.get(key, "").strip()
        if value:
            home = Path(value)
            if home not in homes:
                homes.append(home)
    if not homes:
        try:
            homes.append(Path.home())
        except RuntimeError:
            pass
    return homes


def _drive_candidates() -> list[Path]:
    roots = []
    for letter in "CDEFG":
        root = Path(f"{letter}:/")
        try:
            exists = root.exists()
        except OSError:
            exists = False
        if exists:
            roots.append(root)
    return roots


def _wechat_candidates() -> list[Path]:
    """微信数据目录的候选层（含账号目录的那一层）。"""
    names = ("xwechat_files", "WeChat Files")
    candidates: list[Path] = []
    for home in _user_homes():
        for name in names:
            candidates.append(home / "Documents" / name)
    for key in ("APPDATA", "LOCALAPPDATA"):
        base = _env_path(key)
        if base is None:
            continue
        for name in names:
            candidates.append(base / "Tencent" / name)
    for root in _drive_candidates():
        candidates.append(root / "xwechat_files")
        candidates.append(root / "WeChatData" / "xwechat_files")
        candidates.append(root / "WeChat Files")
    return _dedupe(candidates)


def _is_wechat_data_dir(path: Path) -> bool:
    try:
        if (path / "db_storage").is_dir():
            return True
        for child in path.iterdir():
            if child.is_dir() and (child / "db_storage").is_dir():
                return True
    except OSError:
        pass
    return False


def detect_wechat_dir(candidates: Iterable[Path] | None = None) -> str:
    """返回账号目录的父目录（含 xwechat_files 的那一层）。

    兼容 3.x 的 `WeChat Files` 与 4.x 的 `xwechat_files`，以及把数据目录
    放到其他盘符根的常见做法。找不到返回空串。
    """
    for candidate in candidates if candidates is not None else _wechat_candidates():
        path = Path(candidate)
        try:
            if not path.is_dir():
                continue
        except OSError:
            continue
        if not _is_wechat_data_dir(path):
            continue
        # 候选本身就是账号目录（含 db_storage）时，返回其父层。
        return str(path.parent) if (path / "db_storage").is_dir() else str(path)
    return ""


def _qq_base_candidates() -> list[Path]:
    """可能存放「QQNT 账号目录」的父目录。"""
    bases: list[Path] = []
    env = os.environ.get("INFOHUB_QQ_NT_DIR", "").strip()
    if env:
        bases.append(Path(env))
    for home in _user_homes():
        bases.append(home / "Documents" / "Tencent Files")
    for root in _drive_candidates():
        bases.append(root / "Tencent Files")
        bases.append(root / "Tencent" / "Tencent Files")
        bases.append(root / "Documents" / "Tencent Files")
    for key in ("APPDATA", "LOCALAPPDATA"):
        base = _env_path(key)
        if base is None:
            continue
        bases.append(base / "Tencent" / "QQ")
        bases.append(base / "Tencent" / "QQ" / "Tencent Files")
    return _dedupe(bases)


#: 每个候选父目录下只做有限深度 glob，不做 rglob。
_QQ_DB_PATTERNS = (
    "*/nt_qq/nt_db/nt_msg.db",
    "*/Tencent Files/*/nt_qq/nt_db/nt_msg.db",
    "nt_qq/nt_db/nt_msg.db",
)


def detect_qq_nt_db(roots: Iterable[Path] | None = None) -> str:
    """找 QQNT 的 nt_msg.db，多个账号时取最近修改的那个。

    返回值是 db 文件路径（qq.nt_db 的语义）。不 import sources.qqnt，
    避免 config → sources → config 的循环依赖。
    """
    hits: dict[str, float] = {}
    for base in roots if roots is not None else _qq_base_candidates():
        path = Path(base)
        try:
            if not path.is_dir():
                continue
            for pattern in _QQ_DB_PATTERNS:
                for found in path.glob(pattern):
                    try:
                        if not found.is_file():
                            continue
                        hits[str(found)] = found.stat().st_mtime
                    except OSError:
                        continue
        except OSError:
            continue
    if not hits:
        return ""
    return max(hits.items(), key=lambda item: item[1])[0]


def _qq_account_from_db(db: str | Path) -> str:
    """从 db 路径反推账号：最近的一层纯数字目录名。"""
    if not db:
        return ""
    for parent in Path(db).parents:
        if parent.name.isdigit():
            return parent.name
    return ""


def _qq_export_candidates() -> list[Path]:
    candidates: list[Path] = []
    env = os.environ.get("INFOHUB_QQ_EXPORT_DIR", "").strip()
    if env:
        candidates.append(Path(env))
    candidates.append(HOME / "qq_exports")
    candidates.append(Path("D:/自动化/聊天原始数据"))
    for home in _user_homes():
        candidates.append(home / "Documents" / "QQChatExporter")
    return _dedupe(candidates)


def detect_qq_export_dir(candidates: Iterable[Path] | None = None) -> str:
    """找 QQChatExporter / 旧版导出目录；找不到返回空串（不再假装有目录）。"""
    for candidate in candidates if candidates is not None else _qq_export_candidates():
        path = Path(candidate)
        try:
            if not path.is_dir():
                continue
            if any(path.glob("*.html")) or any(path.glob("*.txt")):
                return str(path)
        except OSError:
            continue
    return ""


def detect_sources(
    wechat_candidates: Iterable[Path] | None = None,
    qq_roots: Iterable[Path] | None = None,
    export_candidates: Iterable[Path] | None = None,
) -> dict:
    """一次性识别 QQ / 微信的信息目录。

    QQNT 优先于导出目录：两者都找到时仍如实返回导出目录，但 `detected`
    由 NT 库决定「可采集」；`export_detected` 单独标出导出目录状态。
    """
    wechat_dir = detect_wechat_dir(wechat_candidates)
    nt_db = detect_qq_nt_db(qq_roots)
    export_dir = detect_qq_export_dir(export_candidates)
    return {
        "wechat": {"db_dir": wechat_dir, "detected": bool(wechat_dir)},
        "qq": {
            "nt_db": nt_db,
            "nt_account": _qq_account_from_db(nt_db),
            "export_dir": export_dir,
            "export_detected": bool(export_dir),
            "detected": bool(nt_db or export_dir),
        },
    }


def source_status(cfg: "Config") -> dict:
    """只读：已配置路径优先，缺失时做一次本机检测（不写配置）。

    Bridge 的 status / config.summary 用它给出「已识别 / 未找到」，
    与 detect_sources() 同口径，但把用户手填的路径也算进来。
    """
    raw = cfg.raw or {}
    wechat_cfg = raw.get("wechat") or {}
    qq_cfg = raw.get("qq") or {}
    db_dir = str(wechat_cfg.get("db_dir") or "").strip() or detect_wechat_dir()
    nt_db = str(qq_cfg.get("nt_db") or "").strip() or detect_qq_nt_db()
    export_dir = str(qq_cfg.get("export_dir") or "").strip() or detect_qq_export_dir()
    nt_account = (
        str(qq_cfg.get("nt_account") or "").strip()
        or _qq_account_from_db(nt_db)
    )
    nt_ok = _is_file(nt_db)
    export_ok = _is_dir(export_dir)
    return {
        "wechat": {
            "db_dir": db_dir,
            "detected": bool(db_dir) and _is_dir(db_dir),
        },
        "qq": {
            "nt_db": nt_db,
            "nt_account": nt_account,
            "export_dir": export_dir,
            "export_detected": export_ok,
            "detected": nt_ok or export_ok,
        },
    }


def _is_dir(path: str | Path) -> bool:
    if not str(path).strip():
        return False
    try:
        return Path(path).is_dir()
    except OSError:
        return False


def _is_file(path: str | Path) -> bool:
    if not str(path).strip():
        return False
    try:
        return Path(path).is_file()
    except OSError:
        return False


def _atomic_write(path: Path, text: str) -> None:
    """同目录临时文件 + os.replace：写一半崩掉也不会留下残缺 config.json。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def ensure_detected_config(cfg: "Config") -> bool:
    """把检测到的目录补进空配置项；只有真的变了才写回 config.json。

    返回是否发生了写回。任何异常都吞掉：自动识别失败不能拖垮采集/桥。
    """
    try:
        raw = cfg.raw
        if not isinstance(raw, dict):
            return False
        wechat = raw.setdefault("wechat", {})
        qq = raw.setdefault("qq", {})
        changed = False
        if not str(wechat.get("db_dir") or "").strip():
            found = detect_wechat_dir()
            if found:
                wechat["db_dir"] = found
                changed = True
        if not str(qq.get("nt_db") or "").strip():
            db = detect_qq_nt_db()
            if db:
                qq["nt_db"] = db
                if not str(qq.get("nt_account") or "").strip():
                    qq["nt_account"] = _qq_account_from_db(db)
                changed = True
        if not str(qq.get("export_dir") or "").strip():
            export = detect_qq_export_dir()
            if export:
                qq["export_dir"] = export
                changed = True
        if changed:
            _atomic_write(cfg.path, json.dumps(raw, ensure_ascii=False, indent=2))
        return changed
    except Exception:
        return False


DEFAULTS: dict[str, Any] = {
    "data_dir": "data",
    "auto_detect": True,
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
        _atomic_write(self.path, json.dumps(self.raw, ensure_ascii=False, indent=2))


def _initial_raw() -> dict:
    from .kb import DEFAULT_AGENDA_EXCLUDE, DEFAULT_NOTICE_KEYWORDS, detect_vault

    raw = json.loads(json.dumps(DEFAULTS))
    detected = detect_sources()
    raw["wechat"]["db_dir"] = detected["wechat"]["db_dir"]
    raw["qq"]["nt_db"] = detected["qq"]["nt_db"]
    raw["qq"]["nt_account"] = detected["qq"]["nt_account"]
    raw["qq"]["export_dir"] = detected["qq"]["export_dir"]
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
        _atomic_write(cfg.path, json.dumps(merged, ensure_ascii=False, indent=2))
        return cfg
    return Config(raw=merged)


def save_config(raw: dict) -> None:
    _atomic_write(CONFIG_PATH, json.dumps(raw, ensure_ascii=False, indent=2))
