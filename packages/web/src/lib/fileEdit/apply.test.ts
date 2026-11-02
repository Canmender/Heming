import { describe, expect, it } from "vitest";
import { kindsSummary, planPatch, sumKinds, type PatchIo, type ReadResult } from "./apply.js";
import { MAX_FILE_BYTES, MAX_FILES_PER_PATCH, MAX_PATCH_BYTES } from "./limits.js";
import { parsePatch } from "./parse.js";
import type { FileRoot } from "./paths.js";
import type { PatchPlan } from "./types.js";

const ROOT: FileRoot = { name: "obsidian", path: "D:/Obsidian/学院事务", mode: "write" };
const OTHER: FileRoot = { name: "scratch", path: "D:/Scratch", mode: "write" };
const READONLY: FileRoot = { name: "ref", path: "D:/参考", mode: "read" };

/** 内存文件系统：`D:/...` 绝对路径 → 内容。 */
function memoryIo(files: Record<string, string>): PatchIo & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    async read(abs: string): Promise<ReadResult> {
      const key = abs.replace(/\\/g, "/");
      if (!(key in files)) return { ok: false, code: "not-found", error: "ENOENT" };
      const content = files[key];
      const bytes = new TextEncoder().encode(content).length;
      if (bytes > MAX_FILE_BYTES) return { ok: false, code: "too-large", error: "too large" };
      return { ok: true, content, bytes };
    },
  };
}

/** 解析必须成功（夹具失败即测试失败，避免静默）。 */
function plan(text: string): PatchPlan {
  const parsed = parsePatch(text);
  if (!parsed.ok) throw new Error(`夹具解析失败：${parsed.error.message}`);
  return parsed.plan;
}

const patch = (...lines: string[]) => plan(lines.join("\n"));

async function run(
  text: string,
  files: Record<string, string> = {},
  extra?: { roots?: FileRoot[]; rootName?: string },
) {
  const io = memoryIo(files);
  const result = await planPatch(plan(text), {
    roots: extra?.roots ?? [ROOT],
    rootName: extra?.rootName,
    patchText: text,
    io,
  });
  return { result, io };
}

