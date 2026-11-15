/**
 * 联网工具的主进程 HTTP 桥（`window.__heming_http`）。
 *
 * 为什么必须经主进程：渲染层 origin 是 `app://heming`，直接 `fetch` 第三方会被同源策略
 * 拦下，搜索站也不会给这个 origin 发 CORS 头。桌面端已有一条通用代发桥
 * （`packages/desktop/http-bridge.js` 的 `workflow:http`，安全边界写在该文件头：
 * 只收 http/https、方法白名单、超时 1s–120s、响应上限 20MB、不读环境变量、不写日志）。
 *
 * 类型说明：preload 没有为这条桥生成 `.d.ts`，按 `lib/registry/runtime.ts:100-103`
 * 的既定写法在本地强转声明；**返回值一律当外部输入逐字段校验**，坏数据按失败处理。
 * 浏览器端（没有桥）返回 null，调用方据此让 provider 返回 null（默认不注入）。
 */

/** 主进程 HTTP 桥的入参（与 `desktop/http-bridge.js:buildRequestOptions` 对齐）。 */
export interface HttpRequestInput {
  url: string;
  method?: string;
  /** 值必须是字符串（主进程侧强校验，非字符串直接报错）。 */
  headers?: Record<string, string>;
  /** 只接受字符串：跨 IPC 传对象容易变成 `[object Object]`。 */
  body?: string;
  /** 主进程会夹到 1000–120000；这里给默认值。 */
  timeoutMs?: number;
  followRedirects?: boolean;
  responseType?: "text" | "base64";
}

/** 归一后的桥结果：成功带状态码与正文，失败只有中文原因（不回显请求头/体）。 */
export type HttpBridgeResult =
  | {
      ok: true;
      statusCode: number;
      headers: Record<string, string>;
      body: string;
      encoding: "utf8" | "base64";
      truncated: boolean;
      size: number;
    }
  | { ok: false; error: string };

/** preload 暴露的桥本体（浏览器端为 undefined）。 */
export interface HemingHttpBridge {
  available?: boolean;
  request(input: HttpRequestInput): Promise<unknown>;
}

/** 便于单测注入的请求函数形态。 */
export type HttpRequestFn = (input: HttpRequestInput) => Promise<HttpBridgeResult>;

/**
 * 桌面主进程 `fetch` 的默认 User-Agent 是 Node/Electron 的，搜索站与部分站点会直接
 * 回 403 或反爬页；这里统一给一个常见浏览器的 UA（调用方仍可覆盖）。
 */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 联网工具的默认超时：搜索/读页都不该让一轮对话卡太久（主进程上限 120s）。 */
export const DEFAULT_HTTP_TIMEOUT_MS = 12_000;

/** 取桥：桌面端有、浏览器端没有。 */
export function getHttpBridge(): HemingHttpBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { __heming_http?: HemingHttpBridge }).__heming_http;
  if (!bridge || typeof bridge.request !== "function") return null;
  return bridge;
}

/** 是否具备经主进程发请求的能力（工具可见性的判据之一）。 */
export function hasHttpBridge(): boolean {
  return getHttpBridge() !== null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 主进程回来的东西当外部输入：逐字段校验，坏数据统一成失败。 */
function normalize(raw: unknown): HttpBridgeResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "网络请求返回了无法识别的结果" };
  }
  const r = raw as Record<string, unknown>;
  if (r.ok !== true) {
    const reason = typeof r.error === "string" ? r.error.trim() : "";
    return { ok: false, error: reason || "网络请求失败" };
  }
  if (typeof r.statusCode !== "number" || typeof r.body !== "string") {
    return { ok: false, error: "网络请求返回了无法识别的结果" };
  }
  const headers: Record<string, string> = {};
  if (r.headers && typeof r.headers === "object" && !Array.isArray(r.headers)) {
    for (const [name, value] of Object.entries(r.headers as Record<string, unknown>)) {
      if (typeof value === "string") headers[name] = value;
    }
  }
  return {
    ok: true,
    statusCode: r.statusCode,
    headers,
    body: r.body,
    encoding: r.encoding === "base64" ? "base64" : "utf8",
    truncated: r.truncated === true,
    size: typeof r.size === "number" && Number.isFinite(r.size) ? r.size : r.body.length,
  };
}

/**
 * 经主进程发一次 HTTP 请求。
 *
 * 永不抛：无桥、桥抛错、返回坏数据都归一成 `{ ok: false, error }` 中文文案——
 * 工具桥的契约是「失败也在结果里说清原因」，模型据此改走别的路。
 */
export async function httpRequest(input: HttpRequestInput): Promise<HttpBridgeResult> {
  const bridge = getHttpBridge();
  if (!bridge) {
    return { ok: false, error: "联网需要桌面端运行（浏览器里没有主进程 HTTP 桥）" };
  }
  const payload: HttpRequestInput = {
    ...input,
    method: input.method ?? "GET",
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      ...(input.headers ?? {}),
    },
    timeoutMs: input.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
  };
  try {
    return normalize(await bridge.request(payload));
  } catch (error) {
    return { ok: false, error: `网络请求失败：${messageOf(error)}` };
  }
}
