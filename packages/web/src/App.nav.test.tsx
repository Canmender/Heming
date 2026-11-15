/**
 * 新外壳（顶栏 + 常驻会话侧栏 + 页面菜单）：替换旧的「Ctrl+B 导航栏」测试（d.68 → 精简外壳）。
 *
 * 覆盖 REFACTOR-BRIEF 的 T3 口径 1-5：
 *   1. 已登录壳里没有 nav[aria-label="主导航"] / .w-14 图标轨；
 *   2. header[data-testid="topbar"] 存在；「打开页面菜单」→ role=menu「页面菜单」→ 点「设置」后 h1 是设置；
 *      且无 sessionStorage 时默认页是会话（chat）；
 *   3. Sidebar 常驻：aria-label「新建会话」+ h2「会话列表」，点「新对话」进入会话页；
 *   4. 浏览器（无 window.heming）TopBar 也渲染且类含 h-10；桌面根节点类含 desktop-titlebar；
 *   5. Ctrl/⌘+B 不再生效、不写 heming.nav.mode.v1；Alt+8 仍切会话。
 */
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./App.js";
import { useAuthStore } from "./store/auth.js";
import { useChatStore } from "./store/chat.js";
import { useUiStore } from "./store/ui.js";
import { setToken } from "./lib/api.js";

vi.mock("./lib/appPresence.js", () => ({ useAppPresence: () => undefined }));
vi.mock("./components/BootWave.js", () => ({
  BootWave: ({ onDone }: { onDone: () => void }) => {
    useEffect(() => {
      onDone();
    }, [onDone]);
    return null;
  },
}));

// 本文件只关心外壳与快捷键，不跑对话链路。
vi.mock("./lib/ws.js", () => ({
  connectWs: vi.fn(() => ({ send: vi.fn(), close: vi.fn() })),
}));

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const alice = { id: "u1", username: "alice", displayName: "爱丽丝" };

function mockFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url === "/api/me") return Promise.resolve(jsonRes(alice));
    if (url === "/api/files/usage")
      return Promise.resolve(jsonRes({ used: 0, quota: 200 * 1024 * 1024 }));
    if (url === "/api/files") return Promise.resolve(jsonRes([]));
    if (url === "/api/health") return Promise.resolve(jsonRes({ ok: true }));
    if (url === "/api/team")
      return Promise.resolve(jsonRes({ members: [], onlineCount: 0 }));
    if (url === "/api/team/activities") return Promise.resolve(jsonRes({ activities: [] }));
    if (url === "/api/agents") return Promise.resolve(jsonRes([]));
    // 默认页是会话：AssistantPage 的 loadWorkspace 会拉会话列表，必须给空数组而不是 404。
    if (url === "/api/conversations" || url.startsWith("/api/conversations?"))
      return Promise.resolve(jsonRes([]));
    return Promise.resolve(jsonRes({ error: "not found" }, 404));
  });
}

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

/**
 * 模块加载时的初始页。vitest 按文件隔离 jsdom，本文件 import 时 sessionStorage 还是空的，
 * 所以这就是「没有 sessionStorage 时」的初始页——用于口径 2 的默认页断言。
 */
const initialPage = useUiStore.getState().page;

beforeEach(() => {
  localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  setToken("t1");
  setViewportWidth(1280);
  mockFetch();
  useAuthStore.setState({ token: "t1", user: alice, status: "authed", error: null });
  // 页面由各用例自己指定；第一条用例刻意不动它，用来断言模块初始页（默认 chat）。
  useUiStore.setState({
    page: "home",
    pageView: null,
    activeConversationId: null,
    paletteIntent: null,
  });
  useChatStore.setState({
    conversations: [],
    messages: {},
    workspaceReady: true,
    workspaceError: "",
    conversationsHasMore: false,
    conversationsLoadingMore: false,
    loadWorkspace: vi.fn(async () => undefined),
    loadMoreConversations: vi.fn(async () => undefined),
    openAgent: vi.fn(async () => "c9"),
  });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).heming;
});

