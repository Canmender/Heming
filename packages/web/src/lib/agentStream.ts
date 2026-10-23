import type { WsClientEvent } from "@heming/shared";
import type { LlmProfile } from "../store/llm.js";
import { streamChat, type ChatMessage, type ToolCall } from "./llmClient.js";
import type { DenyCause, GateOutcome, RiskLevel } from "./hitl/types.js";
import { toHitlCall } from "./hitl/classify.js";
import { deniedText, notExecutedText, ruleDeniedText } from "./hitl/text.js";
import { supportsKind } from "./capabilityNotice.js";

/** 工具调用最多允许的连续轮次（防止模型陷入「调工具→再调」死循环）。 */
export const MAX_TOOL_ROUNDS = 3;

/** 触发编排的依赖注入面：stores/WS/流式适配器由 ChatPage 组装，本模块保持纯逻辑可测。 */
/** 一次流（单个 mention）的终态：成功 / 中断 / 失败，每次流恰好一次。 */
export interface RunSettled {
  status: "ok" | "aborted" | "error";
  /** 成功或中断时的最终文本（中断时为已产生的部分文本）。 */
  finalText?: string;
  /** 失败原因（status="error" 时有值）。 */
  error?: string;
}

/** 工具结果里附带的一条来源（如知识库页面）。 */
export interface ToolSource {
  /** 稳定标识（wiki 页面路径）。 */
  id: string;
  /** 展示标题。 */
  title: string;
  /** 可选的补充定位信息（类别、片段）。 */
  detail?: string;
}

/** 答案末尾来源脚注最多列几条（再多用户也不会看）。 */
export const MAX_SOURCES = 8;

/**
 * 把工具带回的来源拼成确定性脚注。
 *
 * 为什么由编排层拼而不是让模型自己写：模型会漏、会编、会改标题；
 * 脚注只在**工具真的返回过该来源**时出现，按首次出现顺序去重，
 * 与模型是否在正文里引用无关——它至少保证「用了知识库就有可点核的来源」。
 */
