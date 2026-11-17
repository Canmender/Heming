import { describe, expect, it } from "vitest";

import { ARG_DIFF_MAX_ROWS, argDiff, formatArgDiffStat } from "./argDiff.js";

function args(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

describe("参数级内联对照（d.239）", () => {
  it("file_write：整份写入全部算新增，行号从 1 开始", () => {
    const diff = argDiff("file_write", args({ path: "a.md", content: "一\n二\n三\n" }));
    expect(diff).not.toBeNull();
    expect(diff!.added).toBe(3);
    expect(diff!.removed).toBe(0);
    expect(diff!.truncated).toBe(false);
    expect(diff!.rows.map((row) => row.kind)).toEqual(["add", "add", "add"]);
    expect(diff!.rows.map((row) => (row.kind === "add" ? row.newNo : 0))).toEqual([1, 2, 3]);
    expect(formatArgDiffStat(diff!)).toBe("新增 3 行");
  });

  it("file_write：CRLF 与末尾换行不会多算一行", () => {
    const diff = argDiff("file_write", args({ path: "a.md", content: "一\r\n二\r\n" }));
    expect(diff!.added).toBe(2);
    expect(diff!.rows.map((row) => row.text)).toEqual(["一", "二"]);
  });

  it("file_write：超过显示上限时如实标记截断，但统计按全文算", () => {
    const content = Array.from({ length: ARG_DIFF_MAX_ROWS + 5 }, (_, i) => `第 ${i + 1} 行`).join("\n");
    const diff = argDiff("file_write", args({ path: "a.md", content }));
    expect(diff!.rows).toHaveLength(ARG_DIFF_MAX_ROWS);
    expect(diff!.added).toBe(ARG_DIFF_MAX_ROWS + 5);
    expect(diff!.truncated).toBe(true);
  });

  it("file_edit：old_string → new_string 走 LCS，增删各自计数", () => {
    const diff = argDiff(
      "file_edit",
      args({ path: "a.ts", old_string: "const a = 1;\nconst b = 2;", new_string: "const a = 1;\nconst b = 3;" }),
    );
    expect(diff).not.toBeNull();
    expect(diff!.added).toBe(1);
    expect(diff!.removed).toBe(1);
    const kinds = diff!.rows.map((row) => row.kind);
    expect(kinds).toContain("del");
    expect(kinds).toContain("add");
    expect(formatArgDiffStat(diff!)).toBe("新增 1 行 / 删除 1 行");
  });

  it("file_edit：原文与结果一致时不出对照（没有变化就不画）", () => {
    expect(argDiff("file_edit", args({ old_string: "同一段", new_string: "同一段" }))).toBeNull();
  });

  it("别的工具不猜：run_command / file_read 都返回 null", () => {
    expect(argDiff("run_command", args({ command: "pnpm test" }))).toBeNull();
    expect(argDiff("file_read", args({ path: "a.ts" }))).toBeNull();
  });

  it("file_patch：按补丁文法画上下文/删/增，文件头当上下文", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "*** End Patch",
    ].join("\n");
    const diff = argDiff("file_patch", args({ patch }));
    expect(diff).not.toBeNull();
    expect(diff!.added).toBe(1);
    expect(diff!.removed).toBe(1);
    const texts = diff!.rows.map((row) => `${row.kind}:${row.text}`);
    expect(texts).toContain("same:*** Update File: a.ts");
    expect(texts).toContain("del:const b = 2;");
    expect(texts).toContain("add:const b = 3;");
    // Begin/End Patch 这两行是信封，不该出现在对照里
    expect(diff!.rows.some((row) => row.text.includes("Begin Patch"))).toBe(false);
  });

  it("file_patch：新建文件全部算新增", () => {
    const patch = ["*** Begin Patch", "*** Add File: 新.md", "+第一行", "+第二行", "*** End Patch"].join("\n");
    const diff = argDiff("file_patch", args({ patch }));
    expect(diff!.added).toBe(2);
    expect(diff!.removed).toBe(0);
  });

  it("file_patch：只有上下文没有增删时不出对照", () => {
    const patch = ["*** Begin Patch", "*** Update File: a.ts", " 只有上下文", "*** End Patch"].join("\n");
    expect(argDiff("file_patch", args({ patch }))).toBeNull();
  });

  it("参数不合规（非法 JSON、缺字段、空内容）时返回 null，不抛错", () => {
    expect(argDiff("file_write", "{不是 JSON")).toBeNull();
    expect(argDiff("file_write", args({ path: "a.md" }))).toBeNull();
    expect(argDiff("file_write", args({ content: "" }))).toBeNull();
    expect(argDiff("file_edit", args({ old_string: "只给一半" }))).toBeNull();
    expect(argDiff("file_write", undefined)).toBeNull();
    expect(argDiff("file_write", null)).toBeNull();
  });

  it("formatArgDiffStat：只有删除时不画蛇添足写「新增 0 行」", () => {
    const diff = argDiff(
      "file_edit",
      args({ old_string: "一\n二", new_string: "一" }),
    );
    expect(formatArgDiffStat(diff!)).toBe("删除 1 行");
  });
});
