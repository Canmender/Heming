/**
 * magpie 网关客户端（原生组件，d.89）。
 *
 * 和鸣不再直连各家模型供应商：本机 magpie 网关统一提供 OpenAI 兼容接口
 * （默认 `http://127.0.0.1:3425`），`GET /v1/models` 给出「用户已经能用的模型」目录。
 * 本文件只做两件事：读目录、探活；聊天请求仍走 `llmClient`（OpenAI 兼容形状）。
 *
 * 边界：
 * - 不读 magpie 的账号/Key/设置文件，只认用户填的网关地址与网关 Key；
 * - 目录里的字段按 OpenAI 形状宽松解析：magpie 会带 `display_name` / `context_window` /
 *   `max_output_tokens` / `modalities` 等扩展字段，缺失就按未知处理，不猜；
 * - 纯函数 + 注入 fetch，便于单测；不发任何除 /v1/models、/api/hello 之外的请求。
 */

/** 网关配置：一条地址 + 一把网关 Key（本机默认值即 magpie 的默认）。 */
export interface GatewayConfig {
  /** 形如 `http://127.0.0.1:3425/v1`（OpenAI 兼容根路径）。 */
  baseUrl: string;
  /** magpie 网关 Key；本机不校验具体值，缺省 `magpie-heming`。 */
  key: string;
}

/** 目录里的一个模型（只保留和鸣用得到的字段）。 */
export interface GatewayModel {
  /** 交给网关的模型 id：`provider/model`，或路由组 `group/<id>` / `auto/<model>`。 */
  id: string;
  name: string;
  /** 供应方（magpie 的 `owned_by`），仅展示用。 */
  ownedBy: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** 支持的推理档位（magpie 扩展），空数组 = 未知/不支持。 */
  reasoningLevels: string[];
  /** 是否接受图片输入（未知按 false：能力判定宁可保守）。 */
  vision: boolean;
}

export interface GatewayCatalog {
  models: GatewayModel[];
  /** `/api/hello` 里的版本号（探活失败时为 undefined）。 */
  version?: string;
}

export class MagpieGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MagpieGatewayError";
  }
}

export const DEFAULT_GATEWAY: GatewayConfig = {
  baseUrl: "http://127.0.0.1:3425/v1",
  key: "magpie-heming",
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 规范化网关地址：去尾部斜杠；保留用户写的路径（可能不是 /v1）。 */
export function normalizeGatewayBaseUrl(raw: string): string {
  const value = String(raw ?? "").trim();
  return value.replace(/\/+$/, "");
}

/** 从网关根地址推 `/api/hello`（baseUrl 可能带 /v1）。 */
export function helloUrlOf(gateway: GatewayConfig): string {
  const base = normalizeGatewayBaseUrl(gateway.baseUrl);
  const root = base.replace(/\/v1$/, "");
  return `${root}/api/hello`;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `modalities` 可能是 `["text","image"]` 或 `["text"]`；只认出现 image。 */
function hasImage(modalities: unknown): boolean {
  return Array.isArray(modalities) && modalities.some((item) => String(item).toLowerCase() === "image");
}

/** 解析 `/v1/models` 的响应（OpenAI 形状 + magpie 扩展字段）。 */
export function parseGatewayModels(raw: unknown): GatewayModel[] {
  const list =
    raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)
      ? ((raw as { data: unknown[] }).data as unknown[])
      : null;
  if (!list) throw new MagpieGatewayError("网关的模型目录格式不对（缺少 data 数组）");
  const out: GatewayModel[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = asString(obj.id).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const levels = Array.isArray(obj.supported_reasoning_levels)
      ? obj.supported_reasoning_levels
          .map((entry) =>
            typeof entry === "string"
              ? entry
              : asString((entry as { effort?: unknown } | null)?.effort),
          )
          .filter(Boolean)
      : Array.isArray(obj.reasoning_levels)
        ? obj.reasoning_levels.map((entry) => asString(entry)).filter(Boolean)
        : [];
    out.push({
      id,
      name: asString(obj.display_name).trim() || id,
      ownedBy: asString(obj.owned_by).trim(),
      contextWindow: asNumber(obj.context_window),
      maxOutputTokens: asNumber(obj.max_output_tokens),
      reasoningLevels: levels,
      vision: hasImage(obj.modalities),
    });
  }
  return out;
}

/**
 * 读取网关目录（含一次探活）。
 *
 * 为什么探活单独一次 `/api/hello`：它同时证明「这是 magpie，不是别的东西」，
 * 并且能拿到版本号展示；`/v1/models` 的空白也可能是「没配任何供应商」，两者要分清。
 */
export async function fetchGatewayCatalog(
  gateway: GatewayConfig,
  deps: { fetchImpl?: FetchLike } = {},
): Promise<GatewayCatalog> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = normalizeGatewayBaseUrl(gateway.baseUrl);
  if (!base) throw new MagpieGatewayError("网关地址不能为空");
  if (!/^https?:\/\//i.test(base)) {
    throw new MagpieGatewayError("网关地址必须以 http:// 或 https:// 开头");
  }

  let version: string | undefined;
  try {
    const hello = await fetchImpl(helloUrlOf(gateway), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (hello.ok) {
      const info = (await hello.json().catch(() => null)) as { name?: unknown; version?: unknown } | null;
      if (info && asString(info.name) === "magpie") version = asString(info.version) || undefined;
    }
  } catch {
    // 探活失败不直接判死：有些部署只暴露 /v1；下面 /v1/models 成功就说明可用。
  }

  let response: Response;
  try {
    response = await fetchImpl(`${base}/models`, {
      headers: { accept: "application/json", authorization: `Bearer ${gateway.key}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    throw new MagpieGatewayError(
      `连不上 magpie 网关（${base}）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new MagpieGatewayError(
      response.status === 401 || response.status === 403
        ? `网关拒绝了这个 Key（HTTP ${response.status}）：请核对 magpie 网关 Key`
        : `读取模型目录失败（HTTP ${response.status}）`,
    );
  }
  const raw = await response.json().catch(() => null);
  return { models: parseGatewayModels(raw), version };
}
