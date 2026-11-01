/**
 * 候选冷却账本（「休息」名单）。
 *
 * 语义照搬 magpie 的 `restingUntil`（gw-routing.go:644-684、1311-1533）：
 * - 按「为什么失败」决定休息多久，速率限制是倍增阶梯，余额是长阶梯等人充值；
 * - **一次成功就清零**（`served()`→`clearRest`，gw-routing.go:66-77）；
 * - **更长的休息不会被更短的覆盖**（gw-routing.go:1518-1533）；
 * - 休息中的候选**排到最后但绝不删除**——只剩它时仍然要问（`probeOne`，:1151-1182）。
 *
 * 两档作用域（magpie `restKey`/`restID`）：账号级 `a:<profileId>` 与
 * 账号×模型级 `m:<profileId>@<model>`。后者让「这个 Key 不供这个模型」
 * 不至于把整个 Key 的其他模型一起关进去。
 */

import { createDefaultStorage, readJson, writeJson } from "./memory/storage.js";
import type { StorageLike } from "./memory/types.js";
import type { FailureVerdict } from "./llmFailure.js";

export const HEALTH_KEY = "heming.llmHealth.v1";

const MIN = 60_000;

/** fallbackCooldown（gw-routing.go:38）：速率限制的起点。 */
const RATE_BASE = 1 * MIN;
/** longestRateRest（:184）：速率限制的封顶。 */
const RATE_LONGEST = 30 * MIN;
/** rateForget（:191）：休息结束后安静这么久，下次算新的一轮。 */
const RATE_FORGET = 30 * MIN;
/** quotaRest（:166）：什么都没说时间的额度耗尽。 */
const QUOTA_REST = 15 * MIN;
/** creditRest + creditLadder（:165、:224）：没钱了，等人充值，越拒越久。 */
const CREDIT_LADDER = [30 * MIN, 2 * 60 * MIN, 8 * 60 * MIN, 24 * 60 * MIN, 3 * 24 * 60 * MIN, 7 * 24 * 60 * MIN];
/** longestRetry（:185）：反复失败但说不出原因的封顶。 */
const UNKNOWN_LONGEST = 10 * MIN;
/** verifyRest（:194）：供应商要你先去做验证。 */
const VERIFY_REST = 30 * MIN;
/** restrictedRest（:207）：账号被限制，要申诉而不是等。 */
const RESTRICTED_REST = 2 * 60 * MIN;
/** Key 失效（401/403）：半小时问一次就够，别把每一轮都搭进去。 */
const AUTH_REST = 30 * MIN;
/** 模型下架/不供：只关这个「账号×模型」。magpie 按其原因定长，这里取中位。 */
const MODEL_REST = 30 * MIN;
/** longestWait（:167）：供应商自己说的「X 秒后再来」最多信这么久。 */
const SAID_LONGEST = 60 * MIN;

export interface RestRecord {
  /** 到期时刻（Date.now() 毫秒）。 */
  until: number;
  /** 为什么在休息（界面要说清）。 */
  kind: string;
  /** 连续失败次数（阶梯的档位）。 */
  failures: number;
}

export type HealthLedger = Record<string, RestRecord>;

/** 账号档作用域键（magpie `restKey`）。 */
export function accountKey(profileId: string): string {
  return `a:${profileId}`;
}

/** 账号×模型档作用域键（magpie `restID`）。 */
export function modelKey(profileId: string, model: string): string {
  return `m:${profileId}@${model}`;
}

/** 按 verdict 选作用域键（modelGone/overflow 只关这个模型）。 */
export function keyForVerdict(profileId: string, model: string, v: FailureVerdict): string {
  return v.scope === "model" ? modelKey(profileId, model) : accountKey(profileId);
}

/** 冷却时长由「为什么」定，供应商说了时间就信它说的（封顶 SAID_LONGEST）。 */
export function restDurationMs(
  v: FailureVerdict,
  record: RestRecord | undefined,
  retryAfterMs: number,
  now: number,
): number {
  let d: number;
  switch (v.kind) {
    case "rate": {
      // 阶梯：还在休息中又失败 → 档位不动（magpie :1676-1681 注释：一次请求自己的重试不该拉长它）；
      // 休息结束后 30 分钟内再犯 → 档位 +1；安静超过 30 分钟 → 从零开始。
      let n = 1;
      if (record && record.kind === "rate") {
        if (now < record.until) n = Math.max(record.failures, 1);
        else if (now - record.until < RATE_FORGET) n = Math.max(record.failures, 1) + 1;
      }
      d = Math.min(RATE_BASE * 2 ** Math.min(n - 1, 10), RATE_LONGEST);
      break;
    }
    case "quota":
      d = QUOTA_REST;
      break;
    case "credit": {
      const rung = record && record.kind === "credit" ? Math.max(record.failures, 1) : 0;
      d = CREDIT_LADDER[Math.min(rung, CREDIT_LADDER.length - 1)];
      break;
    }
    case "verify":
      d = VERIFY_REST;
      break;
    case "restricted":
      d = RESTRICTED_REST;
      break;
    case "auth":
      d = AUTH_REST;
      break;
    case "modelGone":
      d = MODEL_REST;
      break;
    default:
      // transient 与一切说不出所以然的失败：1min 倍增，封顶 10min（longestRetry）
      d = Math.min(RATE_BASE * 2 ** Math.min(record?.failures ?? 0, 10), UNKNOWN_LONGEST);
  }
  // 供应商说了什么时候回来，且比算出来的长 → 听它的（rateRest 的 retry-after 分支）
  if (retryAfterMs > 0 && retryAfterMs >= d) d = Math.min(retryAfterMs, SAID_LONGEST);
  return d;
}

