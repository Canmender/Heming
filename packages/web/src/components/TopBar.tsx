import { IconButton } from "./ui/IconButton.js";
import { KeyboardIcon, SearchIcon } from "./icons.js";
import { PageMenu } from "./PageMenu.js";
import { NotificationCenter } from "./NotificationCenter.js";
import { Wordmark } from "./Wordmark.js";

/**
 * 顶栏（d.147.4.86 起是唯一常驻的全局控件条；d.147.4.88 再瘦一圈）。
 *
 * 现在只留四件事：品牌（手写标志，兼桌面拖拽带）、页面菜单、命令面板、快捷键帮助
 * 与通知中心。原来挂在这里的两颗按钮各自回到自己的归属：
 * - 「会话进度」→ 会话页 header（Codex 式：面板开关挨着它要开的那个面板）；
 * - 账户头像 → 会话栏左下角（见 `AccountMenu`）。
 *
 * 顶栏越薄，内容越像内容：这是本轮「最大化简化」的落点。
 */
export function TopBar({
  onOpenSearch,
  onOpenShortcuts,
}: {
  onOpenSearch: () => void;
  onOpenShortcuts: () => void;
}) {
  /**
   * 桌面端顶栏复用 `.desktop-titlebar`（拖拽区 + 让开右侧窗口控件），
   * 浏览器端没有窗口壳，就退化成一条普通 h-10 顶栏——两种形态结构一致，
   * 只是类名不同（测试与设计审计都按 `[data-testid="topbar"]` 定位）。
   */
  const isDesktop = typeof window !== "undefined" && !!window.heming;

  return (
    <header
      data-testid="topbar"
      aria-label="顶栏"
      className={
        isDesktop
          ? "desktop-titlebar relative z-30 flex shrink-0 items-center border-b border-line-soft bg-surface"
          : "relative z-30 flex h-10 shrink-0 items-center border-b border-line-soft bg-surface px-3"
      }
    >
      <div
        className={
          isDesktop
            ? "flex h-full w-full items-center gap-2 px-3"
            : "flex w-full min-w-0 items-center gap-2"
        }
      >
        {/* 品牌位兼作桌面拖拽区（只有右侧动作区是 no-drag）。
            用产品的手写字样（与登录页/启动动画同源），不再排一行「和鸣」正文。 */}
        <Wordmark width={78} className="shrink-0 text-ink" />

        <div data-testid="topbar-actions" className="app-no-drag ml-auto flex items-center gap-1">
          <PageMenu />
          <IconButton
            label="打开命令面板"
            icon={<SearchIcon width={16} height={16} />}
            onClick={onOpenSearch}
          />
          <IconButton
            label="快捷键帮助"
            icon={<KeyboardIcon width={16} height={16} />}
            onClick={onOpenShortcuts}
          />
          {/* 通知中心自带触发按钮（aria-label「通知中心」）与浮层，直接复用。 */}
          <NotificationCenter />
        </div>
      </div>
    </header>
  );
}
