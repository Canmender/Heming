/**
 * HTTP 请求：工作流唯一允许出网的节点。
 *
 * 为什么节点里没有一句 `fetch`：网络出口统一由宿主注入（本机服务用全局 fetch
 * 实现），节点只依赖 `context.helpers.httpRequest` 这个抽象——超时、取消、
 * 状态码归一只有一份实现，测试里也能用假实现替换，不碰真实网络（CONTRACT §6.2）。
 *
 * 只允许 http/https：`file:`、`data:` 之类的协议在本机服务里等于读本机文件，
 * 属于安全边界，宁可在参数校验处就报错，也不交给下游实现去猜。
 *
 * 输出约定：响应体是对象 ⇒ 一条 item；是数组 ⇒ 一个元素一条 item；
 * 是标量/文本 ⇒ 放进 `data` 字段；空响应（204/HEAD）⇒ 一条空 item。
 */

import type { INodeType, Item } from "../../types.js";
import {
  clampInteger,
  errorText,
  inputItems,
  isPlainObject,
  normalizeToItems,
  parseJsonParameter,
  readBoolean,
  readJsonObject,
  readNumber,
  readOption,
  readString,
  WorkflowNodeError,
} from "./helpers.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
type HttpMethod = (typeof METHODS)[number];

const BODY_TYPES = ["none", "json", "text", "form"] as const;
type BodyType = (typeof BODY_TYPES)[number];

const RESPONSE_TYPES = ["json", "text", "base64"] as const;
type ResponseType = (typeof RESPONSE_TYPES)[number];

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

/** 从错误对象上读 HTTP 状态码（桥接层与 fetch 的错误各用不同字段名）。 */
function readHttpCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ["httpCode", "statusCode", "status"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/** 把查询参数拼到 URL 上（值做 URL 编码；已有 query 时用 & 续接）。 */
function appendQuery(url: string, query: Record<string, string>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  if (parts.length === 0) return url;
  const separator = url.includes("?") ? (url.endsWith("?") || url.endsWith("&") ? "" : "&") : "?";
  return `${url}${separator}${parts.join("&")}`;
}

function headersToRecord(raw: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    headers[key] = typeof value === "string" ? value : String(value);
  }
  return headers;
}

/** 查询参数在契约里是 `Record<string, string>`，非字符串值在这里统一转字符串。 */
function queryToRecord(raw: Record<string, unknown>): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    query[key] = typeof value === "string" ? value : String(value);
  }
  return query;
}

function buildBody(
  context: Parameters<INodeType["execute"]>[0],
  bodyType: BodyType,
): unknown {
  switch (bodyType) {
    case "json": {
      const parsed = parseJsonParameter(context.getNodeParameter<unknown>("jsonBody", {}), "JSON 请求体");
      return parsed === undefined ? undefined : parsed;
    }
    case "text": {
      const value = context.getNodeParameter<unknown>("textBody", "");
      if (typeof value === "string") return value;
      return value === undefined || value === null ? undefined : String(value);
    }
    case "form": {
      const raw = context.getNodeParameter<unknown>("formBody", {});
      const parsed = parseJsonParameter(raw, "表单请求体");
      if (parsed === undefined) return undefined;
      if (!isPlainObject(parsed)) {
        throw new WorkflowNodeError("表单请求体必须是一个 JSON 对象", {
          description: '例如 {"name":"示例","kind":"workflow"}。',
        });
      }
      return parsed;
    }
    case "none":
    default:
      return undefined;
  }
}

function responseToItems(body: unknown): Item[] {
  if (body === undefined || body === null || body === "") return [{ json: {} }];
  if (Array.isArray(body)) return normalizeToItems(body);
  if (isPlainObject(body)) return [{ json: body }];
  return [{ json: { data: body } }];
}

