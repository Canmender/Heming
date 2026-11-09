/**
 * 凭据（本机）：HTTP 节点要用到的账号密码 / 请求头 / 查询参数 / Bearer Token。
 *
 * 两条硬规则：
 * 1. **元数据与值分开存**。元数据（名字/类型/时间）放在普通 localStorage 键
 *    `heming.workflows.credentials.v1`，值放**每个凭据一个**的键
 *    `heming.workflows.credentials.v1.value.<id>`，走 `lib/secureStorage.ts`：
 *    桌面端是系统安全存储加密的信封，浏览器端只能明文（那个 origin 没有系统
 *    安全存储，明说比假装加密更诚实）。分开存的原因：页面列表只渲染元数据，
 *    不需要为了显示「有哪些凭据」去解密每个值（纯异步桥下同步解密拿不到值）。
 * 2. **值不进日志、不进执行记录、不进导出**。导出工作流时只带凭据 id 引用，
 *    带走 JSON 的人拿不到 secret。
 */

import { create } from "zustand";
import { createDefaultStorage, readJson, writeJson } from "../memory/storage.js";
import type { StorageLike } from "../memory/types.js";
import {
  readSecureValueAsync,
  secureGetItem,
  secureRemoveItem,
  secureSetItem,
} from "../secureStorage.js";

/** 凭据元数据键（契约 §8）。 */
export const CREDENTIALS_KEY = "heming.workflows.credentials.v1";
/** 单个凭据值的键前缀（值走 secureStorage 信封）。 */
export const CREDENTIAL_VALUE_PREFIX = "heming.workflows.credentials.v1.value.";
/** 最多保存多少条凭据（契约 §8：30 条）。 */
export const MAX_CREDENTIALS = 30;
/** 凭据名字长度上限。 */
export const CREDENTIAL_NAME_MAX = 60;

/** 凭据类型：只做 HTTP 认证，够本版 HTTP 节点用。 */
export type WorkflowCredentialType =
  | "httpBasic"
  | "httpHeader"
  | "httpQueryAuth"
  | "bearerToken";

/** 凭据表单字段描述（UI 按它渲染，也用于保存时白名单过滤）。 */
export interface CredentialFieldDescription {
  name: string;
  displayName: string;
  /** password 走密码输入框（不显示明文） */
  type: "text" | "password";
  required?: boolean;
  placeholder?: string;
  description?: string;
}

export interface CredentialTypeDescription {
  type: WorkflowCredentialType;
  displayName: string;
  description: string;
  fields: CredentialFieldDescription[];
}

/** 四种凭据的参数定义（字段名是持久化契约的一部分，不要改名）。 */
export const CREDENTIAL_TYPES: readonly CredentialTypeDescription[] = [
  {
    type: "httpBasic",
    displayName: "HTTP 基本认证",
    description: "把用户名与密码放进 Authorization 头（Basic）。",
    fields: [
      { name: "username", displayName: "用户名", type: "text", required: true },
      { name: "password", displayName: "密码", type: "password", required: true },
    ],
  },
  {
    type: "httpHeader",
    displayName: "请求头认证",
    description: "自定义请求头，例如 X-API-Key。",
    fields: [
      {
        name: "headerName",
        displayName: "请求头名称",
        type: "text",
        required: true,
        placeholder: "X-API-Key",
      },
      { name: "headerValue", displayName: "请求头值", type: "password", required: true },
    ],
  },
  {
    type: "httpQueryAuth",
    displayName: "查询参数认证",
    description: "把密钥放进 URL 查询参数，例如 ?api_key=…。",
    fields: [
      {
        name: "paramName",
        displayName: "参数名",
        type: "text",
        required: true,
        placeholder: "api_key",
      },
      { name: "paramValue", displayName: "参数值", type: "password", required: true },
    ],
  },
  {
    type: "bearerToken",
    displayName: "Bearer Token",
    description: "把令牌放进 Authorization: Bearer 头。",
    fields: [{ name: "token", displayName: "令牌", type: "password", required: true }],
  },
] as const;

/** 按类型取字段定义；未知类型返回 undefined（导入旧数据/前端传错类型时用）。 */
export function getCredentialType(type: string): CredentialTypeDescription | undefined {
  return CREDENTIAL_TYPES.find((item) => item.type === type);
}

/** 凭据元数据（值不在这里）。 */
export interface WorkflowCredentialRecord {
  id: string;
  name: string;
  type: WorkflowCredentialType;
  createdAt: number;
  updatedAt: number;
}

