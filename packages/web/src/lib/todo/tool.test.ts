/**
 * `todo_write` 工具：校验口径 + 执行结果 + 桥的边界。
 *
 * 重点不是「能存下」，而是**模型给错时能拿到能改的具体错误**——校验失败不能静默吞掉，
 * 也不能把现有清单改坏（长任务最怕「更新了一下，进度全没了」）。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getTodos, MAX_TODOS, TODO_CONTENT_MAX, resetTodoStore, setTodos } from "./store.js";
import { TODO_TOOL, buildTodoToolBridge, parseTodoArgs, runTodoWrite } from "./tool.js";

beforeEach(() => {
  localStorage.clear();
  resetTodoStore();
});

describe("parseTodoArgs（校验口径）", () => {
  it("合法清单原样通过，内容去首尾空白", () => {
    const parsed = parseTodoArgs([
      { content: "  读入口文件  ", status: "in_progress" },
      { content: "跑测试", status: "pending" },
    ]);
    expect(parsed).toEqual({
      ok: true,
      items: [
        { content: "读入口文件", status: "in_progress" },
        { content: "跑测试", status: "pending" },
      ],
    });
  });

  it("空数组合法（表示清空）", () => {
    expect(parseTodoArgs([])).toEqual({ ok: true, items: [] });
  });

  it("不是数组 → 直接说要数组", () => {
    const parsed = parseTodoArgs({ todos: [] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("数组");
  });

  it("空内容 / 纯空白 → 报第几条缺 content", () => {
    const parsed = parseTodoArgs([{ content: "  ", status: "pending" }]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("第 1 条");
      expect(parsed.error).toContain("content");
    }
  });

  it("内容超长 → 报具体字数（模型才知道要拆短）", () => {
    const parsed = parseTodoArgs([
      { content: "长".repeat(TODO_CONTENT_MAX + 1), status: "pending" },
    ]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(String(TODO_CONTENT_MAX));
  });

  it("重复内容 → 指到重复的那一条", () => {
    const parsed = parseTodoArgs([
      { content: "同一件事", status: "pending" },
      { content: "同一件事", status: "completed" },
    ]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("第 2 条");
  });

  it("非法状态 → 列出三个合法值", () => {
    const parsed = parseTodoArgs([{ content: "一", status: "doing" }]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("pending");
      expect(parsed.error).toContain("in_progress");
      expect(parsed.error).toContain("completed");
    }
  });

  it("两条 in_progress → 拒绝（单活跃纪律）", () => {
    const parsed = parseTodoArgs([
      { content: "一", status: "in_progress" },
      { content: "二", status: "in_progress" },
    ]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("in_progress");
  });

  it(`超过 ${MAX_TODOS} 条 → 拒绝并提示拆阶段`, () => {
    const list = Array.from({ length: MAX_TODOS + 1 }, (_, i) => ({
      content: `步骤${i}`,
      status: "pending",
    }));
    const parsed = parseTodoArgs(list);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(String(MAX_TODOS));
  });

  it("条目不是对象 → 报第几条", () => {
    const parsed = parseTodoArgs(["字符串"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("第 1 条");
  });
});

describe("runTodoWrite（执行）", () => {
  it("成功：落清单并回显整份（带进度行）", () => {
    const result = runTodoWrite(
      [
        { content: "读代码", status: "completed" },
        { content: "写补丁", status: "in_progress" },
        { content: "跑测试", status: "pending" },
      ],
      "conv-1",
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain("进度：1/3 已完成");
    expect(result.text).toContain("2. [>] 写补丁");
    expect(getTodos("conv-1")).toHaveLength(3);
  });

  it("失败：回错误 + 现有清单，但**不动**已有清单", () => {
    setTodos("conv-2", [{ content: "原计划", status: "in_progress" }]);
    const result = runTodoWrite([{ content: "新计划", status: "in_progress" }, { content: "冲突", status: "in_progress" }], "conv-2");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("没有改动现有清单");
    expect(result.text).toContain("[>] 原计划");
    expect(getTodos("conv-2")).toEqual([{ content: "原计划", status: "in_progress" }]);
  });

  it("空数组 = 清空", () => {
    setTodos("conv-3", [{ content: "一", status: "pending" }]);
    const result = runTodoWrite([], "conv-3");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("已清空");
    expect(getTodos("conv-3")).toEqual([]);
  });
});

describe("buildTodoToolBridge（工具桥）", () => {
  it("没有会话 id 就不提供工具（不写进全局桶）", () => {
    expect(buildTodoToolBridge({ conversationId: "" })).toBeNull();
  });

  it("schema：工具名 todo_write，todos 是必填数组，status 三态枚举", () => {
    const bridge = buildTodoToolBridge({ conversationId: "conv-1" });
    expect(bridge).not.toBeNull();
    const spec = bridge!.tools[0] as {
      type: string;
      function: { name: string; parameters: { required: string[]; properties: Record<string, { items: { properties: { status: { enum: string[] } } } }> } };
    };
    expect(spec.type).toBe("function");
    expect(spec.function.name).toBe(TODO_TOOL);
    expect(spec.function.parameters.required).toContain("todos");
    expect(spec.function.parameters.properties.todos.items.properties.status.enum).toEqual([
      "pending",
      "in_progress",
      "completed",
    ]);
  });

  it("meta 声明 read + 中文名（确认卡不该被写计划刷屏）", () => {
    const bridge = buildTodoToolBridge({ conversationId: "conv-1" })!;
    expect(bridge.meta?.(TODO_TOOL)).toEqual({ risk: "read", displayName: "更新任务清单", core: true });
    expect(bridge.meta?.("other_tool")).toBeUndefined();
  });

  it("execute：正常调用返回清单文本", async () => {
    const bridge = buildTodoToolBridge({ conversationId: "conv-1" })!;
    const result = await bridge.execute({
      name: TODO_TOOL,
      arguments: JSON.stringify({ todos: [{ content: "一", status: "pending" }] }),
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("[ ] 一");
  });

  it("execute：参数不是 JSON → 明确失败（不让模型以为成功了）", async () => {
    const bridge = buildTodoToolBridge({ conversationId: "conv-1" })!;
    const result = await bridge.execute({ name: TODO_TOOL, arguments: "{不是 JSON" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("JSON");
  });

  it("execute：未知工具名 → 失败", async () => {
    const bridge = buildTodoToolBridge({ conversationId: "conv-1" })!;
    const result = await bridge.execute({ name: "todo_read", arguments: "{}" });
    expect(result.ok).toBe(false);
  });
});
