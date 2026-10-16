import type { Agent } from "@heming/shared";
import { api } from "./api.js";

/**
 * 智能体名册 REST 封装（Task 2 契约：GET/POST /api/agents、PUT/DELETE /api/agents/:id）。
 * 错误统一抛 ApiError（403 系统/他人、404 不存在）；响应不含 system_prompt
 *（系统提示词只落本机 localStorage，云端 API 永不含——见 store/llm.ts）。
 */

/** 创建入参：description 服务端有 default("")，客户端可省略。 */
export interface AgentCreateBody {
  name: string;
  avatar?: string | null;
  description?: string;
}

/** 更新入参：partial（服务端 AgentBodySchema.partial() 同口径）。 */
export type AgentUpdateBody = Partial<AgentCreateBody>;

export const listAgents = () => api<Agent[]>("/api/agents");

export const createAgent = (body: AgentCreateBody) =>
  api<Agent>("/api/agents", { method: "POST", body: JSON.stringify(body) });

export const updateAgent = (id: string, patch: AgentUpdateBody) =>
  api<Agent>(`/api/agents/${id}`, { method: "PUT", body: JSON.stringify(patch) });

export const deleteAgent = (id: string) =>
  api<void>(`/api/agents/${id}`, { method: "DELETE" });
