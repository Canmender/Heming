import { describe, expect, it } from "vitest";
import type { VaultEntry } from "../../lib/vault/types.js";
import {
  ancestorsOf,
  baseName,
  ensureMdExt,
  findEntry,
  flattenTree,
  joinRel,
  parentOf,
  stripMdExt,
} from "./model.js";

const mtime = "2026-11-08T08:00:00.000Z";

function treeFixture(): VaultEntry[] {
  return [
    {
      rel: "a",
      name: "a",
      kind: "dir",
      size: 0,
      mtime,
      children: [
        { rel: "a/b.md", name: "b.md", kind: "md", size: 1, mtime },
        {
          rel: "a/sub",
          name: "sub",
          kind: "dir",
          size: 0,
          mtime,
          children: [{ rel: "a/sub/c.md", name: "c.md", kind: "md", size: 2, mtime }],
        },
      ],
    },
    { rel: "root.md", name: "root.md", kind: "md", size: 3, mtime },
  ];
}

describe("文件树纯函数", () => {
  it("joinRel：空目录就是文件名，分隔符归一", () => {
    expect(joinRel("", "a.md")).toBe("a.md");
    expect(joinRel("dir", "a.md")).toBe("dir/a.md");
    expect(joinRel("/dir/", "/a.md")).toBe("dir/a.md");
    expect(joinRel("dir", "")).toBe("dir");
  });

  it("parentOf / baseName / stripMdExt", () => {
    expect(parentOf("a/sub/c.md")).toBe("a/sub");
    expect(parentOf("root.md")).toBe("");
    expect(baseName("a/sub/c.md")).toBe("c.md");
    expect(stripMdExt("c.md")).toBe("c");
    expect(stripMdExt("c.MD")).toBe("c");
    expect(stripMdExt("c.canvas")).toBe("c.canvas");
  });

  it("ensureMdExt：无扩展名补 .md，已有扩展名保留", () => {
    expect(ensureMdExt("新笔记")).toBe("新笔记.md");
    expect(ensureMdExt(" 新笔记 ")).toBe("新笔记.md");
    expect(ensureMdExt("图.png")).toBe("图.png");
    expect(ensureMdExt("")).toBe("");
  });

  it("flattenTree 只展开 expanded 里的目录", () => {
    const tree = treeFixture();
    expect(flattenTree(tree, new Set())).toEqual([
      { entry: tree[0], depth: 0 },
      { entry: tree[1], depth: 0 },
    ]);
    const rows = flattenTree(tree, new Set(["a"]));
    expect(rows.map((row) => row.entry.rel)).toEqual(["a", "a/b.md", "a/sub", "root.md"]);
    expect(rows[2].depth).toBe(1);

    const deep = flattenTree(tree, new Set(["a", "a/sub"]));
    expect(deep.map((row) => row.entry.rel)).toEqual([
      "a",
      "a/b.md",
      "a/sub",
      "a/sub/c.md",
      "root.md",
    ]);
    expect(deep[3].depth).toBe(2);
  });

  it("findEntry 递归查找；找不到返回 null", () => {
    const tree = treeFixture();
    expect(findEntry(tree, "a/sub/c.md")?.name).toBe("c.md");
    expect(findEntry(tree, "root.md")?.rel).toBe("root.md");
    expect(findEntry(tree, "nope")).toBeNull();
  });

  it("ancestorsOf 给出所有祖先目录（不含自身）", () => {
    expect(ancestorsOf("a/sub/c.md")).toEqual(["a", "a/sub"]);
    expect(ancestorsOf("root.md")).toEqual([]);
    expect(ancestorsOf("a\\b\\c.md")).toEqual(["a", "a/b"]);
  });
});
