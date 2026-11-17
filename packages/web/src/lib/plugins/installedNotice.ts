/**
 * 「刚装了一个插件」这件事，要让智能体知道（d.241）。
 *
 * 为什么需要它：插件装完之后，它的能力（贡献的 MCP 服务、技能）确实会出现在工具里，
 * 但**智能体并不知道「刚刚多了这些」**——它只看到一份长长的工具清单，自然继续用旧的几件；
 * 用户于是觉得「装了插件它也不会用」。这不是能力缺失，而是**交接缺失**：
 * 安装这件事发生在插件页，而下一轮对话没有任何一句话把它带过去。
 *
 * 三条口径：
 * - **只在安装成功后记**：失败/回滚/过期计划什么都不写，绝不留下「装了但其实没装」的假记忆；
 * - **按插件 id 去重**：同一个插件连着升级两次，只留最后一次（提示词里说两遍是噪音）；
 * - **用过就清**：这条提示是「告知一次」，不是长期状态——读走即清（`take`），
 *   否则每轮都写「最近装了 X」，会把提示词预算吃光，也会让模型以为每次都是新装的。
 *
 * 与 `lib/plugins/store.ts` 的关系：store 负责安装事务，这里只做「安装结果 → 下轮提示词」的传递。
 */

/** localStorage 键：与其它本机状态同前缀风格，排障时一起找到。 */
export const PLUGIN_NOTICE_KEY = "heming.pluginNotices.v1";

/** 最多同时挂几条待告知（再多也没人看，且会挤占提示词）。 */
export const MAX_PENDING_PLUGIN_NOTICES = 10;

/** 一条「刚装/刚升级」告知。 */
export interface PluginInstallNotice {
  /** 插件 id（清单里的 `id`，去重用）。 */
  pluginId: string;
  /** 人读名字（清单 `name`，缺省退回 id）。 */
  name: string;
  /** 版本（清单 `version`）。 */
  version: string;
  /** 装完的时间（毫秒时间戳）。 */
  at: number;
  /** 这次是覆盖升级（true）还是首装（false）。 */
  updated: boolean;
  /** 本插件贡献的 MCP 服务 id（形状由插件贡献决定，只用于提示「工具在哪个服务下」）。 */
  servers: readonly string[];
  /** 本插件贡献的技能名（可以在提示词里点名「它还带了个技能」）。 */
  skills: readonly string[];
}

let pending: PluginInstallNotice[] = [];
let loaded = false;

function storage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    // 隐私模式/被策略禁用：告知只是锦上添花，不能因此让安装流程失败。
    return null;
  }
}

function isNotice(value: unknown): value is PluginInstallNotice {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<PluginInstallNotice>;
  return (
    typeof row.pluginId === "string" &&
    row.pluginId.length > 0 &&
    typeof row.name === "string" &&
    typeof row.version === "string" &&
    typeof row.at === "number" &&
    Number.isFinite(row.at) &&
    typeof row.updated === "boolean" &&
    Array.isArray(row.servers) &&
    row.servers.every((item) => typeof item === "string") &&
    Array.isArray(row.skills) &&
    row.skills.every((item) => typeof item === "string")
  );
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const store = storage();
  if (!store) return;
  try {
    const raw = store.getItem(PLUGIN_NOTICE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    pending = parsed.filter(isNotice).slice(-MAX_PENDING_PLUGIN_NOTICES);
  } catch {
    // 坏数据当作没有：宁可少说一句「刚装了」，也不能让提示词里出现半条 JSON。
    pending = [];
  }
}

function persist(): void {
  const store = storage();
  if (!store) return;
  try {
    if (pending.length === 0) {
      store.removeItem(PLUGIN_NOTICE_KEY);
      return;
    }
    store.setItem(PLUGIN_NOTICE_KEY, JSON.stringify(pending));
  } catch {
    // 配额满/被禁用：内存里还在，本轮仍能告知；落盘失败不抛。
  }
}

/**
 * 记一条安装告知。由 `pluginStore.applyPlan` 在**落盘成功之后**调用。
 *
 * 同 id 去重（升级覆盖首装），并按 `MAX_PENDING_PLUGIN_NOTICES` 只留最近若干条。
 */
export function recordPluginInstall(notice: PluginInstallNotice): void {
  ensureLoaded();
  if (!isNotice(notice)) return;
  const rest = pending.filter((item) => item.pluginId !== notice.pluginId);
  pending = [...rest, notice].slice(-MAX_PENDING_PLUGIN_NOTICES);
  persist();
}

/** 看一眼待告知（不消费）。提示词构建用它。 */
export function peekPluginInstallNotices(): PluginInstallNotice[] {
  ensureLoaded();
  return pending.map((item) => ({ ...item }));
}

/** 读走并清空：这一轮提示词已经写进去了，下一轮不必再说。 */
export function takePluginInstallNotices(): PluginInstallNotice[] {
  ensureLoaded();
  const out = pending.map((item) => ({ ...item }));
  pending = [];
  persist();
  return out;
}

/** 测试与换账号用：清空内存与落盘。 */
export function resetPluginInstallNotices(): void {
  pending = [];
  loaded = true;
  persist();
}
