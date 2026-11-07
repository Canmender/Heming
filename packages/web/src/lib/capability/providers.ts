import { buildChartToolBridge } from "../charts/tools.js";
import { buildFileToolBridgeIfAvailable } from "../fileEdit/tools.js";
import { buildInfohubToolsIfConnected } from "../infohub/tools.js";
import { buildToolBridge } from "../mcp/index.js";
import { mcpRegistry } from "../mcp/store.js";
import { memoryStore } from "../memory/index.js";
import { makePluginToolFilter } from "../plugins/toolCeiling.js";
import { buildSelfToolBridge } from "../selfEdit/index.js";
import { skillPool } from "../skills/index.js";
import { buildToneToolBridge } from "../tone/tools.js";
import { buildWikiToolBridge } from "../wiki/tools.js";
import type { CapabilityProvider } from "./types.js";

/**
 * 内置能力提供者：原先散在 `ChatPage.buildToolsFor` 的五类来源。
 *
 * 顺序与改前一致（mcp → charts → tone → wiki → infohub → self）：工具名重复时前者胜出。
 */

/**
 * 插件声明的工具风险上限（d.77）：在**注入点**过滤，而不是只在能力目录里标「未注入」。
 * 目录与执行同源（同一份 `riskAllowed` 口径），否则工具页的承诺是假的。
 */
const pluginToolFilter = makePluginToolFilter();

export const mcpProvider: CapabilityProvider = {
  id: "mcp",
  origin: "mcp",
  build: () => buildToolBridge(mcpRegistry, { toolAllowed: pluginToolFilter }),
};

export const chartsProvider: CapabilityProvider = {
  id: "charts",
  origin: "builtin",
  build: () => buildChartToolBridge(),
};

export const toneProvider: CapabilityProvider = {
  id: "tone",
  origin: "builtin",
  build: () => buildToneToolBridge(),
};

export const wikiProvider: CapabilityProvider = {
  id: "wiki",
  origin: "builtin",
  build: () => buildWikiToolBridge(),
};

/**
 * 文件编辑工具（d.55 · file_patch / file_read）：只在**桌面桥存在且至少有一条可写根**时注入。
 * 浏览器端与未配置可写根时返回 null——绝不为了「能用」造一个内存假桥，
 * 那会让用户在浏览器里以为文件真被改了（产品决策，见 lib/fileEdit/tools.ts）。
 */
export const filesProvider: CapabilityProvider = {
  id: "files",
  origin: "builtin",
  build: () => buildFileToolBridgeIfAvailable(),
};

/**
 * 本机归档工具：只在桌面端且用户已连接信息中枢时注入。
 * 未连接时返回 null——绝不为了「能用」而替用户拉起 Python 进程。
 */
export const infohubProvider: CapabilityProvider = {
  id: "infohub",
  origin: "builtin",
  build: () => buildInfohubToolsIfConnected(),
};

/**
 * 自我修改工具：只有用户**显式配置过**该智能体才注入（沿用改前口径）。
 * 配置过但关闭时仍会构建——`buildSelfToolBridge` 产出空 tools，由注册表过滤。
 */
export const selfProvider: CapabilityProvider = {
  id: "self",
  origin: "self",
  build: (ctx) => {
    const selfEdit = ctx.selfEdit;
    if (!selfEdit || !selfEdit.policy.configured(ctx.agentId)) return null;
    return buildSelfToolBridge(
      {
        memory: memoryStore,
        skills: skillPool,
        mcp: mcpRegistry,
        policy: selfEdit.policy,
        budget: selfEdit.budget,
      },
      { agentId: ctx.agentId, conversationId: ctx.conversationId },
    );
  },
};
