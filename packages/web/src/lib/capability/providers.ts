import { buildChartToolBridge } from "../charts/tools.js";
import { buildInfohubToolsIfConnected } from "../infohub/tools.js";
import { buildToolBridge } from "../mcp/index.js";
import { mcpRegistry } from "../mcp/store.js";
import { memoryStore } from "../memory/index.js";
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

export const mcpProvider: CapabilityProvider = {
  id: "mcp",
  origin: "mcp",
  build: () => buildToolBridge(),
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
