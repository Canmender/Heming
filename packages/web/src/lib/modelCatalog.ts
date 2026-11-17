/**
 * 模型目录的展示层（d.259）：把网关目录与 `model` 命令的输出收敛成一行一个模型需要的值。
 *
 * 对齐原版 magpie 的 Models 列表：一行里能看到「显示名、思考档、窗口、能不能看图」，
 * 并且直接把「测试 / 改名 / 调档 / 禁用」挂在模型上，而不是让用户在表单里手打模型 ID。
 *
 * 纯函数，不发命令、不碰 DOM；页码只负责排版。
 */
import type { GatewayModel } from "./magpieClient.js";

/** 一行模型（网关目录里的一条，附派生出来的来源与展示字段）。 */
export interface ModelRow {
  /** 交给网关的模型 id：`provider/model`、`group/<id>`、`auto/<model>`。 */
  id: string;
  /** 来源名（magpie 的 provider id，或「路由组」「自动路由」「本机」）。 */
  provider: string;
  /** 显示名；空串表示没有名字（界面退回 id）。 */
  name: string;
  /** 思考档（`none/low/high/max`），空数组 = 未知或不支持。 */
  efforts: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  /** 是否接受图片输入（未知按 false：能力判定宁可保守）。 */
  vision: boolean;
  /** 价格（USD / 每 100 万 token）；网关目录没给就是未知。 */
  priceIn?: number;
  priceOut?: number;
  priceCacheRead?: number;
  priceCacheWrite?: number;
  /** 网关目录里有没有这一条（离线缓存里的旧档案可能没有）。 */
  inCatalog: boolean;
}

/** 路由组与自动路由不是供应商，分组标题单独起名（magpie 里是 "Routing groups"）。 */
export const GROUP_PROVIDER = "路由组";
export const AUTO_PROVIDER = "自动路由";
export const LOCAL_PROVIDER = "本机";
/** 列表末尾的「不是供应商」分组：magpie 把路由组排在所有供应商之后。 */
const NON_VENDOR = new Set([GROUP_PROVIDER, AUTO_PROVIDER]);

/** `provider/model` → 来源名；`group/x` 与 `auto/x` 单独命名，不留裸前缀。 */
export function providerOfModel(id: string): string {
  const slash = id.indexOf("/");
  if (slash <= 0) return LOCAL_PROVIDER;
  const head = id.slice(0, slash);
  if (head === "group") return GROUP_PROVIDER;
  if (head === "auto") return AUTO_PROVIDER;
  return head;
}

/**
 * 由「模型档案 + 网关目录」拼出一行展示数据。
 *
 * 为什么两个来源都要：档案是聊天层实际能用的模型（离线缓存也在），目录带显示名、
 * 思考档、窗口与图片能力（`GET /v1/models` 的扩展字段）。以档案为准、目录补细节，
 * 目录里没有的旧档案也照样列出来，只是没有细节。
 */
export function buildModelRows(
  profiles: readonly { model: string; label?: string }[],
  catalog: readonly GatewayModel[] = [],
): ModelRow[] {
  const byId = new Map<string, GatewayModel>();
  for (const model of catalog) byId.set(model.id, model);
  const rows: ModelRow[] = [];
  const seen = new Set<string>();
  for (const profile of profiles) {
    const id = profile.model?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const entry = byId.get(id);
    const ownName = entry && entry.name && entry.name !== entry.id ? entry.name : "";
    const labelName = profile.label && profile.label !== id ? profile.label : "";
    rows.push({
      id,
      provider: providerOfModel(id),
      name: ownName || labelName,
      efforts: entry?.reasoningLevels?.length ? entry.reasoningLevels : [],
      contextWindow: entry?.contextWindow,
      maxOutputTokens: entry?.maxOutputTokens,
      vision: entry?.vision ?? false,
      priceIn: entry?.priceIn,
      priceOut: entry?.priceOut,
      priceCacheRead: entry?.priceCacheRead,
      priceCacheWrite: entry?.priceCacheWrite,
      inCatalog: Boolean(entry),
    });
  }
  return rows;
}

/** 把 token 数写成人看的大小：128000 → "128K"、1000000 → "1M"；未知返回空串。 */
export function formatTokenCount(tokens?: number): string {
  if (!tokens || tokens <= 0) return "";
  const trim = (value: number) => {
    const fixed = Math.round(value * 10) / 10;
    return Number.isInteger(fixed) ? String(fixed) : fixed.toFixed(1);
  };
  if (tokens >= 1_000_000) return `${trim(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${trim(tokens / 1_000)}K`;
  return String(tokens);
}

/** 一行下面的能力摘要：思考档 / 窗口 / 输出上限 / 图片输入，缺失的项不占位。 */
export function modelCapabilityLine(row: ModelRow): string {
  const parts: string[] = [];
  if (row.efforts.length > 0) parts.push(`思考 ${row.efforts.join("/")}`);
  const window = formatTokenCount(row.contextWindow);
  if (window) parts.push(`窗口 ${window}`);
  const output = formatTokenCount(row.maxOutputTokens);
  if (output) parts.push(`输出 ${output}`);
  if (row.vision) parts.push("图片输入");
  return parts.join(" · ");
}

/** 价格写成人看的一行：`$0.15 入 / $0.6 出 · 每 1M token`；未知返回空串。 */
export function modelPriceLine(row: ModelRow): string {
  if (row.priceIn === undefined && row.priceOut === undefined) return "";
  const money = (value: number) => `$${String(Number(value.toFixed(4)))}`;
  const parts: string[] = [];
  if (row.priceIn !== undefined) parts.push(`${money(row.priceIn)} 入`);
  if (row.priceOut !== undefined) parts.push(`${money(row.priceOut)} 出`);
  return `${parts.join(" / ")} · 每 1M token`;
}

