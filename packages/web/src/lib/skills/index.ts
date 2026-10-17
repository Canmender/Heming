export * from "./types.js";
export { BUILTIN_SKILLS, buildBuiltinSkills } from "./builtins.js";
export type { SkillSeed } from "./builtins.js";
export { SkillPool } from "./store.js";
export { formatSkillSection, routeSkills, tokenize } from "./router.js";
export type { RouteContext, RouteInput } from "./router.js";
export { parseImportText, parseSkillJson, parseSkillMarkdown, skillToMarkdown } from "./markdown.js";
export type { ParsedSkill } from "./markdown.js";

import { SkillPool } from "./store.js";

/**
 * 模块级单例：技能池只本机存储（键 `heming.skills.v1` / `heming.skillBindings.v1`），
 * 供 ChatPage 等调用方共用同一份内存态（构造即完成首启种子）。
 */
export const skillPool = new SkillPool();
