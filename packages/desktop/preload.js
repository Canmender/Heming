const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("heming", {
  platform: process.platform,
  /** 内部：web 端注册 BootWave 启动回调 */
  __onBootReady: null,
  /** 内部：主进程 did-finish-load 后调用，触发 BootWave */
  __startBootWave: null
  // harness 桥接 API 在 M（二期）扩展
});
