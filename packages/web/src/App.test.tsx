import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

/** 按 URL 分发：/api/me 返回用户，/api/files 返回共享文件列表，其余 404。 */
function mockFetch(routes: { me?: unknown; files?: unknown } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url === "/api/me") return Promise.resolve(jsonRes(routes.me ?? alice));
    if (url === "/api/files") return Promise.resolve(jsonRes(routes.files ?? []));
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
    expect(screen.getByText("合序 Heming")).toBeInTheDocument();
    expect(screen.getByText("登录你的账号")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
    expect(screen.queryByText("已登录")).not.toBeInTheDocument();
  });

  it("有 token 且 fetchMe 成功：restore 后渲染三栏壳", async () => {
    setToken("t1");
    const fetchMock = mockFetch();

    render(<App />);

    expect(await screen.findByText("已登录")).toBeInTheDocument();
    expect(screen.getByText("合序 Heming")).toBeInTheDocument();
    expect(screen.getAllByText("主页").length).toBeGreaterThan(0);
    expect(screen.queryByText("登录你的账号")).not.toBeInTheDocument();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
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
});
