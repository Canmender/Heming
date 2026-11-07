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
import { AUTO_COLLECT_INTERVAL_MS, useAutoCollectStore } from "../lib/infohub/autoCollect.js";
import { useInfohubStore } from "../lib/infohub/store.js";
import { useUiStore, type InfohubIntent } from "../store/ui.js";
import { isModuleEffective, useModuleStore } from "../lib/modules/store.js";
import { PageShell } from "./layout/PageShell.js";

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
          <mark key={index} className="rounded-sm bg-[#fff1a8] px-0.5 text-ink">
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        );
      })}
    </>
  );
}

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 8776;

/**
 * 「自动采集」（d.98）：插件「信息采集中枢」装上并启用后，由和鸣托管的后台增量采集。
 *
 * 页面**只读运行态、只投递用户动作**：30 分钟循环、安装即采、采集桥托管都在
 * `lib/infohub/autoCollect.ts`，这里不自己起定时器。`running` 时只禁用按钮，不做加载动画。
 * 浏览器端没有本机进程能力：如实说「不会自动采集，也不会拉起进程」，不给假按钮。
 */
function AutoCollectSection({ desktop }: { desktop: boolean }) {
  // 逐字段选择器订阅：任何一部分状态变化只重渲染用到它的地方，不整体订阅 store。
  const pluginActive = useAutoCollectStore((s) => s.pluginActive);
  const enabled = useAutoCollectStore((s) => s.enabled);
  const running = useAutoCollectStore((s) => s.running);
  const lastRunAt = useAutoCollectStore((s) => s.lastRunAt);
  const lastStatus = useAutoCollectStore((s) => s.lastStatus);
  const lastMessage = useAutoCollectStore((s) => s.lastMessage);
  const nextRunAt = useAutoCollectStore((s) => s.nextRunAt);
  const setEnabled = useAutoCollectStore((s) => s.setEnabled);
  const runNow = useAutoCollectStore((s) => s.runNow);
  const setPage = useUiStore((s) => s.setPage);

  if (!desktop) {
    return (
      <div className="mt-2 border-t border-line-soft pt-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="ui-body-sm font-medium text-ink">自动采集</span>
          <span className="ui-caption">浏览器版不会自动采集，也不会拉起进程。</span>
        </div>
      </div>
    );
  }

  const intervalMinutes = Math.round(AUTO_COLLECT_INTERVAL_MS / 60_000);
  const lastText = lastRunAt ? formatInfohubTime(lastRunAt / 1000, true) : "还没有采集过";
  // 下次预计只在「开着」时才有意义：关掉后 store 会清 nextRunAt，这里再兜一层。
  const nextText = enabled && nextRunAt ? formatInfohubTime(nextRunAt / 1000) : "";
  const statusText = running ? "正在采集…" : !pluginActive ? "插件未启用" : enabled ? "已开启" : "已关闭";
  const failure = lastStatus === "error" ? lastMessage : "";
  // 插件没装/停用时没有可采的端点：按钮禁用，把「去装插件」摆在眼前。
  const actionsDisabled = running || !pluginActive;

  return (
    <div className="mt-2 border-t border-line-soft pt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="ui-body-sm font-medium text-ink">自动采集</span>
        <span role="status" className="ui-body-sm text-ink">
          {statusText}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={actionsDisabled}
            onClick={() => setEnabled(!enabled)}
            className="ui-btn ui-btn-sm ui-btn-ghost"
          >
            {enabled ? "关闭自动采集" : "开启自动采集"}
          </button>
          <button
            type="button"
            disabled={actionsDisabled}
            onClick={() => void runNow("manual")}
            className="ui-btn ui-btn-sm ui-btn-primary"
          >
            立即采集一次
          </button>
        </div>
      </div>
      <p className="ui-micro mt-1">
        上次采集：{lastText}
        {nextText ? ` · 下次预计：${nextText}` : ""}
      </p>
      {failure && <p className="ui-caption mt-1 text-[#b42318]">上次采集失败：{failure}</p>}
      {!pluginActive && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="ui-caption">
            安装并启用「信息采集中枢」插件后，会自动开始采集（每 {intervalMinutes} 分钟增量一次，可在这一步关闭）。
          </span>
          <button
            type="button"
            title="到插件区安装 / 启用「信息采集中枢」"
            onClick={() => setPage("plugins")}
            className="ui-btn ui-btn-sm ui-btn-ghost"
          >
            去插件区安装
          </button>
        </div>
      )}
      <p className="ui-micro mt-1">
        仅桌面端 · 只采本机 · 每 {intervalMinutes} 分钟增量一次 · 可在这一步关闭
      </p>
    </div>
  );
}

