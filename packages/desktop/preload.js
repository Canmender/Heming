const { contextBridge } = require("electron");

// BootWave 回调注册表：contextBridge 暴露的对象在 Electron 中被冻结，
// web 端无法直接注入属性，因此回调保存在 preload 隔离世界的闭包中。
let bootCallback = null;

contextBridge.exposeInMainWorld("heming", {
  platform: process.platform,
  /** 内部：web 端注册 BootWave 启动回调 */
  __onBootReady: (cb) => {
    bootCallback = cb;
  },
  /** 内部：主进程 did-finish-load 后调用，触发 BootWave */
  __startBootWave: () => {
    if (bootCallback) bootCallback();
  }
  // harness 桥接 API 在 M（二期）扩展
});
