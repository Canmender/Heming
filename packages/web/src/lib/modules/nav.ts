import type { NavPage, Page } from "../../store/ui.js";
import type { PalettePage } from "../palette/pages.js";
import { moduleForPage } from "./registry.js";
import { isModuleEffective, type ModuleState } from "./store.js";

/**
 * 模块开关 → 导航/命令面板/路由的**纯函数**接线（d.70）。
 *
 * 为什么不把这些判断散在各组件里：
 * - 同一个问题（「这页现在能用吗」）在导航轨、命令面板、App 路由、设置区导航顺序、
 *   通知/桌宠跳转五处出现，写五遍必然漂移；
 * - 五个地方都要能单测，而组件测试又重又慢——纯函数是唯一能低成本钉住口径的形态。
 */

/** 页面当前是否可用：非模块页恒可用；模块页要求其模块**实际生效**。 */
export function isPageAvailable(page: Page, state: ModuleState): boolean {
  const mod = moduleForPage(page);
  return mod ? isModuleEffective(state, mod.id) : true;
}

/** 过滤导航顺序：停用模块的页面不进导航（重新启用后按原顺序回来）。 */
export function filterNavOrder(order: readonly NavPage[], state: ModuleState): NavPage[] {
  return order.filter((page) => isPageAvailable(page, state));
}

/** 过滤命令面板页面目录：停用模块的页面不出现在「页面跳转」组里。 */
export function filterPalettePages(
  pages: readonly PalettePage[],
  state: ModuleState,
): PalettePage[] {
  return pages.filter((item) => isPageAvailable(item.page, state));
}

/**
 * 当前页面被停用时的落点。
 *
 * 停用瞬间（在设置区点开关）用户正停在设置区，不受影响；但如果是「通知/桌宠/旧链接
 * 跳到一个已停用页」，或刷新后 localStorage 里 page 仍是已停用页，就统一回主页，
 * 而不是白屏或渲染一个不该存在的页面。
 */
export function fallbackPage(page: Page, state: ModuleState): Page {
  return isPageAvailable(page, state) ? page : "home";
}
