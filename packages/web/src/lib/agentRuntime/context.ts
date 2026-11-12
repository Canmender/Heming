import { recallMemory } from "../memory/recall.js";
import type { VaultRecallOptions } from "../memory/recall.js";
import { isVaultSourceAvailable } from "../memory/vaultMemory.js";
import { summarizeInjection } from "../memory/format.js";
import type { MemoryObservability } from "../memory/format.js";
import type { UsageView } from "../memory/usage.js";
import type { EpisodicEntry, SemanticEntry, WorkingTurn } from "../memory/types.js";
import type { MemoryStore } from "../memory/store.js";
import { formatSkillSection } from "../skills/router.js";
import type { SkillMatch } from "../skills/types.js";
import type { SkillPool } from "../skills/store.js";

/**
 * 运行时上下文组装（设计 §6）：把「原系统提示词 → 记忆段 → 技能段」拼成最终系统提示词。
 *
 * 三条红线：
 * - 原提示词原文不动，记忆/技能只做追加；两段皆空时**原样返回 basePrompt**（严格同一字符串）；
 * - 记忆与技能各自独立 try/catch：任一层异常只丢该层，绝不上抛到生成链路；
 * - 纯本机：只用传入的 MemoryStore/SkillPool（默认即模块级单例），不触达网络与 WS。
 */

/** 召回查询额外带上最近几轮用户文本（设计 §4：query = 当前用户文本 + 最近 2 轮用户文本）。 */
const QUERY_TAIL_TURNS = 2;

/** 段落分隔：空行（记忆段/技能段自带标题，正文直接续上）。 */
const SECTION_SEPARATOR = "\n\n";

export interface BuildContextInput {
  agentId: string;
  conversationId: string;
  userText: string;
  /** 原系统提示词：作为最终提示词的前缀，原文不改。 */
  basePrompt: string;
  /** 缺省表示不接记忆（零注入）；记忆总开关关闭时同样零注入。 */
  memory?: MemoryStore;
  /** 缺省表示不接技能池（零注入）；池内无命中同样零注入。 */
  skills?: SkillPool;
  /**
   * 个性化加权视图（d.28）。缺省 = 全 ×1，召回顺序与分数和 d.27 完全一致；
   * 传账本实例时，被疑似引用过的条目在**同等相关度**下排前面（上限 +25%，不降权）。
   */
  usage?: UsageView;
  /**
   * 知识库参与记忆的可选接入点（d.114）。**缺省行为与不传时逐字相同**——
   * 没有知识库、或设置关闭时，`systemPrompt === basePrompt` 这条契约不变。
   *
   * 为什么是同步快照：本函数被 `agentStream` 在流启动前**同步**调用，
   * 注入只能用条目自带的 `value` 摘要（≤ 500 字）；按指针异步读正文
   * （`resolveExcerpt`）留给记忆页预览等异步路径，注入路径不 await 读文件。
   */
  vaultMemory?: VaultMemoryInput;
  /**
   * 智能体级记忆偏好（`memory/agentPrefs.ts`）。缺省 = 不按偏好收口（沿用旧行为）。
   *
   * ★ 传了就必须按层生效：长期关 → 不召回语义/情景；短期关 → 不召回工作记忆；
   * 个人数据库关 → 不接个人知识库。以前这些开关只影响「写」，读侧照样注入，
   * 用户关掉后仍在提示词里看到旧记忆。
   */
  agentPrefs?: { shortTerm: boolean; longTerm: boolean; personalDb: boolean };
}

/**
 * 知识库参与注入的同步接入点。
 *
 * 三个字段都可选，且都只是「覆盖」：默认从记忆仓库与设置读，真实来源
 * 由集成侧 `setVaultDocSource` 注册的 VaultDocSource 决定。
 */
export interface VaultMemoryInput {
  /** 覆盖设置开关；缺省读 `MemorySettings.vaultMemory`（唯一真源，不另起键）。 */
  enabled?: boolean;
  /** 知识库源是否接入；缺省 `isVaultSourceAvailable()`。 */
  available?: boolean;
  /** 知识库条目快照（同步函数）；缺省读记忆仓库里的指针条目。 */
  entries?: () => SemanticEntry[];
}

/** 三层召回明细（供记忆页预览/调试；原样透传 recallMemory 的结果）。 */
export interface RecalledMemory {
  semantic: SemanticEntry[];
  episodic: EpisodicEntry[];
  working: WorkingTurn[];
}

/**
 * 一次记忆注入的可观测旁路（d.27）。
 *
 * 核心口径：**召回 ≠ 注入**。`counts`/`recalled` 是排序后取到的候选，
 * `injected` 才是真进了提示词的行——预算裁掉的那几条只在 `dropped` 里出现。
 * 数据结构与算法都归 memory/format.ts（差集只有格式化那一层算得准），这里只是转发给调用方。
 */
export type { MemoryObservability };

export interface BuiltContext {
  /** 最终系统提示词：basePrompt + 记忆段 + 技能段（无注入时严格等于 basePrompt）。 */
  systemPrompt: string;
  recalled: RecalledMemory;
  /** 本次注入的技能（含命中理由/分数），空数组表示未注入。 */
  skills: SkillMatch[];
  /** 记忆注入旁路；未接记忆/零注入时为 `injected: []` 的空档。 */
  recallTrace: MemoryObservability;
}

