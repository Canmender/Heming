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