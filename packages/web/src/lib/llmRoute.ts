/**
 * 多候选路由层：一条候选链（路由组）+ 失败换候选 + 冷却账本。
 *
 * 与 `streamChat` **签名兼容**——装配处只需把 `TriggerDeps.streamChat` 换成
 * `streamChatRouted`（ChatPage.tsx 的 deps），编排层完全不理解「候选链」这个概念。
 * 没有路由组时链长为 1，直接透传，行为与旧版逐字相同。
 *
 * 规则来源：magpie（github.com/yetone/magpie，MIT）
 * - `internal/gateway/fallback.go` 的 `holdWriter.passing`（:1995-2130、:2911-2924）
 *   —— **已经向客户端写出正文后绝不换候选**，否则回复出现两份；
 * - `retryable()`（:1618-1648）—— 见 lib/llmFailure.ts；
 * - `roomy`/`withRoom`（:1850、:1800-1816）—— 窗口装不下就不问这个候选，
 *   说过「太长」的那个模型本轮不再问（同模型每个账号都一样长）；
 * - `rateRest`/`creditBackoff`/`served()`（gw-routing.go）—— 见 lib/llmHealth.ts；
 * - `probeOne`（gw-routing.go:1151-1182）—— 全在休息时仍问最快回来的那个，绝不死路；
 * - 顺序：magpie「In order」= 按声明顺序，第一个能答的一直答。
 *
 * ## 选路策略（第二批移植，见 `orderCandidates`）
 *
 * 八档全部确定性、可解释、可单测，共同规矩：**休息中的候选永远排最后但绝不删除**，
 * 全休息时仍问最快回来的一个（`probeOne` 语义一字不动）。
 * - `order`：声明顺序（老数据缺省，行为与加这档前逐字相同）；
 * - `smart`：本月用量、参考价、近期失败三项归一后加权求和（权重见常量；magpie 默认档）；
 * - `usage`：本月用量按 1 小时半衰后升序（magpie `usageHalfLife`）；
 * - `pace`：本月用量 ÷ 本月已过时间比例，比值升序（「Use before expiry」的客户端近似，
 *   **不读供应商配额、不假装有预算**）；
 * - `weight`：平滑加权轮询（magpie `routes.Weighted`），权重存 `RouteMember.weight`；
 * - `fast`：首 token + 200 token 用时短先问（magpie `Fastest`），没测过速的排后，
 *   每第 5 个请求给一个未测速候选先手（防饿死）；数据源 lib/llmSpeed.ts（纯内存）；
 * - `rotate`：醒着的按序轮换（magpie「In turn」），休息的跳过。
 *
 * **模块闸门**：本机 `modelroute` 模块停用时，无论 `RouteGroup.strategy` 写什么，
 * 一律按 `order` 走——停用只下线高级选路，候选链与失败切换照常工作，
 * 数据一个不删（与模块「停用不删数据」的语义一致）。见 `effectiveRouteStrategy`。
 *
 * ## 刻意不做（本仓没有数据来源，不装样子）
 *
 * - `drain` / `expiring`：需要「供应商窗口何时续期」「免费额度何时到期」的数据，
 *   本仓读不到，不做近似——近似出来的选路比不选更难解释；
 * - 不读供应商配额、不做并发/限流/请求翻译（那是网关的活，本仓是客户端）；
 * - 不改 HITL / E2E / Key 存储。
 *
 * 与 magpie 的两处有意差异（都在下面标注了）：① 一次请求最多发 6 个 HTTP
 * （magpie 不设上限，浏览器侧用户是在等，必须有上限）；② 401/403/404 无特殊措辞时
 * 统一按 auth/modelGone 冷却，magpie 是按供应商点名的 hint 判定的。
 */

