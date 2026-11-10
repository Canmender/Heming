import { describe, expect, it, vi } from "vitest";
import { createMemoryVaultBridge } from "./bridge.js";
import { VaultBridgeError, type VaultBridge, type VaultEntry } from "./types.js";
import {
  STANDARD_DIRS,
  STANDARD_ROOT_FILES,
  applyStandardRepair,
  buildStandardFile,
  inspectStandard,
  isRawRel,
  missingFrontmatterFields,
  type StandardReport,
} from "./standard.js";

const MTIME = "2026-11-10T08:00:00.000Z";

function dir(rel: string, children?: VaultEntry[]): VaultEntry {
  return { rel, name: rel.split("/").pop() ?? rel, kind: "dir", size: 0, mtime: MTIME, children };
}

function md(rel: string): VaultEntry {
  return { rel, name: rel.split("/").pop() ?? rel, kind: "md", size: 10, mtime: MTIME };
}

/** 一个完全合格的库树（用来验证「complete」不会误报）。 */
function standardTree(): VaultEntry[] {
  return [
    dir("raw"),
    dir("wiki", [
      dir("wiki/entities"),
      dir("wiki/concepts"),
      dir("wiki/sources"),
      dir("wiki/synthesis"),
      dir("wiki/notes"),
    ]),
    ...STANDARD_ROOT_FILES.map((rel) => md(rel)),
  ];
}

describe("标准模板", () => {
  it("四个根文件都带 created + tags frontmatter，日期用注入值", () => {
    for (const rel of STANDARD_ROOT_FILES) {
      const text = buildStandardFile(rel, "2026-11-10");
      expect(text, `${rel} 必须有模板`).not.toBeNull();
      expect(text).toMatch(/^---\n/);
      expect(text).toContain("created: 2026-11-10");
      expect(text).toMatch(/\ntags: \[[^\]]+\]/);
      // 模板自己要能通过标准检查（刚补齐的库不该立刻报缺）
      expect(missingFrontmatterFields({ created: "2026-11-10", tags: ["x"] })).toEqual([]);
    }
  });

  it("schema.md 保留卡帕西标准的三层结构与 ingest/query/lint 流程", () => {
    const schema = buildStandardFile("schema.md", "2026-11-10") ?? "";
    expect(schema).toContain("raw/");
    expect(schema).toContain("wiki/<类别>/");
    expect(schema).toContain("Ingest（摄入）");
    expect(schema).toContain("Query（提问）");
    expect(schema).toContain("Lint（体检）");
  });

  it("未知文件返回 null（调用方跳过，不凭空造文件）", () => {
    expect(buildStandardFile("README.md", "2026-11-10")).toBeNull();
  });
});

describe("raw/ 只读口径", () => {
  it("raw 目录本身与它下面任何层级都算只读来源", () => {
    expect(isRawRel("raw")).toBe(true);
    expect(isRawRel("raw/论文.md")).toBe(true);
    expect(isRawRel("raw/2026/访谈.md")).toBe(true);
    expect(isRawRel("wiki/entities/raw.md")).toBe(false);
    expect(isRawRel("raw.md")).toBe(false);
    expect(isRawRel("inbox/raw/笔记.md")).toBe(false);
  });
});

describe("frontmatter 必备字段判定", () => {
  it("created 与 tags 都缺（没有 frontmatter）时两个都报", () => {
    expect(missingFrontmatterFields({})).toEqual(["created", "tags"]);
    expect(missingFrontmatterFields(undefined)).toEqual(["created", "tags"]);
  });

  it("tags 为空数组/空串算缺；标量 tags 也算合格（老页面常见写法）", () => {
    expect(missingFrontmatterFields({ created: "2026-01-01", tags: [] })).toEqual(["tags"]);
    expect(missingFrontmatterFields({ created: "2026-01-01", tags: "  " })).toEqual(["tags"]);
    expect(missingFrontmatterFields({ created: "2026-01-01", tags: ["项目"] })).toEqual([]);
    expect(missingFrontmatterFields({ created: "2026-01-01", tags: "项目" })).toEqual([]);
    expect(missingFrontmatterFields({ created: "2026-01-01" })).toEqual(["tags"]);
  });
});

