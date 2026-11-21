import { describe, expect, it } from "vitest";
import { favoriteMarkdown, favoriteRel, safeFileName } from "./teamKnowledgeShare.js";
import type { TeamKnowledgeDoc } from "@heming/shared";

const DOC: TeamKnowledgeDoc = {
  id: "doc-1",
  teamId: "t1",
  authorId: "u1",
  title: "预算 / 结论",
  content: "# 预算\n\n正文。",
  sourceVault: null,
  tags: ["预算", "Q4"],
  pinned: false,
  createdAt: "2026-11-20T08:00:00.000Z",
  updatedAt: "2026-11-20T09:00:00.000Z",
};

describe("团队知识 → 个人库收藏（纯函数）", () => {
  it("文件名去掉 Windows 非法字符并补 .md", () => {
    expect(safeFileName("预算 / 结论")).toBe("预算 _ 结论.md");
    expect(safeFileName("a:b?c")).toBe("a_b_c.md");
    expect(safeFileName("already.md")).toBe("already.md");
  });

  it("收藏路径落在 _team/{团队}/{标题}.md，与个人笔记隔离", () => {
    expect(favoriteRel("产品组", "预算 / 结论")).toBe("_team/产品组/预算 _ 结论.md");
  });

  it("收藏正文带来源 frontmatter 与原文，供本机 vault_search 检索", () => {
    const md = favoriteMarkdown(DOC, "产品组");
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain('teamDocId: "doc-1"');
    expect(md).toContain('team: "产品组"');
    expect(md).toContain("预算");
    expect(md).toContain("# 预算\n\n正文。");
  });
});
