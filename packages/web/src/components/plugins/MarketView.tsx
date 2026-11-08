import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  comparePluginVersions,
  pickInstallVersion,
  type MarketPlugin,
  type PluginCatalogEntry,
} from "@heming/shared";
import { currentAppVersion } from "../../lib/units/projection.js";
import {
  fetchMarketIndex,
  type FetchMarketIndexOptions,
  type MarketClientDeps,
  type MarketIndexResult,
} from "../../lib/plugins/marketClient.js";
import { MarketDetailDialog } from "./MarketDetailDialog.js";
import { CHIP, ERROR_TEXT, HINT } from "./shared.js";

/**
 * 插件区「市场」（d.108 · 阶段 B）：云端市场索引 v2 的浏览入口。
 *
 * - 一次拉取 `market.json` 渲染分类/标签/搜索/排序/卡片，不为每个插件再拉清单；
 * - `removed` 整插件隐藏，`deprecated` 灰标并给迁移提示；`requires-newer` 明确写
 *   「需要更新和鸣」，不静默变成不可点；
 * - 安装只把「市场条目 → PluginCatalogEntry」交回页面，复用既有 InstallDialog
 *   （预览/验签/sha256/写入全不变）；界面插件不在市场直接装（提示去「桌面小组件」）；
 * - 索引不可用时回调 `onUnavailable`，由页面回落到既有 v1「仓库」面板。
 */

/** 搜索防抖（规格 §6.3：250ms）。 */
export const MARKET_SEARCH_DEBOUNCE_MS = 250;

export type MarketSort = "index" | "updated" | "downloads";

