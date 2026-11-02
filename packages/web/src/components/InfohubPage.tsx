import { useEffect, useRef, useState } from "react";
import {
  callInfohub,
  describeInfohubError,
  formatInfohubBytes,
  formatInfohubTime,
  infohubInfo,
  isInfohubAvailable,
  onInfohubEvent,
  pickInfohubHome,
  pickInfohubPython,
  readInfohubConfig,
  startInfohub,
  stopInfohub,
  writeInfohubConfig,
  type InfohubAgendaResult,
  type InfohubBridgeInfo,
  type InfohubConfig,
  type InfohubProgressEvent,
  type InfohubSearchHit,
  type InfohubSearchResult,
  type InfohubStatus,
} from "../lib/infohub/client.js";
import { useInfohubStore } from "../lib/infohub/store.js";
import { useUiStore, type InfohubIntent } from "../store/ui.js";

const SEARCH_LIMIT = 100;

type Phase = "idle" | "connecting" | "ready" | "error";
/** 去 IM 后只保留检索与日程：归档里的聊天会话不再提供浏览入口。 */
type Tab = "search" | "agenda";

function sourceLabel(source: string): string {
  if (source === "qq") return "QQ";
  if (source === "wechat") return "微信";
  return source || "未知";
}

/** 一行统计块：数字大、标题小，扫一眼就能看到数据规模。 */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-line-soft bg-panel px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-0.5 truncate text-[15px] font-semibold tabular-nums text-ink">{value}</div>
    </div>
  );
}

/** FTS5 snippet 用 `<<…>>` 标命中词：渲染成高亮而不是把标记原样显示。 */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(<<|>>)/);
  let highlight = false;
  return (
    <>
      {parts.map((part, index) => {
        if (part === "<<") {
          highlight = true;
          return null;
        }
        if (part === ">>") {
          highlight = false;
          return null;
        }
        return highlight ? (
          <mark key={index} className="rounded bg-[#fff1a8] px-0.5 text-ink">
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        );
      })}
    </>
  );
}

/**
 * 信息中枢（d.45）：把 InfoHub 的本机 QQ/微信归档接进和鸣。
 *
 * 红线：
 * - 只读：归档以 `mode=ro` 打开，检索与重扫不会写库；
 * - 数据不出本机：不调用任何云端接口，浏览器环境直接显示「仅桌面端可用」；
 * - 不自动采集：进程由用户点「连接」拉起，同步由用户显式勾选来源后触发。
 */
