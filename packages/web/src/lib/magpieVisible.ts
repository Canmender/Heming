/**
 * 每个智能体「能看到哪些模型」的展示层：解析 `magpie visible` 的人类可读输出。
 *
 * 原版 magpie 允许把某个智能体收窄到几个来源/家族/路由组（`magpie visible <agent> relay,ocgo`），
 * 之后网关的模型表和写进该智能体配置里的模型列表都跟着收窄；`all` 恢复。
 * 这里只做解析与命令参数，界面不重复解释语义（服务端才是权威）。
 */

/** 某个智能体当前的可见范围（`magpie visible` 的一行）。 */
export interface AgentVisibility {
  /** 智能体 id（小写，如 `codex`、`claude`）。 */
  agent: string;
  /** 收窄到哪些名字（来源 id / 家族 / 路由组）；空数组 = 没按名字收窄。 */
  names: string[];
  /** 输出里的 `only models picked`：只显示逐个挑过的模型。 */
  pickedOnly?: boolean;
  /** 收窄后还能看到几个模型（输出没给就是 undefined）。 */
  shown?: number;
  /** 被挡住了几个模型。 */
  hidden?: number;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** 输出里的计数：`12 shown, 3 not`（magpie 用一个空格分隔两段）。 */
function counts(line: string): { shown?: number; hidden?: number } {
  const match = /(\d+)\s+shown,\s+(\d+)\s+not/.exec(line);
  if (!match) return {};
  return { shown: Number(match[1]), hidden: Number(match[2]) };
}

/**
 * 解析 `magpie visible`：空态是一句 `every agent is shown every model · …`，
 * 返回空数组；每个智能体一行 `  <agent>  <names>  <N shown, M not>`；
 * 末尾可能有 `families: …` 之类提示行，跳过。
 */
export function parseAgentVisibility(raw: string): AgentVisibility[] {
  const text = raw.replace(ANSI, "");
  const out: AgentVisibility[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/every agent is shown/i.test(line)) continue;
    if (/^\s*(families|shown|hidden|usage|magpie )/i.test(line)) continue;
    // 列表行以两个空格起头；没有缩进的提示行不要当成智能体。
    if (!/^\s{2}\S/.test(line)) continue;
    const countsOfLine = counts(line);
    const body = line.replace(/\s*\d+\s+shown,\s*\d+\s+not.*$/, "").trim();
    const tokens = body.split(/\s{2,}/).filter(Boolean);
    if (tokens.length === 0) continue;
    // 输出按列对齐：第一列 agent、第二列「名字们 · only models picked」。
    const agent = tokens[0]!.trim().toLowerCase();
    if (!/^[a-z0-9_.-]+$/.test(agent)) continue;
    const says = tokens.slice(1).join("  ");
    const pickedOnly = /\bonly models picked\b/i.test(says);
    const names = says
      .replace(/\bonly models picked\b/gi, "")
      .replace(/[·,]\s*$/g, "")
      .split(/[·,]/)
      .map((name) => name.trim())
      .filter(Boolean);
    out.push({ agent, names, ...(pickedOnly ? { pickedOnly: true } : {}), ...countsOfLine });
  }
  return out;
}

/** 某个智能体的可见范围（没出现 = 不受限，能看到全部模型）。 */
export function visibilityOf(
  list: readonly AgentVisibility[],
  agent: string,
): AgentVisibility | undefined {
  const id = agent.trim().toLowerCase();
  return list.find((item) => item.agent === id);
}

/**
 * 保存可见范围的参数：勾满所有来源（或一个都没勾）时发 `all`（恢复全部），
 * 否则发逗号分隔的名字。空数组也发 `all`：magpie 没有「什么都看不到」的写法。
 */
export function visibleArgs(agent: string, names: readonly string[]): string[] {
  const clean = names.map((name) => name.trim()).filter(Boolean);
  return ["visible", agent, clean.length ? clean.join(",") : "all"];
}

/**
 * 打开/关掉「只显示逐个挑过的模型」：`visible <agent> --only-picked|--show-new`。
 * 它不改已经显示的模型，只决定以后新出现的模型要不要自动露出来。
 */
export function pickedOnlyArgs(agent: string, onlyPicked: boolean): string[] {
  return ["visible", agent, onlyPicked ? "--only-picked" : "--show-new"];
}

/** 一行说明：`收窄到 deepseek、relay · 12 个可见，3 个被挡住`。 */export function visibilitySummary(item: AgentVisibility | undefined): string {
  if (!item) return "能看到全部模型";
  const parts: string[] = [];
  if (item.names.length) parts.push(`收窄到 ${item.names.join("、")}`);
  if (item.pickedOnly) parts.push("只显示逐个挑过的模型");
  const narrowed = parts.join(" · ") || "收窄了模型范围";
  const counted =
    item.shown === undefined ? "" : ` · ${item.shown} 个可见${item.hidden ? `，${item.hidden} 个被挡住` : ""}`;
  return `${narrowed}${counted}`;
}
