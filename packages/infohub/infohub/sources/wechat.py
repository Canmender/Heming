from __future__ import annotations

import hashlib
import os
import re
import shutil
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import zstandard as zstd

from ..models import Conversation, Message, SyncReport

ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
LOOKBACK_SECONDS = 2 * 24 * 3600

TYPE_LABELS = {
    1: "文本",
    3: "图片",
    34: "语音",
    42: "名片",
    43: "视频",
    47: "表情",
    48: "位置",
    49: "链接/文件",
    50: "通话",
    62: "视频",
    10000: "系统消息",
    10002: "系统消息",
}

SPECIAL_PREFIXES = (
    "gh_",
    "@openim",
    "fmessage",
    "medianote",
    "newsapp",
    "weixin",
    "notifymessage",
    "brandsessionholder",
    "floatbottle",
    "qqmail",
    "tmessage",
    "qmessage",
    "officialaccounts",
)


class WeChatUnavailable(RuntimeError):
    pass


def normalize_db_dir(path: str | Path) -> str:
    p = Path(path)
    if not p.exists():
        raise WeChatUnavailable(f"微信数据目录不存在：{p}")
    if (p / "db_storage").is_dir():
        return str(p.parent)
    try:
        for child in p.iterdir():
            if child.is_dir() and (child / "db_storage").is_dir():
                return str(p)
        for child in p.iterdir():
            if not child.is_dir():
                continue
            for grand in child.iterdir():
                if grand.is_dir() and (grand / "db_storage").is_dir():
                    return str(child)
    except OSError:
        pass
    raise WeChatUnavailable(f"目录里没有找到微信账号数据：{p}")


def decode_blob(value) -> str:
    if value is None:
        return ""
    if isinstance(value, memoryview):
        value = bytes(value)
    if isinstance(value, (bytes, bytearray)):
        data = bytes(value)
        if data[:4] == ZSTD_MAGIC:
            try:
                data = zstd.decompress(data)
            except zstd.ZstdError:
                pass
        return data.decode("utf-8", "replace")
    return str(value)


def _norm_ts(value) -> int:
    try:
        ts = int(value or 0)
    except (TypeError, ValueError):
        return 0
    if ts > 10_000_000_000:
        ts //= 1000
    return max(ts, 0)


def _low_type(value) -> int:
    """微信 4.x 把 appmsg 子类型放在高 32 位（如 244813135921 = 57<<32 | 49）。"""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return -1
    return n & 0xFFFFFFFF if n > 0xFFFFFFFF else n


def _clean(text: str) -> str:
    text = text.replace("\x00", "").replace("\r\n", "\n").strip()
    return text


_GROUP_PREFIX = re.compile(r"^([A-Za-z0-9_@.\-]{3,64}):\n")


def _strip_group_prefix(text: str, sender_id: str) -> str:
    m = _GROUP_PREFIX.match(text)
    if m and (not sender_id or m.group(1) == sender_id):
        return text[m.end() :]
    return text


def _app_message(text: str) -> str:
    stripped = text.strip()
    if "<appmsg" not in stripped and "<msg" not in stripped:
        return _clean(stripped)
    try:
        root = ET.fromstring(stripped)
    except ET.ParseError:
        title = re.search(r"<title>(.*?)</title>", stripped, re.S)
        return _clean(_unescape(title.group(1))) if title else _clean(stripped)

    def find(tag: str) -> str:
        node = root.find(".//" + tag)
        return _clean(node.text or "") if node is not None and node.text else ""

    app_type = find("type")
    title = find("title")
    des = find("des")
    url = find("url")
    if app_type == "57":
        refer = root.find(".//refermsg")
        quoted = ""
        if refer is not None:
            q_text = refer.findtext("content") or ""
            quoted = _clean(_app_message(q_text))[:120]
        body = title or des
        return f"「引用」{quoted}：{body}" if quoted else body or "[引用消息]"
    if app_type in {"5", "4"}:
        parts = [p for p in (title, des, url) if p]
        return " · ".join(parts) or "[链接]"
    if app_type == "6":
        return f"[文件] {title}" if title else "[文件]"
    if app_type == "19":
        return f"[聊天记录] {title}" if title else "[聊天记录]"
    if app_type in {"33", "36"}:
        return f"[小程序] {title}" if title else "[小程序]"
    if app_type in {"51", "63"}:
        return f"[视频号] {title}" if title else "[视频号]"
    parts = [p for p in (title, des) if p]
    return " · ".join(parts) or "[卡片消息]"


