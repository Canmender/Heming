/**
 * d.39 App 生命周期 / 页面切换压测（团队系统裁剪后）。
 *
 * 去 IM 后 App 壳不再维护后台聊天连接：只有助手页（ChatPage 挂载）才建 WS，
 * 离开即关。这里锁「建连/关闭配平、无残留活句柄」，以及通知深链打开会话。
 */
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../App.js";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { setNotificationStorage } from "../store/notifications.js";
import { setToken } from "./api.js";
import {
  chatSocketCount,
  resetChatSocketPresenceForTest,
} from "./chatSocketPresence.js";
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
const c1 = {
  id: "c1",
  type: "agent" as const,
  agent: {
    id: "system-assistant",
    owner_id: null,
    name: "和小鸣",
    avatar: null,
    description: "官方",
  },
  unreadCount: 0,
  lastMessageAt: null,
};

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
    if (url.startsWith("/api/e2e/keys")) return Promise.resolve(jsonRes({ ok: true }));
    if (/^\/api\/conversations\/[^/]+\/messages$/.test(url)) return Promise.resolve(jsonRes([]));
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
  setNotificationStorage(null);
  useAuthStore.setState({ token: null, user: null, status: "idle", error: null });
  useChatStore.setState({
    conversations: [],
    messages: {},
    agentsRoster: [],
    messagesLoading: {},
    messagesError: {},
    streaming: {},
    streamOwner: {},
    plainById: {},
    pendingE2e: {},
  });
  useUiStore.setState({ page: "home", activeConversationId: null });
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
  // 等首页的 loadWorkspace 落定，保证 c1 已在会话列表里
  await waitFor(() =>
    expect(useChatStore.getState().conversations.some((c) => c.id === "c1")).toBe(true),
  );
}

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

  it("B3: 未登录不建 WS 连接；通知点击被忽略", async () => {
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
  it("100 次 chat↔home 切换：每次挂载建连、离开关闭，无残留", async () => {
    await renderAuthed();
    expect(mockConnect).not.toHaveBeenCalled(); // 首页不再建后台连接
    const switches = 100;
    const t0 = performance.now();
    for (let i = 0; i < switches; i += 1) {
      await act(async () => {
        if (i % 2 === 0) useUiStore.getState().openConversation("c1");
        else useUiStore.getState().setPage("home");
      });
    }
    const total = performance.now() - t0;
    const hs = handles();
    const live = hs.filter((h) => h.close.mock.calls.length === 0);
    console.info(
      `[E4] ${switches} switches total=${total.toFixed(1)}ms per=${(total / switches).toFixed(2)}ms ` +
        `handles=${hs.length} live=${live.length} chatSocketCount=${chatSocketCount()}`,
    );
    expect(hs.length).toBe(switches / 2); // 每进一次助手页建一次（偶数步）
    expect(live).toHaveLength(0); // 最后停在首页，全部关闭
    expect(chatSocketCount()).toBe(0);
    expect(total).toBeLessThan(120_000);
  }, 180_000);
});

describe("F. 未知会话点击", () => {
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
    // 会话行已不存在 → 智能体页回落到「选择一个智能体开始」，而不是崩或挂一个空壳聊天。
    // 限定在主内容区：左侧名册也含「智能体」字样，全局查会命中多个。
    expect(
      await within(screen.getByRole("main")).findByText("选择一个智能体开始"),
    ).toBeInTheDocument();
  });
});
