import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AssistantPage } from "./AssistantPage.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useLlmStore } from "../store/llm.js";

/**
 * 智能体页（本轮改为「任务 / 协作」两个视图）：
 * - 任务 = 左名册 + ChatPage（会话驱动）；
 * - 协作 = CollabView（多智能体编排工作台）。
 *
 * ChatPage 换成探针，重点验证：
 * - 两个视图**同一时刻只挂载一个**（不会两份消息列表抢流）；
 * - 旧 Tab 值 chat/tasks 归一为任务视图；pageView 意图（tasks/chat）都落到任务；
 * - 协作视图在可用智能体不足时给出引导。
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
  description: "",
};
const agent2 = {
  id: "a2",
  owner_id: "u1",
  name: "小研",
  avatar: null,
  description: "负责调研",
};

const TAB_KEY = "heming.tab.assistant.v1";

function tab(name: "任务" | "协作") {
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
    conversations: [
      {
        id: "c1",
        type: "agent",
        agent: { id: "a1", name: "和小鸣" },
        unreadCount: 0,
      } as never,
    ],
    agentsRoster: [agent as never],
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

describe("智能体名册：搜索 / 分组 / 编辑常显（d.87）", () => {
  const roster = [
    { id: "system-assistant", owner_id: null, name: "和小鸣", avatar: null, description: "和鸣内置智能体" },
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `own-${i}`,
      owner_id: "u1",
      name: `自建助手${i + 1}`,
      avatar: null,
      description: i === 0 ? "专门写周报" : "",
    })),
  ];

  it("名册 ≥5 个才出现搜索框；按名称/简介过滤，空结果可一键清空", () => {
    useChatStore.setState({ agentsRoster: roster as never });
    render(<AssistantPage />);
    const search = screen.getByLabelText("搜索智能体");
    expect(search).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "周报" } });
    // 只按简介命中的那条留下
    expect(screen.getByRole("button", { name: "与智能体 自建助手1 对话" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "与智能体 自建助手2 对话" })).toBeNull();

    fireEvent.change(search, { target: { value: "不存在的名字" } });
    expect(screen.getByText("没有匹配的智能体")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(screen.getByRole("button", { name: "与智能体 自建助手2 对话" })).toBeInTheDocument();
  });

  it("系统与自建同时存在时打分组标题；只有系统智能体时不加噪", () => {
    useChatStore.setState({ agentsRoster: roster as never });
    const { unmount } = render(<AssistantPage />);
    expect(screen.getByText("系统智能体")).toBeInTheDocument();
    // 左栏表头已经叫「我的智能体」，分组标题用「自建智能体」避免重名
    expect(screen.getByText("自建智能体")).toBeInTheDocument();
    unmount();

    useChatStore.setState({ agentsRoster: [roster[0]] as never });
    render(<AssistantPage />);
    expect(screen.queryByText("系统智能体")).toBeNull();
    expect(screen.queryByText("自建智能体")).toBeNull();
  });

  it("编辑按钮常显（不是 hover 才出现），触控板/键盘也能看到入口", () => {
    useChatStore.setState({ agentsRoster: roster as never });
    render(<AssistantPage />);
    const edit = screen.getByRole("button", { name: "编辑智能体：和小鸣" });
    // 低对比常显：不再是 opacity-0 + group-hover 才可见
    expect(edit.className).toContain("opacity-60");
    expect(edit.className).not.toContain("opacity-0");
    expect(edit).toHaveAttribute("title", "编辑智能体");
  });

  it("名册可折叠：收起后只剩头像入口，再展开恢复名称", () => {
    render(<AssistantPage />);
    fireEvent.click(screen.getByRole("button", { name: "收起智能体名册" }));
    expect(screen.getByRole("button", { name: "展开智能体名册" })).toBeInTheDocument();
    // 折叠态仍可直接点选智能体
    expect(screen.getByRole("button", { name: "与智能体 和小鸣 对话" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开智能体名册" }));
    expect(screen.getByRole("button", { name: "收起智能体名册" })).toBeInTheDocument();
  });
});

describe("智能体页：任务 / 协作 两个视图", () => {
  it("默认落在任务；页面只有一个 h1，空态给出选择与新建入口", () => {
    render(<AssistantPage />);

    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent("智能体");
    expect(tab("任务")).toHaveAttribute("aria-selected", "true");
    expect(tab("协作")).toHaveAttribute("aria-selected", "false");
    expect(screen.getByText("选择一个智能体开始")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建一个智能体" })).toBeInTheDocument();
    expect(document.querySelectorAll(".ui-page-title")).toHaveLength(1);
  });

  it("有会话时显示任务状态条与 ChatPage；切到协作时 ChatPage 卸载", () => {
    useUiStore.setState({ activeConversationId: "c1" });
    // 两位可用智能体：协作视图才会渲染设置表单
    useChatStore.setState({ agentsRoster: [agent, agent2] as never });
    useLlmStore.setState({ bindings: { a1: "p1", a2: "p1" } });
    render(<AssistantPage />);

    expect(screen.getByTestId("chat-standalone")).toBeInTheDocument();
    expect(screen.getByText("与 和小鸣 的会话")).toBeInTheDocument();
    expect(screen.getByText("模型已绑定")).toBeInTheDocument();

    fireEvent.click(tab("协作"));
    expect(screen.queryByTestId("chat-standalone")).not.toBeInTheDocument();
    expect(screen.getByLabelText("协作设置")).toBeInTheDocument();

    fireEvent.click(tab("任务"));
    expect(screen.getByTestId("chat-standalone")).toBeInTheDocument();
    expect(screen.queryByLabelText("协作设置")).not.toBeInTheDocument();
  });

  it("旧 Tab 值 chat/tasks 归一为任务视图（保留会话记忆，不空白）", () => {
    for (const legacy of ["chat", "tasks"]) {
      window.sessionStorage.setItem(TAB_KEY, JSON.stringify(legacy));
      const { unmount } = render(<AssistantPage />);
      expect(tab("任务")).toHaveAttribute("aria-selected", "true");
      unmount();
    }

    window.sessionStorage.setItem(TAB_KEY, JSON.stringify("collab"));
    render(<AssistantPage />);
    expect(tab("协作")).toHaveAttribute("aria-selected", "true");
  });

  it("pageView=tasks 意图：切到任务并消费；之后手动切走不被钉住", async () => {
    useUiStore.setState({ pageView: "tasks" });
    render(<AssistantPage />);

    await waitFor(() => expect(tab("任务")).toHaveAttribute("aria-selected", "true"));
    expect(useUiStore.getState().pageView).toBeNull();

    fireEvent.click(tab("协作"));
    expect(tab("协作")).toHaveAttribute("aria-selected", "true");
  });

  it("通知中心 openConversation（pageView=chat）会把协作切回任务并显示会话", async () => {
    render(<AssistantPage />);
    fireEvent.click(tab("协作"));
    expect(tab("协作")).toHaveAttribute("aria-selected", "true");

    act(() => useUiStore.getState().openConversation("c1"));
    await waitFor(() => expect(tab("任务")).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByTestId("chat-standalone")).toBeInTheDocument();
    expect(screen.getByText("与 和小鸣 的会话")).toBeInTheDocument();
  });

  it("pageView 为其他视图意图时不动 Tab（只消费属于本页的 board/tasks/chat 语义）", () => {
    useUiStore.setState({ pageView: "board" });
    render(<AssistantPage />);
    expect(tab("任务")).toHaveAttribute("aria-selected", "true");
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
  it("名册为空时给出「新建智能体」「从模板创建」两个直达动作", () => {
    useChatStore.setState({ agentsRoster: [] });
    render(<AssistantPage />);

    expect(screen.getByText("还没有自建智能体")).toBeInTheDocument();

    // 从模板创建：打开弹窗，焦点直接落在第一个模板上
    fireEvent.click(screen.getByRole("button", { name: "从模板创建" }));
    expect(screen.getByRole("dialog", { name: "新建智能体" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "使用模板 通用助手" })).toHaveFocus();

    // 关掉后走「新建智能体」：同一个弹窗，焦点落在名称输入框
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "新建智能体" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("新建智能体"));
    expect(screen.getByRole("dialog", { name: "新建智能体" })).toBeInTheDocument();
    expect(screen.getByLabelText("名称")).toHaveFocus();
  });

  it("名册「＋ 新建」入口打开弹窗，焦点在名称上", () => {
    render(<AssistantPage />);
    fireEvent.click(screen.getByRole("button", { name: "新建智能体" }));
    expect(screen.getByRole("dialog", { name: "新建智能体" })).toBeInTheDocument();
    expect(screen.getByLabelText("名称")).toHaveFocus();
  });

  it("创建成功后直接开始对话：切回任务并激活会话，不新增页面/路由", async () => {
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
    // 会话已激活：切回任务视图并直接进入对话（ChatPage 探针）
    expect(tab("任务")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("chat-standalone")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "新建智能体" })).not.toBeInTheDocument();
  });
});
