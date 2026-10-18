/**
 * 桌面端 preload（packages/desktop/preload.js）通过 contextBridge 暴露在
 * `window.heming` 上的桥接 API。只有 Electron 里存在；浏览器直接打开时是 undefined，
 * 调用方必须按可选处理（BootWave 即靠此区分「有主进程信号」与「无信号兜底」）。
 */
declare global {
  interface Window {
    heming?: {
      /** 运行平台（process.platform），如 "win32" / "darwin"。 */
      platform?: string;
      /**
       * 内部：web 端注册启动动画回调。preload 侧会缓冲信号——若主进程信号已发过，
       * 注册即立刻回调（避免 did-finish-load 早于 React 挂载时丢信号）。
       */
      __onBootReady?: (cb: () => void) => void;
      /** 内部：主进程 did-finish-load 后调用；web 端不主动调用。 */
      __startBootWave?: () => void;
    };
  }
}

export {};