import { estimateTokens, ROW_TOKEN_OVERHEAD } from "./agentContext/tokens.js";
import { classifyFailure, type FailureVerdict } from "./llmFailure.js";
import {
  LlmHttpError,
  streamChat,
  type ChatMessage,
  type RouteAttempt,
  type StreamChatOpts,
  type UsageTotals,
} from "./llmClient.js";
import { accountKey, keyForVerdict, llmHealth, modelKey } from "./llmHealth.js";
import { lookupCapability } from "./modelCaps.js";
import { llmSpeed } from "./llmSpeed.js";
import { isModuleOn } from "./modules/store.js";
import {
  decayedMonthTokensOf,
  monthElapsedFraction,
  monthKeyOf,
  monthTokensOf,
  useTokenUsageStore,
} from "../store/tokenUsage.js";
import {
  parseRouteRef,
  useLlmStore,
  type LlmProfile,
  type RouteGroup,
  type RouteStrategy,
} from "../store/llm.js";

/** 一次 streamChatRouted 最多发出的 HTTP 数（见文件头的差异①）。 */
const MAX_ASKS = 6;
/** 同一候选对瞬时失败（5xx/408/网络）的再问次数（magpie `lastRetries`=2）。 */
const TRANSIENT_REASKS = 2;
/** 再问前的等待阶梯（magpie 1s/2s/4s）。 */
const PAUSE_LADDER = [1000, 2000, 4000];
/** 供应商让等超过这个就别傻等，直接换候选（magpie `longestPause`=8s）。 */
const LONGEST_PAUSE = 8000;

/** 带路由组的合成 profile：只在本机内存里存在，绝不写进 secureStorage。 */
export interface RoutedProfile extends LlmProfile {
  route?: RouteGroup;
}

interface Candidate {
  profile: LlmProfile;
  /** 账号档（magpie restKey）。 */
  ak: string;
  /** 账号×模型档（magpie restID）。 */
  mk: string;
  /** 成员权重（`weight` 档用；缺省 1，夹到 1–100，见 `weightOf`）。 */
  weight?: number;
}

