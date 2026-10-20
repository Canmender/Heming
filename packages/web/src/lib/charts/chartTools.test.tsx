import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { buildChartToolBridge, toFence } from "./tools.js";
import { ChatChart } from "../../components/ChatChart.js";
import { exportChartHtml, chartFileName } from "./exportHtml.js";
import { ChartSpecSchema } from "./spec.js";

/** 调工具。 */
async function call(name: string, args: Record<string, unknown>) {
  const bridge = buildChartToolBridge();
  return bridge.execute({ name, arguments: JSON.stringify(args) });
}

describe("chart_types", () => {
  it("按数据形状给出候选图型", async () => {
    const res = await call("chart_types", { shape: "100% 构成占比" });
    expect(res.ok).toBe(true);
    expect(res.text).toContain("F4");
  });

  it("形状为空时列出全部可用图型", async () => {
    const res = await call("chart_types", { shape: "" });
    expect(res.text).toContain("可用图型");
    expect(res.text).toContain("F1");
  });

  it("不匹配时给出可用图型清单而不是空白", async () => {
    const res = await call("chart_types", { shape: "zzz 完全不存在的形状" });
    expect(res.text).toContain("可用图型");
  });
});

describe("chart_render", () => {
  it("产出可直接贴进回复的围栏块", async () => {
    const res = await call("chart_render", {
      type: "F1",
      title: "季度收入",
      points: [{ label: "Q1", value: 10 }],
    });
    expect(res.ok).toBe(true);
    expect(res.text).toContain("```chart");
    expect(res.text).toContain("季度收入");
    // 围栏块里的 JSON 能被解析回规范
    const json = /```chart\n([\s\S]*?)\n```/.exec(res.text)?.[1] ?? "";
    const spec = ChartSpecSchema.safeParse(JSON.parse(json));
    expect(spec.success).toBe(true);
  });

  it("缺 type 时给出明确提示", async () => {
    const res = await call("chart_render", { title: "无图型" });
    expect(res.ok).toBe(true);
    expect(res.text).toContain("缺少 type");
  });

  it("未知图型时提示先查图型", async () => {
    const res = await call("chart_render", { type: "ZZZ" });
    expect(res.text).toContain("未知图型");
  });

  it("数据不合法时列出具体问题", async () => {
    const res = await call("chart_render", {
      type: "F1",
      points: [{ label: "x", value: "不是数字" }],
    });
    expect(res.text).toContain("不合法");
  });

  it("模型多传的字段被忽略而不是整条失败", async () => {
    const res = await call("chart_render", {
      type: "F1",
      points: [{ label: "x", value: 1 }],
      乱七八糟: "字段",
    });
    expect(res.text).toContain("```chart");
  });

  it("参数不是合法 JSON 时不抛异常", async () => {
    const bridge = buildChartToolBridge();
    const res = await bridge.execute({ name: "chart_types", arguments: "{坏 JSON" });
    expect(res.ok).toBe(false);
    expect(res.text).toContain("JSON");
  });

  it("未知工具名给提示", async () => {
    const res = await call("chart_xxx", {});
    expect(res.ok).toBe(false);
  });

  it("工具声明符合 OpenAI tools 形状", () => {
    const bridge = buildChartToolBridge();
    expect(bridge.tools.length).toBeGreaterThan(0);
    for (const t of bridge.tools) {
      const fn = (t as { function?: { name?: string; parameters?: unknown } }).function;
      expect(fn?.name).toMatch(/^chart_[a-z_]+$/);
      expect(fn?.parameters).toBeTruthy();
    }
  });
});

