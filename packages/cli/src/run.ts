/**
 * CLI 的无头智能体循环：把 `runAgentMentions` 接到 Node 的文件桥 / 命令桥 / 确定性闸门上。
 *
 * 为什么不是另写一套循环：和鸣的编排层（工具轮、预算收口、HITL、失败收口、长任务续跑）
 * 全部在 `packages/web/src/lib/agentStream.ts` 里，评测也是直接跑它（见 evals/runner/run.ts）。
 * CLI 如果复制一份「简化循环」，第一天就会和桌面端行为分叉——用户看到的工具轮次、
 * 拒绝文案、预算收口都会不一样，而这正是「无头 CLI」最不该有的差异。
 *
 * 本文件只做三件事：
 * 1. 组装真实依赖（真实 fs 桥、真实 file_* 工具、可选 run_command）；
 * 2. 把「没有人类可问」翻译成一条确定性闸门规则（fail-closed）；
 * 3. 观测 rollout，产出固定的 JSON 契约（见 README）。
 *
 * `streamChat` 可注入是给测试用的：测试里绝不调外部 API。
 */

import path from "node:path";
import type { FileRoot } from "../../../packages/web/src/lib/fileEdit/paths.js";
import type { LlmProfile } from "../../../packages/web/src/store/llm.js";
import {
  MAX_TOOL_ROUNDS,
  runAgentMentions,
  type RunSettled,
  type ToolBridge,
  type TriggerDeps,
  type TurnProgressEvent,
} from "../../../packages/web/src/lib/agentStream.js";
import {
  streamChat as realStreamChat,
  type ChatMessage,
  type StreamChatOpts,
} from "../../../packages/web/src/lib/llmClient.js";
import { buildAgentContext } from "../../../packages/web/src/lib/agentRuntime/context.js";
import { resolveBasePrompt } from "../../../packages/web/src/lib/agentRuntime/defaultPrompt.js";
import {
  buildRuntimeSection,
  runtimeToolsFromSpecs,
} from "../../../packages/web/src/lib/agentRuntime/runtimePrompt.js";
import { SHELL_TOOL } from "../../../packages/web/src/lib/shell/tool.js";
import { createCliTooling, shellDeniedText } from "./tooling.js";
import { createCliHistoryPrep, type CliContextStats } from "./contextBudget.js";
import { estimateTokens } from "../../../packages/web/src/lib/agentContext/tokens.js";
import type { CliWorkspaceRuleSet } from "./workspaceRules.js";
import type { CliApprover } from "./approvals.js";
import type { CliHookVerdict } from "./toolHooks.js";
import type { McpConnection } from "./mcpClient.js";
import type { CliEvent } from "./events.js";

/** 注入点：测试传脚本化 chat；生产用真实 OpenAI 兼容客户端。 */
export type StreamChatFn = typeof realStreamChat;

/** 一次运行是怎么收口的（CI 用来区分「做完了」与「撞上限停了」）。 */
export type StopReason = "ok" | "max-rounds" | "aborted" | "error";

export interface ToolCallRecord {
  name: string;
  ok: boolean;
  /** 被闸门/策略拒绝（没有真正执行）。 */
  denied: boolean;
  /** 工具回给模型的文本（截断到 500 字符）。 */
  text?: string;
}

/** `exec --json` 的固定输出契约（README 有逐字段说明）。 */
export interface ExecJson {
  ok: boolean;
  /** 收口原因：`ok` 正常答完 / `max-rounds` 撞 --max-rounds / `aborted` 被中断 / `error` 运行失败。 */
  stopReason: StopReason;
  text: string;
  rounds: number;
  toolCalls: ToolCallRecord[];
  writes: string[];
  usage: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  durationMs: number;
  error?: string;
  /** 本次会话的存档 id：下次 `--resume <id>` 就接着这份聊（单轮模式也有）。 */
  sessionId?: string;
}

