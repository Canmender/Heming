"""和鸣桌面端的本机桥：换行分隔的 JSON，经 stdin/stdout 与 Electron 主进程通信。

为什么要 stdio 而不是 HTTP：聊天归档是个人数据，桥只应与拉起它的桌面进程通信。
不开端口、不监听回环地址、不引入 token，进程一退出通道就消失。

协议（每行一个 JSON 对象）：
    请求  {"id": 1, "method": "conversations", "params": {...}}
    成功  {"id": 1, "ok": true, "result": ...}
    失败  {"id": 1, "ok": false, "error": {"type": "...", "message": "..."}}
    事件  {"event": "progress", "phase": "sync", "stage": "...", ...}

stdout 只允许出现协议行；运行期的普通 print 全部改道 stderr，避免污染协议。
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any, Callable

from . import __version__
from . import agenda as agenda_mod
from .config import CONFIG_PATH, HOME, load_config
from .store import Store

PROTOCOL_VERSION = 1

#: 单行请求上限：消息正文不经过这里，正常请求只有几 KB。
MAX_LINE_BYTES = 4 * 1024 * 1024

_ALLOWED_METHODS = {
    "ping",
    "status",
    "conversations",
    "messages",
    "search",
    "agenda",
    "sync",
    "config.summary",
    "shutdown",
}

#: 这些方法可能跑几分钟（采集/语音转写），单独放宽超时。
_LONG_METHODS = {"sync"}

_OUT = sys.stdout


def _emit(payload: dict) -> None:
    _OUT.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    _OUT.flush()


def _error(request_id: Any, exc: BaseException) -> dict:
    message = str(exc) or exc.__class__.__name__
    if len(message) > 800:
        message = message[:800] + "…"
    return {
        "id": request_id,
        "ok": False,
        "error": {"type": exc.__class__.__name__, "message": message},
    }


def _row(row: Any) -> dict:
    return {key: row[key] for key in row.keys()}


def _int_param(params: dict, name: str, default: int, low: int, high: int) -> int:
    value = params.get(name, default)
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(low, min(high, number))


def _bool_param(params: dict, name: str, default: bool = False) -> bool:
    value = params.get(name, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _conversation(row: Any) -> dict:
    item = _row(row)
    meta: Any = {}
    try:
        meta = json.loads(item.get("meta") or "{}")
    except (TypeError, ValueError):
        meta = {}
    item["meta"] = meta if isinstance(meta, dict) else {}
    return item


def _message(row: Any) -> dict:
    item = _row(row)
    if item.get("is_self") is not None:
        item["is_self"] = bool(item["is_self"])
    return item


def _media(row: Any) -> dict:
    item = _row(row)
    # 路径是归档库里的本机绝对路径：只回给桌面端，页面不把它渲染成链接。
    return {
        "messageId": item["message_id"],
        "kind": item["kind"],
        "name": item["name"],
        "width": item["width"],
        "height": item["height"],
        "size": item["size"],
        "hasPath": bool(item["path"]),
    }


class _Progress:
    """把采集进度节流成事件：扫描时回调很密，全部转发会把管道塞满。"""

    def __init__(self, phase: str, min_interval: float = 0.1) -> None:
        self.phase = phase
        self.min_interval = min_interval
        self.last = 0.0
        self.last_stage = ""

    def __call__(self, stage: str, current: int, total: int) -> None:
        now = time.monotonic()
        finished = total > 0 and current >= total
        if not finished and now - self.last < self.min_interval:
            return
        self.last = now
        self.last_stage = stage
        _emit(
            {
                "event": "progress",
                "phase": self.phase,
                "stage": str(stage)[:200],
                "current": int(current),
                "total": int(total),
            }
        )


def _open_store(cfg: Any, create: bool = False) -> Store | None:
    path = cfg.archive_db
    if not create and not path.is_file():
        return None
    return Store(path, readonly=not create)


def _config_summary(cfg: Any) -> dict:
    """只回非敏感配置；密钥、口令、Webhook 一律不出桥。"""
    raw = cfg.raw
    push = raw.get("push") or {}
    llm = raw.get("llm") or {}
    return {
        "dataDir": str(cfg.data_dir),
        "configPath": str(CONFIG_PATH),
        "wechat": {
            "enabled": bool((raw.get("wechat") or {}).get("enabled", True)),
            "dbDir": (raw.get("wechat") or {}).get("db_dir", ""),
        },
        "qq": {
            "enabled": bool((raw.get("qq") or {}).get("enabled", True)),
            "mode": (raw.get("qq") or {}).get("mode", "nt"),
            "ntAccount": (raw.get("qq") or {}).get("nt_account", ""),
        },
        "voice": {"enabled": bool((raw.get("voice") or {}).get("enabled", True))},
        "kb": {
            "vault": (raw.get("kb") or {}).get("vault", ""),
            "autoExport": bool((raw.get("kb") or {}).get("auto_export", True)),
        },
        "digest": {
            "enabled": bool((raw.get("digest") or {}).get("enabled", True)),
            "intervalMin": (raw.get("digest") or {}).get("interval_min", 60),
        },
        "agent": {"enabled": bool((raw.get("agent") or {}).get("enabled", True))},
        "push": {
            "enabled": bool(push.get("enabled", False)),
            "channel": push.get("channel", "smtp"),
            "hasCredentials": bool(
                push.get("wecom_bot_secret") or push.get("wecom_webhook") or push.get("smtp_pass")
            ),
        },
        "llm": {
            "enabled": bool(llm.get("enabled", False)),
            "baseUrl": llm.get("base_url", ""),
            "model": llm.get("model", ""),
            "hasKey": bool(llm.get("api_key")),
            "allowRemote": bool(llm.get("allow_remote", False)),
        },
    }


class Bridge:
    def __init__(self) -> None:
        self._store: Store | None = None
        self._stop = False

    @property
    def cfg(self) -> Any:
        return load_config(create=False)

    def _store_read(self) -> Store | None:
        if self._store is None:
            self._store = _open_store(self.cfg, create=False)
        return self._store

    def close(self) -> None:
        if self._store is not None:
            try:
                self._store.close()
            finally:
                self._store = None

    # ---------- 方法 ----------

    def ping(self, _params: dict) -> dict:
        cfg = self.cfg
        db = cfg.archive_db
        return {
            "app": "infohub",
            "version": __version__,
            "protocol": PROTOCOL_VERSION,
            "home": str(HOME),
            "python": sys.executable,
            "configPath": str(CONFIG_PATH),
            "configExists": CONFIG_PATH.is_file(),
            "dbPath": str(db),
            "hasDb": db.is_file(),
        }

    def status(self, _params: dict) -> dict:
        cfg = self.cfg
        db = cfg.archive_db
        result: dict = {
            "home": str(HOME),
            "configPath": str(CONFIG_PATH),
            "configExists": CONFIG_PATH.is_file(),
            "dbPath": str(db),
            "hasDb": db.is_file(),
            "config": _config_summary(cfg),
            "stats": {"conversations": 0, "messages": 0, "per_source": {}},
            "sources": {},
            "events": 0,
            "media": {},
            "dbBytes": 0,
        }
        try:
            result["dbBytes"] = db.stat().st_size
        except OSError:
            pass
        store = self._store_read()
        if store is None:
            return result
        result["stats"] = store.stats()
        result["sources"] = {
            key: {"status": row["status"], "lastRun": row["last_run_ts"], "detail": row["detail"]}
            for key, row in store.source_states().items()
        }
        result["events"] = store.event_count()
        result["media"] = store.media_stats()
        try:
            row = store.conn.execute("SELECT MAX(ts) AS last_ts FROM messages").fetchone()
            result["lastMessageTs"] = int(row["last_ts"] or 0) if row else 0
        except Exception:
            result["lastMessageTs"] = 0
        return result

    def conversations(self, params: dict) -> dict:
        store = self._store_read()
        if store is None:
            return {"items": [], "dbMissing": True}
        source = params.get("source")
        if source not in (None, "", "qq", "wechat"):
            raise ValueError("source 只能是 qq / wechat")
        keyword = str(params.get("keyword") or "")[:200]
        limit = _int_param(params, "limit", 500, 1, 5000)
        rows = store.list_conversations(source=source or None, keyword=keyword)
        return {
            "items": [_conversation(row) for row in rows[:limit]],
            "total": len(rows),
        }

    def messages(self, params: dict) -> dict:
        try:
            conv_id = int(params.get("conversationId") or 0)
        except (TypeError, ValueError):
            conv_id = 0
        if conv_id <= 0:
            raise ValueError("缺少 conversationId")
        limit = _int_param(params, "limit", 400, 1, 1000)
        before = params.get("beforeTs")
        before_ts = None
        if before not in (None, "", 0):
            before_ts = _int_param(params, "beforeTs", 0, 1, 2**31 - 1)
        store = self._store_read()
        if store is None:
            return {"dbMissing": True, "conversation": None, "items": []}
        conv = store.get_conversation(conv_id)
        if conv is None:
            raise ValueError("会话不存在")
        rows = store.get_messages(conv_id, limit=limit, before_ts=before_ts)
        media = store.media_for([row["id"] for row in rows])
        items = []
        for row in rows:
            item = _message(row)
            found = media.get(int(row["id"]))
            item["media"] = _media(found) if found else None
            items.append(item)
        return {
            "conversation": _conversation(conv),
            "items": items,
            "hasMore": len(rows) >= limit,
            "beforeTs": rows[0]["ts"] if rows else before_ts,
        }

    def search(self, params: dict) -> dict:
        query = str(params.get("query") or "").strip()
        if not query:
            return {"items": [], "query": ""}
        if len(query) > 200:
            query = query[:200]
        limit = _int_param(params, "limit", 100, 1, 500)
        store = self._store_read()
        if store is None:
            return {"items": [], "query": query, "dbMissing": True}
        items = []
        for row in store.search(query, limit=limit):
            items.append(
                {
                    "id": row["id"],
                    "conversationId": row["conversation_id"],
                    "ts": row["ts"],
                    "senderName": row["sender_name"],
                    "content": row["content"],
                    "snippet": row["snippet"],
                    "convName": row["conv_name"],
                    "source": row["source"],
                }
            )
        return {"items": items, "query": query}

    def agenda(self, params: dict) -> dict:
        days = _int_param(params, "days", 14, 0, 365)
        overdue = _int_param(params, "overdue", 30, 0, 365)
        rebuild = _bool_param(params, "rebuild")
        cfg = self.cfg
        if not cfg.archive_db.is_file():
            return {"items": [], "summary": {"overdue": 0, "today": 0, "week": 0, "total": 0}, "dbMissing": True}
        self.close()
        store = Store(cfg.archive_db, readonly=not rebuild)
        try:
            if rebuild:
                agenda_mod.rebuild(store)
                store.set_agenda_cursor(store.max_message_id(), "manual rebuild")
            now = int(time.time())
            rows = store.agenda(now - overdue * 86400, now + days * 86400)
            items = []
            for row in rows:
                items.append(
                    {
                        "id": row["id"],
                        "messageId": row["message_id"],
                        "conversationId": row["conversation_id"],
                        "title": row["title"],
                        "detail": row["detail"],
                        "dueTs": row["due_ts"],
                        "dueText": row["due_text"],
                        "allDay": bool(row["all_day"]),
                        "kind": row["kind"],
                        "status": row["status"],
                        "convName": row["conv_name"],
                        "source": row["source"],
                        "senderName": row["sender_name"],
                        "msgTs": row["msg_ts"],
                    }
                )
            overdue_n, today_n, week_n = agenda_mod.summary(rows, now)
            return {
                "items": items,
                "summary": {"overdue": overdue_n, "today": today_n, "week": week_n, "total": len(items)},
            }
        finally:
            store.close()

    def sync(self, params: dict) -> dict:
        raw_sources = params.get("sources")
        if raw_sources in (None, ""):
            sources = ["qq", "wechat"]
        elif isinstance(raw_sources, list) and all(s in ("qq", "wechat") for s in raw_sources):
            sources = list(dict.fromkeys(raw_sources))
        else:
            raise ValueError("sources 只能是 qq / wechat 的数组")
        full = _bool_param(params, "full")
        archive = _bool_param(params, "archive")
        cfg = load_config(create=True)
        progress = _Progress("sync")
        self.close()
        store = Store(cfg.archive_db)
        try:
            from .sync import sync_all  # 依赖采集包，延迟到真正采集时再导入

            reports = sync_all(cfg, store=store, sources=sources, full=full, progress=progress)
            agenda_changed = agenda_mod.update_agenda(store, cfg)
            kb_stats = None
            if archive and (cfg.kb or {}).get("auto_export"):
                from .kb import export_all

                kb_stats = export_all(cfg, store, progress=_Progress("kb"))
            return {
                "reports": [
                    {
                        "source": report.source,
                        "conversations": report.conversations,
                        "added": report.added,
                        "updated": report.updated,
                        "scannedFiles": report.scanned_files,
                        "skipped": report.skipped,
                        "errors": report.errors,
                        "elapsed": round(report.elapsed, 2),
                    }
                    for report in reports
                ],
                "agenda": agenda_changed,
                "kb": kb_stats,
            }
        except ImportError as exc:
            raise RuntimeError(
                "缺少 InfoHub 采集依赖（wechatauto-replica / zstandard / cryptography 等）。"
                "请把「Python 解释器」指向 InfoHub 的虚拟环境，或在打包时安装这些依赖。"
                f" 原始错误：{exc}"
            ) from exc
        finally:
            store.close()
            self._store = None

    def config_summary(self, _params: dict) -> dict:
        return _config_summary(self.cfg)

    def shutdown(self, _params: dict) -> dict:
        self._stop = True
        return {"stopped": True}


def _dispatch(bridge: Bridge, method: str, params: dict) -> Any:
    if method not in _ALLOWED_METHODS:
        raise ValueError(f"未知方法：{method}")
    handler: Callable[[dict], Any] = {
        "ping": bridge.ping,
        "status": bridge.status,
        "conversations": bridge.conversations,
        "messages": bridge.messages,
        "search": bridge.search,
        "agenda": bridge.agenda,
        "sync": bridge.sync,
        "config.summary": bridge.config_summary,
        "shutdown": bridge.shutdown,
    }[method]
    return handler(params)


def main() -> int:
    global _OUT
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    try:
        _OUT.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    # 协议行只走 _OUT；第三方或调试 print 一律进 stderr，不污染 stdout。
    sys.stdout = sys.stderr

    bridge = Bridge()
    _emit({"event": "hello", "app": "infohub", "version": __version__, "protocol": PROTOCOL_VERSION})
    try:
        while not bridge._stop:
            line = sys.stdin.readline()
            if not line:
                break
            if len(line.encode("utf-8", "replace")) > MAX_LINE_BYTES:
                _emit({"id": None, "ok": False, "error": {"type": "ValueError", "message": "请求过大"}})
                continue
            text = line.strip()
            if not text:
                continue
            try:
                request = json.loads(text)
            except ValueError as exc:
                _emit({"id": None, "ok": False, "error": {"type": "JSONDecodeError", "message": str(exc)}})
                continue
            if not isinstance(request, dict):
                _emit({"id": None, "ok": False, "error": {"type": "ValueError", "message": "请求必须是对象"}})
                continue
            request_id = request.get("id")
            method = request.get("method")
            params = request.get("params") or {}
            if not isinstance(method, str) or not isinstance(params, dict):
                _emit({"id": request_id, "ok": False, "error": {"type": "ValueError", "message": "method/params 不合法"}})
                continue
            try:
                result = _dispatch(bridge, method, params)
                _emit({"id": request_id, "ok": True, "result": result})
            except Exception as exc:  # 单次请求失败不能拖垮整个桥
                _emit(_error(request_id, exc))
            finally:
                if method not in _LONG_METHODS:
                    bridge.close()
    finally:
        bridge.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
