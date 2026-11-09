/**
 * 凭据仓库：AES-256-GCM 加密后落盘，密钥文件与数据分离。
 *
 * 为什么不是「跟着工作流存明文」：HTTP 节点要带 token/密码，导出工作流时绝不能被带出去；
 * 明文落盘也会被本机其它程序/备份顺手读走。这里用一个本机生成的 32 字节密钥做
 * AES-256-GCM（带认证标签），密钥文件权限 0600，数据文件里只有密文。
 *
 * 边界：这是**本机文件级加密**，不是系统钥匙串（无 Electron safeStorage 可用）。
 * 密钥文件与数据在同一目录时，能读整个目录的人仍可解密——文档如实写明。
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export interface Vault {
  encrypt(plain: string): string;
  decrypt(payload: string): string;
}

interface Envelope {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

function isEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return raw.v === 1 && typeof raw.iv === "string" && typeof raw.tag === "string" && typeof raw.data === "string";
}

/** 读/建密钥文件（32 字节，hex 存储，0600）。 */
export function loadOrCreateKey(keyPath: string): Buffer {
  if (existsSync(keyPath)) {
    try {
      const buf = Buffer.from(readFileSync(keyPath, "utf8").trim(), "hex");
      if (buf.length === 32) return buf;
    } catch {
      /* 坏文件按重建处理（旧密文会解不开，调用方负责提示） */
    }
  }
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString("hex"), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    /* Windows 上 chmod 语义有限，失败不影响功能 */
  }
  return key;
}

export function createVault(keyPath: string): Vault {
  const key = loadOrCreateKey(keyPath);
  return {
    encrypt(plain: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      const envelope: Envelope = {
        v: 1,
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        data: data.toString("base64"),
      };
      return JSON.stringify(envelope);
    },
    decrypt(payload: string): string {
      const parsed = JSON.parse(payload) as unknown;
      if (!isEnvelope(parsed)) throw new Error("凭据密文格式不正确");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
      decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]);
      return plain.toString("utf8");
    },
  };
}

export interface CredentialFieldSpec {
  name: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
}

export interface CredentialTypeSpec {
  type: string;
  label: string;
  description: string;
  fields: CredentialFieldSpec[];
}

/** 支持的凭据类型（HTTP 节点鉴权用；与旧分支保持一致）。 */
export const CREDENTIAL_TYPES: readonly CredentialTypeSpec[] = [
  {
    type: "httpBasic",
    label: "HTTP 基本认证",
    description: "用户名 + 密码，放进 Authorization: Basic。",
    fields: [
      { name: "username", label: "用户名", secret: false, required: true },
      { name: "password", label: "密码", secret: true, required: true },
    ],
  },
  {
    type: "httpHeader",
    label: "请求头",
    description: "自定义请求头，例如 X-API-Key。",
    fields: [
      { name: "name", label: "请求头名", secret: false, required: true, placeholder: "X-API-Key" },
      { name: "value", label: "请求头值", secret: true, required: true },
    ],
  },
  {
    type: "httpQueryAuth",
    label: "查询参数",
    description: "把凭据拼进 URL 查询串，例如 ?api_key=…。",
    fields: [
      { name: "name", label: "参数名", secret: false, required: true, placeholder: "api_key" },
      { name: "value", label: "参数值", secret: true, required: true },
    ],
  },
  {
    type: "bearerToken",
    label: "Bearer Token",
    description: "放进 Authorization: Bearer <token>。",
    fields: [{ name: "token", label: "Token", secret: true, required: true }],
  },
];

export function findCredentialType(type: string): CredentialTypeSpec | undefined {
  return CREDENTIAL_TYPES.find((item) => item.type === type);
}

/**
 * 校验凭据数据：类型必须已知；字段必须符合该类型的白名单；未知字段直接拒绝
 * （宁可让用户改配置，也不静默丢掉他以为生效的字段）。
 */
export function validateCredentialData(
  type: string,
  data: Record<string, unknown>,
): { ok: true; data: Record<string, string> } | { ok: false; error: string } {
  const spec = findCredentialType(type);
  if (!spec) return { ok: false, error: `不支持的凭据类型：${type}` };
  const allowed = new Set(spec.fields.map((field) => field.name));
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) return { ok: false, error: `凭据字段 ${key} 不属于类型 ${spec.label}` };
  }
  const result: Record<string, string> = {};
  for (const field of spec.fields) {
    const value = data[field.name];
    if (typeof value !== "string") {
      if (field.required) return { ok: false, error: `缺少字段：${field.label}` };
      continue;
    }
    if (field.required && !value.trim()) return { ok: false, error: `字段不能为空：${field.label}` };
    if (value.length > 4096) return { ok: false, error: `字段过长：${field.label}` };
    result[field.name] = value;
  }
  return { ok: true, data: result };
}
