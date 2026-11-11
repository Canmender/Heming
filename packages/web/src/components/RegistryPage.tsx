import { useEffect, useMemo, useRef, useState } from "react";
import {
  blockedReason,
  isInstallable,
  missingRuntimeReason,
  rateInstall,
  hostOf,
  type InstallOption,
  type LocalRuntimeStatus,
  type RegistryEntry,
} from "../lib/registry/index.js";
import { hasStdioBridge } from "../lib/mcp/index.js";
import { useRegistryStore, type RegistryStore } from "../store/registry.js";
import { PlusIcon } from "./icons.js";
import { PageShell } from "./layout/PageShell.js";

/** 搜索防抖：输入过程中的每个字符都打一次 Registry 没有意义。 */
export const SEARCH_DEBOUNCE_MS = 400;

type Filter = "all" | "remote" | "stdio" | "unsupported";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "remote", label: "远程" },
  { id: "stdio", label: "本地包" },
  { id: "unsupported", label: "暂不支持" },
];

/**
 * 一行默认展示哪种装法：优先「可装且本机跑得起来」的（远程在前），
 * 其次任一条可装的，最后第一个。
 *
 * ★ 为什么要看运行时：本地包排第一而本机没有 Node 时，行上会出现一个点不动的按钮，
 * 用户以为服务坏了；把能真正装起来的那条排前面，一次点击就有结果。
 */
export function primaryOption(
  entry: RegistryEntry,
  runtime: LocalRuntimeStatus | null = null,
): InstallOption | undefined {
  const installable = entry.options.filter(isInstallable);
  return (
    installable.find((o) => missingRuntimeReason(o, runtime) === null) ??
    installable[0] ??
    entry.options[0]
  );
}

/** 一行按钮上的短语：区分「Registry 不支持」与「本机跑不了」，两者要做的完全不同。 */
export function rowBlockLabel(option: InstallOption, runtime: LocalRuntimeStatus | null): string {
  if (!isInstallable(option)) return "暂不支持";
  return hasStdioBridge() ? "缺运行时" : "需桌面版";
}

function matchesFilter(entry: RegistryEntry, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "unsupported") return !entry.options.some(isInstallable);
  return entry.options.some((o) => isInstallable(o) && (filter === "remote" ? o.kind === "http" : o.kind === "stdio"));
}

export interface RegistryPageProps {
  store?: RegistryStore;
  /** 返回接口区（发现页是接口区的二级面板，不是独立导航项）。 */
  onBack?: () => void;
  /** 安装成功后通知外层刷新接口区列表。 */
  onInstalled?: () => void;
}

/**
 * MCP 官方 Registry 发现页。
 *
 * 远程装法本机不落代码；本地包（npm/pypi）要本机已有 Node/uv —— 和鸣刻意不内置这两个
 * 运行时，所以这类条目在探测之前只是「待确认」，探测缺了就直接标出来而不是让用户白装一次。
 * 不可装的条目**不隐藏**：用户至少知道 Registry 里有它、以及为什么装不了。
 */
