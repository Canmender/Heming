import { describe, it, expect } from "vitest";
import {
  WIKI_SEARCH_MAX,
  WIKI_TOOLS,
  buildWikiToolBridge,
  searchPages,
  validWikiPath,
} from "./tools.js";
import { renderPage, type WikiBridge, type WikiPage } from "./index.js";

/** 内存桥：文件表 + 记录 read 过的路径（用于验证越界路径没被读到）。 */
function fakeBridge(files: Record<string, string>) {
  const reads: string[] = [];
  const map = new Map(Object.entries(files));
  const bridge: WikiBridge = {
    async info() {
      return { root: "/tmp/wiki", exists: true };
    },
    async list() {
      return [...map.keys()].sort();
    },
    async read(rel) {
      reads.push(rel);
      return map.get(rel) ?? null;
    },
    async write(rel, content) {
      map.set(rel, content);
      return { path: rel, bytes: content.length };
    },
    async remove(rel) {
      return map.delete(rel);
    },
    async log() {
      return true;
    },
  };
  return { bridge, reads, map };
}

const FILES = {
  "wiki/concepts/llm.md": renderPage({ title: "LLM", tags: ["ai"], body: "大语言模型的统称，本项目的核心。" }),
  "wiki/entities/heming.md": renderPage({ title: "和鸣", tags: ["项目"], body: "本项目的名称，基于 LLM 的本地智能体。" }),
  "wiki/notes/other.md": renderPage({ title: "其他", body: "与检索无关的笔记。" }),
  "index.md": "# 索引\nLLM 和鸣",
  "raw/source.md": "# 原始资料\nLLM 的历史",
};

describe("wiki 检索（纯函数）", () => {
  const page = (over: Partial<WikiPage> & Pick<WikiPage, "path" | "title">): WikiPage => ({
    kind: "notes",
    tags: [],
    body: "",
    updatedAt: "",
    ...over,
  });

  it("所有关键词都命中才入选，标题命中排在正文命中前", () => {
    const pages = [
      page({ path: "wiki/a.md", title: "部署流程", body: "发布、回滚" }),
      page({ path: "wiki/b.md", title: "杂记", body: "部署流程见另一页" }),
    ];
    const hits = searchPages(pages, "部署流程");
    expect(hits.map((h) => h.page.path)).toEqual(["wiki/a.md", "wiki/b.md"]);
  });

  it("多关键词按 AND 过滤", () => {
    const pages = [
      page({ path: "wiki/a.md", title: "部署流程", body: "回滚要小心" }),
      page({ path: "wiki/b.md", title: "部署", body: "与发布无关" }),
    ];
    expect(searchPages(pages, "部署 回滚").map((h) => h.page.path)).toEqual(["wiki/a.md"]);
  });

  it("结果确定：同分时按标题、再按路径排序", () => {
    const pages = [
      page({ path: "wiki/z.md", title: "B", body: "k" }),
      page({ path: "wiki/a.md", title: "A", body: "k" }),
      page({ path: "wiki/y.md", title: "A", body: "k" }),
    ];
    expect(searchPages(pages, "k").map((h) => h.page.path)).toEqual([
      "wiki/a.md",
      "wiki/y.md",
      "wiki/z.md",
    ]);
  });

  it("空 query 返回空；limit 被夹在 1..上限", () => {
    const pages = Array.from({ length: 15 }, (_, i) =>
      page({ path: `wiki/${i}.md`, title: `页 ${i}`, body: "共同词" }),
    );
    expect(searchPages(pages, "  ")).toEqual([]);
    expect(searchPages(pages, "共同词", 0)).toHaveLength(1);
    expect(searchPages(pages, "共同词", 999)).toHaveLength(WIKI_SEARCH_MAX);
  });
});

