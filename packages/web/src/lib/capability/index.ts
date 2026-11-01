import { CapabilityRegistry } from "./registry.js";
import {
  chartsProvider,
  infohubProvider,
  mcpProvider,
  selfProvider,
  toneProvider,
  wikiProvider,
} from "./providers.js";

/** 应用默认注册表：先注册内置能力；插件能力由 mcp 提供者统一承载。 */
export const capabilityRegistry = new CapabilityRegistry()
  .register(mcpProvider)
  .register(chartsProvider)
  .register(toneProvider)
  .register(wikiProvider)
  .register(infohubProvider)
  .register(selfProvider);

export { CapabilityRegistry } from "./registry.js";
export type { CapabilityContext, CapabilityProvider, ToolOrigin } from "./types.js";
export {
  chartsProvider,
  infohubProvider,
  mcpProvider,
  selfProvider,
  toneProvider,
  wikiProvider,
};
