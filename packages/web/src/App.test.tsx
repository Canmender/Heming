import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App.js";
import { useAuthStore } from "./store/auth.js";
import { useUiStore } from "./store/ui.js";
import { setToken } from "./lib/api.js";

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
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "u1", username: "alice", displayName: "爱丽丝" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(<App />);

    expect(await screen.findByText("已登录")).toBeInTheDocument();
    expect(screen.getByText("合序 Heming")).toBeInTheDocument();
    expect(screen.getAllByText("主页").length).toBeGreaterThan(0);
    expect(screen.queryByText("登录你的账号")).not.toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/me");
    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer t1");
    expect(useAuthStore.getState().status).toBe("authed");
    expect(useAuthStore.getState().user?.username).toBe("alice");
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
