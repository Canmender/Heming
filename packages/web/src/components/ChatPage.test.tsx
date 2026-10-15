import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import type { Message, User } from "@heming/shared";
import { ChatPage } from "./ChatPage.js";
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

/** 按调用序返回不同历史列表的 fetch mock（首次 → first，其后 → second ?? first）。 */
function mockMessagesFetch(first: Message[], second?: Message[]) {
  let call = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (/^\/api\/conversations\/[^/]+\/messages$/.test(url)) {
      const list = call++ === 0 ? first : (second ?? first);
      return Promise.resolve(jsonRes(list));
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
});
