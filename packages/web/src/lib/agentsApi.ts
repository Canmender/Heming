import type { Agent } from "@heming/shared";
import { api } from "./api.js";

/**
 * 智能体名册 REST 封装（单智能体产品：全产品唯一内置智能体，不可创建/修改/删除）。
 * 浏览器侧只读名册；旧版 createAgent/updateAgent/deleteAgent 已随自建智能体功能删除。
 * 响应不含 system_prompt（系统提示词只落本机 localStorage，云端 API 永不含——见 store/llm.ts）。
 */

export const listAgents = () => api<Agent[]>("/api/agents");