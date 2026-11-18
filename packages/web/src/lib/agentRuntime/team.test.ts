/**
 * 团队任务（d.347）的用例。
 *
 * 与工作流一样，这里注入 `chat` / `execute`：团队的价值在「角色、依赖、并发、
 * 写盘边界、失败隔离」，这些用假模型就能测死；真模型那条线由对话实测与评测兜。
 */
import { describe, expect, it, vi } from "vitest";
import type { ToolBridge } from "../agentStream.js";
import type { ChatMessage } from "../llmClient.js";
import {
  TEAM_MAX_CONCURRENT,
  TEAM_MAX_MEMBERS,
  TEAM_MAX_ROUNDS_LIMIT,
  TEAM_MEMBER_TASK_MAX_CHARS,
  TEAM_TOOL,
  parseTeamArgs,
  planTeamWaves,
  runTeam,
  teamSpec,
  withTeamTool,
  type TeamMember,
  type TeamPlan,
} from "./team.js";
import { parseSubagentDefs } from "./subagentDefs.js";
import type { SubagentDeps } from "./subagent.js";

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

function lastUserText(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === "user") {
      return typeof message.content === "string" ? message.content : "";
    }
  }
  return "";
}

function specNames(tools: readonly unknown[]): string[] {
  const names: string[] = [];
  for (const tool of tools) {
    const fn = (tool as { function?: { name?: unknown } }).function;
    if (fn && typeof fn.name === "string") names.push(fn.name);
  }
  return names;
}

function makeDeps(options: {
  conclusions?: (task: string) => string;
  chat?: SubagentDeps["chat"];
  execute?: SubagentDeps["execute"];
  onProgress?: SubagentDeps["onProgress"];
  writable?: boolean;
} = {}): SubagentDeps {
  return {
    tools: makeBridge().tools,
    execute: options.execute ?? (async () => ({ text: "ok", ok: true })),
    chat:
      options.chat ??
      (async (messages) => {
        const task = lastUserText(messages);
        return options.conclusions ? options.conclusions(task) : `结论：${task}`;
      }),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.writable ? { writable: true } : {}),
  };
}

function member(id: string, extra: Partial<TeamMember> = {}): TeamMember {
  return { id, agent: null, task: `任务 ${id}`, needs: [], write: false, ...extra };
}

function plan(members: TeamMember[], goal = "把登录链路摸清并给出改造方案"): TeamPlan {
  return { goal, members, maxRounds: 2 };
}

const AGENTS = parseSubagentDefs([
  { rel: ".heming/agents/review.md", text: "# 安全审查\n> 按威胁模型逐条对\n只挑安全问题。" },
  { rel: ".heming/agents/perf.md", text: "# 性能排查\n> 先问数据规模\n先问规模再猜瓶颈。" },
]);

