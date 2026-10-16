import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import type { Agent, Member, Message, ReadState, User } from "@heming/shared";
import { ChatPage, renderTextWithMentions } from "./ChatPage.js";
import { useUiStore } from "../store/ui.js";
import { useChatStore } from "../store/chat.js";
import { useAuthStore } from "../store/auth.js";
import { connectWs, type WsHandlers, type WsHandle } from "../lib/ws.js";

vi.mock("../lib/ws.js", () => ({ connectWs: vi.fn() }));

const me: User = { id: "u1", username: "alice", displayName: "爱丽丝" };
const peer: User = { id: "u2", username: "bob", displayName: "鲍勃" };

const msg = (id: string, text: string, createdAt: string): Message => ({
  id,
  conversationId: "c1",
  senderType: "user",
  senderId: "u2",
  payload: { text },
  replyTo: null,
  createdAt,
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * 会话 fetch mock：/messages 按调用序返回不同历史（首次 → first，其后 → second ?? first）；
 * /reads、/members 按调用序取 conv 内对应序列（缺省空表 200，避免挂载期 loadReads/fetchMembers 走 404 噪声）。
 */
function mockMessagesFetch(
  first: Message[],
  second?: Message[],
  conv: { reads?: ReadState[][]; members?: Member[][] } = {},
) {
  let m = 0;
  let r = 0;
  let k = 0;
  const pick = <T,>(seq: T[][] | undefined, i: number): T[] =>
    seq ? seq[Math.min(i, seq.length - 1)] : [];
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (/^\/api\/conversations\/[^/]+\/messages$/.test(url)) {
      return Promise.resolve(jsonRes(m++ === 0 ? first : (second ?? first)));
    }
    if (/^\/api\/conversations\/[^/]+\/reads$/.test(url)) {
      return Promise.resolve(jsonRes(pick(conv.reads, r++)));
    }
    if (/^\/api\/conversations\/[^/]+\/members$/.test(url)) {
      return Promise.resolve(jsonRes(pick(conv.members, k++)));
    }
    return Promise.resolve(jsonRes({ error: "not found" }, 404));
  });
}

/** connectWs 已 vi.mock：返回最近一次注册的 handlers。 */
function lastHandlers(): WsHandlers {
  const calls = vi.mocked(connectWs).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0];
}

/** @ 选择器用例共用底座：群会话 + 名册 join（含「和小鸣」）+ 可断言的 ws send。 */
const agentRow: Agent = {
  id: "system-assistant",
  owner_id: "u1",
  name: "和小鸣",
  avatar: null,
  description: "",
};

async function setupGroupChat() {
  const send = vi.fn();
  vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
  useChatStore.setState({
    conversations: [{ id: "c1", type: "group", name: "评审组", memberCount: 3, unreadCount: 0 }],
    agentsRoster: [agentRow],
    agentIdsInGroups: new Set([agentRow.id]),
    agents: [agentRow],
  });
  mockMessagesFetch([], undefined, { members: [[]], reads: [[]] });
  render(<ChatPage />);
  await act(async () => {}); // 冲刷挂载 effects（fetchMessages/loadReads/fetchMembers 落定）
  return send;
}

