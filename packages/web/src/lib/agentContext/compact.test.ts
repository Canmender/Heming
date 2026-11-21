import { beforeEach, describe, it, expect, vi } from "vitest";
import type { ChatMessage } from "../llmClient.js";
import type { StorageLike } from "../memory/types.js";
import { compactNow, countFoldedMessages, prepareHistory } from "./history.js";
import { SUMMARY_HEADER } from "./summary.js";
import { DEFAULT_CONTEXT_SETTINGS } from "./settings.js";
import { SummaryCache } from "./store.js";
import { clearManualSummaries } from "./manualCompact.js";

/**
 * 手动压缩（d.183）：`/compact` 走 `force` 分支——即使历史本来放得下也折叠，
 * 让「我现在就想让它轻一点」变成可执行动作；统计返回给界面显示省了多少。
 */

function msg(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content };
}

/** n 轮对话：每轮 user + assistant。 */
function conversation(turns: number, pad = ""): ChatMessage[] {
  const rows: ChatMessage[] = [];
  for (let i = 1; i <= turns; i += 1) {
    const tag = String(i).padStart(2, "0");
    rows.push(msg("user", `第 ${tag} 轮的问题${pad}`));
    rows.push(msg("assistant", `第 ${tag} 轮的回答${pad}`));
  }
  return rows;
}

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe("compactNow：手动压缩（d.183）", () => {
  // 手动摘要是「一次性」的，落在共享 storage 里会串到下一个用例。
  beforeEach(() => {
    clearManualSummaries();
  });

  it("历史本来放得下也会折叠：只留最后一轮原文，其余进摘要", async () => {
    const rows = conversation(6, "……".repeat(200)); // 内容足够长，压缩才真的省
    const result = await compactNow(rows, {
      settings: { ...DEFAULT_CONTEXT_SETTINGS, budgetTokens: 100_000, keepRecentTurns: 20 },
    });

    expect(result.compacted).toBe(true);
    expect(result.messages[0].role).toBe("system");
    expect(String(result.messages[0].content).startsWith(SUMMARY_HEADER)).toBe(true);
    // 最后一轮（user + assistant）原样保留
    expect(result.messages.slice(1)).toEqual(rows.slice(-2));
    // 折叠统计：8 条里只有 2 条留在原文
    expect(result.foldedCount).toBe(10);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
  });

  it("历史太短时压了不划算：如实回 compacted=false，不发摘要替换原文", async () => {
    const rows = conversation(1); // 两条短消息，摘要比原文还长
    const result = await compactNow(rows, { settings: DEFAULT_CONTEXT_SETTINGS });

    expect(result.compacted).toBe(false);
    expect(result.foldedCount).toBe(0);
    expect(result.summary).toBe("");
    expect(result.messages).toEqual(rows);
    expect(result.afterTokens).toBe(result.beforeTokens);
  });

  it("空历史不炸、不产生空摘要消息", async () => {
    const result = await compactNow([], { settings: DEFAULT_CONTEXT_SETTINGS });
    expect(result.messages).toEqual([]);
    expect(result.compacted).toBe(false);
  });

  it("给了 summarize 就用 LLM 摘要，且写进缓存供下一轮直接命中", async () => {
    const rows = conversation(4, "……".repeat(150));
    const cache = new SummaryCache(memoryStorage());
    let calls = 0;
    const result = await compactNow(rows, {
      settings: DEFAULT_CONTEXT_SETTINGS,
      cache,
      conversationId: "c1",
      summarize: async (messages) => {
        calls += 1;
        expect(messages[0].role).toBe("system");
        return "意图：让我压缩；结论：已压缩；待办：（未提及）";
      },
    });

    expect(calls).toBe(1);
    expect(result.summary).toContain("已压缩");

    // 同样的历史再压一次：缓存命中，不再请求模型（只发一次摘要请求是这条的关键）
    calls = 0;
    const again = await compactNow(rows, {
      settings: DEFAULT_CONTEXT_SETTINGS,
      cache,
      conversationId: "c1",
      summarize: async () => {
        calls += 1;
        return "不应被调用";
      },
    });
    expect(calls).toBe(0);
    expect(again.summary).toBe(result.summary);
  });

  it("摘要是模型给的空串时回落到确定性摘要，而不是丢掉摘要", async () => {
    const rows = conversation(4, "……".repeat(150));
    const result = await compactNow(rows, {
      settings: DEFAULT_CONTEXT_SETTINGS,
      summarize: async () => "   ",
    });

    expect(result.compacted).toBe(true);
    expect(result.summary).toContain(SUMMARY_HEADER);
    expect(result.summary).toContain("意图：");
  });

  it("摘要不比折掉的内容短时不采用它，回落确定性摘要（d.412 回归）", async () => {
    const rows = conversation(4, "……".repeat(150));
    // 模型没守住「≤200 字」，回吐一段比被折内容还长的「摘要」
    const verbose = "啰嗦摘要".repeat(2000);
    const result = await compactNow(rows, {
      settings: DEFAULT_CONTEXT_SETTINGS,
      summarize: async () => verbose,
    });

    // 摘要被拒：用的是确定性摘要，不含那段啰嗦文本
    expect(result.summary).not.toContain("啰嗦摘要");
    expect(result.summary).toContain("意图：");
    // 压完确实变短，没把请求撑大
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
  });

  it("缓存分桶按会话隔离：别的会话不会命中这条摘要", async () => {
    const rows = conversation(4, "……".repeat(150));
    const cache = new SummaryCache(memoryStorage());
    const first = await compactNow(rows, {
      settings: DEFAULT_CONTEXT_SETTINGS,
      cache,
      conversationId: "c1",
      summarize: async () => "意图：A；结论：A；待办：A",
    });
    let calls = 0;
    const other = await compactNow(rows, {
      settings: DEFAULT_CONTEXT_SETTINGS,
      cache,
      conversationId: "c2",
      summarize: async () => {
        calls += 1;
        return "意图：B；结论：B；待办：B";
      },
    });
    expect(calls).toBe(1);
    expect(other.summary).toContain("B");
    expect(first.summary).toContain("A");
  });

  it("摘要供应商抛错时留一条可观测告警，同时照常回落确定性摘要（d.412 回归）", async () => {
    const rows = conversation(4, "……".repeat(150));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await compactNow(rows, {
        settings: DEFAULT_CONTEXT_SETTINGS,
        summarize: async () => {
          throw new Error("provider down");
        },
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("LLM 摘要失败"),
        expect.any(Error),
      );
      // 不阻断：仍产出确定性摘要
      expect(result.compacted).toBe(true);
      expect(result.summary).toContain("意图：");
    } finally {
      warn.mockRestore();
    }
  });

  it("不 force 的 prepareHistory 不会折：手动压缩不能改变自动压缩的口径", async () => {
    const rows = conversation(2);
    const auto = await prepareHistory(rows, {
      settings: { ...DEFAULT_CONTEXT_SETTINGS, budgetTokens: 100_000, keepRecentTurns: 20 },
    });
    expect(auto).toEqual(rows);
  });
});

describe("折叠条数的判据（d.217）", () => {
  const rows = conversation(20);

  it("头是摘要骨架时，按「原始条数 - (返回条数 - 1)」算折叠条数", async () => {
    const compacted = await compactNow(rows, {
      settings: { ...DEFAULT_CONTEXT_SETTINGS, budgetTokens: 100_000, keepRecentTurns: 2 },
    });
    expect(compacted.compacted).toBe(true);
    expect(countFoldedMessages(rows, compacted.messages)).toBe(compacted.foldedCount);
  });

  it("没折（历史原样返回）时是 0，不编数字", async () => {
    const auto = await prepareHistory(rows, {
      settings: { ...DEFAULT_CONTEXT_SETTINGS, budgetTokens: 100_000, keepRecentTurns: 20 },
    });
    expect(countFoldedMessages(rows, auto)).toBe(0);
  });

  it("头不是摘要（普通 system 或空列表）时也是 0", () => {
    expect(countFoldedMessages(rows, [{ role: "system", content: "普通系统提示词" }, ...rows])).toBe(0);
    expect(countFoldedMessages(rows, [])).toBe(0);
    expect(countFoldedMessages(rows, [{ role: "system", content: SUMMARY_HEADER }])).toBe(rows.length);
  });
});
