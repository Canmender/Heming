import type { NavPage } from "../store/ui.js";
import { isPluginPagePage } from "./pages/ids.js";

/**
 * 导航分组：53px 图标轨放不下分组标题，用「组内紧凑 + 组间细线」表达。
 *
 * 导航默认 8 项，分组按「干活 → 能力 → 资料 → 系统」：
 * - `work`（工作台）：主页 / 团队 / 智能体；
 * - `capability`（能力）：插件（安装后带入技能、工具、MCP 服务与页面），
 *   以及**已安装插件的页面入口**（声明式插件页与沙箱 bundle 插件页，d.128 起追加在
 *   导航最下面，分组表里仍算「能力」，所以末尾会有一次「系统 → 能力」的分隔线，
 *   位置稳定不跳动）；
 * - `resources`（资料）：记忆 / 知识库 / 模型；
 * - `system`（系统）：设置。
 *
 * 为什么固定分组而不是让用户自定义组：导航顺序本来就是用户可调的（设置区 · 导航），
 * 再加一层「组可编辑」会把一个问题变成两个（顺序 + 归属），且 localStorage 里的旧顺序
 * 迁移规则会复杂到没法解释。这里的分组只是**视觉分隔**：用户把某页拖出组时，
 * 分隔线跟着「组变化」的位置走，不会出现空组或幽灵线。
 *
 * 插件页在本表里没有静态归属（页面 id 是安装后才有的 `plugin:<id>`），
 * 由 `navGroupOf` 统一算「能力」；表只表达宿主 8 页的归属。
 */
export type NavGroupId = "work" | "capability" | "resources" | "system";

export const NAV_GROUP_LABEL: Record<NavGroupId, string> = {
  work: "工作台",
  capability: "能力",
  resources: "资料",
  system: "系统",
};

/**
 * 页面 → 分组。只列 8 个固定导航页；插件页由 `navGroupOf` 动态归入能力组。
 * 新增宿主导航页时这里与 `DEFAULT_NAV_ORDER` 一起改，测试会钉住集合一致。
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

/** 分组查询：插件页面一律算「能力」；不在表里的页回落到系统组，不抛。 */
export function navGroupOf(page: NavPage): NavGroupId {
  // d.124：插件页面是「装出来的能力」，与插件同一组（导航末尾的分隔线口径不变）。
  if (isPluginPagePage(page)) return "capability";
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
