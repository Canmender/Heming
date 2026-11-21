import { describe, expect, it } from "vitest";
import {
  KEEP_RECENT_SAME_TOOL,
  KEEP_RECENT_TOOL_RESULTS,
  MAX_TOOL_CONTEXT_TOKENS,
  foldToolResults,
  summarizeToolResult,
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

  it("用户贴长文档不触发折叠（预算只算工具输出，不拿对话文本充数）", () => {
    const rows: ChatMessage[] = [
      { role: "user", content: "字".repeat(50_000) },
      { role: "assistant", content: "字".repeat(10_000) },
      toolRow(100, "a"),
    ];
    const result = foldToolResults(rows, { budgetTokens: MAX_TOOL_CONTEXT_TOKENS });
    expect(result.folded).toBe(0);
    expect(result.rows).toBe(rows);
  });
});

/** 造一条带工具名与首行的工具结果（真实工具结果的首行通常是路径/标题）。 */
function namedToolRow(name: string, id: string, body: string): ChatMessage {
  return { role: "tool", tool_call_id: id, name, content: body };
}

describe("foldToolResults · 同名工具合并（P2-T10）", () => {
  it("同一工具多次调用：最近一条保留全文，更早的压成单行摘要", () => {
    const rows = [1, 2, 3].map((i) =>
      namedToolRow("file_read", `c${i}`, `路径：notes/f${i}.md\n${"正文".repeat(600)}`),
    );
    const result = foldToolResults(rows, { budgetTokens: 10_000, keepRecent: 0 });

    expect(result.merged).toBe(2);
    // 最近一条原文不动
    expect(result.rows[2]?.content).toBe(rows[2]?.content);
    // 更早的只剩一行摘要，且能认出是哪个文件
    expect(String(result.rows[0]?.content)).toContain("已折叠为单行摘要");
    expect(String(result.rows[0]?.content)).toContain("notes/f1.md");
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
  });

  it("不同工具互不影响（file_read 与 file_patch 各留全文）", () => {
    const rows = [
      namedToolRow("file_read", "a", `路径：a.md\n${"正文".repeat(600)}`),
      namedToolRow("file_patch", "b", `已写入 1 个文件\n${"清单".repeat(600)}`),
    ];
    const result = foldToolResults(rows, { budgetTokens: 10_000, keepRecent: 0 });
    expect(result.merged).toBe(0);
    expect(result.rows).toBe(rows);
  });

  it("最近 keepRecent 条内不合并（模型往往还在用它们）", () => {
    const rows = [1, 2].map((i) => namedToolRow("file_read", `c${i}`, `路径：f${i}.md\n${"正文".repeat(600)}`));
    const result = foldToolResults(rows, { budgetTokens: 10_000, keepRecent: 2 });
    expect(result.merged).toBe(0);
    expect(result.rows).toBe(rows);
  });

  it("带图片说明的结果不压（那几行是「模型看不到图」的唯一解释）", () => {
    const rows = [
      namedToolRow("file_read", "a", `路径：a.png\n（本次返回了 2 张图片，但当前模型不支持读图，已省略）`),
      namedToolRow("file_read", "b", `路径：b.png\n（本次返回了 2 张图片，但当前模型不支持读图，已省略）`),
    ];
    const result = foldToolResults(rows, { budgetTokens: 10_000, keepRecent: 0 });
    expect(result.merged).toBe(0);
  });

  it("摘要保留首行与原文长度（模型据此判断要不要重查）", () => {
    const summary = summarizeToolResult(namedToolRow("file_read", "a", "路径：x.md\n正文"));
    expect(summary).toContain("file_read");
    expect(summary).toContain("路径：x.md");
    expect(summary).toContain("字符");
    expect(summary.length).toBeLessThan(200);
  });

  it("摘要首行截断按码点切，不在 emoji 代理对中间劈出落单代理", () => {
    const emoji = "\u{1F600}";
    // emoji 恰好骑在第 80 个码点的截断边界上。
    const firstLine = "A".repeat(79) + emoji + "tail";
    const summary = summarizeToolResult(namedToolRow("file_read", "a", firstLine + "\n正文"));
    // 移除合法代理对后，剩下的字符串里不该还有任何落单代理。
    const withoutPairs = summary.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "");
    expect(/[\uD800-\uDFFF]/.test(withoutPairs)).toBe(false);
    expect(summary).toContain(emoji);
  });

  it("默认只留最近 1 条同名工具全文（公开常量）", () => {
    expect(KEEP_RECENT_SAME_TOOL).toBe(1);
  });

  it("典型长会话（同一文件读 5 次）至少省下 60% 工具结果 token", () => {
    const body = `路径：notes/长文.md\n${"这是一段比较长的正文。".repeat(1200)}`;
    const rows = [1, 2, 3, 4, 5].map((i) => namedToolRow("file_read", `c${i}`, body));
    const result = foldToolResults(rows, { budgetTokens: 1_000_000, keepRecent: 0 });
    const saved = 1 - result.afterTokens / result.beforeTokens;
    expect(result.merged).toBe(4);
    expect(saved).toBeGreaterThanOrEqual(0.6);
  });
});
