import type { StorageLike } from "./types.js";
import { createDefaultStorage, isPlainObject, readJson, writeJson } from "./storage.js";

/**
 * 智能体级记忆偏好（`heming.memory.agentPrefs.v1`）。
 *
 * d.146.5 起记忆页删除：短期/长期/个人数据库**默认全开且不可关闭**，全部在后台自动运行。
 * 落盘结构保留（旧版本可能写过 false），但 `get()` 一律返回全开——页面没了就没有关它的入口，
 * 读旧值时再把记忆关掉只会让行为与产品承诺不一致。
 */

export const AGENT_PREFS_KEY = "heming.memory.agentPrefs.v1";

export interface AgentMemoryPrefs {
  /** 短期记忆（会话级缓冲）。 */
  shortTerm: boolean;
  /** 长期记忆（数据库记忆：情景 + 语义）。 */
  longTerm: boolean;
  /** 个人数据库/个人知识库。 */
  personalDb: boolean;
}

export const DEFAULT_AGENT_PREFS: AgentMemoryPrefs = {
  shortTerm: true,
  longTerm: true,
  personalDb: true,
};

/** 纯函数：把任意落盘内容收敛为合法偏好表（非对象条目丢弃，缺字段取缺省）。 */
export function resolveAgentMemoryPrefs(raw: unknown): Record<string, AgentMemoryPrefs> {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, AgentMemoryPrefs> = {};
  for (const [agentId, value] of Object.entries(raw)) {
    const id = agentId.trim();
    if (!id || !isPlainObject(value)) continue;
    out[id] = {
      shortTerm: typeof value.shortTerm === "boolean" ? value.shortTerm : DEFAULT_AGENT_PREFS.shortTerm,
      longTerm: typeof value.longTerm === "boolean" ? value.longTerm : DEFAULT_AGENT_PREFS.longTerm,
      personalDb: typeof value.personalDb === "boolean" ? value.personalDb : DEFAULT_AGENT_PREFS.personalDb,
    };
  }
  return out;
}

export class AgentPrefsStore {
  private readonly storage: StorageLike;
  private prefs: Record<string, AgentMemoryPrefs>;

  constructor(storage?: StorageLike) {
    this.storage = storage ?? createDefaultStorage();
    this.prefs = readJson(this.storage, AGENT_PREFS_KEY, {}, resolveAgentMemoryPrefs);
  }

  /** 单智能体偏好：记忆无界面开关，恒为全开（旧落盘值不再生效）。 */
  get(_agentId: string): AgentMemoryPrefs {
    return { ...DEFAULT_AGENT_PREFS };
  }

  set(agentId: string, patch: Partial<AgentMemoryPrefs>): AgentMemoryPrefs {
    const next: AgentMemoryPrefs = { ...this.get(agentId), ...patch };
    this.prefs = { ...this.prefs, [agentId]: next };
    writeJson(this.storage, AGENT_PREFS_KEY, this.prefs);
    return { ...next };
  }

  /** 全量快照（含已落盘但名册里暂时读不到的智能体）。 */
  all(): Record<string, AgentMemoryPrefs> {
    const out: Record<string, AgentMemoryPrefs> = {};
    for (const [agentId, prefs] of Object.entries(this.prefs)) out[agentId] = { ...prefs };
    return out;
  }
}

/** 模块级单例：记忆页与后续上下文组装共用同一份偏好。 */
export const agentPrefsStore = new AgentPrefsStore();
