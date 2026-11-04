import { useEffect, useRef, useState, type JSX } from "react";
import {
  HomeIcon,
  TeamIcon,
  AssistantIcon,
  MemoryIcon,
  GearIcon,
  UserIcon,
  PackageIcon,
  SearchIcon,
  InfoHubIcon,
  AutomationIcon,
  StaffIcon,
  PinIcon,
} from "./icons.js";
import { normalizeNavOrder, useUiStore, type NavPage } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";
import { NotificationCenter } from "./NotificationCenter.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { GlobalFocusRing } from "./a11y/GlobalFocusRing.js";
import { hasOpenModal } from "./useModalA11y.js";
import { NAV_HIDE_DELAY_MS, NAV_HOTZONE_PX, otherNavMode } from "../lib/navPrefs.js";
import { useModuleStore } from "../lib/modules/store.js";
import { filterNavOrder } from "../lib/modules/nav.js";
import { moduleForPage } from "../lib/modules/registry.js";

/**
 * 导航项目录（顺序无关）：展示顺序由设置区的「导航顺序」决定（store.navOrder），
 * 而 digit 固定绑定页本身——所以排序后 Alt+N 快捷键不变。
 *
 * d.67 合并后只剩 9 个宿主页：团队看板 / 通用智能体 / 技能区 / 接口区不再单独占位。
 * - 团队看板 → 团队页「看板」视图
 * - 通用智能体 → 智能体页「任务」视图
 * - 技能区、接口区 → 插件区（能力中心）的「技能」「MCP」视图
 * 数字键沿用被合并页的旧键位（2 团队看板、8 通用智能体），保住肌肉记忆；
 * 技能区 3 / 接口区 4 没有承接页，空出来不用——不给现有页凭空换号。
 */
const ITEMS: { page: NavPage; label: string; icon: JSX.Element; digit?: string }[] = [
  { page: "home", label: "主页", icon: <HomeIcon width={17} height={17} />, digit: "1" },
  // 团队（d.54）：名册 + 动向；d.67 起还承接原「团队看板」的看板视图
  { page: "team", label: "团队", icon: <TeamIcon width={17} height={17} />, digit: "2" },
  // 智能体（本机运行）：d.67 起承接原「通用智能体」的任务视图
  { page: "chat", label: "智能体", icon: <AssistantIcon width={17} height={17} />, digit: "8" },
  // 幕僚（d.48）：常驻主动简报，与信息中枢同口径，不占数字键
  { page: "staff", label: "幕僚", icon: <StaffIcon width={17} height={17} /> },
  // 信息中枢（d.45）：1–9 已排满，新页不再占用快捷键，只从导航点开
  { page: "infohub", label: "信息中枢", icon: <InfoHubIcon width={17} height={17} /> },
  // 自动化（d.47）：与信息中枢同口径，不占数字键
  { page: "automations", label: "自动化", icon: <AutomationIcon width={17} height={17} /> },
  // 插件区（d.62 统一插件模型，d.67 起并入技能区与接口区）：能力中心
  { page: "plugins", label: "插件区", icon: <PackageIcon width={17} height={17} />, digit: "0" },
  { page: "memory", label: "记忆区", icon: <MemoryIcon width={17} height={17} />, digit: "5" },
  // digit 绑定页面不随显示顺序变：改老页的编号等于换掉用户肌肉记忆里的快捷键。
  { page: "settings", label: "设置区", icon: <GearIcon width={17} height={17} />, digit: "6" },
];

/** 悬停黑色胶囊浮签：淡入 + 轻微左移进入（group-hover，150ms）。 */
function Tip({ label, shortcut }: { label: string; shortcut?: string }) {
  return (
    <span className="pointer-events-none absolute left-full top-1/2 z-20 ml-2 flex -translate-y-1/2 translate-x-1 items-center gap-1.5 whitespace-nowrap rounded-[7px] bg-ink px-2 py-1 text-[11px] font-medium text-white opacity-0 shadow-[0_2px_6px_rgba(0,0,0,0.25)] transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100">
      <span>{label}</span>
      {shortcut && (
        <kbd className="rounded-sm border border-current px-1 text-[10px] font-normal opacity-70">
          {shortcut}
        </kbd>
      )}
    </span>
  );
}

