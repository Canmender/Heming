import type { NavPage, Page } from "../../store/ui.js";
import type { PalettePage } from "../palette/pages.js";
import { BUILTIN_MODULES, moduleForPage } from "./registry.js";
import { isModuleEffective, type ModuleState } from "./store.js";

/**
 * 模块开关 → 导航/命令面板/路由的**纯函数**接线（d.70）。
 *
 * 为什么不把这些判断散在各组件里：
 * - 同一个问题（「这页现在能用吗」）在导航轨、命令面板、App 路由、设置区导航顺序、
 *   通知/桌宠跳转五处出现，写五遍必然漂移；
 * - 五个地方都要能单测，而组件测试又重又慢——纯函数是唯一能低成本钉住口径的形态。
 */

/**
 * 页面当前是否可用：非模块页恒可用；模块页要求其模块**已安装且实际生效**。
 *
 * d.105 起「实际生效」由统一能力单元投影判定（`modules/store.ts` 的
 * `isModuleEffective` 是薄封装：已安装 && 已启用 && 依赖链满足，内部走
 * `lib/units/projection.ts`），导航与插件页统一列表因此读同一个口径；
 * 本文件仍是纯函数（便于单测）。
 *
 * 注意：模块页（幕僚/信息中枢/自动化）**不在导航顺序里**（导航固定 8 项），
 * 但这条判断仍被 `App.tsx` 的路由守卫与命令面板使用——未安装模块页绝不能被渲染，
 * 只能从插件页的模块卡「打开页面」进去。
 */
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

/**
 * 已安装且**实际生效**的模块页（导航入口用）。
 *
 * 顺序按注册表（幕僚 / 信息中枢 / 自动化 / 工作流）而不是安装顺序：同一台设备每次
 * 启动的入口顺序必须稳定，否则用户会觉得导航「自己会动」。
 */
export function moduleNavPages(state: ModuleState): NavPage[] {
  return BUILTIN_MODULES.filter(
    (mod) => mod.contributions.page && isModuleEffective(state, mod.id),
  ).map((mod) => mod.page as NavPage);
}

/**
 * 把「已装模块」的入口并进导航顺序：紧跟在「插件」之后（能力组内），位置固定。
 *
 * 这是 d.119 的用户口径：**装上就在左侧导航看得到入口**，不用回插件页找「打开页面」。
 * 但它不写进 `heming.navOrder.v1`——个性化排序排的是宿主页，模块入口是「装出来的」，
 * 参与排序会让同一份顺序在不同设备/不同安装状态下含义不一致（设置区也只排那 8 项）。
 * 卸载/停用模块后它自然消失（`isModuleEffective` 不成立）。
 */
export function withModuleNav(order: readonly NavPage[], state: ModuleState): NavPage[] {
  const pages = moduleNavPages(state).filter((page) => !order.includes(page));
  if (pages.length === 0) return [...order];
  const at = order.indexOf("plugins");
  const insertAt = at >= 0 ? at + 1 : order.length;
  return [...order.slice(0, insertAt), ...pages, ...order.slice(insertAt)];
}
