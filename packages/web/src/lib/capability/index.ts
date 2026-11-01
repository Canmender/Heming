import { CapabilityRegistry } from "./registry.js";
import {
  chartsProvider,
  mcpProvider,
  selfProvider,
  toneProvider,
  wikiProvider,
} from "./providers.js";

/** 应用默认注册表：先注册内置五类；d.42 的插件提供者从这里接入。 */
export const capabilityRegistry = new CapabilityRegistry()
  .register(mcpProvider)
  .register(chartsProvider)
  .register(toneProvider)
  .register(wikiProvider)
  .register(selfProvider);

export { CapabilityRegistry } from "./registry.js";
export type { CapabilityContext, CapabilityProvider, ToolOrigin } from "./types.js";
export { chartsProvider, mcpProvider, selfProvider, toneProvider, wikiProvider };
