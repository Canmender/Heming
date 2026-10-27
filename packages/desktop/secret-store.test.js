"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ENVELOPE_VERSION,
  isAvailable,
  encrypt,
  decrypt,
  registerSecretIpc,
} = require("./secret-store");

/** 假 safeStorage：加密 = 加 "s:" 前缀，解密 = 去前缀；可注入失败模式。 */
function fakeSafe(opts = {}) {
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    calls,
    isEncryptionAvailable() {
      if (opts.throwsAvailable) throw new Error("boom");
      return opts.available !== false;
    },
    encryptString(plain) {
      calls.encrypt += 1;
      if (opts.throwsEncrypt) throw new Error("dpapi down");
      return Buffer.from(`s:${plain}`, "utf8");
    },
    decryptString(buf) {
      calls.decrypt += 1;
      const text = buf.toString("utf8");
      if (!text.startsWith("s:")) throw new Error("bad cipher");
      return text.slice(2);
    },
  };
}

test("可用时加密 → 解密往返", () => {
  const safe = fakeSafe();
  const b64 = encrypt("sk-ant-secret", safe);
  assert.equal(typeof b64, "string");
  assert.equal(decrypt(b64, safe), "sk-ant-secret");
  assert.equal(safe.calls.encrypt, 1);
  assert.equal(safe.calls.decrypt, 1);
});

test("安全存储不可用：encrypt/decrypt 都返回 null", () => {
  const safe = fakeSafe({ available: false });
  assert.equal(isAvailable(safe), false);
  assert.equal(encrypt("x", safe), null);
  assert.equal(decrypt("AAAA", safe), null);
});

test("safeStorage 抛错时不冒泡，返回 null", () => {
  const safe = fakeSafe({ throwsAvailable: true });
  assert.equal(isAvailable(safe), false);
  assert.equal(encrypt("x", safe), null);
});

test("加密失败（DPAPI 异常）返回 null，不抛", () => {
  assert.equal(encrypt("x", fakeSafe({ throwsEncrypt: true })), null);
});

test("空输入与损坏密文返回 null", () => {
  assert.equal(encrypt("", fakeSafe()), null);
  assert.equal(encrypt(null, fakeSafe()), null);
  assert.equal(decrypt("", fakeSafe()), null);
  assert.equal(decrypt("bm90LWEtY2lwaGVy", fakeSafe()), null); // "not-a-cipher"
});

test("IPC：available / encrypt / decrypt 三条同步通道", () => {
  const handlers = {};
  registerSecretIpc({ on: (channel, fn) => { handlers[channel] = fn; } }, fakeSafe());
  const call = (channel, arg) => {
    const event = { returnValue: undefined };
    handlers[channel](event, arg);
    return event.returnValue;
  };
  assert.equal(call("secret:available"), true);
  const b64 = call("secret:encrypt", "top-secret");
  assert.equal(typeof b64, "string");
  assert.equal(call("secret:decrypt", b64), "top-secret");
});

test("信封版本常量与 web 侧一致", () => {
  assert.equal(ENVELOPE_VERSION, "v1");
});

test("源码不引入任何网络能力（红线，结构性断言）", () => {
  const src = fs.readFileSync(path.join(__dirname, "secret-store.js"), "utf8");
  assert.ok(!/require\(\s*["'](node:)?(http|https|net|dgram|tls)["']\s*\)/.test(src));
  assert.ok(!/\bfetch\s*\(/.test(src));
});
