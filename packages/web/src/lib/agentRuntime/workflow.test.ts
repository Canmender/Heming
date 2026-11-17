/**
 * 工作流编排（d.203.4.109）的用例。
 *
 * 这里都注入 `chat` / `execute`：工作流的价值全在「依赖排序 + 上游结论注入 +
 * 只读红线」，这些用假模型就能测死；真模型那条线由评测（`evals/`）兜。
 */
import { describe, expect, it } from "vitest";
import type { ToolBridge } from "../agentStream.js";
import type { ChatMessage } from "../llmClient.js";
import {
  WORKFLOW_MAX_CONCURRENT,
  WORKFLOW_MAX_STEPS,
  WORKFLOW_STEP_TASK_MAX_CHARS,
  WORKFLOW_TOOL,
  WORKFLOW_UPSTREAM_CONTEXT_MAX,
  parseWorkflowArgs,
  planWaves,
  runWorkflow,
  withWorkflowTool,
  workflowSpec,
  type WorkflowPlan,
  type WorkflowStep,
} from "./workflow.js";
import type { SubagentDeps } from "./subagent.js";

/** 造一个最小的主桥：子代理只读三件都能被「调用」。 */
function makeBridge(overrides: Partial<ToolBridge> = {}): ToolBridge {
  const spec = (name: string) => ({
    type: "function",
    function: { name, description: `${name} 工具`, parameters: { type: "object", properties: {} } },
  });
  return {
    tools: [spec("file_read"), spec("file_glob"), spec("file_grep"), spec("file_write")],
    execute: async (call) => ({ text: `读到 ${call.arguments}`, ok: true }),
    meta: (name: string) => ({ risk: name === "file_write" ? ("write" as const) : ("read" as const) }),
    ...overrides,
  } as ToolBridge;
}

/** 造一份执行依赖：`conclusions` 决定每个任务回什么结论。 */
function makeDeps(options: {
  conclusions?: (task: string) => string;
  execute?: SubagentDeps["execute"];
  onProgress?: SubagentDeps["onProgress"];
  seen?: { task: string; messages: ChatMessage[] }[];
} = {}): SubagentDeps {
  return {
    tools: makeBridge().tools,
    execute: options.execute ?? (async () => ({ text: "ok", ok: true })),
    chat: async (messages) => {
      const task = lastUserText(messages);
      options.seen?.push({ task, messages });
      return options.conclusions ? options.conclusions(task) : `结论：${task}`;
    },
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  };
}

/** 取最后一条 user 消息的正文（子代理的任务/注入上下文都在这里）。 */
function lastUserText(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === "user") {
      return typeof message.content === "string" ? message.content : "";
    }
  }
  return "";
}

function plan(steps: WorkflowStep[], goal = "弄清登录链路"): WorkflowPlan {
  return { goal, steps, maxRounds: 2 };
}

