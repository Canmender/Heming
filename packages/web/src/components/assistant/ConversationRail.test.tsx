import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Conversation } from "@heming/shared";
import { ConversationRail, type ConversationRailProps } from "./ConversationRail.js";
import { markTurnRunning, resetResumePoint } from "../../lib/agentRuntime/resumePoint.js";
import type { ConversationContentSearchResult } from "../../lib/api.js";

const agent = { id: "a1", owner_id: null, name: "和鸣", avatar: null, description: "" };

function conv(
  id: string,
  title: string,
  workspace?: string,
  lastMessageAt: string | null = "2026-11-15T09:00:00.000Z",
): Conversation {
  return {
    id,
    type: "agent",
    agent,
    unreadCount: 0,
    title,
    lastMessageAt,
    ...(workspace ? { workspace } : {}),
  } as Conversation;
}

function renderRail(over: Partial<ConversationRailProps> = {}) {
  const props: ConversationRailProps = {
    conversations: [],
    workspaces: [],
    activeConversationId: null,
    messages: {},
    onOpen: vi.fn(),
    onNewConversation: vi.fn(),
    onRename: vi.fn(),
    onDeleteRequest: vi.fn(),
    onMoveConversation: vi.fn(async () => {}),
    onAddWorkspace: vi.fn(async () => {}),
    ...over,
  };
  render(<ConversationRail {...props} />);
  return props;
}

function groupHeaderNames(): string[] {
  return screen
    .getAllByRole("button", { name: /^工作区：/ })
    .map((el) => el.getAttribute("aria-label")!.replace("工作区：", ""));
}

afterEach(() => {
  cleanup();
});

