/**
 * HITL 策略存储：档位 + 会话授权。
 *
 * 两种「记忆」必须分开：
 * - **落盘策略**（档位、免问下限）走 localStorage，跨会话保留；
 * - **会话授权**（「本会话内允许此工具」）只在内存里，进程退出即失效——
 *   落盘的话「本会话」三个字就骗人了：下次启动用户会以为还有授权。
 */

import type { StorageLike } from "../memory/types.js";
import type { HitlCall, HitlMode, PolicyOutcome, PolicyScope, RiskLevel } from "./types.js";
import { RISK_ORDER } from "./classify.js";

/** 策略存储键（带版本后缀，便于将来迁移）。 */
export const HITL_KEY = "heming.hitl.v1";

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
   * ★ **没有「全部放行」档**。曾经有 `auto`，被否掉了——
   *   它与 `self_mcp_add_server` → `self_mcp_enable` 组合后，
   *   「用户随手装个第三方包」就等于「任意代码静默执行」。
   *   理由见 `types.ts` 里 `HitlMode` 的注释。
   *
   * ★ 返回值用 `pass` 而非 `auto`：避免与已删除的档位同名两义。
   */
  allowed(call: HitlCall, policy: HitlPolicy, agentId = ""): PolicyOutcome {
    if (policy.mode === "strict") return "ask";
    if (this.underFloor(call, policy)) return "pass";
    if (policy.mode === "trusted" && this.granted(agentId, call.name, policy.scope)) {
      return "pass";
    }
    return "ask";
  }
}
