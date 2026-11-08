import { CapabilityRegistry } from "./registry.js";
import {
  chartsProvider,
  filesProvider,
  infohubProvider,
  mcpProvider,
  pluginMarketProvider,
  selfProvider,
  toneProvider,
  wikiProvider,
} from "./providers.js";
import { teamProvider } from "./teamTools.js";

/**
 * 应用默认注册表：先注册内置能力；插件能力由 mcp 提供者统一承载。
 *
 * 顺序即优先级（工具名重复时前者胜出），与改前一致并在 `files`、`plugin-market` 处插入：
 * `mcp → charts → tone → wiki → files → infohub → plugin-market → team → self`。
 * `files` 放在 wiki 之后：wiki 是知识库专用只读工具，名字不会撞；
 * 放它在 infohub/self 之前，是因为文件编辑比「归档/自我修改」更常用。
 * `plugin-market`（插件市场只读工具）放在 team 之前：前缀 `plugin_*` 同样不会撞名。
 * `team`（团队工作台）排在 self 之前：前缀 `team_*` 不会与自我修改工具重名。
 */
export const capabilityRegistry = new CapabilityRegistry()
  .register(mcpProvider)
  .register(chartsProvider)
  .register(toneProvider)
  .register(wikiProvider)
  .register(filesProvider)
  .register(infohubProvider)
  .register(pluginMarketProvider)
  .register(teamProvider)
  .register(selfProvider);

export { CapabilityRegistry } from "./registry.js";
export type { CapabilityContext, CapabilityProvider, ToolOrigin } from "./types.js";
export {
  chartsProvider,
  filesProvider,
  infohubProvider,
  mcpProvider,
  pluginMarketProvider,
  selfProvider,
  teamProvider,
  toneProvider,
  wikiProvider,
};
