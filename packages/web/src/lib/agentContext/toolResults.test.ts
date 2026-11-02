import { describe, expect, it } from "vitest";
import {
  KEEP_RECENT_TOOL_RESULTS,
  MAX_TOOL_CONTEXT_TOKENS,
  foldToolResults,
} from "./toolResults.js";
import type { ChatMessage } from "./types.js";

/** 造一条工具结果消息（内容长度按字符数控制，CJK 近似 1 token/字）。 */
function toolRow(chars: number, id = "c1"): ChatMessage {
  return { role: "tool", tool_call_id: id, name: "srv__x", content: "字".repeat(chars) };
}

describe("foldToolResults", () => {
  it("未超预算时原样返回同一引用（什么都没发生）", () => {
    const rows = [toolRow(100, "a"), toolRow(100, "b")];
    const result = foldToolResults(rows);
    expect(result.folded).toBe(0);
    expect(result.rows).toBe(rows);
    expect(result.beforeTokens).toBe(result.afterTokens);
  });

  it("超预算时从最旧的开始折叠，最近 N 条保持原样", () => {
    // 4 条各 2000 token，预算 3000：只能折到够，最近 3 条不许动
    const rows = [1, 2, 3, 4].map((i) => toolRow(2000, `c${i}`));
    const result = foldToolResults(rows, { budgetTokens: 3000, keepRecent: 3 });

    expect(result.folded).toBe(1);
    expect(String(result.rows[0]?.content)).toContain("已折叠");
    // 消息条数不变：删消息会让 tool_call 对不上，供应商直接 400
    expect(result.rows).toHaveLength(4);
    for (const i of [1, 2, 3]) {
      expect(result.rows[i]?.content).toBe(rows[i]?.content);
    }
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
  });

  it("用户/助手消息绝不折叠（它们是语义，不是数据）", () => {
    const rows: ChatMessage[] = [
      { role: "user", content: "字".repeat(2000) },
      { role: "assistant", content: "字".repeat(2000) },
      toolRow(2000, "a"),
      toolRow(2000, "b"),
    ];
    const result = foldToolResults(rows, { budgetTokens: 100, keepRecent: 0 });
    expect(result.rows[0]).toEqual(rows[0]);
    expect(result.rows[1]).toEqual(rows[1]);
    expect(String(result.rows[2]?.content)).toContain("已折叠");
  });

  it("折叠标记里带原字符数（模型据此判断要不要重查）", () => {
    const rows = [toolRow(5000, "a"), toolRow(10, "b")];
    const result = foldToolResults(rows, { budgetTokens: 10, keepRecent: 0 });
    expect(String(result.rows[0]?.content)).toContain("5000");
  });

  it("条数不足 keepRecent 时一条都不折（宁可超，也不折掉还在用的那条）", () => {
    const rows = [toolRow(9000, "a")];
    const result = foldToolResults(rows, { budgetTokens: 10, keepRecent: KEEP_RECENT_TOOL_RESULTS });
    expect(result.folded).toBe(0);
    expect(result.rows).toBe(rows);
  });

  it("默认预算与保留条数是公开常量（界面/文档可引用同一口径）", () => {
    expect(MAX_TOOL_CONTEXT_TOKENS).toBeGreaterThan(0);
    expect(KEEP_RECENT_TOOL_RESULTS).toBe(3);
  });
});