export function InfohubPage() {
  const available = isInfohubAvailable();

  const [info, setInfo] = useState<InfohubBridgeInfo | null>(null);
  const [home, setHome] = useState(() => readInfohubConfig().home ?? "");
  const [python, setPython] = useState(() => readInfohubConfig().python ?? "");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");

  const [status, setStatus] = useState<InfohubStatus | null>(null);
  const [tab, setTab] = useState<Tab>("search");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<InfohubSearchHit[]>([]);
  const [searchedFor, setSearchedFor] = useState("");
  const [agenda, setAgenda] = useState<InfohubAgendaResult | null>(null);

  const [busy, setBusy] = useState("");
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncSources, setSyncSources] = useState({ qq: true, wechat: true });
  const [syncFull, setSyncFull] = useState(false);
  const [syncArchive, setSyncArchive] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<InfohubProgressEvent | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  /** 首页卡/命令面板投递的一次性意图：检索词或日程页。 */
  const intent = useUiStore((s) => s.infohubIntent);
  const consumeInfohubIntent = useUiStore((s) => s.consumeInfohubIntent);
  const openAutomations = useUiStore((s) => s.openAutomations);
  const pendingIntentRef = useRef<InfohubIntent | null>(null);

  /** 当前连接配置：未填目录时交给主进程用默认目录。 */
  function currentConfig(): InfohubConfig {
    const trimmedHome = home.trim();
    const trimmedPython = python.trim();
    return {
      ...(trimmedHome ? { home: trimmedHome } : {}),
      ...(trimmedPython ? { python: trimmedPython } : {}),
    };
  }

  async function loadStatus(config: InfohubConfig) {
    const next = await callInfohub<InfohubStatus>("status", {}, config);
    setStatus(next);
    // 首页卡与归档工具读共享 store：页面里刷新过的规模/连接态要立刻可见
    useInfohubStore.setState({ status: next });
    return next;
  }

  async function loadAgenda(config: InfohubConfig) {
    setBusy("agenda");
    try {
      const data = await callInfohub<InfohubAgendaResult>("agenda", { days: 14, overdue: 30 }, config);
      setAgenda(data);
      useInfohubStore.setState({ agenda: data });
    } finally {
      setBusy("");
    }
  }

  async function connect(override?: InfohubConfig) {
    if (phase === "connecting") return;
    const config = override ?? currentConfig();
    setPhase("connecting");
    setError("");
    try {
      const next = await startInfohub(config);
      setInfo(next);
      useInfohubStore.getState().syncInfo(next);
      if (next.running) void useInfohubStore.getState().refresh();
      if (next.home) setHome(next.home);
      if (next.python) setPython(next.python);
      writeInfohubConfig({ home: next.home ?? config.home, python: next.python ?? config.python });
      await loadStatus(config);
      setPhase("ready");
    } catch (err) {
      setPhase("error");
      setError(describeInfohubError(err));
    }
  }

  // 首次进入：只读取静态信息与已保存配置。进程已经在跑（例如从别的页面切回来）才重新挂上，
  // 否则保持 idle——拉起子进程必须由用户点「连接」。
  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    void (async () => {
      try {
        const bridgeInfo = await infohubInfo();
        if (cancelled) return;
        setInfo(bridgeInfo);
        useInfohubStore.getState().syncInfo(bridgeInfo);
        if (bridgeInfo.running) void useInfohubStore.getState().refresh();
        const saved = readInfohubConfig();
        if (!saved.home) setHome(bridgeInfo.home ?? "");
        if (bridgeInfo.running && bridgeInfo.home) {
          setHome(bridgeInfo.home);
          if (bridgeInfo.python) setPython(bridgeInfo.python);
          setPhase("connecting");
          const config: InfohubConfig = { home: bridgeInfo.home };
          await loadStatus(config);
          setPhase("ready");
        }
      } catch (err) {
        if (!cancelled) {
          setPhase("error");
          setError(describeInfohubError(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // 只在可用性变化时初始化一次：其余状态由用户显式操作驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available]);

  // 采集/导出进度：主进程广播，页面只展示最近一条（Python 侧已按 0.1s 节流）。
  useEffect(() => {
    if (!available) return;
    return onInfohubEvent((event) => {
      if (event && event.event === "progress") setProgress(event);
    });
  }, [available]);

  // 跨页意图：首页卡/命令面板投递检索词或日程页。未连接时先记住，连接就绪后再执行。
  useEffect(() => {
    if (!intent) return;
    pendingIntentRef.current = intent;
    consumeInfohubIntent();
    setTab(intent.tab);
    if (intent.tab === "search") setQuery(intent.query ?? "");
    if (phase !== "ready") return;
    const pending = pendingIntentRef.current;
    pendingIntentRef.current = null;
    if (pending?.tab === "search" && pending.query?.trim()) {
      void runSearch(pending.query);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent]);

  useEffect(() => {
    if (phase !== "ready") return;
    const pending = pendingIntentRef.current;
    if (!pending) return;
    pendingIntentRef.current = null;
    // 日程页由下面的 [phase, tab, agenda] effect 负责加载
    if (pending.tab === "search" && pending.query?.trim()) {
      void runSearch(pending.query);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // 切到日程页且还没拉过时才请求，避免每次切页都重算。
  useEffect(() => {
    if (phase !== "ready" || tab !== "agenda" || agenda) return;
    void loadAgenda(currentConfig()).catch((err) => setError(describeInfohubError(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, tab, agenda]);

  async function refresh() {
    if (phase !== "ready") return;
    setError("");
    try {
      const config = currentConfig();
      await loadStatus(config);
      if (agenda) await loadAgenda(config);
    } catch (err) {
      setError(describeInfohubError(err));
    }
  }

  async function disconnect() {
    try {
      await stopInfohub();
    } catch {
      /* 进程可能已经退出：断开仍然是「回到未连接状态」 */
    }
    setPhase("idle");
    useInfohubStore.getState().markStopped();
    setStatus(null);
    setAgenda(null);
    setHits([]);
    setProgress(null);
  }

  async function chooseHome() {
    try {
      const picked = await pickInfohubHome();
      if (picked) setHome(picked);
    } catch (err) {
      setError(describeInfohubError(err));
    }
  }

  async function choosePython() {
    try {
      const picked = await pickInfohubPython();
      if (picked) setPython(picked);
    } catch (err) {
      setError(describeInfohubError(err));
    }
  }

  async function runSearch(term?: string) {
    const trimmed = (term ?? query).trim();
    if (!trimmed || phase !== "ready") return;
    if (term !== undefined) setQuery(trimmed);
    setBusy("search");
    setError("");
    try {
      const data = await callInfohub<InfohubSearchResult>(
        "search",
        { query: trimmed, limit: SEARCH_LIMIT },
        currentConfig(),
      );
      setHits(Array.isArray(data.items) ? data.items : []);
      setSearchedFor(data.query || trimmed);
    } catch (err) {
      setError(describeInfohubError(err));
    } finally {
      setBusy("");
    }
  }

  async function rebuildAgenda() {
    if (phase !== "ready") return;
    setBusy("rebuild");
    setError("");
    try {
      const data = await callInfohub<InfohubAgendaResult>(
        "agenda",
        { days: 14, overdue: 30, rebuild: true },
        currentConfig(),
      );
      setAgenda(data);
      useInfohubStore.setState({ agenda: data });
    } catch (err) {
      setError(describeInfohubError(err));
    } finally {
      setBusy("");
    }
  }

  async function runSync() {
    if (phase !== "ready" || syncing) return;
    const sources = [syncSources.qq ? "qq" : "", syncSources.wechat ? "wechat" : ""].filter(Boolean);
    if (sources.length === 0) {
      setError("至少选择一个采集来源");
      return;
    }
    setSyncing(true);
    setError("");
    setProgress(null);
    try {
      await callInfohub(
        "sync",
        { sources, full: syncFull, archive: syncArchive },
        currentConfig(),
      );
      const config = currentConfig();
      await loadStatus(config);
      setAgenda(null);
      // 同步会写归档：共享 store 的规模与日程立即重算，首页卡不显示旧数据
      void useInfohubStore.getState().refresh();
    } catch (err) {
      setError(describeInfohubError(err));
    } finally {
      setSyncing(false);
      setProgress(null);
    }
  }

  /** 把当前同步选项带到自动化页的新建表单（不在这里复制任务状态）。 */
  function scheduleSyncAutomation() {
    const sources = [syncSources.qq ? "qq" : "", syncSources.wechat ? "wechat" : ""].filter(
      (s): s is "qq" | "wechat" => Boolean(s),
    );
    if (sources.length === 0) {
      setError("至少选择一个采集来源");
      return;
    }
    openAutomations({
      kind: "infohub.sync",
      sync: { sources, full: syncFull, archive: syncArchive },
    });
  }

  /* ---------------------------------------------------------------- 渲染 */

  if (!available) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6">
        <div className="max-w-[460px] rounded-xl border border-line bg-white p-6 shadow-card">
          <h1 className="text-[16px] font-semibold">信息中枢仅桌面端可用</h1>
          <p className="mt-2 text-[12px] leading-6 text-muted">
            QQ / 微信归档要读取本机数据库，必须由桌面端拉起本机进程。
            和鸣不会把归档上传到云端，所以浏览器环境没有可用的数据源。
          </p>
        </div>
      </div>
    );
  }

  const ready = phase === "ready";
  const lastMessageText = status?.lastMessageTs ? formatInfohubTime(status.lastMessageTs) : "";

  const statusLine = syncing
    ? progress
      ? `正在同步 · ${progress.stage}${progress.total ? ` ${progress.current}/${progress.total}` : ""}`
      : "正在同步…"
    : ready
      ? "已连接 · 只读归档"
      : phase === "connecting"
        ? "正在连接…"
        : "未连接";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-5 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-[15px] font-semibold tracking-tight">信息中枢</h1>
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                ready ? "bg-[#1f9d55]" : phase === "error" ? "bg-[#b42318]" : "bg-[#bbb]"
              }`}
              aria-hidden
            />
            <span className="text-[11px] text-muted">{statusLine}</span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted">
            {ready && status ? `${status.stats.conversations} 个归档会话 · ${formatInfohubBytes(status.dbBytes)}` : "QQ / 微信归档只在本机处理"}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {ready && (
            <>
              <button
                type="button"
                onClick={() => setSyncOpen((v) => !v)}
                className="rounded-md border border-line px-2.5 py-1 text-[11px] shadow-card hover:bg-[#fafafa]"
              >
                {syncOpen ? "收起同步" : "同步"}
              </button>
              <button
                type="button"
                aria-label="新建定时同步"
                title="把当前同步选项设为定时任务"
                onClick={scheduleSyncAutomation}
                className="rounded-md border border-line px-2.5 py-1 text-[11px] shadow-card hover:bg-[#fafafa]"
              >
                定时
              </button>
              <button
                type="button"
                onClick={() => void refresh()}
                className="rounded-md border border-line px-2.5 py-1 text-[11px] shadow-card hover:bg-[#fafafa]"
              >
                刷新
              </button>
              <button
                type="button"
                onClick={() => void disconnect()}
                className="rounded-md border border-line px-2.5 py-1 text-[11px] text-[#666] hover:bg-[#fafafa]"
              >
                断开
              </button>
            </>
          )}
        </div>
      </header>

      {error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 border-b border-[#f3c6c2] bg-[#fdf3f2] px-5 py-2 text-[11px] leading-5 text-[#912018]"
        >
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" onClick={() => setError("")} className="shrink-0 hover:underline">
            关闭
          </button>
        </div>
      )}

      {/* 未连接：数据目录与解释器设置。默认目录来自主进程，可浏览选择已有 InfoHub 目录。 */}
      {!ready && (
        <div className="min-h-0 flex-1 overflow-auto px-5 py-6">
          <div className="mx-auto max-w-[620px] rounded-xl border border-line bg-white p-5 shadow-card">
            <h2 className="text-[14px] font-semibold">连接本机归档</h2>
            <p className="mt-1 text-[12px] leading-6 text-muted">
              指向已有的 InfoHub 数据目录（里面有 <code className="rounded bg-[#f4f4f4] px-1">config.json</code> 和{" "}
              <code className="rounded bg-[#f4f4f4] px-1">data/archive.db</code>）。
              首次使用也可以直接用默认目录，同步后自动建库。
            </p>

            <label className="mt-4 block text-[11px] font-medium text-[#555]" htmlFor="infohub-home">
              数据目录
            </label>
            <div className="mt-1 flex gap-1.5">
              <input
                id="infohub-home"
                value={home}
                onChange={(e) => setHome(e.target.value)}
                placeholder={info?.defaultHome ?? "例如 D:\\wohaolei"}
                className="min-w-0 flex-1 rounded-md border border-line px-2.5 py-1.5 text-[12px] outline-none focus:border-[#bbb]"
              />
              <button
                type="button"
                onClick={() => void chooseHome()}
                className="shrink-0 rounded-md border border-line px-2.5 py-1.5 text-[11px] hover:bg-[#fafafa]"
              >
                浏览…
              </button>
            </div>
            {info?.defaultHome && home !== info.defaultHome && (
              <button
                type="button"
                onClick={() => setHome(info.defaultHome)}
                className="mt-1 text-[10px] text-muted underline-offset-2 hover:underline"
              >
                使用默认目录 {info.defaultHome}
              </button>
            )}

            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="mt-4 text-[11px] text-[#555] hover:text-ink"
              aria-expanded={showAdvanced}
            >
              {showAdvanced ? "收起高级设置" : "高级设置（Python 解释器）"}
            </button>
            {showAdvanced && (
              <div className="mt-2 rounded-lg border border-line-soft bg-panel p-3">
                <label className="block text-[11px] font-medium text-[#555]" htmlFor="infohub-python">
                  Python 解释器
                </label>
                <div className="mt-1 flex gap-1.5">
                  <input
                    id="infohub-python"
                    value={python}
                    onChange={(e) => setPython(e.target.value)}
                    placeholder={info?.bundledPython ?? "内置运行时不可用，请选择 python.exe"}
                    className="min-w-0 flex-1 rounded-md border border-line px-2.5 py-1.5 text-[12px] outline-none focus:border-[#bbb]"
                  />
                  <button
                    type="button"
                    onClick={() => void choosePython()}
                    className="shrink-0 rounded-md border border-line px-2.5 py-1.5 text-[11px] hover:bg-[#fafafa]"
                  >
                    浏览…
                  </button>
                </div>
                <p className="mt-1 text-[10px] leading-4 text-muted">
                  浏览/检索只需要标准库；<strong>同步采集</strong>需要 InfoHub 的虚拟环境
                  （含 wechatauto-replica / zstandard 等依赖）。留空则使用内置运行时。
                </p>
              </div>
            )}

            <div className="mt-5 flex items-center gap-2">
              <button
                type="button"
                disabled={phase === "connecting"}
                onClick={() => void connect()}
                className="rounded-md bg-ink px-4 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {phase === "connecting" ? "连接中…" : "连接"}
              </button>
              {info?.bundledPython ? (
                <span className="text-[10px] text-muted">内置运行时可用</span>
              ) : (
                <span className="text-[10px] text-[#b42318]">未找到内置运行时</span>
              )}
            </div>
          </div>
        </div>
      )}

      {ready && status && (
        <>
          <div className="flex gap-2 border-b border-line-soft px-5 py-2.5">
            <Stat label="归档会话" value={String(status.stats.conversations)} />
            <Stat label="消息" value={status.stats.messages.toLocaleString("zh-CN")} />
            <Stat label="日程" value={agenda ? String(agenda.summary.total) : "—"} />
            <Stat label="最后消息" value={lastMessageText || "—"} />
            <Stat label="归档大小" value={formatInfohubBytes(status.dbBytes)} />
          </div>

          {syncOpen && (
            <div className="border-b border-line-soft bg-panel px-5 py-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
                <span className="font-medium text-[#555]">采集来源</span>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={syncSources.qq}
                    disabled={syncing}
                    onChange={(e) => setSyncSources((s) => ({ ...s, qq: e.target.checked }))}
                  />
                  QQ
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={syncSources.wechat}
                    disabled={syncing}
                    onChange={(e) => setSyncSources((s) => ({ ...s, wechat: e.target.checked }))}
                  />
                  微信
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={syncFull}
                    disabled={syncing}
                    onChange={(e) => setSyncFull(e.target.checked)}
                  />
                  全量重扫
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={syncArchive}
                    disabled={syncing}
                    onChange={(e) => setSyncArchive(e.target.checked)}
                  />
                  导出知识库
                </label>
                <button
                  type="button"
                  disabled={syncing}
                  onClick={() => void runSync()}
                  className="rounded-md bg-ink px-3 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {syncing ? "同步中…" : "开始同步"}
                </button>
                <button
                  type="button"
                  disabled={syncing}
                  onClick={scheduleSyncAutomation}
                  className="rounded-md border border-line px-2.5 py-1 text-[11px] hover:bg-[#fafafa] disabled:opacity-50"
                >
                  保存为定时任务
                </button>
                <span className="text-[10px] text-muted">同步会写入归档库；检索与日程始终只读。</span>
              </div>
              {syncing && (
                <div className="mt-2">
                  <div className="h-1 overflow-hidden rounded-full bg-[#e8e8e8]">
                    <div
                      className="h-full rounded-full bg-ink transition-[width] duration-200"
                      style={{
                        width: progress?.total
                          ? `${Math.min(100, Math.round((progress.current / progress.total) * 100))}%`
                          : "30%",
                      }}
                    />
                  </div>
                  <div className="mt-1 text-[10px] text-muted">
                    {progress ? `${progress.stage} · ${progress.current}/${progress.total}` : "准备中…"}
                  </div>
                </div>
              )}
            </div>
          )}

          <div role="tablist" className="flex items-center gap-1 border-b border-line-soft px-5 py-2">
            {(
              [
                ["search", "检索"],
                ["agenda", "日程"],
              ] as [Tab, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                className={`rounded-md px-3 py-1 text-[12px] transition-colors ${
                  tab === value ? "bg-ink text-white" : "text-[#666] hover:bg-[#f2f2f2] hover:text-ink"
                }`}
              >
                {label}
                {value === "agenda" && agenda?.summary.overdue ? (
                  <span className="ml-1 rounded-full bg-[#fdecea] px-1 text-[9px] font-semibold text-[#b42318]">
                    {agenda.summary.overdue}
                  </span>
                ) : null}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2 text-[10px] text-muted">
              {Object.entries(status.sources).map(([key, value]) => (
                <span key={key} title={value.detail || ""}>
                  {sourceLabel(key)} {value.status || "未同步"}
                  {value.lastRun ? ` · ${formatInfohubTime(value.lastRun)}` : ""}
                </span>
              ))}
            </div>
          </div>

          {!status.hasDb && (
            <div className="border-b border-line-soft bg-[#fffdf5] px-5 py-2 text-[11px] text-[#8a6d3b]">
              该目录还没有归档库。先在「同步」里选择来源并开始采集；采集完成后这里会自动刷新。
            </div>
          )}

          {tab === "search" && (
            <div className="flex min-h-0 flex-1 flex-col">
              <form
                className="flex gap-2 border-b border-line-soft px-5 py-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void runSearch();
                }}
              >
                <input
                  aria-label="在归档中检索"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="全文检索（FTS5 trigram）：人物、地点、单号…"
                  className="min-w-0 flex-1 rounded-md border border-line px-3 py-1.5 text-[12px] outline-none focus:border-[#bbb]"
                />
                <button
                  type="submit"
                  disabled={busy === "search"}
                  className="rounded-md bg-ink px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {busy === "search" ? "检索中…" : "检索"}
                </button>
              </form>
              <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
                {hits.length === 0 ? (
                  <p className="text-[11px] text-muted">
                    {searchedFor ? `没有找到「${searchedFor}」` : "输入关键词后回车。检索只在本机归档内进行。"}
                  </p>
                ) : (
                  <>
                    <p className="mb-2 text-[10px] text-muted">
                      「{searchedFor}」命中 {hits.length} 条
                    </p>
                    <ul className="flex flex-col gap-1.5">
                      {hits.map((hit) => (
                        <li key={hit.id}>
                          <div className="rounded-lg border border-line-soft bg-white px-3 py-2">
                            <div className="flex items-baseline gap-2 text-[10px] text-muted">
                              <span className="font-medium text-[#555]">{hit.convName}</span>
                              <span>{sourceLabel(hit.source)}</span>
                              <span className="ml-auto">{formatInfohubTime(hit.ts, true)}</span>
                            </div>
                            <div className="mt-1 text-[12px] leading-5">
                              {hit.senderName ? <span className="text-muted">{hit.senderName}：</span> : null}
                              <Snippet text={hit.snippet || hit.content} />
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </div>
          )}

          {tab === "agenda" && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center gap-3 border-b border-line-soft px-5 py-2.5 text-[11px]">
                <span className="text-muted">
                  未来 14 天 · 逾期 30 天
                  {agenda ? ` · 共 ${agenda.summary.total} 条` : ""}
                </span>
                {agenda && (
                  <span className="flex gap-2 text-[10px]">
                    <span className="text-[#b42318]">逾期 {agenda.summary.overdue}</span>
                    <span>今天 {agenda.summary.today}</span>
                    <span>本周 {agenda.summary.week}</span>
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy === "rebuild"}
                    onClick={() => void rebuildAgenda()}
                    className="rounded-md border border-line px-2.5 py-1 text-[11px] hover:bg-[#fafafa] disabled:opacity-50"
                  >
                    {busy === "rebuild" ? "重扫中…" : "重扫议程"}
                  </button>
                  <button
                    type="button"
                    aria-label="新建定时重扫"
                    onClick={() => openAutomations({ kind: "infohub.agenda" })}
                    className="rounded-md border border-line px-2.5 py-1 text-[11px] hover:bg-[#fafafa]"
                  >
                    定时重扫
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
                {!agenda || agenda.items.length === 0 ? (
                  <p className="text-[11px] text-muted">
                    {agenda ? "没有待办事项" : "读取中…"}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {agenda.items.map((item) => {
                      const now = Date.now() / 1000;
                      const overdue = item.dueTs > 0 && item.dueTs < now;
                      return (
                        <li
                          key={item.id}
                          className="flex items-start gap-3 rounded-lg border border-line-soft bg-white px-3 py-2"
                        >
                          <span
                            className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                              overdue ? "bg-[#fdecea] text-[#b42318]" : "bg-[#f2f2f2] text-[#555]"
                            }`}
                          >
                            {item.dueText || (item.dueTs ? formatInfohubTime(item.dueTs) : "未定")}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[12px] font-medium text-ink">{item.title}</div>
                            {item.detail && (
                              <div className="mt-0.5 line-clamp-2 text-[11px] leading-5 text-[#666]">{item.detail}</div>
                            )}
                            <div className="mt-0.5 text-[10px] text-muted">
                              {item.convName}
                              {item.senderName ? ` · ${item.senderName}` : ""}
                              {item.msgTs ? ` · 消息 ${formatInfohubTime(item.msgTs, true)}` : ""}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          )}

          <details className="shrink-0 border-t border-line-soft bg-panel px-5 py-2 text-[11px]">
            <summary className="cursor-pointer text-[#555]">本机配置（已脱敏）</summary>
            <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-[10px] text-[#666] sm:grid-cols-4">
              <span>QQ：{status.config.qq.enabled ? "启用" : "停用"}</span>
              <span>微信：{status.config.wechat.enabled ? "启用" : "停用"}</span>
              <span>语音转写：{status.config.voice.enabled ? "启用" : "停用"}</span>
              <span>议程摘要：{status.config.digest.enabled ? "启用" : "停用"}</span>
              <span>推送：{status.config.push.channel}（{status.config.push.hasCredentials ? "凭据已配置" : "无凭据"}）</span>
              <span>
                模型：{status.config.llm.model || "未设置"}（{status.config.llm.hasKey ? "Key 已配置" : "无 Key"}）
              </span>
              <span>知识库：{status.config.kb.autoExport ? "自动导出" : "未开启导出"}</span>
              <span>智能体：{status.config.agent.enabled ? "启用" : "停用"}</span>
            </div>
            <p className="mt-1.5 break-all text-[10px] text-muted">配置：{status.configPath}</p>
            <p className="break-all text-[10px] text-muted">归档：{status.dbPath}</p>
          </details>
        </>
      )}
    </div>
  );
}
