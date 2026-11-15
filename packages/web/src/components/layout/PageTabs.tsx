/**
 * PageTabs：页面级一级页签的唯一结构实现（下划线式）。
 *
 * 为什么要有它：插件 / 团队 / 模型三个页面此前各自手写页签，位置落成三套——
 * 模型页放在页头下方的 headerExtra；团队页塞进右栏 <main>（被 300px 名册挤到右边，
 * 且「工作台」视图下整条消失）；插件页埋在统计卡与提示条之后、缩进还和内容列不同。
 * 同一层级、同一含义的切换，在三页上落在三个位置，切换页面时视线要重新找。
 *
 * 现在这层收在一处，页面只交 items / active / onChange：
 *   · 外观来自 `lib/ui/tabStyles.ts`（PAGE_TABLIST / pageTabClass，选中项 2px 下划线）；
 *   · 键盘来自 `lib/ui/tabs.ts`（整组一个 Tab 停靠点 + ←/→/Home/End，APG Tabs）；
 *   · 位置由 `PageShell` 的 `tabs` 槽提供：紧贴页头、通栏、与页头同左右内边距，
 *     选中项的下划线压住该行底边——三页因此在任何窗口宽度下都对齐到同一基线。
 *
 * tabpanel 约定：id = `${idPrefix}-${key}-panel`，aria-labelledby 回指它的页签。
 *
 * 用法：
 * ```tsx
 * <PageShell
 *   tabs={<PageTabs label="模型页分区" idPrefix="model" items={TABS} active={tab} onChange={setTab} />}
 *   …
 * >
 *   <div role="tabpanel" id={`model-${tab}-panel`} aria-labelledby={`model-${tab}-tab`}>…</div>
 * </PageShell>
 * ```
 */
import type { ReactNode } from "react";
import { PAGE_TABLIST, pageTabClass } from "../../lib/ui/tabStyles.js";
import { useRovingTabs } from "../../lib/ui/tabs.js";

export interface PageTabItem {
  /** 稳定 key：同时作为 tab / panel 的 id 片段。 */
  key: string;
  label: string;
  /**
   * 14px 图标（icons.tsx 同一套描边）：三个页面的一级页签都带图标，
   * 视觉语言才一致；纯文字页签留在页内二级筛选用。
   */
  icon?: ReactNode;
}

export interface PageTabsProps {
  /** 无障碍组名（如「模型页分区」）；读屏与测试都靠它定位。 */
  label: string;
  items: readonly PageTabItem[];
  /** 当前选中项的 key。 */
  active: string;
  onChange: (key: string) => void;
  /**
   * id 前缀：tab = `${idPrefix}-${key}-tab`，panel = `${idPrefix}-${key}-panel`。
   * 同屏可能挂两份的页面传 `useId()` 生成的前缀，避免静态 id 撞车（团队页）。
   */
  idPrefix: string;
}

export function PageTabs({ label, items, active, onChange, idPrefix }: PageTabsProps) {
  const tabs = useRovingTabs({
    count: items.length,
    activeIndex: items.findIndex((item) => item.key === active),
    onChange: (index) => onChange(items[index].key),
  });

  return (
    <div role="tablist" aria-label={label} className={PAGE_TABLIST} onKeyDown={tabs.onKeyDown}>
      {items.map((item, index) => {
        const selected = item.key === active;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            id={`${idPrefix}-${item.key}-tab`}
            ref={tabs.getTabRef(index)}
            tabIndex={tabs.tabIndexFor(index)}
            // 只有选中项引用真实存在的面板；未选中的不写悬空引用。
            aria-controls={selected ? `${idPrefix}-${item.key}-panel` : undefined}
            aria-selected={selected}
            onClick={() => onChange(item.key)}
            // 图标与文案对齐靠 inline-flex + gap；单字页签（如「模型」）也走同一套。
            className={`${pageTabClass(selected)} inline-flex items-center gap-1.5 whitespace-nowrap`}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
