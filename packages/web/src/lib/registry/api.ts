/**
 * MCP 官方 Registry 的列表拉取（游标分页 + 去重）。
 *
 * 零 React、零 store：只用原生 `fetch`，超时用 `AbortController` 自己实现（不引依赖）。
 *
 * ★ **永不 reject**：断网/超时/返回垃圾数据都归为 `{ok:false, error}`。
 * 这样调用方能「保留旧缓存 + 顶部提示」，而不是整个发现页崩掉——
 * 离线可用是硬要求（设计 §6.3）。
 *
 * ★ **必须用 https**：Registry 是第三方服务，走 https 才能防中间人篡改服务器列表
 * （否则用户可能被塞进恶意 MCP）。注意这与我们的自动更新源（http 明文）不一致，
 * **那个不一致是对的，不要「为了统一」把这里改成 http**。
 */

import type {
  FetchResult,
  RegistryEntry,
  RegistryItem,
  RegistryPage,
} from "./types.js";
import { toEntry } from "./map.js";

export const REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0.1";

/** 一页拉多少条（原始条目数，去重前）。★ Registry 的 limit 上限是 100，超了返回 422。 */
export const REGISTRY_PAGE_SIZE = 30;
/** 去重后一页给 UI 多少条。 */
export const ENTRY_PAGE_SIZE = 20;
/** 单次请求超时。断网时不能无限转圈。 */
export const FETCH_TIMEOUT_MS = 12_000;

/** 只展示 `active` 的条目。实测 120 条全是 active，但**不能假设**——将来可能有下架的。 */
const STATUS_SHOW = "active";

/** 可注入的 fetch（测试用）。签名与 `fetch` 一致即可。 */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** 拉取的可选参数。 */
export interface FetchDeps {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /**
   * Registry 的版本快照参数（实测支持）：
   * - `"latest"` → 最新版本（此时每条的 `_meta.isLatest` 都是 true，可直接信，不必本地去重）
   * - `"2025-09-29"` → 该日期的快照
   *
   * ★ 本轮 UI 不一定用得上，但**API 层先留出这个能力**——
   * Registry 有版本历史，将来做「回滚到某个 MCP 版本」不用我们自己存历史、不用改接口。
   */
  version?: string;
}

/* -------------------------------------------------------------- 版本比较 */

/**
 * 比较两个版本号：按 `.` 分段，数字段按数值比，非数字段按字符串比。返回 -1 / 0 / 1。
 *
 * ★ 为什么不能用字符串比较（**实测踩过的坑**）：
 * ```
 * "1.10.0" > "1.9.0"   → false    ← 字符串比：'1'=='1'，'.'=='.'，'1'<'9'
 * ```
 * 于是 1.10.0 被判为比 1.9.0 **老**，选中了错的版本。
 * Registry 里有真实的 `1.10.x` / `1.9.x`，这不是理论问题。
 *
 * ★ **这不是完整的 semver 实现**，已知局限：
 * - 预发布标记：`1.0.0-alpha` 在 semver 里**小于** `1.0.0`，
 *   这里按段比 `"alpha" > "0"` → 会判成**更大**；
 * - 不处理 `^1.2.3` 这类区间（官方明确**拒绝**区间，实际遇不到）。
 *
 * **这个误差可以接受**：版本比较只是「没有 `isLatest` 时的兜底」，
 * Registry 的 `isLatest` 标记才是权威信号（见 `dedupeItems`）。
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const rawA = pa[i];
    const rawB = pb[i];
    // ★ 缺失段视为 0（"1.2" 与 "1.2.0" 应当相等）。
    //   否则 rawB 是 undefined → Number(undefined) 是 NaN → 掉进字符串分支 →
    //   `"2" > ""` 判成更大，于是 "1.2" 被认为比 "1.2.0" 新，完全错。
    const na = rawA === undefined ? 0 : Number(rawA);
    const nb = rawB === undefined ? 0 : Number(rawB);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na < nb ? -1 : 1;
      continue;
    }
    const sa = rawA ?? "";
    const sb = rawB ?? "";
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  return 0;
}

/* -------------------------------------------------------------- 去重 */

/**
 * 去重：同一 `server.name` 只保留一条。
 *
 * ★ 这是**必需步骤，不是优化** —— 实测 `?limit=30` 只有 **19 个唯一名**，
 * 同一服务最多重复 4 次（每个版本一条）。不去重，用户会看到同一个服务出现四次，
 * 以为产品有 bug。
 *
 * 选代表的两级规则：
 * 1. `isLatest === true` 的优先（Registry 自己标的「当前版本」，权威）；
 * 2. 否则按 `compareVersions` 取版本号最大的。
 */
