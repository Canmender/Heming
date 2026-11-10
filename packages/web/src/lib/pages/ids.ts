/**
 * 插件页面路由 id 的纯函数与类型（d.124）。
 *
 * 单独一个文件是为了让 `store/ui.ts` 与 `lib/pages/registry.ts` 都能引用
 * `PluginPageId` 而不互相 import —— 页面 id 的解析规则只有这一份，
 * 拆成两个文件各写一遍必然漂移（`plugin:` 前缀/切分口径）。
 */

/** 插件页面的路由 id：`plugin:<pluginId>`（插件的清单 id 可含点，如 `heming.pet`）。 */
export type PluginPageId = `plugin:${string}`;

const PLUGIN_PAGE_PREFIX = "plugin:";

/** 由插件 id 生成路由 id（空 id 也原样生成，由调用方保证来源可信）。 */
export function pluginPageId(pluginId: string): PluginPageId {
  return `plugin:${pluginId}`;
}

/** 从路由 id 取回插件 id（调用方应先确认 `isPluginPagePage`）。 */
export function pluginIdFromPage(page: PluginPageId): string {
  return page.slice(PLUGIN_PAGE_PREFIX.length);
}

/**
 * 是否插件页面路由。
 *
 * 只认 `plugin:` 前缀且后续非空——`plugin:` 本身不是合法插件 id，
 * 放行会让路由去查一个不存在的条目，表现为白屏。
 */
export function isPluginPagePage(page: string): page is PluginPageId {
  return page.startsWith(PLUGIN_PAGE_PREFIX) && page.length > PLUGIN_PAGE_PREFIX.length;
}
