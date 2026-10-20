#!/usr/bin/env node
/**
 * CHANGELOG.md → 结构化条目（纯函数，无依赖）。
 *
 * 识别的版式：
 *   ## d.3.0.3.0（2026-10-19）— 安装包输出迁到 D 盘
 *   正文：段落 + `- 要点` 列表（支持 `**粗体**` 与 `` `代码` `` 行内标记）
 *
 * 刻意只解析这一种版式：够用、可测、渲染端不需要 markdown 依赖。
 * 遇到不认识的行就当普通段落文本，不丢内容也不猜结构。
 */

/**
 * @typedef {object} ChangelogEntry
 * @property {string} version 5 段版本号
 * @property {string} date    YYYY-MM-DD
 * @property {string} title   一句话标题
 * @property {string[]} bullets 要点（去掉列表符号，保留行内标记原文）
 * @property {string[]} paragraphs 要点之外的说明段落
 */

const HEADING = /^##\s+(\S+?)（(\d{4}-\d{2}-\d{2})）\s*(?:—\s*(.*))?$/;

/**
 * 解析整份 CHANGELOG。版本降序由调用方保证（生成脚本不排序，原文顺序即新→旧）。
 * @param {string} markdown
 * @returns {ChangelogEntry[]}
 */
export function parseChangelog(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  /** @type {ChangelogEntry[]} */
  const entries = [];
  let current = null;
  let inCode = false;

  const flush = () => {
    if (current) entries.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    // 代码块内的内容不当结构处理
    if (line.trim().startsWith("```")) {
      inCode = !inCode;
      if (current) current.paragraphs.push(line);
      continue;
    }
    if (inCode) {
      if (current) current.paragraphs.push(line);
      continue;
    }

    const heading = HEADING.exec(line.trim());
    if (heading) {
      flush();
      current = {
        version: heading[1],
        date: heading[2],
        title: (heading[3] ?? "").trim(),
        bullets: [],
        paragraphs: [],
      };
      continue;
    }

    if (!current) continue; // 文件头（# 标题、说明段）不进条目

    // 先判缩进二级要点：否则 `\s*` 会把缩进行也吃掉，层级就丢了
    const sub = /^\s{2,}[-*]\s+(.*)$/.exec(line);
    if (sub) {
      const text = sub[1].trim();
      if (text) current.bullets.push(`— ${text}`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      const text = bullet[1].trim();
      if (text) current.bullets.push(text);
      continue;
    }

    const text = line.trim();
    if (text) current.paragraphs.push(text);
  }
  flush();

  return entries.filter((e) => e.version && e.bullets.length + e.paragraphs.length > 0);
}

/**
 * 生成 TS 模块文本（写进 src/generated/changelog.ts 供界面直接 import）。
 * 纯字符串拼装，产物可 review、可 diff。
 */
export function renderChangelogModule(entries) {
  const json = JSON.stringify(entries, null, 2);
  return `// 本文件由 \`node scripts/build-changelog.mjs\` 从 CHANGELOG.md 生成，请勿手改。
// 改了 CHANGELOG.md 就重跑该脚本（发版流程里已有这一步）。

export interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  bullets: string[];
  paragraphs: string[];
}

/** 更新日志条目，按 CHANGELOG.md 原文顺序（新 → 旧）。 */
export const CHANGELOG: ChangelogEntry[] = ${json};
`;
}