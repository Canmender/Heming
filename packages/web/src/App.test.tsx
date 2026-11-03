import { useEffect } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import { App, clampAsideWidth, ASIDE_MIN, ASIDE_MAX } from "./App.js";
import { useAuthStore } from "./store/auth.js";
import { useUiStore } from "./store/ui.js";
import { setToken, fetchFileBlobText } from "./lib/api.js";

// 启动动画集成：BootWave 以「挂载即 onDone」桩替换，动画完成后 App 路由到登录页/主界面。
// 自动完成的 BootWave 桩让既有用例聚焦认证/右栏/导航行为；完整的门禁路由用例见 App.boot.test.tsx。
vi.mock("./components/BootWave.js", () => ({
  BootWave: ({ onDone }: { onDone: () => void }) => {
    useEffect(() => { onDone(); }, [onDone]);
    return null;
  },
}));

// 预览接线用：文件内容取纯文本走独立函数（其余 api 保持真实实现）
vi.mock("./lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/api.js")>();
  return { ...actual, fetchFileBlobText: vi.fn() };
});

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

/** 按 URL 分发：/api/me 返回用户，/api/files 返回共享文件列表，工作区/健康等返回空集合，其余 404。 */
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

  it("有 token 且 fetchMe 成功：restore 后渲染三栏壳", async () => {
    setToken("t1");
    const fetchMock = mockFetch();

    render(<App />);

    // 导航 A 方案：壳以图标轨呈现（原「已登录」状态页脚已随展开文字栏移除，改查导航按钮）
    expect(await screen.findByRole("button", { name: "主页 Alt1" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
    expect(screen.getAllByText("主页").length).toBeGreaterThan(0); // 浮签名称文本
    expect(screen.getByRole("navigation", { name: "主导航" }).textContent).not.toMatch(
      /和鸣|Heming/,
    ); // 导航区不显示产品名
    expect(screen.queryByText("登录你的账号")).not.toBeInTheDocument();

    // v7 主页挂载后还会发起 /api/health 探测与工作区数据加载，硬计数改为按 URL 断言
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === "/api/files")).toBe(true),
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/me");
    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer t1");
    expect(useAuthStore.getState().status).toBe("authed");
    expect(useAuthStore.getState().user?.username).toBe("alice");

    const filesCall = fetchMock.mock.calls.find((c) => String(c[0]) === "/api/files");
    expect(filesCall).toBeTruthy();
    expect(((filesCall![1] as RequestInit).headers as Headers).get("Authorization")).toBe(
      "Bearer t1",
    );
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
    expect(screen.getByRole("button", { name: "立即重试" })).toBeInTheDocument();
    expect(localStorage.getItem("heming.token")).toBe("keep-me");
  });
});

