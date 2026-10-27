# d.36 密钥系统安全存储 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把桌面端三把钥匙（`heming.llmConfigs` / `heming.mcp.servers.v1` / `heming.e2e.identity`）改成用 Electron `safeStorage` 加密的「就地信封」，读时懒迁移、失败保留明文且状态可见。

**Architecture:** 主进程新增 `secret-store.js` 做 `safeStorage` 加解密；preload 用 `sendSync` 暴露 `window.__heming_secrets`（只在三个低频键上用）；web 侧新增 `lib/secureStorage.ts` 负责信封判定、懒迁移与状态记录，三个读写点各替换一处。密文仍写原 localStorage 键位，浏览器端（无桥）行为与今天完全一致。

**Tech Stack:** Electron 主进程 `safeStorage`、contextBridge + 同步 IPC、TypeScript（web，vitest + jsdom）、Node `node:test`（desktop）。

**Spec:** `docs/superpowers/specs/2026-10-23-d36-safestorage.md`

## Global Constraints

- 版本号只能增不能减；本计划完成后执行 `node scripts/bump-version.mjs auto feature`。当前 `d.35.1.9.0` ⇒ 目标 **`d.36.1.9.0`**（规格里写的 `d.36.1.8.0` 写于 `d.35.1.8.0` 时期；按累计位规则修订位保留，不会归零）。
- **只加密三把钥匙**。`heming.msgCache.*` 与 `heming.e2e.chains.*` 一律不动（热路径，P0-5b 另立轮次）。
- `secret-store.js` **不得有任何网络能力**（http/https/net/dgram/tls/fetch），测试从源码做结构性断言。
- `sendSync` 只允许用在 `llmConfigs` / `mcp.servers` / `e2e.identity` 三个低频键上；注释里写明这条前提。
- 加密失败/不可用时**保留明文，绝不丢配置**，并在设置区可见提示（降级不能静默）。
- 界面无 emoji、图标用细线 SVG（1.5px）；分割线用 `border-line-soft`；中文文案。
- 现有 jsdom 测试没有桥，走的必须是明文路径——这就是「浏览器端不受影响」的证据。
- 测试门禁：`pnpm -r build && pnpm -r --workspace-concurrency=1 test`；改 shared 契约才需要先单独 build shared（本轮不动 shared）。
- 本仓 `skipLibCheck: true`：新增 `interface Window` 前先 `grep -rn "interface Window" packages/web/src`（已知两处：`types/heming.d.ts`、`ChatPage.tsx`）。

## File Structure

| 文件 | 操作 | 职责 |
|---|---|---|
| `packages/desktop/secret-store.js` | 新建 | `safeStorage` 加解密 + 三条同步 IPC 通道；无网络、不落文件 |
| `packages/desktop/secret-store.test.js` | 新建 | 注入假 `safeStorage` 测可用/不可用/抛错/往返/源码红线 |
| `packages/desktop/preload.js` | 修改 | 暴露 `window.__heming_secrets`（`available` + 同步 `encrypt`/`decrypt`） |
| `packages/desktop/preload.test.js` | 修改 | 桩 `ipcRenderer`，断言桥的形状与失败回落 |
| `packages/desktop/main.js` | 修改 | 在 `createWindow()` 之前注册密钥 IPC |
| `packages/desktop/main.test.js` | 修改 | 断言注册顺序（preload 的 `sendSync` 依赖它） |
| `packages/desktop/package.json` | 修改 | `test` 脚本加入 `node --check secret-store.js` 与 `node --test secret-store.test.js` |
| `packages/web/src/lib/secureStorage.ts` | 新建 | 信封判定、懒迁移、状态快照、`secureStorageFor` 适配器 |
| `packages/web/src/lib/secureStorage.test.ts` | 新建 | 无桥/有桥/幂等/失败/损坏信封/键作用域 |
| `packages/web/src/types/heming.d.ts` | 修改 | 声明 `window.__heming_secrets` |
| `packages/web/src/store/llm.ts` | 修改 | `llmConfigs` 走 secure 层；bindings/prompts 保持普通 |
| `packages/web/src/store/llm.test.ts` | 修改 | 信封落盘 + 刷新水合 + 非凭据键不加密 |
| `packages/web/src/lib/mcp/store.ts` | 修改 | 默认存储改为只对 `mcp.servers.v1` 加密的适配器 |
| `packages/web/src/lib/mcp/mcp.test.ts` | 修改 | servers 是信封、tools 不是；重开能解回 headers |
| `packages/web/src/lib/e2eSession.ts` | 修改 | identity 三处读写走 secure；chains/deferred 不动 |
| `packages/web/src/lib/e2eSession.test.ts` | 修改 | 身份信封落盘、可解、不二次加密、chains 仍明文 |
| `packages/web/src/components/KeyStorageCard.tsx` | 新建 | 三态文案 + 失败/解不开的键名清单 |
| `packages/web/src/components/SettingsPage.tsx` | 修改 | 模型分组里挂载 `KeyStorageCard` |
| `packages/web/src/components/SettingsPage.test.tsx` | 修改 | 四种状态各渲染一次 |
| `CHANGELOG.md` / `docs/HANDOFF.md` / `docs/INDEX.md` / 规格文件 | 修改 | 版本、里程碑、交接、待实施标记 |

---

### Task 1: 桌面主进程 `secret-store.js`

**Files:**
- Create: `packages/desktop/secret-store.js`
- Create: `packages/desktop/secret-store.test.js`
- Modify: `packages/desktop/package.json`（`test` 脚本 + electron-builder `build.files` 白名单）

**Interfaces:**
- Produces: `ENVELOPE_VERSION = "v1"`、`isAvailable(safeStorage?)`、`encrypt(plain, safeStorage?) => string|null`、`decrypt(cipherB64, safeStorage?) => string|null`、`registerSecretIpc(ipcMain, safeStorage?)`。
- `safeStorage` 参数可选：测试注入，生产走 `require("electron").safeStorage`（懒 require，纯 node 环境可加载本模块）。

- [ ] **Step 1: 写失败的测试**

