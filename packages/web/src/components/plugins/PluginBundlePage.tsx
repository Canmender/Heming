import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button.js";
import {
  refreshWidgets,
  useWidgetsStore,
} from "../../lib/widgets/store.js";
import { useUiStore } from "../../store/ui.js";
import {
  widgetsBridge,
  type WidgetPageCallResult,
  type WidgetsBridge,
} from "../../types/widgets.js";
import { AlertIcon, PackageIcon, RefreshIcon } from "../icons.js";
import { ErrorState } from "../ui/ErrorState.js";
import { EmptyState } from "../ui/EmptyState.js";
import {
  ERR_BRIDGE_MISSING,
  ERR_CALL_FAILED,
  ERR_UNKNOWN_METHOD,
  eventMessage,
  frameOrigin,
  isFrameEventTrusted,
  parseFrameMessage,
  payloadOfArgs,
  relayKindOf,
  resultMessage,
  type FrameCallMessage,
  type FrameOutboundMessage,
  type FrameResultMessage,
} from "../../lib/pluginPageFrame.js";

/**
 * 插件页面（d.124 B 路径 / d.141 内嵌）的渲染层宿主。
 *
 * d.141 起页面不再由主进程用原生 `WebContentsView` 盖在渲染层上，而是渲染层卡片里
 * 的一个 `<iframe src="widget://<id>/<entry>">`。这样页面**在 DOM 里**，应用自己的
 * 浮层/抽屉/对话框能正常盖住它（原生视图永远在最上层，这正是用户反馈的「悬浮」问题）。
 *
 * 职责分三层：
 * 1. 生命周期：挂载时 `pageOpen({id, intent})` 拿主进程拼好的 url → `iframe.src`；
 *    卸载/切页时 `pageClose()`。重新加载 = iframe key 自增重挂。
 * 2. 中继：只接受**本插件 origin + 当前 iframe contentWindow** 的 postMessage
 *    （`isFrameEventTrusted`），把 `call` 拆成 `pageCall`/`pageSend` 并把结果
 *    `postMessage` 回帧；`onPageEvent` 的下行事件同样只投进本帧。
 * 3. 状态：页头保留在 iframe 之外；加载/错误态是叠在 iframe 之上的 DOM 节点
 *    （层级由 DOM 顺序决定，自然能被应用浮层盖住）。
 *
 * ★ 旧桌面端/浏览器没有 `pageOpen` 时**降级说明**而不是空壳（规格 §1）：组件渲染
 *   前先判方法是否存在，缺失就不发任何 IPC。
 *
 * ★ 能力不增加（规格 §1）：帧里能调的方法由主进程桥的方法表白名单决定，渲染层
 *   只做「转发 + 未知方法回 `ERR_WIDGET_UNKNOWN_METHOD`」。
 */

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failedResult(code: string, message: string): WidgetPageCallResult {
  return { ok: false, error: { code, message } };
}

/** 把帧桥的一次 `call` 落成桥调用，并把结果打包成下行 result（任何异常都回错，不让帧干等）。 */
async function relayFrameCall(
  bridge: WidgetsBridge,
  pluginId: string,
  call: FrameCallMessage,
): Promise<FrameResultMessage> {
  const kind = relayKindOf(call.method);
  if (!kind) {
    return resultMessage(
      call.id,
      failedResult(ERR_UNKNOWN_METHOD, `插件页面不支持方法：${call.method}`),
    );
  }
  const payload = payloadOfArgs(call.args);
  try {
    if (kind === "send") {
      if (typeof bridge.pageSend !== "function") {
        return resultMessage(
          call.id,
          failedResult(ERR_BRIDGE_MISSING, `当前桌面端不支持页面方法：${call.method}`),
        );
      }
      bridge.pageSend({ id: pluginId, method: call.method, payload });
      return resultMessage(call.id, { ok: true, value: undefined });
    }
    if (typeof bridge.pageCall !== "function") {
      return resultMessage(
        call.id,
        failedResult(ERR_BRIDGE_MISSING, `当前桌面端不支持页面方法：${call.method}`),
      );
    }
    return resultMessage(
      call.id,
      await bridge.pageCall({ id: pluginId, method: call.method, payload }),
    );
  } catch (err) {
    return resultMessage(call.id, failedResult(ERR_CALL_FAILED, reasonOf(err)));
  }
}

type FramePhase = "loading" | "ready" | "error";

export interface PluginBundlePageProps {
  /** 界面插件 id（= 安装目录名，如 `heming.pet`）；路由 `plugin:<pluginId>` 传入。 */
  pluginId: string;
}

