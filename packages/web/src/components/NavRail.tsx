import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  HomeIcon,
  TeamIcon,
  AssistantIcon,
  MemoryIcon,
  GearIcon,
  UserIcon,
  PackageIcon,
  SearchIcon,
  ModelIcon,
  PinIcon,
  BookIcon,
  KeyboardIcon,
} from "./icons.js";
import { DEFAULT_NAV_ORDER, useUiStore, type NavPage } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";
import { NotificationCenter } from "./NotificationCenter.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { GlobalFocusRing } from "./a11y/GlobalFocusRing.js";
import { hasOpenModal } from "./useModalA11y.js";
import { NAV_HIDE_DELAY_MS, NAV_HOTZONE_PX, otherNavMode } from "../lib/navPrefs.js";
import { NAV_GROUP_LABEL, navGroupOf, needsGroupDivider } from "../lib/navGroups.js";
import { navViewName, navViewsOf } from "../lib/navViews.js";
import { usePluginPageEntries } from "../lib/pages/usePluginPages.js";
import { withPluginNav } from "../lib/pages/registry.js";
import { PluginPageIcon } from "./plugins/PluginPageIcon.js";
import { Button } from "../components/ui/Button.js";
import { Kbd } from "./ui/Kbd.js";

/**
 * 导航项目录（**顺序即显示顺序**，见下方「固定顺序」说明）。
 * digit 固定绑定页本身，所以将来若重排顺序，Alt+N 也不会跟着漂。
 *
 * 固定顺序（2026-11-14 审计 A-04 起）：不再读 `store.navOrder`。
 * 顺序可调时用户会把「设置」拖到中间，而 Alt+N 的号仍是旧的——顺序与编号两套真源；
 * 现在顺序写死、编号也写死，两者一一对应，轨上从上到下就是 1、2、8、0、5、6。
 *
 * **默认可视 8 项**：主页 / 团队 / 会话 / 插件 / 记忆 / 知识库 / 模型 / 设置。
 * 另外还有带页面的插件（信息中枢 / 自动化 / 工作流等）：它们默认不出现，
 * 装好且启用后才由 `withPluginNav()` 追加到**最下面**（d.119 用户口径：上面这 8 项
 * 从上到下的顺序原样不动，插件入口不许插在中间）。插件页不占数字快捷键。
 *
 * 数字键沿用既有绑定：1 主页、2 团队、5 记忆、6 设置、8 会话、0 插件；
 * 3 / 4 原是技能区 / 接口区，合并后空着不用——不给现有页凭空换号。
 */
const ITEMS: { page: NavPage; label: string; icon: JSX.Element; digit?: string }[] = [
  { page: "home", label: "主页", icon: <HomeIcon width={18} height={18} />, digit: "1" },
  // 团队：名册 + 动向；还承接原「团队看板」的看板视图
  { page: "team", label: "团队", icon: <TeamIcon width={18} height={18} />, digit: "2" },
  // 会话（本机运行）：唯一内置智能体的对话入口，像 Codex / Claude Code 一样只有会话
  { page: "chat", label: "会话", icon: <AssistantIcon width={18} height={18} />, digit: "8" },
  // 插件（能力中枢）：插件包 + 技能 / 工具 / MCP / 组件
  { page: "plugins", label: "插件", icon: <PackageIcon width={18} height={18} />, digit: "0" },
  { page: "memory", label: "记忆", icon: <MemoryIcon width={18} height={18} />, digit: "5" },
  // 知识库：本地 vault（文件树/双链/标签/搜索/图谱），数据不出设备
  { page: "vault", label: "知识库", icon: <BookIcon width={18} height={18} /> },
  { page: "model", label: "模型", icon: <ModelIcon width={18} height={18} /> },
  // digit 绑定页面不随显示顺序变：改老页的编号等于换掉用户肌肉记忆里的快捷键。
  { page: "settings", label: "设置", icon: <GearIcon width={18} height={18} />, digit: "6" },
];

