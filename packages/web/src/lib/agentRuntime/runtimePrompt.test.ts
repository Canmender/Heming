import { describe, it, expect } from "vitest";
import {
  CAPABILITY_SECTION_MAX_CHARS,
  MAX_LISTED_TOOLS,
  type RuntimeSectionInput,
  RUNTIME_HEADING,
  buildRuntimeSection,
  capabilitySection,
  describePlatform,
  formatLocalTime,
} from "./runtimePrompt.js";

const NOW = new Date("2026-11-15T14:45:00Z");

describe("describePlatform", () => {
  it("认得 Windows 10/11，也认得 macOS/Linux", () => {
    expect(describePlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows 10/11");
    expect(describePlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macOS");
    expect(describePlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Linux");
  });

  it("认不出或空 UA 时不猜（空串/未知系统），绝不写死 Windows", () => {
    expect(describePlatform("")).toBe("");
    expect(describePlatform(undefined)).toBe("");
    expect(describePlatform("SomeAgent/1.0")).toBe("未知系统");
  });
});

describe("formatLocalTime", () => {
  it("按给定时区渲染分钟级本地时间", () => {
    expect(formatLocalTime(NOW, "Asia/Shanghai")).toBe("2026-11-15 22:45");
    expect(formatLocalTime(NOW, "UTC")).toBe("2026-11-15 14:45");
  });

  it("时区非法时回落本地时区，不抛错", () => {
    expect(formatLocalTime(NOW, "Not/AZone")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe("buildRuntimeSection", () => {
  const base: RuntimeSectionInput = {
    desktop: true,
    platform: "Windows 10/11",
    now: NOW,
    timeZone: "Asia/Shanghai",
    workspace: "D:/项目/和鸣",
    roots: [{ name: "工作区", path: "D:/项目/和鸣", mode: "write" }],
  };

  it("桌面端写清楚：能改本机文件、系统、时间、工作区", () => {
    const text = buildRuntimeSection(base);
    expect(text).toContain(RUNTIME_HEADING);
    expect(text).toContain("桌面智能体");
    expect(text).toContain("系统：Windows 10/11");
    expect(text).toContain("2026-11-15 22:45");
    expect(text).toContain("Asia/Shanghai");
    expect(text).toContain("D:/项目/和鸣");
    expect(text).not.toContain("没有可写目录");
  });

  it("浏览器端不宣称能改本机文件", () => {
    const text = buildRuntimeSection({ desktop: false, platform: "Windows 10/11" });
    expect(text).toContain("没有桌面文件桥");
    expect(text).not.toContain("会真的改本机文件");
  });

  it("列出可写/只读目录，只读要标注，超过 6 条折成「另有 N 个」", () => {
    const roots = [
      { name: "工作区", path: "D:/项目/和鸣", mode: "write" as const },
      { name: "配置只读", path: "D:/资料", mode: "read" as const },
      ...Array.from({ length: 5 }, (_, i) => ({ name: `根${i}`, path: `D:/r${i}`, mode: "write" as const })),
    ];
    const text = buildRuntimeSection({ ...base, roots });
    expect(text).toContain("工作区（D:/项目/和鸣）");
    expect(text).toContain("配置只读（D:/资料，只读）");
    expect(text).toContain("另有 1 个");
  });

  it("桌面端没有任何根时明说「没有可写目录」，不许假装写入", () => {
    const text = buildRuntimeSection({ ...base, roots: [] });
    expect(text).toContain("当前没有可写目录");
    expect(text).toContain("不要假装已经写入");
  });

  it("工具清单逐条列出（含中文名与读写风险），超过上限折叠并可提示 tool_search", () => {
    const tools = [
      { name: "file_read", title: "读取文件", risk: "read" as const },
      { name: "file_write", title: "写入文件", risk: "write" as const },
    ];
    const text = buildRuntimeSection({ ...base, tools, toolSearchAvailable: true });
    expect(text).toContain("## 本轮可用工具（共 2 个）");
    expect(text).toContain("- file_read（读取文件）·读");
    expect(text).toContain("- file_write（写入文件）·写");

    const many = Array.from({ length: MAX_LISTED_TOOLS + 3 }, (_, i) => ({ name: `t${i}` }));
    const folded = buildRuntimeSection({ ...base, tools: many, toolSearchAvailable: true });
    expect(folded).toContain(`还有 3 个工具没有列出`);
    expect(folded).toContain("tool_search");
  });

  it("零工具时明确说这一轮没有工具，并指路设置，而不是编造结果", () => {
    const text = buildRuntimeSection({ ...base, tools: [] });
    expect(text).toContain("## 本轮可用工具（0 个）");
    expect(text).toContain("不要编造查询结果");
  });

  it("写了工具轮次上限，并给出「已完成/未完成/下一步」的收口要求", () => {
    const text = buildRuntimeSection({ ...base, tools: [], maxToolRounds: 12 });
    expect(text).toContain("最多 12 次工具往返");
    expect(text).toContain("已完成 / 未完成 / 下一步");
  });

  it("有任务清单工具时才承诺「到顶自动续跑」，且不再让用户催继续（d.157）", () => {
    const todos = [{ name: "todo_write", title: "更新任务清单", risk: "read" as const }];
    const withoutTodo = buildRuntimeSection({ ...base, tools: [], maxToolRounds: 12 });
    expect(withoutTodo).not.toContain("自动接着做");

    const withTodo = buildRuntimeSection({ ...base, tools: todos, maxToolRounds: 12 });
    expect(withTodo).toContain("自动接着做");
    expect(withTodo).toContain("36 轮");
  });

  it("注入了 todo_write 才提任务清单：没注入就不承诺（d.154）", () => {
    const without = buildRuntimeSection({ ...base, tools: [] });
    expect(without).not.toContain("todo_write");

    const withTodo = buildRuntimeSection({
      ...base,
      tools: [{ name: "todo_write", title: "更新任务清单", risk: "read" as const }],
    });
    expect(withTodo).toContain("todo_write");
    expect(withTodo).toContain("多步任务");
  });

  it("长任务段始终要求「先验证再声称完成」", () => {
    const text = buildRuntimeSection({ ...base });
    expect(text).toContain("## 长任务怎么处理");
    expect(text).toContain("未验证");
    expect(text).toContain("需要多步就直接开始");
  });

  it("注入了 agent_task 才提子代理：没注入就不承诺（d.162）", () => {
    const subagent = [{ name: "agent_task", title: "派子代理", risk: "read" as const }];
    const without = buildRuntimeSection({ ...base, tools: [] });
    expect(without).not.toContain("agent_task");

    const withTool = buildRuntimeSection({ ...base, tools: subagent });
    expect(withTool).toContain("agent_task");
    // 提示词要说清「为什么用它」：把原文留给子代理，别拉进主对话
    expect(withTool).toContain("只读子代理");
    expect(withTool).toContain("原文");
  });

  it("注入了 run_command 才提命令，并且提前说清「要先请用户确认」（d.164）", () => {
    const shell = [{ name: "run_command", title: "运行命令", risk: "write" as const }];
    const without = buildRuntimeSection({ ...base, tools: [] });
    expect(without).not.toContain("run_command");

    const withTool = buildRuntimeSection({ ...base, tools: shell });
    expect(withTool).toContain("run_command");
    // 「等用户点确认」这件事必须提前说，否则模型会把它当成卡死、转而编输出
    expect(withTool).toContain("请用户确认");
    expect(withTool).toContain("不要原样重跑");
  });
});

describe("读图提示（d.168）", () => {
  const base = {
    desktop: true as const,
    roots: [{ name: "库", path: "D:/库", mode: "write" as const }],
  };

  it("注入了 file_image 才提「直接打开看」", () => {
    const withImage = buildRuntimeSection({
      ...base,
      tools: [{ name: "file_image", title: "查看图片", risk: "read" as const }],
    });
    expect(withImage).toContain("file_image");
    expect(withImage).toContain("直接打开看");
    expect(withImage).toContain("不要凭文件名猜内容");
  });

  it("没有 file_image 时不承诺这个能力（浏览器端/老安装包）", () => {
    const without = buildRuntimeSection({
      ...base,
      tools: [{ name: "file_read", title: "读取文件", risk: "read" as const }],
    });
    expect(without).not.toContain("file_image");
    expect(without).not.toContain("直接打开看");
  });
});

describe("撤销提示（d.170）", () => {
  it("没注入 file_undo 时不提撤销，避免承诺一个调不到的工具", () => {
    const text = buildRuntimeSection({ tools: [{ name: "file_read", risk: "read" }] });
    expect(text).not.toContain("file_undo");
  });

  it("注入了 file_undo 才告诉模型「改错了可以回滚」并说明备份只能用一次", () => {
    const text = buildRuntimeSection({ tools: [{ name: "file_undo", risk: "write" }] });
    expect(text).toContain("file_undo");
    expect(text).toContain("一份备份只能用一次");
  });
});

describe("计划模式（d.173）", () => {
  const readOnly = [{ name: "file_read", risk: "read" as const }];

  it("开了计划模式：明说「只读不改」，并说明写工具是用户选的、不是权限坏了", () => {
    const text = buildRuntimeSection({ tools: readOnly, planMode: true });
    expect(text).toContain("## 计划模式（本轮只读，不改东西）");
    expect(text).toContain("不要调用、也不要假装已经改了");
    expect(text).toContain("不是权限坏了，是用户选的");
  });

  it("没开（或没传）时不含这一段：普通对话不能以为自己只读", () => {
    expect(buildRuntimeSection({ tools: readOnly })).not.toContain("## 计划模式");
    expect(buildRuntimeSection({ tools: readOnly, planMode: false })).not.toContain("## 计划模式");
  });
});

describe("后台作业提示（d.180）", () => {
  const shell = [{ name: "run_command", risk: "write" as const }];

  it("桥有后台通道时才教 background:true（老桌面端只会回 bridge-missing）", () => {
    const withJobs = buildRuntimeSection({ tools: shell, hasBackgroundJobs: true });
    expect(withJobs).toContain("`background: true`");
    expect(withJobs).toContain("command_output");
    expect(withJobs).toContain("120 秒超时");
    // 没注入 run_command 时也不能凭 hasBackgroundJobs 就写这一段
    expect(buildRuntimeSection({ tools: [], hasBackgroundJobs: true })).not.toContain("`background: true`");
  });

  it("不传 / false 时逐字不变（老安装包的提示词不能因为升级代码而改）", () => {
    const baseline = buildRuntimeSection({ tools: shell });
    expect(buildRuntimeSection({ tools: shell, hasBackgroundJobs: false })).toBe(baseline);
    expect(baseline).not.toContain("command_output");
    expect(baseline).not.toContain("background");
  });
});

describe("当前任务清单回灌（d.192）", () => {
  const base = { now: new Date("2026-11-16T00:00:00Z"), timeZone: "UTC" };

  it("有清单时列出进度与每条状态，并说明「以这条为基线」", () => {
    const text = buildRuntimeSection({
      ...base,
      todos: [
        { content: "读三份文档", status: "completed" },
        { content: "改 config.md", status: "in_progress" },
        { content: "跑测试", status: "pending" },
      ],
    });
    expect(text).toContain("## 当前任务清单（1/3 已完成，1 项进行中）");
    expect(text).toContain("- [x] 读三份文档");
    expect(text).toContain("- [>] 改 config.md");
    expect(text).toContain("- [ ] 跑测试");
    expect(text).toContain("以这条清单为进度基线");
    expect(text).toContain("已经完成的不要再做一遍");
  });

  it("清单为空/没传时完全不出现这一段（普通对话不该多一句）", () => {
    expect(buildRuntimeSection(base)).not.toContain("当前任务清单");
    expect(buildRuntimeSection({ ...base, todos: [] })).not.toContain("当前任务清单");
    // 只有空白内容的条目等于没有
    expect(buildRuntimeSection({ ...base, todos: [{ content: "  ", status: "pending" }] })).not.toContain(
      "当前任务清单",
    );
  });

  it("超过上限时只列前 20 条，并说明还有几项", () => {
    const todos = Array.from({ length: 23 }, (_, i) => ({
      content: `步骤 ${i + 1}`,
      status: "pending" as const,
    }));
    const text = buildRuntimeSection({ ...base, todos });
    expect(text).toContain("0/23 已完成");
    expect(text).toContain("- [ ] 步骤 20");
    expect(text).not.toContain("步骤 21");
    expect(text).toContain("另有 3 项未列出");
  });
});

describe("长输出再读（d.181）", () => {
  it("注入了 tool_output_read 才提 spill handle；没注入时不提", () => {
    const base = { now: new Date("2026-11-16T00:00:00Z"), timeZone: "UTC" };
    const withTool = buildRuntimeSection({
      ...base,
      tools: [{ name: "tool_output_read", risk: "read" as const }],
    });
    expect(withTool).toContain("spill-<数字>");
    expect(withTool).toContain("tool_output_read");

    const without = buildRuntimeSection({ ...base, tools: [{ name: "file_read", risk: "read" as const }] });
    expect(without).not.toContain("spill-<数字>");
  });
});

describe("当前目标（d.201）", () => {
  const base = { now: new Date("2026-11-16T00:00:00Z"), timeZone: "UTC" };

  it("有目标才写这一段，且写在任务清单之前（先终点、后步骤）", () => {
    const text = buildRuntimeSection({
      ...base,
      goal: "把登录改成扫码",
      todos: [{ content: "读登录页", status: "pending" }],
    });
    expect(text).toContain("## 当前目标（跨轮保持）");
    expect(text).toContain("目标：把登录改成扫码");
    expect(text).toContain("清单全做完 ≠ 目标完成");
    expect(text.indexOf("## 当前目标")).toBeLessThan(text.indexOf("## 当前任务清单"));
  });

  it("没有目标（或只有空白）时完全不写，输出与原来一致", () => {
    const without = buildRuntimeSection({ ...base, tools: [] });
    expect(buildRuntimeSection({ ...base, tools: [], goal: "" })).toBe(without);
    expect(buildRuntimeSection({ ...base, tools: [], goal: "   " })).toBe(without);
    expect(without).not.toContain("当前目标");
  });
});

describe("能力与配合（d.241）", () => {
  const base = { now: new Date("2026-11-17T00:00:00Z"), timeZone: "UTC" };

  it("有知识库工具时点名「先检索再回答」与出处", () => {
    const text = buildRuntimeSection({
      ...base,
      capabilities: {
        knowledgeBaseTools: ["vault_search", "vault_read", "vault_write"],
      },
    });
    expect(text).toContain("## 能力与配合");
    expect(text).toContain("vault_search");
    expect(text).toContain("先检索再回答");
    expect(text).toContain("文件名或页面名");
    // 可写时才提 vault_write（不可写却提示「去写」会误导）
    expect(text).toContain("vault_write");
  });

  it("知识库只读时不提写入", () => {
    const text = buildRuntimeSection({
      ...base,
      capabilities: { knowledgeBaseTools: ["vault_search", "vault_read"] },
    });
    expect(text).toContain("先检索再回答");
    expect(text).not.toContain("vault_write");
  });

  it("刚装/刚升级的插件逐条点名，并教它「找不到工具就先检索」", () => {
    const text = buildRuntimeSection({
      ...base,
      capabilities: {
        newPlugins: [
          {
            name: "图表增强",
            version: "1.2.0",
            updated: true,
            servers: ["plugin:com.example.charts:charts", "plugin:com.example.charts:export"],
            skills: ["画图"],
          },
          { name: "日报助手", version: "0.3.0", updated: false },
        ],
      },
    });
    expect(text).toContain("「图表增强」v1.2.0（升级）");
    expect(text).toContain("「日报助手」v0.3.0（新装）");
    expect(text).toContain("贡献 2 个工具服务");
    expect(text).toContain("1 个技能（画图）");
    expect(text).toContain("tool_search 搜「图表增强」");
    expect(text).toContain("不要因为没认出来就说自己没有这个能力");
  });

  it("团队与插件市场各写一条用法，且市场那条不许把预览说成装好", () => {
    const text = buildRuntimeSection({
      ...base,
      capabilities: {
        teamTools: ["team_list", "team_assign", "team_status"],
        pluginMarketTools: ["plugin_market_search", "plugin_market_install_preview"],
      },
    });
    expect(text).toContain("team_list");
    expect(text).toContain("不知道团队 id 就先 team_list");
    expect(text).toContain("plugin_market_search");
    expect(text).toContain("不要把「预览过」说成「装好了」");
  });

  it("没有可写内容时整段不出现，输出与加这个字段之前逐字相同", () => {
    const without = buildRuntimeSection({ ...base, tools: [] });
    expect(buildRuntimeSection({ ...base, tools: [], capabilities: {} })).toBe(without);
    expect(buildRuntimeSection({ ...base, tools: [], capabilities: { newPlugins: [] } })).toBe(
      without,
    );
    expect(without).not.toContain("能力与配合");
  });

  it("超长时按行截断并留一句说明，不会吃掉整段提示词预算", () => {
    const newPlugins = Array.from({ length: 12 }, (_, index) => ({
      name: `很长的插件名字第${index}号`,
      version: "1.0.0",
      servers: Array.from({ length: 6 }, (_, key) => `plugin:com.example.${index}:service-${key}`),
      skills: ["技能甲", "技能乙"],
    }));
    const lines = capabilitySection({ ...base, capabilities: { newPlugins } });
    const text = lines.join("\n");
    expect(text.length).toBeLessThanOrEqual(CAPABILITY_SECTION_MAX_CHARS);
    expect(text).toContain("因长度上限省略");
    // 标题必须留着，否则后面那条说明就成了孤句。
    expect(lines[0]).toContain("## 能力与配合");
  });
});

describe("团队派给我的任务（d.248）", () => {
  const base = (over: Partial<RuntimeSectionInput> = {}): RuntimeSectionInput => ({
    desktop: true,
    platform: "Windows 11",
    now: new Date("2026-11-17T10:00:00+08:00"),
    workspace: "D:/proj",
    tools: [{ name: "team_get" }, { name: "team_task_update" }],
    ...over,
  });

  it("列出任务行，并写清先看详情、做完改状态", () => {
    const text = buildRuntimeSection(
      base({ teamTasks: ["研发组 · 整理接口文档（未开始，明天截止）"] }),
    );
    expect(text).toContain("## 团队任务（派到我名下的）");
    expect(text).toContain("研发组 · 整理接口文档（未开始，明天截止）");
    expect(text).toContain("team_get");
    expect(text).toContain("team_task_update");
    expect(text).toContain("只有组长能把任务派给别人");
  });

  it("没有任务就不写这一段（与旧版逐字相同）", () => {
    const without = buildRuntimeSection(base());
    expect(without).not.toContain("团队任务");
    expect(buildRuntimeSection(base({ teamTasks: [] }))).toBe(without);
    expect(buildRuntimeSection(base({ teamTasks: ["   "] }))).toBe(without);
  });
});

describe("团队简报：派活前先认人（d.253）", () => {
  const base = (over: Partial<RuntimeSectionInput> = {}): RuntimeSectionInput => ({
    desktop: true,
    platform: "Windows 11",
    now: new Date("2026-11-17T10:00:00+08:00"),
    workspace: "D:/proj",
    tools: [{ name: "team_task_add" }],
    ...over,
  });

  it("写团队名、我的身份与队友 id，并且排在「派到我名下的任务」之前", () => {
    const text = buildRuntimeSection(
      base({
        teamBrief: ["## 团队（你在的）", "- 产品组（你是组长）：成员：阿鸣（u-1，组长）"],
        teamTasks: ["产品组 · 整理接口文档"],
      }),
    );
    expect(text).toContain("## 团队（你在的）");
    expect(text).toContain("阿鸣（u-1，组长）");
    expect(text.indexOf("## 团队（你在的）")).toBeLessThan(
      text.indexOf("## 团队任务（派到我名下的）"),
    );
  });

  it("没有简报就不写这一段（与旧版逐字相同）", () => {
    const without = buildRuntimeSection(base());
    expect(without).not.toContain("## 团队（你在的）");
    expect(buildRuntimeSection(base({ teamBrief: [] }))).toBe(without);
    expect(buildRuntimeSection(base({ teamBrief: ["   "] }))).toBe(without);
  });
});

describe("团队里待认领的活（d.260）", () => {
  const base = (over: Partial<RuntimeSectionInput> = {}): RuntimeSectionInput => ({
    desktop: true,
    platform: "Windows 11",
    now: new Date("2026-11-17T10:00:00+08:00"),
    workspace: "D:/proj",
    tools: [{ name: "team_get" }, { name: "team_task_update" }],
    ...over,
  });

  it("单列一段，写明先认领（assignee_id）再动手，且排在「派到我名下的」之后", () => {
    const text = buildRuntimeSection(
      base({
        teamTasks: ["研发组 · 派给我的活"],
        claimableTeamTasks: ["研发组 · 没人接的活（待认领）"],
      }),
    );
    expect(text).toContain("## 团队里待认领的活");
    expect(text).toContain("没人接的活");
    expect(text).toContain("认领");
    expect(text).toContain("assignee_id");
    expect(text.indexOf("## 团队任务（派到我名下的）")).toBeLessThan(
      text.indexOf("## 团队里待认领的活"),
    );
  });

  it("没有待认领的活就不写这一段（与旧版逐字相同）", () => {
    const without = buildRuntimeSection(base());
    expect(without).not.toContain("待认领");
    expect(buildRuntimeSection(base({ claimableTeamTasks: [] }))).toBe(without);
  });
});
