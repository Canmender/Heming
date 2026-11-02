import { useRef } from "react";
import { PALETTE_PAGES } from "../lib/palette/pages.js";
import { useModalA11y } from "./useModalA11y.js";
import { XIcon } from "./icons.js";

/**
 * 快捷键帮助面板（d.61 · UX 第二轮 F 轨）。
 *
 * 为什么导航项不在这里写死：Alt+数字 的唯一真源是 `lib/palette/pages.ts`
 * （命令面板与它共用）。这里再抄一份数字 → 两份迟早漂移（改键位时只改一处，
 * 帮助面板就会教用户按错的键）。所以导航组由 `PALETTE_PAGES` 现场生成。
 *
 * 其它快捷键（Ctrl+K / Esc / Enter / Shift+Enter / ?）没有单一数据源，
 * 用下面的静态表——它们同时出现在实现里，注释互相指向，改实现时记得改这里。
 */
interface ShortcutRow {
  /** 按键序列（每个元素渲染成一个 kbd，中间加 +）。 */
  keys: string[];
  label: string;
}

const GLOBAL_ROWS: ShortcutRow[] = [
  { keys: ["Ctrl", "K"], label: "全局搜索（命令面板）" },
  { keys: ["?"], label: "打开快捷键帮助" },
  { keys: ["Ctrl", "/"], label: "打开快捷键帮助（备用键）" },
  { keys: ["Esc"], label: "关闭当前弹窗 / 取消" },
];

const EDIT_ROWS: ShortcutRow[] = [
  { keys: ["Enter"], label: "发送消息 / 确认" },
  { keys: ["Shift", "Enter"], label: "换行（不发送）" },
];

/**
 * 导航组：从 `PALETTE_PAGES` 里取「有 Alt 数字」的页面。
 * 排序按数字键（1..8 在前，0 在后），方便用户按顺序找。
 */
function navRows(): ShortcutRow[] {
  return PALETTE_PAGES.filter((p) => Boolean(p.digit))
    .slice()
    .sort((a, b) => {
      const rank = (d?: string) => (d === "0" ? 99 : Number(d));
      return rank(a.digit) - rank(b.digit);
    })
    .map((p) => ({ keys: ["Alt", String(p.digit)], label: p.label }));
}

function KeyCaps({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((k, i) => (
        <span key={`${k}-${i}`} className="flex items-center gap-1">
          {i > 0 && <span className="text-[10px] text-muted">+</span>}
          <kbd className="rounded-sm border border-line px-1.5 py-0.5 text-[10px] font-medium text-[#444] shadow-card">
            {k}
          </kbd>
        </span>
      ))}
    </span>
  );
}

function Group({ title, rows }: { title: string; rows: ShortcutRow[] }) {
  return (
    <section className="mb-4 last:mb-0">
      <h3 className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-muted">{title}</h3>
      <dl className="divide-y divide-[#f4f4f4]">
        {rows.map((row) => (
          <div key={`${title}-${row.label}`} className="flex items-center justify-between gap-3 py-1.5">
            <dt className="min-w-0 truncate text-[12px] text-ink">{row.label}</dt>
            <dd>
              <KeyCaps keys={row.keys} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * 快捷键帮助弹窗。
 *
 * Esc / 焦点陷阱 / 焦点归还全部交给 `useModalA11y`：它按「最内层弹窗」判定 Esc，
 * 所以这个面板开着时按 Esc 只关自己，不会误关下层别的弹窗（与全仓弹窗口径一致）。
 */
export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, onClose);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="快捷键"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-[min(480px,92vw)] flex-col overflow-hidden rounded-xl border border-[#ececec] bg-white shadow-card"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
          <span className="text-[13px] font-bold">快捷键</span>
          <button
            type="button"
            aria-label="关闭快捷键"
            onClick={onClose}
            className="shrink-0 rounded-sm p-1 text-muted hover:bg-[#f0f0f0] hover:text-ink"
          >
            <XIcon width={16} height={16} aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <Group title="导航" rows={navRows()} />
          <Group title="全局" rows={GLOBAL_ROWS} />
          <Group title="编辑" rows={EDIT_ROWS} />
        </div>
        <p className="border-t border-line-soft px-4 py-2 text-[11px] text-muted">
          输入框内不会触发「?」；随时可按 <kbd className="rounded-sm border border-line px-1">?</kbd> 再次打开。
        </p>
      </div>
    </div>
  );
}
