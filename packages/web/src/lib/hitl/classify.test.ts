import { describe, it, expect } from "vitest";
import {
  classifyCall,
  displayNameOf,
  resolveRisk,
  riskOfName,
  ruleResource,
  sourceOf,
  summarizeArgs,
  toHitlCall,
} from "./classify.js";

describe("风险分类", () => {
  it("self.* 13 个工具的风险分级正确", () => {
    // 三个 list 是只读
    expect(riskOfName("self_memory_list")).toBe("read");
    expect(riskOfName("self_skill_list")).toBe("read");
    expect(riskOfName("self_mcp_list")).toBe("read");
    // 记忆/技能写入是 write
    expect(riskOfName("self_memory_write")).toBe("write");
    expect(riskOfName("self_memory_remove")).toBe("write");
    expect(riskOfName("self_skill_update")).toBe("write");
    expect(riskOfName("self_skill_create")).toBe("write");
    // self_mcp_* 五个都能改自己的执行环境，一律 danger
    expect(riskOfName("self_mcp_enable")).toBe("danger");
    expect(riskOfName("self_mcp_disable")).toBe("danger");
    expect(riskOfName("self_mcp_add_server")).toBe("danger");
    expect(riskOfName("self_mcp_update_server")).toBe("danger");
    expect(riskOfName("self_mcp_remove_server")).toBe("danger");
  });

  it("todo_write 名字带 write，但只改本会话清单，必须是 read（d.154）", () => {
    // 兜底表不登记就会落进 DANGER_WORDS 的 write 分支变成 danger，
    // 结果是每次列计划都弹确认，用户会直接关掉清单工具。
    expect(riskOfName("todo_write")).toBe("read");
    expect(displayNameOf("todo_write")).toBe("更新任务清单");
    expect(
      summarizeArgs(
        JSON.stringify({
          todos: [
            { content: "a", status: "completed" },
            { content: "b", status: "in_progress" },
            { content: "c", status: "pending" },
          ],
        }),
      ),
    ).toBe("任务清单：共 3 条，已完成 1，进行中 1");
  });

  it("agent_task 是只读：子代理只能读文件，不该因为「派活」弹确认（d.162）", () => {
    expect(riskOfName("agent_task")).toBe("read");
    expect(displayNameOf("agent_task")).toBe("派子代理");
    // 摘要只放任务目标，且截断——子会话里的文件清单不进确认卡
    const summary = summarizeArgs(
      JSON.stringify({ task: "在 docs/ 里找出所有提到限流的文件并总结各文件说法", max_rounds: 4 }),
    );
    expect(summary.startsWith("子代理任务：")).toBe(true);
    expect(summary).toContain("提到限流");
    expect(summary.length).toBeLessThanOrEqual(80);
  });

  it("图表与去 AI 味是只读（纯计算，不写任何存储）", () => {
    expect(riskOfName("chart_render")).toBe("read");
    expect(riskOfName("chart_types")).toBe("read");
    expect(riskOfName("tone_detect")).toBe("read");
  });

  it("内置联网工具是只读（发请求 / 读本机时钟，不写任何存储）", () => {
    // 桥的 meta 会先命中（见 tools.ts），这张表是「没有桥」时的兜底
    expect(riskOfName("web_search")).toBe("read");
    expect(riskOfName("web_read")).toBe("read");
    expect(riskOfName("now")).toBe("read");
  });

  it("本地只读工具（计算/JSON/编码/日期）免确认", () => {
    expect(riskOfName("calculator")).toBe("read");
    expect(riskOfName("json_query")).toBe("read");
    expect(riskOfName("encoding")).toBe("read");
    expect(riskOfName("date_calc")).toBe("read");
  });

  it("MCP 工具不按名字猜只读：db__query / api__get_url 必须先确认", () => {
    // 服务端工具名可以是任意词，`query`/`get` 也可能是写操作；
    // 以前整串跑 READ_WORDS 会把它们判成 read 免确认执行。
    expect(riskOfName("db__query")).toBe("write");
    expect(riskOfName("api__get_url")).toBe("write");
    expect(riskOfName("fs__list_directory")).toBe("write");
    expect(riskOfName("windows-desktop__screenshot")).toBe("write");
    // 真危险词照旧升档
    expect(riskOfName("db__run_sql")).toBe("danger");
    expect(riskOfName("shell__exec")).toBe("danger");
  });

  it("非命名空间的内置工具仍按读意图判只读", () => {
    expect(riskOfName("list_files")).toBe("read");
    expect(riskOfName("fetch_page")).toBe("read");
  });

  it("未知工具一律 write——绝不兜底成 read", () => {
    expect(riskOfName("some_unknown_tool")).toBe("write");
    expect(riskOfName("")).toBe("write");
  });

  it("危险词命中即 danger（删文件、跑命令、改注册表）", () => {
    expect(riskOfName("fs__delete_file")).toBe("danger");
    expect(riskOfName("win__PowerShell")).toBe("danger");
    expect(riskOfName("srv__kill_process")).toBe("danger");
    expect(riskOfName("srv__exec_command")).toBe("danger");
    expect(riskOfName("srv__write_registry")).toBe("danger");
  });

  it("读意图启发只对非 MCP 名字生效（MCP 见下一条护栏）", () => {
    expect(riskOfName("list_files")).toBe("read");
    expect(riskOfName("fetch_page")).toBe("read");
    expect(riskOfName("search_web")).toBe("read");
    expect(riskOfName("view_image")).toBe("read");
  });

  it("桥自带 meta.risk 优先级最高，覆盖一切名字启发", () => {
    expect(resolveRisk("fs__delete_file", { risk: "read" })).toBe("read");
    expect(resolveRisk("srv__get_file", { risk: "danger" })).toBe("danger");
  });

  it("MCP 的 annotations 不参与判定（规范明言它是 untrusted hint）", () => {
    // ★ 这条是**安全护栏**。规范原文（schema/2025-06-18）：
    //   "Clients should never make tool use decisions based on ToolAnnotations
    //    received from untrusted servers."
    // 2025-12-11 版更明确：MUST consider tool annotations to be untrusted。
    //
    // 实测真实服务器（Windows-MCP）**20/20 个工具都带 annotations**——
    // 所以这不是理论风险：恶意服务器只要把 readOnlyHint 设成 true，
    // 它的 delete_file / run_command 就会静默执行。
    //
    // → 声明了 readOnlyHint: true 的 delete_file 仍然是 danger。
    expect(resolveRisk("srv__delete_file", { readOnlyHint: true })).toBe("danger");
    // 声明了 readOnlyHint: false 的陌生工具**不会**因此被判 write——
    // 但也不会按名字被降级成 read：MCP 名字由服务端随意起，
    // `srv__get_file` 可能是写操作，所以 MCP 一律先按 write 收口。
    expect(resolveRisk("srv__get_file", { readOnlyHint: false })).toBe("write");
    // 非 MCP 的内置工具不受这条影响，仍按读意图判只读
    expect(riskOfName("get_file")).toBe("read");
    // 作者显式声明的 meta.risk 仍然优先（那是我们自己写的桥，可信）
    expect(resolveRisk("srv__delete_file", { risk: "write", readOnlyHint: true })).toBe("write");
  });

  it("readOnlyHint 为 true 的陌生工具名 → write（不是 read）", () => {
    // 同一漏洞的另一面：连名字都认不出的工具，声明自己只读也不能放行。
    expect(resolveRisk("some_unknown_tool", { readOnlyHint: true })).toBe("write");
  });

  it("文件读写新工具的风险显式表压过危险词（file_write 含 write 但不能是 danger）", () => {
    // DANGER_WORDS 里有 write / move 这类词，新增写工具若只靠名字启发会被升成 danger，
    // 于是永远要人工确认——显式表就是用来钉住这一点的。
    expect(riskOfName("file_write")).toBe("write");
    expect(riskOfName("file_edit")).toBe("write");
    expect(riskOfName("file_glob")).toBe("read");
    expect(riskOfName("file_grep")).toBe("read");
    expect(classifyCall("file_write", "{}").risk).toBe("write");
    expect(classifyCall("file_edit", "{}").risk).toBe("write");
  });

  it("工具来源按名字推断", () => {
    expect(sourceOf("self_memory_write")).toBe("self");
    expect(sourceOf("chart_render")).toBe("chart");
    expect(sourceOf("tone_detect")).toBe("tone");
    expect(sourceOf("windows-mcp__Screenshot")).toBe("mcp");
    expect(sourceOf("random_tool")).toBe("unknown");
  });

  it("团队工具来源是 team（d.109 D1），不再落到 unknown", () => {
    for (const name of [
      "team_list",
      "team_get",
      "team_create",
      "team_update",
      "team_member_add",
      "team_plan_add",
      "team_plan_update",
      "team_task_add",
      "team_task_update",
    ]) {
      expect(sourceOf(name)).toBe("team");
    }
  });
});

