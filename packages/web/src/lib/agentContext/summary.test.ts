import { describe, expect, it } from "vitest";
import { buildSummaryPrompt, deterministicSummary } from "./summary.js";

/** 逐 UTF-16 单元扫描，找出未被合法代理对配对的落单代理。 */
function hasLoneSurrogate(text: string): boolean {
  const units = text.split("").map((ch) => ch.charCodeAt(0));
  return units.some((c, i) => {
    if (c >= 0xd800 && c <= 0xdbff) {
      return !(i + 1 < units.length && units[i + 1] >= 0xdc00 && units[i + 1] <= 0xdfff);
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      return !(i > 0 && units[i - 1] >= 0xd800 && units[i - 1] <= 0xdbff);
    }
    return false;
  });
}

describe("摘要提示词/确定性摘要的码点边界（d.412 回归）", () => {
  it("buildSummaryPrompt 尾部截断落在 emoji 中间时不留落单代理", () => {
    // 内容足够长使截断发生，且刻意让 emoji 正好骑在尾部切点上
    const rows = [
      { role: "user" as const, content: "X".repeat(200) + "😀" + "Y".repeat(50) },
      { role: "assistant" as const, content: "Z".repeat(200) },
    ];
    // 逐个 maxChars 扫一遍，总有一个切点落在代理对上；任何值都不该产生落单代理
    for (let maxChars = 8; maxChars <= 120; maxChars += 1) {
      const prompt = buildSummaryPrompt(rows, maxChars);
      const userText = prompt.map((m) => m.content ?? "").join("\n");
      expect(hasLoneSurrogate(userText), `maxChars=${maxChars}`).toBe(false);
    }
  });

  it("deterministicSummary 的用户意图截断落在 emoji 中间时不留落单代理", () => {
    // 意图取前 80 字，让 emoji 正好落在第 80 个码点附近
    for (let n = 76; n <= 82; n += 1) {
      const rows = [{ role: "user" as const, content: "A".repeat(n) + "😀" + "后续内容" }];
      const summary = deterministicSummary(rows);
      expect(hasLoneSurrogate(summary), `n=${n}`).toBe(false);
    }
  });

  it("完整 emoji 在预算内时仍原样出现（不误删合法内容）", () => {
    const rows = [{ role: "user" as const, content: "要点😀完整保留" }];
    const summary = deterministicSummary(rows);
    expect(summary).toContain("😀");
    expect(hasLoneSurrogate(summary)).toBe(false);
  });
});
