import { describe, expect, it } from "vitest";
import { INIT_PROMPT, expandInitCommand } from "./initPrompt.js";
import { INIT_COMMAND } from "./slashCommands.js";

describe("`/init` 的任务描述（d.219）", () => {
  it("/init 换成一段任务描述；其它文本原样不动", () => {
    expect(expandInitCommand("/init")).toBe(INIT_PROMPT);
    expect(expandInitCommand("  /init  ")).toBe(INIT_PROMPT);
    expect(expandInitCommand("/init 帮我看看")).toBeNull();
    expect(expandInitCommand("看一下 /init 是什么")).toBeNull();
    expect(expandInitCommand("")).toBeNull();
  });

  it("命令名与面板里的那一条同源（不各写一个字符串）", () => {
    expect(INIT_COMMAND).toBe("/init");
    expect(expandInitCommand(INIT_COMMAND)).toBe(INIT_PROMPT);
  });

  it("提示词要求「先读再写」并点名要读的文件", () => {
    // 不读就写会写出「这个仓库里不存在的命令」，这是踩过的坑
    expect(INIT_PROMPT).toContain("file_glob");
    expect(INIT_PROMPT).toContain("file_read");
    expect(INIT_PROMPT).toContain("README");
    expect(INIT_PROMPT).toContain("package.json");
  });

  it("提示词要求合并不覆盖，且篇幅封顶", () => {
    expect(INIT_PROMPT).toContain("先 file_read 读一遍");
    expect(INIT_PROMPT).toContain("不要覆盖");
    expect(INIT_PROMPT).toContain("200 行");
  });

  it("提示词限定只写 AGENTS.md 一个文件（不许顺手改别的）", () => {
    expect(INIT_PROMPT).toContain("不要改其它任何文件");
    expect(INIT_PROMPT).toContain("AGENTS.md");
  });
});
