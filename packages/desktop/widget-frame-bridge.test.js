"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const bridgePath = path.join(__dirname, "widget-frame-bridge.js");
const bridgeSource = fs.readFileSync(bridgePath, "utf8");

/**
 * 在 vm 里跑真实的 widget-frame-bridge.js（它就是纯浏览器 JS，没有 require），
 * 用一个最小的假 window 捕获它发给宿主的 postMessage。
 *
 * `topLevel: true` 时 `window.parent === window`（模拟插件页被直接打开，不是 iframe）。
 */
function loadBridge(options = {}) {
  const posted = [];
  const listeners = [];
  const reloads = [];
  const windowObject = {
    addEventListener: (type, listener) => {
      if (type === "message") listeners.push(listener);
    },
    location: {
      reload: () => reloads.push("reload"),
    },
  };
  if (options.existing) windowObject.__heming_widget = { existing: true };
  const parent = {
    // 跨 vm realm 的对象原型不同，深比较会失败；先做一次 JSON 往返拿回本 realm 的值
    postMessage: (message, targetOrigin) => posted.push({ message: JSON.parse(JSON.stringify(message)), targetOrigin }),
  };
  windowObject.parent = options.topLevel ? windowObject : parent;

  const sandbox = { window: windowObject, console };
  vm.createContext(sandbox);
  vm.runInContext(bridgeSource, sandbox);

  const deliver = (data, source) => {
    for (const listener of listeners) listener({ data, source: source === undefined ? parent : source });
  };

  return { window: windowObject, posted, reloads, listeners, deliver };
}

function calls(host) {
  return host.posted.map((entry) => entry.message).filter((message) => message.kind === "call");
}

test("自守卫：已有 window.__heming_widget 时什么都不做（不覆盖、不发 ready）", () => {
  const host = loadBridge({ existing: true });
  assert.deepEqual(host.window.__heming_widget, { existing: true });
  assert.equal(host.posted.length, 0);
  assert.equal(host.listeners.length, 0);
});

test("自守卫：顶层打开（window.parent === window）不暴露桥、不发 ready", () => {
  const host = loadBridge({ topLevel: true });
  assert.equal(host.window.__heming_widget, undefined);
  assert.equal(host.posted.length, 0);
  assert.equal(host.listeners.length, 0);
});

test("握手：注入后立刻向宿主发一条带协议的 ready", () => {
  const host = loadBridge();
  assert.equal(host.posted.length, 1);
  assert.equal(host.posted[0].targetOrigin, "*");
  assert.deepEqual(host.posted[0].message, { __heming_frame: 1, kind: "ready" });
  assert.ok(host.window.__heming_widget, "应暴露 __heming_widget");
});

test("invoke：发 {kind:'call', id, method, args}，宿主回 result 后 resolve", async () => {
  const host = loadBridge();
  const promise = host.window.__heming_widget.info();
  const [message] = calls(host);
  assert.equal(message.__heming_frame, 1);
  assert.equal(message.kind, "call");
  assert.equal(message.method, "info");
  assert.equal(typeof message.id, "number");
  assert.ok(message.id > 0);
  assert.deepEqual(message.args, []);

  host.deliver({ __heming_frame: 1, kind: "result", id: message.id, ok: true, value: { pluginId: "acme.page" } });
  assert.deepEqual(await promise, { pluginId: "acme.page" });
});

test("invoke：宿主回 {ok:false} 时 reject 出带 code 的错误；缺 code 有兜底", async () => {
  const host = loadBridge();
  const first = host.window.__heming_widget.settings();
  const message = calls(host).at(-1);
  host.deliver({
    __heming_frame: 1,
    kind: "result",
    id: message.id,
    ok: false,
    error: { code: "ERR_WIDGET_PAGE_SCOPE", message: "不是当前页面" },
  });
  await assert.rejects(first, (error) => error.code === "ERR_WIDGET_PAGE_SCOPE" && /不是当前页面/.test(error.message));

  const second = host.window.__heming_widget.dataKeys();
  const secondMessage = calls(host).at(-1);
  host.deliver({ __heming_frame: 1, kind: "result", id: secondMessage.id, ok: false });
  await assert.rejects(second, (error) => error.code === "ERR_WIDGET_PAGE_CALL_FAILED");
});

test("invoke：只认 window.parent 的消息，冒充宿主 / 版本不对的回包一律忽略", async () => {
  const host = loadBridge();
  const promise = host.window.__heming_widget.engineStatus();
  const message = calls(host).at(-1);

  // 不是 parent 发来的（页面里别的 frame/worker）
  host.deliver({ __heming_frame: 1, kind: "result", id: message.id, ok: true, value: "forged" }, { postMessage() {} });
  // 协议版本不对
  host.deliver({ __heming_frame: 2, kind: "result", id: message.id, ok: true, value: "wrong-version" });

  host.deliver({ __heming_frame: 1, kind: "result", id: message.id, ok: true, value: { running: false } });
  assert.deepEqual(await promise, { running: false });
});