describe("ConversationRail · 工作区分组", () => {
  const conversations = [
    conv("c1", "周会纪要", "D:/项目/和鸣", "2026-11-15T09:00:00.000Z"),
    conv("c2", "竞品调研", "D:/项目/其他", "2026-11-14T09:00:00.000Z"),
    conv("c3", "未归档的想法", undefined, "2026-11-13T09:00:00.000Z"),
  ];
  const workspaces = [
    { path: "D:/项目/和鸣", updatedAt: "2026-11-15T00:00:00.000Z" },
    { path: "D:/项目/其他", updatedAt: "2026-11-14T00:00:00.000Z" },
  ];

  it("栏头是「工作区」而不是「会话列表」，并带搜索/新建工作区两个图标", () => {
    renderRail({ conversations, workspaces });
    expect(screen.getByRole("heading", { level: 2, name: "工作区" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "会话列表" })).not.toBeInTheDocument();
    expect(screen.getByTestId("rail-search-toggle")).toHaveAttribute("aria-label", "搜索会话");
    expect(screen.getByTestId("rail-new-workspace")).toHaveAttribute("aria-label", "新建工作区");
  });

  it("按 workspace 分组渲染，未分组永远最后", () => {
    renderRail({ conversations, workspaces });
    expect(groupHeaderNames()).toEqual(["和鸣", "其他", "未分组"]);
    expect(screen.getByRole("button", { name: "打开会话：周会纪要" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开会话：未归档的想法" })).toBeInTheDocument();
  });

  it("清单里的空工作区也成组（刚选的文件夹不能消失）", () => {
    renderRail({
      conversations: [],
      workspaces: [{ path: "D:/空文件夹", updatedAt: "2026-11-15T00:00:00.000Z" }],
    });
    expect(groupHeaderNames()).toEqual(["空文件夹"]);
    const header = screen.getByRole("button", { name: "工作区：空文件夹" });
    expect(header).toHaveAttribute("aria-expanded", "true");
    // 空组只渲染组头（参考图的空文件夹不占一行说明文字）。
    expect(screen.queryByText("暂无会话")).toBeNull();
  });

  it("组头可折叠：aria-expanded 翻转，折叠后组内会话不再渲染", () => {
    renderRail({ conversations, workspaces });
    const header = screen.getByRole("button", { name: "工作区：和鸣" });
    expect(header).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "打开会话：周会纪要" })).not.toBeInTheDocument();
    // 别的组不受影响
    expect(screen.getByRole("button", { name: "打开会话：竞品调研" })).toBeInTheDocument();
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "打开会话：周会纪要" })).toBeInTheDocument();
  });

  it("搜索命中时忽略折叠状态，展开并留下命中的会话", () => {
    renderRail({ conversations, workspaces });
    fireEvent.click(screen.getByRole("button", { name: "工作区：和鸣" }));
    expect(screen.getByRole("button", { name: "工作区：和鸣" })).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "搜索会话" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索会话" }), { target: { value: "纪要" } });

    expect(screen.getByRole("button", { name: "工作区：和鸣" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "打开会话：周会纪要" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开会话：竞品调研" })).not.toBeInTheDocument();
  });

  it("组头「+」直连该工作区（不经过菜单）；栏头主按钮先开菜单，选「未分组」才建会话", () => {
    const props = renderRail({ conversations, workspaces });
    fireEvent.click(screen.getByRole("button", { name: "在 和鸣 新建对话" }));
    expect(props.onNewConversation).toHaveBeenLastCalledWith("D:/项目/和鸣");
    expect(screen.queryByTestId("new-conversation-workspace-menu")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    expect(props.onNewConversation).toHaveBeenCalledTimes(1);
    const menu = screen.getByTestId("new-conversation-workspace-menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "未分组" }));
    expect(props.onNewConversation).toHaveBeenLastCalledWith(null);
    expect(screen.queryByTestId("new-conversation-workspace-menu")).toBeNull();
  });

  it("会话菜单 →「移动到工作区…」打开弹窗，确认后调 onMoveConversation", async () => {
    const props = renderRail({ conversations, workspaces });
    fireEvent.click(screen.getByRole("button", { name: "会话操作：周会纪要" }));
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((el) => el.textContent?.trim()),
    ).toEqual(["重命名", "移动到工作区…", "删除"]);

    fireEvent.click(within(menu).getByRole("menuitem", { name: "移动到工作区…" }));
    const dialog = screen.getByRole("dialog", { name: "移动到工作区" });
    const input = within(dialog).getByRole("textbox", { name: "工作区文件夹路径" });
    expect(input).toHaveValue("D:/项目/和鸣");

    fireEvent.change(input, { target: { value: "D:/项目/新组" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确定" }));
    await waitFor(() => expect(props.onMoveConversation).toHaveBeenCalledWith("c1", "D:/项目/新组"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "移动到工作区" })).not.toBeInTheDocument());
  });

  it("未分组会话的菜单可「移出工作区（未分组）」→ onMoveConversation(id, null)", async () => {
    const props = renderRail({ conversations, workspaces });
    fireEvent.click(screen.getByRole("button", { name: "会话操作：未归档的想法" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "移动到工作区…" }));
    const dialog = screen.getByRole("dialog", { name: "移动到工作区" });
    fireEvent.click(within(dialog).getByRole("button", { name: "移出工作区（未分组）" }));
    await waitFor(() => expect(props.onMoveConversation).toHaveBeenCalledWith("c3", null));
  });

  it("栏头「新建工作区」打开弹窗，确定后调 onAddWorkspace", async () => {
    const props = renderRail({ conversations, workspaces });
    fireEvent.click(screen.getByTestId("rail-new-workspace"));
    const dialog = screen.getByRole("dialog", { name: "新建工作区" });
    const confirm = within(dialog).getByRole("button", { name: "确定" });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "工作区文件夹路径" }), {
      target: { value: " D:/项目/新工作区 " },
    });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(props.onAddWorkspace).toHaveBeenCalledWith("D:/项目/新工作区"));
  });

  it("错误条用 role=alert 显示在栏底", () => {
    renderRail({ conversations, workspaces, error: "移动会话失败：权限不足" });
    expect(screen.getByRole("alert")).toHaveTextContent("移动会话失败：权限不足");
  });
});

