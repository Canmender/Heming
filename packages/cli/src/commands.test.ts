import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CLI_COMMAND_ARGS_MAX,
  cliCommandsDir,
  describeCliCommandUse,
  describeCliCommands,
  expandCliCommand,
  loadCliCommands,
  parseCliCommandInvocation,
  resolveCliCommand,
  summarizeCliCommands,
} from "./commands.js";
import type { CustomCommand } from "../../../packages/web/src/lib/agentRuntime/customCommands.js";

const dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heming-cli-commands-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** 在工作区里写一条命令文件（自动建 `.heming/commands`）。 */
function workspaceWith(files: Record<string, string>): string {
  const dir = tmpDir();
  mkdirSync(path.join(dir, ".heming", "commands"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(dir, ".heming", "commands", name), text, "utf8");
  }
  return dir;
}

const REVIEW = "# 安全审查\n> 只挑能被利用的问题\n\n按威胁模型逐条过入口、权限、数据落点。\n";

function commandOf(overrides: Partial<CustomCommand> = {}): CustomCommand {
  return {
    name: "review",
    command: "/review",
    title: "安全审查",
    hint: "只挑能被利用的问题",
    prompt: "按威胁模型逐条过入口、权限、数据落点。",
    rel: ".heming/commands/review.md",
    truncated: false,
    ...overrides,
  };
}

describe("cliCommandsDir", () => {
  it("拼出绝对路径并统一正斜杠", () => {
    expect(cliCommandsDir("D:\\work\\proj")).toBe("D:/work/proj/.heming/commands");
  });
});

describe("loadCliCommands", () => {
  it("没有命令目录时返回 null（不是错误）", async () => {
    expect(await loadCliCommands(tmpDir())).toBeNull();
  });

  it("读出命令：名字取自文件名，标题与说明取自文件头", async () => {
    const dir = workspaceWith({ "review.md": REVIEW, "perf.md": "# 性能\n\n先量再改。\n" });
    const loaded = await loadCliCommands(dir);
    expect(loaded?.ok).toBe(true);
    const commands = loaded && loaded.ok ? loaded.commands : [];
    expect(commands.map((item) => item.command)).toEqual(["/perf", "/review"]);
    const review = commands.find((item) => item.name === "review");
    expect(review?.title).toBe("安全审查");
    expect(review?.hint).toBe("只挑能被利用的问题");
    expect(review?.prompt).toBe("按威胁模型逐条过入口、权限、数据落点。");
    expect(review?.rel).toBe(".heming/commands/review.md");
  });

  it("带 BOM 的文件也能认出标题（记事本 / PowerShell 5 的默认写法）", async () => {
    const dir = workspaceWith({ "review.md": `\uFEFF${REVIEW}` });
    const loaded = await loadCliCommands(dir);
    const review = loaded && loaded.ok ? loaded.commands[0] : undefined;
    expect(review?.title).toBe("安全审查");
    expect(review?.prompt).not.toContain("\uFEFF");
    expect(review?.prompt.startsWith("# ")).toBe(false);
  });

  it("跳过不是 .md 的、名字不合规的、以及只有标题没有正文的", async () => {
    const dir = workspaceWith({
      "review.md": REVIEW,
      "notes.txt": "不是命令",
      "Bad_Name.md": "# 名字不合规\n\n正文。\n",
      "empty.md": "# 只有标题\n",
    });
    const loaded = await loadCliCommands(dir);
    const commands = loaded && loaded.ok ? loaded.commands : [];
    expect(commands.map((item) => item.name)).toEqual(["review"]);
  });

  it("`.heming` 是同名文件时不抛错：当作没有命令，或给出可读错误", async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, ".heming"), "我是个文件", "utf8");
    const loaded = await loadCliCommands(dir);
    // Windows 对「中间路径是文件」报 ENOENT、POSIX 报 ENOTDIR：两种都不该炸，只要不当成有命令。
    const usable = loaded === null || !loaded.ok;
    expect(usable).toBe(true);
  });
});

