import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "../store/auth.js";
import { useUiStore } from "../store/ui.js";
import { Button } from "./ui/Button.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

/**
 * 用户头像 + 账户菜单（d.147.4.88）。
 *
 * 为什么从顶栏搬到会话栏底部：顶栏右侧是「页面级动作」（命令面板/快捷键/通知），
 * 「我是谁」不属于动作区。放到左下角之后，视线起点是身份、终点是内容，
 * 和 Codex 这类桌面智能体一致，也把顶栏右端让给真正的操作。
 *
 * 菜单**向上**弹：它贴着窗口底边，向下弹会被裁掉。侧栏常驻（d.147.4.89 起不再
 * 可折叠），所以这里只保留「头像 + 名字」一种排法，不再分叉收起态。
 */
export function AccountMenu() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const setPage = useUiStore((s) => s.setPage);
  const displayName = user?.displayName?.trim() || "我";

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: Event) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div ref={rootRef} className="relative w-full">
      <button
        type="button"
        aria-label={`账户：${displayName}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={displayName}
        onClick={() => setMenuOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-subtle-2"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-subtle-3 text-ui-sm font-semibold text-body">
          {user?.avatar ? (
            <img src={user.avatar} alt="" className="h-full w-full rounded-full object-cover" />
          ) : (
            displayName.slice(0, 1)
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-ui-sm text-body">{displayName}</span>
      </button>
      {menuOpen ? (
        <div
          role="menu"
          aria-label="账户菜单"
          className="absolute bottom-full left-0 right-0 z-50 mb-1 rounded-lg border border-line bg-surface p-1 text-ui-sm ui-overlay-shadow"
        >
          <button
            type="button"
            role="menuitem"
            className="block w-full rounded-sm px-2 py-1.5 text-left text-body hover:bg-subtle-3 hover:text-ink"
            onClick={() => {
              setMenuOpen(false);
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
              setMenuOpen(false);
              setConfirmLogout(true);
            }}
          >
            退出登录
          </button>
        </div>
      ) : null}

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
    </div>
  );
}
