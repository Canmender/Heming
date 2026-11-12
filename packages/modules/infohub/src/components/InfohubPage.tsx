import { useEffect, useRef, useState } from "react";
import {
  callInfohub,
  describeInfohubError,
  detectedSourcesFromSummary,
  formatInfohubBytes,
  formatInfohubTime,
  isInfohubAvailable,
  onInfohubEvent,
  readInfohubConfig,
  type InfohubAgendaResult,
  type InfohubConfig,
  type InfohubDetectedSources,
  type InfohubProgressEvent,
  type InfohubSearchHit,
  type InfohubSearchResult,
  type InfohubStatus,
  type InfohubSyncResult,
} from "@heming/sdk";
import { useInfohubStore } from "@heming/sdk";
import { useUiStore, type InfohubIntent } from "@heming/sdk";
import { isModuleEffective, useModuleStore } from "@heming/sdk";
import { PageShell } from "@heming/sdk";
import { InfohubChats } from "./InfohubChats.js";

const SEARCH_LIMIT = 100;

type Phase = "idle" | "connecting" | "ready" | "error";
/**
 * 页面顶层的三个页签：检索 / 会话 / 日程。
 *
 * 会话页签是原 infohub-page 插件的聊天浏览界面并入后的入口：同样只读本机归档，
 * 数据走桥的 conversations / messages，不再单独安装插件。
 * 默认仍是「检索」：首页卡和命令面板投递的意图都以检索为主，会话是并列的浏览入口。
 */
type Tab = "search" | "chats" | "agenda";

function sourceLabel(source: string): string {
  if (source === "qq") return "QQ";
  if (source === "wechat") return "微信";
  return source || "未知";
}

/** 一行统计块：数字大、标题小，扫一眼就能看到数据规模。 */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-line-soft bg-panel px-3 py-2">
      <div className="ui-micro uppercase tracking-wider">{label}</div>
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
          <mark key={index} className="rounded-sm bg-[var(--warn-soft)] px-0.5 text-ink">
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
 * 「采集来源」小节：微信目录 / QQNT 库 / QQ 导出目录的识别状态。
 *
 * 识别与采集都在边车启动时自动完成，这里只展示结果与自动采集说明；
 * 路径默认折叠，展开后可复制——长路径一上来就铺满会挤掉真正要看的状态。
 */