test("event：宿主 kind:'event' 推给本地订阅者，退订后不再收到", () => {
  const host = loadBridge();
  const received = [];
  const off = host.window.__heming_widget.onEvent((payload) => received.push(payload));

  host.deliver({ __heming_frame: 1, kind: "event", channel: "event", payload: { kind: "notify", title: "x" } });
  assert.deepEqual(received, [{ kind: "notify", title: "x" }]);

  off();
  host.deliver({ __heming_frame: 1, kind: "event", channel: "event", payload: { kind: "notify", title: "y" } });
  assert.equal(received.length, 1);
});

test("event：settings/lifecycle/engine-event 各自走自己的订阅，互不串台", () => {
  const host = loadBridge();
  const settings = [];
  const lifecycle = [];
  const engine = [];
  host.window.__heming_widget.onSettings((payload) => settings.push(payload));
  host.window.__heming_widget.onLifecycle((payload) => lifecycle.push(payload));
  host.window.__heming_widget.onEngineEvent((payload) => engine.push(payload));

  host.deliver({ __heming_frame: 1, kind: "event", channel: "settings", payload: { agentId: "a1" } });
  host.deliver({ __heming_frame: 1, kind: "event", channel: "lifecycle", payload: { kind: "enabled" } });
  host.deliver({ __heming_frame: 1, kind: "event", channel: "engine-event", payload: { type: "ready" } });

  assert.deepEqual(settings, [{ agentId: "a1" }]);
  assert.deepEqual(lifecycle, [{ kind: "enabled" }]);
  assert.deepEqual(engine, [{ type: "ready" }]);
});

test("窗口动作：state() → null，其余抛/拒绝 ERR_WIDGET_PAGE_VIEW_UNSUPPORTED（不下发 IPC）", async () => {
  const host = loadBridge();
  const api = host.window.__heming_widget;

  assert.equal(await api.state(), null);

  for (const [name, call] of [
    ["show", () => api.show()],
    ["setScale", () => api.setScale(1)],
    ["setClickThrough", () => api.setClickThrough(true)],
  ]) {
    await assert.rejects(call, (error) => error.code === "ERR_WIDGET_PAGE_VIEW_UNSUPPORTED", name);
  }
  for (const [name, call] of [
    ["hide", () => api.hide()],
    ["toggle", () => api.toggle()],
    ["setInteractive", () => api.setInteractive(false)],
    ["dragStart", () => api.dragStart()],
    ["dragMove", () => api.dragMove()],
    ["dragEnd", () => api.dragEnd()],
    ["resetPosition", () => api.resetPosition()],
  ]) {
    assert.throws(call, (error) => error.code === "ERR_WIDGET_PAGE_VIEW_UNSUPPORTED", name);
  }

  // 一个窗口动作都没有变成宿主调用（桥自己消化掉）
  assert.deepEqual(calls(host), []);
});

test("reload：本地 location.reload()，不走宿主", () => {
  const host = loadBridge();
  host.window.__heming_widget.reload();
  assert.deepEqual(host.reloads, ["reload"]);
  assert.deepEqual(calls(host), []);
});

test("fire-and-forget：log/openPage/openSettings 发 id:0 的 call，不登记回调", () => {
  const host = loadBridge();
  const api = host.window.__heming_widget;
  api.log("页面日志");
  api.openPage("infohub");
  api.openSettings();

  const posted = calls(host);
  assert.deepEqual(posted.map((message) => [message.id, message.method, message.args]), [
    [0, "log", ["页面日志"]],
    [0, "openPage", ["infohub"]],
    [0, "openSettings", []],
  ]);
});

test("参数整形：setSetting/dataGet/engineCall/infohubCall/notify/homeCardSet 与 preload 同形", () => {
  const host = loadBridge();
  const api = host.window.__heming_widget;

  api.setSetting("agentId", "a1");
  assert.deepEqual(calls(host).at(-1).args, ["agentId", "a1"]);

  api.dataGet("cache");
  assert.deepEqual(calls(host).at(-1).args, ["cache"]);

  api.dataSet("cache", { k: 1 });
  assert.deepEqual(calls(host).at(-1).args, ["cache", { k: 1 }]);

  api.dataDelete("cache");
  assert.deepEqual(calls(host).at(-1).args, ["cache"]);

  api.engineCall("start", { model: "m" }, { timeoutMs: 5000 });
  assert.deepEqual(calls(host).at(-1).args, ["start", { model: "m" }, { timeoutMs: 5000 }]);

  api.infohubCall("conversations", { limit: 5 }, {});
  assert.deepEqual(calls(host).at(-1).args, ["conversations", { limit: 5 }, {}]);

  api.notify({ title: "t", level: "info" });
  assert.deepEqual(calls(host).at(-1).args, [{ title: "t", level: "info" }]);

  api.homeCardSet("brief", { text: "3 条待办" });
  assert.deepEqual(calls(host).at(-1).args, ["brief", { text: "3 条待办" }]);
});

test("桥文件是纯浏览器 JS：没有 require/import，也不依赖 Node 内置模块", () => {
  assert.ok(!/\brequire\s*\(/.test(bridgeSource), "桥不能 require");
  assert.ok(!/^\s*import\s/m.test(bridgeSource), "桥不能 import");
  assert.ok(!/\bmodule\.exports\b/.test(bridgeSource), "桥不是 CommonJS 模块");
  // 桥必须挂在 __heming_widget 上（注入脚本后插件代码直接可用）
  assert.match(bridgeSource, /window\.__heming_widget\s*=\s*api/);
});