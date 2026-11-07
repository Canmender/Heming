import { PluginCatalogResponseSchema, type PluginCatalogEntry } from "@heming/shared";
import { API_BASE, api } from "../api.js";

/**
 * 云端插件目录客户端（d.86）。
 *
 * 插件包不随安装包分发：客户端从服务端目录拿「有哪些包 / 哪个版本 / 内容指纹」，
 * 再下载**原样 plugin.json** 交给既有安装预览。这里只做两件事：
 * 1. 拉目录（公开接口，无需登录）；
 * 2. 下载清单并**校验 sha256**——不校验就不装，绝不因为「环境不支持」而跳过。
 *
 * 安全边界：
 * - 只是搬运字节，不信任内容；权限/签名/安装校验仍由 `lib/plugins` 的既有管线做；
 * - 目录不可用时给明确错误，不影响用户手动粘贴 JSON 的路径。
 */

export class PluginCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginCatalogError";
  }
}

/** 只需要「发一次 GET 拿 JSON」的窄接口；具体返回形状交给 zod 校验。 */
type ApiLike = (path: string, init?: RequestInit) => Promise<unknown>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CatalogClientDeps {
  apiImpl?: ApiLike;
  fetchImpl?: FetchLike;
  /** 测试可注入；缺省用 WebCrypto 的 SHA-256。 */
  sha256Hex?: (bytes: Uint8Array) => Promise<string>;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 拉云端插件目录；失败统一说「云端插件目录不可用」+ 原因。 */
export async function fetchPluginCatalog(deps: CatalogClientDeps = {}): Promise<PluginCatalogEntry[]> {
  const apiImpl = deps.apiImpl ?? api;
  let raw: unknown;
  try {
    raw = await apiImpl("/api/plugins");
  } catch (err) {
    throw new PluginCatalogError(`云端插件目录不可用：${reasonOf(err)}`);
  }
  const parsed = PluginCatalogResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PluginCatalogError(
      `云端插件目录不可用：返回的数据格式不对（${parsed.error.issues[0]?.message ?? "未知原因"}）`,
    );
  }
  return parsed.data.plugins;
}

/** 把字节数组转小写 hex（测试与校验共用）。 */
export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 默认的 sha256 实现。
 *
 * 非安全上下文（`file://`、http 非回环）没有 `crypto.subtle`：这里**直接失败**，
 * 不回退到「跳过校验」——插件安装要的就是内容指纹，跳过等于把方向盘交给中间层。
 */
export async function cryptoSha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new PluginCatalogError(
      "当前环境无法校验插件指纹（需要桌面版或 HTTPS/localhost），已拒绝下载安装",
    );
  }
  const digest = await subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return toHex(new Uint8Array(digest));
}

/**
 * 下载某个版本的清单原文并校验指纹。
 *
 * - 指纹优先用响应头 `X-Plugin-Sha256`，缺失时回退到目录 entry 里的 sha256；
 * - 校验失败抛错且**不返回内容**（调用方拿不到可安装的文本）。
 */
export async function downloadPluginManifest(
  entry: PluginCatalogEntry,
  deps: CatalogClientDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sha256Hex = deps.sha256Hex ?? cryptoSha256Hex;
  const url = `${API_BASE}/api/plugins/${encodeURIComponent(entry.id)}/${encodeURIComponent(
    entry.version,
  )}/manifest`;

  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (err) {
    throw new PluginCatalogError(`下载失败：${reasonOf(err)}`);
  }
  if (!response.ok) {
    throw new PluginCatalogError(`下载失败：HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const expected = (response.headers.get("x-plugin-sha256") ?? entry.sha256).toLowerCase();
  const actual = (await sha256Hex(bytes)).toLowerCase();
  if (expected !== actual) {
    throw new PluginCatalogError("内容指纹不一致，已拒绝安装（可能是中间层改动或目录已更新）");
  }
  return new TextDecoder().decode(bytes);
}
