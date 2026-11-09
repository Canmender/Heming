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
  /** 是否允许自动识别信息目录（Python 侧 config.auto_detect）。 */
  autoDetect?: boolean;
  /** 首次连接时是否自动采集一次（Python 侧 config.auto_sync_on_start）。 */
  autoSyncOnStart?: boolean;
  wechat: { enabled: boolean; dbDir: string; detected?: boolean };
  qq: {
    enabled: boolean;
    mode: string;
    ntAccount: string;
    /** QQNT 消息库路径（本机路径，只在桌面端展示）。 */
    ntDb?: string;
    /** QQ 导出目录（QCE 模式）。 */
    exportDir?: string;
    /** QQNT 或导出目录任一被识别到。 */
    detected?: boolean;
    /** 导出目录本身是否被识别到。 */
    exportDetected?: boolean;
  };
  voice: { enabled: boolean };
  kb: { vault: string; autoExport: boolean };
  digest: { enabled: boolean; intervalMin: number };
  agent: { enabled: boolean };
  push: { enabled: boolean; channel: string; hasCredentials: boolean };
  llm: { enabled: boolean; baseUrl: string; model: string; hasKey: boolean; allowRemote: boolean };
}

/** Python `config.detect` 的原始返回（snake_case，与 config.py 同口径）。 */
export interface InfohubDetectedSources {
  wechat: { db_dir: string; detected: boolean };
  qq: {
    nt_db: string;
    nt_account: string;
    export_dir: string;
    export_detected?: boolean;
    detected: boolean;
  };
}

export interface InfohubDetectResult {
  /** 是否有空配置项被检测结果填上并写回 config.json。 */
  applied: boolean;
  sources: InfohubDetectedSources;
  summary: InfohubConfigSummary;
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
  /** 引擎自带的依赖目录（模块包 files/lib）；源码模式下为空。 */
  libraryDir?: string;
  defaultHome: string;
  bundledPython: string | null;
  running: boolean;
  pid: number | null;
  home: string | null;
  python: string | null;
  pythonSource: string | null;
  startedAt: number;
  methods: string[];
  /** 选装引擎是否已装到本机模块目录。 */
  engineInstalled?: boolean;
}

/** 选装引擎（模块包）状态。 */
export interface InfohubEngineInfo {
  id: string;
  expectedVersion: string;
  installed: boolean;
  version: string;
  /** 模块源（更新源地址；调试时可指向本地目录）。 */
  base: string;
  /** 本次调用是否真的装了新版本。 */
  updated?: boolean;
}

/** 引擎下载/安装进度（主进程广播）。 */
export interface InfohubEngineProgress {
  stage: "download" | "install" | "done" | string;
  version: string;
  received: number;
  total: number;
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

type InfohubBridge = NonNullable<Window["__heming_infohub"]>;

const HOME_KEY = "heming.infohub.home.v1";
const PYTHON_KEY = "heming.infohub.python.v1";
const AUTO_COLLECT_KEY = "heming.infohub.autocollect.v1";

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

/**
 * 「首次连接时自动识别并采集」开关。
 * 优先 localStorage（用户显式改过）；没改过返回 null，由调用方回落到
 * config.json 的 auto_sync_on_start（默认开）。
 */
export function readAutoCollectPreference(storage: Storage | null = storageOrNull()): boolean | null {
  const raw = readKey(storage, AUTO_COLLECT_KEY);
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

export function writeAutoCollectPreference(
  value: boolean | null,
  storage: Storage | null = storageOrNull(),
): void {
  if (!storage) return;
  try {
    if (value === null) storage.removeItem(AUTO_COLLECT_KEY);
    else storage.setItem(AUTO_COLLECT_KEY, value ? "1" : "0");
  } catch {
    /* 忽略 */
  }
}

/** 让 Python 自动识别 QQ / 微信信息目录（不采集；采集仍走 `sync`）。 */
export function detectInfohubSources(config: InfohubConfig = {}): Promise<InfohubDetectResult> {
  return callInfohub<InfohubDetectResult>("config.detect", {}, config);
}

/** 从 status/config.summary 还原检测结果，供 UI 统一展示。 */
export function detectedSourcesFromSummary(
  summary: InfohubConfigSummary | null | undefined,
): InfohubDetectedSources {
  const wechatDir = summary?.wechat?.dbDir ?? "";
  const ntDb = summary?.qq?.ntDb ?? "";
  const exportDir = summary?.qq?.exportDir ?? "";
  return {
    wechat: { db_dir: wechatDir, detected: Boolean(summary?.wechat?.detected && wechatDir) },
    qq: {
      nt_db: ntDb,
      nt_account: summary?.qq?.ntAccount ?? "",
      export_dir: exportDir,
      export_detected: Boolean(summary?.qq?.exportDetected && exportDir),
      detected: Boolean(summary?.qq?.detected && (ntDb || exportDir)),
    },
  };
}

/** 已识别到目录的来源；可用于自动采集与默认勾选。 */
export function detectedSyncSources(sources: InfohubDetectedSources | null | undefined): Array<
  "qq" | "wechat"
> {
  const out: Array<"qq" | "wechat"> = [];
  if (sources?.qq?.detected) out.push("qq");
  if (sources?.wechat?.detected) out.push("wechat");
  return out;
}

function bridge(): InfohubBridge {
  if (!isInfohubAvailable()) throw new Error("信息中枢仅桌面端可用");
  return window.__heming_infohub as InfohubBridge;
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

/** 引擎模块状态：是否已装、期望版本、模块源。 */
export function infohubEngineInfo(): Promise<InfohubEngineInfo> {
  return invoke(() => engineBridge().engineInfo());
}

/**
 * 确保引擎已装：缺则下载官签名模块包并安装，已装则直接返回。
 * 引擎是选装模块，第一次启用信息中枢时才会联网下载，安装包里不携带。
 */
export function ensureInfohubEngine(version?: string): Promise<InfohubEngineInfo> {
  return invoke(() => engineBridge().ensureEngine(version) as Promise<InfohubEngineInfo>);
}

/** 宿主是否带选装引擎通道（旧版桌面端没有，按未安装处理）。 */
export function supportsInfohubEngine(): boolean {
  if (!isInfohubAvailable()) return false;
  const host = window.__heming_infohub!;
  return typeof host.engineInfo === "function" && typeof host.ensureEngine === "function";
}

function engineBridge(): Required<Pick<InfohubBridge, "engineInfo" | "ensureEngine">> {
  const host = bridge();
  if (typeof host.engineInfo !== "function" || typeof host.ensureEngine !== "function") {
    throw new Error("当前桌面端不支持选装模块，请更新应用");
  }
  return host as Required<Pick<InfohubBridge, "engineInfo" | "ensureEngine">>;
}

/** 订阅引擎下载/安装进度。浏览器端返回空取消函数。 */
export function onInfohubEngineEvent(
  callback: (event: InfohubEngineProgress) => void,
): () => void {
  if (!isInfohubAvailable() || typeof callback !== "function") return () => {};
  const host = window.__heming_infohub!;
  if (typeof host.onEngine !== "function") return () => {};
  return host.onEngine((event) => callback(event as InfohubEngineProgress));
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
