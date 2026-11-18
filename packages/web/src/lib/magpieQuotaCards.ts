/**
 * 额度总览：内核 `quota --json` 的 `provider.Quota` 卡片。
 *
 * `accounts --json` 只讲订阅账号；按量付费的 Key、套餐（plan）与钱包余额只出现在
 * 这里。页面原先完全看不到它们——用户在别处买的 Key 花到哪儿去了、还剩多少，
 * 得开终端敲命令才知道。
 *
 * 订阅（`kind: "subscription"`）不在这里画：它们已经在「订阅账号」卡里按账号
 * 列过了，重复画一遍只会让同一份额度看起来像两份。
 */
import {
  parseQuotaWindows,
  parseResets,
  windowLeftPercent,
  windowLeftText,
  windowTone,
  type QuotaTone,
  type QuotaWindow,
} from "./magpieQuota.js";

export interface BalancePart {
  label: string;
  text: string;
  percent?: number;
  error?: string;
}

export interface QuotaCard {
  /** 内核里的 provider id，例如 `deepseek`。 */
  provider: string;
  /** 给人看的名号，例如 `DeepSeek`。 */
  name: string;
  /** `subscription` / `plan` / `balance`，内核将来加了新值也照原样带过来。 */
  kind: string;
  plan?: string;
  user?: string;
  windows: QuotaWindow[];
  /** 一个数说不完的余额（例如「5h 0% · week 3.4% · $70.00」）。 */
  balance?: string;
  balanceSplit: BalancePart[];
  /** 几个 Key 共用的余额。 */
  sharedBalance?: string;
  /** 这一次没读到的原因。 */
  error?: string;
  /** 余额/套餐什么时候到期。 */
  until?: string;
  /** 下次自动续期。 */
  renew?: string;
  /** 卡里这份额度是不是当前实际在用的那一个。 */
  last: boolean;
  /** 这一份是哪来的（导入、Key、订阅…）。 */
  from?: string;
  alias?: string;
  seat?: string;
  readAt?: string;
  asOf?: string;
  resets?: { count: number; until?: string };
}

function str(item: Record<string, unknown>, key: string): string {
  const value = item[key];
  return typeof value === "string" ? value.trim() : "";
}

function parseBalancePart(value: unknown): BalancePart | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const text = str(item, "text");
  const error = str(item, "error");
  if (!text && !error) return null;
  const percent =
    typeof item.percent === "number" && Number.isFinite(item.percent) ? item.percent : undefined;
  return {
    label: str(item, "label"),
    text,
    ...(percent === undefined ? {} : { percent }),
    ...(error ? { error } : {}),
  };
}

/** 一行 JSON → 一张卡；缺 `provider`/`name` 的行不成卡。 */
export function parseQuotaCard(value: unknown): QuotaCard | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const provider = str(item, "provider");
  const name = str(item, "name") || provider;
  if (!provider && !name) return null;
  const split = Array.isArray(item.balanceSplit)
    ? item.balanceSplit
        .map(parseBalancePart)
        .filter((part): part is BalancePart => part !== null)
    : [];
  const readAt = str(item, "readAt");
  const asOf = str(item, "asOf");
  const until = str(item, "until");
  const renew = str(item, "renew");
  const from = str(item, "from");
  const alias = str(item, "alias");
  const seat = str(item, "seat");
  const plan = str(item, "plan");
  const user = str(item, "user");
  const error = str(item, "error");
  const balance = str(item, "balance");
  const sharedBalance = str(item, "sharedBalance");
  const resets = parseResets(item.resets);
  return {
    provider: provider || name,
    name,
    kind: str(item, "kind") || "balance",
    ...(plan ? { plan } : {}),
    ...(user ? { user } : {}),
    windows: parseQuotaWindows(item.windows),
    ...(balance ? { balance } : {}),
    balanceSplit: split,
    ...(sharedBalance ? { sharedBalance } : {}),
    ...(error ? { error } : {}),
    ...(until ? { until } : {}),
    ...(renew ? { renew } : {}),
    last: item.last === true,
    ...(from ? { from } : {}),
    ...(alias ? { alias } : {}),
    ...(seat ? { seat } : {}),
    ...(readAt ? { readAt } : {}),
    ...(asOf ? { asOf } : {}),
    ...(resets ? { resets } : {}),
  };
}

export function parseQuotaCards(stdout: string): QuotaCard[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data
    .map(parseQuotaCard)
    .filter((card): card is QuotaCard => card !== null);
}

/** 订阅以外的来源：Key、套餐、钱包余额。订阅由「订阅账号」卡负责。 */
export function nonSubscriptionCards(cards: readonly QuotaCard[]): QuotaCard[] {
  return cards.filter((card) => card.kind !== "subscription");
}

export function quotaKindLabel(kind: string): string {
  switch (kind) {
    case "plan":
      return "套餐";
    case "balance":
      return "余额";
    case "subscription":
      return "订阅";
    default:
      return kind;
  }
}

/** 这张卡的一句话结论：余额优先，其次最紧的窗口，再其次「没读到」。 */
export function cardSummary(card: QuotaCard, now: number): string {
  if (card.error) return "这次没读到";
  if (card.kind === "balance" && card.balance) return card.balance;
  if (card.balanceSplit.length > 0) {
    const failing = card.balanceSplit.find((part) => part.error);
    if (failing) return `${failing.label || card.name} 这次没读到`;
    return card.balanceSplit.map((part) => part.text).join(" · ");
  }
  const windows = card.windows.filter((window) => !window.unlimited || window.display);
  if (windows.length === 0) return "";
  const tightest = windows.reduce((worst, window) =>
    windowLeftPercent(window) < windowLeftPercent(worst) ? window : worst,
  );
  return windowLeftText(tightest);
}

/**
 * 这张卡该用什么颜色说（d.340）：跟着最紧的那份窗口走。
 *
 * 给定一个 provider 的额度时，来源行上只放一枚小徽标，颜色就是这句话的轻重：
 * 见底红、偏紧黄、其余中性。读不到不装作「还宽裕」，按红走。
 */
export function cardTone(card: QuotaCard): QuotaTone {
  if (card.error) return "danger";
  const windows = card.windows.filter((window) => !window.unlimited && !window.text);
  if (windows.length === 0) return "ok";
  const tightest = windows.reduce((worst, window) =>
    windowLeftPercent(window) < windowLeftPercent(worst) ? window : worst,
  );
  return windowTone(tightest);
}
