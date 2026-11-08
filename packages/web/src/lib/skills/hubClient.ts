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
  constructor(message: string) {
    super(message);
    this.name = "SkillHubError";
  }
}

export interface SkillHubClientDeps {
  fetchImpl?: typeof fetch;
  /** 测试注入；缺省 `API_BASE`（空串 = 同源相对路径）。 */
  baseUrl?: string;
}

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

async function requestJson(
  url: string,
  init: RequestInit,
  deps: SkillHubClientDeps,
  what: string,
): Promise<unknown> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (err) {
    throw new SkillHubError(`技能社区请求失败：${reasonOf(err)}`);
  }
  if (response.status === 401) {
    throw new SkillHubError("需要虾评 API Key：请先在「社区 Key」里粘贴，或用名字创建账号");
  }
  if (response.status === 503) {
    throw new SkillHubError("技能社区未启用：服务端没有开启该源，请稍后再试或联系管理员");
  }
  if (response.status === 404) {
    throw new SkillHubError(`${what}不存在或已下架`);
  }
  if (!response.ok) {
    throw new SkillHubError(`技能社区请求失败：HTTP ${response.status}`);
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
      headers: { ...JSON_HEADERS, "content-type": "application/json" },
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