export function sourceFooter(sources: ToolSource[]): string {
  const seen = new Set<string>();
  const uniq: ToolSource[] = [];
  for (const s of sources) {
    const id = String(s?.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniq.push({ ...s, id });
    if (uniq.length >= MAX_SOURCES) break;
  }
  if (!uniq.length) return "";
  const line = (s: ToolSource) =>
    `- ${String(s.title ?? s.id).replace(/\s+/g, " ").slice(0, 120)}（${s.id.replace(/[\r\n]+/g, " ")}）`;
  return `\n\n---\n来源（来自本机知识库）：\n${uniq.map(line).join("\n")}`;
}

/** 工具桥：把「给模型的工具声明」与「执行一次调用」交给编排层（本模块不认识 MCP）。 */
export interface ToolBridge {
  /** OpenAI 格式的 tools 数组；空数组 = 本轮没有可用工具。 */
  tools: unknown[];
  /** 执行一个工具调用（永不抛：失败也在结果里带 ok=false 与原因）。 */
  execute: (call: {
    name: string;
    arguments: string;
  }) => Promise<{ text: string; ok: boolean; sources?: ToolSource[] }>;
  /**
   * 工具的风险元数据（可选）：闸门用它判断该调用该不该问用户。
   *
   * 缺省按 `risk=write` 处理——**这是安全默认**：认不出来的工具宁可多问一次，
   * 也不要把一个没见过的工具当成只读放过去。
   */
  meta?: (name: string) => { risk?: RiskLevel; displayName?: string } | undefined;
}

export interface TriggerDeps {
  getProfile: (agentId: string) => LlmProfile | undefined;
  getPrompt: (agentId: string) => string;
  /**
   * 历史（按调用方给的 profile 组装）：视觉模型才会把图片片附进历史，
   * 因此这里把 profile 透传下去，而不是先取一份与模型无关的历史。
   */
  fetchHistory: (profile: LlmProfile) => Promise<ChatMessage[]>;
  /**
   * 本轮 user 行的组装（可选）：图片/文档与正文同发时，触发端在这一行里带上文档文本
   * 与图片内容片——刚上传的附件还没进历史（回声未到），不这样就得等下一轮。
   * profile 决定图片能不能附（视觉能力按本智能体绑定的模型判定）。
   * 缺省或抛错 → 纯文本 user 行，与没有本钩子时逐字等价。
   */
  buildUserTurn?: (text: string, profile: LlmProfile) => Promise<ChatMessage>;
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
   *
   * `denied` 只在「用户拒绝了这次调用」时为真：轨迹里必须让用户看得见
   * 「我真的拒绝了」——否则用户会以为工具真的执行过了。
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
      denied?: boolean;
      /** 本调用成功返回的来源（仅 ok=true 时带；任务区汇总来源用）。 */
      sources?: ToolSource[];
      /** 被拒原因（denied=true 时带：用户当场拒绝 / 命中记住的规则 / 闸门异常）。 */
      denyCause?: DenyCause;
    },
  ) => void;
  /**
   * 一次流（单个 mention）的**终态**回调：成功 / 中断 / 失败，每次流恰好一次。
   *
   * 与 `onTurnComplete` 的区别：后者只关心「有没有可记忆的文本」，
   * 完全无文本的失败不回调；任务区需要**每个流都有终态**——
   * 否则失败的流会永远停在「进行中」。
   * 回调异常一律吞掉，绝不影响三事件上行。
   */
  onRunSettled?: (streamId: string, result: RunSettled) => void;
  /**
   * 工具执行前的**人工确认闸门**（HITL）：返回的数组**长度与顺序必须与 calls 一致**。
   *
   * 抛错 / 条数对不上 → 一律按**拒绝**处理（补 deny，不是放行）；
   * 缺省 → 全放行（行为与未接入时逐字等价）。
   *
   * 「闸门故障不得阻断生成」= 模型总能收到一条 `tool` 消息，
   * 不等于「工具总能执行」。兜底往执行倒，UI 一坏就是危险操作静默放行。
   *
   * 判定为「拒绝」的项**不会被执行**——编排层改回一段明确声明「未修改」的文案，
   * 让模型知道这次调用没有落地（否则它会以为写了一半）。
   */
  confirmToolCalls?: (
    calls: ToolCall[],
    ctx: { agentId: string; agentName: string; streamId: string; conversationId: string },
  ) => Promise<GateOutcome[]>;
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
  /**
   * 本轮运行的 token 用量记账（d.32）：成功收口前调用**恰好一次**。
   * - `tokens` = 本次运行各轮累加的用量（优先 totalTokens，没有则 input+output）；
   * - `null` = 供应商一次都没上报（**不是 0**——「未上报」与「真的用了 0」必须能区分）；
   * - 失败/中止的运行**不调用**：没跑完的用量口径不清，记了反而误导。
   * 走注入而不是直接 import store：本模块保持纯逻辑可测。
   */
  recordUsage?: (model: string, tokens: number | null) => void;
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

/** 终态回调：任务区/日志等副作用失败不得反噬流的收口。 */
function notifyRunSettled(deps: TriggerDeps, streamId: string, result: RunSettled): void {
  try {
    deps.onRunSettled?.(streamId, result);
  } catch {
    /* 终态记录失败不影响三事件上行 */
  }
}

/**
 * 闸门调用：把一批 tool_calls 交给接线层裁决，返回与 calls **等长同序**的放行/拒绝结果。
 *
 * 两条降级口径（都是「宁可拒绝也不误放行」）：
 * - 钩子抛错 → 全部拒绝；
 * - 返回条数与 calls 不一致 → 全部拒绝（下游按下标对齐，对不上就不能信）。
 *
 * 未注入钩子时**不产生任何额外对象**，直接沿用原来的执行路径——
 * 这是向后兼容铁律：没接闸门时行为与接入之前逐字等价。
 */
