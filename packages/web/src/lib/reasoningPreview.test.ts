import { describe, it, expect } from "vitest";
import {
  REASONING_PREVIEW_CHARS,
  REASONING_PREVIEW_LINES,
  describeReasoningClip,
  previewReasoning,
} from "./reasoningPreview.js";

describe("思考片段的大小控制（d.247）", () => {
  it("短文本原样返回，不误判成被截断", () => {
    const preview = previewReasoning("先看看这个文件");
    expect(preview.text).toBe("先看看这个文件");
    expect(preview.clipped).toBe(false);
    expect(preview.hiddenChars).toBe(0);
  });

  it("空文本返回空，不抛", () => {
    expect(previewReasoning("")).toEqual({ text: "", clipped: false, hiddenChars: 0, mode: "head" });
  });

  it("回看模式（head）留开头：超字数时截断并报出没显示的字数", () => {
    const text = "甲".repeat(REASONING_PREVIEW_CHARS + 50);
    const preview = previewReasoning(text, { mode: "head", lines: 999 });
    expect(preview.clipped).toBe(true);
    expect(preview.hiddenChars).toBe(50);
    expect(preview.text).toBe("甲".repeat(REASONING_PREVIEW_CHARS));
  });

  it("流式模式（tail）留尾巴：用户要看的是它现在想到哪", () => {
    const text = "前".repeat(10) + "后".repeat(REASONING_PREVIEW_CHARS + 20);
    const preview = previewReasoning(text, { mode: "tail", lines: 999 });
    expect(preview.clipped).toBe(true);
    expect(preview.text.startsWith("后")).toBe(true);
    expect(preview.text).not.toContain("前");
    expect(preview.hiddenChars).toBe(30);
  });

  it("行数比字数更严格时按行截（长段落与多短行都要能压住）", () => {
    const many = Array.from({ length: 40 }, (_, i) => `第 ${i} 行`).join("\n");
    const preview = previewReasoning(many, { mode: "head", lines: 5 });
    expect(preview.clipped).toBe(true);
    expect(preview.text.split("\n")).toHaveLength(5);
    expect(preview.text).not.toContain("第 5 行");
  });

  it("两种截法取更短的那个：不会因为字数够而留下一篇长文", () => {
    // 300 字但全是短行：字数上限没到，行数上限先到 → 结果按行截。
    const text = Array.from({ length: 30 }, () => "短").join("\n");
    const preview = previewReasoning(text, { lines: REASONING_PREVIEW_LINES, chars: 10_000 });
    expect(preview.clipped).toBe(true);
    expect(preview.text.split("\n")).toHaveLength(REASONING_PREVIEW_LINES);
  });

  it("刚好等于上限时不截断（边界不多显示一个省略号）", () => {
    const exactChars = "字".repeat(REASONING_PREVIEW_CHARS);
    expect(previewReasoning(exactChars, { lines: 999 }).clipped).toBe(false);
    const exactLines = Array.from({ length: REASONING_PREVIEW_LINES }, (_, i) => `${i}`).join("\n");
    expect(previewReasoning(exactLines, { chars: 10_000 }).clipped).toBe(false);
  });

  it("从末尾截时不把 emoji 切一半（代理对不能被劈开）", () => {
    const text = "甲".repeat(10) + "🙂".repeat(REASONING_PREVIEW_CHARS);
    const preview = previewReasoning(text, { mode: "tail", lines: 999 });
    // 首字符不能是孤立的高代理（U+D800–U+DBFF）
    const first = preview.text.charCodeAt(0);
    expect(first >= 0xd800 && first <= 0xdbff).toBe(false);
    expect(preview.text.includes("\uFFFD")).toBe(false);
  });

  it("没显示的字数按方向说清是「前面」还是「后面」", () => {
    const text = "字".repeat(REASONING_PREVIEW_CHARS + 7);
    expect(describeReasoningClip(previewReasoning(text, { mode: "head", lines: 999 }))).toBe(
      "后面还有 7 字没显示",
    );
    expect(describeReasoningClip(previewReasoning(text, { mode: "tail", lines: 999 }))).toBe(
      "前面还有 7 字没显示",
    );
    expect(describeReasoningClip(previewReasoning("短", { lines: 999 }))).toBe("");
  });
});
