"""RAG：知识库工具与 HTTP 入口（FakeLLM，无网络）。"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from agent_pipeline.config import Settings
from agent_pipeline.llm import FakeLLM
from agent_pipeline.protocol import TaskSpec, ToolRequest
from agent_pipeline.runtime import build_runtime, run_once
from agent_pipeline.service import create_app
from agent_pipeline.tools import build_default_registry


def _json(payload: dict) -> dict:
    return {"text": json.dumps(payload, ensure_ascii=False)}


def _seed(runtime) -> None:
    runtime.memory.add_document(
        "doc-installer",
        "和鸣安装器支持通用外壳。\n\n静默安装时会从更新源下载内层安装包。",
        title="安装器手册",
    )


def test_knowledge_search_tool_returns_hits_with_citations(runtime_factory) -> None:
    runtime = runtime_factory([])
    _seed(runtime)

    observation = runtime.tools.execute(
        ToolRequest(call_id="c1", name="knowledge_search", arguments={"query": "安装器 通用外壳"})
    )

    assert observation.ok is True
    assert observation.result["hits"], "检索不到任何片段说明索引/分词坏了"
    assert "通用外壳" in observation.result["hits"][0]["text"]
    assert observation.citations, "工具结果里的 citations 必须转进 Observation（摘要只认这些来源）"
    assert {c.doc_id for c in observation.citations} == {"doc-installer"}
    assert observation.citations[0].quote


def test_knowledge_search_validation_and_limits(runtime_factory) -> None:
    runtime = runtime_factory([])
    _seed(runtime)

    empty = runtime.tools.execute(
        ToolRequest(call_id="c1", name="knowledge_search", arguments={"query": "  "})
    )
    assert empty.ok is False and "不能为空" in (empty.error or "")

    too_many = runtime.tools.execute(
        ToolRequest(call_id="c2", name="knowledge_search", arguments={"query": "安装器", "limit": 99})
    )
    assert too_many.ok is True
    assert len(too_many.result["hits"]) <= 10

    # 没有 memory 的注册表不该凭空多出知识库工具
    assert "knowledge_search" not in build_default_registry().names()


def test_react_run_cites_only_observed_knowledge(runtime_factory) -> None:
    """模型检索到片段后，摘要里引用的来源必须真的来自观测。"""
    script = [
        _json({"steps": [{"goal": "查安装器手册", "done_when": "拿到外壳相关说明"}]}),
        {
            "text": "先查知识库",
            "tool_calls": [
                {"id": "k1", "name": "knowledge_search", "arguments": {"query": "通用外壳"}}
            ],
        },
        {"text": "查到了"},
        _json({"verdict": "done", "reasons": ["观测里有说明"]}),
        _json({"score": 0.9, "blocking_issues": []}),
        _json(
            {
                "answer": "结论：外壳可跨版本复用",
                "citations": [
                    {"doc_id": "doc-installer", "chunk": 0, "quote": "和鸣安装器支持通用外壳。"},
                    {"doc_id": "编造的文档", "chunk": 0, "quote": "这条不该出现"},
                ],
            }
        ),
    ]
    runtime = runtime_factory(script)
    _seed(runtime)

    result, _row = run_once(runtime, TaskSpec(goal="讲讲通用外壳", cwd="."))

    assert result.status == "ok"
    assert result.answer == "结论：外壳可跨版本复用"
    assert result.observations[0].tool == "knowledge_search"
    cited = {c.doc_id for c in result.citations}
    assert cited == {"doc-installer"}, f"编造的来源不该被保留：{cited}"


def test_http_knowledge_endpoints(runtime_factory) -> None:
    settings = Settings(log_path=":memory:", db_path=":memory:")
    runtime = build_runtime(settings, llm=FakeLLM([]))
    client = TestClient(create_app(settings=settings, runtime=runtime))

    created = client.post(
        "/v1/knowledge",
        json={"doc_id": "d1", "title": "手册", "text": "第一段。\n\n第二段。"},
    )
    assert created.status_code == 200
    assert created.json()["chunks"] >= 1
    assert client.get("/v1/knowledge").json()["documents"] == 1

    replaced = client.post("/v1/knowledge", json={"doc_id": "d1", "text": "只留这一段。"})
    assert replaced.status_code == 200
    assert client.get("/v1/knowledge").json()["documents"] == 1

    deleted = client.delete("/v1/knowledge/d1")
    assert deleted.status_code == 200
    assert deleted.json()["stats"]["documents"] == 0
    assert client.delete("/v1/knowledge/d1").status_code == 404


def test_knowledge_rejects_blank_documents_instead_of_storing_unsearchable_rows(runtime_factory) -> None:
    """只有空白的文档以前会「入库成功但检索不到」。

    `add_document` 切不出 chunk 也照样写 documents 行：`/v1/knowledge` 的 documents 计数 +1、
    chunks 不变，`knowledge_search` 永远命中不到——事后只能靠翻库才发现。
    现在直接 422，并说清楚原因。
    """
    settings = Settings(log_path=":memory:", db_path=":memory:")
    runtime = build_runtime(settings, llm=FakeLLM([]))
    client = TestClient(create_app(settings=settings, runtime=runtime))

    blank_text = client.post("/v1/knowledge", json={"doc_id": "d1", "text": "   \n\t  "})
    assert blank_text.status_code == 422
    assert "空白" in blank_text.text or "切片" in blank_text.text

    blank_id = client.post("/v1/knowledge", json={"doc_id": "  ", "text": "有内容的正文"})
    assert blank_id.status_code == 422

    # 一个都没写进去，计数保持为空
    assert client.get("/v1/knowledge").json()["documents"] == 0

    # 首尾空白会被去掉，正文照样能检索
    ok = client.post("/v1/knowledge", json={"doc_id": "  d2  ", "text": "  安装器通用外壳  "})
    assert ok.status_code == 200
    assert ok.json()["doc_id"] == "d2"
    assert ok.json()["chunks"] >= 1
