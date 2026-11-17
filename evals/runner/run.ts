/**
 * 单条用例的执行：准备沙箱 → 注入确定性依赖 → 真的跑 `runAgentMentions` → 收集观测。
 *
 * 关键取舍：**走真实编排层**（`runAgentMentions`）而不是直接调工具。
 * 只有走真实路径，回合上限、工具轮预算、HITL 闸门、rollout 记录这些才是被测对象；
 * 否则评测就退化成「测了几个工具函数」，与线上行为无关。
 */

import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { runAgentMentions, MAX_TOOL_ROUNDS } from "../../packages/web/src/lib/agentStream.js";
import { buildAgentContext } from "../../packages/web/src/lib/agentRuntime/context.js";
import { resolveBasePrompt } from "../../packages/web/src/lib/agentRuntime/defaultPrompt.js";
import { buildRuntimeSection, describePlatform } from "../../packages/web/src/lib/agentRuntime/runtimePrompt.js";
import { getTodos, resetTodoStore, setTodos } from "../../packages/web/src/lib/todo/store.js";
import type { ChatMessage } from "../../packages/web/src/lib/llmClient.js";
import type { LlmProfile } from "../../packages/web/src/store/llm.js";
import { streamChat as realStreamChat } from "../../packages/web/src/lib/llmClient.js";
import type { FileRoot } from "../../packages/web/src/lib/fileEdit/paths.js";
import { createNodeFsBridge } from "./fsBridge.js";
import { createDeterministicGate, type GateDecision } from "./gate.js";
import { gradeCase, type GraderResult } from "./graders.js";
import { withSubagentTool } from "../../packages/web/src/lib/agentRuntime/subagent.js";
import { withWorkflowTool } from "../../packages/web/src/lib/agentRuntime/workflow.js";
import { createEvalToolBridge } from "./tools.js";
import { createScriptedChat, createScriptedSubagentChat } from "./stream.js";
import type { CaseObservation, EvalCase, RolloutRecord } from "./types.js";

/** 单步最长等待：卡死的用例必须红，而不是把 CI 挂住。 */
const STEP_TIMEOUT_MS = 60_000;

export interface RunCaseOptions {
  repoRoot: string;
  fixturesDir: string;
  /** 临时工作根（每个用例一个子目录）。 */
  workRoot: string;
  /** true = 用真实模型（夜间任务）。 */
  real?: boolean;
  /** --real 时使用的模型 id（缺省 gpt-4o-mini）。 */
  model?: string;
  /** 跑完保留沙箱（排查用）。 */
  keep?: boolean;
  /** 进度回调（CLI 打印用）。 */
  onLog?: (line: string) => void;
}

export interface CaseRunResult {
  caseId: string;
  case: EvalCase;
  passed: boolean;
  obs: CaseObservation;
  results: GraderResult[];
  skipped?: boolean;
}

/** 真实模式的模型档案（Key/端点来自环境变量，不落盘）。 */
export function realProfile(model: string): LlmProfile {
  return {
    id: "eval-real",
    label: "评测模型",
    provider: "openai",
    baseUrl: process.env.HEMING_EVAL_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.HEMING_EVAL_API_KEY ?? "",
    model,
    temperature: 0,
  };
}

/** 把路径规整成「根」的绝对形式（正斜杠）。 */
function toRootName(dir: string, defaultName: string): string {
  return path.basename(dir) || defaultName;
}

/**
 * 删掉用例沙箱目录，Windows 上要容忍「刚被杀的进程还攥着 cwd」。
 *
 * 为什么需要重试：`cmd-004`（命令超时）会真的 spawn 一个子进程再杀掉它，
 * 进程句柄的释放是异步的——紧接着 `rm` 会拿到 `EBUSY: resource busy or locked`；
 * 整个评测因此以「无法完成（退出码 2）」收场，看起来像评测框架坏了，而不是用例在验证超时。
 * `fs.rm` 的 `maxRetries` 只覆盖它内部认的那几类错误，所以外面再包一层显式重试。
 */
