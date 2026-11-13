import type { WsClientEvent } from "@heming/shared";
import type { LlmProfile } from "../store/llm.js";
import {
  streamChat,
  type ChatMessage,
  type ContentPart,
  type RouteAttempt,
  type ToolCall,
} from "./llmClient.js";
import type { DenyCause, GateOutcome, RiskLevel } from "./hitl/types.js";
import { toHitlCall } from "./hitl/classify.js";
import { deniedText, notExecutedText, ruleDeniedText } from "./hitl/text.js";
import { supportsKind } from "./capabilityNotice.js";
import { IMAGE_TOKEN_COST, estimateTokens } from "./agentContext/tokens.js";
import { foldToolResults } from "./agentContext/toolResults.js";
import { discoverTools, searchTools } from "./mcp/discovery.js";
import { truncateToolResult, type ToolImage } from "./mcp/bridge.js";
import { resolveCapability } from "./modelCaps.js";
import type { RolloutInput } from "./rollout/types.js";

/**
 * 工具调用最多允许的连续轮次。
 *
 * 曾经是 3——真实任务（搜→读→改→验证）刚好第 4 步就被砍，而用户看不出是被截断的。
 * 现在提到 12，只作为「防死循环」的兜底；真正的收敛条件是 `MAX_TURN_TOOL_TOKENS`
 * 与 `MAX_TOOL_CONTEXT_TOKENS`（预算驱动，而不是轮次驱动）。
 */
export const MAX_TOOL_ROUNDS = 12;

/**
 * 单次运行里**回灌给模型的工具结果总量上限**（token）。
 *
 * 工具轮每轮都把「历史 + 已累积的全部工具结果」重发一遍，输入成本随轮次线性涨。
 * 到这里就收口：把已有文本给用户，并明确告知「还能继续」，而不是悄悄停在半路。
 */
export const MAX_TURN_TOOL_TOKENS = 12_000;

/**
 * 工具目录超过多少个就切到「按需发现」。
 *
 * 20 是经验值：十个以内的工具全部展示最省事（模型不需要多花一轮检索），
 * 超过二十个之后提示词里光 schema 就上千 token，检索的收益开始覆盖多一轮的成本。
 */
export const TOOL_SEARCH_THRESHOLD = 20;

/** 发现模式下默认展示多少个工具（其余靠检索）。 */
export const MAX_VISIBLE_TOOLS = 20;

/** 检索工具的名字（内部工具，不来自 MCP）。 */
export const TOOL_SEARCH_NAME = "tool_search";

/** 一次检索最多返回几个工具：太多等于把目录又塞回去了。 */
export const TOOL_SEARCH_LIMIT = 8;

/**
 * 检索工具自身对模型的声明。
 *
 * 描述里必须说清「只返回名字与一句话」——否则模型会以为检索结果就是工具输出，
 * 拿一句说明当答案回给用户。
 */
const TOOL_SEARCH_SPEC = {
  type: "function",
  function: {
    name: TOOL_SEARCH_NAME,
    description:
      "按关键词检索本机可用的工具。工具数量较多时只展示了一部分，其余需要通过本工具检索；" +
      "返回的是工具名与一句话说明（不是工具执行结果），命中后即可在同一轮后续调用里直接使用。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词，如服务名、动作名（天气、搜索、写入）" },
      },
      required: ["query"],
    },
  },
};

/** 触发编排的依赖注入面：stores/WS/流式适配器由 ChatPage 组装，本模块保持纯逻辑可测。 */
/** 一次流（单个 mention）的终态：成功 / 中断 / 失败，每次流恰好一次。 */
export interface RunSettled {
  status: "ok" | "aborted" | "error";
  /** 成功或中断时的最终文本（中断时为已产生的部分文本）。 */
  finalText?: string;
  /** 失败原因（status="error" 时有值）。 */
  error?: string;
}

/** 工具结果里附带的一条来源（如知识库页面、本机归档消息）。 */
export interface ToolSource {
  /** 稳定标识（wiki 页面路径、归档消息 id）。 */
  id: string;
  /** 展示标题。 */
  title: string;
  /** 可选的补充定位信息（类别、片段）。 */
  detail?: string;
  /**
   * 来源类型：脚注标题按它区分「本机知识库」与「本机归档」。
   * 缺省按 wiki 处理，保持旧来源的行为不变。
   */
  kind?: "wiki" | "archive";
}

/**
 * 等工具/等审批期间的心跳间隔（毫秒）。
 *
 * 界面按 60 秒无刷新判断「卡死」（`packages/web/src/store/chat.ts` 的 `STREAM_STALE_MS`）。
 * 一次工具调用可以合法地跑几分钟（MCP 单次超时上限 600 秒），所以要在中途定期刷新，
 * 否则工具还在跑、界面已经写「长时间无响应，生成可能已中断」。取 15 秒 —— 留足四次余量。
 */
export const HEARTBEAT_MS = 15_000;

/**
 * 给一段「可能很久没有新内容」的等待挂上心跳。
 *
 * 只包工具执行与人工审批：模型流本身如果长时间不出字，那是上游卡住，应当让看门狗报警，
 * 不能用心跳掩盖。回调抛错、没有接心跳钩子都不影响被包装的 Promise。
 */
function withHeartbeat<T>(deps: TriggerDeps, streamId: string, job: Promise<T>): Promise<T> {
  const beat = deps.onHeartbeat;
  if (!beat) return job;
  const timer = setInterval(() => {
    try {
      beat(streamId);
    } catch {
      /* 心跳失败不影响生成 */
    }
  }, HEARTBEAT_MS);
  return job.finally(() => clearInterval(timer));
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
  const hasArchive = uniq.some((s) => s.kind === "archive");
  const hasWiki = uniq.some((s) => s.kind !== "archive");
  const label = hasArchive && hasWiki ? "来源（本机知识库与本机归档）" : hasArchive ? "来源（来自本机归档）" : "来源（来自本机知识库）";
  return `\n\n---\n${label}：\n${uniq.map(line).join("\n")}`;
}

