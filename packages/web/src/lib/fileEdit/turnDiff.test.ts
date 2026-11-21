import { describe, expect, it } from "vitest";
import { DIFF_MAX_ROWS, diffLines, formatDiffStat, type DiffRow } from "./turnDiff.js";

const kinds = (rows: DiffRow[]): string[] => rows.map((row) => row.kind);

describe("行级 diff（d.207.4.110）", () => {
  it("内容完全一致：没有行、没有增删，摘要如实说没变化", () => {
    const result = diffLines("a\nb\nc\n", "a\r\nb\r\nc\r\n");
    expect(result.identical).toBe(true);
    expect(result.rows).toEqual([]);
    expect(formatDiffStat(result)).toBe("内容没有变化");
  });

  it("改一行：同位置一删一增，上下文保留，统计对得上", () => {
    const result = diffLines("a\nb\nc\n", "a\nB\nc\n");
    expect(result.identical).toBe(false);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(formatDiffStat(result)).toBe("新增 1 行 · 删除 1 行");
    expect(kinds(result.rows)).toEqual(["same", "del", "add", "same"]);
    expect(result.rows[1]).toMatchObject({ kind: "del", text: "b", oldNo: 2 });
    expect(result.rows[2]).toMatchObject({ kind: "add", text: "B", newNo: 2 });
    // same 行两套行号都要有，界面据此显示「第几行」
    expect(result.rows[0]).toMatchObject({ kind: "same", text: "a", oldNo: 1, newNo: 1 });
    expect(result.rows[3]).toMatchObject({ kind: "same", text: "c", oldNo: 3, newNo: 3 });
  });

  it("末尾追加与中间插入只出现 add，不把后文误判成改动", () => {
    const appended = diffLines("a\nb\n", "a\nb\nc\n");
    expect(kinds(appended.rows)).toEqual(["same", "same", "add"]);
    expect(appended.rows[2]).toMatchObject({ kind: "add", text: "c", newNo: 3 });

    const inserted = diffLines("a\nc\n", "a\nb\nc\n");
    expect(inserted.added).toBe(1);
    expect(inserted.removed).toBe(0);
    expect(inserted.rows.filter((row) => row.kind === "same")).toHaveLength(2);
  });

  it("新建文件（改动前为空）全是新增；清空文件全是删除", () => {
    const created = diffLines("", "x\ny\n");
    expect(created.added).toBe(2);
    expect(created.removed).toBe(0);
    expect(kinds(created.rows)).toEqual(["add", "add"]);

    const cleared = diffLines("x\ny\n", "");
    expect(cleared.added).toBe(0);
    expect(cleared.removed).toBe(2);
    expect(kinds(cleared.rows)).toEqual(["del", "del"]);
  });

  it("长段未改动被折叠成一行「省略 N 行」，该省的行数算得准", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const after = [...before.slice(0, 28), "line 29 changed", ...before.slice(28)];
    const result = diffLines(`${before.join("\n")}\n`, `${after.join("\n")}\n`, { context: 2 });
    const omitted = result.rows.find(
      (row): row is Extract<DiffRow, { kind: "same" }> => row.kind === "same" && row.omitted !== undefined,
    );
    expect(omitted).toBeDefined();
    // 30 行里只有第 29 行变了；文件头折叠掉 27 行（30 - 前后各 2 行上下文 - 变动的 1 行 + …）
    expect(omitted?.kind).toBe("same");
    expect(omitted?.text).toContain("行未改动");
    expect(omitted?.omitted).toBeGreaterThan(20);
  });

  it("折叠标记之后的行号按真实行继续，不因省略而偏小（d.412 回归）", () => {
    // 折叠掉开头 26 行后，紧随其后的「line 27」必须是第 27 行，而不是第 2 行。
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const after = [...before.slice(0, 28), "line 29 changed", ...before.slice(28)];
    const result = diffLines(`${before.join("\n")}\n`, `${after.join("\n")}\n`, { context: 2 });
    const line27 = result.rows.find((row) => "text" in row && row.text === "line 27");
    const changed = result.rows.find((row) => "text" in row && row.text === "line 29 changed");
    expect(line27).toMatchObject({ kind: "same", oldNo: 27, newNo: 27 });
    expect(changed).toMatchObject({ kind: "add", newNo: 29 });
  });

  it("超过行数上限时截断并标记 truncated，不假装完整", () => {
    const before = Array.from({ length: 40 }, (_, i) => `a${i}`);
    const after = Array.from({ length: 40 }, (_, i) => `b${i}`);
    const result = diffLines(before.join("\n"), after.join("\n"), { maxRows: 10 });
    expect(result.rows).toHaveLength(10);
    expect(result.truncated).toBe(true);
    // 统计仍按全量算：界面要能说清「一共改了多少」
    expect(result.added).toBe(40);
    expect(result.removed).toBe(40);

    const full = diffLines("a\n", "b\n", { maxRows: DIFF_MAX_ROWS });
    expect(full.truncated).toBe(false);
  });
});
