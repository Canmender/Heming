/**
 * 订阅额度的读法（模型页「来源 → 订阅账号」）。
 *
 * 内核 `accounts --json` 给的是机器字段：窗口名是英文（"5 hours" / "7 days" /
 * "Week"）、用量是浮点百分比、重置时间与读数时间是 RFC3339 时间戳，
 * 读不到现行值时还带一个「上次读数」。页面上要的是
 * 「5 小时 · 剩 18% · 3 小时后重置」，这一层就是那一步翻译。
 *
 * 全是纯函数：时间由调用方传 `now`，单测可以不碰真实时钟；
 * `quota` 视图以后要用同一套文案，也直接复用这里。
 */

/** 一个额度窗口（内核 `provider.QuotaSpan` 的页面侧形状）。 */
export interface QuotaWindow {
  /** 内核的窗口名，英文原样（`windowName` 负责翻译）。 */
  name: string;
  /** 不限量（订阅没设上限）。 */
  unlimited: boolean;
  /** 已用百分比 0-100。 */
  used: number;
  /** 剩余百分比 0-100。 */
  remaining: number;
  /** 这个窗口什么时候重新开始（ISO 时间）。 */
  resetsAt: string | null;
  /** 厂商自己的写法："1.2k / 3k"、"In use"、"$3.40"。 */
  display: string;
  /** `display` 是一句话而不是用量（例如 "In use"），此时不按百分比读。 */
  text: boolean;
  amount: number | null;
  limit: number | null;
  unit: string;
  /** 共享池的名字（Gemini 的额度是几个窗口共用一个池）。 */
  pool: string;
  /** 按当前速度大概什么时候用完。 */
  runsOutAt: string | null;
  balance: number | null;
}

/** 空窗口：解析时缺失的字段用它兜底，页面不判 undefined。 */
export function emptyWindow(): QuotaWindow {
  return {
    name: "",
    unlimited: false,
    used: 0,
    remaining: 100,
    resetsAt: null,
    display: "",
    text: false,
    amount: null,
    limit: null,
    unit: "",
    pool: "",
    runsOutAt: null,
    balance: null,
  };
}

/**
 * 订阅账号的显示名。与 `ModelPage` 的登录卡片保持一致：
 * 页面按「用户订的那个产品」叫人，不把内核的 agent id 摊出来。
 */
const AGENT_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "ChatGPT",
  copilot: "Copilot",
  gemini: "Gemini",
  antigravity: "Antigravity",
  zed: "Zed",
  factory: "Factory",
  mimo: "MiMo",
  grok: "Grok",
};

export function agentName(agent: string): string {
  const key = agent.trim().toLowerCase();
  return AGENT_LABELS[key] ?? (agent.trim() || "账号");
}

/** 内核把纳秒小数也写进时间戳（"…T12:00:00.123456789Z"），Date 只认到毫秒。 */
export function parseTime(text: string | null | undefined): number | null {
  if (!text) return null;
  const trimmed = text.trim().replace(/\.(\d{3})\d+/, ".$1");
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 窗口名翻译。内核里出现的英文名是 "5 hours" / "7 days" / "Week" / "Month" /
 * "Credits" / "Extra usage"，插件还可能报自己的名字——认不出来的原样显示，
 * 不要硬翻成「额度 1」。
 */
const WINDOW_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(\d+)\s*(?:hours?|h)$/i, "$1 小时"],
  [/^(\d+)\s*(?:days?|d)$/i, "$1 天"],
  [/^(\d+)\s*weeks?$/i, "$1 周"],
  [/^week(?:ly)?$/i, "每周"],
  [/^month(?:ly)?$/i, "每月"],
  [/^day$/i, "每天"],
  [/^credits?$/i, "点数"],
  [/^extra usage$/i, "额外用量"],
  [/^allowance$/i, "预算"],
  [/^balance$/i, "余额"],
];

