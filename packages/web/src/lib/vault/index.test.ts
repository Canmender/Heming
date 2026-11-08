import { describe, expect, it } from "vitest";
import {
  buildGraph,
  buildVaultIndex,
  buildVaultIndexFromPages,
  buildVaultToolBridge,
  contentHash,
  isMarkdownRel,
  isImageTarget,
  normalizeRel,
  parseDoc,
  parseSearchQuery,
  resolveVaultBridge,
  runSearch,
  tagRefsOf,
  titleOf,
  useVaultStore,
  type VaultDocInput,
} from "./index.js";

/**
 * vault 索引：页面信息、双链解析（最短唯一路径）、反链对称、标签索引、孤立页、hash。
 *
 * 夹具是一组构造的 markdown，刻意包含同名文件、别名、锚点、根绝对路径、嵌入，
 * 用来钉住规格 §3 的解析口径。
 */

function doc(rel: string, text: string, mtime = "2026-11-08T00:00:00.000Z"): VaultDocInput {
  return { rel, text, mtime };
}

const FIXTURE: VaultDocInput[] = [
  doc("index.md", "# 索引\n"),
  doc("log.md", "流水\n"),
  doc("a/note.md", "---\ntags: [项目]\n---\n# 笔记A\n[[b/target]]\n"),
  doc("b/note.md", "# 笔记B\n[[target]]\n"),
  doc("b/target.md", "---\naliases: [别名目标]\n---\n# 目标\n## 小节\n"),
  doc("root.md", "正文 #行内/标签\n[[/b/target]] [[别名目标]] [[note]]\n"),
  doc("solo.md", "# 孤立\n"),
];

describe("contentHash", () => {
  it("与标准 SHA-256 前 16 位一致", () => {
    expect(contentHash("abc")).toBe("ba7816bf8f01cfea");
    expect(contentHash("")).toBe("e3b0c44298fc1c14");
  });

  it("同内容同 hash、不同内容不同 hash（含 CJK 与多字节）", () => {
    expect(contentHash("预算风险")).toBe(contentHash("预算风险"));
    expect(contentHash("预算风险")).not.toBe(contentHash("预算与风险"));
    expect(contentHash("abc")).toHaveLength(16);
  });
});

describe("路径小工具", () => {
  it("normalizeRel 统一分隔符并去前导 ./ 与 /", () => {
    expect(normalizeRel("./a\\b//c.md")).toBe("a/b/c.md");
    expect(normalizeRel("/a/b.md")).toBe("a/b.md");
    expect(normalizeRel("a/b/")).toBe("a/b");
  });

  it("titleOf 去目录与 .md 后缀", () => {
    expect(titleOf("a/b/笔记.md")).toBe("笔记");
    expect(titleOf("笔记.md")).toBe("笔记");
  });

  it("isMarkdownRel 只认 .md", () => {
    expect(isMarkdownRel("a.md")).toBe(true);
    expect(isMarkdownRel("a.MD")).toBe(true);
    expect(isMarkdownRel("a.canvas")).toBe(false);
  });
});

describe("parseDoc", () => {
  it("页面信息：标题、别名、标签、标题行号、正文、hash", () => {
    const page = parseDoc(
      doc("a/note.md", "---\naliases: [A, B]\ntags: [项目]\n---\n# 笔记A\n正文 #行内\n"),
    );
    expect(page.rel).toBe("a/note.md");
    expect(page.title).toBe("note");
    expect(page.aliases).toEqual(["A", "B"]);
    expect(page.tags).toEqual(["项目", "行内"]);
    // frontmatter 占 4 行，标题在文件第 5 行
    expect(page.headings).toEqual([{ level: 1, text: "笔记A", line: 5 }]);
    expect(page.body).toBe("# 笔记A\n正文 #行内\n");
    expect(page.hash).toBe(contentHash("---\naliases: [A, B]\ntags: [项目]\n---\n# 笔记A\n正文 #行内\n"));
    expect(page.frontmatter.aliases).toEqual(["A", "B"]);
  });

  it("tagRefsOf：frontmatter 行号为 0、行内标签带文件行号", () => {
    const page = parseDoc(doc("x.md", "---\ntags: [甲]\n---\n正文 #乙\n"));
    const refs = tagRefsOf(page, 3);
    expect(refs).toEqual([
      { tag: "甲", from: "x.md", line: 0, source: "frontmatter" },
      { tag: "乙", from: "x.md", line: 4, source: "inline" },
    ]);
  });
});

