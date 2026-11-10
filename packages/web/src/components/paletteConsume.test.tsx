import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { AssistantPage } from "./AssistantPage.js";
import { NotificationCenter } from "./NotificationCenter.js";
import { useUiStore } from "../store/ui.js";
import { useChatStore } from "../store/chat.js";
import { useNotificationStore } from "../store/notifications.js";

// 只验「命令面板意图到达后，消费端会打开对应浮层并清空意图」这条接线，
// 不在这里跑完整对话链路：把 ChatPage 与名册请求都按掉。
vi.mock("./ChatPage.js", () => ({ ChatPage: () => null }));

/**
 * 命令面板意图消费点（d.60）。
 *
 * 命令面板（可能在被懒加载的页面里）只投内存意图，真正的开关在
 * `AssistantPage`（新建智能体的**编辑页**，d.126 起不再弹窗）与
 * `NotificationCenter`（通知中心浮层）里。
 * 这两个用例锁住：**意图到达 → 视图打开 → 意图被清空**（幂等、不重复打开）。
 */
describe("命令面板意图消费 · 新建智能体", () => {
  beforeEach(() => {
    localStorage.clear();
    window.sessionStorage.clear();
    useUiStore.setState({ page: "chat", paletteIntent: null });
    // 名册/会话加载是网络操作，这里直接替换成空实现，避免测试打真实接口。
    useChatStore.setState({
      conversations: [],
      agentsRoster: [],
      loadWorkspace: vi.fn(async () => {}),
      loadAgentsRoster: vi.fn(async () => {}),
      openAgent: vi.fn(async (_agentId: string) => ""),
    });
  });
  afterEach(() => cleanup());

  it("收到 agent-create 意图后打开新建智能体编辑页，并清空意图", async () => {
    render(<AssistantPage />);
    expect(screen.queryByRole("heading", { name: "新建智能体" })).not.toBeInTheDocument();

    act(() => {
      useUiStore.getState().setPaletteIntent("agent-create");
    });

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "新建智能体" })).toBeInTheDocument(),
    );
    // d.126：编辑智能体是页内视图，不再是模态弹窗
    expect(screen.queryByRole("dialog", { name: "新建智能体" })).not.toBeInTheDocument();
    expect(useUiStore.getState().paletteIntent).toBeNull();
  });

  it("意图被消费后不会再次打开（关掉编辑页后保持关闭）", async () => {
    render(<AssistantPage />);
    act(() => {
      useUiStore.getState().setPaletteIntent("agent-create");
    });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "新建智能体" })).toBeInTheDocument(),
    );
    act(() => {
      screen.getByRole("button", { name: "取消" }).click();
    });
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "新建智能体" })).not.toBeInTheDocument(),
    );
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
