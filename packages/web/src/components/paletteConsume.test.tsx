import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { AssistantPage } from "./AssistantPage.js";
import { NotificationCenter } from "./NotificationCenter.js";
import { useUiStore } from "../store/ui.js";
import { useChatStore } from "../store/chat.js";
import { useNotificationStore } from "../store/notifications.js";

// 只验「命令面板意图到达后，消费端会执行对应动作并清空意图」这条接线，
// 不在这里跑完整对话链路：把 ChatPage 与会话加载都按掉。
vi.mock("./ChatPage.js", () => ({
  ChatPage: () => <div data-testid="chat-embed" />,
}));

/**
 * 命令面板意图消费点（d.60；d.150 起会话页只有一个内置智能体）。
 *
 * 命令面板（可能在被懒加载的页面里）只投内存意图，真正的动作在
 * `AssistantPage`（「新建会话」→ 直接开一段新会话）与
 * `NotificationCenter`（通知中心浮层）里。
 * 这两个用例锁住：**意图到达 → 动作执行 → 意图被清空**（幂等、不重复执行）。
 */
describe("命令面板意图消费 · 新建会话", () => {
  const conversation = {
    id: "c9",
    type: "agent",
    agent: {
      id: "system-assistant",
      owner_id: null,
      name: "和小鸣",
      avatar: null,
      description: "和鸣官方预设智能体",
    },
    unreadCount: 0,
    lastMessageAt: null,
  };

  beforeEach(() => {
    localStorage.clear();
    window.sessionStorage.clear();
    useUiStore.setState({
      page: "chat",
      paletteIntent: null,
      activeConversationId: null,
    });
    // 会话加载是网络操作，这里直接替换成空实现，避免测试打真实接口。
    useChatStore.setState({
      conversations: [conversation] as never,
      messages: {} as never,
      workspaceReady: true,
      workspaceError: "",
      loadWorkspace: vi.fn(async () => {}),
      openAgent: vi.fn(async () => "c9"),
    });
  });
  afterEach(() => cleanup());

  it("收到 new-session 意图后直接建一段 fresh 会话并打开，意图清空", async () => {
    render(<AssistantPage />);
    expect(screen.queryByText("新建智能体")).toBeNull();
    expect(useUiStore.getState().activeConversationId).toBeNull();

    act(() => {
      useUiStore.getState().setPaletteIntent("new-session");
    });

    await waitFor(() =>
      expect(useChatStore.getState().openAgent).toHaveBeenCalledWith("system-assistant", {
        fresh: true,
      }),
    );
    await waitFor(() => expect(useUiStore.getState().activeConversationId).toBe("c9"));
    // 单智能体产品：不再出现「新建智能体」编辑页/弹窗
    expect(screen.queryByText("新建智能体")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "新建智能体" })).toBeNull();
    expect(useUiStore.getState().paletteIntent).toBeNull();
  });

  it("同一种意图连投两次，token 自增会各自消费一次（不会因 kind 相同被合并）", async () => {
    render(<AssistantPage />);

    act(() => {
      useUiStore.getState().setPaletteIntent("new-session");
    });
    await waitFor(() =>
      expect(useChatStore.getState().openAgent).toHaveBeenCalledTimes(1),
    );
    await waitFor(() => expect(useUiStore.getState().activeConversationId).toBe("c9"));

    // 用户回到空态后再从命令面板「新建会话」：应再建一段，而不是被「已经打开了」挡住
    act(() => {
      useUiStore.setState({ activeConversationId: null });
      useUiStore.getState().setPaletteIntent("new-session");
    });
    await waitFor(() =>
      expect(useChatStore.getState().openAgent).toHaveBeenCalledTimes(2),
    );
    expect(useUiStore.getState().paletteIntent).toBeNull();
  });
});

describe("命令面板意图消费 · 打开通知中心", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ page: "home", paletteIntent: null });
    useNotificationStore.setState({ items: [] });
  });
  afterEach(() => cleanup());

  it("收到 notifications 意图后打开通知中心，并清空意图", async () => {
    render(<NotificationCenter />);
    expect(screen.queryByRole("dialog", { name: "通知中心" })).not.toBeInTheDocument();

    act(() => {
      useUiStore.getState().setPaletteIntent("notifications");
    });

    await waitFor(() => expect(screen.getByRole("dialog", { name: "通知中心" })).toBeInTheDocument());
    expect(useUiStore.getState().paletteIntent).toBeNull();
  });

  it("同一种意图连投两次，第二次仍能把已关闭的浮层重新打开", async () => {
    render(<NotificationCenter />);
    act(() => {
      useUiStore.getState().setPaletteIntent("notifications");
    });
    await waitFor(() => expect(screen.getByRole("dialog", { name: "通知中心" })).toBeInTheDocument());

    // 关掉
    act(() => {
      screen.getByRole("button", { name: "关闭通知中心" }).click();
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "通知中心" })).not.toBeInTheDocument(),
    );

    // 再投一次（token 自增，不会因为 kind 相同被忽略）
    act(() => {
      useUiStore.getState().setPaletteIntent("notifications");
    });
    await waitFor(() => expect(screen.getByRole("dialog", { name: "通知中心" })).toBeInTheDocument());
  });
});