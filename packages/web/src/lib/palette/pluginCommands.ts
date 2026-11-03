import type { PluginCommandInfo } from "../plugins/index.js";
import { matchScore } from "./local.js";

/**
 * 命令面板 · 插件命令（d.64 T3b）。
 *
 * 数据来自 `pluginStore.commands()`：只列**启用中**插件的 `contributions.commands`，
 * 停用/卸载后自然消失（面板每次打开现读 store，不做缓存）。
 *
 * 检索口径与其它组一致（标题命中权重 > 副标题/关键词）：
 * - 主字段：命令标题（title）
 * - 副字段：描述、关键词、插件名（便于「搜插件名带出它所有命令」）
 */

/** 面板里一条插件命令要携带的最小信息（执行分发按 target 走）。 */
export type PluginCommandTarget = PluginCommandInfo["target"];

/** 命令项副标题：「<插件名> · <描述>」，无描述时只留插件名。 */
export function pluginCommandDetail(command: PluginCommandInfo): string {
  const desc = (command.description ?? "").replace(/\s+/g, " ").trim();
  return desc ? `${command.pluginName} · ${desc}` : command.pluginName;
}

/** 命令项是否命中关键词（标题 / 描述 / 关键词 / 插件名）。 */
export function pluginCommandScore(query: string, command: PluginCommandInfo): number {
  return matchScore(
    query,
    command.title,
    [command.description, ...(command.keywords ?? []), command.pluginName].filter(Boolean),
  );
}

export interface PluginCommandSearchResult {
  /** 截断到上限后的命中（相关度降序）。 */
  hits: PluginCommandInfo[];
  /** 未截断的命中总数（用于「还有 N 条」）。 */
  total: number;
}

/** 按关键词检索插件命令（纯函数，便于单测；不读 store）。 */
export function searchPluginCommands(
  query: string,
  commands: PluginCommandInfo[],
  limit = 5,
): PluginCommandSearchResult {
  const q = query.trim();
  if (!q) return { hits: [], total: 0 };
  const scored = commands
    .map((command) => ({ command, score: pluginCommandScore(q, command) }))
    .filter((s) => s.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.command.title.localeCompare(b.command.title, "zh"),
    );
  return {
    hits: scored.slice(0, limit).map((s) => s.command),
    total: scored.length,
  };
}
