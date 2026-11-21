import { describe, it, expect } from "vitest";
import { resolveWikiTarget } from "./wikilinks.js";
import type { PageInfo, VaultIndex } from "../../lib/vault/types.js";

/** 双链解析：title 是第一选择键，别名只是第二选择键。 */

function page(rel: string, title: string, aliases: string[] = []): PageInfo {
  return {
    rel,
    title,
    aliases,
    tags: [],
    headings: [],
    mtime: "2026-11-21T00:00:00.000Z",
    hash: "0",
    frontmatter: {},
    body: "",
  };
}

function index(pages: PageInfo[]): VaultIndex {
  return {
    pages: new Map(pages.map((p) => [p.rel, p])),
    links: [],
    backlinks: new Map(),
    unresolved: [],
    tags: new Map(),
  } as unknown as VaultIndex;
}

describe("resolveWikiTarget", () => {
  it("精确 title 命中优先于近处的别名命中（d.412 回归）", () => {
    const idx = index([
      page("archive/foo.md", "foo"),
      page("current/bar.md", "bar", ["foo"]),
    ]);
    const got = resolveWikiTarget(idx, "current/now.md", "foo");
    expect(got).toEqual({ rel: "archive/foo.md", ambiguous: false });
  });

  it("title 没有命中时才用别名", () => {
    const idx = index([
      page("current/bar.md", "bar", ["foo"]),
    ]);
    const got = resolveWikiTarget(idx, "current/now.md", "foo");
    expect(got).toEqual({ rel: "current/bar.md", ambiguous: false });
  });

  it("多个同名 title 仍按最近择一并标 ambiguous", () => {
    const idx = index([
      page("archive/foo.md", "foo"),
      page("current/foo.md", "foo"),
    ]);
    const got = resolveWikiTarget(idx, "current/now.md", "foo");
    expect(got.rel).toBe("current/foo.md");
    expect(got.ambiguous).toBe(true);
  });
});
