import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AssistantPage } from "./AssistantPage.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useLlmStore } from "../store/llm.js";
import { useAuthStore } from "../store/auth.js";

/**
 * 智能体页（d.126 阶段 B）：
 * - 三个一级 Tab：对话 / 协作 / 智能体；
 * - 对话 Tab：Claude Code 风格左栏（新建/搜索、按智能体分组、会话名为一级信息、
 *   当前会话高亮、草稿标识、折叠），主区嵌 ChatPage（embedded）；
 * - 智能体 Tab：名册 + **独立编辑页**（不再弹窗），保存/取消后回名册；
 * - 协作 Tab：CollabView 原样收进。
 *
 * ChatPage 换成探针，重点验证：
 * - 三个视图**同一时刻只挂载一个**；
 * - 旧 Tab 值 work/chat/tasks 归一为对话并回写规范值；pageView 意图（tasks/chat）落到对话；
 * - 编辑页不是 dialog（不再弹窗），删除仍有二次确认。
 */
vi.mock("./ChatPage.js", () => ({
  ChatPage: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid={embedded ? "chat-embed" : "chat-standalone"}>
      {embedded ? "embedded" : "standalone"}
    </div>
  ),
}));

const profile = { id: "p1", label: "本地", provider: "openai" as const, apiKey: "k", model: "m" };
const agent = {
  id: "a1",
  owner_id: "u1",
  name: "和小鸣",
  avatar: null,
  description: "和鸣内置智能体",
};
const agent2 = {
  id: "a2",
  owner_id: "u1",
  name: "小研",
  avatar: null,
  description: "负责调研",
};

const conv1 = {
  id: "c1",
  type: "agent",
  agent: { id: "a1", owner_id: "u1", name: "和小鸣", avatar: null, description: "和鸣内置智能体" },
  unreadCount: 0,
  lastMessageAt: "2026-11-09T03:00:00.000Z",
};
const conv2 = {
  id: "c2",
  type: "agent",
  agent: { id: "a2", owner_id: "u1", name: "小研", avatar: null, description: "负责调研" },
  unreadCount: 0,
  lastMessageAt: "2026-11-08T03:00:00.000Z",
};
const conv3 = {
  id: "c3",
  type: "agent",
  agent: { id: "a2", owner_id: "u1", name: "小研", avatar: null, description: "负责调研" },
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

const TAB_KEY = "heming.tab.assistant.v1";

function tab(name: "对话" | "协作" | "智能体") {
  return screen.getByRole("tab", { name });
}

function seedConversations() {
  useChatStore.setState({
    conversations: [conv1, conv2] as never,
    messages: {
      c1: [userMessage("m1", "c1", "整理一下这周的会议纪要")],
      c2: [userMessage("m2", "c2", "调研一下竞品定价")],
    } as never,
  });
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
  });
  useChatStore.setState({
    conversations: [conv1] as never,
    messages: { c1: [userMessage("m1", "c1", "整理一下这周的会议纪要")] } as never,
    agentsRoster: [agent] as never,
    loadWorkspace: vi.fn(async () => undefined),
    loadAgentsRoster: vi.fn(async () => undefined),
    openAgent: vi.fn(async () => "c1"),
  });
  useLlmStore.setState({
    profiles: [profile],
    bindings: { a1: "p1" },
    prompts: {},
    routes: [],
  });
});