const isAbort = (e: unknown): boolean => (e as { name?: string })?.name === "AbortError";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("AbortError", "AbortError"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 成员 → 真实 profile（引用不存在的成员跳过）；成员上的 model/weight 覆盖生效。 */
function toCandidate(
  profile: LlmProfile,
  modelOverride?: string,
  weight?: number,
): Candidate | null {
  if (!profile) return null;
  const effective: LlmProfile = modelOverride
    ? { ...profile, model: modelOverride, id: profile.id }
    : profile;
  return {
    profile: effective,
    ak: accountKey(effective.id),
    mk: modelKey(effective.id, effective.model),
    ...(typeof weight === "number" ? { weight } : {}),
  };
}

/** 展开候选链：路由组 → 成员；单连接 → 长度 1。 */
export function expandChain(profile: LlmProfile): Candidate[] {
  const route = (profile as RoutedProfile).route;
  if (!route) {
    const one = toCandidate(profile);
    return one ? [one] : [];
  }
  const store = useLlmStore.getState();
  const out: Candidate[] = [];
  for (const m of route.members) {
    const p = store.getProfile(m.profileId);
    if (!p) continue; // 成员已被删（store 会同步剪掉，这里只兜住同一 tick 的竞态）
    const c = toCandidate(p, m.model, m.weight);
    if (c) out.push(c);
  }
  return out;
}

/**
 * 选路策略的排序上下文。
 * - `now`：读取时刻（单测注入假时钟；生产传 Date.now()）；
 * - `strategy`：路由组上写的档位（老数据缺省 order）；
 * - `groupId`：轮询/公平计数按组隔离（单连接路径不会走到这里，兜底 "single"）。
 */
interface OrderContext {
  now: number;
  strategy: RouteStrategy;
  groupId: string;
}

/** smart 档的三项权重（三项都归一到 0..1，分数越小越前）。理由见 `sortSmart`。 */
const SMART_W_USAGE = 0.65;
const SMART_W_FAILURE = 0.35;

/** fast 档的分档粒度（毫秒）：同档内保持声明序，避免几十毫秒的抖动就换人。 */
const FAST_BUCKET_MS = 500;

/** 每第几个请求给「没测过速」的候选一次先手机会（magpie `Fastest` 的防饿死）。 */
const FAST_UNDERDOG_EVERY = 5;

/**
 * 轮询状态（**纯内存**，重启清零——magpie 同样只在内存里存轮询位置）。
 * key 见 `rotationKey`；值是各档自己的计数，互不影响。
 */
const weightStates = new Map<string, Map<string, number>>();
const rotateStates = new Map<string, number>();
const fastCounters = new Map<string, number>();

/** 测试隔离：清掉轮询/防饿死计数（生产不要调，重启自然清零）。 */
export function resetRouteStrategyState(): void {
  weightStates.clear();
  rotateStates.clear();
  fastCounters.clear();
}

/**
 * 模块闸门 + 老数据兜底。
 *
 * `modelroute` 模块停用时，无论 `RouteGroup.strategy` 写什么都按 `order`——
 * 停用只下线高级选路，候选链与失败切换照常工作（模块语义「停用不删数据」）。
 * 认不出的档位（手改坏的 localStorage、将来回滚版本留下的值）也按 order，绝不抛。
 */
export function effectiveRouteStrategy(raw: RouteStrategy | undefined): RouteStrategy {
  if (!isModuleOn("modelroute")) return "order";
  return raw ?? "order";
}

/**
 * 轮询状态的归一化键：组 id + 成员集合（与声明顺序无关的签名）。
 * 成员集合变了就换键、状态从零开始——旧成员的计数带着也没意义。
 */
function rotationKey(prefix: string, ctx: OrderContext, chain: Candidate[]): string {
  const signature = chain
    .map((c) => c.mk)
    .sort()
    .join("|");
  return `${prefix}:${ctx.groupId}:${signature}`;
}

/** 成员权重：缺省 1，夹到 1–100 的整数（坏数据不卡死轮询）。 */
function weightOf(c: Candidate): number {
  return typeof c.weight === "number" && Number.isFinite(c.weight)
    ? Math.min(100, Math.max(1, Math.round(c.weight)))
    : 1;
}

/** 数值升序的稳定排序：同值返回 0，保持声明序（V8/ECMAScript 的 sort 是稳定排序）。 */
function sortByNumberAsc(awake: Candidate[], valueOf: (c: Candidate) => number): void {
  const values = new Map(awake.map((c) => [c, valueOf(c)]));
  awake.sort((a, b) => (values.get(a) ?? 0) - (values.get(b) ?? 0));
}

/**
 * `smart`：醒着里按三项本机可算的信号综合打分，分数小者先。
 *
 * 公式（两项都归一到 0..1）：
 * `0.65 × 本月用量占比 + 0.35 × 近期失败占比`
 *
 * 权重说明（d.93 起）：
 * - 网关不提供价格，参考价维度已删除；用量成为主信号（「这个月还愿意让它花多少」），
 *   近期失败做次信号（刚失败过、已出休息期的候选排干净候选后面，避免一回来就抢首发）；
 * - 原本的 0.5/0.3/0.2 按「去掉价格后重新归一」变成 0.65/0.35，保持两项相对优先级不变。
 *
 * 口径说明：
 * - 用量用**本月已上报 token**（`monthTokensOf`），不是衰减值——smart 要的是「月度盘面」；
 *   想要近期衰减语义请选 `usage` 档；
 * - 「近期失败」取冷却账本里残留的连续失败档位（`llmHealth.failures`），醒着的候选
 *   没有 active rest，这是唯一还能读到的近期表现；
 * - 同分保持声明序（稳定排序），所以没有任何数据时 smart ≡ order。
 */
function sortSmart(
  awake: Candidate[],
  now: number,
  failureOf: Map<Candidate, number>,
): void {
  const month = monthKeyOf(new Date(now).toISOString());
  const records = useTokenUsageStore.getState().records;
  const usage = new Map<Candidate, number>();
  let maxUsage = 0;
  let maxFailure = 1;
  for (const c of awake) {
    const u = monthTokensOf(records, c.profile.id, c.profile.model, month);
    const f = failureOf.get(c) ?? 0;
    usage.set(c, u);
    maxUsage = Math.max(maxUsage, u);
    maxFailure = Math.max(maxFailure, f);
  }
  const scoreOf = (c: Candidate): number => {
    const u = maxUsage > 0 ? (usage.get(c) ?? 0) / maxUsage : 0;
    const f = (failureOf.get(c) ?? 0) / maxFailure;
    return SMART_W_USAGE * u + SMART_W_FAILURE * f;
  };
  const scores = new Map(awake.map((c) => [c, scoreOf(c)]));
  awake.sort((a, b) => (scores.get(a) ?? 0) - (scores.get(b) ?? 0));
}

/**
 * `usage`（Least used）：本月用量升序，同量保持声明序。
 * 用量按 1 小时半衰计（magpie `usageHalfLife`，实现与数据来源的偏离见
 * `store/tokenUsage.ts` 的 `decayedMonthTokensOf`）。从没用过的候选 = 0，排最前。
 */
function sortUsage(awake: Candidate[], now: number): void {
  const records = useTokenUsageStore.getState().records;
  sortByNumberAsc(awake, (c) =>
    decayedMonthTokensOf(records, c.profile.id, c.profile.model, now),
  );
}

/**
 * `pace`（Use before expiry 的客户端近似）：本月用量 ÷ 本月已过时间比例，比值小者先。
 *
 * 本仓是客户端，**没有预算/quota 概念**，所以这里只做「花得比时间慢」这一个判断，
 * 不假装知道谁家额度快到期。分母对所有候选相同，因此排序结果与「本月用量升序」一致；
 * 保留这个档的意义是把口径写明白（且将来若引入每候选预算，只改这里）。
 */
function sortPace(awake: Candidate[], now: number): void {
  const records = useTokenUsageStore.getState().records;
  const month = monthKeyOf(new Date(now).toISOString());
  const fraction = monthElapsedFraction(now);
  sortByNumberAsc(awake, (c) =>
    monthTokensOf(records, c.profile.id, c.profile.model, month) / fraction,
  );
}

/**
 * `weight`（magpie `routes.Weighted`）：平滑加权轮询（nginx SWRR 同算法）。
 *
 * 每轮每个醒着的候选 `current += weight`，选 current 最大者（**同值取声明序靠前的**），
 * 选中者 `current -= 总权重`。效果：权重 3:1 的两人在 8 次里被选 6:2 次，且不会
 * 出现「连续 4 次都是同一个人」的突兀分布。轮询状态放模块级 Map（重启清零）。
 * 休息中的候选不参与轮询（它们排在最后，见 `orderCandidates`）。
 */
function sortWeight(awake: Candidate[], ctx: OrderContext, chain: Candidate[]): void {
  const key = rotationKey("weight", ctx, chain);
  let currents = weightStates.get(key);
  if (!currents) {
    currents = new Map<string, number>();
    weightStates.set(key, currents);
  }
  let total = 0;
  let best: Candidate | null = null;
  let bestCurrent = Number.NEGATIVE_INFINITY;
  for (const c of awake) {
    const w = weightOf(c);
    total += w;
    const current = (currents.get(c.mk) ?? 0) + w;
    currents.set(c.mk, current);
    if (current > bestCurrent) {
      bestCurrent = current;
      best = c;
    }
  }
  if (!best) return;
  currents.set(best.mk, (currents.get(best.mk) ?? 0) - total);
  const idx = awake.indexOf(best);
  if (idx > 0) {
    const [chosen] = awake.splice(idx, 1);
    awake.unshift(chosen);
  }
}

/**
 * `fast`（magpie `Fastest`，Speed first）：首 token + 200 token 用时短者先。
 *
 * - 比较键来自 `lib/llmSpeed.ts`（纯内存、20 分钟半衰），
 *   按 `FAST_BUCKET_MS` 分档：同档保持声明序，避免几十毫秒抖动就换人；
 * - **没测过速的排测过的后面**；
 * - **每第 5 个请求**把第一个没测过速的候选提到最前，给它被实测的机会（防饿死）；
 * - 一条测速数据都没有时退化为声明序（新建的链、刚重启后就是这样，可解释）。
 */
function sortFast(awake: Candidate[], ctx: OrderContext, chain: Candidate[]): void {
  const key = rotationKey("fast", ctx, chain);
  const used = (fastCounters.get(key) ?? 0) + 1;
  fastCounters.set(key, used);
  const measured: { candidate: Candidate; bucket: number }[] = [];
  const unmeasured: Candidate[] = [];
  for (const c of awake) {
    const metric = llmSpeed.rankOf(c.profile.id, c.profile.model);
    if (metric === undefined) unmeasured.push(c);
    else measured.push({ candidate: c, bucket: Math.floor(metric / FAST_BUCKET_MS) });
  }
  measured.sort((a, b) => a.bucket - b.bucket); // 同档返回 0 → 稳定排序保持声明序
  awake.splice(0, awake.length, ...measured.map((m) => m.candidate), ...unmeasured);
  if (used % FAST_UNDERDOG_EVERY === 0 && unmeasured.length > 0) {
    const idx = awake.indexOf(unmeasured[0]);
    if (idx > 0) {
      const [chosen] = awake.splice(idx, 1);
      awake.unshift(chosen);
    }
  }
}

/**
 * `rotate`（magpie「In turn」）：醒着的候选按序轮换，休息的跳过。
 *
 * 内存里按组存「下一个该轮到谁」的下标；每次选中后 +1，越过末尾回到 0。
 * 休息的候选不参与轮换（它们排在最后）；全休息时下面的 `resting` 排序接手
 * （仍问最快回来的那个，`probeOne` 语义不动）。
 */
function sortRotate(awake: Candidate[], ctx: OrderContext, chain: Candidate[]): void {
  if (awake.length === 0) return;
  const key = rotationKey("rotate", ctx, chain);
  const next = rotateStates.get(key) ?? 0;
  const idx = next % awake.length;
  rotateStates.set(key, (idx + 1) % awake.length);
  if (idx > 0) {
    const [chosen] = awake.splice(idx, 1);
    awake.unshift(chosen);
  }
}

/**
 * 候选排序（所有选路策略的唯一出口）。
 *
 * 共同结构：先按「是否在休息」分成两段（`restLast`），醒着的那段按策略排序，
 * 休息的那段按「回来早晚」升序拼在后面——**绝不删除任何候选**。
 * 排完后的第一个若正在休息，说明全都休息：仍要问最快回来的那一个（`probeOne`）。
 *
 * 注意：`llmHealth.resting()` 会顺手删掉过期休息行，而 smart 档要读「近期失败」，
 * 所以失败档位必须在分组**之前**读（`llmHealth.failures` 的注释写明了这个顺序约束）。
 */
function orderCandidates(chain: Candidate[], ctx: OrderContext): Candidate[] {
  const strategy = effectiveRouteStrategy(ctx.strategy);
  /** smart 档的「近期失败」：分组前读，否则过期行会被 resting() 清掉。 */
  const failureOf = new Map<Candidate, number>();
  if (strategy === "smart") {
    for (const c of chain) failureOf.set(c, llmHealth.failures(c.ak) + llmHealth.failures(c.mk));
  }
  const awake: Candidate[] = [];
  const resting: Candidate[] = [];
  for (const c of chain) {
    (llmHealth.resting(c.ak, ctx.now) || llmHealth.resting(c.mk, ctx.now) ? resting : awake).push(c);
  }
  switch (strategy) {
    case "smart":
      sortSmart(awake, ctx.now, failureOf);
      break;
    case "usage":
      sortUsage(awake, ctx.now);
      break;
    case "pace":
      sortPace(awake, ctx.now);
      break;
    case "weight":
      sortWeight(awake, ctx, chain);
      break;
    case "fast":
      sortFast(awake, ctx, chain);
      break;
    case "rotate":
      sortRotate(awake, ctx, chain);
      break;
    default:
      break; // order（含认不出的档位）：声明序
  }
  resting.sort((a, b) => {
    const ra = llmHealth.restOf(a.ak, ctx.now)?.until ?? llmHealth.restOf(a.mk, ctx.now)?.until ?? 0;
    const rb = llmHealth.restOf(b.ak, ctx.now)?.until ?? llmHealth.restOf(b.mk, ctx.now)?.until ?? 0;
    return ra - rb;
  });
  return [...awake, ...resting];
}

/**
 * 提示词规模估算（只算文本，口径与 lib/agentContext 的预算一致：宁可高估）。
 * 图片不计：窗口表对未知模型本给保守缺省，再加一层猜测会误筛掉能答的候选——
 * 超了让供应商告诉我们，比我们替它猜要可靠。
 */
function estimatePromptTokens(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += estimateTokens(m.content ?? "") + ROW_TOKEN_OVERHEAD;
    if (m.contentParts) {
      for (const part of m.contentParts) if (part.type === "text") n += estimateTokens(part.text);
    }
    if (m.tool_calls) for (const c of m.tool_calls) n += estimateTokens(c.function.arguments ?? "");
  }
  return n;
}

