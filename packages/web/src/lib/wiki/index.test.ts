import { describe, it, expect } from "vitest";
import {
  buildGraph,
  extractLinks,
  isWikiEphemeral,
  parseFrontmatter,
  parsePagePath,
  renderIndex,
  renderPage,
  slugify,
  type WikiPage,
} from "./index.js";
import { layoutGraph, nodeRadius } from "./layout.js";

const page = (over: Partial<WikiPage> & Pick<WikiPage, "path" | "title">): WikiPage => ({
  kind: parsePagePath(over.path)?.kind ?? "notes",
  tags: [],
  body: "",
  updatedAt: "2026-10-20",
  ...over,
});

describe("slugify：文件名安全化", () => {
  it("去非法字符、空格转连字符、去首尾连字符", () => {
    expect(slugify("和鸣：记忆/LLM?")).toBe("和鸣-记忆-LLM");
    expect(slugify("  a  b  ")).toBe("a-b");
    expect(slugify("--x--")).toBe("x");
  });

  it("空标题与超长标题有兜底（不会产出空文件名或超长路径）", () => {
    expect(slugify("")).toBe("未命名");
    expect(slugify("   ")).toBe("未命名");
    expect(slugify("x".repeat(200)).length).toBeLessThanOrEqual(60);
  });

  it("挡掉路径分隔符与 Windows 保留字符，防止写到目录外", () => {
    const s = slugify("../../etc/passwd");
    expect(s).not.toContain("/");
    expect(s).not.toContain("\\");
  });
});

describe("frontmatter 解析与渲染", () => {
  it("解析 title / tags / updated，body 为其余正文", () => {
    const raw = renderPage({ title: "LLM", tags: ["ai", "记忆"], body: "正文一行\n正文两行" });
    const { meta, body } = parseFrontmatter(raw);
    expect(meta.title).toBe("LLM");
    expect(meta.tags).toEqual(["ai", "记忆"]);
    expect(meta.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.trim()).toBe("正文一行\n正文两行");
  });

  it("无 frontmatter 时整篇当正文，不报错", () => {
    const { meta, body } = parseFrontmatter("# 标题\n内容");
    expect(meta).toEqual({});
    expect(body).toContain("内容");
  });

  it("tags 为空时省略该行，不留空数组噪声", () => {
    const raw = renderPage({ title: "X", body: "b" });
    expect(raw).not.toContain("tags:");
  });

  it("容忍 BOM 与 CRLF", () => {
    const { meta } = parseFrontmatter("﻿---\r\ntitle: A\r\n---\r\n正文");
    expect(meta.title).toBe("A");
  });
});

describe("[[双链]] 抽取", () => {
  it("抽出目标与别名", () => {
    expect(extractLinks("见 [[和小鸣]] 与 [[向量检索|检索]]")).toEqual([
      { target: "和小鸣" },
      { target: "向量检索", alias: "检索" },
    ]);
  });

  it("空目标不产出条目，未闭合的也不产出", () => {
    // [[]] 是空目标 → 丢弃；[[未闭合 没有闭合 ]] → 整个不匹配
    expect(extractLinks("[[]] 与 [[未闭合")).toEqual([]);
  });

  it("目标里可含空格（别名写法），两端空白被裁掉", () => {
    expect(extractLinks("[[ 和小鸣 ]]")).toEqual([{ target: "和小鸣" }]);
    expect(extractLinks("[[a b|显示 文字]]")).toEqual([{ target: "a b", alias: "显示 文字" }]);
  });
});

describe("buildGraph：由双链建图", () => {
  const pages = [
    page({ path: "wiki/concepts/llm.md", title: "LLM", body: "见 [[记忆]] 与 [[和鸣]]" }),
    page({ path: "wiki/concepts/memory.md", title: "记忆", body: "与 [[和鸣]] 相关" }),
    page({ path: "wiki/entities/heming.md", title: "和鸣", body: "" }),
    page({ path: "wiki/notes/isolated.md", title: "孤立笔记", body: "" }),
  ];

  it("边按标题解析目标，去重", () => {
    const g = buildGraph(pages);
    // LLM→记忆 / LLM→和鸣 / 记忆→和鸣，共 3 条（LLM→和鸣 只画一次）
    expect(g.edges).toHaveLength(3);
    expect(g.edges.map((e) => `${e.source}->${e.target}`)).toContain(
      "wiki/concepts/llm.md->wiki/entities/heming.md",
    );
  });

  it("度：枢纽页 degree 更高；无链接页标为孤儿", () => {
    const g = buildGraph(pages);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get("wiki/entities/heming.md")!.degree).toBe(2);
    expect(byId.get("wiki/concepts/llm.md")!.degree).toBe(2);
    expect(byId.get("wiki/concepts/memory.md")!.degree).toBe(2);
    expect(byId.get("wiki/notes/isolated.md")!.orphan).toBe(true);
    expect(byId.get("wiki/concepts/llm.md")!.orphan).toBe(false);
  });

  it("链接到不存在的页面时不造幽灵节点", () => {
    const g = buildGraph([page({ path: "wiki/notes/a.md", title: "A", body: "见 [[不存在]]" })]);
    expect(g.nodes).toHaveLength(1);
    expect(g.edges).toHaveLength(0);
  });

  it("自引用不成边（否则节点会连到自己）", () => {
    const g = buildGraph([page({ path: "wiki/notes/a.md", title: "A", body: "见 [[A]]" })]);
    expect(g.edges).toHaveLength(0);
  });

  it("同名页面时链接解析到先出现的那一个", () => {
    const g = buildGraph([
      page({ path: "wiki/notes/a.md", title: "同名", body: "" }),
      page({ path: "wiki/notes/b.md", title: "别名", body: "见 [[同名]]" }),
    ]);
    expect(g.edges[0].target).toBe("wiki/notes/a.md");
  });
});

