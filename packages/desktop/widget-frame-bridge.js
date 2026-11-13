"use strict";

/**
 * 和鸣界面插件页面桥（d.141）。
 *
 * ★ 这是**纯浏览器 JS**：由主进程从 `widget://<id>/__heming_frame_bridge.js` 返回，
 *   并由 widget:// 的 HTML 响应注入 `<script src="/__heming_frame_bridge.js">`。
 *   因此本文件里**不能**有 `require` / `import` / Node 内置模块——它跑在渲染进程的
 *   子框架里，没有 preload、没有 contextBridge，只有浏览器环境。
 *
 * 为什么需要它：插件页面以前是主进程的 `WebContentsView`，自带 `widget-preload.js`
 * 的 `__heming_widget` 桥。改成渲染层 `<iframe>` 后，页面跑在主窗渲染进程的一个子框架里，
 * 拿不到主窗的 preload 桥（也不需要，那等于把主窗的 IPC 入口递给插件代码）。所以宿主在
 * 页面里注一个最小的 `__heming_widget` 兼容层：API 面与 d.124 的「页面模式」一致，
 * 底下用 postMessage 把调用转给宿主渲染层（宿主再经 preload 的 `pageCall`/`pageSend`
 * 走主进程，主进程按 activePage 做 sender 校验）。
 *
 * 安全边界（三条都不许放松）：
 * 1. 只接受 `event.source === window.parent` 的消息——页面里其它 frame/worker 冒充不了宿主；
 * 2. 调用必须带 `__heming_frame:1` 标记，宿主侧（web）也要校验 origin 是 `widget://<id>`；
 * 3. **窗口类动作**（显隐/缩放/拖拽/穿透）在页面里没有意义，一律返回明确的不支持错误
 *    （sync 抛 / invoke reject，`code === "ERR_WIDGET_PAGE_VIEW_UNSUPPORTED"`），
 *    `state()` 返回 null（只读 unsupported），绝不伪造 visible/scale。
 *
 * ★ 自守卫：已经有 `window.__heming_widget`（宿主别处注入过）就什么都不做；顶层打开
 *   （`window.parent === window`）也直接退出——没有宿主可说话，别污染页面全局。
 */
