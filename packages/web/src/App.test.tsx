import { useEffect } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import { App } from "./App.js";
import { useAuthStore } from "./store/auth.js";
import { useUiStore } from "./store/ui.js";
import { setToken } from "./lib/api.js";

// 启动动画集成：BootWave 以「挂载即 onDone」桩替换，动画完成后 App 路由到登录页/主界面。
// 自动完成的 BootWave 桩让既有用例聚焦认证/右栏/导航行为；完整的门禁路由用例见 App.boot.test.tsx。
vi.mock("./lib/appPresence.js", () => ({ useAppPresence: () => undefined }));
vi.mock("./components/BootWave.js", () => ({
  BootWave: ({ onDone }: { onDone: () => void }) => {
    useEffect(() => { onDone(); }, [onDone]);
    return null;
  },
}));

// 命令面板打开时预取名册、首页拉取团队数据都走 fetchTeam（真实 api → mock fetch）。
// 桩掉 connectWs，避免 ChatPage 挂载时 jsdom 真去建 WebSocket。
vi.mock("./lib/ws.js", () => ({
  connectWs: vi.fn(() => ({ send: vi.fn(), close: vi.fn() })),
}));

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * d.67 T4：jsdom 的 `window.innerWidth` 默认 1024（窄窗），而本文件绝大多数用例
 * 验证的是**宽窗**既有行为（右侧 aside / 拖拽调宽）。这里统一把视口置 1280，
 * 窄窗用例自己再切到 1024；不断言任何真实像素布局，只驱动 useViewport 的断点判定。
 */
function setViewportWidth(width: number, dispatch = true): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  if (dispatch) window.dispatchEvent(new Event("resize"));
}

// 外层先清一次：网络失败用例会排自动重试定时器，避免跨用例泄漏
beforeEach(() => {
  useAuthStore.getState().logout();
  setViewportWidth(1280); // 既有用例按宽窗语义写：默认 1280，避免被 jsdom 的 1024 当成窄窗
});

afterEach(() => {
  setViewportWidth(1280, false); // 不派发 resize：此时组件可能还没被 RTL 卸载，避免 act 噪音
});

const alice = { id: "u1", username: "alice", displayName: "爱丽丝" };

/** 按 URL 分发：/api/me 返回用户，团队/朋友/会话等返回空集合，其余 404。 */
function mockFetch(
  routes: {
    me?: unknown;
    files?: unknown;
    usage?: unknown;
    team?: unknown;
    friends?: unknown;
    incoming?: unknown;
    messages?: unknown;
    agents?: unknown;
  } = {},
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url === "/api/me") return Promise.resolve(jsonRes(routes.me ?? alice));
    if (url === "/api/files/usage")
      return Promise.resolve(jsonRes(routes.usage ?? { used: 0, quota: 200 * 1024 * 1024 }));
    if (url === "/api/files") return Promise.resolve(jsonRes(routes.files ?? []));
    if (url === "/api/health") return Promise.resolve(jsonRes({ ok: true }));
    if (url === "/api/team")
      return Promise.resolve(jsonRes(routes.team ?? { members: [], onlineCount: 0 }));
    if (url === "/api/agents") return Promise.resolve(jsonRes(routes.agents ?? []));
    if (url === "/api/friends/requests") return Promise.resolve(jsonRes(routes.incoming ?? []));
    if (url === "/api/friends") return Promise.resolve(jsonRes(routes.friends ?? []));
    if (/^\/api\/conversations\/[^/]+\/messages$/.test(url))
      return Promise.resolve(jsonRes(routes.messages ?? []));
    return Promise.resolve(jsonRes({ error: "not found" }, 404));
  });
}

