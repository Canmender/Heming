/**
 * 项目约定文件（AGENTS.md 一族）的读取与注入（d.174）。
 *
 * ## 为什么要有这个
 *
 * 到 d.173，智能体已经知道自己在桌面端、工作区在哪、这轮给了哪些工具。但它**不知道
 * 这个仓库自己的规矩**：命令用 pnpm 还是 npm、改完要不要跑哪套测试、注释里能不能写
 * 「为什么」、有没有生成文件不许手改。opencode / Claude Code / DSH 都会在工作区里读
 * 一份约定文件（AGENTS.md / CLAUDE.md），这是「像团队里的人」和「像通用聊天机器人」的
 * 分界线之一。
 *
 * ## 口径（刻意保守）
 *
 * - **只认几个固定文件名**，不扫全仓、不按 glob 找：约定文件必须是显式的、有主的，
 *   否则用户根本不知道模型读了什么。
 * - **只读工作区根目录（及其下的 `.heming/`）**：不往上层目录找——上层属于别人的工作区，
 *   读它等于把别的项目的规矩套到这一轮上。
 * - **总量封顶**：约定文件是给人看的，可能几千行；全塞进系统提示词会挤掉记忆与历史。
 *   单文件封顶 + 总量封顶，截断处明写「只读了前 N 字，需要更多用 file_read」。
 * - **失败静默**：读不到（不存在/无权限/不是文本/桥不存在）就是「这一轮没有约定」，
 *   绝不阻断生成，也不在提示词里留半句残话。
 */

import type { FileFsBridge } from "../fileEdit/bridge.js";
import { compareKey, isInsideRoot, relFromRoot, resolveInsideRoot, toPosixPath } from "../fileEdit/paths.js";
import type { FileRoot } from "../fileEdit/paths.js";

/** 认得的约定文件（相对工作区根，按优先级排；先读到的先出现）。 */
export const PROJECT_RULE_FILES = ["AGENTS.md", "HEMING.md", ".heming/AGENTS.md", ".heming/rules.md"] as const;

/** 最多读几个文件（后面的文件只在前面不存在时才有机会）。 */
export const MAX_PROJECT_RULE_FILES = 2;

/** 单个文件的字数上限（超出截断并写清怎么继续读）。 */
export const MAX_PROJECT_RULE_CHARS = 4000;

/** 所有约定文件加起来的字数上限。 */
export const MAX_PROJECT_RULES_TOTAL_CHARS = 6000;

/** 段落标题：与记忆段/技能段的 `##` 同级，便于模型区分来源。 */
export const PROJECT_RULES_HEADING = "## 项目约定（本工作区）";

/** 一段约定文件的读取结果。 */
export interface ProjectRuleFile {
  /** 相对工作区的路径（正斜杠），例如 `AGENTS.md`、`.heming/rules.md`。 */
  rel: string;
  /** 已归一化（去 BOM、CRLF→LF、去首尾空白）的正文。 */
  text: string;
  /** 原文超过 `MAX_PROJECT_RULE_CHARS`，只保留开头。 */
  truncated: boolean;
}

export interface CollectedProjectRules {
  files: ProjectRuleFile[];
  /** 拼好的注入段；没有任何文件时为空串（调用方据此保持「零注入等于原文」）。 */
  section: string;
  /** 被总量上限截掉的文件名（只在提示词里作为一行「还有 N 个没展开」出现）。 */
  omitted: string[];
}

const EMPTY: CollectedProjectRules = { files: [], section: "", omitted: [] };

/**
 * 找到「包含工作区」的那条根，并算出工作区相对它的前缀。
 *
 * 为什么不用工作区直接当根：根是用户授权过的目录（可读/可写），工作区只是会话分组；
 * 两者常常一致，但工作区可能是根下面的一层（例如根 = `D:/项目`、工作区 = `D:/项目/和鸣`）。
 * 这时相对根的路径才是 `file_read` 认得的形状。
 */
