import type { PluginCatalogEntry } from "@heming/shared";

/**
 * 云端插件目录面板（d.86）：只渲染 + 回调，不自己发请求。
 *
 * 请求编排放在 `InstallDialog`（那里才有「载入清单」的落点）；
 * 这样面板可以纯 props 单测，也避免「组件一挂载就联网」这种不可控行为。
 *
 * 视觉沿用插件区既有类（ui-card 之外的浅底小组件），不新造 token。
 */
export interface OnlineCatalogPanelProps {
  entries: PluginCatalogEntry[] | null;
  loading: boolean;
  error: string | null;
  installed?: { id: string; version: string }[];
  onRefresh: () => void;
  onLoad: (entry: PluginCatalogEntry) => void;
  onClose: () => void;
  /** 正在下载的包 id@version（禁用对应按钮并显示「下载中…」）。 */
  loadingKey?: string | null;
}

const CHIP = "ui-chip";
const BTN = "ui-btn ui-btn-sm ui-btn-ghost";

/** 权限一行：主机数 + 风险上限（与插件卡口径一致）。 */
function permissionLine(entry: PluginCatalogEntry): string {
  const ceiling =
    entry.permissions.tools === "write" ? "读写" : entry.permissions.tools === "read" ? "只读" : "不提供工具";
  return `主机 ${entry.permissions.network.length} · 风险上限 ${ceiling}`;
}

function contributionLine(entry: PluginCatalogEntry): string {
  const c = entry.contributions;
  return `技能 ${c.skills} · MCP ${c.mcpServers} · 命令 ${c.commands}`;
}

function installedStateOf(
  entry: PluginCatalogEntry,
  installed: { id: string; version: string }[],
): { text: string; tone: "new" | "same" | "update" } {
  const current = installed.find((item) => item.id === entry.id);
  if (!current) return { text: "新插件", tone: "new" };
  if (current.version === entry.version) {
    return { text: `已装 v${current.version}`, tone: "same" };
  }
  return { text: `已装 v${current.version} · 可更新到 v${entry.version}`, tone: "update" };
}

function publishedLabel(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function OnlineCatalogPanel({
  entries,
  loading,
  error,
  installed = [],
  onRefresh,
  onLoad,
  onClose,
  loadingKey = null,
}: OnlineCatalogPanelProps) {
  return (
    <section
      aria-label="云端插件目录"
      className="mt-2 rounded-lg border border-line bg-[var(--subtle)] p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="text-[12px] font-bold text-muted">云端插件目录</span>
          <span className="ml-2 ui-caption">独立插件包：下载后仍走本机校验与安装预览</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" aria-label="刷新云端插件目录" onClick={onRefresh} className={BTN}>
            刷新
          </button>
          <button type="button" aria-label="关闭云端插件目录" onClick={onClose} className={BTN}>
            关闭
          </button>
        </div>
      </div>

      {loading && <p className="mt-2 ui-caption">正在获取云端插件目录…</p>}

      {!loading && error && (
        <div className="mt-2">
          <p role="alert" className="ui-body-sm text-[var(--danger)]">
            {error}
          </p>
          <button type="button" onClick={onRefresh} className={`${BTN} mt-1`}>
            重试
          </button>
        </div>
      )}

      {!loading && !error && entries !== null && entries.length === 0 && (
        <p className="mt-2 ui-caption">云端还没有可安装的插件。</p>
      )}

      {!loading && !error && entries !== null && entries.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {entries.map((entry) => {
            const state = installedStateOf(entry, installed);
            const key = `${entry.id}@${entry.version}`;
            const busy = loadingKey === key;
            return (
              <li
                key={key}
                aria-label={`云端插件 ${entry.name}`}
                className="rounded-lg border border-line bg-[var(--surface)] p-2.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] font-bold">{entry.name}</span>
                  <span className={CHIP}>v{entry.version}</span>
                  <span
                    className={
                      state.tone === "update"
                        ? "ui-caption text-[var(--warn)]"
                        : "ui-caption"
                    }
                  >
                    {state.text}
                  </span>
                  <span className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      aria-label={`载入 ${entry.name}`}
                      onClick={() => onLoad(entry)}
                      disabled={busy}
                      className="ui-btn ui-btn-sm ui-btn-primary"
                    >
                      {busy ? "下载中…" : "载入清单"}
                    </button>
                  </span>
                </div>
                <div className="mt-0.5 ui-caption">
                  {entry.id}
                  {entry.author ? ` · ${entry.author}` : ""}
                  {publishedLabel(entry.publishedAt) ? ` · ${publishedLabel(entry.publishedAt)}` : ""}
                </div>
                {entry.description && (
                  <p className="mt-1 line-clamp-2 break-words ui-body-sm text-muted">
                    {entry.description}
                  </p>
                )}
                <div className="mt-1 flex flex-wrap gap-2 ui-caption">
                  <span>{contributionLine(entry)}</span>
                  <span>· {permissionLine(entry)}</span>
                  <span className="font-mono" title={`sha256:${entry.sha256}`}>
                    · 指纹 {entry.sha256.slice(0, 8)}…
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
