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
});

test("preload 暴露 __heming_exports（记忆导出落盘桥）", () => {
  assert.ok(src.includes('exposeInMainWorld("__heming_exports"'));
  assert.ok(src.includes('invoke("export:write"'));
  assert.ok(src.includes('invoke("export:info"'));
});

// 行为测试：stub electron 模块的 contextBridge + ipcRenderer，真实执行 preload.js，
// 验证 contextBridge 暴露的对象上 __onBootReady/__startBootWave 为可调用函数。
// 注：preload.js 会多次调用 exposeInMainWorld（heming / __heming_ice_servers_get /
// __heming_voice_call / __heming_secrets），此处按 key 收集而非「最后一次即 heming」。
// ipcRenderer.sendSync 必须在桩里存在：preload 顶层会同步问一次密钥桥可用性。
// sink.listeners：channel → Set<listener>，用于断言订阅注册/取消；
// sink.sent：ipcRenderer.send 的调用记录，用于断言 system 通知请求。
function loadExposed(ipc = {}, sink = {}) {
  const exposed = {};
  const listeners = sink.listeners || new Map();
  const sent = sink.sent || [];
  const invoked = sink.invoked || [];
  const stubBridge = {
    exposeInMainWorld: (key, api) => {
      exposed[key] = api;
    },
  };
  const stubIpc = {
    sendSync: (channel, arg) => (typeof ipc[channel] === "function" ? ipc[channel](arg) : undefined),
    invoke: async (channel, payload) => {
      invoked.push([channel, payload]);
      return undefined;
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

// ── 本机密钥信封桥（d.36）──
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
    "secret:decrypt": (data) => (data.startsWith("enc:") ? data.slice(4) : null),
  });
  const s = exposed.__heming_secrets;
  assert.equal(s.encrypt("x"), "enc:x");
  assert.equal(s.decrypt("enc:y"), "y");

  const failing = loadExposed({ "secret:available": () => true }); // encrypt 通道缺失 → undefined
  assert.equal(failing.__heming_secrets.encrypt("x"), null);
  assert.equal(failing.__heming_secrets.decrypt("y"), null);
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
