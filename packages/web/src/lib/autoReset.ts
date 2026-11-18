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