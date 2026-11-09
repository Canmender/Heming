import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AssistantPage } from "./AssistantPage.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useLlmStore } from "../store/llm.js";

/**
 * 智能体页（本轮把主次调换）：
 * - 左栏 = 对话列表（按最近活跃排序，点一行进那段对话）；
 * - 主区 = 没有选中对话时是智能体选择页；选中后是 ChatPage；
 * - 协作 = CollabView（多智能体编排工作台）。
 *
 * ChatPage 换成探针，重点验证：
 * - 两个视图**同一时刻只挂载一个**（不会两份消息列表抢流）；
 * - 旧 Tab 值 chat/tasks 归一为对话视图；pageView 意图（tasks/chat）都落到对话；
 * - 选择智能体 / 切换智能体 / 新建后直接开聊。
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
  agent: { id: "a1", name: "和小鸣", avatar: null, description: "和鸣内置智能体" },
  unreadCount: 0,
  lastMessageAt: "2026-11-09T03:00:00.000Z",
};
const conv2 = {
  id: "c2",
  type: "agent",
  agent: { id: "a2", name: "小研", avatar: null, description: "负责调研" },
  unreadCount: 0,
  lastMessageAt: "2026-11-08T03:00:00.000Z",
};

const TAB_KEY = "heming.tab.assistant.v1";

function tab(name: "对话" | "协作") {
  return screen.getByRole("tab", { name });
}

beforeEach(() => {
  localStorage.clear();
  useUiStore.setState({
    page: "chat",
    pageView: null,
    activeConversationId: null,
    taskDraft: null,
    taskFocusId: null,
  });
  useChatStore.setState({
    conversations: [conv1] as never,
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

describe("智能体页 · 左栏是对话", () => {
  it("默认没有选中对话时，主区是智能体选择页；左栏列出已有对话", () => {
    render(<AssistantPage />);

    expect(tab("对话")).toHaveAttribute("aria-selected", "true");
    expect(tab("协作")).toHaveAttribute("aria-selected", "false");
    expect(screen.getByText("选择智能体")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "与智能体 和小鸣 对话" })).toBeInTheDocument();
    // 左栏是对话，不是名册：同一智能体只出现一次（对话行），不再有「我的智能体」列表
    expect(screen.getByText("我的对话")).toBeInTheDocument();
    expect(screen.queryByText("我的智能体")).toBeNull();
    expect(document.querySelectorAll(".ui-page-title")).toHaveLength(1);
  });

  it("点左栏对话行进入该对话；主区显示 ChatPage 与状态条", async () => {
    render(<AssistantPage />);
    fireEvent.click(screen.getByRole("button", { name: "打开与 和小鸣 的对话" }));

    expect(useUiStore.getState().activeConversationId).toBe("c1");
    expect(screen.getByTestId("chat-standalone")).toBeInTheDocument();
    expect(screen.getByText("与 和小鸣 的会话")).toBeInTheDocument();
    expect(screen.getByText("模型已绑定")).toBeInTheDocument();
    expect(screen.queryByText("选择智能体")).toBeNull();
  });

  it("对话按最近活跃排序：最近有消息的在前", () => {
    useChatStore.setState({ conversations: [conv2, conv1] as never });
    render(<AssistantPage />);
    const rows = screen.getAllByRole("button", { name: /打开与 .* 的对话/ });
    expect(rows[0]).toHaveAccessibleName("打开与 和小鸣 的对话");
    expect(rows[1]).toHaveAccessibleName("打开与 小研 的对话");
  });

  it("对话 ≥5 条才出现搜索框；按智能体名称过滤，空结果可清空", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      ...conv1,
      id: `cx${i}`,
      agent: { ...conv1.agent, id: `ax${i}`, name: `助手${i + 1}` },
    }));
    useChatStore.setState({ conversations: many as never });
    render(<AssistantPage />);

    const search = screen.getByLabelText("搜索对话");
    fireEvent.change(search, { target: { value: "助手3" } });
    expect(screen.getByRole("button", { name: "打开与 助手3 的对话" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开与 助手4 的对话" })).toBeNull();

    fireEvent.change(search, { target: { value: "不存在" } });
    expect(screen.getByText("没有匹配的对话")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(screen.getByRole("button", { name: "打开与 助手4 的对话" })).toBeInTheDocument();
  });

  it("左栏可折叠：收起后只剩头像入口，再展开恢复名称", () => {
    render(<AssistantPage />);
    fireEvent.click(screen.getByRole("button", { name: "收起对话列表" }));
    expect(screen.getByRole("button", { name: "展开对话列表" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开与 和小鸣 的对话" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开对话列表" }));
    expect(screen.getByRole("button", { name: "收起对话列表" })).toBeInTheDocument();
  });
});

describe("智能体页 · 页面里选智能体", () => {
  it("选择页按系统/自建分组；点卡片开始对话", async () => {
    useChatStore.setState({
      agentsRoster: [{ ...agent, id: "system-assistant", name: "和小鸣" }, agent2] as never,
    });
    useLlmStore.setState({ bindings: { "system-assistant": "p1", a2: "p1" } });
    render(<AssistantPage />);

    expect(screen.getByText("系统智能体")).toBeInTheDocument();
    expect(screen.getByText("自建智能体")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "与智能体 小研 开始对话" }));

    await waitFor(() => expect(useChatStore.getState().openAgent).toHaveBeenCalledWith("a2"));
    expect(useUiStore.getState().activeConversationId).toBe("c1");
    expect(screen.getByTestId("chat-standalone")).toBeInTheDocument();
  });

  it("智能体 ≥5 个才出现搜索框；按名称/简介过滤，空结果可清空", () => {
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

  it("编辑按钮常显（不是 hover 才出现），点开编辑弹窗", () => {
    render(<AssistantPage />);
    const edit = screen.getByRole("button", { name: "编辑智能体：和小鸣" });
    expect(edit.className).toContain("opacity-70");
    expect(edit.className).not.toContain("opacity-0");
    fireEvent.click(edit);
    expect(screen.getByRole("dialog", { name: "编辑智能体" })).toBeInTheDocument();
  });

  it("对话进行中点「切换智能体」回到选择页，对话仍在左栏", () => {
    useUiStore.setState({ activeConversationId: "c1" });
    render(<AssistantPage />);
    expect(screen.getByTestId("chat-standalone")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "切换智能体" }));
    expect(useUiStore.getState().activeConversationId).toBeNull();
    expect(screen.getByText("选择智能体")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开与 和小鸣 的对话" })).toBeInTheDocument();
  });

  it("名册为空时选择页给出「新建智能体」「从模板创建」两个直达动作", () => {
    useChatStore.setState({ agentsRoster: [] });
    render(<AssistantPage />);

    expect(screen.getByText("还没有智能体")).toBeInTheDocument();

    // 页头与空态各有一个入口，取第一个即可（两个都打开同一个弹窗）
    fireEvent.click(screen.getAllByRole("button", { name: "从模板创建" })[0]);
    expect(screen.getByRole("dialog", { name: "新建智能体" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "使用模板 通用助手" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "新建智能体" })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "新建智能体" })[0]);
    expect(screen.getByRole("dialog", { name: "新建智能体" })).toBeInTheDocument();
    expect(screen.getByLabelText("名称")).toHaveFocus();
  });
});

describe("智能体页：对话 / 协作 两个视图", () => {
  it("有会话时显示 ChatPage；切到协作时 ChatPage 卸载", () => {
    useUiStore.setState({ activeConversationId: "c1" });
    // 两位可用智能体：协作视图才会渲染设置表单
    useChatStore.setState({ agentsRoster: [agent, agent2] as never });
    useLlmStore.setState({ bindings: { a1: "p1", a2: "p1" } });
    render(<AssistantPage />);

    expect(screen.getByTestId("chat-standalone")).toBeInTheDocument();

    fireEvent.click(tab("协作"));
    expect(screen.queryByTestId("chat-standalone")).not.toBeInTheDocument();
    expect(screen.getByLabelText("协作设置")).toBeInTheDocument();

    fireEvent.click(tab("对话"));
    expect(screen.getByTestId("chat-standalone")).toBeInTheDocument();
    expect(screen.queryByLabelText("协作设置")).not.toBeInTheDocument();
  });

  it("旧 Tab 值 chat/tasks 归一为对话视图（保留会话记忆，不空白）", () => {
    for (const legacy of ["chat", "tasks"]) {
      window.sessionStorage.setItem(TAB_KEY, JSON.stringify(legacy));
      const { unmount } = render(<AssistantPage />);
      expect(tab("对话")).toHaveAttribute("aria-selected", "true");
      unmount();
    }

    window.sessionStorage.setItem(TAB_KEY, JSON.stringify("collab"));
    render(<AssistantPage />);
    expect(tab("协作")).toHaveAttribute("aria-selected", "true");
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
    render(<AssistantPage />);
    fireEvent.click(tab("协作"));
    expect(tab("协作")).toHaveAttribute("aria-selected", "true");

    act(() => useUiStore.getState().openConversation("c1"));
    await waitFor(() => expect(tab("对话")).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByTestId("chat-standalone")).toBeInTheDocument();
    expect(screen.getByText("与 和小鸣 的会话")).toBeInTheDocument();
  });

  it("pageView 为其他视图意图时不动 Tab（只消费属于本页的 board/tasks/chat 语义）", () => {
    useUiStore.setState({ pageView: "board" });
    render(<AssistantPage />);
    expect(tab("对话")).toHaveAttribute("aria-selected", "true");
  });
});

describe("智能体页 · 协作视图入口", () => {
  it("可用智能体不足 2 个时给出新建/绑定引导", () => {
    render(<AssistantPage />);
    fireEvent.click(tab("协作"));
    expect(screen.getByText("至少需要 2 个已绑定模型的智能体")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "去绑定模型" })).toBeInTheDocument();
    // 未绑定模型也会在说明里点出来
    expect(screen.getByText(/当前可用 1 个/)).toBeInTheDocument();
  });

  it("两个已绑定智能体时显示设置表单，任务为空时开始按钮禁用", () => {
    useChatStore.setState({ agentsRoster: [agent, agent2] as never });
    useLlmStore.setState({ bindings: { a1: "p1", a2: "p1" } });
    render(<AssistantPage />);
    fireEvent.click(tab("协作"));

    expect(screen.getByLabelText("协作设置")).toBeInTheDocument();
    const start = screen.getByRole("button", { name: "开始协作" });
    expect(start).toBeDisabled();

    fireEvent.change(screen.getByLabelText("任务描述（必填）"), {
      target: { value: "整理季度复盘" },
    });
    // 默认选中两位已绑定参与者
    expect(start).toBeEnabled();
  });
});

describe("智能体页：新建入口与创建后直接开聊（d.68 简化）", () => {
  it("创建成功后直接开始对话：切回对话并激活会话，不新增页面/路由", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ id: "a9", owner_id: "u1", name: "新助手", avatar: null, description: "" }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    render(<AssistantPage />);
    fireEvent.click(tab("协作"));

    fireEvent.click(screen.getByRole("button", { name: "新建智能体" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "新助手" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(useUiStore.getState().activeConversationId).toBe("c1"));
    expect(useChatStore.getState().openAgent).toHaveBeenCalledWith("a9");
    // 会话已激活：切回对话视图并直接进入对话（ChatPage 探针）
    expect(tab("对话")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("chat-standalone")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "新建智能体" })).not.toBeInTheDocument();
  });
});
