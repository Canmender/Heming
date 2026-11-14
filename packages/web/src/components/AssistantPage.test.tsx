import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AssistantPage } from "./AssistantPage.js";
import { useChatStore } from "../store/chat.js";
import { clearDraft, hasDraft, setDraft } from "../lib/drafts.js";
import { useUiStore } from "../store/ui.js";
import { useLlmStore } from "../store/llm.js";
import { useAuthStore } from "../store/auth.js";

/**
 * 会话页（单智能体 · 会话模式，d.150）。
 *
 * 产品只剩一个内置智能体，页面从「三 Tab 的智能体页」收口成纯会话页：
 * - 没有一级 Tab、没有智能体名册/编辑页、没有多智能体协作视图；
 * - 左侧 ConversationRail 是一条扁平会话列表，新建会话直接建 fresh 会话；
 * - 右侧是状态条 + embedded ChatPage（没有选中会话时是新建会话空态）。
 *
 * ChatPage 换成探针，只验证「谁在什么时候挂载」，不跑对话链路。
 */
vi.mock("./ChatPage.js", () => ({
  ChatPage: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid={embedded ? "chat-embed" : "chat-standalone"}>
      {embedded ? "embedded" : "standalone"}
    </div>
  ),
}));

/** 内置智能体（shared 的 SYSTEM_AGENT；这里只用到 id/name/avatar）。 */
const systemAgent = {
  id: "system-assistant",
  owner_id: null,
  name: "和小鸣",
  avatar: null,
  description: "和鸣官方预设智能体",
};

const profile = { id: "p1", label: "本地", provider: "openai" as const, apiKey: "k", model: "m" };

const conv1 = {
  id: "c1",
  type: "agent",
  agent: systemAgent,
  unreadCount: 0,
  lastMessageAt: "2026-11-09T03:00:00.000Z",
};
const conv2 = {
  id: "c2",
  type: "agent",
  agent: systemAgent,
  unreadCount: 0,
  lastMessageAt: "2026-11-08T03:00:00.000Z",
};
/** openAgent(fresh) 建出来的新会话（id 与 mock 返回值一致）。 */
const convNew = {
  id: "c9",
  type: "agent",
  agent: systemAgent,
  unreadCount: 0,
  lastMessageAt: null,
};
/** 服务端有 title 的会话：用来证明搜索只看会话名，不看消息正文。 */
const convTitled = {
  id: "c3",
  type: "agent",
  agent: systemAgent,
  title: "竞品调研",
  unreadCount: 0,
  lastMessageAt: null,
};

function userMessage(id: string, convId: string, text: string) {
  return {
    id,
    conversationId: convId,
    senderType: "user" as const,
    senderId: "u1",
    payload: { text },
    createdAt: "2026-11-09T03:00:00.000Z",
    enc: "plain" as const,
  };
}

const messages: Record<string, unknown[]> = {
  c1: [userMessage("m1", "c1", "整理一下这周的会议纪要")],
  c2: [userMessage("m2", "c2", "调研一下竞品定价")],
  c3: [userMessage("m3", "c3", "整理一下这周的会议纪要")],
};

/** 主区空态的「新建会话」（rail 顶部还有一个同名按钮，取 DOM 里最后一个 = 主区）。 */
function mainNewConversationButton(): HTMLElement {
  const buttons = screen.getAllByRole("button", { name: "新建会话" });
  return buttons[buttons.length - 1]!;
}

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
    taskDraft: null,
    taskFocusId: null,
    paletteIntent: null,
  });
  useChatStore.setState({
    conversations: [conv1, conv2] as never,
    messages: messages as never,
    workspaceReady: true,
    workspaceError: "",
    conversationsHasMore: false,
    conversationsLoadingMore: false,
    loadWorkspace: vi.fn(async () => undefined),
    loadMoreConversations: vi.fn(async () => undefined),
    // 新建会话的返回值：会话已预先放进 conversations（模拟 store 建完并刷新后的状态）。
    openAgent: vi.fn(async () => "c9"),
    renameConversation: vi.fn(async () => undefined),
    deleteConversation: vi.fn(async () => undefined),
  });
  useLlmStore.setState({
    profiles: [profile],
    bindings: { "system-assistant": "p1" },
    prompts: {},
    routes: [],
  });
});

