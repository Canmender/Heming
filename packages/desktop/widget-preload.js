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

  /* ── 事件：{kind:"notify"|"theme"|"tray"}，只带标题级文案，不落盘 ── */
  onEvent: (callback) => subscribe("widget:event", callback),

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
