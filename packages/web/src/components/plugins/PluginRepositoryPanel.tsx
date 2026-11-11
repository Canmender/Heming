import { useCallback, useEffect, useMemo, useState } from "react";
import type { PluginCatalogEntry } from "@heming/shared";
import {
  fetchPluginCatalog,
  type CatalogClientDeps,
} from "../../lib/plugins/catalogClient.js";
import { FOCUS_RING } from "../../lib/a11y/focus.js";
import { PackageIcon, SearchIcon } from "../icons.js";
import { EmptyState } from "../ui/EmptyState.js";

/**
 * 插件仓库（d.95）：云端只维护**一份**插件仓库，用户在这里浏览、下载、安装。
 *
 * 与安装弹窗里的「从云端浏览」区别：那是「我已经有一份清单、顺手看看云端」；
 * 这里是「我想装点什么」的主入口——可以先按名字/描述搜，再看权限与贡献，再决定装。
 *
 * 边界（与 catalogClient 一致）：
 * - 目录接口公开、不登录也能拉；服务端只给元数据与原样清单，权限/签名/安装校验全在客户端；
 * - 插件包是声明式清单，下载后走既有安装预览（sha256 不符就不装）；
 * - 仓库不可用时只影响本 Tab，手动粘贴/选文件那条路照常。
 */
export function PluginRepositoryPanel({
  catalog,
  installed,
  onLoad,
  loadingKey,
  onError,
}: {
  catalog?: CatalogClientDeps;
  installed: { id: string; version: string }[];
  /** 下载并打开安装预览（由 PluginsPage 负责写清单并开弹窗）。 */
  onLoad: (entry: PluginCatalogEntry) => void | Promise<void>;
  /** 正在下载的包 id@version（禁用对应按钮）。 */
  loadingKey?: string | null;
  /** 把错误交给页面统一提示（下载失败在页面顶部可见）。 */
  onError?: (message: string) => void;
}) {
  const [entries, setEntries] = useState<PluginCatalogEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // 仓库里既可能有声明式包，也可能有首方界面插件（bundle，如桌宠/画布/建模）；
      // 统一仓库必须全部列出，否则用户只看到声明式那一条路径。
      setEntries(await fetchPluginCatalog(catalog, { distribution: "all" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [catalog]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!entries) return null;
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (entry) =>
        entry.id.toLowerCase().includes(q) ||
        entry.name.toLowerCase().includes(q) ||
        entry.description.toLowerCase().includes(q) ||
        entry.author.toLowerCase().includes(q),
    );
  }, [entries, query]);

  const installedOf = (id: string) => installed.find((item) => item.id === id) ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line-soft bg-[var(--surface)] p-2.5">
        <div className="relative w-[280px] max-w-full">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted"
          >
            <SearchIcon width={13} height={13} />
          </span>
          <input
            aria-label="搜索插件仓库"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索插件名称 / id / 描述 / 作者…"
            className="ui-input h-8 pl-7 text-[12px]"
          />
        </div>
        <span className="ui-caption">
          {filtered ? `共 ${filtered.length} 个` : "正在读取目录…"} · 云端同一份插件仓库
        </span>
        <button
          type="button"
          className="ui-btn ui-btn-sm ui-btn-ghost ml-auto"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-[var(--danger-line)] bg-[var(--danger-soft)] px-3 py-2">
          <p role="alert" className="text-[12px] text-[var(--danger)]">
            {error}
          </p>
          <button type="button" className="ui-link mt-1" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : filtered === null ? (
        <p role="status" className="ui-caption">
          正在读取云端插件目录…
        </p>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<PackageIcon width={20} height={20} />}
          title={entries && entries.length > 0 ? "没有匹配的插件" : "仓库里还没有插件"}
          desc={
            entries && entries.length > 0
              ? "换个关键词试试，或清空搜索。"
              : "管理员用发布接口往云端仓库推一个插件，这里就会出现。"
          }
          actions={
            entries && entries.length > 0 ? (
              <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" onClick={() => setQuery("")}>
                清空搜索
              </button>
            ) : undefined
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {filtered.map((entry) => {
            const current = installedOf(entry.id);
            const state = !current
              ? { text: "未安装", tone: "new" as const }
              : current.version === entry.version
                ? { text: `已装 v${current.version}`, tone: "same" as const }
                : { text: `可更新：v${current.version} → v${entry.version}`, tone: "update" as const };
            const key = `${entry.id}@${entry.version}`;
            const busy = loadingKey === key;
            return (
              <li key={key} className="ui-card plugin-card p-3">
                <div className="flex flex-wrap items-start gap-2">
                  <span
                    aria-hidden="true"
                    className="plugin-icon-tile h-8 w-8 text-[12px] font-bold"
                  >
                    {Array.from(entry.name)[0]?.toUpperCase() ?? "?"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[13px] font-bold">{entry.name}</span>
                      <span className="ui-micro rounded-sm border border-line px-1 tabular-nums">
                        v{entry.version}
                      </span>
                      <span
                        className={`ui-micro rounded-full border px-1.5 ${
                          state.tone === "new"
                            ? "plugin-tone-neutral"
                            : state.tone === "same"
                              ? "plugin-tone-ok"
                              : "plugin-tone-info"
                        }`}
                      >
                        {state.text}
                      </span>
                    </div>
                    <div className="mt-0.5 ui-caption">
                      {entry.id}
                      {entry.author ? ` · ${entry.author}` : ""}
                      {entry.publishedAt ? ` · ${entry.publishedAt.slice(0, 10)}` : ""}
                    </div>
                    {entry.description && (
                      <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-muted">
                        {entry.description}
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 ui-micro">
                      <span className="ui-chip">技能 {entry.contributions.skills}</span>
                      <span className="ui-chip">MCP {entry.contributions.mcpServers}</span>
                      <span className="ui-chip">命令 {entry.contributions.commands}</span>
                      <span className="ui-chip">
                        风险上限{" "}
                        {entry.permissions.tools === "write"
                          ? "读写"
                          : entry.permissions.tools === "read"
                            ? "只读"
                            : "不提供工具"}
                      </span>
                      <span className="ui-chip">网络主机 {entry.permissions.network.length}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        void Promise.resolve(onLoad(entry)).catch((err: unknown) => {
                          onError?.(err instanceof Error ? err.message : String(err));
                        });
                      }}
                      className={`ui-btn ui-btn-sm ui-btn-primary ${FOCUS_RING}`}
                    >
                      {busy ? "下载中…" : current && current.version === entry.version ? "重新载入" : current ? "更新" : "安装"}
                    </button>
                    <span className="ui-micro">安装前会展示权限与指纹</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