/**
 * 浮签：悬停黑色胶囊，淡入 + 轻微左移进入（120ms）；鼠标悬停或键盘聚焦时都出现
 * （焦点可见性，不只服务鼠标用户）。
 *
 * 键帽（2026-11-14 审计 C2）：本文件手写的键帽元素换成 `ui/Kbd`，全站键帽只剩一套外观。
 * 浮签是**反色**底（`bg-ink` 自带前景色 `--heming-on-accent`），所以不用 `text-white`
 * （那是把亮暗两套主题的前景色写死成白，暗色主题下反而读不清），
 * 键帽用 `[&>kbd]` 把描边/字色改成 `currentColor`，两套主题都自动跟随。
 */
function Tip({ label, shortcut }: { label: string; shortcut?: string }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute left-full top-1/2 z-20 ml-2 flex -translate-y-1/2 translate-x-1 items-center gap-2 whitespace-nowrap rounded-lg bg-ink px-2 py-1 text-ui-sm font-medium opacity-0 ui-overlay-shadow transition-all duration-fast motion-reduce:transition-none group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:translate-x-0 group-focus-within:opacity-100 [&>kbd]:border-current [&>kbd]:text-current [&>kbd]:opacity-70"
    >
      <span>{label}</span>
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </span>
  );
}

/**
 * 导航轨外形尺寸：56px 常驻宽度（2026-11-14 审计 A-11：原 54px 不在 8pt 栅格上，
 * 32px 控件左右各 11px、四舍五入不成整数；56 让两侧各 12px，整列重心落在像素中点上）。
 */
const RAIL_WIDTH = "w-14";

/**
 * 导航轨控件的统一命中区（d.141）：32×32、圆角 12。
 *
 * 为什么收口：改动前同一列里 34×34（搜索 / 导航页）、32×34（快捷键 / 固定）、
 * 30×30（通知）、32×32（账户）四种尺寸混排——图标视觉重心左右各差 1px，
 * 悬停时整列看着在轻微「抖」；34 也超出控件高刻度（28 / 32）。
 * 命中区不到 32 的控件一律套 RAIL_CTRL，新增按钮别再写一次性 h-[…] w-[…]。
 */
const RAIL_CTRL = "flex h-8 w-8 items-center justify-center rounded-lg";

/**
 * 二级视图飞出菜单的开/关延时（2026-11-14 审计 §4-F1）。
 *
 * 为什么不是「hover 即开」：鼠标从轨顶扫到轨底会依次掠过 8 个导航项，
 * 立刻弹菜单会串出一排开开关关的浮层，比没有菜单更吵。120ms 是「停一下」的判定阈值，
 * 与浮签（Tip）的即时淡入不冲突——浮签 120ms 淡入、菜单 120ms 后展开，时间上刚好接上。
 * 关闭用 160ms：比打开略长，手指从图标移到右侧菜单要跨 8px 缝隙，短了会闪。
 */
const MENU_OPEN_DELAY_MS = 120;
const MENU_CLOSE_DELAY_MS = 160;

/**
 * 元素当前是否是「键盘可见焦点」。
 *
 * jsdom 不实现 `:focus-visible`（会抛错），所以包一层 try/catch；
 * 测试环境回退到调用方的 keyboardFocusRef 判定。
 */