export function windowName(name: string): string {
  const text = name.trim();
  if (!text) return "额度";
  for (const [pattern, label] of WINDOW_NAMES) {
    const matched = pattern.exec(text);
    if (matched) return label.replace("$1", matched[1] ?? "");
  }
  return text;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** 已用百分比：内核两个都给，缺一个就用另一个补，最后夹到 0-100。 */
export function windowPercent(window: QuotaWindow): number {
  const used = Number.isFinite(window.used) ? window.used : 100 - window.remaining;
  return clampPercent(used);
}

export function windowLeftPercent(window: QuotaWindow): number {
  const left = Number.isFinite(window.remaining) ? window.remaining : 100 - window.used;
  return clampPercent(left);
}

export type QuotaTone = "ok" | "warn" | "danger";

/**
 * 剩余多少算紧张：10% 以下标红，25% 以下标黄。
 * 阈值按「还剩多少」而不是「用了多少」定——满额的新账号不该因为 0% 已用而报警。
 */
export function windowTone(window: QuotaWindow): QuotaTone {
  if (window.unlimited) return "ok";
  const left = windowLeftPercent(window);
  if (left <= 10) return "danger";
  if (left <= 25) return "warn";
  return "ok";
}

/** 窗口左侧的结论文字：剩多少、不限、或者厂商自己那句话。 */
export function windowLeftText(window: QuotaWindow): string {
  if (window.unlimited) return "不限";
  if (window.text && window.display.trim()) return window.display.trim();
  const left = windowLeftPercent(window);
  return left <= 0 ? "已用完" : `剩 ${left}%`;
}

/** 距现在多久：1 分钟 / 2 小时 5 分钟 / 3 天。用于重置与读数。 */
export function formatDuration(spanMs: number): string {
  if (!Number.isFinite(spanMs) || spanMs <= 0) return "";
  // 向下取整：59 秒与 30 秒都还不到 1 分钟，不该被四舍五入说成「1 分钟」。
  const minutes = Math.floor(spanMs / 60_000);
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

/** 相对时间（"2 分钟前"）；读不出来 / 还没到就回空串。 */
export function relativeTime(text: string | null | undefined, now: number): string {
  const at = parseTime(text);
  if (at === null) return "";
  const age = now - at;
  if (age < 60_000) return "刚刚";
  return `${formatDuration(age)}前`;
}

/** 窗口什么时候重新开始：「3 小时后重置」；已经过了就是「马上重置」。 */
export function formatResetIn(resetsAt: string | null | undefined, now: number): string {
  const at = parseTime(resetsAt);
  if (at === null) return "";
  if (at <= now) return "马上重置";
  const span = formatDuration(at - now);
  return span ? `${span}后重置` : "";
}

/** 读数时间：内核读现行值时给 readAt，读不到时给上一次的 asOf。 */
export function formatReadAt(
  readAt: string | null | undefined,
  asOf: string | null | undefined,
  now: number,
): string {
  const fresh = relativeTime(readAt, now);
  if (fresh) return `读数 ${fresh}`;
  const stale = relativeTime(asOf, now);
  if (stale) return `上次读数 ${stale}`;
  return "";
}

/** 窗口那行右侧的小字：厂商的用量写法 + 重置倒计时，用「·」接。 */
export function windowDetailText(window: QuotaWindow, now: number): string {
  const parts: string[] = [];
  const display = window.display.trim();
  if (display && !(window.text && display === windowLeftText(window))) parts.push(display);
  if (window.unlimited) return parts.join(" · ");
  const reset = formatResetIn(window.resetsAt, now);
  if (reset) parts.push(reset);
  return parts.join(" · ");
}

/** Codex 手里攥着的 rate-limit reset 还能花几次。 */
export function resetsText(
  resets: { count: number; until?: string } | undefined,
  now: number,
): string {
  if (!resets || resets.count <= 0) return "";
  // `until` 是将来某刻就作废的截止时间，得按「还有多久」读，不能当过去的读数算。
  const until = parseTime(resets.until);
  const due =
    until === null ? "" : until > now ? `${formatDuration(until - now)}后到期` : "已经到期";
  return due ? `可手动重置 ${resets.count} 次（${due}）` : `可手动重置 ${resets.count} 次`;
}

export interface AccountState {
  tone: "info" | "muted" | "danger";
  label: string;
  /** 悬停/读屏用的完整解释：徽标只有两个字，原因写在这里。 */
  detail: string;
}

/** 账号状态：读不到 > 登录失效 > 在用 > 排队接手 > 备用。 */
export function accountState(row: {
  active: boolean;
  on: boolean;
  lapsed?: string;
  error?: string;
}): AccountState {
  if (row.error) return { tone: "danger", label: "读不到", detail: row.error };
  if (row.lapsed) {
    return {
      tone: "danger",
      label: "登录失效",
      detail: row.lapsed || "登录已经过期，重新登录一次就好",
    };
  }
  if (row.active && row.on) {
    return { tone: "info", label: "在用", detail: "这个智能体现在登录的就是它，走它的额度" };
  }
  if (row.on) {
    return { tone: "info", label: "接手", detail: "当前账号额度用完时，自动换到它" };
  }
  if (row.active) return { tone: "muted", label: "已登录", detail: "已登录，暂时没在用它" };
  return { tone: "muted", label: "备用", detail: "多个账号自动分担，轮到它时换过来" };
}

/** 至少有一个窗口读到用量；全空时页面只说「额度未知」，不画空进度条。 */
export function hasQuota(windows: readonly QuotaWindow[] | undefined): boolean {
  return Boolean(windows && windows.length > 0);
}

/** 卡头那句「最近一次读数」：取所有账号里最新的一个。 */
export function latestReadAt(
  rows: ReadonlyArray<{ readAt?: string; asOf?: string }>,
  now: number,
): string {
  let newest: number | null = null;
  for (const row of rows) {
    const at = parseTime(row.readAt) ?? parseTime(row.asOf);
    if (at === null) continue;
    if (newest === null || at > newest) newest = at;
  }
  if (newest === null) return "";
  const rel = now - newest < 60_000 ? "刚刚" : `${formatDuration(now - newest)}前`;
  return `最近读数 ${rel}`;
}
