"""记忆层测试：切块、混合检索、情景记忆、中文分词。"""

from __future__ import annotations

from agent_pipeline.memory import MemoryStore, tokenize
from agent_pipeline.protocol import Citation, MemoryRecord


def test_tokenize_mixes_latin_and_cjk() -> None:
    tokens = tokenize("RAG 检索增强 rAg")
    assert "rag" in tokens
    assert "检" in tokens
    assert "检索" in tokens


def test_add_document_chunks_and_search_hits_its_citation() -> None:
    store = MemoryStore(":memory:")
    text = "检索增强生成把外部知识注入提示词。\n\n" * 4
    chunks = store.add_document("doc-rag", text, title="RAG 笔记", chunk_chars=80)
    assert chunks, "切块不能为空"
    counts = store.count()
    assert counts["documents"] == 1
    assert counts["chunks"] == len(chunks)

    hits = store.search("RAG 检索增强", limit=3)
    assert hits, "中文查询必须能命中"
    top = hits[0]
    assert top.citations, "命中结果必须带可追溯引用"
    assert top.citations[0].doc_id == "doc-rag"
    assert top.citations[0].quote, "引用要带原文片段，便于脚注展示"
    store.close()


def test_episodic_memory_is_recalled() -> None:
    store = MemoryStore(":memory:")
    store.add_episodic(
        MemoryRecord(
            kind="lesson",
            text="Windows 上卸载插件失败，是因为插件引擎把它当工作目录占着，先停引擎就能删。",
            run_id="run-1",
            importance=0.9,
        )
    )
    hits = store.search("卸载插件失败", limit=5, memories=True)
    assert any("工作目录" in hit.text for hit in hits)
    assert store.count()["episodes"] == 1
    store.close()


def test_episodic_can_be_excluded() -> None:
    store = MemoryStore(":memory:")
    store.add_episodic(MemoryRecord(kind="lesson", text="只读文件不带 mtime", run_id="run-1"))
    assert store.search("只读文件", memories=False) == []
    store.close()


def test_readding_document_replaces_chunks() -> None:
    store = MemoryStore(":memory:")
    store.add_document("doc-1", "第一版内容。" * 50, chunk_chars=100)
    first = store.count()["chunks"]
    store.add_document("doc-1", "第二版内容。", chunk_chars=100)
    assert store.count()["chunks"] == 1
    assert store.count()["documents"] == 1
    assert first > 1
    store.close()


def test_search_respects_limit_and_empty_store() -> None:
    store = MemoryStore(":memory:")
    assert store.search("随便问问") == []
    store.add_document("doc-a", "关于覆盖率与测试的内容。" * 20, chunk_chars=100)
    store.add_document("doc-b", "关于覆盖率与测试的内容。" * 20, chunk_chars=100)
    assert len(store.search("覆盖率", limit=1)) == 1
    store.close()


def test_citation_round_trip_in_episodic() -> None:
    store = MemoryStore(":memory:")
    store.add_episodic(
        MemoryRecord(
            kind="semantic",
            text="部署脚本在 deploy/ 目录，用 nginx 反代。",
            run_id="run-2",
            citations=[Citation(doc_id="doc-deploy", chunk=0, quote="nginx")],
        )
    )
    hits = store.search("部署 nginx", limit=3)
    found = [hit for hit in hits if hit.citations]
    assert found and found[0].citations[0].doc_id == "doc-deploy"
    store.close()

def test_episodes_are_pruned_to_capacity():
    """情景记忆有容量上限：超了删最旧，保最新（否则跑得越久越大）。"""
    from agent_pipeline.memory import MemoryStore
    from agent_pipeline.protocol import MemoryRecord

    store = MemoryStore(":memory:", max_episodes=3)
    for i in range(5):
        store.add_episodic(MemoryRecord(kind="lesson", text=f"经验{i}", run_id=f"r{i}"))
    assert store.count()["episodes"] == 3
    texts = [r["text"] for r in store._conn.execute("SELECT text FROM episodic ORDER BY rowid")]
    assert texts == ["经验2", "经验3", "经验4"]


def test_documents_are_pruned_with_their_chunks():
    """文档超限删最旧，并连带删掉它的 chunks（不留孤儿块）。"""
    from agent_pipeline.memory import MemoryStore

    store = MemoryStore(":memory:", max_documents=2)
    for i in range(4):
        store.add_document(f"doc{i}", f"第{i}份文档的内容，够长一点点来切块。")
    assert store.count()["documents"] == 2
    assert store.count()["chunks"] == 2  # 每份只一块
    remaining = [r["doc_id"] for r in store._conn.execute("SELECT doc_id FROM documents ORDER BY rowid")]
    assert remaining == ["doc2", "doc3"]
    # 旧文档的块已被删掉：任何命中都不该再引用 doc0/doc1
    cited = {c.doc_id for r in store.search("第0份文档", limit=8) for c in r.citations}
    assert cited and not ({"doc0", "doc1"} & cited)
    assert "doc3" in {c.doc_id for r in store.search("第3份文档", limit=8) for c in r.citations}


def test_prune_is_idempotent_and_accepts_overrides():
    from agent_pipeline.memory import MemoryStore
    from agent_pipeline.protocol import MemoryRecord

    store = MemoryStore(":memory:")
    for i in range(4):
        store.add_episodic(MemoryRecord(kind="lesson", text=f"x{i}", run_id="r"))
    assert store.prune(max_episodes=2) == {"episodes": 2, "documents": 0}
    assert store.prune(max_episodes=2) == {"episodes": 0, "documents": 0}