export function PluginBundlePage({ pluginId }: PluginBundlePageProps) {
  const record = useWidgetsStore((s) => s.records.find((item) => item.id === pluginId));
  const loaded = useWidgetsStore((s) => s.loaded);

  const [phase, setPhase] = useState<FramePhase>("loading");
  const [pageError, setPageError] = useState<string | null>(null);
  /** 主进程返回的 `widget://` 地址；为空表示还没打开成功（iframe 不挂载）。 */
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  /** 重新加载 = key 自增，让 iframe 换一个 DOM 节点重挂。 */
  const [frameKey, setFrameKey] = useState(0);
  /** 打开失败后重试：自增触发「pageClose → pageOpen」一轮。 */
  const [generation, setGeneration] = useState(0);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  /** 打开轮次：异步返回时用它判「这一轮还是不是当前轮」，避免旧结果杀掉新页面。 */
  const runSeq = useRef(0);

  const bridge = widgetsBridge();
  const canMount = typeof bridge?.pageOpen === "function";
  const page = record?.page;
  const usable = Boolean(record && record.enabled && page);
  const pageEntry = page?.entry ?? "";
  const version = record?.version ?? "";
  const enabled = record?.enabled ?? false;
  const frameTitle = page?.title || record?.name || pluginId;

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
   * 页面生命周期：打开 → 等 ready → 关闭。
   *
   * 依赖只放**原始值**（id / entry / 版本 / 启停 / 打开轮次），不放 `record` 对象：
   * 列表每次刷新都会换新对象，拿对象当依赖会让页面无故重开（页面里的输入会丢）。
   */
  useEffect(() => {
    if (!canMount || !usable) return;
    const activeBridge = widgetsBridge();
    const pageOpen = activeBridge?.pageOpen;
    if (!activeBridge || !pageOpen) return;

    const runId = ++runSeq.current;
    let disposed = false;
    const pluginOrigin = frameOrigin(pluginId);

    setPhase("loading");
    setPageError(null);
    setFrameSrc(null);

    const postToFrame = (message: FrameOutboundMessage): void => {
      iframeRef.current?.contentWindow?.postMessage(message, pluginOrigin);
    };

    const onMessage = (event: MessageEvent): void => {
      if (disposed || runId !== runSeq.current) return;
      // 双重校验：本插件 origin + 当前 iframe 的 contentWindow（规格 §3）。
      if (!isFrameEventTrusted(event, iframeRef.current?.contentWindow ?? null, pluginId)) {
        return;
      }
      const message = parseFrameMessage(event.data);
      if (!message) return;
      if (message.kind === "ready") {
        setPhase("ready");
        return;
      }
      void relayFrameCall(activeBridge, pluginId, message).then((reply) => {
        if (disposed || runId !== runSeq.current) return;
        postToFrame(reply);
      });
    };

    window.addEventListener("message", onMessage);

    const unsubscribe = activeBridge.onPageEvent?.((msg) => {
      if (disposed || runId !== runSeq.current) return;
      if (msg.id !== pluginId) return;
      postToFrame(eventMessage(msg.channel, msg.payload));
    });

    /**
     * 首页卡的 action 会先导航到这里、再把「页面意图」投进 store（d.139）。
     * 用 `getState()` 读而不是当 effect 依赖：意图只是一次性提示，不该因为
     * store 变化重开页面（重开会丢插件页里的输入）。取走即清，避免下次从
     * 侧边栏进来时被旧意图劫持；pluginId 不匹配就当作普通进入。
     */
    const pending = useUiStore.getState().pluginPageIntent;
    const intent = pending?.pluginId === pluginId ? pending.intent : undefined;
    if (intent !== undefined) useUiStore.getState().consumePluginPageIntent();

    pageOpen({
      id: pluginId,
      // 无意图时不带这个键，保持与旧调用方/假桥的浅比对兼容。
      ...(intent === undefined ? {} : { intent }),
    })
      .then((result) => {
        if (runId !== runSeq.current) return; // 已有新一轮打开：收尾交给它
        if (disposed) {
          // 组件已走但页面已打开：主动关掉，别留孤儿（重复调用无害）。
          activeBridge.pageClose?.();
          return;
        }
        if (!result?.ok) {
          setPageError(result?.error ?? "插件页面打开失败");
          setPhase("error");
          return;
        }
        setFrameSrc(result.url);
      })
      .catch((err: unknown) => {
        // IPC 本身失败（桥断了/主进程未就绪）：与业务失败同一套错误态，别白屏。
        if (runId !== runSeq.current) return;
        if (disposed) {
          activeBridge.pageClose?.();
          return;
        }
        setPageError(`挂载插件页面失败：${reasonOf(err)}`);
        setPhase("error");
      });

    return () => {
      disposed = true;
      window.removeEventListener("message", onMessage);
      unsubscribe?.();
      activeBridge.pageClose?.();
    };
  }, [canMount, usable, pluginId, pageEntry, version, enabled, generation]);

  /**
   * 打开失败后重试（也用于页头的「重新加载」在无 iframe 时兜底）：
   * 自增轮次重走 pageClose → pageOpen。
   */
  const retry = useCallback((): void => {
    setPageError(null);
    setPhase("loading");
    setFrameSrc(null);
    setGeneration((n) => n + 1);
  }, []);

  /** 页头「重新加载」：已内嵌时只换 iframe 节点重挂，不重新走主进程 pageOpen。 */
  const reload = useCallback((): void => {
    if (!frameSrc) {
      retry();
      return;
    }
    setPageError(null);
    setPhase("loading");
    setFrameKey((n) => n + 1);
  }, [frameSrc, retry]);

  /** onload 兜底：帧桥的 ready 可能先到也可能后到，任一到达都撤加载态。 */
  const handleFrameLoad = useCallback((): void => {
    setPhase((current) => (current === "error" ? current : "ready"));
  }, []);

  /** 错误态/空态的出路：回到插件区（这里有该插件的启停、更新、卸载入口）。 */
  const openPluginDetails = useCallback((): void => {
    useUiStore.getState().setPage("plugins");
  }, []);

  // ── 降级：浏览器 / 旧版桌面端没有 pageOpen（规格 §1） ──
  if (!canMount) {
    return (
      <section aria-label="插件页面" className="flex h-full items-start justify-center p-6 pt-16">
        <EmptyState
          framed
          className="w-full max-w-[520px]"
          icon={<AlertIcon width={20} height={20} />}
          title="插件页面只在安装版里可用"
          desc="插件的页面是插件包自带的 HTML，必须由桌面端以沙箱 iframe 内嵌渲染；浏览器里没有这个能力，也不会退化成只读的文字页。"
        />
      </section>
    );
  }

  // ── 列表还没读到：先别急着打开页面（记录是前提） ──
  if (!loaded) {
    return (
      <section aria-label="插件页面" className="flex h-full items-start justify-center p-6 pt-16">
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
      <section aria-label="插件页面" className="flex h-full items-start justify-center p-6 pt-16">
        <EmptyState
          framed
          className="w-full max-w-[520px]"
          icon={<PackageIcon width={20} height={20} />}
          title="这个插件没有页面或已被停用"
          desc={detail}
          actions={
            <Button
              type="button"
              onClick={openPluginDetails}
              size="md" variant="primary"
            >
              打开插件详情
            </Button>
          }
        />
      </section>
    );
  }

  // ── 正常态：页头（iframe 之外）+ 圆角卡片里的 iframe（加载/错误态叠在它上面） ──
  return (
    <section aria-label="插件页面" className="flex h-full min-h-0 flex-col gap-2 p-3">
      <header className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-line-soft bg-surface px-3 py-2">
        <span className="plugin-icon-tile h-7 w-7" aria-hidden="true">
          <PackageIcon width={14} height={14} />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h2 className="ui-block-title truncate">{page?.title || record?.name || pluginId}</h2>
            <span className="ui-chip">插件</span>
            <span className="ui-micro ui-numeric">v{version}</span>
          </div>
          {page?.summary ? <p className="ui-caption truncate">{page.summary}</p> : null}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            type="button"
            onClick={reload}
            size="sm" variant="ghost"
            aria-label="重新加载插件页面"
          >
            <RefreshIcon width={12} height={12} aria-hidden="true" />
            重新加载
          </Button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-line-soft bg-surface">
        {frameSrc ? (
          /**
           * 页面内容：`widget://` 独立 origin 的沙箱 iframe。
           * `allow-same-origin` 让页面能读自己的 localStorage / 用相对资源；
           * `allow-scripts` 是页面自身逻辑；不额外给 top-navigation/popup 等能力。
           * `allow-downloads`：导出（信息中枢导出归档、建模室导出模型）走 `<a download>`，
           * 沙箱里不给这条会被浏览器静默丢弃，下载不会开始。
           * `allow="fullscreen; clipboard-write"`：预览全屏（剪辑室）与「复制」按钮
           * （信息中枢/建模室）都是权限策略门控的，跨源帧必须由宿主显式委派。
           */
          <iframe
            key={frameKey}
            ref={iframeRef}
            src={frameSrc}
            title={frameTitle}
            data-testid="plugin-page-frame"
            className="h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin allow-downloads"
            allow="fullscreen; clipboard-write"
            allowFullScreen
            referrerPolicy="no-referrer"
            onLoad={handleFrameLoad}
          />
        ) : null}

        {phase === "loading" && !pageError ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="ui-caption">正在加载插件页面…</p>
          </div>
        ) : null}

        {pageError ? (
          /* 审计 C6：原来是第四套手写的失败态（自定图标砖 + 内联 style 底色 + 两段小字），
             与全站 ErrorState 不一致。改为复用 ui/ErrorState，只保留「盖住 iframe」的定位职责。 */
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-y-auto bg-surface p-6">
            <ErrorState
              className="w-full max-w-[520px]"
              title="插件页面没能显示出来"
              desc={`${pageError}。页面由插件包自带的 HTML 渲染：包文件损坏、入口缺失或插件刚更新过都可能失败，重新加载会按当前安装再打开一次。`}
              onRetry={retry}
              retryLabel="重新加载"
            />
            <Button
              type="button"
              onClick={openPluginDetails}
              size="md" variant="ghost"
            >
              打开插件详情
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}