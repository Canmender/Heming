import { describe, expect, it } from "vitest";
import {
  parseSearchQuery,
  QUICK_OPEN_DEFAULT_LIMIT,
  rankQuickOpen,
  runSearch,
  SEARCH_MAX,
} from "./search.js";
import {
  buildVaultIndex,
  buildVaultIndexFromParsed,
  parseDocWithOffset,
  type ParsedVaultDoc,
  type VaultDocInput,
} from "./index.js";
import type { VaultIndex } from "./types.js";

/**
 * vault 搜索：查询语法解析 + 执行（tag/path/file/line/短语/排除/CJK 二元组）。
 *
 * 夹具刻意让「预算」与「风险」分处两行，用来验证 `line:` 的「同一行」语义
 * 与普通正文搜索的「全页 AND」语义确实不同；行号同时验证 frontmatter 偏移。
 */

const DOCS: VaultDocInput[] = [
  {
    rel: "项目/预算.md",
    text: "---\ntags: [项目, 预算]\n---\n# 预算\n本季度预算与风险都很高。\n部署流程待定。\n",
    mtime: "2026-11-08T00:00:00.000Z",
  },
  {
    rel: "部署.md",
    text: "---\ntags: [项目]\n---\n# 部署\n回滚部署流程。\n预算风险：低。\n",
    mtime: "2026-11-08T00:00:00.000Z",
  },
  {
    rel: "分开.md",
    text: "预算在这里\n风险在下一行\n",
    mtime: "2026-11-08T00:00:00.000Z",
  },
  {
    rel: "杂项.md",
    text: "没有关键词的一页。\n",
    mtime: "2026-11-08T00:00:00.000Z",
  },
];

const PARSED: ParsedVaultDoc[] = DOCS.map((doc) => parseDocWithOffset(doc));
const INDEX: VaultIndex = buildVaultIndexFromParsed(PARSED);
const LINE_OFFSETS = new Map(PARSED.map((item) => [item.page.rel, item.lineOffset]));

function search(query: string, limit?: number) {
  return runSearch(INDEX, query, {
    ...(limit === undefined ? {} : { limit }),
    lineOffsetOf: (rel) => LINE_OFFSETS.get(rel) ?? 0,
  });
}

describe("parseSearchQuery", () => {
  it("识别五种键与自由词", () => {
    const query = parseSearchQuery("tag:#项目 path:项目 file:预算 line:预算 自由词");
    expect(query.terms).toEqual([
      { key: "tag", value: "项目", phrase: false },
      { key: "path", value: "项目", phrase: false },
      { key: "file", value: "预算", phrase: false },
      { key: "line", value: "预算", phrase: false },
      { key: "content", value: "自由词", phrase: false },
    ]);
    expect(query.negations).toEqual([]);
  });

  it("引号短语保留空格", () => {
    const query = parseSearchQuery('"预算 风险"');
    expect(query.terms).toEqual([{ key: "content", value: "预算 风险", phrase: true }]);
  });

  it("键 + 引号短语", () => {
    expect(parseSearchQuery('tag:"项目 甲"').terms).toEqual([
      { key: "tag", value: "项目 甲", phrase: true },
    ]);
  });

  it("- 前缀是排除词，排除词也能带键", () => {
    const query = parseSearchQuery("预算 -tag:部署 -\"旧 结论\"");
    expect(query.terms).toEqual([{ key: "content", value: "预算", phrase: false }]);
    expect(query.negations).toEqual([
      { key: "tag", value: "部署", phrase: false },
      { key: "content", value: "旧 结论", phrase: true },
    ]);
  });

  it("多级标签保留斜杠，键名大小写不敏感", () => {
    expect(parseSearchQuery("TAG:#a/b").terms).toEqual([
      { key: "tag", value: "a/b", phrase: false },
    ]);
  });

  it("空串、纯空白、孤立 - 都不产生词", () => {
    expect(parseSearchQuery("").terms).toEqual([]);
    expect(parseSearchQuery("   ").terms).toEqual([]);
    expect(parseSearchQuery("- ").terms).toEqual([]);
  });
});

