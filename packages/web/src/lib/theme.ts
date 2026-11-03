/**
 * 页面颜色（主题色）：一套纯函数 + CSS 变量出口。
 *
 * 设计取舍：既有界面有 60+ 处 `bg-ink` / `text-ink`，逐个改成变量既啰嗦又容易漏。
 * 这里只在 index.css 里让 `.bg-ink` 跟随 `--heming-accent`，一处生效、全局跟随；
 * 文字色不动（换主题色不该把所有正文染成蓝色）。
 *
 * 前景色按背景相对亮度自动选黑或白，保证按钮上的字始终读得清。
 */

/** 默认墨色（与 Tailwind ink 同值，保持向后兼容）。 */
export const DEFAULT_ACCENT = "#1a1a1a";

/** 预设色板：设置区一键切换；最后一个「自定义」走 hex 输入。 */
export const ACCENT_PRESETS: { id: string; name: string; color: string }[] = [
  { id: "ink", name: "墨黑", color: "#1a1a1a" },
  { id: "indigo", name: "靛蓝", color: "#2f5bd7" },
  { id: "teal", name: "松绿", color: "#1f6f54" },
  { id: "clay", name: "赭红", color: "#a8422f" },
  { id: "grape", name: "紫", color: "#6b4ea8" },
  { id: "slate", name: "石板", color: "#3f4750" },
];

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * 规整用户输入的十六进制色：补 `#`、三位缩写展开为六位、统一小写。
 * 非法输入返回 null（调用方据此保持原值，不写入脏色）。
 */
export function normalizeHex(input: string): string | null {
  const raw = input.trim();
  const m = HEX.exec(raw);
  if (!m) return null;
  const hex = m[1].toLowerCase();
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  return `#${full}`;
}

/** 十六进制 → [r, g, b]（0–255）；非法色返回 null。 */
export function hexToRgb(hex: string): [number, number, number] | null {
  const normalized = normalizeHex(hex);
  if (!normalized) return null;
  return [
    parseInt(normalized.slice(1, 3), 16),
    parseInt(normalized.slice(3, 5), 16),
    parseInt(normalized.slice(5, 7), 16),
  ];
}

/** WCAG 相对亮度（sRGB → 线性）。 */
export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 在该底色上该用什么字：亮底用近黑，暗底用纯白。 */
export function readableOn(hex: string): string {
  return relativeLuminance(hex) > 0.45 ? "#101010" : "#ffffff";
}

/** 把主题色写进 CSS 变量（`.bg-ink` 在 index.css 里跟随这两个变量）。 */
export function applyAccent(color: string): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--heming-accent", color);
  root.style.setProperty("--heming-on-accent", readableOn(color));
}

/** 清掉内联变量，回到 index.css 里的默认墨色。 */
export function clearAccent(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.removeProperty("--heming-accent");
  root.style.removeProperty("--heming-on-accent");
}

/* ══════════════════════════════════════════════════════════════════════
 * 主题模式（d.67 T3 暗色）：light / dark / system
 * ══════════════════════════════════════════════════════════════════════
 *
 * 与「主题色」（上面那套 accent）是两件事：
 *   · 主题色决定主按钮/选中项等**填充色**；
 *   · 主题模式决定整页是浅色还是暗色（CSS 变量在 `[data-theme="dark"]` 下覆盖）。
 *
 * 为什么这里不碰 React：启动阶段（main.tsx / pet.tsx）要在首帧前应用到 DOM，
 * 那时候还没有组件树；设置页只是再调一次同样的函数即可，避免两套逻辑漂移。
 */

export type ThemeMode = "light" | "dark" | "system";

/** 主题模式本地存储键（与主题色的 `heming.theme.v1` 分开，互不影响）。 */
export const THEME_MODE_KEY = "heming.theme.mode.v1";

/** 暗色下的默认强调色：默认墨黑在深底上对比度约 1.1:1，换成浅色保证 `.bg-ink` 可读。 */
export const DARK_DEFAULT_ACCENT = "#e8eaed";

type ModeStorage = Pick<Storage, "getItem" | "setItem">;

