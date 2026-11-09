import { useSyncExternalStore } from "react";
import {
  CONTRIBUTION_LABELS,
  resolveUnits,
  type CapabilityUnit,
  type ContributionKind,
  type UnitBlockReason,
  type UnitStatus,
} from "@heming/shared";
import { useModuleStore } from "../modules/store.js";
import { BUILTIN_MODULES } from "../modules/registry.js";
import { pluginStore } from "../plugins/store.js";
import { describeSystemPlugin } from "../plugins/system.js";
import { useWidgetsStore } from "../widgets/store.js";
import {
  currentAppVersion,
  projectUnitStatuses,
  projectUnits,
  type UnitProjectionSources,
} from "./projection.js";

/**
 * 能力单元注册表（d.105 · 阶段 A）。
 *
 * 两件事：
 * 1. **读投影**：`useUnitStatuses()` 订阅 plugins / modules / widgets 三处状态，
 *    把投影 + 生效判定结果给插件页统一列表与诊断用。`pluginStore` 没有订阅 API，
 *    改插件后由调用方 `refreshUnits()` 显式失效（插件页安装/启停/卸载处已接）。
 * 2. **运行时贡献挂载**：`mountContribution(kind, unitId, mount)` 返回撤销句柄；
 *    `disposeUnit(unitId)` **后注册先撤销**、异步撤销串行 await、单个失败不阻断其余。
 *    阶段 A 只提供这套纯函数注册表（页面/首页卡/后台循环的接线放阶段 C），
 *    所以这里没有任何 React 组件/循环的挂载点。
 *
 * ★ 边界：不写任何 store；挂载只是「拿到撤销函数并存起来」，撤销由单元停用/更新/卸载
 *   的调用方触发。失败进诊断（`unitMountFailures`），不阻断其它单元。
 */

export type Dispose = () => void | Promise<void>;

/** 运行时贡献的挂载记录。 */
interface MountedEntry {
  kind: ContributionKind;
  unitId: string;
  dispose: Dispose;
  disposed: boolean;
}

const mounted = new Map<string, MountedEntry[]>();
const mountFailures = new Map<string, string[]>();

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function recordMountFailure(unitId: string, detail: string): void {
  const list = mountFailures.get(unitId) ?? [];
  list.push(detail);
  mountFailures.set(unitId, list);
}

async function runEntry(entry: MountedEntry): Promise<void> {
  if (entry.disposed) return;
  entry.disposed = true;
  await entry.dispose();
}

/**
 * 挂载一个运行时贡献，返回撤销句柄。
 *
 * `mount` 在调用时立即执行（拿到它返回的撤销函数）；`mount` 自身抛错视为挂载失败，
 * 记入诊断并返回 no-op 句柄——**失败不阻断**调用方继续挂载其它贡献。
 */
export function mountContribution(
  kind: ContributionKind,
  unitId: string,
  mount: () => Dispose,
): Dispose {
  let entry: MountedEntry;
  try {
    const dispose = mount();
    if (typeof dispose !== "function") {
      throw new Error("mount 必须返回撤销函数（Dispose）");
    }
    entry = { kind, unitId, dispose, disposed: false };
  } catch (err) {
    recordMountFailure(unitId, `挂载「${CONTRIBUTION_LABELS[kind]}」失败：${errorText(err)}`);
    return () => {};
  }
  const list = mounted.get(unitId) ?? [];
  list.push(entry);
  mounted.set(unitId, list);
  return () => {
    const current = mounted.get(unitId);
    if (current) {
      const index = current.indexOf(entry);
      if (index >= 0) current.splice(index, 1);
    }
    void runEntry(entry).catch((err) => {
      recordMountFailure(unitId, `撤销「${CONTRIBUTION_LABELS[kind]}」失败：${errorText(err)}`);
    });
  };
}

/**
 * 撤销某个单元的全部运行时贡献：**后注册先撤销**、逐个 await（串行）。
 *
 * 单个撤销抛错不阻断其余；失败与已撤销数量一起返回，并写入诊断。
 * 幂等：重复调用第二次返回 `disposed: 0`。
 */
