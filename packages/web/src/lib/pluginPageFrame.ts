/**
 * 插件页面帧协议（d.141，规格 §3）：`widget://<id>` 页面 ↔ 渲染层宿主的 postMessage。
 *
 * 页面在自己的 `window` 里用 `parent.postMessage` 说话，宿主只认两种上行消息：
 * - `{ __heming_frame: 1, kind: "ready" }`：页面脚本（含帧桥）已就绪，可以撤加载态；
 * - `{ __heming_frame: 1, kind: "call", id, method, args }`：调一个宿主方法。
 *
 * 宿主回两种下行消息：
 * - `{ __heming_frame: 1, kind: "result", id, ok, value|error }`：对 call 的应答；
 * - `{ __heming_frame: 1, kind: "event", channel, payload }`：主进程推来的事件。
 *
 * 这里只放**纯函数**（解析/打包方法表），生命周期与 postMessage 都在组件里，
 * 方便单测直接钉协议形状而不渲染 React。
 */

import type {
  WidgetPageCallResult,
  WidgetPageEventChannel,
} from "../types/widgets.js";

/** 协议版本；消息顶层 `__heming_frame` 必须严格等于它，其余一律丢弃。 */
export const FRAME_PROTOCOL = 1 as const;

/** 页面 → 宿主的调用请求。`args` 恒为数组（帧桥从 `...args` 收集）。 */
export interface FrameCallMessage {
  __heming_frame: 1;
  kind: "call";
  id: number;
  method: string;
  args: unknown[];
}

/** 页面 → 宿主：帧桥已就绪。 */
export interface FrameReadyMessage {
  __heming_frame: 1;
  kind: "ready";
}

export type FrameInboundMessage = FrameReadyMessage | FrameCallMessage;

/** 宿主 → 页面的调用结果。 */
export type FrameResultMessage =
  | { __heming_frame: 1; kind: "result"; id: number; ok: true; value: unknown }
  | {
      __heming_frame: 1;
      kind: "result";
      id: number;
      ok: false;
      error: { code: string; message: string };
    };

/** 宿主 → 页面的主进程事件。 */
export interface FrameEventMessage {
  __heming_frame: 1;
  kind: "event";
  channel: WidgetPageEventChannel;
  payload: unknown;
}

export type FrameOutboundMessage = FrameResultMessage | FrameEventMessage;

/** call 的两种去路：等结果的 invoke，和不等结果的 fire-and-forget。 */
export type FrameRelayKind = "call" | "send";

/** 未知方法统一错误码（规格 §3；帧桥据此回 `undefined`/抛错）。 */
export const ERR_UNKNOWN_METHOD = "ERR_WIDGET_UNKNOWN_METHOD";

/** 桥缺方法（只有 `pageOpen` 没有 `pageCall/pageSend` 的过渡期桌面端）。 */
export const ERR_BRIDGE_MISSING = "ERR_WIDGET_BRIDGE_MISSING";

/** 桥自己抛错（IPC 断/主进程未就绪）时的错误码。 */
export const ERR_CALL_FAILED = "ERR_WIDGET_PAGE_CALL_FAILED";

/**
 * 宿主方法表（与 packages/desktop 的 `widget-frame-bridge` 对齐）。
 *
 * `state`/窗口几何/`reload`/`on*` 订阅由帧桥在页面内本地处理，**不过宿主**；
 * 表外方法一律回 `ERR_WIDGET_UNKNOWN_METHOD`（能力不增加，规格 §1）。
 */
const CALL_METHODS: ReadonlySet<string> = new Set([
  "info",
  "settings",
  "setSetting",
  "dataGet",
  "dataSet",
  "dataDelete",
  "dataKeys",
  "dataDir",
  "chatConfig",
  "engineStatus",
  "engineCall",
  "infohubCall",
  "notify",
  "homeCardSet",
]);

const SEND_METHODS: ReadonlySet<string> = new Set(["log", "openSettings", "openPage"]);

/** 方法该走 `pageCall` 还是 `pageSend`；不在表里返回 null。 */
export function relayKindOf(method: string): FrameRelayKind | null {
  if (SEND_METHODS.has(method)) return "send";
  if (CALL_METHODS.has(method)) return "call";
  return null;
}

/**
 * 帧桥的参数数组 → 桥的 `payload`。
 *
 * 0 个参数省略 payload（主进程按「无参」处理）；1 个参数裸传值；多个参数传数组
 * （主进程按位还原）。桌面侧对 `undefined`/数组/其它值做了双兼容，两边不会歧义。
 */
export function payloadOfArgs(args: readonly unknown[]): unknown {
  if (args.length === 0) return undefined;
  if (args.length === 1) return args[0];
  return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 解析页面 → 宿主的消息；结构不对、版本不对、字段类型不对都返回 null。
 *
 * 只做形状校验，**不做**来源校验 —— origin/source 由 `isFrameEventTrusted` 负责，
 * 两者缺一不可（规格 §3：必须同时校验，否则任意 frame/页面都能冒充）。
 */
export function parseFrameMessage(data: unknown): FrameInboundMessage | null {
  if (!isRecord(data)) return null;
  if (data.__heming_frame !== FRAME_PROTOCOL) return null;
  if (data.kind === "ready") {
    return { __heming_frame: FRAME_PROTOCOL, kind: "ready" };
  }
  if (data.kind !== "call") return null;
  if (typeof data.id !== "number" || !Number.isFinite(data.id)) return null;
  if (typeof data.method !== "string" || data.method.length === 0) return null;
  let args: unknown[];
  if (data.args === undefined) args = [];
  else if (Array.isArray(data.args)) args = data.args;
  else return null;
  return { __heming_frame: FRAME_PROTOCOL, kind: "call", id: data.id, method: data.method, args };
}

/** 桥调用结果 → 下行 result（顺手兜住桥返回形状不对的情况，别让页面永远等）。 */
export function resultMessage(id: number, result: WidgetPageCallResult): FrameResultMessage {
  if (isRecord(result) && result.ok === true) {
    return {
      __heming_frame: FRAME_PROTOCOL,
      kind: "result",
      id,
      ok: true,
      value: (result as { value: unknown }).value,
    };
  }
  const error =
    isRecord(result) && isRecord(result.error)
      ? {
          code: String(result.error.code ?? ERR_CALL_FAILED),
          message: String(result.error.message ?? ""),
        }
      : { code: ERR_CALL_FAILED, message: "插件页面调用失败" };
  return { __heming_frame: FRAME_PROTOCOL, kind: "result", id, ok: false, error };
}

/** 主进程事件 → 下行 event。 */
export function eventMessage(
  channel: WidgetPageEventChannel,
  payload: unknown,
): FrameEventMessage {
  return { __heming_frame: FRAME_PROTOCOL, kind: "event", channel, payload };
}

/** 页面帧的源：`widget://<插件id>`（协议规定 origin 不含入口路径）。 */
export function frameOrigin(pluginId: string): string {
  return `widget://${pluginId}`;
}

/**
 * 来源校验（规格 §3）：origin 必须是本插件的 `widget://<id>`，且 source 必须是
 * **当前** iframe 的 contentWindow。只查其一都能被其它 frame / 恶意页面冒充。
 */
export function isFrameEventTrusted(
  event: Pick<MessageEvent, "origin" | "source">,
  frameWindow: Window | null,
  pluginId: string,
): boolean {
  if (!frameWindow) return false;
  if (event.source !== frameWindow) return false;
  return event.origin === frameOrigin(pluginId);
}