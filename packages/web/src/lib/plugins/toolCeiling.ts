import { riskOfName } from "../hitl/classify.js";
import { pluginIdFromServerId, riskAllowed } from "./permissions.js";
import { pluginStore, type PluginStore } from "./store.js";

/**
 * 插件「工具风险上限」在执行期的落地点（d.77）。
 *
 * 权限模型承诺的是「运行时只能收紧」：插件声明 `permissions.tools: "read"`，
 * 它随包登记的 MCP 服务里的写工具就**不该被注入**。此前这条只落在能力目录
 * （`catalog.ts` 把超限工具放进 `blocked` 供 UI 展示），而真正的注入路径
 * `buildToolBridge()` 只按「服务启用 + 工具开关」过滤——于是工具页写着
 * 「未注入」，模型手上却拿到了这个写工具。本文件把同一口径接到注入点。
 *
 * 判定必须与目录**同源**：
 * - 风险按名字启发（`riskOfName`，与 HITL 同口径；`danger` 归入 write）；
 * - 归属按 `plugin:<id>:` 前缀反解；非插件服务不受上限约束；
 * - 记录缺失（插件被删/记录损坏但服务还在）按 `none` 处理——与目录一致，
 *   不能让「找不到声明」反而变成放行。
 */

/** 只需要 `get()` 的窄接口：单测注入固定记录，不碰全局存储。 */
type PluginLookup = Pick<PluginStore, "get">;

/** 过滤器只关心归属与工具名，不依赖完整 `McpTool`。 */
export interface CeilingToolRef {
  serverId: string;
  tool: { name: string };
}

/** 工具风险的上限口径：`danger` 按 write 处理（展示与执行都更保守）。 */
function ceilingRiskOf(toolName: string): "read" | "write" {
  return riskOfName(toolName) === "read" ? "read" : "write";
}

/**
 * 生成一个「这个工具是否允许注入」的判定函数。
 *
 * 缺省读全局插件存储；页面与注入点用同一份实现，
 * 避免「目录说未注入、执行期照给」这类两套口径。
 */
export function makePluginToolFilter(
  plugins: PluginLookup = pluginStore,
): (ref: CeilingToolRef) => boolean {
  return (ref) => {
    const pluginId = pluginIdFromServerId(ref.serverId);
    if (!pluginId) return true; // 手工 / Registry 服务：上限不适用
    const plugin = plugins.get(pluginId);
    if (!plugin) return false; // 归属还在、记录没了：按目录同口径（none）不注入
    return riskAllowed(ceilingRiskOf(ref.tool.name), plugin.manifest.permissions.tools);
  };
}
