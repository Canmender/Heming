import { useEffect } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
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

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const alice = { id: "u1", username: "alice", displayName: "爱丽丝" };

/** 按 URL 分发：/api/me 返回用户，/api/files 返回共享文件列表，工作区/健康等返回空集合，其余 404。 */
function mockFetch(
  routes: {
    me?: unknown;
    files?: unknown;
    usage?: unknown;
    conversations?: unknown;
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
    if (url === "/api/conversations") return Promise.resolve(jsonRes(routes.conversations ?? []));
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

  it("有 token 但 fetchMe 失败：清 token 回到登录页", async () => {
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

  it("Alt+1–6 直接切页（含技能区），导航常驻；Ctrl+数字 不再切页", async () => {
    setToken("t1");
    mockFetch();
    render(<App />);
    await screen.findByRole("button", { name: "主页 Alt1" });

    fireEvent.keyDown(window, { key: "2", altKey: true });
    expect(useUiStore.getState().page).toBe("workspace");
    fireEvent.keyDown(window, { key: "3", altKey: true });
    expect(useUiStore.getState().page).toBe("skills");
    fireEvent.keyDown(window, { key: "5", altKey: true });
    expect(useUiStore.getState().page).toBe("memory");
    fireEvent.keyDown(window, { key: "6", altKey: true });
    expect(useUiStore.getState().page).toBe("settings");
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
    fireEvent.keyDown(probe, { key: "4", altKey: true });
    expect(useUiStore.getState().page).toBe("home");
    probe.remove();
    fireEvent.keyDown(window, { key: "4", altKey: true });
    expect(useUiStore.getState().page).toBe("interfaces");

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