describe("App 右栏云端共享", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    setToken(null);
    useAuthStore.setState({ token: null, user: null, status: "idle", error: null });
    useUiStore.setState({ page: "home", activeConversationId: null });
  });

  it("登录后拉取共享文件并渲染上传按钮与根级行", async () => {
    setToken("t1");
    mockFetch({
      files: [
        {
          id: "f1",
          owner: "alice",
          name: "需求草案.md",
          mime: "text/markdown",
          size: 18,
          updatedAt: "2026-10-13T00:00:00.000Z",
        },
      ],
    });

    render(<App />);

    const uploadBtn = await screen.findByRole("button", { name: "上传" });
    expect(uploadBtn).toBeInTheDocument();
    expect(await screen.findByText("需求草案.md")).toBeInTheDocument();
    expect(screen.getByText("云端共享")).toBeInTheDocument();
    // 根级行（无 parentId）直接显示，非文件夹行不带展开箭头
    expect(screen.queryByRole("button", { name: "切换文件夹 需求草案.md" })).not.toBeInTheDocument();
  });

  it("文件行点预览打开预览模态，点关闭消失（onPreview 接线）", async () => {
    setToken("t1");
    mockFetch({
      files: [
        {
          id: "f1",
          owner: "alice",
          name: "需求草案.md",
          mime: "text/markdown",
          size: 18,
          updatedAt: "2026-10-13T00:00:00.000Z",
        },
      ],
    });
    vi.mocked(fetchFileBlobText).mockResolvedValue("# 内容\n正文");

    render(<App />);

    fireEvent.click(await screen.findByLabelText("预览 需求草案.md"));
    expect(await screen.findByRole("heading", { name: "内容" })).toBeInTheDocument();
    expect(fetchFileBlobText).toHaveBeenCalledWith("f1");

    fireEvent.click(screen.getByLabelText("关闭预览"));
    expect(screen.queryByLabelText("关闭预览")).not.toBeInTheDocument();
  });

  it("右栏头部显示存储用量（fmtBytes：5.0MB / 200.0MB）", async () => {
    setToken("t1");
    mockFetch({
      usage: { used: 5 * 1024 * 1024, quota: 200 * 1024 * 1024 },
    });

    render(<App />);

    expect(await screen.findByText("5.0MB / 200.0MB")).toBeInTheDocument();
  });

  it("用量接口失败时静默不显示用量（不打断文件列表渲染）", async () => {
    setToken("t1");
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/me") return Promise.resolve(jsonRes(alice));
      if (url === "/api/files/usage")
        return Promise.resolve(jsonRes({ error: "boom" }, 500));
      if (url === "/api/files") return Promise.resolve(jsonRes([]));
      if (url === "/api/health") return Promise.resolve(jsonRes({ ok: true }));
      if (
        url === "/api/conversations" ||
        url === "/api/friends" ||
        url === "/api/friends/requests"
      )
        return Promise.resolve(jsonRes([]));
      return Promise.resolve(jsonRes({ error: "not found" }, 404));
    });

    render(<App />);

    expect(await screen.findByRole("button", { name: "上传" })).toBeInTheDocument();
    expect(screen.queryByText(/\/ 200MB$/)).not.toBeInTheDocument();
  });

  it("未登录时不拉取文件列表", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(<App />);
    expect(screen.queryByRole("button", { name: "上传" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("上传失败（413 非 JSON 体）时 alert 走 http 413 兜底且不刷新列表", async () => {
    setToken("t1");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/me") return Promise.resolve(jsonRes(alice));
      // 真实网关超限时多为纯文本体，res.json() 解析失败 → api.ts 兜底 `http ${status}`
      if (url === "/api/files" && init?.method === "POST")
        return Promise.resolve(new Response("Payload too large", { status: 413 }));
      if (url === "/api/files") return Promise.resolve(jsonRes([]));
      // HomePage 挂载时的 health/工作区探测，正常应答避免噪声告警
      if (url === "/api/health") return Promise.resolve(jsonRes({ ok: true }));
      if (
        url === "/api/conversations" ||
        url === "/api/friends" ||
        url === "/api/friends/requests"
      )
        return Promise.resolve(jsonRes([]));
      return Promise.resolve(jsonRes({ error: "not found" }, 404));
    });
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const origClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
      if (this.type !== "file") {
        origClick.call(this);
        return;
      }
      const file = new File(["hi"], "a.txt", { type: "text/plain" });
      // jsdom 的 Blob 未实现 arrayBuffer，补上以走真实上传路径（否则在读文件处就进 catch）
      Object.defineProperty(file, "arrayBuffer", {
        value: async () => new TextEncoder().encode("hi").buffer,
      });
      Object.defineProperty(this, "files", { value: [file], configurable: true });
      queueMicrotask(() => {
        void this.onchange?.(new Event("change"));
      });
    };
    try {
      render(<App />);
      const btn = await screen.findByRole("button", { name: "上传" });
      btn.click();
      await waitFor(() =>
        expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("http 413")),
      );
      expect(errSpy).toHaveBeenCalledWith("上传失败", expect.any(Error));
      // 失败后不触发 refreshFiles 的 GET（仅 restore 的 /api/me 与初始 GET /api/files）
      const getCalls = fetchMock.mock.calls.filter(
        (c) => String(c[0]) === "/api/files" && !(c[1] as RequestInit | undefined)?.method,
      );
      expect(getCalls).toHaveLength(1);
    } finally {
      HTMLInputElement.prototype.click = origClick;
    }
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

  it("page=memory 渲染记忆区（三分区 + 智能体选择器），不再落到占位页", async () => {
    setToken("t1");
    mockFetch({
      agents: [{ id: "a1", owner_id: "u1", name: "阿和", avatar: null, description: "" }],
    });
    useUiStore.setState({ page: "memory" });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "记忆区" })).toBeInTheDocument();
    for (const label of ["智能体", "数据库", "个人知识库"]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
    expect(await screen.findByRole("option", { name: "阿和" })).toBeInTheDocument();
    expect(screen.queryByText("占位页面")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "数据库" }));
    expect(screen.getByRole("group", { name: "语义记忆条目" })).toBeInTheDocument();
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
    await screen.findByRole("button", { name: "主页 Alt1" });

    fireEvent.keyDown(window, { key: "2", altKey: true });
    expect(useUiStore.getState().page).toBe("team");
    // 3/4 随技能区/接口区合并取消：没有承接页，按空键位处理（不切页）
    fireEvent.keyDown(window, { key: "3", altKey: true });
    fireEvent.keyDown(window, { key: "4", altKey: true });
    expect(useUiStore.getState().page).toBe("team");
    fireEvent.keyDown(window, { key: "5", altKey: true });
    expect(useUiStore.getState().page).toBe("memory");
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

    // 导航轨常驻：Ctrl+\ 不再折叠导航，主导航始终在
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "主页 Alt1" })).toBeInTheDocument();
  });

  it("焦点在输入框 / 未登录时，Alt+数字 不切页", async () => {
    setToken("t1");
    mockFetch();
    const { container } = render(<App />);
    await screen.findByRole("button", { name: "主页 Alt1" });

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
    mockFetch({
      files: [
        {
          id: "f1",
          owner: "alice",
          name: "需求草案.md",
          mime: "text/markdown",
          size: 18,
          updatedAt: "2026-10-13T00:00:00.000Z",
        },
      ],
    });
    vi.mocked(fetchFileBlobText).mockResolvedValue("# 内容\n正文");
    render(<App />);
    await screen.findByRole("button", { name: "主页 Alt1" });

    fireEvent.click(await screen.findByLabelText("预览 需求草案.md"));
    await screen.findByLabelText("关闭预览");

    // inert 挡得住点击，挡不住挂在 window 上的 keydown：这里必须显式拦
    fireEvent.keyDown(window, { key: "5", altKey: true });
    expect(useUiStore.getState().page).toBe("home");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.queryByRole("dialog", { name: "命令面板" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("关闭预览")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("关闭预览"));
    fireEvent.keyDown(window, { key: "5", altKey: true });
    expect(useUiStore.getState().page).toBe("memory");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "命令面板" })).toBeInTheDocument();
  });

  it("输入框聚焦时：Alt+数字 仍被过滤，导航常驻不被键盘改动", async () => {
    setToken("t1");
    mockFetch();
    const { container } = render(<App />);
    await screen.findByRole("button", { name: "主页 Alt1" });

    const probe = document.createElement("input");
    container.appendChild(probe);
    probe.focus();

    // Alt+数字 在输入框内仍过滤（防与输入法/浏览器快捷键冲突）
    fireEvent.keyDown(probe, { key: "2", altKey: true });
    expect(useUiStore.getState().page).toBe("home");

    // 导航常驻：Ctrl+\ 不再折叠，主导航仍在
    fireEvent.keyDown(probe, { key: "\\", ctrlKey: true });
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
    probe.remove();
  });

  it("导航轨搜索按钮打开命令面板；焦点在结果按钮上按 Esc 也能关闭", async () => {
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
    await screen.findByRole("button", { name: "全局搜索 Ctrl K" });

    fireEvent.click(screen.getByRole("button", { name: "全局搜索 Ctrl K" }));
    const dialog = await screen.findByRole("dialog", { name: "命令面板" });
    fireEvent.change(within(dialog).getByLabelText("搜索页面、动作与成员"), {
      target: { value: "张三" },
    });

    // 焦点不在输入框（在结果按钮上）：Esc 由面板容器接住
    const result = await within(dialog).findByRole("option", { name: "选择 张三" });
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
    await screen.findByRole("button", { name: "全局搜索 Ctrl K" });

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "命令面板" });
    fireEvent.change(within(dialog).getByLabelText("搜索页面、动作与成员"), {
      target: { value: "候选" },
    });
    // 成员最多展示 8 条 → 12 − 8 = 4
    expect(await within(dialog).findByText("还有 4 条")).toBeInTheDocument();
    expect(within(dialog).getAllByRole("option", { name: /^选择 候选/ })).toHaveLength(8);
  });

  it("进入会话后左侧导航仍常驻（不再收起、不再有呼出条）", async () => {
    setToken("t1");
    mockFetch();
    render(<App />);
    await screen.findByRole("button", { name: "主页 Alt1" });

    // jsdom 未实现 scrollIntoView（ChatPage 滚到底部用），进入会话前补个空实现
    Element.prototype.scrollIntoView = vi.fn();
    act(() => {
      useUiStore.getState().openConversation("c1");
    });

    expect(useUiStore.getState().page).toBe("chat");
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "呼出导航" })).not.toBeInTheDocument();
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

  it("桌面端（window.heming 存在）：主壳顶部渲染拖拽带", async () => {
    setToken("t1");
    mockFetch();
    (window as unknown as { heming: unknown }).heming = { platform: "win32" };

    const { container } = render(<App />);
    await screen.findByRole("button", { name: "主页 Alt1" });

    expect(container.querySelector(".desktop-titlebar")).not.toBeNull();
  });

  it("桌面端：登录页顶部渲染拖拽带", () => {
    (window as unknown as { heming: unknown }).heming = { platform: "win32" };

    const { container } = render(<App />);

    expect(screen.getByText("登录你的账号")).toBeInTheDocument();
    expect(container.querySelector(".desktop-titlebar")).not.toBeNull();
  });

  it("浏览器端（无 window.heming）：不渲染拖拽带，布局与原先一致", async () => {
    setToken("t1");
    mockFetch();

    const { container } = render(<App />);
    await screen.findByRole("button", { name: "主页 Alt1" });

    expect(container.querySelector(".desktop-titlebar")).toBeNull();
  });
});