describe("runSearch", () => {
  it("tag: 按层级前缀匹配（大小写不敏感；口径对齐 Obsidian，不再是精确相等）", () => {
    // 旧口径是「标签精确相等」，与 Obsidian 的 tag: 语义不一致：
    // 用户按顶层标签过滤时会漏掉所有子标签页面（#构建 搜不到 #构建/知识库）。
    // 现口径：同名或 `目标/` 前缀命中；不做字符串中间匹配（#构建x 不算 #构建 的子标签）。
    const hits = search("tag:项目");
    expect(hits.map((hit) => hit.rel)).toEqual(["部署.md", "项目/预算.md"]);
    expect(hits.every((hit) => hit.matched.join(",") === "tag")).toBe(true);
    // 纯过滤命中的行号也带 frontmatter 偏移
    expect(hits.find((hit) => hit.rel === "部署.md")?.line).toBe(4);
  });

  it("tag: 子标签层级：父标签命中子标签，子标签只命中自己与更深层，中间不做匹配", () => {
    const index = buildVaultIndex([
      { rel: "顶层.md", text: "---\ntags: [构建]\n---\n", mtime: "t" },
      { rel: "子级.md", text: "---\ntags: [构建/知识库]\n---\n", mtime: "t" },
      { rel: "深层.md", text: "---\ntags: [构建/知识库/索引]\n---\n", mtime: "t" },
      { rel: "干扰.md", text: "---\ntags: [构建x, 构建-其他]\n---\n", mtime: "t" },
    ]);
    const rels = (query: string): string[] =>
      runSearch(index, query)
        .map((hit) => hit.rel)
        .sort();

    expect(rels("tag:构建")).toEqual(["子级.md", "深层.md", "顶层.md"].sort());
    expect(rels("tag:#构建")).toEqual(rels("tag:构建"));
    expect(rels("tag:构建/知识库")).toEqual(["子级.md", "深层.md"].sort());
    expect(rels("tag:构建/知识库/索引")).toEqual(["深层.md"]);
    // 以 / 为边界：构建x、构建-其他 不是 构建 的子标签
    expect(rels("tag:构建x")).toEqual(["干扰.md"]);
    expect(rels("tag:构建x/任意")).toEqual([]);
    // 不做字符串中间匹配
    expect(rels("tag:构")).toEqual([]);
    expect(rels("tag:知识库")).toEqual([]);
    // 大小写不敏感
    expect(rels("TAG:构建/知识库")).toEqual(rels("tag:构建/知识库"));
    // 排除词同样按层级语义
    expect(rels("tag:构建x -tag:构建")).toEqual(["干扰.md"]);
  });

  it("path: 与 file: 各自只认路径 / 文件名", () => {
    expect(search("path:项目").map((hit) => hit.rel)).toEqual(["项目/预算.md"]);
    expect(search("path:项目")[0].matched).toEqual(["path"]);
    expect(search("file:预算").map((hit) => hit.rel)).toEqual(["项目/预算.md"]);
    expect(search("file:预算")[0].matched).toEqual(["file"]);
  });

  it("line: 要求所有分词落在同一行（分开.md 两行各一个词，不命中）", () => {
    const hits = search("line:预算风险");
    expect(hits.map((hit) => hit.rel)).toEqual(["部署.md", "项目/预算.md"]);
    expect(hits.find((hit) => hit.rel === "部署.md")?.line).toBe(6);
    expect(hits.find((hit) => hit.rel === "项目/预算.md")?.line).toBe(5);
  });

  it("普通正文搜索是整页 AND（允许跨行）", () => {
    const hits = search("content:预算 风险");
    expect(hits.map((hit) => hit.rel)).toContain("分开.md");
  });

  it("CJK 长词按二元组覆盖率命中（「预算风险」命中「预算与风险」）", () => {
    const hits = search("预算风险");
    expect(hits.map((hit) => hit.rel)).toContain("项目/预算.md");
    // 整词命中的「部署.md」得分更高，排第一
    expect(hits[0].rel).toBe("部署.md");
  });

  it("引号短语按原文精确匹配，并给出命中行与片段", () => {
    const hits = search('"预算与风险"');
    expect(hits.map((hit) => hit.rel)).toEqual(["项目/预算.md"]);
    expect(hits[0].line).toBe(5);
    expect(hits[0].snippet).toContain("预算与风险");
  });

  it("排除词命中即整页丢弃", () => {
    expect(search("预算 -tag:项目").map((hit) => hit.rel)).toEqual(["分开.md"]);
    expect(search('预算 -"本季度"').map((hit) => hit.rel)).not.toContain("项目/预算.md");
  });

  it("只有排除词 / 空查询返回空数组", () => {
    expect(search("-tag:项目")).toEqual([]);
    expect(search("")).toEqual([]);
    expect(runSearch(null, "预算")).toEqual([]);
  });

  it("多键组合时 matched 按固定顺序输出", () => {
    const hits = search("tag:项目 预算");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].matched).toEqual(["tag", "content"]);
  });

  it("limit 生效且硬上限为 200", () => {
    expect(search("预算", 1)).toHaveLength(1);
    const many = runSearch(INDEX, "预算", { limit: 999 });
    expect(many.length).toBeLessThanOrEqual(SEARCH_MAX);
  });

  it("确定性：同一索引同一查询两次结果完全一致", () => {
    const a = search("预算 风险");
    const b = search("预算 风险");
    expect(a).toEqual(b);
    // 得分降序、同分按 rel 升序
    for (let i = 1; i < a.length; i += 1) {
      const prev = a[i - 1];
      const next = a[i];
      expect(prev.score > next.score || (prev.score === next.score && prev.rel < next.rel)).toBe(
        true,
      );
    }
  });
});

