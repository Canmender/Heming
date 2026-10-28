"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { registerNotifyIpc } = require("./notify-bridge");

function fakeEnv(opts = {}) {
  const shown = [];
  const sent = [];
  const win = {
    isDestroyed: () => false,
    isMinimized: () => opts.minimized === true,
    restore: () => { win.restored = true; },
    show: () => { win.shown = true; },
    focus: () => { win.focused = true; },
    webContents: { send: (...args) => sent.push(args) },
  };
  class FakeNotification {
    constructor(payload) { this.payload = payload; this.handlers = {}; this.shown = false; }
    static isSupported() { return opts.supported !== false; }
    on(ev, fn) { this.handlers[ev] = fn; }
    show() { this.shown = true; shown.push(this); }
  }
  const ipcMain = { on: (ch, fn) => { ipcMain[ch] = fn; } };
  return {
    shown, sent, win,
    ipcMain,
    deps: { Notification: FakeNotification, BrowserWindow: { getAllWindows: () => (opts.noWindow ? [] : [win]) } },
  };
}

test("合法通知：显示、点击聚焦并回传会话 id", () => {
  const env = fakeEnv({ minimized: true });
  registerNotifyIpc(env.ipcMain, env.deps);
  env.ipcMain["notify:message"]({}, { title: "鲍勃", body: "你有一条新消息", conversationId: "c1" });
  assert.equal(env.shown.length, 1);
  assert.deepEqual(env.shown[0].payload, { title: "鲍勃", body: "你有一条新消息" });
  env.shown[0].handlers.click();
  assert.equal(env.win.restored, true);
  assert.equal(env.win.shown, true);
  assert.equal(env.win.focused, true);
  assert.deepEqual(env.sent[0], ["notify:open", "c1"]);
});

test("不支持通知时跳过；无窗口时点击不崩", () => {
  const env = fakeEnv({ supported: false });
  registerNotifyIpc(env.ipcMain, env.deps);
  env.ipcMain["notify:message"]({}, { title: "x", body: "y" });
  assert.equal(env.shown.length, 0);

  const env2 = fakeEnv({ noWindow: true });
  registerNotifyIpc(env2.ipcMain, env2.deps);
  env2.ipcMain["notify:message"]({}, { title: "x", body: "y" });
  assert.doesNotThrow(() => env2.shown[0].handlers.click());
});

test("脏输入被清洗：缺标题用默认、超长截断、非字符串忽略", () => {
  const env = fakeEnv();
  registerNotifyIpc(env.ipcMain, env.deps);
  env.ipcMain["notify:message"]({}, { title: "  ".repeat(100), body: 123, conversationId: 7 });
  const p = env.shown[0].payload;
  assert.equal(p.title, "新消息");
  assert.equal(p.body, "你有一条新消息");
  env.shown[0].handlers.click();
  assert.deepEqual(env.sent, []);
});

test("源码不引入任何网络能力（红线）", () => {
  const src = fs.readFileSync(path.join(__dirname, "notify-bridge.js"), "utf8");
  assert.ok(!/require\(\s*["'](node:)?(http|https|net|dgram|tls)["']\s*\)/.test(src));
});
