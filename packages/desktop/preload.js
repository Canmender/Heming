"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("heming", {
  platform: process.platform,
  // harness 桥接 API 在 M（二期）扩展
});

// —— 语音通话桥接（Task 5）——
// ICE 服务器列表：主进程拉取 /api/ice-servers 后注入，渲染层在建立 PeerConnection 前读取。
contextBridge.exposeInMainWorld("__heming_ice_servers", []);

contextBridge.exposeInMainWorld("__heming_voice_call", {
  /** 窗口最小化事件订阅（主进程 voice-call:minimized → 渲染层回调）。 */
  onMinimize: (callback) => {
    ipcRenderer.on("voice-call:minimized", callback);
  },
  /** 请求主进程发系统通知（来电等场景，窗口最小化时仍可见）。 */
  notify: (title, body) => {
    ipcRenderer.send("voice-call:notify", title, body);
  },
});
