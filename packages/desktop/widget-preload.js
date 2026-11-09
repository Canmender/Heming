"use strict";

/**
 * 界面插件窗口（`widget://<id>/…`）的**唯一**桥（规格 §3.4）。
 *
 * ★ 这是整条插件链最关键的收口：widget 页是第三方/第一方插件的代码，它能拿到的
 *   全部宿主能力就是下面这些方法。**不许**出现 secrets / mcp / files / 会话 / 记忆
 *   任何桥——桌宠时代 widget 窗挂的是主窗那份 preload.js，等于把 `__mcp_stdio`
 *   （拉起子进程）、`__heming_secrets`（解密预言机）、`__heming_files`（写用户文件）
 *   一起交给了插件页（当时靠「同源 + 导航闸」兜着，见 d.98 前的 pet-host.js 注释）。
 *   拆成独立 preload 后，这条风险从"靠纪律"变成"结构上没有"。
 *
 * ★ 坐标不上报：拖拽只发"按下/移动了/抬起"三个信号，位移由主进程按屏幕光标计算。
 *   渲染层的 clientX 会随窗口移动而失真，拿它算位置一定跑偏。
 *
 * ★ 主进程侧每个通道都按 sender 反查「是不是这个 widget 自己的窗口」，
 *   查不到直接拒绝；本文件不承担安全判断，只做最小暴露面。
 */

const { contextBridge, ipcRenderer } = require("electron");

/** 订阅一个主进程 → widget 的推送通道，返回取消订阅函数。 */
function subscribe(channel, callback) {
  if (typeof callback !== "function") return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("__heming_widget", {
  /* ── 窗口 ── */
  /** 读当前状态 { visible, scale, clickThrough }。 */
  state: () => ipcRenderer.invoke("widget:state"),
  /** 显示自己（主进程会 showInactive，不抢焦点）。 */
  show: () => ipcRenderer.invoke("widget:show"),
  hide: () => ipcRenderer.send("widget:hide"),
  toggle: () => ipcRenderer.send("widget:toggle"),
  /**
   * 缩放：两种语义
   *   setScale(1) / setScale(-1)   相对切一档
   *   setScale({ dir: 1 })         同上（兼容旧形状）
   * 绝对档位由宿主托盘/主窗设置决定，插件不自选（避免和用户偏好打架）。
   */
  setScale: (dir) => ipcRenderer.invoke("widget:set-scale", typeof dir === "object" ? dir : { dir: dir === -1 ? -1 : 1 }),
  /** 鼠标穿透开关；只有清单 clickThrough:"auto" 的 widget 生效。 */
  setClickThrough: (on) => ipcRenderer.invoke("widget:set-click-through", on === true),
  /** 上报「光标此刻是否在可交互区」。只在值变化时调用（mousemove 是高频事件）。 */
  setInteractive: (on) => ipcRenderer.send("widget:set-interactive", on === true),
  dragStart: () => ipcRenderer.send("widget:drag-start"),
  dragMove: () => ipcRenderer.send("widget:drag-move"),
  dragEnd: () => ipcRenderer.send("widget:drag-end"),
  resetPosition: () => ipcRenderer.send("widget:reset-position"),
  /** 重新加载自己（换模型/换绑定后重新读配置）。 */
  reload: () => ipcRenderer.send("widget:reload"),

  /* ── 宿主环境 ── */
  /** { pluginId, pluginName, appVersion, theme }。 */
  info: () => ipcRenderer.invoke("widget:info"),
  /** 本插件的设置值（清单 settings.fields 的当前值）。 */
  settings: () => ipcRenderer.invoke("widget:settings-get"),
  /** 写一个设置项，返回合并后的全量。 */
  setSetting: (key, value) => ipcRenderer.invoke("widget:settings-set", { key, value }),
  /** 设置被别处（主窗设置区）改动时的推送。返回取消订阅函数。 */
  onSettings: (callback) => subscribe("widget:settings", callback),

  /**
   * 本插件自己的业务数据：`<userData>/plugins/<id>/data/<key>.json`。
   *
   * ★ 为什么不是 localStorage：插件窗口是独立 origin，重启/清缓存都会丢；
   *   数据默认放**安装目录**（与 settings/state 同处），升级保留、卸载即删。
   * ★ key 只允许 `[A-Za-z0-9._-]{1,64}`（不含 `..`），值必须是 JSON，单文件 ≤1MB；
   *   超限/非法 key 会 reject（可读 message），不会静默截断。
   * ★ 读失败（不存在 / JSON 坏了）返回 null；写失败抛错——别吞掉写失败。
   * ★ 不要在这里存密钥：密钥属于宿主设置/密钥存储，数据目录是明文文件。
   */
  dataGet: (key) => ipcRenderer.invoke("widget:data-get", { key }),
  /** 写一个 key，resolve `{ key, bytes }`；上限/序列化/写盘失败都会 reject。 */
  dataSet: (key, value) => ipcRenderer.invoke("widget:data-set", { key, value }),
  /** 删一个 key，resolve 是否真的删掉了文件。 */
  dataDelete: (key) => ipcRenderer.invoke("widget:data-delete", { key }),
  /** 已有 key 列表（只含 `*.json`，已排序）。 */
  dataKeys: () => ipcRenderer.invoke("widget:data-keys", {}),
  /** 数据目录绝对路径 `{ dir }`（放不进 JSON 的大文件也放这里；别展示给终端用户）。 */
  dataDir: () => ipcRenderer.invoke("widget:data-dir", {}),

  /* ── 事件：{kind:"notify"|"theme"|"tray"}，只带标题级文案，不落盘 ── */
  onEvent: (callback) => subscribe("widget:event", callback),

  /**
   * 生命周期事件（d.108，规格 §5.4）：只给清单 `permissions.events` 含 `"lifecycle"` 的插件投递。
   * 载荷 `{ event: "installed"|"enabled"|"disabled"|"updated"|"uninstalled", version, from? }`。
   *
   * ★ 语义边界：事件是**通知**不是授权——收到 `enabled` 不会多出任何能力；
   *   窗口重建/宿主重启后不会重放历史事件，插件状态请用 `info()` / `settings()` 自检。
   * ★ 返回取消订阅函数，语义与其他 `on*` 一致。
   */
  onLifecycle: (callback) => subscribe("widget:lifecycle", callback),

  /* ── 跳转（主窗白名单页面；主进程再按白名单归一化一次） ── */
  openSettings: () => ipcRenderer.send("widget:open-settings"),
  openPage: (page) => ipcRenderer.send("widget:open-page", page),

  /**
   * 对话上下文：本机 magpie 反代地址 + 网关 Key + 可用智能体与绑定。
   *
   * ★ 用户自己的供应商 Key **不在这里**（P0 口径，规格 §3.4）：网关 Key 是本机默认值，
   *   widget 拿不到用户的真实凭据。P1 若改宿主代发，这里会退化成只剩 agents/binding。
   */
  chatConfig: () => ipcRenderer.invoke("widget:chat-config"),

  /** 插件自己的日志（主进程统一加前缀，限长 500）。 */
  log: (line) => ipcRenderer.send("widget:log", typeof line === "string" ? line : String(line ?? "")),
});
