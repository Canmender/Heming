import { Component, type ReactNode } from "react";
import { MODULE_BY_ID, moduleForPage, type ModuleId } from "./registry.js";
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

/** Page 是否属于某个模块；是则返回模块**包 id**，否则 null。 */
export function modulePageOf(page: string): ModuleId | null {
  // 幕僚/工作流页面已并入自动化插件：旧链接/通知点进来统一落到 automations 页。
  if (page === "staff" || page === "workflows") return moduleForPage("automations")?.id ?? null;
  return moduleForPage(page)?.id ?? null;
}

/**
 * 渲染模块页。
 *
 * 模块包导出的 `pages` 以**页面 id** 为键（`pages: { infohub: Page }`），而宿主传进来的是
 * **包 id**（`heming.infohub`）——两者不是一层，必须经注册表的 `page` 字段换算。
 */
export function ModulePage({ moduleId }: { moduleId: ModuleId }) {
  const { entry, error } = useWebModuleEntry(moduleId);
  const page = MODULE_BY_ID[moduleId]?.page;
  const WebPage = page ? entry?.pages?.[page] : undefined;
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

/** 首页模块卡：只从模块包取；未加载/未生效时不渲染（包内 `homeCards` 同样以页面 id 为键）。 */
export function ModuleHomeCard({ moduleId, active }: { moduleId: ModuleId; active: boolean }) {
  const { entry } = useWebModuleEntry(moduleId);
  if (!active) return null;
  const page = MODULE_BY_ID[moduleId]?.page;
  const WebCard = page ? entry?.homeCards?.[page] : undefined;
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
  return <AutomationBackgroundSlot active={authUser && isModuleEffective(moduleState, "heming.automations")} />;
}

function AutomationBackgroundSlot({ active }: { active: boolean }) {
  const { entry } = useWebModuleEntry("heming.automations");
  const page = MODULE_BY_ID["heming.automations"]?.page;
  const WebBackground = page ? entry?.background?.[page] : undefined;
  if (!WebBackground) return null;
  return (
    <ModuleBoundary fallback={null}>
      <WebBackground active={active} />
    </ModuleBoundary>
  );
}

