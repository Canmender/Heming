import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { Conversation, User } from "@heming/shared";
import { ConversationsPage } from "./ConversationsPage.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { resetConvPrefsForTest, setPinned } from "../lib/convPrefs.js";
import { clearDraft, setDraft } from "../lib/drafts.js";
import { msgCache } from "../lib/e2eSession.js";
import { archiveConversation } from "../lib/api.js";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, archiveConversation: vi.fn(async () => {}) };
});

const bob: User = { id: "u2", username: "bob", displayName: "鲍勃" };

const direct = (id: string, lastMessageAt: string | null = null): Conversation =>
  ({ id, type: "direct", peer: bob, unreadCount: 0, lastMessageAt }) as Conversation;

/** 建一个 direct 会话并指定对方昵称（搜索/行操作按名字定位）。 */
const support = (id: string, name: string, lastMessageAt: string | null = null): Conversation =>
  ({
    id,
    type: "direct",
    peer: { id: `peer-${id}`, username: `user_${id}`, displayName: name },
    unreadCount: 0,
    lastMessageAt,
  }) as Conversation;

beforeEach(() => {
  localStorage.clear();
  resetConvPrefsForTest();
  vi.mocked(archiveConversation).mockClear();
  useUiStore.setState({ activeConversationId: null, openTabs: [] });
  useChatStore.setState({
    conversations: [],
    messages: {},
    workspaceReady: true,
    workspaceError: null,
    loadWorkspace: vi.fn(async () => {}),
  });
});

describe("ConversationsPage", () => {
  it("只列未归档；置顶优先，其次按 lastMessageAt 降序", () => {
    const rows = [
      direct("c-old", "2026-10-20T00:00:00.000Z"),
      direct("c-new", "2026-10-25T00:00:00.000Z"),
      { ...direct("c-arch", "2026-10-26T00:00:00.000Z"), archivedAt: "2026-10-27T00:00:00.000Z" },
      direct("c-pin", "2026-10-01T00:00:00.000Z"),
    ] as Conversation[];
    setPinned("c-pin", true);
    useChatStore.setState({ conversations: rows, messages: {} });

    const { container } = render(<ConversationsPage />);
    const ids = [...container.querySelectorAll("[data-conv-id]")].map((el) =>
      el.getAttribute("data-conv-id"),
    );
    expect(ids).toEqual(["c-pin", "c-new", "c-old"]);
    expect(screen.queryByText(/c-arch/)).not.toBeInTheDocument();
    expect(container.querySelector('[data-conv-id="c-arch"]')).toBeNull();
  });

  it("预览优先级：草稿 > 已加载最后一条 > 本机缓存 > 点击查看消息 > 暂无消息", () => {
    const rows = [
      direct("c-draft", "2026-10-25T00:00:00.000Z"),
      direct("c-loaded", "2026-10-25T00:00:00.000Z"),
      direct("c-cache", "2026-10-25T00:00:00.000Z"),
      direct("c-unloaded", "2026-10-25T00:00:00.000Z"),
      direct("c-empty", null),
    ];
    setDraft("c-draft", "写到一半");
    msgCache.append("c-cache", {
      id: "cm1",
      senderId: "u2",
      at: Date.parse("2026-10-25T00:00:00.000Z"),
      plain: { kind: "text", text: "缓存里的正文" },
    });
    useChatStore.setState({
      conversations: rows,
      messages: {
        "c-loaded": [
          {
            id: "m1",
            conversationId: "c-loaded",
            senderType: "user",
            senderId: "u2",
            payload: { text: "已加载正文" },
            replyTo: null,
            createdAt: "2026-10-25T00:00:00.000Z",
            recalledAt: null,
            enc: "plain",
          },
        ],
      },
    });

    const { unmount } = render(<ConversationsPage />);
    expect(screen.getByText(/草稿：写到一半/)).toBeInTheDocument();
    expect(screen.getByText("已加载正文")).toBeInTheDocument();
    expect(screen.getByText("缓存里的正文")).toBeInTheDocument();
    expect(screen.getByText("点击查看消息")).toBeInTheDocument();
    expect(screen.getByText("暂无消息")).toBeInTheDocument();
    // 先卸载再清草稿：清草稿会通知订阅者，挂在组件上会在 act 之外 setState
    unmount();
    clearDraft("c-draft");
  });

  it("搜索按会话名过滤；置顶/免打扰切换即时生效；归档调用 API", async () => {
    useChatStore.setState({
      conversations: [support("c1", "张三"), support("c2", "李四")],
      messages: {},
    });
    render(<ConversationsPage />);
    fireEvent.change(screen.getByLabelText("搜索会话"), { target: { value: "李四" } });
    expect(screen.queryByText("张三")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "置顶 李四" }));
    expect(screen.getByRole("button", { name: "取消置顶 李四" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "免打扰 李四" }));
    expect(screen.getByRole("button", { name: "取消免打扰 李四" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "归档 李四" }));
    });
    expect(archiveConversation).toHaveBeenCalledWith("c2", true);
    await waitFor(() => expect(useChatStore.getState().loadWorkspace).toHaveBeenCalled());
  });
});
