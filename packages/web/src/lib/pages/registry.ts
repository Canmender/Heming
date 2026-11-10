import type { InstalledPlugin } from "../plugins/store.js";
import type { WidgetRecord } from "../../types/widgets.js";
import { normalizePluginPageIcon } from "./icons.js";
import { pluginPageId, type PluginPageId } from "./ids.js";

/**
 * 插件页面注册表（d.124）：把「已装且启用的插件页面」投影成导航 / 路由 / 插件页
 * 共用的一份数据。
 *
 * 为什么必须只有一个投影函数：
 * 导航轨、App 路由守卫、插件卡「打开页面」、设置区导航说明四处都要回答
 * 「这个插件现在有没有页面、叫什么、能不能进」。各写各的 `if` 必然漂移——
 * 典型症状是导航里有入口、点进去路由说没有（或反之）。
 *
 * 两类来源：
 * - 声明式插件（`pluginStore.list()` 的 `manifest.contributions.page.kind === "blocks"`）；
 * - 界面插件（`widgets:list` 记录的 `page`，由主进程按包内 entry 给出）。
 *
 * 排序（稳定、与安装顺序无关地可复现）：
 * 1. 声明式页面按 `installedAt` 升序；
 * 2. 界面插件页面按 `installedAt` 升序（在声明式之后）。
 * 同一插件升级不改 `installedAt`，所以入口位置不会因为更新而跳。
 */
export interface PluginPageEntry {
  /** 路由 id：`plugin:<pluginId>`。 */
  pageId: PluginPageId;
  pluginId: string;
  /** 导航项与页面标题（清单 `page.title`）。 */
  title: string;
  /** 已归一化到图标词表的 id。 */
  icon: string;
  source: "declarative" | "bundle";
  /** 首次安装时间（ISO）；用于稳定排序。 */
  installedAt: string;
  /** 现在能不能进：已装 && 已启用 && 未损坏 &&（界面插件还要求桌面桥存在）。 */
  available: boolean;
}

export interface PluginPageInput {
  /** 声明式插件记录（`pluginStore.list()`）。 */
  plugins: readonly InstalledPlugin[];
  /** 界面插件记录（`useWidgetsStore` 的 `records`）。 */
  widgets: readonly WidgetRecord[];
  /** 当前环境是否有界面插件运行时（桌面端主窗）。 */
  desktop: boolean;
}

function compareByInstalledAt(
  a: Pick<PluginPageEntry, "installedAt" | "pageId">,
  b: Pick<PluginPageEntry, "installedAt" | "pageId">,
): number {
  if (a.installedAt !== b.installedAt) return a.installedAt < b.installedAt ? -1 : 1;
  // 同一时刻安装（批量/时钟精度）：按 id 字典序，保证每次启动顺序一致。
  return a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0;
}

/**
 * 已装插件 → 页面入口列表。
 *
 * 纯函数：输入是两份记录数组 + 桌面能力标志，输出可直接用于导航与路由。
 * 不读 store、不读 window——测试与路由守卫可以用同一份输入各自断言。
 */
export function pluginPageEntries(input: PluginPageInput): PluginPageEntry[] {
  const declarative: PluginPageEntry[] = [];
  for (const plugin of input.plugins) {
    const page = plugin.manifest.contributions.page;
    if (!page || page.kind !== "blocks") continue;
    // 损坏记录（清单读不回来）不建入口：它的 manifest 是占位，页面内容不可信。
    if (plugin.invalidRecord) continue;
    declarative.push({
      pageId: pluginPageId(plugin.manifest.id),
      pluginId: plugin.manifest.id,
      title: page.title,
      icon: normalizePluginPageIcon(page.icon),
      source: "declarative",
      installedAt: plugin.installedAt,
      available: plugin.enabled,
    });
  }

  const bundle: PluginPageEntry[] = [];
  for (const record of input.widgets) {
    if (!record.page) continue;
    bundle.push({
      pageId: pluginPageId(record.id),
      pluginId: record.id,
      title: record.page.title,
      icon: normalizePluginPageIcon(record.page.icon),
      source: "bundle",
      installedAt: record.installedAt,
      // 界面插件页面要靠主进程建视图：浏览器里没有桥，入口保留但不可用
      // （设置区会说明「仅安装版可用」，点进去也是降级说明，不是白屏）。
      available: input.desktop && record.enabled && !record.error,
    });
  }

  declarative.sort(compareByInstalledAt);
  bundle.sort(compareByInstalledAt);

  // 同一插件 id 理论上不会同时出现在两套存储（声明式安装管线拒绝 bundle），
  // 但手改文件可能造出这种状态：保留先出现的（声明式），避免导航出现两个同名入口。
  const seen = new Set<string>();
  const entries: PluginPageEntry[] = [];
  for (const entry of [...declarative, ...bundle]) {
    if (seen.has(entry.pageId)) continue;
    seen.add(entry.pageId);
    entries.push(entry);
  }
  return entries;
}

/** 按路由 id 反查页面入口（路由守卫/页面宿主用）。 */
export function pluginPageEntry(
  entries: readonly PluginPageEntry[],
  page: string,
): PluginPageEntry | undefined {
  return entries.find((entry) => entry.pageId === page);
}

/** 导航可用的插件页面 id（按注册表顺序；停用的不出现在导航里）。 */
export function pluginNavPages(entries: readonly PluginPageEntry[]): PluginPageId[] {
  return entries.filter((entry) => entry.available).map((entry) => entry.pageId);
}

/**
 * 把可用插件页面追加到导航顺序末尾（宿主 8 项与模块页顺序原样不动）。
 *
 * 与 `modules/nav.ts` 的 `withModuleNav` 同一口径：插件入口是「装出来的」，
 * 不写进 `heming.navOrder.v1`、不参与个性化排序——否则同一份顺序在不同安装
 * 状态下含义会变。
 */
export function withPluginNav<T extends string>(
  order: readonly T[],
  entries: readonly PluginPageEntry[],
): T[] {
  const pages = pluginNavPages(entries) as unknown as T[];
  const missing = pages.filter((page) => !order.includes(page));
  if (missing.length === 0) return [...order];
  return [...order, ...missing];
}

export { isPluginPagePage, pluginIdFromPage, pluginPageId } from "./ids.js";
export type { PluginPageId } from "./ids.js";