/**
 * 「采集桥」区块（d.97，规格 §8）：本机 MCP 端点的状态与启停。
 *
 * 两条路能力不同，也都不阻塞归档那条路：
 * - 桌面端：读 IPC 状态、用户点按钮才启动/停止；外部进程只提示「去它自己的窗口关」；
 * - 浏览器端：只能 `GET /health` 探测，拉不起进程——如实说明，不假装可用。
 * - d.98 起自动采集（见 `AutoCollectSection`）会在插件启用后托管采集与采集桥，
 *   但采集桥的**进程启停入口**仍只在这里，自动采集可随时关掉。
 */
function CollectBridgeSection({ desktop, layout }: { desktop: boolean; layout: "card" | "strip" }) {
  const bridgeStatus = useInfohubStore((s) => s.bridgeStatus);
  const bridgeBusy = useInfohubStore((s) => s.bridgeBusy);
  const bridgeError = useInfohubStore((s) => s.bridgeError);
  const bridgeProbe = useInfohubStore((s) => s.bridgeProbe);
  const startBridge = useInfohubStore((s) => s.startBridge);
  const stopBridge = useInfohubStore((s) => s.stopBridge);
  const probeBridge = useInfohubStore((s) => s.probeBridge);
  const setPage = useUiStore((s) => s.setPage);

  const running = bridgeStatus?.running === true;
  const starting = bridgeBusy === "start" || bridgeStatus?.starting === true;
  const external = bridgeStatus?.source === "external";
  // 本次操作错误优先于主进程状态里的旧错误：用户刚点「启动」失败时，原因就在眼前。
  const failure = bridgeError || bridgeStatus?.error || "";
  const port = bridgeStatus?.port ?? BRIDGE_PORT;

  const desktopStatus = starting
    ? "启动中…"
    : running
      ? external
        ? "运行中 · 外部进程"
        : `运行中 · ${BRIDGE_HOST}:${port} · 由和鸣托管`
      : failure
        ? `失败：${failure}`
        : "未运行";

  const probeText =
    bridgeBusy === "probe"
      ? "检测中…"
      : bridgeProbe?.ok
        ? "检测到本机采集桥"
        : bridgeProbe
          ? "未检测到本机采集桥"
          : "尚未检测";

  const dotClass = (desktop ? running : bridgeProbe?.ok === true)
    ? "bg-[#1f9d55]"
    : desktop && failure
      ? "bg-[#b42318]"
      : starting || bridgeBusy === "probe"
        ? "bg-[#d99a2b]"
        : "bg-[#bbb]";

  const body = (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="ui-section-title">采集桥</span>
        <span className="flex items-center gap-1.5">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden />
          <span role="status" className="ui-body-sm text-ink">
            {desktop ? desktopStatus : probeText}
          </span>
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {desktop ? (
            running ? (
              external ? (
                <span className="ui-micro">请在你启动它的窗口里关闭</span>
              ) : (
                <button
                  type="button"
                  disabled={bridgeBusy === "stop"}
                  onClick={() => void stopBridge()}
                  className="ui-btn ui-btn-sm ui-btn-ghost"
                >
                  停止
                </button>
              )
            ) : (
              <button
                type="button"
                disabled={starting}
                onClick={() => void startBridge(readInfohubConfig())}
                className="ui-btn ui-btn-sm ui-btn-primary"
              >
                启动采集桥
              </button>
            )
          ) : (
            <button
              type="button"
              disabled={bridgeBusy === "probe"}
              onClick={() => void probeBridge()}
              className="ui-btn ui-btn-sm ui-btn-ghost"
            >
              重新检测
            </button>
          )}
          <button
            type="button"
            title="到插件区安装 / 查看「信息采集中枢」"
            onClick={() => setPage("plugins")}
            className="ui-btn ui-btn-sm ui-btn-ghost"
          >
            去插件区
          </button>
        </div>
      </div>
      <p className="ui-micro mt-1">只监听本机回环 · 自动采集由和鸣托管 · 写操作仍走人工确认 · 归档不出本机</p>
      {!desktop && (
        <p className="ui-caption mt-1">
          浏览器版不能拉起进程，请在和鸣桌面端启动。
          {bridgeProbe && !bridgeProbe.ok ? `（${bridgeProbe.error}）` : ""}
        </p>
      )}
      {/* d.98：自动采集一段就长在采集桥区块里——同一件事的两种入口（自动 / 手动）。 */}
      <AutoCollectSection desktop={desktop} />
    </>
  );

  if (layout === "card") return <div className="ui-card p-4">{body}</div>;
  return <div className="shrink-0 border-b border-line-soft bg-panel px-6 py-2.5">{body}</div>;
}

