import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAuthStore } from "./auth.js";

describe("auth store", () => {
  beforeEach(() => {
    useAuthStore.getState().logout();
    localStorage.clear();
    vi.restoreAllMocks();
    useAuthStore.setState({ token: null, user: null, status: "idle", error: null, restoreError: null });
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
    // 不把服务端英文原文透传给用户（旧行为是显示 "invalid credentials"）
    expect(s.error).toBe("用户名或密码不正确");
    expect(localStorage.getItem("heming.token")).toBeNull();
  });

  it("登录失败文案按状态码翻译：429/5xx/网络异常各不相同", async () => {
    const { loginErrorMessage } = await import("./auth.js");
    const { ApiError } = await import("../lib/api.js");
    expect(loginErrorMessage(new ApiError(401, "invalid credentials"))).toBe("用户名或密码不正确");
    expect(loginErrorMessage(new ApiError(429, "too many"))).toBe("尝试次数过多，请稍后再试");
    expect(loginErrorMessage(new ApiError(503, "boom"))).toBe("服务器暂时不可用，请稍后重试");
    expect(loginErrorMessage(new ApiError(400, "bad"))).toBe("登录失败，请重试");
    expect(loginErrorMessage(new TypeError("Failed to fetch"))).toBe("连不上服务器，请检查网络后重试");
  });

  it("clearError：改输入即复位 error/status，未失败时不打扰", async () => {
    useAuthStore.setState({ status: "error", error: "用户名或密码不正确" });
    useAuthStore.getState().clearError();
    expect(useAuthStore.getState().error).toBeNull();
    expect(useAuthStore.getState().status).toBe("idle");

    useAuthStore.setState({ status: "authed", error: null });
    useAuthStore.getState().clearError();
    expect(useAuthStore.getState().status).toBe("authed");
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

  it("运行中请求 401（onUnauthorized 已注册）→ logout 清会话", async () => {    // 模拟已登录会话
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

  it("恢复时网络失败：保留 token 并自动重试，恢复后回到 authed", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("heming.token", "t1");
      const { setToken } = await import("../lib/api.js");
      setToken("t1");
      const alice = { id: "u1", username: "alice", displayName: "爱丽丝" };
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce(
          new Response(JSON.stringify(alice), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

      await useAuthStore.getState().restore();

      // 网络失败不是「登录失效」：token 必须留着，状态走重连面板
      expect(useAuthStore.getState().status).toBe("pending");
      expect(useAuthStore.getState().restoreError).toContain("网络异常");
      expect(localStorage.getItem("heming.token")).toBe("t1");

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(useAuthStore.getState().status).toBe("authed"));
      expect(useAuthStore.getState().user?.username).toBe("alice");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      useAuthStore.getState().logout();
      vi.useRealTimers();
    }
  });

  it("恢复时 5xx：同样保留 token，不当作登录失效", async () => {
    localStorage.setItem("heming.token", "t1");
    const { setToken } = await import("../lib/api.js");
    setToken("t1");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "bad gateway" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await useAuthStore.getState().restore();

    expect(useAuthStore.getState().status).toBe("pending");
    expect(useAuthStore.getState().restoreError).toBe("服务器暂时不可用，正在重试…");
    expect(localStorage.getItem("heming.token")).toBe("t1");
  });

  // 放在最后：resetModules 会重建模块注册表，放在前面会污染前面用例的动态 import
  it("模块初始 status：有 token → pending（刷新首帧显示加载中），无 token → idle", async () => {
    localStorage.setItem("heming.token", "t1");
    vi.resetModules();
    try {
      const withToken = await import("./auth.js");
      expect(withToken.useAuthStore.getState().status).toBe("pending");

      localStorage.removeItem("heming.token");
      vi.resetModules();
      const withoutToken = await import("./auth.js");
      expect(withoutToken.useAuthStore.getState().status).toBe("idle");
    } finally {
      vi.resetModules();
      localStorage.removeItem("heming.token");
    }
  });
});