def _unescape(text: str) -> str:
    import html

    return html.unescape(text)


def parse_content(local_type, content, compress_content=None, group_prefix_sender: str = "") -> tuple[str, int]:
    t = _low_type(local_type)
    text = decode_blob(content)
    if not text:
        text = decode_blob(compress_content)
    if group_prefix_sender:
        text = _strip_group_prefix(text, group_prefix_sender)

    if t == 1:
        if text.lstrip().startswith(("<?xml", "<msg", "<appmsg")):
            parsed = _app_message(text)
            if parsed:
                return parsed, t
        return _clean(text) or "[空文本]", t
    if t == 49:
        return _app_message(text), t
    if t == 3:
        return "[图片]", t
    if t == 34:
        return "[语音]", t
    if t in (43, 62):
        return "[视频]", t
    if t == 47:
        return "[表情]", t
    if t == 48:
        return "[位置]", t
    if t == 42:
        return "[名片]", t
    if t == 50:
        return "[通话]", t
    if t in (10000, 10002):
        if text.lstrip().startswith(("<?xml", "<sysmsg")):
            m = re.search(r"<content>(.*?)</content>", text, re.S)
            if m:
                return _clean(_unescape(m.group(1))), t
        return _clean(text) or "[系统消息]", t
    out = _clean(text)
    if out.lstrip().startswith(("<?xml", "<msg", "<appmsg", "<sysmsg")):
        return "[消息]", t
    return out or f"[消息 type={local_type}]", t


