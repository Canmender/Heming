import { describe, expect, it } from "vitest";
import { FILE_WRITE_TOOL } from "../fileEdit/ruleTargets.js";
import { PREVIEW_MAX_LINES, buildChangePreview, changeCountLabel } from "./preview.js";

const args = (value: unknown) => JSON.stringify(value);

describe("HITL 变更预览", () => {
  it("编辑：剥掉公共前缀/后缀，只显示改动行并给出准确增删数", () => {
    const preview = buildChangePreview(
      "fs__edit_file",
      args({
        path: "notes/a.md",
        old_string: "第一行\n第二行\n第三行",
        new_string: "第一行\n第二行（改）\n第三行",
      }),
    );

    expect(preview).toMatchObject({ kind: "edit", path: "notes/a.md", added: 1, removed: 1 });
    expect(preview!.lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      "ctx:第一行",
      "del:第二行",
      "add:第二行（改）",
      "ctx:第三行",
    ]);
  });

  it("大文件改一行：增删数按真实差异算，不把相同的中间段算成删了又加", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `L${i}`);
    const changed = [...lines];
    changed[10] = "CHANGED";
    const preview = buildChangePreview(
      "fs__edit_file",
      args({ path: "big.md", old_string: lines.join("\n"), new_string: changed.join("\n") }),
    );

    expect(preview).toMatchObject({ kind: "edit", added: 1, removed: 1 });

    // 完全一样的大文件不应产生任何幻影增删
    const noop = buildChangePreview(
      "fs__edit_file",
      args({ path: "big.md", old_string: lines.join("\n"), new_string: lines.join("\n") }),
    );
    expect(noop).toMatchObject({ kind: "edit", added: 0, removed: 0 });
  });

  it("写入：内容按新增行展示，空文件也给出路径", () => {
    const preview = buildChangePreview(
      "fs__write_file",
      args({ path: "notes/b.md", content: "a\nb\n" }),
    );

    expect(preview).toMatchObject({ kind: "write", path: "notes/b.md", added: 2, removed: 0 });
    expect(preview!.lines.every((l) => l.kind === "add")).toBe(true);
  });

  it("删除：只在工具名明确是删除时才认定，且只显示路径", () => {
    expect(
      buildChangePreview("fs__delete_file", args({ path: "C:/data/a.txt" })),
    ).toMatchObject({ kind: "delete", path: "C:/data/a.txt", added: 0, removed: 0 });

    // 读文件同样有 path 但没有内容：不能被误标成删除
    expect(buildChangePreview("fs__read_file", args({ path: "C:/data/a.txt" }))).toBeNull();
  });

  it("参数不是 JSON 对象 / 没有可识别字段 → null（不猜着展示）", () => {
    expect(buildChangePreview("fs__write_file", "not json")).toBeNull();
    expect(buildChangePreview("fs__write_file", "[]")).toBeNull();
    expect(buildChangePreview("send_message", args({ text: "hi" }))).toBeNull();
  });

  it("超长内容截断到上限，但增删数按完整内容算", () => {
    const content = Array.from({ length: PREVIEW_MAX_LINES + 10 }, (_, i) => `line ${i}`).join("\n");
    const preview = buildChangePreview("fs__write_file", args({ path: "big.md", content }))!;

    expect(preview.truncated).toBe(true);
    expect(preview.lines).toHaveLength(PREVIEW_MAX_LINES);
    expect(preview.added).toBe(PREVIEW_MAX_LINES + 10);
    expect(changeCountLabel(preview)).toBe(`+${PREVIEW_MAX_LINES + 10} −0`);
  });

  it("file_write：拿不到旧内容时降级为「将写入 N 行」，不当成整份新增的 +N −0", () => {
    const preview = buildChangePreview(
      FILE_WRITE_TOOL,
      args({ path: "notes/c.md", content: "a\nb" }),
    )!;

    expect(preview).toMatchObject({
      kind: "write",
      path: "notes/c.md",
      added: 2,
      removed: 0,
      fallback: true,
    });
    expect(changeCountLabel(preview)).toBe("将写入 2 行");
  });

  it("file_write：能读到旧内容就展示覆盖前后的行级 diff", () => {
    const preview = buildChangePreview(
      FILE_WRITE_TOOL,
      args({ path: "notes/a.md", content: "第一行\n第二行（改）\n第三行" }),
      { readBefore: (path) => (path === "notes/a.md" ? "第一行\n第二行\n第三行" : null) },
    )!;

    expect(preview).toMatchObject({ kind: "write", path: "notes/a.md", added: 1, removed: 1 });
    expect(preview.fallback).toBeUndefined();
    expect(preview.lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      "ctx:第一行",
      "del:第二行",
      "add:第二行（改）",
      "ctx:第三行",
    ]);
    expect(changeCountLabel(preview)).toBe("+1 −1");
  });

  it("读旧内容抛错也不抛：确认卡不能因为预览读盘失败而白屏", () => {
    const argsJson = args({ path: "notes/a.md", content: "x" });
    const preview = buildChangePreview(FILE_WRITE_TOOL, argsJson, {
      readBefore: () => {
        throw new Error("读盘失败");
      },
    })!;

    expect(preview).toMatchObject({ kind: "write", added: 1, fallback: true });
    expect(changeCountLabel(preview)).toBe("将写入 1 行");
  });

  it("file_edit：按替换点做 diff（不展示整份文件）", () => {
    const preview = buildChangePreview(
      "file_edit",
      args({ path: "notes/a.md", old_string: "旧", new_string: "新" }),
    )!;

    expect(preview).toMatchObject({ kind: "edit", path: "notes/a.md", added: 1, removed: 1 });
    expect(preview.lines.map((l) => `${l.kind}:${l.text}`)).toEqual(["del:旧", "add:新"]);
  });

  it("file_glob / file_grep 没有变更内容 → null（pattern 展示交给参数摘要）", () => {
    expect(buildChangePreview("file_glob", args({ pattern: "**/*.md" }))).toBeNull();
    expect(buildChangePreview("file_grep", args({ pattern: "TODO", include: "*.ts" }))).toBeNull();
  });
});
