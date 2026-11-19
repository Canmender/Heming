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

/** 默认没有模型：窗口未知，卡片要写清「先用默认值」。 */
beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  useLlmStore.setState({ profiles: [], bindings: {}, prompts: {} });
});

describe("ContextSettingsCard 上下文预算（d.351：按 DSH 规则，不再手填）", () => {
  it("不再有「预算」「保留轮数」下拉，也没有「自动分配」开关", () => {
    render(<ContextSettingsCard />);
    expect(screen.getByText("上下文预算")).toBeInTheDocument();
    expect(screen.getByText(/按 DSH 的压缩规则/)).toBeInTheDocument();
    expect(screen.queryByLabelText("预算")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("保留轮数")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "按模型上下文窗口自动分配" })).not.toBeInTheDocument();
    // 两个真正是偏好的开关还在
    expect(screen.getByRole("switch", { name: "启用上下文预算" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "用模型生成早期摘要" })).toHaveAttribute("aria-checked", "true");
    // 只回填不写：没动过的设置不产生噪声写入
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("存储损坏（非法 JSON / 字段类型错）一律回退默认值，不抛错", () => {
    seed("{ not json");
    const first = render(<ContextSettingsCard />);
    expect(screen.getByRole("switch", { name: "启用上下文预算" })).toHaveAttribute("aria-checked", "true");
    first.unmount();

    seed(JSON.stringify({ enabled: "yes", budgetTokens: -1, keepRecentTurns: null, llmSummary: "no" }));
    render(<ContextSettingsCard />);
    expect(screen.getByRole("switch", { name: "启用上下文预算" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "用模型生成早期摘要" })).toHaveAttribute("aria-checked", "true");
  });

  it("切换「启用上下文预算」即时落盘，并提示按原样发送", () => {
    render(<ContextSettingsCard />);
    fireEvent.click(screen.getByRole("switch", { name: "启用上下文预算" }));

    expect(stored()).toEqual({
      enabled: false,
      budgetTokens: 6000,
      keepRecentTurns: 8,
      llmSummary: true,
      autoBudget: true,
    });
    expect(screen.getByRole("switch", { name: "启用上下文预算" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/按原样发送/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
  });

  it("切换「用模型生成早期摘要」即时落盘，不动别的字段", () => {
    render(<ContextSettingsCard />);
    fireEvent.click(screen.getByRole("switch", { name: "用模型生成早期摘要" }));

    expect(screen.getByRole("switch", { name: "用模型生成早期摘要" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/零成本确定性摘要/)).toBeInTheDocument();
    expect(stored().llmSummary).toBe(false);
    expect(stored().enabled).toBe(true);
  });

  it("没有模型：写清先用默认值，不假装知道窗口", () => {
    render(<ContextSettingsCard />);
    expect(screen.getByText(/当前没有可用模型/)).toBeInTheDocument();
    expect(screen.getByText(/先用默认 6K token/)).toBeInTheDocument();
    expect(screen.queryByText("压缩阈值")).not.toBeInTheDocument();
  });

  it("有模型：窗口 / 压缩阈值 / 保留原文 / 最近轮数 / 摘要余量都是算出来的数", async () => {
    const caps = await import("../lib/modelCaps.js");
    vi.spyOn(caps, "lookupCapability").mockReturnValue({ contextWindow: 200_000, maxOutput: 8_192 } as never);
    useLlmStore.setState({
      profiles: [
        { id: "p1", provider: "openai", model: "gpt-4o", label: "测试模型" },
      ] as never,
      bindings: {},
      prompts: {},
    });

    render(<ContextSettingsCard />);
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
    expect(screen.getByText(/窗口 200K tokens/)).toBeInTheDocument();
    expect(screen.getByText("压缩阈值")).toBeInTheDocument();
    expect(screen.getAllByText("126.3K")).toHaveLength(2); // 阈值与摘要余量同值：min(窗口 80%, 窗口 − 输出 − 余量)
    expect(screen.getByText(/阈值 = min\(窗口 × 80%/)).toBeInTheDocument();
    expect(screen.getByText("40 轮")).toBeInTheDocument();
  });
});
