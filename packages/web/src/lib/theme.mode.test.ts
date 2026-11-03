import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DARK_DEFAULT_ACCENT,
  DEFAULT_ACCENT,
  THEME_MODE_KEY,
  applyThemeMode,
  getThemeMode,
  normalizeThemeMode,
  resetThemeModeWatcherForTest,
  resolveThemeMode,
  setThemeMode,
  systemPrefersDark,
  watchThemeMode,
} from "./theme.js";

/**
 * d.67 T3：主题模式（light / dark / system）的解析、持久化与 DOM 应用。
 *
 * 这些用例只关心「模式」这条线；主题色（accent）的既有用例在 theme.test.ts 里，
 * 这里只验暗色下「默认墨黑 → 浅色强调、自定义色不被覆盖」这条交互规则。
 */

interface FakeMq {
  matches: boolean;
  media: string;
  addEventListener: (type: string, cb: (e: { matches: boolean }) => void) => void;
  removeEventListener: (type: string, cb: (e: { matches: boolean }) => void) => void;
  dispatch: (matches: boolean) => void;
  listenerCount: () => number;
}

/** 可控的 matchMedia：能改 matches 并手动触发 change，用于验证 system 跟随。 */
function installMatchMedia(matches: boolean): FakeMq {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const mq: FakeMq = {
    matches,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_type, cb) => void listeners.add(cb),
    removeEventListener: (_type, cb) => void listeners.delete(cb),
    dispatch: (next) => {
      mq.matches = next;
      for (const cb of [...listeners]) cb({ matches: next });
    },
    listenerCount: () => listeners.size,
  };
  window.matchMedia = vi.fn(() => mq) as unknown as typeof window.matchMedia;
  return mq;
}

function makeStorage(map = new Map<string, string>()) {
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

beforeEach(() => {
  resetThemeModeWatcherForTest();
  delete document.documentElement.dataset.theme;
  document.documentElement.removeAttribute("style");
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeThemeMode / resolveThemeMode", () => {
  it("只认三种合法值，其余（含 null/数字/中文）一律回落 system", () => {
    expect(normalizeThemeMode("light")).toBe("light");
    expect(normalizeThemeMode("dark")).toBe("dark");
    expect(normalizeThemeMode("system")).toBe("system");
    for (const bad of [null, undefined, "", "Dark ", 0, {}, "auto"]) {
      expect(normalizeThemeMode(bad)).toBe("system");
    }
  });

  it("显式模式不受系统偏好影响；system 跟随 prefersDark", () => {
    expect(resolveThemeMode("light", true)).toBe("light");
    expect(resolveThemeMode("dark", false)).toBe("dark");
    expect(resolveThemeMode("system", true)).toBe("dark");
    expect(resolveThemeMode("system", false)).toBe("light");
  });
});

describe("getThemeMode / setThemeMode（持久化）", () => {
  it("无记录 → system；写入后用同一键读回", () => {
    const storage = makeStorage();
    expect(getThemeMode(storage)).toBe("system");

    expect(setThemeMode("dark", storage)).toBe("dark");
    expect(storage.getItem(THEME_MODE_KEY)).toBe("dark");
    expect(getThemeMode(storage)).toBe("dark");
  });

  it("存储里是脏值 → 回落 system（不抛错）", () => {
    const storage = makeStorage(new Map([[THEME_MODE_KEY, "purple"]]));
    expect(getThemeMode(storage)).toBe("system");
  });

  it("非法输入写入时被规整为 system", () => {
    const storage = makeStorage();
    expect(setThemeMode("nope" as never, storage)).toBe("system");
    expect(storage.getItem(THEME_MODE_KEY)).toBe("system");
  });

  it("无 storage（SSR/隐私模式）→ 默认 system，不抛错", () => {
    expect(getThemeMode(null)).toBe("system");
    expect(setThemeMode("light", null)).toBe("light");
  });
});

describe("systemPrefersDark", () => {
  it("跟随 matchMedia；不支持时按浅色处理", () => {
    installMatchMedia(true);
    expect(systemPrefersDark()).toBe(true);
    installMatchMedia(false);
    expect(systemPrefersDark()).toBe(false);

    // @ts-expect-error 模拟老环境没有 matchMedia
    window.matchMedia = undefined;
    expect(systemPrefersDark()).toBe(false);
  });
});

describe("applyThemeMode（写 data-theme 与 color-scheme）", () => {
  it("light / dark 直接生效", () => {
    installMatchMedia(false);
    applyThemeMode("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");

    applyThemeMode("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("system 按当前系统偏好解析并挂监听，系统切换后即时跟随", () => {
    const mq = installMatchMedia(true);
    const dispose = applyThemeMode("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(mq.listenerCount()).toBe(1);

    mq.dispatch(false);
    expect(document.documentElement.dataset.theme).toBe("light");

    dispose();
    expect(mq.listenerCount()).toBe(0);
  });

  it("非 system 模式不挂系统监听", () => {
    const mq = installMatchMedia(true);
    applyThemeMode("light");
    expect(mq.listenerCount()).toBe(0);
  });

  it("暗色下默认墨黑 → 临时换成浅色强调（保证 .bg-ink 可读）", () => {
    installMatchMedia(false);
    applyThemeMode("dark", { accent: DEFAULT_ACCENT });
    expect(document.documentElement.style.getPropertyValue("--heming-accent")).toBe(
      DARK_DEFAULT_ACCENT,
    );
  });

  it("用户自定义主题色在暗色下不被覆盖", () => {
    installMatchMedia(false);
    applyThemeMode("dark", { accent: "#2f5bd7" });
    expect(document.documentElement.style.getPropertyValue("--heming-accent")).toBe("#2f5bd7");
  });

  it("浅色下默认墨黑回到 CSS 默认（不写内联变量、不套用暗色强调）", () => {
    installMatchMedia(false);
    // 先写一个暗色强调，确认切回浅色时会被清掉
    applyThemeMode("dark", { accent: DEFAULT_ACCENT });
    expect(document.documentElement.style.getPropertyValue("--heming-accent")).toBe(
      DARK_DEFAULT_ACCENT,
    );

    applyThemeMode("light", { accent: DEFAULT_ACCENT });
    expect(document.documentElement.style.getPropertyValue("--heming-accent")).toBe("");
  });
});

describe("watchThemeMode（应用级监听器）", () => {
  it("重复调用不会叠加 matchMedia 监听（先摘旧再挂新）", () => {
    const mq = installMatchMedia(false);
    window.localStorage.setItem(THEME_MODE_KEY, "system");
    watchThemeMode();
    expect(mq.listenerCount()).toBe(1);
    watchThemeMode();
    watchThemeMode();
    expect(mq.listenerCount()).toBe(1);
    resetThemeModeWatcherForTest();
    expect(mq.listenerCount()).toBe(0);
  });

  it("从 system 切到 light 后，系统变化不再影响页面", () => {
    const mq = installMatchMedia(false);
    window.localStorage.setItem(THEME_MODE_KEY, "system");
    watchThemeMode();
    expect(mq.listenerCount()).toBe(1);

    window.localStorage.setItem(THEME_MODE_KEY, "light");
    watchThemeMode();
    expect(mq.listenerCount()).toBe(0);
    expect(document.documentElement.dataset.theme).toBe("light");

    mq.dispatch(true); // 即使系统变暗，页面也保持浅色
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