describe("ChatPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // jsdom 未实现 scrollIntoView
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(connectWs).mockReset();
    vi.mocked(connectWs).mockReturnValue({ send: vi.fn(), close: vi.fn() });
    useAuthStore.setState({ token: "t1", user: me, status: "authed", error: null });
    useUiStore.setState({ page: "chat", navCollapsed: true, activeConversationId: "c1" });
    useChatStore.setState({
      conversations: [{ id: "c1", type: "direct", peer, unreadCount: 0 }],
      friends: [],
      incoming: [],
      messages: {},
      reads: {},
    });
  });

  it("挂载后收到 message_new：append 到消息列表", async () => {
    mockMessagesFetch([msg("m1", "第一条", "2026-10-14T01:00:00.000Z")]);

    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("第一条")).toBeInTheDocument());

    act(() => {
      lastHandlers().onEvent({
        type: "message_new",
        message: msg("m2", "断线期间的新消息", "2026-10-14T01:05:00.000Z"),
      });
    });

    expect(screen.getByText("断线期间的新消息")).toBeInTheDocument();
    expect(screen.getByText("第一条")).toBeInTheDocument(); // 历史仍在
    expect(useChatStore.getState().messages.c1.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("触发 onOpen（重连）：补拉 fetchMessages 并用合并结果渲染", async () => {
    const m1 = msg("m1", "旧消息", "2026-10-14T01:00:00.000Z");
    const m3 = msg("m3", "断档消息", "2026-10-14T01:10:00.000Z");
    const fetchMock = mockMessagesFetch([m1], [m1, m3]);

    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("旧消息")).toBeInTheDocument());
    const messagesCalls = () =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("/messages"));
    const callsBefore = messagesCalls().length;

    // 连接期间本地先收到一条（覆盖 WS 与补拉历史交错的合并不变量）
    act(() => {
      lastHandlers().onEvent({
        type: "message_new",
        message: msg("m2", "本地已入列", "2026-10-14T01:07:00.000Z"),
      });
    });

    act(() => {
      lastHandlers().onOpen?.();
    });

    await waitFor(() => {
      const calls = messagesCalls();
      expect(calls.length).toBe(callsBefore + 1);
      expect(String(calls[calls.length - 1][0])).toBe("/api/conversations/c1/messages");
    });
    // 合并结果：历史 + 断档 + 本地独有条目全部渲染
    expect(await screen.findByText("断档消息")).toBeInTheDocument();
    expect(screen.getByText("本地已入列")).toBeInTheDocument();
    expect(screen.getByText("旧消息")).toBeInTheDocument();
    expect(useChatStore.getState().messages.c1.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(screen.queryByRole("status")).not.toBeInTheDocument(); // 无发送失败提示
  });

  it("连接句柄为 null 时发送：保留草稿并显示「连接未就绪，消息未发送」", async () => {
    vi.mocked(connectWs).mockReturnValue(null as unknown as WsHandle);
    mockMessagesFetch([]);

    render(<ChatPage />);
    await act(async () => {});

    const input = screen.getByPlaceholderText("输入消息…");
    fireEvent.change(input, { target: { value: "还没发出去的话" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(screen.getByRole("status")).toHaveTextContent("连接未就绪，消息未发送");
    expect(input).toHaveValue("还没发出去的话"); // 草稿未被清空
  });

  it("句柄就绪时发送：走 handle.send，清空草稿且无失败提示", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([]);

    render(<ChatPage />);
    await act(async () => {});

    const input = screen.getByPlaceholderText("输入消息…");
    fireEvent.change(input, { target: { value: "你好" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(send).toHaveBeenCalledWith({
      type: "send_message",
      conversationId: "c1",
      payload: { text: "你好" },
    });
    expect(input).toHaveValue("");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("对方消息显示对方头像（无头像首字回退），自己的消息不显示头像", async () => {
    const mine: Message = {
      ...msg("m2", "我回一句", "2026-10-14T01:05:00.000Z"),
      senderId: "u1",
    };
    mockMessagesFetch([msg("m1", "在的", "2026-10-14T01:00:00.000Z"), mine]);

    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("在的")).toBeInTheDocument());

    // 对方两条中仅 m1 是对方消息：首字「鲍」头像出现且仅出现一次（自己的消息不带头像）
    expect(screen.getByText("鲍")).toBeInTheDocument();
    expect(screen.getAllByText("鲍")).toHaveLength(1);
    // 自己的消息气泡正常渲染（右对齐为既有样式，不另作断言）
    expect(screen.getByText("我回一句")).toBeInTheDocument();
  });

  it("direct 下对方已读我的消息时显示「已读」（晚于读点的不显示）", async () => {
    const mine1: Message = {
      ...msg("m1", "我 10:00 发的", "2026-10-14T02:00:00.000Z"),
      senderId: "u1",
    };
    const mine2: Message = {
      ...msg("m2", "我 10:03 发的", "2026-10-14T02:03:00.000Z"),
      senderId: "u1",
    };
    mockMessagesFetch([mine1, mine2], undefined, {
      reads: [[{ userId: "u2", at: "2026-10-14T02:01:00.000Z" }]],
    });

    render(<ChatPage />);
    expect(await screen.findByText("已读")).toBeInTheDocument();
    // 逐条判断：m1 早于对方读点 → 已读；m2 晚于读点 → 不显示
    expect(screen.getByText("我 10:00 发的")).toHaveTextContent("已读");
    expect(screen.getByText("我 10:03 发的")).not.toHaveTextContent("已读");
    expect(screen.getAllByText("已读")).toHaveLength(1);
  });

  it("挂载后 unreadCount>0 时发送 mark_read", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([]);
    useChatStore.setState({
      conversations: [{ id: "c1", type: "direct", peer, unreadCount: 3 }],
    });

    render(<ChatPage />);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({ type: "mark_read", conversationId: "c1" }),
    );
  });

  it("挂载后 unreadCount=0 时不发送 mark_read", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([]);

    render(<ChatPage />);
    await act(async () => {}); // 冲刷挂载 effects（loadReads/fetchMessages 落定）
    expect(send).not.toHaveBeenCalled();
  });

  it("会话内收到他人新消息补发 mark_read，自己发的消息不补发", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([]);

    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText("输入消息…")).toBeInTheDocument());

    act(() => {
      lastHandlers().onEvent({
        type: "message_new",
        message: { ...msg("m2", "刚发来的", "2026-10-14T02:10:00.000Z"), senderId: "u2" },
      });
    });
    // 正在会话内看到的消息即时标记已读：否则退出后角标会把已读内容算作未读
    expect(send).toHaveBeenCalledWith({ type: "mark_read", conversationId: "c1" });

    send.mockClear();
    act(() => {
      lastHandlers().onEvent({
        type: "message_new",
        message: { ...msg("m3", "我自己发的", "2026-10-14T02:11:00.000Z"), senderId: "u1" },
      });
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("群会话头显示「群名（N 人）」，且群会话不显示「已读」（真击穿守卫）", async () => {
    useChatStore.setState({
      conversations: [{ id: "c1", type: "group", name: "评审组", memberCount: 5, unreadCount: 0 }],
    });
    const other = msg("m1", "我提个问题", "2026-10-14T01:00:00.000Z"); // senderId u2
    // 真击穿：我方消息（senderId=me）+ 对方读点晚于消息 → 若守卫失效本应显示「已读」
    const mine: Message = {
      ...msg("m2", "群里我发的", "2026-10-14T09:00:00.000Z"),
      senderId: "u1",
    };
    mockMessagesFetch([other, mine], undefined, {
      reads: [[{ userId: "u2", at: "2026-10-14T09:30:00.000Z" }]],
      members: [
        [
          { kind: "user", id: "u1", name: "爱丽丝", avatar: null, user: me },
          { kind: "user", id: "u2", name: "鲍勃", avatar: null, user: peer },
        ],
      ],
    });

    render(<ChatPage />);
    expect(await screen.findByText("评审组（5 人）")).toBeInTheDocument();
    expect(screen.getByText("群里我发的")).toBeInTheDocument(); // 群内我方消息确实渲染
    expect(screen.queryByText("已读")).not.toBeInTheDocument();
  });

  it("群内他人消息气泡显示成员映射名，自己的显示「我」", async () => {
    useChatStore.setState({
      conversations: [{ id: "c1", type: "group", name: "评审组", memberCount: 3, unreadCount: 0 }],
    });
    const other = msg("m1", "我提个问题", "2026-10-14T01:00:00.000Z"); // senderId u2
    const mine: Message = {
      ...msg("m2", "同意", "2026-10-14T01:02:00.000Z"),
      senderId: "u1",
    };
    const fetchMock = mockMessagesFetch([other, mine], undefined, {
      members: [
        [
          { kind: "user", id: "u1", name: "爱丽丝", avatar: null, user: me },
          { kind: "user", id: "u2", name: "鲍勃", avatar: null, user: peer },
        ],
      ],
    });

    render(<ChatPage />);
    // 挂载时拉一次 members 建 id→名字映射（M2 消息体无 senderName）
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === "/api/conversations/c1/members")).toBe(
        true,
      ),
    );
    expect(await screen.findByText("鲍勃")).toBeInTheDocument(); // 他人气泡：映射名
    expect(screen.getByText("我")).toBeInTheDocument(); // 自己
    expect(screen.getByText("同意")).toBeInTheDocument();
  });

  it("收到 read_update：仅本会话重拉 /reads 并更新「已读」标记", async () => {
    const mine: Message = {
      ...msg("m1", "我发的", "2026-10-14T02:00:00.000Z"),
      senderId: "u1",
    };
    const fetchMock = mockMessagesFetch([mine], undefined, {
      reads: [[], [{ userId: "u2", at: "2026-10-14T02:01:00.000Z" }]],
    });

    render(<ChatPage />);
    const readsCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/reads"));
    await waitFor(() => expect(readsCalls()).toHaveLength(1)); // 挂载 loadReads
    await waitFor(() => expect(screen.getByText("我发的")).toBeInTheDocument());
    expect(screen.queryByText("已读")).not.toBeInTheDocument(); // 首拉空表 → 无已读标记

    // 他会话的 read_update 不触发重拉
    act(() => {
      lastHandlers().onEvent({
        type: "read_update",
        conversationId: "other",
        userId: "u2",
        at: "2026-10-14T02:01:00.000Z",
      });
    });
    expect(readsCalls()).toHaveLength(1);

    act(() => {
      lastHandlers().onEvent({
        type: "read_update",
        conversationId: "c1",
        userId: "u2",
        at: "2026-10-14T02:01:00.000Z",
      });
    });
    expect(await screen.findByText("已读")).toBeInTheDocument();
    expect(readsCalls().length).toBeGreaterThan(1);
  });

  it("点 @ 按钮出选择器，Esc 关；选中后发送 payload 含 mentions，发送成功清 chip", async () => {
    const send = await setupGroupChat();

    // @ 按钮 → 选择器出现（本群 agent 来自 agents join 视图）
    fireEvent.click(screen.getByRole("button", { name: "提及智能体" }));
    expect(screen.getByText("和小鸣")).toBeInTheDocument();
    // Esc 关闭
    fireEvent.keyDown(screen.getByPlaceholderText("输入消息…"), { key: "Escape" });
    expect(screen.queryByText("和小鸣")).not.toBeInTheDocument();

    // 再开 → 点选 → chip 出现（输入框文本不动，mentions 走内部 state）
    fireEvent.click(screen.getByRole("button", { name: "提及智能体" }));
    fireEvent.click(screen.getByText("和小鸣"));
    expect(screen.getByText("@和小鸣")).toBeInTheDocument();

    const input = screen.getByPlaceholderText("输入消息…");
    fireEvent.change(input, { target: { value: "@和小鸣 帮我看下" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(send).toHaveBeenCalledWith({
      type: "send_message",
      conversationId: "c1",
      payload: {
        text: "@和小鸣 帮我看下",
        mentions: [{ agentId: "system-assistant", name: "和小鸣" }],
      },
    });
    expect(screen.queryByText("@和小鸣")).not.toBeInTheDocument(); // 发送成功清 chip
    expect(input).toHaveValue("");
  });

  it("chip 点 × 移除后发送不带 mentions", async () => {
    const send = await setupGroupChat();

    fireEvent.click(screen.getByRole("button", { name: "提及智能体" }));
    fireEvent.click(screen.getByText("和小鸣"));
    expect(screen.getByText("@和小鸣")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "移除 和小鸣" }));
    expect(screen.queryByText("@和小鸣")).not.toBeInTheDocument();

    const input = screen.getByPlaceholderText("输入消息…");
    fireEvent.change(input, { target: { value: "这版先不提" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(send).toHaveBeenCalledWith({
      type: "send_message",
      conversationId: "c1",
      payload: { text: "这版先不提" },
    });
  });

  it("键入 @ 触发选择器过滤，选中后文字保持原样且 token 不再重弹", async () => {
    await setupGroupChat();
    const input = screen.getByPlaceholderText("输入消息…");

    // 键入尾随 token → 弹选择器（空 query 全量）
    fireEvent.change(input, { target: { value: "@" } });
    expect(screen.getByText("和小鸣")).toBeInTheDocument();

    fireEvent.click(screen.getByText("和小鸣"));
    expect(screen.getByText("@和小鸣")).toBeInTheDocument(); // chip
    expect(input).toHaveValue("@"); // 文字保持原样（mention 不注入草稿）

    // token 仍在（未空格断开）：继续输入不重弹——否则每击键都闪空态
    fireEvent.change(input, { target: { value: "@和看下" } });
    expect(screen.queryByText("群内暂无智能体")).not.toBeInTheDocument();
    expect(screen.queryByText("和小鸣")).not.toBeInTheDocument(); // 仅剩 chip（@和小鸣 ≠ 和小鸣）

    // token 消失（空格断开）→ 解锁；再键入 @ 重弹（已选项被过滤 → 空态）
    fireEvent.change(input, { target: { value: "@和看下 中段" } });
    fireEvent.change(input, { target: { value: "@和看下 中段 @" } });
    expect(screen.getByText("群内暂无智能体")).toBeInTheDocument();
  });

  it("切换会话清空已选 mention chip（防跨会话带出）", async () => {
    await setupGroupChat();
    fireEvent.click(screen.getByRole("button", { name: "提及智能体" }));
    fireEvent.click(screen.getByText("和小鸣"));
    expect(screen.getByText("@和小鸣")).toBeInTheDocument();

    act(() => {
      useUiStore.setState({ activeConversationId: "c2" });
    });
    expect(screen.queryByText("@和小鸣")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "提及智能体" })).not.toBeInTheDocument(); // direct/未知会话不给 @ 入口
  });

  it("气泡对 mentions 名称高亮渲染", async () => {
    const m: Message = {
      ...msg("m1", "@和小鸣 看下这版", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "@和小鸣 看下这版",
        mentions: [{ agentId: "system-assistant", name: "和小鸣" }],
      },
    };
    mockMessagesFetch([m]);

    render(<ChatPage />);
    const hl = await screen.findByText("和小鸣");
    expect(hl.tagName).toBe("SPAN");
    expect(hl).toHaveClass("bg-[#eef3f8]"); // 浅蓝 chip 高亮
    expect(screen.getByText(/看下这版/)).toBeInTheDocument(); // 其余文本照常渲染
  });
});