/**
 * 同一个「供应商×端点×模型」的标识（magpie `roomy` 的 `key(c) = c.p.ID + "\\x00" + c.model`）。
 *
 * magpie 的一个 provider 下挂着多个账号/Key，Heming 的一个 profile 就是一个 Key，
 * 所以这里用 `provider + baseUrl + model` 拼出同物：同一家端点的同一个模型，
 * 换一个 Key 也一样长（gw-fallback.go:1804 `withRoom`：`x.p.ID == c.p.ID && x.model == c.model`）。
 * 未填 baseUrl = 该协议的官方端点，故 provider 必须在键里。
 */
function roomKey(c: Candidate): string {
  const base = (c.profile.baseUrl ?? "").trim().replace(/\/$/, "");
  return `${c.profile.provider}\u0000${base}\u0000${c.profile.model}`;
}

/**
 * `roomy` 预筛：已知窗口装不下这条请求的候选先排除（gw-fallback.go:1850）。
 *
 * 只对**查得到窗口**的模型下手（`lookupCapability` 查不到返回 null，与 magpie
 * `windowOf <= 0` 一律不判同）：能力未知的模型排掉是猜，留下才是本仓的口径。
 * 全排掉时退回整条链——绝不死路。
 */
function withRoom(chain: Candidate[], messages: ChatMessage[], maxTokens?: number): Candidate[] {
  const need = estimatePromptTokens(messages) + (maxTokens ?? 0);
  if (need <= 0) return chain;
  const roomy = chain.filter((c) => {
    const caps = lookupCapability(c.profile.provider, c.profile.model);
    return caps === null || need <= caps.contextWindow;
  });
  return roomy.length > 0 ? roomy : chain;
}