function isFocusVisible(el: Element | null): boolean {
  if (!el || typeof (el as HTMLElement).matches !== "function") return false;
  try {
    return (el as HTMLElement).matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * 图标轨（A 方案）：约 56px 常驻左缘，无产品名文字。
 *
 * d.68 起支持两种模式（见 `lib/navPrefs.ts`）：
 * - `pinned`（默认）：与之前完全一致，参与布局、占 56px；
 * - `auto`：**脱离文档流**的浮层（absolute + 壳层行 relative），不挤压主内容；
 *   左缘 8px 热区（可聚焦 button）悬停/点击/Tab 展开，鼠标离开 400ms 收回，
 *   焦点仍在导航内不收回，Esc 收回并把焦点还回热区。
 *
 * 为什么浮层用 absolute 而不是 fixed：fixed 会按视口定位，导航浮层会盖住
 * 桌面壳的自定义标题栏（它在本组件的兄弟节点上）。absolute 相对「壳层内容行」
 * 定位，顶边正好在标题栏下，观感就是浮层、又不用把标题栏高度写死在组件里。
 */
export function NavRail({
  onOpenSearch,
  onOpenShortcuts,
}: {
  onOpenSearch?: () => void;
  onOpenShortcuts?: () => void;
} = {}) {
  const page = useUiStore((s) => s.page);
  const setPage = useUiStore((s) => s.setPage);
  /** d.124：已装插件声明的页面入口（声明式 + 界面插件由注册表统一投影）。 */
  const pluginEntries = usePluginPageEntries();
  /*
   * 导航顺序**完全固定**（d.123 用户口径：从上到下永远是
   * 主页 / 团队 / 会话 / 插件 / 记忆 / 知识库 / 模型 / 设置）。
   *
   * 不再读取 `heming.navOrder.v1`：旧版允许拖拽排序，用户的存储里可能留着与固定顺序不同的
   * 旧排列（升级/换设备后表现为「顺序不对」），继续沿用会让「永远固定」落空。
   * 已装且启用的插件页面仍追加在这 8 项之后，不改变上面 8 项的顺序。
   */
  const navOrder = withPluginNav([...DEFAULT_NAV_ORDER], pluginEntries);
  /**
   * 导航项目录 = 固定 8 宿主页（ITEMS） + 插件页面（按清单标题/图标生成）。
   *
   * 插件页面是运行时才知道的页面，不能塞进模块级常量 ITEMS；这里用注册表投影
   * 生成，再用同一个 `find` 口径把顺序映射成可见项，避免两处各判一次「能不能进」。
   */
  const items = useMemo(() => {
    const fixed = new Set(ITEMS.map((item) => item.page));
    const pluginItems = pluginEntries
      .filter((entry) => entry.available && !fixed.has(entry.pageId))
      .map((entry) => ({
        page: entry.pageId,
        label: entry.title,
        icon: <PluginPageIcon icon={entry.icon} size={18} />,
      }));
    return [...ITEMS, ...pluginItems];
  }, [pluginEntries]);
  const navMode = useUiStore((s) => s.navMode);
  const navOpen = useUiStore((s) => s.navOpen);
  const setNavMode = useUiStore((s) => s.setNavMode);
  const openNav = useUiStore((s) => s.openNav);
  const closeNav = useUiStore((s) => s.closeNav);
  const displayName = useAuthStore((s) => s.user?.displayName);
  const avatar = useAuthStore((s) => s.user?.avatar);
  const who = displayName || "我";
  // 退出是破坏性操作（会清掉会话态），先问一句再登出
  const [confirmLogout, setConfirmLogout] = useState(false);

  const auto = navMode === "auto";
  const pinned = !auto;
  const navRef = useRef<HTMLElement | null>(null);
  const hotzoneRef = useRef<HTMLButtonElement | null>(null);
  const hideTimer = useRef<number | null>(null);
  /**
   * Esc 收起后要把焦点还给热区，但热区的 `onFocus` 又会展开导航——
   * 「收回到热区」就会变成「收起来立刻又弹开」。这个门闩只在程序化聚焦热区的那一瞬间关掉。
   */
  const suppressFocusOpen = useRef(false);
  /**
   * 最近一次交互是不是键盘（d.68 自检修）。
   *
   * ★ 为什么需要：鼠标点导航项后，按钮会保留 focus；而「收回前看焦点是否在导航内」
   *   是给键盘用户留的，鼠标点击留下的焦点不该把浮层永远钉住。否则 auto 模式点完
   *   一个页面后鼠标移开，浮层不会收回（实测确认）。这里用 keydown/pointerdown 区分，
   *   并辅以 `:focus-visible`（真实 Chromium 能正确区分鼠标/键盘焦点）。
   */
  const keyboardFocusRef = useRef(false);

  /**
   * 二级视图飞出菜单（2026-11-14 审计 §4-F1）。
   *
   * 状态就是「当前展开的是哪一页的菜单」（null = 全收起），一个导航项同一时刻只开一个。
   * 与 Tip 共用 hover 语义，但两者**不共存**：有二级视图的项只出菜单（菜单头里带页名与
   * 快捷键），没有二级视图的项才出 Tip——否则同一位置（left-full ml-2）会叠两层浮层。
   */
  const setPaletteIntent = useUiStore((s) => s.setPaletteIntent);
  const [openMenu, setOpenMenu] = useState<NavPage | null>(null);
  const menuOpenTimer = useRef<number | null>(null);
  const menuCloseTimer = useRef<number | null>(null);
  /** 键盘打开菜单后要把焦点送进第一项；hover 打开则不动焦点。 */
  const pendingMenuFocus = useRef(false);
  /** 每个导航项的外壳（菜单的定位容器 + 焦点回位锚点），按页 id 取。 */
  const navItemRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  const clearHideTimer = () => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  /** 清掉飞出菜单的开/关定时器（移入菜单、点项、收起时都要清，避免滞后触发）。 */
  const clearMenuTimers = () => {
    if (menuOpenTimer.current !== null) {
      window.clearTimeout(menuOpenTimer.current);
      menuOpenTimer.current = null;
    }
    if (menuCloseTimer.current !== null) {
      window.clearTimeout(menuCloseTimer.current);
      menuCloseTimer.current = null;
    }
  };

  /** 悬停 120ms 后展开该页菜单；已在开的那一页则直接返回（不重启计时）。 */
  const scheduleMenuOpen = (target: NavPage) => {
    if (navViewsOf(target).length === 0) return;
    if (menuOpenTimer.current !== null) {
      window.clearTimeout(menuOpenTimer.current);
      menuOpenTimer.current = null;
    }
    // 扫过相邻项时，上一项排的「160ms 后收起」必须作废——否则它会在新菜单刚开
    // 出来 40ms 后把 openMenu 清掉，菜单闪一下就没（鼠标横扫导航轨时必现）。
    if (menuCloseTimer.current !== null) {
      window.clearTimeout(menuCloseTimer.current);
      menuCloseTimer.current = null;
    }
    if (openMenu === target) return;
    menuOpenTimer.current = window.setTimeout(() => {
      menuOpenTimer.current = null;
      setOpenMenu(target);
    }, MENU_OPEN_DELAY_MS);
  };

  /** 移出导航项 160ms 后收起（给「从图标挪到右侧菜单」的 8px 缝隙留时间）。 */
  const scheduleMenuClose = () => {
    if (menuOpenTimer.current !== null) {
      window.clearTimeout(menuOpenTimer.current);
      menuOpenTimer.current = null;
    }
    if (menuCloseTimer.current !== null) window.clearTimeout(menuCloseTimer.current);
    menuCloseTimer.current = window.setTimeout(() => {
      menuCloseTimer.current = null;
      setOpenMenu(null);
    }, MENU_CLOSE_DELAY_MS);
  };

  /** 立刻展开（键盘路径：ArrowRight/ArrowDown），并把焦点排进第一项。 */
  const openMenuNow = (target: NavPage, focusFirst: boolean) => {
    clearMenuTimers();
    pendingMenuFocus.current = focusFirst;
    setOpenMenu(target);
  };

  /** 立刻收起；传了页 id 就把焦点还给该项的导航按钮（键盘回位）。 */
  const closeMenuNow = (returnTo?: NavPage) => {
    clearMenuTimers();
    pendingMenuFocus.current = false;
    setOpenMenu(null);
    if (returnTo) {
      navItemRefs.current
        .get(returnTo)
        ?.querySelector<HTMLElement>("button[aria-haspopup]")
        ?.focus();
    }
  };

  /**
   * 键盘打开后把焦点送进菜单第一项。
   * 放在 effect 里而不是 `requestAnimationFrame`：菜单是同一帧渲染出来的，
   * effect 提交后节点已在 DOM 上，测试（act 同步刷）与真实运行都不用等定时器。
   */
  useEffect(() => {
    if (!openMenu || !pendingMenuFocus.current) return;
    pendingMenuFocus.current = false;
    navItemRefs.current.get(openMenu)?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [openMenu]);

  /**
   * 点到轨道以外就收起菜单。
   *
   * 键盘（ArrowRight）打开的菜单不会被鼠标移开带走，用户点一下正文回来，
   * 菜单会一直僵在屏上——那条路径必须显式收。内部判定用「项外壳」：
   * pinned 与 auto 两种模式的 <nav> 不是同一个节点，而每个项的外壳（连同它的
   * 飞出菜单）始终登记在 navItemRefs 里，两种模式都成立。
   */
  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      const inside = [...navItemRefs.current.values()].some((el) => el?.contains(e.target as Node));
      if (inside) return;
      clearMenuTimers();
      setOpenMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [openMenu]);

  /** 菜单内键盘：↑↓ 在项间环走、Home/End 跳首尾、Esc 收起并回位、Tab 收起后交还浏览器。 */
  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, target: NavPage) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenuNow(target);
      return;
    }
    if (e.key === "Tab") {
      // 不拦默认行为：先把焦点还给导航项，浏览器接着按 DOM 顺序搬到下一个可聚焦元素。
      // 若直接 unmount 菜单，焦点会掉到 document.body（Tab 之后什么都选不中）。
      closeMenuNow(target);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    );
    if (items.length === 0) return;
    e.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : e.key === "ArrowDown"
            ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  /** 收起浮层；若焦点因鼠标点击留在导航里，先 blur，避免焦点停在 inert 元素上。 */
  const closeOverlay = () => {
    // 导航整体收起时，挂在它上面的二级视图菜单也必须一起收（否则会留下几像素的孤儿浮层）
    clearMenuTimers();
    setOpenMenu(null);
    const nav = navRef.current;
    const active = document.activeElement as HTMLElement | null;
    if (nav && active && nav.contains(active)) active.blur();
    useUiStore.getState().closeNav();
  };

  /**
   * 延迟收回（auto 模式）。真正收回前**再看一眼焦点**：
   * 键盘用户可能正停在导航里没动鼠标，300ms 一到就收走会让焦点悬空；
   * 但鼠标点击留下的焦点不算「键盘焦点」，否则浮层会被永远钉住。
   */
  const scheduleHide = () => {
    if (!auto) return;
    clearHideTimer();
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      const nav = navRef.current;
      const active = document.activeElement;
      const keyboardInside =
        !!nav && !!active && nav.contains(active) && (keyboardFocusRef.current || isFocusVisible(active));
      if (keyboardInside) return; // 键盘焦点在导航内：不收回
      closeOverlay();
    }, NAV_HIDE_DELAY_MS);
  };

  // 卸载时清掉待执行的收回定时器（切页/注销会直接卸载导航轨）
  useEffect(
    () => () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      if (menuOpenTimer.current !== null) window.clearTimeout(menuOpenTimer.current);
      if (menuCloseTimer.current !== null) window.clearTimeout(menuCloseTimer.current);
    },
    [],
  );

  /** 展开并把焦点送进当前页按钮（键盘路径：Tab/Enter 与 Ctrl+B）。 */
  const openWithFocus = () => {
    clearHideTimer();
    keyboardFocusRef.current = true;
    openNav();
    // 等浮层挂上再聚焦；rAF 在 jsdom 里同样可用
    window.requestAnimationFrame(() => {
      const nav = navRef.current;
      if (!nav) return;
      const target =
        nav.querySelector<HTMLElement>('[aria-current="page"]') ??
        nav.querySelector<HTMLElement>("button:not([disabled])");
      target?.focus();
    });
  };

  // Esc 收起：只在「auto 且已展开」时挂一个捕获阶段的监听。
  // 捕获是为了先于全局快捷键处理，并在处理后停掉冒泡（Esc 只收导航，不影响别的层）。
  // 有模态弹窗时直接让位：Esc 属于弹窗（与 Alt+N / Ctrl+K 同一套纪律）。
  useEffect(() => {
    if (!auto || !navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (hasOpenModal()) return;
      // 二级视图菜单开着时按 Esc 先收菜单（焦点回导航项），再按一次才收整条导航轨——
      // 与「先关最内层浮层」的通用预期一致。
      if (openMenu) {
        e.preventDefault();
        e.stopPropagation();
        closeMenuNow(openMenu);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      closeNav();
      // 焦点还给热区（否则焦点停在已隐藏的按钮上），并临时关掉「聚焦即展开」
      suppressFocusOpen.current = true;
      hotzoneRef.current?.focus();
      suppressFocusOpen.current = false;
      keyboardFocusRef.current = false;
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [auto, navOpen, closeNav, openMenu]);

  /**
   * 可见导航项（固定顺序、不可用的插件页撤下）。
   * 抽成变量是为了让分组能按「连续同组」切段——内联 map 里拿不到过滤后的前一项。
   */
  const visibleItems = navOrder
    .map((navPage) => items.find((it) => it.page === navPage))
    .filter((it): it is (typeof ITEMS)[number] => Boolean(it));

  /**
   * 中组逐项展开：带上「是否起新组」（决定要不要画细线、要不要放隐藏组名）。
   * 插件页面一律算能力组、又固定追加在最末，所以末尾会再起一段能力组——与原来的分隔线
   * 口径一致（系统→能力多一条线，位置稳定不跳动）。
   * `groupLabelId` 以「本段首项」命名，同组内的按钮共用同一个描述目标。
   */
  let currentRunId = "";
  const navRows = visibleItems.map((it, index) => {
    const group = navGroupOf(it.page);
    const prev = visibleItems[index - 1];
    const runStart = !prev || navGroupOf(prev.page) !== group;
    if (runStart) currentRunId = `nav-group-${it.page}`;
    return {
      it,
      group,
      runStart,
      groupLabelId: currentRunId,
      divider: needsGroupDivider(prev?.page ?? null, it.page),
    };
  });

  /** 导航轨内容：常显与浮层共用一份，避免两种模式的行为慢慢分叉。 */
  const railInner = (
    <>
      {/* 全站键盘焦点环（③-2）：一条 :focus-visible 规则覆盖所有 outline-hidden 控件 */}
      <GlobalFocusRing />
      {/* 上组：搜索 + 快捷键帮助（不占导航页键位） */}
      <div className="flex flex-col items-center gap-2 pb-2">
        <div className="group relative">
          <button
            type="button"
            aria-label="全局搜索 Ctrl K"
            onClick={() => onOpenSearch?.()}
            className={`${RAIL_CTRL} text-muted transition-colors duration-fast hover:bg-subtle-3 hover:text-ink`}
          >
            <SearchIcon width={18} height={18} />
          </button>
          <Tip label="搜索" shortcut="Ctrl K" />
        </div>

        {/* 快捷键帮助：? 与搜索并排（不占导航页键位）。也可随时按 ? 或 Ctrl+/ 打开。 */}
        <div className="group relative">
          <button
            type="button"
            aria-label="快捷键帮助"
            title="快捷键"
            onClick={() => onOpenShortcuts?.()}
            className={`${RAIL_CTRL} text-muted transition-colors duration-fast hover:bg-subtle-3 hover:text-ink`}
          >
            {/* P2-G1：「?」是文字冒充图标，字形随字体变、基线也不稳；键盘图标语义更直白 */}
            <KeyboardIcon width={18} height={18} />
          </button>
          <Tip label="快捷键" shortcut="?" />
        </div>
      </div>

      {/* 中组：导航页（宿主 8 页 + 已装插件的页面），垂直居中（组内间距 8px；组间一条细线）。
          G2（2026-11-14 审计）：分组名「工作台 / 能力 / 资料 / 系统」在 56px 宽的图标轨上放不下——
          中文横排要 3 个字宽、竖排要 40px 高，两种都得挤掉导航项或改轨道布局。所以**不做可见标签**，
          改成「隐藏组名 + `aria-describedby`」：每组首项之前放一个 `sr-only` 的组名节点，
          组内按钮都指向它，读屏读到按钮时补一句组名；视觉上仍只靠那条细线，轨道宽度不用动。
          分组于是从「只有设计稿知道的隐式约定」变成可朗读、可断言的显式结构。 */}
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        {navRows.map(({ it, group, runStart, groupLabelId, divider }) => {
          const active = page === it.page;
          // 浮签里的键位写法与 `ShortcutsHelp` 面板一致：修饰键与键之间留空格
          // （「Alt 1」而不是「Alt1」）。`aria-keyshortcuts` 仍按 ARIA 规范用「+」。
          const shortcut = it.digit ? `Alt ${it.digit}` : "";
          // 显示名固定在本文件（含插件页标题，插件页也要能在这条轨上被点到）
          const label = it.label;
          // 二级视图（§4-F1）：有才挂飞出菜单；没有的页保持原来的 Tip，不硬造一层。
          const views = navViewsOf(it.page);
          const hasViews = views.length > 0;
          const menuOpen = openMenu === it.page;
          return (
            <Fragment key={it.page}>
              {divider ? <div aria-hidden="true" className="h-px w-6 bg-line-soft" /> : null}
              {runStart ? (
                <span id={groupLabelId} className="sr-only">
                  {NAV_GROUP_LABEL[group]}
                </span>
              ) : null}
              <div
                className="group relative"
                data-nav-group={group}
                ref={(el) => {
                  if (el) navItemRefs.current.set(it.page, el);
                  else navItemRefs.current.delete(it.page);
                }}
                onMouseEnter={hasViews ? () => scheduleMenuOpen(it.page) : undefined}
                onMouseLeave={hasViews ? scheduleMenuClose : undefined}
              >
                <button
                  type="button"
                  aria-label={label}
                  aria-describedby={groupLabelId}
                  aria-keyshortcuts={it.digit ? `Alt+${it.digit}` : undefined}
                  aria-current={active ? "page" : undefined}
                  // 有二级视图的项是「可展开的导航入口」：菜单由 hover/ArrowRight 打开，
                  // 点本体仍是「进默认视图」，所以只是 popup 按钮，不是纯菜单按钮。
                  aria-haspopup={hasViews ? "menu" : undefined}
                  aria-expanded={hasViews ? menuOpen : undefined}
                  onKeyDown={
                    hasViews
                      ? (e) => {
                          if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                            e.preventDefault();
                            openMenuNow(it.page, true);
                            return;
                          }
                          if (e.key === "Escape" && menuOpen) {
                            e.preventDefault();
                            closeMenuNow(it.page);
                          }
                        }
                      : undefined
                  }
                  onClick={() => {
                    // 点本体 = 进该页默认视图，并把菜单收起（菜单是「跳去某一层」的旁路）
                    clearMenuTimers();
                    setOpenMenu(null);
                    setPage(it.page);
                    // auto 模式 + 鼠标点击：导航已完成使命，直接收起。
                    // 键盘激活（Enter）保留浮层，让焦点连续、可继续 Tab/Esc。
                    if (auto && !keyboardFocusRef.current) closeOverlay();
                  }}
                  className={`relative ${RAIL_CTRL} transition-colors duration-fast ${
                    active ? "bg-ink text-white" : "text-muted hover:bg-subtle-3 hover:text-ink"
                  }`}
                >
                  {it.icon}
                </button>

                {hasViews && menuOpen ? (
                  /**
                   * 飞出菜单：贴在本项右侧（left-full + 8px），与浮签同一层（z-20），
                   * 所以不会盖住左侧导航轨的其它项；轨道宽度不变。
                   * 菜单头是纯装饰（aria-hidden）：可访问名由 role=menu 的 aria-label 与
                   * 每个 menuitem 的「页 · 视图」给全，读屏不必再念一遍页名。
                   */
                  <div
                    role="menu"
                    aria-label={`${label}的视图`}
                    data-testid={`nav-menu-${it.page}`}
                    onMouseEnter={clearMenuTimers}
                    onMouseLeave={scheduleMenuClose}
                    onKeyDown={(e) => onMenuKeyDown(e, it.page)}
                    className="absolute left-full top-1/2 z-20 ml-2 w-44 -translate-y-1/2 rounded-lg border border-line-soft bg-surface py-1 ui-overlay-shadow"
                  >
                    <div
                      aria-hidden="true"
                      className="flex items-center justify-between gap-2 px-2.5 pb-1 pt-0.5 ui-caption"
                    >
                      <span>{label}</span>
                      {shortcut ? <Kbd>{shortcut}</Kbd> : null}
                    </div>
                    {views.map((view) => (
                      <button
                        key={view.key}
                        type="button"
                        role="menuitem"
                        aria-label={navViewName(label, view)}
                        onClick={() => {
                          // 先落页、再投一次一次性意图：宿主页挂载后第一帧消费，
                          // 已挂载时靠 store 订阅重渲染触发，两条路径落地一致。
                          setPage(it.page);
                          setPaletteIntent("focus-tab", { page: it.page, tab: view.key });
                          closeMenuNow();
                          if (auto && !keyboardFocusRef.current) closeOverlay();
                        }}
                        className="flex min-h-8 w-full items-center px-2.5 text-left text-ui-sm text-body transition-colors duration-fast hover:bg-subtle-2 hover:text-ink"
                      >
                        {view.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <Tip label={label} shortcut={shortcut || undefined} />
                )}
              </div>
            </Fragment>
          );
        })}
      </div>

      {/* 下组：通知 + 固定开关 + 账户（间距 8px，与上/中组同节奏） */}
      <div className="flex flex-col items-center gap-2 pt-2">
        <NotificationCenter />
        <div className="group relative">
          <button
            type="button"
            aria-label={pinned ? "自动隐藏导航栏" : "固定导航栏"}
            aria-pressed={pinned}
            title={pinned ? "自动隐藏导航栏（Ctrl+B）" : "固定导航栏常显（Ctrl+B）"}
            onClick={() => setNavMode(otherNavMode(navMode))}
            className={`${RAIL_CTRL} transition-colors duration-fast ${
              pinned ? "text-body hover:bg-subtle-3 hover:text-ink" : "text-muted hover:bg-subtle-3 hover:text-ink"
            }`}
          >
            <PinIcon width={16} height={16} />
          </button>
          <Tip label={pinned ? "自动隐藏" : "固定常显"} shortcut="Ctrl B" />
        </div>

        <div className="group relative">
          <button
            type="button"
            aria-label={`账户：${who} · 退出登录`}
            title="退出登录"
            onClick={() => setConfirmLogout(true)}
            className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-subtle-3 text-ui-sm font-semibold text-body transition-colors duration-fast hover:bg-subtle-4"
          >
            {avatar ? (
              <img src={avatar} alt="" className="h-full w-full rounded-full object-cover" />
            ) : (
              <UserIcon width={16} height={16} />
            )}
          </button>
          <Tip label={`${who} · 账户`} />
        </div>
      </div>

      {confirmLogout && (
        <ConfirmDialog
          title="退出登录"
          onCancel={() => setConfirmLogout(false)}
          footer={
            <>
              <Button
                type="button"
                onClick={() => setConfirmLogout(false)}
                size="md" variant="ghost"
              >
                取消
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setConfirmLogout(false);
                  useAuthStore.getState().logout();
                }}
                size="md" variant="danger"
              >
                退出登录
              </Button>
            </>
          }
        >
          <p className="ui-caption leading-6">退出后需要重新登录才能继续使用和鸣。</p>
        </ConfirmDialog>
      )}
    </>
  );

  // ── pinned：常显（与 d.67 一致，参与布局） ──
  if (pinned) {
    return (
      <nav
        aria-label="主导航"
        className={`flex ${RAIL_WIDTH} shrink-0 flex-col items-center border-r border-line-soft bg-subtle-2 py-3`}
      >
        {railInner}
      </nav>
    );
  }

  // ── auto：左缘热区 + 浮层（不参与布局宽度） ──
  return (
    <>
      {/* 热区：可聚焦 button（Tab 可达），8px 宽、不可见；hover/聚焦/点击都展开 */}
      <button
        ref={hotzoneRef}
        type="button"
        data-testid="nav-hotzone"
        aria-label="展开导航"
        aria-expanded={navOpen}
        aria-controls="heming-nav-rail"
        style={{ width: NAV_HOTZONE_PX }}
        onMouseEnter={() => {
          clearHideTimer();
          openNav();
        }}
        onFocus={() => {
          if (suppressFocusOpen.current) return;
          keyboardFocusRef.current = true;
          clearHideTimer();
          openNav();
        }}
        onClick={openWithFocus}
        className="absolute inset-y-0 left-0 z-20 cursor-default bg-transparent"
      />
      <nav
        id="heming-nav-rail"
        ref={navRef}
        aria-label="主导航"
        aria-hidden={!navOpen}
        inert={!navOpen}
        // 键盘/鼠标交互标记：决定「收回时焦点是否该留住浮层」（见 keyboardFocusRef 注释）。
        onKeyDownCapture={() => {
          keyboardFocusRef.current = true;
        }}
        onPointerDownCapture={() => {
          keyboardFocusRef.current = false;
        }}
        onMouseEnter={clearHideTimer}
        onMouseLeave={scheduleHide}
        onBlur={(e) => {
          const next = e.relatedTarget as Node | null;
          if (next && (navRef.current?.contains(next) || hotzoneRef.current?.contains(next))) return;
          scheduleHide();
        }}
        className={`absolute inset-y-0 left-0 z-30 flex ${RAIL_WIDTH} flex-col items-center border-r border-line-soft bg-subtle-2 py-3 ui-overlay-shadow transition-[transform,opacity] duration-base ease-out motion-reduce:transition-none ${
          navOpen ? "translate-x-0 opacity-100" : "pointer-events-none -translate-x-full opacity-0"
        }`}
      >
        {railInner}
      </nav>
    </>
  );
}
