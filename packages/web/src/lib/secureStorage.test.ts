import { describe, it, expect, beforeEach, vi } from "vitest";
import type { StorageLike } from "./memory/types.js";
import {
  ENVELOPE_MARK,
  ENVELOPE_VERSION,
  UNDECRYPTABLE_BACKUP_SUFFIX,
  secureGetItem,
  secureSetItem,
  secureStorageFor,
  secureStorageStatus,
  resetSecureStorageState,
} from "./secureStorage.js";

/**
 * 可控假桥：密文 = `enc:` + base64(明文)——必须真的「看不出原文」，
 * 否则 `not.toContain(明文)` 这类断言会假失败（假加密不能是原文加前缀）。
 */
const fakeEncrypt = (plain: string) => `enc:${Buffer.from(plain, "utf8").toString("base64")}`;
const fakeDecrypt = (data: string) =>
  data.startsWith("enc:") ? Buffer.from(data.slice(4), "base64").toString("utf8") : null;

function installBridge(opts: { available?: boolean; failEncrypt?: boolean } = {}) {
  const calls = { encrypt: 0, decrypt: 0 };
  (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = {
    available: opts.available !== false,
    encrypt: (plain: string) => {
      calls.encrypt += 1;
      return opts.failEncrypt ? null : fakeEncrypt(plain);
    },
    decrypt: (data: string) => {
      calls.decrypt += 1;
      return fakeDecrypt(data);
    },
  };
  return calls;
}

function envelopeData(key: string): string {
  return (JSON.parse(localStorage.getItem(key)!) as Record<string, string>).data;
}

beforeEach(() => {
  localStorage.clear();
  delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
  resetSecureStorageState();
});

describe("secureStorage · 无桥（浏览器路径）", () => {
  it("读写行为与今天一致：明文进、明文出", () => {
    secureSetItem("k", "v");
    expect(localStorage.getItem("k")).toBe("v");
    expect(secureGetItem("k")).toBe("v");
  });

  it("状态为浏览器模式", () => {
    const s = secureStorageStatus();
    expect(s.desktop).toBe(false);
    expect(s.available).toBe(false);
    expect(s.plaintextKeys).toEqual([]);
  });

  it("读到信封（异常场景）返回 null 且不改写，标记无法解密", () => {
    const envelope = JSON.stringify({ [ENVELOPE_MARK]: ENVELOPE_VERSION, data: "enc:x" });
    localStorage.setItem("k", envelope);
    expect(secureGetItem("k")).toBeNull();
    expect(localStorage.getItem("k")).toBe(envelope);
    expect(secureStorageStatus().undecryptableKeys).toContain("k");
  });
});

describe("secureStorage · 有桥（桌面路径）", () => {
  it("写入为信封、读出为明文", () => {
    installBridge();
    secureSetItem("k", "secret-value");
    const raw = localStorage.getItem("k")!;
    expect(JSON.parse(raw)[ENVELOPE_MARK]).toBe(ENVELOPE_VERSION);
    expect(raw).not.toContain("secret-value");
    expect(secureGetItem("k")).toBe("secret-value");
  });

  it("懒迁移幂等：明文读一次变信封，第二次不再加密", () => {
    localStorage.setItem("k", JSON.stringify({ a: 1 }));
    const calls = installBridge();
    expect(secureGetItem("k")).toBe(JSON.stringify({ a: 1 }));
    expect(calls.encrypt).toBe(1);
    expect(JSON.parse(localStorage.getItem("k")!)[ENVELOPE_MARK]).toBe(ENVELOPE_VERSION);
    expect(secureGetItem("k")).toBe(JSON.stringify({ a: 1 }));
    expect(calls.encrypt).toBe(1);
  });

  it("加密失败：保留明文并标记，不丢配置", () => {
    installBridge({ failEncrypt: true });
    secureSetItem("k", "v");
    expect(localStorage.getItem("k")).toBe("v");
    expect(secureGetItem("k")).toBe("v");
    expect(secureStorageStatus().plaintextKeys).toContain("k");
  });

  it("桥不可用：不加密但记入明文清单", () => {
    installBridge({ available: false });
    secureSetItem("k", "v");
    expect(localStorage.getItem("k")).toBe("v");
    expect(secureStorageStatus().plaintextKeys).toContain("k");
    expect(secureStorageStatus().available).toBe(false);
  });

  it("桥不可用且只读明文：也记入明文清单", () => {
    localStorage.setItem("k", "v");
    const calls = installBridge({ available: false });
    expect(secureGetItem("k")).toBe("v");
    expect(secureStorageStatus().plaintextKeys).toContain("k");
    expect(calls.encrypt).toBe(0);
  });

  it("解不开的信封被新值覆盖后，状态不再报无法解密，且先原样备份", () => {
    const bad = JSON.stringify({ [ENVELOPE_MARK]: ENVELOPE_VERSION, data: "garbage" });
    localStorage.setItem("k", bad);
    installBridge();
    expect(secureGetItem("k")).toBeNull();
    expect(secureStorageStatus().undecryptableKeys).toContain("k");
    secureSetItem("k", "fresh");
    expect(secureStorageStatus().undecryptableKeys).not.toContain("k");
    expect(secureStorageStatus().backedUpKeys).toContain("k");
    expect(secureGetItem("k")).toBe("fresh");
  });

  it("覆盖解不开的信封前先原样备份，状态转入 backedUpKeys", () => {
    const original = JSON.stringify({ [ENVELOPE_MARK]: ENVELOPE_VERSION, data: "garbage" });
    localStorage.setItem("k", original);
    installBridge(); // decrypt("garbage") → null；encrypt 正常
    expect(secureGetItem("k")).toBeNull();
    expect(secureStorageStatus().undecryptableKeys).toContain("k");

    secureSetItem("k", "fresh");
    expect(localStorage.getItem("k" + UNDECRYPTABLE_BACKUP_SUFFIX)).toBe(original);
    expect(secureStorageStatus().undecryptableKeys).not.toContain("k");
    expect(secureStorageStatus().backedUpKeys).toContain("k");
    expect(secureGetItem("k")).toBe("fresh");
    // 幂等：再覆盖一次不重写备份（备份内容仍是第一份旧密文）
    const backup = localStorage.getItem("k" + UNDECRYPTABLE_BACKUP_SUFFIX);
    secureSetItem("k", "fresh-2");
    expect(localStorage.getItem("k" + UNDECRYPTABLE_BACKUP_SUFFIX)).toBe(backup);
  });

  it("默认存储层不吞配额异常：信封写失败时保留明文并如实标记，不谎报已加密", () => {
    installBridge();
    const realSetItem = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      k: string,
      v: string,
    ) {
      // 只让信封写失败（配额语义）：明文兜底照常写入
      if (v.startsWith("{")) throw new DOMException("QuotaExceededError", "QuotaExceededError");
      realSetItem.call(this, k, v);
    });
    try {
      secureSetItem("k", "v");
      expect(secureStorageStatus().plaintextKeys).toContain("k");
      expect(secureStorageStatus().backedUpKeys).not.toContain("k");
      expect(localStorage.getItem("k")).toBe("v"); // 明文兜底真的落盘
    } finally {
      spy.mockRestore();
    }
  });

  it("信封与明文兜底都写不进（配额耗尽）时不抛，仍如实标记明文", () => {
    const backing = new Map<string, string>();
    const failing: StorageLike = {
      getItem: (k) => backing.get(k) ?? null,
      setItem: (_k, v) => {
        if (v.startsWith("{")) throw new Error("QuotaExceededError"); // 只让信封写失败
        throw new Error("QuotaExceededError"); // 明文也写不进
      },
      removeItem: (k) => void backing.delete(k),
    };
    installBridge();
    expect(() => secureSetItem("k", "v", failing)).not.toThrow();
    expect(secureStorageStatus().plaintextKeys).toContain("k");
    expect(secureStorageStatus().backedUpKeys).not.toContain("k");
    expect(secureGetItem("k", failing)).toBeNull();
  });


  it("损坏信封：不抛、返回 null、不改写原值", () => {
    const bad = JSON.stringify({ [ENVELOPE_MARK]: ENVELOPE_VERSION, data: "garbage" });
    localStorage.setItem("k", bad);
    installBridge();
    expect(() => secureGetItem("k")).not.toThrow();
    expect(secureGetItem("k")).toBeNull();
    expect(localStorage.getItem("k")).toBe(bad);
    expect(secureStorageStatus().undecryptableKeys).toContain("k");
  });

  it("版本不认识的信封按「解不开」处理，不当作明文重新加密", () => {
    const future = JSON.stringify({ [ENVELOPE_MARK]: "v9", data: "x" });
    localStorage.setItem("k", future);
    const calls = installBridge();
    expect(secureGetItem("k")).toBeNull();
    expect(localStorage.getItem("k")).toBe(future);
    expect(calls.encrypt).toBe(0);
  });
});

describe("secureStorageFor · 键作用域", () => {
  it("只加密指定键，其他键直通", () => {
    installBridge();
    const store = secureStorageFor("secret");
    store.setItem("secret", "s");
    store.setItem("plain", "p");
    expect(JSON.parse(localStorage.getItem("secret")!)[ENVELOPE_MARK]).toBe(ENVELOPE_VERSION);
    expect(localStorage.getItem("plain")).toBe("p");
    expect(store.getItem("secret")).toBe("s");
    expect(store.getItem("plain")).toBe("p");
    expect(envelopeData("secret")).not.toContain('"s"');
  });

  it("删除同时清掉信封与状态记录", () => {
    installBridge({ failEncrypt: true });
    const store = secureStorageFor("secret");
    store.setItem("secret", "s");
    expect(secureStorageStatus().plaintextKeys).toContain("secret");
    store.removeItem("secret");
    expect(localStorage.getItem("secret")).toBeNull();
    expect(secureStorageStatus().plaintextKeys).not.toContain("secret");
  });
});