describe("团队工具的展示名与参数摘要（d.109 D1）", () => {
  it("9 个 team_* 工具各有中文动作名，不再显示「外部工具 team_task_add」", () => {
    expect(displayNameOf("team_list")).toBe("列出团队");
    expect(displayNameOf("team_get")).toBe("查看团队");
    expect(displayNameOf("team_create")).toBe("创建团队");
    expect(displayNameOf("team_update")).toBe("修改团队");
    expect(displayNameOf("team_member_add")).toBe("添加成员");
    expect(displayNameOf("team_plan_add")).toBe("添加方案");
    expect(displayNameOf("team_plan_update")).toBe("更新方案");
    expect(displayNameOf("team_task_add")).toBe("派任务");
    expect(displayNameOf("team_task_update")).toBe("更新任务");
    // 以后新增的 team_* 走前缀兜底，也不会掉回「外部工具」
    expect(displayNameOf("team_archive_create")).toBe("团队操作");
  });

  it("参数摘要能截到 title / team_id（仍走敏感词过滤）", () => {
    expect(summarizeArgs('{"team_id":"t1","title":"写落地页"}')).toBe("写落地页");
    expect(summarizeArgs('{"team_id":"t1"}')).toBe("t1");
    // 快照回传的是 camelCase，模型照抄时摘要同样要认得（否则确认框里只剩一串 JSON）
    expect(summarizeArgs('{"teamId":"t1","planId":"p1"}')).toBe("t1");
    // title 里夹带密钥同样被屏蔽（新字段不绕过敏感词检查）
    expect(summarizeArgs('{"title":"sk-abcdefghijklmnop"}')).toBe("***");
  });

  it("classifyCall：派任务的风险仍由桥的 riskHint 决定，展示层用中文动作名", () => {
    const call = classifyCall("team_task_add", '{"team_id":"t1","title":"写落地页"}', undefined, {
      risk: "write",
    });
    expect(call.displayName).toBe("派任务");
    expect(call.risk).toBe("write");
    expect(call.source).toBe("team");
    expect(call.summary).toBe("写落地页");
  });
});