export async function removeSandbox(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
      return;
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw err;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  // 删不掉不应该是「用例失败」：留现场比炸掉整轮更有用（--keep 时本来也不删）。
  process.stderr.write(`[eval] 警告：沙箱目录清理失败（已重试 6 次），留在原地：${dir} —— ${String(lastError)}\n`);
}

/** 复制 fixture 到沙箱；fixture 不存在时建空目录（新用例可以先不带夹具）。 */
async function prepareSandbox(testCase: EvalCase, options: RunCaseOptions): Promise<{ dir: string; roots: FileRoot[] }> {
  const dir = path.join(options.workRoot, testCase.id);
  await removeSandbox(dir);
  await mkdir(dir, { recursive: true });

  const fixtureName = testCase.setup?.fixture ?? testCase.id;
  const fixtureDir = path.join(options.fixturesDir, fixtureName);
  try {
    await cp(fixtureDir, dir, { recursive: true });
  } catch {
    /* 没有夹具目录：空沙箱也能跑（安全用例就常常只需要一个干净目录） */
  }

  const declared = testCase.setup?.roots ?? [{ path: ".", mode: "write" as const, name: "work" }];
  const roots: FileRoot[] = declared.map((root, index) => {
    const abs = path.isAbsolute(root.path) ? path.normalize(root.path) : path.resolve(dir, root.path);
    return {
      name: root.name ?? (declared.length === 1 ? "work" : toRootName(abs, `root${index + 1}`)),
      path: abs.replace(/\\/g, "/"),
      mode: root.mode,
    };
  });
  return { dir, roots };
}

/**
 * 组装本用例的系统提示词：**复用生产的组装链路**，不另写一份。
 *
 * 为什么必须用生产函数：d.154 运行环境段、d.156 默认人设、d.157 长任务协议都在这条链路上，
 * 评测自己拼一段「差不多的提示词」就只能测到评测自己。这里与 `ChatPage.buildSystemPrompt`
 * 的口径一致：`resolveBasePrompt(空)`（= 内置人设）→ 运行环境段 → `buildAgentContext` 合并。
 */
function buildEvalSystemPrompt(input: {
  caseId: string;
  dir: string;
  roots: FileRoot[];
  tools: unknown[];
}): string {
  const specs = input.tools as Array<{ type?: string; function?: { name?: string; description?: string } }>;
  const tools = specs
    .filter((spec) => spec?.type === "function" && spec.function?.name)
    .map((spec) => ({
      name: spec.function?.name as string,
      title: spec.function?.description,
      risk: "read" as const,
    }));
  const runtime = buildRuntimeSection({
    // 评测跑在 node 里、没有 `window.__heming_files`：按「桌面智能体但无桥」的实情描述，
    // 而不是假装有桥——提示词说假话会污染所有用例的判定。
    desktop: false,
    platform: describePlatform(process.platform ?? ""),
    now: new Date("2026-11-16T00:00:00+08:00"),
    timeZone: "Asia/Shanghai",
    workspace: input.dir.replace(/\\/g, "/"),
    roots: input.roots.map((root) => ({ name: root.name, path: root.path, mode: root.mode })),
    tools,
    toolSearchAvailable: false,
    maxToolRounds: MAX_TOOL_ROUNDS,
  });
  return buildAgentContext({
    agentId: "eval-agent",
    conversationId: `eval-${input.caseId}`,
    userText: "",
    basePrompt: resolveBasePrompt(undefined),
    runtime,
  }).systemPrompt;
}