describe("buildVaultIndex", () => {
  const index = buildVaultIndex(FIXTURE);

  it("pages 按 rel 字典序，重复 rel 只留一份", () => {
    expect([...index.pages.keys()]).toEqual([
      "a/note.md",
      "b/note.md",
      "b/target.md",
      "index.md",
      "log.md",
      "root.md",
      "solo.md",
    ]);
    const dup = buildVaultIndex([doc("a.md", "A"), doc("a.md", "B")]);
    expect(dup.pages.size).toBe(1);
    expect(dup.pages.get("a.md")?.body).toBe("A");
  });

  it("链接解析：文件名优先、别名、目录路径、根绝对路径", () => {
    const byFrom = index.links.filter((l) => l.from === "root.md");
    expect(byFrom.map((l) => [l.target, l.resolved])).toEqual([
      ["/b/target", "b/target.md"],
      ["note", "a/note.md"],
      ["别名目标", "b/target.md"],
    ]);
    // 行号是文件行（root.md 的链接都在第 2 行）
    expect(byFrom.map((l) => l.line)).toEqual([2, 2, 2]);
    expect(index.links.find((l) => l.from === "a/note.md")?.resolved).toBe("b/target.md");
    expect(index.links.find((l) => l.from === "b/note.md")?.resolved).toBe("b/target.md");
  });

  it("同名歧义：同目录优先解析，同时记进 ambiguous", () => {
    expect(index.ambiguous.get("note")).toEqual(["a/note.md", "b/note.md"]);
    const fromRoot = index.links.find((l) => l.from === "root.md" && l.target === "note");
    expect(fromRoot?.resolved).toBe("a/note.md");
    // a/note.md 自己也在 a/ 下，指向 note 时会选自己
    const selfDir = buildVaultIndex([
      doc("a/note.md", "[[note]]\n"),
      doc("b/note.md", "B\n"),
    ]);
    expect(selfDir.links[0].resolved).toBe("a/note.md");
  });

  it("锚点：标题不存在仍算文件已解析", () => {
    const idx = buildVaultIndex([
      doc("foo.md", "# 目标\n"),
      doc("from.md", "[[foo#不存在的标题]]\n[[foo#目标]]\n"),
    ]);
    expect(idx.links.map((l) => l.resolved)).toEqual(["foo.md", "foo.md"]);
    expect(idx.links[0].heading).toBe("不存在的标题");
    expect(idx.unresolved).toEqual([]);
  });

  it("未解析链接进 unresolved，代码块里的不算", () => {
    const idx = buildVaultIndex([
      doc("a.md", "[[不存在]]\n```\n[[也不存在]]\n```\n`[[行内]]`\n"),
    ]);
    expect(idx.unresolved.map((l) => l.target)).toEqual(["不存在"]);
    expect(idx.links).toHaveLength(1);
  });

  it("嵌入链接也参与解析", () => {
    const idx = buildVaultIndex([doc("a.md", "![[b.png]]\n![[b.md]]\n"), doc("b.md", "B\n")]);
    expect(idx.links[0].resolved).toBeNull();
    expect(idx.links[1].resolved).toBe("b.md");
    expect(idx.links[1].embed).toBe(true);
  });

  it("图片目标不进 unresolved（图片不是待建页面），真实缺页仍进", () => {
    // 图片附件不在索引输入（只有 md）里，所以一定 resolved=null；但界面不该提示
    // 「创建该页」——create 对图片扩展名会直接 forbidden-ext。因此这类目标从
    // unresolved 里排除，同时仍保留在 links 里供图谱/预览识别嵌入。
    const idx = buildVaultIndex([
      doc(
        "a.md",
        ["![[附件/图.png]]", "[[附件/图.JPG]]", "[[附件/图.svg|别名]]", "[[还没写的页面]]", "[[图.png 说明]]"].join("\n"),
      ),
    ]);
    expect(idx.links.map((link) => link.target)).toEqual([
      "附件/图.png",
      "附件/图.JPG",
      "附件/图.svg",
      "还没写的页面",
      "图.png 说明",
    ]);
    expect(idx.unresolved.map((link) => link.target)).toEqual(["还没写的页面", "图.png 说明"]);
    expect(isImageTarget("a.PNG")).toBe(true);
    expect(isImageTarget("目录/图.jpeg")).toBe(true);
    expect(isImageTarget(".gif")).toBe(true);
    expect(isImageTarget("a.png.md")).toBe(false);
    expect(isImageTarget("图片")).toBe(false);
    expect(isImageTarget("")).toBe(false);
  });

  it("反链对称：每条已解析链接都能在目标的反链里找到", () => {
    for (const link of index.links) {
      if (link.resolved === null) continue;
      const back = index.backlinks.get(link.resolved) ?? [];
      expect(back).toContainEqual(link);
    }
    const targetBacklinks = index.backlinks.get("b/target.md") ?? [];
    // root.md 用了两条不同写法（根绝对路径与别名）指向同一目标，两条都算反链
    expect(targetBacklinks.map((l) => l.from)).toEqual([
      "a/note.md",
      "b/note.md",
      "root.md",
      "root.md",
    ]);
  });

  it("标签索引：frontmatter 与行内合并，键为小写", () => {
    expect(index.tags.get("项目")).toEqual(["a/note.md"]);
    expect(index.tags.get("行内/标签")).toEqual(["root.md"]);
    expect(index.pages.get("a/note.md")?.tags).toEqual(["项目"]);
    expect(index.pages.get("root.md")?.tags).toEqual(["行内/标签"]);
  });

  it("孤立页排除根目录 index/log/schema，有入链的不算", () => {
    expect(index.orphans).toEqual(["b/note.md", "root.md", "solo.md"]);
  });

  it("确定性：输入顺序打乱结果不变", () => {
    const reversed = buildVaultIndex([...FIXTURE].reverse());
    expect([...reversed.pages.keys()]).toEqual([...index.pages.keys()]);
    expect(reversed.links).toEqual(index.links);
    expect(reversed.orphans).toEqual(index.orphans);
    expect(reversed.unresolved).toEqual(index.unresolved);
    expect([...reversed.ambiguous.entries()]).toEqual([...index.ambiguous.entries()]);
    expect([...reversed.tags.entries()]).toEqual([...index.tags.entries()]);
    for (const [rel, page] of reversed.pages) {
      expect(page.hash).toBe(index.pages.get(rel)?.hash);
    }
  });

  it("buildVaultIndexFromPages 支持外部构造的 PageInfo（行号按 body 计）", () => {
    const page = parseDoc(doc("a.md", "[[b]]\n"));
    const idx = buildVaultIndexFromPages([page, parseDoc(doc("b.md", "B\n"))]);
    expect(idx.links[0].line).toBe(1);
    expect(idx.links[0].resolved).toBe("b.md");
  });

  it("5000 篇文档一次构建能跑完（纯函数，无 IO）", () => {
    const docs: VaultDocInput[] = [];
    for (let i = 0; i < 5000; i += 1) {
      docs.push(doc(`bulk/n${i}.md`, `# 第 ${i} 篇\n[[bulk/n${(i + 1) % 5000}]]\n`));
    }
    const big = buildVaultIndex(docs);
    expect(big.pages.size).toBe(5000);
    expect(big.links).toHaveLength(5000);
    expect(big.unresolved).toEqual([]);
    expect(big.ambiguous.size).toBe(0);
  });

  it("桶文件导出界面与记忆层需要的公共 API", () => {
    expect(typeof resolveVaultBridge).toBe("function");
    expect(typeof parseSearchQuery).toBe("function");
    expect(typeof runSearch).toBe("function");
    expect(typeof buildGraph).toBe("function");
    expect(typeof buildVaultToolBridge).toBe("function");
    expect(typeof useVaultStore.getState).toBe("function");
    expect(typeof useVaultStore.getState().buildIndexNow).toBe("function");
  });
});