describe("文件工具的展示名与参数摘要", () => {
  it("六个文件工具都有中文动作名（不再落到「文件操作」兜底/外部工具）", () => {
    expect(displayNameOf("file_patch")).toBe("修改文件");
    expect(displayNameOf("file_read")).toBe("读取文件");
    expect(displayNameOf("file_write")).toBe("写入文件");
    expect(displayNameOf("file_edit")).toBe("编辑文件");
    expect(displayNameOf("file_glob")).toBe("查找文件");
    expect(displayNameOf("file_grep")).toBe("搜索内容");
  });

  it("file_write 摘要只给路径 + 行数/字节数，绝不回显正文", () => {
    const content = "第一行\n第二行";
    const summary = summarizeArgs(JSON.stringify({ path: "notes/a.md", content }));

    expect(summary).toBe(`notes/a.md（2 行 · ${new TextEncoder().encode(content).length} 字节）`);
    expect(summary).not.toContain("第一行");
  });

  it("file_edit 摘要只给目标与替换规模，不回显替换内容", () => {
    const summary = summarizeArgs(
      JSON.stringify({ path: "notes/a.md", old_string: "旧", new_string: "新\n新2" }),
    );
    expect(summary).toBe("notes/a.md（替换 1 行 → 2 行）");
    expect(summary).not.toContain("旧");
    expect(summary).not.toContain("新2");
  });

  it("file_glob / file_grep 摘要以 pattern 为主（path / include 作为范围补充）", () => {
    expect(summarizeArgs('{"pattern":"**/*.md"}')).toBe("**/*.md");
    expect(summarizeArgs('{"pattern":"TODO","include":"*.ts"}')).toBe("TODO（include: *.ts）");
    expect(summarizeArgs('{"pattern":"TODO","path":"src"}')).toBe("TODO（在 src 内）");
    expect(summarizeArgs('{"pattern":"TODO","path":"src","include":"*.ts"}')).toBe(
      "TODO（在 src 内）（include: *.ts）",
    );
  });

  it("pattern 命中敏感特征时同样屏蔽", () => {
    expect(summarizeArgs('{"pattern":"sk-abcdefghijklmnop"}')).toBe("***");
  });
});

