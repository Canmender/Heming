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
 * 与 magpie 的两处有意差异（都在下面标注了）：① 一次请求最多发 6 个 HTTP
 * （magpie 不设上限，浏览器侧用户是在等，必须有上限）；② 401/403/404 无特殊措辞时
 * 统一按 auth/modelGone 冷却，magpie 是按供应商点名的 hint 判定的。
 */

import { estimateTokens, ROW_TOKEN_OVERHEAD } from "./agentContext/tokens.js";
import { lookupCapability } from "./modelCaps.js";
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

/** 成员 → 真实 profile（引用不存在的成员跳过）；成员上的 model 覆盖生效。 */
function toCandidate(profile: LlmProfile, modelOverride?: string): Candidate | null {
  if (!profile) return null;
  const effective: LlmProfile = modelOverride
    ? { ...profile, model: modelOverride, id: profile.id }
    : profile;
  return {
    profile: effective,
    ak: accountKey(effective.id),
    mk: modelKey(effective.id, effective.model),
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
    const c = toCandidate(p, m.model);
    if (c) out.push(c);
  }
  return out;
}

/**
 * 参考价键（`cheap` 档用）：input+output 单价之和，元/百万 token。
 *
 * 为什么用「两侧相加」这种粗口径：一次请求的输入/输出比例事先不知道，
 * 拿比例去加权等于猜；两侧相加只保留「哪家更贵」这个单调关系，排序用途够了。
 * 查不到价目返回 Infinity = 排到最后——不猜它便宜，也不删它（绝不死路）。
 */
function priceKey(c: Candidate): number {
  const pricing = lookupCapability(c.profile.provider, c.profile.model)?.pricing;
  return pricing ? pricing.input + pricing.output : Number.POSITIVE_INFINITY;
}

/**
 * 顺序：声明顺序为准，休息中的排到最后但**不删除**（magpie `restLast` + `probeOne`）。
 * 排完后的第一个若正在休息，说明全都休息——仍要问最快回来的那一个。
 *
 * `cheap` 档（d.48）：醒着的那一批改按参考价从便宜到贵（`priceKey` 稳定排序，
 * 同价保持声明顺序）；休息的仍排最后——省钱的优先级排在「现在能不能答」之后。
 */
function orderCandidates(chain: Candidate[], now: number, strategy: RouteStrategy): Candidate[] {
  const awake: Candidate[] = [];
  const resting: Candidate[] = [];
  for (const c of chain) {
    (llmHealth.resting(c.ak, now) || llmHealth.resting(c.mk, now) ? resting : awake).push(c);
  }
  if (strategy === "cheap") awake.sort((a, b) => priceKey(a) - priceKey(b));
  resting.sort((a, b) => {
    const ra = llmHealth.restOf(a.ak, now)?.until ?? llmHealth.restOf(a.mk, now)?.until ?? 0;
    const rb = llmHealth.restOf(b.ak, now)?.until ?? llmHealth.restOf(b.mk, now)?.until ?? 0;
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

  const roomy = withRoom(chain, messages, opts.maxTokens);
  const ordered = orderCandidates(roomy, Date.now(), (profile as RoutedProfile).route?.strategy ?? "order");
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
      const guarded: StreamChatOpts = {
        ...opts,
        onUsage: (u) => {
          usage = u;
          opts.onUsage?.(u);
        },
        onDelta: (t) => {
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
