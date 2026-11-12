"use strict";
/**
 * 渲染进程与主进程之间唯一的桥。
 *
 * 渲染进程没有 node，也不能直接拿 ipcRenderer；这里只暴露安装真正需要的那几个动作，
 * 事件统一走 onEvent / onCaptureState 两个订阅。
 */

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  if (typeof callback !== "function") return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("setup", {
  init: () => ipcRenderer.invoke("setup:init"),
  chooseDirectory: (current) => ipcRenderer.invoke("setup:choose-directory", current),
  pickPayload: () => ipcRenderer.invoke("setup:pick-payload"),
  start: (options) => ipcRenderer.invoke("setup:start", options),
  cancel: () => ipcRenderer.invoke("setup:cancel"),
  openFolder: (dir) => ipcRenderer.invoke("setup:open-folder", dir),
  openInstalled: (dir) => ipcRenderer.invoke("setup:open-installed", dir),
  openLog: () => ipcRenderer.invoke("setup:open-log"),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  close: () => ipcRenderer.invoke("window:close"),
  quit: () => ipcRenderer.invoke("app:quit"),
  onEvent: (callback) => subscribe("setup:event", callback),
  onCaptureState: (callback) => subscribe("setup:capture-state", callback),
});
