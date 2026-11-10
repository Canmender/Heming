import type { PluginCommandInfo } from "../plugins/index.js";
import type { PageId, PaletteIntentData, PaletteIntentKind } from "../../store/ui.js";
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

/**
 * target 分发所需的宿主能力（由调用方注入，本模块不直接读 store）。
 *
 * 为什么用注入而不是在这里 import store：命令面板与插件页（声明式页的 `actions` 块）
 * 都要执行同一套 target，但两者的「页面能不能去」判断来源不同——面板按「已装模块
 * 过滤后的页面目录」，插件页按「可路由页面白名单」。把判断留在调用方，跳转口径
 * （page → 切页 / settings / unit / plugin → 意图槽）留在这里，才是一份真源。
 */
export interface PluginCommandTargetDeps {
  /** 触发这条动作的插件 id（`target: "plugin"` 时指向它自己的详情）。 */
  pluginId: string;
  /** 该页面现在能不能去（调用方传自己的投影，页面白名单不在这里复制）。 */
  canOpenPage: (page: string) => boolean;
  /** 技能名 → 本机技能 id（找不到返回 null，面板与插件页同口径）。 */
  skillIdOf: (name: string) => string | null;
  setPage: (page: PageId) => void;
  setPaletteIntent: (kind: PaletteIntentKind, data?: PaletteIntentData) => void;
}

/**
 * 执行一条插件命令 / 声明式页动作的 target（d.108 / d.124）。
 *
 * 落点与既有语义逐字一致：
 * - `page` → 直接切页（页面不可用时静默忽略，与面板原来一致）；
 * - `skill` → 查技能池 id 投 `focus-skill`，再切技能视图；
 * - `settings` → 投 `focus-settings` 定位设置卡，再切设置页；
 * - `unit` → 复用 `open-plugin` 槽，由插件页判断开详情还是在统一单元列表里定位；
 * - `plugin` → 打开本插件详情。
 *
 * 返回是否真的执行了跳转（`page` 不可路由时为 false），供调用方决定要不要给提示。
 */
export function runPluginCommandTarget(
  target: PluginCommandTarget,
  deps: PluginCommandTargetDeps,
): boolean {
  if (!target || typeof target !== "object") return false;
  switch (target.kind) {
    case "page":
      if (!deps.canOpenPage(target.page)) return false;
      deps.setPage(target.page as PageId);
      return true;
    case "skill": {
      const skillId = deps.skillIdOf(target.name);
      if (skillId) deps.setPaletteIntent("focus-skill", { id: skillId });
      deps.setPage("skills");
      return true;
    }
    case "settings":
      deps.setPaletteIntent("focus-settings", { card: target.card });
      deps.setPage("settings");
      return true;
    case "unit":
      deps.setPaletteIntent("open-plugin", { id: target.unitId });
      deps.setPage("plugins");
      return true;
    case "plugin":
      deps.setPaletteIntent("open-plugin", { id: deps.pluginId });
      deps.setPage("plugins");
      return true;
    default:
      return false;
  }
}
