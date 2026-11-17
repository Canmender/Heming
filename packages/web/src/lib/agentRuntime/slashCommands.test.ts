import { describe, expect, it } from "vitest";
import {
  GOAL_COMMAND,
  HELP_COMMAND,
  INIT_COMMAND,
  PLAN_COMMAND,
  SLASH_COMMANDS,
  NOTIFY_COMMAND,
  STATUS_COMMAND,
  SUBAGENT_COMMAND,
  matchSlashCommands,
  slashQuery,
} from "./slashCommands.js";

describe("输入框命令面板（d.184）", () => {
  it("只打了个 / 就把命令全列出来", () => {
    expect(slashQuery("/")).toBe("");
    const items = matchSlashCommands("/");
    expect(items.length).toBeGreaterThanOrEqual(4);
    expect(items.map((i) => i.command)).toContain("/compact");
    expect(items.map((i) => i.command)).toContain(PLAN_COMMAND);
    // d.193：自检与帮助也要能在这里发现
    expect(items.map((i) => i.command)).toContain(STATUS_COMMAND);
    expect(items.map((i) => i.command)).toContain(HELP_COMMAND);
    // d.201：目标设定同样要能被发现（否则用户永远只知道清单）
    expect(items.map((i) => i.command)).toContain(GOAL_COMMAND);
    // d.202：子代理写盘授权默认关，但入口要能被发现
    expect(items.map((i) => i.command)).toContain(SUBAGENT_COMMAND);
    // d.208：系统通知开关
    expect(items.map((i) => i.command)).toContain(NOTIFY_COMMAND);
    // d.219：让它摸清仓库写 AGENTS.md
    expect(items.map((i) => i.command)).toContain(INIT_COMMAND);
  });

  it("/init 的说明要点明它会写 AGENTS.md 且不覆盖手写内容（d.219）", () => {
    const init = SLASH_COMMANDS.find((item) => item.command === INIT_COMMAND);
    expect(init).toBeDefined();
    expect(init!.hint).toContain("AGENTS.md");
    expect(init!.hint).toContain("合并");
  });

  it("按前缀过滤，且大小写不敏感", () => {
    expect(matchSlashCommands("/com").map((i) => i.command)).toEqual(["/compact"]);
    expect(matchSlashCommands("/PL").map((i) => i.command)).toEqual([PLAN_COMMAND]);
    expect(matchSlashCommands("/zzz")).toEqual([]);
  });

  it("正常消息里的斜杠不弹面板", () => {
    // 路径、日期、分数：都不该被当成命令
    expect(matchSlashCommands("看一下 /docs 目录")).toEqual([]);
    expect(matchSlashCommands("1/2 的平均值")).toEqual([]);
    expect(matchSlashCommands("")).toEqual([]);
  });

  it("多行输入不弹面板（第二行以 / 开头也不行）", () => {
    expect(slashQuery("/compact\n第二行")).toBeNull();
    expect(matchSlashCommands("/compact\n第二行")).toEqual([]);
  });

  it("打完整命令加空格后不再弹面板（那时是在发命令本身）", () => {
    expect(slashQuery("/compact ")).toBeNull();
    expect(matchSlashCommands("/compact ")).toEqual([]);
  });

  it("每个命令都有标题与说明，面板不出现空白行", () => {
    for (const item of SLASH_COMMANDS) {
      expect(item.command.startsWith("/")).toBe(true);
      expect(item.command.trim()).toBe(item.command);
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.hint.length).toBeGreaterThan(0);
    }
  });
});
