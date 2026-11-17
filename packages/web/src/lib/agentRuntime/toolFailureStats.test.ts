import { beforeEach, describe, expect, it } from "vitest";
import {
  DENIED_CODE,
  MAX_FAILURE_CODES,
  clearToolFailureStats,
  getToolFailureStats,
  recordToolFailure,
  resetToolFailureStats,
} from "./toolFailureStats.js";

const fail = (code: string) => `写入失败（${code}）：说明`;

beforeEach(() => {
  resetToolFailureStats();
});

describe("工具失败归因（d.221）", () => {
  it("没失败过就没有统计（不写「0 次」占一行）", () => {
    expect(getToolFailureStats("c1")).toBeNull();
    expect(getToolFailureStats("")).toBeNull();
  });

  it("按错误码计数，从多到少；同次数按首次出现顺序", () => {
    recordToolFailure("c1", { tool: "file_write", result: fail("path-escape") });
    recordToolFailure("c1", { tool: "file_write", result: fail("match-failed") });
    recordToolFailure("c1", { tool: "file_write", result: fail("path-escape") });
    const stats = getToolFailureStats("c1");
    expect(stats?.total).toBe(3);
    expect(stats?.codes).toEqual([
      { code: "path-escape", count: 2 },
      { code: "match-failed", count: 1 },
    ]);
    expect(stats?.tools).toEqual([{ code: "file_write", count: 3 }]);
    expect(stats?.dropped).toBe(0);
  });

  it("被用户拒绝单独记 denied，不算工具失败", () => {
    recordToolFailure("c1", { tool: "run_command", denied: true });
    recordToolFailure("c1", { tool: "file_write", result: fail("no-roots") });
    const stats = getToolFailureStats("c1");
    expect(stats?.total).toBe(2);
    expect(stats?.codes).toContainEqual({ code: DENIED_CODE, count: 1 });
    expect(stats?.codes).toContainEqual({ code: "no-roots", count: 1 });
  });

  it("拿不到错误码记 unknown，不猜也不丢", () => {
    recordToolFailure("c1", { tool: "file_read", result: "读取失败：没有这段" });
    expect(getToolFailureStats("c1")?.codes).toEqual([{ code: "unknown", count: 1 }]);
  });

  it("结构化 errorCode 优先于文本解析（appendFailure 的文本里没有 `（code）`）", () => {
    recordToolFailure("c1", {
      tool: "file_read",
      result: "没有这个文件\n可重试：换个路径",
      errorCode: "not-found",
    });
    expect(getToolFailureStats("c1")?.codes).toEqual([{ code: "not-found", count: 1 }]);
  });

  it("按会话隔离；清一个不影响另一个", () => {
    recordToolFailure("c1", { tool: "a", result: fail("path-escape") });
    recordToolFailure("c2", { tool: "b", result: fail("no-roots") });
    clearToolFailureStats("c1");
    expect(getToolFailureStats("c1")).toBeNull();
    expect(getToolFailureStats("c2")?.total).toBe(1);
    clearToolFailureStats();
    expect(getToolFailureStats("c2")).toBeNull();
  });

  it("错误码种类到上限后只记次数，并在 dropped 里如实标出", () => {
    for (let i = 0; i < MAX_FAILURE_CODES; i += 1) {
      recordToolFailure("c1", { tool: "t", result: fail(`code-${i}`) });
    }
    expect(getToolFailureStats("c1")?.codes).toHaveLength(MAX_FAILURE_CODES);
    recordToolFailure("c1", { tool: "t", result: fail("code-extra") });
    const stats = getToolFailureStats("c1");
    expect(stats?.total).toBe(MAX_FAILURE_CODES + 1);
    expect(stats?.codes).toHaveLength(MAX_FAILURE_CODES);
    expect(stats?.dropped).toBe(1);
    expect(stats?.codes.some((item) => item.code === "code-extra")).toBe(false);
  });

  it("工具名缺失记 unknown 工具，不崩", () => {
    recordToolFailure("c1", { tool: "", result: fail("boom-code") });
    expect(getToolFailureStats("c1")?.tools).toEqual([{ code: "unknown", count: 1 }]);
  });

  it("空会话 id 不入账", () => {
    recordToolFailure("", { tool: "t", result: fail("path-escape") });
    expect(getToolFailureStats("")).toBeNull();
  });
});