describe("智能体页 · 三个一级 Tab", () => {
  it("默认落在「对话」，三个 Tab 都在且 aria-selected 正确", () => {
    render(<AssistantPage />);

    expect(tab("对话")).toHaveAttribute("aria-selected", "true");
    expect(tab("协作")).toHaveAttribute("aria-selected", "false");
    expect(tab("智能体")).toHaveAttribute("aria-selected", "false");
    // 对话 Tab 没有选中会话时主区是智能体选择页（选一个再进 embedded ChatPage）
    expect(screen.getByText("选择智能体")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-standalone")).toBeNull();
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  });

  it("点「协作」/「智能体」互斥切换：同一时刻只渲染一个视图", () => {
    // 协作视图需要两位已绑定模型的参与者才会渲染设置表单
    useChatStore.setState({ agentsRoster: [agent, agent2] as never });
    useLlmStore.setState({ bindings: { a1: "p1", a2: "p1" } });
    render(<AssistantPage />);

    fireEvent.click(tab("协作"));
    expect(tab("协作")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("协作设置")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-embed")).not.toBeInTheDocument();

    fireEvent.click(tab("智能体"));
    expect(tab("智能体")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("智能体名册")).toBeInTheDocument();
    expect(screen.queryByLabelText("协作设置")).not.toBeInTheDocument();

    fireEvent.click(tab("对话"));
    expect(screen.getByText("选择智能体")).toBeInTheDocument();
    expect(screen.queryByText("智能体名册")).not.toBeInTheDocument();
  });

  it("旧 Tab 值 work/chat/tasks 归一为「对话」，并回写规范值；collab/agents 各归各位", async () => {
    for (const legacy of ["work", "chat", "tasks"]) {
      window.sessionStorage.setItem(TAB_KEY, JSON.stringify(legacy));
      const { unmount } = render(<AssistantPage />);
      expect(tab("对话")).toHaveAttribute("aria-selected", "true");
      await waitFor(() =>
        expect(JSON.parse(window.sessionStorage.getItem(TAB_KEY) ?? '""')).toBe("chat"),
      );
      unmount();
    }

    window.sessionStorage.setItem(TAB_KEY, JSON.stringify("collab"));
    const collab = render(<AssistantPage />);
    expect(tab("协作")).toHaveAttribute("aria-selected", "true");
    collab.unmount();

    window.sessionStorage.setItem(TAB_KEY, JSON.stringify("agents"));
    render(<AssistantPage />);
    expect(tab("智能体")).toHaveAttribute("aria-selected", "true");
  });

  it("tablist 键盘：左右方向键切换并移动焦点", () => {
    render(<AssistantPage />);
    const chatTab = tab("对话");
    chatTab.focus();

    fireEvent.keyDown(chatTab, { key: "ArrowRight" });
    expect(tab("协作")).toHaveAttribute("aria-selected", "true");
    expect(tab("协作")).toHaveFocus();

    fireEvent.keyDown(tab("协作"), { key: "ArrowLeft" });
    expect(tab("对话")).toHaveAttribute("aria-selected", "true");
    expect(tab("对话")).toHaveFocus();

    fireEvent.keyDown(tab("对话"), { key: "End" });
    expect(tab("智能体")).toHaveAttribute("aria-selected", "true");
  });
});

describe("对话 Tab · Claude Code 风格会话栏", () => {
  it("按智能体分组：组标题是智能体名，组内一级信息是会话名，当前会话高亮", () => {
    seedConversations();
    useUiStore.setState({ activeConversationId: "c1" });
    render(<AssistantPage />);

    // 分组（section 的可访问名）
    expect(screen.getByRole("region", { name: "和小鸣 的对话" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "小研 的对话" })).toBeInTheDocument();

    // 会话名来自首条用户消息，智能体名只在组标题上
    const current = screen.getByRole("button", {
      name: "打开与 和小鸣 的对话：整理一下这周的会议纪要",
    });
    expect(current).toHaveAttribute("aria-current", "true");
    expect(
      screen.getByRole("button", { name: "打开与 小研 的对话：调研一下竞品定价" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("没有可读消息时用时间/「新的对话」兜底，不再只显示智能体名", () => {
    useChatStore.setState({ conversations: [conv3] as never, messages: {} as never });
    render(<AssistantPage />);
    expect(
      screen.getByRole("button", { name: "打开与 小研 的对话：新的对话" }),
    ).toBeInTheDocument();
  });

  it("服务端会话有 title 时优先显示标题（不再从消息推导）", () => {
    useChatStore.setState({
      conversations: [{ ...conv2, title: "竞品调研（第二段）" }] as never,
      messages: {} as never,
    });
    render(<AssistantPage />);
    expect(
      screen.getByRole("button", { name: "打开与 小研 的对话：竞品调研（第二段）" }),
    ).toBeInTheDocument();
  });

  it("组右侧 + 直接新建该智能体的会话；顶部「新建对话」回到选择页", async () => {
    seedConversations();
    render(<AssistantPage />);

    fireEvent.click(screen.getByRole("button", { name: "新建与 小研 的对话" }));
    // d.128：组右侧「＋」是新建一段会话（fresh），不是复用已有会话
    await waitFor(() =>
      expect(useChatStore.getState().openAgent).toHaveBeenCalledWith("a2", { fresh: true }),
    );
    expect(useUiStore.getState().activeConversationId).toBe("c1");
    expect(tab("对话")).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("button", { name: "新建对话" }));
    expect(useUiStore.getState().activeConversationId).toBeNull();
    expect(screen.getByText("选择智能体")).toBeInTheDocument();
  });

  it("搜索先点「搜索」再出现输入框；按会话名/智能体名过滤，可清空", () => {
    seedConversations();
    render(<AssistantPage />);

    expect(screen.queryByLabelText("搜索对话")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));

    const search = screen.getByLabelText("搜索对话");
    expect(search).toHaveFocus();

    fireEvent.change(search, { target: { value: "竞品" } });
    expect(
      screen.getByRole("button", { name: "打开与 小研 的对话：调研一下竞品定价" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "打开与 和小鸣 的对话：整理一下这周的会议纪要" }),
    ).toBeNull();

    fireEvent.change(search, { target: { value: "不存在" } });
    expect(screen.getByText("没有匹配的对话")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(
      screen.getByRole("button", { name: "打开与 和小鸣 的对话：整理一下这周的会议纪要" }),
    ).toBeInTheDocument();
  });

  it("有草稿的会话带「草稿」标识，草稿清理后消失", async () => {
    seedConversations();
    localStorage.setItem(
      "heming.draft.c1",
      JSON.stringify({ text: "还没发出去的话", at: Date.now() }),
    );
    render(<AssistantPage />);
    expect(screen.getByRole("button", { name: /打开与 和小鸣 的对话/ })).toHaveTextContent(
      "草稿",
    );

    act(() => localStorage.removeItem("heming.draft.c1"));
    // 草稿订阅只在写入时通知；这里直接重渲染一次验证标识来自存储
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    fireEvent.change(screen.getByLabelText("搜索对话"), { target: { value: "会议" } });
    expect(screen.getByRole("button", { name: /打开与 和小鸣 的对话/ })).not.toHaveTextContent(
      "草稿",
    );
  });

  it("左栏可折叠：收起后只剩头像入口，再展开恢复会话名", () => {
    seedConversations();
    render(<AssistantPage />);

    fireEvent.click(screen.getByRole("button", { name: "收起对话列表" }));
    expect(screen.getByRole("button", { name: "展开对话列表" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "打开与 和小鸣 的对话：整理一下这周的会议纪要" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开对话列表" }));
    expect(screen.getByRole("button", { name: "收起对话列表" })).toBeInTheDocument();
  });

  it("点会话行进入对话：主区显示状态条与 ChatPage（embedded）", () => {
    seedConversations();
    render(<AssistantPage />);
    fireEvent.click(
      screen.getByRole("button", { name: "打开与 和小鸣 的对话：整理一下这周的会议纪要" }),
    );

    expect(useUiStore.getState().activeConversationId).toBe("c1");
    expect(screen.getByTestId("chat-embed")).toBeInTheDocument();
    expect(screen.getByText("与 和小鸣 的会话")).toBeInTheDocument();
    expect(screen.getByText("模型已绑定")).toBeInTheDocument();
    expect(screen.queryByText("选择智能体")).toBeNull();
  });

  it("对话进行中点「切换智能体」回到选择页，对话仍在左栏", () => {
    seedConversations();
    useUiStore.setState({ activeConversationId: "c1" });
    render(<AssistantPage />);
    expect(screen.getByTestId("chat-embed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "切换智能体" }));
    expect(useUiStore.getState().activeConversationId).toBeNull();
    expect(screen.getByText("选择智能体")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "打开与 和小鸣 的对话：整理一下这周的会议纪要" }),
    ).toBeInTheDocument();
  });
});

describe("对话 Tab · 没有选中会话时的智能体选择页", () => {
  it("系统/自建分组；点卡片开始对话并留在对话 Tab", async () => {
    seedConversations();
    useChatStore.setState({
      agentsRoster: [{ ...agent, id: "system-assistant", name: "和小鸣" }, agent2] as never,
    });
    useLlmStore.setState({ bindings: { "system-assistant": "p1", a2: "p1" } });
    render(<AssistantPage />);

    expect(screen.getByText("选择智能体")).toBeInTheDocument();
    expect(screen.getByText("系统智能体")).toBeInTheDocument();
    expect(screen.getByText("自建智能体")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "与智能体 小研 开始对话" }));
    await waitFor(() => expect(useChatStore.getState().openAgent).toHaveBeenCalledWith("a2"));
    expect(useUiStore.getState().activeConversationId).toBe("c1");
    expect(tab("对话")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("chat-embed")).toBeInTheDocument();
  });

  it("智能体 ≥5 个才出现选择页搜索框；空结果可清空", () => {
    const roster = [
      agent,
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `own-${i}`,
        owner_id: "u1",
        name: `自建助手${i + 1}`,
        avatar: null,
        description: i === 0 ? "专门写周报" : "",
      })),
    ];
    useChatStore.setState({ agentsRoster: roster as never });
    render(<AssistantPage />);

    const search = screen.getByLabelText("搜索智能体");
    fireEvent.change(search, { target: { value: "周报" } });
    expect(screen.getByRole("button", { name: "与智能体 自建助手1 对话" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "与智能体 自建助手2 对话" })).toBeNull();

    fireEvent.change(search, { target: { value: "不存在的名字" } });
    expect(screen.getByText("没有匹配的智能体")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(screen.getByRole("button", { name: "与智能体 自建助手2 对话" })).toBeInTheDocument();
  });

  it("选择页的「编辑」进入智能体 Tab 的编辑页（不是弹窗）", () => {
    useChatStore.setState({ agentsRoster: [agent, agent2] as never });
    render(<AssistantPage />);

    fireEvent.click(screen.getByRole("button", { name: "编辑智能体：小研" }));
    expect(tab("智能体")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "编辑智能体" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "编辑智能体" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("名称")).toHaveValue("小研");
  });

  it("名册为空时选择页给出「新建智能体」「从模板创建」两个直达动作（进编辑页）", () => {
    useChatStore.setState({ agentsRoster: [] });
    render(<AssistantPage />);

    expect(screen.getByText("还没有智能体")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "从模板创建" })[0]);
    expect(tab("智能体")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "新建智能体" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "使用模板 通用助手" })).toHaveFocus();
    expect(screen.queryByRole("dialog", { name: "新建智能体" })).not.toBeInTheDocument();
  });
});

describe("智能体 Tab · 名册与独立编辑页", () => {
  it("名册按系统/自建分组、显示模型绑定状态；编辑打开独立页面，取消回名册", () => {
    useChatStore.setState({
      agentsRoster: [{ ...agent, id: "system-assistant", name: "和小鸣" }, agent2] as never,
    });
    useLlmStore.setState({ bindings: { "system-assistant": "p1" } });
    render(<AssistantPage />);
    fireEvent.click(tab("智能体"));

    expect(screen.getByText("智能体名册")).toBeInTheDocument();
    expect(screen.getByText("系统智能体")).toBeInTheDocument();
    expect(screen.getByText("自建智能体")).toBeInTheDocument();
    expect(screen.getByText("模型已绑定")).toBeInTheDocument();
    // 小研没有绑定
    expect(screen.getAllByText("未绑定模型").length).toBeGreaterThanOrEqual(1);

    // 编辑按钮常显（不是 hover 才出现）
    const edit = screen.getByRole("button", { name: "编辑智能体：小研" });
    expect(edit.className).not.toContain("opacity-0");
    fireEvent.click(edit);
    expect(screen.getByRole("heading", { name: "编辑智能体" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByText("智能体名册")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "编辑智能体" })).toBeNull();
  });

  it("名册搜索：按名称/简介过滤，空结果可清空", () => {
    const roster = [
      agent,
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `own-${i}`,
        owner_id: "u1",
        name: `自建助手${i + 1}`,
        avatar: null,
        description: i === 0 ? "专门写周报" : "",
      })),
    ];
    useChatStore.setState({ agentsRoster: roster as never });
    render(<AssistantPage />);
    fireEvent.click(tab("智能体"));

    const search = screen.getByLabelText("搜索智能体");
    fireEvent.change(search, { target: { value: "周报" } });
    expect(screen.getByRole("button", { name: "与智能体 自建助手1 对话" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "与智能体 自建助手2 对话" })).toBeNull();

    fireEvent.change(search, { target: { value: "不存在" } });
    expect(screen.getByText("没有匹配的智能体")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(screen.getByRole("button", { name: "与智能体 自建助手2 对话" })).toBeInTheDocument();
  });

  it("新建智能体走独立编辑页，保存（创建）后直接开聊并回到对话 Tab", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ id: "a9", owner_id: "u1", name: "新助手", avatar: null, description: "" }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    render(<AssistantPage />);
    fireEvent.click(tab("智能体"));

    fireEvent.click(screen.getByRole("button", { name: "新建智能体" }));
    expect(screen.getByRole("heading", { name: "新建智能体" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "新助手" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(useUiStore.getState().activeConversationId).toBe("c1"));
    expect(useChatStore.getState().openAgent).toHaveBeenCalledWith("a9");
    expect(tab("对话")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("chat-embed")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "新建智能体" })).toBeNull();
  });

  it("编辑本人智能体：保存走 PUT 后回名册；删除仍有应用内二次确认", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    render(<AssistantPage />);
    fireEvent.click(tab("智能体"));
    fireEvent.click(screen.getByRole("button", { name: "编辑智能体：和小鸣" }));

    fireEvent.change(screen.getByLabelText("一句话描述"), { target: { value: "帮我写周报" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(fetchSpy.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true),
    );
    // 保存成功回名册
    await waitFor(() => expect(screen.getByText("智能体名册")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "编辑智能体：和小鸣" }));
    fireEvent.click(screen.getByText("删除智能体"));
    const confirm = screen.getByRole("dialog", { name: "删除智能体" });
    expect(within(confirm).getByText(/此操作不可恢复/)).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(fetchSpy.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true),
    );
    await waitFor(() => expect(screen.getByText("智能体名册")).toBeInTheDocument());
  });

  it("从模板创建：落在第一个模板上，只填空白字段", () => {
    render(<AssistantPage />);
    fireEvent.click(tab("智能体"));
    fireEvent.click(screen.getByRole("button", { name: "从模板创建" }));

    const tpl = screen.getByRole("button", { name: "使用模板 写作润色" });
    fireEvent.click(tpl);
    expect(screen.getByLabelText("名称")).toHaveValue("写作润色");
    expect(tpl).toHaveAttribute("aria-pressed", "true");
  });
});