/** 工具来源分类：展示与归属用，**不参与** HITL 风险判定。 */
export type ToolOrigin = "mcp" | "builtin" | "self" | "plugin";

/** 工具桥：把「给模型的工具声明」与「执行一次调用」交给编排层（本模块不认识 MCP）。 */
export interface ToolBridge {
  /** OpenAI 格式的 tools 数组；空数组 = 本轮没有可用工具。 */
  tools: unknown[];
  /**
   * 执行一个工具调用（永不抛：失败也在结果里带 ok=false 与原因）。
   *
   * `opts.signal` 是本次运行的 AbortSignal：用户点中断时，在途的工具调用应当尽快收手。
   * 桥实现可以不支持取消（stdio 的 IPC 就没有取消语义），但**必须**在返回文案里说清
   * 「可能仍在运行」，不能让用户以为已经停了。
   */
  execute: (
    call: { name: string; arguments: string },
    opts?: { signal?: AbortSignal },
  ) => Promise<{ text: string; ok: boolean; sources?: ToolSource[]; images?: ToolImage[] }>;
  /**
   * 工具的风险元数据（可选）：闸门用它判断该调用该不该问用户。
   *
   * 缺省按 `risk=write` 处理——**这是安全默认**：认不出来的工具宁可多问一次，
   * 也不要把一个没见过的工具当成只读放过去。
   */
  meta?: (name: string) => {
    risk?: RiskLevel;
    displayName?: string;
    /** 来源与提供者 id 由能力注册表统一补齐（见 lib/capability）。 */
    origin?: ToolOrigin;
    providerId?: string;
  } | undefined;
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
   * 心跳：等工具执行、等用户审批这类**长时间没有新内容**的阶段定期回调一次。
   *
   * 界面侧会按「多久没刷新」判断流是不是卡死（`sweepStaleStreams`，60 秒）。
   * 一次合法的工具调用可能比这更久（MCP 单次超时可配到 600 秒、审批更久），
   * 不发心跳就会在工具还在跑的时候显示「长时间无响应，生成可能已中断」。
   * 回调异常一律吞掉（心跳失败不能影响生成）。
   */
  onHeartbeat?: (streamId: string) => void;
  /**
   * 逐候选留痕（d.48 路由组）：候选链每问一个候选回调一次，**只在本机展示**，绝不上行。
   * 单连接（链长 1）时路由层直接透传，从不回调——与没有本钩子时逐字等价。
   */
  onAttempt?: (streamId: string, attempt: RouteAttempt) => void;
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
   *
   * `served`（d.48 路由组）：**真正答话的那个连接**。走候选链时 profile 是
   * `route.<gid>` 合成档，按它记账会把「哪个 Key 花的钱」彻底糊掉（价目与额度都按 Key 走）；
   * 单连接没有留痕时为 undefined，调用方按 profile.id 记即可。
   */
  recordUsage?: (
    model: string,
    tokens: number | null,
    served?: { profileId: string; profileLabel?: string; input?: number; output?: number },
  ) => void;
  /**
   * 回合事件日志（G6）：每回合开始/每次工具调用与结果/最终答案/终态各回调一次。
   *
   * 与 `onToolTrace` 的区别：轨迹是**给本机界面看的瞬时展示**（含 args 原文、随组件卸载消失），
   * 日志是**可回放的记录**（带时间戳、有上限、能读回来）。两者不合并：
   * 展示层的字段说改就改，日志格式则要长期稳定。
   *
   * 回调异常一律吞掉——记录失败绝不能影响一次已经生成好的回答。
   */
  onRollout?: (item: RolloutInput) => void;
  /**
   * 分叉来源（d.56）：本回合从哪个回合的第 `seq` 条 item 之后接着执行。
   *
   * 只写进日志的 `turn_start`，不影响请求组装——服务端不知道「这是分叉」，
   * 也不需要知道（§7：分叉是任务区的能力，不往消息流里塞系统提示）。
   */
  forkedFrom?: { streamId: string; seq: number };
  /**
   * 分叉前缀（d.56）：由 `buildForkPrefix` 从本机日志重建的 extra
   * （`assistant.tool_calls` + `tool` 结果，等长同序）。
   *
   * 接在**真实会话历史之后**再走 `prepareHistory`：置后是刻意的——
   * 早期对话压缩只动前面的历史，重建出来的前缀必须原样留给模型，
   * 否则「分叉」会退化成「重跑」。
   */
  forkPrefix?: ChatMessage[];
}

/**
 * 上下文超限的供应商 400 特征（设计 §3.4）：OpenAI 的 `maximum context length`、
 * Anthropic 的 `prompt is too long`、网关转写的 `context_length_exceeded` 等。
 */
const CONTEXT_OVERFLOW_RE = /context length|context_length|maximum context|too long|reduce the length/i;

/**
 * 严格 400 里另一类「重发就有救」的：工具调用配对破了。
 *
 * 本地组装的请求有个已知风险——预算/摘要切点落在 `assistant(tool_calls)` 与其
 * `role:"tool"` 结果之间，会切出孤儿工具消息，供应商直接 400
 * （`messages with role 'tool' must be a response to a preceding message with 'tool_calls'`）。
 * 这类错误用更紧的历史重试一次是能救回来的（切点更靠后，配对自然完整），
 * 所以和超限一样纳入重试判定；只是「历史没变短的重试」照样没意义（见 prepareHistory 的强制收缩）。
 */
const TOOL_PAIRING_400_RE = /tool_call|tool_calls|tool message|role '?tool'?|corresponding/i;
/** 收紧重试次数上限：首次之外再试 2 次（aggressive 1 → 2），不无限重试。 */
const MAX_CONTEXT_RETRIES = 2;

