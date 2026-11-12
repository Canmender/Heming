import { useCallback, useEffect, useRef, useState } from "react";
import {
  refreshWidgets,
  useWidgetsStore,
} from "../../lib/widgets/store.js";
import { useUiStore } from "../../store/ui.js";
import {
  widgetsBridge,
  type WidgetPageMountResult,
  type WidgetPageRect,
} from "../../types/widgets.js";
import { AlertIcon, PackageIcon, RefreshIcon } from "../icons.js";
import { ERROR_TEXT, HINT } from "./shared.js";

/**
 * 插件页面（d.124 B 路径）的 web 宿主（规格 §5.2）。
 *
 * 职责边界很窄：**页面内容不归渲染层**。插件自带 HTML 由主进程在 `widget://` 独立
 * origin 的沙箱 `WebContentsView` 里跑，主窗只做三件事：
 * 1. 量出一个占位区的矩形（主窗 contentView 坐标，CSS px = DIP），交给 `pageMount`；
 * 2. 窗口/布局变化时把新矩形推给 `pageBounds`；
 * 3. 离开页面（卸载/切页）时 `pageUnmount` 销毁视图，不留孤儿（规格 §2.6）。
 *
 * ★ 为什么占位区只放一个空 div：视图是**原生层**，永远盖在渲染层之上，宿主里
 *   多画的任何元素都看不见。所以页头工具条刻意放在占位区**外面**（上方），
 *   否则会被视图整块遮住。
 *
 * ★ 坐标口径（规格 §5.3）：`getBoundingClientRect()` 相对**视口**原点，而 Electron
 *   窗口的视口就是主窗 `contentView`（自定义标题栏是渲染层 HTML，本来就算在内容区里），
 *   主窗 `zoomFactor` 恒为 1，所以 CSS px 直接就是 DIP，不做任何缩放换算。
 *
 * ★ 旧桌面端/浏览器没有 `pageMount` 时**降级说明**而不是空壳（规格 §2.8）：
 *   组件渲染前先判方法是否存在，缺失就不发任何 IPC。
 */

/** 占位区在宿主里的测量结果 → IPC 契约；取整并钳到 ≥1（主进程还会再钳一次）。 */
function measureRect(el: HTMLElement): WidgetPageRect {
  const box = el.getBoundingClientRect();
  return {
    x: Math.round(box.left),
    y: Math.round(box.top),
    width: Math.max(1, Math.round(box.width)),
    height: Math.max(1, Math.round(box.height)),
  };
}

