/**
 * 信息中枢 · 桌面端 InfoHub 桥的渲染层客户端（d.45）。
 *
 * 归档数据**只在本机**：这里不碰网络，所有调用都经 preload → 主进程 → Python 子进程。
 * 浏览器端没有 `window.__heming_infohub`，页面据此显示「仅桌面端可用」，
 * 绝不回退到云端（归档是个人数据，上传即越界）。
 */

/** 会话行（与 InfoHub 归档库 conversations 表同口径）。 */
export interface InfohubConversation {
  id: number;
  source: "qq" | "wechat" | string;
  account: string;
  external_id: string;
  name: string;
  kind: string;
  avatar: string;
  last_ts: number;
  message_count?: number;
  meta: Record<string, unknown>;
}

/** 附件信息：路径不出桥，只回是否可用与尺寸。 */
export interface InfohubMedia {
  messageId: number;
  kind: string;
  name: string;
  width: number;
  height: number;
  size: number;
  hasPath: boolean;
}

export interface InfohubMessage {
  id: number;
  conversation_id: number;
  external_id: string;
  ts: number;
  sender_id: string;
  sender_name: string;
  is_self: boolean | null;
  type_code: number | null;
  type_label: string;
  content: string;
  imported_at: number;
  media: InfohubMedia | null;
}

export interface InfohubSearchHit {
  id: number;
  conversationId: number;
  ts: number;
  senderName: string;
  content: string;
  snippet: string;
  convName: string;
  source: string;
}

export interface InfohubAgendaItem {
  id: number;
  messageId: number;
  conversationId: number;
  title: string;
  detail: string;
  dueTs: number;
  dueText: string;
  allDay: boolean;
  kind: string;
  status: string;
  convName: string;
  source: string;
  senderName: string;
  msgTs: number;
}

export interface InfohubConfigSummary {
  dataDir: string;
  configPath: string;
  wechat: { enabled: boolean; dbDir: string };
  qq: { enabled: boolean; mode: string; ntAccount: string };
  voice: { enabled: boolean };
  kb: { vault: string; autoExport: boolean };
  digest: { enabled: boolean; intervalMin: number };
  agent: { enabled: boolean };
  push: { enabled: boolean; channel: string; hasCredentials: boolean };
  llm: { enabled: boolean; baseUrl: string; model: string; hasKey: boolean; allowRemote: boolean };
}

export interface InfohubStatus {
  home: string;
  configPath: string;
  configExists: boolean;
  dbPath: string;
  hasDb: boolean;
  config: InfohubConfigSummary;
  stats: { conversations: number; messages: number; per_source: Record<string, number> };
  sources: Record<string, { status: string; lastRun: number; detail: string }>;
  events: number;
  media: Record<string, number>;
  dbBytes: number;
  lastMessageTs?: number;
}

export interface InfohubProgressEvent {
  event: "progress";
  phase: string;
  stage: string;
  current: number;
  total: number;
}

export interface InfohubBridgeInfo {
  packageDir: string;
  defaultHome: string;
  bundledPython: string | null;
  running: boolean;
  pid: number | null;
  home: string | null;
  python: string | null;
  pythonSource: string | null;
  startedAt: number;
  methods: string[];
}

export interface InfohubConfig {
  home?: string;
  python?: string;
}

export interface InfohubConversationsResult {
  items: InfohubConversation[];
  total: number;
  dbMissing?: boolean;
}

export interface InfohubMessagesResult {
  conversation: InfohubConversation | null;
  items: InfohubMessage[];
  hasMore: boolean;
  dbMissing?: boolean;
}

export interface InfohubSearchResult {
  items: InfohubSearchHit[];
  query: string;
  dbMissing?: boolean;
}

export interface InfohubAgendaSummary {
  overdue: number;
  today: number;
  week: number;
  total: number;
}

export interface InfohubAgendaResult {
  items: InfohubAgendaItem[];
  summary: InfohubAgendaSummary;
  dbMissing?: boolean;
}

export interface InfohubSyncReport {
  source: string;
  conversations: number;
  added: number;
  updated: number;
  scannedFiles?: number;
  skipped: number;
  errors: string[];
  elapsed: number;
}

export interface InfohubSyncResult {
  reports: InfohubSyncReport[];
  agenda: unknown;
  kb: unknown;
}

/**
 * 采集桥运行态（d.96，规格 §6.1）：桌面主进程产出、渲染层只读消费。
 *
 * 字段名与 `infohub:bridge-status` 的返回形状**逐字一致**——改名字前先改桌面端产出方
 * 与 preload 的类型声明，否则渲染层会静默拿到 undefined 并把状态显示成「未运行」。
 */