describe("会话页结构 · 单智能体、没有 Tab", () => {
  it("没有一级 Tab、智能体名册、协作视图或自建智能体入口", () => {
    render(<AssistantPage />);

    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByText("智能体名册")).toBeNull();
    expect(screen.queryByText("协作设置")).toBeNull();
    expect(screen.queryByText("新建智能体")).toBeNull();
    expect(screen.queryByText("选择智能体")).toBeNull();
    // 页头是「会话」，主区空态引导新建会话
    expect(screen.getByRole("heading", { name: "会话" })).toBeInTheDocument();
    expect(screen.getByText("开始新会话")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-standalone")).toBeNull();
    expect(screen.queryByTestId("chat-embed")).toBeNull();
  });

  it("旧的 pageView 导航意图读到即清（不再切 Tab）", async () => {
    useUiStore.setState({ pageView: "tasks" });
    render(<AssistantPage />);
    await waitFor(() => expect(useUiStore.getState().pageView).toBeNull());
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("首载失败：页头下方 alert + 重试按钮", async () => {
    useChatStore.setState({ workspaceReady: false, workspaceError: "网络断了" });
    render(<AssistantPage />);

    expect(screen.getByRole("alert")).toHaveTextContent("会话列表加载失败：网络断了");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(useChatStore.getState().loadWorkspace).toHaveBeenCalledTimes(2),
    );
  });
});

describe("会话栏 · 扁平列表与打开会话", () => {
  it("会话扁平展示（不再按智能体分组），当前会话高亮", () => {
    useUiStore.setState({ activeConversationId: "c1" });
    render(<AssistantPage />);

    // 不再有「X 的对话」分组
    expect(screen.queryByRole("region", { name: /的对话/ })).toBeNull();

    const current = screen.getByRole("button", { name: "打开会话：整理一下这周的会议纪要" });
    expect(current).toHaveAttribute("aria-current", "true");
    expect(
      screen.getByRole("button", { name: "打开会话：调研一下竞品定价" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("选中会话：状态条 + 单个 embedded ChatPage；点另一条会话就地切换", () => {
    useUiStore.setState({ activeConversationId: "c1" });
    render(<AssistantPage />);

    expect(screen.getByText("与 和小鸣 的会话")).toBeInTheDocument();
    expect(screen.getAllByTestId("chat-embed")).toHaveLength(1);
    expect(screen.queryByTestId("chat-standalone")).toBeNull();
    expect(screen.queryByText("开始新会话")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "打开会话：调研一下竞品定价" }));
    expect(useUiStore.getState().activeConversationId).toBe("c2");
    expect(screen.getAllByTestId("chat-embed")).toHaveLength(1);
  });

  it("模型已绑定时状态条给「模型已绑定」；未绑定时提示并可去「模型设置」", () => {
    useUiStore.setState({ activeConversationId: "c1" });
    const first = render(<AssistantPage />);
    expect(screen.getByText("模型已绑定")).toBeInTheDocument();
    first.unmount();

    useLlmStore.setState({ bindings: {} });
    render(<AssistantPage />);
    expect(screen.getByText("未绑定模型")).toBeInTheDocument();
    expect(screen.getByText("未绑定模型")).toHaveAttribute(
      "title",
      "还没有绑定模型，发送会失败",
    );

    fireEvent.click(screen.getByRole("button", { name: "模型设置" }));
    expect(useUiStore.getState().page).toBe("model");
  });
});

describe("新建会话", () => {
  it("主区空态「新建会话」→ 直接建 fresh 会话（单智能体，不再选人）并打开", async () => {
    useChatStore.setState({ conversations: [conv1, conv2, convNew] as never });
    render(<AssistantPage />);

    fireEvent.click(mainNewConversationButton());

    await waitFor(() =>
      expect(useChatStore.getState().openAgent).toHaveBeenCalledWith("system-assistant", {
        fresh: true,
      }),
    );
    await waitFor(() => expect(useUiStore.getState().activeConversationId).toBe("c9"));
    expect(screen.getByTestId("chat-embed")).toBeInTheDocument();
  });

  it("会话栏顶部「新建会话」走同一个入口", async () => {
    useChatStore.setState({ conversations: [conv1, conv2, convNew] as never });
    render(<AssistantPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "新建会话" })[0]!);

    await waitFor(() =>
      expect(useChatStore.getState().openAgent).toHaveBeenCalledWith("system-assistant", {
        fresh: true,
      }),
    );
    await waitFor(() => expect(useUiStore.getState().activeConversationId).toBe("c9"));
  });

  it("新建失败：错误进 rail 底部 alert，主区仍是空态", async () => {
    useChatStore.setState({
      openAgent: vi.fn(async () => {
        throw new Error("服务不可用");
      }),
    });
    render(<AssistantPage />);
    fireEvent.click(mainNewConversationButton());

    expect(await screen.findByRole("alert")).toHaveTextContent("新建会话失败：服务不可用");
    expect(useUiStore.getState().activeConversationId).toBeNull();
    expect(screen.getByText("开始新会话")).toBeInTheDocument();
  });

  it("进行中防重：按钮 busy 且再次点击不会再建", async () => {
    let resolve: (id: string) => void = () => {};
    const pending = new Promise<string>((r) => {
      resolve = r;
    });
    useChatStore.setState({ openAgent: vi.fn(() => pending) });
    render(<AssistantPage />);

    fireEvent.click(mainNewConversationButton());
    await waitFor(() => expect(screen.getByText("新建中…")).toBeInTheDocument());
    expect(screen.getByText("新建中…").closest("button")).toHaveAttribute("aria-busy", "true");

    fireEvent.click(screen.getByText("新建中…"));
    expect(useChatStore.getState().openAgent).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve("c9");
      await pending;
    });
    await waitFor(() => expect(useUiStore.getState().activeConversationId).toBe("c9"));
  });
});

