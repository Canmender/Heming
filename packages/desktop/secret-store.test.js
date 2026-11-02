"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  BATCH_MAX_ITEMS,
  BOOTSTRAP_ALLOWED_KEYS,
  ENVELOPE_VERSION,
  bootstrapSecrets,
  cryptoMode,
  isAvailable,
  encrypt,
  decrypt,
  isAvailableAsync,
  encryptAsync,
  decryptAsync,
  encryptMany,
  decryptMany,
  registerSecretIpc,
} = require("./secret-store");

/** 假 safeStorage（只有同步三件套）：加密 = 加 "s:" 前缀，解密 = 去前缀；可注入失败模式。 */
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

/**
 * 假 safeStorage（Electron 45+：异步三件套优先）。
 *
 * 刻意把 `decryptStringAsync` 做成**返回 `{result}` 对象**（与 Electron 的真实形状一致）：
 * 少解构一层就会静默拿到 undefined，这条契约必须有测试钉住。
 */
function fakeSafeAsync(opts = {}) {
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    calls,
    isAsyncEncryptionAvailable: async () => {
      if (opts.throwsAvailable) throw new Error("boom");
      return opts.available !== false;
    },
    async encryptStringAsync(plain) {
      calls.encrypt += 1;
      if (opts.throwsEncrypt) throw new Error("async dpapi down");
      return Buffer.from(`a:${plain}`, "utf8");
    },
    async decryptStringAsync(buf) {
      calls.decrypt += 1;
      const text = buf.toString("utf8");
      if (!text.startsWith("a:")) throw new Error("bad cipher");
      if (opts.bareString) return text.slice(2); // 防御性兼容：未来若变回裸字符串
      return { result: text.slice(2), shouldReEncrypt: false };
    },
  };
}

/** 假 ipcMain：同时支持同步通道（on）与异步通道（handle）。 */
function fakeIpcMain() {
  const onHandlers = {};
  const handleHandlers = {};
  return {
    onHandlers,
    handleHandlers,
    on(channel, fn) {
      onHandlers[channel] = fn;
    },
    handle(channel, fn) {
      handleHandlers[channel] = fn;
    },
  };
}

function callSync(handlers, channel, arg) {
  const event = { returnValue: undefined };
  handlers[channel](event, arg);
  return event.returnValue;
}

/* ─────────────────────────── 同步三件套（弃用兜底） ─────────────────────────── */

test("同步：可用时加密 → 解密往返", () => {
  const safe = fakeSafe();
  const b64 = encrypt("sk-ant-secret", safe);
  assert.equal(typeof b64, "string");
  assert.equal(decrypt(b64, safe), "sk-ant-secret");
  assert.equal(safe.calls.encrypt, 1);
  assert.equal(safe.calls.decrypt, 1);
});

test("同步：安全存储不可用 → encrypt/decrypt 都返回 null", () => {
  const safe = fakeSafe({ available: false });
  assert.equal(isAvailable(safe), false);
  assert.equal(encrypt("x", safe), null);
  assert.equal(decrypt("AAAA", safe), null);
});

test("同步：safeStorage 抛错时不冒泡（可用性/加密都返回 false/null）", () => {
  const safe = fakeSafe({ throwsAvailable: true });
  assert.equal(isAvailable(safe), false);
  assert.equal(encrypt("x", safe), null);
});

test("同步：加密失败（DPAPI 异常）返回 null", () => {
  assert.equal(encrypt("x", fakeSafe({ throwsEncrypt: true })), null);
});

test("同步：空输入与损坏密文返回 null", () => {
  assert.equal(encrypt("", fakeSafe()), null);
  assert.equal(encrypt(null, fakeSafe()), null);
  assert.equal(decrypt("", fakeSafe()), null);
  assert.equal(decrypt("bm90LWEtY2lwaGVy", fakeSafe()), null); // "not-a-cipher"
});

/* ─────────────────────────── 异步三件套（首选） ─────────────────────────── */

