"use strict";
/**
 * 界面插件「可跳转页面」白名单的**单一真源守卫**。
 *
 * 真源在 shared：`packages/shared/src/plugin/widget.ts` 的 `WIDGET_ALLOWED_PAGES`
 * （`WidgetPage` 类型由它派生）。但主进程是 CommonJS、不直接 import shared 构建产物，
 * 所以两处运行期副本必须手工同步：
 * - `plugin-window.js` 的 `WIDGET_PAGE_ALLOWLIST`（清单侧归一化）；
 * - `main.js` 的 `widget:open-page` 校验数组（IPC 侧二次收紧）。
 *
 * 本用例读源码逐项比对：任何一处多一个/少一个都红，避免「加了新页面但跳不过去」。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..", "..");
const SHARED_WIDGET = join(ROOT, "packages", "shared", "src", "plugin", "widget.ts");
const PLUGIN_WINDOW = join(__dirname, "plugin-window.js");
const MAIN = join(__dirname, "main.js");

/** 从 shared 的 `export const WIDGET_ALLOWED_PAGES = ["a", "b"] as const;` 取名单。 */
function sharedPages() {
  const source = readFileSync(SHARED_WIDGET, "utf8");
  const match = /export const WIDGET_ALLOWED_PAGES\s*=\s*\[([^\]]*)\]\s*as const;/.exec(source);
  assert.ok(match, "shared/widget.ts 里找不到 WIDGET_ALLOWED_PAGES 定义");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** `plugin-window.js`：`const WIDGET_PAGE_ALLOWLIST = Object.freeze(["a", ...]);` */
function pluginWindowPages() {
  const source = readFileSync(PLUGIN_WINDOW, "utf8");
  const match = /const WIDGET_PAGE_ALLOWLIST\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/.exec(source);
  assert.ok(match, "plugin-window.js 里找不到 WIDGET_PAGE_ALLOWLIST");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** `main.js`：`const page = ["settings", ...].includes(payload.page) ? ...` */
function mainPages() {
  const source = readFileSync(MAIN, "utf8");
  const match = /\[([^\]]*)\]\.includes\(payload\.page\)/.exec(source);
  assert.ok(match, "main.js 里找不到 widget:open-page 的页面白名单数组");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test("三处页面白名单逐项一致（shared 是唯一真源）", () => {
  const shared = sharedPages();
  assert.ok(shared.length > 0);
  assert.deepEqual(pluginWindowPages(), shared, "plugin-window.js 的白名单与 shared 不一致");
  assert.deepEqual(mainPages(), shared, "main.js 的白名单与 shared 不一致");
});

test("白名单非空且无重复（空名单会让 openPage 全部失效）", () => {
  const shared = sharedPages();
  assert.ok(shared.length > 0);
  assert.equal(new Set(shared).size, shared.length);
});
