import type { StorageLike } from "../memory/types.js";

/**
 * 技能池类型与常量（设计 §5、§8）。
 * 存储适配器复用 lib/memory 的 StorageLike（默认 localStorage），本文件不重复定义。
 */

/** 技能定义：本地可复用的能力包，格式兼容 SKILL.md（frontmatter + 正文）。 */
export interface SkillDefinition {
  id: string;
  name: string; // ≤ 32
  description: string; // 路由依据，≤ 200
  instructions: string; // 注入正文，≤ 8000
  triggers: string[]; // 显式触发词
  tags: string[];
  enabled: boolean;
  builtin: boolean;
  version: string; // 默认 1.0.0
  source: "builtin" | "user" | "imported";
  createdAt: string;
  updatedAt: string;
}

/** 智能体级绑定：pinned 每次必带，disabled 本智能体禁用。 */
export interface SkillBinding {
  agentId: string;
  pinned: string[];
  disabled: string[];
}

/** 路由结果：命中技能 + 分数 + 注入理由（命中词 / 用户置顶）。 */
export interface SkillMatch {
  skill: SkillDefinition;
  score: number;
  reason: string;
}

/** 技能使用计数（usage 微增益与 LRU 淘汰共用）。 */
export interface SkillUsage {
  count: number;
  at: string; // 最近一次使用时间（ISO）
}

/** 存储键（带版本，见设计 §8）。 */
export const SKILLS_KEY = "heming.skills.v1";
export const SKILL_BINDINGS_KEY = "heming.skillBindings.v1";

/** 单键 JSON 超限即触发最久未使用淘汰（设计 §8：1.2MB）。 */
export const MAX_POOL_CHARS = 1_200_000;

/** 路由默认：top 3、总注入 ≤ 1600 字符（设计 §5.1）。 */
export const DEFAULT_ROUTE_TOP_K = 3;
export const DEFAULT_ROUTE_BUDGET = 1600;

export type { StorageLike };
