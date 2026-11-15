import { PALETTE_PAGES } from "../lib/palette/pages.js";
import { Dialog } from "./ui/Dialog.js";
import { Kbd } from "./ui/Kbd.js";

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
  /** 按键序列（每个元素渲染成一个键帽，并列排布，中间不加「+」字）。 */
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
 *
 * 顺序直接用 `PALETTE_PAGES` 的数组顺序——侧栏「主导航」、命令面板与这里读的是同一份正表，
 * 三处顺序天然一致，不再二次排序（此前按数字值排会得到 1、2、5、6、8、0 这种对不上号的顺序）。
 */
function navRows(): ShortcutRow[] {
  return PALETTE_PAGES.filter((p) => Boolean(p.digit)).map((p) => ({
    keys: ["Alt", String(p.digit)],
    label: p.label,
  }));
}

/** 键帽（2026-11-14 审计 C2）：全站唯一外观，写在 `ui/Kbd`；组合键并列渲染，不加「+」字。 */
function KeyCaps({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((k, i) => (
        <Kbd key={`${k}-${i}`}>{k}</Kbd>
      ))}
    </span>
  );
}

function Group({ title, rows }: { title: string; rows: ShortcutRow[] }) {
  return (
    <section className="mb-4 last:mb-0">
      <h3 className="mb-2 text-ui-xs font-semibold uppercase tracking-wider text-muted">{title}</h3>
      <dl className="divide-y divide-line-soft">
        {rows.map((row) => (
          <div key={`${title}-${row.label}`} className="flex items-center justify-between gap-3 py-2">
            <dt className="min-w-0 truncate text-ui-sm text-ink">{row.label}</dt>
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
  return (
    <Dialog
      ariaLabel="快捷键"
      title="快捷键"
      size="sm"
      onClose={onClose}
      closeLabel="关闭快捷键"
      bodyClassName="px-4 py-3"
      footer={
        <p className="mr-auto ui-body-sm text-muted">
          输入框内不会触发「?」；随时可按 <Kbd>?</Kbd> 再次打开。
        </p>
      }
    >
      <Group title="导航" rows={navRows()} />
      <Group title="全局" rows={GLOBAL_ROWS} />
      <Group title="编辑" rows={EDIT_ROWS} />
    </Dialog>
  );
}
