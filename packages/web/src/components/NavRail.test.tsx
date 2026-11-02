import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
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

  it("带快捷键徽标的图标按钮（aria-label = 名称 + 快捷键），其余页只有名称", () => {
    render(<NavRail />);
    for (const name of [
      "主页 Alt1",
      "团队看板 Alt2",
      "技能区 Alt3",
      "接口区 Alt4",
      "记忆区 Alt5",
      "设置区 Alt6",
      "通用智能体 Alt8",
      "插件区 Alt0",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    // 团队/智能体/幕僚/信息中枢/自动化不占数字键：只有名称
    for (const name of ["团队", "智能体", "幕僚", "信息中枢", "自动化"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
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

  it("底部头像点击先弹确认：取消不登出，确认才 logout；浮签不再写死「在线」", () => {
    render(<NavRail />);
    const avatar = screen.getByRole("button", { name: "账户：爱丽丝 · 退出登录" });
    expect(screen.getByText("爱丽丝 · 账户")).toBeInTheDocument(); // 悬停浮签（span）
    expect(screen.queryByText(/在线/)).not.toBeInTheDocument();
    expect(useAuthStore.getState().user).not.toBeNull();

    // 第一下只弹确认，不动登录态
    fireEvent.click(avatar);
    expect(useAuthStore.getState().user).not.toBeNull();
    const dialog = screen.getByRole("dialog", { name: "退出登录" });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "退出登录" })).not.toBeInTheDocument();
    expect(useAuthStore.getState().user).not.toBeNull();

    // 确认后才真正登出
    fireEvent.click(screen.getByRole("button", { name: "账户：爱丽丝 · 退出登录" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "退出登录" })).getByRole("button", { name: "退出登录" }),
    );
    const s = useAuthStore.getState();
    expect(s.user).toBeNull();
    expect(s.token).toBeNull();
    expect(localStorage.getItem("heming.token")).toBeNull();
  });

  it("搜索按钮：浮签带 Ctrl K，点按调用外部打开命令面板", () => {
    const onOpenSearch = vi.fn();
    render(<NavRail onOpenSearch={onOpenSearch} />);
    expect(screen.getByText("搜索")).toBeInTheDocument(); // 浮签名称
    expect(screen.getByText("Ctrl K")).toBeInTheDocument(); // 快捷键徽标
    fireEvent.click(screen.getByRole("button", { name: "全局搜索 Ctrl K" }));
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
  });

  it("快捷键帮助按钮：浮签带 ?，点按调用外部打开帮助面板（d.61 F 轨）", () => {
    const onOpenShortcuts = vi.fn();
    render(<NavRail onOpenSearch={vi.fn()} onOpenShortcuts={onOpenShortcuts} />);
    const btn = screen.getByRole("button", { name: "快捷键帮助" });
    expect(btn).toHaveAttribute("title", "快捷键");
    // 浮签：名称 + ? 徽标（按钮本身也写着 ?，所以这里用 getAllByText）
    expect(screen.getByText("快捷键")).toBeInTheDocument();
    expect(screen.getAllByText("?").length).toBeGreaterThanOrEqual(2);
    fireEvent.click(btn);
    expect(onOpenShortcuts).toHaveBeenCalledTimes(1);
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
    const btn = screen.getByRole("button", { name: "账户：爱丽丝 · 退出登录" });
    const img = btn.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("data:image/png;base64,AAA");
    expect(img!.className).toContain("rounded-full");
    expect(img!.className).toContain("object-cover");
    expect(screen.getByText("爱丽丝 · 账户")).toBeInTheDocument();
  });

  it("无 user.avatar 时底部按钮显示默认人形图标（不渲染 img）", () => {
    render(<NavRail />);
    const btn = screen.getByRole("button", { name: "账户：爱丽丝 · 退出登录" });
    expect(btn.querySelector("img")).toBeNull();
    expect(btn.querySelector("svg")).not.toBeNull();
  });

  it("图标列包在垂直居中容器内，头像在容器外", () => {
    render(<NavRail />);
    const nav = screen.getByLabelText("主导航");
    const items = [
      "主页 Alt1",
      "团队看板 Alt2",
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
    expect(wrapper.contains(screen.getByLabelText("账户：爱丽丝 · 退出登录"))).toBe(false);
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
      .filter((l): l is string => Boolean(l?.startsWith("主页") || l?.startsWith("团队看板") || l?.startsWith("技能区") || l?.startsWith("接口区") || l?.startsWith("记忆区") || l?.startsWith("设置区")));
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
    for (const name of ["主页", "团队", "智能体", "团队看板", "技能区", "接口区", "记忆区", "设置区", "信息中枢", "自动化"]) {
      expect(screen.getAllByRole("button", { name: new RegExp(name) }).length).toBeGreaterThan(0);
    }
  });
});

describe("全站键盘焦点环（③-2）", () => {
  afterEach(() => {
    document.getElementById("heming-focus-visible")?.remove();
  });

  it("导航轨挂载时注入 :focus-visible 规则（覆盖 outline-hidden 的控件）", () => {
    render(<NavRail />);
    const style = document.getElementById("heming-focus-visible");
    expect(style).not.toBeNull();
    expect(style!.textContent).toContain(":focus-visible");
    expect(style!.textContent).toContain("outline: 2px solid");
    // 只对键盘生效：不能用 :focus（鼠标点击也会出环）
    expect(style!.textContent).not.toMatch(/(^|[\s,{]):focus\s*\{/);
  });

  it("重复挂载不重复注入（幂等）", () => {
    const first = render(<NavRail />);
    render(<NavRail />);
    expect(document.querySelectorAll("#heming-focus-visible")).toHaveLength(1);
    first.unmount();
  });
});
