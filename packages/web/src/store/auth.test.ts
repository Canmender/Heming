import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAuthStore } from "./auth.js";

describe("auth store", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    useAuthStore.setState({ token: null, user: null, status: "idle", error: null });
  });

  it("登录成功写入 token 与 user", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ token: "t1", user: { id: "u1", username: "alice", displayName: "爱丽丝" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await useAuthStore.getState().login("alice", "secret123");
    const s = useAuthStore.getState();
    expect(s.status).toBe("authed");
    expect(s.token).toBe("t1");
    expect(localStorage.getItem("heming.token")).toBe("t1");
  });

  it("登录失败置 error 且不写 token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid credentials" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await useAuthStore.getState().login("alice", "wrongpass");
    const s = useAuthStore.getState();
    expect(s.status).toBe("error");
    expect(s.error).toBe("invalid credentials");
    expect(localStorage.getItem("heming.token")).toBeNull();
  });

  it("updateProfile 成功：PUT /api/me 后用返回 User 更新 store.user", async () => {
    localStorage.setItem("heming.token", "t1");
    useAuthStore.setState({
      token: "t1",
      user: { id: "u1", username: "alice", displayName: "爱丽丝" },
      status: "authed",
      error: null,
    });
    const { setToken } = await import("../lib/api.js");
    setToken("t1");

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "u1",
          username: "alice",
          displayName: "新昵称",
          avatar: "data:image/png;base64,AAA",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await useAuthStore.getState().updateProfile("新昵称", "data:image/png;base64,AAA");

    const s = useAuthStore.getState();
    expect(s.user?.displayName).toBe("新昵称");
    expect(s.user?.avatar).toBe("data:image/png;base64,AAA");
    expect(s.status).toBe("authed"); // 资料更新不动登录状态
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/me");
    expect(init.method).toBe("PUT");
  });

  it("运行中请求 401（onUnauthorized 已注册）→ logout 清会话", async () => {
    // 模拟已登录会话
    localStorage.setItem("heming.token", "t1");
    useAuthStore.setState({
      token: "t1",
      user: { id: "u1", username: "alice", displayName: "爱丽丝" },
      status: "authed",
      error: null,
    });
    // token 在 api 模块内的缓存同步（api.ts 模块级 token 初始读 localStorage）
    const { setToken } = await import("../lib/api.js");
    setToken("t1");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    // restore 自身 catch 吞掉 ApiError；断言 onUnauthorized 注册的 logout 已清会话
    await useAuthStore.getState().restore();

    const s = useAuthStore.getState();
    expect(s.user).toBeNull();
    expect(s.token).toBeNull();
    expect(s.status).toBe("idle");
    expect(localStorage.getItem("heming.token")).toBeNull();
  });
});
