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
  /**
   * 来源四分：内置（种子）、已装（导入）、沉淀（从已装/自定义复制并冻结的稳定版）、自定义（本地新建）。
   * 与技能区的分组一一对应，见 SkillsPage.categorizeSkill。
   */
  source: "builtin" | "user" | "imported" | "distilled";
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
/**
 * 智能体 → 已分配技能 id 列表（`heming.skillAssignments.v1`）。
 *
 * 与 `SkillBinding` 的区别：binding 管「路由行为」（置顶/禁用），assigned 管
 * 「这个智能体拥有哪些技能」——技能页只展示已分配的，技能池才是全量。
 * 没有记录时默认分配全部内置技能（开箱即用），其余技能需要显式添加。
 */
export const SKILL_ASSIGNMENTS_KEY = "heming.skillAssignments.v1";

/** 单键 JSON 超限即触发最久未使用淘汰（设计 §8：1.2MB）。 */
export const MAX_POOL_CHARS = 1_200_000;

/** 路由默认：top 3、总注入 ≤ 1600 字符（设计 §5.1）。 */
export const DEFAULT_ROUTE_TOP_K = 3;
export const DEFAULT_ROUTE_BUDGET = 1600;

export type { StorageLike };