/** 矩形指纹：ResizeObserver 会为「同尺寸的重复通知」反复触发，去重后再上报。 */
function rectKey(rect: WidgetPageRect): string {
  return `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type MountPhase = "mounting" | "ready" | "error";

export interface PluginBundlePageProps {
  /** 界面插件 id（= 安装目录名，如 `heming.pet`）；路由 `plugin:<pluginId>` 传入。 */
  pluginId: string;
}

export function PluginBundlePage({ pluginId }: PluginBundlePageProps) {
  const record = useWidgetsStore((s) => s.records.find((item) => item.id === pluginId));
  const loaded = useWidgetsStore((s) => s.loaded);

  const [phase, setPhase] = useState<MountPhase>("mounting");
  const [mountError, setMountError] = useState<string | null>(null);
  /** 手动重建视图：自增即触发「卸载 → 重新挂载」一轮。 */
  const [generation, setGeneration] = useState(0);

  const hostRef = useRef<HTMLDivElement | null>(null);
  /** 挂载轮次：异步 IPC 返回时用它判「这一轮还是不是当前轮」，避免旧结果杀掉新视图。 */
  const runSeq = useRef(0);

  const bridge = widgetsBridge();
  const canMount = typeof bridge?.pageMount === "function";
  const page = record?.page;
  const usable = Boolean(record && record.enabled && page);
  const pageEntry = page?.entry ?? "";
  const version = record?.version ?? "";
  const enabled = record?.enabled ?? false;

  /**
   * 直接进页面（没先走插件区）时列表可能还没拉过：补一次。
   * `refreshWidgets` 自带「无桥即 no-op / 失败不抛」的语义，重复调用无害。
   */
  useEffect(() => {
    if (!canMount) return;
    if (useWidgetsStore.getState().loaded) return;
    void refreshWidgets();
  }, [canMount]);

  /**
   * 视图生命周期：挂载 → 尺寸变化 → 清理。
   *
   * 依赖只放**原始值**（id / entry / 版本 / 启停 / 重建轮次），不放 `record` 对象：
   * 列表每次刷新都会换新对象，拿对象当依赖会让视图无故销毁重建（页面里的输入会丢）。
   */
  useEffect(() => {
    if (!canMount || !usable) return;
    const el = hostRef.current;
    const activeBridge = widgetsBridge();
    const pageMount = activeBridge?.pageMount;
    if (!el || !activeBridge || !pageMount) return;

    const runId = ++runSeq.current;
    let disposed = false;
    let ready = false;
    let lastKey = "";

    const report = (): void => {
      if (disposed || runId !== runSeq.current || !ready) return;
      const rect = measureRect(el);
      const key = rectKey(rect);
      if (key === lastKey) return;
      lastKey = key;
      activeBridge.pageBounds?.({ rect });
    };

    // ResizeObserver 覆盖窗口缩放/DPI 变化/侧栏开合/全屏切换（规格 §5.3）；
    // jsdom 等没有它的环境退回 window.resize，至少不错过窗口级变化。
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => report()) : null;
    if (observer) observer.observe(el);
    else window.addEventListener("resize", report);

    const mount = async (): Promise<void> => {
      const rect = measureRect(el);
      lastKey = rectKey(rect);
      setPhase("mounting");
      setMountError(null);
      /**
       * 首页卡的 action 会先导航到这里、再把「页面意图」投进 store（d.139）。
       * 用 `getState()` 读而不是当 effect 依赖：意图只是一次性提示，不该因为
       * store 变化重建视图（重建会丢插件页里的输入）。取走即清，避免下次从
       * 侧边栏进来时被旧意图劫持；pluginId 不匹配就当作普通进入。
       */
      const pending = useUiStore.getState().pluginPageIntent;
      const intent = pending?.pluginId === pluginId ? pending.intent : undefined;
      if (intent !== undefined) useUiStore.getState().consumePluginPageIntent();
      let result: WidgetPageMountResult;
      try {
        result = await pageMount({
          id: pluginId,
          rect,
          // 无意图时不带这个键：旧宿主/旧测试按 `{ id, rect }` 全等比对也能过。
          ...(intent === undefined ? {} : { intent }),
        });
      } catch (err) {
        // IPC 本身失败（桥断了/主进程未就绪）：与业务失败同一套错误态，别白屏。
        if (runId !== runSeq.current) return;
        if (disposed) {
          activeBridge.pageUnmount?.();
          return;
        }
        setPhase("error");
        setMountError(`挂载插件页面失败：${reasonOf(err)}`);
        return;
      }
      if (runId !== runSeq.current) return; // 已有新一轮挂载：收尾交给它
      if (disposed) {
        // 组件已走但视图已建：主动销毁，别留孤儿（规格 §2.6）。重复调用无害。
        activeBridge.pageUnmount?.();
        return;
      }
      if (result?.ok) {
        ready = true;
        setPhase("ready");
        return;
      }
      // 失败时也清一次视图：主进程可能已建过半个视图，它盖在错误提示上面就什么都看不到。
      activeBridge.pageUnmount?.();
      setPhase("error");
      setMountError(result?.error ?? "页面视图创建失败");
    };
    void mount();

    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener("resize", report);
      activeBridge.pageUnmount?.();
    };
  }, [canMount, usable, pluginId, pageEntry, version, enabled, generation]);

  const rebuild = useCallback((): void => {
    setMountError(null);
    setPhase("mounting");
    setGeneration((n) => n + 1);
  }, []);

  /** 错误态/空态的出路：回到插件区（这里有该插件的启停、更新、卸载入口）。 */
  const openPluginDetails = useCallback((): void => {
    useUiStore.getState().setPage("plugins");
  }, []);

  // ── 降级：浏览器 / 旧版桌面端没有页面视图方法（规格 §2.8、§5.2.3） ──
  if (!canMount) {
    return (
      <section aria-label="插件页面" className="flex h-full items-center justify-center p-6">
        <div className="flex max-w-[520px] flex-col items-center gap-2 rounded-xl border border-line-soft bg-[var(--surface)] px-6 py-10 text-center shadow-card">
          <span className="plugin-icon-tile mb-1 h-11 w-11" aria-hidden="true">
            <AlertIcon width={20} height={20} />
          </span>
          <p className="ui-section-title">插件页面只在安装版里可用</p>
          <p className={HINT}>
            插件的页面是插件包自带的 HTML，必须在桌面端的独立沙箱视图里渲染；
            浏览器里没有这个能力，也不会退化成只读的文字页。
          </p>
        </div>
      </section>
    );
  }

  // ── 列表还没读到：先别急着实例化视图（记录是挂载的前提） ──
  if (!loaded) {
    return (
      <section aria-label="插件页面" className="flex h-full items-center justify-center p-6">
        <p className="ui-caption">正在读取插件…</p>
      </section>
    );
  }

  // ── 空态：无记录 / 已停用 / 清单没有 page ──
  if (!usable) {
    const detail = !record
      ? "没有找到这个插件的安装记录，可能已被卸载。"
      : !record.enabled
        ? `「${record.name}」已被停用，启用后才会显示它的页面。`
        : `「${record.name}」的清单里没有声明页面（contributions.page）。`;
    return (
      <section aria-label="插件页面" className="flex h-full items-center justify-center p-6">
        <div className="flex max-w-[520px] flex-col items-center gap-2 rounded-xl border border-line-soft bg-[var(--surface)] px-6 py-10 text-center shadow-card">
          <span className="plugin-icon-tile mb-1 h-11 w-11" aria-hidden="true">
            <PackageIcon width={20} height={20} />
          </span>
          <p className="ui-section-title">这个插件没有页面或已被停用</p>
          <p className={HINT}>{detail}</p>
          <button
            type="button"
            onClick={openPluginDetails}
            className="ui-btn ui-btn-md ui-btn-primary"
          >
            打开插件详情
          </button>
        </div>
      </section>
    );
  }

  // ── 正常态：页头工具条（占位区外，不会被视图遮住）+ 占位区（视图叠在它上面） ──
  return (
    <section aria-label="插件页面" className="flex h-full min-h-0 flex-col gap-2 p-3">
      <header className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-line-soft bg-[var(--surface)] px-3 py-2">
        <span className="plugin-icon-tile h-7 w-7" aria-hidden="true">
          <PackageIcon width={14} height={14} />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h2 className="ui-section-title truncate">{page?.title || record?.name || pluginId}</h2>
            <span className="ui-chip">插件</span>
            <span className="ui-micro ui-numeric">v{version}</span>
          </div>
          {page?.summary ? <p className="ui-caption truncate">{page.summary}</p> : null}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={rebuild}
            className="ui-btn ui-btn-sm ui-btn-ghost"
            aria-label="重新加载插件页面"
          >
            <RefreshIcon width={12} height={12} aria-hidden="true" />
            重新加载
          </button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-line-soft bg-[var(--surface)]">
        {/* 视图的落点：铺满内容区，position: relative 作为主进程叠放坐标的基准。 */}
        <div
          ref={hostRef}
          data-testid="plugin-page-host"
          style={{ position: "relative" }}
          className="h-full w-full"
        >
          {phase === "mounting" && !mountError ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <p className="ui-caption">正在加载插件页面…</p>
            </div>
          ) : null}
        </div>

        {mountError ? (
          <div
            role="alert"
            aria-label="插件页面错误"
            className="absolute inset-0 flex items-center justify-center p-6"
            style={{ backgroundColor: "var(--surface)" }}
          >
            <div className="flex max-w-[520px] flex-col items-center gap-2 text-center">
              <span className="plugin-icon-tile mb-1 h-11 w-11" aria-hidden="true">
                <AlertIcon width={20} height={20} />
              </span>
              <p className="ui-section-title">插件页面没能显示出来</p>
              <p className={ERROR_TEXT}>{mountError}</p>
              <p className={HINT}>
                页面视图由主进程创建，包文件损坏、入口缺失或插件刚更新过都可能失败；重建视图
                会按当前安装重新加载一次。
              </p>
              <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={rebuild}
                  className="ui-btn ui-btn-md ui-btn-primary"
                >
                  重建视图
                </button>
                <button
                  type="button"
                  onClick={openPluginDetails}
                  className="ui-btn ui-btn-md ui-btn-ghost"
                >
                  打开插件详情
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
