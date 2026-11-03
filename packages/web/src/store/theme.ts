import { create } from "zustand";
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  applyAccent,
  clearAccent,
  normalizeHex,
  watchThemeMode,
} from "../lib/theme.js";

/** 主题色本地存储键（只存色值，前景色运行时算出来）。 */
export const THEME_KEY = "heming.theme.v1";

/** 从 localStorage 读回色值；脏数据/缺失一律回落默认墨色。 */
export function readStoredAccent(storage: Pick<Storage, "getItem"> | null): string {
  if (!storage) return DEFAULT_ACCENT;
  try {
    const raw = storage.getItem(THEME_KEY);
    if (!raw) return DEFAULT_ACCENT;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_ACCENT;
    const color = (parsed as { accent?: unknown }).accent;
    if (typeof color !== "string") return DEFAULT_ACCENT;
    return normalizeHex(color) ?? DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null; // 隐私模式/配额禁用：只在本次会话生效
  }
}

interface ThemeState {
  /** 当前主题色（归一化后的十六进制）。 */
  accent: string;
  /** 设为自定义色；非法值返回 false 且不改动现有值。 */
  setAccent: (color: string) => boolean;
  /** 恢复默认墨色。 */
  resetAccent: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  accent: readStoredAccent(defaultStorage()),
  setAccent: (color) => {
    const normalized = normalizeHex(color);
    if (!normalized) return false;
    set({ accent: normalized });
    applyAccent(normalized);
    try {
      defaultStorage()?.setItem(THEME_KEY, JSON.stringify({ accent: normalized }));
    } catch {
      /* 存不下就只在本次会话生效 */
    }
    return true;
  },
  resetAccent: () => {
    set({ accent: DEFAULT_ACCENT });
    clearAccent();
    try {
      defaultStorage()?.removeItem?.(THEME_KEY);
    } catch {
      /* 同上 */
    }
  },
}));

/** 启动时把存储里的色值应用到 DOM（渲染前调用，避免第一帧闪回默认色）。 */
export function initTheme(): void {
  const accent = useThemeStore.getState().accent;
  if (accent === DEFAULT_ACCENT) return;
  applyAccent(accent);
}

/** 启动时应用「主题模式」：读存储、写 data-theme、system 时挂系统监听。
 *
 * 与 `initTheme` 的分工：initTheme 只负责主题色（accent），本函数负责浅/深色模式；
 * 两者都写 CSS 变量，先后顺序无关。放这里而不是 lib/theme.ts，是为了复用 store
 * 里已经读好的 accent（避免再解析一次 localStorage）。
 */
export function initThemeMode(): void {
  watchThemeMode({ accent: useThemeStore.getState().accent });
}

export { ACCENT_PRESETS, DEFAULT_ACCENT };