describe("parseWorkflowArgs（d.203.4.109）", () => {
  it("解析出目标、步骤与依赖，max_rounds 缺省比单派子代理少一轮", () => {
    const parsed = parseWorkflowArgs(
      JSON.stringify({
        goal: "弄清登录链路",
        steps: [
          { id: "scan", task: "列出 auth 相关文件" },
          { id: "read", task: "读核心实现", needs: ["scan"] },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.goal).toBe("弄清登录链路");
    expect(parsed.plan.steps.map((step) => step.id)).toEqual(["scan", "read"]);
    expect(parsed.plan.steps[1]?.needs).toEqual(["scan"]);
    expect(parsed.plan.maxRounds).toBeGreaterThanOrEqual(1);
  });

  it("拒绝缺目标/空目标/非法 JSON，并给出能照做的文案", () => {
    expect(parseWorkflowArgs(undefined).ok).toBe(false);
    const noGoal = parseWorkflowArgs(JSON.stringify({ steps: [{ id: "a", task: "x" }] }));
    expect(noGoal.ok).toBe(false);
    if (!noGoal.ok) expect(noGoal.error).toContain("goal");
    const blankGoal = parseWorkflowArgs(JSON.stringify({ goal: "  ", steps: [{ id: "a", task: "x" }] }));
    expect(blankGoal.ok).toBe(false);
    const badJson = parseWorkflowArgs("{goal:");
    expect(badJson.ok).toBe(false);
    if (!badJson.ok) expect(badJson.error).toContain("JSON");
  });

  it(`拒绝空步骤表与超过 ${WORKFLOW_MAX_STEPS} 步`, () => {
    const empty = parseWorkflowArgs(JSON.stringify({ goal: "g", steps: [] }));
    expect(empty.ok).toBe(false);
    const tooMany = parseWorkflowArgs(
      JSON.stringify({
        goal: "g",
        steps: Array.from({ length: WORKFLOW_MAX_STEPS + 1 }, (_, index) => ({
          id: `s${index}`,
          task: `第 ${index} 步`,
        })),
      }),
    );
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error).toContain(String(WORKFLOW_MAX_STEPS));
  });

  it("拒绝重复 id、非法 id 形状、空任务与超长任务", () => {
    const dup = parseWorkflowArgs(
      JSON.stringify({ goal: "g", steps: [{ id: "a", task: "x" }, { id: "a", task: "y" }] }),
    );
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toContain("重复");
    const badId = parseWorkflowArgs(JSON.stringify({ goal: "g", steps: [{ id: "1a", task: "x" }] }));
    expect(badId.ok).toBe(false);
    const noTask = parseWorkflowArgs(JSON.stringify({ goal: "g", steps: [{ id: "a" }] }));
    expect(noTask.ok).toBe(false);
    const longTask = parseWorkflowArgs(
      JSON.stringify({ goal: "g", steps: [{ id: "a", task: "x".repeat(WORKFLOW_STEP_TASK_MAX_CHARS + 1) }] }),
    );
    expect(longTask.ok).toBe(false);
  });

  it("拒绝不存在的依赖与自己依赖自己，但允许引用后面才定义的步骤", () => {
    const unknown = parseWorkflowArgs(
      JSON.stringify({ goal: "g", steps: [{ id: "a", task: "x", needs: ["nope"] }] }),
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("nope");
    const self = parseWorkflowArgs(
      JSON.stringify({ goal: "g", steps: [{ id: "a", task: "x", needs: ["a"] }] }),
    );
    expect(self.ok).toBe(false);
    const forward = parseWorkflowArgs(
      JSON.stringify({
        goal: "g",
        steps: [
          { id: "b", task: "先读 A 的结论", needs: ["a"] },
          { id: "a", task: "列出文件" },
        ],
      }),
    );
    expect(forward.ok).toBe(true);
  });

  it("校验 max_rounds 的类型与范围", () => {
    const text = JSON.stringify({ goal: "g", steps: [{ id: "a", task: "x" }], max_rounds: 0 });
    const zero = parseWorkflowArgs(text);
    expect(zero.ok).toBe(false);
    const clamped = parseWorkflowArgs(
      JSON.stringify({ goal: "g", steps: [{ id: "a", task: "x" }], max_rounds: 99 }),
    );
    expect(clamped.ok).toBe(true);
    if (clamped.ok) expect(clamped.plan.maxRounds).toBeLessThanOrEqual(6);
  });
});

describe("planWaves（d.203.4.109）", () => {
  it("链式依赖拆成逐批：a → b → c", () => {
    const waves = planWaves([
      { id: "a", task: "x", needs: [] },
      { id: "b", task: "y", needs: ["a"] },
      { id: "c", task: "z", needs: ["b"] },
    ]);
    expect(waves.ok).toBe(true);
    if (waves.ok) expect(waves.waves).toEqual([["a"], ["b"], ["c"]]);
  });

  it("互不依赖的一批并行，菱形依赖拆成三层", () => {
    const flat = planWaves([
      { id: "a", task: "x", needs: [] },
      { id: "b", task: "y", needs: [] },
    ]);
    expect(flat.ok).toBe(true);
    if (flat.ok) expect(flat.waves).toEqual([["a", "b"]]);
    const diamond = planWaves([
      { id: "a", task: "x", needs: [] },
      { id: "b", task: "y", needs: ["a"] },
      { id: "c", task: "z", needs: ["a"] },
      { id: "d", task: "w", needs: ["b", "c"] },
    ]);
    expect(diamond.ok).toBe(true);
    if (diamond.ok) expect(diamond.waves).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  it("成环时不执行，并指出是哪几条在互相等待", () => {
    const cycle = planWaves([
      { id: "a", task: "x", needs: ["b"] },
      { id: "b", task: "y", needs: ["a"] },
    ]);
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) {
      expect(cycle.error).toContain("成环");
      expect(cycle.error).toContain("a");
      expect(cycle.error).toContain("b");
    }
  });
});

describe("runWorkflow（d.203.4.109）", () => {
  it("按依赖顺序执行，并把上游结论接在下游任务前面", async () => {
    const seen: { task: string; messages: ChatMessage[] }[] = [];
    const deps = makeDeps({
      seen,
      conclusions: (task) => (task.includes("列出") ? "SCAN-CONCLUSION" : "READ-CONCLUSION"),
    });
    const result = await runWorkflow(
      plan([
        { id: "scan", task: "列出 auth 相关文件", needs: [] },
        { id: "read", task: "读 auth 的核心实现", needs: ["scan"] },
      ]),
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.waves).toEqual([["scan"], ["read"]]);
    // 上游先跑、下游后跑
    const scanIndex = seen.findIndex((item) => item.task.includes("列出"));
    const readIndex = seen.findIndex((item) => item.task.includes("读 auth"));
    expect(scanIndex).toBeGreaterThanOrEqual(0);
    expect(readIndex).toBeGreaterThan(scanIndex);
    // 下游任务里带着上游的结论，且带步骤 id / 任务名
    expect(seen[readIndex]?.task).toContain("上游步骤已经查到的结论");
    expect(seen[readIndex]?.task).toContain("SCAN-CONCLUSION");
    expect(seen[readIndex]?.task).toContain("步骤 scan");
    // 汇总里两步都在，并带轮次用量
    expect(result.text).toContain("工作流（2 步 / 2 批");
    expect(result.text).toContain("### [scan]");
    expect(result.text).toContain("SCAN-CONCLUSION");
    expect(result.text).toContain("### [read]");
  });

  it("同一批的步骤并行跑，结果顺序仍按计划顺序", async () => {
    const started: string[] = [];
    let running = 0;
    let peak = 0;
    const deps = makeDeps({
      conclusions: (task) => `结论 ${task}`,
    });
    deps.chat = async (messages) => {
      const task = lastUserText(messages);
      started.push(task);
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return `结论 ${task}`;
    };
    const result = await runWorkflow(
      plan([
        { id: "a", task: "第一件", needs: [] },
        { id: "b", task: "第二件", needs: [] },
        { id: "c", task: "第三件", needs: [] },
      ]),
      deps,
      { concurrency: 3 },
    );
    expect(result.ok).toBe(true);
    expect(result.waves).toEqual([["a", "b", "c"]]);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(WORKFLOW_MAX_CONCURRENT);
    expect(result.steps.map((step) => step.id)).toEqual(["a", "b", "c"]);
  });

  it("上游结论过长时截断，不把原文一路搬下去", async () => {
    const seen: { task: string; messages: ChatMessage[] }[] = [];
    const deps = makeDeps({ seen, conclusions: () => "长".repeat(WORKFLOW_UPSTREAM_CONTEXT_MAX * 2) });
    await runWorkflow(
      plan([
        { id: "a", task: "第一件", needs: [] },
        { id: "b", task: "第二件", needs: ["a"] },
      ]),
      deps,
    );
    const downstream = seen.find((item) => item.task.includes("第二件"))?.task ?? "";
    expect(downstream).toContain("已截断");
    expect(downstream.length).toBeLessThan(WORKFLOW_UPSTREAM_CONTEXT_MAX * 2);
  });

  it("某一步没跑完时如实标出，并提示按原因决定重试还是说明", async () => {
    const deps = makeDeps({ conclusions: () => "结论" });
    // 第一步正常、第二步在对话阶段抛错（子代理内部会把它变成 ok:false）。
    let calls = 0;
    deps.chat = async (messages) => {
      calls += 1;
      if (lastUserText(messages).includes("第二件")) throw new Error("上游挂了");
      return "结论";
    };
    const result = await runWorkflow(
      plan([
        { id: "a", task: "第一件", needs: [] },
        { id: "b", task: "第二件", needs: [] },
      ]),
      deps,
    );
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("未完成");
    expect(result.text).toContain("有步骤没有跑完");
  });

  it("进度用步骤 id 上报，且显示的是这一步原任务（不是注入的上下文）", async () => {
    const ids: string[] = [];
    const tasks: string[] = [];
    const deps = makeDeps({
      onProgress: (event) => {
        ids.push(event.taskId);
        tasks.push(event.task);
      },
    });
    await runWorkflow(
      plan([
        { id: "scan", task: "列出文件", needs: [] },
        { id: "read", task: "读实现", needs: ["scan"] },
      ]),
      deps,
    );
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id === "wf-scan" || id === "wf-read")).toBe(true);
    // 下游任务带着上游结论，但面板该显示「读实现」而不是那段注入文字
    expect(tasks).toContain("列出文件");
    expect(tasks).toContain("读实现");
    expect(tasks.some((task) => task.includes("上游步骤已经查到的结论"))).toBe(false);
  });
});

describe("withWorkflowTool（d.203.4.109）", () => {
  it("多出一件 workflow_run，风险是只读；其余工具原样透传", async () => {
    const bridge = makeBridge();
    const wrapped = withWorkflowTool(bridge, { agentId: "system-assistant", conversationId: "c1" });
    const names = wrapped.tools.map((spec) => String((spec as { function: { name: string } }).function.name));
    expect(names).toContain(WORKFLOW_TOOL);
    expect(names).toContain("file_read");
    expect(wrapped.meta?.(WORKFLOW_TOOL)).toEqual({ risk: "read", displayName: "跑工作流", core: true });
    expect(wrapped.meta?.("file_read")).toEqual({ risk: "read" });
    const response = await wrapped.execute({ name: "file_read", arguments: "{}" }, {});
    expect(response.text).toBe("读到 {}");
  });

  it("参数不合法时直接回可照做的错误，不发起任何子会话", async () => {
    let chats = 0;
    const wrapped = withWorkflowTool(makeBridge(), {
      agentId: "system-assistant",
      conversationId: "c1",
      chat: async () => {
        chats += 1;
        return "不应被调用";
      },
    });
    const response = await wrapped.execute({ name: WORKFLOW_TOOL, arguments: "{}" }, {});
    expect(response.ok).toBe(false);
    expect(chats).toBe(0);
  });

  it("依赖成环时在执行前拒绝，并把环上的步骤 id 讲清楚", async () => {
    let chats = 0;
    const wrapped = withWorkflowTool(makeBridge(), {
      agentId: "system-assistant",
      conversationId: "c1",
      chat: async () => {
        chats += 1;
        return "结论";
      },
    });
    const response = await wrapped.execute(
      {
        name: WORKFLOW_TOOL,
        arguments: JSON.stringify({
          goal: "g",
          steps: [
            { id: "a", task: "第一步", needs: ["b"] },
            { id: "b", task: "第二步", needs: ["a"] },
          ],
        }),
      },
      {},
    );
    expect(chats).toBe(0);
    expect(response.ok).toBe(false);
    expect(response.text).toContain("成环");
  });

  it("没有模型绑定时给出指路文案（而不是静默失败）", async () => {
    const wrapped = withWorkflowTool(makeBridge(), {
      agentId: "agent-without-binding",
      conversationId: "c1",
    });
    const response = await wrapped.execute(
      {
        name: WORKFLOW_TOOL,
        arguments: JSON.stringify({ goal: "g", steps: [{ id: "a", task: "第一步" }] }),
      },
      {},
    );
    expect(response.ok).toBe(false);
    expect(response.text).toContain("没有可用的模型绑定");
  });

  it("注入 chat 时跑完整条流程，并按步骤分段回结论", async () => {
    const wrapped = withWorkflowTool(makeBridge(), {
      agentId: "system-assistant",
      conversationId: "c1",
      chat: async (messages) => {
        const task = lastUserText(messages);
        return `【假模型】${task.slice(0, 20)}`;
      },
    });
    const response = await wrapped.execute(
      {
        name: WORKFLOW_TOOL,
        arguments: JSON.stringify({
          goal: "弄清登录链路",
          steps: [
            { id: "scan", task: "列出 auth 相关文件" },
            { id: "read", task: "读核心实现", needs: ["scan"] },
          ],
        }),
      },
      {},
    );
    expect(response.ok).toBe(true);
    expect(response.text).toContain("工作流（2 步");
    expect(response.text).toContain("目标：弄清登录链路");
    expect(response.text).toContain("### [scan]");
    expect(response.text).toContain("### [read]");
    expect(response.text).toContain("【假模型】");
  });

  it("spec 写明有依赖要写 needs、步数上限与轮次上限", () => {
    const spec = workflowSpec() as {
      function: { name: string; description: string; parameters: { properties: Record<string, unknown>; required: string[] } };
    };
    expect(spec.function.name).toBe(WORKFLOW_TOOL);
    expect(spec.function.description).toContain("needs");
    expect(spec.function.parameters.required).toEqual(["goal", "steps"]);
    const steps = spec.function.parameters.properties.steps as { maxItems: number };
    expect(steps.maxItems).toBe(WORKFLOW_MAX_STEPS);
  });
});