export const httpRequestNode: INodeType = {
  description: {
    type: "httpRequest",
    displayName: "HTTP 请求",
    group: "action",
    description: "调用 http/https 接口（由本机服务发起，不受浏览器跨域限制）。",
    icon: "globe",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "method",
        displayName: "方法",
        type: "options",
        default: "GET",
        options: [
          { name: "GET", value: "GET" },
          { name: "POST", value: "POST" },
          { name: "PUT", value: "PUT" },
          { name: "PATCH", value: "PATCH" },
          { name: "DELETE", value: "DELETE" },
          { name: "HEAD", value: "HEAD" },
        ],
      },
      {
        name: "url",
        displayName: "请求地址",
        type: "string",
        default: "",
        required: true,
        placeholder: "https://api.example.com/items",
        description: "必须是以 http:// 或 https:// 开头的完整地址；支持 {{ }} 表达式。",
      },
      {
        name: "headers",
        displayName: "请求头",
        type: "json",
        default: {},
        description: '形如 {"Authorization":"Bearer xxx"}。',
      },
      {
        name: "query",
        displayName: "查询参数",
        type: "json",
        default: {},
        description: '形如 {"page":"1"}，会做 URL 编码后拼到地址上。',
      },
      {
        name: "bodyType",
        displayName: "请求体类型",
        type: "options",
        default: "json",
        description: "GET/HEAD 不使用请求体（会被忽略）。",
        options: [
          { name: "无", value: "none" },
          { name: "JSON", value: "json" },
          { name: "文本", value: "text" },
          { name: "表单", value: "form" },
        ],
      },
      {
        name: "jsonBody",
        displayName: "JSON 请求体",
        type: "json",
        default: {},
        displayOptions: { show: { bodyType: ["json"] } },
      },
      {
        name: "textBody",
        displayName: "文本请求体",
        type: "multiline",
        default: "",
        rows: 4,
        displayOptions: { show: { bodyType: ["text"] } },
      },
      {
        name: "formBody",
        displayName: "表单请求体",
        type: "json",
        default: {},
        displayOptions: { show: { bodyType: ["form"] } },
      },
      {
        name: "timeoutMs",
        displayName: "超时（毫秒）",
        type: "number",
        default: DEFAULT_TIMEOUT_MS,
        description: `1–${MAX_TIMEOUT_MS} 毫秒，缺省 30 秒。`,
      },
      {
        name: "responseFormat",
        displayName: "响应格式",
        type: "options",
        default: "json",
        options: [
          { name: "JSON", value: "json" },
          { name: "文本", value: "text" },
          { name: "Base64", value: "base64" },
        ],
      },
      {
        name: "neverError",
        displayName: "非 2xx 也继续",
        type: "boolean",
        default: false,
        description: "关闭时 4xx/5xx 会让节点失败（错误里带状态码）；开启后状态码交给下游处理。",
      },
    ],
  },

  async execute(context) {
    const method = readOption<HttpMethod>(context, "method", METHODS, "GET");
    const url = readString(context, "url", "").trim();
    if (!url) {
      throw new WorkflowNodeError("HTTP 请求缺少 URL");
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new WorkflowNodeError("HTTP 请求只允许 http:// 或 https:// 地址", {
        description: `收到的是：${url.slice(0, 80)}`,
      });
    }

    const bodyType =
      method === "GET" || method === "HEAD"
        ? "none"
        : readOption<BodyType>(context, "bodyType", BODY_TYPES, "json");
    const timeoutMs = clampInteger(
      readNumber(context, "timeoutMs", DEFAULT_TIMEOUT_MS),
      1,
      MAX_TIMEOUT_MS,
    );
    const neverError = readBoolean(context, "neverError", false);
    const responseType = readOption<ResponseType>(
      context,
      "responseFormat",
      RESPONSE_TYPES,
      "json",
    );

    const headers = headersToRecord(readJsonObject(context, "headers", "请求头"));
    const query = queryToRecord(readJsonObject(context, "query", "查询参数"));
    const body = buildBody(context, bodyType);
    const finalUrl = appendQuery(url, query);

    let response;
    try {
      response = await context.helpers.httpRequest({
        method,
        // 查询参数已经编码进 URL；不再重复传 query，避免桥接层再拼一次。
        url: finalUrl,
        headers,
        body,
        bodyType,
        timeoutMs,
        responseType,
      });
    } catch (error) {
      throw new WorkflowNodeError(`HTTP 请求失败：${errorText(error)}`, {
        httpCode: readHttpCode(error),
        description: "检查地址/网络/超时，以及本机服务的网络出口是否可用。",
        cause: error,
      });
    }

    const status = response.statusCode;
    if (!neverError && status >= 400) {
      const preview = errorText(response.body).slice(0, 300);
      throw new WorkflowNodeError(`HTTP 请求失败：${status}`, {
        httpCode: String(status),
        description: preview,
      });
    }

    return { main: [responseToItems(response.body)] };
  },
};
