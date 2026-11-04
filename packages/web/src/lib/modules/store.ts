import { create } from "zustand";
import { createDefaultStorage, readJson, writeJson } from "../memory/storage.js";
import type { StorageLike } from "../memory/types.js";
import { MODULE_IDS, type ModuleId, type BuiltinModule, MODULE_BY_ID } from "./registry.js";

/**
 * 内置能力模块的启用状态（本机）。
 *
 * 存储键 `heming.modules.v1`，只存 `{ enabled: { staff: boolean, … } }`：
 * - **默认全开**：升级后行为与 d.69 及之前完全一致，老用户不会发现入口不见了；
 * - 缺字段 / 坏 JSON / 手改坏值 → 该模块回落「启用」，不让一次坏数据把模块锁死；
 * - 未知模块 id 直接丢弃（卸载模块后留下的旧键不会变成幽灵卡）；
 * - 只存本机、不上云、不导出；停用**不删任何业务数据**（各模块自己的键不动）。
 *
 * 依赖口径：`automations` 依赖 `infohub`。依赖项停用时，本模块开关仍保留，
 * 但**实际不生效**（`isModuleEffective` 为 false）——这样重新启用依赖项后能自动恢复，
 * 不会出现「开关是开的、却什么都不工作」的静默状态。
 */

export const MODULES_KEY = "heming.modules.v1";
/** 三个布尔值，4KB 绰绰有余；写满/写失败静默（下次打开回到默认全开）。 */
const MODULES_BYTE_LIMIT = 4 * 1024;

export interface ModuleState {
  enabled: Record<ModuleId, boolean>;
}

/** 默认全开：与改造前行为一致。 */
export function defaultModuleState(): ModuleState {
  return {
    enabled: Object.fromEntries(MODULE_IDS.map((id) => [id, true])) as Record<ModuleId, boolean>,
  };
}

/** 规整任意输入：只认已知 id 的布尔值，其余回落默认（启用）。 */
export function normalizeModuleState(raw: unknown): ModuleState {
  const base = defaultModuleState();
  if (!raw || typeof raw !== "object") return base;
  const enabled = (raw as { enabled?: unknown }).enabled;
  if (!enabled || typeof enabled !== "object") return base;
  for (const id of MODULE_IDS) {
    const value = (enabled as Record<string, unknown>)[id];
    if (typeof value === "boolean") base.enabled[id] = value;
  }
  return base;
}

/** 从原始字符串解析（坏 JSON / 非对象 → 默认全开）。 */
export function parseModuleState(raw: string | null | undefined): ModuleState {
  if (typeof raw !== "string" || !raw.trim()) return defaultModuleState();
  try {
    return normalizeModuleState(JSON.parse(raw));
  } catch {
    return defaultModuleState();
  }
}

let storage: StorageLike | null = null;

/** 测试注入点：传 null 恢复默认（jsdom localStorage）。 */
export function setModuleStorage(next: StorageLike | null): void {
  storage = next;
}

function getStorage(): StorageLike {
  return (storage ??= createDefaultStorage());
}

export function readModuleState(store: StorageLike = getStorage()): ModuleState {
  return readJson(store, MODULES_KEY, defaultModuleState(), normalizeModuleState);
}

function persist(state: ModuleState): void {
  writeJson(getStorage(), MODULES_KEY, state, MODULES_BYTE_LIMIT);
}

/**
 * 模块是否**实际生效**：自身启用，且依赖链上的模块都启用了。
 *
 * 递归带 seen 防环（当前注册表无环；新增模块时若误配成环，这里返回 false 而不是栈溢出，
 * 由依赖说明兜底提示，不让整个导航因为一条坏配置崩掉）。
 */
export function isModuleEffective(
  state: ModuleState,
  id: ModuleId,
  seen: ReadonlySet<ModuleId> = new Set(),
): boolean {
  if (!state.enabled[id]) return false;
  if (seen.has(id)) return false;
  const mod: BuiltinModule | undefined = MODULE_BY_ID[id];
  const requires = mod?.requires ?? [];
  if (requires.length === 0) return true;
  const next = new Set(seen);
  next.add(id);
  return requires.every((dep) => isModuleEffective(state, dep, next));
}

/** 当前实际生效的模块（按注册表顺序）。 */
export function effectiveModuleIds(state: ModuleState): ModuleId[] {
  return MODULE_IDS.filter((id) => isModuleEffective(state, id));
}

/** 某个模块当前缺少的依赖（用于卡片与停用提示；为空表示依赖满足）。 */
export function missingRequirements(state: ModuleState, id: ModuleId): ModuleId[] {
  return (MODULE_BY_ID[id]?.requires ?? []).filter((dep) => !isModuleEffective(state, dep));
}

interface ModuleStore extends ModuleState {
  /** 启用/停用；写盘失败静默（本次会话仍生效）。 */
  setEnabled: (id: ModuleId, enabled: boolean) => void;
  /** 恢复默认（全开）；测试与「恢复默认」入口共用。 */
  reset: () => void;
}

export const useModuleStore = create<ModuleStore>((set, get) => ({
  ...readModuleState(),
  setEnabled: (id, enabled) => {
    if (!MODULE_IDS.includes(id)) return;
    if (get().enabled[id] === enabled) return;
    const next: ModuleState = { enabled: { ...get().enabled, [id]: enabled } };
    persist(next);
    set(next);
  },
  reset: () => {
    const next = defaultModuleState();
    persist(next);
    set(next);
  },
}));

/** 当前是否实际生效（供非 React 代码用：能力提供者、路由守卫）。 */
export function isModuleOn(id: ModuleId): boolean {
  return isModuleEffective(useModuleStore.getState(), id);
}