function emptyRecalled(): RecalledMemory {
  return { semantic: [], episodic: [], working: [] };
}

function emptyObservability(): MemoryObservability {
  return {
    injected: [],
    dropped: [],
    scores: {},
    boosts: {},
    superseded: [],
    counts: { semantic: 0, episodic: 0, working: 0 },
  };
}

/** 召回查询：当前文本 + 最近 2 轮用户文本（读工作记忆失败就只用当前文本）。 */
function recallQuery(memory: MemoryStore, input: BuildContextInput): string {
  try {
    const recent = memory
      .working(input.conversationId, input.agentId)
      .slice(-QUERY_TAIL_TURNS)
      .map((turn) => turn.userText)
      .filter(Boolean);
    return [input.userText, ...recent].filter(Boolean).join("\n");
  } catch {
    return input.userText;
  }
}

/**
 * 知识库层的召回选项：三个字段都从「记忆仓库 + 设置 + 注册中心」读默认值，
 * 任何读取异常都降级为「源不可用」（可观测：旁路里能看到被跳过），不上抛。
 */
function vaultOptionsOf(input: BuildContextInput, memory: MemoryStore): VaultRecallOptions {
  const bridge = input.vaultMemory;
  // 个人数据库关掉 → 知识库这一层整体不参与（与「读侧按偏好收口」同一口径）。
  let enabled = input.agentPrefs?.personalDb ?? true;
  let available = false;
  let entries: SemanticEntry[] | undefined;
  try {
    enabled = bridge?.enabled ?? memory.getSettings().vaultMemory !== false;
    available = bridge?.available ?? (bridge?.entries ? true : isVaultSourceAvailable());
    if (bridge?.entries) entries = bridge.entries();
  } catch {
    available = false;
  }
  return { enabled, available, ...(entries ? { entries } : {}) };
}

/** 记忆段：召回 → 格式化（含注入旁路）；任何异常都降级为「无记忆」。 */
function collectMemory(
  input: BuildContextInput,
  memory: MemoryStore | undefined,
): { section: string; recalled: RecalledMemory; trace: MemoryObservability } {
  if (!memory) return { section: "", recalled: emptyRecalled(), trace: emptyObservability() };
  try {
    const found = recallMemory(
      memory,
      {
        agentId: input.agentId,
        conversationId: input.conversationId,
        query: recallQuery(memory, input),
        ...(input.agentPrefs ? { prefs: input.agentPrefs } : {}),
      },
      input.usage,
      vaultOptionsOf(input, memory),
    );
    const { text, observability } = summarizeInjection(found);
    const prefs = input.agentPrefs;
    const skippedByPrefs: string[] = [];
    if (prefs) {
      if (!prefs.longTerm) skippedByPrefs.push("长期记忆未开启：不注入语义/情景记忆");
      if (!prefs.shortTerm) skippedByPrefs.push("短期记忆未开启：不注入会话内工作记忆");
      if (!prefs.personalDb) skippedByPrefs.push("个人数据库未开启：不接入个人知识库");
    }
    return {
      section: text,
      recalled: { semantic: found.semantic, episodic: found.episodic, working: found.working },
      trace: prefs ? { ...observability, prefs, skippedByPrefs } : observability,
    };
  } catch {
    return { section: "", recalled: emptyRecalled(), trace: emptyObservability() };
  }
}

/**
 * 技能段：路由 → 格式化。命中即计一次 usage（每轮每技能一次，不重复计数），
 * 计数失败只丢计数、不影响注入（技能池异常对用户不可见）。
 */
function collectSkills(
  input: BuildContextInput,
  skills: SkillPool | undefined,
): { section: string; matches: SkillMatch[] } {
  if (!skills) return { section: "", matches: [] };
  let matches: SkillMatch[];
  try {
    matches = skills.route({ query: input.userText, agentId: input.agentId });
  } catch {
    return { section: "", matches: [] };
  }
  const section = formatSkillSection(matches);
  if (section) {
    try {
      for (const match of matches) skills.recordUsage(match.skill.id);
    } catch {
      /* 计数失败不影响本次注入 */
    }
  }
  return { section, matches };
}

/**
 * 组装一次 @ 触发的系统提示词。无记忆/技能、两层皆为空、任一层关闭或抛错时，
 * `systemPrompt` 与 `basePrompt` 严格相等（既有「原提示词行为」零变化）。
 */
export function buildAgentContext(input: BuildContextInput): BuiltContext {
  const base = typeof input.basePrompt === "string" ? input.basePrompt : "";
  const memory = collectMemory(input, input.memory);
  const skills = collectSkills(input, input.skills);

  if (!memory.section && !skills.section) {
    return {
      systemPrompt: base,
      recalled: memory.recalled,
      skills: skills.matches,
      recallTrace: memory.trace,
    };
  }
  return {
    systemPrompt: [base, memory.section, skills.section].filter(Boolean).join(SECTION_SEPARATOR),
    recalled: memory.recalled,
    skills: skills.matches,
    recallTrace: memory.trace,
  };
}