/** 从抛出的错误造分类判据。非 LlmHttpError = 本地守卫（如缺 scheme 的 baseUrl），不冷却不换人。 */
function verdictOf(e: unknown): FailureVerdict {
  if (e instanceof LlmHttpError) {
    return classifyFailure({ status: e.status, body: e.body, retryAfterMs: e.retryAfterMs });
  }
  return { kind: "fatal", rests: false, scope: "account", failover: false };
}

/**
 * 路由版 streamChat：签名与 `streamChat` 兼容，返回全文。
 *
 * 换候选的三条硬规矩（都来自 magpie）：
 * 1. 已经向界面吐出任何正文/思考/工具调用 → 不换，直接抛（否则用户看到两份）；
 * 2. 调用方中止 → 原样抛 DOMException，不判定、不冷却；
 * 3. 供应商没救的（裸 400、内容保护）→ 不换候选，把错误交给调用方。
 */
export async function streamChatRouted(
  profile: LlmProfile,
  messages: ChatMessage[],
  opts: StreamChatOpts,
): Promise<string> {
  const chain = expandChain(profile);
  // 空链 = 路由组成员都被删了（调用方拿到的是 undefined 绑定，这里只兜住竞态）
  if (chain.length === 0) throw new Error("provider_error: 候选链为空（路由组的成员都已删除）");
  // 单候选 = 旧行为，逐字等价（不排序、不预筛、不记账）
  if (chain.length === 1) return streamChat(chain[0].profile, messages, opts);

  const roomy = withRoom(chain, messages);
  const route = (profile as RoutedProfile).route;
  const ordered = orderCandidates(roomy, {
    now: Date.now(),
    strategy: route?.strategy ?? "order",
    groupId: route?.id ?? "single",
  });
  /** 本轮已经说过「太长」的供应商×模型：同一家端点换个 Key 也一样长（`withRoom`）。 */
  const spentRoom = new Set<string>();
  let asks = 0;
  let hop = 0;
  let lastError: unknown = null;

  for (const cand of ordered) {
    if (asks >= MAX_ASKS) break;
    if (spentRoom.has(roomKey(cand))) continue;
    let reasks = 0;
    for (;;) {
      if (opts.signal.aborted) throw new DOMException("AbortError", "AbortError");
      if (asks >= MAX_ASKS) break;
      asks++;

      // magpie `holdWriter.passing`：写出过正文就到此为止，不再换候选
      let surfaced = false;
      /** 这一次调用上报的用量；供应商没上报就是 undefined（不补 0）。 */
      let usage: UsageTotals | undefined;
      /**
       * 测速采集（`fast` 档的数据源）：发起时刻与首 token 时刻。
       * 只算**正文增量**的首个（思考片段不计：不同提供商的上报节奏差别太大，
       * 混在一起会让「首 token 时延」失去可比性）。不改流式语义，只读时间。
       */
      const startedAt = Date.now();
      let firstTokenAt: number | null = null;
      const guarded: StreamChatOpts = {
        ...opts,
        onUsage: (u) => {
          usage = u;
          opts.onUsage?.(u);
        },
        onDelta: (t) => {
          if (firstTokenAt === null) firstTokenAt = Date.now();
          surfaced = true;
          opts.onDelta(t);
        },
        onReasoning: opts.onReasoning
          ? (t) => {
              surfaced = true;
              opts.onReasoning?.(t);
            }
          : undefined,
        onToolCalls: opts.onToolCalls
          ? (calls) => {
              surfaced = true;
              opts.onToolCalls?.(calls);
            }
          : undefined,
      };

      try {
        const text = await streamChat(cand.profile, messages, guarded);
        // 一次成功清两档休息（magpie `served()`→`clearRest` 并删失败计数）
        llmHealth.clear(cand.ak);
        llmHealth.clear(cand.mk);
        // 测速账（纯内存）：只记「成功且拿到首 token」的调用——失败没有速度可言。
        // 按**真实答话的候选**记（profileId×model），不是 route.<gid> 合成档。
        if (firstTokenAt !== null) {
          llmSpeed.record(cand.profile.id, cand.profile.model, {
            ttftMs: firstTokenAt - startedAt,
            outputTokens: usage?.outputTokens,
            elapsedMs: Date.now() - startedAt,
          });
        }
        opts.onAttempt?.({
          profileId: cand.profile.id,
          profileLabel: cand.profile.label,
          model: cand.profile.model,
          ok: true,
          restedMs: 0,
          hop,
          usage,
        });
        hop++;
        return text;
      } catch (e) {
        if (isAbort(e) || opts.signal.aborted) throw e;
        lastError = e;
        const v = verdictOf(e);
        const http = e instanceof LlmHttpError ? e : null;
        const wait = http?.retryAfterMs ?? 0;

        // 瞬时失败先在同一个候选上再问一次（不冷却：magpie `lastRetries` 的 1s/2s 停顿）。
        // 供应商让等超过 LONGEST_PAUSE 就别傻等，直接换下一个（magpie longestPause）。
        if (
          !surfaced &&
          (v.kind === "transient" || v.kind === "cut") &&
          reasks < TRANSIENT_REASKS &&
          wait <= LONGEST_PAUSE &&
          asks < MAX_ASKS
        ) {
          const pause = Math.max(wait, PAUSE_LADDER[Math.min(reasks, PAUSE_LADDER.length - 1)]);
          reasks++;
          await sleep(pause, opts.signal);
          continue;
        }

        const rest = llmHealth.mark(keyForVerdict(cand.profile.id, cand.profile.model, v), v, {
          retryAfterMs: wait,
        });
        if (v.kind === "overflow") spentRoom.add(roomKey(cand));
        opts.onAttempt?.({
          profileId: cand.profile.id,
          profileLabel: cand.profile.label,
          model: cand.profile.model,
          ok: false,
          kind: v.kind,
          status: http?.status ?? 0,
          restedMs: rest ? rest.until - Date.now() : 0,
          error: http?.message ?? String(e),
          hop,
        });
        hop++;

        // 正文已经出去 → 错误原样抛给调用方（休息账照记，magpie `lateRests` 同此）；
        // 判据说不换（裸 400、内容保护）→ 也照原样抛。
        if (surfaced || !v.failover) throw e;
        break; // 换下一个候选（asks 封顶由外层循环头把关）
      }
    }
  }

  if (lastError) throw lastError;
  throw new Error("provider_error: 候选链没有可用成员");
}

