import { useNotificationStore, type AppNotification } from "../store/notifications.js";
import { widgetsBridge, type WidgetNotifyEvent, type WidgetsBridge } from "../types/widgets.js";

/**
 * 通知中心 → 界面插件的事件转发（d.98 · 规格 §4.2）。
 *
 * 这是原桌宠「在场感」（`lib/petEvent.ts`）拆插件后的宿主侧替代：
 * 主窗只负责**订阅新通知 → 脱敏 → 经 `window.__heming_widgets.publish()` 交给主进程**；
 * 主进程按插件清单 `permissions.events` 含 `notify` 决定转给哪个 widget；
 * widget 是否冒泡、是否只换姿态由它自己按设置决定（对应原「打扰强度」）。
 *
 * ★ 脱敏口径（规格 §4.2，硬约定）：
 *   只带 `kind / title(≤60) / summary(≤60) / route / at`；
 *   **不带正文、附件、会话名、发送人、conversationId / taskId / automationId**。
 *   `summary` 只由「已决定要展示的通知级信息」派生：
 *   - 幕僚简报：通知里的简报摘要（≤60 字，与旧桌宠口径一致）；
 *   - 待确认：工具显示名（不是参数/正文）；
 *   - 任务收尾 / 自动化失败：**不带 summary**（标题已含状态，正文可能是执行细节/错误堆栈）。
 *
 * ★ 渠道互斥不再在渲染层做：主窗在前台时是否打扰用户由**主进程**判断（它知道窗口焦点），
 *   本文件只做「脱敏上报」这一件事，不做频控也不排队（错过不补发）。
 */

/** 单条事件文本硬上限（规格 §4.2：title / summary 均 ≤60 字）。 */
export const WIDGET_EVENT_TEXT_MAX = 60;

/** 通知类型 → 主窗可达页面（与主进程 `widgets:open-page` 白名单同源）。 */
const NOTIFY_ROUTES: Partial<Record<AppNotification["kind"], string>> = {
  task: "tasks",
  staff: "staff",
};

/** 压成一行并截断到上限（按字符计数，避免把 emoji 劈成半个）。 */
export function clipWidgetEventText(text: unknown, max = WIDGET_EVENT_TEXT_MAX): string {
  const oneLine = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (!oneLine) return "";
  const chars = [...oneLine];
  if (chars.length <= max) return oneLine;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/**
 * 通知的「可转发摘要」按类型收口（见文件头脱敏口径）。
 * 空串表示这条事件只带标题，不额外泄漏内容。
 */
function summaryOf(item: Pick<AppNotification, "kind" | "body">): string {
  if (item.kind === "staff" || item.kind === "approval") {
    return clipWidgetEventText(item.body);
  }
  return "";
}

/**
 * 一条通知 → 一条可转发事件（纯函数）。
 *
 * 返回 null = 这条不该转发（标题为空/时间不可用等畸形数据），调用方静默跳过。
 */
export function buildWidgetNotifyEvent(
  item: Pick<AppNotification, "kind" | "title" | "body" | "createdAt">,
): WidgetNotifyEvent | null {
  const title = clipWidgetEventText(item.title);
  if (!title) return null;
  const summary = summaryOf(item);
  const route = NOTIFY_ROUTES[item.kind];
  const createdAt = typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
    ? item.createdAt
    : Date.now();
  return {
    kind: "notify",
    title,
    summary,
    ...(route ? { route } : {}),
    at: new Date(createdAt).toISOString(),
  };
}

/** 运行器依赖（单测注入；生产见 `startWidgetEvents`）。 */
export interface WidgetEventsRuntimeDeps {
  /** 转发给主进程（生产 = `window.__heming_widgets.publish`）。 */
  publish(event: WidgetNotifyEvent): void;
  /** 订阅「通知中心新增条目」；返回退订函数。 */
  subscribe(listener: (item: AppNotification) => void): () => void;
}

export interface WidgetEventsRuntime {
  /** 处理一条通知；返回是否转发成功（便于测试与诊断）。 */
  handle(item: AppNotification): boolean;
  dispose(): void;
}

/**
 * 事件转发运行器：订阅新通知 → 脱敏 → publish。
 *
 * publish 抛错（IPC 抖动/主进程未就绪）只吞掉这一条：不重试、不排队（错过不补发），
 * 单条坏通知也不该中断订阅。
 */
export function createWidgetEvents(deps: WidgetEventsRuntimeDeps): WidgetEventsRuntime {
  let disposed = false;
  const handle = (item: AppNotification): boolean => {
    if (disposed) return false;
    const event = buildWidgetNotifyEvent(item);
    if (!event) return false;
    try {
      deps.publish(event);
      return true;
    } catch {
      return false;
    }
  };
  const unsubscribe = deps.subscribe((item) => {
    try {
      handle(item);
    } catch {
      /* 单条坏通知不中断订阅 */
    }
  });
  return {
    handle,
    dispose() {
      disposed = true;
      try {
        unsubscribe();
      } catch {
        /* 退订失败无副作用 */
      }
    },
  };
}

/**
 * 订阅通知中心**新增**条目（只处理订阅之后出现的；错过不补发）。
 *
 * 用 id 集合差集而不是 `items[0]`：一次可能插多条，且列表按时间倒序。
 * 按发生顺序（旧 → 新）交给上层，与通知中心的阅读顺序一致。
 */
export function subscribeNewNotifications(
  listener: (item: AppNotification) => void,
  store: typeof useNotificationStore = useNotificationStore,
): () => void {
  let known = new Set(store.getState().items.map((item) => item.id));
  return store.subscribe((state, prev) => {
    if (state.items === prev.items) return;
    const fresh = state.items.filter((item) => !known.has(item.id));
    known = new Set(state.items.map((item) => item.id));
    for (const item of [...fresh].reverse()) listener(item);
  });
}

/** 测试隔离：清掉单例（不影响 localStorage）。 */
let eventsRuntime: WidgetEventsRuntime | null = null;

export function resetWidgetEvents(): void {
  eventsRuntime?.dispose();
  eventsRuntime = null;
}

/**
 * 主窗启动时调用一次（App 挂载处）。返回退订函数。
 *
 * 浏览器/无界面插件桥时是空操作（云端网页没有 widget 可转发）。
 * 幂等：重复调用只保留第一个运行器（HMR/重渲染不会重复订阅）。
 */
export function startWidgetEvents(
  overrides: Partial<WidgetEventsRuntimeDeps> = {},
  bridge: WidgetsBridge | undefined = widgetsBridge(),
): () => void {
  if (eventsRuntime) return () => {};
  if (!bridge || typeof bridge.publish !== "function") return () => {};
  const runtime = createWidgetEvents({
    publish: (event) => bridge.publish(event),
    subscribe: (listener) => subscribeNewNotifications(listener),
    ...overrides,
  });
  eventsRuntime = runtime;
  return () => {
    runtime.dispose();
    if (eventsRuntime === runtime) eventsRuntime = null;
  };
}