async function confirmToolCalls(
  deps: TriggerDeps,
  calls: ToolCall[],
  ctx: { agentId: string; agentName: string; streamId: string; conversationId: string },
): Promise<GateOutcome[] | null> {
  if (!deps.confirmToolCalls) return null;
  try {
    const outcomes = await deps.confirmToolCalls(calls, ctx);
    if (Array.isArray(outcomes) && outcomes.length === calls.length) return outcomes;
    console.warn("HITL 闸门返回条数与工具调用数不一致，本轮按拒绝处理");
  } catch (e) {
    console.warn("HITL 闸门异常，本轮按拒绝处理", e);
  }
  return calls.map((call) => ({
    kind: "deny" as const,
    call: toHitlCall(call),
    reason: "确认流程异常，本次调用未执行",
    cause: "gate" as const,
  }));
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
    await Promise.all(
      mentions.map(async (m) => {
        const streamId = newStreamId();
        deps.onStart?.(streamId, m);
        /** 终态恰好一次：成功/中断/失败与「无绑定」「读历史失败」等早退路径共用此闸。 */
        let settled = false;
        const settle = (result: RunSettled) => {
          if (settled) return;
          settled = true;
          notifyRunSettled(deps, streamId, result);
        };
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
          settle({ status: "error", error: "未绑定 LLM 连接" });
          await sendError("provider_error", "未绑定 LLM 连接");
          return;
        }
        // 历史按本智能体的模型能力组装（视觉模型才带图片片）；取历史放在绑定判定之后，
        // 无绑定分支不再白读一次消息。
        // 读历史失败发生在主 try 之外（原有行为：整轮 reject，触发端提示启动失败），
        // 但任务区仍需要一个终态，否则该任务会一直停在「进行中」。
        let history: ChatMessage[];
        try {
          history = await deps.fetchHistory(profile);
        } catch (e) {
          settle({ status: "error", error: (e as Error)?.message?.slice(0, 300) || "读取历史失败" });
          throw e;
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
         * Token 用量累加（d.32）：一次运行可能有多轮工具调用（每轮一次 streamChat），
         * 每轮拿到多少就加多少。每次尝试开始时归零——溢出重试的失败尝试没跑完，
         * 不并入最终口径（失败/中止的运行整体不记账）。
         */
        let usageTotal = 0;
        let usageSeen = false;
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
          /** 本轮 user 行：触发端可附文档文本与图片内容片；缺省/抛错回落纯文本行。 */
          let userTurn: ChatMessage = { role: "user", content: userText };
          if (deps.buildUserTurn) {
            try {
              userTurn = await deps.buildUserTurn(userText, profile);
            } catch {
              /* 当前轮附件组装失败不阻断生成：按纯文本行发 */
            }
          }
          const prepared: ChatMessage[] = [...rows, userTurn, ...extra];
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
          usageTotal = 0;
          usageSeen = false;
          const bridge = deps.getTools?.(m.agentId) ?? null;
          // 工具需要两个条件：桥形状是 OpenAI tools（Anthropic 的 content blocks 不兼容），
          // 且能力表认定该模型支持函数调用——不支持时给了也没用，反而让模型胡言「我去查一下」。
          const useTools =
            !!bridge &&
            bridge.tools.length > 0 &&
            supportsKind(profile, "tools") &&
            !aborted;
          let extra: ChatMessage[] = [];
          let reasoning = "";
          /** 本轮尝试里工具实际返回过的来源（被拒/失败的不算）。 */
          const sources: ToolSource[] = [];
          /** 把来源脚注补在答案末尾（无来源时不发）。 */
          const emitFooter = () => {
            const footer = sourceFooter(sources);
            if (footer) emitDelta(footer, aggressive);
          };
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
              onUsage: (u) => {
                // 优先总用量；没有就 input+output；两者都缺 = 这个包没上报（不按 0 计）。
                const t =
                  u.totalTokens ??
                  (u.inputTokens !== undefined || u.outputTokens !== undefined
                    ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
                    : undefined);
                if (t === undefined) return;
                usageSeen = true;
                usageTotal += t;
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
              emitFooter();
              return;
            }
            // 到上限还在要工具：把已有文本给用户，不再无限循环
            if (round >= MAX_TOOL_ROUNDS) {
              for (const chunk of roundChunks) emitDelta(chunk, aggressive);
              emitFooter();
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
            // HITL 闸门：执行**之前**问用户。被拒的项绝不调用 bridge.execute。
            // 未注入闸门时 outcomes 为 null，走原来的执行路径（逐字等价）。
            const outcomes = await confirmToolCalls(deps, calls, {
              agentId: m.agentId,
              agentName: m.name,
              streamId,
              conversationId,
            });
            const results = await Promise.all(
              calls.map(async (call, i) => {
                const outcome = outcomes?.[i];
                if (outcome?.kind === "deny") {
                  // 被拒：回一段明确声明「未修改」的文案，让模型知道这次没落地。
                  // ok=false 也会让轨迹显示成失败态，UI 另行标「已拒绝」。
                  //
                  // 文案按原因分流：闸门异常 / 命中记住的规则 / 用户当场拒绝，
                  // 三者对模型的含义不同，尤其异常不能被说成「用户拒绝了」。
                  const text =
                    outcome.cause === "gate"
                      ? notExecutedText(outcome.call, outcome.reason)
                      : outcome.cause === "rule"
                        ? ruleDeniedText(outcome.call, outcome.reason)
                        : deniedText(outcome.call, outcome.reason);
                  return { text, ok: false };
                }
                return bridge!.execute({
                  name: call.function.name,
                  arguments: call.function.arguments,
                });
              }),
            );
            // 按调用顺序收集来源（不按 Promise 完成顺序），脚注顺序才可复现。
            // 被拒/失败的结果不算「引用过」——它们根本没读到内容。
            for (const result of results) {
              if (result.ok && result.sources?.length) sources.push(...result.sources);
            }
            // 拿到结果后补 end（成功/失败 + 文本）
            calls.forEach((call, i) => {
              const result = results[i] ?? { text: "", ok: false };
              const gate = outcomes?.[i];
              const denied = gate?.kind === "deny";
              deps.onToolTrace?.(streamId, {
                phase: "end",
                id: call.id,
                name: call.function.name,
                args: call.function.arguments,
                ok: result.ok,
                result: result.text,
                ...(denied ? { denied: true } : {}),
                // 只有真正执行且成功的结果才算「引用过」——被拒/失败没读到内容。
                ...(result.ok && result.sources?.length ? { sources: result.sources } : {}),
                ...(denied && gate?.cause ? { denyCause: gate.cause } : {}),
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
            // 用量记账：成功收口前恰好一次；一次都没拿到就记 null（未上报）。
            // 记账是旁路副作用，失败不得反噬收口（与 onRunSettled 同口径吞掉）。
            try {
              deps.recordUsage?.(profile.model, usageSeen ? usageTotal : null);
            } catch {
              /* 记账失败不影响三事件上行 */
            }
            settle({ status: "ok", finalText: text });
          } else {
            settle({ status: "error", error: "端到端加密失败，回复未发送" });
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
          // 中断判定同时看错误名与两个标志：controller.abort() 在部分适配器里
          // 被包装成普通 Error，只看 name 会把用户主动中断记成失败。
          const abortedRun = err.name === "AbortError" || aborted || controller.signal.aborted;
          try {
            if (partial && (await sendFinish(partial))) {
              // 中断/失败：只写工作记忆（partial），不沉淀长期记忆（设计 §3）
              notifyTurnComplete(deps, m.agentId, userText, partial, "partial");
            }
            await sendError(abortedRun ? "aborted" : "provider_error", err.message.slice(0, 300));
          } finally {
            // 终态先于异常传播落定：sendError 抛错（发送链异常）时任务区也要收口。
            settle({
              status: abortedRun ? "aborted" : "error",
              ...(partial ? { finalText: partial } : {}),
              ...(abortedRun ? {} : { error: err.message.slice(0, 300) }),
            });
          }
        } finally {
          controllers.delete(controller);
        }
      }),
    );
    return { abortAll };
  })();
  return Object.assign(done, { abortAll });
}
