import { stripAnsi } from "./magpieCli.js";

/**
 * Codex 账号「自己把重置花掉」的那条设置（`quota auto-reset`）。
 *
 * 内核把开关存在 settings 里（`CodexAutoReset` 存账号、`CodexAutoResetOnly` 存只开了哪一档），
 * 但这几个键既不在 `settings list --json` 里、也不在 `accounts --json` 里，
 * 只能用 `magpie quota auto-reset` 打印的散文来读：
 *
 *   ● me@example.com  uses a reset by itself when its week runs out, or before one expires
 *   no Codex account uses a reset by itself · magpie quota auto-reset <account> on
 *
 * 所以这里按那几行做解析，并且只认它认识的措辞：认不出的行直接跳过，
 * 页面会退回「不自己花」，不会替用户猜一个开着的状态。
 */
export type AutoResetLevel = "off" | "week" | "expiring" | "both";

/** 下拉里的顺序：先关、再两档单开、最后两档都开。 */
export const AUTO_RESET_LEVELS: readonly AutoResetLevel[] = ["off", "week", "expiring", "both"];

/** 给人看的说法，和确认过的内核语义一一对应。 */
export function autoResetLevelText(level: AutoResetLevel): string {
  switch (level) {
    case "week":
      return "周额度用完就花";
    case "expiring":
      return "快过期就花";
    case "both":
      return "两种时候都花";
    default:
      return "不自己花";
  }
}

/**
 * 读 `quota auto-reset` 的输出，得到「哪个账号开到了哪一档」。
 *
 * 键一律小写：内核保存时也是小写，账号邮箱大小写不该影响匹配。
 */
export function parseAutoReset(output: string): Map<string, AutoResetLevel> {
  const levels = new Map<string, AutoResetLevel>();
  for (const raw of stripAnsi(output).split("\n")) {
    const line = raw.replace(/^[\s●•·]+/, "").trim();
    if (line === "") continue;
    if (/^no codex account uses a reset by itself/i.test(line)) continue;
    const match = /^(\S+)\s+(uses\b.*)$/i.exec(line);
    if (!match) continue;
    const user = match[1].toLowerCase();
    const words = match[2].toLowerCase();
    const week = words.includes("week runs out");
    const expiring = words.includes("before one expires");
    const level: AutoResetLevel =
      week && expiring ? "both" : week ? "week" : expiring ? "expiring" : "off";
    levels.set(user, level);
  }
  return levels;
}

/**
 * 把一档翻成要发的命令。
 *
 * `week` / `expiring` 在内核里只管一档、另一档保持原样，所以从「快过期才花」改成「周用完才花」
 * 必须显式把另一档关掉，否则会变成两档都开——这正是只发一条命令容易踩的坑。
 */
export function autoResetArgs(user: string, level: AutoResetLevel): string[][] {
  const base = ["quota", "auto-reset", user];
  if (level === "off") return [[...base, "off"]];
  if (level === "both") return [[...base, "on"]];
  const other = level === "week" ? "expiring" : "week";
  return [
    [...base, level, "on"],
    [...base, other, "off"],
  ];
}

/**
 * 「快过期时提前多久花」——`quota auto-reset lead`。
 *
 * 这是全局一项（不是按账号）：内核默认提前 30 分钟，可设 3 分钟到 24 小时；
 * 它同样不在 `settings list --json` 里，只能读那句
 * 「a reset about to expire unused is used 30m before it expires (the default)」。
 */
export const RESET_LEAD_DEFAULT = 30;

/** 内核菜单给的档位，外加默认值。 */
export const RESET_LEAD_CHOICES: readonly number[] = [3, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];

/** 分钟说成中文：3 分钟 / 2 小时 / 1 小时 30 分钟。 */
export function resetLeadLabel(minutes: number): string {
  if (minutes === RESET_LEAD_DEFAULT) return "30 分钟（默认）";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

/**
 * 读 `quota auto-reset lead` 的那句话，得到分钟数；认不出就是 null（页面不显示这一项）。
 *
 * 内核的写法是 `leadWords`：整小时写 `3h`，其余写 `30m` / `1h30m`，所以三种形态都要认。
 */
export function parseResetLead(output: string): number | null {
  const match = /used ([0-9]+h[0-9]*m?|[0-9]+m) before it expires/i.exec(stripAnsi(output));
  if (!match) return null;
  const hours = /([0-9]+)h/.exec(match[1]);
  const minutes = /([0-9]+)m/.exec(match[1]);
  const total = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  return total > 0 ? total : null;
}

/**
 * 把分钟翻成命令。默认值发 `default` 而不是 `30m`：
 * 那样内核不用记一个等于默认的自定义值，以后的默认值也能跟着走。
 */
export function resetLeadArgs(minutes: number): string[] {
  if (minutes === RESET_LEAD_DEFAULT) return ["quota", "auto-reset", "lead", "default"];
  if (minutes < 60) return ["quota", "auto-reset", "lead", `${minutes}m`];
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return ["quota", "auto-reset", "lead", rest === 0 ? `${hours}h` : `${hours}h${rest}m`];
}

/** 下拉的候选：内核给的那几档；当前值不在里面（比如手动设过 45 分钟）就补进去，免得被悄悄改掉。 */
export function resetLeadOptions(current: number | null): number[] {
  if (current === null || RESET_LEAD_CHOICES.includes(current)) return [...RESET_LEAD_CHOICES];
  return [...RESET_LEAD_CHOICES, current].sort((a, b) => a - b);
}

/** 有没有账号会在「快过期」时自动花掉——只有这时「提前多久」才影响行为。 */
export function spendsExpiringResets(levels: ReadonlyMap<string, AutoResetLevel>): boolean {
  for (const level of levels.values()) {
    if (level === "expiring" || level === "both") return true;
  }
  return false;
}