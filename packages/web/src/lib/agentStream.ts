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
  /**
   * 异步系统提示词构建（设计 §6）：存在时优先于 `getPrompt`（每次 mention 在流启动前 await），
   * 抛错则回落 `getPrompt`。触发端在此拼装「原提示词 + 记忆 + 技能」。
   */
  buildSystemPrompt?: (agentId: string, userText: string) => Promise<string>;
  /**
   * 轮次收尾回调（设计 §3/§6）：成功 finish 记 `"ok"`；中断/失败但已有部分文本记 `"partial"`
   * （触发端据此只写工作记忆，不沉淀长期记忆）；完全无文本不回调。
   * 回调异常一律吞掉，绝不影响三事件上行。
   */
  onTurnComplete?: (
    agentId: string,
    userText: string,
    assistantText: string,
    status: "ok" | "partial",
  ) => void;
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
 * 轮次收尾回调：成功 ok / 中断与失败但有部分文本 partial。
 * 回调里的记忆写入等副作用不得反噬流式收尾（否则 catch 分支会被再次抛出：
 * partial 路径的异常会 reject 整轮 mention），故整段吞掉。
 */
function notifyTurnComplete(
  deps: TriggerDeps,
  agentId: string,
  userText: string,
  assistantText: string,
  status: "ok" | "partial",
): void {
  try {
    deps.onTurnComplete?.(agentId, userText, assistantText, status);
  } catch {
    /* 记忆/技能回调失败不影响三事件上行 */
  }
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
        // 系统提示词：deps.buildSystemPrompt 存在时优先（触发端在此拼装记忆/技能），
        // 抛错回落 getPrompt 的原提示词——上下文组装失败不影响生成
        let prompt: string;
        if (deps.buildSystemPrompt) {
          try {
            prompt = await deps.buildSystemPrompt(m.agentId, userText);
          } catch {
            prompt = deps.getPrompt(m.agentId);
          }
        } else {
          prompt = deps.getPrompt(m.agentId);
        }
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
          notifyTurnComplete(deps, m.agentId, userText, acc, "ok");
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
            // 中断/失败：只写工作记忆（partial），不沉淀长期记忆（设计 §3）
            notifyTurnComplete(deps, m.agentId, userText, acc, "partial");
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
