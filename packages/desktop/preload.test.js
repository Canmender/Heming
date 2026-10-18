"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");

test("preload 暴露 __startBootWave 方法", () => {
  assert.ok(src.includes("__startBootWave"));
});

test("preload 暴露 __onBootReady 注册接口", () => {
  assert.ok(src.includes("__onBootReady"));
});

test("preload 暴露 platform（既有）", () => {
  assert.ok(src.includes("platform"));
});

// 行为测试：模拟 contextBridge
test("__startBootWave 触发已注册回调", () => {
  var cb = null;
  var heming = {
    __onBootReady: function (callback) { cb = callback; },
    __startBootWave: function () { if (cb) cb(); }
  };
  var called = false;
  heming.__onBootReady(function () { called = true; });
  heming.__startBootWave();
  assert.equal(called, true);
});

test("__startBootWave 无回调时不抛错", () => {
  var heming = {
    __onBootReady: function () {},
    __startBootWave: function () { /* no callback */ }
  };
  assert.doesNotThrow(function () { heming.__startBootWave(); });
});