export interface InfohubBridgeStatus {
  /** /health 探测通过。 */
  running: boolean;
  /** 正在拉起进程或等待健康检查。 */
  starting: boolean;
  /** running 时为 `http://127.0.0.1:8776/mcp`。 */
  url: string | null;
  port: number | null;
  /** 采集桥读取的归档目录（INFOHUB_HOME）。 */
  home: string | null;
  /** 实际使用的解释器；复用外部进程时为 null。 */
  python: string | null;
  pythonSource: "configured" | "bundled" | "missing" | "external" | "unknown";
  /** 端点由谁拉起：和鸣自己（app）/ 用户自己跑的进程（external）/ 都没起（none）。 */
  source: "app" | "external" | "none";
  /** 启动时间（epoch ms）。 */
  since: number | null;
  /** 失败原因（中文、可执行）；成功时为 null。 */
  error: string | null;
}

/** 启动采集桥的配置；缺省字段由主进程回落（已保存目录 / 内置运行时）。 */
export interface InfohubBridgeConfig {
  home?: string;
  python?: string;
}

/**
 * preload 追加在 `window.__heming_infohub` 上的采集桥方法（d.96）。
 *
 * 旧版桌面端没有这组方法：这里用 `Partial` 合并进既有桥类型，调用方经
 * `bridgeApi()` 显式判存并给出「请更新和鸣」的可读错误，而不是把 undefined 当函数调崩。
 */
export interface InfohubBridgeApi {
  bridgeStatus(): Promise<InfohubBridgeStatus>;
  bridgeStart(config?: InfohubBridgeConfig): Promise<InfohubBridgeStatus>;
  bridgeStop(): Promise<boolean>;
  onBridgeEvent(callback: (status: InfohubBridgeStatus) => void): () => void;
}

type InfohubBridge = NonNullable<Window["__heming_infohub"]> & Partial<InfohubBridgeApi>;

const HOME_KEY = "heming.infohub.home.v1";
const PYTHON_KEY = "heming.infohub.python.v1";

