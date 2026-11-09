import type { PluginCommandInfo } from "../plugins/index.js";
import { ROUTABLE_PAGE_IDS } from "../palette/pages.js";
import { settingsCardById } from "../settings/registry.js";
import type { WidgetCommand, WidgetRecord } from "../../types/widgets.js";

/**
 * 界面插件（bundle）的命令 → 命令面板条目（d.109 · 规格 §7.3）。
 *
 * 数据来自 `window.__heming_widgets.list()`：主进程在安装/启动自检时已经把
 * `contributions.commands` 按 bundle 允许的 target 集合（page/plugin/settings/unit）
 * 收紧并写进注册表。本模块是**纯函数**，只做两件事：
 *
 * 1. 过滤：停用/损坏的记录不产生命令（与声明式插件「停用即消失」同口径）；
 * 2. web 侧再兜一层 target 可解析性（页面 id 在 `PALETTE_PAGES`、设置卡在
 *    `SETTINGS_CARDS`、单元 id 合法）——主进程只校验形状，不认识 web 的页面/卡片目录。
 *
 * ★ 这里不执行插件代码：命令只是导航入口，执行分发仍由 CommandPalette 的
 *   `plugin-command` 分支按 target 走既有页面/意图。
 */

/** 命令来源标签（副标题里标明「界面插件」，与声明式插件区分）。 */
export const WIDGET_COMMAND_SOURCE = "界面插件";

const PAGE_IDS: ReadonlySet<string> = ROUTABLE_PAGE_IDS;
const UNIT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_TITLE = 80;
const MAX_DESCRIPTION = 200;
const MAX_KEYWORDS = 10;

/** 把 bundle 命令的 target 收成面板可执行的形状；不可解析返回 null。 */
function paletteTargetOf(target: WidgetCommand["target"]): PluginCommandInfo["target"] | null {
  if (!target || typeof target !== "object") return null;
  switch (target.kind) {
    case "page":
      return typeof target.page === "string" && PAGE_IDS.has(target.page)
        ? { kind: "page", page: target.page }
        : null;
    case "plugin":
      return { kind: "plugin" };
    case "settings":
      return typeof target.card === "string" && settingsCardById(target.card)
        ? { kind: "settings", card: target.card }
        : null;
    case "unit":
      return typeof target.unitId === "string" && UNIT_ID_RE.test(target.unitId)
        ? { kind: "unit", unitId: target.unitId }
        : null;
    default:
      return null;
  }
}

function keywordsOf(command: WidgetCommand): string[] {
  if (!Array.isArray(command.keywords)) return [];
  const out: string[] = [];
  for (const item of command.keywords) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed.slice(0, 32));
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

/** 已安装界面插件的命令 → 命令面板条目（顺序稳定，按注册表顺序）。 */
export function widgetCommands(records: readonly WidgetRecord[]): PluginCommandInfo[] {
  const out: PluginCommandInfo[] = [];
  for (const record of records) {
    // 停用/损坏的记录不产生命令：面板入口必须与「可执行」同口径
    if (!record || record.enabled !== true || record.error) continue;
    const commands = Array.isArray(record.commands) ? record.commands : [];
    for (const command of commands) {
      if (!command || typeof command.id !== "string" || !command.id.trim()) continue;
      if (typeof command.title !== "string" || !command.title.trim()) continue;
      const target = paletteTargetOf(command.target);
      if (!target) continue;
      const name = record.name || record.id;
      out.push({
        // 与声明式插件的 `plugin:<id>:<cmd>` 区分：面板 key / 最近使用都不会串
        id: `widget:${record.id}:${command.id.trim()}`,
        pluginId: record.id,
        pluginName: `${name}（${WIDGET_COMMAND_SOURCE}）`,
        title: command.title.trim().slice(0, MAX_TITLE),
        description:
          typeof command.description === "string" ? command.description.trim().slice(0, MAX_DESCRIPTION) : "",
        keywords: keywordsOf(command),
        target,
      });
    }
  }
  return out;
}