describe("wiki 路径校验", () => {
  it("只放行 wiki/ 或 raw/ 下的 .md", () => {
    expect(validWikiPath("wiki/concepts/llm.md")).toBe("wiki/concepts/llm.md");
    expect(validWikiPath("./wiki/notes/a.md")).toBe("wiki/notes/a.md");
    expect(validWikiPath("raw/source.md")).toBe("raw/source.md");
  });

  it("拦掉越界与非法路径", () => {
    for (const bad of [
      "../../etc/passwd",
      "wiki/../../secret.md",
      "/etc/passwd",
      "C:\\Windows\\x.md",
      "wiki\\notes\\a.md",
      "wiki/notes/a.txt",
      "other/a.md",
      "wiki/a.md\u0000.png",
      "",
      null,
      42,
    ]) {
      expect(validWikiPath(bad)).toBeNull();
    }
  });
});

describe("wiki 工具桥", () => {
  const call = (bridge: WikiBridge, name: string, args: Record<string, unknown>) =>
    buildWikiToolBridge(bridge).execute({ name, arguments: JSON.stringify(args) });

  it("搜索命中页面并带回 sources（可直接进答案脚注）", async () => {
    const { bridge } = fakeBridge(FILES);
    const r = await call(bridge, "wiki_search", { query: "LLM" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("LLM");
    expect(r.text).toContain("wiki/concepts/llm.md");
    expect(r.text).toContain("wiki/entities/heming.md");
    expect(r.text).not.toContain("wiki/notes/other.md");
    expect(r.sources).toEqual([
      { id: "wiki/concepts/llm.md", title: "LLM", detail: "概念" },
      { id: "wiki/entities/heming.md", title: "和鸣", detail: "实体" },
    ]);
  });

  it("搜索只扫 wiki/，不把 index.md 与 raw/ 当页面", async () => {
    const { bridge } = fakeBridge(FILES);
    const r = await call(bridge, "wiki_search", { query: "LLM" });
    expect(r.sources?.map((s) => s.id)).not.toContain("raw/source.md");
    expect(r.sources?.map((s) => s.id)).not.toContain("index.md");
  });

  it("没有命中：ok=true 但没有来源（不是错误）", async () => {
    const { bridge } = fakeBridge(FILES);
    const r = await call(bridge, "wiki_search", { query: "完全不存在的词" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("没有匹配");
    expect(r.sources).toBeUndefined();
  });

  it("读取页面：正文与来源齐全；不存在的页面给出明确原因", async () => {
    const { bridge } = fakeBridge(FILES);
    const r = await call(bridge, "wiki_read", { path: "wiki/entities/heming.md" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("# 和鸣");
    expect(r.text).toContain("本地智能体");
    expect(r.sources).toEqual([{ id: "wiki/entities/heming.md", title: "和鸣" }]);

    const missing = await call(bridge, "wiki_read", { path: "wiki/entities/ghost.md" });
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain("没有页面");
  });

  it("越界路径在 read 之前就被拒绝（模型给的参数不可信）", async () => {
    const { bridge, reads } = fakeBridge(FILES);
    const r = await call(bridge, "wiki_read", { path: "../../etc/passwd" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("必须是");
    expect(reads).toEqual([]);
  });

  it("空 query、坏 JSON、未知工具都不抛", async () => {
    const { bridge } = fakeBridge(FILES);
    expect((await call(bridge, "wiki_search", {})).ok).toBe(false);
    const bad = await buildWikiToolBridge(bridge).execute({
      name: "wiki_search",
      arguments: "{坏 JSON",
    });
    expect(bad.ok).toBe(false);
    const unknown = await call(bridge, "wiki_write", {});
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain("未知工具");
  });

  it("读库异常时返回原因而不是抛", async () => {
    const broken: WikiBridge = {
      ...fakeBridge(FILES).bridge,
      async list() {
        throw new Error("磁盘只读");
      },
    };
    const r = await call(broken, "wiki_search", { query: "LLM" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("读取知识库失败");
  });

  it("两个工具都声明为 read（HITL 不把它们当写操作来问）", () => {
    const bridge = buildWikiToolBridge(fakeBridge(FILES).bridge);
    for (const name of ["wiki_search", "wiki_read"]) {
      expect(bridge.meta?.(name)).toEqual({ risk: "read" });
    }
    expect(WIKI_TOOLS.every((t) => t.riskHint === "read")).toBe(true);
    expect(bridge.meta?.("wiki_unknown")).toBeUndefined();
  });
});
