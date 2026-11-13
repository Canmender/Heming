"""记忆层：情景记忆（episodic/lesson）+ 语义记忆（RAG，BM25 混哈希向量）。

为什么不用外部向量库：这套服务要能在离线机器、单进程里跑起来；
SQLite + 轻量检索足以支撑「检索几条历史经验/文档片段」的需求，
真到需要规模化时，只需替换 ``MemoryStore.search`` 的实现。

检索是**混合**的：词法（BM25，看重关键词命中）与向量（哈希 embedding，看重近义/顺序）
按 ``alpha`` 加权。中文没有空格，所以分词用「单字 + 相邻二元组」，避免整句失配。
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

from .protocol import Citation, MemoryRecord

_WORD = re.compile(r"[a-zA-Z0-9_]+")
_CJK = re.compile(r"[\u4e00-\u9fff]")
_STOP = {"the", "a", "an", "of", "to", "and", "or", "is", "are", "in", "on", "for", "with"}


def tokenize(text: str) -> list[str]:
    """中英混排分词：英文/数字按词，中文按单字 + 二元组。"""
    tokens: list[str] = []
    for word in _WORD.findall(text.lower()):
        if word not in _STOP:
            tokens.append(word)
    cjk = _CJK.findall(text)
    tokens.extend(cjk)
    for i in range(len(cjk) - 1):
        tokens.append(cjk[i] + cjk[i + 1])
    return tokens


def embed(text: str, dim: int = 256) -> list[float]:
    """确定性哈希 embedding（离线可用；不追求语义质量，只要稳定、可复现）。"""
    vec = [0.0] * dim
    for token in tokenize(text):
        digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
        index = int.from_bytes(digest[:4], "big") % dim
        sign = 1.0 if digest[4] % 2 == 0 else -1.0
        vec[index] += sign
    norm = math.sqrt(sum(v * v for v in vec))
    if norm == 0:
        return vec
    return [v / norm for v in vec]


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def _pack(vec: Sequence[float]) -> bytes:
    return json.dumps(list(vec)).encode("utf-8")


def _unpack(blob: bytes) -> list[float]:
    return list(json.loads(blob.decode("utf-8")))


@dataclass
class Chunk:
    doc_id: str
    chunk: int
    text: str


SCHEMA = """
CREATE TABLE IF NOT EXISTS episodic (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    run_id TEXT NOT NULL,
    text TEXT NOT NULL,
    citations TEXT NOT NULL DEFAULT '[]',
    importance REAL NOT NULL DEFAULT 0.5,
    created_at REAL NOT NULL DEFAULT (unixepoch('subsec'))
);
CREATE TABLE IF NOT EXISTS documents (
    doc_id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL DEFAULT (unixepoch('subsec'))
);
CREATE TABLE IF NOT EXISTS chunks (
    doc_id TEXT NOT NULL,
    chunk INTEGER NOT NULL,
    text TEXT NOT NULL,
    tokens TEXT NOT NULL,
    vec BLOB NOT NULL,
    PRIMARY KEY (doc_id, chunk)
);
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id);
"""


class MemoryStore:
    """SQLite 记忆库。

    容量上限是**硬约束**，不是建议：跑得越久写入越多，不回收的话
    内存/磁盘与检索延迟都会单调上涨（10 万次调用 ≈ 20 万条情景记忆）。
    超限时删最旧的（``rowid`` 升序）——最新经验才是下一次运行要用的。
    """

    def __init__(
        self,
        path: str | Path = ":memory:",
        dim: int = 256,
        max_episodes: int = 5_000,
        max_documents: int = 2_000,
        max_episode_age_days: float = 0.0,
    ) -> None:
        self.path = str(path)
        self.dim = dim
        self.max_episodes = max(0, int(max_episodes))
        self.max_documents = max(0, int(max_documents))
        # 0 表示「只按条数上限淘汰、不按时间过期」——按时间淘汰需要调用方愿意接受
        # 「三个月前的经验自动消失」，所以默认关，由 AGENT_MAX_EPISODE_AGE_DAYS 打开。
        self.max_episode_age_days = max(0.0, float(max_episode_age_days))
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._conn.commit()
        self._stats: dict[str, int] = {}

    # ---- 写入 -------------------------------------------------------------

    def add_episodic(self, record: MemoryRecord) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO episodic (kind, run_id, text, citations, importance) VALUES (?,?,?,?,?)",
                (
                    record.kind,
                    record.run_id,
                    record.text,
                    json.dumps([c.to_dict() for c in record.citations], ensure_ascii=False),
                    record.importance,
                ),
            )
            self._conn.commit()
        self.prune()

    def add_document(self, doc_id: str, text: str, *, title: str = "", chunk_chars: int = 600) -> list[Chunk]:
        """切块入索引。切块按段落聚合到 ``chunk_chars`` 左右，保留上下文。

        内容为空（或只有空白）时直接报错、**不动库**：以前会先写 documents 行再删旧 chunk，
        于是「用一份空文档覆盖已有文档」会把原来能检索到的内容清空，看起来像 RAG 突然坏了。
        """
        chunks = _split_chunks(text, chunk_chars)
        if not chunks:
            raise ValueError(f"文档 {doc_id!r} 的内容为空（去掉空白后没有任何可索引的文本），未写入")
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO documents (doc_id, title) VALUES (?,?)",
                (doc_id, title or doc_id),
            )
            self._conn.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
            for index, chunk_text in enumerate(chunks):
                self._conn.execute(
                    "INSERT INTO chunks (doc_id, chunk, text, tokens, vec) VALUES (?,?,?,?,?)",
                    (
                        doc_id,
                        index,
                        chunk_text,
                        json.dumps(tokenize(chunk_text), ensure_ascii=False),
                        _pack(embed(chunk_text, self.dim)),
                    ),
                )
            self._conn.commit()
        self.prune()
        return [Chunk(doc_id, i, c) for i, c in enumerate(chunks)]

    # ---- 检索 -------------------------------------------------------------

    def _corpus(self) -> list[sqlite3.Row]:
        with self._lock:
            return list(self._conn.execute("SELECT doc_id, chunk, text, tokens, vec FROM chunks"))

    def search(
        self,
        query: str,
        *,
        limit: int = 5,
        alpha: float = 0.6,
        memories: bool = True,
    ) -> list[MemoryRecord]:
        """混合检索：语料片段（semantic）+ 历史经验（episodic/lesson）。"""
        query_tokens = tokenize(query)
        query_vec = embed(query, self.dim)
        results: list[MemoryRecord] = []

        corpus = self._corpus()
        if corpus and query_tokens:
            doc_freq: dict[str, int] = {}
            doc_tokens: list[list[str]] = []
            for row in corpus:
                tokens = json.loads(row["tokens"])
                doc_tokens.append(tokens)
                for token in set(tokens):
                    doc_freq[token] = doc_freq.get(token, 0) + 1
            total = len(corpus)
            avg_len = sum(len(t) for t in doc_tokens) / total if total else 1.0
            for row, tokens in zip(corpus, doc_tokens):
                lexical = _bm25(query_tokens, tokens, doc_freq, total, avg_len)
                semantic = cosine(query_vec, _unpack(row["vec"]))
                score = alpha * lexical + (1.0 - alpha) * semantic
                if score <= 0:
                    continue
                results.append(
                    MemoryRecord(
                        kind="semantic",
                        text=row["text"],
                        run_id=f"doc:{row['doc_id']}",
                        citations=[
                            Citation(doc_id=row["doc_id"], chunk=int(row["chunk"]), quote=str(row["text"])[:160])
                        ],
                        importance=0.6,
                        score=round(score, 6),
                    )
                )

        if memories:
            with self._lock:
                rows = list(
                    self._conn.execute(
                        "SELECT kind, run_id, text, citations, importance FROM episodic ORDER BY id DESC LIMIT 200"
                    )
                )
            for row in rows:
                text = row["text"]
                overlap = len(set(query_tokens) & set(tokenize(text)))
                if overlap == 0:
                    continue
                score = overlap / (len(set(query_tokens)) + 1) + 0.1 * float(row["importance"])
                results.append(
                    MemoryRecord(
                        kind=row["kind"],
                        text=text,
                        run_id=row["run_id"],
                        citations=[Citation(**c) for c in json.loads(row["citations"])],
                        importance=float(row["importance"]),
                        score=round(score, 6),
                    )
                )

        results.sort(key=lambda r: r.score, reverse=True)
        return results[:limit]

    def prune(
        self,
        *,
        max_episodes: int | None = None,
        max_documents: int | None = None,
        max_episode_age_days: float | None = None,
        now: float | None = None,
    ) -> dict[str, int]:
        """按容量上限与（可选）时间上限删记录（幂等；可在任意时刻调用）。

        - 情景记忆先按 ``max_episode_age_days`` 过期（0 = 不按时间淘汰），
          再按条数裁到 ``max_episodes``；裁的时候**先删低重要性的**，
          同等重要性才比新旧——「三个月前反复验证过的教训」不该因为一条
          今天随手记的流水账就被挤掉。
        - 文档按 ``max_documents`` 删最旧，连带删 chunks（同一事务，避免孤儿块）。

        返回 ``{"episodes": n, "documents": n}``——删掉的条数，便于日志与测试断言。
        """
        keep_episodes = self.max_episodes if max_episodes is None else max(0, int(max_episodes))
        keep_documents = self.max_documents if max_documents is None else max(0, int(max_documents))
        age_days = self.max_episode_age_days if max_episode_age_days is None else max(0.0, float(max_episode_age_days))
        current = time.time() if now is None else float(now)
        removed_episodes = 0
        removed_documents = 0
        with self._lock:
            if age_days > 0:
                cur = self._conn.execute(
                    "DELETE FROM episodic WHERE created_at < ?",
                    (current - age_days * 86_400.0,),
                )
                removed_episodes += max(0, cur.rowcount or 0)
            if keep_episodes:
                cur = self._conn.execute(
                    "DELETE FROM episodic WHERE rowid NOT IN "
                    "(SELECT rowid FROM episodic ORDER BY importance DESC, created_at DESC, rowid DESC LIMIT ?)",
                    (keep_episodes,),
                )
                removed_episodes += max(0, cur.rowcount or 0)
            if keep_documents:
                stale = [
                    row[0]
                    for row in self._conn.execute(
                        "SELECT doc_id FROM documents ORDER BY rowid DESC LIMIT -1 OFFSET ?",
                        (keep_documents,),
                    )
                ]
                for doc_id in stale:
                    self._conn.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
                    self._conn.execute("DELETE FROM documents WHERE doc_id = ?", (doc_id,))
                removed_documents = len(stale)
            if removed_episodes or removed_documents:
                self._conn.commit()
        return {"episodes": removed_episodes, "documents": removed_documents}

    def remove_document(self, doc_id: str) -> bool:
        """删掉一份文档及其全部片段；返回是否真的删到了。"""
        with self._lock:
            self._conn.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
            cur = self._conn.execute("DELETE FROM documents WHERE doc_id = ?", (doc_id,))
            self._conn.commit()
            return bool(cur.rowcount)

    def count(self) -> dict[str, int]:
        with self._lock:
            docs = self._conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
            chunks = self._conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
            episodes = self._conn.execute("SELECT COUNT(*) FROM episodic").fetchone()[0]
        return {"documents": docs, "chunks": chunks, "episodes": episodes}

    def close(self) -> None:
        with self._lock:
            self._conn.close()


def _bm25(query: Sequence[str], doc: Sequence[str], doc_freq: dict[str, int], total: int, avg_len: float, k1: float = 1.5, b: float = 0.75) -> float:
    if not doc:
        return 0.0
    length = len(doc)
    counts: dict[str, int] = {}
    for token in doc:
        counts[token] = counts.get(token, 0) + 1
    score = 0.0
    for token in query:
        tf = counts.get(token, 0)
        if tf == 0:
            continue
        df = doc_freq.get(token, 0)
        idf = math.log(1 + (total - df + 0.5) / (df + 0.5))
        denom = tf + k1 * (1 - b + b * length / avg_len)
        score += idf * (tf * (k1 + 1)) / denom
    return score


def _split_chunks(text: str, chunk_chars: int) -> list[str]:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if not paragraphs:
        return [text.strip()] if text.strip() else []
    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs:
        if current and len(current) + len(paragraph) + 2 > chunk_chars:
            chunks.append(current)
            current = paragraph
        else:
            current = f"{current}\n\n{paragraph}" if current else paragraph
    if current:
        chunks.append(current)
    # 单段超长时再硬切
    out: list[str] = []
    for chunk in chunks:
        if len(chunk) <= chunk_chars * 2:
            out.append(chunk)
            continue
        for i in range(0, len(chunk), chunk_chars):
            out.append(chunk[i : i + chunk_chars])
    return out


def load_memories(store: MemoryStore, query: str, limit: int) -> list[MemoryRecord]:
    return [m for m in store.search(query, limit=limit) if m.kind != "semantic"] if limit > 0 else []