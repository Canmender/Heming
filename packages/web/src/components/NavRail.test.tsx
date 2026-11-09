import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, fireEvent, within } from "@testing-library/react";
import { NavRail } from "./NavRail.js";
import { useUiStore, DEFAULT_NAV_ORDER } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";
import { useModuleStore } from "../lib/modules/store.js";
import { DEFAULT_NAV_ORDER as NEW_DEFAULT } from "../store/ui.js";

describe("NavRail 图标轨（A 方案）", () => {
  beforeEach(() => {
    useModuleStore.getState().reset();
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

  it("带快捷键徽标的图标按钮（aria-label = 名称 + 快捷键），无数字键的页只有名称", () => {
    render(<NavRail />);
    for (const name of ["主页 Alt1", "团队 Alt2", "记忆 Alt5", "设置 Alt6", "智能体 Alt8", "插件 Alt0"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    // 知识库 / 模型不占数字键：只有名称
    for (const name of ["知识库", "模型"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("没装模块时导航只有 8 个宿主页：幕僚 / 信息中枢 / 自动化 / 工作流都不在轨上", () => {
    render(<NavRail />);
    for (const name of ["幕僚", "信息中枢", "自动化", "工作流", "模型路由"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("装上并启用模块后，导航里立刻出现入口（排在「插件」之后），停用后消失", () => {
    useModuleStore.getState().install("workflows");
    render(<NavRail />);
    const labels = screen
      .getAllByRole("button")
      .map((b) => (b.getAttribute("aria-label") || "").split(" ")[0])
      .filter((label) => ["插件", "工作流", "记忆"].includes(label));
    expect(labels).toEqual(["插件", "工作流", "记忆"]);

    // 停用（不是删除）→ 入口下线；重新启用 → 回来
    act(() => useModuleStore.getState().setEnabled("workflows", false));
    expect(screen.queryByRole("button", { name: "工作流" })).not.toBeInTheDocument();
    act(() => useModuleStore.getState().setEnabled("workflows", true));
    expect(screen.getByRole("button", { name: "工作流" })).toBeInTheDocument();

    // 删除 → 入口消失
    act(() => useModuleStore.getState().uninstall("workflows"));
    expect(screen.queryByRole("button", { name: "工作流" })).not.toBeInTheDocument();
  });

  it("点模块入口能切到对应页面（模块页不需要从插件卡绕）", () => {
    useModuleStore.getState().install("infohub");
    render(<NavRail />);
    fireEvent.click(screen.getByRole("button", { name: "信息中枢" }));
    expect(useUiStore.getState().page).toBe("infohub");
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

    fireEvent.click(screen.getByRole("button", { name: "插件 Alt0" }));
    expect(useUiStore.getState().page).toBe("plugins");

    const pluginsBtn = screen.getByRole("button", { name: "插件 Alt0" });
    expect(pluginsBtn.className).toContain("bg-ink");
    expect(pluginsBtn.className).toContain("text-white");
    expect(pluginsBtn).toHaveAttribute("aria-current", "page");
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
    const items = ["主页 Alt1", "团队 Alt2", "插件 Alt0", "记忆 Alt5", "设置 Alt6"].map((l) =>
      screen.getByLabelText(l),
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
      navOrder: ["settings", "home", "team", "chat", "plugins", "memory"],
    });
    render(<NavRail />);
    const labels = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"))
      .filter((l): l is string => Boolean(l?.startsWith("主页") || l?.startsWith("团队") || l?.startsWith("智能体") || l?.startsWith("插件") || l?.startsWith("记忆") || l?.startsWith("设置")));
    // 顺序跟着 store 走
    expect(labels[0]).toContain("设置");
    expect(labels[1]).toContain("主页");
    // 但 Alt 键位仍按页固定：设置永远是 Alt6、主页永远是 Alt1
    expect(labels[0]).toContain("Alt6");
    expect(labels[1]).toContain("Alt1");
  });

  it("存储里缺项时自动补齐，不漏渲染任何导航", () => {
    useUiStore.setState({ navOrder: ["memory", "home"] });
    render(<NavRail />);
    for (const name of ["主页", "团队", "智能体", "插件", "记忆", "知识库", "模型", "设置"]) {
      expect(screen.getAllByRole("button", { name: new RegExp(name) }).length).toBeGreaterThan(0);
    }
  });

  it("旧导航顺序里的已合并页（团队看板/技能区/接口区/通用智能体）折叠成宿主页，不重复渲染", () => {
    // 老用户的 localStorage 里可能还留着合并前的 13 项：读回时必须折叠、去重，
    // 否则导航轨会凭空多出几个点不开的入口。
    useUiStore.getState().setNavOrder([
      "settings",
      "workspace",
      "home",
      "skills",
      "tasks",
      "interfaces",
      "memory",
    ] as never);
    render(<NavRail />);
    expect(useUiStore.getState().navOrder).toEqual([
      "settings",
      "team",
      "home",
      "plugins",
      "chat",
      "memory",
      "vault",
      "model",
    ]);
    // 团队/插件/智能体各只出现一次
    for (const name of ["团队", "插件", "智能体"]) {
      expect(screen.getAllByRole("button", { name: new RegExp(`^${name}( |$)`) }).length).toBe(1);
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

/**
 * d.68 导航自动隐藏：pinned（默认常显）/ auto（左缘热区 + 浮层）。
 * 只断言结构与状态机，不断言像素；动效只允许动 transform/opacity 由源码守卫覆盖。
 */
describe("NavRail 导航自动隐藏（d.68）", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({
      page: "home",
      navOrder: [...DEFAULT_NAV_ORDER],
      navMode: "pinned",
      navOpen: false,
    });
    useAuthStore.setState({
      token: "t1",
      user: { id: "u1", username: "alice", displayName: "爱丽丝" },
      status: "authed",
      error: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("默认 pinned：常驻轨道参与布局，底部 pin 按钮切换到自动隐藏并落盘", () => {
    render(<NavRail />);
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(nav.className).toContain("shrink-0");
    expect(nav.className).not.toContain("absolute");

    const pin = screen.getByRole("button", { name: "自动隐藏导航栏" });
    expect(pin).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(pin);
    expect(useUiStore.getState().navMode).toBe("auto");
    expect(localStorage.getItem("heming.nav.mode.v1")).toBe("auto");
  });

  it("auto：8px 热区是可聚焦 button，浮层 absolute 不占布局宽度、收起时 aria-hidden", () => {
    useUiStore.setState({ navMode: "auto" });
    render(<NavRail />);

    const hot = screen.getByRole("button", { name: "展开导航" });
    expect(hot).toHaveAttribute("data-testid", "nav-hotzone");
    expect(hot.style.width).toBe("8px");
    expect(hot).toHaveAttribute("aria-expanded", "false");

    const nav = screen.getByLabelText("主导航");
    expect(nav.className).toContain("absolute");
    expect(nav.className).not.toContain("shrink-0");
    expect(nav).toHaveAttribute("aria-hidden", "true");
    expect(nav).toHaveAttribute("inert");

    // 悬停热区 → 展开（浮层滑入，不改变任何布局宽度）
    fireEvent.mouseEnter(hot);
    expect(useUiStore.getState().navOpen).toBe(true);
    expect(screen.getByLabelText("主导航")).toHaveAttribute("aria-hidden", "false");
    expect(screen.getByLabelText("主导航")).not.toHaveAttribute("inert");
    expect(screen.getByLabelText("主导航").className).toContain("translate-x-0");
    expect(hot).toHaveAttribute("aria-expanded", "true");
  });

  it("鼠标离开 300ms 后收回；不足 300ms 不收回", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    useUiStore.setState({ navMode: "auto" });
    render(<NavRail />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "展开导航" }));
    expect(useUiStore.getState().navOpen).toBe(true);

    fireEvent.mouseLeave(screen.getByLabelText("主导航"));
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(useUiStore.getState().navOpen).toBe(true); // 还没到点

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(useUiStore.getState().navOpen).toBe(false);
  });

  it("键盘焦点在导航内时，鼠标移开不收回（键盘用户不会被打断）", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    useUiStore.setState({ navMode: "auto" });
    render(<NavRail />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "展开导航" }));
    const nav = screen.getByLabelText("主导航");
    // 先有一次键盘交互，再聚焦：模拟「Tab 进导航」，不是鼠标点击留下的焦点
    fireEvent.keyDown(nav, { key: "Tab" });
    screen.getByLabelText("主页 Alt1").focus();

    fireEvent.mouseLeave(nav);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(useUiStore.getState().navOpen).toBe(true);
  });

  it("鼠标点击留下的焦点不会把浮层钉住：鼠标移开 300ms 后照样收回", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    useUiStore.setState({ navMode: "auto" });
    render(<NavRail />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "展开导航" }));
    const nav = screen.getByLabelText("主导航");
    // 只有 focus（无键盘交互）= 鼠标点击后的焦点状态（d.68 自检实测到的「浮层关不掉」）
    screen.getByLabelText("主页 Alt1").focus();
    fireEvent.mouseLeave(nav);
    act(() => {
      vi.advanceTimersByTime(320);
    });
    expect(useUiStore.getState().navOpen).toBe(false);
  });

  it("auto 模式下鼠标点击导航项：页面切换后浮层立即收起", () => {
    useUiStore.setState({ navMode: "auto" });
    render(<NavRail />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "展开导航" }));
    const item = screen.getByLabelText("记忆 Alt5");
    // 真实鼠标点击顺序：pointerdown（标记鼠标交互）→ click
    fireEvent.pointerDown(item);
    fireEvent.click(item);
    expect(useUiStore.getState().page).toBe("memory");
    expect(useUiStore.getState().navOpen).toBe(false);
  });

  it("Esc 收回浮层，并把焦点还给热区（不会立刻又被聚焦展开）", () => {
    useUiStore.setState({ navMode: "auto" });
    render(<NavRail />);

    const hot = screen.getByRole("button", { name: "展开导航" });
    fireEvent.mouseEnter(hot);
    expect(useUiStore.getState().navOpen).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(useUiStore.getState().navOpen).toBe(false);
    expect(hot).toHaveFocus();
    // 回焦热区不应再次触发 onFocus 展开
    expect(useUiStore.getState().navOpen).toBe(false);
  });

  it("auto 模式下点 pin 按钮回到常显：浮层收起、轨道重新参与布局", () => {
    useUiStore.setState({ navMode: "auto", navOpen: true });
    render(<NavRail />);

    fireEvent.click(screen.getByRole("button", { name: "固定导航栏" }));
    const s = useUiStore.getState();
    expect(s.navMode).toBe("pinned");
    expect(s.navOpen).toBe(false);
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(nav.className).toContain("shrink-0");
    expect(nav.className).not.toContain("absolute");
  });
});

describe("NavRail 分组（固定 8 项）", () => {
  beforeEach(() => {
    useModuleStore.getState().reset();
    useUiStore.setState({ page: "home", navOrder: [...NEW_DEFAULT] });
  });

  const PAGE_LABELS = ["主页", "团队", "智能体", "插件", "记忆", "知识库", "模型", "设置"];

  it("默认顺序：主页 / 团队 / 智能体 / 插件 / 记忆 / 知识库 / 模型 / 设置", () => {
    render(<NavRail />);
    const labels = screen
      .getAllByRole("button")
      .map((b) => (b.getAttribute("aria-label") || "").split(" ")[0])
      .filter((label) => PAGE_LABELS.includes(label));
    expect(labels).toEqual(PAGE_LABELS);
  });

  it("组间画 3 条细线：工作台 → 能力 → 资料 → 系统", () => {
    const { container } = render(<NavRail />);
    expect(container.querySelectorAll("[data-nav-group]")).toHaveLength(8);
    // 分隔线是 aria-hidden 的纯视觉元素，不参与读屏
    const lines = [...container.querySelectorAll("div[aria-hidden='true']")].filter((el) =>
      el.className.includes("h-px"),
    );
    expect(lines).toHaveLength(3);
  });
});