describe("inspectStandard：结构检查", () => {
  it("结构完整且页面 frontmatter 合格 → complete", () => {
    const report = inspectStandard({
      tree: standardTree(),
      pages: new Map([
        ["index.md", { frontmatter: { created: "2026-01-01", tags: ["index"] } }],
        ["wiki/entities/和鸣.md", { frontmatter: { created: "2026-01-01", tags: ["项目"] } }],
      ]),
    });
    expect(report.missingDirs).toEqual([]);
    expect(report.missingFiles).toEqual([]);
    expect(report.pageIssues).toEqual([]);
    expect(report.scannedPages).toBe(2);
    expect(report.complete).toBe(true);
    expect(report.frontmatterChecked).toBe(true);
  });

  it("缺目录与根文件都列出来（补的是具体路径，不是一句「结构不完整」）", () => {
    const tree: VaultEntry[] = [
      dir("raw"),
      dir("wiki", [dir("wiki/entities")]),
      md("index.md"),
    ];
    const report = inspectStandard({ tree, pages: null });
    expect(report.missingDirs.sort()).toEqual(
      STANDARD_DIRS.filter((d) => d !== "raw" && d !== "wiki/entities").sort(),
    );
    expect(report.missingFiles.sort()).toEqual(["log.md", "schema.md", "首页.md"]);
    expect(report.frontmatterChecked).toBe(false);
    expect(report.complete).toBe(false);
  });

  it("索引未就绪时只查结构，不假装 frontmatter 通过", () => {
    const report = inspectStandard({ tree: standardTree(), pages: null });
    expect(report.frontmatterChecked).toBe(false);
    expect(report.scannedPages).toBe(0);
    expect(report.pageIssueCount).toBe(0);
    // 结构齐了就算 complete（frontmatter 这次没查，界面会说明）
    expect(report.complete).toBe(true);
  });

  it("缺 frontmatter 的页面按路径列出 missing 字段，最多列 MAX_PAGE_ISSUES 条", () => {
    const pages = new Map<string, { frontmatter: Record<string, string | string[]> }>();
    pages.set("notes/a.md", { frontmatter: {} });
    pages.set("notes/b.md", { frontmatter: { created: "2026-01-01" } });
    pages.set("notes/c.md", { frontmatter: { created: "2026-01-01", tags: ["x"] } });
    const report = inspectStandard({ tree: standardTree(), pages });
    expect(report.pageIssueCount).toBe(2);
    expect(report.pageIssues).toEqual([
      { rel: "notes/a.md", missing: ["created", "tags"] },
      { rel: "notes/b.md", missing: ["tags"] },
    ]);
    expect(report.complete).toBe(false);
  });
});

describe("applyStandardRepair：只补缺、不覆盖", () => {
  it("空库一键补齐：目录 + 四个根文件都建好，复查通过", async () => {
    const bridge = createMemoryVaultBridge({ now: () => Date.parse("2026-11-10T00:00:00Z") });
    const before = await bridge.tree("memory", { depth: 4 });
    const report = inspectStandard({ tree: before, pages: new Map() });
    expect(report.missingDirs.length).toBe(STANDARD_DIRS.length);
    expect(report.missingFiles.length).toBe(STANDARD_ROOT_FILES.length);

    const result = await applyStandardRepair(bridge, "memory", report, { today: "2026-11-10" });
    expect(result.failures).toEqual([]);
    expect(result.createdDirs.sort()).toEqual([...STANDARD_DIRS].sort());
    expect(result.createdFiles.sort()).toEqual([...STANDARD_ROOT_FILES].sort());

    const after = await bridge.tree("memory", { depth: 4 });
    const recheck = inspectStandard({ tree: after, pages: new Map() });
    expect(recheck.complete).toBe(true);
    const schema = await bridge.read("memory", "schema.md");
    expect(schema?.text).toContain("created: 2026-11-10");
    expect(schema?.text).toContain("知识库规约");
  });

  it("已有文件一字不动：只补缺的那几个", async () => {
    const userIndex = "---\ntitle: 我的索引\ncreated: 2025-01-01\ntags: [mine]\n---\n\n用户自己写的\n";
    const bridge = createMemoryVaultBridge({ files: { "index.md": userIndex } });
    const tree = await bridge.tree("memory", { depth: 4 });
    const report = inspectStandard({ tree, pages: null });
    const result = await applyStandardRepair(bridge, "memory", report, { today: "2026-11-10" });

    expect(result.createdFiles).not.toContain("index.md");
    expect(result.createdFiles.sort()).toEqual(["log.md", "schema.md", "首页.md"]);
    expect((await bridge.read("memory", "index.md"))?.text).toBe(userIndex);
  });

  it("补齐过程中「文件刚被建好」不算失败（并发窗口按已存在跳过）", async () => {
    const memory = createMemoryVaultBridge();
    const tree = await memory.tree("memory", { depth: 4 });
    const report = inspectStandard({ tree, pages: null });
    const bridge: VaultBridge = {
      ...memory,
      create: vi.fn(async () => {
        throw new VaultBridgeError("io-error", "文件已存在：index.md。");
      }),
    };
    const result = await applyStandardRepair(bridge, "memory", report, { today: "2026-11-10" });
    expect(result.failures).toEqual([]);
  });

  it("真实失败（没权限等）逐项报出来，不宣称已补齐", async () => {
    const memory = createMemoryVaultBridge();
    const tree = await memory.tree("memory", { depth: 4 });
    const report: StandardReport = inspectStandard({ tree, pages: null });
    const bridge: VaultBridge = {
      ...memory,
      createDir: vi.fn(async () => {
        throw new VaultBridgeError("io-error", "没有写权限");
      }),
    };
    const result = await applyStandardRepair(bridge, "memory", report, { today: "2026-11-10" });
    expect(result.createdDirs).toEqual([]);
    expect(result.failures.length).toBe(report.missingDirs.length);
    expect(result.failures[0].message).toBe("没有写权限");
  });
});
