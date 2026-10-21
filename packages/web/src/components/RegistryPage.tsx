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
        text: `${entry.title}：已连接，发现 ${result.tools ?? 0} 个工具。工具默认未启用，请到接口区逐个授权。`,
      });
      onInstalled?.();
    } else {
      setMsg({ kind: "error", text: result.error ?? "安装失败" });
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[17px] font-extrabold">发现 MCP 服务</h1>
          <p className="mt-1 text-[12px] text-muted">
            来自官方 Registry。远程服务本机不落代码；本地包由本机的 Node/uv 运行（和鸣不内置）。装完工具默认关闭。
          </p>
          {runtimeProbed && runtime && (
            <p className="mt-1 text-[11px] text-[#999]" title={runtime.note}>
              {`本机运行时：Node.js ${runtime.npm ? "可用" : "未检测到"} · uv ${runtime.pypi ? "可用" : "未检测到"}`}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load(undefined, { force: true })}
            className="rounded-lg border border-line bg-white px-3 py-1.5 text-[12px] shadow-card hover:bg-[#fafafa]"
          >
            刷新
          </button>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="rounded-lg border border-line bg-white px-3 py-1.5 text-[12px] shadow-card hover:bg-[#fafafa]"
            >
              返回接口区
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          aria-label="搜索 MCP 服务"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="搜索服务名，如 filesystem / github"
          className="w-full max-w-[360px] rounded-lg border border-line px-3 py-2 text-[12px] text-ink outline-none focus:border-[#bbb]"
        />
        <div className="flex flex-wrap items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`rounded-lg border px-2.5 py-1 text-[11px] ${
                filter === f.id ? "border-ink bg-ink text-white" : "border-line bg-white text-muted hover:bg-[#fafafa]"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        {loadedAt && (
          <span className="text-[10px] text-[#999]">
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
              ? "border-[#f3d2ce] bg-[#fef3f2] text-[#b42318]"
              : "border-[#d7e9dc] bg-[#f2faf5] text-[#1d6b3a]"
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
              ? "border-[#f0e0b8] bg-[#fff8e6] text-[#8a5a00]"
              : "border-[#f3d2ce] bg-[#fef3f2] text-[#b42318]"
          }`}
        >
          <span>
            {stale ? "无法连接 Registry，正在显示上次缓存。" : error}
          </span>
          <button
            type="button"
            onClick={() => void load(undefined, { force: true })}
            className="rounded border border-current px-2 py-0.5"
          >
            重试
          </button>
        </div>
      )}

      {loading && entries.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-line bg-white p-8 text-center text-[13px] text-muted">
          正在连接 Registry…
        </div>
      ) : visible.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-line bg-white p-8 text-center text-[13px] text-muted">
          {entries.length === 0 ? "没有拉到可展示的服务。检查网络后重试。" : "没有匹配的服务。"}
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
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
            className="rounded-lg border border-line bg-white px-4 py-1.5 text-[12px] shadow-card hover:bg-[#fafafa] disabled:opacity-40"
          >
            {loadingMore ? "加载中…" : "加载更多"}
          </button>
        </div>
      )}

      <p className="mt-4 text-[11px] text-muted">
        Registry 是开放注册中心，任何条目都不代表已通过安全审核。安装前请自行核对来源与仓库。
      </p>
    </div>
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
      className="flex flex-wrap items-start gap-3 rounded-xl border border-line bg-white p-3.5 shadow-card"
    >
      <EntryIcon entry={entry} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-bold">{entry.title}</span>
          {risk && (
            <span
              className={`rounded px-1 text-[10px] ${
                risk.level === "high"
                  ? "bg-[#fdf6f6] text-[#b42318]"
                  : risk.level === "medium"
                    ? "bg-[#fff8e6] text-[#8a5a00]"
                    : "bg-[#f2faf5] text-[#1d6b3a]"
              }`}
              title={risk.message}
            >
              {risk.level === "high" ? "高风险" : risk.level === "medium" ? "中风险" : "低风险"}
            </span>
          )}
          {installed && (
            <span className="rounded bg-[#f0f0f0] px-1 text-[10px] text-[#666]">已安装</span>
          )}
        </div>
        <p className="mt-0.5 line-clamp-2 text-[11px] text-muted">{entry.description || "（无描述）"}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-[#999]">
          <span className="font-mono">{entry.key}</span>
          {option && (
            <span>
              {option.kind === "http"
                ? `远程 · ${hostOf(option.url ?? "") || "未知主机"}`
                : option.label}
            </span>
          )}
          {/* 装不了的原因要点开就看得见，不能只藏在按钮的 title 里（触屏与读屏都拿不到）。 */}
          {option && !installable && <span className="text-[#8a5a00]">{blockReason}</span>}
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
          className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[11px] shadow-card hover:bg-[#fafafa] disabled:cursor-not-allowed disabled:opacity-40"
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
    <div className="relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-[#fafafa] text-[13px] font-bold text-[#777]">
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
