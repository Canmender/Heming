/**
 * 国产智能体端（模型页 → 来源 → 订阅账号 的第二组）：国内站与国际站的账号都在这张表里。
 *
 * 这些端不像 Claude、ChatGPT 那样有面向第三方的接入：免费额度挂在账号里——
 * WorkBuddy 每天签到给点数、Qoder 每天给一份额度——所以「用它们的额度」等于
 * 「让和鸣认这个账号」。内核把它们当订阅账号读（`accounts` / `quota`），
 * 但它们的账号由社区插件供给：内核自己的登录流只认 Claude/ChatGPT/Copilot/
 * Gemini/Antigravity，所以先装插件、再登录。
 *
 * 这张表只放内核确认过的 id 与包名：`internal/provider/migrate_*.go` 里 movers 的
 * pkg，以及没有 mover、只在 `internal/provider/*_checkin.go` 里写明插件包的那几个端
 * （Trae CN、MiniMax Code）。不猜名字：猜错的名字会被当成 npm 上的同名包装进来。
 * 真正的账号与额度仍然只从 `accounts --json` 读，这里不复制内核的判断。
 */

/** 卡片归哪一组：同一个包服务的两个站（国内站 / 国际站）分开列。 */
export type DomesticSite = "cn" | "intl";

export interface DomesticAgent {
  /** 内核 agent id，也是 `accounts --json` 里的 `agent`。 */
  agent: string;
  /** 社区插件的 npm 包名（内核 movers 表或签到实现里那个）。 */
  pkg: string;
  label: string;
  desc: string;
  /** 站点：国内站或国际站（同一个包的另一个端）。 */
  site: DomesticSite;
  /** 支持每日签到（`magpie accounts checkin`）。 */
  checkin: boolean;
  /** 登录前必须说的事实（内核风险提示的中文说法）。 */
  risk?: string;
}

export const DOMESTIC_AGENTS: readonly DomesticAgent[] = [
  {
    agent: "workbuddy",
    pkg: "@magpie-community/opencode-workbuddy-auth",
    label: "WorkBuddy",
    desc: "腾讯 · 每天签到领点数",
    site: "cn",
    checkin: true,
    risk: "腾讯可能封禁在 WorkBuddy 之外使用的账号，国际版 WorkBuddy AI 已有先例；建议用不心疼的号。",
  },
  {
    agent: "qoder-cn",
    pkg: "@magpie-community/opencode-qoder-auth",
    label: "Qoder CN",
    desc: "阿里 · 每天领免费额度",
    site: "cn",
    checkin: true,
  },
  {
    agent: "trae-cn",
    pkg: "@magpie-community/opencode-trae-auth",
    label: "Trae CN",
    desc: "字节 · 每天领免费额度",
    site: "cn",
    checkin: true,
  },
  {
    agent: "minimax-code",
    pkg: "@magpie-community/opencode-minimax-auth",
    label: "MiniMax Code",
    desc: "MiniMax · 每天领免费额度",
    site: "cn",
    checkin: true,
  },
  {
    agent: "mimo",
    pkg: "@magpie-community/opencode-mimo-auth",
    label: "MiMo Code",
    desc: "小米",
    site: "cn",
    checkin: false,
  },
  {
    agent: "zcode",
    pkg: "@magpie-community/opencode-zcode-auth",
    label: "ZCode",
    desc: "智谱",
    site: "cn",
    checkin: false,
  },
  {
    agent: "workbuddy-ai",
    pkg: "@magpie-community/opencode-workbuddy-auth",
    label: "WorkBuddy AI",
    desc: "腾讯 · 每天签到领点数",
    site: "intl",
    checkin: true,
    risk: "已有账号因为经别的智能体调用被封，风险比国内版更高。",
  },
  {
    agent: "qoder",
    pkg: "@magpie-community/opencode-qoder-auth",
    label: "Qoder",
    desc: "阿里 · 每天领免费额度",
    site: "intl",
    checkin: true,
  },
  {
    agent: "minimax-code-global",
    pkg: "@magpie-community/opencode-minimax-auth",
    label: "MiniMax Code（国际）",
    desc: "MiniMax · 每天领免费额度",
    site: "intl",
    checkin: true,
  },
];

