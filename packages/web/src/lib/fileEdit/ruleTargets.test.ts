import { describe, expect, it } from "vitest";
import type { FileRoot } from "./paths.js";
import {
  dirPrefixesOfTargets,
  isFileEditTool,
  prefixRulesOfCall,
  targetsOfCall,
} from "./ruleTargets.js";

const ROOT: FileRoot = { name: "库", path: "D:/库", mode: "write" };
const READ_ROOT: FileRoot = { name: "参考", path: "D:/参考", mode: "read" };

const updatePatch = [
  "*** Begin Patch",
  "*** Update File: notes/a.md",
  "@@",
  "-旧",
  "+新",
  "*** End Patch",
].join("\n");

const call = (name: string, args: unknown) => ({ name, argsJson: JSON.stringify(args) });

describe("工具识别", () => {
  it("只认两个文件工具", () => {
    expect(isFileEditTool("file_patch")).toBe(true);
    expect(isFileEditTool("file_read")).toBe(true);
    expect(isFileEditTool("wiki_read")).toBe(false);
  });
});

describe("调用目标解析", () => {
  it("非文件工具返回 null", () => {
    expect(targetsOfCall(call("wiki_read", { path: "a.md" }), [ROOT])).toBeNull();
  });

  it("file_read：相对路径解析成绝对路径", () => {
    const targets = targetsOfCall(call("file_read", { path: "notes/a.md" }), [ROOT]);
    expect(targets?.absolute).toEqual(["D:/库/notes/a.md"]);
    expect(targets?.rootNames).toEqual(["库"]);
  });

  it("file_patch：解析每个 op，含 Move to 目标", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.md",
      "*** Move to: b.md",
      "@@",
      "-旧",
      "+新",
      "*** Add File: c.md",
      "+内容",
      "*** End Patch",
    ].join("\n");
    const targets = targetsOfCall(call("file_patch", { patch }), [ROOT]);
    expect(targets?.absolute).toEqual(["D:/库/a.md", "D:/库/b.md", "D:/库/c.md"]);
    expect(targets?.deletions).toBe(1); // 改名算删除语义
  });

  it("补丁格式错 / 路径越界 / 根不存在 → null（不误判成已授权）", () => {
    expect(targetsOfCall(call("file_patch", { patch: "随便写的" }), [ROOT])).toBeNull();
    expect(
      targetsOfCall(
        call("file_patch", { patch: "*** Begin Patch\n*** Add File: ../逃逸.md\n+x\n*** End Patch" }),
        [ROOT],
      ),
    ).toBeNull();
    expect(targetsOfCall(call("file_read", { path: "a.md", root: "不存在" }), [ROOT])).toBeNull();
  });
});

describe("目录前缀归纳（授权用）", () => {
  it("同目录多个文件只归纳出一条前缀", () => {
    expect(
      dirPrefixesOfTargets(["D:/库/notes/a.md", "D:/库/notes/b.md"], [ROOT], "write"),
    ).toEqual(["D:/库/notes/"]);
  });

  it("跨目录归纳出多条前缀", () => {
    expect(
      dirPrefixesOfTargets(["D:/库/notes/a.md", "D:/库/草稿/b.md"], [ROOT], "write"),
    ).toEqual(["D:/库/notes/", "D:/库/草稿/"]);
  });

  it("目标是根下的直接子文件时，前缀就是根本身", () => {
    expect(dirPrefixesOfTargets(["D:/库/a.md"], [ROOT], "write")).toEqual(["D:/库/"]);
  });

  it("根外目标不生成前缀（不能凭空授权到根外）", () => {
    expect(dirPrefixesOfTargets(["D:/别处/a.md"], [ROOT], "write")).toEqual([]);
  });

  it("大小写不同的同一目录只留一条", () => {
    expect(
      dirPrefixesOfTargets(["D:/库/Notes/a.md", "D:/库/notes/b.md"], [ROOT], "write"),
    ).toEqual(["D:/库/Notes/"]);
  });

  it("write 模式只认写根；any 模式认所有根", () => {
    expect(dirPrefixesOfTargets(["D:/参考/a.md"], [READ_ROOT], "write")).toEqual([]);
    expect(dirPrefixesOfTargets(["D:/参考/a.md"], [READ_ROOT], "any")).toEqual(["D:/参考/"]);
  });

  it("prefixRulesOfCall：file_patch 用写根、file_read 用任意根", () => {
    expect(prefixRulesOfCall(call("file_patch", { patch: updatePatch }), [ROOT])).toEqual(["D:/库/notes/"]);
    expect(prefixRulesOfCall(call("file_read", { path: "a.md" }), [READ_ROOT])).toEqual(["D:/参考/"]);
  });
});