`packages/desktop/secret-store.test.js`：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/desktop && node --test secret-store.test.js`
Expected: FAIL —— `Cannot find module './secret-store'`。

- [ ] **Step 3: 写实现**

`packages/desktop/secret-store.js`：

```js
"use strict";
/**
 * 本机密钥信封桥（d.36 · P0-5）。
 *
 * 职责：用 Electron `safeStorage`（Windows DPAPI / macOS 钥匙串 / 系统密钥环）
 * 给 web 端的三个低频键做加解密：
 *   heming.llmConfigs / heming.mcp.servers.v1 / heming.e2e.identity
 *
 * 红线：只做加解密。**不引入任何网络能力**，也不写文件——密文由渲染层写回
 * 原 localStorage 键位（就地信封），主进程不保存第二份。
 * 测试会从源码的 require 列表结构性断言这一点。
 *
 * 为什么是同步 IPC：渲染层那三个键都是同步读写（store 在模块初始化时读），
 * 改异步会牵动整条启动链。sendSync 的阻塞代价只落在这三个低频键上。
 */

const ENVELOPE_VERSION = "v1";

/** 取 safeStorage；测试可注入，避免纯 node 环境加载 electron。 */
function defaultSafeStorage() {
  try {
    return require("electron").safeStorage;
  } catch {
    return null;
  }
}

function isAvailable(safeStorage = defaultSafeStorage()) {
  try {
    return !!safeStorage && safeStorage.isEncryptionAvailable() === true;
  } catch {
    return false; // Linux 无 keyring / 系统策略禁用：降级为「不可用」，不抛
  }
}

/** 加密为 base64 密文；不可用或失败返回 null（调用方保留明文，绝不丢配置）。 */
function encrypt(plain, safeStorage = defaultSafeStorage()) {
  if (typeof plain !== "string" || !plain) return null;
  if (!isAvailable(safeStorage)) return null;
  try {
    return safeStorage.encryptString(plain).toString("base64");
  } catch {
    return null;
  }
}

