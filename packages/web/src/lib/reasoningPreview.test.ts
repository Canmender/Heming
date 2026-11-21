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
    // 边界若落在完整 emoji 上，首字符就是它的高代理——只要紧跟低代理就是完整的一对，
    // 不是「孤立高代理」。真正坏掉的情况有两种：首字符是落单的低代理，或首字符是高代理
    // 但下一个不是低代理。旧的断言「首字符不能是高代理」恰恰是在给错误实现（把完整对劈开、
    // 只留下低代理）打掩护，这里改成检查正确的不变量：边界处没有落单的半个代理对。
    const first = preview.text.charCodeAt(0);
    const second = preview.text.charCodeAt(1);
    const orphanedHigh = first >= 0xd800 && first <= 0xdbff && !(second >= 0xdc00 && second <= 0xdfff);
    const orphanedLow = first >= 0xdc00 && first <= 0xdfff;
    expect(orphanedHigh || orphanedLow).toBe(false);
    expect(preview.text.includes("\uFFFD")).toBe(false);
  });

  it("尾截的代理对边界不劈 emoji：落点是低代理丢弃、是高代理保留整对", () => {
    const smile = "\u{1F642}";
    // 边界正好落在 emoji 的高代理上（落点索引 = 完整 emoji 的起点）：必须保留整对，
    // 旧实现在这里 start += 1，把本来完整的一对劈成「低代理 + 尾文」。
    const high = "abcd" + smile + "ef";
    const tail = previewReasoning(high, { mode: "tail", chars: 4, lines: 999 });
    expect(tail.text).toBe(smile + "ef");
    expect(tail.text.includes(smile)).toBe(true);

    // 边界正好落在 emoji 的低代理上（高代理被留在被裁掉的前缀里）：
    // 落单的低代理必须丢弃，否则前面会挂一个坏字符。
    const low = "a" + smile + "bc";
    const tail2 = previewReasoning(low, { mode: "tail", chars: 3, lines: 999 });
    expect(tail2.text).toBe("bc");
    for (const ch of [...tail2.text]) {
      const cp = ch.codePointAt(0)!;
      expect(cp >= 0xdc00 && cp <= 0xdfff).toBe(false);
    }
  });

  it("头截时不在 emoji 中间切开：结尾是高代理就退回一格", () => {
    const smile = "\u{1F642}";
    const text = "a" + smile + "bc";
    const head = previewReasoning(text, { mode: "head", chars: 2, lines: 999 });
    expect(head.text).toBe("a");
    const last = head.text.charCodeAt(head.text.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
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