describe("parseTeamArgs（d.347）", () => {
  it("解析出目标、成员、依赖与 role，默认轮次为 4", () => {
    const parsed = parseTeamArgs(
      JSON.stringify({
        goal: "把登录链路摸清",
        members: [
          { id: "scan", task: "列出 auth 相关文件", agent: "review" },
          { id: "dig", task: "按扫描结果读实现", needs: ["scan"] },
        ],
      }),
      { knownAgents: ["review", "perf"] },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.goal).toBe("把登录链路摸清");
    expect(parsed.plan.maxRounds).toBe(4);
    expect(parsed.plan.members[0]).toMatchObject({ id: "scan", agent: "review", needs: [] });
    expect(parsed.plan.members[1]?.needs).toEqual(["scan"]);
  });

  it("缺 goal 时给一句能照着改的错", () => {
    const parsed = parseTeamArgs(JSON.stringify({ members: [{ id: "a", task: "x" }] }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("goal");
  });

  it("只有一位成员就拒绝：一个人应该用 agent_task", () => {
    const parsed = parseTeamArgs(
      JSON.stringify({ goal: "g", members: [{ id: "a", task: "x" }] }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("至少需要 2 位成员");
  });

  it(`超过 ${TEAM_MAX_MEMBERS} 位成员就拒绝，并提示拆分`, () => {
    const members = Array.from({ length: TEAM_MAX_MEMBERS + 1 }, (_, i) => ({
      id: `m${i}`,
      task: "x",
    }));
    const parsed = parseTeamArgs(JSON.stringify({ goal: "g", members }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("最多");
  });

  it("成员 id 必须是小写可引用的短标识", () => {
    const parsed = parseTeamArgs(
      JSON.stringify({
        goal: "g",
        members: [
          { id: "1bad", task: "x" },
          { id: "ok", task: "y" },
        ],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("id 不合法");
  });

  it("成员 id 重复时拒绝（needs 会指不清）", () => {
    const parsed = parseTeamArgs(
      JSON.stringify({
        goal: "g",
        members: [
          { id: "dup", task: "x" },
          { id: "dup", task: "y" },
        ],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("重复");
  });

  it("任务太长时拒绝，并说明上限", () => {
    const parsed = parseTeamArgs(
      JSON.stringify({
        goal: "g",
        members: [
          { id: "a", task: "长".repeat(TEAM_MEMBER_TASK_MAX_CHARS + 1) },
          { id: "b", task: "y" },
        ],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain(String(TEAM_MEMBER_TASK_MAX_CHARS));
  });

  it("依赖不存在的成员时，列出可用的 id", () => {
    const parsed = parseTeamArgs(
      JSON.stringify({
        goal: "g",
        members: [
          { id: "a", task: "x", needs: ["ghost"] },
          { id: "b", task: "y" },
        ],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("ghost");
    expect(parsed.error).toContain("a / b");
  });

  it("自己依赖自己时拒绝", () => {
    const parsed = parseTeamArgs(
      JSON.stringify({
        goal: "g",
        members: [
          { id: "a", task: "x", needs: ["a"] },
          { id: "b", task: "y" },
        ],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("不能依赖自己");
  });

  it("成环时指出谁在互相等待，而不是只说「有环」", () => {
    const parsed = parseTeamArgs(
      JSON.stringify({
        goal: "g",
        members: [
          { id: "a", task: "x", needs: ["b"] },
          { id: "b", task: "y", needs: ["a"] },
        ],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("成环");
    expect(parsed.error).toContain("「a」");
    expect(parsed.error).toContain("「b」");
  });

  it("没授权写盘时，任何 write: true 都在执行前拒绝", () => {
    const parsed = parseTeamArgs(
      JSON.stringify({
        goal: "g",
        members: [
          { id: "a", task: "x", write: true },
          { id: "b", task: "y" },
        ],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("没有授权子代理写盘");
  });

  it("授权写盘后 write: true 才被接受", () => {
    const parsed = parseTeamArgs(
      JSON.stringify({
        goal: "g",
        members: [
          { id: "a", task: "x", write: true },
          { id: "b", task: "y" },
        ],
      }),
      { allowWrite: true },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.members[0]?.write).toBe(true);
  });

  it("点名不存在的角色时，列出工作区里定义的名字", () => {
    const parsed = parseTeamArgs(
      JSON.stringify({
        goal: "g",
        members: [
          { id: "a", task: "x", agent: "ghost" },
          { id: "b", task: "y" },
        ],
      }),
      { knownAgents: ["review", "perf"] },
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("ghost");
    expect(parsed.error).toContain("review / perf");
  });

  it(`轮次上限抬到 ${TEAM_MAX_ROUNDS_LIMIT}，超出的按上限夹住`, () => {
    const parsed = parseTeamArgs(
      JSON.stringify({
        goal: "g",
        max_rounds: 99,
        members: [
          { id: "a", task: "x" },
          { id: "b", task: "y" },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.maxRounds).toBe(TEAM_MAX_ROUNDS_LIMIT);
  });
});

describe("planTeamWaves（d.347）", () => {
  it("互不依赖的同批并行", () => {
    const planned = planTeamWaves([member("a"), member("b"), member("c")]);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.waves).toEqual([["a", "b", "c"]]);
  });

  it("链式依赖逐批排开", () => {
    const planned = planTeamWaves([
      member("a"),
      member("b", { needs: ["a"] }),
      member("c", { needs: ["b"] }),
    ]);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.waves).toEqual([["a"], ["b"], ["c"]]);
  });

  it("菱形依赖：中游并行、下游等齐", () => {
    const planned = planTeamWaves([
      member("a"),
      member("b", { needs: ["a"] }),
      member("c", { needs: ["a"] }),
      member("d", { needs: ["b", "c"] }),
    ]);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.waves).toEqual([["a"], ["b", "c"], ["d"]]);
  });
});

describe("runTeam（d.347）", () => {
  it("按依赖顺序跑，并把上游结论接在下游任务前面", async () => {
    const seen: { task: string }[] = [];
    const result = await runTeam(
      plan([member("scan", { task: "列出 auth 文件" }), member("dig", { task: "读实现", needs: ["scan"] })]),
      makeDeps({
        chat: async (messages) => {
          const task = lastUserText(messages);
          seen.push({ task });
          return task.includes("读实现") ? "下游结论" : "上游结论：auth.ts";
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(seen[0]?.task).toContain("列出 auth 文件");
    expect(seen[1]?.task).toContain("上游成员已经查到的结论");
    expect(seen[1]?.task).toContain("auth.ts");
    expect(seen[1]?.task).toContain("读实现");
    expect(result.text).toContain("团队任务");
    expect(result.text).toContain("目标：把登录链路摸清并给出改造方案");
  });

  it("同批并行但不超过并发上限", async () => {
    let active = 0;
    let peak = 0;
    await runTeam(
      plan([member("a"), member("b"), member("c"), member("d")]),
      makeDeps({
        chat: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return "结论";
        },
      }),
    );
    expect(peak).toBeLessThanOrEqual(TEAM_MAX_CONCURRENT);
    expect(peak).toBeGreaterThan(1);
  });

  it("一位成员出错不拖垮整队，下游照跑并看见失败", async () => {
    const seen: string[] = [];
    const result = await runTeam(
      plan([member("a"), member("b", { needs: ["a"] })]),
      makeDeps({
        chat: async (messages, _tools, _signal, onToolCalls) => {
          const task = lastUserText(messages);
          seen.push(task);
          if (task.includes("任务 a") && !task.includes("上游成员")) throw new Error("模型超时");
          onToolCalls([]);
          return "结论";
        },
      }),
    );
    expect(seen.some((task) => task.includes("任务 b"))).toBe(true);
    expect(result.text).toContain("这位成员执行时出错");
    expect(result.ok).toBe(false);
  });

  it("只有 write: true 的成员拿到写工具与可写人设", async () => {
    const prompts: { writable: boolean; names: string[] }[] = [];
    await runTeam(
      plan([member("a", { write: true }), member("b")]),
      makeDeps({
        writable: true,
        chat: async (messages, tools) => {
          const system = messages.find((message) => message.role === "system");
          const text = typeof system?.content === "string" ? system.content : "";
          prompts.push({ writable: text.includes("已授权你改文件"), names: specNames(tools) });
          return "结论";
        },
      }),
    );
    expect(prompts).toHaveLength(2);
    const writable = prompts.filter((item) => item.writable);
    expect(writable).toHaveLength(1);
    expect(writable[0]?.names).toContain("file_write");
    const readOnly = prompts.filter((item) => !item.writable);
    expect(readOnly[0]?.names).not.toContain("file_write");
  });

  it("没授权写盘时所有成员都只读，即使成员写了 write", async () => {
    const prompts: string[] = [];
    const parsed = parseTeamArgs(
      JSON.stringify({
        goal: "g",
        members: [
          { id: "a", task: "x" },
          { id: "b", task: "y" },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    await runTeam(parsed.plan, {
      ...makeDeps({
        chat: async (messages) => {
          const system = messages.find((message) => message.role === "system");
          prompts.push(typeof system?.content === "string" ? system.content : "");
          return "结论";
        },
      }),
    });
    expect(prompts.every((text) => text.includes("只读子代理"))).toBe(true);
  });

  it("进度带成员身份与角色名，界面才能按人显示", async () => {
    const onProgress = vi.fn();
    await runTeam(
      plan([member("review", { agent: "review" }), member("perf", { agent: "perf" })]),
      {
        ...makeDeps({ onProgress }),
        agents: AGENTS,
      },
    );
    const events = onProgress.mock.calls.map((call) => call[0] as { memberId: string; role: string });
    expect(events.some((event) => event.memberId === "review" && event.role === "安全审查")).toBe(true);
    expect(events.some((event) => event.memberId === "perf" && event.role === "性能排查")).toBe(true);
  });

  it("回调 onStart / onFinish 各一次，收口带成员结果", async () => {
    const onStart = vi.fn();
    const onFinish = vi.fn();
    await runTeam(plan([member("a"), member("b")]), makeDeps(), { onStart, onFinish });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledTimes(1);
    const finished = onFinish.mock.calls[0]?.[0] as { members: { id: string }[] };
    expect(finished.members.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("轮次上限抬到 8：长任务成员真的能多跑几轮", async () => {
    let rounds = 0;
    const result = await runTeam(
      { goal: "g", members: [member("a", { task: "深挖" }), member("b", { task: "深挖2" })], maxRounds: 7 },
      makeDeps({
        chat: async (_messages, _tools, _signal, onToolCalls) => {
          rounds += 1;
          onToolCalls([{ id: `c${rounds}`, name: "file_read", arguments: "{}" }]);
          return "还要读";
        },
      }),
    );
    expect(result.members.every((item) => item.rounds === 7)).toBe(true);
  });
});

describe("teamSpec / withTeamTool（d.347）", () => {
  it("没有授权、没有角色定义时不出现 write / agent 参数", () => {
    const spec = teamSpec() as { function: { parameters: { properties: Record<string, unknown> } } };
    const memberProps = (spec.function.parameters.properties.members as {
      items: { properties: Record<string, unknown> };
    }).items.properties;
    expect(memberProps.write).toBeUndefined();
    expect(memberProps.agent).toBeUndefined();
  });

  it("授权写盘与角色定义时，schema 如实出现", () => {
    const spec = teamSpec({ writable: true, agents: AGENTS }) as {
      function: { parameters: { properties: Record<string, unknown> } };
    };
    const memberProps = (spec.function.parameters.properties.members as {
      items: { properties: Record<string, unknown> & { agent: { enum: string[] } } };
    }).items.properties;
    expect(memberProps.write).toBeDefined();
    expect(memberProps.agent.enum).toEqual(["perf", "review"]);
  });

  it("把 agent_team 挂到桥上：核心工具、参数错误原样回给模型", async () => {
    const bridge = withTeamTool(makeBridge(), {
      agentId: "system",
      conversationId: "c1",
      chat: async () => "结论",
    });
    expect(specNames(bridge.tools)).toContain(TEAM_TOOL);
    expect(bridge.meta?.(TEAM_TOOL)).toMatchObject({ displayName: "派团队", core: true });
    const bad = await bridge.execute({ name: TEAM_TOOL, arguments: "{oops" });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("不是合法 JSON");
  });

  it("正常调用把团队结论交给模型，且 ok 反映整队成败", async () => {
    const bridge = withTeamTool(makeBridge(), {
      agentId: "system",
      conversationId: "c1",
      chat: async () => "结论",
    });
    const good = await bridge.execute({
      name: TEAM_TOOL,
      arguments: JSON.stringify({
        goal: "g",
        members: [
          { id: "a", task: "x" },
          { id: "b", task: "y" },
        ],
      }),
    });
    expect(good.ok).toBe(true);
    expect(good.text).toContain("团队任务");
    expect(good.text).toContain("以上是团队各成员的结论");
  });
});
