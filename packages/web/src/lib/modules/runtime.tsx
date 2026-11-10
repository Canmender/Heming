import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { ModuleId } from "./registry.js";
import { isModuleEffective, type ModuleState } from "./store.js";
import { useAutomationScheduler } from "../automation/scheduler.js";
import { useStaffLoop } from "../staff/loop.js";
import { useWorkflowScheduler } from "../workflow/scheduler.js";

/**
 * 内置模块的**运行时注册表**（d.128，P2 迁移切口）。
 *
 * 为什么要多这一层：此前 App.tsx 直接 import 四个模块页面与三个后台循环 hook——
 * 宿主知道每个模块的内部实现，模块代码也就永远嵌在本体里。现在 App 只认两件事：
 * 「某个 moduleId 有页面」与「后台循环按生效状态启停」，具体实现收在本文件。
 *
 * 迁移到插件包时，替换这里的一个条目即可（页面换成插件页宿主、循环换成插件引擎托管），
 * App 的路由/生命周期不动。耦合基线（lib/modules/coupling-baseline.json）继续只减不增。
 */

/** 懒加载的模块页面（每个模块单独成 chunk，首屏不下载）。 */
const StaffPage = lazy(() =>
  import("../../components/StaffPage.js").then((m) => ({ default: m.StaffPage })),
);
const InfohubPage = lazy(() =>
  import("../../components/InfohubPage.js").then((m) => ({ default: m.InfohubPage })),
);
const AutomationPage = lazy(() =>
  import("../../components/AutomationPage.js").then((m) => ({ default: m.AutomationPage })),
);
const WorkflowPage = lazy(() =>
  import("../../components/workflow/WorkflowPage.js").then((m) => ({ default: m.WorkflowPage })),
);

/** moduleId → 页面组件（必须与 registry 的 page 一一对应）。 */
export const MODULE_PAGES: Readonly<Record<ModuleId, LazyExoticComponent<ComponentType>>> = {
  staff: StaffPage,
  infohub: InfohubPage,
  automations: AutomationPage,
  workflows: WorkflowPage,
};

const MODULE_PAGE_IDS: ReadonlySet<string> = new Set(Object.keys(MODULE_PAGES));

/** Page 是否属于某个内置模块；是则返回 moduleId，否则 null。 */
export function modulePageOf(page: string): ModuleId | null {
  return MODULE_PAGE_IDS.has(page) ? (page as ModuleId) : null;
}

/** 渲染模块页；页面不存在时由 registry 的 isPageAvailable 先把关（这里只做兜底空渲染）。 */
export function ModulePage({ moduleId }: { moduleId: ModuleId }) {
  const Page = MODULE_PAGES[moduleId];
  return Page ? <Page /> : null;
}

/* ── 后台循环：App 只调一个 hook，模块实现留在本文件 ── */

/**
 * 登录后按模块生效状态挂载后台循环。
 *
 * 与拆分前逐条等价（自动化 / 工作流 / 幕僚；信息中枢的边车拉起仍在 App，因为它是
 * 进程级开关而不是模块内部循环）。三个 hook 都是「effect 挂载/卸载」，互不读取彼此状态。
 */
export function useModuleBackgroundLoops(authUser: boolean, state: ModuleState): void {
  useAutomationScheduler(authUser && isModuleEffective(state, "automations"));
  useWorkflowScheduler(authUser && isModuleEffective(state, "workflows"));
  useStaffLoop(authUser && isModuleEffective(state, "staff"));
}