describe("layoutGraph：确定性力导向布局", () => {
  const pages = [
    page({ path: "wiki/concepts/a.md", title: "A", body: "[[B]]" }),
    page({ path: "wiki/concepts/b.md", title: "B", body: "[[A]] [[C]]" }),
    page({ path: "wiki/concepts/c.md", title: "C", body: "[[B]]" }),
  ];
  const graph = buildGraph(pages);

  it("同一输入两次调用结果完全一致（无随机，用户能形成空间记忆）", () => {
    const a = layoutGraph(graph, 800, 600);
    const b = layoutGraph(graph, 800, 600);
    expect(a).toEqual(b);
  });

  it("每个节点都有坐标，且是有限数", () => {
    for (const p of layoutGraph(graph, 800, 600)) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("有连接的节点彼此拉近（距离小于无连接的两点）", () => {
    const pts = layoutGraph(graph, 800, 600);
    const byId = new Map(pts.map((p) => [p.id, p]));
    const a = byId.get("wiki/concepts/a.md")!;
    const b = byId.get("wiki/concepts/b.md")!;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(400);
  });

  it("空图返回空数组，不抛", () => {
    expect(layoutGraph({ nodes: [], edges: [] }, 800, 600)).toEqual([]);
  });

  it("全部重合的 id 不会除零或产生 NaN", () => {
    // 两个不同 id 但极相似的内容：初值几乎重合，考验除零保护
    const g = buildGraph([
      page({ path: "wiki/notes/x.md", title: "X", body: "" }),
      page({ path: "wiki/notes/y.md", title: "Y", body: "" }),
    ]);
    for (const p of layoutGraph(g, 400, 300)) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe("nodeRadius：枢纽页更大", () => {
  it("随度数单调不减，且有上下限", () => {
    expect(nodeRadius(0)).toBeLessThan(nodeRadius(1));
    expect(nodeRadius(1)).toBeLessThan(nodeRadius(5));
    expect(nodeRadius(5)).toBeLessThanOrEqual(16);
    expect(nodeRadius(1000)).toBe(16);
    expect(nodeRadius(0)).toBeGreaterThanOrEqual(4);
  });
});

describe("renderIndex：内容目录", () => {
  it("按类别分组，每条是 [[标题]] + 一句话摘要", () => {
    const g = buildGraph([]);
    expect(g.nodes).toHaveLength(0);
    const md = renderIndex([
      page({ path: "wiki/concepts/llm.md", title: "LLM", body: "大语言模型的统称\n第二段" }),
      page({ path: "wiki/entities/heming.md", title: "和鸣", body: "本项目名称" }),
    ]);
    expect(md).toContain("## 概念（1）");
    expect(md).toContain("[[LLM]] —— 大语言模型的统称");
    expect(md).toContain("## 实体（1）");
    expect(md).toContain("[[和鸣]] —— 本项目名称");
    expect(md).toContain("共 2 个页面");
  });

  it("摘要取首个非标题非列表行，并截断到 60 字", () => {
    const long = "长".repeat(100);
    const md = renderIndex([page({ path: "wiki/notes/a.md", title: "A", body: long })]);
    expect(md).toContain(`${"长".repeat(60)}…`);
  });

  it("跳过标题行与分隔线做摘要", () => {
    const md = renderIndex([
      page({ path: "wiki/notes/a.md", title: "A", body: "# 小标题\n---\n真正的首行" }),
    ]);
    expect(md).toContain("[[A]] —— 真正的首行");
  });
});

describe("浏览器模式判定", () => {
  it("无 preload 桥时判定为临时模式", () => {
    // jsdom 环境下没有注入 __heming_wiki
    expect(isWikiEphemeral()).toBe(true);
  });
});