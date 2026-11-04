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

    expect(await screen.findByText("用户名或密码不正确")).toBeInTheDocument();
    const s = useAuthStore.getState();
    expect(s.status).toBe("error");
    expect(localStorage.getItem("heming.token")).toBeNull();
  });

  it("改输入即清掉上一次的失败提示（错误不追着用户走、aria-invalid 复位）", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid credentials" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByText("用户名或密码不正确")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "wrong2" } });
    expect(screen.queryByText("用户名或密码不正确")).not.toBeInTheDocument();
    expect(screen.getByLabelText("密码")).not.toHaveAttribute("aria-invalid");
    expect(useAuthStore.getState().status).toBe("idle");
  });

  it("登录页说明账号来源（没有注册入口时不把新用户晾在原地）", () => {
    render(<LoginPage />);
    expect(screen.getByText(/账号由团队管理员开通/)).toBeInTheDocument();
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

describe("LoginPage 无障碍（③-2）", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    setToken(null);
    useAuthStore.setState({ token: null, user: null, status: "idle", error: null });
  });

  it("字段有可访问名（不依赖 placeholder 当标签）", () => {
    render(<LoginPage />);
    expect(screen.getByLabelText("用户名")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("密码")).toHaveAttribute("autocomplete", "current-password");
  });

  it("登录失败：错误行 role=alert，输入框 aria-invalid + aria-describedby 指向它", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid credentials" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("id", "login-error");
    expect(alert).toHaveTextContent("用户名或密码不正确");
    for (const field of [screen.getByLabelText("用户名"), screen.getByLabelText("密码")]) {
      expect(field).toHaveAttribute("aria-invalid", "true");
    }
    // 用户名只关联错误行；密码还要关联常驻的大写锁定 live region
    expect(screen.getByLabelText("用户名")).toHaveAttribute("aria-describedby", "login-error");
    expect(screen.getByLabelText("密码")).toHaveAttribute(
      "aria-describedby",
      "login-error login-capslock",
    );
  });

  it("输入框与提交按钮带可见焦点环（键盘 Tab 能看到）", () => {
    render(<LoginPage />);
    expect(screen.getByLabelText("用户名").className).toContain("focus-visible:outline-2");
    expect(screen.getByLabelText("密码").className).toContain("focus-visible:outline-2");
    expect(screen.getByRole("button", { name: "登录" }).className).toContain(
      "focus-visible:outline-2",
    );
  });
});

describe("LoginPage · 输入辅助", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    setToken(null);
    useAuthStore.setState({ token: null, user: null, status: "idle", error: null });
  });

  it("大写锁定开启时提示出现，并通过 aria-describedby 挂在密码框上", () => {
    render(<LoginPage />);
    const pwd = screen.getByLabelText("密码");
    expect(pwd).toHaveAttribute("aria-describedby", "login-capslock");
    // jsdom 的 KeyboardEvent 不会真的带修饰键状态：直接覆写 getModifierState 模拟 CapsLock
    const capsEvent = (on: boolean) => {
      const ev = new KeyboardEvent("keydown", { key: "a", bubbles: true });
      Object.defineProperty(ev, "getModifierState", { value: () => on });
      return ev;
    };
    fireEvent(pwd, capsEvent(true));
    expect(screen.getByText("大写锁定已开启")).toBeInTheDocument();
    fireEvent(pwd, capsEvent(false));
    // 关灯后换成 sr-only 常驻容器，文字清空（live region 不重建）
    expect(screen.queryByText("大写锁定已开启")).not.toBeInTheDocument();
    expect(document.getElementById("login-capslock")).toHaveClass("sr-only");
  });

  it("打开页面时焦点落在用户名（焦点无处可去时）", async () => {
    render(<LoginPage />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("用户名")));
  });

  it("已经有别处焦点时不抢焦点", async () => {
    render(<LoginPage />);
    const submit = screen.getByRole("button", { name: "登录" });
    submit.focus();
    // 等一帧，确认 rAF 里的 guard 不会把焦点夺回用户名
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).toBe(submit);
  });
});
