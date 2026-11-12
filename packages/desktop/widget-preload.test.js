"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const preloadPath = path.join(__dirname, "widget-preload.js");
const PAGE_VIEW_FLAG = "--heming-page-view";
/** 后台常驻页的标记参数：语义与页面视图一样「没有独立窗口」（contract §5）。 */
const BACKGROUND_FLAG = "--heming-widget-mode=background";

/**
 * 真实执行 `widget-preload.js`（stub 掉 electron 的 contextBridge/ipcRenderer），
 * 返回暴露的 `__heming_widget` 与调用记录。
 *
 * 页面视图模式靠 `process.argv` 里的 `--heming-page-view` 判定（主进程建
 * WebContentsView 时通过 webPreferences.additionalArguments 传入）。
 */
function loadWidgetBridge(options = {}) {
  const exposed = {};
  const invoked = [];
  const sent = [];
  const originalArgv = process.argv;
  const nextArgv = originalArgv.filter((arg) => arg !== PAGE_VIEW_FLAG && arg !== BACKGROUND_FLAG);
  if (options.pageView) nextArgv.push(PAGE_VIEW_FLAG);
  if (options.background) nextArgv.push(BACKGROUND_FLAG);
  process.argv = nextArgv;

  const stubElectron = {
    contextBridge: {
      exposeInMainWorld: (key, api) => {
        exposed[key] = api;
      },
    },
    ipcRenderer: {
      invoke: async (channel, payload) => {
        invoked.push([channel, payload]);
        return null;
      },
      send: (channel, ...args) => {
        sent.push([channel, ...args]);
      },
      on: () => {},
      removeListener: () => {},
    },
  };

  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") return stubElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve(preloadPath)];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
    process.argv = originalArgv;
  }
  return { bridge: exposed.__heming_widget, invoked, sent };
}

test("widget 窗口：窗口动作照常经 widget: 通道下发", async () => {
  const { bridge, invoked, sent } = loadWidgetBridge();
  assert.ok(bridge, "应暴露 __heming_widget");

  bridge.hide();
  assert.deepEqual(sent.at(-1), ["widget:hide"]);
  bridge.dragStart();
  assert.deepEqual(sent.at(-1), ["widget:drag-start"]);
  bridge.setInteractive(true);
  assert.deepEqual(sent.at(-1), ["widget:set-interactive", true]);
  await bridge.show();
  assert.deepEqual(invoked.at(-1), ["widget:show", undefined]);
  await bridge.setScale(-1);
  assert.deepEqual(invoked.at(-1), ["widget:set-scale", { dir: -1 }]);

  // 非页面视图：几何 API 不应抛错
  assert.doesNotThrow(() => bridge.toggle());
  assert.doesNotThrow(() => bridge.resetPosition());
});

test("页面视图：窗口几何类 API 返回明确 unsupported（不静默 no-op、不下发通道）", async () => {
  const { bridge, invoked, sent } = loadWidgetBridge({ pageView: true });

  // 只读状态：null 表示 unsupported（页面没有独立窗口）
  assert.equal(await bridge.state(), null);

  // invoke 类：reject 中文错误
  for (const [name, call] of [
    ["show", () => bridge.show()],
    ["setScale", () => bridge.setScale(1)],
    ["setClickThrough", () => bridge.setClickThrough(true)],
  ]) {
    await assert.rejects(call, /页面视图不支持窗口操作/, name);
  }

  // 同步 send 类：直接抛中文错误
  for (const [name, call] of [
    ["hide", () => bridge.hide()],
    ["toggle", () => bridge.toggle()],
    ["setInteractive", () => bridge.setInteractive(false)],
    ["dragStart", () => bridge.dragStart()],
    ["dragMove", () => bridge.dragMove()],
    ["dragEnd", () => bridge.dragEnd()],
    ["resetPosition", () => bridge.resetPosition()],
  ]) {
    assert.throws(call, /页面视图不支持窗口操作/, name);
  }

  // 一个窗口几何通道都不该被下发（主进程侧还有第二道拒绝）
  for (const [channel] of [...sent, ...invoked]) {
    assert.ok(
      ![
        "widget:show",
        "widget:hide",
        "widget:toggle",
        "widget:set-scale",
        "widget:set-click-through",
        "widget:set-interactive",
        "widget:drag-start",
        "widget:drag-move",
        "widget:drag-end",
        "widget:reset-position",
        "widget:state",
      ].includes(channel),
      `页面视图不应下发窗口动作通道：${channel}`,
    );
  }
});

