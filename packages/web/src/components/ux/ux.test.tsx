import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { OnboardingCard } from "./OnboardingCard.js";
import { UnboundModelNotice, UNBOUND_NOTICE_ID, unboundNoticeText } from "./UnboundModelNotice.js";
import { ChatEmptyState } from "./ChatEmptyState.js";
import { ComposerHints } from "./ComposerHints.js";
import { deriveOnboardingSteps } from "../../lib/onboarding.js";

/**
 * UX-A 的四个小组件：引导卡 / 未绑定模型提示 / 对话空态 / 快捷键提示。
 * 断言「说了什么 + 点了会怎样」，不测像素。
 */

describe("OnboardingCard", () => {
  const steps = deriveOnboardingSteps({ connections: 0, conversations: 1, tasks: 0 });

  it("三步都画出来，已完成步骤标「已完成」且按钮禁用", () => {
    render(<OnboardingCard steps={steps} onGo={vi.fn()} onDismiss={vi.fn()} />);
    const card = screen.getByRole("region", { name: "开始使用" });
    expect(within(card).getByText("配置模型连接")).toBeInTheDocument();
    expect(within(card).getByText("和智能体对话")).toBeInTheDocument();
    expect(within(card).getByText("建第一个任务")).toBeInTheDocument();
    // 1/3 完成
    expect(within(card).getByText(/1\/3\s*已完成/)).toBeInTheDocument();
    const doneButton = within(card).getByRole("button", { name: "已完成" });
    expect(doneButton).toBeDisabled();
  });

  it("未完成步骤的按钮把目标页交给上层（设置 / 对话 / 任务区）", () => {
    const onGo = vi.fn();
    render(<OnboardingCard steps={deriveOnboardingSteps({ connections: 0, conversations: 0, tasks: 0 })} onGo={onGo} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "去配置模型" }));
    fireEvent.click(screen.getByRole("button", { name: "去对话" }));
    fireEvent.click(screen.getByRole("button", { name: "去建任务" }));
    expect(onGo.mock.calls.map(([t]) => t)).toEqual(["settings", "chat", "tasks"]);
  });

  it("点「不再显示」只回调，不在组件里自己写存储", () => {
    const onDismiss = vi.fn();
    render(<OnboardingCard steps={steps} onGo={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "不再显示" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("UnboundModelNotice（三处同源）", () => {
  it("有具体智能体：文案带名字，并说明「当前智能体还没有绑定模型连接」", () => {
    render(<UnboundModelNotice agentName="和小鸣" onGoSettings={vi.fn()} />);
    const notice = document.getElementById(UNBOUND_NOTICE_ID)!;
    expect(notice).not.toBeNull();
    expect(notice).toHaveTextContent("当前智能体还没有绑定模型连接");
    expect(notice).toHaveTextContent("和小鸣");
  });

  it("通用场景（没选中具体智能体）：沿用任务区的既有说法", () => {
    render(<UnboundModelNotice onGoSettings={vi.fn()} />);
    expect(screen.getByText("还没有智能体绑定 LLM 连接")).toBeInTheDocument();
  });

  it("「去设置」可点、id 可覆盖（对话页 aria-describedby 指向它）", () => {
    const go = vi.fn();
    render(<UnboundModelNotice id="chat-unbound" agentName="X" onGoSettings={go} />);
    const notice = document.getElementById("chat-unbound")!;
    expect(notice).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "去设置" }));
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("不传 onGoSettings 时不渲染按钮（只读提示场景）", () => {
    render(<UnboundModelNotice agentName="X" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("文案函数与组件同源：有名字/无名字两种口径只此一处", () => {
    expect(unboundNoticeText()).toBe("还没有智能体绑定 LLM 连接");
    expect(unboundNoticeText("  ")).toBe("还没有智能体绑定 LLM 连接");
    expect(unboundNoticeText("和小鸣")).toContain("和小鸣");
  });

  it("常驻指引不占 live region：不抢「生成中/失败」的状态播报", () => {
    render(<UnboundModelNotice agentName="X" onGoSettings={vi.fn()} />);
    // role=status 只留给真正的状态变化；这里是静态说明
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("ChatEmptyState（对话空态）", () => {
  const examples = [
    { id: "a", text: "示例一" },
    { id: "b", text: "示例二" },
    { id: "c", text: "示例三" },
  ];

  it("保留原有空态文案，并列出 3 条示例", () => {
    render(<ChatEmptyState examples={examples} onPick={vi.fn()} />);
    expect(screen.getByText("还没有消息")).toBeInTheDocument();
    expect(screen.getByText("发送第一条消息，开始这段对话。")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "对话示例" });
    expect(within(list).getAllByRole("button")).toHaveLength(3);
  });

  it("点示例只回调「填入」，不承担发送职责（用例断言 onclick 只是 onPick）", () => {
    const onPick = vi.fn();
    render(<ChatEmptyState examples={examples} onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: "示例二" }));
    expect(onPick).toHaveBeenCalledWith("示例二");
    // 组件内没有任何表单/发送按钮
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
  });
});

describe("ComposerHints（快捷键提示）", () => {
  it("常驻显示 Enter 发送 / Shift+Enter 换行 / Esc 停止生成", () => {
    render(<ComposerHints />);
    const hints = screen.getByLabelText("输入快捷键提示");
    expect(hints).toHaveTextContent("Enter");
    expect(hints).toHaveTextContent("发送");
    expect(hints).toHaveTextContent("Shift+Enter");
    expect(hints).toHaveTextContent("换行");
    expect(hints).toHaveTextContent("Esc");
    expect(hints).toHaveTextContent("停止生成");
  });

  it("生成中时 Esc 说明切换为「停止生成」（不再重复「生成中可用」）", () => {
    render(<ComposerHints streaming />);
    expect(screen.getByLabelText("输入快捷键提示")).not.toHaveTextContent("生成中可用");
  });
});
