import { describe, expect, it, vi } from "vitest";
import type { ToolBridge } from "../agentStream.js";
import {
  PANEL_REASON_MAX,
  PANEL_TOOL,
  buildPanelToolBridge,
  withPanelTool,
} from "./panelTool.js";

/**
 * `panel_show`（d.245）：让模型自己打开右侧会话进度栏。
 *
 * 只测契约，不测 React：工具桥是纯逻辑，「打开」这件事通过注入的回调断言。
 * 特别钉住两条：参数坏了也要打开（开栏不依赖参数）、理由要截到一行能放下的长度。
 */
describe("panelTool · panel_show 的工具契约", () => {
  it("声明成一个只读、免确认的工具", () => {
    const bridge = buildPanelToolBridge({ onOpen: () => {} });
    const spec = bridge.tools[0] as { type: string; function: { name: string } };
    expect(spec.type).toBe("function");
    expect(spec.function.name).toBe(PANEL_TOOL);
    expect(bridge.meta?.(PANEL_TOOL)).toMatchObject({ risk: "read", displayName: "打开会话进度栏" });
  });

  it("调用后把 trim 过的理由交给打开回调，并回一句可读的结果", async () => {
    const onOpen = vi.fn();
    const bridge = buildPanelToolBridge({ onOpen });
    const result = await bridge.execute({
      name: PANEL_TOOL,
      arguments: JSON.stringify({ reason: "  我列了三步计划  " }),
    });
    expect(onOpen).toHaveBeenCalledWith("我列了三步计划");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("会话进度");
  });

  it("没给理由也能打开（理由只是可选的说明）", async () => {
    const onOpen = vi.fn();
    const bridge = buildPanelToolBridge({ onOpen });
    const result = await bridge.execute({ name: PANEL_TOOL, arguments: "{}" });
    expect(onOpen).toHaveBeenCalledWith("");
    expect(result.ok).toBe(true);
  });

  it("参数不是合法 JSON 照样打开：开栏不依赖参数", async () => {
    const onOpen = vi.fn();
    const bridge = buildPanelToolBridge({ onOpen });
    const result = await bridge.execute({ name: PANEL_TOOL, arguments: "{坏掉了" });
    expect(onOpen).toHaveBeenCalledWith("");
    expect(result.ok).toBe(true);
  });

  it("理由过长按上限截断（栏头只有一行）", async () => {
    const onOpen = vi.fn();
    const bridge = buildPanelToolBridge({ onOpen });
    await bridge.execute({
      name: PANEL_TOOL,
      arguments: JSON.stringify({ reason: "长".repeat(PANEL_REASON_MAX + 40) }),
    });
    const reason = onOpen.mock.calls[0]?.[0] as string;
    expect(reason).toHaveLength(PANEL_REASON_MAX);
  });

  it("未知工具名回失败，不误触发打开", async () => {
    const onOpen = vi.fn();
    const bridge = buildPanelToolBridge({ onOpen });
    const result = await bridge.execute({ name: "other_tool", arguments: "{}" });
    expect(result.ok).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("panelTool · withPanelTool 包装", () => {
  const inner = (): ToolBridge => ({
    tools: [
      {
        type: "function" as const,
        function: { name: "file_read", description: "读文件", parameters: { type: "object" } },
      },
    ],
    meta: (name: string) =>
      name === "file_read" ? { risk: "read" as const, displayName: "读文件" } : undefined,
    execute: vi.fn(async () => ({ text: "原文", ok: true })),
  });

  it("在原桥工具之后追加 panel_show，原工具的 meta 与执行都不受影响", async () => {
    const onOpen = vi.fn();
    const wrapped = withPanelTool(inner(), { onOpen });
    const names = (wrapped.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(names).toEqual(["file_read", PANEL_TOOL]);
    expect(wrapped.meta?.("file_read")).toMatchObject({ displayName: "读文件" });
    expect(wrapped.meta?.(PANEL_TOOL)).toMatchObject({ displayName: "打开会话进度栏" });

    const innerResult = await wrapped.execute({ name: "file_read", arguments: "{}" });
    expect(innerResult).toEqual({ text: "原文", ok: true });

    await wrapped.execute({ name: PANEL_TOOL, arguments: "{}" });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
