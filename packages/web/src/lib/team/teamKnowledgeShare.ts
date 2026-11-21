/**
 * 团队知识库 ↔ 个人库的显式双向动作（纯函数部分）。
 *
 * 隐私口径：智能体不作为团队成员、无服务端身份。团队资料要进本机智能体检索，
 * 必须经"人取回 → 收藏到个人库（落本地 Markdown）→ 本机 vault_search"的路径，
 * 不自动同步、不给智能体直连团队库。
 */

import type { TeamKnowledgeDoc } from "@heming/shared";

/** Windows/常见文件系统非法文件名字符 → 下划线，限长，避免收藏路径写不进去。 */
export function safeFileName(input: string): string {
  const cleaned = input.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
  const base = cleaned.slice(0, 80) || "未命名";
  return base.endsWith(".md") ? base : `${base}.md`;
}

/** 收藏到个人库的相对路径：_team/{团队名}/{标题}.md，与个人笔记隔离。 */
export function favoriteRel(teamName: string, title: string): string {
  return `_team/${safeFileName(teamName).replace(/\.md$/, "")}/${safeFileName(title)}`;
}

/**
 * 收藏时写入本地 Markdown 的正文：带 frontmatter 记录来源（teamDocId/teamId），
 * 便于本机智能体检索到人取回的副本，同时标明这是"人工审核过的团队快照"。
 */
export function favoriteMarkdown(doc: TeamKnowledgeDoc, teamName: string): string {
  const tags = doc.tags.length > 0 ? doc.tags.map((t) => JSON.stringify(t)).join(", ") : "[]";
  const fm = [
    "---",
    `title: ${JSON.stringify(doc.title)}`,
    `source: team`,
    `team: ${JSON.stringify(teamName)}`,
    `teamDocId: ${JSON.stringify(doc.id)}`,
    `teamId: ${JSON.stringify(doc.teamId)}`,
    `authorId: ${JSON.stringify(doc.authorId)}`,
    `tags: [${tags}]`,
    `syncedAt: ${JSON.stringify(doc.updatedAt)}`,
    "---",
    "",
  ].join("\n");
  return `${fm}${doc.content}\n`;
}
