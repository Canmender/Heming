/**
 * d.39 App 生命周期 / 页面切换压测（QA 独立复检）。
 *
 * App 壳在「没有 ChatPage 实例」时保持一条后台 WS 连接；ChatPage 挂载时让位。
 * 这里用桩 connectWs 统计建连/关闭是否配平、是否残留活句柄，并复现
 * 「后台连接 → ChatPage」交接窗口内对当前会话误提醒的问题。
 */
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { App } from "../App.js";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useNotificationStore, setNotificationStorage } from "../store/notifications.js";
import { setToken } from "./api.js";
import {
  chatSocketCount,
  registerChatSocket,
  resetChatSocketPresenceForTest,
} from "./chatSocketPresence.js";
import { resetConvPrefsForTest } from "./convPrefs.js";
import { connectWs, type WsHandlers } from "./ws.js";

// 启动动画自动完成，避免遮罩影响路由。
vi.mock("../components/BootWave.js", () => ({
  BootWave: ({ onDone }: { onDone: () => void }) => {
    useEffect(() => {
      onDone();
    }, [onDone]);
    return null;
  },
}));

// 桩掉真实 WebSocket：每次 connectWs 返回独立句柄，供配平/残留统计。
vi.mock("./ws.js", () => ({
  connectWs: vi.fn(() => ({ send: vi.fn(), close: vi.fn() })),
}));

const alice = { id: "u1", username: "alice", displayName: "爱丽丝" };
const bob = { id: "u2", username: "bob", displayName: "鲍勃" };
const c1 = { id: "c1", type: "direct" as const, peer: bob, unreadCount: 0, lastMessageAt: null };

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url === "/api/me") return Promise.resolve(jsonRes(alice));
    if (url === "/api/files") return Promise.resolve(jsonRes([]));
    if (url === "/api/files/usage")
      return Promise.resolve(jsonRes({ used: 0, quota: 200 * 1024 * 1024 }));
    if (url === "/api/health") return Promise.resolve(jsonRes({ ok: true }));
    if (url === "/api/conversations") return Promise.resolve(jsonRes([c1]));
    if (url === "/api/agents") return Promise.resolve(jsonRes([]));
    if (url === "/api/friends") return Promise.resolve(jsonRes([]));
    if (url === "/api/friends/requests") return Promise.resolve(jsonRes([]));
    if (url.startsWith("/api/e2e/keys")) return Promise.resolve(jsonRes({ ok: true }));
    if (/^\/api\/conversations\/[^/]+\/messages$/.test(url)) return Promise.resolve(jsonRes([]));
    if (/^\/api\/conversations\/[^/]+\/reads$/.test(url)) return Promise.resolve(jsonRes([]));
    if (/^\/api\/conversations\/[^/]+\/members$/.test(url)) return Promise.resolve(jsonRes([]));
    return Promise.resolve(jsonRes({ error: "not found" }, 404));
  });
}

type Handle = { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
const mockConnect = vi.mocked(connectWs);
const handles = (): Handle[] => mockConnect.mock.results.map((r) => r.value as Handle);
const handlerAt = (i: number): WsHandlers => mockConnect.mock.calls[i][0] as WsHandlers;

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  mockConnect.mockClear();
  setToken(null);
  resetChatSocketPresenceForTest();
  resetConvPrefsForTest();
  setNotificationStorage(null);
  useNotificationStore.setState({ items: [] });
  useAuthStore.setState({ token: null, user: null, status: "idle", error: null });
  useChatStore.setState({ conversations: [], messages: {}, plainById: {} });
  useUiStore.setState({
    page: "home",
    activeConversationId: null,
    openTabs: [],
    contactsHidden: false,
  });
  delete (window as unknown as { __heming_notify?: unknown }).__heming_notify;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { __heming_notify?: unknown }).__heming_notify;
});

async function renderAuthed(): Promise<void> {
  setToken("t1");
  useAuthStore.setState({ token: "t1", user: alice as never, status: "authed" });
  mockFetch();
  render(<App />);
  await waitFor(() => expect(mockConnect).toHaveBeenCalled());
  // 等首页的 loadWorkspace 落定，保证 c1 已在会话列表里（未读才能就地 +1）
  await waitFor(() =>
    expect(useChatStore.getState().conversations.some((c) => c.id === "c1")).toBe(true),
  );
}

describe("B2. 快速切页：连接/关闭配平", () => {
  it("home→chat→home ×30：建连数 = 1+2N，仅最后一个后台句柄存活，无残留", async () => {
    await renderAuthed();
    expect(mockConnect).toHaveBeenCalledTimes(1); // 初始后台连接
    expect(chatSocketCount()).toBe(0);

    const cycles = 30;
    for (let i = 0; i < cycles; i += 1) {
      await act(async () => {
        useUiStore.getState().openConversation("c1");
      });
      expect(chatSocketCount()).toBeGreaterThan(0);

      await act(async () => {
        useUiStore.getState().setPage("home");
      });
      expect(chatSocketCount()).toBe(0);
    }

    const hs = handles();
    expect(hs).toHaveLength(1 + 2 * cycles);
    const live = hs.filter((h) => h.close.mock.calls.length === 0);
    // 只有最后一次「回首页」开的后台连接应存活
    expect(live).toHaveLength(1);
    expect(hs[hs.length - 1].close).not.toHaveBeenCalled();
    for (let i = 0; i < hs.length - 1; i += 1) {
      // 每个历史句柄恰好关闭一次（不重复 close）
      expect(hs[i].close.mock.calls.length).toBe(1);
    }
    // 后台连接存在 ⇔ ChatPage 计数为 0
    expect(chatSocketCount()).toBe(0);
  }, 120_000);
});

