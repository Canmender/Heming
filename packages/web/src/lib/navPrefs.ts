/**
 * 导航轨显示模式的纯函数层（d.68 · 工作流 B）。
 *
 * 两种模式：
 * - `pinned`（默认）：常显，与 d.67 及之前完全一致——老用户升级后不会「导航不见了」。
 * - `auto`：自动隐藏。导航轨不占布局宽度，左缘留 8px 热区，悬停/快捷键呼出**浮层**，
 *   离开后延迟收回。浮层是 `position: fixed/absolute`，不挤压主内容。
 *
 * 为什么单独一个文件而不是直接写进 store：
 *   · 解析/持久化是纯逻辑，「坏值回落 pinned」这条必须能单测（不需要 React / DOM）；
 *   · 交互默认值（热区宽、收回延迟、动效时长）集中一处，规格与实现不会各写一个数；
 *   · store 只负责把结果装进状态、NavRail 只负责渲染，两边都不再各自解析字符串。
 *
 * 存储键 `heming.nav.mode.v1`：只存 `"pinned"` / `"auto"` 两个字符串；
 * 旧版本没有这个键、手改坏了、或者存的是 JSON 片段（`"\"auto\""`），一律回落 `pinned`。
 */

/** 导航轨显示模式。 */
export type NavMode = "pinned" | "auto";

/** 导航模式本地存储键（与 `heming.navOrder.v1` 同族，互不影响）。 */
export const NAV_MODE_KEY = "heming.nav.mode.v1";

/** 默认模式：常显。默认值就是「不吓到老用户」的兜底，坏数据也回落到它。 */
export const DEFAULT_NAV_MODE: NavMode = "pinned";

/** 左缘热区宽度（像素）：够鼠标扫到，又不至于挡住内容的可点区域。 */
export const NAV_HOTZONE_PX = 8;

/** 鼠标离开导航后多久收回（毫秒）：给「手滑移出去又移回来」留一点容错。
 *  300ms 取自桌面侧栏文献区间（300–400ms，见 docs/research/2026-11-03-d68-ux-solutions.md §2.4）。 */
export const NAV_HIDE_DELAY_MS = 300;

/** 展开/收起动效时长（毫秒）：160ms ease-out，与调研建议的桌面侧栏节奏一致。 */
export const NAV_MOTION_MS = 160;

/** 规整任意输入到 `NavMode`；未知值/非字符串一律回落 `pinned`。 */
export function normalizeNavMode(raw: unknown): NavMode {
  return raw === "pinned" || raw === "auto" ? raw : DEFAULT_NAV_MODE;
}

/**
 * 解析 localStorage 里的原始字符串。
 *
 * 兼容三种历史/手改写法：
 *   1. 纯字符串 `auto`；
 *   2. JSON 字符串 `"auto"`（早期直接 `JSON.stringify(mode)` 落盘的写法）；
 *   3. 其它任何东西 → `pinned`。
 */
export function parseNavMode(raw: string | null | undefined): NavMode {
  if (typeof raw !== "string") return DEFAULT_NAV_MODE;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_NAV_MODE;
  if (trimmed === "pinned" || trimmed === "auto") return trimmed;
  try {
    return normalizeNavMode(JSON.parse(trimmed));
  } catch {
    return DEFAULT_NAV_MODE;
  }
}

/** 读回存储里的模式；storage 缺失（SSR/隐私模式）或读抛错都回落 `pinned`。 */
export function readStoredNavMode(storage: Pick<Storage, "getItem"> | null): NavMode {
  if (!storage) return DEFAULT_NAV_MODE;
  try {
    return parseNavMode(storage.getItem(NAV_MODE_KEY));
  } catch {
    return DEFAULT_NAV_MODE;
  }
}

/** 写盘；存不下（隐私模式/配额满）时只在本次会话生效，不抛错。 */
export function persistNavMode(
  mode: NavMode,
  storage: Pick<Storage, "setItem"> | null = defaultLocalStorage(),
): NavMode {
  const next = normalizeNavMode(mode);
  if (storage) {
    try {
      storage.setItem(NAV_MODE_KEY, next);
    } catch {
      /* 忽略 */
    }
  }
  return next;
}

/** 取当前模式的另一档（固定 ↔ 自动）。 */
export function otherNavMode(mode: NavMode): NavMode {
  return normalizeNavMode(mode) === "pinned" ? "auto" : "pinned";
}

function defaultLocalStorage(): Pick<Storage, "setItem"> | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
