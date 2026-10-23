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

// 行为测试：stub electron 模块的 contextBridge，真实执行 preload.js，
// 验证 contextBridge 暴露的对象上 __onBootReady/__startBootWave 为可调用函数。
// 注：preload.js 会多次调用 exposeInMainWorld（heming / __heming_ice_servers_get /
// __heming_voice_call），此处按 key 收集而非「最后一次即 heming」。
function loadHeming() {
  const exposed = {};
  const stubBridge = {
    exposeInMainWorld: (key, api) => {
      exposed[key] = api;
    }
  };
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") {
      return { contextBridge: stubBridge };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve(preloadPath)];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }
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