describe("右侧工作目录栏：绑定按钮与拖动调宽", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    delete (window as unknown as { heming?: unknown }).heming;
    setToken("t1");
    mockFetch();
  });

  it("目录栏头部有「绑定」与「上传」两个入口", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "主页 Alt1" });
    expect(screen.getByRole("button", { name: "绑定本地文件到会话" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传" })).toBeInTheDocument();
  });

  it("没有打开会话时点绑定给出提示（不静默失败）", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<App />);
    await screen.findByRole("button", { name: "主页 Alt1" });
    fireEvent.click(screen.getByRole("button", { name: "绑定本地文件到会话" }));
    expect(alertSpy).toHaveBeenCalledWith("先打开一个会话，再绑定文件");
  });

  it("拖动手柄可改变目录栏宽度并落盘", async () => {
    const { container } = render(<App />);
    await screen.findByRole("button", { name: "主页 Alt1" });
    const handle = screen.getByRole("separator", { name: "调整目录栏宽度" });
    const aside = container.querySelector("aside.flex.shrink-0") as HTMLElement;

    // jsdom 不实现 PointerEvent（typeof undefined），fireEvent.pointerDown 造出的事件
    // React 认不出来、onPointerDown 不触发。这里用 MouseEvent 顶替——它同样带
    // clientX 且冒泡，足够驱动本组件的指针拖动逻辑（同 RadarContacts 测试的做法）。
    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, clientX: 0, button: 0 }));
    fireEvent(window, new MouseEvent("pointermove", { bubbles: true, clientX: 80 }));
    expect(aside.style.width).toBe("320px"); // 默认 240 + 拖动 80
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));

    // 松手后宽度落盘，下次启动沿用
    expect(localStorage.getItem("heming.asideWidth.v1")).toBe("320");
  });

  it("clampAsideWidth：夹在上下限之间，非法值回落默认", () => {
    expect(clampAsideWidth(100)).toBe(ASIDE_MIN);
    expect(clampAsideWidth(9999)).toBe(ASIDE_MAX);
    expect(clampAsideWidth(Number.NaN)).toBe(240);
    expect(clampAsideWidth(300)).toBe(300);
  });
});