export interface MarketViewProps {
  /** 已安装（声明式插件 + 界面插件）：用于「已安装 / 可更新」徽标。 */
  installed?: { id: string; version: string }[];
  /** 宿主版本；缺省读构建期 `__APP_VERSION__`。 */
  hostVersion?: string;
  deps?: MarketClientDeps;
  /** 索引不可用（404/网络/格式）：交页面切到「仓库」并提示。 */
  onUnavailable?: (reason: string) => void;
  /** 选择某版本安装：页面下载清单并打开既有安装预览。 */
  onInstall?: (entry: PluginCatalogEntry) => void | Promise<void>;
  /** 测试注入：索引加载（缺省 fetchMarketIndex）。 */
  loadIndex?: (options: FetchMarketIndexOptions) => Promise<MarketIndexResult>;
  /** 测试注入：详情文档（转发给 MarketDetailDialog）。 */
  loadDetail?: (id: string, version: string, deps?: MarketClientDeps) => Promise<string | null>;
  /** 测试注入：清单加载（转发给 MarketDetailDialog）。 */
  loadManifest?: (entry: PluginCatalogEntry, deps?: MarketClientDeps) => Promise<string>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function updatedMs(plugin: MarketPlugin): number {
  const raw = plugin.updatedAt ?? plugin.versions[0]?.publishedAt;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function downloadsOf(plugin: MarketPlugin): number {
  return plugin.metadata?.sortKeys?.downloads ?? 0;
}

function searchText(plugin: MarketPlugin): string {
  return [
    plugin.title ?? "",
    plugin.id,
    plugin.description ?? "",
    plugin.author ?? "",
    ...(plugin.metadata?.keywords ?? []),
    ...(plugin.metadata?.tags ?? []),
  ]
    .join("\n")
    .toLowerCase();
}

/** 图标只允许 https/data:image（索引 schema 只限长度，渲染前再挡一次奇怪 scheme）。 */
function safeIconUrl(url: string | undefined): string | null {
  if (!url) return null;
  return /^(https?:\/\/|data:image\/)/i.test(url) ? url : null;
}

/** 卡片：图标/标题/描述/作者/更新与兼容性徽标/已装状态。 */
function MarketCard({
  plugin,
  hostVersion,
  installedVersion,
  onDetail,
}: {
  plugin: MarketPlugin;
  hostVersion: string;
  installedVersion: string | null;
  onDetail: () => void;
}) {
  const version = pickInstallVersion(plugin, { hostVersion });
  const available = Boolean(version);
  const update = Boolean(
    version && installedVersion && comparePluginVersions(version.version, installedVersion) > 0,
  );
  const deprecated = plugin.status === "deprecated" || version?.status === "deprecated";
  const bundle = version?.distribution === "bundle";
  const required = plugin.versions[0]?.engines.heming ?? "d.0";
  const title = plugin.title ?? plugin.id;

  return (
    <li className="ui-card flex min-w-0 flex-col gap-2 p-3">
      <div className="flex items-start gap-2">
        {safeIconUrl(plugin.icon) ? (
          <img
            src={safeIconUrl(plugin.icon) ?? undefined}
            alt=""
            className="h-9 w-9 shrink-0 rounded-lg border border-line object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-[#fafafa] text-[14px] font-bold"
          >
            {title.slice(0, 1)}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[13px] font-bold">{title}</span>
            {version && (
              <span className="ui-micro rounded-sm border border-line px-1 tabular-nums">
                v{version.version}
              </span>
            )}
            {deprecated && (
              <span className={CHIP} title={plugin.deprecatedReason ?? undefined}>
                已弃用
              </span>
            )}
            {bundle && <span className={CHIP}>界面插件</span>}
            {!available && (
              <span className="ui-micro rounded-full border border-[#fedf89] bg-[#fffaeb] px-1.5 text-[#b54708]">
                需要更新和鸣（≥{required}）
              </span>
            )}
            {update && (
              <span className="ui-micro rounded-full border border-[#b2ddff] bg-[#eff8ff] px-1.5 text-[#175cd3]">
                可更新
              </span>
            )}
            {!update && installedVersion && (
              <span className="ui-micro rounded-full border border-[#abefc6] bg-[#ecfdf3] px-1.5 text-[#067647]">
                已安装 v{installedVersion}
              </span>
            )}
          </div>
          <div className="mt-0.5 ui-caption">
            {plugin.id}
            {plugin.author ? ` · ${plugin.author}` : ""}
            {plugin.updatedAt ? ` · 更新于 ${plugin.updatedAt.slice(0, 10)}` : ""}
          </div>
        </div>
      </div>
      <p className="line-clamp-2 text-[12px] leading-5 text-muted">
        {plugin.description ?? "暂无描述"}
      </p>
      <div className="flex flex-wrap items-center gap-1.5 ui-micro">
        {plugin.metadata?.category && <span className={CHIP}>{plugin.metadata.category}</span>}
        {(plugin.metadata?.tags ?? []).map((tag) => (
          <span key={tag} className={CHIP}>
            {tag}
          </span>
        ))}
        <button
          type="button"
          className="ui-btn ui-btn-sm ui-btn-ghost ml-auto"
          onClick={onDetail}
          aria-label={`查看 ${title} 详情`}
        >
          详情
        </button>
      </div>
    </li>
  );
}

export function MarketView({
  installed = [],
  hostVersion = currentAppVersion(),
  deps,
  onUnavailable,
  onInstall,
  loadIndex = fetchMarketIndex,
  loadDetail,
  loadManifest,
}: MarketViewProps) {
  const fetchImpl = deps?.fetchImpl;
  const baseUrl = deps?.baseUrl;
  const onUnavailableRef = useRef(onUnavailable);
  useEffect(() => {
    onUnavailableRef.current = onUnavailable;
  }, [onUnavailable]);

  const [state, setState] = useState<{
    loading: boolean;
    error: string | null;
    result: MarketIndexResult | null;
  }>({ loading: true, error: null, result: null });
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [sort, setSort] = useState<MarketSort>("index");
  const [detailPlugin, setDetailPlugin] = useState<MarketPlugin | null>(null);

  const load = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const result = await loadIndex({ hostVersion, fetchImpl, baseUrl });
      setState({ loading: false, error: null, result });
    } catch (err) {
      const message = errorText(err);
      setState({ loading: false, error: message, result: null });
      // 索引不可用 = 目录问题，不是「没有匹配」：交页面回落到 v1 仓库面板。
      onUnavailableRef.current?.(message);
    }
  }, [loadIndex, hostVersion, fetchImpl, baseUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  // 搜索防抖（规格 §6.3）：输入框即时反馈，过滤在 250ms 后执行。
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), MARKET_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const index = state.result?.index ?? null;
  const installedById = useMemo(
    () => new Map(installed.map((item) => [item.id, item.version] as const)),
    [installed],
  );
  const categoryOptions = useMemo(
    () => Object.entries(index?.categories ?? {}).map(([key, value]) => ({ key, title: value.title })),
    [index],
  );
  const tagOptions = useMemo(
    () => Object.entries(index?.tags ?? {}).map(([key, value]) => ({ key, title: value.title })),
    [index],
  );

  const visible = useMemo(() => {
    if (!index) return [];
    const terms = debouncedQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = index.plugins.filter((plugin) => {
      if (plugin.status === "removed") return false;
      if (category && plugin.metadata?.category !== category) return false;
      if (tags.length > 0) {
        const own = new Set(plugin.metadata?.tags ?? []);
        if (!tags.every((tag) => own.has(tag))) return false;
      }
      if (terms.length > 0) {
        const haystack = searchText(plugin);
        if (!terms.every((term) => haystack.includes(term))) return false;
      }
      return true;
    });
    const sorted = [...rows];
    if (sort === "updated") sorted.sort((a, b) => updatedMs(b) - updatedMs(a));
    else if (sort === "downloads") sorted.sort((a, b) => downloadsOf(b) - downloadsOf(a));
    return sorted;
  }, [index, category, tags, debouncedQuery, sort]);

  const toggleTag = (tag: string) => {
    setTags((prev) => (prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag]));
  };

  const filterActive = query.trim().length > 0 || category !== null || tags.length > 0;

  return (
    <div aria-label="插件市场">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          aria-label="搜索市场插件"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜名称 / 描述 / 作者 / 关键词…"
          className="ui-input min-w-[220px] max-w-[340px] flex-1"
        />
        <label className={`flex items-center gap-1 ${HINT}`}>
          排序
          <select
            aria-label="排序"
            value={sort}
            onChange={(event) => setSort(event.target.value as MarketSort)}
            className="ui-input h-7 text-[12px]"
          >
            <option value="index">索引声明顺序</option>
            <option value="updated">最近更新</option>
            <option value="downloads">下载量</option>
          </select>
        </label>
        <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost ml-auto" onClick={() => void load()}>
          刷新
        </button>
      </div>

      {categoryOptions.length > 0 && (
        <div role="group" aria-label="按分类筛选" className="mb-2 flex flex-wrap gap-1">
          <button
            type="button"
            aria-pressed={category === null}
            onClick={() => setCategory(null)}
            className={`ui-btn ui-btn-sm ${category === null ? "ui-btn-primary" : "ui-btn-ghost text-muted"}`}
          >
            全部分类
          </button>
          {categoryOptions.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={category === item.key}
              onClick={() => setCategory(item.key)}
              className={`ui-btn ui-btn-sm ${
                category === item.key ? "ui-btn-primary" : "ui-btn-ghost text-muted"
              }`}
            >
              {item.title}
            </button>
          ))}
        </div>
      )}

