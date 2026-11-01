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

type InfohubBridge = NonNullable<Window["__heming_infohub"]>;

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
