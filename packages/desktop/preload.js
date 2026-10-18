"use strict";
const { contextBridge, ipcRenderer } = require("electron");

// BootWave 回调注册表：contextBridge 暴露的对象在 Electron 中被冻结，
// web 端无法直接注入属性，因此回调保存在 preload 隔离世界的闭包中。
let bootCallback = null;

// 启动信号缓冲：主进程在 did-finish-load 后立刻调用 __startBootWave，可能早于 React
// 挂载并注册回调（渲染进程首帧 vs. 网络加载完成的竞态）。若只是「发一次就忘」，
// 这次启动动画的声波段就永远不会播。故记住「信号已发」，等回调注册时立刻补发。
let bootStarted = false;

contextBridge.exposeInMainWorld("heming", {
  platform: process.platform,
  /** 内部：web 端注册 BootWave 启动回调；若信号已发过则立刻回调（补齐竞态）。 */
  __onBootReady: (cb) => {
    if (typeof cb !== "function") return; // 非函数参数直接忽略，避免调用时炸在 preload 里
    bootCallback = cb;
    if (bootStarted) cb();
  },
  /** 内部：主进程 did-finish-load 后调用，触发 BootWave；重复调用幂等（只置位 + 回调一次语义由 web 端保持）。 */
  __startBootWave: () => {
    bootStarted = true;
    if (typeof bootCallback === "function") bootCallback();
  }
  // harness 桥接 API 在 M（二期）扩展
});

// —— 语音通话桥接（Task 5）——
// ICE 服务器列表：主进程拉取 /api/ice-servers 后注入，渲染层在建立 PeerConnection 前读取。
// 注意：contextBridge.exposeInMainWorld 暴露的属性只有 getter 没有 setter，
// executeJavaScript 直接赋值会静默失败，因此使用闭包变量 + setter/getter 函数。
let _iceServers = [];

contextBridge.exposeInMainWorld("__heming_ice_servers_get", () => _iceServers);

contextBridge.exposeInMainWorld("__heming_voice_call", {
  /** 窗口最小化事件订阅（主进程 voice-call:minimized → 渲染层回调）。返回取消订阅函数。 */
  onMinimize: (callback) => {
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on("voice-call:minimized", listener);
    return () => ipcRenderer.removeListener("voice-call:minimized", listener);
  },
  /** 请求主进程发系统通知（来电/通话中场景，窗口最小化时仍可见；主进程一并闪烁任务栏）。 */
  notify: (title, body) => {
    ipcRenderer.send("voice-call:notify", title, body);
  },
  /** 注入 ICE 服务器列表（主进程调用，渲染层通过 __heming_ice_servers_get 读取）。 */
  setIceServers: (list) => {
    _iceServers = list;
  },
});
