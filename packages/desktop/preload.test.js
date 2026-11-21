"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const preloadPath = path.join(__dirname, "preload.js");
const src = fs.readFileSync(preloadPath, "utf8");

// 源码模式测试：确认暴露的接口存在
test("preload 暴露 __startBootWave 方法", () => {
  assert.ok(src.includes("__startBootWave"));
});

test("preload 暴露 __onBootReady 注册接口", () => {
  assert.ok(src.includes("__onBootReady"));
});

test("preload 暴露 platform（既有）", () => {
  assert.ok(src.includes("platform"));
});

test("preload 暴露 __mcp_stdio 与 __heming_runtime（stdio 传输与运行时探测）", () => {
  assert.ok(src.includes('exposeInMainWorld("__mcp_stdio"'));
  assert.ok(src.includes('exposeInMainWorld("__heming_runtime"'));
  assert.ok(src.includes('invoke("runtime:probe")'));
  assert.ok(src.includes('invoke("runtime:status")'), "内置运行时状态桥（d.147.4.94.11）");
});

test("__heming_runtime.status 走 runtime:status 并回传状态快照", async () => {
  const invoked = [];
  const status = {
    bundled: true,
    depsReady: true,
    python: "C:\\runtime\\python\\python.exe",
    uv: "C:\\runtime\\bin\\uvx.exe",
    runtimeDir: "C:\\runtime",
    note: "系统能力使用包内运行时，无需安装 Python 或 uv",
  };
  const exposed = loadExposed({}, { invoked, invokeResults: { "runtime:status": () => status } });
  assert.equal(typeof exposed.__heming_runtime.status, "function");
  assert.deepEqual(await exposed.__heming_runtime.status(), status);
  assert.deepEqual(invoked, [["runtime:status", undefined]]);
});

test("preload 暴露 __heming_exports（记忆导出落盘桥）", () => {
  assert.ok(src.includes('exposeInMainWorld("__heming_exports"'));
  assert.ok(src.includes('invoke("export:write"'));
  assert.ok(src.includes('invoke("export:info"'));
});

