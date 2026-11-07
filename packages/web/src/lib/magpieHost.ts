/**
 * 桌面端 magpie 桥的渲染层封装（d.91）。
 *
 * 桌面主进程托管内置 magpie 并提供一个带 CORS 的本机反代（见 packages/desktop/magpie-host.js
 * 与 magpie-proxy.js）；浏览器端没有这个桥，只能让用户手填网关地址。
 *
 * 边界：这里只做「探测/启动/取反代地址」，不保存任何账号或 Key；网关 Key 仍由
 * store 里的 gateway 配置负责（默认 magpie-heming）。
 */

export interface MagpieHostStatus {
  available: boolean;
  running: boolean;
  port: number;
  version?: string;
  binaryPath?: string;
  startedAt?: number;
  lastError?: string | null;
  stderrTail?: string[];
  proxyPort?: number | null;
}

export interface MagpieGatewayResponse {
  baseUrl: string | null;
  status: MagpieHostStatus;
  error?: string;
}

export interface MagpieBridge {
  status(): Promise<MagpieHostStatus>;
  start(): Promise<{ baseUrl?: string; status: MagpieHostStatus; error?: string }>;
  stop(): Promise<MagpieHostStatus>;
  gateway(): Promise<MagpieGatewayResponse>;
}

/** 读取桌面端桥（浏览器返回 null，页面据此显示「仅桌面端可用内置组件」）。 */
export function getMagpieBridge(): MagpieBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { __heming_magpie?: unknown }).__heming_magpie;
  if (!bridge || typeof bridge !== "object") return null;
  const candidate = bridge as Partial<MagpieBridge>;
  if (
    typeof candidate.status !== "function" ||
    typeof candidate.start !== "function" ||
    typeof candidate.stop !== "function" ||
    typeof candidate.gateway !== "function"
  ) {
    return null;
  }
  return candidate as MagpieBridge;
}

/**
 * 取桌面端反代地址：没运行就先启动（幂等），失败把原因带回去。
 *
 * 为什么不在这里直接返回 `http://127.0.0.1:3425/v1`：magpie 会拒绝网页跨源请求，
 * 渲染层必须走主进程的反代（带 CORS、并清掉 Origin）。
 */
export async function resolveDesktopGateway(
  bridge: MagpieBridge | null = getMagpieBridge(),
): Promise<{ supported: boolean; baseUrl: string | null; version?: string; error?: string }> {
  if (!bridge) return { supported: false, baseUrl: null };
  try {
    const first = await bridge.status();
    if (!first.available) {
      return {
        supported: true,
        baseUrl: null,
        error: first.lastError || "内置 magpie 还没有准备好（缺少二进制，先运行 node scripts/fetch-magpie.mjs）",
      };
    }
    if (first.running) {
      const gateway = await bridge.gateway();
      return { supported: true, baseUrl: gateway.baseUrl, version: gateway.status.version, error: gateway.error };
    }
    const started = await bridge.start();
    if (started.error || !started.baseUrl) {
      return { supported: true, baseUrl: null, error: started.error || "内置 magpie 启动失败" };
    }
    return { supported: true, baseUrl: started.baseUrl, version: started.status.version };
  } catch (err) {
    return {
      supported: true,
      baseUrl: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

let ensuring: Promise<{
  supported: boolean;
  baseUrl: string | null;
  adopted: boolean;
  version?: string;
  error?: string;
}> | null = null;

/**
 * 应用启动时收口：若桌面端提供内置 magpie，采用它的反代地址并刷新模型目录。
 *
 * - 幂等：并发调用复用同一个 Promise；
 * - 失败不抛（启动流程不能因为模型服务没起来而中断），由设置页展示原因；
 * - 只采用地址，不改用户手填的网关（见 store 的 source 语义）。
 */
export async function ensureDesktopGateway(): Promise<{
  supported: boolean;
  baseUrl: string | null;
  adopted: boolean;
  version?: string;
  error?: string;
}> {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    const bridge = getMagpieBridge();
    if (!bridge) return { supported: false, baseUrl: null, adopted: false };
    const resolved = await resolveDesktopGateway(bridge);
    let adopted = false;
    if (resolved.baseUrl) {
      const store = (await import("../store/llm.js")).useLlmStore;
      adopted = store.getState().adoptDesktopGateway(resolved.baseUrl);
      if (adopted) {
        try {
          await store.getState().refreshCatalog();
        } catch (err) {
          return {
            supported: true,
            baseUrl: resolved.baseUrl,
            adopted,
            version: resolved.version,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }
    return {
      supported: true,
      baseUrl: resolved.baseUrl,
      adopted,
      version: resolved.version,
      error: resolved.error,
    };
  })().finally(() => {
    ensuring = null;
  });
  return ensuring;
}