/**
 * 页面上的两个小标题：9 张卡里 3 张是国际站，一排排下来分不清谁对谁，
 * 按站分组比在每行 desc 里重复「国内站/国际站」更好扫。
 */
export const DOMESTIC_GROUPS: readonly { site: DomesticSite; title: string; items: readonly DomesticAgent[] }[] = [
  { site: "cn", title: "国内站", items: DOMESTIC_AGENTS.filter((item) => item.site === "cn") },
  { site: "intl", title: "国际站", items: DOMESTIC_AGENTS.filter((item) => item.site === "intl") },
];

/**
 * 走 API Key 的国内端不在这张表里：Qwen Code、Kimi Code 这些是「Key / 套餐」，
 * 在下面的「加一个其他地址」里加，占的是供应商，不是订阅账号。
 * （MiniMax Code 以前也在这句话里，内核的账号插件已经覆盖它，改成卡片了。）
 */
export const DOMESTIC_KEY_NOTE =
  "Qwen Code、Kimi Code 这些走 Key 或套餐的端不在账号里：点下面的「加一个其他地址」填它们的 Key。";

/** 能签到的端（`accounts checkin` 覆盖的范围），空状态的说明里点一下名。 */
export const CHECKIN_VENDORS = "WorkBuddy、Qoder、Trae CN、MiniMax Code";

/**
 * `plugin list --json` 里插件服务的 provider id。
 *
 * 内核的插件清单是一个对象（plugins / loaded / providers / middleware），
 * 没有插件时是一行 `[]`。页面只关心「哪些 agent 有插件在服务」：没有它，
 * `accounts add <agent>` 会答「magpie can't sign in to … accounts」。
 */
export function parsePluginProviders(stdout: string): Set<string> {
  const providers = new Set<string>();
  const text = stdout.trim();
  if (!text) return providers;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return providers;
  }
  const list =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).providers
      : parsed;
  if (!Array.isArray(list)) return providers;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = (item as Record<string, unknown>).id;
    if (typeof id === "string" && id.trim()) providers.add(id.trim());
  }
  return providers;
}

/** 一次签到的结果（内核 `provider.WorkBuddyCheckin` 的页面侧形状）。 */
export interface CheckinEntry {
  /** 账号名；内核没给时是空串。 */
  user: string;
  /** 哪个端的签到：空串＝WorkBuddy，"trae"＝Trae CN，"plugin:<id>"＝插件。 */
  vendor: string;
  /** claimed / done / ineligible / inactive / captcha / own-app / failed。 */
  outcome: string;
  /** 领到多少（点数或额度）。 */
  credit: number;
  /** 连续签到天数。 */
  streak: number;
  /** 厂商或插件给的原因。 */
  msg: string;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 签到的结果行；坏 JSON / 非数组都当「没有结果」，不抛。 */
export function parseCheckin(stdout: string): CheckinEntry[] {
  const text = stdout.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item): CheckinEntry[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const outcome = readString(record.outcome);
    if (!outcome) return [];
    return [
      {
        user: readString(record.user),
        vendor: readString(record.by) || readString(record.vendor),
        outcome,
        credit: readNumber(record.credit),
        streak: readNumber(record.streak),
        msg: readString(record.msg),
      },
    ];
  });
}

/** 哪个端：WorkBuddy 的 `by` 是空串，插件的是 `plugin:<id>`。 */
export function checkinVendorName(vendor: string): string {
  if (!vendor) return "WorkBuddy";
  if (vendor === "trae") return "Trae CN";
  if (vendor.startsWith("plugin:")) return vendor.slice("plugin:".length) || "接入组件";
  return vendor;
}

