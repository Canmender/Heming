import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 当前打开的弹窗：只有「最内层」那个响应 Esc 与 Tab。
 *
 * 为什么需要判定：确认框常套在表单弹窗里，两层都监听 document 时，
 * Esc 会把两层一起关掉（React 的子组件 effect 先执行，注册顺序还和直觉相反）。
 * 按 DOM 嵌套判定「谁里面没有别的弹窗」，才是真正该退出的那一层。
 */
type DialogEntry = { token: symbol; panel: () => HTMLElement | null };
const openDialogs: DialogEntry[] = [];

function topToken(): symbol | null {
  const live = openDialogs
    .map((entry) => ({ entry, el: entry.panel() }))
    .filter((x): x is { entry: DialogEntry; el: HTMLElement } => x.el !== null);
  if (live.length === 0) return null;
  const hasNested = (el: HTMLElement) =>
    live.some((other) => other.el !== el && el.contains(other.el));
  const innermost = live.filter((x) => !hasNested(x.el));
  const pick = innermost.length > 0 ? innermost[innermost.length - 1] : live[live.length - 1];
  return pick.entry.token;
}

/**
 * 弹窗的键盘与焦点契约：Esc 关闭、Tab 在面板内循环、打开时把焦点移进来。
 *
 * 为什么单独一个 hook：焦点管理是本仓最易写错的部分，手写弹窗各写一套，
 * 迟早出现「这个弹窗 Esc 能关、那个不能」的不一致。
 */
export function useModalA11y(
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  options: {
    closeOnEscape?: boolean;
    autoFocus?: boolean;
    initialFocusRef?: RefObject<HTMLElement | null>;
    /** 弹窗当前是否处于打开态（常驻挂载的弹窗用 `open` 控制）。 */
    active?: boolean;
  } = {},
): void {
  const { closeOnEscape = true, autoFocus = true, initialFocusRef, active = true } = options;
  const token = useRef(Symbol("dialog"));
  const readPanel = useRef(() => panelRef.current);

  useEffect(() => {
    if (!active) return;
    const entry: DialogEntry = { token: token.current, panel: readPanel.current };
    openDialogs.push(entry);
    return () => {
      const index = openDialogs.indexOf(entry);
      if (index >= 0) openDialogs.splice(index, 1);
    };
  }, [active]);

  useEffect(() => {
    if (!active || !autoFocus) return;
    const panel = panelRef.current;
    if (!panel) return;
    const target = initialFocusRef?.current ?? panel.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
  }, [panelRef, autoFocus, initialFocusRef, active]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!active || topToken() !== token.current) return;
      if (closeOnEscape && e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      // 只按「是否可聚焦」筛，不按可见性筛：
      // `offsetParent` 在 fixed 定位的祖先里恒为 null，用它筛会把元素全滤掉。
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true",
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [panelRef, onClose, closeOnEscape, active]);
}
