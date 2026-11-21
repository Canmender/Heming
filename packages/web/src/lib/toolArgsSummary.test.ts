import { describe, expect, it } from "vitest";
import { summarizeToolArgs, toolArgPath } from "./toolArgsSummary.js";

const json = (value: unknown) => JSON.stringify(value);

describe("工具参数的人话摘要（d.216）", () => {
  it("写文件：路径 + 新增行数", () => {
    expect(summarizeToolArgs("file_write", json({ path: "notes/新.md", content: "一行\n两行\n三行" }))).toBe(
      "notes/新.md · +3 行",
    );
  });

  it("写文件：末尾没有换行也算一行（与编辑器行号一致）", () => {
    expect(summarizeToolArgs("file_write", json({ path: "a.ts", content: "只有一行" }))).toBe("a.ts · +1 行");
  });

  it("改文件：旧行数 → 新行数；只给路径时退化成路径", () => {
    expect(
      summarizeToolArgs("file_edit", json({ path: "src/a.ts", old_string: "旧的", new_string: "新的\n两行" })),
    ).toBe("src/a.ts · 1 行 → 2 行");
    expect(summarizeToolArgs("file_edit", json({ path: "src/a.ts" }))).toBe("src/a.ts");
  });

  it("补丁：按 +++ 行数出改了哪些文件", () => {
    const one = "--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-旧\n+新";
    expect(summarizeToolArgs("file_patch", json({ patch: one }))).toBe("补丁 · x.md");
    const two = `${one}\n--- a/y.md\n+++ b/y.md`;
    expect(summarizeToolArgs("file_patch", json({ patch: two }))).toBe("补丁 · 2 个文件");
    expect(summarizeToolArgs("file_patch", json({ patch: "@@ 没有文件头 @@" }))).toBe("补丁");
  });

  it("读/图/撤销：只给路径，并把反斜杠与多余斜杠压掉", () => {
    expect(summarizeToolArgs("file_read", json({ path: "D:\\\\Heming\\\\packages\\\\web\\\\a.ts" }))).toBe(
      "D:/Heming/packages/web/a.ts",
    );
    expect(summarizeToolArgs("file_image", json({ path: "图/a.png" }))).toBe("图/a.png");
    expect(summarizeToolArgs("file_undo", json({ path: "a.ts" }))).toBe("a.ts");
  });

  it("查找：glob 给模式、grep 给 /模式/ in 路径", () => {
    expect(summarizeToolArgs("file_glob", json({ pattern: "**/*.test.ts" }))).toBe("**/*.test.ts");
    expect(summarizeToolArgs("file_grep", json({ pattern: "TODO", path: "src" }))).toBe("/TODO/ in src");
    expect(summarizeToolArgs("file_grep", json({ pattern: "TODO" }))).toBe("/TODO/");
  });

  it("跑命令：命令行一行（带 cwd 时附在末尾）", () => {
    expect(summarizeToolArgs("run_command", json({ command: "pnpm -w typecheck" }))).toBe("pnpm -w typecheck");
    expect(summarizeToolArgs("run_command", json({ command: "git status", cwd: "D:/Heming" }))).toBe(
      "git status · D:/Heming",
    );
    const long = summarizeToolArgs("run_command", json({ command: "x".repeat(200) }));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("…")).toBe(true);
  });

  it("后台作业：按 job_id 说作业号；command_list 说「列出后台作业」", () => {
    expect(summarizeToolArgs("command_output", json({ job_id: "job-3" }))).toBe("作业 job-3");
    expect(summarizeToolArgs("command_kill", json({ job_id: "job-3" }))).toBe("作业 job-3");
    expect(summarizeToolArgs("command_list", json({}))).toBe("列出后台作业");
  });

  it("子代理与工作流：并行件数、步数与目标", () => {
    expect(summarizeToolArgs("agent_task", json({ task: "查一下登录流程" }))).toBe("查一下登录流程");
    expect(summarizeToolArgs("workflow_run", json({ goal: "查清缓存失效", steps: [{ id: "a" }, { id: "b" }] }))).toBe(
      "2 步 · 查清缓存失效",
    );
    expect(summarizeToolArgs("workflow_run", json({ steps: [{ id: "a" }] }))).toBe("1 步");
  });

  it("清单与长输出：项数、编号与起始字", () => {
    expect(summarizeToolArgs("todo_write", json({ todos: [{ content: "a" }, { content: "b" }] }))).toBe("2 项");
    expect(summarizeToolArgs("tool_output_read", json({ id: "1" }))).toBe("#1");
    expect(summarizeToolArgs("tool_output_read", json({ id: "1", offset: 200 }))).toBe("#1 · 从第 200 字");
  });

  it("未知工具：取前两个标量，数组说项数", () => {
    expect(summarizeToolArgs("srv__search", json({ q: "天气", limit: 5, nested: { a: 1 } }))).toBe(
      "q: 天气 · limit: 5",
    );
    expect(summarizeToolArgs("srv__batch", json({ items: [1, 2, 3] }))).toBe("items: 3 项");
    expect(summarizeToolArgs("srv__nothing", json({}))).toBe("");
  });

  it("参数不是合法 JSON / 不是对象 / 空串：一律返回空串，不瞎猜", () => {
    expect(summarizeToolArgs("file_write", "")).toBe("");
    expect(summarizeToolArgs("file_write", "   ")).toBe("");
    expect(summarizeToolArgs("file_write", "{\"path\":\"a.ts\"")).toBe("");
    expect(summarizeToolArgs("file_write", "[1,2,3]")).toBe("");
    expect(summarizeToolArgs("file_write", "null")).toBe("");
    expect(summarizeToolArgs("file_write", "not json at all")).toBe("");
  });

  it("超长路径按码点截断，不会把代理对切一半", () => {
    const path = `${"深".repeat(80)}.md`;
    const summary = summarizeToolArgs("file_read", json({ path }));
    expect(summary.startsWith("…")).toBe(true);
    expect(summary.endsWith(".md")).toBe(true);
    expect(summary.includes("\uFFFD")).toBe(false);
  });

  it("超长路径保留末尾的文件名，而不是丢掉文件名只留目录头", () => {
    const path = "/very/deep/directory/structure/that/keeps/going/and/going/for/a/very/long/while/important-file.ts";
    const summary = summarizeToolArgs("file_read", json({ path }));
    expect(summary).toContain("important-file.ts");
    expect(summary.startsWith("…")).toBe(true);
    expect(Array.from(summary).length).toBeLessThanOrEqual(64);
  });
});


