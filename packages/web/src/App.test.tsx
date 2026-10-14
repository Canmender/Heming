import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { App } from "./App.js";
import { useAuthStore } from "./store/auth.js";
import { useUiStore } from "./store/ui.js";
import { setToken } from "./lib/api.js";

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
    conversations?: unknown;
    friends?: unknown;
    incoming?: unknown;
    messages?: unknown;
  } = {},
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url === "/api/me") return Promise.resolve(jsonRes(routes.me ?? alice));
    if (url === "/api/files") return Promise.resolve(jsonRes(routes.files ?? []));
    if (url === "/api/health") return Promise.resolve(jsonRes({ ok: true }));
    if (url === "/api/conversations") return Promise.resolve(jsonRes(routes.conversations ?? []));
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
    useUiStore.setState({ page: "home", navCollapsed: false, activeConversationId: null });
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
    expect(await screen.findByRole("button", { name: "主页 ⌘1" })).toBeInTheDocument();
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
    useUiStore.setState({ page: "home", navCollapsed: false, activeConversationId: null });
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

  it("未登录时不拉取文件列表", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(<App />);
    expect(screen.queryByRole("button", { name: "上传" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("上传失败（413）时 alert 提示且不刷新列表", async () => {
    setToken("t1");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/me") return Promise.resolve(jsonRes(alice));
      if (url === "/api/files" && init?.method === "POST")
        return Promise.resolve(jsonRes({ error: "payload too large" }, 413));
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
        expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("payload too large")),
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

describe("App 导航快捷键与隐藏态", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    setToken(null);
    useAuthStore.setState({ token: null, user: null, status: "idle", error: null });
    useUiStore.setState({ page: "home", navCollapsed: false, activeConversationId: null });
  });

  it("Ctrl+1–5 直接切页，Ctrl+\ 切换导航显隐", async () => {
    setToken("t1");
    mockFetch();
    render(<App />);
    await screen.findByRole("button", { name: "主页 ⌘1" });

    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    expect(useUiStore.getState().page).toBe("workspace");
    fireEvent.keyDown(window, { key: "4", ctrlKey: true });
    expect(useUiStore.getState().page).toBe("memory");
    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    expect(useUiStore.getState().page).toBe("home");

    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    expect(useUiStore.getState().navCollapsed).toBe(true);
    expect(await screen.findByRole("button", { name: "呼出导航" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "主导航" })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    expect(useUiStore.getState().navCollapsed).toBe(false);
    expect(await screen.findByRole("button", { name: "主页 ⌘1" })).toBeInTheDocument();
  });

  it("导航收起态（如进入会话后）左缘呼出提示可点击展开", async () => {
    setToken("t1");
    mockFetch();
    // 模拟 openConversation 后的状态（page/chat 由 store 测试覆盖，这里只验证壳的导航显隐）
    useUiStore.setState({ page: "home", navCollapsed: true, activeConversationId: null });
    render(<App />);

    await screen.findByRole("button", { name: "呼出导航" });
    expect(screen.queryByRole("navigation", { name: "主导航" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "呼出导航" }));
    expect(useUiStore.getState().navCollapsed).toBe(false);
    expect(await screen.findByRole("button", { name: "主页 ⌘1" })).toBeInTheDocument();
  });
});