/**
 * 智能体绑定 → profile。绑定值是 `route.<id>` 时造出**合成 profile**：
 * 形状与真实连接一致（provider/baseUrl/apiKey/model 取链首），所以既有的
 * 能力判定、历史预算、视觉闸门照常工作；多出来的 `route` 只有路由层读。
 *
 * 不认路由组的旧调用方（staff/llm.ts、memory/reviewRunner.ts、InfoHub 边车）
 * 拿到的是链首连接——能问，只是不会换候选。这是刻意的渐进接入。
 */
export function resolveBoundProfile(agentId: string): RoutedProfile | undefined {
  const store = useLlmStore.getState();
  const ref = store.bindings[agentId];
  if (!ref) return undefined;
  const groupId = parseRouteRef(ref);
  if (!groupId) return store.getProfile(ref);
  const group = store.getRoute(groupId);
  if (!group || group.members.length === 0) return undefined;
  return profileOfRoute(group, store.profiles);
}

/** 用链首成员造合成 profile（id 用 `route.<gid>`，绝不与真实连接冲突）。 */
export function profileOfRoute(
  group: RouteGroup,
  profiles: LlmProfile[],
): RoutedProfile | undefined {
  for (const m of group.members) {
    const p = profiles.find((x) => x.id === m.profileId);
    if (!p) continue;
    return {
      id: `route.${group.id}`,
      label: group.label || p.label,
      provider: p.provider,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model: m.model ?? p.model,
      temperature: p.temperature,
      mask: p.mask,
      route: group,
    };
  }
  return undefined;
}
