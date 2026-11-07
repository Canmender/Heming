/**
 * widget preload 桥（宿主注入 `window.__heming_widget`）。
 *
 * 契约见 `docs/superpowers/specs/2026-11-07-d94-pet-as-plugin.md` §3.4。
 *
 * ★ 这个包跑在**独立 origin** `widget://heming.pet/...` 下：读不到 `app://heming` 的
 *   localStorage，也没有 Node / fs / 会话 / 密钥桥。所以这里不出现任何宿主存储模块：
 *   - 偏好 → `settings()/setSetting()/onSettings()`（宿主存 userData/plugins/<id>/settings.json）
 *   - 主题 → `info().theme` / `onEvent({kind:"theme"})`
 *   - 事件 → `onEvent()`（宿主主窗脱敏转发）
 *   - 对话 → `chatConfig()`（本机 magpie 网关地址 + 网关 Key；用户供应商 Key 不经过这里）
 *
 * 本模块只做两件事：类型声明 + 一层容错包装。容错是为了两件事：
 * 1. jsdom 单测里只需提供用到的那几个方法（不要求每个 mock 都实现全接口）；
 * 2. 旧宿主 preload 缺某个方法时不白屏——能力探测按方法是否存在。
 */

export interface WidgetState {
  visible: boolean;
  scale: number;
  clickThrough: boolean;
}

export interface WidgetInfo {
  pluginId: string;
  pluginName: string;
  appVersion: string;
  theme: "light" | "dark";
}

/** 对话上下文：网关地址/网关 Key + 可用智能体 + 当前绑定（`binding.agentId`）。 */
export interface ChatConfig {
  /** 宿主解析不到网关时会给 `null`（此时按「未配置」处理，不假装能聊）。 */
  gateway: { baseUrl: string | null; key: string };
  agents: Array<{ id: string; name: string; prompt?: string }>;
  binding: { agentId: string | null };
  /**
   * 宿主要求用的模型 id（可选，前向兼容）。缺省时由包内按网关 `/v1/models`
   * 的目录选第一个可用模型——`chatConfig` 的 P0 契约里没有模型字段。
   */
  model?: string;
}

/** 宿主经 `onEvent` 推来的事件（规格 §3.4）。 */
export type WidgetEvent =
  | { kind: "notify"; title: string; summary?: string; route?: string; at?: string }
  | { kind: "theme"; theme: "light" | "dark" }
  | { kind: "tray"; action: string };

export interface WidgetBridge {
  // 窗口
  state(): Promise<WidgetState>;
  show(): Promise<void>;
  hide(): void;
  toggle(): void;
  setScale(dir: 1 | -1): Promise<{ scale: number }>;
  setClickThrough(on: boolean): Promise<boolean>;
  setInteractive(on: boolean): void;
  dragStart(): void;
  dragMove(): void;
  dragEnd(): void;
  resetPosition(): void;
  reload(): void;
  // 宿主环境
  info(): Promise<WidgetInfo>;
  settings(): Promise<Record<string, unknown>>;
  setSetting(key: string, value: unknown): Promise<Record<string, unknown>>;
  onSettings(cb: (settings: Record<string, unknown>) => void): () => void;
  onEvent(cb: (event: unknown) => void): () => void;
  // 跳转
  openSettings(): void;
  openPage(page: string): void;
  // 对话上下文（Key 不出主进程的 P1 之前，给的是本机网关地址与网关 Key）
  chatConfig(): Promise<ChatConfig>;
  log(line: string): void;
}

/** 读宿主注入的原始桥；浏览器直开（没有 preload）时为 null。 */
export function getRawWidgetBridge(): Partial<WidgetBridge> | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { __heming_widget?: unknown }).__heming_widget;
  return bridge && typeof bridge === "object" ? (bridge as Partial<WidgetBridge>) : null;
}

/** 包装后的桥：每个方法都有安全兜底，组件里不用到处写 `?.`。 */
export interface WidgetApi {
  /** 是否存在真实 preload 桥（浏览器预览时 false，只保留纯渲染能力）。 */
  available: boolean;
  state(): Promise<WidgetState>;
  show(): Promise<void>;
  hide(): void;
  setScale(dir: 1 | -1): Promise<{ scale: number }>;
  setClickThrough(on: boolean): Promise<boolean>;
  setInteractive(on: boolean): void;
  dragStart(): void;
  dragMove(): void;
  dragEnd(): void;
  resetPosition(): void;
  reload(): void;
  info(): Promise<WidgetInfo>;
  settings(): Promise<Record<string, unknown>>;
  setSetting(key: string, value: unknown): Promise<Record<string, unknown>>;
  onSettings(cb: (settings: Record<string, unknown>) => void): () => void;
  onEvent(cb: (event: unknown) => void): () => void;
  openSettings(): void;
  openPage(page: string): void;
  chatConfig(): Promise<ChatConfig | null>;
  log(line: string): void;
}

