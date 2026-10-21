import { describe, expect, it } from "vitest";
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
});
