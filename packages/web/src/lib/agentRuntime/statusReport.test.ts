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

describe("系统通知状态（d.208）", () => {
  it("开着时说清「什么时候会提醒」，关着时给打开的办法", () => {
    const on = buildStatusReport({ notifyEnabled: true, desktop: true });
    expect(on).toContain("系统通知：开（窗口不在前台时，跑完 / 出错 / 等你确认会提醒，点通知回到会话）");
    const off = buildStatusReport({ notifyEnabled: false, desktop: true });
    expect(off).toContain("系统通知：关（发 /notify on 打开）");
    // 省略 = 按默认开处理（老调用点不用改）
    expect(buildStatusReport({ desktop: true })).toContain("系统通知：开");
  });
});

describe("会话改动台账（d.210）", () => {
  it("有改动时报个数并指路「查看改动」，没有时不占一行", () => {
    const withChanges = buildStatusReport({ sessionChanges: 3, desktop: true });
    expect(withChanges).toContain("本会话改动：3 个文件（点输入框上方的「查看改动」逐行对照）");
    expect(buildStatusReport({ sessionChanges: 0, desktop: true })).not.toContain("本会话改动");
    expect(buildStatusReport({ desktop: true })).not.toContain("本会话改动");
  });
});

describe("上下文校准（d.215）", () => {
  it("按实测校准过就在上下文那行注明", () => {
    const text = buildStatusReport({ desktop: true, context: { used: 12_000, budget: 25_000, calibrated: true } });
    expect(text).toContain("上下文：约 12000 / 25000 tokens（48%）（已按实测校准）");
  });

  it("没校准（或没这个字段）时不加这句话", () => {
    const text = buildStatusReport({ desktop: true, context: { used: 12_000, budget: 25_000 } });
    expect(text).toContain("上下文：约 12000 / 25000 tokens（48%）");
    expect(text).not.toContain("已按实测校准");
  });
});
describe("压缩这件事要说出「原文没删」（d.217）", () => {
  const base = {
    version: "d.216.4.109.12",
    model: "和小鸣",
    workspace: "D:/剧库",
    roots: [{ name: "剧库", path: "D:/剧库", mode: "write" as const }],
    context: { used: 12_000, budget: 32_000 },
  };

  it("折过就说折了几条、多久以前，并明说原文没删", () => {
    const text = buildStatusReport({ ...base, contextFold: { foldedCount: 18, ageMinutes: 3 } });
    expect(text).toContain("上次压缩：折叠 18 条（3 分钟前）");
    expect(text).toContain("会话原文一条没删");
    expect(text).toContain("模型看到的是摘要");
  });

  it("没折过、或条数为 0 时不出这一行（不吓人）", () => {
    expect(buildStatusReport({ ...base })).not.toContain("上次压缩");
    expect(buildStatusReport({ ...base, contextFold: null })).not.toContain("上次压缩");
    expect(buildStatusReport({ ...base, contextFold: { foldedCount: 0, ageMinutes: 1 } })).not.toContain("上次压缩");
  });
});

describe("项目约定读到了什么，要说出来（d.219）", () => {
  const base = {
    version: "d.218.4.109.12",
    model: "和小鸣",
    workspace: "D:/剧库",
    roots: [{ name: "剧库", path: "D:/剧库", mode: "write" as const }],
  };

  it("读到就列文件名与字数", () => {
    const text = buildStatusReport({
      ...base,
      projectRules: { files: [{ rel: "AGENTS.md", chars: 812, truncated: false }], omitted: 0 },
    });
    expect(text).toContain("项目约定：AGENTS.md（812 字）");
  });

  it("被截断、被总量上限省略的都要标出来", () => {
    const text = buildStatusReport({
      ...base,
      projectRules: {
        files: [
          { rel: "AGENTS.md", chars: 4000, truncated: true },
          { rel: ".heming/rules.md", chars: 2400, truncated: false },
        ],
        omitted: 1,
      },
    });
    expect(text).toContain("AGENTS.md（4.0K 字，已截断）");
    expect(text).toContain(".heming/rules.md（2.4K 字）");
    expect(text).toContain("还有 1 份没展开");
  });

  it("没有约定文件时说「无」，并指一条路（/init）", () => {
    for (const projectRules of [
      null,
      { files: [], omitted: 0 },
    ] as const) {
      const text = buildStatusReport({ ...base, projectRules });
      expect(text).toContain("项目约定：无");
      expect(text).toContain("/init");
    }
  });

  it("还没跑过一轮时说「尚未统计」，不把不知道说成没有", () => {
    const text = buildStatusReport({ ...base });
    expect(text).toContain("项目约定：尚未统计");
    expect(text).not.toContain("项目约定：无");
  });
});

describe("工具失败归因（d.221）", () => {
  const base = {
    version: "d.221.4.109.12",
    model: "和小鸣",
    workspace: "D:/剧库",
    roots: [{ name: "剧库", path: "D:/剧库", mode: "write" as const }],
  };

  it("失败过就按错误码列次数，并说哪个工具出错最多", () => {
    const text = buildStatusReport({
      ...base,
      toolFailures: {
        total: 3,
        codes: [
          { code: "path-escape", count: 2 },
          { code: "match-failed", count: 1 },
        ],
        tools: [{ code: "file_write", count: 2 }],
        dropped: 0,
      },
    });
    expect(text).toContain("工具失败：本会话 3 次（path-escape ×2、match-failed ×1）");
    expect(text).toContain("出错最多的是 file_write（2 次）");
  });

  it("错误码太多时只列前三个，并说还有几种没列", () => {
    const text = buildStatusReport({
      ...base,
      toolFailures: {
        total: 6,
        codes: [
          { code: "a-code", count: 3 },
          { code: "b-code", count: 1 },
          { code: "c-code", count: 1 },
          { code: "d-code", count: 1 },
        ],
        tools: [],
        dropped: 0,
      },
    });
    expect(text).toContain("a-code ×3、b-code ×1、c-code ×1");
    expect(text).toContain("还有 1 种没列");
    expect(text).not.toContain("d-code");
  });

  it("没有失败时整行不出现（不写「0 次」占位）", () => {
    const text = buildStatusReport({ ...base });
    expect(text).not.toContain("工具失败：");
  });
});

