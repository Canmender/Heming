/**
 * 页面级标签（一级 Tab）的统一外观（d.75）。
 *
 * 为什么抽出来：设置区 / 记忆区 / 插件区各自抄了一份完全相同的下划线 Tab 类名，
 * 智能体页 / 团队页又用了另一套「黑色药丸」——同一个「页面内一级切换」出现两种视觉语言。
 * 统一为下划线式（与设置区一致、也与本仓「选中项压住内容区分隔线」的做法一致），
 * 把类名收在这里，改一处五个页面一起变。
 *
 * 注意：这不是「所有 Tab 都必须长这样」。页内的二级筛选（团队页「全部/任务/日程」、
 * 信息中枢「检索/日程」）是工具栏里的分段控件，不属于本文件；它们保持紧凑按钮形态。
 */
export const PAGE_TABLIST = "flex gap-1";

/** 单个页面级 Tab 按钮（含选中/未选中两种状态）。 */
export const PAGE_TAB = "-mb-px border-b-2 px-3.5 py-2 text-[13px] transition-colors";
export const PAGE_TAB_ACTIVE = "border-b-ink font-semibold text-ink";
export const PAGE_TAB_IDLE = "border-b-transparent text-muted hover:text-ink";

/** 拼一个 Tab 的完整 className。 */
export function pageTabClass(active: boolean): string {
  return `${PAGE_TAB} ${active ? PAGE_TAB_ACTIVE : PAGE_TAB_IDLE}`;
}
