/**
 * 供应商失败的分类与换候选判据。
 *
 * 规则整体移植自 magpie（github.com/yetone/magpie，MIT）的
 * `internal/gateway/fallback.go` 与 `internal/gateway/routing.go`：
 * `failure()`（gw-routing.go:476-536）决定「为什么失败」，
 * `retryable()`（gw-fallback.go:1618-1648）决定「换个候选会不会更好」。
 * 词表照抄，不改写——那是它 27k star 踩过的供应商样本。
 * 只砍掉与「订阅账号 + 供应商窗口」有关的部分（Heming 只有 API Key，
 * 读不到 5 小时/周窗口的续期时刻），文末「砍掉了什么」逐条列明。
 */

/** 一次失败的因由。冷却时长与冷却档位由 `llmHealth` 按 kind 决定。 */
export type FailureKind =
  /** 会话太长，超了模型窗口：换个账号也一样长，只排除「这个模型」 */
  | "overflow"
  /** 429 速率限制：短冷却，倍增 */
  | "rate"
  /** 套餐/额度用尽：中冷却 */
  | "quota"
  /** 余额不足（402）：长阶梯冷却，等人充值 */
  | "credit"
  /** Key 或登录态失效（401/403） */
  | "auth"
  /** 供应商要求先验证账号（Google 那类） */
  | "verify"
  /** 账号被供应商限制（需申诉，不是等一等就好） */
  | "restricted"
  /** 这个 Key/套餐不供这个模型、或模型已下架：只有「这个模型」冷却 */
  | "modelGone"
  /** 请求形状这家不认（tools/schema/参数名）：下一个候选可能吃，本候选不冷却 */
  | "shape"
  /** 地域限制：换个出口可能通，本候选不冷却 */
  | "region"
  /** 供应商拒绝这个客户端（不是拒这条请求）：换候选，本候选不冷却 */
  | "refused"
  /** 内容保护机制挡下的（同一条历史每个账号都挡）：谁都不冷却 */
  | "protection"
  /** 上游流被中途掐断的瞬断：原样再问一次，谁都不冷却 */
  | "cut"
  /** 5xx/408/网络不可达：本候选小步重试后冷却 */
  | "transient"
  /** 其余 4xx：请求本身有问题，中止，把错误交给调用方 */
  | "fatal"
  /** 调用方主动中止：不参与任何判定 */
  | "aborted";

/**
 * JSON 转义解码后再匹配词表（magpie `wordsOf`/catalog.Words，#1669）：
 * 网关常把中文错误写成 `\u4f59\u989d\u4e0d\u8db3`，不解码就一条也匹配不上。
 * 错误体在被截断（300 字符）后多半不是合法 JSON，所以逐段替换而不是 JSON.parse。
 */