describe("MCP 连接没连上要说清（d.223）", () => {
  const base = { desktop: true } as const;

  it("一个服务都没配置时说「没有配置服务」", () => {
    const text = buildStatusReport({
      ...base,
      mcp: { total: 0, enabled: 0, connected: 0, failed: [], pending: 0, tools: 0 },
    });
    expect(text).toContain("MCP：没有配置服务");
  });

  it("全部连上时只给结论与工具数", () => {
    const text = buildStatusReport({
      ...base,
      mcp: { total: 2, enabled: 2, connected: 2, failed: [], pending: 0, tools: 7 },
    });
    expect(text).toContain("MCP：2 个服务都已连接（共 7 个 MCP 工具可用）。");
  });

  it("没连上的服务点名 + 带原因 + 指出去哪儿修", () => {
    const text = buildStatusReport({
      ...base,
      mcp: {
        total: 2,
        enabled: 2,
        connected: 1,
        failed: [{ name: "爬虫", state: "error", error: "连接超时" }],
        pending: 0,
        tools: 3,
      },
    });
    expect(text).toContain("1 个没连上：爬虫（连接超时）");
    expect(text).toContain("「能力 → MCP」");
    expect(text).toContain("调了会失败");
  });

  it("还没连过的单独说「还没连过」，不说成失败", () => {
    const text = buildStatusReport({
      ...base,
      mcp: { total: 1, enabled: 1, connected: 0, failed: [], pending: 1, tools: 0 },
    });
    expect(text).toContain("1 个还没连过");
    expect(text).not.toContain("没连上：");
  });

  it("服务全停用时说明停用，不说「没连上」", () => {
    const text = buildStatusReport({
      ...base,
      mcp: { total: 3, enabled: 0, connected: 0, failed: [], pending: 0, tools: 0 },
    });
    expect(text).toContain("3 个服务都已停用");
  });

  it("不给 mcp 快照就不出这一行（浏览器环境 / 老调用点）", () => {
    expect(buildStatusReport({ ...base })).not.toContain("MCP：");
  });
});

describe("工具目录与按需发现（d.224）", () => {
  const base = {
    version: "d.223.4.109.12",
    model: "和小鸣",
    workspace: "D:/剧库",
  };

  it("没超阈值时只说数量，不提按需发现", () => {
    const text = buildStatusReport({
      ...base,
      tools: { count: 12, core: 5, discovery: false, visible: 20, threshold: 20 },
    });
    expect(text).toContain("本轮工具：共 12 个（其中核心 5 个常驻）");
    expect(text).not.toContain("按需发现");
  });

  it("超阈值时说明「先给约几个 + tool_search」，并指出怎么让它直接可用", () => {
    const text = buildStatusReport({
      ...base,
      tools: { count: 34, core: 15, discovery: true, visible: 20, threshold: 20 },
    });
    expect(text).toContain("本轮工具：共 34 个（其中核心 15 个常驻）");
    expect(text).toContain("超过 20 个");
    expect(text).toContain("按需发现");
    expect(text).toContain("先给约 20 个");
    expect(text).toContain("tool_search");
    expect(text).toContain("停用不用的服务");
  });

  it("没给阈值与可见数时按 20 兜底，不写出 0 或 undefined", () => {
    const text = buildStatusReport({ ...base, tools: { count: 25, core: 15, discovery: true } });
    expect(text).toContain("超过 20 个");
    expect(text).toContain("先给约 20 个");
    expect(text).not.toContain("undefined");
  });
});

describe("本会话用量行（d.230）", () => {
  const base = {
    version: "d.229.4.115.12",
    model: "和小鸣",
    workspace: "D:/剧库",
  };

  it("把轮数与输入/输出/合成都说清，并压成 K/M", () => {
    const text = buildStatusReport({
      ...base,
      usage: { runs: 12, input: 34_200, output: 8_100, total: 42_300, unreported: 0 },
    });
    expect(text).toContain("本会话用量：12 轮");
    expect(text).toContain("输入 34.2K / 输出 8.1K tokens");
    expect(text).toContain("合计 42.3K");
    expect(text).not.toContain("没上报");
  });

  it("供应商有轮次没上报时如实附上，不并进数字也不说成 0", () => {
    const text = buildStatusReport({
      ...base,
      usage: { runs: 3, input: 900, output: 300, total: 1_200, unreported: 2 },
    });
    expect(text).toContain("本会话用量：3 轮");
    expect(text).toContain("另有 2 轮供应商没上报用量");
  });

  it("一次都没上报时明说无法统计", () => {
    const text = buildStatusReport({
      ...base,
      usage: { runs: 3, input: 0, output: 0, total: 0, unreported: 3 },
    });
    expect(text).toContain("3 轮（供应商没有上报用量，无法统计）");
  });

  it("还没跑过（省略快照或 runs 为 0）时不出这一行", () => {
    expect(buildStatusReport(base)).not.toContain("本会话用量");
    expect(
      buildStatusReport({ ...base, usage: { runs: 0, input: 0, output: 0, total: 0, unreported: 0 } }),
    ).not.toContain("本会话用量");
    expect(
      buildStatusReport({ ...base, usage: { runs: 1, input: 0, output: 0, total: 0, unreported: 1 } }),
    ).toContain("本会话用量");
  });
});
