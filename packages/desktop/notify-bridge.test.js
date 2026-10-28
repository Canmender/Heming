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
    isDestroyed: () => opts.destroyed === true,
    isMinimized: () => opts.minimized === true,
    isFocused: () => opts.focused === true,
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
    deps: { Notification: FakeNotification, getMainWindow: () => (opts.noWindow ? null : win) },
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

test("主窗口在前台 → 主进程不再弹系统通知；后台才弹", () => {
  const focusedEnv = fakeEnv({ focused: true });
  registerNotifyIpc(focusedEnv.ipcMain, focusedEnv.deps);
  focusedEnv.ipcMain["notify:message"]({}, { title: "鲍勃", body: "你有一条新消息", conversationId: "c1" });
  assert.equal(focusedEnv.shown.length, 0);

  const backgroundEnv = fakeEnv({ focused: false });
  registerNotifyIpc(backgroundEnv.ipcMain, backgroundEnv.deps);
  backgroundEnv.ipcMain["notify:message"]({}, { title: "鲍勃", body: "你有一条新消息", conversationId: "c1" });
  assert.equal(backgroundEnv.shown.length, 1);
});

test("主窗口已销毁 → 点击不崩、不发送", () => {
  const env = fakeEnv({ destroyed: true });
  registerNotifyIpc(env.ipcMain, env.deps);
  env.ipcMain["notify:message"]({}, { title: "x", body: "y", conversationId: "c1" });
  assert.doesNotThrow(() => env.shown[0].handlers.click());
  assert.equal(env.win.shown, undefined);
  assert.equal(env.win.focused, undefined);
  assert.deepEqual(env.sent, []);
});

test("多窗口（主窗口 + 通话窗口）：点击只聚焦主窗口，绝不碰通话窗口", () => {
  const shown = [];
  const makeWin = () => {
    const calls = { show: 0, focus: 0, restore: 0, send: [] };
    const win = {
      isDestroyed: () => false,
      isMinimized: () => false,
      isFocused: () => false,
      restore: () => { calls.restore++; },
      show: () => { calls.show++; },
      focus: () => { calls.focus++; },
      webContents: { send: (...args) => { calls.send.push(args); } },
    };
    return { win, calls };
  };
  const call = makeWin();
  const main = makeWin();
  class FakeNotification {
    constructor(payload) { this.payload = payload; this.handlers = {}; }
    static isSupported() { return true; }
    on(ev, fn) { this.handlers[ev] = fn; }
    show() { shown.push(this); }
  }
  const ipcMain = { on: (ch, fn) => { ipcMain[ch] = fn; } };
  registerNotifyIpc(ipcMain, {
    Notification: FakeNotification,
    getMainWindow: () => main.win,
    // 若实现误改回 getAllWindows()[0]，这里第一个是通话窗口，用例会抓住。
    BrowserWindow: { getAllWindows: () => [call.win, main.win] },
  });
  ipcMain["notify:message"]({}, { title: "鲍勃", body: "你有一条新消息", conversationId: "c1" });
  shown[0].handlers.click();
  assert.deepEqual(main.calls.send, [["notify:open", "c1"]]);
  assert.equal(main.calls.show, 1);
  assert.equal(main.calls.focus, 1);
  assert.equal(call.calls.show, 0);
  assert.equal(call.calls.focus, 0);
  assert.deepEqual(call.calls.send, []);
});

test("getMainWindow 抛错时点击不崩（回调内兜底）", () => {
  const env = fakeEnv();
  let windowGone = false;
  registerNotifyIpc(env.ipcMain, {
    Notification: env.deps.Notification,
    getMainWindow: () => {
      if (windowGone) throw new Error("window gone");
      return env.win;
    },
  });
  env.ipcMain["notify:message"]({}, { title: "x", body: "y", conversationId: "c1" });
  windowGone = true;
  assert.doesNotThrow(() => env.shown[0].handlers.click());
});

test("超长标题/正文按上限截断（80 / 160）", () => {
  const env = fakeEnv();
  registerNotifyIpc(env.ipcMain, env.deps);
  env.ipcMain["notify:message"]({}, {
    title: "张".repeat(200),
    body: "文".repeat(400),
    conversationId: "c1",
  });
  const p = env.shown[0].payload;
  assert.equal(p.title.length, 80);
  assert.equal(p.body.length, 160);
  assert.equal(p.title, "张".repeat(80));
  assert.equal(p.body, "文".repeat(160));
});

test("截断按码点：emoji 不被劈成孤立代理项", () => {
  const env = fakeEnv();
  registerNotifyIpc(env.ipcMain, env.deps);
  env.ipcMain["notify:message"]({}, { title: "😀".repeat(100), body: "y" });
  const title = env.shown[0].payload.title;
  assert.equal([...title].length, 80);
  assert.equal(title, "😀".repeat(80));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(title), "不应有孤立代理项");
});

test("源码不引入任何网络能力（红线）", () => {
  const src = fs.readFileSync(path.join(__dirname, "notify-bridge.js"), "utf8");
  assert.ok(!/require\(\s*["'](node:)?(http|https|http2|net|dgram|tls|dns)["']\s*\)/.test(src));
  assert.ok(!/\bfetch\s*\(/.test(src));
});
