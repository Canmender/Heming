/**
 * 插件页面可用图标词表（d.124）。
 *
 * 清单只写一个 id（`page.icon`），宿主映射到既有线条图标：这样插件作者不用
 * 自己带图标（bundle 的图标要额外走 `widget://` 资源与 CSP），也不会出现
 * 「一个插件一套视觉」。未知/空值统一回落 `package`，**不报错**——图标是装饰，
 * 不该让一个能用的页面因为图标拼错而装不上。
 */
export const PLUGIN_PAGE_ICON_IDS = [
  "activity",
  "book",
  "calendar",
  "chart",
  "database",
  "file",
  "folder",
  "globe",
  "grid",
  "hammer",
  "key",
  "layers",
  "layout",
  "link",
  "list",
  "message",
  "package",
  "play",
  "settings",
  "shield",
  "terminal",
] as const;

export type PluginPageIconId = (typeof PLUGIN_PAGE_ICON_IDS)[number];

/** 默认图标：清单没写、写了未知值、或写成空串时都用它。 */
export const DEFAULT_PLUGIN_PAGE_ICON: PluginPageIconId = "package";

const ICON_SET: ReadonlySet<string> = new Set(PLUGIN_PAGE_ICON_IDS);

/**
 * 归一化清单里的图标 id：小写、去空白；不在词表内回落默认。
 *
 * 清单校验（shared 的 `PageSchema.icon`）已经把大小写与字符集收窄，
 * 这里再归一化一次是因为落盘记录可能来自旧版本/手改文件——渲染层不信任它。
 */
export function normalizePluginPageIcon(icon: string | null | undefined): PluginPageIconId {
  if (typeof icon !== "string") return DEFAULT_PLUGIN_PAGE_ICON;
  const normalized = icon.trim().toLowerCase();
  return ICON_SET.has(normalized) ? (normalized as PluginPageIconId) : DEFAULT_PLUGIN_PAGE_ICON;
}
