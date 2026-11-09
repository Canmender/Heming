/**
 * 本机 magpie 网关的流式对话（widget 侧最小实现）。
 *
 * 为什么不是复用宿主的 `lib/llmClient.ts`：
 * - 那个模块牵着宿主的一整套逻辑（多供应商 anthropic 分支、工具调用、脱敏、前缀缓存、
 *   路由降级），静态 import 会把它依赖的宿主 store 一起拖进插件包——而插件跑在
 *   **独立 origin**，读不到宿主 localStorage，拖进来也跑不通；
 * - 桌宠只需要「一句短回复」：OpenAI 兼容的 `/chat/completions` + SSE 就够。
 *
 * 红线不变：这里拿到的是**本机网关地址 + 网关 Key**（`chatConfig()` 给的），
 * 不是用户的供应商 Key；而且请求只发往本机回环（宿主 CSP 的 connect-src 也只放
 * `127.0.0.1/localhost` + `permissions.network`）。
 */

import type { ChatConfig } from "./widgetBridge.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamGatewayOpts {
  signal?: AbortSignal;
  maxTokens?: number;
  onDelta?: (delta: string) => void;
  /** 测试注入；生产默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

/** 网关没配可用模型时给用户看的话（与宿主设置区文案同口径）。 */
export const NO_MODEL_MESSAGE = "网关里还没有可用模型：请先在主窗口「设置 → 模型」配置供应商。";

/** 每个网关地址只探一次模型目录（同一窗口生命周期内缓存）。 */
const modelCache = new Map<string, string>();

function normalizeBase(baseUrl: string | null | undefined): string {
  return String(baseUrl ?? "").trim().replace(/\/+$/, "");
}

function authHeaders(config: ChatConfig): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.gateway.key) headers.authorization = `Bearer ${config.gateway.key}`;
  return headers;
}

/** 网关物体：`{data:[{id}]}`（OpenAI 形状 + magpie 扩展字段，这里只读 id）。 */
function pickModelId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return null;
}

/**
 * 决定这一轮用哪个模型。
 *
 * P0 契约 `chatConfig()` 只给网关地址/Key/智能体绑定，没有模型字段；所以缺省时读
 * 网关的 `/v1/models` 目录取第一个可用模型（magpie 的目录就是「用户已经能用的模型」）。
 * 宿主将来补 `model` 字段时（`ChatConfig.model`）优先用它。
 */