function decrypt(cipherB64, safeStorage = defaultSafeStorage()) {
  if (typeof cipherB64 !== "string" || !cipherB64) return null;
  if (!isAvailable(safeStorage)) return null;
  try {
    const buf = Buffer.from(cipherB64, "base64");
    if (!buf.length) return null;
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

/** 注册 IPC：三条都是同步通道（preload 用 sendSync 调用）。 */
function registerSecretIpc(ipcMain, safeStorage = defaultSafeStorage()) {
  ipcMain.on("secret:available", (event) => {
    event.returnValue = isAvailable(safeStorage);
  });
  ipcMain.on("secret:encrypt", (event, plain) => {
    event.returnValue = encrypt(plain, safeStorage);
  });
  ipcMain.on("secret:decrypt", (event, cipherB64) => {
    event.returnValue = decrypt(cipherB64, safeStorage);
  });
}

module.exports = {
  ENVELOPE_VERSION,
  isAvailable,
  encrypt,
  decrypt,
  registerSecretIpc,
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/desktop && node --test secret-store.test.js`
Expected: PASS（8 例）。

- [ ] **Step 5: 把新文件纳入桌面包测试脚本**

在 `packages/desktop/package.json` 的 `"test"` 一行里：
- 在 `node --check crash-log.js` 后插入 `node --check secret-store.js`；
- 在 `node --test crash-log.test.js` 后插入 `node --test secret-store.test.js`；
- 在 `build.files` 数组里 `"crash-log.js"` 之后插入 `"secret-store.js",`——否则打出来的安装包会缺这个模块，Task 2 接线后启动即崩。

Run: `cd packages/desktop && pnpm test`
Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/desktop/secret-store.js packages/desktop/secret-store.test.js packages/desktop/package.json
git commit -m "feat(desktop): safeStorage 密钥信封主进程模块（d.36）"
```

---

### Task 2: preload 暴露桥 + 主进程接线 + 类型声明

**Files:**
- Modify: `packages/desktop/preload.js`（文件末尾）
- Modify: `packages/desktop/preload.test.js`
- Modify: `packages/desktop/main.js`（require 区 + `whenReady`）
- Modify: `packages/desktop/main.test.js`
- Modify: `packages/web/src/types/heming.d.ts`

**Interfaces:**
- Consumes: Task 1 的 `registerSecretIpc`。
- Produces: `window.__heming_secrets: { available: boolean; encrypt(plain: string): string | null; decrypt(cipherB64: string): string | null }`（浏览器里 `undefined`）。

- [ ] **Step 1: 先改测试桩并写失败的测试**

`packages/desktop/preload.test.js` 里把 `loadHeming` 拆成 `loadExposed` + `loadHeming`（保留原有所有断言）：

```js
function loadExposed(ipc = {}) {
  const exposed = {};
  const stubBridge = {
    exposeInMainWorld: (key, api) => {
      exposed[key] = api;
    },
  };
  const stubIpc = {
    sendSync: (channel, arg) => (typeof ipc[channel] === "function" ? ipc[channel](arg) : undefined),
    invoke: async () => undefined,
    on: () => {},
    removeListener: () => {},
  };
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") {
      return { contextBridge: stubBridge, ipcRenderer: stubIpc };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve(preloadPath)];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }
  return exposed;
}

function loadHeming() {
  const exposed = loadExposed();
  assert.ok(exposed.heming, "preload 应暴露 heming");
  return exposed.heming;
}
```

新增用例（放在行为测试之后）：

```js
test("preload 暴露 __heming_secrets（密钥信封桥）", () => {
  const exposed = loadExposed({ "secret:available": () => true });
  const s = exposed.__heming_secrets;
  assert.ok(s, "应暴露 __heming_secrets");
  assert.equal(s.available, true);
  assert.equal(typeof s.encrypt, "function");
  assert.equal(typeof s.decrypt, "function");
});

test("可用性来自 sendSync；通道异常按不可用处理", () => {
  assert.equal(loadExposed({ "secret:available": () => false }).__heming_secrets.available, false);
  const broken = loadExposed({
    "secret:available": () => {
      throw new Error("no handler");
    },
  });
  assert.equal(broken.__heming_secrets.available, false);
});

test("encrypt/decrypt 经 sendSync 转发；异常或非字符串回落 null", () => {
  const exposed = loadExposed({
    "secret:available": () => true,
    "secret:encrypt": (plain) => `enc:${plain}`,
    "secret:decrypt": (data) => data.startsWith("enc:") ? data.slice(4) : null,
  });
  const s = exposed.__heming_secrets;
  assert.equal(s.encrypt("x"), "enc:x");
  assert.equal(s.decrypt("enc:y"), "y");

  const failing = loadExposed({ "secret:available": () => true }); // encrypt 通道缺失 → undefined
  assert.equal(failing.__heming_secrets.encrypt("x"), null);
  assert.equal(failing.__heming_secrets.decrypt("y"), null);
});
```

`packages/desktop/main.test.js` 追加：

```js
test("密钥信封桥在 createWindow 之前注册（preload 用 sendSync 问可用性）", () => {
  const reg = mainCode.indexOf("registerSecretIpc(ipcMain)");
  const create = mainCode.indexOf("createWindow();"); // 带分号：避开函数定义的 `function createWindow() {`
  assert.ok(reg > 0, "main.js 应注册 secret IPC");
  assert.ok(create > 0, "main.js 应调用 createWindow()");
  assert.ok(reg < create, "注册必须早于窗口创建");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/desktop && node --test preload.test.js main.test.js`
Expected: FAIL —— 没有 `__heming_secrets`、main.js 没有 `registerSecretIpc(ipcMain)`。

- [ ] **Step 3: 实现 preload 桥**

在 `packages/desktop/preload.js` 末尾追加：

```js
// —— 本机密钥信封桥（d.36）——
// 三个低频键（模型 Key、MCP 服务请求头、E2E 设备身份）在渲染层的读写经这里
// 交给主进程的 safeStorage 加解密。sendSync 会阻塞渲染进程，只用于这三个
// 「启动读一次 / 用户改配置写一次」的键；**绝不能用在高频路径（消息收发）上**。
// 浏览器端没有这个桥，web 侧据此保持明文并把状态如实写进设置区。
const secretsAvailable = (() => {
  try {
    return ipcRenderer.sendSync("secret:available") === true;
  } catch {
    return false; // 主进程尚未注册或通道异常：按不可用处理，不让 preload 挂掉
  }
})();

contextBridge.exposeInMainWorld("__heming_secrets", {
  available: secretsAvailable,
  encrypt: (plain) => {
    try {
      const out = ipcRenderer.sendSync("secret:encrypt", plain);
      return typeof out === "string" ? out : null;
    } catch {
      return null;
    }
  },
  decrypt: (cipherB64) => {
    try {
      const out = ipcRenderer.sendSync("secret:decrypt", cipherB64);
      return typeof out === "string" ? out : null;
    } catch {
      return null;
    }
  },
});
```

- [ ] **Step 4: 实现主进程接线**

`packages/desktop/main.js` 顶部 require 区，在 `registerExportIpc` 之后加：

```js
const { registerSecretIpc } = require("./secret-store");
```

`app.whenReady().then(() => { ... })` 里，在 `registerExportIpc(ipcMain);` 之后、`createWindow();` 之前加：

```js
    // 本机密钥信封桥（d.36）：preload 在页面加载时用 sendSync 问可用性，
    // 所以必须早于 createWindow()。
    registerSecretIpc(ipcMain);
```

- [ ] **Step 5: 补类型声明**

`packages/web/src/types/heming.d.ts` 的 `interface Window` 里、`__heming_exports` 之后加：

```ts
    /**
     * 内部：桌面端本机密钥信封桥（preload 暴露；浏览器里 undefined）。
     * 同步 API——只给三个低频键用（模型 Key / MCP 请求头 / E2E 身份），
     * 不要用在消息收发热路径上。
     */
    __heming_secrets?: {
      available: boolean;
      encrypt: (plain: string) => string | null;
      decrypt: (cipherB64: string) => string | null;
    };
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd packages/desktop && pnpm test`
Expected: PASS（含新增 3 + 1 例）。

Run: `cd packages/web && npx tsc -p tsconfig.json --noEmit`
Expected: 无错误。

- [ ] **Step 7: 提交**

```bash
git add packages/desktop/preload.js packages/desktop/preload.test.js packages/desktop/main.js packages/desktop/main.test.js packages/web/src/types/heming.d.ts
git commit -m "feat(desktop): preload 暴露密钥信封桥并在建窗前注册（d.36）"
```

---

### Task 3: web 侧 `lib/secureStorage.ts`

**Files:**
- Create: `packages/web/src/lib/secureStorage.ts`
- Create: `packages/web/src/lib/secureStorage.test.ts`

**Interfaces:**
- Consumes: `window.__heming_secrets`（Task 2）、`StorageLike`（`lib/memory/types.ts`）。
- Produces:
  - `ENVELOPE_MARK = "__hemingEnc"`、`ENVELOPE_VERSION = "v1"`
  - `secureGetItem(key, base?): string | null`
  - `secureSetItem(key, value, base?): void`
  - `secureRemoveItem(key, base?): void`
  - `secureStorageFor(secureKey, base?): StorageLike`
  - `secureStorageStatus(): { desktop: boolean; available: boolean; plaintextKeys: string[]; undecryptableKeys: string[] }`
  - `resetSecureStorageState(): void`（测试隔离）
  - `hasSecureBridge()` / `secureStorageAvailable()`

- [ ] **Step 1: 写失败的测试**

`packages/web/src/lib/secureStorage.test.ts`：

```ts
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

  it("桥不可用且只读明文：也记入明文清单（状态卡不能漏报）", () => {
    localStorage.setItem("k", "v");
    const calls = installBridge({ available: false });
    expect(secureGetItem("k")).toBe("v");
    expect(secureStorageStatus().plaintextKeys).toContain("k");
    expect(calls.encrypt).toBe(0);
  });

  it("解不开的信封被新值覆盖后，状态不再报无法解密", () => {
    localStorage.setItem("k", JSON.stringify({ [ENVELOPE_MARK]: ENVELOPE_VERSION, data: "garbage" }));
    installBridge();
    expect(secureGetItem("k")).toBeNull();
    expect(secureStorageStatus().undecryptableKeys).toContain("k");
    secureSetItem("k", "fresh");
    expect(secureStorageStatus().undecryptableKeys).not.toContain("k");
    expect(secureGetItem("k")).toBe("fresh");
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/web && npx vitest run src/lib/secureStorage.test.ts --no-file-parallelism`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写实现**

`packages/web/src/lib/secureStorage.ts`：

```ts
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
        undecryptableKeys.delete(key);
      } catch {
        plaintextKeys.add(key);
      }
    } else {
      plaintextKeys.add(key);
    }
  } else if (b) {
    // 桌面桥在、系统安全存储不可用：**只读的明文也要进清单**——
    // 否则「启动时读一次」的键（模型配置）永远不出现在状态卡里，降级就不可见了。
    plaintextKeys.add(key);
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
        undecryptableKeys.delete(key); // 新值已覆盖旧信封，旧“解不开”状态作废
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/web && npx vitest run src/lib/secureStorage.test.ts --no-file-parallelism`
Expected: PASS（11 例）。

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/lib/secureStorage.ts packages/web/src/lib/secureStorage.test.ts
git commit -m "feat(web): 密钥就地信封与懒迁移基础层（d.36）"
```

---

### Task 4: `store/llm.ts` 接入

**Files:**
- Modify: `packages/web/src/store/llm.ts:23-48`
- Test: `packages/web/src/store/llm.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `secureGetItem` / `secureSetItem`。
- Produces: `useLlmStore` 的对外 API 不变（`profiles` / `bindings` / `prompts` 与各 action 签名原样）。

- [ ] **Step 1: 写失败的测试**

在 `packages/web/src/store/llm.test.ts` 的 `beforeEach` 里补一行清理：

```ts
    delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
```

新增两个用例：

```ts
  it("有桌面桥时 apiKey 以信封落盘，刷新后能解密水合", async () => {
    (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = {
      available: true,
      encrypt: (plain: string) => `enc:${Buffer.from(plain, "utf8").toString("base64")}`,
      decrypt: (data: string) =>
        data.startsWith("enc:") ? Buffer.from(data.slice(4), "base64").toString("utf8") : null,
    };
    vi.resetModules();
    const fresh = await import("./llm.js");
    fresh.useLlmStore.getState().addProfile(p);

    const raw = localStorage.getItem("heming.llmConfigs")!;
    expect(JSON.parse(raw).__hemingEnc).toBe("v1");
    expect(raw).not.toContain("sk-ant-x");

    vi.resetModules();
    const again = await import("./llm.js");
    expect(again.useLlmStore.getState().profiles).toEqual([p]);
  });

  it("绑定与提示词不是凭据：仍走普通 localStorage", () => {
    (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = {
      available: true,
      encrypt: (plain: string) => `enc:${Buffer.from(plain, "utf8").toString("base64")}`,
      decrypt: (data: string) =>
        data.startsWith("enc:") ? Buffer.from(data.slice(4), "base64").toString("utf8") : null,
    };
    useLlmStore.getState().setBinding("agent-1", "p1");
    useLlmStore.getState().setPrompt("agent-1", "你是架构师");
    expect(localStorage.getItem("heming.agentLlm")).not.toContain("__hemingEnc");
    expect(localStorage.getItem("heming.agentPrompts")).not.toContain("__hemingEnc");
    expect(JSON.parse(localStorage.getItem("heming.agentLlm")!)).toEqual({ "agent-1": "p1" });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/web && npx vitest run src/store/llm.test.ts --no-file-parallelism`
Expected: FAIL —— `heming.llmConfigs` 仍是明文（`__hemingEnc` 为 undefined），刷新后信封无法水合（第一例）。

- [ ] **Step 3: 实现**

`packages/web/src/store/llm.ts` 顶部 import 后：

```ts
import { secureGetItem, secureSetItem } from "../lib/secureStorage.js";
```

把 `loadProfiles` 与 `saveProfiles` 改成：

```ts
function loadProfiles(): LlmProfile[] {
  try {
    // 只有 llmConfigs 是凭据（直连供应商的付费 Key），走系统安全存储；
    // 绑定与提示词留在普通 localStorage——它们不是凭据，没必要过 IPC。
    const raw = secureGetItem(KEY_CONFIGS);
    if (!raw) return [];
    const profiles = (JSON.parse(raw) as { profiles?: unknown }).profiles;
    return Array.isArray(profiles) ? (profiles as LlmProfile[]) : [];
  } catch {
    return []; // 损坏数据回退空（与 tokenUsage 同策略）
  }
}
```

```ts
const saveProfiles = (profiles: LlmProfile[]): void => {
  secureSetItem(KEY_CONFIGS, JSON.stringify({ profiles }));
};
```

`loadJson` / `loadRecord` / `saveRecord` 保持原样（继续服务 bindings/prompts）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/web && npx vitest run src/store/llm.test.ts --no-file-parallelism`
Expected: PASS（原 5 例 + 新 2 例）。

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/store/llm.ts packages/web/src/store/llm.test.ts
git commit -m "feat(llm): 模型连接 Key 改走系统安全存储（d.36）"
```

---

### Task 5: `lib/mcp/store.ts` 接入

**Files:**
- Modify: `packages/web/src/lib/mcp/store.ts:1-52`
- Test: `packages/web/src/lib/mcp/mcp.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `secureStorageFor`。
- Produces: `McpRegistry` 构造签名不变（仍接收 `StorageLike`），默认存储只对 `MCP_SERVERS_KEY` 加密。

- [ ] **Step 1: 写失败的测试**

在 `packages/web/src/lib/mcp/mcp.test.ts` 顶部补 import（按现有文件里已 import 的符号调整，勿重复导入）：

```ts
import { resetSecureStorageState, secureStorageFor } from "../secureStorage.js";
```

新增用例（`memStorage` 是文件里已有的内存存储工厂）：

```ts
  it("服务配置走 secure 层：servers 键是信封、tools 键是普通 JSON，重开能解回请求头", () => {
    (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = {
      available: true,
      encrypt: (plain: string) => `enc:${Buffer.from(plain, "utf8").toString("base64")}`,
      decrypt: (data: string) =>
        data.startsWith("enc:") ? Buffer.from(data.slice(4), "base64").toString("utf8") : null,
    };
    resetSecureStorageState();
    try {
      const base = memStorage();
      const reg = new McpRegistry(secureStorageFor(MCP_SERVERS_KEY, base));
      const server = reg.add({
        name: "带鉴权的服务",
        transport: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer top-secret" },
      });

      const rawServers = base.map.get(MCP_SERVERS_KEY)!;
      expect(JSON.parse(rawServers).__hemingEnc).toBe("v1");
      expect(rawServers).not.toContain("top-secret");
      expect(base.map.get(MCP_TOOLS_KEY) ?? "").not.toContain("__hemingEnc");

      const again = new McpRegistry(secureStorageFor(MCP_SERVERS_KEY, base));
      expect(again.get(server.id)?.headers?.Authorization).toBe("Bearer top-secret");
    } finally {
      delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
    }
  });

  it("解不开的服务配置不会被启动预置覆盖（密文还在，等原账户恢复）", () => {
    const base = memStorage();
    const original = JSON.stringify({ __hemingEnc: "v1", data: "garbage" });
    base.map.set(MCP_SERVERS_KEY, original);
    (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = {
      available: true,
      encrypt: (plain: string) => `enc:${Buffer.from(plain, "utf8").toString("base64")}`,
      decrypt: () => null, // 解不开
    };
    resetSecureStorageState();
    try {
      const reg = new McpRegistry(secureStorageFor(MCP_SERVERS_KEY, base));
      expect(reg.servers()).toEqual([]);
      expect(base.map.get(MCP_SERVERS_KEY)).toBe(original); // 没被预置写盘覆盖
    } finally {
      delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
      resetSecureStorageState();
    }
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/web && npx vitest run src/lib/mcp/mcp.test.ts --no-file-parallelism`
Expected: FAIL —— servers 键没有 `__hemingEnc`。

- [ ] **Step 3: 实现**

`packages/web/src/lib/mcp/store.ts` 顶部：

```ts
import { secureStorageFor, secureStorageStatus } from "../secureStorage.js";
```

把原来的 `defaultStorage()` 改名并包装：

```ts
/** 浏览器/桌面共用的 localStorage 适配：配额与隐私模式都不抛。 */
function browserStorage(): StorageLike {
  return {
    getItem: (k) => {
      try {
        return window.localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      try {
        window.localStorage.setItem(k, v);
      } catch {
        /* 配额/隐私模式：只影响持久化，不影响本次会话 */
      }
    },
    removeItem: (k) => {
      try {
        window.localStorage.removeItem(k);
      } catch {
        /* 同上 */
      }
    },
  };
}

function defaultStorage(): StorageLike {
  // 只加密服务配置（里面有用户自填的请求头 token）；
  // 工具清单/启用状态不是凭据，直通 localStorage，避免无谓的 IPC。
  return secureStorageFor(MCP_SERVERS_KEY, browserStorage());
}
```

同时给 `seedDefaults()` 加一条护栏（否则「解不开的信封」会被当成空表，启动时被预置覆盖）：

```ts
  private seedDefaults(): void {
    if (this.serverList.length > 0) return;
    // 键存在但解不开（keyring 重置 / 换系统账户 / 密文损坏）时 readServers 只能
    // 读出空表；此时若继续预置并落盘，会把用户原有服务与请求头**永久覆盖**。
    // 宁可这一轮显示空，也不动磁盘上的密文——升级回原账户还能恢复。
    if (secureStorageStatus().undecryptableKeys.includes(MCP_SERVERS_KEY)) return;
    const removed = this.readRemovedPresets();
```

（其余预置循环不变。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/web && npx vitest run src/lib/mcp/mcp.test.ts --no-file-parallelism`
Expected: PASS（原有用例 + 新 1 例）。

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/lib/mcp/store.ts packages/web/src/lib/mcp/mcp.test.ts
git commit -m "feat(mcp): 服务请求头改走系统安全存储（d.36）"
```

---

### Task 6: `lib/e2eSession.ts` 身份接入

**Files:**
- Modify: `packages/web/src/lib/e2eSession.ts:179-191`（新增 secure 版读写）、`:296`、`:318`、`:378`
- Test: `packages/web/src/lib/e2eSession.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `secureGetItem` / `secureSetItem`。
- Produces: `IDENTITY_KEY` 的读写形态改变；公开 API 不变。`CHAINS_PREFIX` / `DEFERRED_PREFIX` / `MSGCACHE_PREFIX` 行为**一字不动**。

- [ ] **Step 1: 写失败的测试**

在 `packages/web/src/lib/e2eSession.test.ts` 顶部的 import 里补 `IDENTITY_KEY` 已有，无需新增。追加用例（放在文件主 describe 内，复用 `bootstrap` / `exportOwnDeviceKeys`）：

```ts
it("桌面安全存储下设备身份加密落盘：可解、不二次加密，chains 仍是明文", async () => {
  localStorage.clear();
  registry = {};
  const calls = { encrypt: 0, decrypt: 0 };
  (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = {
    available: true,
    encrypt: (plain: string) => {
      calls.encrypt += 1;
      // 密文必须看不出原文（base64），否则 not.toContain 类断言会假失败。
      return `enc:${Buffer.from(plain, "utf8").toString("base64")}`;
    },
    decrypt: (data: string) => {
      calls.decrypt += 1;
      return data.startsWith("enc:") ? Buffer.from(data.slice(4), "base64").toString("utf8") : null;
    },
  };
  try {
    await bootstrap("secure-a");
    const raw = localStorage.getItem(IDENTITY_KEY)!;
    const envelope = JSON.parse(raw) as { __hemingEnc?: string; data?: string };
    expect(envelope.__hemingEnc).toBe("v1");
    expect(raw).not.toContain("ikEcdh");

    const keys = await exportOwnDeviceKeys();
    expect(keys.spk.pub).toBeTruthy();
    // 读信封只是解密，不会把密文再包一层
    expect((JSON.parse(localStorage.getItem(IDENTITY_KEY)!) as { data: string }).data).toBe(envelope.data);
    expect(calls.encrypt).toBe(1);

    const chainKey = Object.keys(localStorage).find((k) => k.startsWith("heming.e2e.chains."));
    expect(chainKey).toBeTruthy();
    expect(localStorage.getItem(chainKey!)).not.toContain("__hemingEnc");
  } finally {
    delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
    localStorage.removeItem(IDENTITY_KEY); // 不留信封给后续用例（无桥读信封会记 undecryptable）
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/web && npx vitest run src/lib/e2eSession.test.ts --no-file-parallelism`
Expected: FAIL —— 身份仍是明文，`__hemingEnc` 为 undefined。

- [ ] **Step 3: 实现**

`packages/web/src/lib/e2eSession.ts` 顶部 import 区：

```ts
import { secureGetItem, secureSetItem } from "./secureStorage.js";
```

在 `readJson` / `writeJson` 旁边新增（注释写明作用域）：

```ts
/** 身份键走 secure 层（凭据）；chains/deferred/msgCache 仍在下面的普通 readJson 路径。 */
function readSecureJson<T>(key: string): T | null {
  const raw = secureGetItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeSecureJson(key: string, value: unknown): void {
  secureSetItem(key, JSON.stringify(value));
}
```

三处替换：

1. `ensureIdentity` 第 296 行：
```ts
  const existing = readSecureJson<StoredIdentity>(IDENTITY_KEY);
```
2. 第 318 行：
```ts
    writeSecureJson(IDENTITY_KEY, stored);
```
3. `isForMe` **不能**直接读 secure 层——它在每个入站信封（含每个流式 chunk）上被调用，
   每次 `sendSync + DPAPI` 会把热路径拖死。改成**按原始存储值缓存 kid**：

```ts
/**
 * 身份 kid 缓存：key 为原始存储值。
 *
 * `isForMe` 在**每个入站信封**（含流式 chunk）上被调用；直接走 secure 层会让每片
 * chunk 都过一次 sendSync + DPAPI 解密——那是热路径。原始值不变时复用已算出的 kid；
 * 身份被替换（测试快照 / 重新生成）时 raw 变化，缓存自然失效。
 */
let identityKidCache: { raw: string; kid: string | null } | null = null;

function identityKidFor(raw: string): string | null {
  if (identityKidCache && identityKidCache.raw === raw) return identityKidCache.kid;
  const stored = readSecureJson<StoredIdentity>(IDENTITY_KEY);
  const kid = stored?.kid ?? null;
  identityKidCache = { raw, kid };
  return kid;
}
```

`isForMe` 里：

```ts
    const raw = localStorage.getItem(IDENTITY_KEY); // 只读原始值：廉价，不过 IPC
    if (!raw) return false;
    return identityKidFor(raw) === outer.to;
```

并在 `ensureIdentity` 写完身份后同步缓存，避免首条消息再解密一次：

```ts
    writeSecureJson(IDENTITY_KEY, stored);
    identityKidCache = { raw: localStorage.getItem(IDENTITY_KEY) ?? "", kid: stored.kid };
```

**新增一条缓存用例**（证明热路径不再逐条解密）：在测试文件 import 里补上 `isForMe`；
用例里用假桥建好身份后，取原始存储值解出 kid（`JSON.parse(Buffer.from(data.slice(4), "base64").toString("utf8"))`），
然后构造 `isForMe` 能接受的定向信封：

```ts
const envFor = (to: string) => ({
  id: `m-${to}`,
  cipher: toB64(new TextEncoder().encode(JSON.stringify({ v: 1, ek: "x", to }))),
});
const before = calls.decrypt;
expect(isForMe(envFor(stored.kid))).toBe(true);
expect(isForMe(envFor("other-device"))).toBe(false);
expect(calls.decrypt).toBe(before); // 身份写入时已缓存 ⇒ 热路径零解密
```

（存量身份升级场景首条消息会解密一次，随后同样命中缓存；这是每次启动一次的成本，可接受。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/web && npx vitest run src/lib/e2eSession.test.ts --no-file-parallelism`
Expected: PASS（原有用例全部通过 + 新 1 例）。

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/lib/e2eSession.ts packages/web/src/lib/e2eSession.test.ts
git commit -m "feat(e2e): 设备身份私钥改走系统安全存储（d.36）"
```

---

### Task 7: 设置区「密钥存储」状态卡

**Files:**
- Create: `packages/web/src/components/KeyStorageCard.tsx`
- Modify: `packages/web/src/components/SettingsPage.tsx`（import + 模型分组）
- Modify: `packages/web/src/components/LlmSettingsCard.tsx:205`（旧文案「API Key 仅存本机浏览器」与新现状冲突）
- Test: `packages/web/src/components/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: Task 3 的 `secureStorageStatus`、`secureSetItem`、`resetSecureStorageState`。
- Produces: `<KeyStorageCard />`，无 props。

- [ ] **Step 1: 写失败的测试**

`packages/web/src/components/SettingsPage.test.tsx` 顶部补 import：

```ts
import { resetSecureStorageState, secureSetItem } from "../lib/secureStorage.js";
```

新增 describe：

```tsx
describe("SettingsPage 密钥存储状态", () => {
  function stubSecrets(opts: { available?: boolean; failEncrypt?: boolean } = {}) {
    (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = {
      available: opts.available !== false,
      encrypt: (plain: string) =>
        opts.failEncrypt ? null : `enc:${Buffer.from(plain, "utf8").toString("base64")}`,
      decrypt: (data: string) =>
        data.startsWith("enc:") ? Buffer.from(data.slice(4), "base64").toString("utf8") : null,
    };
  }

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
    resetSecureStorageState();
    setToken("t1");
    useAuthStore.setState({ token: "t1", user: { ...alice }, status: "authed", error: null });
  });

  it("浏览器环境：如实说明不加密", () => {
    render(<SettingsPage />);
    goTab("模型");
    expect(screen.getByText(/浏览器端不落安全存储/)).toBeInTheDocument();
  });

  it("桌面桥可用：显示已加密与平台名", () => {
    stubSecrets();
    render(<SettingsPage />);
    goTab("模型");
    expect(screen.getByText(/密钥已用系统安全存储加密/)).toBeInTheDocument();
  });

  it("桌面桥在但加密失败：点名明文保存的键", () => {
    stubSecrets({ failEncrypt: true });
    secureSetItem("heming.llmConfigs", "{}");
    render(<SettingsPage />);
    goTab("模型");
    expect(screen.getByText(/以下密钥未能加密/)).toBeInTheDocument();
    expect(screen.getByText(/模型连接密钥/)).toBeInTheDocument();
  });

  it("系统安全存储不可用：说明新写入将明文，并点名已落明文的键", () => {
    stubSecrets({ available: false });
    secureSetItem("heming.mcp.servers.v1", "{}"); // 不可用 → 记入明文清单
    render(<SettingsPage />);
    goTab("模型");
    expect(screen.getByText(/本机安全存储不可用/)).toBeInTheDocument();
    expect(screen.getByText(/新写入的密钥将以明文保存/)).toBeInTheDocument();
    expect(screen.getByText(/MCP 服务请求头/)).toBeInTheDocument();
  });

  it("既有密文解不开时，与「新写入明文」的提示并存而不矛盾", () => {
    stubSecrets({ available: false });
    localStorage.setItem("heming.llmConfigs", JSON.stringify({ __hemingEnc: "v1", data: "x" }));
    secureSetItem("heming.mcp.servers.v1", "{}");
    render(<SettingsPage />);
    goTab("模型");
    expect(screen.getByText(/新写入的密钥将以明文保存/)).toBeInTheDocument();
    expect(screen.getByText(/无法在本机解密/)).toBeInTheDocument();
    expect(screen.getByText(/模型连接密钥/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/web && npx vitest run src/components/SettingsPage.test.tsx --no-file-parallelism`
Expected: FAIL —— 找不到这些文案。

- [ ] **Step 3: 写组件**

`packages/web/src/components/KeyStorageCard.tsx`：

```tsx
import type { SVGProps } from "react";
import { secureStorageStatus } from "../lib/secureStorage.js";

/** 三个受保护键的中文名：状态提示要能点名，不能只说「部分密钥」。 */
const KEY_LABELS: Record<string, string> = {
  "heming.llmConfigs": "模型连接密钥",
  "heming.mcp.servers.v1": "MCP 服务请求头",
  "heming.e2e.identity": "设备身份私钥",
};

function labelOf(key: string): string {
  return KEY_LABELS[key] ?? key;
}

/** 系统安全存储的名字：文案要说清楚密钥交给了谁。 */
function platformStorageName(): string {
  const platform = typeof window !== "undefined" ? window.heming?.platform : undefined;
  if (platform === "win32") return "Windows DPAPI";
  if (platform === "darwin") return "macOS 钥匙串";
  return "系统密钥环";
}

function LockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/**
 * 设置区 · 密钥存储状态（d.36）。
 *
 * 文案是**承诺的边界**：只覆盖三把钥匙，不写成「所有数据都已加密」。
 * 承诺错的地方比不承诺更糟——用户会据此决定把什么交给这个应用。
 */
export function KeyStorageCard() {
  const status = secureStorageStatus();
  const plaintext = status.plaintextKeys.map(labelOf);
  const undecryptable = status.undecryptableKeys.map(labelOf);

  let mainLine: string;
  let tone = "text-muted";
  if (!status.desktop) {
    mainLine = "浏览器端不落安全存储，密钥明文保存在浏览器本地";
  } else if (!status.available) {
    // 不可用时磁盘上可能既有明文、也有解不开的旧密文；文案必须只说「新写入」，
    // 否则会和下面「密文仍在、本机解不开」的提示自相矛盾。
    mainLine = "注意：本机安全存储不可用，新写入的密钥将以明文保存";
    if (plaintext.length > 0) mainLine += `（当前以明文保存：${plaintext.join("、")}）`;
    tone = "text-amber-700";
  } else if (plaintext.length > 0) {
    mainLine = `注意：以下密钥未能加密，以明文保存：${plaintext.join("、")}`;
    tone = "text-amber-700";
  } else {
    mainLine = `密钥已用系统安全存储加密（${platformStorageName()}）`;
  }

  return (
    <section
      aria-label="密钥存储"
      className="mt-3 max-w-[520px] rounded-xl border border-line bg-white p-4 shadow-card"
    >
      <div className="flex items-center gap-1.5 text-[12px] font-bold text-[#777]">
        <LockIcon className="text-[#999]" />
        密钥存储
      </div>
      <div className={`mt-1 text-[11px] ${tone}`}>{mainLine}</div>
      <div className="mt-1 text-[11px] text-muted">
        覆盖模型 Key、MCP 请求头与设备身份私钥；消息明文缓存与加密链状态尚未加密（后续单独处理）。
      </div>
      {undecryptable.length > 0 && (
        <div className="mt-1 text-[11px] text-amber-700">
          以下密钥无法在本机解密（密文仍在，可能来自其他设备或系统账户）：
          {undecryptable.join("、")}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: 挂到设置区**

`packages/web/src/components/SettingsPage.tsx`：

```tsx
import { KeyStorageCard } from "./KeyStorageCard.js";
```

模型分组里放在 `LlmSettingsCard` 之后（密钥状态紧挨着它保护的第一类凭据）：

```tsx
        {tab === "model" && (
          <>
            <LlmSettingsCard />
            <KeyStorageCard />
            <ContextSettingsCard />
            ...
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd packages/web && npx vitest run src/components/SettingsPage.test.tsx --no-file-parallelism`
Expected: PASS（原有用例 + 新 4 例）。

- [ ] **Step 5b: 修正 LLM 卡旧文案**

`LlmSettingsCard.tsx:205` 的「API Key 仅存本机浏览器，不上传和鸣服务端」在桌面端已经不准（现在是系统安全存储里的密文）。改成：

```tsx
      <div className="mt-1 text-[11px] text-muted">
        API Key 仅存本机（桌面端经系统安全存储加密），不上传和鸣服务端
      </div>
```

并在 SettingsPage 测试的模型分组用例里加一条断言：`getByText(/桌面端经系统安全存储加密/)`。
新增 describe 的 `afterEach` 里补 `delete window.__heming_secrets` 与 `resetSecureStorageState()`，避免假桥泄漏到同文件后续用例。

- [ ] **Step 6: 提交**

```bash
git add packages/web/src/components/KeyStorageCard.tsx packages/web/src/components/SettingsPage.tsx packages/web/src/components/SettingsPage.test.tsx
git commit -m "feat(settings): 密钥存储状态卡与三种如实文案（d.36）"
```

---

### Task 8: 版本、日志、交接文档与全量门禁

**Files:**
- Modify: 五个 `package.json`（由脚本改）
- Modify: `CHANGELOG.md`、`packages/web/src/generated/changelog.ts`（由脚本生成）
- Modify: `docs/HANDOFF.md`（§2 状态表、里程碑、§5 下一步、§6 风险）
- Modify: `docs/INDEX.md`（d.36 规格行「待实施」标记）
- Modify: `docs/superpowers/specs/2026-10-23-d36-safestorage.md`（版本行 + 实施状态）

- [ ] **Step 1: 全量门禁（提交前必须全绿）**

Run:

```bash
pnpm -r build && pnpm -r --workspace-concurrency=1 test
```

Expected: shared / server / web / desktop 四个包全部 exit 0。若 web 测试因新用例失败，回到对应 Task 修复；**不许跳过**。

- [ ] **Step 2: 升版本**

Run:

```bash
node scripts/bump-version.mjs auto feature
```

Expected: 五个包 `d.35.1.9.0 → d.36.1.9.0`（修订位保留，不归零）。

- [ ] **Step 3: 补 CHANGELOG**

在 `CHANGELOG.md` 顶部（`## d.35.1.9.0` 之前）插入：

```markdown
## d.36.1.9.0（2026-10-27）— 三把钥匙交给系统安全存储

桌面端不再把最贵的凭据明文写在 localStorage 里。

- **加密范围**：模型连接 `apiKey`、MCP 服务请求头、E2E 设备身份私钥改用 Electron
  `safeStorage`（Windows DPAPI / macOS 钥匙串 / 系统密钥环）加密，密文仍放原键位（就地信封）。
- **懒迁移**：首次读到时自动把明文改成信封；加密失败或系统安全存储不可用时**保留明文并提示**，
  绝不因迁移丢配置。浏览器端（没有安全存储）行为不变。
- **状态可见**：设置区新增「密钥存储」卡，区分「已加密 / 不可用 / 部分未加密 / 无法解密」四种状态，
  未加密的键会点名。
- **明确未覆盖**：消息明文缓存与加密链状态仍在热路径上，需要单独的搬移与原子写设计（P0-5b）。
- **回滚说明**：旧版本客户端读不懂信封，配置会显示为空（密文仍在磁盘），升级回来即恢复。
```

- [ ] **Step 4: 生成设置区更新日志**

Run: `node scripts/build-changelog.mjs`
Expected: `packages/web/src/generated/changelog.ts` 出现 d.36.1.9.0 条目。

- [ ] **Step 5: 更新交接文档**

`docs/HANDOFF.md`：
- §2 版本行改为 `d.36.1.9.0`，说明本轮是新的特性位（P0-5 `safeStorage`）。
- §2「已完成里程碑」追加第 34 条，记录加密范围、懒迁移、可见降级、未覆盖项与测试数。
- §5「下一步候选」：把「d.36 = P0-5 规格已备」改成「d.36 已完成」；下一轮指向 `research/2026-10-23-rounds-after-d36.md`，并把 P0-5b 列为独立待设计项。
- §6「分发」条目：删掉「未用 Electron safeStorage 加密落盘密钥」这句，改为「三把钥匙已加密；`msgCache` 与 `e2e.chains` 仍明文（P0-5b）」。

`docs/INDEX.md` 第 87 行：把「d.36（待实施）」改为「d.36（已实施）」，并在描述里补一句「懒迁移 + 失败保留明文」。

`docs/superpowers/specs/2026-10-23-d36-safestorage.md` 头部：把「本 spec = d.36.1.8.0」改为「本 spec = d.36.1.9.0（实施时按累计位规则取号）」。

- [ ] **Step 6: 再跑一次门禁（版本号变更后）**

Run:

```bash
pnpm -r build && pnpm -r --workspace-concurrency=1 test
```

Expected: 全绿（`version-sync.test.js` 与 `changelog-sync.test.js` 会校验五个包与生成文件一致）。

- [ ] **Step 7: 提交**

```bash
git add package.json packages/*/package.json CHANGELOG.md packages/web/src/generated/changelog.ts docs/HANDOFF.md docs/INDEX.md docs/superpowers/specs/2026-10-23-d36-safestorage.md
git commit -m "docs(release): d.36.1.9.0 三把钥匙改走系统安全存储，门禁全绿"
```

---

## 自检清单（计划写完后逐条核对过）

- 规格 §1.1 三键 / 不覆盖 msgCache+chains → Task 4/5/6 + Global Constraints。
- §1.2 就地信封 → Task 3 `envelopeOf` / `ENVELOPE_MARK`。
- §1.3 同步桥 + preload 形状 + 主进程无网络 → Task 1/2。
- §1.4 懒迁移、幂等、失败保留明文且可见 → Task 3 的四个用例 + `plaintextKeys`。
- §1.5 三个接入点 → Task 4/5/6，且 bindings/prompts、tools/enabled 明确不加密。
- §1.6 设置区三态文案 → Task 7（`⚠` 按本仓视觉规范改成「注意：」，不引入 emoji）。
- §2 风险表：旧客户端读到信封显示为空（CHANGELOG 回滚说明）；DPAPI 不可用（`available:false` 文案）；`sendSync` 前提（两处注释）；字节数变化（水位卡本就按字节统计，无需改动）。
- §3 测试计划六个文件全部覆盖。
- 版本号：当前 `d.35.1.9.0` + feature ⇒ `d.36.1.9.0`（规格写的 `d.36.1.8.0` 已过期）。