describe("新外壳：顶栏 + 常驻会话侧栏 + 页面菜单", () => {
  it("默认页是会话（无 sessionStorage），壳里没有导航轨", async () => {
    // 本文件第一条用例：initialPage 是 ui.ts 模块初始化时的 page（早于任何 setState）。
    expect(initialPage).toBe("chat");
    useUiStore.setState({ page: initialPage });

    const { container } = render(<App />);

    // 页面路由是 lazy + Suspense：顶栏先出现，main 里可能还在 page-fallback。
    await screen.findByTestId("topbar");
    // 默认页 = 会话：AssistantPage 的 sr-only h1。
    expect(await screen.findByRole("heading", { level: 1, name: "会话" })).toBeInTheDocument();
    // 旧的左侧图标导航轨已被删除。
    expect(container.querySelector('nav[aria-label="主导航"]')).toBeNull();
    expect(container.querySelector(".w-14")).toBeNull();
    // 空会话列表 → 主区是新建会话空态（不挂 ChatPage）。
    expect(await screen.findByText("开始新会话")).toBeInTheDocument();
  });

  it("顶栏存在；页面菜单只有一个真源、点「设置」切页", async () => {
    useUiStore.setState({ page: "home" });
    render(<App />);

    expect(await screen.findByTestId("topbar")).toBeInTheDocument();
    // 旧图标轨的入口也不应存在
    expect(screen.queryByRole("navigation", { name: "主导航" })).toBeNull();

    const trigger = screen.getByRole("button", { name: "打开页面菜单" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = await screen.findByRole("menu", { name: "页面菜单" });
    expect(menu).toBeInTheDocument();

    // 菜单项 = PALETTE_PAGES 的页面集合（未装插件页时恰好 8 项，文字就是页面名）。
    const labels = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent?.trim() ?? "");
    expect(labels.sort()).toEqual(
      ["主页", "团队", "会话", "插件", "协作", "知识库", "模型", "设置"].sort(),
    );
    // 当前页有 aria-current="page"
    expect(within(menu).getByRole("menuitem", { name: "主页" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    fireEvent.click(within(menu).getByRole("menuitem", { name: "设置" }));
    await waitFor(() => expect(useUiStore.getState().page).toBe("settings"));
    expect(await screen.findByRole("heading", { level: 1, name: "设置" })).toBeInTheDocument();
  });

  it("右侧动作区：命令面板入口仍在（aria-label 由导航轨的「全局搜索 Ctrl K」改为「打开命令面板」）", async () => {
    useUiStore.setState({ page: "home" });
    render(<App />);

    await screen.findByTestId("topbar");
    expect(screen.getByRole("button", { name: "打开命令面板" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "快捷键帮助" })).toBeInTheDocument();
  });

  it("会话侧栏常驻：h2「会话列表」+「新建会话」；点「新对话」进入会话页", async () => {
    useUiStore.setState({ page: "home" });
    render(<App />);

    await screen.findByTestId("topbar");
    // 空会话列表时 rail 顶部与空态各有一个「新建会话」，所以用 getAllByRole。
    expect(screen.getByRole("heading", { level: 2, name: "会话列表" })).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "新建会话" }).length,
    ).toBeGreaterThanOrEqual(1);

    // 页面上有两个「新对话」（侧栏 primary 按钮 + 主页空态引导按钮）：点击范围收进侧栏。
    const rail = screen
      .getByRole("heading", { level: 2, name: "会话列表" })
      .closest("aside") as HTMLElement;
    expect(rail).not.toBeNull();
    // 侧栏里也有两个同名入口（rail 顶部 + 空态），取第一个即可。
    fireEvent.click(within(rail).getAllByRole("button", { name: "新建会话" })[0]!);

    await waitFor(() =>
      expect(useChatStore.getState().openAgent).toHaveBeenCalledWith("system-assistant", {
        fresh: true,
      }),
    );
    await waitFor(() => expect(useUiStore.getState().page).toBe("chat"));
    expect(useUiStore.getState().activeConversationId).toBe("c9");
  });

  it("浏览器（无 window.heming）：TopBar 仍渲染且高度是 h-10，不是桌面标题栏", async () => {
    useUiStore.setState({ page: "home" });
    delete (window as unknown as Record<string, unknown>).heming;
    render(<App />);

    const topbar = await screen.findByTestId("topbar");
    expect(topbar).toBeInTheDocument();
    expect(topbar.className).toContain("h-10");
    expect(topbar.className).not.toContain("desktop-titlebar");
  });

  it("桌面（window.heming）：TopBar 根节点带 desktop-titlebar", async () => {
    useUiStore.setState({ page: "home" });
    (window as unknown as Record<string, unknown>).heming = { platform: "win32" };
    render(<App />);

    const topbar = await screen.findByTestId("topbar");
    expect(topbar.className).toContain("desktop-titlebar");
  });

  it("Ctrl/⌘+B 不再生效，也不写 heming.nav.mode.v1", async () => {
    useUiStore.setState({ page: "home" });
    render(<App />);
    await screen.findByTestId("topbar");

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(useUiStore.getState().page).toBe("home");
    expect(localStorage.getItem("heming.nav.mode.v1")).toBeNull();
    // 旧字段也不该被重新写出来
    expect("navMode" in useUiStore.getState()).toBe(false);

    fireEvent.keyDown(window, { key: "b", metaKey: true });
    expect(localStorage.getItem("heming.nav.mode.v1")).toBeNull();
    expect(useUiStore.getState().page).toBe("home");
  });

  it("Alt+8 仍切到会话页", async () => {
    useUiStore.setState({ page: "home" });
    render(<App />);
    await screen.findByTestId("topbar");

    fireEvent.keyDown(window, { key: "8", altKey: true });
    await waitFor(() => expect(useUiStore.getState().page).toBe("chat"));
  });
});
