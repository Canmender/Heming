import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import type { Member, Message, ReadState, User, WsClientEvent } from "@heming/shared";
import { ChatPage, renderTextWithMentions } from "./ChatPage.js";
import { useUiStore } from "../store/ui.js";
import { useChatStore } from "../store/chat.js";
import { useAuthStore } from "../store/auth.js";
import { useLlmStore, type LlmProfile } from "../store/llm.js";
import { streamChat } from "../lib/llmClient.js";
import { connectWs, type WsHandlers, type WsHandle } from "../lib/ws.js";

vi.mock("../lib/ws.js", () => ({ connectWs: vi.fn() }));
// 流式打底走本机 streamChat：模块 mock（保留 testConnection/buildRequest 真实现），
// 默认立即回空串——mention 发送用例不至于把 fetch 打到供应商端点
vi.mock("../lib/llmClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/llmClient.js")>();
  return { ...actual, streamChat: vi.fn(async () => "") };
});

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
  recalledAt: null,
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * 会话 fetch mock：/messages 按调用序返回不同历史（首次 → first，其后 → second ?? first）；
 * /reads、/members 按调用序取 conv 内对应序列（缺省空表 200，避免挂载期 loadReads/fetchMembers 走 404 噪声）；
 * /files/:id/content 走 fetchFileBlobUrl 的同一 fetch 面（默认 200 blob；contentFail 模拟 401）——
 * jsdom 不发真实网络请求，附件断言统一落在 objectURL 桩上。
 */
