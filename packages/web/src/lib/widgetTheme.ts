
/**
 * 主窗 → widget 的**主题同步**（d.94 完善）：
 * 主窗挂载后把当前浅/深色发布给主进程，之后跟着 `data-theme` 变化继续发。
 *
 * 为什么单独一个模块：
 * - widget 窗口在独立 origin，读不到主窗的 localStorage/主题设置，只能靠宿主转发；
 * - 主进程启动时也读不到主题（存在渲染层），所以 `getTheme` 只能给上次缓存，
 *   「首次正确」必须靠这里挂载后立刻补一发；
 * - 单测里可以注入 bridge / 观察器，不依赖真实 MutationObserver 与 IPC。
 */

export interface WidgetThemeBridge {
  publish?: (event: { kind: "theme"; theme: "light" | "dark" }) => void;
}

export interface WidgetThemeOptions {
  bridge?: WidgetThemeBridge | null;
  /** 读当前主题（默认看 `<html data-theme>`）。 */
  readTheme?: () => "light" | "dark";
  /** 观察主题变化的订阅器，返回取消函数（默认 MutationObserver 盯 `data-theme`）。 */
  observe?: (cb: () => void) => () => void;
}

export interface WidgetThemeRuntime {
  /** 立即按当前主题发一次（同一主题不重复发）。 */
  publish: () => "light" | "dark" | null;
  stop: () => void;
}

/** 当前页面的浅/深色（与主题模式实现同一来源：`<html data-theme>`）。 */
export function currentTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function defaultObserve(cb: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(cb);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

export function createWidgetThemeSync(options: WidgetThemeOptions = {}): WidgetThemeRuntime {
  const bridge = options.bridge ?? null;
  const readTheme = options.readTheme ?? currentTheme;
  const observe = options.observe ?? defaultObserve;
  let last: "light" | "dark" | null = null;
  let stopped = false;

  const publish = (): "light" | "dark" | null => {
    if (stopped) return null;
    if (!bridge || typeof bridge.publish !== "function") return null;
    const theme = readTheme();
    if (theme === last) return null;
    last = theme;
    try {
      bridge.publish({ kind: "theme", theme });
    } catch {
      /* IPC 抖动：不重试、不排队，下一次主题变化再说（与通知转发同口径） */
    }
    return theme;
  };

  let stopObserve: () => void = () => {};
  if (bridge && typeof bridge.publish === "function") {
    publish();
    stopObserve = observe(() => {
      publish();
    });
  }

  return {
    publish,
    stop: () => {
      stopped = true;
      stopObserve();
    },
  };
}

/** 生产入口：主窗挂载时调用，返回清理函数。 */
export function startWidgetThemeSync(bridge?: WidgetThemeBridge | null): () => void {
  const runtime = createWidgetThemeSync({ bridge });
  return () => runtime.stop();
}
