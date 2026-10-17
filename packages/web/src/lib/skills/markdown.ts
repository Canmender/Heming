import type { SkillDefinition } from "./types.js";

/**
 * SKILL.md / JSON 的解析与生成（设计 §5.3）：内置极简 frontmatter 解析，
 * 不引入 YAML 依赖；解析失败一律抛中文 Error，绝不静默吞。
 */

/** 解析结果：只带「已声明」的字段，undefined 表示导入时不动该字段。 */
export interface ParsedSkill {
  name: string;
  instructions: string;
  description?: string;
  version?: string;
  triggers?: string[];
  tags?: string[];
  id?: string;
  enabled?: boolean;
  builtin?: boolean;
  source?: SkillDefinition["source"];
  createdAt?: string;
  updatedAt?: string;
}

const FRONTMATTER_OPEN = /^---[ \t]*\n/;
const FRONTMATTER_BLOCK = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

/** 数组值：`[a, b]` 或逗号串（兼容中文逗号与顿号）；空值 → []。 */
function parseList(raw: string): string[] {
  let body = raw.trim();
  if (body.startsWith("[") && body.endsWith("]")) body = body.slice(1, -1);
  return body
    .split(/[,，、]/)
    .map((item) => unquote(item.trim()))
    .filter((item) => item.length > 0);
}

function unquote(raw: string): string {
  const text = raw.trim();
  if (text.length >= 2 && (text.startsWith('"') || text.startsWith("'")) && text.endsWith(text[0])) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/** 解析 SKILL.md：`---` frontmatter（name/description/version/triggers/tags）+ 正文。 */
export function parseSkillMarkdown(text: string): ParsedSkill {
  const src = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").trim();
  if (!src) throw new Error("内容为空，无法解析 SKILL.md");
  if (!FRONTMATTER_OPEN.test(src)) {
    throw new Error("SKILL.md 缺少 frontmatter：需以 --- 开头");
  }
  const block = FRONTMATTER_BLOCK.exec(src);
  if (!block) throw new Error("SKILL.md 的 frontmatter 未闭合：缺少结束的 ---");

  const fields = new Map<string, string>();
  for (const line of block[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf(":");
    if (at <= 0) continue;
    fields.set(trimmed.slice(0, at).trim().toLowerCase(), trimmed.slice(at + 1).trim());
  }

  const name = unquote(fields.get("name") ?? "");
  if (!name) throw new Error("SKILL.md 的 frontmatter 缺少 name");

  const parsed: ParsedSkill = {
    name,
    instructions: src.slice(block[0].length).trim(),
  };
  const description = fields.get("description");
  if (description !== undefined) parsed.description = unquote(description);
  const version = fields.get("version");
  if (version !== undefined) parsed.version = unquote(version);
  if (fields.has("triggers")) parsed.triggers = parseList(fields.get("triggers") as string);
  if (fields.has("tags")) parsed.tags = parseList(fields.get("tags") as string);
  return parsed;
}

/** 生成 SKILL.md：frontmatter 固定 5 键，正文即 instructions（与设计 §5.3 一致）。 */
export function skillToMarkdown(skill: SkillDefinition): string {
  const list = (items: string[]): string => `[${items.filter(Boolean).join(", ")}]`;
  const frontmatter = [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    `version: ${skill.version}`,
    `triggers: ${list(skill.triggers)}`,
    `tags: ${list(skill.tags)}`,
    "---",
  ].join("\n");
  return `${frontmatter}\n\n${skill.instructions.trim()}\n`;
}

const SOURCES: readonly SkillDefinition["source"][] = ["builtin", "user", "imported"];

function toStringList(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
  if (typeof raw === "string") return parseList(raw);
  return undefined;
}

/** JSON 单条 → ParsedSkill；结构不符抛中文错误。 */
function parseJsonSkill(raw: unknown, index: number): ParsedSkill {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`第 ${index + 1} 个技能不是对象`);
  }
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) throw new Error(`第 ${index + 1} 个技能缺少 name`);
  const skill: ParsedSkill = {
    name,
    instructions: typeof r.instructions === "string" ? r.instructions : "",
  };
  if (typeof r.id === "string" && r.id.trim()) skill.id = r.id.trim();
  if (typeof r.description === "string") skill.description = r.description;
  if (typeof r.version === "string") skill.version = r.version;
  const triggers = toStringList(r.triggers);
  if (triggers) skill.triggers = triggers;
  const tags = toStringList(r.tags);
  if (tags) skill.tags = tags;
  if (typeof r.enabled === "boolean") skill.enabled = r.enabled;
  if (typeof r.builtin === "boolean") skill.builtin = r.builtin;
  if (typeof r.source === "string" && (SOURCES as readonly string[]).includes(r.source)) {
    skill.source = r.source as SkillDefinition["source"];
  }
  if (typeof r.createdAt === "string") skill.createdAt = r.createdAt;
  if (typeof r.updatedAt === "string") skill.updatedAt = r.updatedAt;
  return skill;
}

/** 解析 JSON：单技能对象、技能数组、整池 `{ version: 1, skills: [...] }` 均支持。 */
export function parseSkillJson(text: string): ParsedSkill[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON 解析失败：${(err as Error).message}`);
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) return [];
    return raw.map((item, i) => parseJsonSkill(item, i));
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.skills)) {
      return (obj.skills as unknown[]).map((item, i) => parseJsonSkill(item, i));
    }
    if (typeof obj.name === "string") return [parseJsonSkill(obj, 0)];
  }
  throw new Error("JSON 结构无法识别：需要单技能对象、技能数组或 { version: 1, skills: [...] }");
}

/** 自动识别：SKILL.md / 单技能 JSON / 整池 JSON。 */
export function parseImportText(text: string): ParsedSkill[] {
  const src = text.replace(/^﻿/, "").trim();
  if (!src) throw new Error("内容为空，无法导入");
  if (src.startsWith("{") || src.startsWith("[")) return parseSkillJson(src);
  if (src.startsWith("---")) return [parseSkillMarkdown(src)];
  throw new Error("无法识别的导入内容：需为 SKILL.md（以 --- 开头）或 JSON");
}
