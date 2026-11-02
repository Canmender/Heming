import { describe, expect, it } from "vitest";
import {
  allPaths,
  countTargets,
  hasDeleteIntent,
  parsePatch,
  sourcePaths,
} from "./parse.js";
import { MAX_HUNK_LINES } from "./limits.js";

/** 包一层：测试里绝大多数断言只看「解析成什么」。 */
function ok(text: string) {
  const result = parsePatch(text);
  if (!result.ok) throw new Error(`预期解析成功，实际失败：${result.error.message}`);
  return result.plan;
}

/** 包一层：只关心失败码与文案。 */
function err(text: string) {
  const result = parsePatch(text);
  if (result.ok) throw new Error("预期解析失败，实际成功");
  return result.error;
}

describe("补丁协议解析 · 结构", () => {
  it("解析改名 + 改内容的完整示例（规格 §3）", () => {
    const plan = ok(
      [
        "*** Begin Patch",
        "*** Update File: notes/a.md",
        "*** Move to: notes/b.md",
        "@@ # 标题",
        "-旧的一行",
        "+新的一行",
        "*** End Patch",
      ].join("\n"),
    );

    expect(plan.ops).toHaveLength(1);
    const op = plan.ops[0];
    expect(op).toMatchObject({ kind: "update", path: "notes/a.md", moveTo: "notes/b.md" });
    if (op.kind !== "update") throw new Error("类型收窄失败");
    expect(op.hunks).toHaveLength(1);
    expect(op.hunks[0]).toMatchObject({ header: "# 标题", atEof: false });
    expect(op.hunks[0].lines).toEqual([
      { kind: "del", text: "旧的一行" },
      { kind: "add", text: "新的一行" },
    ]);
  });

  it("解析新增文件：每一行都必须以 + 开头", () => {
    const plan = ok(
      ["*** Begin Patch", "*** Add File: notes/new.md", "+第一行", "+第二行", "*** End Patch"].join("\n"),
    );
    expect(plan.ops).toEqual([{ kind: "add", path: "notes/new.md", lines: ["第一行", "第二行"] }]);
  });

  it("解析删除文件", () => {
    const plan = ok(["*** Begin Patch", "*** Delete File: notes/old.md", "*** End Patch"].join("\n"));
    expect(plan.ops).toEqual([{ kind: "delete", path: "notes/old.md" }]);
  });

  it("一个 Update 下可以有多个 @@ 块，按出现顺序保留", () => {
    const plan = ok(
      [
        "*** Begin Patch",
        "*** Update File: a.md",
        "@@ 第一块",
        " 上下文",
        "-旧",
        "+新",
        "@@ 第二块",
        "-旧二",
        "+新二",
        "*** End Patch",
      ].join("\n"),
    );
    const op = plan.ops[0];
    if (op.kind !== "update") throw new Error("类型收窄失败");
    expect(op.hunks.map((h) => h.header)).toEqual(["第一块", "第二块"]);
    expect(op.hunks[1].lines).toEqual([
      { kind: "del", text: "旧二" },
      { kind: "add", text: "新二" },
    ]);
  });

  it("`*** End of File` 记在该块上", () => {
    const plan = ok(
      ["*** Begin Patch", "*** Update File: a.md", "@@", "-最后一行", "+新的最后一行", "*** End of File", "*** End Patch"].join(
        "\n",
      ),
    );
    const op = plan.ops[0];
    if (op.kind !== "update") throw new Error("类型收窄失败");
    expect(op.hunks[0].atEof).toBe(true);
  });

  it("Begin Patch 后面的说明文字被收集但不参与语义", () => {
    const plan = ok(["*** Begin Patch 整理标题", "*** Delete File: a.md", "*** End Patch"].join("\n"));
    expect(plan.note).toBe("整理标题");
    expect(plan.ops).toHaveLength(1);
  });

  it("兼容 CRLF 补丁（模型从 Windows 客户端发出的常见形态）", () => {
    const plan = ok(
      "*** Begin Patch\r\n*** Add File: a.md\r\n+一行\r\n*** End Patch\r\n",
    );
    expect(plan.ops).toEqual([{ kind: "add", path: "a.md", lines: ["一行"] }]);
  });

  it("块之间的空行是分隔符，不影响解析", () => {
    const plan = ok(
      [
        "*** Begin Patch",
        "*** Add File: a.md",
        "+一行",
        "",
        "*** Delete File: b.md",
        "*** End Patch",
      ].join("\n"),
    );
    expect(plan.ops.map((o) => o.kind)).toEqual(["add", "delete"]);
  });

  it("多个文件按书写顺序保留", () => {
    const plan = ok(
      [
        "*** Begin Patch",
        "*** Update File: b.md",
        "@@",
        "-x",
        "+y",
        "*** Delete File: c.md",
        "*** Add File: d.md",
        "+内容",
        "*** End Patch",
      ].join("\n"),
    );
    expect(plan.ops.map((o) => o.path)).toEqual(["b.md", "c.md", "d.md"]);
  });
});

