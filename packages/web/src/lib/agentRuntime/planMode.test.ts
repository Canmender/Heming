import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolBridge } from "../agentStream.js";
import {
  PLAN_EXECUTE_PROMPT,
  PLAN_MODE_BLOCK_TEXT,
  PLAN_MODE_KEY,
  PLAN_MODE_MAX_ROOMS,
  isWriteRisk,
  loadPlanMode,
  planModeAllows,
  resetPlanMode,
  savePlanMode,
  withPlanMode,
} from "./planMode.js";

function fakeBridge(overrides: Partial<ToolBridge> = {}): ToolBridge {
  const specs = [
    { type: "function", function: { name: "file_read" } },
    { type: "function", function: { name: "file_write" } },
    { type: "function", function: { name: "file_undo" } },
    { type: "function", function: { name: "run_command" } },
    { type: "function", function: { name: "mcp_unknown" } },
    { type: "function", function: { name: "todo_write" } },
  ];
  const risks: Record<string, "read" | "write" | "danger" | undefined> = {
    file_read: "read",
    file_write: "write",
    file_undo: "write",
    run_command: "danger",
    mcp_unknown: undefined,
    todo_write: "read",
  };
  return {
    tools: specs,
    execute: vi.fn(async () => ({ text: "真执行了", ok: true })),
    meta: (name: string) => (risks[name] ? { risk: risks[name] } : undefined),
    ...overrides,
  };
}

function names(bridge: ToolBridge): string[] {
  return bridge.tools.map((spec) => (spec as { function: { name: string } }).function.name);
}

afterEach(() => {
  resetPlanMode();
  localStorage.removeItem(PLAN_MODE_KEY);
});

describe("计划模式 · 存储（d.173）", () => {
  it("默认关闭：没开过的会话读回来是 false", () => {
    expect(loadPlanMode("c1")).toBe(false);
  });

  it("开启后能读回，关闭后立刻消失", () => {
    expect(savePlanMode("c1", true)).toBe(true);
    expect(loadPlanMode("c1")).toBe(true);
    expect(savePlanMode("c1", false)).toBe(true);
    expect(loadPlanMode("c1")).toBe(false);
  });

  it("按会话隔离：开 A 不影响 B", () => {
    savePlanMode("a", true);
    expect(loadPlanMode("a")).toBe(true);
    expect(loadPlanMode("b")).toBe(false);
  });

  it("没有会话 id（未落库的新对话）时既不读也不写", () => {
    expect(loadPlanMode(undefined)).toBe(false);
    expect(savePlanMode(undefined, true)).toBe(false);
  });

  it("坏 JSON 当作没开过（它不是安全边界，读坏了大不了重开）", () => {
    localStorage.setItem(PLAN_MODE_KEY, "{ 这不是 JSON");
    expect(loadPlanMode("c1")).toBe(false);
  });

  it("超过上限时只留最近的 50 个会话，存储不会无限长", () => {
    for (let i = 0; i < PLAN_MODE_MAX_ROOMS + 5; i++) {
      savePlanMode(`room-${i}`, true);
    }
    const raw = localStorage.getItem(PLAN_MODE_KEY);
    expect(raw).toBeTruthy();
    const rooms = Object.keys((JSON.parse(raw!) as { rooms: Record<string, number> }).rooms);
    expect(rooms).toHaveLength(PLAN_MODE_MAX_ROOMS);
    // 最近开的那个一定还在；最早的会被淘汰
    expect(loadPlanMode(`room-${PLAN_MODE_MAX_ROOMS + 4}`)).toBe(true);
    expect(loadPlanMode("room-0")).toBe(false);
  });
});

describe("计划模式 · 风险判定", () => {
  it("write / danger 算「会改东西」，read 与未知不算", () => {
    expect(isWriteRisk("write")).toBe(true);
    expect(isWriteRisk("danger")).toBe(true);
    expect(isWriteRisk("read")).toBe(false);
    expect(isWriteRisk(undefined)).toBe(false);
  });

  it("只有显式声明 risk=read 的工具允许；风险不明（MCP）一律不许", () => {
    const bridge = fakeBridge();
    expect(planModeAllows(bridge, "file_read")).toBe(true);
    expect(planModeAllows(bridge, "file_write")).toBe(false);
    expect(planModeAllows(bridge, "run_command")).toBe(false);
    expect(planModeAllows(bridge, "mcp_unknown")).toBe(false);
    // 桥没有 meta 时也按「不明」处理
    expect(planModeAllows({ tools: [], execute: async () => ({ text: "", ok: true }) }, "file_read")).toBe(false);
  });
});

describe("计划模式 · 桥包装", () => {
  it("工具清单只留只读的（写类、danger、风险不明都被摘掉）", () => {
    const bridge = withPlanMode(fakeBridge());
    expect(names(bridge)).toEqual(["file_read", "todo_write"]);
  });

  it("执行层也拦：写工具即使被点名也不调用原桥，回 plan-mode 错误码", async () => {
    const inner = fakeBridge();
    const bridge = withPlanMode(inner);
    const result = await bridge.execute({ name: "file_write", arguments: "{}" });
    expect(result.ok).toBe(false);
    expect(result.error?.error_code).toBe("plan-mode");
    expect(result.text).toContain("计划模式");
    expect(result.text).toBe(PLAN_MODE_BLOCK_TEXT);
    expect(inner.execute).not.toHaveBeenCalled();
  });

  it("只读工具照常透传（包括 opts.signal）", async () => {
    const inner = fakeBridge();
    const bridge = withPlanMode(inner);
    const controller = new AbortController();
    const result = await bridge.execute({ name: "file_read", arguments: "{}" }, { signal: controller.signal });
    expect(result.ok).toBe(true);
    expect(inner.execute).toHaveBeenCalledWith({ name: "file_read", arguments: "{}" }, { signal: controller.signal });
  });

  it("风险元数据透传：提示词与闸门查到的仍是同一份声明", () => {
    const bridge = withPlanMode(fakeBridge());
    expect(bridge.meta?.("file_write")?.risk).toBe("write");
    expect(bridge.meta?.("file_read")?.risk).toBe("read");
  });
});

describe("计划就绪后的一键执行（d.173）", () => {
  it("执行口令要求「照计划做、逐步更新清单、改完先验证」，而不是重发原提问", () => {
    expect(PLAN_EXECUTE_PROMPT).toContain("照上面这份计划开始执行");
    expect(PLAN_EXECUTE_PROMPT).toContain("任务清单");
    expect(PLAN_EXECUTE_PROMPT).toContain("验证");
    // 它是一条新的用户消息：不该把原提问再写一遍（retryStream 的同一个理由）
    expect(PLAN_EXECUTE_PROMPT).not.toContain("重新回答");
  });
});
