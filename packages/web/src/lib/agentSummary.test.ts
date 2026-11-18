import { describe, expect, it } from "vitest";
import { agentSummary } from "./agentSummary.js";

describe("agentSummary", () => {
  it("都没有待办时留空：没有事就不在顶上多一行字", () => {
    expect(agentSummary({ total: 4, dirty: 0, unset: 0 })).toBe("");
  });

  it("只报了没落盘的", () => {
    expect(agentSummary({ total: 4, dirty: 2, unset: 0 })).toBe("2 个工具改了还没写进去。");
  });

  it("只报了没配模型的", () => {
    expect(agentSummary({ total: 4, dirty: 0, unset: 1 })).toBe("1 个还没配模型。");
  });

  it("两类都有时一次说完，顺序是改了的在前", () => {
    expect(agentSummary({ total: 4, dirty: 2, unset: 3 })).toBe(
      "2 个工具改了还没写进去；3 个还没配模型。",
    );
  });
});
