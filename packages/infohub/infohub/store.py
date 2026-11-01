from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Iterable

from .models import Conversation, Message

_SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    account TEXT NOT NULL DEFAULT '',
    external_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'private',
    avatar TEXT NOT NULL DEFAULT '',
    last_ts INTEGER NOT NULL DEFAULT 0,
    cursor_ts INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(source, account, external_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_source ON conversations(source);
CREATE INDEX IF NOT EXISTS idx_conv_last ON conversations(last_ts DESC);

CREATE TABLE IF NOT EXISTS messages(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    external_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    sender_id TEXT NOT NULL DEFAULT '',
    sender_name TEXT NOT NULL DEFAULT '',
    is_self INTEGER,
    type_code INTEGER,
    type_label TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    imported_at INTEGER NOT NULL,
    UNIQUE(conversation_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_msg_conv_ts ON messages(conversation_id, ts);
CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(ts DESC);

CREATE TABLE IF NOT EXISTS imported_files(
    path TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    mtime REAL NOT NULL,
    imported_at INTEGER NOT NULL,
    messages INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ok',
    detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS media(
    message_id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    thumb TEXT NOT NULL DEFAULT '',
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    mtime REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    conversation_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    due_ts INTEGER NOT NULL,
    due_text TEXT NOT NULL DEFAULT '',
    all_day INTEGER NOT NULL DEFAULT 1,
    kind TEXT NOT NULL DEFAULT 'task',
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    UNIQUE(message_id, due_ts, title)
);
CREATE INDEX IF NOT EXISTS idx_events_due ON events(due_ts);
CREATE INDEX IF NOT EXISTS idx_events_msg ON events(message_id);

CREATE TABLE IF NOT EXISTS source_state(
    source TEXT PRIMARY KEY,
    last_run_ts INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'idle',
    detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS voice_cache(
    md5 TEXT PRIMARY KEY,
    text TEXT NOT NULL DEFAULT '',
    duration REAL NOT NULL DEFAULT 0,
    engine TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
"""

_FTS_TRIGGERS = """
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
"""


def now() -> int:
    return int(time.time())


class Store:
    def __init__(self, path: str | Path, readonly: bool = False):
        self.path = Path(path)
        self.readonly = readonly
        if readonly:
            # 浏览/检索不动用户的归档：URI 只读打开，且不跑建表/建 FTS 的 DDL。
            uri = f"file:{self.path.as_posix()}?mode=ro"
            self.conn = sqlite3.connect(uri, uri=True, timeout=30, check_same_thread=False)
            self.conn.row_factory = sqlite3.Row
            self.conn.execute("PRAGMA busy_timeout=30000")
            self.fts = self._detect_fts()
            self.fts_tokenizer = ""
        else:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.conn = sqlite3.connect(str(self.path), timeout=30, check_same_thread=False)
            self.conn.row_factory = sqlite3.Row
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA synchronous=NORMAL")
            self.conn.execute("PRAGMA busy_timeout=30000")
            self.conn.executescript(_SCHEMA)
            self.fts = self._setup_fts()
            self.conn.commit()

    def _detect_fts(self) -> bool:
        try:
            row = self.conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'"
            ).fetchone()
            return bool(row)
        except sqlite3.Error:
            return False

    def _setup_fts(self) -> bool:
        for tokenizer in ("trigram", "unicode61"):
            try:
                self.conn.execute(
                    "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5("
                    "content, content='messages', content_rowid='id', tokenize='%s')" % tokenizer
                )
                self.conn.executescript(_FTS_TRIGGERS)
                self.conn.commit()
                self.fts_tokenizer = tokenizer
                return True
            except sqlite3.OperationalError:
                continue
        self.fts_tokenizer = ""
        return False

    def close(self) -> None:
        try:
            self.conn.close()
        except sqlite3.Error:
            pass

    # ---------- conversations ----------

    def upsert_conversation(self, conv: Conversation) -> int:
        ts = now()
        cur = self.conn.execute(
            """
            INSERT INTO conversations(source, account, external_id, name, kind, avatar,
                                      last_ts, meta, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source, account, external_id) DO UPDATE SET
                name = CASE WHEN excluded.name != '' THEN excluded.name ELSE conversations.name END,
                kind = excluded.kind,
                avatar = CASE WHEN excluded.avatar != '' THEN excluded.avatar ELSE conversations.avatar END,
                last_ts = MAX(conversations.last_ts, excluded.last_ts),
                meta = CASE WHEN excluded.meta != '{}' THEN excluded.meta ELSE conversations.meta END,
                updated_at = excluded.updated_at
            RETURNING id
            """,
            (
                conv.source,
                conv.account,
                conv.external_id,
                conv.name,
                conv.kind,
                conv.avatar,
                int(conv.last_ts or 0),
                _json(conv.meta),
                ts,
                ts,
            ),
        )
        row = cur.fetchone()
        self.conn.commit()
        return int(row[0])

    def get_conversation(self, conv_id: int) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM conversations WHERE id = ?", (conv_id,)).fetchone()

    def list_conversations(self, source: str | None = None, keyword: str = "") -> list[sqlite3.Row]:
        sql = "SELECT * FROM conversations WHERE message_count > 0"
        args: list = []
        if source:
            sql += " AND source = ?"
            args.append(source)
        if keyword.strip():
            sql += " AND name LIKE ? ESCAPE '\\'"
            args.append(f"%{_like(keyword.strip())}%")
        sql += " ORDER BY last_ts DESC, id DESC"
        return self.conn.execute(sql, args).fetchall()

    # ---------- messages ----------

    def add_messages(self, conv_id: int, messages: Iterable[Message]) -> tuple[int, int]:
        ts_now = now()
        rows = []
        max_ts = 0
        for m in messages:
            ext = m.external_id or f"h:{m.ts}:{m.sender_id}:{hash(m.content)}"
            max_ts = max(max_ts, int(m.ts or 0))
            rows.append(
                (
                    conv_id,
                    ext,
                    int(m.ts or 0),
                    m.sender_id or "",
                    m.sender_name or "",
                    None if m.is_self is None else int(bool(m.is_self)),
                    m.type_code,
                    m.type_label or "",
                    m.content or "",
                    ts_now,
                )
            )
        if not rows:
            return 0, max_ts
        before = self.conn.execute(
            "SELECT COUNT(*) FROM messages WHERE conversation_id = ?", (conv_id,)
        ).fetchone()[0]
        self.conn.executemany(
            """
            INSERT INTO messages(conversation_id, external_id, ts, sender_id, sender_name,
                                 is_self, type_code, type_label, content, imported_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(conversation_id, external_id) DO UPDATE SET
                ts = excluded.ts,
                sender_name = excluded.sender_name,
                type_code = excluded.type_code,
                type_label = excluded.type_label,
                content = excluded.content
            WHERE messages.content IS NOT excluded.content
               OR messages.type_code IS NOT excluded.type_code
               OR messages.type_label IS NOT excluded.type_label
               OR messages.sender_name IS NOT excluded.sender_name
               OR messages.ts IS NOT excluded.ts
            """,
            rows,
        )
        after = self.conn.execute(
            "SELECT COUNT(*) FROM messages WHERE conversation_id = ?", (conv_id,)
        ).fetchone()[0]
        added = int(after) - int(before)
        if max_ts:
            self.conn.execute(
                """
                UPDATE conversations
                SET message_count = message_count + ?,
                    last_ts = MAX(last_ts, ?),
                    cursor_ts = MAX(cursor_ts, ?),
                    updated_at = ?
                WHERE id = ?
                """,
                (added, max_ts, max_ts, ts_now, conv_id),
            )
        elif added:
            self.conn.execute(
                "UPDATE conversations SET message_count = message_count + ?, updated_at = ? WHERE id = ?",
                (added, ts_now, conv_id),
            )
        self.conn.commit()
        return added, max_ts

    def attach_media(self, conv_id: int, items: list[tuple]) -> int:
        """items: (external_id, kind, path, name, thumb, width, height, size, mtime)"""
        if not items:
            return 0
        id_map: dict[str, int] = {}
        for chunk in _chunks([it[0] for it in items], 400):
            marks = ",".join("?" * len(chunk))
            for row in self.conn.execute(
                f"SELECT id, external_id FROM messages "
                f"WHERE conversation_id = ? AND external_id IN ({marks})",
                [conv_id, *chunk],
            ):
                id_map[row["external_id"]] = int(row["id"])
        payload = [(id_map[it[0]], *it[1:]) for it in items if it[0] in id_map]
        if payload:
            self.conn.executemany(
                """
                INSERT INTO media(message_id, kind, path, name, thumb, width, height, size, mtime)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(message_id) DO UPDATE SET
                    kind = excluded.kind, path = excluded.path, name = excluded.name,
                    thumb = excluded.thumb, width = excluded.width, height = excluded.height,
                    size = excluded.size, mtime = excluded.mtime
                """,
                payload,
            )
            self.conn.commit()
        return len(payload)

    def media_for(self, message_ids) -> dict[int, sqlite3.Row]:
        out: dict[int, sqlite3.Row] = {}
        for chunk in _chunks(list(message_ids), 400):
            marks = ",".join("?" * len(chunk))
            for row in self.conn.execute(f"SELECT * FROM media WHERE message_id IN ({marks})", chunk):
                out[int(row["message_id"])] = row
        return out

    # ---------- voice ----------

    def voice_rows(self) -> list[sqlite3.Row]:
        """所有带本地音频的语音消息（path 是音频，stem 即缓存键）。"""
        return self.conn.execute(
            """
            SELECT md.path, md.message_id, m.id AS id, m.content
            FROM media md
            JOIN messages m ON m.id = md.message_id
            WHERE md.kind = 'voice' AND md.path != ''
            ORDER BY m.ts ASC
            """
        ).fetchall()

    def voice_texts(self) -> dict[str, str]:
        return {
            row["md5"]: row["text"]
            for row in self.conn.execute("SELECT md5, text FROM voice_cache WHERE text != ''")
        }

    def save_voice(self, md5: str, text: str, duration: float = 0.0, engine: str = "", path: str = "") -> None:
        self.conn.execute(
            """
            INSERT INTO voice_cache(md5, text, duration, engine, path, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(md5) DO UPDATE SET
                text = excluded.text, duration = excluded.duration,
                engine = excluded.engine, path = excluded.path, created_at = excluded.created_at
            """,
            (md5, text, float(duration), engine, path, now()),
        )
        self.conn.commit()

    def apply_voice_texts(self, pairs: list[tuple[int, str]]) -> int:
        if not pairs:
            return 0
        before = self.conn.total_changes
        self.conn.executemany(
            "UPDATE messages SET content = ? WHERE id = ? AND content IS NOT ?",
            [(content, message_id, content) for message_id, content in pairs],
        )
        self.conn.commit()
        return int(self.conn.total_changes - before)

    def media_stats(self) -> dict[str, int]:
        rows = self.conn.execute("SELECT kind, COUNT(*) n FROM media GROUP BY kind").fetchall()
        return {row["kind"]: int(row["n"]) for row in rows}

    def self_aliases(self) -> list[str]:
        """自己在各群里的名片，用来判断 @ 的是不是我。"""
        rows = self.conn.execute(
            """
            SELECT DISTINCT m.sender_name AS n FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE m.is_self = 1 AND c.kind = 'group' AND m.sender_name NOT IN ('', '我')
            """
        ).fetchall()
        return sorted({str(row["n"]) for row in rows})

    def window_messages(self, since_ts: int, until_ts: int) -> list[sqlite3.Row]:
        return self.conn.execute(
            """
            SELECT m.id, m.ts, m.sender_name, m.is_self, m.type_label, m.content,
                   c.id AS conv_id, c.name AS conv_name, c.source AS source, c.kind AS conv_kind
            FROM messages m JOIN conversations c ON c.id = m.conversation_id
            WHERE m.ts >= ? AND m.ts < ?
            ORDER BY m.ts ASC, m.id ASC
            """,
            (int(since_ts), int(until_ts)),
        ).fetchall()

    def events_between(self, since_ts: int, until_ts: int) -> list[sqlite3.Row]:
        """消息落在窗口内的新日程（含已完成的，简报里只列 open）。"""
        return self.conn.execute(
            """
            SELECT e.*, c.name AS conv_name, c.source AS source,
                   m.ts AS msg_ts, m.sender_name AS sender_name
            FROM events e
            JOIN messages m ON m.id = e.message_id
            JOIN conversations c ON c.id = e.conversation_id
            WHERE m.ts >= ? AND m.ts < ?
            ORDER BY e.due_ts ASC, e.id ASC
            """,
            (int(since_ts), int(until_ts)),
        ).fetchall()

    def media_counts(self, since_ts: int, until_ts: int) -> dict[str, int]:
        rows = self.conn.execute(
            """
            SELECT md.kind, COUNT(*) n FROM media md JOIN messages m ON m.id = md.message_id
            WHERE m.ts >= ? AND m.ts < ? GROUP BY md.kind
            """,
            (int(since_ts), int(until_ts)),
        ).fetchall()
        return {row["kind"]: int(row["n"]) for row in rows}

    def transcripts_since(self, since_ts: int) -> int:
        return int(
            self.conn.execute(
                "SELECT COUNT(*) FROM voice_cache WHERE created_at >= ?", (int(since_ts),)
            ).fetchone()[0]
        )

    def digest_cursor(self) -> int:
        row = self.conn.execute(
            "SELECT last_run_ts FROM source_state WHERE source = 'digest'"
        ).fetchone()
        return int(row[0]) if row else 0

    def set_digest_cursor(self, ts: int) -> None:
        self.conn.execute(
            """
            INSERT INTO source_state(source, last_run_ts, status, detail) VALUES('digest', ?, 'ok', '')
            ON CONFLICT(source) DO UPDATE SET last_run_ts = excluded.last_run_ts, status = 'ok'
            """,
            (int(ts),),
        )
        self.conn.commit()

    # ---------- events ----------

    def notice_messages(self, since_ts: int, until_ts: int) -> list[sqlite3.Row]:
        """通知候选的原料：窗口内的非本人文本消息，带会话名。"""
        return self.conn.execute(
            """
            SELECT m.id, m.ts, m.sender_name, m.is_self, m.type_label, m.content,
                   c.name AS conv_name, c.source AS source
            FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE m.ts >= ? AND m.ts < ?
              AND (m.is_self IS NULL OR m.is_self = 0)
              AND m.type_label IN ('文本', '链接/文件')
            ORDER BY m.ts DESC, m.id DESC
            """,
            (int(since_ts), int(until_ts)),
        ).fetchall()

    def media_messages(self, since_ts: int = 0) -> list[sqlite3.Row]:
        return self.conn.execute(
            """
            SELECT md.*, m.ts, m.sender_name, m.content, m.conversation_id,
                   c.name AS conv_name, c.source AS source
            FROM media md
            JOIN messages m ON m.id = md.message_id
            JOIN conversations c ON c.id = m.conversation_id
            WHERE m.ts >= ?
            ORDER BY m.ts ASC, md.message_id ASC
            """,
            (int(since_ts),),
        ).fetchall()

    def messages_since(self, since_ts: int) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT id, conversation_id, ts, sender_name, content FROM messages "
            "WHERE ts >= ? ORDER BY ts ASC, id ASC",
            (int(since_ts),),
        ).fetchall()

    def max_message_id(self) -> int:
        row = self.conn.execute("SELECT MAX(id) FROM messages").fetchone()
        return int(row[0] or 0)

    def messages_after_id(self, after_id: int, limit: int = 500) -> list[sqlite3.Row]:
        """按写入顺序取新消息；同步后插入的 id 单调递增，适合做增量游标。"""
        return self.conn.execute(
            """
            SELECT m.id, m.conversation_id, m.ts, m.sender_name, m.is_self, m.content,
                   c.name AS conv_name, c.source AS source
            FROM messages m JOIN conversations c ON c.id = m.conversation_id
            WHERE m.id > ? ORDER BY m.id ASC LIMIT ?
            """,
            (int(after_id), int(limit)),
        ).fetchall()

    def agenda_cursor(self) -> int:
        row = self.conn.execute(
            "SELECT last_run_ts FROM source_state WHERE source = 'agenda'"
        ).fetchone()
        return int(row[0]) if row else 0

    def set_agenda_cursor(self, message_id: int, detail: str = "") -> None:
        self.conn.execute(
            """
            INSERT INTO source_state(source, last_run_ts, status, detail) VALUES('agenda', ?, 'ok', ?)
            ON CONFLICT(source) DO UPDATE SET
                last_run_ts = excluded.last_run_ts, status = 'ok', detail = excluded.detail
            """,
            (int(message_id), str(detail or "")),
        )
        self.conn.commit()

    def event_index(self) -> list[sqlite3.Row]:
        """增量合并去重用：现有事件的会话、标题、类型、截止时间。"""
        return self.conn.execute(
            "SELECT conversation_id, title, kind, due_ts FROM events"
        ).fetchall()

    def insert_events(self, items: list[tuple]) -> tuple[int, int]:
        """items: (message_id, conversation_id, title, detail, due_ts, due_text, all_day, kind)"""
        ts_now = now()
        before = self.event_count()
        if items:
            self.conn.executemany(
                """
                INSERT OR IGNORE INTO events(message_id, conversation_id, title, detail,
                                             due_ts, due_text, all_day, kind, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [(*item, ts_now) for item in items],
            )
            self.conn.commit()
        total = self.event_count()
        return total - before, total

    def replace_events(self, since_ts: int, items: list[tuple]) -> tuple[int, int]:
        """items: (message_id, conversation_id, title, detail, due_ts, due_text, all_day, kind)

        只重建窗口内的消息，窗口外的未来日程保持不变；已完成状态按 same key 保留。
        """
        done = {
            (int(r["message_id"]), int(r["due_ts"]), r["title"])
            for r in self.conn.execute(
                "SELECT e.message_id, e.due_ts, e.title FROM events e "
                "JOIN messages m ON m.id = e.message_id "
                "WHERE m.ts >= ? AND e.status = 'done'",
                (int(since_ts),),
            )
        }
        self.conn.execute(
            "DELETE FROM events WHERE message_id IN (SELECT id FROM messages WHERE ts >= ?)",
            (int(since_ts),),
        )
        after_delete = self.event_count()
        ts_now = now()
        if items:
            self.conn.executemany(
                """
                INSERT OR IGNORE INTO events(message_id, conversation_id, title, detail,
                                             due_ts, due_text, all_day, kind, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [(*item, ts_now) for item in items],
            )
        for message_id, due_ts, title in done:
            self.conn.execute(
                "UPDATE events SET status = 'done' WHERE message_id = ? AND due_ts = ? AND title = ?",
                (message_id, due_ts, title),
            )
        total = self.event_count()
        self.conn.commit()
        return total - after_delete, total

    def agenda(self, since_ts: int, until_ts: int) -> list[sqlite3.Row]:
        return self.conn.execute(
            """
            SELECT e.*, c.name AS conv_name, c.source AS source,
                   m.ts AS msg_ts, m.sender_name AS sender_name, m.content AS content
            FROM events e
            JOIN messages m ON m.id = e.message_id
            JOIN conversations c ON c.id = e.conversation_id
            WHERE e.due_ts >= ? AND e.due_ts < ? AND e.status = 'open'
            ORDER BY e.due_ts ASC, e.id ASC
            """,
            (int(since_ts), int(until_ts)),
        ).fetchall()

    def event_count(self) -> int:
        return int(self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0])

    def get_messages(self, conv_id: int, limit: int = 800, before_ts: int | None = None) -> list[sqlite3.Row]:
        sql = "SELECT * FROM messages WHERE conversation_id = ?"
        args: list = [conv_id]
        if before_ts is not None:
            sql += " AND ts < ?"
            args.append(int(before_ts))
        sql += " ORDER BY ts DESC, id DESC LIMIT ?"
        args.append(int(limit))
        rows = self.conn.execute(sql, args).fetchall()
        return list(reversed(rows))

    def messages_around(self, conv_id: int, ts: int, before: int = 400, after: int = 200) -> list[sqlite3.Row]:
        older = self.conn.execute(
            "SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? AND ts <= ? "
            "ORDER BY ts DESC, id DESC LIMIT ?) ORDER BY ts ASC, id ASC",
            (int(conv_id), int(ts), int(before)),
        ).fetchall()
        newer = self.conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? AND ts > ? "
            "ORDER BY ts ASC, id ASC LIMIT ?",
            (int(conv_id), int(ts), int(after)),
        ).fetchall()
        return list(older) + list(newer)

    def message_ts(self, message_id: int) -> int | None:
        row = self.conn.execute("SELECT ts FROM messages WHERE id = ?", (int(message_id),)).fetchone()
        return int(row[0]) if row else None

    def content_keys(self, conv_id: int, min_ts: int, max_ts: int) -> set[tuple[int, str]]:
        """用于跨格式去重：同一会话、同一秒、同一正文视为同一条。"""
        rows = self.conn.execute(
            "SELECT ts, content FROM messages WHERE conversation_id = ? AND ts BETWEEN ? AND ?",
            (conv_id, int(min_ts), int(max_ts)),
        ).fetchall()
        return {(int(r["ts"]), _content_hash(r["content"])) for r in rows}

    def recent_contents(self, conv_id: int, min_ts: int, max_ts: int) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT ts, sender_name, content FROM messages "
            "WHERE conversation_id = ? AND ts BETWEEN ? AND ?",
            (conv_id, int(min_ts), int(max_ts)),
        ).fetchall()

    def count_messages(self, conv_id: int) -> int:
        row = self.conn.execute(
            "SELECT COUNT(*) FROM messages WHERE conversation_id = ?", (conv_id,)
        ).fetchone()
        return int(row[0]) if row else 0

    def search(self, query: str, limit: int = 300) -> list[sqlite3.Row]:
        q = query.strip()
        if not q:
            return []
        if self.fts and len(q) >= 3:
            match = '"' + q.replace('"', '""') + '"'
            try:
                return self.conn.execute(
                    """
                    SELECT m.id, m.conversation_id, m.ts, m.sender_name, m.content,
                           snippet(messages_fts, 0, '<<', '>>', '…', 32) AS snippet,
                           c.name AS conv_name, c.source AS source
                    FROM messages_fts f
                    JOIN messages m ON m.id = f.rowid
                    JOIN conversations c ON c.id = m.conversation_id
                    WHERE messages_fts MATCH ?
                    ORDER BY m.ts DESC
                    LIMIT ?
                    """,
                    (match, int(limit)),
                ).fetchall()
            except sqlite3.OperationalError:
                pass
        return self.conn.execute(
            """
            SELECT m.id, m.conversation_id, m.ts, m.sender_name, m.content,
                   m.content AS snippet, c.name AS conv_name, c.source AS source
            FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE m.content LIKE ? ESCAPE '\\'
            ORDER BY m.ts DESC
            LIMIT ?
            """,
            (f"%{_like(q)}%", int(limit)),
        ).fetchall()

    # ---------- files / state ----------

    def file_unchanged(self, path: str, size: int, mtime: float) -> bool:
        row = self.conn.execute(
            "SELECT size, mtime FROM imported_files WHERE path = ?", (path,)
        ).fetchone()
        return bool(row and row["size"] == size and abs(row["mtime"] - mtime) < 1.0)

    def note_file(self, path: str, size: int, mtime: float, messages: int, status: str = "ok", detail: str = "") -> None:
        self.conn.execute(
            """
            INSERT INTO imported_files(path, size, mtime, imported_at, messages, status, detail)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                size = excluded.size, mtime = excluded.mtime, imported_at = excluded.imported_at,
                messages = excluded.messages, status = excluded.status, detail = excluded.detail
            """,
            (path, size, mtime, now(), messages, status, detail),
        )
        self.conn.commit()

    def record_source(self, source: str, status: str, detail: str = "") -> None:
        self.conn.execute(
            """
            INSERT INTO source_state(source, last_run_ts, status, detail) VALUES (?, ?, ?, ?)
            ON CONFLICT(source) DO UPDATE SET
                last_run_ts = excluded.last_run_ts, status = excluded.status, detail = excluded.detail
            """,
            (source, now(), status, detail),
        )
        self.conn.commit()

    def source_states(self) -> dict[str, sqlite3.Row]:
        rows = self.conn.execute("SELECT * FROM source_state").fetchall()
        return {r["source"]: r for r in rows}

    def stats(self) -> dict:
        conv = self.conn.execute("SELECT COUNT(*) FROM conversations WHERE message_count > 0").fetchone()[0]
        msg = self.conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        per_source = {
            r["source"]: r["n"]
            for r in self.conn.execute(
                "SELECT source, COUNT(*) AS n FROM conversations WHERE message_count > 0 GROUP BY source"
            ).fetchall()
        }
        return {"conversations": conv, "messages": msg, "per_source": per_source}


def _norm_text(text: str) -> str:
    """归一化正文，供跨格式（HTML/TXT）识别同一条消息。"""
    import re

    raw = (text or "").strip()
    lines = []
    for line in raw.splitlines():
        s = line.strip()
        if not s or set(s) == {"="}:
            continue
        if re.match(r"^(?:提及|回复|资源)\s*[:：]", s) or re.match(r"^-\s*\w+\s*[:：]", s):
            continue
        lines.append(s)
    return re.sub(r"\s+", "", re.sub(r"^(?:@\S+\s*)+", "", " ".join(lines))).lower()


def _content_hash(text: str) -> str:
    import hashlib

    raw = (text or "").strip()
    return hashlib.md5((_norm_text(text) or raw).encode("utf-8", "replace")).hexdigest()


def _chunks(items: list, size: int) -> Iterable[list]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


def _like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _json(value: dict) -> str:
    import json

    return json.dumps(value, ensure_ascii=False)
