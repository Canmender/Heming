import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS } from "./slashCommands.js";
import { buildSlashHelp, buildStatusReport } from "./statusReport.js";

describe("环境自检 `/status`（d.193）", () => {
  it("把模型、工作区、可写目录、预算、清单、作业、可撤回都列成可核对的行", () => {
    const text = buildStatusReport({
      version: "d.193.4.105.12",
      model: "DeepSeek V4",
      modelWindow: 1_048_576,
      vision: true,
      workspace: "D:/Heming",
      roots: [
        { name: "工作区", path: "D:/Heming", mode: "write" },
        { name: "只读资料", path: "E:/docs", mode: "read" },
      ],
      planMode: true,
      context: { used: 12_400, budget: 25_900 },
      todos: [
        { status: "completed" },
        { status: "in_progress" },
        { status: "pending" },
      ],
      jobs: { running: 1, total: 2 },
      writes: 2,
      resumePending: true,
      busy: true,
      tools: { count: 9, core: 7 },
      desktop: true,
    });
    expect(text.startsWith("环境自检 · 和鸣 d.193.4.105.12")).toBe(true);
    expect(text).toContain("模型：DeepSeek V4（窗口 1049K、可读图）");
    expect(text).toContain("工作区：D:/Heming");
    expect(text).toContain("可写目录：1 个");
    expect(text).toContain("另有 1 个只读");
    expect(text).toContain("计划模式：开（只读，先给方案）");
    expect(text).toContain("上下文：约 12400 / 25900 tokens（48%）");
    expect(text).toContain("任务清单：1/3 已完成，1 项进行中");
    expect(text).toContain("后台作业：1 条在跑（共 2 条）");
    expect(text).toContain("可撤回改动：2 个文件");
    expect(text).toContain("还有没跑完的一轮：有");
    expect(text).toContain("本轮工具：共 9 个（其中核心 7 个常驻）");
    expect(text).toContain("正在跑：是");
  });

  it("没有模型绑定时说清「工具不会被调用」，而不是只写一个空值", () => {
    const text = buildStatusReport({ model: "" });
    expect(text).toContain("模型：未绑定");
    expect(text).not.toContain("模型：（");
    expect(text).toContain("正在跑：否");
  });

  it("没有可写根时明说写类工具不会被注入（用户投诉过的场景）", () => {
    const text = buildStatusReport({ roots: [] });
    expect(text).toContain("可写目录：0 个（没有可写根，写类工具不会被注入）");
  });

  it("浏览器里没有桌面桥时说明没有本机能力", () => {
    const text = buildStatusReport({ desktop: false });
    expect(text).toContain("桌面端：未连接");
  });

  it("上下文接近上限时提示可以 /compact", () => {
    expect(buildStatusReport({ context: { used: 900, budget: 1000 } })).toContain("可以发 /compact");
    // 不到 80% 就不啰嗦
    expect(buildStatusReport({ context: { used: 500, budget: 1000 } })).not.toContain("/compact");
  });

  it("长路径中间省略，不让一行被一条路径撑爆", () => {
    const long = `C:/${"a".repeat(120)}/tail.txt`;
    const text = buildStatusReport({ roots: [{ name: "长", path: long, mode: "write" }] });
    expect(text).toContain("…");
    expect(text).not.toContain(long);
    expect(text).toContain("tail.txt");
  });

  it("空清单与无作业如实写「空 / 无」，不编造进度", () => {
    const text = buildStatusReport({ todos: [], jobs: null, writes: 0 });
    expect(text).toContain("任务清单：空");
    expect(text).toContain("后台作业：无");
    expect(text).toContain("可撤回改动：无");
  });

  it("`/help` 与命令面板同源，命令一个不漏", () => {
    const text = buildSlashHelp();
    for (const item of SLASH_COMMANDS) {
      expect(text).toContain(item.command);
      expect(text).toContain(item.title);
    }
    expect(text).toContain("不会发给模型");
  });
});