export class LlmHealth {
  private readonly storage: StorageLike;
  /** 内存影子：同一次页面生命周期内避免反复读写 localStorage。 */
  private cache: HealthLedger | null = null;

  constructor(storage?: StorageLike) {
    this.storage = storage ?? createDefaultStorage();
  }

  private load(): HealthLedger {
    if (this.cache) return this.cache;
    this.cache = readJson<HealthLedger>(this.storage, HEALTH_KEY, {}, (raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      const out: HealthLedger = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const r = v as Partial<RestRecord>;
        if (typeof r?.until === "number" && typeof r.kind === "string") {
          out[k] = {
            until: r.until,
            kind: r.kind,
            failures: typeof r.failures === "number" ? r.failures : 1,
          };
        }
      }
      return out;
    });
    return this.cache;
  }

  private save(ledger: HealthLedger): void {
    this.cache = ledger;
    writeJson(this.storage, HEALTH_KEY, ledger);
  }

  /** 某档当前是否在休息（过期记录顺手清掉，账本不会越长越大）。 */
  restOf(key: string, now = Date.now()): RestRecord | null {
    const ledger = this.load();
    const r = ledger[key];
    if (!r) return null;
    if (r.until <= now) {
      delete ledger[key];
      this.save(ledger);
      return null;
    }
    return r;
  }

  resting(key: string, now = Date.now()): boolean {
    return this.restOf(key, now) !== null;
  }

  /**
   * 记一次失败。verdict 说不冷却（shape/region/refusal/protection/cut/overflow/fatal）
   * 就原样返回 null —— 那类失败换下一个候选就行，把这个账号关起来只会误伤。
   */
  mark(
    key: string,
    v: FailureVerdict,
    opts: { retryAfterMs?: number; now?: number } = {},
  ): RestRecord | null {
    if (!v.rests) return null;
    const now = opts.now ?? Date.now();
    const ledger = this.load();
    // 过期记录也要读得到：rateForget 要拿它当参照（magpie 的 note 同样留到被 clear）
    const prev = ledger[key];
    const duration = restDurationMs(v, prev, opts.retryAfterMs ?? 0, now);
    const until = now + duration;
    const inRest = !!prev && prev.until > now;
    const next: RestRecord = {
      until,
      kind: v.kind,
      // 休息中再犯不加档（同一次请求自己的重试不该拉长它）；休息结束后再犯才 +1
      failures: inRest ? Math.max(prev!.failures, 1) : (prev?.failures ?? 0) + 1,
    };
    // 更长的休息不被更短的覆盖（gw-routing.go:1518-1533）
    if (prev && prev.until > until) {
      ledger[key] = { ...prev, kind: v.kind, failures: next.failures };
    } else {
      ledger[key] = next;
    }
    this.save(ledger);
    return ledger[key];
  }

  /** 一次成功：清休息、清失败计数（magpie `served()`）。 */
  clear(key: string): void {
    const ledger = this.load();
    if (ledger[key]) {
      delete ledger[key];
      this.save(ledger);
    }
  }

  /** 界面上的「立即恢复」：用户自己确认这个账号已经能用了。 */
  unrest(key: string): void {
    this.clear(key);
  }

  /**
   * 全都 resting 时，挑「最快回来的那一个」仍然去问
   * （magpie `probeOne`，gw-routing.go:1151-1182：绝不死路）。
   */
  soonestBack(keys: string[], now = Date.now()): string | null {
    let best: string | null = null;
    for (const k of keys) {
      const r = this.restOf(k, now);
      if (!r) return k; // 本来就没休息，直接给它
      if (best === null || r.until < (this.restOf(best, now)?.until ?? Infinity)) best = k;
    }
    return best;
  }

  /** 当前休息中的档（界面列示 + 单测断言用）。 */
  entries(now = Date.now()): { key: string; rest: RestRecord }[] {
    const ledger = this.load();
    return Object.entries(ledger)
      .filter(([, r]) => r.until > now)
      .sort((a, b) => a[1].until - b[1].until)
      .map(([key, rest]) => ({ key, rest }));
  }

  /** 还剩多久（毫秒），没在休息返回 0。 */
  remainingMs(key: string, now = Date.now()): number {
    const r = this.restOf(key, now);
    return r ? Math.max(0, r.until - now) : 0;
  }

  /** 注入用的干净账本（单测）；生产代码不要用。 */
  reset(): void {
    this.cache = {};
    this.save({});
  }
}

/** 页面级默认账本（localStorage 落本机，与 llmConfigs 同策略：不出设备）。 */
export const llmHealth = new LlmHealth();