class WeChatCollector:
    def __init__(self, db_dir: str, progress=None, blocked_prefixes=()):
        self.db_dir = normalize_db_dir(db_dir)
        self.progress = progress or (lambda *a, **k: None)
        self.blocked_prefixes = tuple(p.lower() for p in blocked_prefixes if p)
        self._tmp: str | None = None
        self.db = None
        self.self_username = ""
        self.self_name = ""
        self.nicks: dict[str, str] = {}

    # ---------- lifecycle ----------

    def open(self) -> None:
        try:
            from wechatauto import WeChatDB
        except ImportError as exc:  # pragma: no cover
            raise WeChatUnavailable(
                "缺少 wechatauto-replica：请用项目 .venv 运行（.venv\\Scripts\\python.exe），"
                "并执行 pip install -e ."
            ) from exc

        self._tmp = tempfile.mkdtemp(prefix="infohub-wx-")
        os.environ["WECHATAUTO_KEYS_DIR"] = os.path.join(self._tmp, "keys")
        try:
            self.db = WeChatDB(db_dir=self.db_dir, workdir=self._tmp)
        except Exception as exc:  # noqa: BLE001 - 上游异常类型不稳定
            self.close()
            raise WeChatUnavailable(
                "无法读取微信本地数据库，请确认微信已经登录并保持后台运行。\n" f"{exc}"
            ) from exc

        try:
            info = self.db.get_self_info() or {}
        except Exception:  # noqa: BLE001
            info = {}
        self.self_username = _valid_username(info.get("username")) or ""
        self.self_name = (info.get("nick_name") or info.get("nickname") or info.get("remark") or "我")
        try:
            self.nicks = self.db._nickname_index() or {}
        except Exception:  # noqa: BLE001
            self.nicks = {}

    def close(self) -> None:
        self.db = None
        if self._tmp:
            shutil.rmtree(self._tmp, ignore_errors=True)
            self._tmp = None

    def __enter__(self) -> "WeChatCollector":
        self.open()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ---------- discovery ----------

    def _is_blocked(self, username: str) -> bool:
        low = username.casefold()
        return any(low.startswith(p) for p in self.blocked_prefixes)

    def list_conversations(self) -> list[Conversation]:
        names = dict(self.nicks)
        names.setdefault(self.self_username, self.self_name)
        last_times: dict[str, int] = {}
        md5_to_username: dict[str, str] = {}

        def add(username, display="", last_ts=0):
            username = _valid_username(username)
            if not username:
                return
            md5_to_username.setdefault(hashlib.md5(username.encode("utf-8")).hexdigest(), username)
            if display:
                names.setdefault(username, display)
            if last_ts:
                last_times[username] = max(last_times.get(username, 0), _norm_ts(last_ts))

        for username, display in self.nicks.items():
            add(username, display)

        for item in getattr(self.db, "_db_files", []) or []:
            if len(item) < 2:
                continue
            rel, path = item[0], item[1]
            base = Path(str(path)).name.casefold()
            if base not in {"contact.db", "session.db"}:
                continue
            try:
                conn = self.db._open(rel)
            except Exception:  # noqa: BLE001
                continue
            try:
                if base == "contact.db":
                    try:
                        for username, nick, remark in conn.execute(
                            "SELECT username, nick_name, remark FROM contact"
                        ):
                            add(username, remark or nick or "")
                    except Exception:  # noqa: BLE001
                        pass
                else:
                    try:
                        for username, last in conn.execute(
                            "SELECT username, last_timestamp FROM SessionTable WHERE is_hidden=0"
                        ):
                            add(username, "", last)
                    except Exception:  # noqa: BLE001
                        pass
            finally:
                try:
                    conn.close()
                except Exception:  # noqa: BLE001
                    pass

        hashes = self._message_table_hashes()
        result = []
        for md5hex in hashes:
            username = md5_to_username.get(md5hex)
            if not username or username == self.self_username or self._is_blocked(username):
                continue
            result.append(
                Conversation(
                    source="wechat",
                    account=self.self_username,
                    external_id=username,
                    name=names.get(username) or username,
                    kind="group" if username.endswith("@chatroom") else "private",
                    last_ts=last_times.get(username, 0),
                )
            )
        result.sort(key=lambda c: c.last_ts, reverse=True)
        return result

    def _message_table_hashes(self) -> set[str]:
        hashes: set[str] = set()
        for rel in self.db._message_dbs():
            try:
                conn = self.db._open(rel)
            except Exception:  # noqa: BLE001
                continue
            try:
                rows = conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'Msg_*'"
                ).fetchall()
                for (name,) in rows:
                    suffix = name[4:].lower()
                    if len(suffix) == 32:
                        hashes.add(suffix)
            except Exception:  # noqa: BLE001
                pass
            finally:
                try:
                    conn.close()
                except Exception:  # noqa: BLE001
                    pass
        return hashes

    # ---------- messages ----------

    def iter_messages(self, conv: Conversation, since_ts: int = 0):
        username = conv.external_id
        table = "Msg_" + hashlib.md5(username.encode("utf-8")).hexdigest()
        is_group = conv.kind == "group"
        since = max(0, int(since_ts) - LOOKBACK_SECONDS) if since_ts else 0
        peer_name = conv.name or username

        for rel in self.db._message_dbs():
            try:
                conn = self.db._open(rel)
            except Exception:  # noqa: BLE001
                continue
            try:
                exists = conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
                ).fetchone()
                if not exists:
                    continue
                cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
                wanted = [
                    "local_id", "local_type", "server_id", "real_sender_id", "create_time",
                    "message_content", "compress_content",
                ]
                select_cols = [c for c in wanted if c in cols]
                if not select_cols:
                    continue
                sender_map: dict[int, str] = {}
                try:
                    sender_map = dict(conn.execute("SELECT rowid, user_name FROM Name2Id"))
                except Exception:  # noqa: BLE001
                    sender_map = {}

                sql = "SELECT " + ", ".join(select_cols) + f" FROM {table}"
                args: list = []
                if since and "create_time" in cols:
                    sql += " WHERE create_time > ?"
                    args.append(since)
                sql += " ORDER BY create_time ASC" if "create_time" in cols else ""
                cur = conn.execute(sql, args)
                names = [d[0] for d in cur.description]
                for raw in cur:
                    row = dict(zip(names, raw))
                    yield self._to_message(row, rel, sender_map, is_group, peer_name)
            finally:
                try:
                    conn.close()
                except Exception:  # noqa: BLE001
                    pass

    def _to_message(self, row: dict, rel, sender_map: dict, is_group: bool, peer_name: str) -> Message:
        sender_id = _sender_username(row.get("real_sender_id"), sender_map)
        is_self = bool(sender_id and sender_id == self.self_username)
        if sender_id:
            sender_name = self.nicks.get(sender_id) or (self.self_name if is_self else sender_id)
        else:
            sender_name = self.self_name if is_self else ("未知成员" if is_group else peer_name)

        content, type_code = parse_content(
            row.get("local_type"),
            row.get("message_content"),
            row.get("compress_content"),
            group_prefix_sender=sender_id if is_group else "",
        )
        local_id = row.get("local_id")
        rel_name = Path(str(rel)).name
        external_id = f"{rel_name}:{local_id}" if local_id is not None else ""
        ts = _norm_ts(row.get("create_time"))
        return Message(
            external_id=external_id or f"h:{ts}:{sender_id}:{hashlib.md5(content.encode()).hexdigest()[:12]}",
            ts=ts,
            sender_id=sender_id or "",
            sender_name=sender_name,
            is_self=is_self,
            type_code=type_code,
            type_label=TYPE_LABELS.get(type_code, f"type={type_code}"),
            content=content,
        )


