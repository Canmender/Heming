/**
 * 自我修改护栏（self-modification guards）。
 *
 * 智能体被授权改动自己的记忆、技能与 MCP 配置后，**能写错东西**就成了主要风险：
 * 把密钥写进记忆、把自己撑爆、或者改了不该改的地方。这层专门管「写之前先验一下」，
 * 而不是去限制能力——用户已经明确授权放开，护栏只解决「写坏」而非「不许写」。
 *
 * 抽成独立模块是为了让**两条自我修改通道共用同一套判据**：
 * - 后台自审：`lib/memory/review.ts`（复盘分身，任务结束触发）
 * - 会话内工具：`lib/selfTools.ts`（模型按需调用，即时生效）
 * 两处若各写一份敏感正则，迟早会漂移成「一条通道能拦、另一条拦不住」。
 */

import type { StorageLike } from "../memory/types.js";

/** 重导出：本模块对外的 API 都要用到它，调用方不必再去 memory/types 单独 import。 */
export type { StorageLike };

/**
 * 敏感信息模式：密钥、口令、令牌、私钥。
 *
 * 这些**永不落盘**——不是「怕被自己读到」，而是它们一旦进了技能/记忆/日志，
 * 就会跟着每一次模型调用被复制到别处，清不干净。
 */
export const SENSITIVE_PATTERNS: RegExp[] = [
  /(sk-[A-Za-z0-9]{12,})/,
  /(ghp_[A-Za-z0-9]{20,})/,
  /(AKIA[0-9A-Z]{12,})/,
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----)/,
  /(bearer\s+[A-Za-z0-9._-]{16,})/,
  /((?:api[_ -]?key|token|secret|password|passwd|密码|口令|密钥)\s*[:=：]\s*\S{6,})/i,
  // 中文里密钥与取值之间常不用「:=」而用「是/为」，例如「我的密码是 hunter2000」。
  // 少了这条，最常见的中文写法反而漏检——而这恰恰是本项目主要的使用语言。
  //
  // 取值必须**以 ≥6 个 ASCII 字符（数字/字母/符号）开头**：
  // JS 的 `\S` 也匹配汉字，写`\S{6,}` 会把「密码是重要的，别写进记忆」这种
  // 正常句子当成口令；而真正的口令/密钥一定是字母数字混合的。
  /(?:密码|口令|密钥|passwd|password)\s*(?:是|为|\bis\b|\bare\b)\s*(?=[A-Za-z0-9!@#$%^&*()_+\-=./?]{6,})/i,
];

/** 文本是否疑似含密钥/口令。多个字段时传数组，任一命中即整条拒绝。 */
export function containsSensitive(text: unknown): boolean {
  const raw = typeof text === "string" ? text : String(text ?? "");
  return SENSITIVE_PATTERNS.some((re) => re.test(raw));
}

/** 多字段一次性检查（技能有 name+instructions，MCP 服务有 name+url+headers）。 */
export function anySensitive(fields: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue;
    if (containsSensitive(typeof value === "string" ? value : JSON.stringify(value))) {
      return key;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ 变更留痕 */

export const AUDIT_KEY = "heming.selfAudit.v1";

/** 一次自我修改的留痕条目。 */
export interface AuditEntry {
  at: string;
  agentId: string;
  /** 受影响的面：记忆 / 技能 / MCP / 提示词… */
  scope: "memory" | "skill" | "mcp" | "other";
  /** 动作：write / update / remove / enable / disable / create */
  action: string;
  /** 被改对象的可读标识（记忆 key、技能名、工具键）。 */
  target: string;
  /** 模型自己给的理由（写入，便于日后回看「它为什么这么改」）。 */
  reason?: string;
  /** 被拒绝的原因；非空说明这次没落地。 */
  rejected?: string;
}

function pickAudit(raw: unknown): AuditEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: AuditEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.at !== "string" || typeof r.agentId !== "string") continue;
    if (typeof r.scope !== "string" || typeof r.action !== "string") continue;
    out.push({
      at: r.at,
      agentId: r.agentId,
      scope: r.scope as AuditEntry["scope"],
      action: r.action,
      target: String(r.target ?? "").slice(0, 120),
      ...(typeof r.reason === "string" ? { reason: r.reason.slice(0, 200) } : {}),
      ...(typeof r.rejected === "string" ? { rejected: r.rejected.slice(0, 200) } : {}),
    });
  }
  return out;
}

/** 留痕保留条数上限：够回看近期行为，又不会无限增长。 */
export const AUDIT_MAX = 300;

/**
 * 追加一条留痕（最新在前，超额丢最旧）。
 * 被拒绝的变更**也要留痕**——「它试图写什么但被拦下」比「什么都没发生」更值得知道。
 */
export function appendAudit(
  storage: StorageLike,
  entry: AuditEntry,
): AuditEntry[] {
  let previous: AuditEntry[] = [];
  try {
    previous = pickAudit(JSON.parse(storage.getItem(AUDIT_KEY) ?? "[]"));
  } catch {
    previous = [];
  }
  const next = [entry, ...previous].slice(0, AUDIT_MAX);
  try {
    storage.setItem(AUDIT_KEY, JSON.stringify(next));
  } catch {
    /* 存不下不留痕，不影响变更本身 */
  }
  return next;
}

