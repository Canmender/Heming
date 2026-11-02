import { describe, expect, it } from "vitest";
import {
  applyHunks,
  buildAddedText,
  findHunk,
  joinText,
  normalizePunctLine,
  normalizeSpaceLine,
  splitText,
} from "./match.js";
import { parsePatch } from "./parse.js";
import type { Hunk } from "./types.js";

/** 从补丁文本里取第一个 Update 的第一个 hunk（测试夹具用）。 */
function firstHunk(patch: string): Hunk {
  const parsed = parsePatch(patch);
  if (!parsed.ok) throw new Error(`夹具解析失败：${parsed.error.message}`);
  const op = parsed.plan.ops[0];
  if (op.kind !== "update") throw new Error("夹具必须是 Update");
  return op.hunks[0];
}

/** 从补丁文本里取第一个 Update 的全部 hunk。 */
function allHunks(patch: string): Hunk[] {
  const parsed = parsePatch(patch);
  if (!parsed.ok) throw new Error(`夹具解析失败：${parsed.error.message}`);
  const op = parsed.plan.ops[0];
  if (op.kind !== "update") throw new Error("夹具必须是 Update");
  return op.hunks;
}

/** 应用必须成功（失败时把失败原因带进断言信息）。 */
function applied(text: string, hunks: Hunk[], file = "a.md") {
  const result = applyHunks(text, hunks, file);
  if (!result.ok) throw new Error(`预期应用成功，实际失败：${result.error.message}`);
  return result;
}

describe("文件文本拆分与拼装", () => {
  it("LF 文件往返不变", () => {
    const text = "第一行\n第二行\n";
    const file = splitText(text);
    expect(file.eol).toBe("\n");
    expect(file.finalNewline).toBe(true);
    expect(joinText(file, file.lines)).toBe(text);
  });

  it("CRLF 文件往返不变（保留原行尾）", () => {
    const text = "第一行\r\n第二行\r\n";
    const file = splitText(text);
    expect(file.eol).toBe("\r\n");
    expect(file.lines).toEqual(["第一行", "第二行"]);
    expect(joinText(file, file.lines)).toBe(text);
  });

  it("末尾没有换行的文件保持没有换行", () => {
    const file = splitText("只有一行");
    expect(file.finalNewline).toBe(false);
    expect(joinText(file, file.lines)).toBe("只有一行");
  });

  it("BOM 保留", () => {
    const file = splitText("\uFEFF第一行\n");
    expect(file.bom).toBe(true);
    expect(file.lines).toEqual(["第一行"]);
    expect(joinText(file, file.lines)).toBe("\uFEFF第一行\n");
  });

  it("空文件拆成零行", () => {
    expect(splitText("").lines).toEqual([]);
  });

  it("空白归一与标点归一的差异点符合规格 §4", () => {
    expect(normalizeSpaceLine("  甲   乙  ")).toBe("甲 乙");
    expect(normalizeSpaceLine("甲\t乙")).toBe("甲 乙");
    // 连字符类互认
    expect(normalizePunctLine("a–b")).toBe("a-b");
    expect(normalizePunctLine("a—b")).toBe("a-b");
    expect(normalizePunctLine("a‐b")).toBe("a-b");
    // 弯引号与直引号互认
    expect(normalizePunctLine("“引用”")).toBe('"引用"');
    expect(normalizePunctLine("‘单引号’")).toBe("'单引号'");
  });
});