describe("renderTextWithMentions", () => {
  it("按各 mention.name 出现位置拆分，命中处包浅蓝高亮 span（长名优先不吃短名）", () => {
    const parts = renderTextWithMentions("hi 和小鸣 与小鸣 再和小鸣", [
      { agentId: "a1", name: "和小鸣" },
      { agentId: "a2", name: "小鸣" },
    ]);
    const { container } = render(<div>{parts}</div>);
    const hl = [...container.querySelectorAll("span")];
    expect(hl.map((s) => s.textContent)).toEqual(["和小鸣", "小鸣", "和小鸣"]);
    for (const s of hl) expect(s).toHaveClass("bg-[#eef3f8]");
    expect(container.textContent).toBe("hi 和小鸣 与小鸣 再和小鸣"); // 原文无丢失
  });

  it("无 mentions 或名字未出现：原样单文本节点", () => {
    const { container } = render(<div>{renderTextWithMentions("纯文本", undefined)}</div>);
    expect(container.textContent).toBe("纯文本");
    expect(container.querySelectorAll("span")).toHaveLength(0);

    const { container: c2 } = render(
      <div>{renderTextWithMentions("不提名", [{ agentId: "a1", name: "和小鸣" }])}</div>,
    );
    expect(c2.textContent).toBe("不提名");
    expect(c2.querySelectorAll("span")).toHaveLength(0);
  });

  it("防注入：text 与 mention 名里的标签按 React 文本节点输出", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const parts = renderTextWithMentions(`${evil} 提醒 <b>粗体</b>`, [
      { agentId: "a1", name: "<b>粗体</b>" },
    ]);
    const { container } = render(<div>{parts}</div>);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toBe(`${evil} 提醒 <b>粗体</b>`);
    expect([...container.querySelectorAll("span")].map((s) => s.textContent)).toEqual([
      "<b>粗体</b>",
    ]);
  });
});
