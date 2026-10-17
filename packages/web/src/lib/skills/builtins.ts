import type { SkillDefinition } from "./types.js";

/**
 * 内置技能（设计 §5.2）：首启种子 4 条，覆盖四类高频场景。
 * 全部可编辑/禁用/删除；删除后不复活（由 store 的 seeded 标记保证）。
 */

export type SkillSeed = Omit<SkillDefinition, "createdAt" | "updatedAt">;

export const BUILTIN_SKILLS: readonly SkillSeed[] = [
  {
    id: "builtin-memory-curator",
    name: "记忆整理",
    description: "把长对话压缩为可复用的记忆条目，提炼偏好、事实与待办",
    instructions: [
      "你在整理这段对话的长期记忆。",
      "1. 提取用户明确表达的偏好、事实与约束，写成「键：值」，键用 4-8 字的归一化主题（如「称呼」「偏好-语言」）。",
      "2. 提取结论与决定，注明依据；未经确认的推测不要写入。",
      "3. 待办写成「谁：做什么：截止时间」，缺失项分别写「待指派」「时间待定」。",
      "4. 与已有记忆冲突时以用户最新表述为准，并指出被替换的旧内容。",
      "5. 只输出条目，不复述原文，不加开场白与解释。",
    ].join("\n"),
    triggers: ["记忆", "整理", "记住", "归纳", "备忘"],
    tags: ["记忆", "整理"],
    enabled: true,
    builtin: true,
    version: "1.0.0",
    source: "builtin",
  },
  {
    id: "builtin-writing",
    name: "写作润色",
    description: "在不改变事实与立场的前提下改写文稿，让表达更清楚、节奏更稳",
    instructions: [
      "你在为用户润色文字。",
      "1. 保留原意、事实、数字与人称，不增删观点。",
      "2. 先给润色后的全文，再用 3 条以内的说明写清改了什么、为什么。",
      "3. 去掉冗词与堆砌的形容词；长句拆短，句子长短交替。",
      "4. 统一术语与标点；中文用全角标点，数字与英文单词保持半角。",
      "5. 用户未指定风格时，默认简体中文、平实书面语。",
    ].join("\n"),
    triggers: ["润色", "改写", "写作", "文案", "polish", "rewrite"],
    tags: ["写作", "文本"],
    enabled: true,
    builtin: true,
    version: "1.0.0",
    source: "builtin",
  },
  {
    id: "builtin-code-review",
    name: "代码审查",
    description: "对代码变更做缺陷、安全与可维护性审查，按严重程度给出可执行建议",
    instructions: [
      "你在审查一段代码变更。",
      "1. 先读变更意图，再逐处检查：逻辑与边界、并发与竞态、错误处理、空值与类型、资源释放、安全（注入/越权/密钥泄漏）。",
      "2. 每条问题给出位置、现象、触发条件与修复建议；能给出最小补丁就给补丁。",
      "3. 按「阻断 / 重要 / 建议」三档排序，只列真实问题，不确定的标注「待确认」。",
      "4. 指出缺失的测试用例与回归风险点。",
      "5. 结尾用一句话给出结论：可直接合并 / 修改后合并 / 需返工。",
    ].join("\n"),
    triggers: ["审查", "代码审查", "review", "缺陷", "重构", "安全"],
    tags: ["代码", "工程"],
    enabled: true,
    builtin: true,
    version: "1.0.0",
    source: "builtin",
  },
  {
    id: "builtin-meeting-notes",
    name: "会议纪要",
    description: "把会议记录整理成结论、待办与风险，输出可直接分发的纪要",
    instructions: [
      "你在整理会议纪要。",
      "1. 结构固定为：会议主题 / 参会人 / 结论与决定 / 待办（负责人 + 截止时间）/ 争议与风险 / 下次议题。",
      "2. 只记录有结论的内容；讨论过程压成一句背景，不逐条复述发言。",
      "3. 待办必须落到人：无负责人的写「待指派」，无时间的写「时间待定」。",
      "4. 数字、日期与专有名词保持原样，不确定处标「待确认」。",
      "5. 全文控制在 400 字内，纯文本、不用 emoji。",
    ].join("\n"),
    triggers: ["会议", "纪要", "记录", "待办", "周会", "meeting"],
    tags: ["会议", "协作"],
    enabled: true,
    builtin: true,
    version: "1.0.0",
    source: "builtin",
  },
];

/** 实例化内置技能：统一盖上时间戳（同批种子时间一致）。 */
export function buildBuiltinSkills(at: string): SkillDefinition[] {
  return BUILTIN_SKILLS.map((seed) => ({
    ...seed,
    triggers: [...seed.triggers],
    tags: [...seed.tags],
    createdAt: at,
    updatedAt: at,
  }));
}