/** 跑一条用例。 */
export async function runCase(testCase: EvalCase, options: RunCaseOptions): Promise<CaseRunResult> {
  const startedAt = Date.now();
  const { dir, roots } = await prepareSandbox(testCase, options);
  const outOfRoot = () => testCase.setup?.outOfRoot ?? "ask";

  const scripted = createScriptedChat(testCase.usage);
  const bridge = createNodeFsBridge();
  // 任务清单：每个用例都从干净状态开始（清单按会话存在模块内存里，不重置会串到下一条用例）。
  const conversationId = `eval-${testCase.id}`;
  const baseToolBridge = createEvalToolBridge({
    bridge,
    roots: () => roots,
    outOfRoot,
    fakeTools: testCase.fake_tools,
    // 只有声明了 `todo: true` 的用例才注入真实 `todo_write`：工具清单会进提示词，
    // 给每条用例都加一件会改变既有 26 条用例的 token 口径（基线会被无关改动带偏）。
    ...(testCase.todo ? { conversationId } : {}),
    // 只有声明 `shell: true` 的用例才注入真实 `run_command`（d.165）：
    // 平时工具清单里没有它，模型也就不会误调；命令的风险是 danger，闸门默认拒绝。
    ...(testCase.shell ? { shell: true } : {}),
  });
  /** 真实模型模式下统计「模型被调用了几轮」——scripted.rounds() 在 real 模式恒为 0，min_rounds/max_rounds 会全部失真。 */
  let realRounds = 0;
  const countingStreamChat: typeof realStreamChat = (...args) => {
    realRounds += 1;
    return realStreamChat(...args);
  };

  const gate = createDeterministicGate(() => roots, outOfRoot, () => testCase.allow_danger === true);
  // 子代理（d.163）：用例给了 `subagent_script` 才把 `agent_task` 挂上去。
  // 不给脚本时不挂——确定性模式下没有模型绑定，挂上去只会得到「没有可用的模型绑定」。
  const subagent = createScriptedSubagentChat(testCase.subagent_script);
  const withAgents = testCase.subagent_script
    ? withSubagentTool(baseToolBridge, { agentId: "eval-agent", conversationId, chat: subagent.chat })
    : baseToolBridge;
  // 工作流（d.205）：`workflow_run` 的每一步都是子会话，确定性模式同样得由脚本驱动。
  // 单独建一份脚本队列——和 `agent_task` 共用一份的话，两边会互相抢回合。
  const workflowScript = createScriptedSubagentChat(testCase.subagent_script);
  const candidateBridge = testCase.workflow
    ? withWorkflowTool(withAgents, { agentId: "eval-agent", conversationId, chat: workflowScript.chat })
    : withAgents;
  // 图片张数（d.168）：rollout 只记文本，图片由编排层另起消息发出，
  // 所以在工具边界数——这是「file_image 真的交回一张图」的唯一可靠观测点。
  let imageCount = 0;
  const toolBridge = {
    ...candidateBridge,
    execute: async (call: Parameters<typeof candidateBridge.execute>[0], opts?: Parameters<typeof candidateBridge.execute>[1]) => {
      const result = await candidateBridge.execute(call, opts);
      imageCount += result?.images?.length ?? 0;
      return result;
    },
  };
  resetTodoStore();
  if (testCase.setup?.todos && testCase.setup.todos.length > 0) {
    setTodos(conversationId, testCase.setup.todos);
  }

  const systemPrompt = buildEvalSystemPrompt({ caseId: testCase.id, dir, roots, tools: toolBridge.tools });

  const rollout: RolloutRecord[] = [];
  const history: ChatMessage[] = [];
  const profile = options.real
    ? realProfile(options.model ?? "gpt-4o-mini")
    : {
        id: "eval",
        label: "评测模型",
        provider: "openai" as const,
        apiKey: "sk-eval-offline",
        model: "eval-offline",
        temperature: 0,
      };

  const steps = testCase.steps ?? [{ prompt: testCase.prompt ?? "", script: testCase.script }];

  for (const step of steps) {
    // 每步用自己的 script；没写就用用例顶层的兜底脚本（ctx-001 的第三步就是这样）。
    scripted.useScript(step.script ?? testCase.script);
    const run = runAgentMentions("eval-" + testCase.id, [{ agentId: "eval-agent", name: "评测智能体" }], step.prompt, {
      getProfile: () => profile,
      getPrompt: () => systemPrompt,
      fetchHistory: async () => [...history],
      send: () => {},
      streamChat: options.real ? countingStreamChat : scripted.chat,
      onLocalDelta: () => {},
      getTools: () => toolBridge,
      confirmToolCalls: gate.confirm,
      onRollout: (item) => {
        rollout.push(item as RolloutRecord);
      },
      recordUsage: () => {},
      onHeartbeat: () => {},
    });

    // 「用户点停止」（d.169）：到点对本次 run 调 abortAll，信号会透传到在途工具。
    // 只给声明了 abort_after_ms 的用例挂，普通用例的行为完全不变。
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    if (typeof testCase.abort_after_ms === "number") {
      abortTimer = setTimeout(() => {
        run.abortAll();
      }, testCase.abort_after_ms);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), STEP_TIMEOUT_MS);
    });
    const settled = await Promise.race([run.then(() => "done" as const), timeout]);
    if (timer) clearTimeout(timer);
    if (abortTimer) clearTimeout(abortTimer);
    if (settled === "timeout") {
      run.abortAll();
      await run.catch(() => {});
      throw new Error(`用例 ${testCase.id} 的第 ${steps.indexOf(step) + 1} 步超过 ${STEP_TIMEOUT_MS}ms 未结束`);
    }

    // 步与步之间的历史：用户这一问 + 模型最终回答（工具消息由编排层自己处理，不需要回灌）。
    const finals = rollout.filter((item): item is Extract<RolloutRecord, { type: "assistant_final" }> => item.type === "assistant_final");
    const lastFinal = finals.length > 0 ? finals[finals.length - 1] : undefined;
    history.push({ role: "user", content: step.prompt });
    if (lastFinal) history.push({ role: "assistant", content: lastFinal.text });
  }

  const finals = rollout.filter((item): item is Extract<RolloutRecord, { type: "assistant_final" }> => item.type === "assistant_final");
  const toolCalls = rollout.filter((item): item is Extract<RolloutRecord, { type: "tool_call" }> => item.type === "tool_call");
  const toolOutcomes = rollout
    .filter((item): item is Extract<RolloutRecord, { type: "tool_result" }> => item.type === "tool_result")
    .map((item) => ({ id: item.id, name: item.name, ok: item.ok, denied: item.denied === true, text: item.text }));

  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const item of rollout) {
    if (item.type !== "turn_end") continue;
    const usage = (item as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
    if (!usage) continue;
    tokens.input += usage.input ?? 0;
    tokens.output += usage.output ?? 0;
    tokens.cacheRead += usage.cacheRead ?? 0;
    tokens.cacheWrite += usage.cacheWrite ?? 0;
  }

  const obs: CaseObservation = {
    dir,
    rollout,
    finals: finals.map((item) => item.text),
    evidence: finals.flatMap((item) => (item.evidence ? [item.evidence] : [])),
    toolResults: toolOutcomes.map((item) => item.text),
    toolCalls: toolCalls.map((item) => ({ id: item.id, name: item.name })),
    toolOutcomes,
    decisions: gate.decisions as GateDecision[],
    rounds: options.real ? realRounds : scripted.rounds(),
    real: options.real === true,
    systemPrompt,
    images: imageCount,
    todos: getTodos(conversationId).map((t) => ({ content: t.content, status: t.status })),
    tokens,
    durationMs: Date.now() - startedAt,
  };

  const results = await gradeCase(testCase, obs);
  const passed = results.every((r) => r.ok);

  if (!options.keep) await removeSandbox(dir);

  return { caseId: testCase.id, case: testCase, passed, obs, results };
}
