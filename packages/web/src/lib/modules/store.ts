import { create } from "zustand";
import { resolveUnit } from "@heming/shared";
import { createDefaultStorage, readJson, writeJson } from "../memory/storage.js";
import type { StorageLike } from "../memory/types.js";
import { projectBuiltinUnits } from "../units/projection.js";
import { MODULE_IDS, type ModuleId, MODULE_BY_ID } from "./registry.js";

/**
 * 内置能力模块的**安装 / 启用**状态（本机）。
 *
 * 存储键 `heming.modules.v1`，存 `{ installed: { staff: boolean, … }, enabled: { … } }`：
 * - **默认全部未安装、未启用**：安装包默认不携带任何插件（系统能力 `heming.core` 不在这里，
 *   它由插件区的系统卡只读展示），用户到插件页点「安装」才装进来；
 * - 缺 `installed` 字段（旧存储 / 手改坏值）→ 该模块回落「未安装」，不假装装过；
 * - `installed=true` 但缺 `enabled` → 回落「启用」（装过就是开着，符合安装即生效）；
 * - 未知模块 id 直接丢弃（卸载模块后留下的旧键不会变成幽灵卡）；
 * - 只存本机、不上云、不导出；停用/删除**不删任何业务数据**（各模块自己的键不动）。
 *
 * 依赖口径：`isModuleEffective` = 已安装 && 已启用 && 依赖链满足。依赖项未就绪时本模块
 * 开关仍保留，但**实际不生效**——这样依赖项恢复后能自动回来，不会出现「开关是开的、
 * 却什么都不工作」的静默状态。
 */

export const MODULES_KEY = "heming.modules.v1";
/**
 * 模块状态版本标记（d.117）。
 *
 * d.115 及以前模块默认随应用「已安装」，用户升级后 localStorage 里会残留
 * `installed/enabled=true`，插件页因此仍显示幕僚/信息中枢/自动化。d.117 起
 * 模块改为**云端目录 + 用户显式安装**：首次读到没有标记的旧状态时，一次性把
 * `installed/enabled` 归零（**不删任何业务数据**），之后用户从云端重新安装即可。
 */
export const MODULES_SCHEMA_KEY = "heming.modules.schema.v2";
/** 两组布尔值，4KB 绰绰有余；写满/写失败静默（下次打开回到默认未安装）。 */
const MODULES_BYTE_LIMIT = 4 * 1024;

export interface ModuleState {
  /** 是否装过（内置模块随安装包发布，这里是「装配」而非「下载」）。 */
  installed: Record<ModuleId, boolean>;
  /** 总开关；未安装时恒为 false。 */
  enabled: Record<ModuleId, boolean>;
}

/** 默认全部未安装、未启用（安装包不携带任何插件）。 */
export function defaultModuleState(): ModuleState {
  return {
    installed: Object.fromEntries(MODULE_IDS.map((id) => [id, false])) as Record<ModuleId, boolean>,
    enabled: Object.fromEntries(MODULE_IDS.map((id) => [id, false])) as Record<ModuleId, boolean>,
  };
}

/**
 * 规整任意输入：只认已知 id 的布尔值，其余回落默认。
 *
 * 两条迁移口径：
 * - 缺 `installed` → 未安装（老存储里的「全开」不再视为已装）；
 * - `installed=true` 且缺 `enabled` → 启用。
 */
export function normalizeModuleState(raw: unknown): ModuleState {
  const base = defaultModuleState();
  if (!raw || typeof raw !== "object") return base;
  const record = raw as { installed?: unknown; enabled?: unknown };
  const installed = record.installed && typeof record.installed === "object" ? record.installed : null;
  const enabled = record.enabled && typeof record.enabled === "object" ? record.enabled : null;
  for (const id of MODULE_IDS) {
    const installedValue =
      installed && typeof (installed as Record<string, unknown>)[id] === "boolean"
        ? ((installed as Record<string, boolean>)[id] as boolean)
        : false;
    base.installed[id] = installedValue;
    const enabledValue =
      enabled && typeof (enabled as Record<string, unknown>)[id] === "boolean"
        ? ((enabled as Record<string, boolean>)[id] as boolean)
        : installedValue; // installed=true 且缺 enabled → 启用
    base.enabled[id] = installedValue && enabledValue;
  }
  return base;
}

/** 从原始字符串解析（坏 JSON / 非对象 → 默认未安装）。 */
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

/**
 * 启动时读取模块状态，并把 d.115 及以前「随应用已安装」的旧状态一次性归零。
 *
 * 只归零 `installed/enabled`，**不删任何业务数据**（简报、归档配置、自动化任务仍在）；
 * 标记写入后不再重复执行，用户从云端重新安装的状态会正常保留。
 * 存储不可用（隐私模式/配额）时按旧状态继续，不清任何东西。
 */
