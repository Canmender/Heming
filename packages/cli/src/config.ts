/**
 * 模型配置解析：命令行 > HEMING_* > OPENAI_*。
 *
 * 为什么把优先级写死在这里、而不是让每个调用点各自读 env：
 * 和鸣桌面端从不直连供应商（一律走本机 magpie 网关），CLI 是第一个「直接说
 * OpenAI 兼容协议」的入口；配置来源越少越可预测，用户试错时只要知道这三层。
 *
 * 没有 key 不是「运行失败」而是「用法/配置错误」：调用方据此给退出码 2，
 * 让人一眼分清「服务商挂了」与「我还没配」。
 */

export interface ModelConfigOverrides {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface ResolvedModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export type ConfigResult =
  | { ok: true; config: ResolvedModelConfig }
  | { ok: false; error: string };

/**
 * 缺省模型。
 *
 * 选 gpt-4o-mini 不是为了「最好」，而是为了「便宜、支持函数调用、大多数 OpenAI
 * 兼容网关都有」——CLI 的首要用途是 CI 与冒烟，默认值不该让第一次运行就烧掉一顿饭钱。
 * 需要更强的模型时显式传 --model。
 */
export const DEFAULT_MODEL = "gpt-4o-mini";

/** 缺省端点：OpenAI 官方；第三方兼容网关用 HEMING_BASE_URL / --base-url 覆盖。 */
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

function pick(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function resolveModelConfig(
  overrides: ModelConfigOverrides,
  env: NodeJS.ProcessEnv = process.env,
): ConfigResult {
  const apiKey = pick(overrides.apiKey, env.HEMING_API_KEY, env.OPENAI_API_KEY);
  if (!apiKey) {
    return {
      ok: false,
      error:
        "没有可用的模型凭据。请设置环境变量 HEMING_API_KEY（或 OPENAI_API_KEY），" +
        "也可以用 --api-key 传入。例如：\n" +
        '  HEMING_API_KEY=sk-... pnpm cli exec --json "用一句话介绍这个目录"\n' +
        "如果你的网关不是 OpenAI 官方端点，再同时设置 HEMING_BASE_URL（或 OPENAI_BASE_URL）。",
    };
  }

  const baseUrl = pick(overrides.baseUrl, env.HEMING_BASE_URL, env.OPENAI_BASE_URL) ?? DEFAULT_BASE_URL;
  /**
   * 先去掉末尾斜杠再校验：既要挡住「没有 scheme」的地址，也要挡住「只有 scheme 没有主机」的
   * 残址（如 `http://` / `https://`）。后者用正则 `^https?://` 也能过，但 `.replace(/\/+$/, "")`
   * 会把它压成 `http:`，拼上 `/chat/completions` 后被 URL 解析成 host=chat 的荒唐目的地——
   * 带 Key 的请求就发错地方了。这里统一用 `new URL()` 要求协议合法且有非空 hostname。
   */
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  let baseOk = false;
  try {
    const parsed = new URL(normalizedBase);
    baseOk = (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname);
  } catch {
    baseOk = false;
  }
  if (!baseOk) {
    return {
      ok: false,
      error: `base URL 必须是带主机的 http:// 或 https:// 地址，收到「${baseUrl}」。` +
        "缺 scheme 或缺主机的地址会让带 Key 的请求发错地方，所以这里直接拒绝。",
    };
  }

  const model = pick(overrides.model, env.HEMING_MODEL, env.OPENAI_MODEL) ?? DEFAULT_MODEL;

  return {
    ok: true,
    config: { apiKey, baseUrl: normalizedBase, model },
  };
}