/** 读留痕，可按智能体过滤。 */
export function readAudit(storage: StorageLike, agentId?: string): AuditEntry[] {
  try {
    const all = pickAudit(JSON.parse(storage.getItem(AUDIT_KEY) ?? "[]"));
    return agentId ? all.filter((e) => e.agentId === agentId) : all;
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ 单轮上限 */

/**
 * 单轮自我修改次数上限。
 *
 * 为什么要卡：模型可能陷入「改一下 → 发现不对 → 再改一下」的死循环，
 * 几轮下来把技能池和记忆写满。不卡上限的话，一次异常就能毁掉配置。
 * 触顶后**不是静默失败**，而是明确回一句「已达上限」。
 */
export const SELF_EDIT_MAX_PER_TURN = 8;

/** 单轮变更计数（按会话 + 智能体）。 */
export class SelfEditBudget {
  private readonly counts = new Map<string, number>();

  /** 还能改几次；<= 0 表示已触顶。 */
  remaining(agentId: string, conversationId: string): number {
    return SELF_EDIT_MAX_PER_TURN - (this.counts.get(keyOf(agentId, conversationId)) ?? 0);
  }

  /** 记一次变更；返回 false 表示已触顶（不计数）。 */
  consume(agentId: string, conversationId: string): boolean {
    const key = keyOf(agentId, conversationId);
    const used = this.counts.get(key) ?? 0;
    if (used >= SELF_EDIT_MAX_PER_TURN) return false;
    this.counts.set(key, used + 1);
    return true;
  }

  /** 轮次结束清零（新的一次生成算新轮）。 */
  reset(agentId: string, conversationId: string): void {
    this.counts.delete(keyOf(agentId, conversationId));
  }

  /** 全清（会话切换、清空记忆等）。 */
  clear(): void {
    this.counts.clear();
  }
}

function keyOf(agentId: string, conversationId: string): string {
  return `${agentId}\u0000${conversationId}`;
}

/* ------------------------------------------------------------------ 开关 */

/**
 * 自我修改开关（`heming.selfEdit.v1`）。**默认开启**（用户明确要求）。
 *
 * 按智能体独立配置：用户在技能区可为某个智能体单独关掉，
 * 这样「让架构师自我优化、但别让临时测试体乱改」是可表达的。
 */
export const SELF_EDIT_KEY = "heming.selfEdit.v1";

export interface SelfEditPolicy {
  /** 是否允许该智能体调用 self.* 工具。缺省 true（默认开启）。 */
  enabled: boolean;
}

function defaultStorage(): StorageLike {
  return {
    getItem: (k) => {
      try {
        return window.localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      try {
        window.localStorage.setItem(k, v);
      } catch {
        /* 隐私模式：只在本次会话生效 */
      }
    },
    removeItem: (k) => {
      try {
        window.localStorage.removeItem(k);
      } catch {
        /* 同上 */
      }
    },
  };
}

/**
 * 自我修改策略存储。
 *
 * 两个口径要分清：
 * - `allowed()`：**界面展示**用的缺省值 = 开启（用户明确要求默认开启），
 *   这样技能区的开关默认是勾上的，用户不必先知道这件事；
 * - `configured()`：**是否真的注入过工具**。从未配置过 = false = 不给工具。
 *
 * 为什么要分开：self.* 有 13 个工具、描述不短，全部塞进每次请求会明显推高 token。
 * 对「并不需要自我优化」的智能体，这是纯浪费。所以实际生效的条件是
 * 「用户至少打开过一次」，而不是「缺省就是开」。
 * 界面上仍默认勾选，用户不动它等于维持现状；
 * 一旦取消勾选即写入 enabled:false，之后不再注入（也不会再自动恢复）。
 */
export class SelfEditStore {
  private readonly storage: StorageLike;
  /** 缺省开启，因此空/损坏数据都按开启处理。 */
  private readonly fallback: SelfEditPolicy = { enabled: true };

  constructor(storage?: StorageLike) {
    this.storage = storage ?? defaultStorage();
  }

  policy(agentId: string): SelfEditPolicy {
    try {
      const raw = JSON.parse(this.storage.getItem(SELF_EDIT_KEY) ?? "{}") as Record<
        string,
        unknown
      >;
      const row = raw?.[agentId];
      if (!row || typeof row !== "object") return { ...this.fallback };
      const r = row as Record<string, unknown>;
      return { enabled: r.enabled !== false };
    } catch {
      return { ...this.fallback };
    }
  }

  setPolicy(agentId: string, policy: SelfEditPolicy): void {
    try {
      const raw = JSON.parse(this.storage.getItem(SELF_EDIT_KEY) ?? "{}") as Record<
        string,
        unknown
      >;
      raw[agentId] = { enabled: policy.enabled };
      this.storage.setItem(SELF_EDIT_KEY, JSON.stringify(raw));
    } catch {
      /* 存不下只在本次会话生效 */
    }
  }

  /** 该智能体是否允许自我修改（界面展示口径，缺省 true）。 */
  allowed(agentId: string): boolean {
    return this.policy(agentId).enabled;
  }

  /** 用户是否显式配置过该智能体（决定要不要注入 self.* 工具）。 */
  configured(agentId: string): boolean {
    try {
      const raw = JSON.parse(this.storage.getItem(SELF_EDIT_KEY) ?? "{}") as Record<
        string,
        unknown
      >;
      return typeof raw?.[agentId] === "object" && raw[agentId] !== null;
    } catch {
      return false;
    }
  }
}