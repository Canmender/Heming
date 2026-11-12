import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PluginCatalogEntry } from "@heming/shared";
import {
  fetchPluginCatalog,
  type CatalogClientDeps,
} from "../../lib/plugins/catalogClient.js";
import { useModalA11y } from "../useModalA11y.js";
import { PackageIcon, SearchIcon, XIcon } from "../icons.js";
import { BTN_GHOST, BTN_PRIMARY, CHIP, ERROR_TEXT, HINT } from "./shared.js";
import { EmptyState } from "../ui/EmptyState.js";

/**
 * 「从插件仓库安装」弹窗（d.135.6）。
 *
 * 用户口径：没有「官方插件 / 更多插件」之分，**全部统称为插件**。
 * 模块运行时下线后这里只剩一条来源：云端插件仓库里的声明式/界面插件清单。
 * 解到本地后走各自的下载/验签路径（bundle 由主进程装，声明式进安装预览）。
 */

type RepoItem = {
  key: string;
  id: string;
  name: string;
  version: string;
  description: string;
  entry: PluginCatalogEntry;
  installed: boolean;
};

export function PluginRepositoryDialog({
  installed,
  loadingKey,
  onLoad,
  onClose,
  onError,
  catalog,
}: {
  installed: { id: string; version: string }[];
  loadingKey?: string | null;
  onLoad: (entry: PluginCatalogEntry) => void | Promise<void>;
  onClose: () => void;
  onError?: (message: string) => void;
  catalog?: CatalogClientDeps;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y(dialogRef, onClose, { active: true });
  const [plugins, setPlugins] = useState<PluginCatalogEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const pluginEntries = await fetchPluginCatalog(catalog, { distribution: "all" });
      setPlugins(pluginEntries);
    } catch (err) {
      setError(err instanceof Error ? err.message : "插件仓库读取失败");
    } finally {
      setLoading(false);
    }
  }, [catalog]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo<RepoItem[]>(
    () =>
      (plugins ?? []).map((entry) => ({
        key: `plugin:${entry.id}@${entry.version}`,
        id: entry.id,
        name: entry.name,
        version: entry.version,
        description: entry.description,
        entry,
        installed: installed.some((item) => item.id === entry.id),
      })),
    [plugins, installed],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.id.toLowerCase().includes(q) ||
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q),
    );
  }, [items, query]);

  const install = async (item: RepoItem) => {
    setBusyKey(item.key);
    setError(null);
    try {
      await onLoad(item.entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : "插件安装失败";
      setError(message);
      onError?.(message);
    } finally {
      setBusyKey(null);
      void load();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="插件仓库"
        className="plugin-dialog-pop flex max-h-[86vh] w-full max-w-[860px] flex-col rounded-2xl border border-line bg-[var(--surface)] shadow-xl"
      >
        <div className="flex items-start gap-2 border-b border-line-soft px-4 py-3">
          <div className="min-w-0">
            <h2 className="ui-section-title">插件仓库</h2>
            <p className="ui-caption">
              和鸣只有一份云端插件仓库；下面都是插件，安装时按类型自动走对应的验签/安装流程。
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            className="ml-auto rounded-md p-1 text-muted hover:bg-[var(--subtle-2)]"
            onClick={onClose}
          >
            <XIcon width={14} height={14} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
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
              placeholder="搜索插件名称 / id / 描述…"
              className="ui-input h-8 pl-7 text-[12px]"
            />
          </div>
          <span className="ui-caption">
            {loading ? "正在读取插件仓库…" : `共 ${filtered.length} 个插件`}
          </span>
          <button
            type="button"
            className={`${BTN_GHOST} ml-auto`}
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error ? (
            <div className={`mb-3 ${ERROR_TEXT}`}>
              <p role="alert">{error}</p>
              <button type="button" className="ui-link mt-1" onClick={() => void load()}>
                重试
              </button>
            </div>
          ) : null}

          {loading && items.length === 0 ? (
            <p role="status" className="ui-caption">正在读取插件仓库…</p>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<PackageIcon width={20} height={20} />}
              title={items.length > 0 ? "没有匹配的插件" : "仓库里还没有插件"}
              desc={
                items.length > 0
                  ? "换个关键词试试，或清空搜索。"
                  : "管理员用发布接口往云端仓库推一个插件，这里就会出现。"
              }
            />
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2" aria-label="插件列表">
              {filtered.map((item) => (
                <li key={item.key} className="ui-card flex flex-col gap-2 p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-bold">{item.name}</span>
                    <span className={CHIP}>v{item.version}</span>
                    {item.installed ? <span className={CHIP}>已安装</span> : null}
                  </div>
                  <p className="line-clamp-2 text-[12px] leading-5 text-muted">{item.description}</p>
                  <div className="mt-auto flex items-center justify-between gap-2">
                    <span className={HINT}>安装前会校验签名/指纹</span>
                    <button
                      type="button"
                      className={item.installed ? BTN_GHOST : BTN_PRIMARY}
                      disabled={item.installed || busyKey === item.key}
                      aria-label={`安装插件 ${item.name}`}
                      onClick={() => void install(item)}
                    >
                      {busyKey === item.key ? "安装中…" : item.installed ? "已安装" : "安装"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