test("页面视图：宿主环境/设置/数据/跳转/主题这些既有能力照常可用（只读不写窗口几何）", async () => {
  const { bridge, invoked, sent } = loadWidgetBridge({ pageView: true });

  bridge.info();
  assert.deepEqual(invoked.at(-1), ["widget:info", undefined]);
  bridge.settings();
  assert.deepEqual(invoked.at(-1), ["widget:settings-get", undefined]);
  bridge.setSetting("agentId", "a1");
  assert.deepEqual(invoked.at(-1), ["widget:settings-set", { key: "agentId", value: "a1" }]);
  bridge.dataGet("cache");
  assert.deepEqual(invoked.at(-1), ["widget:data-get", { key: "cache" }]);
  bridge.openPage("infohub");
  assert.deepEqual(sent.at(-1), ["widget:open-page", "infohub"]);
  bridge.openSettings();
  assert.deepEqual(sent.at(-1), ["widget:open-settings"]);
  bridge.reload();
  assert.deepEqual(sent.at(-1), ["widget:reload"]);
  bridge.chatConfig();
  assert.deepEqual(invoked.at(-1), ["widget:chat-config", undefined]);
  bridge.log("页面日志");
  assert.deepEqual(sent.at(-1), ["widget:log", "页面日志"]);

  // 只有 widget: 前缀的通道（不会偷调主窗的 widgets: 能力面）
  for (const [channel] of [...sent, ...invoked]) {
    assert.ok(channel.startsWith("widget:"), `插件桥不应调非 widget: 通道：${channel}`);
  }
});

test("widget-preload 不暴露 secrets / mcp / files / 会话类桥（页面视图共用同一最小面）", () => {
  const { bridge } = loadWidgetBridge({ pageView: true });
  for (const banned of ["__heming_secrets", "__mcp_stdio", "__heming_files", "__heming_wiki", "__heming_infohub"]) {
    assert.equal(bridge[banned], undefined, `不应暴露 ${banned}`);
  }
  assert.equal(typeof bridge.list, "undefined");
  assert.equal(typeof bridge.install, "undefined");
});

test("后台常驻页：新桥三方法可用，窗口几何类 API 仍按 unsupported 处理", async () => {
  const { bridge, invoked, sent } = loadWidgetBridge({ background: true });
  assert.ok(bridge, "应暴露 __heming_widget");

  await bridge.infohubCall("conversations", { limit: 5 }, { timeoutMs: 5000 });
  assert.deepEqual(invoked.at(-1), [
    "widget:infohub-call",
    { method: "conversations", params: { limit: 5 }, timeoutMs: 5000 },
  ]);

  await bridge.notify({ title: "后台任务完成", level: "info" });
  assert.deepEqual(invoked.at(-1), ["widget:notify", { title: "后台任务完成", level: "info" }]);

  await bridge.homeCardSet("brief", { text: "3 条待办" });
  assert.deepEqual(invoked.at(-1), [
    "widget:homecard-set",
    { cardId: "brief", patch: { text: "3 条待办" } },
  ]);

  // 与页面视图同一口径：后台页也没有独立窗口
  assert.equal(await bridge.state(), null);
  assert.throws(() => bridge.hide(), /页面视图不支持窗口操作/);
  for (const [channel] of [...sent, ...invoked]) {
    assert.ok(channel.startsWith("widget:"), `插件桥不应调非 widget: 通道：${channel}`);
  }
});
