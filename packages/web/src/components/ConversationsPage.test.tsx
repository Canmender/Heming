import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import type { Conversation, Message, User } from "@heming/shared";
import { ConversationsPage } from "./ConversationsPage.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { resetConvPrefsForTest, setPinned } from "../lib/convPrefs.js";
import { clearDraft, setDraft } from "../lib/drafts.js";
import { msgCache, type PlainEnvelope } from "../lib/e2eSession.js";
import { archiveConversation } from "../lib/api.js";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, archiveConversation: vi.fn(async () => {}) };
});

const bob: User = { id: "u2", username: "bob", displayName: "鲍勃" };

const direct = (id: string, lastMessageAt: string | null = null): Conversation =>
  ({ id, type: "direct", peer: bob, unreadCount: 0, lastMessageAt }) as Conversation;

/** 建一个 direct 会话并指定对方昵称（搜索/行操作按名字定位）。 */
const support = (
  id: string,
  name: string,
  lastMessageAt: string | null = null,
  unreadCount = 0,
): Conversation =>
  ({
    id,
    type: "direct",
    peer: { id: `peer-${id}`, username: `user_${id}`, displayName: name },
    unreadCount,
    lastMessageAt,
  }) as Conversation;

const loadedMsg = (id: string, conversationId: string, text: string, createdAt: string): Message =>
  ({
    id,
    conversationId,
    senderType: "user",
    senderId: "u2",
    payload: { text },
    replyTo: null,
    createdAt,
    recalledAt: null,
    enc: "plain",
  }) as Message;

/** e2e 信封占位：列表里 payload 为空，真正的正文在 plainById。 */
const e2eMsg = (id: string, conversationId: string, createdAt: string): Message =>
  ({ ...loadedMsg(id, conversationId, "", createdAt), enc: "e2e" }) as Message;

const cached = (id: string, text: string, kind: "text" | "reaction" | "chaindist" | "chunk" | "error" = "text") => ({
  id,
  senderId: "u2",
  at: Date.parse("2026-10-25T00:00:00.000Z"),
  plain: { kind, text },
});

beforeEach(() => {
  localStorage.clear();
  resetConvPrefsForTest();
  vi.mocked(archiveConversation).mockReset();
  vi.mocked(archiveConversation).mockResolvedValue(undefined);
  useUiStore.setState({ activeConversationId: null, openTabs: [] });
  useChatStore.setState({
    conversations: [],
    messages: {},
    plainById: {},
    workspaceReady: true,
    workspaceError: null,
    loadWorkspace: vi.fn(async () => {}),
  });
});