test("异步：加密 → 解密往返（decryptStringAsync 的 {result} 必须被正确解构）", async () => {
  const safe = fakeSafeAsync();
  const b64 = await encryptAsync("sk-async", safe);
  assert.equal(typeof b64, "string");
  assert.equal(await decryptAsync(b64, safe), "sk-async");
});

test("异步：裸字符串返回形状也能读（防御性兼容）", async () => {
  const safe = fakeSafeAsync({ bareString: true });
  const b64 = await encryptAsync("x", safe);
  assert.equal(await decryptAsync(b64, safe), "x");
});

test("异步：不可用时 encryptAsync/decryptAsync 返回 null", async () => {
  const safe = fakeSafeAsync({ available: false });
  assert.equal(await isAvailableAsync(safe), false);
  assert.equal(await encryptAsync("x", safe), null);
  assert.equal(await decryptAsync("AAAA", safe), null);
});

test("异步：加密抛错返回 null，不冒泡", async () => {
  assert.equal(await encryptAsync("x", fakeSafeAsync({ throwsEncrypt: true })), null);
});

test("异步：没有异步三件套时回退同步实现（旧版 Electron 兼容）", async () => {
  const safe = fakeSafe();
  assert.equal(await isAvailableAsync(safe), true);
  const b64 = await encryptAsync("legacy", safe);
  assert.equal(await decryptAsync(b64, safe), "legacy");
});

test("cryptoMode：async > sync > null", () => {
  assert.equal(cryptoMode(fakeSafeAsync()), "async");
  assert.equal(cryptoMode(fakeSafe()), "sync");
  assert.equal(cryptoMode(null), null);
});

/* ─────────────────────────── 批量通道（白名单） ─────────────────────────── */

test("bootstrap：白名单内的键被解密，顺序与条目一致", async () => {
  const safe = fakeSafeAsync();
  const entries = [];
  for (const key of BOOTSTRAP_ALLOWED_KEYS) {
    entries.push({ key, data: await encryptAsync(`value-of-${key}`, safe) });
  }
  const result = await bootstrapSecrets(entries, safe);
  assert.equal(result.available, true);
  assert.equal(result.plaintexts.length, BOOTSTRAP_ALLOWED_KEYS.length);
  for (let i = 0; i < BOOTSTRAP_ALLOWED_KEYS.length; i += 1) {
    assert.equal(result.plaintexts[i].key, BOOTSTRAP_ALLOWED_KEYS[i]);
    assert.equal(result.plaintexts[i].value, `value-of-${BOOTSTRAP_ALLOWED_KEYS[i]}`);
  }
});

test("bootstrap：白名单之外的键一律拒绝，且不返回任何明文/密文", async () => {
  const safe = fakeSafeAsync();
  const allowed = await encryptAsync("ok", safe);
  const result = await bootstrapSecrets(
    [
      { key: "heming.llmConfigs", data: allowed },
      // 这些都不在白名单里：热路径信封/任意键都不许走批量解密
      { key: "heming.e2e.chains.conv-1", data: allowed },
      { key: "heming.msgCache.conv-1", data: allowed },
      { key: "heming.someOtherKey", data: allowed },
    ],
    safe,
  );
  assert.deepEqual(
    result.plaintexts.map((item) => item.key),
    ["heming.llmConfigs"],
  );
});

test("bootstrap：非字符串 / 缺 data / 超长 payload 一律丢弃", async () => {
  const safe = fakeSafeAsync();
  const allowed = await encryptAsync("ok", safe);
  const result = await bootstrapSecrets(
    [
      { key: "heming.llmConfigs", data: allowed },
      { key: 123, data: allowed },
      { key: "heming.mcp.servers.v1" }, // 缺 data
      { key: "heming.e2e.identity", data: 42 },
      { key: "heming.llmConfigs", data: "x".repeat(600 * 1024) }, // 超长
      "不是对象",
      null,
    ],
    safe,
  );
  assert.deepEqual(
    result.plaintexts.map((item) => item.key),
    ["heming.llmConfigs"],
  );
});