function SourceSection({
  detected,
  autoNote,
}: {
  detected: InfohubDetectedSources | null;
  autoNote: string;
}) {
  const [showPaths, setShowPaths] = useState(false);
  const [copied, setCopied] = useState("");

  async function copy(key: string, value: string) {
    if (!value) return;
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(""), 1500);
    } catch {
      /* 剪贴板不可用（无权限/浏览器）：路径仍然可在展开区看到 */
    }
  }

  const rows: Array<{ key: string; label: string; path: string; detected: boolean }> = [
    {
      key: "wechat",
      label: "微信目录",
      path: detected?.wechat.db_dir ?? "",
      detected: Boolean(detected?.wechat.detected),
    },
    {
      key: "qqnt",
      label: "QQNT 消息库",
      path: detected?.qq.nt_db ?? "",
      detected: Boolean(detected?.qq.detected && detected?.qq.nt_db),
    },
    {
      key: "qqexport",
      label: "QQ 导出目录",
      path: detected?.qq.export_dir ?? "",
      detected: Boolean(detected?.qq.export_detected ?? (detected?.qq.export_dir && detected?.qq.detected)),
    },
  ];

  return (
    <div className="border-b border-line-soft bg-panel px-6 py-2.5" data-testid="infohub-sources">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 ui-caption">
        <span className="font-medium text-[var(--body)]">采集来源</span>
        {rows.map((row) => (
          <span key={row.key} className="flex items-center gap-1.5" data-testid={`source-${row.key}`}>
            <span>{row.label}</span>
            <span
              className={`rounded-sm px-1 py-0.5 ui-micro font-medium ${
                row.detected ? "bg-[var(--success-soft)] text-[var(--success)]" : "bg-[var(--danger-soft)] text-[var(--danger)]"
              }`}
            >
              {row.detected ? "已识别" : "未找到"}
            </span>
            {row.key === "qqnt" && detected?.qq.nt_account ? (
              <span className="ui-micro">账号 {detected.qq.nt_account}</span>
            ) : null}
          </span>
        ))}
        <button
          type="button"
          onClick={() => setShowPaths((v) => !v)}
          className="ui-micro underline-offset-2 hover:underline"
          aria-expanded={showPaths}
        >
          {showPaths ? "收起路径" : "查看路径"}
        </button>
      </div>
      {autoNote && (
        <p className="mt-1 ui-micro text-[var(--body)]" role="status">
          {autoNote}
        </p>
      )}
      {showPaths && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {rows.map((row) => (
            <li key={row.key} className="flex min-w-0 items-center gap-2 ui-micro">
              <span className="w-24 shrink-0 text-muted">{row.label}</span>
              <code className="min-w-0 flex-1 truncate rounded-sm bg-[var(--surface)] px-1 py-0.5" title={row.path || "未找到"}>
                {row.path || "未找到"}
              </code>
              <button
                type="button"
                disabled={!row.path}
                aria-label={`复制${row.label}`}
                onClick={() => void copy(row.key, row.path)}
                className="shrink-0 underline-offset-2 hover:underline disabled:opacity-40"
              >
                {copied === row.key ? "已复制" : "复制"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 信息中枢（d.45）：把 InfoHub 的本机 QQ/微信归档接进和鸣。
 *
 * 红线：
 * - 只读：归档以 `mode=ro` 打开，检索与重扫不会写库；
 * - 数据不出本机：不调用任何云端接口，浏览器环境直接显示「仅桌面端可用」；
 * - 全自动：模块生效后自动拉起边车、自动识别目录、空库时自动采集一次；
 *   页面不提供目录/解释器/连接表单，识别与采集结果仍完整展示（失败原因不吞）。
 */
export function InfohubPage() {
  const available = isInfohubAvailable();

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
  /** 自动采集说明由共享 store 产出：首页卡与页面看到同一条结果。 */
  const autoNote = useInfohubStore((s) => s.autoNote);

  /** 首页卡/命令面板投递的一次性意图：检索词或日程页。 */
  const intent = useUiStore((s) => s.infohubIntent);
  const consumeInfohubIntent = useUiStore((s) => s.consumeInfohubIntent);
  const openAutomations = useUiStore((s) => s.openAutomations);
  // d.70：自动化模块停用时，「定时 / 保存为定时任务 / 定时重扫」不把人送到一个不存在的页
  const automationsOn = useModuleStore((s) => isModuleEffective(s, "automations"));
  const pendingIntentRef = useRef<InfohubIntent | null>(null);

  /** 连接配置来自主进程落盘的解析结果（默认目录 / 内置运行时），页面不再手填。 */
  function currentConfig(): InfohubConfig {
    return readInfohubConfig();
  }

  async function loadStatus(config: InfohubConfig, applyDetected = false) {
    const next = await callInfohub<InfohubStatus>("status", {}, config);
    setStatus(next);
    if (applyDetected) {
      // 默认勾选检测到的来源；未识别的来源在同步面板里置灰并提示。
      const detected = detectedSourcesFromSummary(next.config);
      setSyncSources({ qq: detected.qq.detected, wechat: detected.wechat.detected });
    }
    // 首页卡与归档工具读共享 store：页面里刷新过的规模/连接态要立刻可见
    useInfohubStore.setState({
      status: next,
      detected: detectedSourcesFromSummary(next.config),
    });
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

  /**
   * 自动就绪：拉起（或复用）边车 → 读状态 → 空库自动采集。
   * 进入页面、模块被重新启用、失败后点「重试」都走这里，不需要用户配置任何路径。
   */
  async function autoStart() {
    if (phase === "connecting") return;
    setPhase("connecting");
    setError("");
    try {
      await useInfohubStore.getState().ensureRunning();
      const state = useInfohubStore.getState();
      if (!state.running) {
        setPhase("error");
        setError(state.error || "本机归档没能启动");
        return;
      }
      const next = state.status ?? (await loadStatus(currentConfig(), true));
      setStatus(next);
      const detected = detectedSourcesFromSummary(next.config);
      setSyncSources({ qq: detected.qq.detected, wechat: detected.wechat.detected });
      if (state.error) setError(state.error);
      setPhase("ready");
    } catch (err) {
      setPhase("error");
      setError(describeInfohubError(err));
    }
  }

  // 进入页面即自动就绪：模块已生效时不需要任何「连接」点击。
  useEffect(() => {
    if (!available) return;
    void autoStart();
    // 只在可用性变化时初始化一次；运行态变化由 store 与页面操作驱动。
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

  /** 手动采集一次：来源走同步面板的勾选。自动采集在 store 里，与本函数共用同一协议。 */
  async function runSync() {
    if (syncing) return;
    if (phase !== "ready") return;
    const config = currentConfig();
    const sources = [syncSources.qq ? "qq" : "", syncSources.wechat ? "wechat" : ""].filter(
      (s): s is "qq" | "wechat" => Boolean(s),
    );
    if (sources.length === 0) {
      setError("至少选择一个采集来源");
      return;
    }
    setSyncing(true);
    setError("");
    setProgress(null);
    try {
      const result = await callInfohub<InfohubSyncResult>(
        "sync",
        { sources, full: syncFull, archive: syncArchive },
        config,
      );
      const reports = Array.isArray(result?.reports) ? result.reports : [];
      const errors = reports.flatMap((report) => report.errors ?? []);
      if (errors.length) setError(errors.join("；"));
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
    // 与其他页保持同一套页面骨架：有页头、有说明，用户不会落到一个「只有一张卡片」的空页面。
    return (
      <PageShell
        title="信息中枢"
        subtitle="QQ / 微信归档只在本机处理；浏览器里读不到本机数据。"
        // d.72：这个分支只有一张说明卡，滚动容器里 flex-1 撑不开高度、items-center 失效，
        // 卡片会贴在顶部。改为 PageShell 不接管滚动，让说明卡在整页垂直居中。
        scroll={false}
      >
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
          <div className="w-full max-w-[460px] rounded-xl border border-line bg-[var(--surface)] p-6 shadow-card">
            <h2 className="text-[16px] font-semibold">信息中枢仅桌面端可用</h2>
            <p className="mt-2 text-[12px] leading-6 text-muted">
              QQ / 微信归档要读取本机数据库，需要由桌面版启动本机进程。
              和鸣不会把归档上传到云端，所以浏览器里没有可用的数据源。
            </p>
            <p className="mt-2 ui-caption">
              在桌面版安装包里打开「信息中枢」，即可连接本机归档并检索。
            </p>
          </div>
        </div>
      </PageShell>
    );
  }

  const ready = phase === "ready";
  // 会话页签的数据在组件内部按需拉取；归档规模变化（同步/刷新）时给一个 token 触发重载，
  // 规模没变就不打断用户正在看的列表与消息。
  const chatsRefreshToken = status
    ? `${status.stats.messages}:${status.stats.conversations}`
    : "";
  // status.config 里带着 Python 的识别结果：已配置路径优先，缺失时用检测值。
  const detected = detectedSourcesFromSummary(status?.config);
  const lastMessageText = status?.lastMessageTs ? formatInfohubTime(status.lastMessageTs) : "";

  const statusLine = syncing
    ? progress
      ? `正在同步 · ${progress.stage}${progress.total ? ` ${progress.current}/${progress.total}` : ""}`
      : "正在同步…"
    : ready
      ? "已连接 · 只读归档"
      : phase === "connecting"
        ? "自动启动中…"
        : "未就绪";

  return (
    <PageShell
      title={
        <span className="flex items-center gap-2">
          信息中枢
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              ready ? "bg-[var(--success)]" : phase === "error" ? "bg-[var(--danger)]" : "bg-[var(--line-strong)]"
            }`}
            aria-hidden
          />
          <span className="ui-caption">{statusLine}</span>
        </span>
      }
      subtitle={
        ready && status
          ? `${status.stats.conversations} 个归档会话 · ${formatInfohubBytes(status.dbBytes)}`
          : "QQ / 微信归档只在本机处理"
      }
      width="full"
      scroll={false}
      actions={
        <>
          {ready && (
            <>
              <button
                type="button"
                onClick={() => setSyncOpen((v) => !v)}
                className="ui-btn ui-btn-sm ui-btn-ghost"
              >
                {syncOpen ? "收起同步" : "同步"}
              </button>
              <button
                type="button"
                aria-label="新建定时同步"
                title={
                  automationsOn
                    ? "把当前同步选项设为定时任务"
                    : "自动化模块已停用：到「插件区 → 模块」启用后可再建定时任务"
                }
                disabled={!automationsOn}
                onClick={scheduleSyncAutomation}
                className="ui-btn ui-btn-sm ui-btn-ghost"
              >
                定时
              </button>
              <button
                type="button"
                onClick={() => void refresh()}
                className="ui-btn ui-btn-sm ui-btn-ghost"
              >
                刷新
              </button>
            </>
          )}
        </>
      }
    >
      {error && ready && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 border-b border-[var(--danger-line)] bg-[var(--danger-soft)] px-6 py-2 ui-caption text-[var(--danger)]"
        >
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" onClick={() => setError("")} className="shrink-0 hover:underline">
            关闭
          </button>
        </div>
      )}

      {/* 未就绪：不给任何路径/解释器表单。装上模块就自动连、自动识别、空库自动采集。 */}
      {!ready && (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
          <div className="w-full max-w-[460px] rounded-xl border border-line bg-[var(--surface)] p-6 text-center shadow-card">
            {phase === "error" ? (
              <>
                <h2 className="text-[15px] font-semibold">本机归档没能启动</h2>
                <p role="alert" className="mt-2 break-words text-[12px] leading-6 text-[var(--danger)]">
                  {error || "未知原因"}
                </p>
                <p className="mt-2 ui-micro">
                  数据目录与解释器由主进程自动解析，不需要手动设置；重试仍失败时请重启应用。
                </p>
                <button
                  type="button"
                  onClick={() => void autoStart()}
                  className="mt-4 rounded-md bg-ink px-4 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
                >
                  重试
                </button>
              </>
            ) : (
              <>
                <h2 className="text-[15px] font-semibold">正在启动本机归档</h2>
                <p className="mt-2 text-[12px] leading-6 text-muted">
                  {autoNote ||
                    "信息中枢会在后台自动识别 QQ / 微信目录，并在归档为空时采集一次；全程只在本机运行，不需要任何设置。"}
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {ready && status && (
        <>
          <div className="flex gap-2 border-b border-line-soft px-6 py-2.5">
            <Stat label="归档会话" value={String(status.stats.conversations)} />
            <Stat label="消息" value={status.stats.messages.toLocaleString("zh-CN")} />
            <Stat label="日程" value={agenda ? String(agenda.summary.total) : "—"} />
            <Stat label="最后消息" value={lastMessageText || "—"} />
            <Stat label="归档大小" value={formatInfohubBytes(status.dbBytes)} />
          </div>

          <SourceSection detected={detected} autoNote={autoNote} />

          {syncOpen && (
            <div className="border-b border-line-soft bg-panel px-6 py-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 ui-caption">
                <span className="font-medium text-[var(--body)]">同步来源</span>
                <label
                  className="flex items-center gap-1.5"
                  title={
                    detected.qq.detected
                      ? undefined
                      : "未识别到 QQ 目录：启动时会自动扫描，也可在来源区展开路径确认"
                  }
                >
                  <input
                    type="checkbox"
                    checked={syncSources.qq}
                    disabled={syncing || !detected.qq.detected}
                    onChange={(e) => setSyncSources((s) => ({ ...s, qq: e.target.checked }))}
                  />
                  QQ
                </label>
                <label
                  className="flex items-center gap-1.5"
                  title={
                    detected.wechat.detected
                      ? undefined
                      : "未识别到微信目录：启动时会自动扫描，也可在来源区展开路径确认"
                  }
                >
                  <input
                    type="checkbox"
                    checked={syncSources.wechat}
                    disabled={syncing || !detected.wechat.detected}
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
                  className="ui-btn ui-btn-sm ui-btn-primary"
                >
                  {syncing ? "同步中…" : "开始同步"}
                </button>
                <button
                  type="button"
                  disabled={syncing || !automationsOn}
                  title={automationsOn ? undefined : "自动化模块已停用：到「插件区 → 模块」启用"}
                  onClick={scheduleSyncAutomation}
                  className="ui-btn ui-btn-sm ui-btn-ghost"
                >
                  保存为定时任务
                </button>
                <span className="ui-micro">同步会写入归档库；检索与日程始终只读。</span>
              </div>
              {syncing && (
                <div className="mt-2">
                  <div className="h-1 overflow-hidden rounded-full bg-[var(--line-soft)]">
                    <div
                      className="h-full rounded-full bg-ink transition-[width] duration-200"
                      style={{
                        width: progress?.total
                          ? `${Math.min(100, Math.round((progress.current / progress.total) * 100))}%`
                          : "30%",
                      }}
                    />
                  </div>
                  <div className="ui-micro mt-1">
                    {progress ? `${progress.stage} · ${progress.current}/${progress.total}` : "准备中…"}
                  </div>
                </div>
              )}
            </div>
          )}

          <div role="tablist" className="flex items-center gap-1 border-b border-line-soft px-6 py-2">
            {(
              [
                ["search", "检索"],
                ["chats", "会话"],
                ["agenda", "日程"],
              ] as [Tab, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                className={`ui-btn ui-btn-sm ${tab === value ? "ui-btn-primary" : "ui-btn-ghost text-muted"}`}
              >
                {label}
                {value === "agenda" && agenda?.summary.overdue ? (
                  <span className="ml-1 rounded-full bg-[var(--danger-soft)] px-1 ui-micro font-semibold text-[var(--danger)]">
                    {agenda.summary.overdue}
                  </span>
                ) : null}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2 ui-micro">
              {Object.entries(status.sources).map(([key, value]) => (
                <span key={key} title={value.detail || ""}>
                  {sourceLabel(key)} {value.status || "未同步"}
                  {value.lastRun ? ` · ${formatInfohubTime(value.lastRun)}` : ""}
                </span>
              ))}
            </div>
          </div>

          {!status.hasDb && (
            <div className="border-b border-line-soft bg-[var(--warn-soft)] px-6 py-2 ui-caption text-[var(--warn)]">
              该目录还没有归档库。先在「同步」里选择来源并开始采集；采集完成后这里会自动刷新。
            </div>
          )}

          {tab === "search" && (
            <div className="flex min-h-0 flex-1 flex-col">
              <form
                className="flex gap-2 border-b border-line-soft px-6 py-3"
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
                  className="min-w-0 flex-1 rounded-md border border-line-strong px-3 py-1.5 text-[12px] outline-hidden focus:border-ink"
                />
                <button
                  type="submit"
                  disabled={busy === "search"}
                  className="ui-btn ui-btn-sm ui-btn-primary"
                >
                  {busy === "search" ? "检索中…" : "检索"}
                </button>
              </form>
              <div className="min-h-0 flex-1 overflow-auto px-6 py-3">
                {hits.length === 0 ? (
                  <p className="text-[11px] text-muted">
                    {searchedFor ? `没有找到「${searchedFor}」` : "输入关键词后回车。检索只在本机归档内进行。"}
                  </p>
                ) : (
                  <>
                    <p className="ui-micro mb-2">
                      「{searchedFor}」命中 {hits.length} 条
                    </p>
                    <ul className="flex flex-col gap-1.5">
                      {hits.map((hit) => (
                        <li key={hit.id}>
                          <div className="ui-list-row rounded-lg bg-[var(--surface)]">
                            <div className="flex items-baseline gap-2 ui-micro">
                              <span className="font-medium text-[var(--body)]">{hit.convName}</span>
                              <span>{sourceLabel(hit.source)}</span>
                              <span className="ml-auto">{formatInfohubTime(hit.ts, true)}</span>
                            </div>
                            <div className="mt-1 ui-body-sm leading-5">
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

          {tab === "chats" && (
            <InfohubChats
              ready={ready}
              status={status}
              refreshToken={chatsRefreshToken}
              onError={setError}
            />
          )}

          {tab === "agenda" && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center gap-3 border-b border-line-soft px-6 py-2.5 ui-caption">
                <span className="text-muted">
                  未来 14 天 · 逾期 30 天
                  {agenda ? ` · 共 ${agenda.summary.total} 条` : ""}
                </span>
                {agenda && (
                  <span className="flex gap-2 ui-micro">
                    <span className="text-[var(--danger)]">逾期 {agenda.summary.overdue}</span>
                    <span>今天 {agenda.summary.today}</span>
                    <span>本周 {agenda.summary.week}</span>
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy === "rebuild"}
                    onClick={() => void rebuildAgenda()}
                    className="ui-btn ui-btn-sm ui-btn-ghost"
                  >
                    {busy === "rebuild" ? "重扫中…" : "重扫议程"}
                  </button>
                  <button
                    type="button"
                    aria-label="新建定时重扫"
                    disabled={!automationsOn}
                    title={automationsOn ? undefined : "自动化模块已停用：到「插件区 → 模块」启用"}
                    onClick={() => openAutomations({ kind: "infohub.agenda" })}
                    className="ui-btn ui-btn-sm ui-btn-ghost"
                  >
                    定时重扫
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-6 py-3">
                {!agenda || agenda.items.length === 0 ? (
                  <p className="ui-caption">
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
                          className="ui-list-row items-start gap-3 rounded-lg bg-[var(--surface)]"
                        >
                          <span
                            className={`mt-0.5 shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                              overdue ? "bg-[var(--danger-soft)] text-[var(--danger)]" : "bg-[var(--subtle-3)] text-[var(--body)]"
                            }`}
                          >
                            {item.dueText || (item.dueTs ? formatInfohubTime(item.dueTs) : "未定")}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate ui-body-sm font-medium text-ink">{item.title}</div>
                            {item.detail && (
                              <div className="mt-0.5 line-clamp-2 ui-caption leading-5 text-muted">{item.detail}</div>
                            )}
                            <div className="mt-0.5 ui-micro">
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

          <details className="shrink-0 border-t border-line-soft bg-panel px-6 py-2 ui-caption">
            <summary className="cursor-pointer text-[var(--body)]">本机配置（已脱敏）</summary>
            <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 ui-micro sm:grid-cols-4">
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
            <p className="mt-1.5 break-all ui-micro">配置：{status.configPath}</p>
            <p className="break-all ui-micro">归档：{status.dbPath}</p>
          </details>
        </>
      )}
    </PageShell>
  );
}
