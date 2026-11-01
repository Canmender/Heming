import type { ToolBridge, ToolOrigin } from "../agentStream.js";
import type { SelfEditBudget, SelfEditStore } from "../selfEdit/index.js";

/**
 * 能力内核的类型面：注册表只认「谁提供工具」，不认具体是 MCP 还是图表。
 *
 * `origin` 与 `ToolBridge.meta().origin` 同源：展示与归属用，**不参与 HITL 风险判定**。
 */
export type { ToolOrigin };

/** 一次构建的上下文：按智能体/会话取工具，工具开关变化即时生效（不缓存桥）。 */
export interface CapabilityContext {
  agentId: string;
  conversationId: string;
  /**
   * 自我修改的运行态：策略对象与**单轮预算**。
   * 预算按 ChatPage 实例持有（`reset(agentId, convId)` 在每次触发前调用），
   * 因此由接线层传入，注册表不自建实例——自建会让两个 ChatPage 共享预算。
   */
  selfEdit?: { policy: SelfEditStore; budget: SelfEditBudget };
}

/** 一个能力提供者：一类工具来源。 */
export interface CapabilityProvider {
  /** 注册表内唯一；重复即抛错（插件 id 冲突必须显性失败）。 */
  id: string;
  origin: ToolOrigin;
  /** 返回 null 或空 tools 都表示「本轮不提供」。 */
  build(ctx: CapabilityContext): ToolBridge | null;
}
