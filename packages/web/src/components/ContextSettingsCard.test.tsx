import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContextSettingsCard } from "./ContextSettingsCard.js";
import { useLlmStore } from "../store/llm.js";

/** 本机键（设计 §5）：卡片读写都走它，测试直接查 localStorage 断言落盘。 */
const KEY = "heming.context.v1";

function stored(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(KEY) as string) as Record<string, unknown>;
}

function seed(raw: string): void {
  localStorage.setItem(KEY, raw);
}

describe("ContextSettingsCard 上下文预算", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    useLlmStore.setState({ profiles: [], bindings: {}, prompts: {} });
  });

  it("localStorage 为空：回填默认值（6000 / 8 / 两开关为开），未交互不落盘", () => {
    render(<ContextSettingsCard />);

    expect(screen.getByText("上下文预算")).toBeInTheDocument();
    expect(screen.getByText(/给 @ 触发组装的历史做 token 预算/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "启用上下文预算" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("预算")).toHaveValue("6000");
    expect(screen.getByLabelText("保留轮数")).toHaveValue("8");
    expect(screen.getByRole("switch", { name: "用模型生成早期摘要" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // 只回填不写：没动过的设置不产生噪声写入
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("存储损坏（非法 JSON / 字段类型错）一律回退默认值，不抛错", () => {
    seed("{ not json");
    const first = render(<ContextSettingsCard />);
    expect(screen.getByLabelText("预算")).toHaveValue("6000");
    expect(screen.getByLabelText("保留轮数")).toHaveValue("8");
    first.unmount();

    seed(JSON.stringify({ enabled: "yes", budgetTokens: -1, keepRecentTurns: null, llmSummary: "no" }));
    render(<ContextSettingsCard />);
    expect(screen.getByRole("switch", { name: "启用上下文预算" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("预算")).toHaveValue("6000");
    expect(screen.getByLabelText("保留轮数")).toHaveValue("8");
    expect(screen.getByRole("switch", { name: "用模型生成早期摘要" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("切换「启用上下文预算」即时落盘，并提示按原样发送（无保存按钮）", () => {
    render(<ContextSettingsCard />);
    fireEvent.click(screen.getByRole("switch", { name: "启用上下文预算" }));

    expect(stored()).toEqual({ enabled: false, budgetTokens: 6000, keepRecentTurns: 8, llmSummary: true });
    expect(screen.getByRole("switch", { name: "启用上下文预算" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/按原样发送/)).toBeInTheDocument();
    // 即时落盘：卡片不提供保存按钮
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
  });

  it("改预算下拉即时落盘，且不清掉其他字段", () => {
    render(<ContextSettingsCard />);
    fireEvent.click(screen.getByRole("switch", { name: "启用上下文预算" }));
    fireEvent.change(screen.getByLabelText("预算"), { target: { value: "12000" } });

    expect(screen.getByLabelText("预算")).toHaveValue("12000");
    expect(stored().budgetTokens).toBe(12000);
    expect(stored().enabled).toBe(false); // 补丁合并：只改预算，不动开关
    expect(stored().keepRecentTurns).toBe(8);
  });

  it("改保留轮数下拉即时落盘", () => {
    render(<ContextSettingsCard />);
    fireEvent.change(screen.getByLabelText("保留轮数"), { target: { value: "2" } });

    expect(screen.getByLabelText("保留轮数")).toHaveValue("2");
    expect(stored().keepRecentTurns).toBe(2);
    expect(stored().budgetTokens).toBe(6000);
  });

  it("关闭「用模型生成早期摘要」即时落盘，并显示浅灰说明（零成本确定性摘要）", () => {
    render(<ContextSettingsCard />);
    expect(screen.queryByText(/零成本/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "用模型生成早期摘要" }));

    expect(stored().llmSummary).toBe(false);
    const hint = screen.getByText(/只用零成本确定性摘要/);
    expect(hint).toHaveClass("text-muted"); // 浅灰
    // 打开时说明消失
    fireEvent.click(screen.getByRole("switch", { name: "用模型生成早期摘要" }));
    expect(stored().llmSummary).toBe(true);
    expect(screen.queryByText(/零成本/)).not.toBeInTheDocument();
  });

  it("页面重挂载后回填已落盘的值", () => {
    const first = render(<ContextSettingsCard />);
    fireEvent.change(screen.getByLabelText("预算"), { target: { value: "4000" } });
    fireEvent.change(screen.getByLabelText("保留轮数"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("switch", { name: "用模型生成早期摘要" }));
    first.unmount();

    render(<ContextSettingsCard />);
    expect(screen.getByLabelText("预算")).toHaveValue("4000");
    expect(screen.getByLabelText("保留轮数")).toHaveValue("12");
    expect(screen.getByRole("switch", { name: "用模型生成早期摘要" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("非预设值（手改过的 5000 / 6）仍如实显示，不被静默改写", () => {
    seed(JSON.stringify({ enabled: true, budgetTokens: 5000, keepRecentTurns: 6, llmSummary: true }));
    render(<ContextSettingsCard />);

    expect(screen.getByLabelText("预算")).toHaveValue("5000");
    expect(screen.getByLabelText("保留轮数")).toHaveValue("6");
    expect(stored().budgetTokens).toBe(5000);
    expect(stored().keepRecentTurns).toBe(6);
  });

  // —— 预算按模型上下文窗口钳制（T05）——

  it("已知模型：显示当前预算与模型上限，超限的选项不再列出", () => {
    useLlmStore.setState({
      profiles: [{ id: "p1", label: "小窗", provider: "openai", apiKey: "k", model: "moonshot-v1-8k" }],
    });
    render(<ContextSettingsCard />);
    // moonshot-v1-8k 窗口 8192 → 60% = 4915 → 4000 可选，6000 以上超限
    expect(screen.getByText(/当前预算 4915 \/ 模型上限 4915 token/)).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "6000 token" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "4000 token" })).toBeInTheDocument();
    // 超限时给出提示
    expect(screen.getByText("已超出上限，下面的选择会被收敛到上限")).toBeInTheDocument();
  });

  it("未知模型：不做钳制（不猜窗口），照常列出全部预设", () => {
    useLlmStore.setState({
      profiles: [{ id: "p1", label: "私有", provider: "openai", apiKey: "k", model: "my-private-model" }],
    });
    render(<ContextSettingsCard />);
    expect(screen.getByRole("option", { name: "12000 token" })).toBeInTheDocument();
    expect(screen.queryByText(/模型上限/)).not.toBeInTheDocument();
  });
});
