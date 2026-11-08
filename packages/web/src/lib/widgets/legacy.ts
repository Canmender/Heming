import { widgetsBridge, type WidgetRecord, type WidgetsBridge } from "../../types/widgets.js";

/**
 * 桌宠「从本体改成插件」的迁移与一次性提示（d.98 · 规格 §4.3）。
 *
 * 两件事都只在本机做，不上云：
 * 1. **迁移**：首次安装 `heming.pet` 时把老版本主窗 localStorage 的偏好（开关/绑定/模型路径，
 *    外加 d.59 起单独的打扰强度）交给主进程，由它和 `pet-state.json`（位置/缩放/穿透，主进程持有）
 *    合并成插件 `settings.json` / `state.json`。老键**保留不删**，回滚时还能用。
 * 2. **提示**：未安装桌宠插件时，插件区与设置区给一次「桌宠已改为插件，去安装」；
 *    只提示一次（localStorage 标记），不反复打扰。
 *
 * ★ 本文件不 import 任何被迁走的 pet 模块：字段名在这里按协议重新声明（只读旧数据，
 *   不复制旧实现），迁完之后 web 不再有 `lib/pet*`。
 */

/** 老版本桌宠偏好键（d.46）。只读，不删。 */
export const PET_PREFS_LEGACY_KEY = "heming.pet.v1";
/** 老版本打扰强度键（d.59 起单独存）。*/
export const PET_PRESENCE_LEGACY_KEY = "heming.pet.presence.v1";
/** 「桌宠已改为插件」提示的已展示标记。 */
export const PET_MIGRATION_HINT_KEY = "heming.pet.migration-hint.v1";
/** 桌宠插件 id（规格固定值）。 */
export const PET_PLUGIN_ID = "heming.pet";

function safeStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** 读一个 JSON 对象键；坏数据/非对象返回 null（迁移不能因为一条脏值整份失败）。 */
export function readLegacyPrefs(
  key: string,
  storage?: Storage | null,
): Record<string, unknown> | null {
  const target = safeStorage(storage);
  if (!target) return null;
  try {
    const raw = target.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 组装交给主进程的迁移入参（只挑已知字段，其余脏值不传）。
 *
 * 主进程还会再校验一遍（跨进程一律不可信）；这里做一层字段收口，是为了
 * 不把 localStorage 里的任意内容（可能是别的版本写的）原样塞给主进程。
 */
export function collectLegacyPetPrefs(storage?: Storage | null): Record<string, unknown> | null {
  const prefs = readLegacyPrefs(PET_PREFS_LEGACY_KEY, storage);
  const presence = readLegacyPrefs(PET_PRESENCE_LEGACY_KEY, storage);
  if (!prefs && !presence) return null;
  const out: Record<string, unknown> = {};
  if (prefs) {
    if (typeof prefs.enabled === "boolean") out.enabled = prefs.enabled;
    if (typeof prefs.agentId === "string") out.agentId = prefs.agentId;
    if (typeof prefs.modelPath === "string") out.modelPath = prefs.modelPath;
  }
  // 打扰强度旧键单独存；主进程把它并进 settings.presence（与清单 settings.fields 同名）。
  const intensity = presence?.intensity;
  if (intensity === "quiet" || intensity === "normal" || intensity === "eager") {
    out.presence = intensity;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 把老偏好交给主进程做一次性迁移（幂等）。
 *
 * 只在「首次安装 heming.pet」之后调用；没有老数据时直接成功（不产生空迁移记录）。
 */
export async function migrateLegacyPetPrefs(
  bridge: WidgetsBridge | undefined = widgetsBridge(),
  storage?: Storage | null,
): Promise<{ ok: boolean; error?: string }> {
  const prefs = collectLegacyPetPrefs(storage);
  if (!prefs) return { ok: true };
  if (!bridge) return { ok: false, error: "仅桌面端可用" };
  try {
    const result = await bridge.migrateLegacy({ prefs });
    return result?.ok ? { ok: true } : { ok: false, error: result?.error ?? "迁移失败" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function hintShown(storage?: Storage | null): boolean {
  const target = safeStorage(storage);
  if (!target) return true; // 无存储时不提示，避免每次刷新都弹
  try {
    return target.getItem(PET_MIGRATION_HINT_KEY) === "1";
  } catch {
    return true;
  }
}

/**
 * 是否展示「桌宠已改为插件，去安装」。
 *
 * 条件：桌面端（有 widgets 桥）+ 未安装 heming.pet + 本机没提示过。
 * 浏览器里没有界面插件能力，提示了也装不了，所以不显示。
 */
export function shouldShowPetMigrationHint(
  records: readonly WidgetRecord[],
  opts: { bridge?: WidgetsBridge | undefined; storage?: Storage | null } = {},
): boolean {
  const bridge = opts.bridge ?? widgetsBridge();
  if (!bridge) return false;
  if (records.some((record) => record.id === PET_PLUGIN_ID)) return false;
  return !hintShown(opts.storage);
}

/** 标记「已提示过一次」；失败静默（本机存储不可用时下次仍会提示，不阻塞界面）。 */
export function dismissPetMigrationHint(storage?: Storage | null): void {
  const target = safeStorage(storage);
  if (!target) return;
  try {
    target.setItem(PET_MIGRATION_HINT_KEY, "1");
  } catch {
    /* 配额/隐私模式：静默 */
  }
}
