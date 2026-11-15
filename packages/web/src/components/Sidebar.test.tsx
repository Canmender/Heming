import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Sidebar } from "./Sidebar.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";

/**
 * 常驻会话侧栏（Sidebar）。
 *
 * 精简外壳把 ConversationRail 从会话页搬到全局 Sidebar：数据与动作仍由 store 提供，
 * 所以原先 AssistantPage.test 里的 rail 行为（新建/改名/删除/搜索/分页/高亮）与
 * 「命令面板 new-session 意图」用例迁到这里；AssistantPage 只保留页面标题与主区。
 */
const systemAgent = {
  id: "system-assistant",
  owner_id: null,
  name: "和鸣",
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

beforeEach(() => {
  localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  // 栏底账户入口读真实 auth store（名字进 aria-label / 菜单文案）。
  useAuthStore.setState({
    token: "t1",
    user: { id: "u1", username: "alice", displayName: "爱丽丝" },
    status: "authed",
    error: null,
  });
  useUiStore.setState({
    page: "chat",
    pageView: null,
    activeConversationId: null,
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
});

// 每个用例结束都卸载，避免侧栏的搜索/菜单状态泄漏到下一例。
afterEach(() => {
  cleanup();
});

describe("Sidebar · 常驻结构", () => {
  it("会话列表头 + 新建会话入口 + 扁平会话行", () => {
    render(<Sidebar />);

    expect(screen.getByRole("heading", { level: 2, name: "会话列表" })).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "新建会话" }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByRole("button", { name: "打开会话：整理一下这周的会议纪要" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开会话：调研一下竞品定价" })).toBeInTheDocument();
  });

  it("当前会话高亮（aria-current）", () => {
    useUiStore.setState({ activeConversationId: "c1" });
    render(<Sidebar />);

    expect(
      screen.getByRole("button", { name: "打开会话：整理一下这周的会议纪要" }),
    ).toHaveAttribute("aria-current", "true");
    expect(
      screen.getByRole("button", { name: "打开会话：调研一下竞品定价" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("点另一条会话就地切换", () => {
    useUiStore.setState({ activeConversationId: "c1" });
    render(<Sidebar />);

    fireEvent.click(screen.getByRole("button", { name: "打开会话：调研一下竞品定价" }));
    expect(useUiStore.getState().activeConversationId).toBe("c2");
  });
});

describe("Sidebar · 新建会话", () => {
  it("侧栏「新建会话」→ 直接建 fresh 会话并打开（单智能体，不再选人）", async () => {
    useChatStore.setState({ conversations: [conv1, conv2, convNew] as never });
    render(<Sidebar />);

    // 顶部主操作（展开态 rail header）与空态可能同名，取第一个。
    fireEvent.click(screen.getAllByRole("button", { name: "新建会话" })[0]!);

    await waitFor(() =>
      expect(useChatStore.getState().openAgent).toHaveBeenCalledWith("system-assistant", {
        fresh: true,
      }),
    );
    await waitFor(() => expect(useUiStore.getState().activeConversationId).toBe("c9"));
  });

  it("命令面板 new-session 意图：建 fresh 会话、切到会话页并清空意图", async () => {
    useChatStore.setState({ conversations: [conv1, conv2, convNew] as never });
    useUiStore.setState({ page: "settings" });
    render(<Sidebar />);

    act(() => useUiStore.getState().setPaletteIntent("new-session"));

    await waitFor(() =>
      expect(useChatStore.getState().openAgent).toHaveBeenCalledWith("system-assistant", {
        fresh: true,
      }),
    );
    await waitFor(() => expect(useUiStore.getState().activeConversationId).toBe("c9"));
    await waitFor(() => expect(useUiStore.getState().page).toBe("chat"));
    expect(useUiStore.getState().paletteIntent).toBeNull();
  });
});

describe("Sidebar · 改名与删除", () => {
  function openRowMenu(title: string) {
    fireEvent.click(screen.getByRole("button", { name: `会话操作：${title}` }));
  }

  it("行内改名：输入新名字保存后调用 renameConversation", async () => {
    render(<Sidebar />);
    openRowMenu("整理一下这周的会议纪要");
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    fireEvent.change(screen.getByLabelText("会话名称"), { target: { value: "周会纪要" } });
    fireEvent.click(screen.getByRole("button", { name: "保存会话名称" }));

    await waitFor(() =>
      expect(useChatStore.getState().renameConversation).toHaveBeenCalledWith("c1", "周会纪要"),
    );
  });

  it("改名失败：页内错误条给原因，输入保留可重试", async () => {
    useChatStore.setState({
      renameConversation: vi.fn(async () => {
        throw new Error("服务端拒绝");
      }),
    });
    render(<Sidebar />);
    openRowMenu("整理一下这周的会议纪要");
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    fireEvent.change(screen.getByLabelText("会话名称"), { target: { value: "周会纪要" } });
    fireEvent.click(screen.getByRole("button", { name: "保存会话名称" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("改名失败：服务端拒绝");
    expect(screen.getByLabelText("会话名称")).toHaveValue("周会纪要");
  });

  it("删除有二次确认；确认后调用 deleteConversation", async () => {
    useUiStore.setState({ activeConversationId: "c1" });
    render(<Sidebar />);

    openRowMenu("整理一下这周的会议纪要");
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    const dialog = screen.getByRole("dialog", { name: "删除这段会话" });
    expect(dialog).toHaveTextContent("删除「整理一下这周的会议纪要」？");
    expect(dialog).toHaveTextContent("不可恢复");

    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(useChatStore.getState().deleteConversation).toHaveBeenCalledWith("c1"),
    );
  });

  it("取消删除不调用接口", () => {
    useUiStore.setState({ activeConversationId: "c1" });
    render(<Sidebar />);

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

describe("Sidebar · 搜索与分页", () => {
  it("搜索只匹配会话名，不匹配消息正文", () => {
    useChatStore.setState({ conversations: [conv1, convTitled] as never });
    render(<Sidebar />);
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
    render(<Sidebar />);
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
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "加载更多会话" }));

    await waitFor(() =>
      expect(useChatStore.getState().loadMoreConversations).toHaveBeenCalledTimes(1),
    );
  });
});

/**
 * d.147.4.88：身份从顶栏搬进侧栏左下角。
 *
 * 栏头只留「会话列表」（产品名在顶栏手写标志里），栏底原来的隐私文案换成账户入口；
 * 收起态（60px 窄栏）只留头像，名字留给展开态——窄栏连会话名都显示不下，
 * 再塞一个名字会把头像挤变形。
 */
describe("Sidebar · 栏头与账户入口", () => {
  it("栏头只有一行「会话列表」：不再复读「和鸣」，也没有隐私文案", () => {
    render(<Sidebar />);
    const aside = screen
      .getByRole("heading", { level: 2, name: "会话列表" })
      .closest("aside") as HTMLElement;

    expect(aside).not.toBeNull();
    expect(within(aside).queryByRole("heading", { name: "和鸣" })).toBeNull();
    expect(within(aside).queryByText("和鸣")).toBeNull();
    expect(aside.textContent).not.toContain("本机运行");
    expect(aside.textContent).not.toContain("Key 与记忆不出设备");
  });

  it("栏底账户入口：aria-haspopup=menu，菜单里「设置」切页并关闭、「退出登录」走二次确认", async () => {
    render(<Sidebar />);
    const account = screen.getByRole("button", { name: "账户：爱丽丝" });
    expect(account).toHaveAttribute("aria-haspopup", "menu");
    expect(account).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(account);
    const menu = await screen.findByRole("menu", { name: "账户菜单" });
    expect(within(menu).getByRole("menuitem", { name: "设置" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "退出登录" })).toBeInTheDocument();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "设置" }));
    expect(useUiStore.getState().page).toBe("settings");
    expect(screen.queryByRole("menu", { name: "账户菜单" })).toBeNull();

    // 退出登录不直接登出，先弹确认框
    fireEvent.click(screen.getByRole("button", { name: "账户：爱丽丝" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));
    expect(screen.getByRole("dialog", { name: "退出登录" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "退出登录" })).toBeNull();
  });

  it("收起态只留头像（按钮内不显示名字），「展开会话列表」恢复名字", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "收起会话列表" }));

    const collapsedAccount = screen.getByRole("button", { name: "账户：爱丽丝" });
    expect(collapsedAccount.textContent).not.toContain("爱丽丝");
    expect(screen.getByRole("button", { name: "展开会话列表" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开会话列表" }));
    expect(screen.getByRole("button", { name: "账户：爱丽丝" }).textContent).toContain("爱丽丝");
  });
});
