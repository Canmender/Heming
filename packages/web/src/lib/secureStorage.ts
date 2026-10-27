/**
 * 本机密钥信封（d.36 · P0-5）。
 *
 * 桌面端把三把钥匙（模型 Key、MCP 请求头、E2E 设备身份）改成**就地信封**：
 * 密文仍写原键位，只是值变成 `{"__hemingEnc":"v1","data":"<base64>"}`；
 * 加解密在主进程 `safeStorage` 里完成，渲染层只经 preload 的同步桥传字节。
 *
 * 为什么是同步桥：三个键都是「启动时读一次、用户改配置时写一次」，
 * 不在消息收发热路径上。**谁把这层用到高频路径，谁就得先改成批量/异步**——
 * sendSync 会阻塞渲染进程。
 *
 * 浏览器端（无桥）保持今天的明文形态：那个 origin 没有系统安全存储可用，
 * 明说比假装加密更诚实。
 */
import type { StorageLike } from "./memory/types.js";

export const ENVELOPE_MARK = "__hemingEnc";
export const ENVELOPE_VERSION = "v1";

export interface SecretBridge {
  available: boolean;
  encrypt(plain: string): string | null;
  decrypt(cipherB64: string): string | null;
}

export interface SecureStorageStatus {
  /** 是否存在桌面桥（桌面端恒 true；浏览器 false）。 */
  desktop: boolean;
  /** 桌面桥是否报告系统安全存储可用。 */
  available: boolean;
  /** 加密失败或不可用而落成明文的键（降级是可见的，不是静默的）。 */
  plaintextKeys: string[];
  /** 解不开的信封键：密文仍在磁盘，只是本机解不了（另一台设备/另一个系统账户）。 */
  undecryptableKeys: string[];
}

const plaintextKeys = new Set<string>();
const undecryptableKeys = new Set<string>();

function bridge(): SecretBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const b = window.__heming_secrets;
  if (!b || typeof b.encrypt !== "function" || typeof b.decrypt !== "function") return undefined;
  return b;
}

export function hasSecureBridge(): boolean {
  return bridge() !== undefined;
}

export function secureStorageAvailable(): boolean {
  const b = bridge();
  return !!b && b.available === true;
}

/** localStorage 安全适配：访问/写入本身都可能抛（配额、隐私模式）。 */
function browserStorage(): StorageLike {
  return {
    getItem: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* 配额/隐私模式：只影响持久化，不影响本次会话 */
      }
    },
    removeItem: (k) => {
      try {
        localStorage.removeItem(k);
      } catch {
        /* 同上 */
      }
    },
  };
}

type StoredShape =
  | { kind: "plain" }
  | { kind: "envelope"; data: string }
  | { kind: "bad-envelope" };

/**
 * 判定存的是明文还是信封。
 *
 * `__hemingEnc` 存在但版本不认识/数据不合法 → bad-envelope：**不能**当明文再包一层，
 * 否则会把「未来版本的信封」加密成「当前版本的密文」，等升级回来也解不开了。
 */
function parseStored(raw: string): StoredShape {
  if (!raw.startsWith("{")) return { kind: "plain" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "plain" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "plain" };
  const record = parsed as Record<string, unknown>;
  if (!(ENVELOPE_MARK in record)) return { kind: "plain" };
  if (record[ENVELOPE_MARK] !== ENVELOPE_VERSION) return { kind: "bad-envelope" };
  if (typeof record.data !== "string" || !record.data) return { kind: "bad-envelope" };
  return { kind: "envelope", data: record.data };
}

function envelopeOf(cipherB64: string): string {
  return JSON.stringify({ [ENVELOPE_MARK]: ENVELOPE_VERSION, data: cipherB64 });
}

export function secureGetItem(key: string, base: StorageLike = browserStorage()): string | null {
  let raw: string | null;
  try {
    raw = base.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;

  const shape = parseStored(raw);
  if (shape.kind === "bad-envelope") {
    undecryptableKeys.add(key);
    return null;
  }
  if (shape.kind === "envelope") {
    const b = bridge();
    if (!b || b.available !== true) {
      undecryptableKeys.add(key);
      return null;
    }
    const plain = b.decrypt(shape.data);
    if (plain === null) {
      undecryptableKeys.add(key);
      return null;
    }
    undecryptableKeys.delete(key);
    return plain;
  }

  // 明文（旧数据）：桌面可用时就地懒迁移；失败保留明文，绝不丢配置。
  const b = bridge();
  if (b && b.available === true) {
    const cipher = b.encrypt(raw);
    if (cipher) {
      try {
        base.setItem(key, envelopeOf(cipher));
        plaintextKeys.delete(key);
      } catch {
        plaintextKeys.add(key);
      }
    } else {
      plaintextKeys.add(key);
    }
  }
  return raw;
}

export function secureSetItem(
  key: string,
  value: string,
  base: StorageLike = browserStorage(),
): void {
  const b = bridge();
  if (b && b.available === true) {
    const cipher = b.encrypt(value);
    if (cipher) {
      try {
        base.setItem(key, envelopeOf(cipher));
        plaintextKeys.delete(key);
        return;
      } catch {
        /* 配额：退回明文，至少这次会话的配置还在 */
      }
    }
    plaintextKeys.add(key);
  } else if (b) {
    plaintextKeys.add(key); // 桌面桥在、系统安全存储不可用
  }
  base.setItem(key, value);
}

export function secureRemoveItem(key: string, base: StorageLike = browserStorage()): void {
  plaintextKeys.delete(key);
  undecryptableKeys.delete(key);
  base.removeItem(key);
}

/**
 * 只对 `secureKey` 加密的 StorageLike 适配器。
 *
 * 用于那些「一个存储里混着凭据与非凭据」的模块：MCP 注册表把服务配置（含请求头
 * token）和工具清单/启用状态放在同一份存储里，只加密前者，避免无谓的 IPC。
 */
export function secureStorageFor(
  secureKey: string,
  base: StorageLike = browserStorage(),
): StorageLike {
  return {
    getItem: (k) => (k === secureKey ? secureGetItem(k, base) : base.getItem(k)),
    setItem: (k, v) => (k === secureKey ? secureSetItem(k, v, base) : base.setItem(k, v)),
    removeItem: (k) => (k === secureKey ? secureRemoveItem(k, base) : base.removeItem(k)),
  };
}

export function secureStorageStatus(): SecureStorageStatus {
  const b = bridge();
  return {
    desktop: !!b,
    available: !!b && b.available === true,
    plaintextKeys: [...plaintextKeys].sort(),
    undecryptableKeys: [...undecryptableKeys].sort(),
  };
}

/** 测试隔离：清掉进程内状态（不动 localStorage）。 */
export function resetSecureStorageState(): void {
  plaintextKeys.clear();
  undecryptableKeys.clear();
}