describe("改名与删除", () => {
  function openRowMenu(title: string) {
    fireEvent.click(screen.getByRole("button", { name: `会话操作：${title}` }));
  }

  it("行内改名：输入新名字保存后调用 renameConversation", async () => {
    render(<AssistantPage />);
    openRowMenu("整理一下这周的会议纪要");
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    fireEvent.change(screen.getByLabelText("会话名称"), { target: { value: "周会纪要" } });
    fireEvent.click(screen.getByRole("button", { name: "保存会话名称" }));

    await waitFor(() =>
      expect(useChatStore.getState().renameConversation).toHaveBeenCalledWith(
        "c1",
        "周会纪要",
      ),
    );
  });

  it("改名失败：页内错误条给原因，输入保留可重试", async () => {
    useChatStore.setState({
      renameConversation: vi.fn(async () => {
        throw new Error("服务端拒绝");
      }),
    });
    render(<AssistantPage />);
    openRowMenu("整理一下这周的会议纪要");
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    fireEvent.change(screen.getByLabelText("会话名称"), { target: { value: "周会纪要" } });
    fireEvent.click(screen.getByRole("button", { name: "保存会话名称" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("改名失败：服务端拒绝");
    expect(screen.getByLabelText("会话名称")).toHaveValue("周会纪要");
  });

  it("删除有二次确认；确认后删会话、清草稿，当前会话回空态", async () => {
    setDraft("c1", "没发出去的话");
    useUiStore.setState({ activeConversationId: "c1" });
    render(<AssistantPage />);

    openRowMenu("整理一下这周的会议纪要");
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    const dialog = screen.getByRole("dialog", { name: "删除这段会话" });
    expect(dialog).toHaveTextContent("删除「整理一下这周的会议纪要」？");
    expect(dialog).toHaveTextContent("不可恢复");

    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(useChatStore.getState().deleteConversation).toHaveBeenCalledWith("c1"),
    );
    expect(hasDraft("c1")).toBe(false);
    expect(useUiStore.getState().activeConversationId).toBeNull();
    expect(screen.queryByTestId("chat-embed")).toBeNull();
    expect(screen.getByText("开始新会话")).toBeInTheDocument();
  });

  it("取消删除不调用接口，对话保持打开", () => {
    useUiStore.setState({ activeConversationId: "c1" });
    render(<AssistantPage />);
    openRowMenu("整理一下这周的会议纪要");
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "删除这段会话" })).getByRole("button", {
        name: "取消",
      }),
    );

    expect(screen.queryByRole("dialog", { name: "删除这段会话" })).toBeNull();
    expect(useChatStore.getState().deleteConversation).not.toHaveBeenCalled();
    expect(useUiStore.getState().activeConversationId).toBe("c1");
  });
});

