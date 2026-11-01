export * from "./manifest.js";
export { PluginStore, PLUGINS_KEY, MAX_PLUGINS, pluginServerId } from "./store.js";
export type {
  InstalledPlugin,
  InstallResult,
  PluginMcpPort,
  PluginInstallPreview,
  PluginSkillDiff,
  PluginServerDiff,
  PluginServerDiffEntry,
  PluginServerConflict,
  PluginSkillInfo,
  PluginServerInfo,
} from "./store.js";

import { PluginStore } from "./store.js";

/**
 * 模块级单例：插件记录只本机存储（`heming.plugins.v1`），
 * 技能物化到共用的 `skillPool`，与技能区/聊天路由同一份技能事实。
 */
export const pluginStore = new PluginStore();
