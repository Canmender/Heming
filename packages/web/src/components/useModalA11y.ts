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
type DialogEntry = { token: symbol; panel: () => HTMLElement | null; modal: boolean };
const openDialogs: DialogEntry[] = [];

/**
 * 是否有「屏蔽背景的模态弹窗」正开着。给 App 的全局快捷键当门禁。
 *
 * 为什么 inert 不够：`inert` 只挡点击与焦点，挡不住挂在 window 上的 `keydown`。
 * 弹窗开着时按 Alt+3 仍然切页，而切走的子树里还留着那个弹窗——焦点归还、Esc
 * 归属、`inert` 计数全都落在一个不再属于当前视图的 DOM 上。
 *
 * 只统计模态弹窗：通知抽屉这类 `blockBackground:false` 的常驻浮层本来就允许
 * 用户直接去别的页面，拦它等于把「点外面就关」的轻量浮层升级成模态。
 * 面板未挂载（ref 为空）也不算，与 `topToken` 同一套存活判定。
 */
export function hasOpenModal(): boolean {
  return openDialogs.some((entry) => entry.modal && entry.panel() !== null);
}

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
 * 弹窗自己的「遮罩根」：从 panel 往上连续找 `fixed` 祖先，取最外面那个。
 *
 * 本仓 10 个遮罩一律写成 `fixed inset-0 …`，遮罩本身要么是自己、要么是祖先，
 * 而技能详情抽屉的关闭遮罩是 panel 的**兄弟**（`SkillsPage.tsx:170` 的 absolute button）。
 * 直接从 panel 开始屏蔽会把这个遮罩按钮一起 inert 掉——点遮罩关不上抽屉。
 * 用类名判定而不是 getComputedStyle：jsdom 不加载 Tailwind，算出来的 position 恒为 static。
 */
function overlayRoot(panel: HTMLElement): Element {
  let root: Element = panel;
  for (let node = panel.parentElement; node; node = node.parentElement) {
    if (!node.classList?.contains("fixed")) break;
    root = node;
  }
  return root;
}

/**
 * 已屏蔽元素 → 引用计数与「动之前的 inert」。
 *
 * 为什么要计数而不是各自记住原值再还原：React 先跑子组件 effect、再跑父组件，
 * 嵌套弹窗时**内层先屏蔽**。若各自还原，内层关闭会把外层还需要的屏蔽一起解除
 * （外层当初记录的「原值」已经是内层设上的 inert=true，解除后外层再还原就变成
 * 永久锁死）。计数保证只有最后一个释放者改属性。
 */
const blocked = new Map<Element, { count: number; inert: boolean }>();

function blockOne(el: Element): void {
  const cur = blocked.get(el);
  if (cur) {
    cur.count += 1;
    return;
  }
  blocked.set(el, { count: 1, inert: el.hasAttribute("inert") });
  el.toggleAttribute("inert", true);
}

function unblockOne(el: Element): void {
  const cur = blocked.get(el);
  if (!cur) return;
  cur.count -= 1;
  if (cur.count > 0) return;
  blocked.delete(el);
  el.toggleAttribute("inert", cur.inert);
}

/**
 * 屏蔽背景：把「不含本弹窗」的兄弟元素设 inert，关闭时按原值还原。
 *
 * 为什么不能直接 inert 最外层容器：本仓弹窗**没有 portal**，都渲染在页面子树里，
 * 屏蔽 shell 会把弹窗自己一起屏蔽掉（点不动、读屏也读不到）。
 * 所以从遮罩根往上走到 body，每一层只屏蔽「不在通往 panel 那条链上」的兄弟——
 * 遮罩根以内一律不碰，点遮罩关闭的口径不受影响；嵌套弹窗时内层屏蔽的是外层的
 * 内容区，语义上正是要屏蔽的。
 *
 * 只挂 inert，不补 aria-hidden：inert 子树本身就不进可访问性树，再挂一层是重复；
 * 而 jsdom 不实现 inert（也不影响 byRole 查询），挂 aria-hidden 反而会让
 * testing-library 查不到背景元素，把一堆无关用例拖进来。
 * React 18 无 inert 属性类型，一律用属性形式（同 App.tsx:130）。
 */
function blockSiblings(panel: HTMLElement): () => void {
  const touched: Element[] = [];
  let node: Element | null = overlayRoot(panel);
  while (node && node !== document.body) {
    const current: Element = node;
    const parent: Element | null = current.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === current) continue;
      // 常驻浮层自带逃生门：通话面板这类全屏层被弹窗压住时必须还能点（挂断/静音），
      // 屏蔽它等于把用户锁在通话里。见 `VoiceCallPanel.tsx` 的 data-a11y-keep。
      if (sibling.hasAttribute("data-a11y-keep")) continue;
      touched.push(sibling);
      blockOne(sibling);
    }
    node = parent;
  }
  return () => {
    for (const el of touched) unblockOne(el);
  };
}

/**
 * 弹窗的键盘与焦点契约：Esc 关闭、Tab 在面板内循环、打开时把焦点移进来、
 * 打开期间屏蔽背景、关闭后把焦点还给触发元素。
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
    /** 是否屏蔽背景。非模态浮层（通知抽屉这种点外面就关的）设 false。 */
    blockBackground?: boolean;
  } = {},
): void {
  const {
    closeOnEscape = true,
    autoFocus = true,
    initialFocusRef,
    active = true,
    blockBackground = true,
  } = options;
  const token = useRef(Symbol("dialog"));
  const readPanel = useRef(() => panelRef.current);

  useEffect(() => {
    if (!active) return;
    const entry: DialogEntry = {
      token: token.current,
      panel: readPanel.current,
      modal: blockBackground,
    };
    openDialogs.push(entry);
    return () => {
      const index = openDialogs.indexOf(entry);
      if (index >= 0) openDialogs.splice(index, 1);
    };
  }, [active, blockBackground]);

  // 声明顺序即执行顺序：必须排在下面的聚焦 effect 之前，
  // 否则记录到的「触发元素」已经是弹窗里的按钮了。
  useEffect(() => {
    if (!active) return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusBefore = document.activeElement;
    // 焦点本来就在 panel 里（常驻挂载的浮层重新打开）时没有「触发元素」可还。
    const trigger =
      focusBefore instanceof HTMLElement && !panel.contains(focusBefore) ? focusBefore : null;
    const unblock = blockBackground ? blockSiblings(panel) : null;
    return () => {
      unblock?.();
      if (!trigger?.isConnected) return;
      // 只在焦点已经无处可去时归还：弹窗卸载后 activeElement 落到 body，
      // 或还停在那个已经不在文档里的 panel 上。关闭方主动把焦点移到别处
      // （跳会话、开下一个弹窗）时不抢。
      const now = document.activeElement;
      const lost = !now || now === document.body || !now.isConnected;
      if (lost) trigger.focus();
    };
  }, [panelRef, blockBackground, active]);

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