describe("App 认证门禁", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    setToken(null);
    useAuthStore.setState({ token: null, user: null, status: "idle", error: null });
    useUiStore.setState({ page: "home", activeConversationId: null });
  });

  it("无 token 渲染登录页而非三栏壳", () => {
    render(<App />);
    expect(screen.getByText("和鸣")).toBeInTheDocument();
    expect(screen.getByText("登录你的账号")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
    expect(screen.queryByText("已登录")).not.toBeInTheDocument();
  });

  it("有 token 且 fetchMe 成功：restore 后渲染顶栏壳", async () => {
    setToken("t1");
    const fetchMock = mockFetch();

    render(<App />);

    // 新外壳：顶栏常驻 + 常驻会话侧栏，原左侧图标导航轨已删除
    const topbar = await screen.findByTestId("topbar");
    expect(topbar).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "主导航" })).not.toBeInTheDocument();
    // 顶栏左侧换成手写「Heming」标志，不再有文字品牌 span
    expect(within(topbar).getByRole("img", { name: "Heming" })).toBeInTheDocument();
    expect(topbar.textContent).not.toContain("和鸣");
    expect(screen.queryByText("登录你的账号")).not.toBeInTheDocument();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/me");
    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer t1");
    expect(useAuthStore.getState().status).toBe("authed");
    expect(useAuthStore.getState().user?.username).toBe("alice");
  });

  it("有 token 但服务端返回 401：清 token 回到登录页", async () => {
    setToken("stale-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(<App />);

    expect(await screen.findByText("登录你的账号")).toBeInTheDocument();
    expect(screen.queryByText("已登录")).not.toBeInTheDocument();
    expect(localStorage.getItem("heming.token")).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("有 token 但网络失败：保留 token 显示重连面板，不回落登录页", async () => {
    setToken("keep-me");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    render(<App />);

    expect(await screen.findByText("登录状态已保留")).toBeInTheDocument();
    expect(screen.queryByText("登录你的账号")).not.toBeInTheDocument();
    // d.142：断连只留「状态 + 原因 + 行动」——「需要重新登录」这类解释句已删，
    // 否则它会和旁边的「立即重试」说同一件事。
    expect(screen.queryByText(/网络恢复后会自动重试/)).toBeNull();
    expect(screen.getByRole("button", { name: "立即重试" })).toBeInTheDocument();
    expect(localStorage.getItem("heming.token")).toBe("keep-me");
  });
});

describe("App 记忆区接线", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    setToken(null);
    useAuthStore.setState({ token: null, user: null, status: "idle", error: null });
    useUiStore.setState({ page: "home", activeConversationId: null });
  });

  it("page=memory 是已删除的旧页：兼容落到设置页，不再渲染记忆区", async () => {
    setToken("t1");
    mockFetch();
    useUiStore.setState({ page: "memory" });

    render(<App />);

    // 记忆页已删除（d.146.5）：记忆默认全开、后台运行；旧链接/旧会话视图落设置页。
    expect(await screen.findByRole("heading", { name: "设置" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "数据库" })).toBeNull();
    expect(screen.queryByText("占位页面")).not.toBeInTheDocument();
  });
});