describe("干跑 · 正常路径", () => {
  it("新增文件：产出 A 变更", async () => {
    const { result } = await run(
      ["*** Begin Patch", "*** Add File: notes/new.md", "+第一行", "+第二行", "*** End Patch"].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      kind: "A",
      abs: "D:/Obsidian/学院事务/notes/new.md",
      rel: "notes/new.md",
      root: "obsidian",
      oldText: null,
      newText: "第一行\n第二行\n",
    });
    expect(result.targets).toEqual(["D:/Obsidian/学院事务/notes/new.md"]);
  });

  it("修改文件：产出 M 变更并保留 CRLF", async () => {
    const { result } = await run(
      ["*** Begin Patch", "*** Update File: notes/a.md", "@@", "-第二行", "+第二行改", "*** End Patch"].join("\n"),
      { "D:/Obsidian/学院事务/notes/a.md": "第一行\r\n第二行\r\n" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes[0]).toMatchObject({ kind: "M", newText: "第一行\r\n第二行改\r\n" });
  });

  it("删除文件：产出 D 变更并保留原内容（审计/预览用）", async () => {
    const { result } = await run(
      ["*** Begin Patch", "*** Delete File: notes/old.md", "*** End Patch"].join("\n"),
      { "D:/Obsidian/学院事务/notes/old.md": "旧内容\n" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes[0]).toMatchObject({ kind: "D", oldText: "旧内容\n", newText: null });
  });

  it("改名：拆成 1 个删除 + 1 个新增，并记下 movedFrom", async () => {
    const { result } = await run(
      [
        "*** Begin Patch",
        "*** Update File: notes/a.md",
        "*** Move to: notes/b.md",
        "@@",
        "-甲",
        "+乙",
        "*** End Patch",
      ].join("\n"),
      { "D:/Obsidian/学院事务/notes/a.md": "甲\n" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes.map((c) => c.kind)).toEqual(["D", "A"]);
    expect(result.changes[0].abs).toBe("D:/Obsidian/学院事务/notes/a.md");
    expect(result.changes[1]).toMatchObject({
      abs: "D:/Obsidian/学院事务/notes/b.md",
      newText: "乙\n",
      movedFrom: "notes/a.md",
    });
  });

  it("多个文件一次改完（1 add + 1 update）", async () => {
    const { result } = await run(
      [
        "*** Begin Patch",
        "*** Update File: a.md",
        "@@",
        "-甲",
        "+乙",
        "*** Add File: b.md",
        "+丙",
        "*** End Patch",
      ].join("\n"),
      { "D:/Obsidian/学院事务/a.md": "甲\n" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sumKinds(result.changes)).toEqual({ added: 1, modified: 1, deleted: 0 });
    expect(kindsSummary(result.changes)).toBe("将修改 2 个文件（1 个新增、1 个修改）");
  });
});

describe("干跑 · 路径与根", () => {
  it("`..` 越界被拒绝（且不产出任何变更）", async () => {
    const { result, io } = await run(
      ["*** Begin Patch", "*** Add File: ../逃逸.md", "+x", "*** End Patch"].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("path-escape");
    expect(result.error.message).toContain("越界");
    expect(io.writes).toEqual([]);
  });

  it("多层 `..` 越界在被拒绝时仍给出可写根清单", async () => {
    const { result } = await run(
      ["*** Begin Patch", "*** Update File: notes/../../outside.md", "@@", "-x", "+y", "*** End Patch"].join("\n"),
      { "D:/Obsidian/学院事务/notes/../../outside.md": "x\n" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("obsidian");
  });

  it("绝对路径被拒绝", async () => {
    const { result } = await run(
      ["*** Begin Patch", "*** Add File: D:/Windows/evil.dll", "+x", "*** End Patch"].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("path-invalid");
    expect(result.error.message).toContain("相对路径");
  });

  it("只读根里的目标被拒绝", async () => {
    const { result } = await run(
      ["*** Begin Patch", "*** Update File: a.md", "@@", "-x", "+y", "*** End Patch"].join("\n"),
      { "D:/参考/a.md": "x\n" },
      { roots: [READONLY], rootName: "ref" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("root-readonly");
    expect(result.error.message).toContain("只读");
  });

  it("root 参数指定根后路径按该根解析", async () => {
    const { result } = await run(
      ["*** Begin Patch", "*** Add File: a.md", "+x", "*** End Patch"].join("\n"),
      {},
      { roots: [ROOT, OTHER], rootName: "scratch" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes[0].abs).toBe("D:/Scratch/a.md");
    expect(result.changes[0].root).toBe("scratch");
  });

  it("不存在的 root 参数被拒绝并列出可写根", async () => {
    const { result } = await run(
      ["*** Begin Patch", "*** Add File: a.md", "+x", "*** End Patch"].join("\n"),
      {},
      { roots: [ROOT], rootName: "不存在" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("root-unknown");
    expect(result.error.message).toContain("obsidian");
  });

  it("未配置任何可写根时拒绝（并提示去设置区）", async () => {
    const { result } = await run(
      ["*** Begin Patch", "*** Add File: a.md", "+x", "*** End Patch"].join("\n"),
      {},
      { roots: [] },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("root-unknown");
    expect(result.error.message).toContain("可写根");
  });

  it("只有只读根时也不能写", async () => {
    const { result } = await run(
      ["*** Begin Patch", "*** Add File: a.md", "+x", "*** End Patch"].join("\n"),
      {},
      { roots: [READONLY] },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("root-unknown");
  });
});

describe("干跑 · 文件状态与上限", () => {
  it("Add 的目标已存在 → file-exists，建议改用 Update", async () => {
    const { result } = await run(
      ["*** Begin Patch", "*** Add File: a.md", "+x", "*** End Patch"].join("\n"),
      { "D:/Obsidian/学院事务/a.md": "已有内容\n" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("file-exists");
    expect(result.error.message).toContain("Update File");
  });

  it("Update 的目标不存在 → file-not-found，建议 file_read 或 Add", async () => {
    const { result } = await run(
      ["*** Begin Patch", "*** Update File: a.md", "@@", "-x", "+y", "*** End Patch"].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("file-not-found");
    expect(result.error.message).toContain("file_read");
    expect(result.error.message).toContain("Add File");
  });

  it("Delete 的目标不存在 → file-not-found", async () => {
    const { result } = await run(["*** Begin Patch", "*** Delete File: a.md", "*** End Patch"].join("\n"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("file-not-found");
  });

  it("二进制文件被拒绝", async () => {
    const io: PatchIo = {
      read: async () => ({ ok: false, code: "binary", error: "binary" }),
    };
    const text = ["*** Begin Patch", "*** Update File: a.md", "@@", "-x", "+y", "*** End Patch"].join("\n");
    const result = await planPatch(plan(text), { roots: [ROOT], patchText: text, io });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("binary-file");
    expect(result.error.message).toContain("不是 UTF-8 文本");
  });

  it("两个文件里第二个锚点失败 → 整单失败，第一个也不产出", async () => {
    const { result, io } = await run(
      [
        "*** Begin Patch",
        "*** Update File: a.md",
        "@@",
        "-甲",
        "+乙",
        "*** Update File: b.md",
        "@@",
        "-不存在的行",
        "+x",
        "*** End Patch",
      ].join("\n"),
      { "D:/Obsidian/学院事务/a.md": "甲\n", "D:/Obsidian/学院事务/b.md": "丙\n" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("match-failed");
    expect(result.error.path).toBe("b.md");
    expect(io.writes).toEqual([]);
  });

  it("新增内容超过单文件上限 → file-too-large", async () => {
    const huge = "甲".repeat(Math.ceil(MAX_FILE_BYTES / 3) + 10);
    const { result } = await run(
      ["*** Begin Patch", "*** Add File: big.md", `+${huge}`, "*** End Patch"].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("file-too-large");
  });

  it(`一次改超过 ${MAX_FILES_PER_PATCH} 个文件 → too-many-files`, async () => {
    const lines = ["*** Begin Patch"];
    for (let i = 0; i <= MAX_FILES_PER_PATCH; i += 1) {
      lines.push(`*** Add File: f${i}.md`, `+x${i}`);
    }
    lines.push("*** End Patch");
    const { result } = await run(lines.join("\n"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("too-many-files");
  });

  it("补丁总量超过上限 → patch-too-large", async () => {
    const text = `*** Begin Patch\n*** Add File: a.md\n+${"x".repeat(MAX_PATCH_BYTES + 1)}\n*** End Patch`;
    const io: PatchIo = { read: async () => ({ ok: false, code: "not-found", error: "ENOENT" }) };
    const result = await planPatch(plan(text), { roots: [ROOT], patchText: text, io });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("patch-too-large");
  });

  it("改名目标已存在 → file-exists（不覆盖已有文件）", async () => {
    const { result } = await run(
      ["*** Begin Patch", "*** Update File: a.md", "*** Move to: b.md", "@@", "-x", "+y", "*** End Patch"].join("\n"),
      {
        "D:/Obsidian/学院事务/a.md": "x\n",
        "D:/Obsidian/学院事务/b.md": "已存在\n",
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("file-exists");
  });
});

describe("干跑 · 统计与文案", () => {
  it("A/M/D 统计", () => {
    expect(
      sumKinds([
        { kind: "A" } as never,
        { kind: "M" } as never,
        { kind: "M" } as never,
        { kind: "D" } as never,
      ]),
    ).toEqual({ added: 1, modified: 2, deleted: 1 });
  });

  it("没有变更时的文案兜底", () => {
    expect(kindsSummary([])).toBe("将修改 0 个文件（无变更）");
  });
});