describe("锚点状态（anchor）", () => {
  const docs = [
    doc("目标.md", "# 第一节\n\n正文\n\n## 预算 与 风险\n"),
    doc("来源.md", "[[目标]]\n[[目标#第一节]]\n[[目标# 预算 与 风险 ]]\n[[目标#不存在]]\n"),
  ];

  it("无锚点 none；命中 hit；未命中 miss（仍 resolved、仍进 backlinks）", () => {
    const index = buildVaultIndex(docs);
    const links = index.links.filter((link) => link.from === "来源.md");
    expect(links.map((link) => link.anchor)).toEqual(["none", "hit", "hit", "miss"]);
    expect(links.map((link) => link.resolved)).toEqual([
      "目标.md",
      "目标.md",
      "目标.md",
      "目标.md",
    ]);
    // 锚点未命中不是断链：照样进反链
    expect(index.backlinks.get("目标.md")).toHaveLength(4);
    expect(index.unresolved).toEqual([]);
  });

  it("标题比较大小写不敏感、去首尾空格", () => {
    const index = buildVaultIndex([
      doc("目标.md", "# Budget Risk\n"),
      doc("来源.md", "[[目标#budget risk]]\n[[目标#  Budget Risk  ]]\n"),
    ]);
    expect(index.links.map((link) => link.anchor)).toEqual(["hit", "hit"]);
  });

  it("`#` 只切一次：二级 `#` 按完整串或首段匹配", () => {
    const index = buildVaultIndex([
      doc("目标.md", "# 标题#小节\n"),
      doc("来源.md", "[[目标#标题#小节]]\n"),
    ]);
    expect(index.links[0].heading).toBe("标题#小节");
    expect(index.links[0].anchor).toBe("hit");

    // 目标页只有「标题」时，`标题#小节` 也按首段命中（不因多一个 # 变 miss）
    const partial = buildVaultIndex([
      doc("目标.md", "# 标题\n"),
      doc("来源.md", "[[目标#标题#小节]]\n"),
    ]);
    expect(partial.links[0].anchor).toBe("hit");
  });

  it("文件未解析时 anchor 一律 none（不是 miss）", () => {
    const index = buildVaultIndex([doc("来源.md", "[[没有这页#标题]]\n")]);
    expect(index.links[0].resolved).toBeNull();
    expect(index.links[0].anchor).toBe("none");
  });

  it("空标题（[[页#]]）按无锚点处理", () => {
    const index = buildVaultIndex([doc("目标.md", "# 甲\n"), doc("来源.md", "[[目标#]]\n")]);
    expect(index.links[0].anchor).toBe("none");
    expect(index.links[0].resolved).toBe("目标.md");
  });
});