/** 保存入参：`id` 缺省表示新建。 */
export interface SaveCredentialInput {
  id?: string;
  name: string;
  type: WorkflowCredentialType;
  /** 只取该类型字段定义里的键；其余键丢弃（防止把 UI 状态写进凭据）。 */
  data: Record<string, unknown>;
}

export type CredentialMutation =
  | { ok: true; id: string }
  | { ok: false; error: string };

let storage: StorageLike | null = null;

function getStorage(): StorageLike {
  return (storage ??= createDefaultStorage());
}

/** 测试注入点：传 null 恢复默认（jsdom 的 localStorage）。 */
export function setCredentialStorage(next: StorageLike | null): void {
  storage = next;
}

/** 某个凭据值的存储键。 */
export function credentialValueKey(id: string): string {
  return `${CREDENTIAL_VALUE_PREFIX}${id}`;
}

/**
 * 本次会话的明文兜底缓存。
 *
 * 为什么需要：`secureSetItem` 在纯异步桌面桥下是「后台加密、立即返回」，
 * 值可能还没落盘；如果用户刚保存就去跑 HTTP 节点，同步读会拿不到。缓存让
 * 「写完立刻用」在内存里一定成立，与 secureStorage 自己的 pendingPlain 语义一致。
 */
const memoryValues = new Map<string, string>();

/** 测试隔离：清空明文缓存（不动 localStorage）。 */
export function resetCredentialMemory(): void {
  memoryValues.clear();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCredentialType(value: unknown): value is WorkflowCredentialType {
  return (
    value === "httpBasic" ||
    value === "httpHeader" ||
    value === "httpQueryAuth" ||
    value === "bearerToken"
  );
}

function normalizeRecord(raw: unknown): WorkflowCredentialRecord | null {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!id || !name) return null;
  if (!isCredentialType(raw.type)) return null;
  const createdAt =
    typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
  const updatedAt =
    typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt;
  return {
    id,
    name: name.slice(0, CREDENTIAL_NAME_MAX),
    type: raw.type,
    createdAt,
    updatedAt,
  };
}

/** 读元数据列表：缺键/损坏回退空，坏条目逐条丢弃。 */
export function readCredentialRecords(
  storageLike: StorageLike = createDefaultStorage(),
): WorkflowCredentialRecord[] {
  const records = readJson(storageLike, CREDENTIALS_KEY, [] as WorkflowCredentialRecord[], (raw) => {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const list: WorkflowCredentialRecord[] = [];
    for (const item of raw) {
      const record = normalizeRecord(item);
      if (!record || seen.has(record.id)) continue;
      seen.add(record.id);
      list.push(record);
      if (list.length >= MAX_CREDENTIALS) break;
    }
    return list;
  });
  return [...records].sort((a, b) => b.updatedAt - a.updatedAt);
}

function persist(records: WorkflowCredentialRecord[]): void {
  // 与工作流仓库同口径：写失败静默（内存态继续可用）。
  writeJson(getStorage(), CREDENTIALS_KEY, records, 256 * 1024);
}

/** 按类型校验并过滤字段值；返回 null 表示校验不过（error 里带原因）。 */
function validateAndFilter(
  type: WorkflowCredentialType,
  data: Record<string, unknown>,
): { ok: true; values: Record<string, string> } | { ok: false; error: string } {
  const description = getCredentialType(type);
  if (!description) return { ok: false, error: "未知的凭据类型" };
  const values: Record<string, string> = {};
  for (const field of description.fields) {
    const raw = data[field.name];
    const value = typeof raw === "string" ? raw : "";
    if (field.required && !value.trim()) {
      return { ok: false, error: `请填写${field.displayName}` };
    }
    // 值允许包含空格（token 里可能有），但不能把 undefined 写成 "undefined"。
    if (value !== "") values[field.name] = value;
  }
  return { ok: true, values };
}

let seq = 0;

