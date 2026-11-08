import type { ZodType } from "zod";
import {
  SkillHubDetailSchema,
  SkillHubDownloadSchema,
  SkillHubPageSchema,
  SkillHubRegisterResultSchema,
  SkillHubStatusSchema,
  type SkillHubDetail,
  type SkillHubDownload,
  type SkillHubPage,
  type SkillHubRegisterResult,
  type SkillHubStatus,
} from "@heming/shared";
import { API_BASE } from "../api.js";

/**
 * 技能社区（虾评）客户端（d.109）。
 *
 * 服务端负责调上游 + 归一化，web 只认 `@heming/shared` 的 `SkillHub*` 形状：
 * - 五个读/写调用都走薄封装 + zod `safeParse`，坏形状转中文；
 * - 下载必须带用户自己的社区 Key（`x-skill-hub-key`），和鸣不代扣、不共享；
 * - 社区 Key 只落本机：优先 `window.__heming_secrets` 加密成 `{__hemingEnc:...}`，
 *   无桥时明文兜底并在 UI 注明（见 `readHubKeyState` / `saveHubKey`）。
 *
 * 边界：技能内容只有文本指令；本文件不执行、也不落盘随技能下发的代码。
 */

export class SkillHubError extends Error {
  /** 原始 HTTP 状态（网络/超时/取消为空）；调用方按状态做补救时用。 */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "SkillHubError";
    this.status = status;
  }
}

export interface SkillHubClientDeps {
  fetchImpl?: typeof fetch;
  /** 测试注入；缺省 `API_BASE`（空串 = 同源相对路径）。 */
  baseUrl?: string;
  /** 外部取消信号（批量更新「停止」用）；与内部超时信号合并。 */
  signal?: AbortSignal;
  /** 单请求超时（毫秒，默认 `SKILL_HUB_TIMEOUT_MS`）；≤0 关闭超时。 */
  timeoutMs?: number;
}

/** 单请求超时（d.113 P1-8）：社区是外部依赖，不能无限挂住 UI。 */
export const SKILL_HUB_TIMEOUT_MS = 15_000;

export type SkillHubSort = "downloads" | "stars" | "updated";

export interface FetchHubSkillsOptions extends SkillHubClientDeps {
  page?: number;
  limit?: number;
  search?: string;
  category?: string;
  sort?: SkillHubSort;
}

function baseUrlOf(deps: SkillHubClientDeps): string {
  return (deps.baseUrl ?? API_BASE).replace(/\/+$/, "");
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseShape<T>(schema: ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new SkillHubError(
      `技能社区返回的数据格式不对（${what}）：${parsed.error.issues[0]?.message ?? "未知原因"}`,
    );
  }
  return parsed.data;
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { name?: unknown }).name === "AbortError";
}

/** 组合「超时 + 外部取消」信号；容器不支持 `AbortSignal.any` 时退化为其中一个。 */
function combineSignals(signals: Array<AbortSignal | null | undefined>): AbortSignal | undefined {
  const list = signals.filter((item): item is AbortSignal => !!item);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  const anyFn = (AbortSignal as unknown as { any?: (items: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn(list);
  return list[0];
}

function timeoutSignal(ms: number): AbortSignal | null {
  if (!(ms > 0)) return null;
  try {
    const timeoutFn = (AbortSignal as unknown as { timeout?: (value: number) => AbortSignal }).timeout;
    if (typeof timeoutFn === "function") return timeoutFn(ms);
  } catch {
    /* 个别环境没有/禁用 AbortSignal.timeout：退化为不设超时 */
  }
  return null;
}

interface ServerFailure {
  message: string | null;
  retryAfter: number | null;
}

/**
 * 读非 2xx 的响应体：服务端约定 `{ error, retryAfter }`（中文）。
 * 读不出/不是 JSON/没有字段都按 null，由调用方回落通用文案。
 */
async function readServerFailure(response: Response): Promise<ServerFailure> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  let message: string | null = null;
  let retryAfter: number | null = null;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim()) message = record.error.trim();
    if (typeof record.retryAfter === "number" && Number.isFinite(record.retryAfter)) {
      retryAfter = record.retryAfter;
    } else if (typeof record.retryAfter === "string" && /^\d+$/.test(record.retryAfter.trim())) {
      retryAfter = Number(record.retryAfter.trim());
    }
  }
  if (retryAfter === null) {
    const header = Number(response.headers.get("retry-after"));
    if (Number.isFinite(header) && header >= 0) retryAfter = header;
  }
  return { message, retryAfter: retryAfter !== null && retryAfter >= 0 ? retryAfter : null };
}

