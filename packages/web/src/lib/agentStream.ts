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
   * E2E 流式片封条（Task 4，设计 §5.3）：把一片 delta 封成信封（cipher/chainKid/n）。
   * 返回 null/undefined 视为「当前无法加密」→ 该片**跳过不发**（绝不降级明文片）；
   * 抛错同跳过。未注入 = 明文 legacy 路径（测试/旧端）。
   */
  sealChunk?: (
    streamId: string,
    index: number,
    text: string,
  ) => Promise<{ cipher: string; chainKid?: string; n?: number } | null | undefined>;
  /**
   * E2E finish 封条：全文进信封（text 置空上行，服务端按信封入库）。
   * 加密失败（抛错/null）→ 不发明文 finish，改报 agent_error(bad_event) 收口。
   */
  sealFinish?: (
    text: string,
  ) => Promise<{ cipher: string; chainKid?: string; n?: number } | null | undefined>;
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
        let idx = 0;
        // E2E 片上行串行闸：seal 读写会话链文件跨 await 交错会撞 n（同 n 密文被收端去重
        // 误杀），乱序上行还会让收端 index 与发送序错位——片与 finish 依次过闸再 send。
        let sealTail: Promise<void> = Promise.resolve();
        const enqueue = (job: () => Promise<void>) => {
          sealTail = sealTail.then(job, job);
        };
        const sealChunkHook = deps.sealChunk;
        /** finish 上行：注入 sealFinish → 信封（text 置空）；加密失败返回 false（调用方收口）。 */
        const sendFinish = async (text: string): Promise<boolean> => {
          if (!deps.sealFinish) {
            deps.send({ type: "agent_finish", conversationId, agentId: m.agentId, streamId, text });
            return true;
          }
          try {
            const sealed = await deps.sealFinish(text);
            if (!sealed) return false; // 无法加密 → 不发明文 finish（绝不降级）
            deps.send({
              type: "agent_finish",
              conversationId,
              agentId: m.agentId,
              streamId,
              text: "",
              cipher: sealed.cipher,
              ...(sealed.chainKid !== undefined ? { chainKid: sealed.chainKid } : {}),
              ...(sealed.n !== undefined ? { n: sealed.n } : {}),
            });
            return true;
          } catch {
            return false;
          }
        };
        try {
          await deps.streamChat(profile, messages, {
            signal: controller.signal,
            onDelta: (d) => {
              acc += d;
              deps.onLocalDelta(streamId, acc);
              if (!sealChunkHook) {
                deps.send({
                  type: "agent_chunk",
                  conversationId,
                  agentId: m.agentId,
                  streamId,
                  text: d,
                });
                return;
              }
              const index = idx++;
              enqueue(async () => {
                let sealed: Awaited<ReturnType<typeof sealChunkHook>> = null;
                try {
                  sealed = await sealChunkHook(streamId, index, d);
                } catch {
                  return; // 封失败：跳过该片（finish 全文信封兜底展示，绝不发明文片）
                }
                if (!sealed) return;
                deps.send({
                  type: "agent_chunk",
                  conversationId,
                  agentId: m.agentId,
                  streamId,
                  text: "",
                  index,
                  cipher: sealed.cipher,
                  ...(sealed.chainKid !== undefined ? { chainKid: sealed.chainKid } : {}),
                  ...(sealed.n !== undefined ? { n: sealed.n } : {}),
                });
              });
            },
          });
          await sealTail; // 片全部落闸后再 finish（同一发送链推进有序）
          if (!(await sendFinish(acc))) {
            deps.send({
              type: "agent_error",
              conversationId,
              agentId: m.agentId,
              streamId,
              code: "bad_event",
              message: "端到端加密失败，回复未发送",
            });
          }
        } catch (e) {
          const err = e as Error;
          await sealTail.catch(() => undefined);
          // finish-partial：服务端拒空文本（F2），acc 为空则只报 error；
          // 加密失败时 sendFinish 返回 false——仍走下方 error 收口（明文不外发）
          if (acc) await sendFinish(acc);
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