describe("App 导航快捷键与隐藏态", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    setToken(null);
    useAuthStore.setState({ token: null, user: null, status: "idle", error: null });
    useUiStore.setState({ page: "home", activeConversationId: null });
  });

  it("Alt+数字直接切页（d.67 键位 2/5/6/8/0，空出来的 3/4/7/9 无动作），导航常驻；Ctrl/⌘+数字 不再切页", async () => {
    setToken("t1");
    mockFetch();
    render(<App />);
    await screen.findByTestId("topbar");

    fireEvent.keyDown(window, { key: "2", altKey: true });
    expect(useUiStore.getState().page).toBe("team");
    // 3/4 随技能区/接口区合并取消：没有承接页，按空键位处理（不切页）
    fireEvent.keyDown(window, { key: "3", altKey: true });
    fireEvent.keyDown(window, { key: "4", altKey: true });
    expect(useUiStore.getState().page).toBe("team");
    fireEvent.keyDown(window, { key: "5", altKey: true });
    expect(useUiStore.getState().page).toBe("collab");
    fireEvent.keyDown(window, { key: "6", altKey: true });
    expect(useUiStore.getState().page).toBe("settings");
    fireEvent.keyDown(window, { key: "8", altKey: true });
    expect(useUiStore.getState().page).toBe("chat");
    fireEvent.keyDown(window, { key: "0", altKey: true });
    expect(useUiStore.getState().page).toBe("plugins");

    // 去 IM 时「会话 Alt9」「归档 Alt7」一并取消：不在映射表里 → 不动当前页
    fireEvent.keyDown(window, { key: "7", altKey: true });
    fireEvent.keyDown(window, { key: "9", altKey: true });
    expect(useUiStore.getState().page).toBe("plugins");

    fireEvent.keyDown(window, { key: "1", altKey: true });
    expect(useUiStore.getState().page).toBe("home");

    // I5：旧的 Ctrl/⌘+数字 组合不再切页（避开浏览器/输入法冲突）
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    expect(useUiStore.getState().page).toBe("home");
    fireEvent.keyDown(window, { key: "3", metaKey: true });
    expect(useUiStore.getState().page).toBe("home");

    // 顶栏常驻：Ctrl+\ 不再折叠任何东西
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    expect(screen.getByTestId("topbar")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "主导航" })).not.toBeInTheDocument();
  });

  it("焦点在输入框 / 未登录时，Alt+数字 不切页", async () => {
    setToken("t1");
    mockFetch();
    const { container } = render(<App />);
    await screen.findByTestId("topbar");

    // 焦点在文本输入（右栏上传按钮无 input，用导航区外的窗口内 input 模拟）
    const probe = document.createElement("input");
    container.appendChild(probe);
    probe.focus();
    fireEvent.keyDown(probe, { key: "2", altKey: true });
    expect(useUiStore.getState().page).toBe("home");
    probe.remove();
    fireEvent.keyDown(window, { key: "2", altKey: true });
    expect(useUiStore.getState().page).toBe("team");
    // 合并后空出来的 4 是空键位：不切页、不报错
    fireEvent.keyDown(window, { key: "4", altKey: true });
    expect(useUiStore.getState().page).toBe("team");

    // 未登录：App 走登录页分支，快捷键静默不改 page
    act(() => {
      setToken(null);
      useAuthStore.setState({ token: null, user: null, status: "idle", error: null });
      useUiStore.setState({ page: "home" });
    });
    render(<App />);
    fireEvent.keyDown(window, { key: "2", altKey: true });
    expect(useUiStore.getState().page).toBe("home");
    expect(screen.getAllByText("登录你的账号").length).toBeGreaterThan(0);
  });

  it("模态弹窗开着时 Alt+N 不切页、Ctrl+K 不开面板，关掉后两者恢复", async () => {
    setToken("t1");
    mockFetch();
    render(<App />);
    await screen.findByTestId("topbar");

    // 账户菜单 → 退出登录，开一个真实模态（共享文件预览已随面板一起删除）
    fireEvent.click(screen.getByRole("button", { name: "账户：爱丽丝" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));
    const dialog = await screen.findByRole("dialog", { name: "退出登录" });
    expect(dialog).toBeInTheDocument();

    // inert 挡得住点击，挡不住挂在 window 上的 keydown：这里必须显式拦
    fireEvent.keyDown(window, { key: "5", altKey: true });
    expect(useUiStore.getState().page).toBe("home");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.queryByRole("dialog", { name: "命令面板" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "退出登录" })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "退出登录" })).not.toBeInTheDocument(),
    );
    fireEvent.keyDown(window, { key: "5", altKey: true });
    expect(useUiStore.getState().page).toBe("collab");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "命令面板" })).toBeInTheDocument();
  });

  it("输入框聚焦时：Alt+数字 仍被过滤，导航常驻不被键盘改动", async () => {
    setToken("t1");
    mockFetch();
    const { container } = render(<App />);
    await screen.findByTestId("topbar");

    const probe = document.createElement("input");
    container.appendChild(probe);
    probe.focus();

    // Alt+数字 在输入框内仍过滤（防与输入法/浏览器快捷键冲突）
    fireEvent.keyDown(probe, { key: "2", altKey: true });
    expect(useUiStore.getState().page).toBe("home");

    // 顶栏常驻：Ctrl+\ 不再折叠任何东西
    fireEvent.keyDown(probe, { key: "\\", ctrlKey: true });
    expect(screen.getByTestId("topbar")).toBeInTheDocument();
    probe.remove();
  });

  it("顶栏「打开命令面板」按钮打开命令面板；焦点在结果按钮上按 Esc 也能关闭", async () => {
    setToken("t1");
    mockFetch({
      team: {
        members: [
          {
            user: { id: "u2", username: "bob", displayName: "张三" },
            lastSeenAt: null,
            online: true,
          },
        ],
        onlineCount: 1,
      },
    });
    render(<App />);
    await screen.findByRole("button", { name: "打开命令面板" });

    fireEvent.click(screen.getByRole("button", { name: "打开命令面板" }));
    const dialog = await screen.findByRole("dialog", { name: "命令面板" });
    fireEvent.change(within(dialog).getByLabelText("搜索页面、动作与成员"), {
      target: { value: "张三" },
    });

    // 焦点不在输入框（在结果按钮上）：Esc 由面板容器接住
    const result = await within(dialog).findByRole("option", { name: "张三" });
    result.focus();
    fireEvent.keyDown(result, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "命令面板" })).not.toBeInTheDocument();
  });

  it("命令面板结果超过上限时提示「还有 N 条」", async () => {
    setToken("t1");
    const members = Array.from({ length: 12 }, (_, i) => ({
      user: { id: `ux${i}`, username: `ux${i}`, displayName: `候选${i}` },
      lastSeenAt: null,
      online: false,
    }));
    mockFetch({ team: { members, onlineCount: 0 } });
    render(<App />);
    await screen.findByRole("button", { name: "打开命令面板" });

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "命令面板" });
    fireEvent.change(within(dialog).getByLabelText("搜索页面、动作与成员"), {
      target: { value: "候选" },
    });
    // 成员最多展示 8 条 → 12 − 8 = 4
    expect(await within(dialog).findByText("还有 4 条")).toBeInTheDocument();
    expect(within(dialog).getAllByRole("option", { name: /^候选/ })).toHaveLength(8);
  });

  it("进入会话后顶栏与会话侧栏仍常驻（不再收起、不再有呼出条）", async () => {
    setToken("t1");
    mockFetch();
    render(<App />);
    await screen.findByTestId("topbar");

    // jsdom 未实现 scrollIntoView（ChatPage 滚到底部用），进入会话前补个空实现
    Element.prototype.scrollIntoView = vi.fn();
    act(() => {
      useUiStore.getState().openConversation("c1");
    });

    expect(useUiStore.getState().page).toBe("chat");
    expect(screen.getByTestId("topbar")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "会话列表" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "主导航" })).not.toBeInTheDocument();
  });
});