(function () {
  if (typeof window === "undefined") return;
  if (window.__heming_widget) return;
  if (window.parent === window) return;

  /** 帧协议标记：宿主（web 渲染层）与这里的唯一约定。 */
  var PROTOCOL = "__heming_frame";
  var PROTOCOL_VERSION = 1;
  var UNSUPPORTED_CODE = "ERR_WIDGET_PAGE_VIEW_UNSUPPORTED";

  /** 未完成的一次性调用：id → { resolve, reject }。 */
  var pending = Object.create(null);
  var sequence = 0;

  /** 本地订阅（onEvent/onSettings/onLifecycle/onEngineEvent）→ 回调数组。 */
  var subscribers = Object.create(null);
  subscribers.settings = [];
  subscribers.event = [];
  subscribers.lifecycle = [];
  subscribers["engine-event"] = [];

  /** 发一条消息给宿主（parent）。失败不抛：页面不该因为宿主不在而崩。 */
  function post(message) {
    message[PROTOCOL] = PROTOCOL_VERSION;
    try {
      window.parent.postMessage(message, "*");
    } catch (error) {
      /* 宿主正在卸载：丢弃即可 */
    }
  }

  /** 一次性 ready 握手：宿主据此把 peer 标成「桥已就绪」，之后才投递事件。 */
  function signalReady() {
    post({ kind: "ready" });
  }

  /** invoke：宿主回调 `{kind:"result", id, ok, value|error}`。 */
  function call(method, args) {
    return new Promise(function (resolve, reject) {
      sequence += 1;
      var id = sequence;
      pending[id] = { resolve: resolve, reject: reject };
      post({ kind: "call", id: id, method: method, args: args || [] });
    });
  }

  /** fire-and-forget：与 invoke 同一条消息，只是不登记回调（id=0）。 */
  function fire(method, args) {
    post({ kind: "call", id: 0, method: method, args: args || [] });
  }

  /** 窗口动作不支持时的错误（中文、可直接展示，与 d.124 页面模式同文案同 code）。 */
  function unsupportedError(name) {
    var error = new Error("界面插件页面视图不支持窗口操作：" + name + "（插件页面由宿主布局管理）");
    error.code = UNSUPPORTED_CODE;
    return error;
  }

  function unsupportedSync(name) {
    return function () {
      throw unsupportedError(name);
    };
  }

  function unsupportedInvoke(name) {
    return function () {
      return Promise.reject(unsupportedError(name));
    };
  }

  /** 订阅一个宿主推送通道，返回取消订阅函数（与 widget-preload 的 on* 语义一致）。 */
  function subscribe(channel, callback) {
    if (typeof callback !== "function") return function () {};
    var list = subscribers[channel];
    if (!list) return function () {};
    list.push(callback);
    return function () {
      var index = list.indexOf(callback);
      if (index >= 0) list.splice(index, 1);
    };
  }

  function emit(channel, payload) {
    var list = subscribers[channel];
    if (!list || list.length === 0) return;
    // 复制一份再遍历：回调里退订自己不会打乱本次投递
    for (var copy = list.slice(), index = 0; index < copy.length; index += 1) {
      try {
        copy[index](payload);
      } catch (error) {
        /* 订阅者自己的异常不该打断其它订阅者，也不该冒泡回宿主 */
      }
    }
  }

  /** 宿主的回包：result / event。只认 parent，且标记版本要对（缺省容忍旧宿主）。 */
  function onMessage(event) {
    if (!event || event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data[PROTOCOL] !== undefined && data[PROTOCOL] !== PROTOCOL_VERSION) return;
    if (data.kind === "result") {
      var waiter = pending[data.id];
      if (!waiter) return;
      delete pending[data.id];
      if (data.ok) waiter.resolve(data.value === undefined ? null : data.value);
      else {
        var info = data.error && typeof data.error === "object" ? data.error : {};
        var error = new Error(typeof info.message === "string" ? info.message : "插件页面调用失败");
        error.code = typeof info.code === "string" ? info.code : "ERR_WIDGET_PAGE_CALL_FAILED";
        waiter.reject(error);
      }
      return;
    }
    if (data.kind === "event") emit(data.channel, data.payload);
  }

  window.addEventListener("message", onMessage);

  /**
   * 宿主能力桥：**方法名与 `widget-preload.js` 的 `__heming_widget` 一一对应**
   * （`packages/shared/src/plugin/widget.test.ts` 比对的是 preload 那份名单，
   * 这里保持同名同参，插件代码在浮窗与页面之间可以直接复用）。
   */
  var api = {
    /* ── 窗口动作：页面没有独立窗口，全部 unsupported（与 d.124 页面模式一致） ── */
    state: function () {
      return Promise.resolve(null);
    },
    show: unsupportedInvoke("show"),
    hide: unsupportedSync("hide"),
    toggle: unsupportedSync("toggle"),
    setScale: unsupportedInvoke("setScale"),
    setClickThrough: unsupportedInvoke("setClickThrough"),
    setInteractive: unsupportedSync("setInteractive"),
    dragStart: unsupportedSync("dragStart"),
    dragMove: unsupportedSync("dragMove"),
    dragEnd: unsupportedSync("dragEnd"),
    resetPosition: unsupportedSync("resetPosition"),
    /** 重载页面：直接刷自己（宿主不参与，页面重载后桥会重新注入/执行）。 */
    reload: function () {
      window.location.reload();
    },

    /* ── 宿主环境（invoke） ── */
    info: function () {
      return call("info");
    },
    settings: function () {
      return call("settings");
    },
    setSetting: function (key, value) {
      return call("setSetting", [key, value]);
    },
    /** 设置被别处（主窗设置区）改动时的推送。返回取消订阅函数。 */
    onSettings: function (callback) {
      return subscribe("settings", callback);
    },

    /* ── 插件自己的业务数据（invoke） ── */
    dataGet: function (key) {
      return call("dataGet", [key]);
    },
    dataSet: function (key, value) {
      return call("dataSet", [key, value]);
    },
    dataDelete: function (key) {
      return call("dataDelete", [key]);
    },
    dataKeys: function () {
      return call("dataKeys");
    },
    dataDir: function () {
      return call("dataDir");
    },

    /* ── 事件订阅（宿主 → 页面，经 postMessage 的 kind:"event"） ── */
    onEvent: function (callback) {
      return subscribe("event", callback);
    },
    onLifecycle: function (callback) {
      return subscribe("lifecycle", callback);
    },
    onEngineEvent: function (callback) {
      return subscribe("engine-event", callback);
    },

    /* ── 跳转（fire-and-forget） ── */
    openSettings: function () {
      fire("openSettings");
    },
    openPage: function (page) {
      fire("openPage", [page]);
    },

    /* ── 对话上下文 / 插件引擎 / 日志 / 信息中枢 / 通知 / 首页卡片 ── */
    chatConfig: function () {
      return call("chatConfig");
    },
    engineStatus: function () {
      return call("engineStatus");
    },
    engineCall: function (method, params, options) {
      return call("engineCall", [method, params, options]);
    },
    log: function (line) {
      fire("log", [typeof line === "string" ? line : String(line == null ? "" : line)]);
    },
    infohubCall: function (method, params, options) {
      return call("infohubCall", [method, params, options]);
    },
    notify: function (payload) {
      return call("notify", [payload]);
    },
    homeCardSet: function (cardId, patch) {
      return call("homeCardSet", [cardId, patch]);
    },
  };

  window.__heming_widget = api;

  signalReady();
})();