function formatCredit(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** 一条结果的人话；没有结果行时不说话。 */
export function checkinLine(entry: CheckinEntry): string {
  const vendor = checkinVendorName(entry.vendor);
  const who = entry.user ? `${vendor}（${entry.user}）` : vendor;
  switch (entry.outcome) {
    case "claimed": {
      const credit = entry.credit > 0 ? ` +${formatCredit(entry.credit)}` : "";
      const streak = entry.streak > 1 ? ` · 连续 ${entry.streak} 天` : "";
      return `已签到${credit}${streak}`;
    }
    case "done":
      return `${who} 今天已经签过`;
    case "ineligible":
      return `${who} 不能参加这个签到${entry.msg ? `：${entry.msg}` : ""}`;
    case "inactive":
      return `${who} 现在没有签到活动${entry.msg ? `：${entry.msg}` : ""}`;
    case "captcha":
      return `${who} 被要求验证码，请在这个端自己的应用里签到`;
    case "own-app":
      return `${who} 只给自家应用签到，请在这个端的应用里签`;
    default:
      return `${who} 签到失败${entry.msg ? `：${entry.msg}` : ""}`;
  }
}

/** 一次「今日签到」的总结：最多三条，免得提示条变成日志。 */
export function checkinSummary(entries: readonly CheckinEntry[]): string {
  const lines = entries.map(checkinLine);
  if (lines.length === 0) {
    return `还没有能签到的账号。${CHECKIN_VENDORS} 登录后，这里每天可以领一次。`;
  }
  if (lines.length <= 3) return lines.join("；");
  return `${lines.slice(0, 3).join("；")}；等 ${lines.length} 个账号`;
}

/** 有失败的签到：提示条用告警色，不混进「已完成」的语气里。 */
export function checkinFailed(entries: readonly CheckinEntry[]): boolean {
  return entries.some((entry) => entry.outcome === "failed");
}

/**
 * 每日自动签到的开关（`settings` 里的四个厂商开关）。
 *
 * 内核的定时器按北京时间每天跑一次：把厂商开关打开，`accounts checkin`
 * 覆盖的那几家（WorkBuddy、Trae CN、MiniMax Code、Qoder）到点自己领，
 * 不用等人想起来点按钮。MiMo Code、ZCode 的签到归插件自己
 * （`pluginCheckins`，按 provider id），没有厂商开关，这里不替它们写。
 */
export interface CheckinSwitch {
  /** settings 的 key。 */
  key: string;
  /** 这个开关管哪几家（写给人看）。 */
  label: string;
}

export const CHECKIN_SWITCHES: readonly CheckinSwitch[] = [
  { key: "workbuddyCheckin", label: "WorkBuddy" },
  { key: "qoderCheckin", label: "Qoder" },
  { key: "traeCheckin", label: "Trae CN" },
  { key: "minimaxCheckin", label: "MiniMax Code" },
];

/** 四个开关的全貌：全开、全关、还是有几扇开着一半。 */
export type CheckinSwitchState = "on" | "off" | "mixed";

/** `settings list --json` 的 key → 当前值；坏 JSON 当空表，不抛。 */
export function parseSettingValues(stdout: string): Map<string, unknown> {
  const values = new Map<string, unknown>();
  const text = stdout.trim();
  if (!text) return values;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return values;
  }
  if (!Array.isArray(parsed)) return values;
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const key = readString(record.key);
    if (key) values.set(key, record.value);
  }
  return values;
}

/** 四个厂商开关现在是什么状态（认不出的值按关）。 */
export function checkinSwitchState(values: ReadonlyMap<string, unknown>): CheckinSwitchState {
  const on = CHECKIN_SWITCHES.filter((item) => values.get(item.key) === true).length;
  if (on === 0) return "off";
  return on === CHECKIN_SWITCHES.length ? "on" : "mixed";
}

/** 打开或关掉每日自动签到要发的命令（一条一扇开关，谁失败谁报错）。 */
export function checkinSwitchArgs(enabled: boolean): string[][] {
  const value = enabled ? "on" : "off";
  return CHECKIN_SWITCHES.map((item) => ["settings", "set", item.key, value]);
}

/** 开关状态的人话。 */
export function checkinSwitchText(state: CheckinSwitchState): string {
  if (state === "on") return "每天自动签到";
  if (state === "mixed") return "部分自动签到";
  return "每天自动签到";
}

