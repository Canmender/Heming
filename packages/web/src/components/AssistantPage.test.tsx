import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AssistantPage } from "./AssistantPage.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { setTaskStorage, useTaskStore } from "../lib/tasks/store.js";
import { setTemplateStorage, useTemplateStore } from "../lib/tasks/templates.js";
import { createMemoryStorage } from "../lib/memory/storage.js";
import { useLlmStore } from "../store/llm.js";

/**
 * 智能体页（d.67 导航合并）：
 * 「对话 / 任务」两个 Tab，任务视图复用原「通用智能体」页（TaskAreaPage 嵌入态）。
 *
 * 两个 Tab 都嵌 ChatPage，所以这里把它换成探针，重点验证：
 * - 切 Tab 时另一个 ChatPage **卸载**（同一时刻只有一个实例，不会两份消息列表抢流）；
 * - 嵌入后页头只有一个 h1（任务视图不再画自己的标题）；
 * - 一次性视图意图 pageView="tasks" 能切 Tab 并消费。
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

function seedTask(prompt = "梳理模块依赖") {
  return useTaskStore.getState().create({
    conversationId: "c1",
    agentId: "a1",
    agentName: "和小鸣",
    prompt,
  });
}

beforeEach(() => {
  localStorage.clear();
  setTaskStorage(createMemoryStorage());
  setTemplateStorage(createMemoryStorage());
  useTaskStore.setState({ tasks: [] });
  useTemplateStore.setState({ templates: [] });
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
  useLlmStore.setState({ profiles: [profile], bindings: { a1: "p1" } });
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
});

describe("智能体页：对话 / 任务 两个 Tab", () => {
  it("默认落在对话；切到任务渲染原通用智能体主体，且页面只有一个 h1", async () => {
    seedTask();
    render(<AssistantPage />);

    // 宿主页页头唯一标题
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent("智能体");
    expect(screen.getByRole("tab", { name: "对话" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("tab", { name: "任务" }));
    expect(screen.getByRole("tab", { name: "任务" })).toHaveAttribute("aria-selected", "true");

    // 任务视图内容在（运行列表 + 搜索/筛选），但不再画自己的「通用智能体」页头
    expect(screen.getByRole("button", { name: "运行 梳理模块依赖" })).toBeInTheDocument();
    expect(screen.getByLabelText("搜索运行记录")).toBeInTheDocument();
    expect(screen.queryByText("通用智能体")).not.toBeInTheDocument();
    // 嵌入后全页仍只有一个 ui-page-title（PageShell 的 h1），不重复
    expect(document.querySelectorAll(".ui-page-title")).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("同一时刻只有一个 ChatPage 实例：切 Tab 时另一个卸载", () => {
    useUiStore.setState({ activeConversationId: "c1" });
    seedTask();
    render(<AssistantPage />);

    expect(screen.getByTestId("chat-standalone")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-embed")).not.toBeInTheDocument();

    // 切到任务：对话态 ChatPage 卸载；选中运行后嵌入式实例才挂载
    fireEvent.click(screen.getByRole("tab", { name: "任务" }));
    expect(screen.queryByTestId("chat-standalone")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "运行 梳理模块依赖" }));
    expect(screen.getByTestId("chat-embed")).toHaveTextContent("embedded");
    expect(screen.queryByTestId("chat-standalone")).not.toBeInTheDocument();

    // 切回对话：嵌入式实例卸载，对话实例回来
    fireEvent.click(screen.getByRole("tab", { name: "对话" }));
    expect(screen.getByTestId("chat-standalone")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-embed")).not.toBeInTheDocument();
  });

  it("pageView=tasks 意图：自动切到任务 Tab 并消费（旧链接 setPage(\"tasks\") 等价写法）", async () => {
    useUiStore.setState({ pageView: "tasks" });
    render(<AssistantPage />);

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "任务" })).toHaveAttribute("aria-selected", "true"),
    );
    expect(useUiStore.getState().pageView).toBeNull();

    // 消费过一次后不再被钉住：手动切回对话就停在对话
    fireEvent.click(screen.getByRole("tab", { name: "对话" }));
    expect(screen.getByRole("tab", { name: "对话" })).toHaveAttribute("aria-selected", "true");
  });

  it("pageView 为其他视图意图时不动 Tab（只消费属于本页的 board/tasks 语义）", () => {
    useUiStore.setState({ pageView: "board" });
    render(<AssistantPage />);
    // 不属于智能体页的意图：不切 Tab，但也不会导致崩溃/重复消费
    expect(screen.getByRole("tab", { name: "对话" })).toHaveAttribute("aria-selected", "true");
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

  it("创建成功后直接开始对话：复用 openAgent + 激活会话，不新增页面/路由", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ id: "a9", owner_id: "u1", name: "新助手", avatar: null, description: "" }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    render(<AssistantPage />);

    fireEvent.click(screen.getByRole("button", { name: "新建智能体" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "新助手" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(useUiStore.getState().activeConversationId).toBe("c1"));
    expect(useChatStore.getState().openAgent).toHaveBeenCalledWith("a9");
    // 会话已激活：右栏直接进入对话（ChatPage 探针），不是停在「选择一个智能体开始」
    expect(screen.getByTestId("chat-standalone")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "新建智能体" })).not.toBeInTheDocument();
  });
});
