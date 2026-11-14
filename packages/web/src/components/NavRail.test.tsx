import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, fireEvent, within } from "@testing-library/react";
import { NavRail } from "./NavRail.js";
import { useUiStore, DEFAULT_NAV_ORDER } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";
import { DEFAULT_NAV_ORDER as NEW_DEFAULT } from "../store/ui.js";

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

  it("图标按钮的可访问名只有页名，快捷键走 aria-keyshortcuts（不再把 AltN 拼进名字）", () => {
    render(<NavRail />);
    for (const [label, key] of [
      ["主页", "Alt+1"],
      ["团队", "Alt+2"],
      ["记忆", "Alt+5"],
      ["设置", "Alt+6"],
      ["会话", "Alt+8"],
      ["插件", "Alt+0"],
    ] as const) {
      const btn = screen.getByRole("button", { name: label });
      expect(btn).toHaveAttribute("aria-keyshortcuts", key);
    }
    // 知识库 / 模型不占数字键：只有名称，也没有 aria-keyshortcuts
    for (const name of ["知识库", "模型"]) {
      const btn = screen.getByRole("button", { name });
      expect(btn).not.toHaveAttribute("aria-keyshortcuts");
    }
  });

  it("宿主导航只有 8 个固定页：旧模块页不会再出现在轨上", () => {
    render(<NavRail />);
    for (const name of ["幕僚", "信息中枢", "自动化", "工作流", "模型路由"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("导航区不出现产品名文字（A 方案无品牌位）", () => {
    render(<NavRail />);
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(nav.textContent).not.toMatch(/和鸣|Heming/);
  });

  it("点击切页，选中项为 ink 底反白并标记 aria-current", () => {
    render(<NavRail />);
    const homeBtn = screen.getByRole("button", { name: "主页" });
    expect(homeBtn.className).toContain("bg-ink");
    expect(homeBtn.className).toContain("text-white");
    expect(homeBtn).toHaveAttribute("aria-current", "page");

    fireEvent.click(screen.getByRole("button", { name: "插件" }));
    expect(useUiStore.getState().page).toBe("plugins");

    const pluginsBtn = screen.getByRole("button", { name: "插件" });
    expect(pluginsBtn.className).toContain("bg-ink");
    expect(pluginsBtn.className).toContain("text-white");
    expect(pluginsBtn).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "主页" }).className).not.toContain("bg-ink");
    expect(screen.getByRole("button", { name: "主页" })).not.toHaveAttribute("aria-current");
  });

  it("悬停浮签内容常驻 DOM（名称 + 快捷键徽标，opacity 0 → group-hover 淡入）", () => {
    render(<NavRail />);
    const name = screen.getByText("主页"); // 浮签里的名称文本，供测试查询
    expect(screen.getByText("Alt 1")).toBeInTheDocument(); // 快捷键徽标（与帮助面板同写法）
    const tip = name.parentElement as HTMLElement;
    expect(tip.className).toContain("opacity-0");
    expect(tip.className).toContain("group-hover:opacity-100");
    expect(tip.className).toContain("duration-fast");
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
    // 浮签：名称 + ? 徽标；按钮本体是键盘图标（P2-G1：不再用「?」文字冒充图标）
    expect(screen.getByText("快捷键")).toBeInTheDocument();
    expect(screen.getAllByText("?").length).toBeGreaterThanOrEqual(1);
    expect(btn.querySelector("svg")).not.toBeNull();
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
    const items = ["主页", "团队", "插件", "记忆", "设置"].map((l) =>
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


describe("NavRail 导航顺序固定（d.123：不可自定义）", () => {
  beforeEach(() => {
    useUiStore.setState({ page: "home", navOrder: [...DEFAULT_NAV_ORDER] });
  });

  it("始终按固定顺序渲染 8 项：主页 / 团队 / 会话 / 插件 / 记忆 / 知识库 / 模型 / 设置", () => {
    render(<NavRail />);
    const labels = screen
      .getAllByRole("button")
      .map((b) => (b.getAttribute("aria-label") || "").split(" ")[0])
      .filter((label) => ["主页", "团队", "会话", "插件", "记忆", "知识库", "模型", "设置"].includes(label));
    expect(labels).toEqual(["主页", "团队", "会话", "插件", "记忆", "知识库", "模型", "设置"]);
    // 数字键仍绑页本身
    expect(screen.getByRole("button", { name: "主页" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
  });

  it("存储里残留自定义顺序/旧页 id 时不生效，导航仍是固定 8 项且不重复", () => {
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
    const labels = screen
      .getAllByRole("button")
      .map((b) => (b.getAttribute("aria-label") || "").split(" ")[0])
      .filter((label) => ["主页", "团队", "会话", "插件", "记忆", "知识库", "模型", "设置"].includes(label));
    expect(labels).toEqual(["主页", "团队", "会话", "插件", "记忆", "知识库", "模型", "设置"]);
    for (const name of ["团队", "插件", "会话"]) {
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
    screen.getByLabelText("主页").focus();

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
    screen.getByLabelText("主页").focus();
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
    const item = screen.getByLabelText("记忆");
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
    useUiStore.setState({ page: "home", navOrder: [...NEW_DEFAULT] });
  });

  const PAGE_LABELS = ["主页", "团队", "会话", "插件", "记忆", "知识库", "模型", "设置"];

  it("默认顺序：主页 / 团队 / 会话 / 插件 / 记忆 / 知识库 / 模型 / 设置", () => {
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

/**
 * 二级视图飞出菜单（2026-11-14 审计 §4-F1）。
 *
 * 只断言结构与状态机：hover 延时用 fake timers 拨表，不真实等待 120/160ms；
 * 键盘路径全同步（ArrowRight 立刻展开，不等延时），所以不用动定时器。
 */
describe("NavRail 二级视图飞出菜单（§4-F1）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUiStore.setState({
      page: "home",
      navOrder: [...NEW_DEFAULT],
      navMode: "pinned",
      navOpen: false,
      paletteIntent: null,
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

  const navButton = (name: string) => screen.getByRole("button", { name });

  it("有二级视图的项挂 aria-haspopup/aria-expanded；单视图页不挂", () => {
    render(<NavRail />);
    for (const name of ["团队", "插件", "记忆", "模型", "设置"]) {
      const btn = navButton(name);
      expect(btn).toHaveAttribute("aria-haspopup", "menu");
      expect(btn).toHaveAttribute("aria-expanded", "false");
    }
    // 主页 / 会话 / 知识库没有页内页签：不挂 popup，也不挂空菜单
    for (const name of ["主页", "会话", "知识库"]) {
      expect(navButton(name)).not.toHaveAttribute("aria-haspopup");
    }
  });

  it("悬停 120ms 展开、移出 160ms 收起（扫过不弹）", () => {
    render(<NavRail />);
    const btn = navButton("团队");
    const box = btn.closest("div") as HTMLElement;

    fireEvent.mouseEnter(box);
    // 未到延时：不展开，避免鼠标扫过整条轨时串出一排浮层
    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(10);
    });
    const menu = screen.getByRole("menu", { name: "团队的视图" });
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(5);
    // 项名是「页 · 视图」，与命令面板的「模型 › 运行」同一种说法
    expect(within(menu).getByRole("menuitem", { name: "团队 · 看板" })).toBeInTheDocument();

    fireEvent.mouseLeave(box);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByRole("menu", { name: "团队的视图" })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  it("从一项移到另一项：新菜单不会被上一项的关闭计时器掐掉（横扫不闪）", () => {
    render(<NavRail />);
    const team = navButton("团队");
    const model = navButton("模型");
    const teamBox = team.closest("div") as HTMLElement;
    const modelBox = model.closest("div") as HTMLElement;

    fireEvent.mouseEnter(teamBox);
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(screen.getByRole("menu", { name: "团队的视图" })).toBeInTheDocument();

    // 扫到下一项：团队排的 160ms 关闭计时器必须作废
    fireEvent.mouseLeave(teamBox);
    fireEvent.mouseEnter(modelBox);
    act(() => {
      vi.advanceTimersByTime(120);
    });
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(screen.getByRole("menu", { name: "模型的视图" })).toBeInTheDocument();
  });

  it("键盘：ArrowRight 展开并把焦点送进第一项，↑↓ 环走，Escape 收起且焦点回导航项", () => {
    render(<NavRail />);
    const btn = navButton("团队");
    btn.focus();

    fireEvent.keyDown(btn, { key: "ArrowRight" });
    const menu = screen.getByRole("menu", { name: "团队的视图" });
    const items = within(menu).getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);
    // 首项再上一步环到末项
    fireEvent.keyDown(items[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[items.length - 1]);

    fireEvent.keyDown(items[items.length - 1], { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(btn);

    // Tab 也收起菜单，但焦点必须落在导航项上（不能掉到 body）
    fireEvent.keyDown(btn, { key: "ArrowRight" });
    const again = within(screen.getByRole("menu", { name: "团队的视图" })).getAllByRole("menuitem");
    fireEvent.keyDown(again[0], { key: "Tab" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(btn);
  });

  it("点轨道以外收起菜单（键盘打开的菜单不会僵在屏上）", () => {
    render(<NavRail />);
    fireEvent.keyDown(navButton("团队"), { key: "ArrowRight" });
    expect(screen.getByRole("menu", { name: "团队的视图" })).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    // 点在菜单内部不该收（否则点不动菜单项）
    fireEvent.keyDown(navButton("团队"), { key: "ArrowRight" });
    fireEvent.pointerDown(
      within(screen.getByRole("menu", { name: "团队的视图" })).getAllByRole("menuitem")[0],
    );
    expect(screen.getByRole("menu", { name: "团队的视图" })).toBeInTheDocument();
  });

  it("点「团队 · 看板」= 进团队页 + 投递 focus-tab 意图，菜单收起", () => {
    render(<NavRail />);
    fireEvent.keyDown(navButton("团队"), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitem", { name: "团队 · 看板" }));

    const s = useUiStore.getState();
    expect(s.page).toBe("team");
    expect(s.paletteIntent).toMatchObject({
      kind: "focus-tab",
      data: { page: "team", tab: "board" },
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("点导航项本体仍是「进默认视图」：不发意图、只切页", () => {
    render(<NavRail />);
    fireEvent.click(navButton("设置"));
    const s = useUiStore.getState();
    expect(s.page).toBe("settings");
    expect(s.paletteIntent).toBeNull();
  });

  it("auto 模式下 Esc 先收菜单、再按一次才收整条导航", () => {
    useUiStore.setState({ navMode: "auto", navOpen: true });
    render(<NavRail />);
    const btn = navButton("模型");
    fireEvent.keyDown(btn, { key: "ArrowRight" });
    expect(screen.getByRole("menu", { name: "模型的视图" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    // 最内层先关：整条导航还没收
    expect(useUiStore.getState().navOpen).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(useUiStore.getState().navOpen).toBe(false);
  });
});
