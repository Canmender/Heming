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
});