describe("ConversationsPage", () => {
  it("只列未归档；置顶优先，其次按 lastMessageAt 降序（缺失最后、等值稳定）", () => {
    const rows = [
      direct("c-old", "2026-10-20T00:00:00.000Z"),
      direct("c-new", "2026-10-25T00:00:00.000Z"),
      { ...direct("c-arch", "2026-10-26T00:00:00.000Z"), archivedAt: "2026-10-27T00:00:00.000Z" },
      direct("c-pin", "2026-10-01T00:00:00.000Z"),
      direct("c-null", null),
      direct("c-tie-a", "2026-10-22T00:00:00.000Z"),
      direct("c-tie-b", "2026-10-22T00:00:00.000Z"),
    ] as Conversation[];
    setPinned("c-pin", true);
    useChatStore.setState({ conversations: rows, messages: {} });

    const { container } = render(<ConversationsPage />);
    const ids = [...container.querySelectorAll("[data-conv-id]")].map((el) =>
      el.getAttribute("data-conv-id"),
    );
    expect(ids).toEqual(["c-pin", "c-new", "c-tie-a", "c-tie-b", "c-old", "c-null"]);
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
    // 草稿同时有已加载消息与缓存：草稿必须胜出
    msgCache.append("c-draft", cached("dm1", "草稿不该被缓存覆盖"));
    // 已加载同时有缓存：已加载必须胜出
    msgCache.append("c-loaded", cached("lm1", "缓存不该盖过已加载"));
    // 缓存最后几条是不可展示类型：应跳过、取更早的 text
    msgCache.append("c-cache", cached("cm1", "缓存里的正文"));
    msgCache.append("c-cache", cached("cm2", "回应不该显示", "reaction"));
    msgCache.append("c-cache", cached("cm3", "链分发不该显示", "chaindist"));
    msgCache.append("c-cache", cached("cm4", "分片不该显示", "chunk"));
    msgCache.append("c-cache", cached("cm5", "错误不该显示", "error"));
    useChatStore.setState({
      conversations: rows,
      messages: {
        "c-draft": [loadedMsg("dm0", "c-draft", "消息不该盖过草稿", "2026-10-25T00:00:00.000Z")],
        "c-loaded": [loadedMsg("m1", "c-loaded", "已加载正文", "2026-10-25T00:00:00.000Z")],
      },
    });

    const { unmount } = render(<ConversationsPage />);
    expect(screen.getByText(/草稿：写到一半/)).toBeInTheDocument();
    expect(screen.getByText("已加载正文")).toBeInTheDocument();
    expect(screen.getByText("缓存里的正文")).toBeInTheDocument();
    expect(screen.getByText("点击查看消息")).toBeInTheDocument();
    expect(screen.getByText("暂无消息")).toBeInTheDocument();
    expect(screen.queryByText("草稿不该被缓存覆盖")).toBeNull();
    expect(screen.queryByText("消息不该盖过草稿")).toBeNull();
    expect(screen.queryByText("缓存不该盖过已加载")).toBeNull();
    expect(screen.queryByText("回应不该显示")).toBeNull();
    expect(screen.queryByText("链分发不该显示")).toBeNull();
    expect(screen.queryByText("分片不该显示")).toBeNull();
    expect(screen.queryByText("错误不该显示")).toBeNull();
    // 先卸载再清草稿：清草稿会通知订阅者，挂在组件上会在 act 之外 setState
    unmount();
    clearDraft("c-draft");
  });

  it("搜索按会话名过滤；未读并入打开按钮名；行操作不打开会话；点击行才打开", () => {
    useChatStore.setState({
      conversations: [
        support("c1", "张三"),
        support("c2", "李四", "2026-10-25T00:00:00.000Z", 3),
      ],
      messages: {},
    });
    render(<ConversationsPage />);
    fireEvent.change(screen.getByLabelText("搜索会话"), { target: { value: "李四" } });
    expect(screen.queryByText("张三")).not.toBeInTheDocument();
    // 顶部计数跟列表走（搜索后是 1，而不是全部会话数）
    expect(screen.getByText("1 个会话 · 3 条未读")).toBeInTheDocument();

    expect(screen.getByLabelText("3 条未读")).toBeInTheDocument();
    const open = screen.getByRole("button", { name: "打开会话 李四 3 条未读" });

    fireEvent.click(screen.getByRole("button", { name: "置顶 李四" }));
    expect(screen.getByRole("button", { name: "取消置顶 李四" })).toBeInTheDocument();
    expect(useUiStore.getState().activeConversationId).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "免打扰 李四" }));
    expect(screen.getByRole("button", { name: "取消免打扰 李四" })).toBeInTheDocument();
    expect(useUiStore.getState().activeConversationId).toBeNull();

    fireEvent.click(open);
    expect(useUiStore.getState().activeConversationId).toBe("c2");
  });

  it("归档调用 API、同一 tick 连点只发一次、刷新列表且不打开会话", async () => {
    useChatStore.setState({
      conversations: [support("c1", "张三"), support("c2", "李四")],
      messages: {},
    });
    render(<ConversationsPage />);
    const load = useChatStore.getState().loadWorkspace;
    const btn = screen.getByRole("button", { name: "归档 李四" });

    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    expect(archiveConversation).toHaveBeenCalledTimes(1);
    expect(archiveConversation).toHaveBeenCalledWith("c2", true);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2)); // 挂载 + 归档后刷新
    expect(useUiStore.getState().activeConversationId).toBeNull();
  });

  it("归档失败显示 role=alert 提示", async () => {
    vi.mocked(archiveConversation).mockRejectedValueOnce(new Error("boom"));
    useChatStore.setState({
      conversations: [support("c2", "李四")],
      messages: {},
    });
    render(<ConversationsPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "归档 李四" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("归档失败：boom");
    expect(useUiStore.getState().activeConversationId).toBeNull();
  });

  it("归档成功但列表刷新失败时提示区分于归档失败", async () => {
    const load = vi.fn(async () => {});
    useChatStore.setState({
      conversations: [support("c2", "李四")],
      messages: {},
      loadWorkspace: load,
    });
    render(<ConversationsPage />);
    expect(load).toHaveBeenCalledTimes(1); // 挂载
    load.mockRejectedValueOnce(new Error("nope"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "归档 李四" }));
    });
    expect(archiveConversation).toHaveBeenCalledWith("c2", true);
    expect(await screen.findByRole("alert")).toHaveTextContent("已归档，但列表刷新失败");
  });

  it("行尾时间：非今天显示 MM-DD HH:mm；lastMessageAt 非法时回退到已加载消息时间", () => {
    const createdAt = "2020-03-05T06:07:00.000Z";
    useChatStore.setState({
      conversations: [direct("c-time", createdAt), direct("c-bad", "not-a-date")],
      messages: {
        "c-bad": [loadedMsg("bm1", "c-bad", "坏时间会话", createdAt)],
      },
    });
    const { container } = render(<ConversationsPage />);
    const d = new Date(createdAt);
    const pad = (n: number) => String(n).padStart(2, "0");
    const expected = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

    const timeRow = container.querySelector('[data-conv-id="c-time"]') as HTMLElement;
    const badRow = container.querySelector('[data-conv-id="c-bad"]') as HTMLElement;
    expect(within(timeRow).getByText(expected)).toBeInTheDocument();
    expect(within(badRow).getByText(expected)).toBeInTheDocument();
  });

  it("msgCache.peek 只读且与 list 一致；remove 按 id 删条", () => {
    msgCache.append("c-peek", cached("p1", "一"));
    msgCache.append("c-peek", cached("p2", "二"));
    expect(msgCache.peek("c-peek")).toEqual(msgCache.list("c-peek"));
    expect(msgCache.peek("c-missing")).toEqual([]);

    msgCache.remove("c-peek", "p1");
    expect(msgCache.peek("c-peek").map((m) => m.id)).toEqual(["p2"]);
    expect(msgCache.list("c-peek")).toEqual(msgCache.peek("c-peek"));
    msgCache.remove("c-peek", "no-such");
    expect(msgCache.peek("c-peek").map((m) => m.id)).toEqual(["p2"]);
  });

  it("本机缓存被撤回清除后不再回显原文（回落点击查看消息/暂无消息）", () => {
    msgCache.append("c-rec1", cached("r1", "撤回前的正文"));
    msgCache.append("c-rec2", cached("r2", "撤回前的正文"));
    useChatStore.setState({
      conversations: [direct("c-rec1", "2026-10-25T00:00:00.000Z"), direct("c-rec2", null)],
      messages: {},
    });
    const first = render(<ConversationsPage />);
    expect(screen.getAllByText("撤回前的正文")).toHaveLength(2);
    first.unmount();

    // 模拟撤回已发生、重启后 store 无已加载消息：缓存已清 → 不再回显
    msgCache.remove("c-rec1", "r1");
    msgCache.remove("c-rec2", "r2");

    const second = render(<ConversationsPage />);
    expect(screen.queryByText("撤回前的正文")).toBeNull();
    const row1 = second.container.querySelector('[data-conv-id="c-rec1"]') as HTMLElement;
    const row2 = second.container.querySelector('[data-conv-id="c-rec2"]') as HTMLElement;
    expect(within(row1).getByText("点击查看消息")).toBeInTheDocument();
    expect(within(row2).getByText("暂无消息")).toBeInTheDocument();
  });

  it("已加载 e2e 消息按 plainById 预览：控制类跳过、未解密显示无法解密、附件/转发分型", () => {
    const at = "2026-10-25T00:00:00.000Z";
    const plainById: Record<string, Record<string, PlainEnvelope>> = {
      "c-e2e": {
        "e-old": { kind: "text", text: "e2e 正文" },
        "e-react": { kind: "reaction", reaction: { target: "e-old", emoji: "👍", op: "add" } },
      },
      "c-file": {
        "e-file": { kind: "file", file: { id: "f1", name: "a.png", mime: "image/png", size: 1 } },
      },
      "c-fwd": {
        "e-fwd": { kind: "forward", text: "转发正文", forward: { from: "鲍勃", source: "群" } },
      },
    };
    useChatStore.setState({
      conversations: [
        direct("c-e2e", at),
        direct("c-nodec", at),
        direct("c-file", at),
        direct("c-fwd", at),
      ],
      messages: {
        "c-e2e": [e2eMsg("e-old", "c-e2e", at), e2eMsg("e-react", "c-e2e", at)],
        "c-nodec": [e2eMsg("e-nodec", "c-nodec", at)],
        "c-file": [e2eMsg("e-file", "c-file", at)],
        "c-fwd": [e2eMsg("e-fwd", "c-fwd", at)],
      },
      plainById,
    });
    render(<ConversationsPage />);
    expect(screen.getByText("e2e 正文")).toBeInTheDocument();
    expect(screen.getByText("无法解密")).toBeInTheDocument();
    expect(screen.getByText("(附件)")).toBeInTheDocument();
    expect(screen.getByText("转发正文")).toBeInTheDocument();
  });

  it("坏缓存（缺 plain / at 非数字）不抛，仍可取可展示正文", () => {
    localStorage.setItem(
      "heming.msgCache.c-badcache",
      JSON.stringify([
        { id: "b1", senderId: "u2", at: "oops", plain: null },
        { id: "b2", senderId: "u2", at: null, plain: { kind: "text", text: "时间坏但正文可展示" } },
      ]),
    );
    useChatStore.setState({ conversations: [direct("c-badcache", null)], messages: {} });
    render(<ConversationsPage />);
    expect(screen.getByText("时间坏但正文可展示")).toBeInTheDocument();
  });

  it("工作区未就绪时不显示顶部计数", () => {
    useChatStore.setState({
      conversations: [support("c1", "张三")],
      messages: {},
      workspaceReady: false,
    });
    render(<ConversationsPage />);
    expect(screen.queryByText(/个会话/)).toBeNull();
  });
});