test("bootstrap：批条目数超过上限时只处理前 N 个（白名单本来只有 3 个）", async () => {
  const safe = fakeSafeAsync();
  const data = await encryptAsync("ok", safe);
  const entries = Array.from({ length: 20 }, () => ({ key: "heming.llmConfigs", data }));
  const result = await bootstrapSecrets(entries, safe);
  assert.ok(result.plaintexts.length <= 8);
});

test("bootstrap：安全存储不可用时返回空 plaintexts（不返回任何密文）", async () => {
  const safe = fakeSafeAsync({ available: false });
  const result = await bootstrapSecrets([{ key: "heming.llmConfigs", data: "AAAA" }], safe);
  assert.equal(result.available, false);
  assert.deepEqual(result.plaintexts, []);
});

/* ─────────────────────────── IPC ─────────────────────────── */

test("IPC：同步通道（available / encrypt / decrypt）在旧版 Electron 上仍然可用", () => {
  const ipc = fakeIpcMain();
  registerSecretIpc(ipc, fakeSafe()); // 只有同步三件套的旧版
  assert.equal(callSync(ipc.onHandlers, "secret:available"), true);
  const b64 = callSync(ipc.onHandlers, "secret:encrypt", "top-secret");
  assert.equal(typeof b64, "string");
  assert.equal(callSync(ipc.onHandlers, "secret:decrypt", b64), "top-secret");
  assert.deepEqual(callSync(ipc.onHandlers, "secret:capabilities"), {
    mode: "sync",
    sync: true,
    async: false,
  });
});

test("IPC：capabilities 在异步优先环境报告 async（同步通道此时不可用）", () => {
  const ipc = fakeIpcMain();
  registerSecretIpc(ipc, fakeSafeAsync());
  assert.deepEqual(callSync(ipc.onHandlers, "secret:capabilities"), {
    mode: "async",
    sync: false,
    async: true,
  });
  // 弃用通道在纯异步环境返回 false —— 渲染层据此走异步补取，而不是误判「安全存储不可用」
  assert.equal(callSync(ipc.onHandlers, "secret:available"), false);
});

test("IPC：异步通道（availableAsync / encryptAsync / decryptAsync）", async () => {
  const ipc = fakeIpcMain();
  registerSecretIpc(ipc, fakeSafeAsync());
  assert.equal(await ipc.handleHandlers["secret:availableAsync"](), true);
  const b64 = await ipc.handleHandlers["secret:encryptAsync"]({}, "async-secret");
  assert.equal(typeof b64, "string");
  assert.equal(await ipc.handleHandlers["secret:decryptAsync"]({}, b64), "async-secret");
});

test("IPC：异步通道对非法入参返回 null（不抛）", async () => {
  const ipc = fakeIpcMain();
  registerSecretIpc(ipc, fakeSafeAsync());
  assert.equal(await ipc.handleHandlers["secret:encryptAsync"]({}, 42), null);
  assert.equal(await ipc.handleHandlers["secret:encryptAsync"]({}, "x".repeat(600 * 1024)), null);
  assert.equal(await ipc.handleHandlers["secret:decryptAsync"]({}, null), null);
});

test("IPC：批量通道 secret:bootstrap 走同一份白名单", async () => {
  const ipc = fakeIpcMain();
  const safe = fakeSafeAsync();
  registerSecretIpc(ipc, safe);
  const allowed = await encryptAsync("v", safe);
  const result = await ipc.handleHandlers["secret:bootstrap"]({}, {
    entries: [
      { key: "heming.llmConfigs", data: allowed },
      { key: "heming.e2e.chains.c1", data: allowed },
    ],
  });
  assert.deepEqual(
    result.plaintexts.map((item) => item.key),
    ["heming.llmConfigs"],
  );
});

