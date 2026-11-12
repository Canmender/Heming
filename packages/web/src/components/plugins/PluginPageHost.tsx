import { useEffect } from "react";
import { useUiStore } from "../../store/ui.js";
import { isPluginPagePage, type PluginPageId } from "../../lib/pages/ids.js";
import { usePluginPageEntry } from "../../lib/pages/usePluginPages.js";
import { PluginBundlePage } from "./PluginBundlePage.js";
import { PluginDeclarativePage } from "./PluginDeclarativePage.js";

/**
 * 插件页面宿主（d.124）：按注册表投影选择渲染路径。
 *
 * - `source: "declarative"` → `PluginDeclarativePage`（宿主按清单 blocks 渲染，零代码）；
 * - `source: "bundle"` → `PluginBundlePage`（主进程在占位区上叠 `widget://` 沙箱视图）。
 *
 * 为什么不让 App 直接分支：两类页面的数据来源/降级/错误态完全不同，
 * 由这里收口后，App 的路由只剩「是不是插件页」一个判断。
 *
 * 入口不存在/已停用/已卸载时，本组件不渲染任何页面内容，而是把当前页拨回主页
 * （与 `App.tsx` 用 `resolvePage` 折叠旧模块页 id 的口径一致：不渲染不该存在的页面）。
 */
export function PluginPageHost({ page }: { page: PluginPageId }): React.ReactElement | null {
  const entry = usePluginPageEntry(page);
  const setPage = useUiStore((state) => state.setPage);

  const missing = !entry || !entry.available;
  useEffect(() => {
    // 卸载/停用的一瞬间（路由还没重新算）落到这里：回主页，不白屏。
    if (missing) setPage("home");
  }, [missing, setPage]);

  if (missing) return null;
  if (!isPluginPagePage(entry.pageId)) return null;

  return entry.source === "bundle" ? (
    <PluginBundlePage pluginId={entry.pluginId} />
  ) : (
    <PluginDeclarativePage pluginId={entry.pluginId} />
  );
}