describe("rankQuickOpen（快速切换）", () => {
  const QUICK_INDEX = buildVaultIndex([
    {
      rel: "项目/预算.md",
      text: "---\naliases: [季度预算]\n---\n# 预算\n正文\n",
      mtime: "2026-11-08T00:00:00.000Z",
    },
    { rel: "部署.md", text: "# 部署\n正文\n", mtime: "2026-11-08T00:00:00.000Z" },
    { rel: "项目/部署记录.md", text: "# 部署记录\n正文\n", mtime: "2026-11-08T00:00:00.000Z" },
  ]);

  it("文件名精确/前缀/包含优先于别名与路径", () => {
    const hits = rankQuickOpen(QUICK_INDEX, "部署");
    expect(hits[0]).toMatchObject({ rel: "部署.md", matchKind: "title" });
    expect(hits.map((hit) => hit.rel)).toContain("项目/部署记录.md");
  });

  it("别名也能命中（matchKind=alias）", () => {
    const hits = rankQuickOpen(QUICK_INDEX, "季度预算");
    expect(hits[0]).toMatchObject({ rel: "项目/预算.md", matchKind: "alias" });
  });

  it("路径匹配（含目录名）与子序列模糊匹配", () => {
    const pathHit = rankQuickOpen(QUICK_INDEX, "项目").find((hit) => hit.rel === "项目/预算.md");
    expect(pathHit).toBeDefined();
    // 「项预」是「项目/预算」的子序列
    const fuzzy = rankQuickOpen(QUICK_INDEX, "项预");
    expect(fuzzy.map((hit) => hit.rel)).toContain("项目/预算.md");
  });

  it("大小写不敏感", () => {
    const index = buildVaultIndex([
      { rel: "RoadMap.md", text: "# RoadMap\n", mtime: "2026-11-08T00:00:00.000Z" },
    ]);
    expect(rankQuickOpen(index, "roadmap")[0]).toMatchObject({
      rel: "RoadMap.md",
      matchKind: "title",
    });
    expect(rankQuickOpen(index, "ROADMAP")[0].rel).toBe("RoadMap.md");
  });

  it("空 query 按 recent 顺序返回最近打开（过滤不存在与重复）", () => {
    const hits = rankQuickOpen(QUICK_INDEX, "   ", 8, [
      "部署.md",
      "不存在的.md",
      "./部署.md",
      "项目/预算.md",
    ]);
    expect(hits).toEqual([
      { rel: "部署.md", title: "部署", matchKind: "recent" },
      { rel: "项目/预算.md", title: "预算", matchKind: "recent" },
    ]);
    expect(rankQuickOpen(QUICK_INDEX, "")).toEqual([]);
  });

  it("limit 生效、空索引返回空、结果确定性", () => {
    expect(rankQuickOpen(QUICK_INDEX, "部署", 1)).toHaveLength(1);
    expect(rankQuickOpen(null, "部署")).toEqual([]);
    expect(rankQuickOpen(QUICK_INDEX, "部署")).toEqual(rankQuickOpen(QUICK_INDEX, "部署"));
    // 默认上限 8
    expect(QUICK_OPEN_DEFAULT_LIMIT).toBe(8);
  });
});
