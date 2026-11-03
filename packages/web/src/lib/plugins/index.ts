export * from "./manifest.js";
export * from "./permissions.js";
export * from "./catalog.js";
export * from "./system.js";
export * from "./descriptors.js";
/**
 * 描述符口径的 `CapabilityOwnerKind` 只有 "system" | "plugin" | "mcp"（三档）；
 * 能力目录的 `CapabilityOwnerKind` 多一个 "self"（四档）。两者同名但用途不同，
 * 对外默认导出**描述符口径**（页面归因只认三档）；目录口径按需从 `./catalog.js` 取。
 */
export type { CapabilityOwnerKind } from "./descriptors.js";
export {
  PluginStore,
  PLUGINS_KEY,
  MAX_PLUGINS,
  pluginServerId,
  pluginIdFromServerId,
  pluginStore,
} from "./store.js";
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
  PluginContributionCounts,
  PluginCommandInfo,
} from "./store.js";