/**
 * 信息中枢（d.45）：把 InfoHub 的本机 QQ/微信归档接进和鸣。
 *
 * 红线：
 * - 只读：归档以 `mode=ro` 打开，检索与重扫不会写库；
 * - 数据不出本机：不调用任何云端接口，浏览器环境直接显示「仅桌面端可用」；
 * - 自动采集由插件驱动（d.98）：装并启用「信息采集中枢」后由和鸣托管（每 30 分钟增量一次、
 *   可在本页关掉）；但归档边车仍由用户点「连接」拉起，页面不会自行起进程。
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
  // d.70：自动化模块停用时，「定时 / 保存为定时任务 / 定时重扫」不把人送到一个不存在的页
  const automationsOn = useModuleStore((s) => isModuleEffective(s, "automations"));
  // d.98：自动采集（App 层）拉起边车后，页面要能自动挂上——订阅共享运行态，而不是只信挂载那一刻的快照。
  const sharedRunning = useInfohubStore((s) => s.running);
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
          // 必须带上解释器：少传 python 会让主进程把它当成「另一个目标」重开边车，
          // 在没有内置运行时的机器上会直接报「未找到可用的 Python 解释器」（d.98 真机自检抓到）。
          const config: InfohubConfig = {
            ...(bridgeInfo.home ? { home: bridgeInfo.home } : {}),
            ...(bridgeInfo.python ? { python: bridgeInfo.python } : {}),
          };
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

  // d.98：自动采集可能在本页挂载后才拉起边车（安装插件即采 / 打开和鸣补采）。
  // 共享 store 一旦 running，页面直接挂上，不再要求用户点「连接」——否则会出现
  // 「自动采集正在采、归档却显示未连接」的自相矛盾。只在 idle 时接管，不抢用户的连接流程。
  useEffect(() => {
    if (!available || phase !== "idle" || !sharedRunning) return;
    void connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, phase, sharedRunning]);

  // 采集/导出进度：主进程广播，页面只展示最近一条（Python 侧已按 0.1s 节流）。
  useEffect(() => {
    if (!available) return;
    return onInfohubEvent((event) => {
      if (event && event.event === "progress") setProgress(event);    });
  }, [available]);

  // 采集桥（d.97）：桌面端读 IPC 状态并订阅事件；浏览器端只探测本机回环。
  // 这里**不启动任何进程**——启动只由用户点「启动采集桥」触发（d.45/d.47 红线）。
  // 订阅挂在 store 上（单例），组件卸载不退订，切页回来仍能收到状态变化。
  useEffect(() => {
    if (!available) {
      void useInfohubStore.getState().probeBridge();
      return;
    }
    void useInfohubStore.getState().refreshBridge();
  }, [available]);

  // 自动采集（d.98）：页面只读运行态。安装即采、30 分钟循环与插件事件监听由 App 层
  // 的 useAutoCollect 托管；这里 refresh 一次把「插件是否启用 / 上次结果」同步进来。
  useEffect(() => {
    void useAutoCollectStore.getState().refresh();
  }, []);

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
    // 与其他页保持同一套页面骨架：有页头、有说明，用户不会落到一个「只有一张卡片」的空页面。
    return (
      <PageShell
        title="信息中枢"
        subtitle="QQ / 微信归档只在本机处理；浏览器里读不到本机数据。"
        // d.72：这个分支只有一张说明卡，滚动容器里 flex-1 撑不开高度、items-center 失效，
        // 卡片会贴在顶部。改为 PageShell 不接管滚动，让说明卡在整页垂直居中。
        scroll={false}
      >
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto p-6">
          <div className="w-full max-w-[460px] rounded-xl border border-line bg-white p-6 shadow-card">
            <h2 className="text-[16px] font-semibold">信息中枢仅桌面端可用</h2>
            <p className="mt-2 text-[12px] leading-6 text-muted">
              QQ / 微信归档要读取本机数据库，需要由桌面版启动本机进程。
              和鸣不会把归档上传到云端，所以浏览器里没有可用的数据源。
            </p>
            <p className="mt-2 ui-caption">
              在桌面版安装包里打开「信息中枢」，即可连接本机归档并检索。
            </p>
          </div>
          {/* d.97：采集桥是「本机 MCP 端点」，与归档桥两条路；浏览器只能探测、不能拉起。 */}
          <div className="w-full max-w-[460px]">
            <CollectBridgeSection desktop={false} layout="card" />
          </div>
        </div>
      </PageShell>
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
    <PageShell
      title={
        <span className="flex items-center gap-2">
          信息中枢
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              ready ? "bg-[#1f9d55]" : phase === "error" ? "bg-[#b42318]" : "bg-[#bbb]"
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
              <button
                type="button"
                onClick={() => void disconnect()}
                className="ui-btn ui-btn-sm ui-btn-ghost text-[#666]"
              >
                断开
              </button>
            </>
          )}
        </>
      }
    >
      {error && (
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

      {/* 未连接：数据目录与解释器设置。默认目录来自主进程，可浏览选择已有 InfoHub 目录。 */}
      {!ready && (
        <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
          <div className="mx-auto max-w-[620px] rounded-xl border border-line bg-white p-5 shadow-card">
            <h2 className="ui-section-title">连接本机归档</h2>
            <p className="mt-1 text-[12px] leading-6 text-muted">
              指向已有的 InfoHub 数据目录（里面有 <code className="rounded-sm bg-[#f4f4f4] px-1">config.json</code> 和{" "}
              <code className="rounded-sm bg-[#f4f4f4] px-1">data/archive.db</code>）。
              首次使用也可以直接用默认目录，同步后自动建库。
            </p>

            <label className="ui-caption mt-4 block font-medium text-[#555]" htmlFor="infohub-home">
              数据目录
            </label>
            <div className="mt-1 flex gap-1.5">
              <input
                id="infohub-home"
                value={home}
                onChange={(e) => setHome(e.target.value)}
                placeholder={info?.defaultHome ?? "例如 D:\\wohaolei"}
                className="ui-input min-w-0 flex-1"
              />
              <button
                type="button"
                onClick={() => void chooseHome()}
                className="ui-btn ui-btn-sm ui-btn-ghost shrink-0"
              >
                浏览…
              </button>
            </div>
            {info?.defaultHome && home !== info.defaultHome && (
              <button
                type="button"
                onClick={() => setHome(info.defaultHome)}
                className="ui-micro underline-offset-2 hover:underline"
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
                <label className="ui-caption block font-medium text-[#555]" htmlFor="infohub-python">
                  Python 解释器
                </label>
                <div className="mt-1 flex gap-1.5">
                  <input
                    id="infohub-python"
                    value={python}
                    onChange={(e) => setPython(e.target.value)}
                    placeholder={info?.bundledPython ?? "内置运行时不可用，请选择 python.exe"}
                    className="ui-input min-w-0 flex-1"
                  />
                  <button
                    type="button"
                    onClick={() => void choosePython()}
                    className="ui-btn ui-btn-sm ui-btn-ghost shrink-0"
                  >
                    浏览…
                  </button>
                </div>
                <p className="ui-micro mt-1">
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
                <span className="ui-micro">内置运行时可用</span>
              ) : (
                <span className="text-[10px] text-[#b42318]">未找到内置运行时</span>
              )}
            </div>
          </div>
          {/* 采集桥（规格 §8）：连接区之后、检索区之前；未启动时不影响归档连接。 */}
          <div className="mx-auto mt-4 max-w-[620px]">
            <CollectBridgeSection desktop layout="card" />
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

          {syncOpen && (
            <div className="border-b border-line-soft bg-panel px-6 py-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 ui-caption">
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
                  <div className="ui-micro mt-1">
                    {progress ? `${progress.stage} · ${progress.current}/${progress.total}` : "准备中…"}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 采集桥（规格 §8）：有连接态时以一条紧凑带呈现，不挤占检索/日程的纵向空间。 */}
          <CollectBridgeSection desktop layout="strip" />

          <div role="tablist" className="flex items-center gap-1 border-b border-line-soft px-6 py-2">
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
                className={`ui-btn ui-btn-sm ${tab === value ? "ui-btn-primary" : "ui-btn-ghost text-[#666]"}`}
              >
                {label}
                {value === "agenda" && agenda?.summary.overdue ? (
                  <span className="ml-1 rounded-full bg-[#fdecea] px-1 ui-micro font-semibold text-[#b42318]">
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
            <div className="border-b border-line-soft bg-[#fffdf5] px-6 py-2 ui-caption text-[#8a6d3b]">
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
                          <div className="ui-list-row rounded-lg bg-white">
                            <div className="flex items-baseline gap-2 ui-micro">
                              <span className="font-medium text-[#555]">{hit.convName}</span>
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

          {tab === "agenda" && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center gap-3 border-b border-line-soft px-6 py-2.5 ui-caption">
                <span className="text-muted">
                  未来 14 天 · 逾期 30 天
                  {agenda ? ` · 共 ${agenda.summary.total} 条` : ""}
                </span>
                {agenda && (
                  <span className="flex gap-2 ui-micro">
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
                          className="ui-list-row items-start gap-3 rounded-lg bg-white"
                        >
                          <span
                            className={`mt-0.5 shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                              overdue ? "bg-[#fdecea] text-[#b42318]" : "bg-[#f2f2f2] text-[#555]"
                            }`}
                          >
                            {item.dueText || (item.dueTs ? formatInfohubTime(item.dueTs) : "未定")}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate ui-body-sm font-medium text-ink">{item.title}</div>
                            {item.detail && (
                              <div className="mt-0.5 line-clamp-2 ui-caption leading-5 text-[#666]">{item.detail}</div>
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
            <summary className="cursor-pointer text-[#555]">本机配置（已脱敏）</summary>
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
