const { contextBridge } = require("electron");

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