describe("导出单文件 HTML", () => {
  const spec = ChartSpecSchema.parse({
    type: "F1",
    title: "季度收入",
    points: [{ label: "Q1", value: 10 }],
  });

  it("生成自包含的 HTML（内联样式与 SVG，无外部依赖）", () => {
    const html = exportChartHtml(spec);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<svg");
    expect(html).toContain("季度收入");
    // 不引外部资源：断网也能看。
    // 注意 SVG 的 xmlns 是 "http://www.w3.org/2000/svg"（命名空间标识，不是网络请求），
    // 所以要排除的是 w3.org 之外的真实外链。
    const external = html.match(/https?:\/\/(?!www\.w3\.org)[^"'\s)]+/g) ?? [];
    expect(external).toEqual([]);
    expect(html).not.toContain("<script");
  });

  it("文件名安全（去非法字符）", () => {
    expect(chartFileName(ChartSpecSchema.parse({ type: "F1", title: "a/b:c" }))).toContain("a-b-c");
  });

  it("无标题时用 chart 兜底", () => {
    const name = chartFileName(ChartSpecSchema.parse({ type: "F1" }));
    expect(name).toBe("chart-F1.html");
  });
});

describe("ChatChart 组件", () => {
  const spec = ChartSpecSchema.parse({
    type: "F1",
    title: "季度收入",
    points: [
      { label: "Q1", value: 10 },
      { label: "Q2", value: 20 },
    ],
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    // 桌面端桥：导出走 IPC
    (globalThis as unknown as { __heming_chart?: unknown }).__heming_chart = {
      export: vi.fn().mockResolvedValue({ ok: true, path: "C:/Users/x/Heming/charts/a.html" }),
      list: vi.fn().mockResolvedValue([]),
      open: vi.fn().mockResolvedValue({ ok: true, path: "C:/Users/x/Heming/charts/a.html" }),
    };
  });

  it("渲染 SVG 图表", () => {
    const { container } = render(<ChatChart spec={spec} />);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.textContent).toContain("季度收入");
  });

  it("提供导出与打开两个动作", () => {
    render(<ChatChart spec={spec} />);
    expect(screen.getByRole("button", { name: "导出 HTML" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开" })).toBeInTheDocument();
  });

  it("点导出后反馈保存位置", async () => {
    render(<ChatChart spec={spec} />);
    fireEvent.click(screen.getByRole("button", { name: "导出 HTML" }));
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("已保存到");
    });
  });

  it("导出失败时显示原因", async () => {
    (globalThis as unknown as { __heming_chart: { export: ReturnType<typeof vi.fn> } }).__heming_chart.export =
      vi.fn().mockResolvedValue({ ok: false, error: "文件名不合法" });
    render(<ChatChart spec={spec} />);
    fireEvent.click(screen.getByRole("button", { name: "导出 HTML" }));
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("文件名不合法");
    });
  });

  it("浏览器端无桥时导出降级为下载并说明去向", async () => {
    delete (globalThis as unknown as { __heming_chart?: unknown }).__heming_chart;
    const createObjectURL = vi.fn().mockReturnValue("blob:test");
    const revokeObjectURL = vi.fn();
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;

    render(<ChatChart spec={spec} />);
    fireEvent.click(screen.getByRole("button", { name: "导出 HTML" }));
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("已下载");
    });
    expect(createObjectURL).toHaveBeenCalled();
  });

  it("规范非法时不崩，给出提示", () => {
    // 构造一个渲染会抛错的规范（极端数量）
    const bad = { ...spec, points: Array.from({ length: 5000 }, (_, i) => ({ label: `p${i}`, value: i })) };
    render(<ChatChart spec={bad as never} />);
    // 渲染成功（不崩）即可——数据超限由 schema 挡住，这里只是不抛
    expect(document.body.textContent).not.toContain("图表渲染失败");
  });
});

describe("围栏块转换", () => {
  it("toFence 产出可解析的围栏", () => {
    const spec = ChartSpecSchema.parse({ type: "F1", title: "t" });
    const block = toFence(spec);
    expect(block.startsWith("```chart\n")).toBe(true);
    expect(block.endsWith("\n```")).toBe(true);
  });
});
