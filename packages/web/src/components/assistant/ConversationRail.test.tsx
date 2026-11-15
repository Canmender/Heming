import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Conversation } from "@heming/shared";
import { ConversationRail, type ConversationRailProps } from "./ConversationRail.js";

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

  it("组头「+」在该工作区新建对话；栏头主按钮落在未分组（当前无活动会话）", () => {
    const props = renderRail({ conversations, workspaces });
    fireEvent.click(screen.getByRole("button", { name: "在 和鸣 新建对话" }));
    expect(props.onNewConversation).toHaveBeenLastCalledWith("D:/项目/和鸣");

    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    expect(props.onNewConversation).toHaveBeenLastCalledWith(null);
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