/** 导航轨外形尺寸：与 d.67 的 A 方案一致（54px 常驻宽度）。 */
const RAIL_WIDTH = "w-[54px]";

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
 * 图标轨（A 方案）：约 54px 常驻左缘，无产品名文字。
 *
 * d.68 起支持两种模式（见 `lib/navPrefs.ts`）：
 * - `pinned`（默认）：与之前完全一致，参与布局、占 54px；
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
  // 渲染前再规整一次：手改过 localStorage 或旧版本残留时，缺项也会被补齐，绝不漏掉某个入口
  const rawNavOrder = normalizeNavOrder(useUiStore((s) => s.navOrder));
  const moduleEnabled = useModuleStore((s) => s.enabled);
  // d.70：内置能力模块停用后，其页面入口从导航中撤下（重新启用按原顺序回来）
  const navOrder = filterNavOrder(rawNavOrder, { enabled: moduleEnabled });
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

  const clearHideTimer = () => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  /** 收起浮层；若焦点因鼠标点击留在导航里，先 blur，避免焦点停在 inert 元素上。 */
  const closeOverlay = () => {
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
  }, [auto, navOpen, closeNav]);

  /** 导航轨内容：常显与浮层共用一份，避免两种模式的行为慢慢分叉。 */
  const railInner = (
    <>
      {/* 全站键盘焦点环（③-2）：一条 :focus-visible 规则覆盖所有 outline-hidden 控件 */}
      <GlobalFocusRing />
      {/* 上组：搜索 + 快捷键帮助（不占导航页键位） */}
      <div className="flex flex-col items-center gap-1.5 pb-2">
        <div className="group relative">
          <button
            type="button"
            aria-label="全局搜索 Ctrl K"
            onClick={() => onOpenSearch?.()}
            className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] text-[#666] transition-colors duration-150 hover:bg-[#f0f0f0] hover:text-ink"
          >
            <SearchIcon width={17} height={17} />
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
            className="flex h-[26px] w-[34px] items-center justify-center rounded-[9px] text-[13px] font-bold text-[#666] transition-colors duration-150 hover:bg-[#f0f0f0] hover:text-ink"
          >
            ?
          </button>
          <Tip label="快捷键" shortcut="?" />
        </div>
      </div>

      {/* 中组：9 个宿主页，垂直居中（间距 8px，d.68 排版轮统一节奏） */}
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        {navOrder
          .map((navPage) => ITEMS.find((it) => it.page === navPage))
          .filter((it): it is (typeof ITEMS)[number] => Boolean(it))
          .map((it) => {
            const active = page === it.page;
            const shortcut = it.digit ? `Alt${it.digit}` : "";
            // d.70：模块页的显示名以模块注册表为准（与插件区卡片同源，改一处不会两处漂移）
            const label = moduleForPage(it.page)?.name ?? it.label;
            return (
              <div key={it.page} className="group relative">
                <button
                  type="button"
                  aria-label={`${label}${shortcut ? ` ${shortcut}` : ""}`}
                  aria-current={active ? "page" : undefined}
                  onClick={() => {
                    setPage(it.page);
                    // auto 模式 + 鼠标点击：导航已完成使命，直接收起。
                    // 键盘激活（Enter）保留浮层，让焦点连续、可继续 Tab/Esc。
                    if (auto && !keyboardFocusRef.current) closeOverlay();
                  }}
                  className={`relative flex h-[34px] w-[34px] items-center justify-center rounded-[9px] transition-colors duration-150 ${
                    active ? "bg-ink text-white" : "text-[#666] hover:bg-[#f0f0f0] hover:text-ink"
                  }`}
                >
                  {it.icon}
                </button>
                <Tip label={label} shortcut={shortcut || undefined} />
              </div>
            );
          })}
      </div>

      {/* 下组：通知 + 固定开关 + 账户（间距 8px，与上/中组同节奏） */}
      <div className="flex flex-col items-center gap-2 pt-1.5">
        <NotificationCenter />
        <div className="group relative">
          <button
            type="button"
            aria-label={pinned ? "自动隐藏导航栏" : "固定导航栏"}
            aria-pressed={pinned}
            title={pinned ? "自动隐藏导航栏（Ctrl+B）" : "固定导航栏常显（Ctrl+B）"}
            onClick={() => setNavMode(otherNavMode(navMode))}
            className={`flex h-[26px] w-[34px] items-center justify-center rounded-[9px] transition-colors duration-150 ${
              pinned ? "text-[#555] hover:bg-[#f0f0f0] hover:text-ink" : "text-[#888] hover:bg-[#f0f0f0] hover:text-ink"
            }`}
          >
            <PinIcon width={15} height={15} />
          </button>
          <Tip label={pinned ? "自动隐藏" : "固定常显"} shortcut="Ctrl B" />
        </div>

        <div className="group relative">
          <button
            type="button"
            aria-label={`账户：${who} · 退出登录`}
            title="退出登录"
            onClick={() => setConfirmLogout(true)}
            className="flex h-[28px] w-[28px] items-center justify-center overflow-hidden rounded-full bg-[#ececec] text-[12px] font-bold text-[#555] transition-colors duration-150 hover:bg-[#f0f0f0]"
          >
            {avatar ? (
              <img src={avatar} alt="" className="h-full w-full rounded-full object-cover" />
            ) : (
              <UserIcon width={14} height={14} />
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
              <button
                type="button"
                onClick={() => setConfirmLogout(false)}
                className="rounded-lg border border-line px-3 py-1.5 text-[12px] hover:bg-[#fafafa]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmLogout(false);
                  useAuthStore.getState().logout();
                }}
                className="rounded-lg bg-[#b42318] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#912018]"
              >
                退出登录
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">退出后需要重新登录才能继续使用和鸣。</p>
        </ConfirmDialog>
      )}
    </>
  );

  // ── pinned：常显（与 d.67 一致，参与布局） ──
  if (pinned) {
    return (
      <nav
        aria-label="主导航"
        className={`flex ${RAIL_WIDTH} shrink-0 flex-col items-center border-r border-line-soft bg-[#fafafa] py-3`}
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
        className={`absolute inset-y-0 left-0 z-30 flex ${RAIL_WIDTH} flex-col items-center border-r border-line-soft bg-[#fafafa] py-3 ui-overlay-shadow transition-[transform,opacity] duration-[160ms] ease-out motion-reduce:transition-none ${
          navOpen ? "translate-x-0 opacity-100" : "pointer-events-none -translate-x-full opacity-0"
        }`}
      >
        {railInner}
      </nav>
    </>
  );
}