describe("工具涉及的那个文件路径（d.235）", () => {
  it("读写改撤销读图都认（原样返回路径，不裁不改）", () => {
    for (const name of ["file_read", "file_write", "file_edit", "file_undo", "file_image"]) {
      expect(toolArgPath(name, JSON.stringify({ path: "D:/工作区/src/a.ts" }))).toBe(
        "D:/工作区/src/a.ts",
      );
    }
  });

  it("glob / grep / 补丁都不认（模式不是路径；补丁可能改多个文件，挑一个等于替用户猜）", () => {
    expect(toolArgPath("file_glob", JSON.stringify({ pattern: "**/*.ts" }))).toBeNull();
    expect(toolArgPath("file_grep", JSON.stringify({ pattern: "TODO", path: "D:/w" }))).toBeNull();
    expect(toolArgPath("file_patch", JSON.stringify({ patch: "*** Update File: a.ts" }))).toBeNull();
  });

  it("参数不是合法 JSON、空对象、路径为空或不是字符串 → null（不猜）", () => {
    expect(toolArgPath("file_read", "{半截")).toBeNull();
    expect(toolArgPath("file_read", "{}")).toBeNull();
    expect(toolArgPath("file_read", JSON.stringify({ path: "   " }))).toBeNull();
    expect(toolArgPath("file_read", JSON.stringify({ path: 42 }))).toBeNull();
    expect(toolArgPath("file_read", "")).toBeNull();
  });

  it("路径两端的空白会去掉（模型偶尔带换行）", () => {
    expect(toolArgPath("file_read", JSON.stringify({ path: "\nD:/w/a.ts\n" }))).toBe("D:/w/a.ts");
  });
});
