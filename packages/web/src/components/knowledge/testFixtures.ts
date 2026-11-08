import type { PageInfo, VaultIndex, WikiLink } from "../../lib/vault/types.js";

/**
 * 知识库界面测试夹具：构造 `VaultIndex` / `PageInfo` / `WikiLink`。
 *
 * 为什么单独一个文件：预览、反链、标签、搜索、图谱、知识库页六个测试文件都要
 * 「一篇笔记 + 一条反链」这种最小库；各写一份必然出现「这个用例的 backlinks 忘了建」
 * 之类的夹具漂移，不如一处生成、口径统一。
 */

const DEFAULT_MTIME = "2026-11-08T08:00:00.000Z";

/** 造一个页面信息；title 默认取文件名。 */
export function pageInfo(over: Partial<PageInfo> & { rel: string }): PageInfo {
  const { rel, ...rest } = over;
  const name = rel.split("/").pop() ?? rel;
  return {
    rel,
    title: rest.title ?? name.replace(/\.md$/i, ""),
    aliases: [],
    tags: [],
    headings: [],
    mtime: DEFAULT_MTIME,
    hash: "0123456789abcdef",
    frontmatter: {},
    body: "",
    ...rest,
  };
}

/** 造一条链接引用。 */
export function wikiLink(over: Partial<WikiLink> & { target: string; from: string }): WikiLink {
  const { target, from, ...rest } = over;
  return {
    target,
    alias: undefined,
    heading: undefined,
    embed: false,
    from,
    line: 1,
    resolved: null,
    ...rest,
  };
}

/** 由页面与链接拼一个完整索引（backlinks/tags/orphans/unresolved 自动派生）。 */
export function makeIndex(pages: PageInfo[], links: WikiLink[] = []): VaultIndex {
  const pageMap = new Map(pages.map((page) => [page.rel, page]));

  const backlinks = new Map<string, WikiLink[]>();
  for (const link of links) {
    if (!link.resolved) continue;
    const list = backlinks.get(link.resolved) ?? [];
    list.push(link);
    backlinks.set(link.resolved, list);
  }

  const tags = new Map<string, string[]>();
  for (const page of pages) {
    for (const tag of page.tags) {
      const list = tags.get(tag) ?? [];
      list.push(page.rel);
      tags.set(tag, list);
    }
  }

  const outlinksOf = new Map<string, number>();
  for (const link of links) {
    if (!link.resolved) continue;
    outlinksOf.set(link.from, (outlinksOf.get(link.from) ?? 0) + 1);
  }
  const orphans = pages
    .filter((page) => !backlinks.has(page.rel) && !outlinksOf.has(page.rel))
    .map((page) => page.rel);

  const ambiguous = new Map<string, string[]>();
  const byTitle = new Map<string, string[]>();
  for (const page of pages) {
    const list = byTitle.get(page.title) ?? [];
    list.push(page.rel);
    byTitle.set(page.title, list);
  }
  for (const [title, rels] of byTitle) if (rels.length > 1) ambiguous.set(title, rels);

  return {
    pages: pageMap,
    links,
    backlinks,
    unresolved: links.filter((link) => !link.resolved),
    tags,
    orphans,
    ambiguous,
  };
}

/** 一页含双链的笔记与它指向的目标页，供预览面板用例复用。 */
export function sampleIndex(): VaultIndex {
  const source = pageInfo({
    rel: "notes/source.md",
    tags: ["项目", "资料/前端"],
    headings: [
      { level: 1, text: "来源", line: 1 },
      { level: 2, text: "细节", line: 6 },
    ],
    frontmatter: { title: "来源页", author: "和鸣" },
    body: "看 [[target]] 与 [[target|别名]]。",
  });
  const target = pageInfo({ rel: "notes/target.md", title: "target", tags: ["项目"] });
  return makeIndex(
    [source, target],
    [
      wikiLink({ target: "target", from: "notes/source.md", line: 3, resolved: "notes/target.md" }),
      wikiLink({ target: "target", from: "notes/source.md", line: 3, resolved: "notes/target.md", alias: "别名" }),
    ],
  );
}