/**
 * 价格编辑框里的初值：`入,出,缓存读,缓存写`（magpie `model price` 的四个数，USD/1M）。
 * 缺的按 0 写（0 在 magpie 里是「免费」），整条价格未知时留空。
 */
export function priceEditValue(row: ModelRow): string {
  if (row.priceIn === undefined && row.priceOut === undefined) return "";
  const parts = [row.priceIn, row.priceOut, row.priceCacheRead, row.priceCacheWrite].map(
    (value) => String(Number((value ?? 0).toFixed(4))),
  );
  return parts.join(",");
}

/** 模型 id 里 `provider/` 之后的那段（`provider test <id> <model>` 要的是它）。 */
export function modelShortId(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(slash + 1) : "";
}

/** 能不能拿 `provider test` 测它：路由组/自动路由不是供应商的模型，测不了。 */
export function canTestModel(id: string): boolean {
  const provider = providerOfModel(id);
  return provider !== GROUP_PROVIDER && provider !== AUTO_PROVIDER && provider !== LOCAL_PROVIDER;
}

/**
 * 按「搜索词 + 来源」过滤：搜索词同时匹配 id、显示名与来源名（都按小写、包含判定），
 * 与原版 magpie 的模型过滤一致——用户记得住的是名字，不是 `deepseek-v4-pro`。
 */
export function filterModelRows(
  rows: readonly ModelRow[],
  query: string,
  provider = "",
): ModelRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (provider && row.provider !== provider) return false;
    if (!needle) return true;
    return (
      row.id.toLowerCase().includes(needle) ||
      row.name.toLowerCase().includes(needle) ||
      row.provider.toLowerCase().includes(needle)
    );
  });
}

/** 按来源分组，保持目录里的出现顺序；路由组/自动路由排在最后（与 magpie 一致）。 */
export function groupModelRows(rows: readonly ModelRow[]): { provider: string; rows: ModelRow[] }[] {
  const groups = new Map<string, ModelRow[]>();
  for (const row of rows) {
    const list = groups.get(row.provider) ?? [];
    list.push(row);
    groups.set(row.provider, list);
  }
  const out = [...groups.entries()].map(([provider, list]) => ({ provider, rows: list }));
  return [
    ...out.filter((group) => !NON_VENDOR.has(group.provider)),
    ...out.filter((group) => NON_VENDOR.has(group.provider)),
  ];
}

/** 已禁用的一个模式（`model disabled` 的一行）：模式 + 它现在关掉的模型。 */
export interface DisabledPattern {
  /** 模式本身：模型 id，或带 `*` 的 glob（magpie 原样保存）。 */
  pattern: string;
  /** 现在被它关掉的模型（空数组 = 现在没有模型命中）。 */
  hits: string[];
}

const NO_HITS = "matches no model magpie serves now";

/**
 * 解析 `magpie model disabled` 的人类可读输出。
 *
 * 一行一个模式：`<pattern> · <命中的模型，逗号分隔>`；空态是一句
 * `no model is disabled · …`，返回空数组。解析不了的行原样当模式保留（不丢信息）。
 */
export function parseDisabledModels(raw: string): DisabledPattern[] {
  const text = raw.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const out: DisabledPattern[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^no model is disabled/i.test(trimmed)) continue;
    if (/^[!✓·]/.test(trimmed)) continue;
    const split = trimmed.indexOf(" · ");
    const pattern = (split >= 0 ? trimmed.slice(0, split) : trimmed).trim();
    if (!pattern || seen.has(pattern)) continue;
    const rest = split >= 0 ? trimmed.slice(split + 3).trim() : "";
    const hits =
      !rest || rest === NO_HITS
        ? []
        : rest
            .split(",")
            .map((hit) => hit.trim())
            .filter(Boolean);
    seen.add(pattern);
    out.push({ pattern, hits });
  }
  return out;
}

/** glob（`*`、`?`，大小写不敏感）→ 是否匹配某个模型 id（magpie 的禁用规则）。 */
export function matchesDisabledPattern(pattern: string, modelId: string): boolean {
  const source = pattern
    .trim()
    .split("")
    .map((char) => {
      if (char === "*") return ".*";
      if (char === "?") return ".";
      return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  try {
    return new RegExp(`^${source}$`, "i").test(modelId);
  } catch {
    return pattern.trim().toLowerCase() === modelId.toLowerCase();
  }
}

/** 某个模型是否落在任一禁用模式里（用来给行打「已禁用」并换掉「禁用」按钮）。 */
export function isModelDisabled(row: ModelRow, patterns: readonly DisabledPattern[]): boolean {
  return patterns.some((item) => matchesDisabledPattern(item.pattern, row.id));
}

/** `visible` 里的名字认不出来时（家族/路由组），宁可多列也不要把模型全藏起来。 */
export function rowsForAgent(rows: readonly ModelRow[], names: readonly string[]): ModelRow[] {
  const wanted = [...new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean))];
  if (wanted.length === 0) return [...rows];
  const kept = rows.filter((row) => {
    const provider = row.provider.toLowerCase();
    const id = row.id.toLowerCase();
    const short = modelShortId(row.id).toLowerCase();
    if (wanted.includes(provider) || wanted.includes(id) || wanted.includes(short)) return true;
    // 家族名（如 deepseek-flash）没有单独的 provider：按 id 前缀再认一次。
    return wanted.some((name) => id.startsWith(`${name}/`) || id.includes(`/${name}`));
  });
  return kept.length > 0 ? kept : [...rows];
}
