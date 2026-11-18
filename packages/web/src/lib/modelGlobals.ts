/**
 * magpie 的全局模型设置：名字后缀（`model suffix`）、压缩窗口（`model compact`）、
 * 窗口上限（`model context-cap`）。三项都只影响「智能体看到的模型」，
 * 原版 magpie 把它们放在 Settings › Models 里，这里沿用同样的说法。
 */

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

function firstLine(raw: string): string {
  const line = stripAnsi(raw)
    .split("\n")
    .map((item) => item.trim())
    .find(
      (item) =>
        item !== "" &&
        !item.startsWith("magpie ") &&
        !item.startsWith("✓") &&
        !item.startsWith("✗"),
    );
  return line ?? "";
}

export interface SuffixState {
  /** "" = 读不出来（命令失败或没桥）。 */
  mode: "on" | "own" | "off" | "";
}

export const SUFFIX_LABEL: Record<"on" | "own" | "off", string> = {
  on: "带来源（「Sol · OpenAI」）",
  own: "自己命名的原样，其余带来源",
  off: "只写模型名",
};

export function parseSuffix(raw: string): SuffixState {
  const head = firstLine(raw).split(/\s+/)[0]?.toLowerCase() ?? "";
  return { mode: head === "on" || head === "own" || head === "off" ? head : "" };
}

export interface CompactState {
  /** true = 整个窗口不压缩；false = 压缩（size 有值时是压缩点）。 */
  fullContext: boolean;
  /** 例如 "200K"；读不出来就是 undefined。 */
  size?: string;
}

export function parseCompact(raw: string): CompactState {
  const line = firstLine(raw);
  if (/^off\b/i.test(line)) return { fullContext: true };
  const size = /compact at\s+([0-9]+(?:\.[0-9]+)?\s*[KM]?)/i.exec(line)?.[1];
  return { fullContext: false, size: size?.replace(/\s+/g, "") };
}

export interface ContextCapState {
  /** 上限，例如 "200K"；没有上限就是 undefined。 */
  size?: string;
}

export function parseContextCap(raw: string): ContextCapState {
  const line = firstLine(raw);
  if (/^off\b/i.test(line)) return {};
  const size = /^([0-9]+(?:\.[0-9]+)?\s*[KM]?)/i.exec(line)?.[1];
  return size ? { size: size.replace(/\s+/g, "") } : {};
}

export function suffixArgs(mode: "on" | "own" | "off"): string[] {
  return ["model", "suffix", mode];
}

/** size 为空 = 只是打开压缩（用上次的压缩点）。 */
export function compactArgs(size: string): string[] {
  const value = size.trim();
  if (value === "") return ["model", "compact", "on"];
  if (/^(off|full)$/i.test(value)) return ["model", "compact", "off"];
  return ["model", "compact", value];
}

/** value 为空 = 不改；off 关掉上限；all 让上限也压住自己设过的窗口。 */
export function contextCapArgs(value: string): string[] {
  const text = value.trim();
  return ["model", "context-cap", text === "" ? "off" : text];
}

/**
 * 「窗口上限」是 `model context-cap`：参考源码里有，但随桌面端发布的内核
 * （magpie 0.1.3246-heming.d.107）不认识它——裸 `magpie model` 的 usage 里也没有这一行，
 * 真发这条命令只会回 `unknown command "context-cap"`。
 * 和「速度档」一样先看 usage 再决定摆不摆：摆一个保存必报错的控件比不摆更糟。
 */
export function supportsContextCap(usage: string): boolean {
  return /magpie\s+model\s+context-cap\b/.test(usage);
}

export function suffixSummary(state: SuffixState): string {
  if (state.mode === "") return "读不到现在的设置";
  return SUFFIX_LABEL[state.mode];
}

export function compactSummary(state: CompactState): string {
  if (state.fullContext) return "整个窗口，不压缩";
  return state.size ? `压缩到 ${state.size}` : "压缩（读不到压缩点）";
}

export function contextCapSummary(state: ContextCapState): string {
  return state.size ? `不超过 ${state.size}` : "不设上限，每个模型用自己的窗口";
}
