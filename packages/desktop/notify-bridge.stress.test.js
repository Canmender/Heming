"use strict";
/**
 * d.39 桌面通知桥压力 / 模糊测试（QA 独立复检）。
 *
 * 只验证、不改生产代码。沿用 notify-bridge.test.js 的纯 node 注入式环境。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { registerNotifyIpc } = require("./notify-bridge");

const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const CTRL_TITLE = `a${NUL}${BEL}b`;
const CTRL_BODY = `x${BEL}y`;
const CTRL_CONV = `a${NUL}b`;
const LONE_HI = "\uD800abc";
const LONE_LO = "\uDC00";
const LONE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

class FakeNotification {
  constructor(payload) {
    this.payload = payload;
    this.handlers = {};
  }
  static isSupported() {
    return true;
  }
  on(ev, fn) {
    this.handlers[ev] = fn;
  }
  show() {}
}

function makeWin(opts = {}) {
  const calls = { show: 0, focus: 0, restore: 0, send: [] };
  const win = {
    isDestroyed: () => opts.destroyed === true,
    isMinimized: () => opts.minimized === true,
    isFocused: () => opts.focused === true,
    restore: () => {
      calls.restore += 1;
    },
    show: () => {
      calls.show += 1;
    },
    focus: () => {
      calls.focus += 1;
    },
    webContents: { send: (...args) => calls.send.push(args) },
  };
  return { win, calls };
}

function makeEnv(opts = {}) {
  const shown = [];
  class Base extends FakeNotification {
    constructor(payload) {
      if (opts.ctorThrows) throw new Error("ctor boom");
      super(payload);
    }
    static isSupported() {
      if (opts.supportedThrows) throw new Error("supported boom");
      return opts.supported !== false;
    }
    show() {
      if (opts.showThrows) throw new Error("show boom");
      shown.push(this);
    }
  }
  const ipcMain = { on: (ch, fn) => { ipcMain[ch] = fn; } };
  const main = opts.mainWin ?? makeWin({ focused: opts.focused === true });
  const deps = {
    Notification: Base,
    getMainWindow: opts.getMainWindow ?? (() => (opts.noWindow ? null : main.win)),
    getFocusedWindow: opts.getFocusedWindow,
  };
  registerNotifyIpc(ipcMain, deps);
  return { ipcMain, shown, main, Base };
}

test("D1: 1000 条合法通知 → 不抛、全部弹出", () => {
  const env = makeEnv();
  const t0 = performance.now();
  for (let i = 0; i < 1000; i += 1) {
    env.ipcMain["notify:message"](
      {},
      { title: `鲍勃${i}`, body: "你有一条新消息", conversationId: `c${i}` },
    );
  }
  const ms = performance.now() - t0;
  console.log(`[D1] 1000 notifications ms=${ms.toFixed(1)} shown=${env.shown.length}`);
  assert.equal(env.shown.length, 1000);
  assert.ok(ms < 15000);
});

test("D2: payload 模糊输入不抛、输出收敛", () => {
  const env = makeEnv();
  const cases = [
    { name: "null", payload: null },
    { name: "array", payload: [1, 2, 3] },
    { name: "wrong-types", payload: { title: 123, body: {}, conversationId: [] } },
    { name: "control-chars", payload: { title: CTRL_TITLE, body: CTRL_BODY } },
    { name: "lone-surrogate", payload: { title: LONE_HI, body: LONE_LO } },
    { name: "emoji", payload: { title: "\u{1F600}".repeat(100), body: "\u{1F600}".repeat(300) } },
    { name: "10MB", payload: { title: "a".repeat(10 * 1024 * 1024), body: "b".repeat(10 * 1024 * 1024) } },
    { name: "huge-conversationId", payload: { title: "t", body: "b", conversationId: "x".repeat(100000) } },
    { name: "control-conversationId", payload: { title: "t", body: "b", conversationId: CTRL_CONV } },
    { name: "injection-conversationId", payload: { title: "t", body: "b", conversationId: "c1\n;drop table" } },
    {
      name: "uuid-conversationId",
      payload: { title: "t", body: "b", conversationId: "550e8400-e29b-41d4-a716-446655440000" },
    },
  ];

  const results = {};
  for (const { name, payload } of cases) {
    const before = env.shown.length;
    const t0 = performance.now();
    assert.doesNotThrow(() => env.ipcMain["notify:message"]({}, payload), `case ${name}`);
    const ms = performance.now() - t0;
    const ntf = env.shown[env.shown.length - 1];
    assert.ok(env.shown.length === before + 1, `case ${name}: 应该弹出一条`);
    assert.equal(typeof ntf.payload.title, "string", name);
    assert.equal(typeof ntf.payload.body, "string", name);
    assert.ok([...ntf.payload.title].length <= 80, `${name}: 标题按码点 <= 80`);
    assert.ok([...ntf.payload.body].length <= 160, `${name}: 正文按码点 <= 160`);
    // 点击：conversationId 只在字符串且非空时回传
    const sentBefore = env.main.calls.send.length;
    assert.doesNotThrow(() => ntf.handlers.click(), `click ${name}`);
    const sent = env.main.calls.send.slice(sentBefore);
    results[name] = {
      title: ntf.payload.title,
      titleLen: [...ntf.payload.title].length,
      body: ntf.payload.body,
      convoSent: sent.length,
      convoLen: sent.length ? sent[0][1].length : 0,
      ms: Number(ms.toFixed(2)),
    };
  }
  console.log("[D2]", JSON.stringify(results));

  // 默认文案
  const nullCase = results["null"];
  assert.equal(nullCase.title, "新消息");
  assert.equal(results["array"].convoSent, 0);
  assert.equal(results["wrong-types"].convoSent, 0);
  // 非法 conversationId（超长 / 控制符 / 注入字符）一律不带 → 点击只聚焦，不开幽灵会话
  assert.equal(results["huge-conversationId"].convoSent, 0);
  assert.equal(results["control-conversationId"].convoSent, 0);
  assert.equal(results["injection-conversationId"].convoSent, 0);
  // 合法 UUID 形 id 正常回传
  assert.equal(results["uuid-conversationId"].convoSent, 1);
  assert.equal(results["uuid-conversationId"].convoLen, 36);
  // 10MB 截断到 80 码点
  assert.equal(results["10MB"].titleLen, 80);
  assert.equal(results["emoji"].titleLen, 80);
  // 控制字符替换为空格并折叠（不再原样保留）
  assert.equal(results["control-chars"].title, "a b");
  assert.equal(results["control-chars"].body, "x y");
  // 孤立代理项被 toWellFormed 换成 U+FFFD
  assert.equal(results["lone-surrogate"].title, "�abc");
  assert.equal(results["lone-surrogate"].body, "�");
  for (const [name, r] of Object.entries(results)) {
    assert.ok(!LONE_RE.test(r.title), `${name}: 标题不应有孤立代理项`);
    assert.ok(!LONE_RE.test(r.body), `${name}: 正文不应有孤立代理项`);
  }
});

test("D3: 依赖抛错（窗口/构造/isSupported/show）不产生未捕获异常", () => {
  // getMainWindow 抛错：整条通知失败但不崩
  const e1 = makeEnv({
    getMainWindow: () => {
      throw new Error("window gone");
    },
  });
  assert.doesNotThrow(() => e1.ipcMain["notify:message"]({}, { title: "x", body: "y" }));
  assert.equal(e1.shown.length, 0);

  // 窗口已销毁：仍会弹通知（只影响点击聚焦），点击不崩
  const destroyed = makeWin({ destroyed: true });
  const e2 = makeEnv({ mainWin: destroyed });
  assert.doesNotThrow(() => e2.ipcMain["notify:message"]({}, { title: "x", body: "y", conversationId: "c1" }));
  assert.equal(e2.shown.length, 1);
  assert.doesNotThrow(() => e2.shown[0].handlers.click());
  assert.equal(destroyed.calls.send.length, 0);

  // Notification 构造抛错
  const e3 = makeEnv({ ctorThrows: true });
  assert.doesNotThrow(() => e3.ipcMain["notify:message"]({}, { title: "x", body: "y" }));

  // show() 抛错
  const e4 = makeEnv({ showThrows: true });
  assert.doesNotThrow(() => e4.ipcMain["notify:message"]({}, { title: "x", body: "y" }));

  // isSupported 抛错
  const e5 = makeEnv({ supportedThrows: true });
  assert.doesNotThrow(() => e5.ipcMain["notify:message"]({}, { title: "x", body: "y" }));

  // 不支持
  const e6 = makeEnv({ supported: false });
  e6.ipcMain["notify:message"]({}, { title: "x", body: "y" });
  assert.equal(e6.shown.length, 0);
});

test("D4: 点击回调触发两次 → 只聚焦并回传一次（click-once）", () => {
  const env = makeEnv();
  env.ipcMain["notify:message"]({}, { title: "鲍勃", body: "你有一条新消息", conversationId: "c1" });
  const ntf = env.shown[0];
  ntf.handlers.click();
  ntf.handlers.click();
  console.log("[D4] send calls=", JSON.stringify(env.main.calls.send), "show=", env.main.calls.show);
  // 防重复：第二次点击直接忽略，不重复聚焦/回传
  assert.equal(env.main.calls.send.length, 1);
  assert.deepEqual(env.main.calls.send[0], ["notify:open", "c1"]);
  assert.equal(env.main.calls.show, 1);
  assert.equal(env.main.calls.focus, 1);
});

test("D5: 任一窗口在前台（含桌宠窗口）→ 不弹；无焦点窗且主窗口在后台 → 弹", () => {
  // 主窗口在前台 → 主进程不再弹（即便渲染层已请求）
  const mainFocused = makeWin({ focused: true });
  const e1 = makeEnv({ mainWin: mainFocused });
  e1.ipcMain["notify:message"]({}, { title: "t", body: "b", conversationId: "c1" });
  assert.equal(e1.shown.length, 0);

  // 主窗口不在前台、桌宠窗口在前台 → 任一窗口在前台就不打扰
  const mainBg = makeWin({ focused: false });
  const callFg = makeWin({ focused: true });
  const e2 = makeEnv({ mainWin: mainBg, getFocusedWindow: () => callFg.win });
  e2.ipcMain["notify:message"]({}, { title: "t", body: "b", conversationId: "c1" });
  assert.equal(e2.shown.length, 0);

  // 无焦点窗 + 主窗口在后台 → 正常弹；点击只聚焦主窗口，不碰桌宠窗口
  const mainBg2 = makeWin({ focused: false });
  const e3 = makeEnv({ mainWin: mainBg2, getFocusedWindow: () => null });
  e3.ipcMain["notify:message"]({}, { title: "t", body: "b", conversationId: "c1" });
  assert.equal(e3.shown.length, 1);
  e3.shown[0].handlers.click();
  assert.equal(mainBg2.calls.show, 1);
  assert.equal(mainBg2.calls.focus, 1);
  assert.deepEqual(mainBg2.calls.send, [["notify:open", "c1"]]);
  assert.equal(callFg.calls.show, 0);
  assert.equal(callFg.calls.focus, 0);
  console.log("[D5] mainFocused->suppressed; petWindowFocused->suppressed; background-main->toast");
});