describe("parseCliCommandInvocation", () => {
  it("认单条命令，也认后面带的补充说明", () => {
    expect(parseCliCommandInvocation("/review")).toEqual({ name: "review", args: "" });
    expect(parseCliCommandInvocation("/review src/login.ts")).toEqual({ name: "review", args: "src/login.ts" });
    expect(parseCliCommandInvocation("  /review   换个说法  ")).toEqual({ name: "review", args: "换个说法" });
  });

  it("名字大小写归一", () => {
    expect(parseCliCommandInvocation("/Review")?.name).toBe("review");
  });

  it("不像命令的不当命令：路径、数字开头、命令行中段出现", () => {
    expect(parseCliCommandInvocation("/usr/bin/foo")).toBeNull();
    expect(parseCliCommandInvocation("/1abc")).toBeNull();
    expect(parseCliCommandInvocation("/ review")).toBeNull();
    expect(parseCliCommandInvocation("看看 /review 这条命令")).toBeNull();
    expect(parseCliCommandInvocation("")).toBeNull();
  });

  it("名字合规但没定义时照样算一次命令调用（留给上层报错）", () => {
    expect(parseCliCommandInvocation("/reviwe")?.name).toBe("reviwe");
  });

  it("补充说明有长度上限", () => {
    const long = "x".repeat(CLI_COMMAND_ARGS_MAX + 50);
    expect(parseCliCommandInvocation(`/review ${long}`)?.args.length).toBe(CLI_COMMAND_ARGS_MAX);
  });

  it("截断说明时不劈开 emoji 的代理对", () => {
    // 一个 emoji 正好落在 2000 的边界上：按 UTF-16 slice 会留下孤立高位代理
    const args = "a".repeat(CLI_COMMAND_ARGS_MAX - 1) + "😀tail";
    const parsed = parseCliCommandInvocation(`/review ${args}`);
    // 按码点计正好 2000 个（1999 个 a + 1 个 emoji），不是按 UTF-16 单元
    expect(Array.from(parsed?.args ?? "").length).toBe(CLI_COMMAND_ARGS_MAX);
    // 边界上的 emoji 完整保留，没有劈成孤立代理
    expect(parsed?.args.endsWith("😀")).toBe(true);
  });
});

describe("expandCliCommand / resolveCliCommand", () => {
  it("没有补充说明就只发正文", () => {
    expect(expandCliCommand(commandOf(), "")).toBe("按威胁模型逐条过入口、权限、数据落点。");
  });

  it("有补充说明时空一行接在正文之后", () => {
    expect(expandCliCommand(commandOf(), "src/login.ts")).toBe(
      "按威胁模型逐条过入口、权限、数据落点。\n\nsrc/login.ts",
    );
  });

  it("命中命令时给出提示词与来源", () => {
    const resolved = resolveCliCommand({ name: "review", args: "" }, [commandOf()]);
    expect(resolved.ok).toBe(true);
    expect(resolved.ok ? resolved.command.rel : "").toBe(".heming/commands/review.md");
  });

  it("没定义时列出可用的命令", () => {
    const resolved = resolveCliCommand({ name: "reviwe", args: "" }, [commandOf(), commandOf({ name: "perf", command: "/perf" })]);
    expect(resolved.ok).toBe(false);
    expect(resolved.ok ? "" : resolved.error).toContain("没有这个命令：/reviwe");
    expect(resolved.ok ? "" : resolved.error).toContain("/review、/perf");
  });

  it("工作区还没有命令时说清怎么开一条", () => {
    const resolved = resolveCliCommand({ name: "review", args: "" }, []);
    expect(resolved.ok).toBe(false);
    expect(resolved.ok ? "" : resolved.error).toContain(".heming/commands/名字.md");
  });
});

describe("describeCliCommands / describeCliCommandUse / summarizeCliCommands", () => {
  it("没有命令目录时说清去哪写", () => {
    const text = describeCliCommands(null, "D:/work/proj");
    expect(text).toContain("还没有自定义命令");
    expect(text).toContain("D:/work/proj/.heming/commands");
  });

  it("目录读不出来时带出原因与路径", () => {
    const text = describeCliCommands({ ok: false, error: "不是目录", source: "D:/x/.heming/commands" }, "D:/x");
    expect(text).toContain("读不出来");
    expect(text).toContain("不是目录");
  });

  it("目录为空时提醒放一个文件进去", () => {
    expect(describeCliCommands({ ok: true, commands: [] }, "D:/x")).toContain("命令目录是空的");
  });

  it("有条目时列出命令、标题与来源文件", () => {
    const text = describeCliCommands({ ok: true, commands: [commandOf()] }, "D:/x");
    expect(text).toContain("共 1 条");
    expect(text).toContain("/review");
    expect(text).toContain("安全审查");
    expect(text).toContain(".heming/commands/review.md");
    expect(text).toContain("heming run /名字");
  });

  it("运行提示说清用了哪条命令、有没有接补充说明", () => {
    expect(describeCliCommandUse(commandOf(), "")).toContain("用的是工作区命令 /review");
    expect(describeCliCommandUse(commandOf(), "")).not.toContain("补充说明");
    expect(describeCliCommandUse(commandOf(), "src/a.ts")).toContain("补充说明");
  });

  it("摘要不含正文，方便 --json 给脚本用", () => {
    const [item] = summarizeCliCommands([commandOf()]);
    expect(item).toEqual({
      name: "review",
      command: "/review",
      title: "安全审查",
      hint: "只挑能被利用的问题",
      rel: ".heming/commands/review.md",
    });
  });
});