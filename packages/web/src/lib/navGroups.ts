import type { NavPage } from "../store/ui.js";

/**
 * 导航分组：53px 图标轨放不下分组标题，用「组内紧凑 + 组间细线」表达。
 *
 * 导航已收口为固定 8 项，分组按「干活 → 能力 → 资料 → 系统」：
 * - `work`（工作台）：主页 / 团队 / 智能体；
 * - `capability`（能力）：插件（安装后带入技能、工具、MCP 服务与内置插件）；
 * - `resources`（资料）：记忆 / 知识库 / 模型；
 * - `system`（系统）：设置。
 *
 * 为什么固定分组而不是让用户自定义组：导航顺序本来就是用户可调的（设置区 · 导航），
 * 再加一层「组可编辑」会把一个问题变成两个（顺序 + 归属），且 localStorage 里的旧顺序
 * 迁移规则会复杂到没法解释。这里的分组只是**视觉分隔**：用户把某页拖出组时，
 * 分隔线跟着「组变化」的位置走，不会出现空组或幽灵线。
 *
 * 幕僚 / 信息中枢 / 自动化已不是导航页（可安装的内置插件，入口在插件页的模块卡），
 * 所以这里不再有「智能模块」组；`navGroupOf` 对未知页回落到系统组，只为兼容旧调用。
 */
export type NavGroupId = "work" | "capability" | "resources" | "system";

export const NAV_GROUP_LABEL: Record<NavGroupId, string> = {
  work: "工作台",
  capability: "能力",
  resources: "资料",
  system: "系统",
};

/**
 * 页面 → 分组。只登记 8 个导航页；新增导航页时这里与 DEFAULT_NAV_ORDER 一起改，
 * 测试会钉住「两边集合一致」（避免出现没有分组的页或死项）。
 */
export const NAV_GROUP_OF: Partial<Record<NavPage, NavGroupId>> = {
  home: "work",
  team: "work",
  chat: "work",
  plugins: "capability",
  memory: "resources",
  vault: "resources",
  model: "resources",
  settings: "system",
};

/** 分组查询：非导航页（已退出导航的模块页）回落到系统组，不抛。 */
export function navGroupOf(page: NavPage): NavGroupId {
  return NAV_GROUP_OF[page] ?? "system";
}

/**
 * 两个相邻导航项之间是否需要画分组细线。
 *
 * 只在「有前后两项且分组不同」时为真——第一项之前不会多出一条悬空的线。
 */
export function needsGroupDivider(prev: NavPage | null, next: NavPage): boolean {
  return prev !== null && navGroupOf(prev) !== navGroupOf(next);
}
