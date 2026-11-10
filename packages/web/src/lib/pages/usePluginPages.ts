import { useCallback, useMemo, useSyncExternalStore } from "react";
import { pluginStore } from "../plugins/store.js";
import { useWidgetsStore, widgetsAvailable } from "../widgets/store.js";
import { pluginPageEntries, type PluginPageEntry } from "./registry.js";

/**
 * 插件页面入口的响应式读数（d.124）。
 *
 * 两套数据源的生命周期不同：
 * - 声明式插件在 localStorage 的 `PluginStore` 里（**没有** zustand 订阅，靠
 *   d.124 新加的 `subscribe` / `revision` 感知安装/启停/卸载）；
 * - 界面插件记录在 `useWidgetsStore`（zustand，天然订阅）。
 *
 * 导航轨与 App 路由都从这里读，保证「装完立刻出现、卸载立刻消失」。
 */
export function usePluginPageEntries(): PluginPageEntry[] {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      // 旧版本注入的 store（测试替身）可能没有订阅 API：退化成不通知，不报错。
      if (typeof pluginStore.subscribe !== "function") return () => {};
      return pluginStore.subscribe(onStoreChange);
    },
    [],
  );
  const getRevision = useCallback(() => {
    // 订阅回调在同一 tick 里可能多次触发，revision 只增不变；
    // 用数字快照可以避免把 `list()` 的新数组当快照（那会无限重渲染）。
    return typeof pluginStore.revision === "number" ? pluginStore.revision : 0;
  }, []);
  const revision = useSyncExternalStore(subscribe, getRevision, () => 0);

  const widgets = useWidgetsStore((state) => state.records);

  return useMemo(() => {
    const desktop = widgetsAvailable();
    return pluginPageEntries({
      plugins: pluginStore.list(),
      widgets,
      desktop,
    });
    // revision 只是重算触发点：插件记录变了 list() 的返回值才会变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, widgets]);
}

/** 单个页面入口（路由守卫/页面宿主用；`undefined` = 不存在或已卸载）。 */
export function usePluginPageEntry(page: string): PluginPageEntry | undefined {
  const entries = usePluginPageEntries();
  return useMemo(() => entries.find((entry) => entry.pageId === page), [entries, page]);
}