export async function resolveGatewayModel(
  config: ChatConfig,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const explicit = typeof config.model === "string" ? config.model.trim() : "";
  if (explicit) return explicit;

  const base = normalizeBase(config.gateway.baseUrl);
  const cached = modelCache.get(base);
  if (cached) return cached;
  if (!base) throw new Error("还没有可用的模型连接");

  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${base}/models`, { headers: authHeaders(config), signal: opts.signal });
  if (!res.ok) {
    throw new Error(`provider_error: HTTP ${res.status} 读取模型目录失败`);
  }
  const model = pickModelId(await res.json().catch(() => null));
  if (!model) throw new Error(NO_MODEL_MESSAGE);
  modelCache.set(base, model);
  return model;
}

/** 测试隔离：清掉模型缓存。 */
export function resetGatewayModelCache(): void {
  modelCache.clear();
}

function toAbortError(): DOMException {
  return new DOMException("AbortError", "AbortError");
}

function readErrorMessage(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const error = (raw as { error?: unknown }).error;
  if (error == null) return null;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error).slice(0, 300);
  } catch {
    return String(error);
  }
}

/** 从一段 SSE 文本里取出增量文本；`[DONE]` 用 `done` 标记。 */
function parseSseLine(line: string): { delta: string; done: boolean; error: string | null } {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return { delta: "", done: false, error: null };
  const payload = trimmed.slice("data:".length).trim();
  if (!payload) return { delta: "", done: false, error: null };
  if (payload === "[DONE]") return { delta: "", done: true, error: null };
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return { delta: "", done: false, error: null };
  }
  const error = readErrorMessage(json);
  if (error) return { delta: "", done: false, error };
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return { delta: "", done: false, error: null };
  const choice = choices[0] as { delta?: { content?: unknown }; text?: unknown };
  const content =
    typeof choice?.delta?.content === "string"
      ? choice.delta.content
      : typeof choice?.text === "string"
        ? choice.text
        : "";
  return { delta: content, done: false, error: null };
}

/**
 * 流式对话：SSE（`data:` 行）/ 非流式 JSON 都收；HTTP 错误统一抛
 * `Error("provider_error: HTTP ...")`，由调用方翻成人话。
 */
export async function streamGatewayChat(
  config: ChatConfig,
  messages: ChatMessage[],
  opts: StreamGatewayOpts = {},
): Promise<string> {
  const base = normalizeBase(config.gateway.baseUrl);
  if (!base) throw new Error("还没有可用的模型连接");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = await resolveGatewayModel(config, { signal: opts.signal, fetchImpl });

  let res: Response;
  try {
    res = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: authHeaders(config),
      signal: opts.signal,
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: opts.maxTokens ?? 512,
        messages,
      }),
    });
  } catch (err) {
    if (opts.signal?.aborted) throw toAbortError();
    throw new Error(`provider_error: 无法连接本机网关（${(err && (err as Error).message) || "网络错误"}）`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`provider_error: HTTP ${res.status} ${body.slice(0, 300)}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  let full = "";

  const push = (delta: string) => {
    if (!delta) return;
    full += delta;
    opts.onDelta?.(delta);
  };

  if (!contentType.includes("text/event-stream")) {
    // 非流式端点（部分兼容网关按 content-type 回整段 JSON）
    const json = await res.json().catch(() => null);
    if (opts.signal?.aborted) throw toAbortError();
    const error = readErrorMessage(json);
    if (error) throw new Error(`provider_error: ${error}`);
    const choices = (json as { choices?: unknown } | null)?.choices;
    const first = Array.isArray(choices) ? (choices[0] as { message?: { content?: unknown } }) : null;
    const content = typeof first?.message?.content === "string" ? first.message.content : "";
    push(content);
    return full;
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("provider_error: 网关没有返回可读的流");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const parsed = parseSseLine(line);
        if (parsed.error) throw new Error(`provider_error: ${parsed.error}`);
        if (parsed.done) return full;
        push(parsed.delta);
        index = buffer.indexOf("\n");
      }
    }
    // 收尾：最后一段没有换行结尾
    if (buffer.trim()) {
      const parsed = parseSseLine(buffer);
      if (parsed.error) throw new Error(`provider_error: ${parsed.error}`);
      if (!parsed.done) push(parsed.delta);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 已结束 */
    }
  }
  return full;
}

/**
 * 网关错误 → 人话（宿主 `humanizeProviderError` 的精简版：只覆盖桌宠会遇到的几类）。
 * 只做文案映射，不解析/不回显 Key。
 */
export function humanizeGatewayError(raw: string): string {
  const value = String(raw ?? "").trim();
  if (!value) return "生成失败，请重试。";
  if (value === "还没有可用的模型连接") return "还没有可用的模型连接。";
  if (value === NO_MODEL_MESSAGE) return NO_MODEL_MESSAGE;

  const http = value.match(/^provider_error:\s*HTTP\s+(\d{3})\b/i);
  if (http) {
    const status = Number(http[1]);
    if (status === 401 || status === 403) {
      return `本机网关鉴权失败：请检查「设置 → 模型」里的网关 Key。（HTTP ${status}）`;
    }
    if (status === 404) return `网关接口地址找不到：请检查网关地址是否以 /v1 结尾。（HTTP ${status}）`;
    if (status === 408) return "网关响应超时：请稍后重试。";
    if (status === 429) return "请求太频繁或额度不足：稍后再试。";
    if (status >= 500) return `本机网关暂时不可用（HTTP ${status}）：确认 magpie 正在运行。`;
    return `生成失败（HTTP ${status}）。`;
  }
  if (/无法连接本机网关/.test(value)) {
    return "连不上本机网关：请确认 magpie 已启动（设置 → 模型里可以看状态）。";
  }
  if (/没有可用模型/.test(value)) return NO_MODEL_MESSAGE;
  return "生成失败，请重试。";
}
