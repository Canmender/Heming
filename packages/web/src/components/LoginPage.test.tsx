import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LoginPage } from "./LoginPage.js";
import { useAuthStore } from "../store/auth.js";
import { setToken } from "../lib/api.js";

describe("LoginPage", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    setToken(null);
    useAuthStore.setState({ token: null, user: null, status: "idle", error: null });
  });

  it("渲染登录表单（标题与用户名/密码占位文案）", () => {
    render(<LoginPage />);
    expect(screen.getByText("和鸣")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("用户名")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("密码（至少 6 位）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
    expect(screen.getByText("登录你的账号")).toBeInTheDocument();
  });

  it("仅登录：不渲染注册切换按钮与昵称输入（服务端注册默认 403）", () => {
    render(<LoginPage />);
    expect(screen.queryByRole("button", { name: "没有账号？注册" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "注册" })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("昵称")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "已有账号？登录" })).not.toBeInTheDocument();
  });

  it("提交调用 login：fetch 收到正确 body，成功后 store authed 并持久化 token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ token: "t1", user: { id: "u1", username: "alice", displayName: "爱丽丝" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText("用户名"), { target: { value: "alice" } });
    fireEvent.change(screen.getByPlaceholderText("密码（至少 6 位）"), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => expect(useAuthStore.getState().status).toBe("authed"));
    const s = useAuthStore.getState();
    expect(s.token).toBe("t1");
    expect(s.user?.username).toBe("alice");
    expect(localStorage.getItem("heming.token")).toBe("t1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(init.body).toBe(JSON.stringify({ username: "alice", password: "secret123" }));
  });

  it("登录失败显示错误文案、store 置 error 且不写 token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid credentials" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText("用户名"), { target: { value: "alice" } });
    fireEvent.change(screen.getByPlaceholderText("密码（至少 6 位）"), { target: { value: "wrongpass" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByText("invalid credentials")).toBeInTheDocument();
    const s = useAuthStore.getState();
    expect(s.status).toBe("error");
    expect(localStorage.getItem("heming.token")).toBeNull();
  });
});