function newCredentialId(now: number): string {
  seq += 1;
  return `cred-${now.toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 新建或更新一条凭据：先写值（安全存储），再写元数据。 */
export function saveCredential(input: SaveCredentialInput, now: number = Date.now()): CredentialMutation {
  const name = String(input.name ?? "").trim().slice(0, CREDENTIAL_NAME_MAX);
  if (!name) return { ok: false, error: "请填写凭据名称" };
  if (!isCredentialType(input.type)) return { ok: false, error: "未知的凭据类型" };
  const filtered = validateAndFilter(input.type, input.data ?? {});
  if (!filtered.ok) return filtered;

  const current = readCredentialRecords(getStorage());
  const existing = input.id ? current.find((record) => record.id === input.id) : undefined;
  if (input.id && !existing) return { ok: false, error: "凭据不存在（可能已被删除）" };
  if (!existing && current.length >= MAX_CREDENTIALS) {
    return { ok: false, error: `最多保存 ${MAX_CREDENTIALS} 条凭据，请先删除不用的凭据` };
  }
  const duplicated = current.some((record) => record.name === name && record.id !== input.id);
  if (duplicated) return { ok: false, error: "已有同名凭据，请换一个名字" };

  const id = existing?.id ?? input.id ?? newCredentialId(now);
  const value = JSON.stringify(filtered.values);
  // 先写内存兜底：即使安全存储写盘失败，本次会话里刚保存的凭据也能立刻用。
  memoryValues.set(id, value);
  secureSetItem(credentialValueKey(id), value, getStorage());

  const record: WorkflowCredentialRecord = {
    id,
    name,
    type: input.type,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const records = [record, ...current.filter((item) => item.id !== id)];
  persist(records);
  return { ok: true, id };
}

/** 删除一条凭据：元数据与值一起删（值删失败也不影响元数据）。 */
export function removeCredential(id: string): boolean {
  const current = readCredentialRecords(getStorage());
  const next = current.filter((record) => record.id !== id);
  if (next.length === current.length) return false;
  persist(next);
  memoryValues.delete(id);
  try {
    secureRemoveItem(credentialValueKey(id), getStorage());
  } catch {
    /* 值删不掉只是留了个孤儿键，不影响「凭据已删除」 */
  }
  return true;
}

/** 按类型取凭据值；类型不匹配/凭据不存在返回 null（节点自己报可读的错）。 */
export async function getCredentialData(
  type: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  if (!id || !isCredentialType(type)) return null;
  const record = readCredentialRecords(getStorage()).find((item) => item.id === id);
  if (!record || record.type !== type) return null;

  const key = credentialValueKey(id);
  // 1. 本次会话写过的值（写后立即读）
  const fromMemory = memoryValues.get(id);
  if (fromMemory) return parseValues(type, fromMemory);
  // 2. 同步读（浏览器明文 / 桌面端缓存命中 / 旧同步桥）
  const sync = secureGetItem(key, getStorage());
  if (sync) {
    const parsed = parseValues(type, sync);
    if (parsed) return parsed;
  }
  // 3. 异步读（纯异步桌面桥：同步读拿不到，必须 await 一次解密）
  const asyncRead = await readSecureValueAsync(key, getStorage());
  if (asyncRead.kind === "plain") return parseValues(type, asyncRead.raw);
  if (asyncRead.kind === "envelope") return parseValues(type, asyncRead.value);
  return null;
}

function parseValues(type: string, text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const description = getCredentialType(type);
  if (!description) return null;
  const values: Record<string, unknown> = {};
  for (const field of description.fields) {
    const value = parsed[field.name];
    if (typeof value === "string") values[field.name] = value;
  }
  return values;
}

/** 按 id 取元数据（UI 展示「这个节点用的哪条凭据」）。 */
export function getCredentialRecord(id: string): WorkflowCredentialRecord | undefined {
  return readCredentialRecords(getStorage()).find((record) => record.id === id);
}

interface WorkflowCredentialsState {
  credentials: WorkflowCredentialRecord[];
  save: (input: SaveCredentialInput, now?: number) => CredentialMutation;
  remove: (id: string) => boolean;
  list: () => WorkflowCredentialRecord[];
  getData: (type: string, id: string) => Promise<Record<string, unknown> | null>;
}

export const useWorkflowCredentialsStore = create<WorkflowCredentialsState>((set, get) => ({
  credentials: readCredentialRecords(),

  save: (input, now) => {
    const result = saveCredential(input, now);
    if (result.ok) set({ credentials: readCredentialRecords(getStorage()) });
    return result;
  },

  remove: (id) => {
    const removed = removeCredential(id);
    if (removed) set({ credentials: readCredentialRecords(getStorage()) });
    return removed;
  },

  list: () => get().credentials,

  getData: (type, id) => getCredentialData(type, id),
}));
