/**
 * 多智能体协作（Multi-Agent Collaboration）的公共类型。
 *
 * 设计参考：
 * - AutoGen `ConversableAgent`：每个参与者都是「能收到上下文、能产出消息」的会话体，
 *   编排只是决定「谁在什么上下文里说话」；
 * - CrewAI `role/goal`：每人有明确的角色标签与职责，而不是同一段提示词换个人名；
 * - MetaGPT SOP：先有流程（拆解 → 执行 → 评审），再让不同角色按 SOP 交付；
 * - Anthropic orchestrator-workers：协调者拆解、工作者执行、协调者汇总。
 *
 * 约束：
 * - 只在本机运行：类型里没有任何网络/服务端字段；
 * - `CollaborationParticipant.systemPrompt` 是该智能体的私有提示词，
 *   **只传给本人**，绝不拼进其它参与者的上下文（见 engine.ts 的 buildUserMessage）。
 */

export type CollaborationMode = "sequential" | "supervisor" | "debate";

export interface CollaborationParticipant {
  agentId: string;
  name: string;
  /** 该智能体自己的系统提示词（私有，仅本人可见；不要转述给其他参与者）。 */
  systemPrompt?: string;
}

export interface CollaborationConfig {
  mode: CollaborationMode;
  /** 1-3；sequential 表示接力遍数，supervisor 表示工作者轮数，debate 表示修正轮数。 */
  rounds: number;
  participants: CollaborationParticipant[];
  task: string;
}

/** 协作中的一个回合：某位参与者的一次发言。 */
export interface CollaborationTurn {
  id: string;
  agentId: string;
  agentName: string;
  /** 本轮角色标签，如「方案」「协调者 · 拆解」「第 1 轮修正」。 */
  role: string;
  /** 轮次（0 = 拆解/汇总这类不属于某轮的工作）。 */
  round: number;
  text: string;
  startedAt: number;
  endedAt: number;
  error?: string;
  /** 被中止（保留已生成的部分文本）。 */
  aborted?: boolean;
  /** UI 流式标记（引擎结束时一律为 false；历史记录不保留该字段）。 */
  streaming?: boolean;
}

export type CollaborationStatus = "running" | "done" | "aborted" | "error";

export interface CollaborationRun {
  id: string;
  mode: CollaborationMode;
  task: string;
  participants: CollaborationParticipant[];
  rounds: number;
  turns: CollaborationTurn[];
  status: CollaborationStatus;
  startedAt: number;
  endedAt?: number;
  error?: string;
}