def _valid_username(value) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    if any(c.isspace() or c == "\x00" for c in value):
        return None
    return value


def _sender_username(raw, sender_map: dict[int, str]) -> str:
    try:
        sid = int(raw)
    except (TypeError, ValueError):
        return ""
    if sid <= 0:
        return ""
    return sender_map.get(sid, "")


def sync_wechat(store, cfg, progress=None, full: bool = False) -> SyncReport:
    started = time.time()
    report = SyncReport(source="wechat")
    wx = cfg.wechat or {}
    db_dir = wx.get("db_dir") or ""
    if not db_dir:
        report.errors.append("未配置微信数据目录")
        store.record_source("wechat", "error", "未配置微信数据目录")
        return report

    progress = progress or (lambda *a, **k: None)
    collector = WeChatCollector(db_dir, progress=progress, blocked_prefixes=wx.get("blocked_prefixes", ()))
    try:
        progress("连接微信本地数据库…", 0, 1)
        collector.open()
        conversations = collector.list_conversations()
        total = len(conversations)
        progress(f"发现 {total} 个会话", 0, total)
        for index, conv in enumerate(conversations, 1):
            conv_id = store.upsert_conversation(conv)
            row = store.get_conversation(conv_id)
            since = 0 if full or row is None else int(row["cursor_ts"] or 0)
            batch = []
            for msg in collector.iter_messages(conv, since_ts=since):
                if msg.ts <= 0:
                    continue
                batch.append(msg)
                if len(batch) >= 500:
                    added, _ = store.add_messages(conv_id, batch)
                    report.added += added
                    batch = []
            if batch:
                added, _ = store.add_messages(conv_id, batch)
                report.added += added
            report.conversations += 1
            progress(f"微信 · {conv.name}", index, total)
        store.record_source("wechat", "ok", report.summary())
    except WeChatUnavailable as exc:
        report.errors.append(str(exc))
        store.record_source("wechat", "error", str(exc))
    except Exception as exc:  # noqa: BLE001
        report.errors.append(f"{type(exc).__name__}: {exc}")
        store.record_source("wechat", "error", str(exc))
    finally:
        collector.close()
    report.elapsed = time.time() - started
    return report
