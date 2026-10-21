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

  it("图表与去 AI 味是只读（纯计算，不写任何存储）", () => {
    expect(riskOfName("chart_render")).toBe("read");
    expect(riskOfName("chart_types")).toBe("read");
    expect(riskOfName("tone_detect")).toBe("read");
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

  it("读意图启发只在前缀表与危险词都没命中时生效", () => {
    expect(riskOfName("srv__get_file")).toBe("read");
    expect(riskOfName("srv__list_dir")).toBe("read");
    expect(riskOfName("srv__query_db")).toBe("read");
    expect(riskOfName("srv__search_web")).toBe("read");
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
    // 它按名字判：`get_file` 命中读意图启发 → read（这是对的，它是读操作）。
    // 重点是：声明为 false 也没有「强制降级」的效果。
    expect(resolveRisk("srv__get_file", { readOnlyHint: false })).toBe("read");
    // 作者显式声明的 meta.risk 仍然优先（那是我们自己写的桥，可信）
    expect(resolveRisk("srv__delete_file", { risk: "write", readOnlyHint: true })).toBe("write");
  });

  it("readOnlyHint 为 true 的陌生工具名 → write（不是 read）", () => {
    // 同一漏洞的另一面：连名字都认不出的工具，声明自己只读也不能放行。
    expect(resolveRisk("some_unknown_tool", { readOnlyHint: true })).toBe("write");
  });

  it("工具来源按名字推断", () => {
    expect(sourceOf("self_memory_write")).toBe("self");
    expect(sourceOf("chart_render")).toBe("chart");
    expect(sourceOf("tone_detect")).toBe("tone");
    expect(sourceOf("windows-mcp__Screenshot")).toBe("mcp");
    expect(sourceOf("random_tool")).toBe("unknown");
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
    expect(displayNameOf("windows-mcp__Screenshot")).toBe("外部工具");
  });

  it("toHitlCall 带上模型给的 tool_call id", () => {
    const call = toHitlCall({ id: "call_1", function: { name: "srv__get_file", arguments: "{}" } });
    expect(call.id).toBe("call_1");
    expect(call.risk).toBe("read");
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

  it("超长资源截断，避免把长文本写进 localStorage", () => {
    expect(ruleResource(JSON.stringify({ path: "a".repeat(500) }))).toHaveLength(200);
  });
});
