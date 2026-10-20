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
    expect(screen.getByPlaceholderText("密码")).toBeInTheDocument();
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
    fireEvent.change(screen.getByPlaceholderText("密码"), { target: { value: "secret123" } });
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
    fireEvent.change(screen.getByPlaceholderText("密码"), { target: { value: "wrongpass" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByText("invalid credentials")).toBeInTheDocument();
    const s = useAuthStore.getState();
    expect(s.status).toBe("error");
    expect(localStorage.getItem("heming.token")).toBeNull();
  });

  // ── 左右分栏（左卡右字样） ──

  it("根节点显式占满父容器宽度（w-full）：父容器是 row flex，缺它整页会塌到左侧", () => {
    const { container } = render(<LoginPage />);
    const root = container.firstElementChild as HTMLElement;

    // 防回归断言：LoginPage 的父容器（App.tsx 登录分支 <div class="flex min-h-0 flex-1">）
    // 是 row 方向的 flex 容器，根节点作为其 flex 子项默认 flex-basis:auto，
    // 宽度按 max-content 收缩 → 根节点若退回 shrink-to-fit，整页会塌到左侧、右半屏空白
    // （曾经发生过：1440 宽下登录页仅占 0..758）。jsdom 不做真实布局，只能断言 class 语义。
    expect(root.className).toContain("w-full");
    // min-width:auto 会让 flex 子项无法收缩到内容宽度以下，配 min-w-0 兜住窄窗口
    expect(root.className).toContain("min-w-0");
    // 同一节点必须保留宽屏分栏语义（否则 w-full 撑开的仍是一整条单栏）
    expect(root.className).toContain("min-[900px]:flex-row");
    // 窄屏基线仍是纵向单栏
    expect(root.className).toContain("flex-col");
  });

  it("宽屏左右分栏：两栏等宽，左栏放卡片、右栏放字样", () => {
    const { container } = render(<LoginPage />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("min-[900px]:flex-row");

    const cols = [...root.children] as HTMLElement[];
    expect(cols).toHaveLength(2);
    for (const c of cols) expect(c.className).toContain("flex-1");

    // 左栏是登录卡片，右栏是字样（不是反过来）
    expect(cols[0].querySelector("form")).not.toBeNull();
    expect(cols[0].querySelector('svg[aria-label="Heming"]')).toBeNull();
    expect(cols[1].querySelector('svg[aria-label="Heming"]')).not.toBeNull();
  });

  it("右栏字样窄屏隐藏（<900px 退化为单栏，避免两块都被挤扁）", () => {
    render(<LoginPage />);
    const svg = screen.getByRole("img", { name: "Heming" });
    const brandCol = svg.closest("div") as HTMLElement;
    expect(brandCol.className).toContain("hidden");
    expect(brandCol.className).toContain("min-[900px]:flex");
    expect(brandCol.className).toContain("items-center");
    expect(brandCol.className).toContain("justify-center");
  });

  it("卡片与字样都垂直居中（各自栏内）", () => {
    const { container } = render(<LoginPage />);
    const cols = [...(container.firstElementChild as HTMLElement).children] as HTMLElement[];
    for (const c of cols) {
      expect(c.className).toContain("items-center");
      expect(c.className).toContain("justify-center");
    }
  });

  it("卡片文案不变（标题「和鸣」+ 副标题仍在卡内）", () => {
    const { container } = render(<LoginPage />);
    const form = container.querySelector("form")!;
    expect(form.textContent).toContain("和鸣");
    expect(form.textContent).toContain("登录你的账号");
  });
});