const FALLBACK_STATE: WidgetState = Object.freeze({
  visible: true,
  scale: 1,
  clickThrough: false,
});

const FALLBACK_INFO: WidgetInfo = Object.freeze({
  pluginId: "heming.pet",
  pluginName: "桌宠",
  appVersion: "",
  theme: "light",
});

const NOOP_UNSUBSCRIBE = () => {};

/** 把「可能不存在 / 可能抛」的桥调用收敛成确定行为。 */
export function createWidgetApi(override?: Partial<WidgetBridge> | null): WidgetApi {
  const raw = override === undefined ? getRawWidgetBridge() : override;

  const call = async <T>(fn: (() => T | Promise<T>) | undefined, fallback: T): Promise<T> => {
    if (typeof fn !== "function") return fallback;
    try {
      return (await fn()) ?? fallback;
    } catch {
      return fallback;
    }
  };

  return {
    available: !!raw,
    state: () => call(raw?.state, FALLBACK_STATE),
    show: async () => {
      await call(raw?.show, undefined);
    },
    hide: () => {
      try {
        raw?.hide?.();
      } catch {
        /* 窗口正在销毁 */
      }
    },
    setScale: (dir) => call(raw?.setScale ? () => raw.setScale!(dir) : undefined, { scale: 1 }),
    setClickThrough: (on) =>
      call(raw?.setClickThrough ? () => raw.setClickThrough!(on) : undefined, false),
    setInteractive: (on) => {
      try {
        raw?.setInteractive?.(on);
      } catch {
        /* 宿主未就绪 */
      }
    },
    dragStart: () => {
      try {
        raw?.dragStart?.();
      } catch {
        /* 宿主未就绪 */
      }
    },
    dragMove: () => {
      try {
        raw?.dragMove?.();
      } catch {
        /* 宿主未就绪 */
      }
    },
    dragEnd: () => {
      try {
        raw?.dragEnd?.();
      } catch {
        /* 宿主未就绪 */
      }
    },
    resetPosition: () => {
      try {
        raw?.resetPosition?.();
      } catch {
        /* 宿主未就绪 */
      }
    },
    reload: () => {
      try {
        raw?.reload?.();
      } catch {
        /* 宿主未就绪 */
      }
    },
    info: async () => {
      const info = await call(raw?.info, FALLBACK_INFO);
      return { ...FALLBACK_INFO, ...info };
    },
    settings: () => call(raw?.settings, {} as Record<string, unknown>),
    setSetting: (key, value) =>
      call(
        raw?.setSetting ? () => raw.setSetting!(key, value) : undefined,
        {} as Record<string, unknown>,
      ),
    onSettings: (cb) => {
      try {
        return raw?.onSettings?.(cb) ?? NOOP_UNSUBSCRIBE;
      } catch {
        return NOOP_UNSUBSCRIBE;
      }
    },
    onEvent: (cb) => {
      try {
        return raw?.onEvent?.(cb) ?? NOOP_UNSUBSCRIBE;
      } catch {
        return NOOP_UNSUBSCRIBE;
      }
    },
    openSettings: () => {
      try {
        raw?.openSettings?.();
      } catch {
        /* 宿主未就绪 */
      }
    },
    openPage: (page) => {
      try {
        raw?.openPage?.(page);
      } catch {
        /* 宿主未就绪 */
      }
    },
    chatConfig: () => call(raw?.chatConfig, null as ChatConfig | null),
    log: (line) => {
      try {
        raw?.log?.(line);
      } catch {
        /* 宿主未就绪 */
      }
    },
  };
}

/** 主题：宿主主窗与小组件共用一份选择，widget 侧只写根属性（样式全是内联的）。 */
export function applyWidgetTheme(theme: "light" | "dark" | null | undefined): void {
  if (typeof document === "undefined") return;
  const value = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = value;
  document.documentElement.style.colorScheme = value;
}

/** 从 onEvent 的载荷里认「主题变更」（畸形载荷一律忽略）。 */
export function themeOfWidgetEvent(raw: unknown): "light" | "dark" | null {
  if (!raw || typeof raw !== "object") return null;
  const event = raw as { kind?: unknown; theme?: unknown };
  if (event.kind !== "theme") return null;
  return event.theme === "dark" ? "dark" : event.theme === "light" ? "light" : null;
}
