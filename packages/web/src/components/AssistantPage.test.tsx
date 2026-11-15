import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AssistantPage } from "./AssistantPage.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";

/**
 * 会话页（精简外壳后的瘦页面）。
 *
 * 会话列表/改名/删除/搜索已搬到常驻 Sidebar（ConversationRail 不改），本页只剩：
 * - `<h1 class="sr-only">会话</h1>`（页面标题，不再有可见页头/元信息条/Tab）；
 * - 首载失败提示 + 重试；
 * - 有当前会话时渲染 `<ChatPage />`；
 * - 没有会话时的空态「开始新会话」+ 新建入口。
 *
 * ChatPage 换成探针，只验证「什么时候挂载」，不跑对话链路。
 */
vi.mock("./ChatPage.js", () => ({
  ChatPage: () => <div data-testid="chat-page">ChatPage</div>,
}));

/** 内置智能体（shared 的 SYSTEM_AGENT；这里只用到 id/name/avatar）。 */
const systemAgent = {
  id: "system-assistant",
  owner_id: null,
  name: "和小鸣",
  avatar: null,
  description: "和鸣官方预设智能体",
};

const conv1 = {
  id: "c1",
  type: "agent",
  agent: systemAgent,
  unreadCount: 0,
  lastMessageAt: "2026-11-09T03:00:00.000Z",
};
/** openAgent(fresh) 建出来的新会话（id 与 mock 返回值一致）。 */
const convNew = {
  id: "c9",
  type: "agent",
  agent: systemAgent,
  unreadCount: 0,
  lastMessageAt: null,
};

beforeEach(() => {
  localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  useAuthStore.setState({
    user: { id: "u1", username: "alice", displayName: "爱丽丝" },
    status: "authed",
  });
  useUiStore.setState({
    page: "chat",
    pageView: null,
    activeConversationId: null,
    paletteIntent: null,
  });
  useChatStore.setState({
    conversations: [] as never,
    messages: {} as never,
    workspaceReady: true,
    workspaceError: "",
    conversationsHasMore: false,
    conversationsLoadingMore: false,
    loadWorkspace: vi.fn(async () => undefined),
    loadMoreConversations: vi.fn(async () => undefined),
    // 新建会话的返回值：会话已预先放进 conversations（模拟 store 建完并刷新后的状态）。
    openAgent: vi.fn(async () => "c9"),
  });
});

afterEach(() => {
  cleanup();
});

describe("会话页结构（精简后只剩标题 + 会话内容）", () => {
  it("只有一个 sr-only 的 h1「会话」，没有 Tab/名册/元信息条，也不再自带会话栏", () => {
    render(<AssistantPage />);

    const heading = screen.getByRole("heading", { level: 1, name: "会话" });
    expect(heading).toHaveClass("sr-only");
    expect(heading).toHaveTextContent("会话");
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByText("智能体名册")).toBeNull();
    expect(screen.queryByText("协作设置")).toBeNull();
    // 会话列表已在常驻 Sidebar 里，页面内部不再渲染 rail。
    expect(screen.queryByRole("heading", { name: "会话列表" })).toBeNull();
    // 也删掉了「与 X 的会话」元信息条与模型绑定状态条。
    expect(screen.queryByText(/与 .* 的会话/)).toBeNull();
    expect(screen.queryByText("模型已绑定")).toBeNull();
    expect(screen.queryByText("未绑定模型")).toBeNull();
  });
});

describe("没有会话：空态与新建入口", () => {
  it("空态给「开始新会话」，不挂 ChatPage", () => {
    render(<AssistantPage />);

    expect(screen.getByText("开始新会话")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建会话" })).toBeInTheDocument();
    expect(screen.queryByTestId("chat-page")).toBeNull();
  });

  it("点新建会话 → 直接建 fresh 会话（单智能体，不再选人）并打开", async () => {
    useChatStore.setState({ conversations: [conv1, convNew] as never });
    render(<AssistantPage />);

    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));

    await waitFor(() =>
      expect(useChatStore.getState().openAgent).toHaveBeenCalledWith("system-assistant", {
        fresh: true,
      }),
    );
    await waitFor(() => expect(useUiStore.getState().activeConversationId).toBe("c9"));
    expect(screen.getByTestId("chat-page")).toBeInTheDocument();
  });
});

describe("有会话：主区渲染 ChatPage", () => {
  it("选中会话时只挂一个独立 ChatPage，不再有 embedded/空态", () => {
    useChatStore.setState({ conversations: [conv1, convNew] as never });
    useUiStore.setState({ activeConversationId: "c1" });
    render(<AssistantPage />);

    expect(screen.getByTestId("chat-page")).toBeInTheDocument();
    expect(screen.queryByText("开始新会话")).toBeNull();
  });
});

describe("首载失败", () => {
  it("页头下方 alert + 重试按钮", async () => {
    useChatStore.setState({ workspaceReady: false, workspaceError: "网络断了" });
    render(<AssistantPage />);

    expect(screen.getByRole("alert")).toHaveTextContent("会话列表加载失败：网络断了");
    // 首载由常驻 Sidebar 触发；会话页自己的「重试」只调一次。
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(useChatStore.getState().loadWorkspace).toHaveBeenCalledTimes(1));
  });
});
