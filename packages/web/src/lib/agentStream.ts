import type { WsClientEvent } from "@heming/shared";
import type { LlmProfile } from "../store/llm.js";
import { streamChat, type ChatMessage, type ToolCall } from "./llmClient.js";

/** 工具调用最多允许的连续轮次（防止模型陷入「调工具→再调」死循环）。 */
export const MAX_TOOL_ROUNDS = 3;

/** 触发编排的依赖注入面：stores/WS/流式适配器由 ChatPage 组装，本模块保持纯逻辑可测。 */
/** 工具桥：把「给模型的工具声明」与「执行一次调用」交给编排层（本模块不认识 MCP）。 */
export interface ToolBridge {
  /** OpenAI 格式的 tools 数组；空数组 = 本轮没有可用工具。 */
  tools: unknown[];
  /** 执行一个工具调用（永不抛：失败也在结果里带 ok=false 与原因）。 */
  execute: (call: { name: string; arguments: string }) => Promise<{ text: string; ok: boolean }>;
}

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
  /**
   * E2E 错误封条（fix I2）：agent_error 的正文可回显供应商请求片段 → 同款信封
   * （message 置空、全文进 cipher，AAD 由接线层按 errorAad(convId, streamId) 绑定）。
   * 加密失败（抛错/null）→ 回退通用明文文案（不含原文），绝不发明文错误正文。
   */
  sealError?: (
    streamId: string,
    message: string,
  ) => Promise<{ cipher: string; chainKid?: string; n?: number } | null | undefined>;
  /**
   * 异步系统提示词构建（设计 §6）：存在时优先于 `getPrompt`（每次 mention 在流启动前 await），
   * 抛错则回落 `getPrompt`。触发端在此拼装「原提示词 + 记忆 + 技能」。
   */
  buildSystemPrompt?: (agentId: string, userText: string) => Promise<string>;
  /**
   * 工具桥（MCP 等）：返回 null 表示本轮不启用工具，行为与未接入时完全一致。
   * 有工具时每轮会**缓冲**文本，只有真正产出答案的最后一轮才上行，避免
   * 「我准备调用工具…」这类中间话术刷屏。
   */
  getTools?: (agentId: string) => ToolBridge | null;
  /**
   * 思考过程增量（reasoning/thinking）：`text` 是**累积全文**，UI 直接替换即可。
   * 只做本机展示，不上行（不参与 E2E 信封，也不进最终消息文本）。
   */
  onReasoning?: (streamId: string, text: string) => void;
  /**
   * 工具调用轨迹事件：start（即将调用）→ end（拿到结果）。同样是本机展示用。
   */
  onToolTrace?: (
    streamId: string,
    event: {
      phase: "start" | "end";
      id: string;
      name: string;
      args: string;
      ok?: boolean;
      result?: string;
    },
  ) => void;
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
  /**
   * 历史准备（设计 §4）：`fetchHistory` 之后、组装 messages 之前调用——触发端在此做
   * token 预算切分与早期对话压缩，返回值即本次要发送的历史。缺省或抛错 → 用原 history
   * （行为与加预算之前完全一致）。溢出重试（设计 §3.4）会带 `aggressive` 重新调用以收紧预算。
   */
  prepareHistory?: (
    rows: ChatMessage[],
    agentId: string,
    opts?: { aggressive?: 1 | 2 },
  ) => Promise<ChatMessage[]>;
}

/**
 * 上下文超限的供应商 400 特征（设计 §3.4）：OpenAI 的 `maximum context length`、
 * Anthropic 的 `prompt is too long`、网关转写的 `context_length_exceeded` 等。
 */
const CONTEXT_OVERFLOW_RE = /context length|context_length|maximum context|too long|reduce the length/i;
/** 收紧重试次数上限：首次之外再试 2 次（aggressive 1 → 2），不无限重试。 */
const MAX_CONTEXT_RETRIES = 2;

