import { describe, expect, it } from "vitest";
import type { FileRoot } from "./paths.js";
import {
  dirPrefixesOfTargets,
  isFileEditTool,
  isFileWriteTool,
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
  it("认识六个文件工具", () => {
    for (const name of [
      "file_patch",
      "file_read",
      "file_write",
      "file_edit",
      "file_glob",
      "file_grep",
    ]) {
      expect(isFileEditTool(name)).toBe(true);
    }
    expect(isFileEditTool("wiki_read")).toBe(false);
    expect(isFileEditTool("file_write_extra")).toBe(false);
  });

  it("写类工具与读类工具分开：阻止「整工具放行」时只看写类", () => {
    expect(isFileWriteTool("file_patch")).toBe(true);
    expect(isFileWriteTool("file_write")).toBe(true);
    expect(isFileWriteTool("file_edit")).toBe(true);
    expect(isFileWriteTool("file_read")).toBe(false);
    expect(isFileWriteTool("file_glob")).toBe(false);
    expect(isFileWriteTool("file_grep")).toBe(false);
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

describe("新增写工具（file_write / file_edit）的目标解析", () => {
  it("path 解析成写目标；覆盖不算删除（deletions 恒为 0）", () => {
    for (const name of ["file_write", "file_edit"]) {
      const targets = targetsOfCall(call(name, { path: "notes/a.md" }), [ROOT]);
      expect(targets).toMatchObject({
        tool: name,
        absolute: ["D:/库/notes/a.md"],
        rootNames: ["库"],
        deletions: 0,
      });
    }
  });

  it("缺 path / 路径越界 / 根名不存在 → null（不误判成已授权）", () => {
    expect(targetsOfCall(call("file_write", { content: "x" }), [ROOT])).toBeNull();
    expect(targetsOfCall(call("file_edit", { old_string: "a", new_string: "b" }), [ROOT])).toBeNull();
    expect(targetsOfCall(call("file_write", { path: "../逃逸.md" }), [ROOT])).toBeNull();
    expect(targetsOfCall(call("file_write", { path: "a.md", root: "不存在" }), [ROOT])).toBeNull();
  });

  it("缺省根取第一条写根：读根排第一时也不会写进只读目录", () => {
    const targets = targetsOfCall(call("file_write", { path: "a.md" }), [READ_ROOT, ROOT]);
    expect(targets?.absolute).toEqual(["D:/库/a.md"]);
    expect(targets?.rootNames).toEqual(["库"]);
  });
});

describe("只读工具（file_glob / file_grep）的目标解析", () => {
  it("path 可选：缺省时目标就是整根", () => {
    expect(targetsOfCall(call("file_glob", { pattern: "**/*.md" }), [ROOT])).toMatchObject({
      absolute: ["D:/库"],
      rel: [""],
      kinds: ["dir"],
    });
    expect(targetsOfCall(call("file_grep", { pattern: "TODO", include: "*.ts" }), [ROOT])?.absolute).toEqual([
      "D:/库",
    ]);
  });

  it("带 path 时解析到指定目录（目录本身是授权对象）", () => {
    expect(targetsOfCall(call("file_glob", { pattern: "*.md", path: "notes" }), [ROOT])).toMatchObject({
      absolute: ["D:/库/notes"],
      kinds: ["dir"],
    });
    expect(targetsOfCall(call("file_grep", { pattern: "TODO", path: "notes" }), [ROOT])?.absolute).toEqual([
      "D:/库/notes",
    ]);
  });

  it("读工具也要求路径不越界", () => {
    expect(targetsOfCall(call("file_glob", { pattern: "*", path: "../逃逸" }), [ROOT])).toBeNull();
  });
});

describe("新增工具的目录前缀（记住授权的口径）", () => {
  it("写三件都只按写根生成前缀", () => {
    expect(prefixRulesOfCall(call("file_write", { path: "notes/a.md" }), [READ_ROOT, ROOT])).toEqual([
      "D:/库/notes/",
    ]);
    expect(prefixRulesOfCall(call("file_edit", { path: "notes/a.md" }), [READ_ROOT, ROOT])).toEqual([
      "D:/库/notes/",
    ]);
  });

  it("读三件按任意根生成前缀（只读根本来就不需要写权限）", () => {
    expect(prefixRulesOfCall(call("file_glob", { pattern: "*.md", path: "notes" }), [READ_ROOT])).toEqual([
      "D:/参考/notes/",
    ]);
    expect(prefixRulesOfCall(call("file_grep", { pattern: "TODO", path: "notes" }), [READ_ROOT])).toEqual([
      "D:/参考/notes/",
    ]);
    expect(prefixRulesOfCall(call("file_read", { path: "notes/a.md" }), [READ_ROOT])).toEqual([
      "D:/参考/notes/",
    ]);
  });

  it("glob/grep 扫整个根时前缀就是根本身（不是 * 整工具放行）", () => {
    expect(prefixRulesOfCall(call("file_glob", { pattern: "**/*.md" }), [ROOT])).toEqual(["D:/库/"]);
    expect(prefixRulesOfCall(call("file_grep", { pattern: "TODO" }), [ROOT])).toEqual(["D:/库/"]);
  });
});

describe("file_image 目标解析（d.168）", () => {
  const roots = [{ name: "库", path: "D:/库", mode: "write" as const }];

  it("file_image 的目标按根内文件解析（不产生删除、授权按父目录）", () => {
    const targets = targetsOfCall(
      { name: "file_image", argsJson: JSON.stringify({ path: "截图/home.png" }) },
      roots,
    );
    expect(targets).not.toBeNull();
    expect(targets!.tool).toBe("file_image");
    expect(targets!.absolute).toEqual(["D:/库/截图/home.png"]);
    expect(targets!.kinds).toEqual(["file"]);
    expect(targets!.deletions).toBe(0);
    // 只读工具 → 前缀归纳用 any（读根也能授权）
    const prefixes = dirPrefixesOfTargets(targets!.absolute, roots, "any");
    expect(prefixes.some((p) => p.replace(/\/+$/, "") === "D:/库/截图")).toBe(true);
  });

  it("file_image 缺 path 返回 null（不让闸门按「整根」放行）", () => {
    expect(targetsOfCall({ name: "file_image", argsJson: "{}" }, roots)).toBeNull();
  });
});

describe("file_undo 的路径目标（d.170）", () => {
  it("与 file_write 同类：解析出单个写目标，让 HITL 能按目录记住授权", () => {
    const roots: FileRoot[] = [{ name: "工作区", path: "D:/工作区", mode: "write" }];
    const targets = targetsOfCall({ name: "file_undo", argsJson: JSON.stringify({ path: "src/a.md" }) }, roots);
    expect(targets).not.toBeNull();
    expect(targets?.absolute).toEqual(["D:/工作区/src/a.md"]);
    expect(targets?.rel).toEqual(["src/a.md"]);
  });

  it("缺 path 时不产生目标（否则整根会被当成一次授权）", () => {
    const roots: FileRoot[] = [{ name: "工作区", path: "D:/工作区", mode: "write" }];
    expect(targetsOfCall({ name: "file_undo", argsJson: "{}" }, roots)).toBeNull();
  });
});
