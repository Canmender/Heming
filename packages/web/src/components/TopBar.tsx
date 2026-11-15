import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "../store/auth.js";
import { useUiStore } from "../store/ui.js";
import { IconButton } from "./ui/IconButton.js";
import { Button } from "./ui/Button.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { KeyboardIcon, SearchIcon } from "./icons.js";
import { PageMenu } from "./PageMenu.js";
import { NotificationCenter } from "./NotificationCenter.js";

/** 顶栏高度档位：浏览器与桌面共用 40px（8pt 网格），只是桌面端还要兼做窗口拖拽带。 */
export function TopBar({
  onOpenSearch,
  onOpenShortcuts,
}: {
  onOpenSearch: () => void;
  onOpenShortcuts: () => void;
}) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const setPage = useUiStore((s) => s.setPage);
  const displayName = user?.displayName?.trim() || "我";

  /**
   * 桌面端顶栏复用 `.desktop-titlebar`（拖拽区 + 让开右侧窗口控件），
   * 浏览器端没有窗口壳，就退化成一条普通 h-10 顶栏——两种形态结构一致，
   * 只是类名不同（测试与设计审计都按 `[data-testid="topbar"]` 定位）。
   */
  const isDesktop = typeof window !== "undefined" && !!window.heming;

  const [accountOpen, setAccountOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!accountOpen) return;
    const onDown = (e: Event) => {
      if (!accountRef.current?.contains(e.target as Node)) setAccountOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAccountOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [accountOpen]);

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
        {/* 品牌位兼作桌面拖拽区（只有右侧动作区是 no-drag）。 */}
        <span className="shrink-0 text-ui-sm font-semibold tracking-wide text-ink">和鸣</span>

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
          <div ref={accountRef} className="relative">
            <button
              type="button"
              aria-label={`账户：${displayName}`}
              aria-haspopup="menu"
              aria-expanded={accountOpen}
              onClick={() => setAccountOpen((v) => !v)}
              className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-subtle-3 text-ui-sm font-semibold text-body transition-colors hover:bg-subtle-4"
            >
              {user?.avatar ? (
                <img src={user.avatar} alt="" className="h-full w-full rounded-full object-cover" />
              ) : (
                displayName.slice(0, 1)
              )}
            </button>
            {accountOpen ? (
              <div
                role="menu"
                aria-label="账户菜单"
                className="absolute right-0 top-full z-50 mt-1 w-40 rounded-lg border border-line bg-surface p-1 text-ui-sm ui-overlay-shadow"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full rounded-sm px-2 py-1.5 text-left text-body hover:bg-subtle-3 hover:text-ink"
                  onClick={() => {
                    setAccountOpen(false);
                    setPage("settings");
                  }}
                >
                  设置
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full rounded-sm px-2 py-1.5 text-left text-danger hover:bg-subtle-3"
                  onClick={() => {
                    setAccountOpen(false);
                    setConfirmLogout(true);
                  }}
                >
                  退出登录
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {confirmLogout ? (
        <ConfirmDialog
          title="退出登录"
          onCancel={() => setConfirmLogout(false)}
          footer={
            <>
              <Button type="button" onClick={() => setConfirmLogout(false)} size="md" variant="ghost">
                取消
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setConfirmLogout(false);
                  logout();
                }}
                size="md"
                variant="danger"
              >
                退出登录
              </Button>
            </>
          }
        >
          <p className="ui-caption leading-6">退出后需要重新登录才能继续使用和鸣。</p>
        </ConfirmDialog>
      ) : null}
    </header>
  );
}