describe("ConversationRail · 新对话的工作区选择菜单（d.147.4.92.11）", () => {
  const conversations = [
    conv("c1", "周会纪要", "D:/项目/和鸣", "2026-11-15T09:00:00.000Z"),
    conv("c2", "竞品调研", "D:/项目/其他", "2026-11-14T09:00:00.000Z"),
    conv("c3", "没归档的想法", undefined, "2026-11-13T09:00:00.000Z"),
  ];
  const workspaces = [
    { path: "D:/项目/和鸣", updatedAt: "2026-11-15T00:00:00.000Z" },
    { path: "D:/项目/其他", updatedAt: "2026-11-14T00:00:00.000Z" },
    { path: "D:/空文件夹", updatedAt: "2026-11-15T00:00:00.000Z" },
  ];

  function openPicker() {
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    return screen.getByTestId("new-conversation-workspace-menu");
  }

  it("主按钮不再是「点了就建」：点开菜单、再点收起，aria-expanded 同步", () => {
    const props = renderRail({ conversations, workspaces });
    const button = screen.getByRole("button", { name: "新建会话" });
    expect(button).toHaveAttribute("aria-haspopup", "menu");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("new-conversation-workspace-menu")).toBeNull();

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "选择工作区" });
    expect(within(menu).getByText("新对话建在")).toBeInTheDocument();
    expect(props.onNewConversation).not.toHaveBeenCalled();

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("new-conversation-workspace-menu")).toBeNull();
    expect(props.onNewConversation).not.toHaveBeenCalled();
  });

  it("选项顺序与左栏分组一致（含空工作区、未分组最后），默认落点带 aria-current", () => {
    renderRail({ conversations, workspaces, activeConversationId: "c1" });
    const menu = openPicker();
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((el) => el.textContent?.trim() ?? "");
    expect(items).toEqual(["和鸣", "其他", "空文件夹", "未分组", "新建工作区…"]);
    expect(within(menu).getByRole("menuitem", { name: "和鸣" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(within(menu).getByRole("menuitem", { name: "未分组" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(within(menu).getByRole("menuitem", { name: "和鸣" })).toHaveAttribute(
      "title",
      "D:/项目/和鸣",
    );
  });

  it("没有活动会话时默认落点是「未分组」", () => {
    renderRail({ conversations, workspaces });
    const menu = openPicker();
    expect(within(menu).getByRole("menuitem", { name: "未分组" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("选中某个工作区 → onNewConversation(该路径) 且菜单关闭", () => {
    const props = renderRail({ conversations, workspaces });
    const menu = openPicker();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "其他" }));
    expect(props.onNewConversation).toHaveBeenCalledTimes(1);
    expect(props.onNewConversation).toHaveBeenLastCalledWith("D:/项目/其他");
    expect(screen.queryByTestId("new-conversation-workspace-menu")).toBeNull();
  });

  it("Escape 或点菜单外关闭，且都不建会话", () => {
    const props = renderRail({ conversations, workspaces });
    openPicker();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("new-conversation-workspace-menu")).toBeNull();

    openPicker();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("new-conversation-workspace-menu")).toBeNull();
    expect(props.onNewConversation).not.toHaveBeenCalled();
  });

  it("「新建工作区…」关菜单并打开 new 模式弹窗", () => {
    const props = renderRail({ conversations, workspaces });
    const menu = openPicker();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "新建工作区…" }));
    expect(screen.queryByTestId("new-conversation-workspace-menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "新建工作区" })).toBeInTheDocument();
    expect(props.onNewConversation).not.toHaveBeenCalled();
  });

  it("空列表时空态里的「新建会话」也先开菜单，不直接建会话", () => {
    const props = renderRail();
    expect(screen.getByText("还没有会话")).toBeInTheDocument();
    // [0] 是栏头主按钮，[1] 是空态里的那颗。
    const buttons = screen.getAllByRole("button", { name: "新建会话" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]!);
    const menu = screen.getByTestId("new-conversation-workspace-menu");
    expect(within(menu).getByRole("menuitem", { name: "未分组" })).toBeInTheDocument();
    expect(props.onNewConversation).not.toHaveBeenCalled();
  });
});

describe("会话行「未跑完」徽标（d.196）", () => {
  afterEach(() => {
    localStorage.clear();
    resetResumePoint();
  });

  it("只有那个没跑完的会话带徽标，其它会话不带", () => {
    markTurnRunning({
      conversationId: "c1",
      streamId: "s1",
      agentId: "a1",
      agentName: "和鸣",
      startedAt: Date.now(),
    });
    renderRail({ conversations: [conv("c1", "长任务"), conv("c2", "另一个")] });
    const unfinished = screen.getByRole("button", { name: "打开会话：长任务" });
    const other = screen.getByRole("button", { name: "打开会话：另一个" });
    expect(within(unfinished).getByText("未跑完")).toBeInTheDocument();
    expect(within(other).queryByText("未跑完")).toBeNull();
  });
});

/**
 * d.197：左栏搜索从「只匹配会话名」扩到「也匹配消息正文」。
 *
 * 这里用注入的 `onSearchContent` 代替真请求：rail 只负责「什么时候发、结果怎么并进列表」，
 * 服务端的匹配与鉴权在 `packages/server/src/app.test.ts` 里测。
 */
const workspaces = [{ path: "D:/项目/和鸣", updatedAt: "2026-11-15T00:00:00.000Z" }];

function searchResult(
  over: Partial<ConversationContentSearchResult> = {},
): ConversationContentSearchResult {
  return {
    hits: [
      {
        conversationId: "c2",
        conversationTitle: "竞品调研",
        lastMessageAt: "2026-11-14T09:00:00.000Z",
        messageId: "m1",
        senderType: "user",
        createdAt: "2026-11-14T08:00:00.000Z",
        snippet: "…把 eval 跑一遍，全部通过…",
      },
    ],
    truncated: false,
    scanned: 12,
    ...over,
  };
}

describe("ConversationRail · 会话内容搜索（d.197）", () => {
  const conversations = [
    conv("c1", "周会纪要", "D:/项目/和鸣", "2026-11-15T09:00:00.000Z"),
    conv("c2", "竞品调研", "D:/项目/和鸣", "2026-11-14T09:00:00.000Z"),
  ];

  const typeQuery = (text: string) => {
    fireEvent.click(screen.getByTestId("rail-search-toggle"));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索会话" }), {
      target: { value: text },
    });
  };

  it("会话名不匹配但正文命中：会话仍出现，行下带命中片段", async () => {
    const onSearchContent = vi.fn(async () => searchResult());
    renderRail({ conversations, workspaces, onSearchContent });

    typeQuery("全部通过");
    // 防抖期内不发请求：此刻只有「按会话名」的匹配（这次一个都没有）。
    expect(onSearchContent).not.toHaveBeenCalled();

    await waitFor(() => expect(onSearchContent).toHaveBeenCalledWith("全部通过"));
    expect(await screen.findByRole("button", { name: "打开会话：竞品调研" })).toBeInTheDocument();
    expect(screen.getByTestId("rail-content-hit-snippet")).toHaveTextContent("全部通过");
    // 会话名没命中的那个不该被顺带留下。
    expect(screen.queryByRole("button", { name: "打开会话：周会纪要" })).not.toBeInTheDocument();
  });

  it("词太短不发请求，仍只按会话名过滤", async () => {
    const onSearchContent = vi.fn(async () => searchResult());
    renderRail({ conversations, workspaces, onSearchContent });

    typeQuery("纪");
    expect(screen.getByRole("button", { name: "打开会话：周会纪要" })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(onSearchContent).not.toHaveBeenCalled();
  });

  it("命中落在当前列表之外：列在「更早的会话里也有命中」，点开走 onOpen", async () => {
    const outside: ConversationContentSearchResult = {
      hits: [
        {
          conversationId: "c9",
          conversationTitle: "半个月前的调试",
          lastMessageAt: null,
          messageId: "m9",
          senderType: "agent",
          createdAt: "2026-11-01T00:00:00.000Z",
          snippet: "…这里也提到全部通过…",
        },
      ],
      truncated: false,
      scanned: 3,
    };
    const onSearchContent = vi.fn(async () => outside);
    const props = renderRail({ conversations, workspaces, onSearchContent });

    typeQuery("全部通过");
    const section = await screen.findByTestId("rail-outside-hits");
    expect(within(section).getByText("更早的会话里也有命中")).toBeInTheDocument();

    fireEvent.click(within(section).getByRole("button", { name: /半个月前的调试/ }));
    expect(props.onOpen).toHaveBeenCalledWith("c9");
  });

  it("服务端说扫描被截断：说明「只搜了最近的消息」", async () => {
    const onSearchContent = vi.fn(async () => searchResult({ truncated: true }));
    renderRail({ conversations, workspaces, onSearchContent });

    typeQuery("全部通过");
    expect(await screen.findByText(/只搜了最近的消息/)).toBeInTheDocument();
  });

  it("内容搜索失败：不装作没搜到，明说现在只按会话名匹配", async () => {
    const onSearchContent = vi.fn(async () => {
      throw new Error("http 500");
    });
    renderRail({ conversations, workspaces, onSearchContent });

    typeQuery("全部通过");
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("内容搜索失败：http 500（当前只按会话名匹配）");
    // 失败不清空「按会话名过滤」的结果：这次会话名也没有命中，所以是空态而不是报错页。
    expect(screen.getByText("没有匹配的会话")).toBeInTheDocument();
  });
});

/**
 * d.198：点搜索命中不该只是「打开那个会话」，而要落到那句话上。
 *
 * rail 只负责把 `(conversationId, messageId)` 交出去；滚动与高亮在 `ChatPage`
 * 消费「消息跳转投递槽」时完成（那边有组件测试）。
 */
describe("ConversationRail · 点命中跳到那条消息（d.198）", () => {
  const conversations = [
    conv("c1", "周会纪要", "D:/项目/和鸣", "2026-11-15T09:00:00.000Z"),
    conv("c2", "竞品调研", "D:/项目/和鸣", "2026-11-14T09:00:00.000Z"),
  ];

  const typeQuery = (text: string) => {
    fireEvent.click(screen.getByTestId("rail-search-toggle"));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索会话" }), {
      target: { value: text },
    });
  };

  it("点带正文命中的会话行：交给 onOpenMessage（精确到消息）", async () => {
    const onOpenMessage = vi.fn();
    const props = renderRail({
      conversations,
      workspaces,
      onSearchContent: vi.fn(async () => searchResult()),
      onOpenMessage,
    });

    typeQuery("全部通过");
    fireEvent.click(await screen.findByRole("button", { name: "打开会话：竞品调研" }));

    expect(onOpenMessage).toHaveBeenCalledWith("c2", "m1");
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("点命中片段本身也跳那条消息", async () => {
    const onOpenMessage = vi.fn();
    renderRail({
      conversations,
      workspaces,
      onSearchContent: vi.fn(async () => searchResult()),
      onOpenMessage,
    });

    typeQuery("全部通过");
    fireEvent.click(await screen.findByRole("button", { name: /跳到命中消息/ }));

    expect(onOpenMessage).toHaveBeenCalledWith("c2", "m1");
  });

  it("页外命中同样带消息 id 跳转", async () => {
    const outside: ConversationContentSearchResult = {
      hits: [
        {
          conversationId: "c9",
          conversationTitle: "半个月前的调试",
          lastMessageAt: null,
          messageId: "m9",
          senderType: "agent",
          createdAt: "2026-11-01T00:00:00.000Z",
          snippet: "…这里也提到全部通过…",
        },
      ],
      truncated: false,
      scanned: 3,
    };
    const onOpenMessage = vi.fn();
    const props = renderRail({
      conversations,
      workspaces,
      onSearchContent: vi.fn(async () => outside),
      onOpenMessage,
    });

    typeQuery("全部通过");
    const section = await screen.findByTestId("rail-outside-hits");
    fireEvent.click(within(section).getByRole("button", { name: /半个月前的调试/ }));

    expect(onOpenMessage).toHaveBeenCalledWith("c9", "m9");
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("没接 onOpenMessage 时退回只打开会话（老行为不丢）", async () => {
    const props = renderRail({
      conversations,
      workspaces,
      onSearchContent: vi.fn(async () => searchResult()),
    });

    typeQuery("全部通过");
    fireEvent.click(await screen.findByRole("button", { name: "打开会话：竞品调研" }));

    expect(props.onOpen).toHaveBeenCalledWith("c2");
    // 没有跳转入口时，片段只是文字，不是可点按钮
    expect(screen.queryByRole("button", { name: /跳到命中消息/ })).not.toBeInTheDocument();
  });
});
