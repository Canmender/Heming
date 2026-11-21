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

/** 检测字符串里是否有落单代理（高位后面不是低位，或低位前面不是高位）。 */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      const prev = s.charCodeAt(i - 1);
      if (!(prev >= 0xd800 && prev <= 0xdbff)) return true;
    }
  }
  return false;
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

  it("单行极长时按字符截，切点不会把 emoji 代理对劈成落单代理（d.412.4.197）", () => {
    // keep = floor(20/2) = 10；"a"×9 后紧跟 emoji，head 的 slice(0,10) 正落在代理对中间。
    const headText = "a".repeat(9) + "😀".repeat(30);
    const headOut = previewToolResult(headText, { minChars: 20 });
    expect(headOut.truncated).toBe(true);
    expect(hasLoneSurrogate(headOut.preview)).toBe(false);

    // "😀"×30 + "y"：tail 的 slice(-10) 从某个 emoji 的低位代理开始。
    const tailText = "😀".repeat(30) + "y";
    const tailOut = previewToolResult(tailText, { minChars: 20 });
    expect(tailOut.truncated).toBe(true);
    expect(hasLoneSurrogate(tailOut.preview)).toBe(false);
  });

  it("刚超过阈值一点点也要截（边界不留缝），且隐藏字数为正", () => {
    const text = `${"a".repeat(TOOL_RESULT_PREVIEW_MIN_CHARS)}\n尾行`;
    const out = previewToolResult(text);
    expect(out.truncated).toBe(true);
    expect(out.hiddenChars).toBeGreaterThan(0);
    expect(out.preview).toContain("尾行");
  });

  it("隐藏字数是被藏文字的真实字符数（换行按分隔计，不重复多算）", () => {
    // 4 行、头 1 尾 1：被藏的是 "b\nc"（3 字）。旧实现每行都 +1，报成 4。
    const out = previewToolResult("a\nb\nc\nd", { headLines: 1, tailLines: 1, minChars: 0 });
    expect(out.hiddenChars).toBe(3);
    expect(out.preview).toContain("中间还有 2 行 / 3 字未显示");

    // 3 行被藏："b\nc\nd" = 5 字。
    const five = previewToolResult("a\nb\nc\nd\ne", { headLines: 1, tailLines: 1, minChars: 0 });
    expect(five.hiddenChars).toBe(5);
  });

  it("可以通过参数控制头尾行数与阈值（界面/测试各自按需）", () => {
    const text = lines(30);
    const out = previewToolResult(text, { headLines: 2, tailLines: 2, minChars: 10 });
    expect(out.truncated).toBe(true);
    expect(out.preview.startsWith("line-1\nline-2\n")).toBe(true);
    expect(out.preview.trimEnd().endsWith("line-30")).toBe(true);
  });
});
