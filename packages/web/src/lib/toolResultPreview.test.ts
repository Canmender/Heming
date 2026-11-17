import { describe, expect, it } from "vitest";
import {
  TOOL_RESULT_HEAD_LINES,
  TOOL_RESULT_PREVIEW_MIN_CHARS,
  TOOL_RESULT_TAIL_LINES,
  previewToolResult,
} from "./toolResultPreview.js";

function lines(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`).join("\n");
}

describe("工具结果预览（d.234）", () => {
  it("短结果原样返回，不做任何改变", () => {
    const short = "读了 12 行，没有发现明显问题。";
    const out = previewToolResult(short);
    expect(out).toEqual({ preview: short, hiddenChars: 0, truncated: false });
  });

  it("空/undefined/null 都当作没有结果", () => {
    for (const value of ["", undefined, null]) {
      expect(previewToolResult(value)).toEqual({ preview: "", hiddenChars: 0, truncated: false });
    }
  });

  it("行数很多时保留开头与结尾，中间明写藏了多少行、多少字", () => {
    const text = lines(400);
    const out = previewToolResult(text);
    expect(out.truncated).toBe(true);
    expect(out.hiddenChars).toBeGreaterThan(0);
    // 开头 head 行、结尾 tail 行都在
    expect(out.preview).toContain("line-1");
    expect(out.preview).toContain(`line-${TOOL_RESULT_HEAD_LINES}`);
    expect(out.preview).toContain("line-400");
    expect(out.preview).toContain(`line-${400 - TOOL_RESULT_TAIL_LINES + 1}`);
    // 中间那行被藏了，且说明里写了行数
    expect(out.preview).not.toContain("line-200");
    expect(out.preview).toMatch(/中间还有 \d+ 行 \/ \d+ 字未显示/);
  });

  it("几行但单行极长（压成一行的 JSON/日志）也按字符截，不会整段塞进去", () => {
    const text = "x".repeat(TOOL_RESULT_PREVIEW_MIN_CHARS * 4);
    const out = previewToolResult(text);
    expect(out.truncated).toBe(true);
    expect(out.hiddenChars).toBeGreaterThan(0);
    expect(out.preview.length).toBeLessThan(text.length);
    expect(out.preview).toMatch(/中间还有 \d+ 字未显示/);
  });

  it("刚超过阈值一点点也要截（边界不留缝），且隐藏字数为正", () => {
    const text = `${"a".repeat(TOOL_RESULT_PREVIEW_MIN_CHARS)}\n尾行`;
    const out = previewToolResult(text);
    expect(out.truncated).toBe(true);
    expect(out.hiddenChars).toBeGreaterThan(0);
    expect(out.preview).toContain("尾行");
  });

  it("可以通过参数控制头尾行数与阈值（界面/测试各自按需）", () => {
    const text = lines(30);
    const out = previewToolResult(text, { headLines: 2, tailLines: 2, minChars: 10 });
    expect(out.truncated).toBe(true);
    expect(out.preview.startsWith("line-1\nline-2\n")).toBe(true);
    expect(out.preview.trimEnd().endsWith("line-30")).toBe(true);
  });
});
