import { describe, expect, it } from "vitest";
import { appendFailure, contractLines, failureResult, type ToolFailure } from "./toolError.js";

/**
 * P2-T9 的契约测试：字段怎么变成文案、什么情况下**不**给「可重试」。
 *
 * 重点不是措辞漂亮，而是两个会直接影响模型行为的性质：
 * 1. 不可重试的失败（越界/拒绝）绝不能出现「可重试」行，否则模型会原样再撞一次；
 * 2. 结构化字段与文本必须一致，否则归因（T16）统计的 code 和模型看到的建议会对不上。
 */

describe("toolError · 契约行", () => {
  it("都有就给两行，顺序固定「可重试」在「提示」之前", () => {
    const failure: ToolFailure = { error_code: "x", retry_with: "改成根内相对路径", hint: "路径越界" };
    expect(contractLines(failure)).toEqual(["可重试：改成根内相对路径", "提示：路径越界"]);
  });

  it("只有 hint：不出现「可重试」行（模型不该重试）", () => {
    expect(contractLines({ error_code: "root-readonly", hint: "只读根" })).toEqual(["提示：只读根"]);
  });

  it("都没有：一行都不加（不制造空标题）", () => {
    expect(contractLines({ error_code: "x" })).toEqual([]);
  });
});

describe("toolError · failureResult", () => {
  it("首行保持「标题（code）：说明」，旧开头断言不破", () => {
    const result = failureResult("锚点匹配失败", "第 2 行对不上", {
      error_code: "match-failed",
      retry_with: "先 file_read 再重写锚点",
    });
    expect(result.ok).toBe(false);
    expect(result.error.error_code).toBe("match-failed");
    expect(result.text.split("\n")[0]).toBe("锚点匹配失败（match-failed）：第 2 行对不上");
    expect(result.text).toContain("可重试：先 file_read 再重写锚点");
  });

  it("无契约字段时只有一行，不追加空行", () => {
    const result = failureResult("写入被拒绝", "原因", { error_code: "safety-reject" });
    expect(result.text).toBe("写入被拒绝（safety-reject）：原因");
  });
});

describe("toolError · appendFailure", () => {
  it("保留既有文案原文，补充说明排在契约行之前", () => {
    const result = appendFailure("整份补丁未写入任何文件。", { error_code: "io", retry_with: "重试一次" }, [
      "文件不存在。",
    ]);
    expect(result.text.split("\n")).toEqual([
      "整份补丁未写入任何文件。",
      "文件不存在。",
      "可重试：重试一次",
    ]);
  });

  it("既无补充也无契约：文本原样返回，不多个换行", () => {
    const result = appendFailure("读失败", { error_code: "io" });
    expect(result.text).toBe("读失败");
    expect(result.error.error_code).toBe("io");
  });
});