export interface AgentRunOptions {
  prompt: string;
  /** 工具根与工作区（绝对路径或相对当前进程的路径）。 */
  cwd: string;
  profile: LlmProfile;
  /** 为 true 时挂真实的 `run_command` 并放行 danger 工具；否则命令工具不出现、调用也一律拒绝。 */
  allowDanger: boolean;
  /**
   * 交互式审批（`--ask`）：危险调用（命令 / MCP 工具）先在终端问一句。
   *
   * 缺省 / `null` = 不提问，与以前一样一律按拒绝处理（含 `mcp serve` 那条没有人的路）。
   */
  ask?: CliApprover | null;
  /** 最多允许 N 个工具轮；第 N+1 轮若还要调工具就提前收口。缺省用编排层的 12 轮上限。 */
  maxRounds?: number;
  /** 测试注入；缺省真实 `streamChat`。 */
  streamChat?: StreamChatFn;
  /** 最终回答的增量（已做累计文本切片，直接写 stdout 即可）。 */
  onStdout?: (chunk: string) => void;
  /** 进度/工具轨迹行（写 stderr）。 */
  onProgress?: (line: string) => void;
  /** 结构化事件（`--output-format stream-json` 时写到 stdout）。缺省不发。 */
  onEvent?: (event: CliEvent) => void;
  /**
   * 上一次会话的历史（`--continue` / `--resume` 载入的文字问答）。
   *
   * 缺省是空数组，也就是原来的单轮语义。这里只接「文字问答」，不重放工具调用：
   * 旧的工具结果里可能提到某个已经不在当前目录的文件，重放反而让模型照着旧事实干活。
   */
  history?: ChatMessage[];
  /** 本次会话 id（会写进 `exec --json`，供脚本接着 `--resume`）。 */
  sessionId?: string;
  /**
   * 工作区权限规则（`.heming/permissions.json` 的解析结果，由 `index.ts` / `mcpServe.ts` 读好传进来）。
   *
   * 这里只接「已经解析成功」的结果：解析失败的场合由入口直接拒绝启动，
   * 免得模型白跑几轮才在第一次工具调用时被全拒。
   */
  workspaceRules?: CliWorkspaceRuleSet | null;
  /**
   * 工作区约定文件拼好的注入段（`AGENTS.md` 一族，d.310）。
   *
   * 由入口（`index.ts`）读好传进来，而不是在 `startAgentRun` 里现读：
   * 读盘是异步的、失败要能提前告诉用户，而启动运行是同步返回句柄的。
   * 缺省 = 不注入（保持「CLI 不知道仓库规矩」的旧行为）。
   */
  projectRules?: string;
  /**
   * 已连上的 MCP 服务（`--mcp`）。它们的工具按 danger 处理：
   * 没有 `--allow-danger` 时只会拿到「未执行」，不会真的调到对方进程。
   */
  mcp?: readonly McpConnection[];
  /**
   * 工作区钩子（`.heming/hooks.json`，d.312）装配好的「调用前判定」函数。
   *
   * 同样是入口读好传进来：装载失败要在启动时就告诉用户，而不是等模型跑到第一个
   * 工具调用才拿到「被拒绝」。`null` / 省略 = 这次运行不做钩子检查。
   */
  hooks?: ((call: { name: string; arguments: string }) => Promise<CliHookVerdict>) | null;
  /**
   * 只读模式（`--read-only`）：写与命令一律不执行，提示词里也要说清楚，
   * 否则模型会一次次尝试、把轮数烧在注定失败的调用上。
   */
  readOnly?: boolean;
  /**
   * 是否读写工作区记忆（`.heming/memory.json`）：缺省开启。
   *
   * 关闭时两头都不做——不注入 `memorySection`、也不挂 `remember` 工具。入口在
   * `--no-memory` 或记忆文件读坏时传 `false`（读坏了也不该让模型往一个坏文件里写）。
   */
  memory?: boolean;
  /**
   * 已召回的记忆段（由入口按本轮提问挑好）。
   *
   * 为什么在入口算：召回需要「这一轮的提问」，而提示词在 `startAgentRun` 里才组装；
   * 入口拼好整段传进来，`run` 只负责把它接在人设与 runtime 之后，职责清楚。
   */
  memorySection?: string;
  /**
   * 续聊历史的 token 预算（`--context-budget`）。缺省 12k，超出就把早期对话折成摘要。
   *
   * 只在 `history` 非空时有意义：单轮运行的历史是空的，折与不折都一样。
   */
  contextBudget?: number;
  /** `false` = `--no-compact`：历史原样发送，不折叠。 */
  compact?: boolean;
  /**
   * 一次运行结束后回报折叠情况（`NULL`/省略 = 不回报）。
   *
   * 走回调而不是在这里打印：`run` 的输出渠道由入口决定（stdout 可能是流式 JSON），
   * 这类诊断行必须落在 stderr，只有入口知道该往哪写。
   */
  onContext?: (stats: CliContextStats) => void;
}

export interface AgentRunOutcome {
  json: ExecJson;
  settled: RunSettled | undefined;
  /** 是否由 `--max-rounds` 主动收口（不是失败，也不是用户中断）。 */
  capHit: boolean;
}

