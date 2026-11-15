import { useEffect, useRef, useState } from "react";
import type { Page } from "../store/ui.js";
import { useUiStore } from "../store/ui.js";
import { PALETTE_PAGES } from "../lib/palette/pages.js";
import { usePluginPageEntries } from "../lib/pages/usePluginPages.js";
import { ChevronIcon } from "./icons.js";
import { FOCUS_RING } from "../lib/a11y/focus.js";

/**
 * 顶栏「页面」菜单：导航轨删除后，页面入口只留两处——命令面板（Ctrl K）与这里。
 *
 * 为什么菜单用「点开再选」而不是常驻一排 tab：用户要的是「默认只有会话」，其余页面
 * 是低频动作；一排 tab 会把顶栏重新变成导航条，等于绕一圈回到刚删掉的形态。
 *
 * 页面清单不在本组件里硬编码：正表是 `PALETTE_PAGES`（命令面板/快捷键帮助共用同一份），
 * 插件页从注册表投影追加，`available` 为 false（未装/停用）的不出现。
 *
 * 键盘：打开后焦点进第一项；Esc 关闭并把焦点还给触发按钮；点外部关闭。
 * 菜单项按页面名渲染（innerText 就是页面名，测试与设计审计都按这个名字选）。
 */
export function PageMenu() {
  const page = useUiStore((s) => s.page);
  const setPage = useUiStore((s) => s.setPage);
  const pluginPages = usePluginPageEntries();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  /** 菜单项：8 个固定页 + 已装可用插件页（页面标题是插件的名字，由主进程/注册表给）。 */
  const items: { page: Page; label: string }[] = [
    ...PALETTE_PAGES.map((p) => ({ page: p.page, label: p.label })),
    ...pluginPages.filter((p) => p.available).map((p) => ({ page: p.pageId as Page, label: p.title })),
  ];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (next: Page) => {
    setOpen(false);
    setPage(next);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label="打开页面菜单"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-8 items-center gap-1 rounded-md px-2 text-ui-sm text-body transition-colors hover:bg-subtle-2 hover:text-ink motion-reduce:transition-none ${FOCUS_RING}`}
      >
        页面
        <ChevronIcon width={12} height={12} aria-hidden="true" className="rotate-90" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="页面菜单"
          className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-line bg-surface p-1 text-ui-sm ui-overlay-shadow"
        >
          {items.map((item, index) => (
            <button
              key={item.page}
              type="button"
              role="menuitem"
              autoFocus={index === 0}
              aria-current={item.page === page ? "page" : undefined}
              onClick={() => choose(item.page)}
              className="block w-full rounded-sm px-2 py-1.5 text-left text-body transition-colors hover:bg-subtle-3 hover:text-ink"
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