test("IPC：批量通道对非对象 payload 不抛", async () => {
  const ipc = fakeIpcMain();
  registerSecretIpc(ipc, fakeSafeAsync());
  const result = await ipc.handleHandlers["secret:bootstrap"]({}, null);
  assert.equal(result.available, true);
  assert.deepEqual(result.plaintexts, []);
});

/* ─────────────────── 通用批量热路径（E2E chains / msgCache） ─────────────────── */

test("批量：encryptMany / decryptMany 顺序敏感（乱序索引不串位）", async () => {
  const safe = fakeSafeAsync();
  const plains = ["第一条", "第二条", "第三条"];
  const ciphers = await encryptMany(plains, safe);
  assert.equal(ciphers.length, 3);
  const back = await decryptMany(ciphers, safe);
  assert.deepEqual(back, plains);
  // 显式逐位核对：位置 i 的密文解出的就是 plains[i]（批量热路径最怕串位）
  for (let i = 0; i < plains.length; i += 1) {
    assert.equal(await decryptAsync(ciphers[i], safe), plains[i]);
  }
});

test("批量：单条失败位置为 null，其余条目不受影响", async () => {
  const safe = fakeSafeAsync();
  const good = await encryptAsync("ok", safe);
  const out = await decryptMany([good, "不是密文", good], safe);
  assert.equal(out[0], "ok");
  assert.equal(out[1], null);
  assert.equal(out[2], "ok");
  // 加密侧：非字符串 / 空串位置为 null（调用方按 fail-open 保留明文）
  const enc = await encryptMany(["", 42, "ok"], safe);
  assert.equal(enc[0], null);
  assert.equal(enc[1], null);
  assert.equal(typeof enc[2], "string");
});

test("批量：超过条数上限只处理前 256 条（其余位置缺失 → 调用方 fail-open）", async () => {
  const safe = fakeSafeAsync();
  const plains = Array.from({ length: 300 }, (_, i) => `p${i}`);
  const ciphers = await encryptMany(plains, safe);
  assert.equal(ciphers.length, BATCH_MAX_ITEMS);
  assert.equal(await decryptAsync(ciphers[0], safe), "p0");
  assert.equal(await decryptAsync(ciphers[BATCH_MAX_ITEMS - 1], safe), `p${BATCH_MAX_ITEMS - 1}`);
});

test("批量：总字符超上限时整批返回 null（不部分处理，避免半加密状态）", async () => {
  const safe = fakeSafeAsync();
  const plains = Array.from({ length: BATCH_MAX_ITEMS }, () => "x".repeat(9000)); // 256 * 9KB ≈ 2.3MB > 2MB
  const ciphers = await encryptMany(plains, safe);
  assert.deepEqual(
    ciphers,
    Array.from({ length: BATCH_MAX_ITEMS }, () => null),
  );
});

test("批量：非数组入参返回空数组（不抛）", async () => {
  const safe = fakeSafeAsync();
  assert.deepEqual(await encryptMany(null, safe), []);
  assert.deepEqual(await decryptMany("no", safe), []);
});

test("IPC：secret:encryptMany / secret:decryptMany 通道往返（长度与顺序一致）", async () => {
  const ipc = fakeIpcMain();
  registerSecretIpc(ipc, fakeSafeAsync());
  const plains = ["a", "b", "c"];
  const ciphers = await ipc.handleHandlers["secret:encryptMany"]({}, plains);
  assert.equal(ciphers.length, 3);
  const back = await ipc.handleHandlers["secret:decryptMany"]({}, ciphers);
  assert.deepEqual(back, plains);
});

/* ─────────────────────────── 红线 ─────────────────────────── */

test("信封版本常量与 web 侧一致", () => {
  assert.equal(ENVELOPE_VERSION, "v1");
});

test("源码不引入任何网络能力（红线，结构性断言）", () => {
  const src = fs.readFileSync(path.join(__dirname, "secret-store.js"), "utf8");
  assert.ok(!/require\(\s*["'](node:)?(http|https|net|dgram|tls)["']\s*\)/.test(src));
  assert.ok(!/\bfetch\s*\(/.test(src));
});