/** 规整任意输入到 ThemeMode；缺失/脏值一律回落 `system`（跟随系统最安全）。 */
export function normalizeThemeMode(raw: unknown): ThemeMode {
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

/** 把「模式 + 系统偏好」解析成最终生效的浅/深色。 */
export function resolveThemeMode(mode: ThemeMode, prefersDark: boolean): "light" | "dark" {
  if (mode === "light" || mode === "dark") return mode;
  return prefersDark ? "dark" : "light";
}

/** 系统当前是否偏好深色；非浏览器环境/不支持 matchMedia 时按浅色处理。 */
export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

function defaultModeStorage(): ModeStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null; // 隐私模式/配额禁用：只在本次会话生效
  }
}

/** 读回主题模式；无记录或脏数据 → `system`。 */
export function getThemeMode(storage: ModeStorage | null = defaultModeStorage()): ThemeMode {
  if (!storage) return "system";
  try {
    return normalizeThemeMode(storage.getItem(THEME_MODE_KEY));
  } catch {
    return "system";
  }
}

/** 写入主题模式（非法值规整为 system 后落盘），返回最终写入的模式。 */
export function setThemeMode(
  mode: ThemeMode,
  storage: ModeStorage | null = defaultModeStorage(),
): ThemeMode {
  const normalized = normalizeThemeMode(mode);
  if (storage) {
    try {
      storage.setItem(THEME_MODE_KEY, normalized);
    } catch {
      /* 存不下就只在本次会话生效 */
    }
  }
  return normalized;
}

/**
 * 把主题模式应用到 DOM，返回清理函数（system 模式下用于摘掉 matchMedia 监听）。
 *
 * 规则：
 * - 写 `<html data-theme="light|dark">` 与 `color-scheme`（原生控件、滚动条跟随）；
 * - `accent` 是当前主题色：暗色且仍是默认墨黑时临时换成浅色强调；
 *   用户自定义过颜色就尊重用户值（spec §3）；
 * - `system` 模式挂 `matchMedia("(prefers-color-scheme: dark)")`，系统切换即时生效。
 */
export function applyThemeMode(
  mode: ThemeMode,
  options: { accent?: string } = {},
): () => void {
  if (typeof document === "undefined") return () => {};
  const root = document.documentElement;
  const accent = options.accent ?? DEFAULT_ACCENT;

  const paint = (current: ThemeMode): void => {
    const resolved = resolveThemeMode(current, systemPrefersDark());
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
    if (resolved === "dark" && accent === DEFAULT_ACCENT) {
      // 暗色 + 默认墨黑：临时换浅色强调（内联变量，高于 index.css 的暗色兜底）
      applyAccent(DARK_DEFAULT_ACCENT);
    } else if (accent === DEFAULT_ACCENT) {
      // 浅色 + 默认墨黑：清掉内联变量，回到 :root 的默认值（不制造冗余内联样式）
      clearAccent();
    } else {
      // 用户自定义色：照用户的值应用，暗色下也不替换
      applyAccent(accent);
    }
  };

  paint(mode);

  if (mode !== "system") return () => {};
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};

  let mq: MediaQueryList;
  try {
    mq = window.matchMedia("(prefers-color-scheme: dark)");
  } catch {
    return () => {};
  }
  const onChange = () => paint("system");
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }
  // 老 WebView（无 addEventListener 的 MediaQueryList）兜底
  const legacy = mq as unknown as {
    addListener?: (cb: () => void) => void;
    removeListener?: (cb: () => void) => void;
  };
  legacy.addListener?.(onChange);
  return () => legacy.removeListener?.(onChange);
}

/** 当前 system 监听器的清理函数（切换模式时先清旧监听，避免叠加）。 */
let systemWatcherDispose: (() => void) | null = null;

/**
 * 启动/切换主题模式：应用当前模式，system 时挂系统监听；重复调用先清理旧监听。
 *
 * 为什么是「watcher」而不是直接用 applyThemeMode 的返回值：应用级监听要活到进程结束，
 * 不能绑在某个组件的 useEffect 清理上（离开设置页就停止跟随系统是 bug）。
 */
export function watchThemeMode(options: { accent?: string } = {}): void {
  if (typeof document === "undefined") return;
  systemWatcherDispose?.();
  systemWatcherDispose = applyThemeMode(getThemeMode(), options);
}

/** 测试用：清掉模块级监听器（生产不需要）。 */
export function resetThemeModeWatcherForTest(): void {
  systemWatcherDispose?.();
  systemWatcherDispose = null;
}