/**
 * 是否为「上下文超限」的失败：既要求带 400（限流/鉴权的 400 不在此列），
 * 也要求命中超限特征词；中断（AbortError / 已按中断）一律不算——abort 语义优先，不得重试。
 */
function isContextOverflow(err: Error | null | undefined, aborted: boolean): boolean {
  if (aborted || err?.name === "AbortError") return false;
  const message = String(err?.message ?? "");
  const candidate = (err as unknown as { status?: unknown } | null | undefined)?.status;
  const status = typeof candidate === "number" ? candidate : 0;
  /**
   * 413 是「请求体太大」，语义上就是塞不下了，但错误文本里没有 `400`。
   * 只看 `400` 会把这类超限当成普通失败直接抛给用户——而它恰恰是收紧历史能救的。
   */
  if (status === 413) return true;
  if (!message.includes("400") && status !== 400) return false;
  return CONTEXT_OVERFLOW_RE.test(message) || TOOL_PAIRING_400_RE.test(message);
}

/**
 * 最后一次「问成功」的候选 = 真正答话的那个（d.48 记账归属）。
 *
 * 工具循环会留多条成功留痕，但都指向同一候选；换过候选时**最后一条**才是
 * 发出正文的那个——记在链首候选上等于把账记在别人头上。
 * 没有留痕（单连接透传）返回 undefined，调用方回落到 profile 自身。
 */