function storageOrNull(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readKey(storage: Storage | null, key: string): string {
  if (!storage) return "";
  try {
    return (storage.getItem(key) ?? "").trim();
  } catch {
    return "";
  }
}

/** 读取本机保存的数据目录/解释器；缺失或损坏都回空。 */
export function readInfohubConfig(storage: Storage | null = storageOrNull()): InfohubConfig {
  const home = readKey(storage, HOME_KEY);
  const python = readKey(storage, PYTHON_KEY);
  return {
    ...(home ? { home } : {}),
    ...(python ? { python } : {}),
  };
}

/** 保存用户选定的数据目录/解释器；存不下（隐私模式）时只在本次会话由调用方持有。 */
export function writeInfohubConfig(config: InfohubConfig, storage: Storage | null = storageOrNull()): void {
  if (!storage) return;
  try {
    if (config.home) storage.setItem(HOME_KEY, config.home);
    else storage.removeItem(HOME_KEY);
    if (config.python) storage.setItem(PYTHON_KEY, config.python);
    else storage.removeItem(PYTHON_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 桌面端桥是否存在。浏览器端恒为 false。 */
export function isInfohubAvailable(): boolean {
  return typeof window !== "undefined" && Boolean(window.__heming_infohub);
}

function bridge(): InfohubBridge {
  if (!isInfohubAvailable()) throw new Error("信息中枢仅桌面端可用");
  return window.__heming_infohub as InfohubBridge;
}

/**
 * 采集桥 IPC（d.96）：浏览器端仍是「仅桌面端可用」；
 * 旧版桌面端缺这组方法时回一句能照做的提示，而不是 TypeError。
 */
function bridgeApi(): InfohubBridge & InfohubBridgeApi {
  const api = bridge();
  if (typeof api.bridgeStatus !== "function") {
    throw new Error("当前桌面端不支持采集桥，请更新和鸣");
  }
  return api as InfohubBridge & InfohubBridgeApi;
}

/**
 * 清理 Electron IPC 包装出来的错误前缀：
 * `Error invoking remote method 'infohub:call': Error: 会话不存在` → `会话不存在`。
 */
export function describeInfohubError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
}

async function invoke<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new Error(describeInfohubError(err));
  }
}

export function infohubInfo(): Promise<InfohubBridgeInfo> {
  return invoke(() => bridge().info());
}

export function startInfohub(config: InfohubConfig = {}): Promise<InfohubBridgeInfo> {
  return invoke(() => bridge().start(config) as Promise<InfohubBridgeInfo>);
}

export function stopInfohub(): Promise<boolean> {
  return invoke(() => bridge().stop());
}

export function callInfohub<T>(
  method: string,
  params: Record<string, unknown> = {},
  config: InfohubConfig = {},
): Promise<T> {
  return invoke(() => bridge().call(method, params, config) as Promise<T>);
}

export async function pickInfohubHome(): Promise<string | null> {
  const picked = await invoke(() => bridge().pickHome());
  return typeof picked === "string" && picked ? picked : null;
}

export async function pickInfohubPython(): Promise<string | null> {
  const picked = await invoke(() => bridge().pickPython());
  return typeof picked === "string" && picked ? picked : null;
}

/** 订阅采集/导出进度。浏览器端返回空取消函数。 */
export function onInfohubEvent(callback: (event: InfohubProgressEvent) => void): () => void {
  if (!isInfohubAvailable() || typeof callback !== "function") return () => {};
  return window.__heming_infohub!.onEvent((event) => callback(event as InfohubProgressEvent));
}

/* ---------------------------------------------------------------- 采集桥（d.96） */

/** 采集桥健康检查地址：只回环，不暴露成可在配置里改成公网的地址。 */
export const INFOHUB_BRIDGE_HEALTH_URL = "http://127.0.0.1:8776/health";
/** 探测超时：回环连不上通常立刻失败，1.5s 足够覆盖 Python 冷启动的短暂无响应。 */
export const INFOHUB_BRIDGE_PROBE_TIMEOUT_MS = 1500;
/** /health 成功时的服务名（Python 采集桥写死这个名字，用来识别「8776 上跑的是不是我们」）。 */
export const INFOHUB_BRIDGE_SERVICE_NAME = "infohub-mcp";

export interface InfohubProbeResult {
  ok: boolean;
  name?: string;
  error?: string;
}

export interface InfohubProbeOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 读取采集桥运行态：只读，不探测、不拉起进程。 */
export function infohubBridgeStatus(): Promise<InfohubBridgeStatus> {
  return invoke(() => bridgeApi().bridgeStatus());
}

/** 用户显式启动采集桥：拉起随包 Python，或复用已在跑的外部端点。 */
export function startInfohubBridge(config: InfohubBridgeConfig = {}): Promise<InfohubBridgeStatus> {
  return invoke(() => bridgeApi().bridgeStart(config));
}

/** 停止和鸣自己拉起的采集桥；外部进程返回 false（不代用户杀进程）。 */
export function stopInfohubBridge(): Promise<boolean> {
  return invoke(() => bridgeApi().bridgeStop());
}

/** 订阅采集桥状态变化；浏览器端 / 旧版桌面端返回空取消函数。 */
export function onInfohubBridgeEvent(callback: (status: InfohubBridgeStatus) => void): () => void {
  if (!isInfohubAvailable() || typeof callback !== "function") return () => {};
  const api = window.__heming_infohub as InfohubBridge & Partial<InfohubBridgeApi>;
  if (typeof api.onBridgeEvent !== "function") return () => {};
  return api.onBridgeEvent((status) => callback(status));
}

/**
 * 探测本机采集桥的 `/health`（d.96）：浏览器端也能用，**不依赖 Electron**。
 *
 * 只回环、只读：GET 一个健康检查，不发请求体、不带凭据、不写任何东西。
 * 任何失败都收口成 `{ ok: false, error: <中文原因> }` 而不是抛异常——页面把
 * 「未检测到」当正常状态展示，不能因为探测失败把整页打崩。
 */
export async function probeInfohubBridge(
  url: string = INFOHUB_BRIDGE_HEALTH_URL,
  opts: InfohubProbeOptions = {},
): Promise<InfohubProbeResult> {
  const fetchImpl = opts.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
  if (!fetchImpl) return { ok: false, error: "当前环境不支持本机网络探测" };
  const timeoutMs =
    typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : INFOHUB_BRIDGE_PROBE_TIMEOUT_MS;

  // AbortController 让真实 fetch 在超时后立刻断开；注入的 fetchImpl 可能忽略 signal，
  // 所以超时同时用 Promise.race 兜住，两条路都能按时返回。
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller?.abort();
      resolve("timeout");
    }, timeoutMs);
  });

  try {
    const raced = await Promise.race([
      fetchImpl(url, { method: "GET", cache: "no-store", signal: controller?.signal ?? undefined }),
      timeout,
    ]);
    if (raced === "timeout") return { ok: false, error: `本机采集桥无响应（${timeoutMs}ms 超时）` };
    const response = raced as Response;
    if (!response.ok) return { ok: false, error: `本机采集桥返回 HTTP ${response.status}` };
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return { ok: false, error: "本机采集桥响应不是合法 JSON" };
    }
    const name = data && typeof data === "object" ? (data as { name?: unknown }).name : undefined;
    if (name !== INFOHUB_BRIDGE_SERVICE_NAME) {
      return { ok: false, error: "回环端口上的服务不是信息采集中枢（/health 名称不匹配）" };
    }
    return { ok: true, name: INFOHUB_BRIDGE_SERVICE_NAME };
  } catch {
    if (timedOut) return { ok: false, error: `本机采集桥无响应（${timeoutMs}ms 超时）` };
    return { ok: false, error: "无法连接本机采集桥（连接被拒绝或网络不可达）" };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** 时间戳（秒）→ 本机可读时间；0/非法值回空串。 */
export function formatInfohubTime(ts: number, withYear = false): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withYear ? `${d.getFullYear()}-${md} ${hm}` : `${md} ${hm}`;
}

/** 字节数 → 人读大小。 */
export function formatInfohubBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
