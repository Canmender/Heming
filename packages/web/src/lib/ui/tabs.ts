import { useCallback, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * 页面级标签的键盘行为（③-1 交互态收口）。
 *
 * 背景：本仓 4 个带一级页签的页面（记忆 / 能力 / 技能 / 团队）都只写了
 * `role="tablist"` + `role="tab"` + `aria-selected`，但**没有** roving tabindex，
 * 也没有 ←/→/Home/End —— 读屏能念出「标签页」，键盘用户却要 Tab 穿过全部页签才能
 * 走到内容区，且方向键毫无反应。WAI-ARIA APG 的 Tabs 模式要求：
 *   · 页签组只占一个 Tab 停靠点（选中页签 tabIndex=0，其余 -1）；
 *   · ←/→（水平）或 ↑/↓（垂直）在页签间移动并**同时切换内容**；
 *   · Home/End 跳到首/尾。
 *
 * 为什么做成 hook 而不是 <Tabs> 组件：四个页面的页签外观不同（下划线式 / 药丸式，
 * 记忆页还有计数徽标、技能页用 Button 基元），强行统一结构会改动它们既有的视觉与
 * 测试契约。这里只收口「行为」，外观仍归各页面与 `tabStyles.ts`。
 */

export type TabOrientation = "horizontal" | "vertical";

/**
 * 算出按键后的目标页签下标；不该处理时返回 `null`。
 *
 * 纯函数，便于单测覆盖边界（首/尾、循环、垂直方向、非法当前下标）。
 * 方向键默认循环（APG 允许，且本仓页签数少，循环比卡住更顺手）。
 */
export function nextTabIndex(
  key: string,
  current: number,
  count: number,
  orientation: TabOrientation = "horizontal",
  loop = true,
): number | null {
  if (count <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;

  const back = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
  const forward = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
  // 当前下标越界（页签集合变了但状态还没跟上）时按第一项处理，避免方向键失灵。
  const base = current < 0 || current >= count ? 0 : current;

  if (key === forward) {
    if (base === count - 1) return loop ? 0 : base;
    return base + 1;
  }
  if (key === back) {
    if (base === 0) return loop ? count - 1 : base;
    return base - 1;
  }
  return null;
}

export interface RovingTabsOptions {
  /** 页签数量（必须与 DOM 里的 role="tab" 数量一致）。 */
  count: number;
  /** 当前选中的下标。 */
  activeIndex: number;
  /** 选中变化回调（方向键/Home/End 触发，语义同点击）。 */
  onChange: (index: number) => void;
  orientation?: TabOrientation;
  /** 方向键是否在首尾循环，默认 true。 */
  loop?: boolean;
}

export interface RovingTabs {
  /** 挂到每个页签上的 ref：`ref={getTabRef(i)}`。 */
  getTabRef: (index: number) => (el: HTMLElement | null) => void;
  /** 每个页签的 tabIndex：选中项 0，其余 -1。 */
  tabIndexFor: (index: number) => 0 | -1;
  /** 挂到 tablist 或每个页签上的 keydown（冒泡到 tablist 亦可）。 */
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  /** 手动把焦点移到某个页签（如点击后程序切换）。 */
  focusTab: (index: number) => void;
}

/**
 * roving tabindex + 方向键导航。
 *
 * 用法：
 * ```tsx
 * const tabs = useRovingTabs({ count: 3, activeIndex, onChange: setActive });
 * <div role="tablist" onKeyDown={tabs.onKeyDown}>
 *   {keys.map((key, i) => (
 *     <button role="tab" ref={tabs.getTabRef(i)} tabIndex={tabs.tabIndexFor(i)}
 *             aria-selected={i === activeIndex} onClick={() => setActive(i)}>
 * ```
 * 注意：页签顺序必须与 `count` 的下标一致（记忆页的 `tabOrder`、团队页的 `TABS`
 * 都是稳定数组，符合要求）。
 */
export function useRovingTabs({
  count,
  activeIndex,
  onChange,
  orientation = "horizontal",
  loop = true,
}: RovingTabsOptions): RovingTabs {
  const refs = useRef<Array<HTMLElement | null>>([]);
  // 每个页签一个稳定 ref 回调：避免每次渲染都先 detach 再 attach（React 19 会多跑一轮）。
  const setters = useMemo(
    () =>
      Array.from({ length: count }, (_, index) => (el: HTMLElement | null) => {
        refs.current[index] = el;
      }),
    [count],
  );

  const focusTab = useCallback((index: number) => {
    refs.current[index]?.focus();
  }, []);

  const tabIndexFor = useCallback(
    (index: number): 0 | -1 => {
      const active = activeIndex >= 0 && activeIndex < count ? activeIndex : 0;
      return index === active ? 0 : -1;
    },
    [activeIndex, count],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const next = nextTabIndex(event.key, activeIndex, count, orientation, loop);
      if (next === null) return;
      // 只吞掉本组件处理的方向键/Home/End，其它键（Enter/Space/Tab）照常冒泡。
      event.preventDefault();
      if (next !== activeIndex) onChange(next);
      focusTab(next);
    },
    [activeIndex, count, focusTab, loop, onChange, orientation],
  );

  return {
    getTabRef: useCallback((index: number) => setters[index] ?? (() => undefined), [setters]),
    tabIndexFor,
    onKeyDown,
    focusTab,
  };
}