import { describe, expect, it } from "vitest";
import type { ToolTrace } from "../store/chat.js";
import {
  TOOL_TRACE_FOLD_AT,
  TOOL_TRACE_KEEP_RECENT,
  foldToolTraces,
} from "./toolTraceFold.js";

function trace(index: number, status: ToolTrace["status"] = "ok"): ToolTrace {
  return {
    id: `t-${index}`,
    name: "run_command",
    args: JSON.stringify({ command: `step-${index}` }),
    status,
    result: `输出 ${index}`,
    startedAt: index * 10,
    endedAt: index * 10 + 5,
  };
}

describe("工具轨迹折叠（d.243）", () => {
  it("少于阈值不折：一行都不藏", () => {
    const tools = Array.from({ length: TOOL_TRACE_FOLD_AT }, (_, i) => trace(i + 1));
    const folded = foldToolTraces(tools);
    expect(folded.hidden).toHaveLength(0);
    expect(folded.visible).toHaveLength(tools.length);
  });

  it("超过阈值只保留最近几次，其余收起", () => {
    const tools = Array.from({ length: 10 }, (_, i) => trace(i + 1));
    const folded = foldToolTraces(tools);
    expect(folded.visible).toHaveLength(TOOL_TRACE_KEEP_RECENT);
    expect(folded.visible.at(-1)?.id).toBe("t-10");
    expect(folded.hidden).toHaveLength(10 - folded.visible.length);
  });

  it("旧的失败/被拒调用不折——否则「为什么卡住」被藏起来", () => {
    const tools = [trace(1, "error"), trace(2), trace(3, "denied"), ...Array.from({ length: 5 }, (_, i) => trace(i + 4))];
    const folded = foldToolTraces(tools);
    const visibleIds = folded.visible.map((t) => t.id);
    expect(visibleIds).toContain("t-1");
    expect(visibleIds).toContain("t-3");
    // 折起来的必须全是成功的
    expect(folded.hidden.every((t) => t.status === "ok")).toBe(true);
    expect(folded.hiddenFailed).toBe(0);
  });

  it("保留最近几次时，失败行不计入「最近」的名额但仍留在可见里", () => {
    const tools = [trace(1), trace(2), trace(3, "error"), trace(4), trace(5), trace(6), trace(7), trace(8)];
    const folded = foldToolTraces(tools, 4, 2);
    // 最近 2 条是 t-7/t-8；t-3 是失败行，也留在可见里
    expect(folded.visible.map((t) => t.id)).toEqual(expect.arrayContaining(["t-3", "t-7", "t-8"]));
    expect(folded.hidden.map((t) => t.id)).not.toContain("t-3");
  });

  it("顺序不颠倒：可见行仍按原时间排", () => {
    const tools = Array.from({ length: 9 }, (_, i) => trace(i + 1));
    const folded = foldToolTraces(tools);
    const indexes = folded.visible.map((t) => tools.indexOf(t));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it("空列表不抛错", () => {
    expect(foldToolTraces([])).toEqual({ hidden: [], visible: [], hiddenFailed: 0 });
  });
});