export function readModuleStateWithMigration(store: StorageLike = getStorage()): ModuleState {
  const state = readModuleState(store);
  try {
    if (store.getItem(MODULES_SCHEMA_KEY)) return state;
    const next = defaultModuleState();
    writeJson(store, MODULES_KEY, next, MODULES_BYTE_LIMIT);
    store.setItem(MODULES_SCHEMA_KEY, "1");
    return next;
  } catch {
    return state;
  }
}

function persist(state: ModuleState): void {
  writeJson(getStorage(), MODULES_KEY, state, MODULES_BYTE_LIMIT);
}

/**
 * 模块是否**实际生效**：已安装、自身启用，且依赖链上的模块都生效。
 *
 * d.105 起委托给统一能力单元投影（`lib/units/projection.ts` + shared `resolveUnit`）：
 * - 模块被投影成 `source: "builtin"` 的 `CapabilityUnit`，`requires` 即模块依赖；
 * - 生效口径（安装 × 总开关 × 依赖 × 贡献）与插件/系统/界面插件同源，不再各写一套；
 * - 未安装的模块在投影里 `installed=false`，`resolveUnit` 直接给 `notInstalled`。
 *
 * 递归带 seen 防环；新增模块时若误配成环，`resolveUnit` 返回 `degraded` 且非生效，
 * 不会栈溢出，也不会让整个导航因为一条坏配置崩掉。
 */
export function isModuleEffective(
  state: ModuleState,
  id: ModuleId,
  seen: ReadonlySet<ModuleId> = new Set(),
): boolean {
  if (!state.installed?.[id]) return false;
  if (!state.enabled?.[id]) return false;
  if (!MODULE_BY_ID[id]) return false;
  if (seen.has(id)) return false;
  const units = projectBuiltinUnits(state.enabled, undefined, state.installed);
  const byId = new Map(units.map((unit) => [unit.id, unit] as const));
  const unit = byId.get(id);
  if (!unit) return false;
  return resolveUnit(unit, byId, new Set<string>(seen)).effective;
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
  /** 启用/停用；未安装时启用无效（先安装）。写盘失败静默（本次会话仍生效）。 */
  setEnabled: (id: ModuleId, enabled: boolean) => void;
  /**
   * 设置安装状态。`false` 时一并关掉总开关（未安装不应保持 enabled=true）；
   * 安装本身不启用——安装入口用 `install()`（装完即可用）。
   */
  setInstalled: (id: ModuleId, installed: boolean) => void;
  /** 安装并启用（不迁移、不覆盖任何业务数据）。 */
  install: (id: ModuleId) => void;
  /** 删除：回到未安装 + 停用；**不删除任何业务数据键**。 */
  uninstall: (id: ModuleId) => void;
  /** 恢复默认（全部未安装）；测试与「恢复默认」入口共用。 */
  reset: () => void;
}

function sameState(a: ModuleState, b: ModuleState): boolean {
  return MODULE_IDS.every((id) => a.installed[id] === b.installed[id] && a.enabled[id] === b.enabled[id]);
}

export const useModuleStore = create<ModuleStore>((set, get) => ({
  ...readModuleStateWithMigration(),
  setEnabled: (id, enabled) => {
    if (!MODULE_IDS.includes(id)) return;
    const current = get();
    if (!current.installed[id]) return; // 未安装的模块没有「启用」这回事
    if (current.enabled[id] === enabled) return;
    const next: ModuleState = {
      installed: { ...current.installed },
      enabled: { ...current.enabled, [id]: enabled },
    };
    persist(next);
    set(next);
  },
  setInstalled: (id, installed) => {
    if (!MODULE_IDS.includes(id)) return;
    const current = get();
    const next: ModuleState = {
      installed: { ...current.installed, [id]: installed },
      enabled: { ...current.enabled, [id]: installed ? current.enabled[id] : false },
    };
    if (sameState(current, next)) return;
    persist(next);
    set(next);
  },
  install: (id) => {
    if (!MODULE_IDS.includes(id)) return;
    const current = get();
    const next: ModuleState = {
      installed: { ...current.installed, [id]: true },
      enabled: { ...current.enabled, [id]: true },
    };
    if (sameState(current, next)) return;
    persist(next);
    set(next);
  },
  uninstall: (id) => {
    if (!MODULE_IDS.includes(id)) return;
    const current = get();
    const next: ModuleState = {
      installed: { ...current.installed, [id]: false },
      enabled: { ...current.enabled, [id]: false },
    };
    if (sameState(current, next)) return;
    // 只改状态：本机业务数据（简报、归档配置、自动化任务）一个键都不动
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