function locateWorkspace(roots: readonly FileRoot[], workspace: string): { root: FileRoot; prefix: string } | null {
  const ws = toPosixPath(workspace).replace(/\/+$/, "");
  if (!ws) return null;
  for (const root of roots) {
    const rootAbs = toPosixPath(root.path).replace(/\/+$/, "");
    if (!rootAbs) continue;
    // 工作区常常**就是**根目录本身；`isInsideRoot` 不含根本身，这里要单独认一次，
    // 否则最常见的用法（工作区 = 授权目录）反而读不到约定。
    if (compareKey(rootAbs) === compareKey(ws)) return { root, prefix: "" };
    if (isInsideRoot(rootAbs, ws)) {
      const rel = relFromRoot(rootAbs, ws);
      if (rel !== null) return { root, prefix: rel };
    }
  }
  return null;
}

/** 去 BOM、统一换行、去掉首尾空白。 */
export function normalizeRuleText(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r\n?/g, "\n").trim();
}

/**
 * 读工作区里的约定文件并拼成注入段。
 *
 * 顺序：按 `PROJECT_RULE_FILES` 的声明顺序找，最多读 `MAX_PROJECT_RULE_FILES` 个；
 * 单文件超过 `MAX_PROJECT_RULE_CHARS` 只留开头，累计超过 `MAX_PROJECT_RULES_TOTAL_CHARS`
 * 的后续文件不进正文，只在段尾列一行「还有哪些文件没展开」——**不静默丢**。
 */
export async function collectProjectRules(input: {
  bridge: FileFsBridge | null;
  roots: readonly FileRoot[];
  workspace?: string | null;
}): Promise<CollectedProjectRules> {
  const { bridge } = input;
  const workspace = (input.workspace ?? "").trim();
  if (!bridge || !workspace || input.roots.length === 0) return EMPTY;

  const located = locateWorkspace(input.roots, workspace);
  if (!located) return EMPTY;

  const files: ProjectRuleFile[] = [];
  const omitted: string[] = [];
  let used = 0;

  for (const name of PROJECT_RULE_FILES) {
    if (files.length >= MAX_PROJECT_RULE_FILES) {
      // 已经读够上限：剩下的文件名如果真实存在也只在段尾提示，不再读盘。
      omitted.push(name);
      continue;
    }
    const rel = located.prefix ? `${located.prefix}/${name}` : name;
    const abs = resolveInsideRoot(located.root.path, rel);
    if (!abs) continue; // 路径不合法（不该发生）：当它不存在

    let raw: string | null = null;
    try {
      const res = await bridge.read({ roots: [...input.roots], path: abs });
      if (res.ok && typeof res.content === "string") raw = res.content;
    } catch {
      raw = null; // 桥抛错 = 这一轮读不到，不阻断生成
    }
    if (raw === null) continue; // 不存在/二进制/太大：当它没有，不写进提示词

    const text = normalizeRuleText(raw);
    if (!text) continue; // 空文件没有信息量，不占预算

    const truncated = text.length > MAX_PROJECT_RULE_CHARS;
    const clipped = truncated ? text.slice(0, MAX_PROJECT_RULE_CHARS).trimEnd() : text;
    if (used + clipped.length > MAX_PROJECT_RULES_TOTAL_CHARS) {
      omitted.push(name); // 总量不够了：不进正文，但要在段尾说出来
      continue;
    }
    used += clipped.length;
    files.push({ rel: name, text: clipped, truncated });
  }

  if (files.length === 0) return { files: [], section: "", omitted };

  const lines: string[] = [
    PROJECT_RULES_HEADING,
    "",
    "以下内容来自本工作区里的约定文件，是这个仓库自己的规矩。动手前先照着做；",
    "与用户这一轮明确说出的要求冲突时，以用户的要求为准，并在回答里点出这处冲突。",
  ];
  for (const file of files) {
    lines.push("", `### ${file.rel}`, "");
    lines.push(file.text);
    if (file.truncated) {
      lines.push("", `（这个文件太长，只读了前 ${MAX_PROJECT_RULE_CHARS} 字；需要后面的内容请用 \`file_read\` 读 \`${file.rel}\`。）`);
    }
  }
  if (omitted.length > 0) {
    lines.push(
      "",
      `（工作区里还有这些约定文件没展开：${omitted.map((n) => `\`${n}\``).join("、")}——需要时用 \`file_read\` 读。）`,
    );
  }

  return { files, section: lines.join("\n"), omitted };
}