export interface AgentRunHandle {
  abortAll: () => void;
  done: Promise<AgentRunOutcome>;
}

/** 工具结果文本进 JSON 前的截断长度：契约要求 500。 */
export const TOOL_TEXT_LIMIT = 500;

// 拒绝文案与闸门都在 `tooling.ts`（MCP 模式复用同一份，避免两个入口的安全口径分叉）。
export { shellDeniedText };

// 进度行与审批框共用的短文本（callText.ts），两处必须说同一件事。
import { describeCallArgs } from "./callText.js";


/** 给人读的平台名（`describePlatform` 吃的是 UA 风格的字符串）。 */
function platformLabel(platform: NodeJS.Platform): string {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  return "";
}

/**
 * 组装 CLI 的系统提示词：与评测同样复用生产链路（默认人设 → 运行环境段 → 合并）。
 *
 * 为什么 `desktop: true`：这个布尔在提示词里的含义是「文件工具会真的改本机文件」，
 * 而不是「跑在 Electron 里」。CLI 确实会真的写用户磁盘，按「无桥」描述会让模型
 * 以为只能聊天、拒绝执行文件任务——那是比措辞不精确更严重的错误。
 */
function buildCliSystemPrompt(input: {
  prompt: string;
  cwd: string;
  roots: FileRoot[];
  toolBridge: ToolBridge;
  maxToolRounds: number;
  allowDanger: boolean;
  conversationId: string;
  rules?: string;
  readOnly?: boolean;
  memory?: string;
}): string {
  const runtime = buildRuntimeSection({
    desktop: true,
    platform: platformLabel(process.platform),
    now: new Date(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    workspace: input.cwd,
    roots: input.roots.map((root) => ({ name: root.name, path: root.path, mode: root.mode })),
    tools: runtimeToolsFromSpecs(input.toolBridge.tools, (name) => input.toolBridge.meta?.(name)),
    // CLI 只有十来件内置工具，不会触发「按需发现」，所以明确告诉模型没有 tool_search。
    toolSearchAvailable: false,
    maxToolRounds: input.maxToolRounds,
    hasBackgroundJobs: input.allowDanger,
  });
  const built = buildAgentContext({
    agentId: "cli",
    conversationId: input.conversationId,
    userText: input.prompt,
    basePrompt: resolveBasePrompt(undefined),
    runtime,
    // 仓库自己的规矩排在人设之后、运行环境之前（与桌面端同一个位置）。
    ...(input.rules ? { rules: input.rules } : {}),
  }).systemPrompt;
  /*
   * 记忆段排在运行环境之后、只读说明之前：它是「这个工作区以前发生过的事」，
   * 属于可选增强（与桌面端顺序一致）；只读说明是对本次运行的硬约束，必须最后说。
   */
  const withMemory = input.memory ? `${built}\n\n${input.memory}` : built;
  if (!input.readOnly) return withMemory;
  /*
   * 只读模式要写进提示词：否则模型会一次次尝试写文件、被拒、再换写法，
   * 把轮数烧在注定失败的调用上，最后交出一个没结论的答案。
   * 这里明确「要改动就写说明」，让它把精力放在读和给方案上。
   */
  return (
    withMemory +
    [
      "",
      "## 这次是只读模式",
      "",
      "本次运行加了 --read-only：除了读取文件与搜索，其它工具调用都会被拒绝（写、删、打补丁、跑命令）。",
      "- 需要改动时，把「改哪里、改成什么」写成可以直接执行的说明交回来，不要反复调用写工具。",
      "- 被拒绝的调用不是参数错误，重试不会改变结果。",
      "- 读文件、搜代码、看目录照常可用，结论照常给。",
    ].join("\n")
  );
}

/** 把「累计文本」切成增量：`onLocalDelta` 给的是全文累积，stdout 不该重复写旧内容。 */
function createDeltaWriter(write: ((chunk: string) => void) | undefined) {
  let lastLength = 0;
  return (accumulated: string) => {
    if (!write) return;
    if (accumulated.length <= lastLength) return;
    write(accumulated.slice(lastLength));
    lastLength = accumulated.length;
  };
}

/** 启动一次无头运行（同步返回句柄，便于 SIGINT 立刻 abort）。 */
export function startAgentRun(options: AgentRunOptions): AgentRunHandle {
  const startedAt = Date.now();
  const cwd = path.resolve(options.cwd).replace(/\\/g, "/");
  const conversationId = `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  /** 本回合真正成功落盘的文件（只认 ok=true 的结果，被拒/失败的写不算）。 */
  const writes: string[] = [];
  const seenWrites = new Set<string>();
  const tooling = createCliTooling({
    cwd,
    allowDanger: options.allowDanger,
    rules: options.workspaceRules ?? null,
    hooks: options.hooks ?? null,
    mcp: options.mcp ?? [],
    readOnly: options.readOnly === true,
    // 记忆工具与只读模式互斥：只读时连 `remember` 都不挂（列出来等于承诺能写）。
    memory: options.memory !== false && options.readOnly !== true,
    ask: options.ask ?? null,
    conversationId,
    onWrite: (file) => {
      if (seenWrites.has(file)) return;
      seenWrites.add(file);
      writes.push(file);
    },
  });
  const roots = tooling.roots;
  const toolBridge = tooling.toolBridge;
  const gate = tooling.confirm;

  const effectiveMaxRounds = options.maxRounds ?? MAX_TOOL_ROUNDS;
  const systemPrompt = buildCliSystemPrompt({
    prompt: options.prompt,
    cwd,
    roots,
    toolBridge,
    maxToolRounds: effectiveMaxRounds,
    allowDanger: options.allowDanger,
    conversationId,
    ...(options.projectRules ? { rules: options.projectRules } : {}),
    ...(options.readOnly ? { readOnly: true } : {}),
    ...(options.memorySection ? { memory: options.memorySection } : {}),
  });
  /**
   * 续聊历史的预算与折叠（d.317）：系统提示词在这里才算得出来，
   * 所以预算也要在这儿造——两本账（系统 + 历史）必须共用同一个上限。
   */
  const historyPrep = createCliHistoryPrep({
    ...(options.contextBudget !== undefined ? { budgetTokens: options.contextBudget } : {}),
    ...(options.compact === false ? { enabled: false } : {}),
    systemTokens: estimateTokens(systemPrompt),
  });
  /** 模型被调用了几次（工具循环每轮一次；与评测的 `rounds` 同口径）。 */
  let modelRounds = 0;
  const chat: StreamChatFn = (profile, messages, opts) => {
    modelRounds += 1;
    const impl = options.streamChat ?? realStreamChat;
    return impl(profile, messages, opts);
  };

  /** 进度行（stderr）：只报事实，不猜进度。 */
  const progress = (line: string) => options.onProgress?.(line);

  const toolCalls: ToolCallRecord[] = [];
  let finalText = "";
  let usageInput = 0;
  let usageOutput = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let sawCacheRead = false;
  let sawCacheWrite = false;
  let settled: RunSettled | undefined;
  let capHit = false;

  /** 供 onProgress 提前收口用：runAgentMentions 返回后立刻填上。 */
  const abortRef: { abortAll?: () => void } = {};

  const deps: TriggerDeps = {
    getProfile: () => options.profile,
    getPrompt: () => systemPrompt,
    // 单轮模式返回空数组；`--continue` / `--resume` 时是上一次会话的文字问答。
    fetchHistory: async (): Promise<ChatMessage[]> => options.history ?? [],
    // 历史超出预算时折掉早期对话（d.317）；溢出重试由编排层带 `aggressive` 再调一次。
    prepareHistory: historyPrep.prepare,
    send: () => {},
    streamChat: chat,
    onLocalDelta: (_streamId, accumulated) => stream(accumulated),
    getTools: () => toolBridge,
    confirmToolCalls: gate,
    onProgress: (event: TurnProgressEvent) => {
      if (event.phase === "round") {
        progress(`第 ${event.round} 轮：模型生成中`);
        options.onEvent?.({ type: "round", round: event.round });
        return;
      }
      progress(`第 ${event.round} 轮：调用工具 ${event.tool}`);
      options.onEvent?.({
        type: "round",
        round: event.round,
        ...(event.tool !== undefined ? { tool: event.tool } : {}),
      });
      // 轮次上限是「工具轮」的上限：第 N+1 轮如果模型直接作答，允许；还要调工具才收口。
      if (options.maxRounds && event.round > options.maxRounds && !capHit) {
        capHit = true;
        progress(`已达到 --max-rounds ${options.maxRounds}，不再执行新的工具轮次`);
        abortRef.abortAll?.();
      }
    },
    onToolTrace: (_streamId, event) => {
      if (event.phase === "start") {
        progress(`调用工具 ${event.name}${describeCallArgs(event.args)}`);
        options.onEvent?.({
          type: "tool_start",
          name: event.name,
          args: describeCallArgs(event.args).trim(),
        });
        return;
      }
      // 命令工具在未授权时由桥回「未执行」：这不是工具坏了，是策略拒绝。
      const denied = event.denied === true || (event.name === SHELL_TOOL && !options.allowDanger && !options.ask);
      const state = event.denied ? "已拒绝" : event.ok ? "完成" : "失败";
      progress(`工具 ${event.name} ${state}`);
      options.onEvent?.({ type: "tool_end", name: event.name, ok: event.ok === true && !denied, denied });
    },
    onUpstreamRetry: (info) => {
      progress(
        `上游暂时失败，${Math.round(info.delayMs / 1000)} 秒后重试（第 ${info.attempt}/${info.max} 次）：${info.reason}`,
      );
      options.onEvent?.({
        type: "retry",
        attempt: info.attempt,
        max: info.max,
        delayMs: info.delayMs,
        reason: info.reason,
      });
    },
    onRollout: (item) => {
      if (item.type === "tool_result") {
        toolCalls.push({
          name: item.name,
          ok: item.ok,
          // 命令工具在未授权时由桥回「未执行」：这不是工具坏了，是策略拒绝。
          denied: item.denied === true || (item.name === SHELL_TOOL && !options.allowDanger && !options.ask),
          ...(item.text ? { text: item.text.slice(0, TOOL_TEXT_LIMIT) } : {}),
        });
        return;
      }
      if (item.type === "assistant_final") {
        finalText = item.text;
        return;
      }
      if (item.type === "turn_end") {
        const usage = item.usage;
        if (!usage) return;
        usageInput += usage.input ?? 0;
        usageOutput += usage.output ?? 0;
        if (usage.cacheRead !== undefined) {
          sawCacheRead = true;
          cacheRead += usage.cacheRead;
        }
        if (usage.cacheWrite !== undefined) {
          sawCacheWrite = true;
          cacheWrite += usage.cacheWrite;
        }
      }
    },
    onRunSettled: (_streamId, result) => {
      settled = result;
    },
  };

  const stream = createDeltaWriter(options.onStdout);
  const run = runAgentMentions(conversationId, [{ agentId: "cli", name: "CLI" }], options.prompt, deps);
  abortRef.abortAll = run.abortAll;

  const done = (async (): Promise<AgentRunOutcome> => {
    let fatal: unknown;
    try {
      await run;
    } catch (error) {
      // fetchHistory/send 都不抛；真抛了也要给出一份可读的 JSON，而不是半截堆栈。
      fatal = error;
    }

    const status = settled?.status;
    let error: string | undefined;
    if (fatal !== undefined) {
      error = fatal instanceof Error ? fatal.message : String(fatal);
    } else if (!settled) {
      error = "运行没有返回终态（编排层异常退出）";
    } else if (status === "error") {
      error = settled.error || "运行失败";
    } else if (status === "aborted" && !capHit) {
      error = "运行被中止";
    }

    // 达到 --max-rounds 是用户要的结果（硬上限内跑完了），不是失败；
    // 但「一个终态都没有」或模型/工具真的失败时仍然算失败。
    const ok = status === "ok" || (status === "aborted" && capHit && !fatal);

    /**
     * 收口原因：CI 最常问的是「它到底是做完了，还是撞上限停了」——只看 `ok`
     * 分不出来（撞上限也算成功）。这里把原因单独给出去，消费方不必自己拼
     * `ok && !error` 的推断。
     */
    const stopReason: StopReason = capHit
      ? "max-rounds"
      : status === "ok"
        ? "ok"
        : status === "aborted"
          ? "aborted"
          : "error";

    const text = finalText || settled?.finalText || "";
    const json: ExecJson = {
      ok,
      stopReason,
      text,
      rounds: modelRounds,
      toolCalls,
      writes: [...writes],
      usage: {
        input: usageInput,
        output: usageOutput,
        ...(sawCacheRead ? { cacheRead } : {}),
        ...(sawCacheWrite ? { cacheWrite } : {}),
      },
      durationMs: Math.max(0, Date.now() - startedAt),
      ...(error !== undefined ? { error } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    };
    // 折叠情况在运行收口时回报一次（只报事实：入口决定要不要打给用户）。
    options.onContext?.(historyPrep.stats);
    return { json, settled, capHit };
  })();

  return { abortAll: run.abortAll, done };
}

/**
 * 退出码：0 = 跑完且没有运行级失败；1 = 运行失败；130 = Ctrl+C。
 * 用法/配置错误（2）在 index 里处理得更早（那时还没有运行句柄）。
 */
export function outcomeExitCode(outcome: AgentRunOutcome, interrupted = false): number {
  if (interrupted) return 130;
  return outcome.json.ok ? 0 : 1;
}