describe("App 桌面窗口标题栏", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    setToken(null);
    useAuthStore.setState({ token: null, user: null, status: "idle", error: null });
    useUiStore.setState({ page: "home", activeConversationId: null });
    delete (window as unknown as { heming?: unknown }).heming;
  });

  afterEach(() => {
    delete (window as unknown as { heming?: unknown }).heming;
  });

  it("桌面端（window.heming 存在）：顶栏带 desktop-titlebar 拖拽区", async () => {
    setToken("t1");
    mockFetch();
    (window as unknown as { heming: unknown }).heming = { platform: "win32" };

    render(<App />);
    const topbar = await screen.findByTestId("topbar");

    expect(topbar.className).toContain("desktop-titlebar");
  });

  it("桌面端：登录页顶部渲染拖拽带", () => {
    (window as unknown as { heming: unknown }).heming = { platform: "win32" };

    const { container } = render(<App />);

    expect(screen.getByText("登录你的账号")).toBeInTheDocument();
    expect(container.querySelector(".desktop-titlebar")).not.toBeNull();
  });

  it("浏览器端（无 window.heming）：顶栏仍渲染（h-10），但不带拖拽区", async () => {
    setToken("t1");
    mockFetch();

    render(<App />);
    const topbar = await screen.findByTestId("topbar");

    expect(topbar).toBeInTheDocument();
    expect(topbar.className).toContain("h-10");
    expect(document.querySelector(".desktop-titlebar")).toBeNull();
  });
});

describe("App 会话进度栏（默认隐藏，顶栏按钮开合）", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    delete (window as unknown as { heming?: unknown }).heming;
    setToken("t1");
    mockFetch();
    useAuthStore.setState({ token: "t1", user: null, status: "pending", error: null });
    useUiStore.setState({ page: "chat", activeConversationId: null });
  });

  it("默认 chat 页：顶栏有「会话进度」按钮，但面板不渲染", async () => {
    render(<App />);
    await screen.findByTestId("topbar");

    expect(screen.getByRole("button", { name: "会话进度" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "会话进度" })).not.toBeInTheDocument();
  });

  it("点顶栏按钮出现面板，再点收起", async () => {
    render(<App />);
    await screen.findByTestId("topbar");

    fireEvent.click(screen.getByRole("button", { name: "会话进度" }));
    const panel = await screen.findByRole("complementary", { name: "会话进度" });
    expect(
      within(panel).getByRole("heading", { level: 2, name: "这一轮还没有进度" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "会话进度" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "会话进度" })).not.toBeInTheDocument(),
    );
  });

  it("面板内「关闭会话进度」也能收起", async () => {
    render(<App />);
    await screen.findByTestId("topbar");

    fireEvent.click(screen.getByRole("button", { name: "会话进度" }));
    await screen.findByRole("complementary", { name: "会话进度" });

    fireEvent.click(screen.getByRole("button", { name: "关闭会话进度" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "会话进度" })).not.toBeInTheDocument(),
    );
  });

  it("离开 chat 自动关闭；其它页顶栏不再有「会话进度」按钮", async () => {
    render(<App />);
    await screen.findByTestId("topbar");

    fireEvent.click(screen.getByRole("button", { name: "会话进度" }));
    await screen.findByRole("complementary", { name: "会话进度" });

    act(() => {
      useUiStore.setState({ page: "home" });
    });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "会话进度" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "会话进度" })).not.toBeInTheDocument();

    // 回到会话页：按钮恢复，面板仍是关着的
    act(() => {
      useUiStore.setState({ page: "chat" });
    });
    expect(await screen.findByRole("button", { name: "会话进度" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "会话进度" })).not.toBeInTheDocument();
  });
});
