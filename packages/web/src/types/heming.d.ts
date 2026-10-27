/**
 * 桌面端 preload（packages/desktop/preload.js）通过 contextBridge 暴露在
 * `window.heming` 上的桥接 API。只有 Electron 里存在；浏览器直接打开时是 undefined，
 * 调用方必须按可选处理（BootWave 即靠此区分「有主进程信号」与「无信号兜底」）。
 */
declare global {
  /** 自动更新状态（主进程 → 渲染层）。 */
  interface UpdateState {
    /** idle / checking / up-to-date / available / downloading / downloaded / error */
    status: "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "error";
    /** 本机当前 5 段版本。 */
    currentVersion: string;
    /** 待更新的版本；无更新时为 null。 */
    available: { version: string; path?: string; sha512?: string } | null;
    /** 上次检查时间戳（毫秒）；从未检查为 null。 */
    lastCheckedAt: number | null;
    /** 最近一次错误信息；无错误为 null。 */
    lastError: string | null;
    /** 是否允许下载（打包后为 true，开发态为 false）。 */
    canDownload: boolean;
  }

  interface Window {
    /** 内部：桌面端 5 段版本号（preload 暴露；浏览器里 undefined）。 */
    __heming_version?: string;
    /**
     * 内部：自动更新桥（preload 暴露）。
     *
     * 只有**安装版**存在——开发态主进程不初始化更新器，
     * 所以调用方要按可选处理，且界面必须能在拿不到它时正常显示。
     */
    __heming_update?: {
      /** 主动检查一次，返回最新状态。 */
      check: () => Promise<UpdateState>;
      /** 下载已发现的更新，返回最新状态。 */
      download: () => Promise<UpdateState>;
      /** 退出并安装；仅在状态为 downloaded 时有效。 */
      install: () => Promise<boolean>;
      /** 读当前状态，不触发检查。 */
      state: () => Promise<UpdateState>;
      /** 订阅状态变化，返回取消订阅函数。 */
      subscribe: (callback: (state: UpdateState) => void) => () => void;
    };
    /** 内部：桌面端 MCP stdio 桥（preload 暴露；浏览器里 undefined）。 */
    __mcp_stdio?: {
      request: (
        serverId: string,
        config: { command: string; args?: string[] },
        method: string,
        params?: unknown,
      ) => Promise<unknown>;
      stop: (serverId: string) => Promise<boolean>;
    };
    /**
     * 内部：桌面端导出文件桥（preload 暴露；浏览器里 undefined）。
     *
     * 有它时 `saveExportFile` 写到 `~/Heming/exports`；没有则回退 Blob 下载。
     * 写失败也会以 `{ ok:false, error }` 返回（IPC 边界不抛）。
     */
    __heming_exports?: {
      write: (
        fileName: string,
        content: string,
      ) => Promise<{ ok: boolean; path?: string; name?: string; error?: string }>;
      info: () => Promise<{ dir: string; exists: boolean }>;
    };
    /**
     * 内部：桌面端本机密钥信封桥（preload 暴露；浏览器里 undefined）。
     * 同步 API——只给三个低频键用（模型 Key / MCP 请求头 / E2E 身份），
     * 不要用在消息收发热路径上。
     */
    __heming_secrets?: {
      available: boolean;
      encrypt: (plain: string) => string | null;
      decrypt: (cipherB64: string) => string | null;
    };
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
