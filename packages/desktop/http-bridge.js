"use strict";
/**
 * 工作流 HTTP 桥（d.87）。
 *
 * 为什么需要主进程代发：渲染进程的 `fetch` 受同源策略限制，工作流里的「HTTP 请求」
 * 节点一旦请求第三方接口就会被 CORS 拦下——而 n8n 这类服务端引擎没有这个问题。
 * 桌面端由主进程用 Node 的 fetch 代发，既绕开 CORS，也能走系统代理。
 *
 * 安全边界（改之前先看）：
 * - 只允许 http / https；file:/data:/blob:/javascript:/unix: 一律拒绝；
 * - 不允许 URL 内嵌用户名口令（避免把凭据写进工作流导出物）；
 * - 方法白名单；超时 1s–120s；响应体上限 20MB（超出截断并标记）；
 * - **不读环境变量、不写文件、不把请求头/响应体写日志**；
 * - 返回值只有状态码 / 响应头 / 文本或 base64 体，不暴露任何本地能力。
 */

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_HEADERS = 50;
const MAX_HEADER_NAME = 256;
const MAX_HEADER_VALUE = 4096;

/** URL 校验：只收 http/https、不带头像口令；返回 URL 对象，非法时抛中文错误。 */
function assertUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("请求地址为空");
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("请求地址不是合法的 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`只允许 http/https 地址（收到 ${url.protocol}）`);
  }
  if (url.username || url.password) {
    throw new Error("地址里不能内嵌用户名或密码，请改用请求头鉴权");
  }
  if (!url.hostname) throw new Error("请求地址缺少主机名");
  return url;
}

/** 请求头校验：只收字符串键值，超长/超量直接报错（不静默裁剪，免得请求悄悄变味）。 */
function normalizeHeaders(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("请求头必须是对象");
  const entries = Object.entries(raw);
  if (entries.length > MAX_HEADERS) throw new Error(`请求头最多 ${MAX_HEADERS} 项`);
  const headers = {};
  for (const [name, value] of entries) {
    if (typeof name !== "string" || !name || name.length > MAX_HEADER_NAME) {
      throw new Error("请求头名不合法");
    }
    if (typeof value !== "string") throw new Error(`请求头 ${name} 的值必须是字符串`);
    if (value.length > MAX_HEADER_VALUE) throw new Error(`请求头 ${name} 的值过长`);
    headers[name] = value;
  }
  return headers;
}

function clampTimeout(value) {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, n));
}

/**
 * 把渲染层的入参归一成 fetch 需要的形状。
 * `body` 只接受字符串（渲染层序列化好再传）：跨 IPC 传对象容易变成 `[object Object]`，
 * 而且 JSON/form 的编码决策属于节点，不属于桥。
 */
function buildRequestOptions(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("请求参数必须是对象");
  }
  const url = assertUrl(input.url);
  const method = String(input.method || "GET").toUpperCase();
  if (!METHODS.has(method)) throw new Error(`不支持的请求方法：${method}`);
  const headers = normalizeHeaders(input.headers);
  let body;
  if (input.body !== undefined && input.body !== null && input.body !== "") {
    if (typeof input.body !== "string") throw new Error("请求体必须是字符串");
    if (method === "GET" || method === "HEAD") throw new Error(`${method} 请求不能带请求体`);
    body = input.body;
  }
  const responseType = input.responseType === "base64" ? "base64" : "text";
  return {
    url: url.toString(),
    method,
    headers,
    body,
    timeoutMs: clampTimeout(input.timeoutMs),
    followRedirects: input.followRedirects !== false,
    responseType,
  };
}

/** 响应头 → 普通对象（同名多值取第一个；数组会让 IPC 结构变重）。 */
function headersToObject(headers) {
  const result = {};
  if (!headers || typeof headers.forEach !== "function") return result;
  headers.forEach((value, name) => {
    if (typeof name === "string" && !(name in result)) result[name] = String(value);
  });
  return result;
}

/** 把 fetch 响应读成受上限约束的文本；超出上限截断并返回 truncated。 */
async function readBodyText(response, maxBytes) {
  // 测试注入的假响应可能只有 text()/arrayBuffer()，两种都兼容。
  if (response.body && typeof response.body.getReader === "function" && typeof Buffer !== "undefined") {
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    let truncated = false;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- 流式读取必须串行
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      if (received + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, Math.max(0, maxBytes - received)));
        received = maxBytes;
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          /* 取消失败不影响已读到的内容 */
        }
        break;
      }
      chunks.push(chunk);
      received += chunk.length;
    }
    return { text: Buffer.concat(chunks).toString("utf8"), truncated, size: received };
  }
  if (typeof response.text === "function") {
    const text = await response.text();
    const buffer = Buffer.from(text, "utf8");
    if (buffer.length > maxBytes) {
      return { text: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true, size: maxBytes };
    }
    return { text, truncated: false, size: buffer.length };
  }
  if (typeof response.arrayBuffer === "function") {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      return { text: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true, size: maxBytes };
    }
    return { text: buffer.toString("utf8"), truncated: false, size: buffer.length };
  }
  return { text: "", truncated: false, size: 0 };
}

/**
 * 造一个 HTTP 桥实例。
 * @param {{ fetchImpl?: typeof fetch, maxBytes?: number }} options 测试注入点
 */
function createHttpBridge(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES;

  async function request(input) {
    let built;
    try {
      built = buildRequestOptions(input);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (typeof fetchImpl !== "function") return { ok: false, error: "当前环境没有可用的 HTTP 客户端" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), built.timeoutMs);
    try {
      const response = await fetchImpl(built.url, {
        method: built.method,
        headers: built.headers,
        body: built.body,
        redirect: built.followRedirects ? "follow" : "manual",
        signal: controller.signal,
      });
      const { text, truncated, size } = await readBodyText(response, maxBytes);
      const encoding = built.responseType === "base64" ? "base64" : "utf8";
      return {
        ok: true,
        statusCode: response.status,
        headers: headersToObject(response.headers),
        body: text,
        encoding,
        truncated,
        size,
      };
    } catch (error) {
      // 统一成可读中文；不回传 headers/body（可能含用户的鉴权信息）。
      if (error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        return { ok: false, error: `请求超时（${built.timeoutMs} 毫秒）` };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `请求失败：${message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  return { request, maxBytes };
}

/**
 * 注册 IPC。`secureIpc` 是主进程的统一守卫（校验调用来源），与其它桥一致。
 * @param {{ handle: (channel: string, listener: Function) => void }} secureIpc
 * @param {{ fetchImpl?: typeof fetch, maxBytes?: number }} [options]
 */
function registerWorkflowHttpIpc(secureIpc, options = {}) {
  const bridge = createHttpBridge(options);
  secureIpc.handle("workflow:http", async (_event, input) => bridge.request(input));
}

module.exports = {
  assertUrl,
  normalizeHeaders,
  buildRequestOptions,
  headersToObject,
  readBodyText,
  createHttpBridge,
  registerWorkflowHttpIpc,
};
