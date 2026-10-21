/**
 * HITL 策略存储：档位 + 会话授权。
 *
 * 两种「记忆」必须分开：
 * - **落盘策略**（档位、免问下限）走 localStorage，跨会话保留；
 * - **会话授权**（「本会话内允许此工具」）只在内存里，进程退出即失效——
 *   落盘的话「本会话」三个字就骗人了：下次启动用户会以为还有授权。
 */

import type { StorageLike } from "../memory/types.js";
import type {
  HitlCall,
  HitlMode,
  HitlRule,
  PolicyOutcome,
  PolicyScope,
  RiskLevel,
  RuleEffect,
} from "./types.js";
import { RISK_ORDER, ruleResource } from "./classify.js";

/** 策略存储键（带版本后缀，便于将来迁移）。 */
export const HITL_KEY = "heming.hitl.v1";

/** 记住的规则（按工具 + 资源）。与档位分开存，清规则不影响档位。 */
export const HITL_RULES_KEY = "heming.hitl.rules.v1";

/** 规则上限：防止长期使用把 localStorage 撑爆；超出丢最旧的。 */
export const MAX_HITL_RULES = 200;

/** 资源通配：参数里没有可识别资源时，规则退化成「该工具的所有调用」。 */
export const RULE_WILDCARD = "*";

/** 策略默认值：受控（只读放行，写操作必问）。 */
export const DEFAULT_HITL_POLICY: HitlPolicy = {
  mode: "guarded",
  floor: "read",
  scope: "global",
};

/**
 * 生效中的策略。
 *
 * - `mode`：档位（见 `HitlMode`）；
 * - `floor`：免问下限——**风险不高于**此值的调用一律不问（`guarded` 下即 `read`）；
 * - `scope`：会话授权的作用域（按智能体 / 全局共用）。
 */
export interface HitlPolicy {
  mode: HitlMode;
  floor: RiskLevel;
  scope: PolicyScope;
}

/** 合法档位（读回时逐字段校验，非法值回落默认）。★ 只有三档，没有「全放行」档。 */
const MODES: HitlMode[] = ["strict", "guarded", "trusted"];
/** 合法免问下限。 */
const FLOORS: RiskLevel[] = ["read", "write", "danger"];
/** 合法作用域。 */
const SCOPES: PolicyScope[] = ["per-agent", "global"];

/** localStorage 适配（隐私模式下静默降级）。 */
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

/** 逐字段规整：类型/取值不符的字段回落默认（好字段照样用）。 */
function normalizePolicy(raw: unknown): HitlPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_HITL_POLICY };
  }
  const r = raw as Record<string, unknown>;
  return {
    mode: MODES.includes(r.mode as HitlMode) ? (r.mode as HitlMode) : DEFAULT_HITL_POLICY.mode,
    floor: FLOORS.includes(r.floor as RiskLevel)
      ? (r.floor as RiskLevel)
      : DEFAULT_HITL_POLICY.floor,
    scope: SCOPES.includes(r.scope as PolicyScope)
      ? (r.scope as PolicyScope)
      : DEFAULT_HITL_POLICY.scope,
  };
}

/**
 * 读回规则：逐条校验，坏条目直接丢弃（不因为一条脏数据清空全部规则）。
 */
function normalizeRules(raw: unknown): HitlRule[] {
  if (!Array.isArray(raw)) return [];
  const out: HitlRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.tool !== "string" || !r.tool.trim()) continue;
    if (typeof r.resource !== "string" || !r.resource.trim()) continue;
    if (r.effect !== "allow" && r.effect !== "deny") continue;
    out.push({
      tool: r.tool.trim().slice(0, 200),
      resource: r.resource.trim().slice(0, 200),
      effect: r.effect,
      at: typeof r.at === "string" ? r.at : "",
      ...(typeof r.agentId === "string" && r.agentId.trim()
        ? { agentId: r.agentId.trim().slice(0, 200) }
        : {}),
      ...(typeof r.agentName === "string" && r.agentName.trim()
        ? { agentName: r.agentName.trim().slice(0, 200) }
        : {}),
    });
    if (out.length >= MAX_HITL_RULES) break;
  }
  return out;
}

/**
 * 策略与会话授权的存储。
 *
 * 会话授权**只放内存**（`Map`）：落盘就等于把「本会话」变成了「永久」，
 * 用户下次启动会以为某个危险工具还在授权列表里。
 */
export class HitlPolicyStore {
  private readonly storage: StorageLike;
  /** 会话授权：key = `${scope}:${agentId}:${toolName}`。 */
  private readonly session = new Map<string, number>();

  constructor(storage?: StorageLike) {
    this.storage = storage ?? defaultStorage();
  }

  /** 读当前策略：缺键 / 损坏 / 存储抛错一律回落默认。 */
  get(): HitlPolicy {
    try {
      const raw = this.storage.getItem(HITL_KEY);
      if (!raw) return { ...DEFAULT_HITL_POLICY };
      return normalizePolicy(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_HITL_POLICY };
    }
  }

  /** 写策略：存储抛错静默（本次会话内仍按内存态生效）。 */
  set(policy: HitlPolicy): void {
    try {
      this.storage.setItem(HITL_KEY, JSON.stringify(normalizePolicy(policy)));
    } catch {
      /* 存不下只影响「记住设置」，不影响本次生效 */
    }
  }

  /** 当前档位。 */
  mode(): HitlMode {
    return this.get().mode;
  }

