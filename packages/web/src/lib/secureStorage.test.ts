import { describe, it, expect, beforeEach } from "vitest";
import {
  ENVELOPE_MARK,
  ENVELOPE_VERSION,
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
