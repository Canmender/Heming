/**
 * 节点库总入口：核心节点 + 集成节点。
 *
 * 为什么分两步注册：集成节点（日期/加密/大模型/InfoHub/通知）由 wf-nodes-app 维护，
 * 依赖 store 与外部客户端；核心节点不依赖它们。应用启动时只需要调一次
 * `registerAllNodes()`，引擎与调色板都从注册表读取，不直接 import 具体节点。
 *
 * 接线顺序：先 core 再 integrations——如果一个 type 在两处重复，后注册的一方会
 * 抛出「重复注册」，能在启动阶段立刻暴露，而不是运行到一半才发现节点行为不对。
 */

import { registerCoreNodes } from "./core/index.js";
import { registerIntegrationNodes } from "./integrations/index.js";

/**
 * 应用启动时调用一次即可；重复调用直接返回。
 *
 * 为什么需要幂等：Node 服务里多个入口（main.ts 启动、测试、将来的热重载）
 * 都可能触发节点库初始化，而 `registerNodeType` 对重复 type 是抛错的（那是为了
 * 防两条事实来源）。这里缓存「已注册」状态，重复调用不是错误；真正的注册冲突
 * （两个模块抢同一个 type）仍会在第一次调用时抛出来。
 */
let registered = false;

export function registerAllNodes(): void {
  if (registered) return;
  registerCoreNodes();
  registerIntegrationNodes();
  registered = true;
}

export { registerCoreNodes };