export function RegistryPage({ store, onBack, onInstalled }: RegistryPageProps) {
  const useStore = store ?? useRegistryStore;
  const entries = useStore((s) => s.entries);
  const loading = useStore((s) => s.loading);
  const loadingMore = useStore((s) => s.loadingMore);
  const error = useStore((s) => s.error);
  const stale = useStore((s) => s.stale);
  const nextCursor = useStore((s) => s.nextCursor);
  const loadedAt = useStore((s) => s.loadedAt);
  const installingKey = useStore((s) => s.installingKey);
  const installedKeys = useStore((s) => s.installedKeys);
  const runtime = useStore((s) => s.runtime);
  const runtimeProbed = useStore((s) => s.runtimeProbed);
  const load = useStore((s) => s.load);
  const loadMore = useStore((s) => s.loadMore);
  const install = useStore((s) => s.install);
  const syncInstalled = useStore((s) => s.syncInstalled);
  const probeRuntime = useStore((s) => s.probeRuntime);

  const [text, setText] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const firstRun = useRef(true);

  // 首屏立即拉（命中 TTL 缓存时不发请求）。同步一次「已安装」，删除过也能对上。
  // 运行时探测并行做：它决定本地包条目的按钮文案，不能等用户点了才知道。
  useEffect(() => {
    void load("");
    syncInstalled();
    void probeRuntime();
  }, [load, syncInstalled, probeRuntime]);

  // 搜索防抖。首轮跳过：首屏已由上面的 effect 拉过，避免 400ms 后又打一次。
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const timer = setTimeout(() => void load(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, load]);

  const visible = useMemo(
    () => entries.filter((entry) => matchesFilter(entry, filter)),
    [entries, filter],
  );

  const doInstall = async (entry: RegistryEntry, option: InstallOption) => {
    setMsg(null);
    const result = await install(entry, option);
    if (result.canceled) return;
    if (result.ok) {
      setMsg({
        kind: "ok",
        text: `${entry.title}：已连接，发现 ${result.tools ?? 0} 个工具。工具默认未启用，请在插件区的「MCP 服务」Tab 逐个授权。`,
      });
      onInstalled?.();
    } else {
      setMsg({ kind: "error", text: result.error ?? "安装失败" });
    }
  };

  return (
    <PageShell
      title="发现 MCP 服务"
      subtitle="插件源。远程服务不落代码，本地包用本机的 Node / uv 运行；装好后工具默认关闭。"
      width="wide"
      actions={
        <>
          <button
            type="button"
            onClick={() => void load(undefined, { force: true })}
            disabled={loading}
            className="ui-btn ui-btn-md ui-btn-ghost"
          >
            {loading ? "刷新中…" : "刷新"}
          </button>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="ui-btn ui-btn-md ui-btn-ghost"
            >
              返回 MCP 服务
            </button>
          )}
        </>
      }
    >
      {runtimeProbed && runtime && (
        <p className="ui-caption mb-4" title={runtime.note}>
          {`本机运行时：Node.js ${runtime.npm ? "可用" : "未检测到"} · uv ${runtime.pypi ? "可用" : "未检测到"}`}
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          aria-label="搜索 MCP 服务"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="搜索服务名，如 filesystem / github"
          className="ui-input w-full max-w-[360px]"
        />
        <div className="flex flex-wrap items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`ui-btn ui-btn-sm ${filter === f.id ? "ui-btn-primary" : "ui-btn-ghost text-muted"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        {loadedAt && (
          <span className="ui-caption">
            {stale ? "缓存更新于 " : "更新于 "}
            {new Date(loadedAt).toLocaleString()}
          </span>
        )}
      </div>

      {msg && (
        <div
          role="status"
          className={`mt-3 rounded-lg border px-3 py-2 text-[12px] ${
            msg.kind === "error"
              ? "border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]"
              : "border-[var(--success-line)] bg-[var(--success-soft)] text-[var(--success)]"
          }`}
        >
          {msg.text}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className={`mt-3 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-[11px] ${
            stale
              ? "border-[var(--warn-line)] bg-[var(--warn-soft)] text-[var(--warn)]"
              : "border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]"
          }`}
        >
          <span>
            {stale ? "无法连接 Registry，正在显示上次缓存。" : error}
          </span>
          <button
            type="button"
            onClick={() => void load(undefined, { force: true })}
            className="ui-btn ui-btn-sm ui-btn-ghost border-current"
          >
            重试
          </button>
        </div>
      )}

      {loading && entries.length === 0 ? (
        <div className="ui-empty rounded-xl border border-dashed border-line bg-[var(--surface)]">
          <p className="ui-empty-desc">正在连接 Registry…</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="ui-empty rounded-xl border border-dashed border-line bg-[var(--surface)]">
          <p className="ui-empty-desc">{entries.length === 0 ? "没有拉到可展示的服务。检查网络后重试。" : "没有匹配的服务。"}</p>
        </div>
      ) : (
        <div className="mt-4 flex flex-col ui-card">
          {visible.map((entry) => (
            <RegistryRow
              key={entry.key}
              entry={entry}
              runtime={runtime}
              installed={installedKeys.includes(entry.key)}
              installing={installingKey === entry.key}
              busy={installingKey !== null && installingKey !== entry.key}
              onInstall={doInstall}
            />
          ))}
        </div>
      )}

      {nextCursor && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => void loadMore()}
            className="ui-btn ui-btn-md ui-btn-ghost"
          >
            {loadingMore ? "加载中…" : "加载更多"}
          </button>
        </div>
      )}

      <p className="mt-4 ui-caption">
        Registry 是开放注册中心，任何条目都不代表已通过安全审核。安装前请自行核对来源与仓库。
      </p>
    </PageShell>
  );
}