describe("B3/B4. 登录态与通知点击", () => {
  function installBridge(): Array<(id: string | null) => void> {
    const cbs: Array<(id: string | null) => void> = [];
    window.__heming_notify = {
      message: vi.fn(),
      onOpen: (cb) => {
        cbs.push(cb);
        return () => {};
      },
    };
    return cbs;
  }

  it("B3: 未登录不建后台连接；通知点击被忽略", async () => {
    const onOpenCbs = installBridge();
    mockFetch();
    useUiStore.setState({ page: "home", activeConversationId: "keep-me" });
    render(<App />);
    await screen.findByText("登录你的账号");
    expect(mockConnect).not.toHaveBeenCalled();

    act(() => {
      for (const cb of onOpenCbs) cb("c-ghost");
    });
    expect(useUiStore.getState().page).toBe("home");
    expect(useUiStore.getState().activeConversationId).toBe("keep-me");
  });

  it("B4: 已登录时通知点击 → page=chat 且 activeConversationId 为目标会话", async () => {
    const onOpenCbs = installBridge();
    await renderAuthed();
    expect(onOpenCbs.length).toBeGreaterThan(0);

    act(() => {
      for (const cb of onOpenCbs) cb(c1.id);
    });
    expect(useUiStore.getState().page).toBe("chat");
    expect(useUiStore.getState().activeConversationId).toBe(c1.id);
  });
});

describe("E4. 100 次页面切换计时与配平", () => {
  it("100 次 chat↔home 切换：墙钟、句柄配平", async () => {
    await renderAuthed();
    const switches = 100;
    const t0 = performance.now();
    for (let i = 0; i < switches; i += 1) {
      await act(async () => {
        if (i % 2 === 0) useUiStore.getState().openConversation("c1");
        else useUiStore.getState().setPage("home");
      });
    }
    const total = performance.now() - t0;
    // 100 次切换 = 50 个完整周期 → 1 + 100 次建连
    const hs = handles();
    const live = hs.filter((h) => h.close.mock.calls.length === 0);
    console.info(
      `[E4] ${switches} switches total=${total.toFixed(1)}ms per=${(total / switches).toFixed(2)}ms ` +
        `handles=${hs.length} live=${live.length} chatSocketCount=${chatSocketCount()}`,
    );
    expect(hs.length).toBe(1 + switches);
    expect(live).toHaveLength(1);
    expect(chatSocketCount()).toBe(0);
    expect(total).toBeLessThan(120_000);
  }, 180_000);
});

describe("F. 交接窗口与未知会话点击", () => {
  it("F-overlap: 交接窗口内 ChatPage 已挂载 → 后台不再为当前可见会话记未读/提醒", async () => {
    const osMessage = vi.fn();
    window.__heming_notify = { message: osMessage, onOpen: vi.fn(() => () => {}) };
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await renderAuthed();
    expect(mockConnect).toHaveBeenCalledTimes(1);
    const bg = handlerAt(0);
    const bgMsg = {
      id: "overlap-1",
      conversationId: "c1",
      senderType: "user" as const,
      senderId: bob.id,
      payload: { text: "你正在打开这个会话" },
      replyTo: null,
      createdAt: "2026-10-28T02:00:00.000Z",
      recalledAt: null,
      enc: "plain" as const,
    };

    // 模拟交接窗口：ChatPage 已注册 presence、App 的后台连接尚未卸载
    await act(async () => {
      const releasePresence = registerChatSocket();
      // 用户点开会话；后台连接此刻仍在（交接窗口）
      useUiStore.getState().openConversation("c1");
      bg.onEvent({ type: "message_new", message: bgMsg });
      releasePresence();
    });

    const notifications = useNotificationStore.getState().items;
    console.info(
      `[F-overlap] notifications=${notifications.length} osToasts=${osMessage.mock.calls.length} ` +
        `page=${useUiStore.getState().page} active=${useUiStore.getState().activeConversationId}`,
    );
    expect(useUiStore.getState().page).toBe("chat");
    // 可见会话由 ChatPage 自己 append / 标已读：后台不再计未读、不提醒
    expect(notifications).toHaveLength(0);
    expect(osMessage).not.toHaveBeenCalled();
    const c1Row = useChatStore.getState().conversations.find((c) => c.id === "c1");
    expect(c1Row?.unreadCount ?? 0).toBe(0);
  });

  it("F-ghost: 点击已不存在的会话 id 不崩，但会打开一个空壳会话", async () => {
    let ghostCb: ((id: string) => void) | undefined;
    window.__heming_notify = {
      message: vi.fn(),
      onOpen: (cb) => {
        ghostCb = cb;
        return () => {};
      },
    };
    await renderAuthed();
    expect(ghostCb).toBeTypeOf("function");
    await act(async () => {
      ghostCb!("ghost-conv");
    });
    expect(useUiStore.getState().page).toBe("chat");
    expect(useUiStore.getState().activeConversationId).toBe("ghost-conv");
    // ChatPage 在缺少会话行时不崩，标题回落「会话」
    expect(await screen.findByText("会话")).toBeInTheDocument();
  });
});
