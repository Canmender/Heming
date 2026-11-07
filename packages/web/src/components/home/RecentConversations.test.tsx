import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { RecentConversations } from "./RecentConversations.js";
import { useChatStore } from "../../store/chat.js";
import { useUiStore } from "../../store/ui.js";

/** 首页「最近对话」：按最后消息时间排序、点一下进那个会话、空态给出口。 */

const conv = (id: string, name: string, lastMessageAt: string | null, unreadCount = 0) => ({
  id,
  type: "agent" as const,
  agent: { id: `a-${id}`, name, avatar: null, owner_id: "u1", description: "" },
  unreadCount,
  lastMessageAt,
});

beforeEach(() => {
  localStorage.clear();
  useChatStore.setState({ conversations: [] });
  useUiStore.setState({ page: "home", activeConversationId: null });
});

describe("RecentConversations", () => {
  it("空态：说明 + 去智能体页的按钮", () => {
    render(<RecentConversations />);
    const card = screen.getByRole("region", { name: "最近对话" });
    expect(within(card).getByText(/还没有对话/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "去智能体页" }));
    expect(useUiStore.getState().page).toBe("chat");
  });

  it("按最后消息时间倒序取前 3 个；显示未读角标；点击进会话", () => {
    const t = (minutesAgo: number) =>
      new Date(Date.now() - minutesAgo * 60_000).toISOString();
    useChatStore.setState({
      conversations: [
        conv("c-old", "旧会话", t(600)),
        conv("c-new", "新会话", t(1), 3),
        conv("c-mid", "中间会话", t(60)),
        conv("c-4", "第四个不该出现", t(120)),
      ] as never,
    });

    render(<RecentConversations />);
    const card = screen.getByRole("region", { name: "最近对话" });
    const buttons = within(card).getAllByRole("button", { name: /^继续与/ });
    expect(buttons).toHaveLength(3);
    expect(buttons[0].textContent).toContain("新会话");
    expect(buttons[1].textContent).toContain("中间会话");
    // 第三个是 2 小时前那条；12 小时前的「旧会话」被截掉（只取前 3）
    expect(buttons[2].textContent).toContain("第四个不该出现");
    expect(within(card).queryByText("旧会话")).toBeNull();
    expect(within(card).getByText("3")).toBeInTheDocument(); // 未读角标

    fireEvent.click(buttons[1]);
    expect(useUiStore.getState().page).toBe("chat");
    expect(useUiStore.getState().activeConversationId).toBe("c-mid");
  });

  it("还没有消息的会话显示「还没有消息」，不会被当成最近（排在后面）", () => {
    useChatStore.setState({
      conversations: [
        conv("c-empty", "空会话", null),
        conv("c-recent", "刚聊过", new Date(Date.now() - 60_000).toISOString()),
      ] as never,
    });
    render(<RecentConversations />);
    const card = screen.getByRole("region", { name: "最近对话" });
    const buttons = within(card).getAllByRole("button", { name: /^继续与/ });
    expect(buttons[0].textContent).toContain("刚聊过");
    expect(buttons[1].textContent).toContain("空会话");
    expect(within(card).getByText("还没有消息")).toBeInTheDocument();
  });
});
