/**
 * 「自动收取本机登录」（`accounts discovery`）。
 *
 * 模型页上的订阅账号从哪来？两条路：自己和鸣去登录，或者内核读本机那些智能体自己已经登录好的账号。
 * 后一条是整个「借用额度」故事的底座，但它是个开关——关掉之后订阅账号一个都不会出现，
 * 而页面上原来没有任何地方显示这件事，用户只会觉得「我的账号不见了」。
 */

export type DiscoveryState = "on" | "off";

/** 内核只回一句话（`account discovery is on: …` / `… is off: …`），认不出就返回 null。 */
export function parseDiscovery(text: string): DiscoveryState | null {
  const match = /discovery is (on|off)\b/i.exec(text);
  if (!match) return null;
  return match[1].toLowerCase() === "on" ? "on" : "off";
}

/** 切到某一档要执行的命令。 */
export function discoveryArgs(state: DiscoveryState): string[] {
  return ["accounts", "discovery", state];
}

/** 给用户看的一句：开着时说清「账号是自己来的」，关着时说清「所以这里会是空的」。 */
export function discoveryText(state: DiscoveryState | null): string {
  if (state === "on") return "本机那些软件里已经登录的账号会自动收进来。";
  if (state === "off") return "已关掉自动收取：订阅账号不会自己出现，只能在这里手动登录。";
  return "自动收取的状态这次没读到。";
}
