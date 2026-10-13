import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { User } from "@heming/shared";
import { HomePage } from "./HomePage.js";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";
import { useTokenUsageStore, monthKeyOf, daysOfMonth } from "../store/tokenUsage.js";

const user: User = { id: "u1", username: "alice", displayName: "测试阿丽" };

const conv = (id: string) => ({ id, type: "direct" as const, peer: user });

const now = new Date();
const at = (day: number, hour = 12) =>
  new Date(now.getFullYear(), now.getMonth(), day, hour).toISOString();
const dayKey = (day: number) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

describe("HomePage", () => {
  beforeEach(() => {
    useTokenUsageStore.getState().reset();
    useAuthStore.setState({ token: "t1", user, status: "authed", error: null });
    useChatStore.setState({
      conversations: [conv("c1"), conv("c2")],
      friends: [],
      incoming: [],
      messages: {},
    });
  });

  it("渲染问候与三张统计卡", () => {
    render(<HomePage />);
    const h = new Date().getHours();
    const greeting = h < 6 ? "夜深了" : h < 12 ? "早上好" : h < 18 ? "下午好" : "晚上好";
    expect(
      screen.getByRole("heading", { name: new RegExp(`${greeting}，${user.displayName}`) }),
    ).toBeInTheDocument();
    expect(screen.getByText("会话总数")).toBeInTheDocument();
    expect(screen.getByText("我的智能体")).toBeInTheDocument();
    expect(screen.getByText("知识库文档")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument(); // 会话总数 = 注入的两条
  });

  it("个人视图显示当月汇总（读取时按月重算）", () => {
    useTokenUsageStore.getState().record("claude-sonnet-5", 1200, at(1));
    useTokenUsageStore.getState().record("claude-sonnet-5", 800, at(13, 9));
    useTokenUsageStore.getState().record("deepseek-v3", 300, at(13, 10));
    render(<HomePage />);
    expect(screen.getByText("2.3")).toBeInTheDocument(); // 2300 tokens → 2.3K
    expect(screen.getByText("claude-sonnet-5")).toBeInTheDocument();
    expect(screen.getByText("2000")).toBeInTheDocument();
    expect(screen.getByText("deepseek-v3")).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
  });

  it("按日期：当月全日期行，零值天显示 0", () => {
    useTokenUsageStore.getState().record("claude-sonnet-5", 1200, at(1));
    render(<HomePage />);
    fireEvent.click(screen.getByRole("button", { name: "按日期" }));

    const rows = document.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(daysOfMonth(monthKeyOf(new Date().toISOString())).length);

    const zeroRow = screen.getByText(dayKey(15)).closest("tr") as HTMLElement;
    expect(within(zeroRow).getByText("0")).toBeInTheDocument();
    const day1Row = screen.getByText(dayKey(1)).closest("tr") as HTMLElement;
    expect(within(day1Row).getByText("1200")).toBeInTheDocument();
  });

  it("点某行「查看」展开该行 byModel 明细", async () => {
    useTokenUsageStore.getState().record("claude-sonnet-5", 800, at(13, 9));
    useTokenUsageStore.getState().record("deepseek-v3", 300, at(13, 10));
    render(<HomePage />);
    fireEvent.click(screen.getByRole("button", { name: "按日期" }));

    const row = screen.getByText(dayKey(13)).closest("tr") as HTMLElement;
    expect(within(row).getByText("1100")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "查看" }));

    expect(await screen.findByText("claude-sonnet-5")).toBeInTheDocument();
    expect(screen.getByText("800")).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起" })).toBeInTheDocument();
  });
});
