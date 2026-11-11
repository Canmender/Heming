import { Component, lazy, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";
import { MODULE_IDS, type ModuleId } from "./registry.js";
import { isModuleEffective, type ModuleState } from "./store.js";
import { useAutomationScheduler } from "../automation/scheduler.js";
import { useWebModuleEntry } from "./useWebModule.js";
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
/** staff 已迁出（d.131 M2）；其余模块迁移前仍保留内置回退。 */
export const MODULE_PAGES: Readonly<Partial<Record<ModuleId, LazyExoticComponent<ComponentType>>>> = {
  infohub: InfohubPage,
  automations: AutomationPage,
  workflows: WorkflowPage,
};

// 页面 id 以 registry 为准（staff 已无内置页面，但路由仍要认它是模块页，再交给模块包加载）。
const MODULE_PAGE_IDS: ReadonlySet<string> = new Set<string>(MODULE_IDS);

/** Page 是否属于某个内置模块；是则返回 moduleId，否则 null。 */
export function modulePageOf(page: string): ModuleId | null {
  return MODULE_PAGE_IDS.has(page) ? (page as ModuleId) : null;
}

/**
 * 渲染模块页：优先用已安装模块包导出的页面（d.131），没有/加载失败时回退内置页面。
 * 迁移期保留回退；M6 删除内置页面后这里只剩模块包路径。
 */
export function ModulePage({ moduleId }: { moduleId: ModuleId }) {
  const { entry, error } = useWebModuleEntry(moduleId);
  const WebPage = entry?.pages?.[moduleId];
  if (WebPage) {
    return (
      <ModuleBoundary fallback={<ModuleLoadFailure moduleId={moduleId} reason={error} />}>
        <WebPage />
      </ModuleBoundary>
    );
  }
  const Page = MODULE_PAGES[moduleId];
  if (Page) {
    return (
      <ModuleBoundary fallback={null}>
        <Page />
      </ModuleBoundary>
    );
  }
  return <ModuleLoadFailure moduleId={moduleId} reason={error} />;
}

/** 模块包页面/卡片抛错时的兜底：不把整棵 App 打白（模块是外来代码，边界必须在本体）。 */
class ModuleBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error("[module] 模块包渲染失败，已回退：", error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function ModuleLoadFailure({ moduleId, reason }: { moduleId: ModuleId; reason: string }) {
  return (
    <div className="ui-empty p-8">
      <p className="ui-empty-title">模块「{moduleId}」未就绪</p>
      <p className="ui-empty-desc">{reason || "模块包未安装或加载失败；请在插件区安装/启用后重试。"}</p>
    </div>
  );
}

/** 首页模块卡：模块包提供 homeCards 时优先，否则回退内置卡。 */
export function ModuleHomeCard({
  moduleId,
  active,
  fallback,
}: {
  moduleId: ModuleId;
  active: boolean;
  fallback: ReactNode;
}) {
  const { entry } = useWebModuleEntry(moduleId);
  if (!active) return null;
  const WebCard = entry?.homeCards?.[moduleId];
  if (WebCard) {
    return (
      <ModuleBoundary fallback={fallback}>
        <WebCard />
      </ModuleBoundary>
    );
  }
  return <>{fallback}</>;
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
  // 幕僚循环从 d.131 M2 起由模块包后台导出提供（见 ModuleBackgroundSlots）。
}

/**
 * 后台循环槽位：App 渲染一次，模块包有 background 导出就用模块的组件，否则回退内置。
 * 组件形式（而不是返回 hook）让条件回退不违反 hooks 规则。
 */
export function ModuleBackgroundSlots({
  authUser,
  moduleState,
}: {
  authUser: boolean;
  moduleState: ModuleState;
}) {
  return <StaffBackgroundSlot active={authUser && isModuleEffective(moduleState, "staff")} />;
}

function StaffBackgroundSlot({ active }: { active: boolean }) {
  const { entry } = useWebModuleEntry("staff");
  const WebBackground = entry?.background?.staff;
  if (!WebBackground) return null;
  return (
    <ModuleBoundary fallback={null}>
      <WebBackground active={active} />
    </ModuleBoundary>
  );
}