describe("参数摘要", () => {
  it("优先取已知字段（path/file/url/query/name/server）", () => {
    expect(summarizeArgs('{"path":"D:/Heming/docs/a.md"}')).toBe("D:/Heming/docs/a.md");
    expect(summarizeArgs('{"file":"report.txt"}')).toBe("report.txt");
    expect(summarizeArgs('{"url":"https://example.com/x"}')).toBe("https://example.com/x");
    expect(summarizeArgs('{"query":"和鸣"}')).toBe("和鸣");
    expect(summarizeArgs('{"name":"记忆"}')).toBe("记忆");
  });

  it("含 api_key 的参数值被替换成 ***", () => {
    const summary = summarizeArgs('{"api_key":"sk-abcdefghijklmnop"}');
    expect(summary).toBe("***");
    expect(summary).not.toContain("sk-");
  });

  it("字段名像密钥的（token/password）一律屏蔽", () => {
    expect(summarizeArgs('{"token":"abc"}')).toBe("***");
    expect(summarizeArgs('{"password":"hunter2000"}')).toBe("***");
  });

  it("早返回分支里的密钥也不能漏：task/command/job_id 命中敏感特征整条退化为 ***", () => {
    // 回归：以前敏感扫描只在函数末尾的兜底路径做，task/command/job_id 早返回
    // 直接回显原始取值——Bearer token / sk-… 原样漏到确认卡与审计日志。
    expect(summarizeArgs(JSON.stringify({ task: "use sk-abcdefghijklmnop to login" }))).toBe("***");
    expect(
      summarizeArgs(JSON.stringify({ command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrst' https://x" })),
    ).toBe("***");
    expect(summarizeArgs(JSON.stringify({ job_id: "sk-abcdefghijklmnop" }), "command_output")).toBe("***");
    // 旁边带一个 api_key 字段时同样整条退化（早返回不能绕过敏感扫描）
    expect(summarizeArgs(JSON.stringify({ task: "查一下", api_key: "sk-abcdefghijklmnop" }))).toBe("***");
    // 正常的早返回不受影响
    expect(summarizeArgs('{"job_id":"job-1"}', "command_output")).toBe("读作业 job-1 的输出");
  });

  it("命令/任务摘要截断不劈 emoji 代理对", () => {
    const lone = (s: string): boolean =>
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
    expect(lone(summarizeArgs(JSON.stringify({ command: "x".repeat(69) + "😀" + "yz" })))).toBe(false);
    expect(lone(summarizeArgs(JSON.stringify({ task: "x".repeat(59) + "😀" + "yz" })))).toBe(false);
  });

  it("无已知字段时给截断 JSON", () => {
    const summary = summarizeArgs('{"foo":1,"bar":2}');
    expect(summary).toContain("foo");
    expect(summary.length).toBeLessThanOrEqual(80);
  });

  it("参数不是合法 JSON 时不抛错，给空摘要", () => {
    expect(summarizeArgs("{ 不是 json")).toBe("{}");
    expect(summarizeArgs("")).toBe("{}");
  });
});

describe("classifyCall", () => {
  it("产出完整的一份调用描述（动作名 + 风险 + 摘要 + 来源）", () => {
    const call = classifyCall("self_memory_write", '{"key":"偏好","value":"中文"}');
    expect(call.name).toBe("self_memory_write");
    expect(call.risk).toBe("write");
    expect(call.displayName).toBe("写入记忆");
    // key 不在已知字段表里 → 按设计给截断 JSON
    expect(call.summary).toBe('{"key":"偏好","value":"中文"}');
    expect(call.source).toBe("self");
  });

  it("显示名给中文动作；认不出来的工具给通用名", () => {
    expect(displayNameOf("self_mcp_enable")).toBe("启用 MCP 工具");
    expect(displayNameOf("chart_render")).toBe("生成图表");
    expect(displayNameOf("windows-mcp__Screenshot")).toBe("windows-mcp · Screenshot");
  });

  it("toHitlCall 带上模型给的 tool_call id", () => {
    const call = toHitlCall({ id: "call_1", function: { name: "srv__get_file", arguments: "{}" } });
    expect(call.id).toBe("call_1");
    // MCP 工具名不可信，首次一律按 write 收口（见「MCP 工具不按名字猜只读」）
    expect(call.risk).toBe("write");
  });
});

describe("规则资源标识", () => {
  it("取首个已知字段，路径统一正斜杠、不做展示脱敏", () => {
    expect(ruleResource('{"path":"notes\\\\a.md"}')).toBe("notes/a.md");
    expect(ruleResource('{"url":"https://bob:pw@example.com/x"}')).toBe(
      "https://***@example.com/x",
    );
  });

  it("敏感字段不落规则（退化成通配）", () => {
    expect(ruleResource('{"query":"token=abcdefghijklmnop"}')).toBe("*");
  });

  it("没有可识别字段时是通配", () => {
    expect(ruleResource("{}")).toBe("*");
    expect(ruleResource("{ 不是 json")).toBe("*");
  });

  it("团队工具按 team_id 记规则（不按每次都会变的标题碎片化）", () => {
    expect(ruleResource('{"team_id":"t1","title":"写落地页"}')).toBe("t1");
    expect(ruleResource('{"title":"只有标题没有团队"}')).toBe("只有标题没有团队");
  });

  it("团队 id 的 camelCase 写法同样收窄规则（否则「记住允许」退化成通配）", () => {
    // 快照把 id 以 camelCase 回传给模型，模型照抄 teamId / planId：
    // 修复前这里返回 "*"，一次允许 = 该工具跨团队永久放行。
    expect(ruleResource('{"teamId":"t1","planId":"p1"}')).toBe("t1");
    expect(ruleResource('{"team_id":"t1","plan_id":"p1"}')).toBe("t1");
    // 两种写法混用（模型只改了一半）也要命中，先归一化再查
    expect(ruleResource('{"plan_id":"p1","teamId":"t1"}')).toBe("t1");
    // 没有 teamId 时才退到方案 / 任务 id，仍比通配精确
    expect(ruleResource('{"planId":"p1"}')).toBe("p1");
    expect(ruleResource('{"taskId":"k1"}')).toBe("k1");
  });

  it("超长资源截断，避免把长文本写进 localStorage", () => {
    expect(ruleResource(JSON.stringify({ path: "a".repeat(500) }))).toHaveLength(200);
  });
});

describe("file_image（d.168：读图不该每次弹确认）", () => {
  it("风险是 read：只把根内图片读成 base64，不改磁盘", () => {
    expect(riskOfName("file_image")).toBe("read");
    expect(classifyCall("file_image", JSON.stringify({ path: "截图/home.png" })).risk).toBe("read");
  });

  it("显示名与摘要：动作叫「查看图片」，摘要给路径而不是整段 base64", () => {
    expect(displayNameOf("file_image")).toBe("查看图片");
    const summary = summarizeArgs(JSON.stringify({ path: "截图/home.png", base64: "iVBORw0KGgo=" }));
    expect(summary).toBe("截图/home.png");
    expect(summary).not.toContain("iVBOR");
  });
});

describe("file_undo 的风险等级与显示名（d.170）", () => {
  it("撤销会改文件内容，必须按 write 走确认（不能像只读那样放行）", () => {
    expect(resolveRisk("file_undo")).toBe("write");
  });

  it("显示名直接说「撤销」，不让用户猜这个工具在干什么", () => {
    expect(displayNameOf("file_undo")).toBe("撤销上次写入");
  });
});

describe("后台作业工具的风险与摘要（d.180）", () => {
  it("读输出 / 列作业是 read，停作业是 write（名字里的 kill 不能把它顶成 danger）", () => {
    expect(resolveRisk("command_output")).toBe("read");
    expect(resolveRisk("command_list")).toBe("read");
    expect(resolveRisk("command_kill")).toBe("write");
    // DANGER_WORDS 里有 kill；显式表必须压住它，否则「停掉自己刚起的作业」也要按危险工具逐条确认。
    expect(classifyCall("command_kill", '{"job_id":"job-1"}').risk).toBe("write");
  });

  it("显示名是中文动作，摘要只放作业 id（输出正文不进确认卡）", () => {
    expect(displayNameOf("command_output")).toBe("读取后台输出");
    expect(displayNameOf("command_list")).toBe("列出后台命令");
    expect(displayNameOf("command_kill")).toBe("停止后台命令");
    expect(summarizeArgs('{"job_id":"job-1"}', "command_output")).toBe("读作业 job-1 的输出");
    expect(summarizeArgs('{"job_id":"job-1"}', "command_kill")).toBe("停止作业 job-1");
    expect(summarizeArgs("{}", "command_list")).toBe("列出后台作业");
  });

  it("classifyCall 把工具名带进摘要（不带的话 job_id 只会退化成 JSON 截断）", () => {
    expect(classifyCall("command_output", '{"job_id":"job-9"}').summary).toBe("读作业 job-9 的输出");
    expect(classifyCall("command_kill", '{"job_id":"job-9"}').summary).toBe("停止作业 job-9");
  });
});

describe("tool_output_read（d.181）", () => {
  it("只读内存里的文本：风险 read、显示名与摘要都按文件/输出类给", () => {
    expect(riskOfName("tool_output_read")).toBe("read");
    expect(displayNameOf("tool_output_read")).toBe("读取完整输出");
  });
});
