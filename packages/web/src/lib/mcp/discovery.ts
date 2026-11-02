/**
 * 工具发现（对应 Codex 的 `tool_search` 思路）。
 *
 * 问题：MCP 工具是**全量**注入的。装了五六个服务之后，一轮请求里就有几十个
 * function schema，每个都带完整 JSON Schema——输入 token 被工具定义吃掉，
 * 而且模型在几十个名字里挑，选错的概率明显上升。
 *
 * 做法：目录超过阈值时，只暴露一部分，其余靠 `tool_search` 按需检索；
 * 检索命中后把该工具的 schema 加进**后续轮次**的可调用列表。
 *
 * 这里是纯检索逻辑：不认 MCP、不认网络，只对 OpenAI 形状的 tools 数组打分。
 */

/** 一个可检索的工具定义（从 OpenAI tools 数组里抽出的最小信息）。 */
export interface DiscoveredTool {
  /** 暴露给模型的名字（`服务__工具`）。 */
  name: string;
  /** 描述（可能为空：有些 MCP 服务不写描述）。 */
  description: string;
  /** 原始 schema 引用（命中后原样回填，不做任何改写）。 */
  spec: unknown;
}

/** 把 OpenAI tools 数组拍平成可检索条目（结构不符的条目直接跳过）。 */
export function discoverTools(tools: unknown[]): DiscoveredTool[] {
  const out: DiscoveredTool[] = [];
  for (const raw of Array.isArray(tools) ? tools : []) {
    if (!raw || typeof raw !== "object") continue;
    const fn = (raw as { function?: unknown }).function;
    if (!fn || typeof fn !== "object") continue;
    const name = (fn as { name?: unknown }).name;
    if (typeof name !== "string" || !name) continue;
    const description = (fn as { description?: unknown }).description;
    out.push({
      name,
      description: typeof description === "string" ? description : "",
      spec: raw,
    });
  }
  return out;
}

/** 查询分词：ASCII 按词切，CJK 按单字切（中文没有空格，二元切分反而更难对齐）。 */
function tokenize(query: string): string[] {
  return String(query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((t) => t.length > 0)
    .slice(0, 12);
}

/**
 * 打分：名字命中权重 3，描述命中权重 1；完全等于查询的名字额外 +5。
 *
 * 为什么名字权重高：模型搜「天气」时，`srv__weather` 比一段描述里恰好提到天气的
 * 无关工具更可能是目标。宁可把名字命中的排前面，也不要让描述长的工具靠字数取胜。
 */
function scoreOf(tool: DiscoveredTool, tokens: string[], raw: string): number {
  const name = tool.name.toLowerCase();
  const desc = tool.description.toLowerCase();
  let score = 0;
  if (raw && name === raw) score += 5;
  for (const token of tokens) {
    if (name.includes(token)) score += 3;
    // 描述命中按「出现次数」封顶 2，避免长描述把分数刷上去
    if (desc) {
      const hits = desc.split(token).length - 1;
      if (hits > 0) score += Math.min(hits, 2);
    }
  }
  return score;
}

export interface SearchOptions {
  /** 最多返回几个（缺省 8）。 */
  limit?: number;
  /** 要排除的名字（已经在可调用列表里的不必再搜出来）。 */
  exclude?: Set<string>;
}

/**
 * 按查询检索工具，按相关度降序返回。
 *
 * 空查询返回空数组：没有查询词就没有「相关」，返回全部等于让模型自己翻页，
 * 与「按需发现」的初衷相反。
 */
export function searchTools(
  tools: DiscoveredTool[],
  query: string,
  options: SearchOptions = {},
): DiscoveredTool[] {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const raw = String(query ?? "").toLowerCase().trim();
  const limit = Math.max(1, Math.floor(options.limit ?? 8));
  const exclude = options.exclude ?? new Set<string>();

  return tools
    .filter((tool) => !exclude.has(tool.name))
    .map((tool) => ({ tool, score: scoreOf(tool, tokens, raw) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => (b.score - a.score) || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map((entry) => entry.tool);
}