describe("三级匹配", () => {
  it("第 1 级：精确命中", () => {
    const text = "第一行\n第二行\n第三行\n";
    const hunk = firstHunk(["*** Begin Patch", "*** Update File: a.md", "@@", "-第二行", "+改过的第二行", "*** End Patch"].join("\n"));
    const result = applied(text, [hunk]);
    expect(result.text).toBe("第一行\n改过的第二行\n第三行\n");
    expect(result.notes).toEqual([]);
  });

  it("第 2 级：空白差异仍能命中，且上下文行保留文件原空白", () => {
    // 文件里的上下文行前后有空格，补丁里没有——匹配成功但不该改写这行
    const text = "  上下文有缩进  \n目标行\n结尾\n";
    const hunk = firstHunk(
      ["*** Begin Patch", "*** Update File: a.md", "@@", " 上下文有缩进", "-目标行", "+目标行（改）", " 结尾", "*** End Patch"].join(
        "\n",
      ),
    );
    const result = applied(text, [hunk]);
    expect(result.text).toBe("  上下文有缩进  \n目标行（改）\n结尾\n");
    expect(result.notes.join("\n")).toContain("空白归一");
  });

  it("第 3 级：Unicode 连字符与 ASCII 减号互认", () => {
    const text = "标题 — 副标题\n要改的行\n";
    const hunk = firstHunk(
      ["*** Begin Patch", "*** Update File: a.md", "@@", " 标题 - 副标题", "-要改的行", "+改好的行", "*** End Patch"].join("\n"),
    );
    const result = applied(text, [hunk]);
    expect(result.text).toBe("标题 — 副标题\n改好的行\n");
    expect(result.notes.join("\n")).toContain("标点归一");
  });

  it("第 3 级：弯引号与直引号互认", () => {
    const text = "他说“你好”\n第二行\n";
    const hunk = firstHunk(
      ['*** Begin Patch', '*** Update File: a.md', "@@", ' 他说"你好"', "-第二行", "+第二行（改）", "*** End Patch"].join("\n"),
    );
    const result = applied(text, [hunk]);
    expect(result.text).toBe("他说“你好”\n第二行（改）\n");
  });

  it("锚点不存在 → match-failed，带文件、块号与期望锚点", () => {
    const text = "甲\n乙\n";
    const hunk = firstHunk(
      ["*** Begin Patch", "*** Update File: notes/a.md", "@@", "-完全不存在的行", "+新行", "*** End Patch"].join("\n"),
    );
    const result = applyHunks(text, [hunk], "notes/a.md");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("应当失败");
    expect(result.error.code).toBe("match-failed");
    expect(result.error.path).toBe("notes/a.md");
    expect(result.error.hunkIndex).toBe(1);
    expect(result.error.expected).toEqual(["完全不存在的行"]);
    expect(result.error.message).toContain("file_read");
    expect(result.error.message).toContain("未写入任何文件");
  });

  it("锚点出现两处 → 取第一处并给出提示", () => {
    const text = "重复\n甲\n重复\n乙\n";
    const hunk = firstHunk(["*** Begin Patch", "*** Update File: a.md", "@@", "-重复", "+唯一", "*** End Patch"].join("\n"));
    const result = applied(text, [hunk]);
    expect(result.text).toBe("唯一\n甲\n重复\n乙\n");
    expect(result.notes.join("\n")).toContain("第一处");
  });

  it("多块按顺序应用，后面的块不会匹配到前面已改过的地方", () => {
    const text = "甲\n乙\n丙\n丁\n";
    const hunks = allHunks(
      [
        "*** Begin Patch",
        "*** Update File: a.md",
        "@@",
        "-甲",
        "+甲改",
        "@@",
        "-丙",
        "+丙改",
        "*** End Patch",
      ].join("\n"),
    );
    const result = applied(text, hunks);
    expect(result.text).toBe("甲改\n乙\n丙改\n丁\n");
  });

  it("多块中任何一块失败 → 整份不产出新内容（原子性）", () => {
    const text = "甲\n乙\n";
    const hunks = allHunks(
      ["*** Begin Patch", "*** Update File: a.md", "@@", "-甲", "+甲改", "@@", "-不存在", "+x", "*** End Patch"].join("\n"),
    );
    const result = applyHunks(text, hunks, "a.md");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("应当失败");
    expect(result.error.hunkIndex).toBe(2);
  });

  it("CRLF 文件改完仍是 CRLF", () => {
    const text = "第一行\r\n第二行\r\n";
    const hunk = firstHunk(["*** Begin Patch", "*** Update File: a.md", "@@", "-第二行", "+第二行改", "*** End Patch"].join("\n"));
    const result = applied(text, [hunk]);
    expect(result.text).toBe("第一行\r\n第二行改\r\n");
  });

  it("没有末尾换行的文件改完仍没有末尾换行", () => {
    const text = "第一行\n第二行";
    const hunk = firstHunk(["*** Begin Patch", "*** Update File: a.md", "@@", "-第二行", "+第二行改", "*** End Patch"].join("\n"));
    const result = applied(text, [hunk]);
    expect(result.text).toBe("第一行\n第二行改");
  });

  it("`*** End of File` 只在文件末尾匹配", () => {
    const text = "甲\n末尾\n";
    const hunk = firstHunk(
      ["*** Begin Patch", "*** Update File: a.md", "@@", "-末尾", "+新的末尾", "*** End of File", "*** End Patch"].join("\n"),
    );
    const result = applied(text, [hunk]);
    expect(result.text).toBe("甲\n新的末尾\n");
  });

  it("`*** End of File` 但原文不在末尾 → 匹配失败", () => {
    const text = "末尾\n甲\n";
    const hunk = firstHunk(
      ["*** Begin Patch", "*** Update File: a.md", "@@", "-末尾", "+新的末尾", "*** End of File", "*** End Patch"].join("\n"),
    );
    const result = applyHunks(text, [hunk], "a.md");
    expect(result.ok).toBe(false);
  });

  it("纯新增块用 @@ 后面的说明文字定位（插入到该行之后）", () => {
    const text = "## 标题\n旧内容\n";
    const hunk = firstHunk(["*** Begin Patch", "*** Update File: a.md", "@@ ## 标题", "+插入的一行", "*** End Patch"].join("\n"));
    const result = applied(text, [hunk]);
    expect(result.text).toBe("## 标题\n插入的一行\n旧内容\n");
  });

  it("纯新增块且标了 End of File → 追加到末尾", () => {
    const text = "甲\n";
    const hunk = firstHunk(
      ["*** Begin Patch", "*** Update File: a.md", "@@", "+追加的一行", "*** End of File", "*** End Patch"].join("\n"),
    );
    const result = applied(text, [hunk]);
    expect(result.text).toBe("甲\n追加的一行\n");
  });

  it("纯新增块既无上下文也无 End of File → 无法定位，判失败", () => {
    const text = "甲\n";
    const hunk = firstHunk(["*** Begin Patch", "*** Update File: a.md", "@@", "+追加的一行", "*** End Patch"].join("\n"));
    const result = applyHunks(text, [hunk], "a.md");
    expect(result.ok).toBe(false);
  });

  it("findHunk 在没有原文行时按 atEof 定位到文件末尾", () => {
    const hunk = firstHunk(["*** Begin Patch", "*** Update File: a.md", "@@", "+一行", "*** End of File", "*** End Patch"].join("\n"));
    expect(findHunk(["甲", "乙"], hunk, 0, true)).toMatchObject({ start: 2, level: 1 });
  });
});

describe("新增文件内容拼装", () => {
  it("有内容时以换行结尾", () => {
    expect(buildAddedText(["甲", "乙"])).toBe("甲\n乙\n");
  });

  it("空内容得到空文件", () => {
    expect(buildAddedText([])).toBe("");
  });

  it("Windows 换行不做转换（新增文件统一 LF，避免同一目录里两种行尾）", () => {
    expect(buildAddedText(["甲"])).toBe("甲\n");
  });
});