test("preload 暴露 __heming_shell.run 并转发到 shell:run（d.164）", () => {
  // 独立命名空间：命令执行与文件读写是两套权限，混在一起会让「有文件桥」被误读成「能跑命令」
  const m = src.match(/exposeInMainWorld\(\s*["']__heming_shell["']\s*,\s*\{([\s\S]*?)\}\s*\)/);
  assert.ok(m, "preload 必须暴露 __heming_shell");
  assert.ok(m[1].includes('invoke("shell:run"'), "__heming_shell.run 必须转发到 shell:run");
  assert.ok(m[1].includes('invoke("shell:cancel"'), "__heming_shell.cancel 必须转发到 shell:cancel（d.165）");
  assert.ok(m[1].includes('invoke("shell:jobs"'), "__heming_shell.jobs 必须转发到 shell:jobs（d.180）");
  assert.ok(m[1].includes('invoke("shell:job-output"'), "__heming_shell.jobOutput 必须转发到 shell:job-output（d.180）");
  assert.ok(m[1].includes('invoke("shell:job-kill"'), "__heming_shell.jobKill 必须转发到 shell:job-kill（d.180）");
  assert.ok(m[1].includes('invoke("shell:job-preview"'), "__heming_shell.jobPreview 必须转发到 shell:job-preview（d.203）");
  assert.ok(!m[1].includes("ipcRenderer.send("), "不允许用单向 send 跑命令（拿不到退出码与输出）");
});

test("__heming_shell.jobs / jobOutput / jobKill 三个后台作业转发（d.180）", async () => {
  const invoked = [];
  const exposed = loadExposed(
    {},
    {
      invoked,
      invokeResults: {
        "shell:jobs": () => ({ ok: true, jobs: [] }),
        "shell:job-output": (payload) => ({ ok: true, jobId: payload.jobId, stdout: "x" }),
        "shell:job-kill": (payload) => ({ ok: true, jobId: payload.jobId, killed: true }),
      },
    },
  );
  const shell = exposed.__heming_shell;
  assert.equal(typeof shell.jobs, "function");
  assert.equal(typeof shell.jobOutput, "function");
  assert.equal(typeof shell.jobKill, "function");
  assert.deepEqual(await shell.jobs(), { ok: true, jobs: [] });
  assert.deepEqual(await shell.jobOutput({ jobId: "job-1", waitMs: 500 }), {
    ok: true,
    jobId: "job-1",
    stdout: "x",
  });
  assert.deepEqual(await shell.jobKill({ jobId: "job-1" }), { ok: true, jobId: "job-1", killed: true });
  assert.deepEqual(invoked, [
    ["shell:jobs", undefined],
    ["shell:job-output", { jobId: "job-1", waitMs: 500 }],
    ["shell:job-kill", { jobId: "job-1" }],
  ]);
});

test("__heming_files.glob / grep 分别转发到 file:glob / file:grep", async () => {
  const invoked = [];
  const exposed = loadExposed(
    {},
    {
      invoked,
      invokeResults: {
        "file:glob": (payload) => ({ ok: true, paths: [`/库/${payload.pattern}`] }),
        "file:grep": (payload) => ({ ok: true, matches: [{ path: "/库/a.md", line: 1, text: payload.pattern }] }),
      },
    },
  );
  const bridge = exposed.__heming_files;
  assert.equal(typeof bridge.glob, "function", "桌面端应暴露 glob");
  assert.equal(typeof bridge.grep, "function", "桌面端应暴露 grep");
  assert.deepEqual(await bridge.glob({ pattern: "*.ts" }), { ok: true, paths: ["/库/*.ts"] });
  assert.deepEqual(await bridge.grep({ pattern: "needle" }), {
    ok: true,
    matches: [{ path: "/库/a.md", line: 1, text: "needle" }],
  });
  assert.deepEqual(invoked, [
    ["file:glob", { pattern: "*.ts" }],
    ["file:grep", { pattern: "needle" }],
  ]);
});

test("__heming_files.image 转发到 file:image（与 read 分开：图片是 base64 大块）", async () => {
  const invoked = [];
  const exposed = loadExposed(
    {},
    {
      invoked,
      invokeResults: {
        "file:image": (payload) => ({ ok: true, mime: "image/png", bytes: 3, base64: "AAAA", path: payload.path }),
      },
    },
  );
  const bridge = exposed.__heming_files;
  assert.equal(typeof bridge.image, "function", "桌面端应暴露 image");
  assert.deepEqual(await bridge.image({ path: "D:/库/a.png" }), {
    ok: true,
    mime: "image/png",
    bytes: 3,
    base64: "AAAA",
    path: "D:/库/a.png",
  });
  assert.deepEqual(invoked, [["file:image", { path: "D:/库/a.png" }]]);
});

test("__heming_files.undo 转发到 file:undo（撤销上一次写入）", async () => {
  const invoked = [];
  const exposed = loadExposed(
    {},
    {
      invoked,
      invokeResults: {
        "file:undo": (payload) => ({ ok: true, path: payload.path, restoredFrom: "2026-11-16T05:00:00.000Z", bytes: 12 }),
      },
    },
  );
  const bridge = exposed.__heming_files;
  assert.equal(typeof bridge.undo, "function", "桌面端应暴露 undo");
  assert.deepEqual(await bridge.undo({ path: "D:/库/a.md" }), {
    ok: true,
    path: "D:/库/a.md",
    restoredFrom: "2026-11-16T05:00:00.000Z",
    bytes: 12,
  });
  assert.deepEqual(invoked, [["file:undo", { path: "D:/库/a.md" }]]);
});

test("__heming_files.backups 转发到 file:backups（最近改动列表）", async () => {
  const invoked = [];
  const exposed = loadExposed(
    {},
    {
      invoked,
      invokeResults: {
        "file:backups": () => ({ ok: true, items: [{ path: "D:/库/a.md", at: "2026-11-16T05:00:00.000Z", bytes: 9 }] }),
      },
    },
  );
  const bridge = exposed.__heming_files;
  assert.equal(typeof bridge.backups, "function", "桌面端应暴露 backups");
  const list = await bridge.backups({ roots: [] });
  assert.equal(list.ok, true);
  assert.equal(list.items.length, 1);
  assert.deepEqual(invoked, [["file:backups", { roots: [] }]]);
});

test("__heming_files.backupPreview 转发到 file:backup-preview（预览改动，只读）", async () => {
  const invoked = [];
  const exposed = loadExposed(
    {},
    {
      invoked,
      invokeResults: {
        "file:backup-preview": () => ({ ok: true, path: "D:/库/a.md", at: "2026-11-16T05:00:00.000Z", bytes: 9, truncated: false, binary: false, text: "旧内容\n" }),
      },
    },
  );
  const bridge = exposed.__heming_files;
  assert.equal(typeof bridge.backupPreview, "function", "桌面端应暴露 backupPreview");
  const res = await bridge.backupPreview({ roots: [], path: "D:/库/a.md" });
  assert.equal(res.ok, true);
  assert.equal(res.text, "旧内容\n");
  assert.deepEqual(invoked, [["file:backup-preview", { roots: [], path: "D:/库/a.md" }]]);
});

test("__heming_files.defaultRootPath：加载时同步取默认工作区；取不到为 null 且不抛", () => {
  const withSync = loadExposed({ "file:default-root": () => ({ ok: true, path: "D:/文档/和鸣" }) });
  assert.equal(withSync.__heming_files.defaultRootPath, "D:/文档/和鸣");

  // 老 Electron / 测试桩没有 sendSync：preload 必须照常加载，字段为 null
  const noSync = loadExposed({}, { noSendSync: true });
  assert.equal(typeof noSync.__heming_files.defaultRoot, "function");
  assert.equal(noSync.__heming_files.defaultRootPath, null);

  // 主进程拒绝（非可信来源）或返回值形状不对：同样按「没有」处理
  const denied = loadExposed({ "file:default-root": () => ({ ok: false, error: "untrusted-sender" }) });
  assert.equal(denied.__heming_files.defaultRootPath, null);
  const malformed = loadExposed({ "file:default-root": () => ({ ok: true, path: 42 }) });
  assert.equal(malformed.__heming_files.defaultRootPath, null);
});

test("__heming_files.defaultRoot() 转发到 file:default-root", async () => {
  const invoked = [];
  const exposed = loadExposed(
    {},
    { invoked, invokeResults: { "file:default-root": () => ({ ok: true, path: "D:/文档/和鸣" }) } },
  );
  const bridge = exposed.__heming_files;
  assert.equal(typeof bridge.defaultRoot, "function");
  assert.deepEqual(await bridge.defaultRoot(), { ok: true, path: "D:/文档/和鸣" });
  assert.deepEqual(invoked, [["file:default-root", undefined]]);
});

// 行为测试：stub electron 模块的 contextBridge + ipcRenderer，真实执行 preload.js，
// 验证 contextBridge 暴露的对象上 __onBootReady/__startBootWave 为可调用函数。
// 注：preload.js 会多次调用 exposeInMainWorld（heming / __heming_secrets 等），
// 此处按 key 收集而非「最后一次即 heming」。
// ipcRenderer.sendSync 默认在桩里提供：preload 顶层会同步问密钥桥可用性与默认工作区路径；
// sink.noSendSync 用于模拟老 Electron 没有同步桥，验证 preload 仍能加载。
// sink.listeners：channel → Set<listener>，用于断言订阅注册/取消；
// sink.sent：ipcRenderer.send 的调用记录，用于断言 system 通知请求；
// sink.invokeResults：channel → fn(payload)，给异步通道（secret:bootstrap 等）返回结果；
// sink.secretStorage：假 localStorage（启动预取要读三个白名单键的信封）。
function loadExposed(ipc = {}, sink = {}) {
  const exposed = {};
  const listeners = sink.listeners || new Map();
  const sent = sink.sent || [];
  const invoked = sink.invoked || [];
  const invokeResults = sink.invokeResults || {};
  // preload 的启动预取需要读 localStorage（只读信封）；测试按用例注入。
  const storage = sink.secretStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.window = { localStorage: storage };
  const stubBridge = {
    exposeInMainWorld: (key, api) => {
      exposed[key] = api;
    },
  };
  const stubIpc = {
    ...(sink.noSendSync
      ? {}
      : { sendSync: (channel, arg) => (typeof ipc[channel] === "function" ? ipc[channel](arg) : undefined) }),
    invoke: async (channel, payload) => {
      invoked.push([channel, payload]);
      const handler = invokeResults[channel];
      return typeof handler === "function" ? handler(payload) : undefined;
    },
    send: (channel, ...args) => {
      sent.push([channel, ...args]);
    },
    on: (channel, fn) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(fn);
    },
    removeListener: (channel, fn) => {
      const set = listeners.get(channel);
      if (set) set.delete(fn);
    },
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

test("暴露的 __onBootReady/__startBootWave 是可调用函数", () => {
  const heming = loadHeming();
  assert.equal(typeof heming.__onBootReady, "function");
  assert.equal(typeof heming.__startBootWave, "function");
});

test("__startBootWave 触发 __onBootReady 注册的回调", () => {
  const heming = loadHeming();
  let called = 0;
  heming.__onBootReady(() => { called++; });
  heming.__startBootWave();
  assert.equal(called, 1);
});

test("__startBootWave 无回调时不抛错", () => {
  const heming = loadHeming();
  assert.doesNotThrow(() => { heming.__startBootWave(); });
});

test("重复注册只保留最后一次回调", () => {
  const heming = loadHeming();
  let first = 0;
  let second = 0;
  heming.__onBootReady(() => { first++; });
  heming.__onBootReady(() => { second++; });
  heming.__startBootWave();
  assert.equal(first, 0);
  assert.equal(second, 1);
});

// ── 信号缓冲：主进程 did-finish-load 与 React 挂载注册是竞态，先发的信号不能丢 ──
test("信号先到、回调后注册：注册时立即补发（不丢这次启动动画）", () => {
  const heming = loadHeming();
  // 主进程先发信号（此时 web 端还没挂载 BootWave、没注册回调）
  assert.doesNotThrow(() => { heming.__startBootWave(); });
  // 随后 BootWave 挂载注册：必须立刻收到补发的信号
  let called = 0;
  heming.__onBootReady(() => { called++; });
  assert.equal(called, 1);
});

test("信号后注册的回调只补发一次（再调 __startBootWave 才再触发）", () => {
  const heming = loadHeming();
  heming.__startBootWave();
  let called = 0;
  heming.__onBootReady(() => { called++; });
  assert.equal(called, 1);
  heming.__startBootWave();
  assert.equal(called, 2);
});

test("信号未到时注册：__onBootReady 不当场回调（只等 __startBootWave）", () => {
  const heming = loadHeming();
  let called = 0;
  heming.__onBootReady(() => { called++; });
  assert.equal(called, 0);
  heming.__startBootWave();
  assert.equal(called, 1);
});

test("__onBootReady 收到非函数参数时忽略（不抛出、不污染已有回调）", () => {
  const heming = loadHeming();
  let called = 0;
  heming.__onBootReady(() => { called++; });
  assert.doesNotThrow(() => {
    heming.__onBootReady(null);
    heming.__onBootReady(undefined);
    heming.__onBootReady("not a function");
  });
  // 已有回调未被非函数参数覆盖，仍能被信号触发
  heming.__startBootWave();
  assert.equal(called, 1);
});

// sandbox 的 preload 只能 require electron 与少数内置模块；一旦再写本地 require，
// 整个 preload 会在真实 Electron 里加载失败，所有桥（含密钥/通知）一起消失。
test("preload 不 require 本地模块（sandbox 约束）", () => {
  assert.ok(!/require\(["']\.\.?\//.test(src), "sandbox preload 不允许本地 require");
});

test("版本号经主进程同步 IPC 获取；通道缺失回落到 0.0.0", () => {
  assert.equal(loadExposed({ "app:version": () => "d.45.1.12.0" }).__heming_version, "d.45.1.12.0");
  assert.equal(loadExposed().__heming_version, "0.0.0");
});

// ── 本机密钥信封桥（d.36；d.58 异步优先 + 预取缓存）──
test("preload 暴露 __heming_secrets（密钥信封桥）与 d.58 异步/缓存接口", () => {
  const exposed = loadExposed({ "secret:available": () => true });
  const s = exposed.__heming_secrets;
  assert.ok(s, "应暴露 __heming_secrets");
  assert.equal(s.available, true);
  assert.equal(typeof s.encrypt, "function");
  assert.equal(typeof s.decrypt, "function");
  // d.58：异步优先 + 预取缓存
  for (const fn of ["availableAsync", "encryptAsync", "decryptAsync", "bootstrap", "cachedRead", "cacheSet", "cacheDelete"]) {
    assert.equal(typeof s[fn], "function", `${fn} 应是函数`);
  }
  assert.ok(s.ready && typeof s.ready.then === "function", "ready 应是 Promise");
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
    "secret:decrypt": (data) => (data.startsWith("enc:") ? data.slice(4) : null),
  });
  const s = exposed.__heming_secrets;
  assert.equal(s.encrypt("x"), "enc:x");
  assert.equal(s.decrypt("enc:y"), "y");

  const failing = loadExposed({ "secret:available": () => true }); // encrypt 通道缺失 → undefined
  assert.equal(failing.__heming_secrets.encrypt("x"), null);
  assert.equal(failing.__heming_secrets.decrypt("y"), null);
});

/** 造一个只读的假 localStorage（够 preload 启动预取使用）。 */
function fakeStorage(entries) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const ASYNC_CAPS = {
  "secret:capabilities": () => ({ mode: "async", sync: false, async: true }),
  "secret:available": () => false,
};

test("启动预取：只把三个白名单键的**信封**送进批量通道，并把明文放进缓存", async () => {
  const invoked = [];
  const storage = fakeStorage({
    "heming.llmConfigs": JSON.stringify({ __hemingEnc: "v1", data: "cipher-llm" }),
    "heming.mcp.servers.v1": JSON.stringify({ __hemingEnc: "v1", data: "cipher-mcp" }),
    // 以下都不该进批量通道：非白名单键 / 明文键 / 坏 JSON
    "heming.e2e.chains.c1": JSON.stringify({ __hemingEnc: "v1", data: "cipher-chain" }),
    "heming.e2e.identity": "明文身份（迁移期）",
    "heming.msgCache.c1": "{ 不是 json",
  });
  const exposed = loadExposed(ASYNC_CAPS, {
    invoked,
    secretStorage: storage,
    invokeResults: {
      "secret:bootstrap": (payload) => ({
        available: true,
        mode: "async",
        plaintexts: payload.entries.map((entry) => ({ key: entry.key, value: `plain-of-${entry.key}` })),
      }),
    },
  });
  const s = exposed.__heming_secrets;
  const state = await s.ready;
  assert.equal(state.hydrated, true);
  assert.equal(state.available, true);
  assert.equal(state.mode, "async");

  const bootstrapCall = invoked.find(([channel]) => channel === "secret:bootstrap");
  assert.ok(bootstrapCall, "应发起一次批量预取");
  assert.deepEqual(
    bootstrapCall[1].entries.map((entry) => entry.key).sort(),
    ["heming.llmConfigs", "heming.mcp.servers.v1"],
  );
  assert.equal(s.cachedRead("heming.llmConfigs"), "plain-of-heming.llmConfigs");
  assert.equal(s.cachedRead("heming.mcp.servers.v1"), "plain-of-heming.mcp.servers.v1");
  // 未预取的键：undefined（= 未命中，回退同步桥），不是 null（= 解不开）
  assert.equal(s.cachedRead("heming.e2e.identity"), undefined);
});

test("启动预取：批量通道失败/不可用时也 resolve（hydrated:false），不阻塞启动", async () => {
  const exposed = loadExposed(ASYNC_CAPS, {
    secretStorage: fakeStorage({
      "heming.llmConfigs": JSON.stringify({ __hemingEnc: "v1", data: "cipher-llm" }),
    }),
    invokeResults: {
      "secret:bootstrap": () => {
        throw new Error("IPC 炸了");
      },
    },
  });
  const state = await exposed.__heming_secrets.ready;
  assert.equal(state.hydrated, false);
  assert.equal(exposed.__heming_secrets.cachedRead("heming.llmConfigs"), undefined);
});

test("启动预取：没有异步能力（旧版 Electron）时直接跳过，不发起批量 IPC", async () => {
  const invoked = [];
  const exposed = loadExposed(
    { "secret:capabilities": () => ({ mode: "sync", sync: true, async: false }), "secret:available": () => true },
    { invoked, secretStorage: fakeStorage({}) },
  );
  const state = await exposed.__heming_secrets.ready;
  assert.equal(state.hydrated, false);
  assert.equal(state.mode, "sync");
  assert.equal(invoked.filter(([channel]) => channel === "secret:bootstrap").length, 0);
});

test("缓存写入/失效只对三个白名单键生效", () => {
  const storage = fakeStorage({});
  const exposed = loadExposed(ASYNC_CAPS, { secretStorage: storage });
  const s = exposed.__heming_secrets;
  s.cacheSet("heming.llmConfigs", "新值");
  assert.equal(s.cachedRead("heming.llmConfigs"), "新值");
  s.cacheSet("heming.e2e.chains.c1", "不该进缓存");
  assert.equal(s.cachedRead("heming.e2e.chains.c1"), undefined);
  s.cacheSet("heming.llmConfigs", 42); // 非字符串：忽略
  assert.equal(s.cachedRead("heming.llmConfigs"), "新值");
  s.cacheDelete("heming.llmConfigs");
  assert.equal(s.cachedRead("heming.llmConfigs"), undefined);
});

test("异步 API 经 invoke 转发到对应通道", async () => {
  const invoked = [];
  const exposed = loadExposed(ASYNC_CAPS, {
    invoked,
    invokeResults: {
      "secret:availableAsync": () => true,
      "secret:encryptAsync": (plain) => `enc:${plain}`,
      "secret:decryptAsync": (data) => `plain:${data}`,
    },
  });
  const s = exposed.__heming_secrets;
  assert.equal(await s.availableAsync(), true);
  assert.equal(await s.encryptAsync("x"), "enc:x");
  assert.equal(await s.decryptAsync("y"), "plain:y");
  assert.deepEqual(
    invoked.slice(-3).map(([channel]) => channel),
    ["secret:availableAsync", "secret:encryptAsync", "secret:decryptAsync"],
  );
});

// ── 系统通知桥（d.39）──
test("preload 暴露 __heming_notify（系统通知桥）并可取消订阅", () => {
  const listeners = new Map();
  const sent = [];
  const exposed = loadExposed({}, { listeners, sent });
  const bridge = exposed.__heming_notify;
  assert.ok(bridge, "应暴露 __heming_notify");
  assert.equal(typeof bridge.message, "function");
  assert.equal(typeof bridge.onOpen, "function");

  const payload = { title: "鲍勃", body: "你有一条新消息", conversationId: "c1" };
  bridge.message(payload);
  assert.deepEqual(sent[0], ["notify:message", payload]);

  const received = [];
  const off = bridge.onOpen((id) => received.push(id));
  assert.equal(typeof off, "function");
  const set = listeners.get("notify:open");
  assert.ok(set && set.size === 1, "onOpen 应注册 notify:open 监听");
  for (const fn of [...set]) fn({}, "c1");
  for (const fn of [...set]) fn({}, undefined); // 主进程未带回会话 id 时回落 null
  assert.deepEqual(received, ["c1", null]);

  off();
  assert.equal(listeners.get("notify:open").size, 0, "取消订阅应移除 notify:open 监听");
});

test("__heming_update.subscribe 收到非函数回调时安全忽略（d.412 回归）", () => {
  const listeners = new Map();
  const bridge = loadExposed({}, { listeners }).__heming_update;
  assert.doesNotThrow(() => {
    const off = bridge.subscribe(null);
    assert.equal(typeof off, "function");
    off();
  });
  assert.equal((listeners.get("update:state") || new Set()).size, 0, "非函数回调不应注册监听");
});

test("__heming_notify.onOpen 收到非函数回调时安全忽略", () => {
  const listeners = new Map();
  const bridge = loadExposed({}, { listeners }).__heming_notify;
  assert.doesNotThrow(() => {
    const off = bridge.onOpen(null);
    assert.equal(typeof off, "function");
    off();
  });
  assert.equal((listeners.get("notify:open") || new Set()).size, 0, "非函数回调不应注册监听");
});

// ── 界面插件桥（d.98：桌宠拆成插件后，主窗只剩安装/管理面）──
test("主窗暴露 __heming_widgets，且只调用 widgets: 前缀通道", async () => {
  const sent = [];
  const invoked = [];
  const bridge = loadExposed({}, { sent, invoked }).__heming_widgets;
  assert.ok(bridge, "应暴露 __heming_widgets");
  for (const fn of [
    "list",
    "pickPackage",
    "install",
    "installFromFile",
    "uninstall",
    "setEnabled",
    "settingsGet",
    "settingsSet",
    "action",
    "state",
    "pageOpen",
    "pageClose",
    "pageCall",
    "pageSend",
    "onPageEvent",
    "publish",
    "migrateLegacy",
    "onOpenPage",
    "onChatConfigRequest",
    "replyChatConfig",
  ]) {
    assert.equal(typeof bridge[fn], "function", `${fn} 应是函数`);
  }

  bridge.list();
  assert.deepEqual(invoked.at(-1), ["widgets:list", undefined]);
  bridge.action({ id: "heming.pet", action: "show" });
  assert.deepEqual(invoked.at(-1), ["widgets:action", { id: "heming.pet", action: "show" }]);
  bridge.setEnabled({ id: "heming.pet", enabled: false });
  assert.deepEqual(invoked.at(-1), ["widgets:setEnabled", { id: "heming.pet", enabled: false }]);
  bridge.publish({ kind: "notify", title: "任务完成" });
  assert.deepEqual(sent.at(-1), ["widgets:publish", { kind: "notify", title: "任务完成" }]);
  bridge.replyChatConfig("cc-1", { agents: [], binding: { agentId: null } });
  assert.deepEqual(invoked.at(-1), [
    "widgets:chat-config-reply",
    { requestId: "cc-1", config: { agents: [], binding: { agentId: null } } },
  ]);

  // d.141：页面改成渲染层 iframe（打开/关闭 invoke+send，帧内 RPC 走 call/send，事件中继单向）
  bridge.pageOpen({ id: "acme.page", intent: "agenda" });
  assert.deepEqual(invoked.at(-1), ["widgets:page-open", { id: "acme.page", intent: "agenda" }]);
  bridge.pageCall({ id: "acme.page", method: "info" });
  assert.deepEqual(invoked.at(-1), ["widgets:page-call", { id: "acme.page", method: "info" }]);
  bridge.pageSend({ id: "acme.page", method: "log", payload: "hi" });
  assert.deepEqual(sent.at(-1), ["widgets:page-send", { id: "acme.page", method: "log", payload: "hi" }]);
  bridge.pageClose();
  assert.deepEqual(sent.at(-1), ["widgets:page-close"]);

  // 所有通道都必须落在 widgets: 前缀（主窗专用；不会误用 widget 窗口的通道）
  for (const [channel] of [...sent, ...invoked]) {
    assert.ok(channel.startsWith("widgets:"), `主窗桥不应调非 widgets: 通道：${channel}`);
  }
});

test("主窗 onOpenPage / onChatConfigRequest：非函数回调不注册监听，返回取消订阅", () => {
  const listeners = new Map();
  const bridge = loadExposed({}, { listeners }).__heming_widgets;
  assert.doesNotThrow(() => {
    assert.equal(typeof bridge.onOpenPage(null), "function");
    assert.equal(typeof bridge.onChatConfigRequest(null), "function");
  });
  const received = [];
  const off = bridge.onOpenPage((payload) => received.push(payload));
  const on = bridge.onChatConfigRequest((payload) => received.push(payload));
  const event = { sender: { id: 1 } };
  listeners.get("widgets:open-page").forEach((fn) => fn(event, { page: "settings" }));
  listeners.get("widgets:chat-config-request").forEach((fn) => fn(event, { requestId: "cc-9" }));
  assert.deepEqual(received, [{ page: "settings" }, { requestId: "cc-9" }]);
  off();
  on();
  assert.equal(listeners.get("widgets:open-page").size, 0);
  assert.equal(listeners.get("widgets:chat-config-request").size, 0);
});

// ── 信息中枢 · InfoHub 本机桥（d.45）──
test("preload 暴露 __heming_infohub，call 只转发 home/python 两个配置字段", async () => {
  const invoked = [];
  const bridge = loadExposed({}, { invoked }).__heming_infohub;
  assert.ok(bridge, "应暴露 __heming_infohub");
  for (const fn of ["info", "start", "call", "stop", "pickHome", "pickPython", "onEvent"]) {
    assert.equal(typeof bridge[fn], "function", `${fn} 应是函数`);
  }

  await bridge.call("conversations", { limit: 5 }, { home: "D:\\wohaolei", python: "D:\\py.exe", extra: "忽略" });
  assert.deepEqual(invoked.at(-1), [
    "infohub:call",
    { method: "conversations", params: { limit: 5 }, home: "D:\\wohaolei", python: "D:\\py.exe" },
  ]);

  await bridge.call("status", null, null);
  assert.deepEqual(invoked.at(-1), ["infohub:call", { method: "status", params: null, home: undefined, python: undefined }]);

  await bridge.pickHome();
  await bridge.pickPython();
  await bridge.stop();
  assert.deepEqual(
    invoked.slice(-3).map(([channel]) => channel),
    ["infohub:pick-home", "infohub:pick-python", "infohub:stop"]
  );
});

test("__heming_infohub.onEvent 订阅可取消，非函数回调不注册", () => {
  const listeners = new Map();
  const bridge = loadExposed({}, { listeners }).__heming_infohub;
  const received = [];
  const off = bridge.onEvent((event) => received.push(event));
  const set = listeners.get("infohub:event");
  assert.ok(set && set.size === 1);
  for (const fn of [...set]) fn({}, { event: "progress", phase: "sync", current: 1, total: 3 });
  assert.deepEqual(received, [{ event: "progress", phase: "sync", current: 1, total: 3 }]);
  off();
  assert.equal(set.size, 0);

  assert.doesNotThrow(() => {
    const noop = bridge.onEvent("not a function");
    noop();
  });
  assert.equal((listeners.get("infohub:event") || new Set()).size, 0);
});

// ── 工作区选目录（d.147.4.91.11）：只回传绝对路径，不读目录 ──

test("pickDirectory 走 app:pickDirectory 通道并回传路径", async () => {
  const invoked = [];
  const heming = loadExposed({}, { invoked, invokeResults: { "app:pickDirectory": () => "D:/项目/和鸣" } }).heming;
  assert.equal(typeof heming.pickDirectory, "function");
  const result = await heming.pickDirectory("选择工作区");
  assert.equal(result, "D:/项目/和鸣");
  assert.deepEqual(invoked.at(-1), ["app:pickDirectory", "选择工作区"]);
});

test("pickDirectory 用户取消时原样回传 null（不报错）", async () => {
  // 取消路径由主进程的 handler 归一到 null；这里 mock 掉的正是那个返回值。
  const heming = loadExposed({}, { invokeResults: { "app:pickDirectory": () => null } }).heming;
  assert.equal(await heming.pickDirectory(), null);
});

test("__heming_files.reveal 转发到 file:reveal（在文件夹里显示，d.234）", async () => {
  const invoked = [];
  const exposed = loadExposed(
    {},
    {
      invoked,
      invokeResults: {
        "file:reveal": () => ({ ok: true, kind: "file", path: "D:/库/a.md" }),
      },
    },
  );
  const bridge = exposed.__heming_files;
  assert.equal(typeof bridge.reveal, "function", "桌面端应暴露 reveal");
  const res = await bridge.reveal({ roots: [], path: "D:/库/a.md" });
  assert.equal(res.ok, true);
  assert.equal(res.kind, "file");
  assert.deepEqual(invoked, [["file:reveal", { roots: [], path: "D:/库/a.md" }]]);
});