/**
 * 是否为「上下文超限」的失败：既要求带 400（限流/鉴权的 400 不在此列），
 * 也要求命中超限特征词；中断（AbortError / 已按中断）一律不算——abort 语义优先，不得重试。
 */
function isContextOverflow(err: Error | null | undefined, aborted: boolean): boolean {
  if (aborted || err?.name === "AbortError") return false;
  const message = String(err?.message ?? "");
  return message.includes("400") && CONTEXT_OVERFLOW_RE.test(message);
}

/** 错误信封加密失败时的通用回退文案（不含错误原文；chat store 降级口径同其 E2E_ERROR_FALLBACK）。 */
export const GENERIC_SEAL_FALLBACK = "生成出错（内容无法解密）";

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
 * - 历史准备：`deps.prepareHistory` 存在时在 fetchHistory 之后调用（缺省/抛错回落原历史）；
 *   供应商 400 命中上下文超限特征时按其 `aggressive` 收紧重试（最多 2 次，重试期间不重复上行 chunk）；
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
        // E2E 串行闸与错误上行（fix I2）——先于 profile 判定定义：无绑定分支也要发信封错误
        let idx = 0;
        // 片/错误上行串行闸：seal 读写会话链文件跨 await 交错会撞 n（同 n 密文被收端去重
        // 误杀），乱序上行还会让收端 index 与发送序错位——依次过闸再 send。
        let sealTail: Promise<void> = Promise.resolve();
        const enqueue = (job: () => Promise<void>) => {
          sealTail = sealTail.then(job, job);
        };
        /** 错误上行：注入 sealError → message 置空带信封；封失败只发通用文案（不发明文原文）。 */
        const sendError = async (code: string, message: string) => {
          const base = {
            type: "agent_error" as const,
            conversationId,
            agentId: m.agentId,
            streamId,
            code,
          };
          if (!deps.sealError) {
            deps.send({ ...base, message }); // legacy 明文路径（测试/未注入）
            return;
          }
          await enqueue(async () => {
            let sealed: Awaited<ReturnType<NonNullable<TriggerDeps["sealError"]>>> = null;
            try {
              sealed = await deps.sealError!(streamId, message);
            } catch {
              sealed = null;
            }
            if (sealed) {
              deps.send({
                ...base,
                message: "",
                cipher: sealed.cipher,
                ...(sealed.chainKid !== undefined ? { chainKid: sealed.chainKid } : {}),
                ...(sealed.n !== undefined ? { n: sealed.n } : {}),
              });
            } else {
              deps.send({ ...base, message: GENERIC_SEAL_FALLBACK }); // 无敏感正文，code 保留
            }
          });
          await sealTail;
        };
        const profile = deps.getProfile(m.agentId);
        if (!profile) {
          await sendError("provider_error", "未绑定 LLM 连接");
          return;
        }
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
        const controller = new AbortController();
        controllers.add(controller);
        if (aborted) controller.abort(); // fetchHistory 期间已按中断：启动即中止
        /** 已逐帧上行的累积：接收端按 streamId 累积的正是它（重试期间不再上行，避免重复文本）。 */
        let acc = "";
        /** 当前尝试的本地累积：成功即 finish 全文，故每次尝试归零。 */
        let local = "";
        /**
         * 工具轮里已收到但尚未上行的文本。
         *
         * 工具轮的文本要先攒着（可能是「我这就去查」这类中间话术），
         * 所以它们既不在 acc 也不在 local 里。两处要用它：
         * - 本轮确定没有工具调用 → 逐片上行（这是答案）；
         * - 中断/失败 → 作为 partial 兜底（这些字用户一个字都没看到）。
         *
         * **跨尝试保留**：溢出重试会重新调 once，若这里归零，
         * 首次尝试产出的文字就会被重试悄悄吞掉。
         */
        let buffered = "";
        /**
         * 组装一次尝试的 messages（设计 §4）：系统提示词 → 准备好的历史 → 本条 user 轮。
         * 历史每次都重新走 `prepareHistory`（溢出重试据此用收紧后的预算重切分并重新前置系统提示词）；
         * 缺省或抛错 → 原样 history（与加预算之前完全一致，绝不阻断生成）。
         */
        const messagesFor = async (
          aggressive?: 1 | 2,
          extra: ChatMessage[] = [],
        ): Promise<ChatMessage[]> => {
          let rows: ChatMessage[] = history;
          if (deps.prepareHistory) {
            try {
              rows =
                aggressive === undefined
                  ? await deps.prepareHistory(history, m.agentId)
                  : await deps.prepareHistory(history, m.agentId, { aggressive });
            } catch {
              rows = history; // 压缩失败不阻断生成：回落原样历史
            }
          }
          const prepared: ChatMessage[] = [...rows, { role: "user", content: userText }, ...extra];
          if (prompt) prepared.unshift({ role: "system", content: prompt });
          return prepared;
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
        /**
         * 一次尝试。只有第 1 次尝试上行 chunk / onLocalDelta——重试若重复上行，
         * 接收端按 streamId 累积会出现重复文本（最终文本以 finish 为准）。
         */
        /** 把一片文本按既有规则上行（本地累积 + 流式回调 + 可选的 E2E 封条）。 */
        const emitDelta = (d: string, aggressive?: 1 | 2) => {
          local += d;
          if (aggressive !== undefined) return; // 重试：只本地累积，不上行
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
        };

        /**
         * 一次尝试。只有第 1 次尝试上行 chunk / onLocalDelta——重试若重复上行，
         * 接收端按 streamId 累积会出现重复文本（最终文本以 finish 为准）。
         *
         * 工具轮：`getTools` 返回工具时，本轮文本先缓冲；拿到 tool_calls 就执行并把
         * 结果回灌，最多 MAX_TOOL_ROUNDS 轮；只有「不调用工具」的那轮文本才上行。
         */
        const once = async (aggressive?: 1 | 2) => {
          local = "";
          const bridge = deps.getTools?.(m.agentId) ?? null;
          const useTools =
            !!bridge && bridge.tools.length > 0 && profile.provider !== "anthropic" && !aborted;
          let extra: ChatMessage[] = [];
          let reasoning = "";
          for (let round = 0; ; round++) {
            // 工具轮的文本先攒着（可能是「我这就去查」这类中间话术，等工具结果回来再决定是否上行）。
            // 但要**按片攒**而不是拼成一个字符串——最终答案逐片发出才能保住打字机效果。
            // 拼成整段会让用户看到「文字突然整块蹦出来」，与无工具路径的表现不一致。
            const roundChunks: string[] = [];
            let roundText = "";
            let calls: ToolCall[] = [];
            await deps.streamChat(profile, await messagesFor(aggressive, extra), {
              signal: controller.signal,
              ...(useTools ? { tools: bridge!.tools } : {}),
              onToolCalls: (c) => {
                calls = c;
              },
              onReasoning: (t) => {
                reasoning += t;
                deps.onReasoning?.(streamId, reasoning);
              },
              onDelta: (d) => {
                if (!useTools) {
                  emitDelta(d, aggressive);
                  return;
                }
                roundChunks.push(d); // 工具轮先攒着：可能是「我这就去查」这类中间话术
                roundText += d;
                buffered += d; // 兜底用：中断时这些字还没上行，不能丢
              },
            });

            if (!useTools) return;
            // 没有工具调用 = 这一轮就是答案，逐片补发文本后结束。
            // 逐片而非整段：保住打字机效果，与无工具路径表现一致。
            if (calls.length === 0) {
              for (const chunk of roundChunks) emitDelta(chunk, aggressive);
              return;
            }
            // 到上限还在要工具：把已有文本给用户，不再无限循环
            if (round >= MAX_TOOL_ROUNDS) {
              for (const chunk of roundChunks) emitDelta(chunk, aggressive);
              console.warn(`工具调用超过 ${MAX_TOOL_ROUNDS} 轮，已停止继续调用`);
              return;
            }
            // 调用前先播一条 start（UI 立刻能看到「正在调用 X」）
            for (const call of calls) {
              deps.onToolTrace?.(streamId, {
                phase: "start",
                id: call.id,
                name: call.function.name,
                args: call.function.arguments,
              });
            }
            const results = await Promise.all(
              calls.map((call) =>
                bridge!.execute({
                  name: call.function.name,
                  arguments: call.function.arguments,
                }),
              ),
            );
            // 拿到结果后补 end（成功/失败 + 文本）
            calls.forEach((call, i) => {
              const outcome = results[i] ?? { text: "", ok: false };
              deps.onToolTrace?.(streamId, {
                phase: "end",
                id: call.id,
                name: call.function.name,
                args: call.function.arguments,
                ok: outcome.ok,
                result: outcome.text,
              });
            });
            extra = [
              ...extra,
              { role: "assistant", content: roundText, tool_calls: calls },
              ...calls.map((call, i) => ({
                role: "tool" as const,
                tool_call_id: call.id,
                name: call.function.name,
                content: results[i]?.text ?? "",
              })),
            ];
          }
        };
        try {
          /** 溢出重试（设计 §3.4）：首次 → aggressive 1 → 2，两次仍失败即交给下面的既有失败收口。 */
          let failure: Error | null = null;
          for (let attempt = 0; attempt <= MAX_CONTEXT_RETRIES; attempt++) {
            try {
              await once(attempt === 0 ? undefined : (attempt as 1 | 2));
              failure = null;
              break;
            } catch (e) {
              failure = e as Error;
              const retriable =
                attempt < MAX_CONTEXT_RETRIES &&
                deps.prepareHistory !== undefined &&
                isContextOverflow(failure, aborted || controller.signal.aborted);
              if (!retriable) break;
              // 重试对用户不可见，只在触发端控制台留痕（设计 §3.4）
              console.warn(
                `上下文超限：按 aggressive=${attempt + 1} 收紧预算重试`,
                failure.message,
              );
            }
          }
          if (failure) throw failure;
          await sealTail; // 片全部落闸后再 finish（同一发送链推进有序）
          // 成功文本取本次尝试的全文（重试成功时不含首次尝试的失败文本）
          const text = local || acc;
          if (await sendFinish(text)) {
            notifyTurnComplete(deps, m.agentId, userText, text, "ok");
          } else {
            await sendError("bad_event", "端到端加密失败，回复未发送");
          }
        } catch (e) {
          const err = e as Error;
          await sealTail.catch(() => undefined);
          // finish-partial：服务端拒空文本（F2），partial 为空则只报 error；
          // 文本优先取「已上行」的累积（与接收端所见一致），重试一字未上行时回落本次尝试的本地累积；
          // 加密失败时 sendFinish 返回 false——仍走下方 error 收口（明文不外发）
          // acc = 已上行（用户看得到）；local = 本次尝试的本地累积（含未上行的重试轮）；
          // buffered = 工具轮里收到但还没上行的字——中断时它既不在 acc 也不在 local 里，
          // 不兜底就会丢掉模型已经吐出的内容。
          const partial = acc || local || buffered;
          if (partial && (await sendFinish(partial))) {
            // 中断/失败：只写工作记忆（partial），不沉淀长期记忆（设计 §3）
            notifyTurnComplete(deps, m.agentId, userText, partial, "partial");
          }
          await sendError(err.name === "AbortError" ? "aborted" : "provider_error", err.message.slice(0, 300));
        } finally {
          controllers.delete(controller);
        }
      }),
    );
    return { abortAll };
  })();
  return Object.assign(done, { abortAll });
}
