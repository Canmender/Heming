import { beforeEach, describe, expect, it } from "vitest";
import { buildToolOutputBridge, TOOL_OUTPUT_TOOL } from "./tool.js";
import { resetSpills, spillText } from "./store.js";

beforeEach(() => {
  resetSpills();
});

function specName(bridge: ReturnType<typeof buildToolOutputBridge>): string {
  const first = bridge.tools[0] as { function?: { name?: string } };
  return first.function?.name ?? "";
}

describe("tool_output_read（d.181）", () => {
  it("工具清单里只有一个工具，且是 OpenAI 外壳（多 provider 合并靠 function.name 认领）", () => {
    const bridge = buildToolOutputBridge();
    expect(bridge.tools).toHaveLength(1);
    expect(specName(bridge)).toBe(TOOL_OUTPUT_TOOL);
    const spec = bridge.tools[0] as { function: { parameters: { required: string[] } } };
    expect(spec.function.parameters.required).toContain("id");
  });

  it("meta 是只读、有中文名（HITL 与界面同源）", () => {
    const bridge = buildToolOutputBridge();
    expect(bridge.meta?.(TOOL_OUTPUT_TOOL)).toMatchObject({ risk: "read", displayName: "读取完整输出" });
  });

  it("读到一段时说明「第几到第几字符」与下一段从哪开始", async () => {
    const { id } = spillText("0123456789");
    const bridge = buildToolOutputBridge();
    const result = await bridge.execute({ name: TOOL_OUTPUT_TOOL, arguments: JSON.stringify({ id, offset: 0, limit: 4 }) });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("共 10 字符");
    expect(result.text).toContain("第 1–4 字符");
    expect(result.text).toContain("offset 设成 4");
    expect(result.text).toContain("0123");
  });

  it("读到结尾时说清楚已经读完", async () => {
    const { id } = spillText("0123456789");
    const bridge = buildToolOutputBridge();
    const result = await bridge.execute({ name: TOOL_OUTPUT_TOOL, arguments: JSON.stringify({ id, offset: 8, limit: 50 }) });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("已经读到结尾");
  });

  it("handle 不存在时如实失败，并明确「别在这里重试」", async () => {
    const bridge = buildToolOutputBridge();
    const result = await bridge.execute({ name: TOOL_OUTPUT_TOOL, arguments: JSON.stringify({ id: "spill-404" }) });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("没有 spill-404");
    expect(result.error?.error_code).toBe("spill-not-found");
    expect(result.error?.hint).toContain("重新取");
  });

  it("参数不是 JSON / 缺 id 都回 invalid-args 并给可照做的提示", async () => {
    const bridge = buildToolOutputBridge();
    const badJson = await bridge.execute({ name: TOOL_OUTPUT_TOOL, arguments: "{not json" });
    expect(badJson.ok).toBe(false);
    expect(badJson.error?.error_code).toBe("invalid-args");

    const noId = await bridge.execute({ name: TOOL_OUTPUT_TOOL, arguments: "{}" });
    expect(noId.ok).toBe(false);
    expect(noId.text).toContain("spill-<数字>");
  });

  it("只认自己的工具名（被别的桥误调时明确回未知工具）", async () => {
    const bridge = buildToolOutputBridge();
    const result = await bridge.execute({ name: "file_write", arguments: "{}" });
    expect(result.ok).toBe(false);
    expect(result.error?.error_code).toBe("unknown-tool");
  });
});