      {tagOptions.length > 0 && (
        <div role="group" aria-label="按标签筛选" className="mb-2 flex flex-wrap gap-1">
          {tagOptions.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={tags.includes(item.key)}
              aria-label={`标签 ${item.title}`}
              onClick={() => toggleTag(item.key)}
              className={`ui-micro rounded-full border px-2 py-0.5 ${
                tags.includes(item.key)
                  ? "border-ink bg-[#f7f7f7] font-medium"
                  : "border-line text-muted"
              }`}
            >
              #{item.title}
            </button>
          ))}
        </div>
      )}

      {state.loading && !index ? (
        <p role="status" className="ui-caption">
          正在读取市场目录…
        </p>
      ) : state.error ? (
        <div className="rounded-lg border border-[var(--danger-line)] bg-[var(--danger-soft)] px-3 py-2">
          <p role="alert" className={`text-[12px] ${ERROR_TEXT}`}>
            市场目录不可用：{state.error}
          </p>
          <button type="button" className="ui-link mt-1" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : (
        <>
          <p className={`mb-2 ${HINT}`}>
            {filterActive
              ? `匹配 ${visible.length} / 共 ${index?.plugins.length ?? 0} 个插件`
              : `共 ${index?.plugins.length ?? 0} 个插件`}
            {state.result && state.result.warnings.length > 0
              ? ` · 已忽略 ${state.result.warnings.length} 条无效数据`
              : ""}
          </p>

          {visible.length === 0 ? (
            <section
              role="region"
              aria-label="市场无结果"
              className="flex flex-col items-center gap-2 rounded-xl border border-line bg-white py-10 text-center shadow-card"
            >
              <p className="ui-section-title">没有匹配的插件</p>
              <p className="ui-caption">
                {index && index.plugins.length === 0 ? "市场里还没有插件。" : "换个分类、标签或关键词试试。"}
              </p>
              {filterActive && (
                <button
                  type="button"
                  className="ui-btn ui-btn-sm ui-btn-ghost"
                  onClick={() => {
                    setQuery("");
                    setCategory(null);
                    setTags([]);
                  }}
                >
                  清除筛选
                </button>
              )}
            </section>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {visible.map((plugin) => (
                <MarketCard
                  key={plugin.id}
                  plugin={plugin}
                  hostVersion={hostVersion}
                  installedVersion={installedById.get(plugin.id) ?? null}
                  onDetail={() => setDetailPlugin(plugin)}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {detailPlugin && (
        <MarketDetailDialog
          plugin={detailPlugin}
          hostVersion={hostVersion}
          installed={installed}
          deps={deps}
          onClose={() => setDetailPlugin(null)}
          onInstall={async (entry) => {
            await onInstall?.(entry);
            setDetailPlugin(null);
          }}
          {...(loadDetail ? { loadDetail } : {})}
          {...(loadManifest ? { loadManifest } : {})}
        />
      )}
    </div>
  );
}
