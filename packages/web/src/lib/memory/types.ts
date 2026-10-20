/**
 * 三层记忆的数据契约（设计 §2）。
 * 字段名与 `docs/superpowers/plans/2026-10-17-agent-memory-skills.md` Task 1 严格一致，
 * 后续任务（上下文组装/记忆页）直接复用这些类型。
 */

/** Working（工作记忆）：当前会话近若干轮，会话级 2h TTL / 40 轮环形缓冲。 */
export interface WorkingTurn {
  id: string;
  conversationId: string;
  agentId: string;
  userText: string;
  assistantText: string;
  /** ISO 时间戳。 */
  at: string;
  /** 中断/失败轮次标记：只进 Working，不沉淀 Episodic（设计 §3）。 */
  partial?: boolean;
}

/** Episodic（情景记忆）：「某次对话发生了什么」的压缩条目，长期存放、按分数衰减淘汰。 */
export interface EpisodicEntry {
  id: string;
  agentId: string;
  conversationId: string;
  /** 确定性摘要（≤ 400 字，无 LLM 成本）。 */
  summary: string;
  /** 中文 bigram + ASCII 词（≤ 12）。 */
  keywords: string[];
  at: string;
  /** 0..1，默认 0.5。 */
  importance: number;
  /** 由多少轮沉淀而来。 */
  sourceTurns: number;
}

/** Semantic（语义记忆）：长期成立的事实与偏好。 */
export interface SemanticEntry {
  id: string;
  /**
   * 归属智能体；`GLOBAL_AGENT_ID` 表示**全局共用**（所有智能体共享同一份长期记忆）。
   *
   * 口径（用户 2026-10-20 明确要求「数据库记忆是长期记忆时所有智能体公用的」）：
   * 长期事实与偏好本就是关于用户本人的，与「跟谁说话」无关——分智能体存会让
   * 智能体 A 学到的「用户偏好中文」在智能体 B 上完全失效，还得人工搬一遍。
   * 因此写入默认落全局桶，召回时全局条目与本智能体条目合并后一起排序。
   */
  agentId: string;
  /** 归一化主题键（≤ 24 字），如「称呼」「偏好-语言」。 */
  key: string;
  /** 事实内容（≤ 500 字）。 */
  value: string;
  scope: "user" | "agent";
  confidence: number;
  /** 置顶：每次召回必带，且永不淘汰。 */
  pinned: boolean;
  /** manual=手动添加；explicit=用户明说「记住…」；consolidate=规则沉淀；review=复盘分身自评写入。 */
  source: "manual" | "explicit" | "consolidate" | "review";
  createdAt: string;
  updatedAt: string;
}

/**
 * 全局语义记忆桶的保留 agentId。
 *
 * 为什么用魔法字符串而不是把 semantic 从 `Record<agentId, …>` 改成扁平数组：
 * 那样要迁移既有存储（老用户的 per-agent 语义条目会丢），而保留键名可以让
 * 老数据原样继续工作——读取时只多合并一个桶。
 * 前缀 `__` 用于避开真实 agentId（服务端用的是随机 UUID，不会以双下划线开头）。
 */
export const GLOBAL_AGENT_ID = "__global__";

/** 记忆设置（`heming.memory.settings.v1`）。 */
export interface MemorySettings {
  /** 总开关：关闭后既不记录也不召回。 */
  enabled: boolean;
  /** 自动沉淀：关闭后只追加 Working，不做显式抽取与 6 轮沉淀。 */
  autoCapture: boolean;
  /** 情景记忆保留天数，读取时过滤超期条目。 */
  retentionDays: number;
}

/** localStorage 抽象：可注入内存实现，也便于测试断言落盘与模拟配额异常。 */
export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** 全量记忆数据（导出/导入的单位）。 */
export interface MemoryData {
  working: Record<string, WorkingTurn[]>;
  episodic: Record<string, EpisodicEntry[]>;
  semantic: Record<string, SemanticEntry[]>;
  settings: MemorySettings;
}