  /** 会话授权 key。 */
  private key(agentId: string, toolName: string, scope: PolicyScope): string {
    return `${scope}:${agentId}:${toolName}`;
  }

  /** 该工具在本会话是否已授权。 */
  granted(agentId: string, toolName: string, scope: PolicyScope = "global"): boolean {
    return this.session.has(this.key(agentId, toolName, scope));
  }

  /** 授予本会话内该工具的通行权。 */
  grant(agentId: string, toolName: string, scope: PolicyScope = "global"): void {
    this.session.set(this.key(agentId, toolName, scope), Date.now());
  }

  /** 撤销全部会话授权（用户在设置区点「清空本会话授权」时用）。 */
  revokeAll(): void {
    this.session.clear();
  }

  /**
   * 免问下限是否覆盖该风险（风险**不高于**下限 ⇒ 免问）。
   *
   * 注意是「不高于」而不是「低于」：`floor=read` 时只读免问，
   * 写与危险仍要问——这正是 `guarded` 的语义。
   */
  private underFloor(call: HitlCall, policy: HitlPolicy): boolean {
    return RISK_ORDER[call.risk] <= RISK_ORDER[policy.floor];
  }

  /**
   * 判定一次调用是否需要问用户。
   *
   * 档位语义：
   * - `strict`：全部询问（连只读也问）；
   * - `guarded`：免问下限之下的自动放行，其余询问；
   * - `trusted`：同 `guarded`，但**本会话授权**生效（已授权的工具直接放行）。
   *
   * ★ **没有「全部放行」档**。理由见 `types.ts` 里 `HitlMode` 的注释。
   * ★ 返回值用 `pass` 而非 `auto`：避免与已删除的档位同名两义。
   *
   * 记住的规则（`ruleFor`）不在这里判定：规则可以**跳过询问**（allow）
   * 或**直接拒绝**（deny），语义比 `pass/ask` 更宽，由闸门先查。
   */
  allowed(call: HitlCall, policy: HitlPolicy, agentId = ""): PolicyOutcome {
    if (policy.mode === "strict") return "ask";
    if (this.underFloor(call, policy)) return "pass";
    if (policy.mode === "trusted" && this.granted(agentId, call.name, policy.scope)) {
      return "pass";
    }
    return "ask";
  }

  /** 读回全部记住的规则（最坏情况下返回空数组，绝不抛错）。 */
  rules(): HitlRule[] {
    try {
      const raw = this.storage.getItem(HITL_RULES_KEY);
      if (!raw) return [];
      return normalizeRules(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  /**
   * 记住一条裁决。
   *
   * 同一 `{tool, resource, agentId}` 只保留最新一条：用户先拒绝后允许时，
   * 不该两条规则并存再靠「deny 优先」把新决定吃掉。
   * 不传 agent 时写的是全局规则（兼容旧调用方与旧存储）。
   */
  rememberRule(
    tool: string,
    resource: string,
    effect: RuleEffect,
    agent?: { id: string; name?: string },
  ): void {
    const t = tool.trim().slice(0, 200);
    if (!t) return;
    const r = (resource.trim() || RULE_WILDCARD).slice(0, 200);
    const agentId = agent?.id.trim().slice(0, 200) || undefined;
    const next: HitlRule[] = [
      {
        tool: t,
        resource: r,
        effect,
        at: new Date().toISOString(),
        ...(agentId ? { agentId } : {}),
        ...(agentId && agent?.name ? { agentName: agent.name.slice(0, 200) } : {}),
      },
      ...this.rules().filter(
        (rule) => !(rule.tool === t && rule.resource === r && rule.agentId === agentId),
      ),
    ].slice(0, MAX_HITL_RULES);
    try {
      this.storage.setItem(HITL_RULES_KEY, JSON.stringify(next));
    } catch {
      /* 存不下退化为「仅本次生效」，不阻断对话 */
    }
  }

  /** 一键清空全部规则（设置区「清空记住的规则」）。 */
  clearRules(): void {
    try {
      this.storage.removeItem(HITL_RULES_KEY);
    } catch {
      /* 隐私模式：存储不可用，内存里本就没有规则 */
    }
  }

  /**
   * 查规则：`deny` 永远优先于 `allow`。
   *
   * 作用域：规则带 `agentId` 时只对该智能体生效；不带（旧规则）时对所有智能体生效。
   * 不传 `agentId` 的调用方只能命中全局规则——这正是「宁可多问」的方向。
   *
   * ★ `allow` 规则**不覆盖 `danger`**：按资源记住一个危险工具，
   * 等于给该工具开了一个永久放行口子，与「没有全放行档」的红线冲突。
   * 危险操作始终会弹窗；用户若确实不想被打扰，可以改免问下限——
   * 那是显式、可见、可一键改回的全局设置。
   */
  ruleFor(call: HitlCall, agentId = ""): RuleEffect | null {
    const resource = ruleResource(call.argsJson);
    const rules = this.rules();
    const match = (effect: RuleEffect) =>
      rules.find(
        (r) =>
          r.effect === effect &&
          r.tool === call.name &&
          (r.resource === resource || r.resource === RULE_WILDCARD) &&
          (!r.agentId || r.agentId === agentId),
      );
    if (match("deny")) return "deny";
    if (call.risk === "danger") return null;
    if (match("allow")) return "allow";
    return null;
  }
}
