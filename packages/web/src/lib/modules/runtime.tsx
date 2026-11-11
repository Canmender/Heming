import { Component, type ReactNode } from "react";
import { MODULE_IDS, type ModuleId } from "./registry.js";
import { isModuleEffective, type ModuleState } from "./store.js";
import { useWebModuleEntry } from "./useWebModule.js";

/**
 * 模块页/首页卡/后台循环的**宿主接缝**（d.128 起，d.131 M2–M5 收口）。
 *
 * 本体只认三件事：
 * 1. 某个 page id 属于注册表里的模块（`modulePageOf`）；
 * 2. 页面/首页卡从**已安装模块包**的 `entry.js` 取（`useWebModuleEntry`）；
 * 3. 后台循环由模块包导出的组件提供（`ModuleBackgroundSlots`）。
 *
 * 四个内置模块（staff / automations / infohub / workflows）都迁出后，本文件不再 import
 * 任何模块实现；模块加载失败只显示失败原因，绝不回退到本体实现。
 */

/** Page 是否属于某个模块；是则返回 moduleId，否则 null。 */
export function modulePageOf(page: string): ModuleId | null {
  return MODULE_IDS.includes(page as ModuleId) ? (page as ModuleId) : null;
}

/** 渲染模块页（模块包入口必须导出与 moduleId 同名的页面）。 */
export function ModulePage({ moduleId }: { moduleId: ModuleId }) {
  const { entry, error } = useWebModuleEntry(moduleId);
  const WebPage = entry?.pages?.[moduleId];
  if (!WebPage) return <ModuleLoadFailure moduleId={moduleId} reason={error} />;
  return (
    <ModuleBoundary fallback={<ModuleLoadFailure moduleId={moduleId} reason={error} />}>
      <WebPage />
    </ModuleBoundary>
  );
}

/** 模块包页面/卡片抛错时的兜底：不把整棵 App 打白（模块是外来代码，边界必须在本体）。 */
class ModuleBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error("[module] 模块包渲染失败：", error);
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

/** 首页模块卡：只从模块包取；未加载/未生效时不渲染。 */
export function ModuleHomeCard({ moduleId, active }: { moduleId: ModuleId; active: boolean }) {
  const { entry } = useWebModuleEntry(moduleId);
  if (!active) return null;
  const WebCard = entry?.homeCards?.[moduleId];
  if (!WebCard) return null;
  return (
    <ModuleBoundary fallback={null}>
      <WebCard />
    </ModuleBoundary>
  );
}

/** 后台循环槽位：App 渲染一次，模块包有 background 导出才挂载。 */
export function ModuleBackgroundSlots({
  authUser,
  moduleState,
}: {
  authUser: boolean;
  moduleState: ModuleState;
}) {
  return (
    <>
      <StaffBackgroundSlot active={authUser && isModuleEffective(moduleState, "staff")} />
      <AutomationBackgroundSlot active={authUser && isModuleEffective(moduleState, "automations")} />
      <WorkflowBackgroundSlot active={authUser && isModuleEffective(moduleState, "workflows")} />
    </>
  );
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

function AutomationBackgroundSlot({ active }: { active: boolean }) {
  const { entry } = useWebModuleEntry("automations");
  const WebBackground = entry?.background?.automations;
  if (!WebBackground) return null;
  return (
    <ModuleBoundary fallback={null}>
      <WebBackground active={active} />
    </ModuleBoundary>
  );
}

function WorkflowBackgroundSlot({ active }: { active: boolean }) {
  const { entry } = useWebModuleEntry("workflows");
  const WebBackground = entry?.background?.workflows;
  if (!WebBackground) return null;
  return (
    <ModuleBoundary fallback={null}>
      <WebBackground active={active} />
    </ModuleBoundary>
  );
}
