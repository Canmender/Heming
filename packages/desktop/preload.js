const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("heming", {
  platform: process.platform,
  // harness 桥接 API 在 M（二期）扩展
});