export function dedupeItems(items: RegistryItem[]): RegistryItem[] {
  const best = new Map<string, RegistryItem>();
  const hasLatest = new Set<string>();

  for (const item of items) {
    const name = item?.server?.name;
    if (typeof name !== "string" || !name) continue;
    const latest = isLatest(item);
    if (latest) hasLatest.add(name);

    const prev = best.get(name);
    if (!prev) {
      best.set(name, item);
      continue;
    }
    const prevLatest = isLatest(prev);
    if (latest !== prevLatest) {
      if (latest) best.set(name, item);
      continue;
    }
    if (compareVersions(versionOf(item), versionOf(prev)) > 0) best.set(name, item);
  }

  // isLatest 必须胜出（它是 Registry 的权威标记，不能被版本比较覆盖）。
  for (const name of hasLatest) {
    const winner = items.find((i) => i.server?.name === name && isLatest(i) === true);
    if (winner) best.set(name, winner);
  }
  return [...best.values()];
}

function isLatest(item: RegistryItem): boolean {
  return item._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest === true;
}

function versionOf(item: RegistryItem): string {
  const v = item.server?.version;
  return typeof v === "string" ? v : "";
}

/**
 * 过滤 + 去重 + 转成 `RegistryEntry`。
 *
 * ★ **顺序：先过滤 status，再去重** —— 这样去重是在「要展示的集合」里挑代表，
 * 不会挑到一条马上就要被丢掉的条目。
 *
 * ★ 去重是**必需步骤不是优化**（实测 30 条只有 19 个唯一名）。
 */
export function toEntries(items: RegistryItem[]): RegistryEntry[] {
  return dedupeItems(
    items.filter((item) => {
      const s = item._meta?.["io.modelcontextprotocol.registry/official"]?.status;
      // **没有 _meta 的一律不过滤**（Registry 是公开数据，不该因元数据缺失就整条丢掉）；
      // 有 _meta 但状态不是 active 才丢。
      return s === undefined || s === STATUS_SHOW;
    }),
  ).map(toEntry);
}

/* -------------------------------------------------------------- 拉取 */

/**
 * 内部请求：**`fetchPage` 与 `search` 共用**。
 *
 * 为什么要抽出来：超时要清 timer、错误要归一、解析要容错、`version` 参数要拼——
 * 这些逻辑**有两份就一定会改一处忘一处**（本轮已经踩过好几次「两处不一致」）。
 */
async function requestEntries(
  params: Record<string, string | undefined>,
  deps: FetchDeps = {},
): Promise<FetchResult<RegistryEntry[]>> {
  // 注意用 === undefined 而不是 ??：显式传 null 也要被当作「无 fetch」，
  // 否则会静默回落到 globalThis.fetch（测试里就变成打真实网络了）。
  const doFetch =
    deps.fetchImpl === undefined
      ? (globalThis.fetch as unknown as FetchLike | undefined)
      : deps.fetchImpl;
  if (typeof doFetch !== "function") return { ok: false, error: "当前环境不支持 fetch" };

  const url = new URL(`${REGISTRY_BASE}/servers`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value); // 空值不拼，避免出现 `?search=`
  }
  if (deps.version) url.searchParams.set("version", deps.version);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(url.toString(), { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `Registry 返回 ${res.status}` };
    const parsed = parsePage(await res.text());
    if (!parsed) return { ok: false, error: "Registry 返回的数据无法解析" };
    return { ok: true, value: toEntries(parsed.servers ?? []), nextCursor: parsed.metadata?.nextCursor };
  } catch (err) {
    // abort 与网络错误都归到这里：调用方只需一种处理方式（显示缓存 + 提示）。
    const msg = controller.signal.aborted
      ? "连接 Registry 超时"
      : `无法连接 Registry：${(err as Error).message}`;
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer); // ★ 必须清理，否则句柄泄漏（测试里表现为挂住/报警）
  }
}

/**
 * 拉一页。**分页是游标式**：`metadata.nextCursor` → 下一次 `?cursor=<nextCursor>`。
 *
 * ★ 实测 Registry **没有** offset/页码，也不返回总数，所以无法「跳到第 N 页」。
 * `cursor` 是**不透明串**（形如 `name:version`），**不能自增**。
 */
export async function fetchPage(
  cursor?: string,
  limit: number = REGISTRY_PAGE_SIZE,
  deps: FetchDeps = {},
): Promise<FetchResult<RegistryEntry[]>> {
  return requestEntries({ limit: String(limit), cursor }, deps);
}

/** 搜索（实测 `?search=` 可用，是 name 的子串匹配；未传时按 name 字母序返回）。 */
export async function search(
  query: string,
  deps: FetchDeps & { limit?: number } = {},
): Promise<FetchResult<RegistryEntry[]>> {
  const q = query.trim();
  return requestEntries({ limit: String(deps.limit ?? REGISTRY_PAGE_SIZE), search: q || undefined }, deps);
}

/** JSON 解析 + 基本形状校验。**垃圾输入返回 null 而不是抛**。 */
function parsePage(text: string): RegistryPage | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object") return null;
    const page = raw as RegistryPage;
    if (!Array.isArray(page.servers)) return null;
    return page;
  } catch {
    return null;
  }
}
