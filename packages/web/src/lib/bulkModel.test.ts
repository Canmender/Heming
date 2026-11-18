import { describe, expect, it } from "vitest";

import { bulkModelTargets, bulkModelText } from "./bulkModel.js";

describe("bulkModelTargets", () => {
  it("只挑能被改写的工具，只读的不算进名单", () => {
    const agents = [
      { name: "Claude Code", id: "claude" },
      { name: "某个只读的", id: null },
      { name: "Codex", id: "codex" },
    ];
    expect(bulkModelTargets(agents).map((agent) => agent.name)).toEqual(["Claude Code", "Codex"]);
  });

  it("空列表还是空列表", () => {
    expect(bulkModelTargets([])).toEqual([]);
  });
});

describe("bulkModelText", () => {
  it("全都成功时说清楚设成了什么、什么时候生效", () => {
    expect(bulkModelText("deepseek/deepseek-chat", { done: ["Claude Code", "Codex"], failed: [] })).toEqual({
      text: "已把 2 个工具都设成 deepseek/deepseek-chat，下次启动它们时生效。",
      failed: false,
    });
  });

  it("部分没成时先报成功的数，再点名并带上内核的原话", () => {
    expect(
      bulkModelText("openai/gpt-4o", {
        done: ["Claude Code"],
        failed: [{ name: "Codex", why: "no such agent" }],
      }),
    ).toEqual({ text: "1 个设好了，1 个没成（Codex）：no such agent", failed: true });
  });

  it("一个都没成时直接说没写进去", () => {
    expect(
      bulkModelText("openai/gpt-4o", { done: [], failed: [{ name: "Codex", why: "文件读不了" }] }),
    ).toEqual({ text: "没能写入 Codex：文件读不了", failed: true });
  });

  it("内核什么都没说时不硬凑原因", () => {
    expect(bulkModelText("openai/gpt-4o", { done: [], failed: [{ name: "Codex", why: "" }] })).toEqual({
      text: "没能写入 Codex",
      failed: true,
    });
  });
});