describe("补丁协议解析 · 失败语义", () => {
  it("缺 `*** Begin Patch` 判错", () => {
    expect(err("*** Add File: a.md\n+x\n*** End Patch").code).toBe("invalid-patch");
  });

  it("缺 `*** End Patch` 判错", () => {
    expect(err("*** Begin Patch\n*** Add File: a.md\n+x").code).toBe("invalid-patch");
  });

  it("空补丁（只有首尾标记）→ empty-patch，文案是 No files were modified", () => {
    const error = err("*** Begin Patch\n*** End Patch");
    expect(error.code).toBe("empty-patch");
    expect(error.message).toBe("No files were modified");
  });

  it("空字符串补丁判错", () => {
    expect(err("   ").code).toBe("invalid-patch");
  });

  it("Add 行缺少 + 前缀判错", () => {
    const error = err(["*** Begin Patch", "*** Add File: a.md", "+正常", "少了加号", "*** End Patch"].join("\n"));
    expect(error.code).toBe("invalid-patch");
    expect(error.message).toContain("`+`");
    expect(error.path).toBe("a.md");
  });

  it("Add 块内出现 - 前缀也判错（模型常把上下文行混进来）", () => {
    const error = err(["*** Begin Patch", "*** Add File: a.md", "-一行", "*** End Patch"].join("\n"));
    expect(error.code).toBe("invalid-patch");
  });

  it("`*** Move to` 出现在 @@ 之后判错", () => {
    const error = err(
      [
        "*** Begin Patch",
        "*** Update File: a.md",
        "@@",
        "-x",
        "+y",
        "*** Move to: b.md",
        "*** End Patch",
      ].join("\n"),
    );
    expect(error.code).toBe("invalid-patch");
    expect(error.message).toContain("Move to");
  });

  it("`*** Move to` 出现在 Update 之外判错", () => {
    const error = err(["*** Begin Patch", "*** Move to: b.md", "*** End Patch"].join("\n"));
    expect(error.code).toBe("invalid-patch");
  });

  it("Update 没有任何 @@ 块判错", () => {
    const error = err(["*** Begin Patch", "*** Update File: a.md", "*** End Patch"].join("\n"));
    expect(error.code).toBe("invalid-patch");
    expect(error.message).toContain("@@");
  });

  it("内容行出现在 @@ 之前判错", () => {
    const error = err(["*** Begin Patch", "*** Update File: a.md", "-x", "+y", "*** End Patch"].join("\n"));
    expect(error.code).toBe("invalid-patch");
    expect(error.message).toContain("@@");
  });

  it("不认识的指令判错", () => {
    const error = err(["*** Begin Patch", "*** Rename File: a.md", "*** End Patch"].join("\n"));
    expect(error.code).toBe("invalid-patch");
    expect(error.message).toContain("Rename File");
  });

  it("确实不属于任何指令的行判错", () => {
    const error = err(["*** Begin Patch", "随便一行", "*** End Patch"].join("\n"));
    expect(error.code).toBe("invalid-patch");
  });

  it("同一份补丁里重复操作同一个文件判错", () => {
    const error = err(
      [
        "*** Begin Patch",
        "*** Add File: a.md",
        "+x",
        "*** Delete File: a.md",
        "*** End Patch",
      ].join("\n"),
    );
    expect(error.code).toBe("invalid-patch");
    expect(error.path).toBe("a.md");
  });

  it("路径含 NUL 判错", () => {
    const error = err(["*** Begin Patch", "*** Add File: a\u0000.md", "+x", "*** End Patch"].join("\n"));
    expect(error.code).toBe("path-invalid");
  });

  it("路径为空判错", () => {
    const error = err(["*** Begin Patch", "*** Add File:", "+x", "*** End Patch"].join("\n"));
    expect(error.code).toBe("path-invalid");
  });

  it("Delete 后面多出内容行判错", () => {
    const error = err(["*** Begin Patch", "*** Delete File: a.md", "多余内容", "*** End Patch"].join("\n"));
    expect(error.code).toBe("invalid-patch");
  });

  it(`单个 @@ 块超过 ${MAX_HUNK_LINES} 行判错`, () => {
    const body = Array.from({ length: MAX_HUNK_LINES + 1 }, (_, i) => `+第 ${i} 行`);
    const error = err(["*** Begin Patch", "*** Update File: a.md", "@@", ...body, "*** End Patch"].join("\n"));
    expect(error.code).toBe("hunk-too-large");
    expect(error.path).toBe("a.md");
    expect(error.hunkIndex).toBe(1);
  });

  it("Update 块里缺前缀的空行判错（上下文行必须带一个空格）", () => {
    const error = err(["*** Begin Patch", "*** Update File: a.md", "@@", " 上下文", "", "+新增", "*** End Patch"].join("\n"));
    expect(error.code).toBe("invalid-patch");
    expect(error.message).toContain("空格");
  });

  it("错误里的行号指向真实行（便于模型自纠）", () => {
    const error = err(["*** Begin Patch", "*** Add File: a.md", "+x", "*** Bogus", "*** End Patch"].join("\n"));
    expect(error.message).toContain("第 4 行");
  });
});

describe("补丁计划辅助函数", () => {
  const plan = parsePatch(
    [
      "*** Begin Patch",
      "*** Update File: a.md",
      "*** Move to: b.md",
      "@@",
      "-x",
      "+y",
      "*** Add File: c.md",
      "+内容",
      "*** Delete File: d.md",
      "*** End Patch",
    ].join("\n"),
  );
  if (!plan.ok) throw new Error("测试夹具解析失败");

  it("countTargets 含改名目标", () => {
    expect(countTargets(plan.plan.ops)).toBe(4); // update + move + add + delete
  });

  it("sourcePaths 只给原始路径", () => {
    expect(sourcePaths(plan.plan.ops)).toEqual(["a.md", "c.md", "d.md"]);
  });

  it("allPaths 含改名目标", () => {
    expect(allPaths(plan.plan.ops)).toEqual(["a.md", "b.md", "c.md", "d.md"]);
  });

  it("hasDeleteIntent 认得出删除与改名（改名 = 删旧 + 增新）", () => {
    expect(hasDeleteIntent(plan.plan.ops)).toBe(true);
    const addOnly = parsePatch("*** Begin Patch\n*** Add File: x.md\n+y\n*** End Patch");
    if (!addOnly.ok) throw new Error("夹具失败");
    expect(hasDeleteIntent(addOnly.plan.ops)).toBe(false);
  });
});
