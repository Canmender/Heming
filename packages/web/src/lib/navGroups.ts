import type { NavPage } from "../store/ui.js";
import { isPluginPagePage } from "./pages/ids.js";

/**
 * 导航分组：53px 图标轨放不下分组标题，用「组内紧凑 + 组间细线」表达。
 *
 * 导航默认 8 项，分组按「干活 → 能力 → 资料 → 系统」：
 * - `work`（工作台）：主页 / 团队 / 智能体；
 * - `capability`（能力）：插件（安装后带入技能、工具、MCP 服务与内置插件），
 *   以及**已安装模块的入口**（幕僚 / 信息中枢 / 自动化 / 工作流；d.119 起追加在导航最下面，
 *   分组表里仍算「能力」，所以末尾会有一次「系统 → 能力」的分隔线，位置稳定不跳动）；
 * - `resources`（资料）：记忆 / 知识库 / 模型；
 * - `system`（系统）：设置。
 *
 * 为什么固定分组而不是让用户自定义组：导航顺序本来就是用户可调的（设置区 · 导航），
 * 再加一层「组可编辑」会把一个问题变成两个（顺序 + 归属），且 localStorage 里的旧顺序
 * 迁移规则会复杂到没法解释。这里的分组只是**视觉分隔**：用户把某页拖出组时，
 * 分隔线跟着「组变化」的位置走，不会出现空组或幽灵线。
 *
 * 模块页在本表里有归属（都算「能力」），但它们是否**出现在导航里**由
 * `modules/nav.ts` 的 `withModuleNav` 按安装/启用状态决定——分组表本身不表达可见性。
 */
export type NavGroupId = "work" | "capability" | "resources" | "system";

export const NAV_GROUP_LABEL: Record<NavGroupId, string> = {
  work: "工作台",
  capability: "能力",
  resources: "资料",
  system: "系统",
};

/**
 * 页面 → 分组。8 个固定导航页 + 4 个模块页（模块入口装上才进轨）。
 * 新增导航页/模块时这里与 `DEFAULT_NAV_ORDER` / 模块注册表一起改，测试会钉住集合一致。
 */
export const NAV_GROUP_OF: Partial<Record<NavPage, NavGroupId>> = {
  home: "work",
  team: "work",
  chat: "work",
  plugins: "capability",
  // 模块入口与「插件」同一组：它们就是从插件页装出来的能力
  staff: "capability",
  infohub: "capability",
  automations: "capability",
  workflows: "capability",
  memory: "resources",
  vault: "resources",
  model: "resources",
  settings: "system",
};

/** 分组查询：插件页面一律算「能力」；不在表里的页回落到系统组，不抛。 */
export function navGroupOf(page: NavPage): NavGroupId {
  // d.124：插件页面是「装出来的能力」，与插件/模块同一组（导航末尾的分隔线口径不变）。
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