interface RowProps {
  entry: RegistryEntry;
  /** 本机运行时；null = 还没探或探不到（此时不拦本地包，交给点击时的兜底探测）。 */
  runtime: LocalRuntimeStatus | null;
  installed: boolean;
  installing: boolean;
  busy: boolean;
  onInstall: (entry: RegistryEntry, option: InstallOption) => void;
}

function RegistryRow({ entry, runtime, installed, installing, busy, onInstall }: RowProps) {
  const option = primaryOption(entry, runtime);
  const blockReason = option ? blockedReason(option, runtime) : "该服务没有可用的装法";
  const installable = blockReason === null;
  const risk = option ? rateInstall(entry, option) : null;

  return (
    <section
      aria-label={`Registry 服务 ${entry.title}`}
      className="ui-list-row flex-wrap items-start px-3.5"
    >
      <EntryIcon entry={entry} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="ui-section-title">{entry.title}</span>
          {risk && (
            <span
              className={`rounded-sm px-1 text-[10px] ${
                risk.level === "high"
                  ? "bg-[var(--danger-soft)] text-[var(--danger)]"
                  : risk.level === "medium"
                    ? "bg-[var(--warn-soft)] text-[var(--warn)]"
                    : "bg-[var(--success-soft)] text-[var(--success)]"
              }`}
              title={risk.message}
            >
              {risk.level === "high" ? "高风险" : risk.level === "medium" ? "中风险" : "低风险"}
            </span>
          )}
          {installed && (
            <span className="ui-chip">已安装</span>
          )}
        </div>
        <p className="mt-0.5 line-clamp-2 ui-caption">{entry.description || "（无描述）"}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 ui-micro">
          <span className="font-mono">{entry.key}</span>
          {option && (
            <span>
              {option.kind === "http"
                ? `远程 · ${hostOf(option.url ?? "") || "未知主机"}`
                : option.label}
            </span>
          )}
          {/* 装不了的原因要点开就看得见，不能只藏在按钮的 title 里（触屏与读屏都拿不到）。 */}
          {option && !installable && <span className="text-[var(--warn)]">{blockReason}</span>}
          {entry.repoSource && <span>仓库 {entry.repoSource}</span>}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {entry.websiteUrl && (
          <a
            href={entry.websiteUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[11px] text-muted underline decoration-[#ddd] underline-offset-2 hover:text-ink"
          >
            官网
          </a>
        )}
        {entry.repoUrl && (
          <a
            href={entry.repoUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[11px] text-muted underline decoration-[#ddd] underline-offset-2 hover:text-ink"
          >
            仓库
          </a>
        )}
        <button
          type="button"
          aria-label={`安装 ${entry.title}`}
          disabled={installed || !installable || installing || busy}
          title={installable ? undefined : blockReason}
          onClick={() => option && onInstall(entry, option)}
          className="ui-btn ui-btn-sm ui-btn-ghost"
        >
          {installing
            ? "安装中…"
            : installed
              ? "已安装"
              : installable
                ? <><PlusIcon width={11} height={11} />安装</>
                : option
                  ? rowBlockLabel(option, runtime)
                  : "暂不支持"}
        </button>
      </div>
    </section>
  );
}

function EntryIcon({ entry }: { entry: RegistryEntry }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-[var(--subtle-2)] text-[13px] font-bold text-muted">
      {entry.title.slice(0, 1).toUpperCase()}
      {entry.iconUrl && !broken && (
        <img
          src={entry.iconUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setBroken(true)}
        />
      )}
    </div>
  );
}