describe("智能体页 · 协作 Tab 与意图跳转", () => {
  it("协作 Tab 原样收进：可用智能体不足 2 个时给出绑定引导", () => {
    render(<AssistantPage />);
    fireEvent.click(tab("协作"));
    expect(screen.getByText("至少需要 2 个已绑定模型的智能体")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "去绑定模型" })).toBeInTheDocument();
    expect(screen.getByText(/当前可用 1 个/)).toBeInTheDocument();
  });

  it("协作里「新建智能体」也进智能体 Tab 的编辑页", () => {
    render(<AssistantPage />);
    fireEvent.click(tab("协作"));
    fireEvent.click(screen.getByRole("button", { name: "新建智能体" }));
    expect(tab("智能体")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "新建智能体" })).toBeInTheDocument();
  });

  it("pageView=tasks 意图：切到对话并消费；之后手动切走不被钉住", async () => {
    useUiStore.setState({ pageView: "tasks" });
    render(<AssistantPage />);

    await waitFor(() => expect(tab("对话")).toHaveAttribute("aria-selected", "true"));
    expect(useUiStore.getState().pageView).toBeNull();

    fireEvent.click(tab("协作"));
    expect(tab("协作")).toHaveAttribute("aria-selected", "true");
  });

  it("通知中心 openConversation（pageView=chat）会把协作切回对话并显示会话", async () => {
    seedConversations();
    render(<AssistantPage />);
    fireEvent.click(tab("协作"));

    act(() => useUiStore.getState().openConversation("c1"));
    await waitFor(() => expect(tab("对话")).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByTestId("chat-embed")).toBeInTheDocument();
    expect(screen.getByText("与 和小鸣 的会话")).toBeInTheDocument();
  });

  it("命令面板「新建智能体」意图：切到智能体 Tab 并打开编辑页", async () => {
    render(<AssistantPage />);
    act(() => useUiStore.getState().setPaletteIntent("agent-create"));
    await waitFor(() => expect(tab("智能体")).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByRole("heading", { name: "新建智能体" })).toBeInTheDocument();
    expect(useUiStore.getState().paletteIntent).toBeNull();
  });
});
