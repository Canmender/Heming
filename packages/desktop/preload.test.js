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

// 行为测试：stub electron 模块的 contextBridge，真实执行 preload.js，
// 验证 contextBridge 暴露的对象上 __onBootReady/__startBootWave 为可调用函数。
function loadHeming() {
  let exposed = null;
  const stubBridge = {
    exposeInMainWorld: (key, api) => {
      exposed = { key, api };
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
  assert.equal(exposed.key, "heming");
  return exposed.api;
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
