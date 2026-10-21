import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NavRail } from "./NavRail.js";
import { useUiStore, DEFAULT_NAV_ORDER } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";

describe("NavRail 图标轨（A 方案）", () => {
  beforeEach(() => {
    useUiStore.setState({ page: "home", activeConversationId: null });
    // 角标用例注入未读会话：逐例清零，避免泄漏到「无角标」断言
    useChatStore.setState({ conversations: [] });
    useAuthStore.setState({
      token: "t1",
      user: { id: "u1", username: "alice", displayName: "爱丽丝" },
      status: "authed",
      error: null,
    });
  });

  it("渲染 6 个带快捷键徽标的图标按钮（aria-label = 名称 + 快捷键）", () => {
    render(<NavRail />);
    for (const name of [
      "主页 Alt1",
      "工作区 Alt2",
      "技能区 Alt3",
      "接口区 Alt4",
      "记忆区 Alt5",
      "设置区 Alt6",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("工作区按钮角标 = 会话未读总和，aria-label 追加「N 条未读」", () => {
    useChatStore.setState({
      conversations: [
        {
          id: "c1",
          type: "direct",
          peer: { id: "u9", username: "bob", displayName: "鲍勃" },
          unreadCount: 2,
        },
        { id: "g1", type: "group", name: "评审组", memberCount: 3, unreadCount: 5 },
      ],
    });
    render(<NavRail />);

    const btn = screen.getByRole("button", { name: "工作区 Alt2 7 条未读" });
    const badge = btn.querySelector("span.bg-ink") as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe("7");
    expect(badge.className).toContain("text-white");
    // 其余按钮不受全局未读总和影响
    expect(screen.getByRole("button", { name: "主页 Alt1" })).toBeInTheDocument();
  });

  it("无未读时工作区按钮无角标、aria-label 不带未读文案", () => {
    useChatStore.setState({
      conversations: [{ id: "c1", type: "direct", peer: { id: "u9", username: "bob", displayName: "鲍勃" }, unreadCount: 0 }],
    });
    render(<NavRail />);

    const btn = screen.getByRole("button", { name: "工作区 Alt2" });
    expect(btn.querySelector("span.bg-ink")).toBeNull();
  });

  it("导航区不出现产品名文字（A 方案无品牌位）", () => {
    render(<NavRail />);
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(nav.textContent).not.toMatch(/和鸣|Heming/);
  });

  it("点击切页，选中项为 ink 底反白并标记 aria-current", () => {
    render(<NavRail />);
    const homeBtn = screen.getByRole("button", { name: "主页 Alt1" });
    expect(homeBtn.className).toContain("bg-ink");
    expect(homeBtn.className).toContain("text-white");
    expect(homeBtn).toHaveAttribute("aria-current", "page");

    fireEvent.click(screen.getByRole("button", { name: "接口区 Alt4" }));
    expect(useUiStore.getState().page).toBe("interfaces");

    const intfBtn = screen.getByRole("button", { name: "接口区 Alt4" });
    expect(intfBtn.className).toContain("bg-ink");
    expect(intfBtn.className).toContain("text-white");
    expect(intfBtn).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "主页 Alt1" }).className).not.toContain("bg-ink");
    expect(screen.getByRole("button", { name: "主页 Alt1" })).not.toHaveAttribute("aria-current");
  });

  it("悬停浮签内容常驻 DOM（名称 + 快捷键徽标，opacity 0 → group-hover 淡入）", () => {
    render(<NavRail />);
    const name = screen.getByText("主页"); // 浮签里的名称文本，供测试查询
    expect(screen.getByText("Alt1")).toBeInTheDocument(); // 快捷键徽标
    const tip = name.parentElement as HTMLElement;
    expect(tip.className).toContain("opacity-0");
    expect(tip.className).toContain("group-hover:opacity-100");
    expect(tip.className).toContain("duration-150");
    expect(tip.className).toContain("translate-x-1");
  });

  it("底部头像 aria-label 为「退出登录」，点击调 logout，浮签仍显示在线状态", () => {
    render(<NavRail />);
    const avatar = screen.getByRole("button", { name: "退出登录" });
    expect(screen.getByText("爱丽丝 · 在线")).toBeInTheDocument(); // 悬停浮签（span）
    expect(useAuthStore.getState().user).not.toBeNull();

    fireEvent.click(avatar);
    const s = useAuthStore.getState();
    expect(s.user).toBeNull();
    expect(s.token).toBeNull();
    expect(localStorage.getItem("heming.token")).toBeNull();
  });

  it("有 user.avatar 时底部按钮渲染 <img>（圆形裁剪，src 为 data URL）", () => {
    useAuthStore.setState({
      user: {
        id: "u1",
        username: "alice",
        displayName: "爱丽丝",
        avatar: "data:image/png;base64,AAA",
      },
    });
    render(<NavRail />);
    const btn = screen.getByRole("button", { name: "退出登录" });
    const img = btn.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("data:image/png;base64,AAA");
    expect(img!.className).toContain("rounded-full");
    expect(img!.className).toContain("object-cover");
    expect(screen.getByText("爱丽丝 · 在线")).toBeInTheDocument();
  });

  it("无 user.avatar 时底部按钮显示默认人形图标（不渲染 img）", () => {
    render(<NavRail />);
    const btn = screen.getByRole("button", { name: "退出登录" });
    expect(btn.querySelector("img")).toBeNull();
    expect(btn.querySelector("svg")).not.toBeNull();
  });

  it("图标列包在垂直居中容器内，头像在容器外", () => {
    render(<NavRail />);
    const nav = screen.getByLabelText("主导航");
    const items = [
      "主页 Alt1",
      "工作区 Alt2",
      "技能区 Alt3",
      "接口区 Alt4",
      "记忆区 Alt5",
      "设置区 Alt6",
    ].map(
      (l) => screen.getByLabelText(l),
    );
    const wrapper = items[0].closest("div")!.parentElement!;
    expect(wrapper.className).toContain("flex-1");
    expect(wrapper.className).toContain("justify-center");
    for (const b of items) expect(wrapper.contains(b)).toBe(true);
    expect(wrapper.contains(screen.getByLabelText("退出登录"))).toBe(false);
    expect(nav.contains(wrapper)).toBe(true);
  });
});


describe("NavRail 导航顺序可自定义", () => {
  beforeEach(() => {
    useUiStore.setState({ page: "home", navOrder: [...DEFAULT_NAV_ORDER] });
  });

  it("按 store.navOrder 渲染，且快捷键徽标仍绑页本身", () => {
    useUiStore.setState({
      navOrder: ["settings", "home", "workspace", "skills", "interfaces", "memory"],
    });
    render(<NavRail />);
    const labels = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"))
      .filter((l): l is string => Boolean(l?.startsWith("主页") || l?.startsWith("工作区") || l?.startsWith("技能区") || l?.startsWith("接口区") || l?.startsWith("记忆区") || l?.startsWith("设置区")));
    // 顺序跟着 store 走
    expect(labels[0]).toContain("设置区");
    expect(labels[1]).toContain("主页");
    // 但 Alt 键位仍按页固定：设置区永远是 Alt6、主页永远是 Alt1
    expect(labels[0]).toContain("Alt6");
    expect(labels[1]).toContain("Alt1");
  });

  it("存储里缺项时自动补齐，不漏渲染任何导航", () => {
    useUiStore.setState({ navOrder: ["memory", "home", "workspace", "skills", "interfaces"] });
    render(<NavRail />);
    for (const name of ["主页", "工作区", "技能区", "接口区", "记忆区", "设置区"]) {
      expect(screen.getAllByRole("button", { name: new RegExp(name) }).length).toBeGreaterThan(0);
    }
  });
});
