"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createPluginNotifier,
  normalizePluginNotify,
  NOTIFY_TITLE_MAX,
  NOTIFY_BODY_MAX,
} = require("./plugin-notify");

/** 假主窗：记录 send 的载荷，isDestroyed 由用例控制。 */
function fakeMainWindow(options = {}) {
  const sent = [];
  return {
    sent,
    window: {
      isDestroyed: () => options.destroyed === true,
      webContents: {
        isDestroyed: () => options.webContentsDestroyed === true,
        send: (channel, payload) => sent.push({ channel, payload }),
      },
    },
  };
}

/** 假 Notification 构造器：记录实例与 show 调用。 */
function fakeNotificationClass(options = {}) {
  const instances = [];
  function FakeNotification(payload) {
    this.payload = payload;
    this.shown = false;
    this.show = () => {
      this.shown = true;
    };
    instances.push(this);
  }
  FakeNotification.isSupported = () => options.supported !== false;
  FakeNotification.instances = instances;
  return FakeNotification;
}

test("normalizePluginNotify：标题必填、正文可选、级别非法降 info", () => {
  assert.equal(normalizePluginNotify(null).ok, false);
  assert.equal(normalizePluginNotify({ pluginId: "acme.plugin" }).ok, false);
  assert.equal(normalizePluginNotify({ title: "只有标题" }).ok, false);

  const minimal = normalizePluginNotify({ pluginId: "acme.plugin", title: "  汇总完成  " });
  assert.equal(minimal.ok, true);
  assert.deepEqual(minimal.payload, { pluginId: "acme.plugin", title: "汇总完成", level: "info" });

  const full = normalizePluginNotify({
    pluginId: "acme.plugin",
    title: "同步失败",
    body: "  网络不可用  ",
    level: "warn",
  });
  assert.deepEqual(full.payload, {
    pluginId: "acme.plugin",
    title: "同步失败",
    body: "网络不可用",
    level: "warn",
  });

  // 未知级别不该整条丢弃
  assert.equal(normalizePluginNotify({ pluginId: "x", title: "t", level: "fatal" }).payload.level, "info");
});

test("normalizePluginNotify：标题/正文按主窗通知口径截断并清控制符", () => {
  // 用真实控制符（NUL / BEL）：cleanText 会把它们换成空格再折叠，长度按码点截断。
  // 写成 String.fromCharCode 是为了让本文件里不出现字面控制字符。
  const nul = String.fromCharCode(0);
  const bell = String.fromCharCode(7);
  const result = normalizePluginNotify({
    pluginId: "acme.plugin",
    title: `标${nul}题${"字".repeat(200)}`,
    body: `正${bell}文${"字".repeat(400)}`,
  });
  assert.equal(result.ok, true);
  assert.equal(result.payload.title.length, NOTIFY_TITLE_MAX);
  assert.ok(!result.payload.title.includes(nul));
  assert.equal(result.payload.body.length, NOTIFY_BODY_MAX);
  assert.ok(!result.payload.body.includes(bell));
});

test("notify：主窗活着优先投给渲染层通知中心", () => {
  const main = fakeMainWindow();
  const Notification = fakeNotificationClass();
  const notifier = createPluginNotifier({
    getMainWindow: () => main.window,
    Notification,
  });
  const result = notifier.notify({ pluginId: "acme.plugin", title: "汇总完成", body: "3 条待办" });
  assert.deepEqual(result, { delivered: "renderer" });
  assert.deepEqual(main.sent.at(-1), {
    channel: "plugin:notify",
    payload: { pluginId: "acme.plugin", title: "汇总完成", body: "3 条待办", level: "info" },
  });
  // 主窗吃下了就不该再弹系统通知（否则同一条提醒出现两次）
  assert.equal(Notification.instances.length, 0);
});

test("notify：主窗不存在/已销毁时退回系统通知", () => {
  for (const options of [{ destroyed: true }, { webContentsDestroyed: true }]) {
    const main = fakeMainWindow(options);
    const Notification = fakeNotificationClass();
    const notifier = createPluginNotifier({
      getMainWindow: () => main.window,
      Notification,
    });
    const result = notifier.notify({ pluginId: "acme.plugin", title: "后台任务完成", level: "error" });
    assert.deepEqual(result, { delivered: "system" });
    assert.equal(Notification.instances.length, 1);
    assert.equal(Notification.instances[0].payload.title, "后台任务完成");
    assert.equal(Notification.instances[0].shown, true);
    assert.equal(main.sent.length, 0);
  }
});

test("notify：两条路都不可用时返回 none（不抛异常，插件不会因此崩）", () => {
  const notifier = createPluginNotifier({
    getMainWindow: () => null,
    Notification: fakeNotificationClass({ supported: false }),
  });
  assert.deepEqual(notifier.notify({ pluginId: "acme.plugin", title: "x" }), { delivered: "none" });
});

test("notify：载荷不合法时丢弃并记日志（不打扰用户）", () => {
  const logs = [];
  const Notification = fakeNotificationClass();
  const notifier = createPluginNotifier({
    getMainWindow: () => null,
    Notification,
    log: (line) => logs.push(line),
  });
  assert.equal(notifier.notify({ pluginId: "acme.plugin" }).delivered, "none");
  assert.equal(Notification.instances.length, 0);
  assert.ok(logs.some((line) => line.includes("缺少 title")));
});
