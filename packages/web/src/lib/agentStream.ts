import type { WsClientEvent } from "@heming/shared";
import type { LlmProfile } from "../store/llm.js";
import { streamChat } from "./llmClient.js";

/** 触发编排的依赖注入面：stores/WS/流式适配器由 ChatPage 组装，本模块保持纯逻辑可测。 */
export interface TriggerDeps {
  getProfile: (agentId: string) => LlmProfile | undefined;
  getPrompt: (agentId: string) => string;
  fetchHistory: () => Promise<{ role: "system" | "user" | "assistant"; content: string }[]>;
  send: (e: WsClientEvent) => void;
  streamChat: typeof streamChat;
  onLocalDelta: (streamId: string, chunk: string) => void;
  /**
   * 本机流登记（streamId 生成后、无绑定分支前也回调）：触发端据此标 streamOwner、
   * 建 streaming 打字机项并记录触发文本（重试用）。缺省不影响编排本身。
   */
  onStart?: (streamId: string, mention: { agentId: string; name: string }) => void;
}

/** 一次触发的句柄：中断按钮调用后，进行中的各流 abort → catch 走 finish-partial + agent_error(aborted)。 */
export interface AgentRunHandle {
  abortAll(): void;
}

/**
 * 触发返回值 = 句柄挂在 promise 上（同一对象）：
 * - 同步 `run.abortAll()` 即可中断（不必等句柄 await 出来）；
 * - `await runAgentMentions(...)` 则等全部流跑完再解析出句柄（可断言 finish/error 已上行）。
 */
export type AgentRun = Promise<AgentRunHandle> & AgentRunHandle;

export function newStreamId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @ 触发编排：并行对各 mention 走「历史 →（系统提示词）→ 流式 → 三事件上行」。
 * - 无绑定：直接 agent_error(provider_error)，不触达供应商；
 * - 失败/中断：已有部分文本先 agent_finish(partial)（服务端入库保内容），再 agent_error
 *   （AbortError → code=aborted，其余 → provider_error），message 统一截 300 字符；
 * - abortAll 任意时刻可调：在流启动前打标（aborted），启动后逐 controller abort。
 */
export function runAgentMentions(
  conversationId: string,
  mentions: { agentId: string; name: string }[],
  userText: string,
  deps: TriggerDeps,
): AgentRun {
  const controllers = new Set<AbortController>();
  let aborted = false;
  const abortAll = () => {
    aborted = true;
    for (const c of controllers) c.abort();
  };
  const done = (async (): Promise<AgentRunHandle> => {
    const history = await deps.fetchHistory();
    await Promise.all(
      mentions.map(async (m) => {
        const streamId = newStreamId();
        deps.onStart?.(streamId, m);
        const profile = deps.getProfile(m.agentId);
        if (!profile) {
          deps.send({
            type: "agent_error",
            conversationId,
            agentId: m.agentId,
            streamId,
            code: "provider_error",
            message: "未绑定 LLM 连接",
          });
          return;
        }
        const messages = [...history, { role: "user" as const, content: userText }];
        const prompt = deps.getPrompt(m.agentId);
        if (prompt) messages.unshift({ role: "system" as const, content: prompt });
        const controller = new AbortController();
        controllers.add(controller);
        if (aborted) controller.abort(); // fetchHistory 期间已按中断：启动即中止
        let acc = "";
        try {
          await deps.streamChat(profile, messages, {
            signal: controller.signal,
            onDelta: (d) => {
              acc += d;
              deps.onLocalDelta(streamId, acc);
              deps.send({
                type: "agent_chunk",
                conversationId,
                agentId: m.agentId,
                streamId,
                text: d,
              });
            },
          });
          deps.send({
            type: "agent_finish",
            conversationId,
            agentId: m.agentId,
            streamId,
            text: acc,
          });
        } catch (e) {
          const err = e as Error;
          // finish-partial：服务端拒空文本（F2），acc 为空则只报 error
          if (acc) {
            deps.send({
              type: "agent_finish",
              conversationId,
              agentId: m.agentId,
              streamId,
              text: acc,
            });
          }
          deps.send({
            type: "agent_error",
            conversationId,
            agentId: m.agentId,
            streamId,
            code: err.name === "AbortError" ? "aborted" : "provider_error",
            message: err.message.slice(0, 300),
          });
        } finally {
          controllers.delete(controller);
        }
      }),
    );
    return { abortAll };
  })();
  return Object.assign(done, { abortAll });
}
