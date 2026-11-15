import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { CapabilityToolGroup } from "./viewModel.js";
import { PluginToolPanel, filterToolGroups, plainToolDescription } from "./PluginToolPanel.js";

/**
 * 工具描述面向模型（含 Markdown 标记与对模型的指令），界面展示前要去标记，
 * 但不能改写句子本身——这里钉住「只去标记 + 压空白」的边界。
 */
describe("工具描述面向用户化", () => {
  it("去掉加粗/斜体标记与行内代码，保留文字", () => {
    expect(plainToolDescription("被动句、名词化**不是** AI 痕迹")).toBe("被动句、名词化不是 AI 痕迹");
    expect(plainToolDescription("调用 `chart_render` 后把结果贴回来")).toBe(
      "调用 chart_render 后把结果贴回来",
    );
    expect(plainToolDescription("__重要__：先读再写")).toBe("重要：先读再写");
  });

  it("多行压成一行、首尾空白去掉（列表行只有两行高）", () => {
    expect(plainToolDescription("  第一行\n\n第二行\t第三行  ")).toBe("第一行 第二行 第三行");
  });

  it("没有标记时原样返回（不改写语义）", () => {
    const text = "读取本机归档里的消息，只读。";
    expect(plainToolDescription(text)).toBe(text);
  });
});

function entry(overrides: Partial<CapabilityToolGroup["tools"][number]> = {}) {
  return {
    name: "web_search",
    description: "联网搜索公开网页",
    ownerKind: "system" as const,
    ownerLabel: "系统能力",
    ownerId: "webtools",
    enabled: true,
    editable: false,
    risk: "read" as const,
    ...overrides,
  };
}

function groups(): CapabilityToolGroup[] {
  return [
    {
      kind: "system",
      label: "系统能力",
      tools: [
        entry({ name: "web_search", description: "联网搜索公开网页" }),
        entry({ name: "calculator", description: "精确计算一个算术表达式" }),
      ],
    },
    {
      kind: "mcp",
      label: "MCP 服务",
      tools: [
        entry({
          name: "weather_query",
          description: "查询城市天气",
          ownerKind: "mcp",
          ownerLabel: "报告服务",
          ownerId: "mcp-report",
          enabled: false,
          editable: true,
        }),
        entry({
          name: "weather_write",
          description: "写回天气缓存",
          ownerKind: "mcp",
          ownerLabel: "报告服务",
          ownerId: "mcp-report",
          enabled: true,
          editable: true,
          risk: "write" as const,
        }),
      ],
    },
  ];
}

describe("filterToolGroups", () => {
  it("空查询原样返回", () => {
    const source = groups();
    expect(filterToolGroups(source, "   ")).toBe(source);
  });

  it("按工具名/描述过滤，保留命中的分组", () => {
    const filtered = filterToolGroups(groups(), "计算");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].tools.map((tool) => tool.name)).toEqual(["calculator"]);
  });

  it("多词按 AND 匹配", () => {
    expect(filterToolGroups(groups(), "天气 缓存")[0].tools.map((tool) => tool.name)).toEqual([
      "weather_write",
    ]);
  });

  it("分组标题命中时保留整组", () => {
    const filtered = filterToolGroups(groups(), "MCP 服务");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].tools).toHaveLength(2);
  });

  it("没有命中返回空数组", () => {
    expect(filterToolGroups(groups(), "不存在的工具")).toEqual([]);
  });
});

describe("PluginToolPanel 交互（d.150）", () => {
  it("搜索框过滤工具行，并显示匹配数与清空按钮", () => {
    render(
      <PluginToolPanel groups={groups()} blocked={[]} toolPacks={[]} onToggleTool={() => {}} />,
    );
    expect(screen.getByText("web_search")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索工具"), { target: { value: "天气" } });
    expect(screen.queryByText("web_search")).toBeNull();
    expect(screen.getByText("weather_query")).toBeInTheDocument();
    expect(screen.getByText("匹配 2 个")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("清空工具搜索"));
    expect(screen.getByText("web_search")).toBeInTheDocument();
  });

  it("搜索无结果时给出空态", () => {
    render(
      <PluginToolPanel groups={groups()} blocked={[]} toolPacks={[]} onToggleTool={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText("搜索工具"), { target: { value: "zzz" } });
    expect(screen.getByText("没有匹配「zzz」的工具。")).toBeInTheDocument();
  });

  it("分组可折叠，折叠时隐藏工具行但保留标题", () => {
    render(
      <PluginToolPanel groups={groups()} blocked={[]} toolPacks={[]} onToggleTool={() => {}} />,
    );
    const systemGroup = screen.getByRole("region", { name: "工具分组 系统能力" });
    expect(within(systemGroup).getByText("web_search")).toBeInTheDocument();
    fireEvent.click(within(systemGroup).getByLabelText("收起分组 系统能力"));
    expect(within(systemGroup).queryByText("web_search")).toBeNull();
    expect(within(systemGroup).getByText("系统能力（2）")).toBeInTheDocument();
    fireEvent.click(within(systemGroup).getByLabelText("展开分组 系统能力"));
    expect(within(systemGroup).getByText("web_search")).toBeInTheDocument();
  });

  it("批量开关只对「可开关且状态不符」的工具发请求", () => {
    const onToggleTool = vi.fn();
    render(
      <PluginToolPanel groups={groups()} blocked={[]} toolPacks={[]} onToggleTool={onToggleTool} />,
    );
    const mcpGroup = screen.getByRole("region", { name: "工具分组 MCP 服务" });
    fireEvent.click(within(mcpGroup).getByRole("button", { name: "启用分组 MCP 服务 的全部工具" }));
    expect(onToggleTool).toHaveBeenCalledTimes(1);
    expect(onToggleTool).toHaveBeenCalledWith("mcp-report", "weather_query", true);
    fireEvent.click(within(mcpGroup).getByRole("button", { name: "停用分组 MCP 服务 的全部工具" }));
    expect(onToggleTool).toHaveBeenLastCalledWith("mcp-report", "weather_write", false);
  });

  it("系统分组说明内置只读常开，不出现批量按钮", () => {
    render(
      <PluginToolPanel groups={groups()} blocked={[]} toolPacks={[]} onToggleTool={() => {}} />,
    );
    const systemGroup = screen.getByRole("region", { name: "工具分组 系统能力" });
    expect(systemGroup).toHaveTextContent("随应用内置");
    expect(within(systemGroup).queryByLabelText(/全部启用/)).toBeNull();
    expect(within(systemGroup).getAllByText("常开")).toHaveLength(2);
  });
});