/**
 * d.67 T4 · 窄窗（<1200）响应式：右侧共享文件栏默认不渲染，改由顶部按钮打开覆盖层抽屉。
 *
 * 只验证交互契约（不验证像素）：无 aside 列 / 有入口 / 抽屉 aria-modal + 遮罩 / Esc 与焦点归还 /
 * 拖宽后恢复宽窗 aside。宽窗既有可拖拽 aside 的用例在上一组，保持原断言不变。
 */
describe("App 窄窗响应式：共享文件改抽屉", () => {
  const draftFile = {
    id: "f1",
    owner: "alice",
    name: "需求草案.md",
    mime: "text/markdown",
    size: 18,
    updatedAt: "2026-10-13T00:00:00.000Z",
  };

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    delete (window as unknown as { heming?: unknown }).heming;
    setToken("t1");
    useAuthStore.setState({ token: "t1", user: alice, status: "authed", error: null });
    useUiStore.setState({ page: "home", activeConversationId: null });
    mockFetch({ files: [draftFile] });
    setViewportWidth(1024); // 窄窗：<1200
  });

  afterEach(() => {
    setViewportWidth(1280);
  });

  it("窄窗默认不渲染 aside 列，但顶部有「共享文件」入口（aria-expanded=false）", async () => {
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "打开共享文件" });

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "调整目录栏宽度" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("点入口打开覆盖层抽屉：role=dialog + aria-modal + 遮罩，内容与宽窗同一份", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "打开共享文件" }));

    const dialog = await screen.findByRole("dialog", { name: "共享文件" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("shared-files-backdrop")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开共享文件" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    // 抽屉里是真实的 aside 内容组件（表头入口 + FileTree 行），不是另复制一份
    expect(within(dialog).getByRole("button", { name: "绑定本地文件到会话" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "上传" })).toBeInTheDocument();
    expect(within(dialog).getByText("需求草案.md")).toBeInTheDocument();
  });

  it("Esc 关闭抽屉，关闭后焦点回到触发按钮", async () => {
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "打开共享文件" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "共享文件" });
    // 打开即把焦点移进面板（模态契约）
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("点遮罩也能关闭抽屉", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "打开共享文件" }));
    await screen.findByRole("dialog", { name: "共享文件" });

    fireEvent.click(screen.getByTestId("shared-files-backdrop"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("从窄窗拖宽到 ≥1200：抽屉自动收起，恢复可拖拽 aside 与宽度记忆", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "打开共享文件" }));
    await screen.findByRole("dialog", { name: "共享文件" });

    act(() => setViewportWidth(1280));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "打开共享文件" })).not.toBeInTheDocument();
    const handle = screen.getByRole("separator", { name: "调整目录栏宽度" });
    expect(handle).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "绑定本地文件到会话" })).toBeInTheDocument();
  });

  it("窄窗切到宽页面（settings）时主内容列仍是 min-w-0/overflow-hidden，不横向撑破", async () => {
    useUiStore.setState({ page: "settings" });
    const { container } = render(<App />);
    await screen.findByRole("button", { name: "打开共享文件" });

    const main = container.querySelector("main");
    expect(main?.className).toContain("min-w-0");
    expect(main?.className).toContain("overflow-hidden");
    // aside 列不存在，唯一横向占位是导航轨 + 主列
    expect(container.querySelectorAll("aside").length).toBe(0);
  });
});