export async function disposeUnit(
  unitId: string,
): Promise<{ disposed: number; failures: string[] }> {
  const entries = mounted.get(unitId) ?? [];
  mounted.delete(unitId);
  mountFailures.delete(unitId);
  const failures: string[] = [];
  let disposed = 0;
  for (const entry of [...entries].reverse()) {
    try {
      await runEntry(entry);
      disposed += 1;
    } catch (err) {
      failures.push(`撤销「${CONTRIBUTION_LABELS[entry.kind]}」失败：${errorText(err)}`);
    }
  }
  if (failures.length > 0) {
    for (const failure of failures) recordMountFailure(unitId, failure);
  }
  return { disposed, failures };
}

/** 某个单元挂载/撤销失败的诊断（给诊断区与测试用；无失败返回空数组）。 */
export function unitMountFailures(unitId: string): string[] {
  return [...(mountFailures.get(unitId) ?? [])];
}

/** 把挂载失败转换成统一的阻断原因（诊断区与 `blockReasonText` 共用）。 */
export function unitMountDiagnostics(unitId: string): UnitBlockReason[] {
  return unitMountFailures(unitId).map((detail) => ({ kind: "degraded", detail }));
}

/** 当前已挂载的贡献数（测试/调试用）。 */
export function mountedContributionCount(unitId?: string): number {
  if (unitId) return mounted.get(unitId)?.length ?? 0;
  let total = 0;
  for (const list of mounted.values()) total += list.length;
  return total;
}

/* ───────────────────────── 读投影：快照与订阅 ───────────────────────── */

export interface UnitsSnapshot {
  units: CapabilityUnit[];
  statuses: UnitStatus[];
}

/**
 * 用显式数据源构建快照（插件页在测试里注入自定义 store/系统视图时用）。
 * 纯函数：给定相同输入得到相同结果，不读全局单例。
 */
export function buildUnitStatuses(sources: UnitProjectionSources = {}): UnitStatus[] {
  return projectUnitStatuses(sources);
}

function readDefaultSources(): UnitProjectionSources {
  const installed = useModuleStore.getState().installed;
  return {
    system: describeSystemPlugin(),
    // 只投影已安装的模块：原生应用不显示任何「内置模块」，模块从云端目录安装。
    modules: BUILTIN_MODULES.filter((mod) => installed[mod.id]),
    moduleEnabled: useModuleStore.getState().enabled,
    moduleInstalled: installed,
    plugins: pluginStore.list(),
    widgets: useWidgetsStore.getState().records,
    appVersion: currentAppVersion(),
  };
}

let snapshotCache: UnitsSnapshot | null = null;
const listeners = new Set<() => void>();
let bound = false;

/** 让下一次 `useUnitStatuses()` 重新投影（插件 store 无订阅 API，写入后显式调用）。 */
export function refreshUnits(): void {
  snapshotCache = null;
  for (const listener of [...listeners]) listener();
}

function bindStoreSubscriptions(): void {
  if (bound) return;
  bound = true;
  useModuleStore.subscribe(() => refreshUnits());
  useWidgetsStore.subscribe(() => refreshUnits());
}

function getSnapshot(): UnitsSnapshot {
  if (!snapshotCache) {
    const units = projectUnits(readDefaultSources());
    snapshotCache = { units, statuses: resolveUnits(units) };
  }
  return snapshotCache;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  bindStoreSubscriptions();
  return () => {
    listeners.delete(listener);
  };
}

/** 插件页统一列表/诊断用：四类来源的单元状态（订阅模块与界面插件 store）。 */
export function useUnitStatuses(): UnitStatus[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).statuses;
}

/** 需要单元本体时用（例如按 id 找归属）；与 `useUnitStatuses` 共享同一份快照。 */
export function useUnits(): CapabilityUnit[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).units;
}

/* ───────────────────────── 测试隔离 ───────────────────────── */

/** 仅测试用：清空挂载表与快照缓存（避免用例间串状态）。 */
export function __resetUnitsForTest(): void {
  mounted.clear();
  mountFailures.clear();
  snapshotCache = null;
  listeners.clear();
}