export function decodeWords(raw: string): string {
  return raw
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\(["/\\])/g, "$1");
}

/* —— 词表：逐条照抄 magpie —— */

/** quotaWords（gw-fallback.go:1370）：状态码不说、正文里说「没额度了/慢点」。 */
const QUOTA_RE =
  /quota|insufficient|balance|credit|billing|out of budget|budget (?:exceeded|exhausted)|exceeded|rate.?limit|usage.?limit|limit.?reached|hit your .*limit|limit.{0,24}resets|too many requests|overloaded|余额|额度|欠费|限流|频率|频繁|速率|套餐|用量|上限/i;

/** creditWords（gw-routing.go:267）：账号/Key 没钱了。 */
const CREDIT_RE =
  /insufficient.?(?:balance|credit|fund)|balance|billing|payment|arrear|overdue|suspended|余额|欠费|充值|账户.*(不足|停)/i;

/** brokeWords（gw-routing.go:273）：429 但其实说的是余额（智谱 1113 那类）。 */
const BROKE_RE = /insufficient.?(?:balance|credit|fund)|\bcredits? (?:are )?exhausted\b|余额不足|欠费|请充值/i;

/** usedUpWords（gw-routing.go:281）：套餐此刻的额度用完了。 */
const USED_UP_RE =
  /quota|usage.?limit|out of budget|budget (?:exceeded|exhausted)|limit.?reached|hit your .*limit|limit.{0,24}resets|exceeded.*(plan|limit)|额度|用量|套餐|上限/i;

/** rateWords（gw-routing.go:288）：429 里说的是每分钟那种快限。 */
const RATE_RE =
  /rate.?limit|frequency.?limit|too many requests|per.?(?:second|sec|minute|min)\b|\b[rt]pm\b|频率|太频繁|过于频繁|速率/i;

/** plannedWords（gw-routing.go:296）：429 里说的是套餐自身的量（按天/周/月）。 */
const PLANNED_RE =
  /quota|usage.?limit|hit your .*limit|limit.{0,24}resets|per.?(?:day|week|month)|daily|weekly|monthly|额度|用量|套餐|限额已用完/i;

/** minuteWords（gw-routing.go:303）：窗口 ≤ 1 分钟，或点名 TPM/RPM。 */
const MINUTE_RE = /per.?(?:second|minute)|per.?(?:sec|min)\b|\b[rt]p[ms]\b|(?:token|call|request) rate limit|每分钟|每秒/i;

/** longWords（gw-routing.go:309）：窗口比一分钟长，或是套餐自身的量。 */
const LONG_RE =
  /usage.?limit|hit your .*limit|limit.{0,24}resets|per.?(?:hour|day|week|month)|\bhours?\b|hourly|daily|weekly|monthly|\b[rt]p[dh]\b|额度已用|用量|套餐|限额已用完|小时|每天|每日|每周|每月/i;

/** retiredWords（gw-fallback.go:1444）：模型在该供应商已下架。 */
const RETIRED_RE =
  /"ModelDeprecated"|model_deprecated|model.{0,80}(?:has been|was|is now|is) (?:deprecated|retired|discontinued|decommissioned|sunset)/i;

/** unservedWords 的通用形（magpie 用 provider.ModelUnserved 按供应商点名，
 *  Heming 没有这份按供应商的表，只能取语义交集：这个 Key/套餐不供这个模型）。 */
const UNSERVED_RE =
  /model.{0,60}(?:is (?:not|no longer) (?:supported|available|served)|not available|not in (?:your|the) (?:plan|token plan|model list))|(?:not (?:supported|available) for this (?:key|plan|account)|does not (?:serve|support) this model|unauthorized to (?:use|access) model|model is not available in the current token plan|切换(?:到)?其他模型|该模型|不支持的模型)/i;

/** otherModels（gw-routing.go:327）：说的是「别的模型还能答」——只冷却这个模型。 */
const OTHER_MODELS_RE = /switch(?:ing)? to (?:the )?other models?|切换(?:到)?其他模型/i;

/** modelCooling（gw-routing.go:335）：池化 Key 的中转说这个模型的凭据都在冷却。 */
const MODEL_COOLING_RE = /credentials for (?:the requested )?model .{0,200}?cooling down/i;

/** shapeWords（gw-fallback.go:1493）：请求形状这家不认（tools/schema/参数）。 */
const SHAPE_RE =
  /failed to deserialize|unknown (?:item |content |input )?(?:type|variant|field|parameter)|unknown_parameter|unrecognized (?:request argument|field|parameter)|extra (?:inputs|fields) are not permitted|additional properties are not allowed|schema exceeds the maximum (?:nesting )?depth|schema[^"]{0,60}\bnesting depth\b|function_declarations\[\d+\]\.parameters/i;

/** refusedWords（gw-fallback.go:1463）：拒的是这个客户端，不是这条请求。 */
const REFUSED_RE = /unapproved channel|illegal api invocation/i;

/** regionWords（gw-fallback.go:1524）：拒的是请求来自哪里。 */
const REGION_RE =
  /\buser location is not supported for the api use\b|unsupported_country_region_territory|country, region,? or territory not supported/i;

/** protectionWords（gw-fallback.go:1544）：内容保护挡下的。 */
const PROTECTION_RE = /response protection is unavailable/i;

/** 上下文超限：沿用本仓既有判据（agentStream.ts:240），补齐 Anthropic 的措辞。 */
const OVERFLOW_RE =
  /context length|context_length|maximum context|too long|reduce the length|prompt is too long|input tokens exceed|exceeds (?:the )?model'?s? (?:context|maximum)/i;

/** 状态码不说、正文说的「要你去做验证」。 */
const VERIFY_RE = /verification (?:is )?required|verify (?:your )?account|account (?:is )?not verified/i;

/** 账号被限制（需申诉）。magpie 按供应商点名（WBRestrictedHint），这里取通用措辞。 */
const RESTRICTED_RE = /account.{0,40}(?:restricted|suspended|banned)|违规|账号.*(受限|封禁)/i;

/** urlWords（gw-routing.go:299）：错误里的链接，它的路径不是供应商说的话。 */
const URL_RE = /https?:\/\/\S+/g;

/** 供应商在错误里自带的「多久之后再来」措辞。 */
const BACK_IN_RE = /(?:try again|retry|comes? back|重置|恢复).{0,20}?in\s*\d+\s*(?:s|ms|秒|min|分钟|hour|小时)|\d+\s*(?:秒|分钟|小时)[后後](?:重试|恢复)/i;

/** 一条 200 里携带的错误，按真实状态码读（magpie `streamStatus` gw-fallback.go:3931）。
 *  overflow 必须先于 quota 词判：`context_length_exceeded` 里的 `exceeded` 会被读成限流（#1944）。 */
export function carriedStatus(status: number, body: string): number {
  if (status < 200 || status >= 400) return status;
  const w = decodeWords(body);
  if (OVERFLOW_RE.test(w)) return 400;
  if (/overloaded/i.test(w)) return 529;
  if (RATE_RE.test(w)) return 429;
  if (/quota|余额不足|额度/i.test(w)) return 402;
  return status;
}

export interface FailureSignal {
  /** HTTP 状态码（200 携带的错误已经过 carriedStatus 定级；网络错传 0）。 */
  status: number;
  /** 错误体原文（供应商返回的 JSON 文本，可能被截断过）。 */
  body: string;
  /** 供应商 Retry-After（毫秒），没有则 0/undefined。 */
  retryAfterMs?: number;
}

const OVERFLOW_CODES = [400, 413, 422, 500, 502, 503, 504];

/** 模型级别的失败只冷却「账号×模型」，账号级别冷却整个账号。 */
export type RestScope = "account" | "model";

export interface FailureVerdict {
  kind: FailureKind;
  /** 要不要冷却（magpie：shape/region/refused/protection/cut/overflow 谁都不冷却）。 */
  rests: boolean;
  /** 冷却到哪个档位。 */
  scope: RestScope;
  /** 换个候选会不会更好（magpie `retryable`）。false = 中止，把错误交给调用方。 */
  failover: boolean;
}

/**
 * 分类一条失败。判定顺序与 magpie `failure()` + `retryable()` 逐段对齐：
 * verify → restricted → overflow → credit/quota → 429 细分（分钟窗口 / 很快回来 / 速率词 / 套餐词）
 * → 5xx → 其余。
 */
export function classifyFailure(signal: FailureSignal): FailureVerdict {
  const status = carriedStatus(signal.status, signal.body);
  const w = decodeWords(signal.body);
  const noUrl = w.replace(URL_RE, ""); // 链接里的词不算供应商说的话
  const retrySaid = (signal.retryAfterMs ?? 0) > 0 || BACK_IN_RE.test(w);

  const verdict = (
    kind: FailureKind,
    over: Partial<Omit<FailureVerdict, "kind">> = {},
  ): FailureVerdict => ({
    kind,
    rests: true,
    scope: "account",
    failover: true,
    ...over,
  });

  // ① 瞬断/保护/形状/地域/拒客：先于一切账号级判定，因为它们不该让账号冷却
  if (OVERFLOW_RE.test(w) && OVERFLOW_CODES.includes(status)) {
    // 会话对这个模型就是太长：每个账号都一样长（magpie :1623 不冷却、不换账号），
    // 但换组里窗口更大的模型值得试（`roomy`/`withRoom`）。
    return verdict("overflow", { rests: false, scope: "model", failover: true });
  }
  if (PROTECTION_RE.test(w)) {
    return verdict("protection", { rests: false, failover: false });
  }
  if (status >= 400 && REGION_RE.test(w)) {
    return verdict("region", { rests: false });
  }
  if (REFUSED_RE.test(w)) {
    return verdict("refused", { rests: false });
  }

  // ② 要人去做动作才回得来的：验证 / 限制
  if (VERIFY_RE.test(w) && (status === 401 || status === 403)) return verdict("verify");
  if (status >= 400 && RESTRICTED_RE.test(w)) return verdict("restricted");

  // ③ 只有 401 的 Key 失效：401 也可能是「这个模型它不供」（OpenCode Zen 那类）
  if (status === 401 && UNSERVED_RE.test(w)) {
    return verdict("modelGone", { scope: "model" });
  }

  // ④ 模型层面的拒绝：下架 / 不供 / 别的模型还能答 / 该模型的凭据全在冷却
  if (
    [400, 404, 410, 422].includes(status) &&
    (RETIRED_RE.test(w) || (UNSERVED_RE.test(w) && !QUOTA_RE.test(w)))
  ) {
    return verdict("modelGone", { scope: "model" });
  }
  if (
    [400, 403, 404, 422].includes(status) &&
    UNSERVED_RE.test(w) &&
    !QUOTA_RE.test(w) &&
    !REFUSED_RE.test(w)
  ) {
    return verdict("modelGone", { scope: "model" });
  }
  if (MODEL_COOLING_RE.test(w) || (OTHER_MODELS_RE.test(w) && status >= 400)) {
    return verdict("modelGone", { scope: "model" });
  }

  // ⑤ 形状问题：下一个候选可能吃，本候选没错，不冷却
  if ((status === 400 || status === 422) && SHAPE_RE.test(w) && !QUOTA_RE.test(w) && !CREDIT_RE.test(w)) {
    return verdict("shape", { rests: false });
  }

  // ⑥ 钱与额度
  if (status === 402 && USED_UP_RE.test(w) && !CREDIT_RE.test(w) && !/insufficient_quota/.test(w)) {
    return verdict("quota");
  }
  if (status === 402 || (CREDIT_RE.test(w) && (status !== 429 || BROKE_RE.test(w))) || /insufficient_quota/.test(w)) {
    return verdict("credit");
  }

  // ⑦ 429 的四种读法
  if (status === 429) {
    if (retrySaid) return verdict("quota"); // 说了什么时候回来的，就按它说的等
    if (minuteLimit(w)) return verdict("rate");
    if (RATE_RE.test(w) && !PLANNED_RE.test(noUrl)) return verdict("rate");
    if (USED_UP_RE.test(w) || PLANNED_RE.test(w)) return verdict("quota");
    return verdict("rate");
  }

  // ⑧ 服务端故障与网络不可达
  if (status >= 500 || status === 408 || status === 0) {
    if (status >= 500 && USED_UP_RE.test(w)) return verdict("quota");
    return verdict("transient");
  }
  if (status < 400) return verdict("transient");

  // ⑨ 兜底：4xx 的其余一律中止（magpie `retryable` 对裸 400 返回 false）
  if (status === 401 || status === 403 || status === 404) {
    return verdict(status === 404 ? "modelGone" : "auth", { scope: status === 404 ? "model" : "account" });
  }
  return verdict("fatal", { rests: false, failover: false });
}

/** minuteLimit（gw-routing.go:~1690）：窗口 ≤ 1 分钟，且没有更长的窗口或花光的余额 beside it。 */
function minuteLimit(body: string): boolean {
  const noUrl = body.replace(URL_RE, "");
  return MINUTE_RE.test(noUrl) && !LONG_RE.test(noUrl) && !BROKE_RE.test(noUrl) && !/insufficient_quota/.test(noUrl);
}

/**
 * 「换个候选会不会更好」——magpie `retryable()` 的同物。
 * overflow 与裸 4xx 的答案是否：前者的历史在每个账号上都一样长（交给调用方去压缩），
 * 后者是请求本身的问题。
 */
export function retryable(v: FailureVerdict): boolean {
  return v.failover;
}

/**
 * 把 `provider_error: HTTP 429 {...}` 这类**供应商原文**翻成用户能看懂的一句话。
 *
 * 为什么在展示层做（而不是改写 `agentStream` 落库的 message）：
 * - 已存消息里还是原文，旧数据也一起变好，不需要迁移；
 * - 分类词表（`classifyFailure`）仍按原文工作，界面不该反过来影响路由判据；
 * - 原文不丢：调用方把它放 `title`，需要排障的人仍能看到状态码与响应片段。
 *
 * 只认两种形状：`provider_error: HTTP <status> <body>` 与 `provider_error: <body>`；
 * 其它错误（超时提示、内容无法解密等）原样返回，避免把已有文案再次翻译走样。
 */
export function humanizeProviderError(raw: string): string {
  const text = (raw ?? "").trim();
  if (!text) return "生成失败，请重试。";
  if (text === "未绑定 LLM 连接") {
    return "这个智能体还没有绑定模型连接，请先到「设置 → 模型」选一条连接。";
  }
  /** 中文错误体里通常带着「哪一步不对」：能显示就显示，比套通用提示有用。 */
  const hasCjk = (s: string) => /[\u4e00-\u9fff]/.test(s);
  const detailOf = (s: string) => {
    const body = decodeWords(s).replace(/\s+/g, " ").trim();
    return hasCjk(body) && body.length <= 160 ? `服务商说明：${body}` : "";
  };

  const http = text.match(/^provider_error:\s*HTTP\s+(\d{3})\b/i);
  if (http) {
    const status = Number(http[1]);
    const body = text.slice(http[0].length).trim();
    // 状态码能直接定位的，先用状态码：语义比词表更确定
    const direct =
      status === 401 || status === 403
        ? "模型服务鉴权失败：请到「设置 → 模型」检查 API Key 是否正确、是否有权限。"
        : status === 404
          ? "接口地址找不到：请检查 Base URL（通常以 /v1 结尾）。"
          : status === 408
            ? "模型服务响应超时：请稍后重试。"
            : "";
    if (direct) return `${direct}（HTTP ${status}）`;

    // 其余交给已有的失败分类（与路由/冷却共用一套判据）——否则「上下文太长」「余额不足」
    // 这类真实高频错误会被统一翻成「模型名或参数不支持」，给错建议。
    const kind = classifyFailure({ status, body, retryAfterMs: 0 }).kind;
    const hint: Partial<Record<FailureKind, string>> = {
      overflow: "这轮对话太长了，超出模型能读的长度：请缩短上下文或新建对话。",
      credit: "模型服务余额不足：请先到服务商充值后再试。",
      quota: "模型服务的额度已用完：请稍后重试或检查套餐额度。",
      rate: "请求太频繁：稍等片刻再试。",
      auth: "模型服务鉴权失败：请到「设置 → 模型」检查 API Key 与权限。",
      verify: "模型服务要求先验证账号：请到服务商完成验证。",
      restricted: "账号被服务商限制：需要到服务商申诉或更换账号。",
      modelGone: "这个模型在服务商处不可用：请换一个模型或连接。",
      shape: "服务商不接受这个请求格式：可尝试更换模型，或先关闭工具再试。",
      region: "当前地区不支持该服务商：请更换网络出口或服务商。",
      refused: "服务商拒绝了这个客户端：请更换连接方式。",
      protection: "内容被服务商的安全策略拦下：请改写后重试。",
      cut: "模型响应被中途中断：请重试。",
      transient: "模型服务暂时不可用：请稍后重试。",
      fatal: "请求被服务商拒绝。",
      aborted: "生成已停止。",
    };
    const detail = detailOf(body);
    const base = hint[kind] ?? "模型请求失败。";
    return `${base}${detail ? `（${detail}）` : ""}（HTTP ${status}）`;
  }
  if (/^provider_error:/i.test(text)) {
    const body = text.replace(/^provider_error:\s*/i, "");
    const detail = detailOf(body);
    if (detail) return `${detail}。`;
    return "连不上模型服务：请检查网络与 Base URL 后重试。";
  }
  return text;
}