describe("搜索与分页", () => {
  it("搜索只匹配会话名，不匹配消息正文", async () => {
    useChatStore.setState({ conversations: [conv1, convTitled] as never });
    render(<AssistantPage />);
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    const search = screen.getByLabelText("搜索会话");

    // c3 的 title 是「竞品调研」，消息正文却是会议纪要：搜正文不应命中 c3
    fireEvent.change(search, { target: { value: "会议纪要" } });
    expect(
      screen.getByRole("button", { name: "打开会话：整理一下这周的会议纪要" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开会话：竞品调研" })).toBeNull();

    fireEvent.change(search, { target: { value: "竞品" } });
    expect(screen.getByRole("button", { name: "打开会话：竞品调研" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "打开会话：整理一下这周的会议纪要" }),
    ).toBeNull();
  });

  it("无匹配时给空态，「清空搜索」恢复列表", () => {
    render(<AssistantPage />);
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    fireEvent.change(screen.getByLabelText("搜索会话"), { target: { value: "zzz" } });

    expect(screen.getByText("没有匹配的会话")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(screen.queryByText("没有匹配的会话")).toBeNull();
    expect(
      screen.getByRole("button", { name: "打开会话：整理一下这周的会议纪要" }),
    ).toBeInTheDocument();
  });

  it("还有下一页时「加载更多会话」可用", async () => {
    useChatStore.setState({ conversationsHasMore: true });
    render(<AssistantPage />);
    fireEvent.click(screen.getByRole("button", { name: "加载更多会话" }));

    await waitFor(() =>
      expect(useChatStore.getState().loadMoreConversations).toHaveBeenCalledTimes(1),
    );
  });
});

describe("命令面板意图 · 新建会话", () => {
  it("收到 new-session 意图后直接建 fresh 会话并清空意图", async () => {
    useChatStore.setState({ conversations: [conv1, conv2, convNew] as never });
    render(<AssistantPage />);
    act(() => useUiStore.getState().setPaletteIntent("new-session"));

    await waitFor(() =>
      expect(useChatStore.getState().openAgent).toHaveBeenCalledWith("system-assistant", {
        fresh: true,
      }),
    );
    await waitFor(() => expect(useUiStore.getState().activeConversationId).toBe("c9"));
    expect(useUiStore.getState().paletteIntent).toBeNull();
    // 意图消费后不应再出现自建智能体 UI
    expect(screen.queryByText("新建智能体")).toBeNull();
  });
});

// 测试间清理：草稿是模块级内存，避免上一条用例的 c1 草稿影响后续断言。
afterEach(() => {
  clearDraft("c1");
});