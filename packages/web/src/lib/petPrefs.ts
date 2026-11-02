/**
 * 桌宠本机偏好（d.46）。
 *
 * 只存本机：这是"桌宠长什么样、绑哪个智能体"的偏好，不是业务数据。
 * 不做模块级缓存——桌宠窗口与主窗口是两个渲染进程，各自读到的是同一份 localStorage，
 * 但缓存不会共享；这个值读取频率极低（开窗一次 / 改设置一次），直接读盘更不容易出错。
 *
 * ★ 缩放与窗口位置**不在这里**：它们决定窗口的像素尺寸，属主进程的 pet-state.json。
 *   两处都存一份，迟早出现"设置里写着 1.25、窗口却是 1.0"。
 */
export const PET_PREFS_KEY = "heming.pet.v1";

/** 默认模型：官方示例 Hiyori（随 web 产物打包，见 public/pet/README.md）。 */
export const DEFAULT_PET_MODEL = "pet/Hiyori/Hiyori.model3.json";

export interface PetPrefs {
  /** 是否启用桌宠。默认 false：用户没主动开过，就不该在桌面上多出一个东西。 */
  enabled: boolean;
  /** 绑定的智能体 id；null = 用第一个可用模型连接。 */
  agentId: string | null;
  /** 模型路径（相对 web 产物根）。 */
  modelPath: string;
}

export const DEFAULT_PET_PREFS: PetPrefs = Object.freeze({
  enabled: false,
  agentId: null,
  modelPath: DEFAULT_PET_MODEL,
});

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null; // 隐私模式 / 无 window（测试环境）
  }
}

/**
 * 模型路径白名单校验。
 *
 * 与主进程 `sanitizeModelPath` 同一套规则（两侧都要挡：渲染层负责不让脏值进 URL，
 * 主进程负责不让脏值进磁盘寻址）。规则重复是有意的——单靠一侧就是把安全边界
 * 建在"另一个进程一定会拦住"这个假设上。
 */
export function isValidModelPath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  const raw = path.trim();
  if (!raw || raw.length > 200) return false;
  if (raw.startsWith("/") || raw.startsWith("\\")) return false;
  if (raw.includes(":") || raw.includes("//")) return false;
  const parts = raw.replace(/\\/g, "/").split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
  if (!/\.model3?\.json$/i.test(raw)) return false;
  return /^[\p{L}\p{N}\-_. /]+$/u.test(raw.replace(/\\/g, "/"));
}

/** 读偏好。坏数据逐字段回落默认，绝不整份丢弃（用户只写坏一个字段时不该全丢）。 */
export function loadPetPrefs(store: Storage | null = safeStorage()): PetPrefs {
  if (!store) return { ...DEFAULT_PET_PREFS };
  let parsed: unknown = null;
  try {
    const raw = store.getItem(PET_PREFS_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    return { ...DEFAULT_PET_PREFS };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...DEFAULT_PET_PREFS };
  }
  const src = parsed as Partial<Record<keyof PetPrefs, unknown>>;
  return {
    enabled: src.enabled === true,
    agentId: typeof src.agentId === "string" && src.agentId.trim() ? src.agentId.trim() : null,
    modelPath: isValidModelPath(src.modelPath) ? (src.modelPath as string) : DEFAULT_PET_MODEL,
  };
}

/** 写偏好。配额失败静默（本次会话生效，刷新丢失），不抛给调用方。 */
export function savePetPrefs(prefs: PetPrefs, store: Storage | null = safeStorage()): void {
  if (!store) return;
  const safe: PetPrefs = {
    enabled: prefs.enabled === true,
    agentId: typeof prefs.agentId === "string" && prefs.agentId.trim() ? prefs.agentId.trim() : null,
    modelPath: isValidModelPath(prefs.modelPath) ? prefs.modelPath : DEFAULT_PET_MODEL,
  };
  try {
    store.setItem(PET_PREFS_KEY, JSON.stringify(safe));
  } catch {
    /* 配额/隐私模式：本次会话生效 */
  }
}

/** 把模型相对路径拼成可 fetch 的地址（保持与当前页面同源）。 */
export function petModelUrl(modelPath: string, origin: string): string {
  const path = isValidModelPath(modelPath) ? modelPath : DEFAULT_PET_MODEL;
  const base = origin.replace(/\/$/, "");
  return `${base}/${path}`;
}
