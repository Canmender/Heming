/**
 * 单条用例的执行：准备沙箱 → 注入确定性依赖 → 真的跑 `runAgentMentions` → 收集观测。
 *
 * 关键取舍：**走真实编排层**（`runAgentMentions`）而不是直接调工具。
 * 只有走真实路径，回合上限、工具轮预算、HITL 闸门、rollout 记录这些才是被测对象；
 * 否则评测就退化成「测了几个工具函数」，与线上行为无关。
 */

import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { runAgentMentions } from "../../packages/web/src/lib/agentStream.js";
import type { ChatMessage } from "../../packages/web/src/lib/llmClient.js";
import type { LlmProfile } from "../../packages/web/src/store/llm.js";
import { streamChat as realStreamChat } from "../../packages/web/src/lib/llmClient.js";
import type { FileRoot } from "../../packages/web/src/lib/fileEdit/paths.js";
import { createNodeFsBridge } from "./fsBridge.js";
import { createDeterministicGate, type GateDecision } from "./gate.js";
import { gradeCase, type GraderResult } from "./graders.js";
import { createEvalToolBridge } from "./tools.js";
import { createScriptedChat } from "./stream.js";
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

/** 复制 fixture 到沙箱；fixture 不存在时建空目录（新用例可以先不带夹具）。 */
async function prepareSandbox(testCase: EvalCase, options: RunCaseOptions): Promise<{ dir: string; roots: FileRoot[] }> {
  const dir = path.join(options.workRoot, testCase.id);
  await rm(dir, { recursive: true, force: true });
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

/** 跑一条用例。 */
export async function runCase(testCase: EvalCase, options: RunCaseOptions): Promise<CaseRunResult> {
  const startedAt = Date.now();
  const { dir, roots } = await prepareSandbox(testCase, options);
  const outOfRoot = () => testCase.setup?.outOfRoot ?? "ask";

  const scripted = createScriptedChat(testCase.usage);
  const bridge = createNodeFsBridge();
  const toolBridge = createEvalToolBridge({ bridge, roots: () => roots, outOfRoot, fakeTools: testCase.fake_tools });
  const gate = createDeterministicGate(() => roots, outOfRoot);

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
      getPrompt: () => "",
      fetchHistory: async () => [...history],
      send: () => {},
      streamChat: options.real ? realStreamChat : scripted.chat,
      onLocalDelta: () => {},
      getTools: () => toolBridge,
      confirmToolCalls: gate.confirm,
      onRollout: (item) => {
        rollout.push(item as RolloutRecord);
      },
      recordUsage: () => {},
      onHeartbeat: () => {},
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), STEP_TIMEOUT_MS);
    });
    const settled = await Promise.race([run.then(() => "done" as const), timeout]);
    if (timer) clearTimeout(timer);
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
    rounds: scripted.rounds(),
    tokens,
    durationMs: Date.now() - startedAt,
  };

  const results = await gradeCase(testCase, obs);
  const passed = results.every((r) => r.ok);

  if (!options.keep) await rm(dir, { recursive: true, force: true });

  return { caseId: testCase.id, case: testCase, passed, obs, results };
}
