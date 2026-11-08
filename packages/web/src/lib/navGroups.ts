import type { NavPage } from "../store/ui.js";

/**
 * 导航分组（d.72 布局轮）：53px 图标轨放不下分组标题，用「组内紧凑 + 组间细线」表达。
 *
 * 为什么固定分组而不是让用户自定义组：导航顺序本来就是用户可调的（设置区 · 导航），
 * 再加一层「组可编辑」会把一个问题变成两个（顺序 + 归属），且 localStorage 里的旧顺序
 * 迁移规则会复杂到没法解释。这里的分组只是**视觉分隔**：
 * - 默认顺序按「干活 → 智能模块 → 资料 → 系统」排；
 * - 用户把某页拖出组时，分隔线跟着「组变化」的位置走，不会出现空组或幽灵线。
 *
 * 与模块可插拔（d.70）的关系：幕僚 / 信息中枢 / 自动化属于「智能模块」组；
 * 它们被停用时整组可能只剩分隔线的相邻项——渲染端按「可见相邻项」算分隔线，
 * 不会留下孤立的细线。
 */
export type NavGroupId = "work" | "modules" | "resources" | "system";

export const NAV_GROUP_LABEL: Record<NavGroupId, string> = {
  work: "工作台",
  modules: "智能模块",
  resources: "资料与能力",
  system: "系统",
};

/** 页面 → 分组。新增宿主页时这里与 DEFAULT_NAV_ORDER 一起改，测试会钉住覆盖关系。 */
export const NAV_GROUP_OF: Record<NavPage, NavGroupId> = {
  home: "work",
  chat: "work",
  team: "work",
  staff: "modules",
  infohub: "modules",
  automations: "modules",
  modelroute: "modules",
  model: "resources",
  vault: "resources",
  memory: "resources",
  plugins: "resources",
  settings: "system",
};

export function navGroupOf(page: NavPage): NavGroupId {
  return NAV_GROUP_OF[page] ?? "system";
}

/**
 * 两个相邻导航项之间是否需要画分组细线。
 *
 * 只在「有前后两项且分组不同」时为真——第一项之前、以及模块停用导致的跳变之后
 * 都不会多出一条悬空的线。
 */
export function needsGroupDivider(prev: NavPage | null, next: NavPage): boolean {
  return prev !== null && navGroupOf(prev) !== navGroupOf(next);
}