function mockMessagesFetch(
  first: Message[],
  second?: Message[],
  conv: { reads?: ReadState[][]; members?: Member[][]; contentFail?: boolean } = {},
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
    if (/^\/api\/files\/[^/]+\/content$/.test(url)) {
      if (conv.contentFail) return Promise.resolve(jsonRes({ error: "unauthorized" }, 401));
      return Promise.resolve({
        ok: true,
        status: 200,
        blob: async () => new Blob(["bin"]),
      } as unknown as Response);
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

/** 本会话群 members 行（@ 候选唯一数据源）：默认含人类 u1 + agent「和小鸣」。 */
const inGroupMembers: Member[] = [
  { kind: "user", id: "u1", name: "爱丽丝", avatar: null, user: me },
  { kind: "agent", id: "system-assistant", name: "和小鸣", avatar: null, user: null },
];

/** 本机 LLM 连接（Key 不出设备）：绑定到「和小鸣」后 mention 发送才不被拦截。 */
const testProfile: LlmProfile = {
  id: "p1",
  label: "l",
  provider: "openai",
  apiKey: "k",
  model: "m",
};
function bindAssistant() {
  useLlmStore.setState({
    profiles: [testProfile],
    bindings: { "system-assistant": "p1" },
    prompts: { "system-assistant": "你是和小鸣" },
  });
}

/**
 * @ 选择器用例共用底座：群会话 c1 + members 响应（默认本群含「和小鸣」）+ 可断言的 ws send。
 * 不预置 store 跨群 join 视图（agents）——候选必须来自本会话 members（评审 F1 锁死口径）。
 */
async function setupGroupChat(rows: Member[] = inGroupMembers) {
  const send = vi.fn();
  vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
  useChatStore.setState({
    conversations: [{ id: "c1", type: "group", name: "评审组", memberCount: 3, unreadCount: 0 }],
  });
  mockMessagesFetch([], undefined, { members: [rows], reads: [[]] });
  render(<ChatPage />);
  await act(async () => {}); // 冲刷挂载 effects（fetchMessages/loadReads/fetchMembers 落定）
  return send;
}

describe("ChatPage", () => {
  /** objectURL 桩的序号（每用例归零）：附件断言落在 `blob:mock-N` 上，不依赖真实请求。 */
  let blobSeq = 0;

  beforeEach(() => {
    vi.restoreAllMocks();
    // jsdom 未实现 scrollIntoView
    Element.prototype.scrollIntoView = vi.fn();
    // 附件气泡：createObjectURL 给可区分伪地址，revoke 留给卸载断言（jsdom 原生缺，由 test-setup 补桩）
    blobSeq = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:mock-${++blobSeq}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.mocked(connectWs).mockReset();
    vi.mocked(connectWs).mockReturnValue({ send: vi.fn(), close: vi.fn() });
    // 流式管道复位：streamChat 回空串；llm 绑定默认清空（无绑定 → 发送前拦截路径）；
    // chat store 的 streaming/streamOwner 跨用例不残留
    vi.mocked(streamChat).mockReset();
    vi.mocked(streamChat).mockResolvedValue("");
    useLlmStore.setState({ profiles: [], bindings: {}, prompts: {} });
    useAuthStore.setState({ token: "t1", user: me, status: "authed", error: null });
    useUiStore.setState({
      page: "chat",
      navCollapsed: true,
      activeConversationId: "c1",
      pendingAttachment: null,
    });
    useChatStore.setState({
      conversations: [{ id: "c1", type: "direct", peer, unreadCount: 0 }],
      friends: [],
      incoming: [],
      messages: {},
      reads: {},
      streaming: {},
      streamOwner: {},
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
    // 头部改版后 header 也渲染对方头像 → 共 2 处（header + m1 气泡；自己的消息仍无头像）
    expect(screen.getAllByText("鲍")).toHaveLength(2);
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

  it("头部左侧显示会话头像与昵称、右侧有会话信息按钮", async () => {
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {}); // 冲刷挂载 effects
    // 触发 onOpen → 已连接（否则显示「连接中…」）
    act(() => {
      lastHandlers().onOpen?.();
    });
    // direct：标题=对方昵称；头像为首字回退（peer 无 avatar）
    expect(screen.getByText("鲍勃")).toBeInTheDocument();
    expect(screen.getByText("鲍")).toBeInTheDocument();
    expect(screen.getByText("已连接")).toBeInTheDocument();
    expect(screen.getByLabelText("会话信息")).toBeInTheDocument();
  });

  it("点会话信息弹出信息卡", async () => {
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});
    fireEvent.click(screen.getByLabelText("会话信息"));
    // direct 信息卡：@用户名 + 关闭钮
    expect(screen.getByText("@bob")).toBeInTheDocument();
    expect(screen.getByLabelText("关闭会话信息")).toBeInTheDocument();
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
    bindAssistant(); // 有绑定才不被发送前拦截（无绑定用例见下方「发送前拦截」）

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
    // 冲刷发送后启动的本机流（fetchHistory → streamChat → finish 上行），
    // 否则挂起的异步链会漂到下一条用例才落定，污染其 store 断言
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "agent_finish" })),
    );
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

  it("候选只认本会话群 members：跨群 join 视图里的外群 agent 不可见不可选（评审 F1）", async () => {
    // 跨群 join 视图（Task 6 的 agents）含只在 B 群的 agent——@ 候选若读它就会漏出外群项
    useChatStore.setState({
      agents: [{ id: "foreign-1", owner_id: null, name: "外群甲", avatar: null, description: "" }],
    });
    await setupGroupChat(); // members 响应仅本群行：有和小鸣，无外群甲

    fireEvent.click(screen.getByRole("button", { name: "提及智能体" }));
    expect(screen.getByText("和小鸣")).toBeInTheDocument(); // 正例：本群 members 中的 agent 可见
    expect(screen.queryByText("外群甲")).not.toBeInTheDocument(); // 负例：只在跨群视图的外群 agent 不可见

    fireEvent.click(screen.getByText("和小鸣"));
    expect(screen.getByText("@和小鸣")).toBeInTheDocument(); // 正例：本群 agent 可选
    expect(screen.queryByText("外群甲")).not.toBeInTheDocument();
    useChatStore.setState({ agents: [] }); // 还原，防泄漏到后续用例
  });

  it("Esc 关闭选择器同步清 tokenLock：token 仍在也可再键入重开", async () => {
    await setupGroupChat();
    const input = screen.getByPlaceholderText("输入消息…");

    fireEvent.change(input, { target: { value: "@" } }); // 键入路径开
    fireEvent.click(screen.getByText("和小鸣")); // 键入路径选中 → tokenLock 置位
    expect(input).toHaveValue("@"); // 草稿保持原样（token 还在）

    fireEvent.click(screen.getByRole("button", { name: "提及智能体" })); // 按钮重开（已选被过滤 → 空态）
    expect(screen.getByText("群内暂无智能体")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" }); // Esc 关 + 解锁（Minor#3）
    expect(screen.queryByText("群内暂无智能体")).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "@再看" } }); // token 未断开，解锁后应能重开
    expect(screen.getByText("群内暂无智能体")).toBeInTheDocument();
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

  /** 选中 mention「和小鸣」并发出指定文本（流式用例共用前奏）。 */
  async function pickAndSend(text: string) {
    fireEvent.click(screen.getByRole("button", { name: "提及智能体" }));
    fireEvent.click(screen.getByText("和小鸣"));
    fireEvent.change(screen.getByPlaceholderText("输入消息…"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
  }

  it("发送前拦截：@ 到未绑定 LLM 的智能体 → 不发消息，提示先在设置页配置", async () => {
    const send = await setupGroupChat();

    await pickAndSend("@和小鸣 帮我看下");

    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "和小鸣 未绑定 LLM 连接，请先在设置页配置",
    );
    expect(screen.getByPlaceholderText("输入消息…")).toHaveValue("@和小鸣 帮我看下"); // 草稿保留
    expect(screen.getByText("@和小鸣")).toBeInTheDocument(); // chip 保留
    expect(streamChat).not.toHaveBeenCalled(); // 拦截在触发编排之前
  });

  it("mentions 发送成功触发本机流：打字机气泡 + 生成中提示行 + 自身 chunk 回声不重复累积 + message_new 收口", async () => {
    const send = await setupGroupChat();
    bindAssistant();
    vi.mocked(streamChat).mockImplementation(async (_p, _m, o) => {
      o.onDelta("你");
      o.onDelta("好");
      return "你好";
    });

    await pickAndSend("@和小鸣 打个招呼");

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "agent_chunk", text: "你" })),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent_chunk", text: "好" }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent_finish", text: "你好" }),
    );

    // 打字机气泡（累积文本 + 光标）与输入栏上方「生成中」提示行
    await waitFor(() => expect(screen.getByText(/你好/)).toBeInTheDocument());
    expect(screen.getByText("▌")).toBeInTheDocument();
    expect(screen.getByText("生成中：和小鸣")).toBeInTheDocument();

    const finish = send.mock.calls.map((c) => c[0]).find((e) => e.type === "agent_finish");
    const streamId = (finish as { streamId: string }).streamId;

    // 自身 agent_chunk 回声（服务端全量广播）：本机流已本地累积 → 不重复 upsert
    act(() => {
      lastHandlers().onEvent({
        type: "agent_chunk",
        conversationId: "c1",
        agentId: "system-assistant",
        streamId,
        text: "你",
      });
    });
    expect(screen.getByText(/你好/)).toBeInTheDocument();
    expect(screen.queryByText(/你好你/)).not.toBeInTheDocument();

    // agent_finish → 服务端回 message_new{streamId}：移除 streaming 项，正式消息入列
    act(() => {
      lastHandlers().onEvent({
        type: "message_new",
        streamId,
        message: {
          ...msg("mAgent", "你好", "2026-10-14T01:01:00.000Z"),
          senderType: "agent",
          senderId: "system-assistant",
        },
      });
    });
    expect(screen.queryByText("▌")).not.toBeInTheDocument();
    expect(screen.queryByText("生成中：和小鸣")).not.toBeInTheDocument();
    expect(screen.getByText("你好")).toBeInTheDocument();
    expect(useChatStore.getState().streaming[streamId]).toBeUndefined();
    expect(useChatStore.getState().streamOwner[streamId]).toBe(true); // 归属标记保留（迟到 error 回声仍按本机流处理）
  });

  it("流失败：finish(partial) 上行，agent_error 回声置错误行，点重试重新触发该 mention", async () => {
    const send = await setupGroupChat();
    bindAssistant();
    vi.mocked(streamChat).mockImplementation(async (_p, _m, o) => {
      o.onDelta("半");
      throw new Error("provider_error: HTTP 401 bad key");
    });

    await pickAndSend("@和小鸣 帮我看下");

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "agent_finish", text: "半" })),
    );
    const errEv = send.mock.calls.map((c) => c[0]).find((e) => e.type === "agent_error");
    expect(errEv).toMatchObject({ type: "agent_error", code: "provider_error" });
    const streamId = (errEv as { streamId: string }).streamId;

    // 服务端按序回声：partial 入库的 message_new → agent_error 广播（同帧转发）
    act(() => {
      lastHandlers().onEvent({
        type: "message_new",
        streamId,
        message: {
          ...msg("mHalf", "半", "2026-10-14T01:01:00.000Z"),
          senderType: "agent",
          senderId: "system-assistant",
        },
      });
    });
    act(() => {
      lastHandlers().onEvent(errEv);
    });

    expect(screen.getByText(/HTTP 401/)).toBeInTheDocument(); // 错误原因行
    expect(screen.getByText("半")).toBeInTheDocument(); // partial 消息仍在列表

    // 重试 = 对该 mention 重新跑一遍流
    vi.mocked(streamChat).mockClear();
    fireEvent.click(screen.getByText("重试"));
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
  });

  it("生成中提示行点中断：abortAll → finish(partial) + aborted 错误行可重试", async () => {
    const send = await setupGroupChat();
    bindAssistant();
    vi.mocked(streamChat).mockImplementation(
      (_p, _m, o) =>
        new Promise<string>((_res, rej) => {
          o.onDelta("半");
          o.signal.addEventListener("abort", () =>
            rej(new DOMException("AbortError", "AbortError")),
          );
        }),
    );

    await pickAndSend("@和小鸣 写段文字");
    await waitFor(() => expect(screen.getByText("生成中：和小鸣")).toBeInTheDocument());
    expect(screen.getByText("▌")).toBeInTheDocument();

    fireEvent.click(screen.getByText("中断"));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "agent_error", code: "aborted" }),
      ),
    );
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "agent_finish", text: "半" }));

    const errEv = send.mock.calls.map((c) => c[0]).find((e) => e.type === "agent_error");
    act(() => {
      lastHandlers().onEvent(errEv); // 本机流回声 → 错误态供重试
    });
    expect(screen.getByText(/AbortError/)).toBeInTheDocument();
    expect(screen.getByText("重试")).toBeInTheDocument();
    expect(screen.queryByText("生成中：和小鸣")).not.toBeInTheDocument(); // 不再生成中
  });

  it("他机流：非本机 agent_chunk 按 text 累积渲染，message_new{streamId} 收口移除", async () => {
    await setupGroupChat();

    act(() => {
      lastHandlers().onEvent({
        type: "agent_chunk",
        conversationId: "c1",
        agentId: "system-assistant",
        streamId: "remote-1",
        text: "你",
      });
    });
    act(() => {
      lastHandlers().onEvent({
        type: "agent_chunk",
        conversationId: "c1",
        agentId: "system-assistant",
        streamId: "remote-1",
        text: "好",
      });
    });

    expect(screen.getByText(/你好/)).toBeInTheDocument(); // 累积而非单段
    expect(screen.getByText("和小鸣")).toBeInTheDocument(); // 署名取 members 映射名
    expect(screen.queryByText("生成中：和小鸣")).not.toBeInTheDocument(); // 非本机流不占「生成中」行
    expect(useChatStore.getState().streaming["remote-1"]?.text).toBe("你好");

    act(() => {
      lastHandlers().onEvent({
        type: "message_new",
        streamId: "remote-1",
        message: {
          ...msg("mRemote", "你好", "2026-10-14T01:02:00.000Z"),
          senderType: "agent",
          senderId: "system-assistant",
        },
      });
    });
    expect(screen.queryByText("▌")).not.toBeInTheDocument();
    expect(useChatStore.getState().streaming["remote-1"]).toBeUndefined();
  });

  it("F1 回归：卸载中止后 finish(partial)/agent_error 在 ws close 之前实际发出", async () => {
    // 受控时序：send 与 close 往同一 order 记事件类型，锁定「catch 两帧先于 close」的次序
    const order: string[] = [];
    const send = vi.fn((e: WsClientEvent) => {
      order.push(e.type);
    });
    const close = vi.fn(() => {
      order.push("close");
    });
    vi.mocked(connectWs).mockReturnValue({ send, close } satisfies WsHandle);
    useChatStore.setState({
      conversations: [{ id: "c1", type: "group", name: "评审组", memberCount: 3, unreadCount: 0 }],
    });
    mockMessagesFetch([], undefined, { members: [inGroupMembers], reads: [[]] });
    bindAssistant();
    vi.mocked(streamChat).mockImplementation(
      (_p, _m, o) =>
        new Promise<string>((_res, rej) => {
          const abort = () => rej(new DOMException("AbortError", "AbortError"));
          if (o.signal.aborted) return abort();
          o.onDelta("半");
          o.signal.addEventListener("abort", abort);
        }),
    );

    const view = render(<ChatPage />);
    await act(async () => {});
    await pickAndSend("@和小鸣 写段文字");
    await waitFor(() => expect(screen.getByText("生成中：和小鸣")).toBeInTheDocument());
    expect(Object.keys(useChatStore.getState().streaming)).toHaveLength(1); // 流已在飞（onDelta 半）

    view.unmount(); // cleanup：WS effect 先排期延迟 close，随后 abort effect 中止进行中流

    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent_finish", text: "半" }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent_error", code: "aborted" }),
    );
    // 次序不变量：catch（微任务）的两帧落到句柄上，必须早于 close（宏任务）——否则 partial 不入库
    expect(order.indexOf("agent_finish")).toBeLessThan(order.indexOf("close"));
    expect(order.indexOf("agent_error")).toBeLessThan(order.indexOf("close"));
  });

  it("I1 挂载清扫：本会话孤儿 streaming/streamOwner 条目被清，他会话条目保留", async () => {
    // 上一轮卸载中止后 socket 已关、echo 收不到 → store 残留本会话「生成中」孤儿项
    useChatStore.setState({
      streaming: {
        orphan1: {
          agentId: "system-assistant",
          conversationId: "c1",
          text: "残留半句",
          status: "streaming",
        },
        otherConv: {
          agentId: "system-assistant",
          conversationId: "c2",
          text: "他会话的流",
          status: "streaming",
        },
      },
      streamOwner: { orphan1: true, otherConv: true },
    });
    mockMessagesFetch([]);

    render(<ChatPage />);
    await act(async () => {}); // 冲刷挂载 effects（含清扫）

    const st = useChatStore.getState();
    expect(Object.keys(st.streaming).sort()).toEqual(["otherConv"]); // 本 convId 孤儿被清
    expect(st.streamOwner).toEqual({ otherConv: true }); // 归属键同步清，他会话保留
    expect(screen.queryByText("残留半句")).not.toBeInTheDocument(); // 无「生成中」气泡残留
    expect(screen.queryByText("生成中：和小鸣")).not.toBeInTheDocument(); // 中断行不再出现（no-op 中断按钮消失）
  });

  it("I3 fetchHistory 只取近 30 条：35 条历史组装出末 30 轮 + 本条 user 轮", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    useChatStore.setState({
      conversations: [{ id: "c1", type: "group", name: "评审组", memberCount: 3, unreadCount: 0 }],
    });
    const history = Array.from({ length: 35 }, (_, i) =>
      msg(`m${i + 1}`, `历史${i + 1}`, `2026-10-14T01:00:${String(i).padStart(2, "0")}.000Z`),
    );
    mockMessagesFetch(history, undefined, { members: [inGroupMembers], reads: [[]] });
    render(<ChatPage />);
    await act(async () => {});
    bindAssistant();

    let seen: Parameters<typeof streamChat>[1] | undefined;
    vi.mocked(streamChat).mockImplementation(async (_profile, messages) => {
      seen = messages;
      return "";
    });

    await pickAndSend("@和小鸣 查下上下文");
    await waitFor(() => expect(seen).toBeDefined());

    // 35 条 → slice(-30) 从「历史6」起；末条不等于发送文本故不被剔除 → 30 轮历史
    // （bindAssistant 的系统提示词 unshift 在最前 + 本条 user 轮追加在尾 → 32 条）
    expect(seen).toHaveLength(32);
    expect(seen![0]).toEqual({ role: "system", content: "你是和小鸣" });
    expect(seen![1]).toEqual({ role: "user", content: "历史6" });
    expect(seen![30]).toEqual({ role: "user", content: "历史35" }); // 第 31 条之前的末轮历史
    expect(seen![31]).toEqual({ role: "user", content: "@和小鸣 查下上下文" });
  });

  it("I2 雷达@链路：attach 后（本群 members 出现自建 agent 行）该 agent 进入 @ 候选并可选", async () => {
    await setupGroupChat([
      ...inGroupMembers,
      { kind: "agent", id: "a-mine", name: "架构师", avatar: null, user: null },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "提及智能体" }));
    expect(screen.getByText("架构师")).toBeInTheDocument(); // 服务端 attach → listMembers 带出的行
    fireEvent.click(screen.getByText("架构师"));
    expect(screen.getByText("@架构师")).toBeInTheDocument();
  });

  it("输入区有表情/图片/文件/语音/发送按钮（工具行 + 输入行两行布局）", async () => {
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {}); // 冲刷挂载 effects

    expect(screen.getByLabelText("表情")).toBeInTheDocument();
    expect(screen.getByLabelText("图片")).toBeInTheDocument();
    expect(screen.getByLabelText("文件")).toBeInTheDocument();
    expect(screen.getByLabelText("语音输入")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();

    // 工具行（表情/图片/文件）与输入行（输入框/语音/发送）是两个相邻容器
    const tool = screen.getByLabelText("表情").parentElement!;
    const input = screen.getByPlaceholderText("输入消息…");
    expect(tool).toContainElement(screen.getByLabelText("图片"));
    expect(tool).toContainElement(screen.getByLabelText("文件"));
    const inputRow = input.parentElement!;
    expect(inputRow).toContainElement(screen.getByLabelText("语音输入"));
    expect(inputRow).toContainElement(screen.getByRole("button", { name: "发送" }));
    expect(tool).not.toBe(inputRow);
  });

  it("点表情按钮弹选择器，选中后追加进输入框（并关选择器）", async () => {
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});

    fireEvent.click(screen.getByLabelText("表情"));
    fireEvent.click(await screen.findByRole("button", { name: "😀" }));
    expect((screen.getByPlaceholderText("输入消息…") as HTMLInputElement).value).toBe("😀");
    expect(screen.queryByRole("button", { name: "😄" })).not.toBeInTheDocument(); // 选中即关
  });

  it("点语音输入：无 Web Speech API 的环境提示不支持，不静默", async () => {
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});

    fireEvent.click(screen.getByLabelText("语音输入"));
    expect(screen.getByRole("status")).toHaveTextContent("当前环境不支持语音输入");
  });

  it("切 convId 清发送提示：A 会话的语音提示不带进 B 会话", async () => {
    mockMessagesFetch([]);
    render(<ChatPage />);
    await act(async () => {});

    fireEvent.click(screen.getByLabelText("语音输入"));
    expect(screen.getByRole("status")).toHaveTextContent("当前环境不支持语音输入");

    act(() => {
      useUiStore.setState({ activeConversationId: "c2" });
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument(); // 提示随会话清理
  });

  it("切会话停掉旧识别器：convId 切换调其 stop 并清实例，旧 onend 不清新会话指示", async () => {
    mockMessagesFetch([]);
    const instances: FakeSR[] = [];
    class FakeSR {
      lang = "";
      interimResults = false;
      continuous = false;
      onresult?: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
      onend?: () => void;
      onerror?: () => void;
      start = vi.fn();
      stop = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition = FakeSR;
    try {
      render(<ChatPage />);
      await act(async () => {});

      fireEvent.click(screen.getByLabelText("语音输入"));
      expect(instances).toHaveLength(1);
      expect(instances[0].start).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("语音输入")).toHaveClass("bg-ink"); // 识别中

      // 切会话：旧识别器必须立即停（否则其 onresult 继续回填新会话草稿）
      act(() => {
        useUiStore.setState({ activeConversationId: "c2" });
      });
      expect(instances[0].stop).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("语音输入")).not.toHaveClass("bg-ink"); // 识别态复位

      // 实例已清空：再切会话/卸载不重复 stop 旧实例
      act(() => {
        useUiStore.setState({ activeConversationId: "c3" });
      });
      expect(instances[0].stop).toHaveBeenCalledTimes(1);

      // 新会话重开识别后，旧实例晚到的 onend 不得误清新会话的指示
      fireEvent.click(screen.getByLabelText("语音输入"));
      expect(instances).toHaveLength(2);
      expect(screen.getByLabelText("语音输入")).toHaveClass("bg-ink");
      act(() => {
        instances[0].onend?.();
      });
      expect(screen.getByLabelText("语音输入")).toHaveClass("bg-ink");
      expect(instances[1].start).toHaveBeenCalledTimes(1); // 新实例确在识别
    } finally {
      delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    }
  });

  it("渲染带 file 的消息为附件卡：非图片显示文件名，链接指向带鉴权取到的 objectURL", async () => {
    const m: Message = {
      ...msg("m1", "", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "",
        file: { id: "f1", name: "报告.pdf", mime: "application/pdf", size: 10 },
      },
    };
    mockMessagesFetch([m]);

    render(<ChatPage />);
    expect(await screen.findByText("报告.pdf")).toBeInTheDocument();

    const link = screen.getByRole("link", { name: /报告\.pdf/ });
    // content 路由裸链接会 401 → 组件带 Authorization fetch 后落 objectURL 桩
    expect(link).toHaveAttribute("href", "blob:mock-1");
    expect(link).toHaveAttribute("download", "报告.pdf"); // objectURL 上 download 属性仍可用
    expect(link).toHaveTextContent("0.0 KB"); // 10 字节 → 0.0 KB（size 口径）
    expect(screen.queryByRole("img")).not.toBeInTheDocument(); // 非图片不出缩略图
  });

  it("图片附件渲染为缩略图（src 为鉴权 fetch 得到的 objectURL，非裸 content 地址）", async () => {
    const m: Message = {
      ...msg("m1", "看这张图", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "看这张图",
        file: { id: "f9", name: "a.png", mime: "image/png", size: 1024 },
      },
    };
    mockMessagesFetch([m]);

    render(<ChatPage />);
    const img = (await screen.findByRole("img", { name: "a.png" })) as HTMLImageElement;
    expect(img).toHaveAttribute("src", "blob:mock-1");
    expect(screen.getByText("看这张图")).toBeInTheDocument(); // 文本与附件共存
  });

  it("附件 objectURL：卸载时 revoke（防泄漏），卸载前不销", async () => {
    const m: Message = {
      ...msg("m1", "", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "",
        file: { id: "f1", name: "报告.pdf", mime: "application/pdf", size: 10 },
      },
    };
    mockMessagesFetch([m]);

    const view = render(<ChatPage />);
    const link = await screen.findByRole("link", { name: /报告\.pdf/ });
    expect(link).toHaveAttribute("href", "blob:mock-1");
    expect(vi.mocked(URL.revokeObjectURL)).not.toHaveBeenCalled(); // 仍在用

    view.unmount();
    expect(vi.mocked(URL.revokeObjectURL)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(URL.revokeObjectURL)).toHaveBeenCalledWith("blob:mock-1");
  });

  it("附件 objectURL 竞态：content fetch 未回即卸载 → 晚到结果取到即销（不渲染不泄漏）", async () => {
    const m: Message = {
      ...msg("m1", "", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "",
        file: { id: "f1", name: "报告.pdf", mime: "application/pdf", size: 10 },
      },
    };
    // content 请求悬停：由用例掌控 resolve 时机，模拟「fetch 还没回来就已卸载」
    let resolveContent!: (r: Response) => void;
    const pending = new Promise<Response>((res) => {
      resolveContent = res;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (/\/messages$/.test(url)) return Promise.resolve(jsonRes([m]));
      if (/\/(reads|members)$/.test(url)) return Promise.resolve(jsonRes([]));
      if (/\/files\/[^/]+\/content$/.test(url)) return pending;
      return Promise.resolve(jsonRes({ error: "not found" }, 404));
    });

    const view = render(<ChatPage />);
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some((c) => String(c[0]).includes("/files/f1/content")),
      ).toBe(true), // 附件 effect 已发起 content fetch（响应仍挂起）
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument(); // 取 blob 期间不渲染

    view.unmount(); // effect cleanup：alive=false，owned 尚空 → 卸载本身不销
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    // 晚到的响应：取到即销（无人再用，不 setUrl、不留 objectURL）
    await act(async () => {
      resolveContent({
        ok: true,
        status: 200,
        blob: async () => new Blob(["bin"]),
      } as unknown as Response);
      await new Promise((r) => setTimeout(r, 0)); // 冲刷 fetchFileBlobUrl 的多跳微任务
    });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-1");
  });

  it("附件 content 拉取失败（401）：给「加载失败」占位，不出断链 img/链接", async () => {
    const m: Message = {
      ...msg("m1", "看这张图", "2026-10-14T01:00:00.000Z"),
      payload: {
        text: "看这张图",
        file: { id: "f9", name: "a.png", mime: "image/png", size: 1024 },
      },
    };
    mockMessagesFetch([m], undefined, { contentFail: true });

    render(<ChatPage />);
    expect(await screen.findByText("加载失败")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument(); // 不渲染 src 指向裸地址的断图
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  /**
   * 工具行选文件走 document.createElement("input") 弹系统选择器（jsdom 无文件 UI）：
   * 拦下创建的 input、塞 files、手动触 onchange，等价于「用户选中了文件」。
   */
  function captureFilePicker() {
    const created: HTMLInputElement[] = [];
    const orig = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(
      ((tag: string) => {
        const el = orig(tag);
        if (tag === "input") created.push(el as HTMLInputElement);
        return el;
      }) as typeof document.createElement,
    );
    return {
      pick(accept: string | undefined, file: File | Partial<File>) {
        fireEvent.click(screen.getByLabelText(accept ? "图片" : "文件"));
        const input = created[0];
        expect(input).toBeDefined();
        expect(input.type).toBe("file");
        expect(input.accept).toBe(accept ?? "");
        Object.defineProperty(input, "files", { value: [file], configurable: true });
        input.onchange?.call(input, new Event("change"));
        return input;
      },
    };
  }

  /** 附件用例的 fetch 面：POST /api/files 回 meta，会话只读端点回空表（其余 404）。 */
  function mockUploadFetch(
    meta = { id: "f1", owner: "alice", name: "a.txt", mime: "text/plain", size: 2, updatedAt: "2026-10-17T00:00:00.000Z" },
  ) {
    return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/files") return Promise.resolve(jsonRes(meta, 201));
      if (/\/(messages|reads|members)$/.test(url)) return Promise.resolve(jsonRes([]));
      return Promise.resolve(jsonRes({ error: "not found" }, 404));
    });
  }

  it("选中文件 → 上传共享库 → 发纯附件消息（text 空串 + payload.file）", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    const fetchSpy = mockUploadFetch();

    render(<ChatPage />);
    await act(async () => {});

    captureFilePicker().pick(undefined, new File(["ab"], "a.txt", { type: "text/plain" }));

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: "send_message",
        conversationId: "c1",
        payload: {
          text: "",
          file: { id: "f1", name: "a.txt", mime: "text/plain", size: 2 },
        },
      }),
    );
    expect(
      fetchSpy.mock.calls.some((c) => String(c[0]) === "/api/files" && c[1]?.method === "POST"),
    ).toBe(true); // 附件已落共享库
    expect(screen.queryByRole("status")).not.toBeInTheDocument(); // 成功路径不报错
  });

  it("附件超 6MB：不上传不发送，提示「文件需小于 6MB」；图片入口限定 image/*", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    const fetchSpy = mockUploadFetch();

    render(<ChatPage />);
    await act(async () => {});

    captureFilePicker().pick("image/*", {
      name: "huge.png",
      type: "image/png",
      size: 7 * 1024 * 1024,
    } as unknown as File);

    expect(await screen.findByRole("status")).toHaveTextContent("文件需小于 6MB");
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" }));
    expect(fetchSpy.mock.calls.some((c) => String(c[0]) === "/api/files")).toBe(false); // 未发起上传
  });

  it("上传失败：提示上传失败原因，不发消息", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/files") return Promise.resolve(jsonRes({ error: "too large" }, 413));
      if (/\/(messages|reads|members)$/.test(url)) return Promise.resolve(jsonRes([]));
      return Promise.resolve(jsonRes({ error: "not found" }, 404));
    });

    render(<ChatPage />);
    await act(async () => {});

    captureFilePicker().pick(undefined, new File(["ab"], "a.txt", { type: "text/plain" }));

    expect(await screen.findByRole("status")).toHaveTextContent("上传失败：too large");
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" }));
  });

  it("上传悬停期间切会话：await 后丢弃不发送，提示「已切换会话，文件未发送」", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    // 上传响应由用例掌控：先悬停（模拟慢网络），期间切会话，再让 uploadFile 落定
    let resolveUpload!: (r: Response) => void;
    const pending = new Promise<Response>((res) => {
      resolveUpload = res;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/files") return pending;
      if (/\/(messages|reads|members)$/.test(url)) return Promise.resolve(jsonRes([]));
      return Promise.resolve(jsonRes({ error: "not found" }, 404));
    });

    render(<ChatPage />);
    await act(async () => {});

    captureFilePicker().pick(undefined, new File(["ab"], "a.txt", { type: "text/plain" }));
    act(() => {
      useUiStore.setState({ activeConversationId: "c2" }); // await 未返回前已切会话
    });

    await act(async () => {
      resolveUpload(
        jsonRes(
          {
            id: "f1",
            owner: "alice",
            name: "a.txt",
            mime: "text/plain",
            size: 2,
            updatedAt: "2026-10-17T00:00:00.000Z",
          },
          201,
        ),
      );
      await new Promise((r) => setTimeout(r, 0)); // 冲刷 uploadFile → sendFile 收尾
    });

    // 旧闭包的 convId/handle 都过期：不得把附件发进 B 会话
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" }));
    expect(await screen.findByRole("status")).toHaveTextContent("已切换会话，文件未发送");
  });

  it("消费 pendingAttachment：切到目标会话后经 WS 发送 file 消息", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([]);
    useChatStore.setState({
      conversations: [
        { id: "c1", type: "direct", peer, unreadCount: 0 },
        { id: "c2", type: "direct", peer, unreadCount: 0 },
      ],
    });

    render(<ChatPage />); // 挂在 c1（beforeEach 口径）
    await act(async () => {});

    // 槽指向 c2：本会话（c1）不发、槽保留
    const file = { id: "f-share", name: "共享.md", mime: "text/markdown", size: 3 };
    act(() => {
      useUiStore.setState({ pendingAttachment: { conversationId: "c2", file } });
    });
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" }));
    expect(useUiStore.getState().pendingAttachment).toEqual({ conversationId: "c2", file });

    // 切到目标会话 → 消费槽，经 WS 发出纯附件消息（text 空串 + payload.file）
    act(() => {
      useUiStore.setState({ activeConversationId: "c2" });
    });
    expect(send).toHaveBeenCalledWith({
      type: "send_message",
      conversationId: "c2",
      payload: { text: "", file },
    });
    expect(useUiStore.getState().pendingAttachment).toBeNull();
  });

  it("pendingAttachment 目标不是本会话时不发送", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([]);

    render(<ChatPage />);
    await act(async () => {});

    const file = { id: "f-other", name: "别会话.txt", mime: "text/plain", size: 1 };
    act(() => {
      useUiStore.setState({ pendingAttachment: { conversationId: "c-other", file } });
    });
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" }));
    expect(useUiStore.getState().pendingAttachment).toEqual({
      conversationId: "c-other",
      file,
    }); // 槽保留，等目标会话激活时再消费
  });

  // —— 二期 IM Task 2：消息撤回 UI ——

  it("自己消息出「撤回」按钮（对方消息无），点击经 ws 发 recall_message", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    const theirs = msg("m2", "对方的", "2026-10-14T01:00:00.000Z"); // senderId u2
    const mine: Message = { ...msg("m1", "我发的", "2026-10-14T01:01:00.000Z"), senderId: "u1" };
    mockMessagesFetch([theirs, mine]);

    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("我发的")).toBeInTheDocument());

    // 按钮只在自己消息上出现（对方消息无）→ 全页恰 1 个
    expect(screen.getAllByLabelText("撤回消息")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("撤回消息"));
    expect(send).toHaveBeenCalledWith({
      type: "recall_message",
      conversationId: "c1",
      messageId: "m1",
    });
  });

  it("已撤回消息渲染「消息已撤回」灰字：文本/附件/已读不显示，也不出撤回钮", async () => {
    const recalled: Message = {
      ...msg("m1", "敏感内容", "2026-10-14T01:00:00.000Z"),
      senderId: "u1",
      recalledAt: "2026-10-17T00:00:00.000Z",
      payload: {
        text: "敏感内容",
        file: { id: "f1", name: "报告.pdf", mime: "application/pdf", size: 10 },
      },
    };
    const live = msg("m2", "还在的", "2026-10-14T02:00:00.000Z");
    mockMessagesFetch([recalled, live], undefined, {
      // 对方读点晚于自己那条 → 若「已读」抑制失效本应显示（真击穿守卫）
      reads: [[{ userId: "u2", at: "2026-10-14T03:00:00.000Z" }]],
    });

    render(<ChatPage />);
    expect(await screen.findByText("消息已撤回")).toBeInTheDocument();
    expect(screen.getByText("还在的")).toBeInTheDocument(); // 未撤回消息不受影响
    expect(screen.queryByText("敏感内容")).not.toBeInTheDocument();
    expect(screen.queryByText("报告.pdf")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument(); // 附件不渲染（也不发 content fetch）
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText("已读")).not.toBeInTheDocument(); // 已撤回不显已读
    expect(screen.queryByLabelText("撤回消息")).not.toBeInTheDocument(); // 已撤回不再出撤回钮
  });

  it("收到 message_recalled 事件：气泡即时变「消息已撤回」，列表不移除", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([msg("m1", "刚发来的", "2026-10-14T01:00:00.000Z")]);

    render(<ChatPage />);
    expect(await screen.findByText("刚发来的")).toBeInTheDocument();

    act(() => {
      lastHandlers().onEvent({
        type: "message_recalled",
        conversationId: "c1",
        messageId: "m1",
        at: "2026-10-17T02:00:00.000Z",
      });
    });
    expect(screen.getByText("消息已撤回")).toBeInTheDocument();
    expect(screen.queryByText("刚发来的")).not.toBeInTheDocument();
    expect(useChatStore.getState().messages.c1).toHaveLength(1); // 列表不移除
    expect(useChatStore.getState().messages.c1[0].recalledAt).toBe("2026-10-17T02:00:00.000Z");
  });

  it("fetchHistory 跳过已撤回消息：streamChat 拿到的历史不含撤回原文，正常历史与本条 user 轮不受影响", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    useChatStore.setState({
      conversations: [{ id: "c1", type: "group", name: "评审组", memberCount: 3, unreadCount: 0 }],
    });
    // 末条是窗口尾的已撤回消息：跳过后尾部只剩正常历史，本条 user 轮的 pop 剔除逻辑仍正确
    const history: Message[] = [
      msg("m1", "早前正常讨论", "2026-10-14T01:00:00.000Z"),
      {
        ...msg("m2", "机密方案文本", "2026-10-14T01:01:00.000Z"),
        recalledAt: "2026-10-17T00:00:00.000Z",
      },
    ];
    mockMessagesFetch(history, undefined, { members: [inGroupMembers], reads: [[]] });
    render(<ChatPage />);
    await act(async () => {});
    bindAssistant();

    let seen: Parameters<typeof streamChat>[1] | undefined;
    vi.mocked(streamChat).mockImplementation(async (_profile, messages) => {
      seen = messages;
      return "";
    });

    await pickAndSend("@和小鸣 查下上下文");
    await waitFor(() => expect(seen).toBeDefined());

    // 已撤回原文不进提示词；正常历史保留；末轮是本条 user 轮（未被误剔、未重复）
    const contents = seen!.map((r) => r.content);
    expect(contents).not.toContain("机密方案文本");
    expect(contents).toContain("早前正常讨论");
    expect(seen).toHaveLength(3); // system + 正常历史 1 条 + 本条 user 轮
    expect(seen![seen!.length - 1]).toEqual({ role: "user", content: "@和小鸣 查下上下文" });
  });

  // —— 二期 IM Task 3：回复引用 UI ——

  it("点回复出引用预览条，发送消息带 replyTo（协议顶层键，非 payload 内）", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([msg("m1", "被回复的原句", "2026-10-14T01:00:00.000Z")]); // senderId u2

    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("被回复的原句")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("回复此消息"));
    // 引用预览条：「回复」标签 + 署名 + 原文片段 + 取消钮（经取消钮的父容器圈定预览条，防与气泡同文撞车）
    const bar = screen.getByLabelText("取消回复").parentElement!;
    expect(bar).toHaveTextContent("回复");
    expect(bar).toHaveTextContent("鲍勃"); // direct 会话署名 = peer.displayName
    expect(bar).toHaveTextContent("被回复的原句");

    fireEvent.change(screen.getByPlaceholderText("输入消息…"), { target: { value: "我来回复" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    // replyTo 是 send_message 事件的顶层键（shared WsClientEventSchema），塞 payload 会被 zod 剥掉
    expect(send).toHaveBeenCalledWith({
      type: "send_message",
      conversationId: "c1",
      replyTo: "m1",
      payload: { text: "我来回复" },
    });
    expect(screen.queryByLabelText("取消回复")).not.toBeInTheDocument(); // 发送成功清预览条
  });

  it("气泡渲染 replyTo 引用小卡且点引用滚动到原消息", async () => {
    const orig = msg("m1", "最初的提议", "2026-10-14T01:00:00.000Z"); // senderId u2
    const reply: Message = {
      ...msg("m2", "同意这个方向", "2026-10-14T01:05:00.000Z"),
      senderId: "u1",
      replyTo: "m1",
    };
    mockMessagesFetch([orig, reply]);

    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("同意这个方向")).toBeInTheDocument());

    // 引用小卡：署名 + 原文片段（与 A 气泡正文区分：卡内含署名 span）
    const card = await screen.findByRole("button", { name: /最初的提议/ });
    expect(card).toHaveTextContent("鲍勃");
    expect(card).toHaveTextContent("最初的提议");

    fireEvent.click(card);
    const target = document.getElementById("msg-m1");
    expect(target).not.toBeNull();
    expect(target!.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
  });

  it("× 取消引用后发送不带 replyTo 键", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([msg("m1", "被回复的原句", "2026-10-14T01:00:00.000Z")]);

    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("被回复的原句")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("回复此消息"));
    expect(screen.getByLabelText("取消回复")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("取消回复"));
    expect(screen.queryByLabelText("取消回复")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("输入消息…"), { target: { value: "先不引用了" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(send).toHaveBeenCalledWith({
      type: "send_message",
      conversationId: "c1",
      payload: { text: "先不引用了" }, // 精确形状：无 replyTo 键
    });
  });

  it("已撤回消息不出回复钮；被撤回的原消息不渲染引用小卡", async () => {
    const recalledOrig: Message = {
      ...msg("m1", "会被撤回的原文", "2026-10-14T01:00:00.000Z"),
      recalledAt: "2026-10-17T00:00:00.000Z",
    };
    const live: Message = {
      ...msg("m2", "还在的回复", "2026-10-14T01:05:00.000Z"),
      senderId: "u1",
      replyTo: "m1", // 原消息已撤回 → 引用卡整体不渲染（撤回原文不回显）
    };
    const recalledReply: Message = {
      ...msg("m3", "已撤回的回复体", "2026-10-14T01:06:00.000Z"),
      replyTo: "m2",
      recalledAt: "2026-10-17T00:01:00.000Z",
    };
    mockMessagesFetch([recalledOrig, live, recalledReply]);

    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("还在的回复")).toBeInTheDocument());
    expect(screen.getAllByText("消息已撤回")).toHaveLength(2); // m1（原消息）与 m3 都出灰字行

    expect(screen.queryByText("会被撤回的原文")).not.toBeInTheDocument(); // 原文不回显
    // m3 的引用卡不渲染：页面上没有任何按钮引用 m2 原文
    expect(
      [...document.querySelectorAll("button")].filter((b) => b.textContent?.includes("还在的回复")),
    ).toHaveLength(0);
    // 回复钮只出现在 m2（未撤回）上——m1/m3 已撤回不出
    expect(screen.getAllByLabelText("回复此消息")).toHaveLength(1);
  });

  it("切换会话清空引用预览（防跨会话带出）", async () => {
    vi.mocked(connectWs).mockReturnValue({ send: vi.fn(), close: vi.fn() } satisfies WsHandle);
    mockMessagesFetch([msg("m1", "本会话的引用", "2026-10-14T01:00:00.000Z")]);

    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText("本会话的引用")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("回复此消息"));
    expect(screen.getByLabelText("取消回复")).toBeInTheDocument();

    act(() => {
      useUiStore.setState({ activeConversationId: "c2" });
    });
    expect(screen.queryByLabelText("取消回复")).not.toBeInTheDocument();
  });

  it("fetchHistory 窗口尾全是已撤回消息（剔空尾部）：不炸，本条 user 轮照常在尾", async () => {
    const send = vi.fn();
    vi.mocked(connectWs).mockReturnValue({ send, close: vi.fn() } satisfies WsHandle);
    useChatStore.setState({
      conversations: [{ id: "c1", type: "group", name: "评审组", memberCount: 3, unreadCount: 0 }],
    });
    // 全部已撤回 → 跳过后 rows 为空：pop 的 `last &&` 守卫不炸，本条 user 轮由编排方追加
    const history: Message[] = [
      {
        ...msg("m1", "被撤回的旧讨论", "2026-10-14T01:00:00.000Z"),
        recalledAt: "2026-10-17T00:00:00.000Z",
      },
      {
        ...msg("m2", "被撤回的末条", "2026-10-14T01:01:00.000Z"),
        recalledAt: "2026-10-17T00:00:01.000Z",
      },
    ];
    mockMessagesFetch(history, undefined, { members: [inGroupMembers], reads: [[]] });
    render(<ChatPage />);
    await act(async () => {});
    bindAssistant();

    let seen: Parameters<typeof streamChat>[1] | undefined;
    vi.mocked(streamChat).mockImplementation(async (_profile, messages) => {
      seen = messages;
      return "";
    });

    await pickAndSend("@和小鸣 空历史触发");
    await waitFor(() => expect(seen).toBeDefined());

    const contents = seen!.map((r) => r.content);
    expect(contents).not.toContain("被撤回的旧讨论");
    expect(contents).not.toContain("被撤回的末条");
    expect(seen).toHaveLength(2); // system + 本条 user 轮（历史被剔空）
    expect(seen![1]).toEqual({ role: "user", content: "@和小鸣 空历史触发" });
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