function servingAttempt(attempts: RouteAttempt[]): RouteAttempt | undefined {
  for (let i = attempts.length - 1; i >= 0; i--) if (attempts[i].ok) return attempts[i];
  return undefined;
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
        /**
         * 回合日志：与 `settle` 同层的一次性副作用收集点。
         * 单独包一层是因为**任何一条记录失败都不能影响对话**——包括 JSON 序列化爆栈这种。
         */
        const record = (item: RolloutInput) => {
          try {
            deps.onRollout?.(item);
          } catch {
            /* 日志失败静默：它只服务复盘，不服务本次生成 */
          }
        };
        record({
          type: "turn_start",
          conversationId,
          streamId,
          agentId: m.agentId,
          userText,
          ...(deps.forkedFrom ? { forkedFrom: deps.forkedFrom } : {}),
        });
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
          record({ type: "turn_end", streamId, status: "error", error: "未绑定 LLM 连接" });
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
          record({
            type: "turn_end",
            streamId,
            status: "error",
            error: (e as Error)?.message?.slice(0, 300) || "读取历史失败",
          });
          settle({ status: "error", error: (e as Error)?.message?.slice(0, 300) || "读取历史失败" });
          throw e;
        }
        /**
         * 分叉前缀（d.56）：重建出来的 extra 接在**真实历史之后**，
         * 之后所有组装（含 prepareHistory 的压缩与溢出重试）都看这一份——
         * 压缩只动前面，前缀原样保留；否则分叉会退化成重跑。
         */
        const historyWithFork: ChatMessage[] = deps.forkPrefix?.length
          ? [...history, ...deps.forkPrefix]
          : history;
        /**
         * 降级提示只讲一次：这几条回落都在「组装请求」里，工具轮每轮都会重进，
         * 逐轮重复会把气泡刷满；但也不能静默——附件被丢掉、历史压缩失败，
         * 用户看到的回答会莫名其妙（「我明明传了文件」/「上一轮说过的它怎么忘了」）。
         */
        let degradeNoticed = false;
        // 先存起来、等 emitDelta 可用再外发：这几处回落发生在组装请求阶段，
        // 早于 emitDelta 的声明（它会用到这里是后声明的 sealChunkHook）。
        let pendingNotice: string | null = null;
        const noticeDegrade = (text: string) => {
          if (degradeNoticed) return;
          degradeNoticed = true;
          pendingNotice = text;
        };
        // 系统提示词：deps.buildSystemPrompt 存在时优先（触发端在此拼装记忆/技能），
        // 抛错回落 getPrompt 的原提示词——上下文组装失败不影响生成
        let prompt: string;
        if (deps.buildSystemPrompt) {
          try {
            prompt = await deps.buildSystemPrompt(m.agentId, userText);
          } catch (error) {
            prompt = deps.getPrompt(m.agentId);
            const reason = error instanceof Error ? error.message : String(error);
            noticeDegrade(`\n\n（本轮上下文组装失败：${reason}。这一轮只有基础提示词。）`);
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
         * 提示词/生成拆分累加（d.48 记账用）：口径与 usageTotal 一致（含前缀缓存的
         * （d.93 起网关统一 OpenAI 形状，不再有缓存 token 口径），
         * 缓存命中其实更便宜，估出来只会偏贵不会偏便宜。
         */
        let usageInput = 0;
        let usageOutput = 0;
        /** 报了 usage 的轮数 / 其中报了完整 input+output 的轮数（两者相等才敢给拆分）。 */
        let usageRounds = 0;
        let usageSplitRounds = 0;
        /**
         * 候选链留痕（d.48）：绑路由组时每次问候选都留一条，用于①气泡里显示「换了谁」
         * ②失败收口时说清「都问过谁」（否则错误只说最后一个候选的状态码）。
         * 单连接不回调，数组恒空。
         */
        const attempts: RouteAttempt[] = [];
        /**
         * 历史准备结果按 aggressive 级别缓存（P2-6）：工具轮每轮都要重新组装 messages，
         * 但**一次 run 内历史不会变**——每轮都调 `prepareHistory` 会在 12 轮工具循环里
         * 反复压同一份历史、反复调用摘要模型（白花 token 与延迟）。溢出重试换了级别
         * 才是真的需要重新切分，所以 key 取 `aggressive ?? 0`。
         */
        /**
         * 本条 user 行：触发端可附文档文本与图片内容片；缺省/抛错回落纯文本行。
         *
         * ★ 按尝试缓存（P2-6 同源）：工具轮每轮都重新组装请求，而这一行在一次 run 内
         * 是常量。不缓存的话，一个几 MB 的附件（图片要读文件转 base64）会被读 12 次，
         * 白耗磁盘与内存，中途文件被改还会前后不一致。
         */
        let userTurnJob: Promise<ChatMessage> | null = null;
        const userTurnOnce = (): Promise<ChatMessage> => {
          if (userTurnJob) return userTurnJob;
          userTurnJob = (async () => {
            if (!deps.buildUserTurn) return { role: "user", content: userText } as ChatMessage;
            try {
              return await deps.buildUserTurn(userText, profile);
            } catch (error) {
              // 附件（文档正文/图片）没组装出来：这一轮只能是纯文本，必须让用户知道。
              const reason = error instanceof Error ? error.message : String(error);
              noticeDegrade(`\n\n（附件没能随这条消息发出：${reason}。这一轮只发了文字。）`);
              return { role: "user", content: userText } as ChatMessage;
            }
          })();
          return userTurnJob;
        };
        const historyCache = new Map<number, ChatMessage[]>();
        /**
         * 组装一次尝试的 messages（设计 §4）：系统提示词 → 准备好的历史 → 本条 user 轮。
         * 历史按 aggressive 级别缓存（见上）；缺省或抛错 → 原样 history
         * （与加预算之前完全一致，绝不阻断生成）。
         */
        const messagesFor = async (
          aggressive?: 1 | 2,
          extra: ChatMessage[] = [],
        ): Promise<ChatMessage[]> => {
          const cacheKey = aggressive ?? 0;
          let rows = historyCache.get(cacheKey);
          if (!rows) {
            rows = historyWithFork;
            if (deps.prepareHistory) {
              try {
                rows =
                  aggressive === undefined
                    ? await deps.prepareHistory(historyWithFork, m.agentId)
                    : await deps.prepareHistory(historyWithFork, m.agentId, { aggressive });
              } catch (error) {
                rows = historyWithFork; // 压缩失败不阻断生成：回落原样历史
                const reason = error instanceof Error ? error.message : String(error);
                noticeDegrade(
                  `\n\n（历史压缩失败：${reason}。这一轮按原始历史发送，可能更快撞到长度上限。）`,
                );
              }
            }
            historyCache.set(cacheKey, rows);
          }
          // 本轮 user 行：按尝试缓存（见 userTurnOnce），工具轮不重读附件。
          const userTurn = await userTurnOnce();
          /**
           * 工具结果回灌预算（G5）：组装请求**之前**折叠较早的工具结果。
           *
           * 为什么放在这一层而不是等供应商 400：工具轮每轮重发全部历史 + 全部工具结果，
           * 超限是**结构性必然**而不是意外。等报错再收紧，用户已经白等两个来回。
           * 折叠只动 `role=tool` 的正文，消息条数不变——删消息会让 tool_call 对不上，直接 400。
           */
          const folded = extra.length
            ? foldToolResults(extra).rows
            : extra;
          const prepared: ChatMessage[] = [...rows, userTurn, ...folded];
          if (prompt) prepared.unshift({ role: "system", content: prompt });
          /**
           * 多条 system 合成一条：历史压缩会把摘要以第二条 system 插在 recent 之前，
           * 而供应商对「多条 system」态度不一（有的只认第一条、有的直接 400）。
           * 合并只改形状不改内容，顺序保持「主提示词 → 摘要」——摘要本来就带
           * 「与最近对话冲突时以最近对话为准」的说明。
           */
          const systemRows = prepared.filter((row) => row.role === "system");
          const merged = systemRows.length > 1
            ? (() => {
                const text = systemRows
                  .map((row) => String(row.content ?? ""))
                  .filter((part) => part.trim())
                  .join("\n\n");
                return [
                  { role: "system" as const, content: text },
                  ...prepared.filter((row) => row.role !== "system"),
                ];
              })()
            : prepared;
          // 降级提示在已中止时不再补发；拼在正文前，用户能看见「这一轮为什么不一样」。
          if (pendingNotice && !aborted) {
            emitDelta(pendingNotice, aggressive);
            pendingNotice = null;
          }
          return merged;
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
         * 已执行工具的结果缓存，跨「溢出重试」复用，键是 `call.id`。
         *
         * 为什么必须有：`MAX_CONTEXT_RETRIES` 的两次重试是从 round 0 重跑 `once()`，
         * 而模型会重复给出同一批 tool_calls（同样的 id）。没有这层缓存，一次超限
         * 就会把写操作（发消息、改文件、点按钮）再执行一遍，而且用户还得再点一次确认。
         * 这里缓存的是 Promise：同一轮里重复 id 也不会并发执行两次。
         */
        const executed = new Map<
          string,
          Promise<{ text: string; ok: boolean; sources?: ToolSource[] }>
        >();
        /** 「工具被能力闸摘掉」只提示一次（重试会再进 once()，不重复刷屏）。 */
        let gateNoticed = false;
        /**
         * 本轮尝试内「同名 + 同参数」出现次数（用于重复调用提醒）。
         *
         * 作用域是**整次尝试**而不是单轮：模型原地打转的典型形态是「规划轮 → 同一检索 →
         * 再同一检索」，跨轮才看得出来。溢出重试会重新进 `once()`，这里自然重开计数。
         */
        const repeatedCalls = new Map<string, number>();

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
          usageInput = 0;
          usageOutput = 0;
          usageRounds = 0;
          usageSplitRounds = 0;
          /**
           * 工具目录构建失败不能带走整轮对话。
           *
           * `getTools` 走的是能力注册表：任一提供者的 `build()` 抛错（插件清单坏了、
           * MCP 目录读失败、合并冲突）都会把异常抛到这里。以前它一路冒到外层 catch，
           * 用户看到的是一条「生成出错」——明明是工具没装上，回答本身完全能完成。
           * 现在降级为「本轮没有工具」，并明确告诉用户原因。
           */
          let bridge: ReturnType<NonNullable<typeof deps.getTools>> = null;
          let toolsError: string | null = null;
          try {
            bridge = deps.getTools?.(m.agentId) ?? null;
          } catch (error) {
            toolsError = error instanceof Error ? error.message : String(error);
          }
          // 两个条件缺一不可：能力表认定该模型支持函数调用，且真的有工具可给。
          // 不支持时给了也没用，反而让模型胡言「我去查一下」——所以在这里就丢掉（判定与丢弃同源）。
          // 形状差异不必在这里管：d.93 起只有 OpenAI 兼容协议（协议翻译在 magpie 网关侧）。
          const useTools =
            !!bridge &&
            bridge.tools.length > 0 &&
            supportsKind(profile, "tools") &&
            !aborted;
          /**
           * 工具被静默摘掉是误导：用户看到模型说「我查一下」却什么都没发生，只会以为工具坏了。
           * 只在「确实有工具、但模型不支持」时说一句（每次 run 一次），其余缺失原因
           * （没配 MCP / 没有内置工具）由界面上的能力提示负责，不在这里重复。
           */
          if (!useTools && !gateNoticed && !aborted) {
            if (toolsError) {
              gateNoticed = true;
              emitDelta(
                `（本轮工具目录加载失败：${toolsError}。这次只能凭对话回答；可以检查 MCP/插件配置后重试。）`,
                aggressive,
              );
            } else if (bridge && bridge.tools.length > 0) {
              gateNoticed = true;
              emitDelta(
                `（当前模型（${profile.model}）不支持工具调用，本轮只能纯对话；换一个支持函数调用的模型再试。）`,
                aggressive,
              );
            }
          }
          /**
           * 工具目录超过阈值时改「按需发现」（对应 Codex 的 tool_search）。
           *
           * 为什么不是把全部工具塞进去：每个 function schema 都带完整 JSON Schema，
           * 五六个 MCP 服务叠加后，光工具定义就吃掉可观的输入 token；而且模型在几十个
           * 名字里挑，选错的概率明显上升。超过阈值后只暴露前 `MAX_VISIBLE_TOOLS` 个，
           * 其余靠一次检索加入——多花一轮，换回稳定的选择质量与更小的提示词。
           */
          const allSpecs = useTools ? discoverTools(bridge!.tools) : [];
          const useDiscovery = useTools && allSpecs.length > TOOL_SEARCH_THRESHOLD;
          /**
           * 发现模式下首批可见的工具：**先按本轮用户原话检索一次，再按目录顺序补齐**。
           *
           * 以前固定取目录前 `MAX_VISIBLE_TOOLS` 个——目录顺序就是提供者注册顺序（MCP 在前），
           * 所以本地知识库/白板这类工具常年排在第 21 位之后，模型必须先「猜到要检索」才摸得到：
           * 用户说「查一下我的笔记」，它第一轮只能看见一堆截图/点击工具。
           * 现在一半名额给相关度命中（同一句输入结果确定），其余按目录序补齐。
           */
          const relevantSpecs = useDiscovery
            ? searchTools(allSpecs, userText, { limit: Math.max(1, Math.floor(MAX_VISIBLE_TOOLS / 2)) })
            : [];
          const rankedNames: string[] = [];
          for (const tool of [...relevantSpecs, ...allSpecs]) {
            if (!rankedNames.includes(tool.name)) rankedNames.push(tool.name);
          }
          /** 当前可调用（模型看得见）的工具名。检索命中会往里加，下一轮即生效。 */
          const pinnedNames = useDiscovery ? rankedNames.slice(0, MAX_VISIBLE_TOOLS) : rankedNames;
          const visible = new Set<string>(pinnedNames);
          /**
           * 检索「解锁」的工具，按揭晓顺序排队。
           *
           * 以前 `visible.add()` 无上限：每轮 tool_search 都能再塞 8 个进请求，
           * 12 轮下来请求里可能挂着 100+ 份 schema——正好毁掉「按需发现」本身想省的那点预算，
           * 还可能顶到供应商的 tools 数量上限。这里给总数封顶：
           * 初始可见的（按用户这句话排过序）尽量保留，超出的从**最早揭晓**的开始挤掉
           * （它们已经不在眼前，模型很难凭空再调；真要再用会重新检索到）。
           */
          const revealed: string[] = [];
          const revealTools = (names: string[]) => {
            for (const name of names) {
              if (visible.has(name)) continue;
              visible.add(name);
              revealed.push(name);
            }
            while (pinnedNames.length + revealed.length > MAX_VISIBLE_TOOLS + TOOL_SEARCH_LIMIT && revealed.length > 0) {
              const victim = revealed.shift();
              if (victim) visible.delete(victim);
            }
          };
          const toolSearchId = useDiscovery ? TOOL_SEARCH_NAME : "";
          /** 本轮请求要带的 tools：发现模式下 = tool_search + 当前可见工具（按目录原序）。 */
          const toolsForRequest = (): unknown[] => {
            if (!useTools) return [];
            if (!useDiscovery) return bridge!.tools;
            return [
              TOOL_SEARCH_SPEC,
              ...allSpecs.filter((t) => visible.has(t.name)).map((t) => t.spec),
            ];
          };
          let extra: ChatMessage[] = [];
          let reasoning = "";
          /** 本次尝试里已回灌的工具结果总量（token）：预算驱动的收敛条件，见 MAX_TURN_TOOL_TOKENS。 */
          let toolTokens = 0;
          /** 本轮尝试里工具实际返回过的来源（被拒/失败的不算）。 */
          const sources: ToolSource[] = [];
          /** 把来源脚注补在答案末尾（无来源时不发）。 */
          const emitFooter = () => {
            const footer = sourceFooter(sources);
            if (footer) emitDelta(footer, aggressive);
          };
          for (let round = 0; ; round++) {
            /**
             * 预算驱动收口（G1）：工具结果累计超过 `MAX_TURN_TOOL_TOKENS` 就不再开新一轮。
             *
             * 与「轮次到顶」的区别在**告知**：这里明确告诉用户「已达预算、可以继续」，
             * 而不是静默停在半路——用户看不懂为什么话没说完，只会觉得模型变笨了。
             */
            if (round > 0 && toolTokens > MAX_TURN_TOOL_TOKENS) {
              emitDelta(
                `\n\n（本次工具返回的内容已达预算上限，先给出当前结论。回复「继续」可以接着做。）`,
                aggressive,
              );
              emitFooter();
              console.warn(`工具结果累计 ${toolTokens} token 超过预算 ${MAX_TURN_TOOL_TOKENS}`);
              return;
            }
            // 工具轮的文本先攒着（可能是「我这就去查」这类中间话术，等工具结果回来再决定是否上行）。
            // 但要**按片攒**而不是拼成一个字符串——最终答案逐片发出才能保住打字机效果。
            // 拼成整段会让用户看到「文字突然整块蹦出来」，与无工具路径的表现不一致。
            const roundChunks: string[] = [];
            let roundText = "";
            let calls: ToolCall[] = [];
            /** 本轮是否被输出长度上限截断（finish_reason=length）：要明确告诉用户，别让它像「模型变傻了」。 */
            let truncated = false;
            /** 服务端内容策略拦下（finish_reason=content_filter / refusal）：通常正文是空的，必须说明。 */
            let refused = false;
            await deps.streamChat(profile, await messagesFor(aggressive, extra), {
              signal: controller.signal,
              ...(useTools ? { tools: toolsForRequest() } : {}),
              onToolCalls: (c) => {
                calls = c;
              },
              onFinish: (reason) => {
                if (reason === "length") truncated = true;
                if (reason === "content_filter" || reason === "refusal") refused = true;
              },
              onAttempt: (a) => {
                attempts.push(a);
                deps.onAttempt?.(streamId, a);
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
                usageRounds++;
                // 只收「两侧都报了」的轮：缺一侧的轮次宁可不进拆分，
                // 也别让估算费用少算一整轮（少算比「按上界估」更骗人）。
                if (u.inputTokens !== undefined && u.outputTokens !== undefined) {
                  usageSplitRounds++;
                  usageInput += u.inputTokens;
                  usageOutput += u.outputTokens;
                }
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

            // 内容策略拦下时（无工具路径没有下面那段「工具轮收口」的提示）：
            // 不说一句的话，用户只会看到一个空白气泡。
            if (refused && !useTools) {
              emitDelta(
                "\n\n（这一轮被服务端的内容策略拦下了，没有生成正文。可以换个说法，或把要求拆小一点再试。）",
                aggressive,
              );
            }
            if (!useTools) return;
            // 没有工具调用 = 这一轮就是答案，逐片补发文本后结束。
            // 逐片而非整段：保住打字机效果，与无工具路径表现一致。
            if (calls.length === 0) {
              // 被输出上限截断时，用户看到的是一句话说到一半就停了：必须说明原因，
              // 否则他会以为模型坏了（这跟「工具参数不完整被丢弃」是同一件事的两面）。
              if (truncated) {
                emitDelta("\n\n（回复被输出长度上限截断，回复「继续」可以接着写。）", aggressive);
              }
              // 内容策略拦下时正文通常是空的：不说一句的话，用户只会看到一个空白气泡。
              if (refused) {
                emitDelta(
                  "\n\n（这一轮被服务端的内容策略拦下了，没有生成正文。可以换个说法，或把要求拆小一点再试。）",
                  aggressive,
                );
              }
              for (const chunk of roundChunks) emitDelta(chunk, aggressive);
              emitFooter();
              return;
            }
            if (truncated) {
              // 还有工具调用但整轮被截断：参数完整的那些会照常执行，这里只提示「没说完」。
              emitDelta("\n\n（本轮输出触到长度上限，可能有工具调用没来得及说完，已丢弃。）", aggressive);
            }
            // 到上限还在要工具：把已有文本给用户，并**说明**为什么停在这里。
            // 静默 return 是曾经的实现——用户只看到话没说完，不知道是被截断的。
            if (round >= MAX_TOOL_ROUNDS) {
              for (const chunk of roundChunks) emitDelta(chunk, aggressive);
              emitDelta(
                `\n\n（本次已连续调用 ${MAX_TOOL_ROUNDS} 轮工具，达到上限，先给出当前结论。回复「继续」可以接着做。）`,
                aggressive,
              );
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
              record({
                type: "tool_call",
                streamId,
                id: call.id,
                name: call.function.name,
                args: call.function.arguments,
              });
            }
            /**
             * 内部检索调用（`tool_search`）：不发 MCP、不问用户、不产生副作用。
             * 它只做一件事——把命中工具的 schema 加进 `visible`，下一轮请求即带上。
             */
            const searchIndexes = new Set<number>();
            if (useDiscovery) {
              calls.forEach((call, i) => {
                if (call.function.name === toolSearchId) searchIndexes.add(i);
              });
            }
            const runToolSearch = (call: ToolCall) => {
              let query = "";
              try {
                const parsed = JSON.parse(call.function.arguments || "{}") as { query?: unknown };
                if (typeof parsed.query === "string") query = parsed.query;
              } catch {
                /* 参数坏了按空查询处理：返回可解释的空结果，而不是让整轮失败 */
              }
              const matches = searchTools(allSpecs, query, {
                exclude: visible,
                limit: TOOL_SEARCH_LIMIT,
              });
              for (const match of matches) {
                // 走 revealTools：总可见数有上限，见上面的注释
                revealTools([match.name]);
              }
              const text = matches.length
                ? `已加入可调用工具（本轮后续即可调用）：\n${matches
                    .map(
                      (t) =>
                        `- ${t.name}${t.description ? `：${t.description.replace(/\s+/g, " ").slice(0, 80)}` : ""}`,
                    )
                    .join("\n")}`
                : `没有找到与「${query}」匹配的工具。换更通用的关键词（例如服务名）再试一次。`;
              return { text, ok: matches.length > 0 };
            };

            /**
             * HITL 闸门：**只问真正会执行的外部工具**。
             *
             * 检索是只读的内部动作，问「是否允许检索工具列表」只会制造确认疲劳——
             * 而确认疲劳正是安全边界失效的开始（用户开始无脑点允许）。
             * 裁决数组按**原始下标**回填，保证与 calls 等长同序。
             */
            let outcomes: (GateOutcome | undefined)[] | null = null;
            if (calls.length > searchIndexes.size) {
              const targets = calls
                .map((call, index) => ({ call, index }))
                // 重试时已执行过的调用不再打扰用户：结果直接复用（见 executed）。
                .filter(({ call, index }) => !searchIndexes.has(index) && !executed.has(call.id));
              // 等用户点「允许」可能远超 60 秒：期间定期心跳，避免界面先判「无响应」。
              const decided = await withHeartbeat(
                deps,
                streamId,
                confirmToolCalls(
                  deps,
                  targets.map((t) => t.call),
                  { agentId: m.agentId, agentName: m.name, streamId, conversationId },
                ),
              );
              if (decided) {
                const aligned: (GateOutcome | undefined)[] = new Array(calls.length);
                targets.forEach((target, k) => {
                  aligned[target.index] = decided[k];
                });
                outcomes = aligned;
              }
            }
            /**
             * 工具执行调度（G3）：只读并行，写/危险操作**串行且保序**。
             *
             * 曾经一律 `Promise.all`：同一轮里两个写同一个 key 的调用，最终值取决于谁先返回；
             * 审批小心翼翼、执行却随机，这条不一致比「快几百毫秒」严重得多。
             * 风险元数据直接复用 HITL 用的那份 `bridge.meta`，不另起一套判定——
             * 缺省按 `write` 处理，与闸门的默认口径同源（认不出来就当会改状态）。
             */
            const riskOf = (name: string) => bridge?.meta?.(name)?.risk ?? "write";
            const settled: (
              | { text: string; ok: boolean; sources?: ToolSource[]; images?: ToolImage[] }
              | undefined
            )[] =
              new Array(calls.length);
            const runOne = async (call: ToolCall, i: number) => {
              if (searchIndexes.has(i)) return runToolSearch(call);
              // 溢出重试会从 round 0 重跑：同一个 call.id 只执行一次，结果原样复用。
              const cached = executed.get(call.id);
              if (cached) return cached;
              const job = (async (): Promise<{
                text: string;
                ok: boolean;
                sources?: ToolSource[];
                images?: ToolImage[];
              }> => {
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
                return bridge!.execute(
                  { name: call.function.name, arguments: call.function.arguments },
                  // 中断信号透传：用户点中断后，在途的 HTTP 请求立刻收手；
                  // stdio 侧只能「不再等」，返回文案会说明子进程可能仍在运行。
                  { signal: controller.signal },
                );
              })();
              const callKey = `${call.function.name}\u0000${call.function.arguments}`;
              const repeat = repeatedCalls.get(callKey) ?? 0;
              repeatedCalls.set(callKey, repeat + 1);
              const tracked = job.then((result) => {
                if (repeat === 0) return result;
                return {
                  ...result,
                  text: `（提醒：这次调用的参数与本轮第 ${repeat} 次完全相同。如果需要看到最新状态，请先说明你在等什么变化；如果只是重复确认，可以直接用上面的结果。）\n${result.text}`,
                };
              });
              executed.set(call.id, tracked);
              return tracked;
            };
            /**
             * 同一轮里「同名 + 同参数」的重复调用（attempt 作用域，溢出重试重新计数）。
             *
             * 不是简单的去重：截图/读文件这类工具，同样的参数再调一次可能是**故意的**
             * （点完按钮再看一眼）。但模型也常常原地打转——同一个检索连发 5 次，直到
             * 轮数上限为止。这里只做提醒（结果仍真的执行），让模型自己判断要不要换路。
             */
            let writeChain: Promise<void> = Promise.resolve();
            // 工具执行可能很久（MCP/命令/浏览器），长等待期间发心跳，别让界面把「在跑」看成「卡死」。
            await withHeartbeat(
              deps,
              streamId,
              Promise.all(
                calls.map((call, i) => {
                  const job = async () => {
                    settled[i] = await runOne(call, i);
                  };
                  // 检索是纯内存操作，与只读工具一样并行，不占用写队列
                  if (searchIndexes.has(i) || riskOf(call.function.name) === "read") return job();
                  const chained = writeChain.then(job, job);
                  // 链上任何一环失败都不能断链：失败已落在 settled 里，后续照常排队。
                  writeChain = chained.then(
                    () => undefined,
                    () => undefined,
                  );
                  return chained;
                }),
              ),
            );
            /**
             * 兜底文案（MCP 审计 D8）：job 抛异常时 settled[i] 还是空的，
             * 以前会回给模型一条 `content: ""` 的空工具消息——模型不知道该重试还是换路，
             * 轨迹里也只显示一个没有原因的红叉。失败必须带原因。
             */
            const results = settled.map(
              (r) => r ?? { text: "工具调用失败：执行层未返回结果（内部异常，可换一种方式重试）", ok: false },
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
              record({
                type: "tool_result",
                streamId,
                id: call.id,
                name: call.function.name,
                ok: result.ok,
                ...(denied ? { denied: true } : {}),
                text: result.text,
              });
            });
            /**
             * 图片回灌（MCP 审计 D1）。
             *
             * 截图类工具返回的是 [text, Image(png)]。以前图片在客户端就被压成
             * `[图片 image/png]` 一行字，模型等于没看见画面，只能猜坐标——这正是
             * 「点了半天点错地方」的根源。
             *
             * OpenAI 的 `role=tool` 只能带文本，所以图片必须另起一条 user 消息；
             * 模型不看图时（无 vision 能力）就不发图片，改在文本里说明，
             * 免得把几 MB base64 白塞进预算。
             */
            const vision = resolveCapability(profile).supportsVision;
            const imageResults = results.filter((r) => (r.images?.length ?? 0) > 0);
            extra = [
              ...extra,
              { role: "assistant", content: roundText, tool_calls: calls },
              ...calls.map((call, i) => {
                const result = results[i];
                const hasImages = (result?.images?.length ?? 0) > 0;
                const note =
                  hasImages && !vision
                    ? `\n（本次返回了 ${result!.images!.length} 张图片，但当前模型不支持读图，已省略）`
                    : "";
                // 单条工具结果硬上限：MCP 桥那边已经截过，但内置/插件工具不走那座桥，
                // 一条几十万字的输出会跟着每一轮重发，把预算和 400 一起顶爆。
                const capped = truncateToolResult(String(result?.text ?? ""));
                return {
                  role: "tool" as const,
                  tool_call_id: call.id,
                  name: call.function.name,
                  content: capped + note,
                };
              }),
            ];
            if (vision && imageResults.length > 0) {
              const parts: ContentPart[] = [];
              const labels: string[] = [];
              for (const result of imageResults) {
                const call = calls[results.indexOf(result)];
                labels.push(call ? call.function.name : "工具");
              }
              parts.push({
                type: "text",
                text: `以下是工具（${[...new Set(labels)].join("、")}）返回的图片，请直接看图判断，不要凭占位文字猜内容。`,
              });
              for (const result of imageResults) {
                for (const image of result.images ?? []) {
                  parts.push({ type: "image", mime: image.mimeType, data: image.data });
                }
              }
              extra.push({ role: "user", content: "（工具返回的图片）", contentParts: parts });
            }
            // 累计回灌量，供下一轮的预算收口判断（见 MAX_TURN_TOOL_TOKENS）
            // 口径必须是**真正发出去的那份文本**：按原始 result.text 计，
            // 一条被截到 8000 字符的大输出会被算成几万 token，直接把预算判死。
            toolTokens += calls.reduce(
              (sum, _call, i) =>
                sum +
                estimateTokens(truncateToolResult(String(results[i]?.text ?? ""))) +
                // 与预算层同一个口径（图片不便宜，别按 800 凑合）
                (results[i]?.images?.length ?? 0) * IMAGE_TOKEN_COST,
              0,
            );
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
            record({ type: "assistant_final", streamId, text });
            record({ type: "turn_end", streamId, status: "ok" });
            notifyTurnComplete(deps, m.agentId, userText, text, "ok");
            // 用量记账：成功收口前恰好一次；一次都没拿到就记 null（未上报）。
            // 记账是旁路副作用，失败不得反噬收口（与 onRunSettled 同口径吞掉）。
            try {
              const served = servingAttempt(attempts);
              const split =
                usageRounds > 0 && usageSplitRounds === usageRounds
                  ? { input: usageInput, output: usageOutput }
                  : {};
              deps.recordUsage?.(
                served?.model ?? profile.model,
                usageSeen ? usageTotal : null,
                {
                  profileId: served?.profileId ?? profile.id,
                  profileLabel: served?.profileLabel ?? profile.label,
                  ...split,
                },
              );
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
          // acc = 已上行（用户看得到）；local = 本次尝试的本地累积（含未上行的重试轮）。
          //
          // 工具轮的中间话术（buffered，例如「我这就去查」）**不能**直接当最终答案落库：
          // 它不是这一轮的结论，落下去会让气泡看起来「答完了」，下一轮还把它当已完成的回答。
          // 只有在完全没有答案、且用户确实看到过这段过程说明时，才带着「过程说明」的标注兜底。
          const answer = acc || local;
          const partial =
            answer ||
            (buffered ? `${buffered}\n\n（本轮工具调用未完成，以上是中断前的过程说明，不是最终答案。）` : "");
          // 中断判定同时看错误名与两个标志：controller.abort() 在部分适配器里
          // 被包装成普通 Error，只看 name 会把用户主动中断记成失败。
          const abortedRun = err.name === "AbortError" || aborted || controller.signal.aborted;
          // 中断收口正文固定在用户语言里（A2）：AbortError 是内部实现细节，不该出现在气泡上。
          const errorText = abortedRun ? "已中断，可继续生成" : err.message.slice(0, 300);
          try {
            if (partial && (await sendFinish(partial))) {
              record({ type: "assistant_final", streamId, text: partial });
              // 中断/失败：只写工作记忆（partial），不沉淀长期记忆（设计 §3）
              notifyTurnComplete(deps, m.agentId, userText, partial, "partial");
            }
            await sendError(abortedRun ? "aborted" : "provider_error", errorText);
          } finally {
            // 终态先于异常传播落定：sendError 抛错（发送链异常）时任务区也要收口。
            record({
              type: "turn_end",
              streamId,
              status: abortedRun ? "aborted" : "error",
              ...(abortedRun ? {} : { error: err.message.slice(0, 300) }),
            });
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
