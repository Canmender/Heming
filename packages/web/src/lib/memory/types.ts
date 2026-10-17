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

/** Semantic（语义记忆）：长期成立的事实与偏好，按 agentId + key 去重。 */
export interface SemanticEntry {
  id: string;
  agentId: string;
  /** 归一化主题键（≤ 24 字），如「称呼」「偏好-语言」。 */
  key: string;
  /** 事实内容（≤ 500 字）。 */
  value: string;
  scope: "user" | "agent";
  confidence: number;
  /** 置顶：每次召回必带，且永不淘汰。 */
  pinned: boolean;
  source: "manual" | "explicit" | "consolidate";
  createdAt: string;
  updatedAt: string;
}

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
