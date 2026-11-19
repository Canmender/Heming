/**
 * 网络代理（d.402）：和鸣自己去问模型服务时走哪条线。
 *
 * 内核把这个放在设置里（`settings` 的 `proxy` 键），空值＝跟着环境变量走，
 * `direct` ＝直连不走代理，其余按地址走（`http://`、`https://`、`socks5://`；
 * 只写 `host:port` 时内核当 http 用）。页面只负责三选一与把地址发过去，
 * 地址是否合法先在这里挡一道，免得发出去才被内核拒。
 */

export type ProxyMode = "system" | "direct" | "custom";

export interface ProxyState {
  mode: ProxyMode;
  address: string;
}

/** 内核存的原文 → 页面上的三选一。空值是「跟着环境走」，不是「不走代理」。 */
export function parseProxy(raw: string | undefined): ProxyState {
  const text = (raw ?? "").trim();
  if (text === "") return { mode: "system", address: "" };
  if (/^(direct|none|off)$/i.test(text)) return { mode: "direct", address: "" };
  return { mode: "custom", address: text };
}

/** 地址看起来行不行；行就返回空串，不行返回一句人话。 */
export function proxyProblem(address: string): string {
  const text = address.trim();
  if (text === "") return "还没填地址";
  if (/\s/.test(text)) return "地址里不能有空格";
  const withScheme = /^(https?|socks5):\/\/[^\s/]+/i.test(text);
  const bare = /^[^\s/:]+:\d+$/.test(text);
  if (!withScheme && !bare) return "写成 host:port，或者带 http:// / socks5://";
  return "";
}

/**
 * 三选一 → 一条命令。跟随环境用 `reset`（把值清回默认），
 * 不是发一个空串；直连与自定义都用 `set`。
 */
export function proxyArgs(mode: ProxyMode, address: string): string[] | null {
  if (mode === "system") return ["settings", "reset", "proxy"];
  if (mode === "direct") return ["settings", "set", "proxy", "direct"];
  const text = address.trim();
  if (proxyProblem(text) !== "") return null;
  return ["settings", "set", "proxy", text];
}

/** 现在是怎么走的，一句话。 */
export function describeProxy(mode: ProxyMode, address: string): string {
  if (mode === "system") return "跟着系统的环境变量走";
  if (mode === "direct") return "直连，不走代理";
  const text = address.trim();
  return text === "" ? "还没填地址" : `走 ${text}`;
}