async function requestJson(
  url: string,
  init: RequestInit,
  deps: SkillHubClientDeps,
  what: string,
): Promise<unknown> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  // 外部已取消：不再发请求（批量「停止」后不会再发新请求）。
  if (deps.signal?.aborted) throw new SkillHubError("请求已取消");
  const timeoutMs = deps.timeoutMs ?? SKILL_HUB_TIMEOUT_MS;
  const signal = combineSignals([timeoutSignal(timeoutMs), deps.signal]);
  let response: Response;
  try {
    response = await fetchImpl(url, signal ? { ...init, signal } : init);
  } catch (err) {
    if (deps.signal?.aborted) throw new SkillHubError("请求已取消");
    if (isAbortError(err)) {
      const duration =
        timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`;
      throw new SkillHubError(`技能社区请求超时（${duration}），请重试`);
    }
    throw new SkillHubError(`技能社区请求失败：${reasonOf(err)}`);
  }

  if (!response.ok) {
    const failure = await readServerFailure(response);
    const status = response.status;
    if (status === 401) {
      throw new SkillHubError(
        "需要虾评 API Key：请先在「社区 Key」里粘贴，或用名字创建账号",
        status,
      );
    }
    if (status === 503) {
      throw new SkillHubError(
        "技能社区未启用：服务端没有开启该源，请稍后再试或联系管理员",
        status,
      );
    }
    if (status === 404) {
      throw new SkillHubError(`${what}不存在或已下架`, status);
    }
    if (status === 429) {
      throw new SkillHubError(
        failure.retryAfter !== null
          ? `上游限流，请约 ${failure.retryAfter} 秒后重试`
          : "上游限流，请稍后重试",
        status,
      );
    }
    // 402/400/5xx：优先透出服务端中文 error（如「余额不足，请充值」），不再吞成 HTTP 状态码。
    throw new SkillHubError(
      failure.message ?? `技能社区请求失败：HTTP ${status}`,
      status,
    );
  }

  try {
    return await response.json();
  } catch (err) {
    throw new SkillHubError(`技能社区返回的数据不是合法 JSON：${reasonOf(err)}`);
  }
}

const JSON_HEADERS = { accept: "application/json" };

/** 社区状态：是否启用、来源信息、连通性、分类。 */
export async function fetchHubStatus(deps: SkillHubClientDeps = {}): Promise<SkillHubStatus> {
  const raw = await requestJson(
    `${baseUrlOf(deps)}/api/skill-hub`,
    { headers: JSON_HEADERS },
    deps,
    "技能社区状态",
  );
  return parseShape(SkillHubStatusSchema, raw, "状态");
}

/** 社区技能列表（分页/搜索/分类/排序）。 */
export async function fetchHubSkills(
  options: FetchHubSkillsOptions = {},
): Promise<SkillHubPage> {
  const params = new URLSearchParams();
  if (options.page !== undefined) params.set("page", String(options.page));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.search) params.set("search", options.search);
  if (options.category) params.set("category", options.category);
  if (options.sort) params.set("sort", options.sort);
  const search = params.toString();
  const raw = await requestJson(
    `${baseUrlOf(options)}/api/skill-hub/skills${search ? `?${search}` : ""}`,
    { headers: JSON_HEADERS },
    options,
    "技能列表",
  );
  return parseShape(SkillHubPageSchema, raw, "技能列表");
}

/** 社区技能详情（安全标记/报告、主页、版本数）。 */
export async function fetchHubDetail(
  id: string,
  deps: SkillHubClientDeps = {},
): Promise<SkillHubDetail> {
  const raw = await requestJson(
    `${baseUrlOf(deps)}/api/skill-hub/skills/${encodeURIComponent(id)}`,
    { headers: JSON_HEADERS },
    deps,
    "技能详情",
  );
  return parseShape(SkillHubDetailSchema, raw, "技能详情");
}

/** 下载技能包（服务端已解包成 SKILL.md 文本 + 文件清单）。 */
export async function downloadHubSkill(
  id: string,
  apiKey: string,
  deps: SkillHubClientDeps = {},
): Promise<SkillHubDownload> {
  if (!apiKey.trim()) {
    throw new SkillHubError("需要虾评 API Key：请先在「社区 Key」里粘贴，或用名字创建账号");
  }
  const raw = await requestJson(
    `${baseUrlOf(deps)}/api/skill-hub/skills/${encodeURIComponent(id)}/download`,
    { headers: { ...JSON_HEADERS, "x-skill-hub-key": apiKey.trim() } },
    deps,
    "技能下载",
  );
  return parseShape(SkillHubDownloadSchema, raw, "下载结果");
}

/** 一键注册（用户明确点击「用这个名字创建账号」才调用）。 */
export async function registerHubAccount(
  name: string,
  deps: SkillHubClientDeps = {},
): Promise<SkillHubRegisterResult> {
  const raw = await requestJson(
    `${baseUrlOf(deps)}/api/skill-hub/register`,
    {
      method: "POST",
      // 服务端要求 x-heming-client（防跨站/脚本批量建号；见 server skillHub.ts）。
      headers: { ...JSON_HEADERS, "content-type": "application/json", "x-heming-client": "1" },
      body: JSON.stringify({ name }),
    },
    deps,
    "注册结果",
  );
  return parseShape(SkillHubRegisterResultSchema, raw, "注册结果");
}

/* ─────────────────────── 社区 Key 的本机存储 ─────────────────────── */

/** 社区 Key 的本机键；值形如 `{__hemingEnc:"…"}`（加密）或 `{key:"…"}`（明文兜底）。 */
export const HUB_KEY_STORAGE_KEY = "heming.skillHub.key.v1";

interface KeyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const memoryKeyStorage = (() => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
})();

function keyStorage(): KeyStorage {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch {
    /* 隐私模式：退回内存（本次会话有效） */
  }
  return memoryKeyStorage;
}

type SecretBridge = NonNullable<Window["__heming_secrets"]>;

function secretBridge(): SecretBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return window.__heming_secrets;
}

/** Key 读取结果：`locked` = 本机有密文但当前环境解不开（无桥/密钥不可用）。 */
export type HubKeyState =
  | { kind: "missing" }
  | { kind: "plain"; key: string }
  | { kind: "encrypted"; key: string }
  | { kind: "locked" };

/** 读本机 Key：解密优先；坏数据按 missing 处理，不把脏值当 Key 发出去。 */
export async function readHubKeyState(storage: KeyStorage = keyStorage()): Promise<HubKeyState> {
  let raw: string | null = null;
  try {
    raw = storage.getItem(HUB_KEY_STORAGE_KEY);
  } catch {
    return { kind: "missing" };
  }
  if (!raw) return { kind: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 历史/手写值：整串就是明文 Key
    return raw.trim() ? { kind: "plain", key: raw.trim() } : { kind: "missing" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "missing" };
  const record = parsed as Record<string, unknown>;
  const cipher = typeof record.__hemingEnc === "string" ? record.__hemingEnc : "";
  if (cipher) {
    const bridge = secretBridge();
    if (!bridge) return { kind: "locked" };
    try {
      if (typeof bridge.decryptAsync === "function") {
        const plain = await bridge.decryptAsync(cipher);
        return plain ? { kind: "encrypted", key: plain } : { kind: "locked" };
      }
      if (typeof bridge.decrypt === "function") {
        const plain = bridge.decrypt(cipher);
        return plain ? { kind: "encrypted", key: plain } : { kind: "locked" };
      }
    } catch {
      return { kind: "locked" };
    }
    return { kind: "locked" };
  }
  const plain = typeof record.key === "string" ? record.key.trim() : "";
  return plain ? { kind: "plain", key: plain } : { kind: "missing" };
}

/**
 * 保存 Key：有 `__heming_secrets.encryptAsync`（且可用）就写密文信封，
 * 否则明文兜底并返回 `encrypted:false`（UI 必须注明）。
 */
export async function saveHubKey(
  key: string,
  storage: KeyStorage = keyStorage(),
): Promise<{ encrypted: boolean }> {
  const trimmed = key.trim();
  if (!trimmed) throw new SkillHubError("API Key 不能为空");
  const bridge = secretBridge();
  let cipher: string | null = null;
  if (bridge && typeof bridge.encryptAsync === "function") {
    try {
      const available =
        typeof bridge.availableAsync === "function" ? await bridge.availableAsync() : true;
      if (available) cipher = await bridge.encryptAsync(trimmed);
    } catch {
      cipher = null;
    }
  }
  if (cipher) {
    storage.setItem(HUB_KEY_STORAGE_KEY, JSON.stringify({ __hemingEnc: cipher }));
    return { encrypted: true };
  }
  storage.setItem(HUB_KEY_STORAGE_KEY, JSON.stringify({ key: trimmed }));
  return { encrypted: false };
}

/** 清除本机 Key（不调用上游，不影响已安装技能）。 */
export function clearHubKey(storage: KeyStorage = keyStorage()): void {
  try {
    storage.removeItem(HUB_KEY_STORAGE_KEY);
  } catch {
    /* 清不掉也不影响 UI 状态：下次读取仍会失败为 missing */
  }
}

/**
 * 外部链接白名单（d.110 · P1-4）：只放行 `http(s)` 且长度合理，其余一律 null。
 *
 * 为什么需要：社区详情/来源里的 `homepage` 来自上游，可能含 `javascript:` 或
 * `data:text/html,...`；React 19 不会拦 `<a href>` 的协议，直出等于可点击 XSS。
 * 只做协议白名单（不做域名白名单）：这里是「去社区看原文」的展示链接，
 * 目标域名本来就随源变化；真正的信任边界仍是「不执行、不自动带凭据」。
 */
export { safeExternalUrl } from "../safeUrl.js";
